import Foundation
import Testing
@testable import AgentCore

@Suite struct FakeBackendTests {
    /// Sends one message and reduces everything up to the end of the turn. `answer`
    /// plays the user for any request the script raises.
    private func play(
        _ script: FakeBackend.Script,
        message: String = "hi",
        answer: (PendingRequest) -> RequestAnswer = { _ in .cancelled }
    ) async throws -> ThreadState {
        let backend = FakeBackend(script: script, pace: .zero)
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())

        var state = ThreadState()
        let item = state.messageSent(message)
        state.messageDelivered(item, outcome: try await backend.send(message, to: thread.id))
        for await event in await backend.events(for: thread.id) {
            state.apply(event)
            if case let .requestOpened(request) = event {
                let given = answer(request)
                state.requestAnswered(request.id, with: given)
                try await backend.respond(to: request.id, in: thread.id, with: given)
            }
            if case .turnFinished = event { break }
        }
        return state
    }

    /// The workflow script's workflow is kept as a bridge keeps one, so it can be opened
    /// for its detail, and goes on after the turn until both phases' agents are done.
    @Test func theWorkflowIsKeptAndFinishesAfterTheTurn() async throws {
        let backend = FakeBackend(script: .workflow, pace: .zero)
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())
        var state = ThreadState()
        let item = state.messageSent("review")
        state.messageDelivered(item, outcome: try await backend.send("review", to: thread.id))
        // The turn that started it ends first: the workflow is kept after it, as a bridge
        // keeps one, which is what the subagents line shows it by.
        var turnEndedBeforeIt = false
        for await event in await backend.events(for: thread.id) {
            state.apply(event)
            if case .turnFinished = event, state.subagents.first?.state != .finished { turnEndedBeforeIt = true }
            if state.subagents.first?.state == .finished { break }
        }
        #expect(turnEndedBeforeIt)
        let workflow = try #require(state.subagents.first)
        #expect(workflow.kind == .workflow && workflow.isKept)
        #expect(workflow.phases.map(\.title) == ["Review", "Verify"])
        #expect(workflow.agents.count == 4 && workflow.agents.allSatisfy { $0.state == .finished })
    }

    private func tools(_ state: ThreadState) -> [ToolRun] {
        state.transcript.turns.flatMap(\.items).compactMap { if case let .tool(run) = $0.content { run } else { nil } }
    }

    private func replyText(_ state: ThreadState) -> String {
        state.transcript.turns.flatMap(\.items).compactMap { if case let .text(text) = $0.content { text } else { nil } }.joined()
    }

    @Test func greetingStreamsAReplyThatQuotesThePrompt() async throws {
        let state = try await play(.greeting, message: "ping")
        #expect(state.phase == .idle)
        #expect(state.transcript.turns.first?.outcome == .completed)
        #expect(replyText(state).contains("\u{201C}ping\u{201D}"))
        #expect(state.title == "A quick hello")
    }

    @Test func markdownScriptCoversEveryBlockKind() async throws {
        let state = try await play(.markdown)
        #expect(replyText(state) == FakeBackend.markdownShowcase)

        let kinds = Markdown.blocks(replyText(state)).map(\.kind)
        #expect(kinds.contains(.heading(level: 2)))
        #expect(kinds.contains(.listItem(.number(1), depth: 1)))
        #expect(kinds.contains(.listItem(.bullet, depth: 2)))
        #expect(kinds.contains(.code(language: "python")))
        #expect(kinds.contains(.quote))
        #expect(kinds.contains(.rule))
        #expect(kinds.contains { if case .table = $0 { true } else { false } })
    }

    @Test func mathScriptHasFormulasEverywhereButInPricesAndCode() async throws {
        let state = try await play(.math)
        #expect(replyText(state) == FakeBackend.mathShowcase)

        let blocks = Markdown.blocks(replyText(state))
        let formulas = blocks.flatMap { block -> [MathFormula] in
            let texts = if case let .table(table) = block.kind { table.header + table.rows.flatMap { $0 } } else { [block.text] }
            return texts.flatMap { $0.runs.compactMap(\.mathFormula) }
        }
        #expect(formulas.filter(\.isDisplay).count == 4)
        #expect(formulas.contains { $0.source.hasPrefix(#"\("#) })
        #expect(formulas.contains { $0.source.hasPrefix(#"\["#) })
        #expect(blocks.contains { if case .table = $0.kind { true } else { false } })
        // Neither the prices nor the code span.
        #expect(!formulas.contains { $0.source.contains("$5") || $0.source.contains("$10") || $0.source.contains("HOME") })
    }

    @Test func failureScriptEndsFailedWithItsWarningKept() async throws {
        let state = try await play(.failure)
        let turn = try #require(state.transcript.turns.first)
        guard case let .failed(failure) = turn.outcome else {
            Issue.record("expected a failed turn")
            return
        }
        #expect(failure.retryable)
        #expect(state.statusLine == nil)
        #expect(turn.items.contains { if case let .notice(notice) = $0.content { notice.level == .warning } else { false } })
    }

    @Test func commandsScriptAnswersCompactsSaysNothingFailsAndRefuses() async throws {
        let backend = FakeBackend(script: .commands, pace: .zero)
        let thread = ThreadRef.ID(rawValue: "t")
        #expect(try await backend.runCommand(SlashInput(name: "compact"), in: thread) == .message("/compact", shownAs: nil, note: nil))
        await #expect { try await backend.runCommand(SlashInput(name: "nope"), in: thread) } throws: {
            $0.localizedDescription == "There is no /nope command on this host."
        }
        if case .output = try await backend.runCommand(SlashInput(name: "status"), in: thread) {} else {
            Issue.record("/status should answer")
        }

        let compacted = try await play(.commands, message: "/compact")
        #expect(compacted.transcript.turns[0].items.map(\.content).dropFirst() == [.compaction(Compaction(.manual, tokensBefore: 120_345))])
        #expect(compacted.transcript.turns[0].outcome == .completed)
        #expect(try await play(.commands, message: "/rename tidy").transcript.turns[0].isCommandWithoutAnswer)
        #expect(try await play(.commands, message: "/export").transcript.turns[0].outcome
            == .failed(TurnFailure(message: "No messages to export.", retryable: false)))
    }

    @Test func toolsScriptReasonsRunsToolsAndShowsADiff() async throws {
        let state = try await play(.tools)
        let runs = tools(state)
        #expect(runs.map(\.name) == ["terminal", "read_file", "patch", "terminal"])
        #expect(runs.map(\.state) == [.failed, .succeeded, .succeeded, .succeeded])
        #expect(runs[2].diff == FakeBackend.sampleDiff)
        #expect(runs[0].output?.contains("1 failed") == true)

        let contents = state.transcript.turns.flatMap(\.items).map(\.content)
        guard case let .reasoning(reasoning) = contents[1] else {
            Issue.record("expected the reply to open with reasoning")
            return
        }
        #expect(reasoning.endedAt != nil)
        #expect(replyText(state).hasSuffix("all 14 tests pass."))
        #expect(state.transcript.turns.first?.outcome == .completed)
    }

    @Test func approvalScriptRunsTheCommandWhenAllowed() async throws {
        let state = try await play(.approval) { _ in .approval(.once) }
        #expect(tools(state).map(\.state) == [.succeeded])
        #expect(replyText(state).contains("The build folder is gone"))
        let records = state.transcript.turns.flatMap(\.items).compactMap { if case let .request(record) = $0.content { record } else { nil } }
        #expect(records == [RequestRecord(id: "srq-fake-1", kind: .approval, prompt: "rm -rf build", answer: "Allowed once")])
    }

    @Test func approvalScriptLeavesThingsAloneWhenDenied() async throws {
        let state = try await play(.approval) { _ in .approval(.deny) }
        #expect(tools(state).map(\.state) == [.failed])
        #expect(replyText(state).contains("I left the build folder alone"))
    }

    @Test func clarifyScriptUsesTheAnswers() async throws {
        var asked: PendingRequest?
        let state = try await play(.clarify) { request in
            asked = request
            return .clarify(["q0": "Swift", "q1": "tool.swift"])
        }
        guard case let .clarify(questions)? = asked?.kind else {
            Issue.record("expected questions")
            return
        }
        #expect(questions.count == 2)
        #expect(questions[0].choices.count == 2)
        #expect(questions[1].choices.isEmpty)
        #expect(replyText(state).contains("in Swift called `tool.swift`"))
    }

    @Test func clarifyScriptCopesWithBeingSkipped() async throws {
        let state = try await play(.clarify)
        #expect(replyText(state).contains("sensible defaults"))
    }

    @Test func interruptingWhileAskedEndsTheRun() async throws {
        let backend = FakeBackend(script: .approval, pace: .zero)
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())
        _ = try await backend.send("clean", to: thread.id)

        var outcome: TurnOutcome?
        for await event in await backend.events(for: thread.id) {
            if case .requestOpened = event {
                #expect(try await backend.interrupt(thread.id))
            }
            if case let .turnFinished(finished, _) = event {
                outcome = finished
                break
            }
        }
        #expect(outcome == .interrupted)
        // The request went with the run.
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: "srq-fake-1", in: thread.id, with: .approval(.once))
        }
    }

    @Test func anOpenedThreadIsEmptyAndCanBeContinued() async throws {
        let backend = FakeBackend(script: .greeting, pace: .zero)
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "kept-from-before"), agent: agent.id, title: "Earlier")
        let snapshot = try await backend.openThread(ref)
        #expect(snapshot == ThreadSnapshot(title: "Earlier"))

        #expect(try await backend.send("still there?", to: ref.id) == .started)
        var text = ""
        for await event in await backend.events(for: ref.id) {
            if case let .textDelta(delta) = event { text += delta }
            if case .turnFinished = event { break }
        }
        #expect(text.contains("still there?"))
    }

    @Test func agentsMatchTheRealSetup() async throws {
        let backend = FakeBackend(pace: .zero)
        try await backend.connect()
        let agents = try await backend.listAgents()
        #expect(agents.map(\.displayName) == ["Karina", "Aeri", "Hanni", "Wonyoung"])
        #expect(agents.filter(\.isDefault).map(\.displayName) == ["Karina"])
    }

    @Test func interruptEndsTheRun() async throws {
        let backend = FakeBackend(script: .thinking, pace: .milliseconds(50))
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())
        #expect(try await backend.interrupt(thread.id) == false) // nothing running yet

        #expect(try await backend.send("go", to: thread.id) == .started)
        #expect(try await backend.send("and this", to: thread.id) == .queued)
        #expect(try await backend.interrupt(thread.id))

        var outcome: TurnOutcome?
        for await event in await backend.events(for: thread.id) {
            if case let .turnFinished(finished, _) = event {
                outcome = finished
                break
            }
        }
        #expect(outcome == .interrupted)
        // The queued message survived the interrupt and is running now.
        #expect(try await backend.send("again", to: thread.id) == .queued)
        await backend.disconnect()
    }

    @Test func aQueuedMessageRunsAfterTheCurrentTurn() async throws {
        let backend = FakeBackend(script: .greeting, pace: .zero)
        try await backend.connect()
        let agent = try #require(try await backend.listAgents().first)
        let thread = try await backend.createThread(with: agent.id, options: ThreadOptions())
        _ = try await backend.send("first", to: thread.id)
        _ = try await backend.send("second", to: thread.id)

        var finishedTurns = 0
        var text = ""
        for await event in await backend.events(for: thread.id) {
            if case let .textDelta(delta) = event { text += delta }
            if case .turnFinished = event {
                finishedTurns += 1
                if finishedTurns == 2 { break }
            }
        }
        #expect(text.contains("\u{201C}first\u{201D}"))
        #expect(text.contains("\u{201C}second\u{201D}"))
    }

    @Test func callsBeforeConnectingFail() async throws {
        let backend = FakeBackend()
        await #expect(throws: AgentBackendError.notConnected) { _ = try await backend.listAgents() }
    }
}
