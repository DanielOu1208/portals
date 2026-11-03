import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Frames recorded from `portals-bridge` (`bridge/` in this repo) and its scripted
/// agent, played through the same client code that talks to Hermes. The app has no
/// code of its own for the bridge: these show it needs none to chat, see tool rows and
/// diffs, answer approvals and questions, and pick a thread back up.
///
/// Recorded with `scripts/capture-frames.sh` and `portals-probe --user` against a
/// bridge on 127.0.0.1:9120 signed in with a test password. They are also in
/// `CapturedFrameTests.captures`, which checks every frame is recognized and every
/// param sent is in the contract subset.
@Suite struct BridgeFrameTests {
    static let captures = [
        "bridge-handshake-profiles.jsonl",
        "bridge-chat-text.jsonl",
        "bridge-chat-tools.jsonl",
        "bridge-chat-approval.jsonl",
        "bridge-chat-clarify.jsonl",
        "bridge-chat-interrupt.jsonl",
        "bridge-reattach-running.jsonl",
        "bridge-reattach-approval.jsonl",
        "bridge-resume-tools.jsonl",
    ]

    private func makeBackend(_ server: RecordedServer) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "bridge"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
    }

    /// Sends the recorded message to a new thread with the fake agent and applies what
    /// comes back until the turn ends. `answer` plays the user for any request.
    private func converse(
        _ capture: String,
        message: String,
        answer: (PendingRequest) -> RequestAnswer = { _ in .cancelled }
    ) async throws -> ThreadState {
        let server = try RecordedServer(capture: capture)
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        let thread = try await backend.createThread(with: Agent.ID(host: backend.host, name: "fake"), options: ThreadOptions())

        var state = ThreadState()
        let item = state.messageSent(message)
        state.messageDelivered(item, outcome: try await backend.send(message, to: thread.id))
        for await event in await backend.events(for: thread.id) {
            state.apply(event)
            if case let .requestOpened(request) = event {
                let given = answer(request)
                try await backend.respond(to: request.id, in: thread.id, with: given)
                state.requestAnswered(request.id, with: given)
            }
            if case .turnFinished = event { break }
        }
        await backend.disconnect()
        return state
    }

    private func contents(_ state: ThreadState) -> [TurnItem.Content] {
        state.transcript.turns.flatMap(\.items).map(\.content)
    }

    private func tools(_ contents: [TurnItem.Content]) -> [ToolRun] {
        contents.compactMap { if case let .tool(run) = $0 { run } else { nil } }
    }

    private func texts(_ contents: [TurnItem.Content]) -> [String] {
        contents.compactMap { if case let .text(text) = $0 { text.trimmingCharacters(in: .whitespaces) } else { nil } }
    }

    private func message(_ item: TurnItem?) -> UserMessage? {
        if case let .user(message)? = item?.content { message } else { nil }
    }

    /// The recorded answer to the capture's last request.
    private func lastResult(_ capture: String) throws -> HermesWire.SessionResumeResult {
        let result = try #require(try Fixtures.frames(capture, direction: "in").last?["result"])
        return try result.decode(HermesWire.SessionResumeResult.self)
    }

    @Test func theFakeAgentIsListedAsAnAgent() async throws {
        let server = try RecordedServer(capture: "bridge-handshake-profiles.jsonl")
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        let agents = try await backend.listAgents()
        await backend.disconnect()

        #expect(agents.map(\.id.name) == ["fake"])
        #expect(agents.first?.displayName == "Fake agent")
        #expect(agents.first?.model == "fake-1")
        #expect(agents.first?.isDefault == true)
    }

    @Test func aReplyStreamsIntoTheTranscript() async throws {
        let state = try await converse("bridge-chat-text.jsonl", message: "Say hello.")
        #expect(state.phase == .idle)
        #expect(state.title == "Fake: Say hello.")
        #expect(state.context?.limit == 200_000)

        let turn = try #require(state.transcript.turns.first)
        #expect(state.transcript.turns.count == 1)
        #expect(turn.outcome == .completed)
        #expect(turn.items.count == 2)
        #expect(message(turn.items.first)?.text == "Say hello.")
        #expect(message(turn.items.first)?.delivery == .started)
        #expect(turn.items.last?.content == .text("Hello from the fake agent. You said: Say hello."))
    }

    @Test func toolCallsBecomeRowsWithTheEditsDiffAndTheCommandsOutput() async throws {
        let state = try await converse("bridge-chat-tools.jsonl", message: "Use a tool to change hi to hello.")
        let all = contents(state)
        let runs = tools(all)
        #expect(runs.map(\.name) == ["patch", "terminal"])
        #expect(runs.map(\.label) == ["hello.txt", "cat hello.txt"])
        #expect(runs.allSatisfy { $0.state == .succeeded && ($0.duration ?? 0) > 0 })
        // An edit shows its diff and no input; a command shows itself and what it printed.
        #expect(runs[0].input == nil)
        #expect(runs[0].diff == "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello")
        #expect(runs[0].output == nil)
        #expect(runs[1].input == "cat hello.txt")
        #expect(runs[1].output?.trimmingCharacters(in: .newlines) == "hello")

        // What the agent said before the tools stays above them; the reply follows them.
        #expect(texts(all) == ["I'll change hi to hello in hello.txt.", "Hello from the fake agent. You said: Use a tool to change hi to hello."])
        guard case .tool = all[2], case .tool = all[3] else {
            Issue.record("expected the two tool rows between the texts, got \(all)")
            return
        }
        #expect(state.transcript.turns.first?.outcome == .completed)
    }

    @Test func anApprovalCardIsShownAndTheDenialRecorded() async throws {
        var asked: PendingRequest?
        let state = try await converse("bridge-chat-approval.jsonl", message: "Please approve a command.") { request in
            asked = request
            return .approval(.deny)
        }
        guard case let .approval(approval)? = asked?.kind else {
            Issue.record("expected an approval, got \(String(describing: asked))")
            return
        }
        #expect(asked?.id.hasPrefix("srq-") == true)
        #expect(approval.command == "rm -rf ./fake-build")
        #expect(approval.reason == "delete a folder (the fake agent only pretends)")
        #expect(approval.choices == [.once, .session, .always, .deny])

        let all = contents(state)
        let records = all.compactMap { if case let .request(record) = $0 { record } else { nil } }
        #expect(records.map(\.answer) == ["Denied"])
        let run = try #require(tools(all).first)
        #expect(run.name == "terminal")
        #expect(run.label == "rm -rf ./fake-build")
        #expect(run.state == .failed)
        #expect(run.output == "You denied this command — it did not run.")
        #expect(texts(all).last?.hasPrefix("You said no, so nothing ran.") == true)
        #expect(state.openRequests.isEmpty)
    }

    @Test func aQuestionCardIsShownAndAnswered() async throws {
        var asked: PendingRequest?
        let state = try await converse("bridge-chat-clarify.jsonl", message: "Ask me which language to use.") { request in
            asked = request
            return .clarify(["q0": "Swift"])
        }
        guard case let .clarify(questions)? = asked?.kind else {
            Issue.record("expected a question, got \(String(describing: asked))")
            return
        }
        #expect(questions.map(\.text) == ["Which language should I use?"])
        #expect(questions[0].choices == ["Python", "Swift"])
        #expect(questions[0].allowsMultiple == false)

        let all = contents(state)
        // The question is the row; its tool call is not shown as well.
        #expect(tools(all).isEmpty)
        #expect(all.contains(.request(RequestRecord(id: try #require(asked?.id), kind: .question, prompt: "Which language should I use?", answer: "Swift"))))
        #expect(texts(all).last == "You chose Swift. Hello from the fake agent. You said: Ask me which language to use.")
    }

    @Test func anInterruptedTurnEndsInterrupted() async throws {
        let state = try await converse("bridge-chat-interrupt.jsonl", message: "Write slowly.")
        #expect(state.transcript.turns.first?.outcome == .interrupted)
        #expect(state.phase == .idle)
    }

    /// The snapshot a reattach starts from: what is stored, then the turn in progress
    /// with what it has streamed so far, once.
    @Test func aRunningThreadsSnapshotShowsWhatStreamedSoFar() throws {
        let resumed = try Fixtures.frames("bridge-reattach-running.jsonl", direction: "in")
            .compactMap { $0["result"] }
            .first { $0["running"] != nil }
            .map { try $0.decode(HermesWire.SessionResumeResult.self) }
        let snapshot = HermesHistoryMapper.snapshot(from: try #require(resumed))
        #expect(snapshot.isRunning)
        #expect(snapshot.transcript.turns.count == 1)
        let turn = try #require(snapshot.transcript.turns.first)
        #expect(turn.isRunning)
        #expect(message(turn.items.first)?.text == "Write slowly.")
        guard case let .text(streamed)? = turn.items.last?.content else {
            Issue.record("expected the text streamed so far")
            return
        }
        #expect(streamed.hasPrefix("This is a long reply from the fake agent"))
        #expect(snapshot.model == ModelSetting(model: "fake-1", provider: "fake", level: .medium))
    }

    @Test func aThreadWaitingOnAnApprovalIsReopenedFromItsSnapshotAndAnswered() async throws {
        let capture = "bridge-reattach-approval.jsonl"
        let storedID = try #require(try Fixtures.frames(capture, direction: "out")
            .first { $0["method"]?.stringValue == "session.resume" }?["params"]?["session_id"]?.stringValue)
        let server = try RecordedServer(capture: capture, eventsFollow: .answer)
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()

        let ref = ThreadRef(id: ThreadRef.ID(rawValue: storedID), agent: Agent.ID(host: backend.host, name: "fake"))
        var state = ThreadState()
        state.adopt(try await backend.openThread(ref))
        #expect(state.isRunning)
        let running = try #require(state.transcript.turns.last)
        #expect(running.isRunning)
        #expect(running.items.first?.isUserMessage == true)
        let request = try #require(state.openRequests.first)
        guard case let .approval(approval) = request.kind else {
            Issue.record("expected an approval")
            return
        }
        #expect(approval.command == "rm -rf ./fake-build")

        try await backend.respond(to: request.id, in: ref.id, with: .approval(.deny))
        state.requestAnswered(request.id, with: .approval(.deny))
        for await event in await backend.events(for: ref.id) {
            state.apply(event)
            if case .turnFinished = event { break }
        }
        await backend.disconnect()

        #expect(state.transcript.turns.count == 1)
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .completed)
        #expect(state.openRequests.isEmpty)
        let all = turn.items.map(\.content)
        #expect(all.contains { if case let .request(record) = $0 { record.answer == "Denied" } else { false } })
        // The command started before the app came back; its result still says which it was.
        let run = try #require(tools(all).first)
        #expect(run.label == "rm -rf ./fake-build")
        #expect(run.state == .failed)
        #expect(texts(all).last?.hasPrefix("You said no, so nothing ran.") == true)
    }

    /// After a restart of the bridge the thread is read back from the agent's own history.
    @Test func aThreadComesBackFromItsHistoryAfterARestart() throws {
        let resumed = try lastResult("bridge-resume-tools.jsonl")
        #expect(resumed.running == false)
        #expect(resumed.info?.title == "Fake: Use a tool to change hi")
        let snapshot = HermesHistoryMapper.snapshot(from: resumed)
        #expect(!snapshot.isRunning)
        #expect(snapshot.transcript.turns.count == 1)
        let turn = try #require(snapshot.transcript.turns.first)
        #expect(turn.outcome == .completed)
        let all = turn.items.map(\.content)
        guard case let .user(message) = all.first else {
            Issue.record("expected the turn to open with the message")
            return
        }
        #expect(message.text == "Use a tool to change hi to hello.")

        let runs = tools(all)
        #expect(runs.map(\.name) == ["patch", "terminal"])
        #expect(runs.map(\.label) == ["hello.txt", "cat hello.txt"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs[0].diff == "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello")
        #expect(runs[1].output?.trimmingCharacters(in: .newlines) == "hello")
        #expect(texts(all) == ["I'll change hi to hello in hello.txt.", "Hello from the fake agent. You said: Use a tool to change hi to hello."])
    }
}
