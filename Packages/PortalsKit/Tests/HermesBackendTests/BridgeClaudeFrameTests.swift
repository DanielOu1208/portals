import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Frames recorded from `portals-bridge` running Claude Code (Haiku, in a scratch
/// folder), played through the same client code that talks to Hermes. They show that
/// the app needs nothing new for Claude: its tool rows (with an edit's diff), approval
/// and question cards, interrupts, reattaching to a running turn or to one waiting on
/// an approval, and history read back after a restart of the bridge.
///
/// Recorded with `portals-probe --user` against a bridge on 127.0.0.1:9120, cleaned by
/// `scripts/capture-frames.sh NAME --from RAW`. They are also in
/// `CapturedFrameTests.captures`, which checks every frame is recognized and every param
/// sent is in the contract subset.
@Suite struct BridgeClaudeFrameTests {
    static let captures = [
        "bridge-claude-handshake-profiles.jsonl",
        "bridge-claude-chat-tools.jsonl",
        "bridge-claude-chat-approval.jsonl",
        "bridge-claude-chat-clarify.jsonl",
        "bridge-claude-chat-interrupt.jsonl",
        "bridge-claude-reattach-running.jsonl",
        "bridge-claude-reattach-approval.jsonl",
        "bridge-claude-resume-tools.jsonl",
    ]

    private func makeBackend(_ server: RecordedServer) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "bridge"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
    }

    /// Sends the recorded message to a new Claude Code thread and applies what comes
    /// back until the turn ends. `answer` plays the user for each request, in order.
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
        let thread = try await backend.createThread(with: Agent.ID(host: backend.host, name: "claude"), options: ThreadOptions())

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
        contents.compactMap { if case let .text(text) = $0 { text.trimmingCharacters(in: .whitespacesAndNewlines) } else { nil } }
    }

    private func records(_ contents: [TurnItem.Content]) -> [RequestRecord] {
        contents.compactMap { if case let .request(record) = $0 { record } else { nil } }
    }

    private func hasReasoning(_ contents: [TurnItem.Content]) -> Bool {
        contents.contains { if case .reasoning = $0 { true } else { false } }
    }

    @Test func claudeCodeIsListedAsAnAgent() async throws {
        let server = try RecordedServer(capture: "bridge-claude-handshake-profiles.jsonl")
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        let agents = try await backend.listAgents()
        await backend.disconnect()

        #expect(agents.map(\.id.name) == ["claude"])
        #expect(agents.first?.displayName == "Claude Code")
        #expect(agents.first?.model == "default")
        #expect(agents.first?.isDefault == true)
    }

    @Test func anEditShowsAsAnEditRowWithItsDiffBetweenTheReadAndTheCommand() async throws {
        let state = try await converse("bridge-claude-chat-tools.jsonl", message: "Change hi to hello in hello.txt.")
        let all = contents(state)
        let runs = tools(all)
        #expect(runs.map(\.name) == ["read_file", "patch", "terminal"])
        #expect(runs.map(\.label) == ["hello.txt", "hello.txt", "cat /tmp/aeriportal-cwd/hello.txt"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs[0].output == "hi\n")
        // The edit is shown by its diff, with no input and no output.
        #expect(runs[1].diff == "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello")
        #expect(runs[1].input == nil)
        #expect(runs[1].output == nil)
        #expect(runs[2].input == "cat /tmp/aeriportal-cwd/hello.txt")
        #expect(runs[2].output == "hello")

        // Claude's thinking streams into the reasoning rows; the reply closes the turn.
        #expect(hasReasoning(all))
        #expect(texts(all).last == "Changed \"hi\" to \"hello\" in the file and confirmed it now reads \"hello\".")
        #expect(state.transcript.turns.first?.outcome == .completed)
        #expect(state.context?.limit == 200_000)
        #expect(state.phase == .idle)
    }

    /// After `/mode ask`: the first write is denied, the second allowed once.
    @Test func approvalCardsShowTheEditAndTheAnswersAreRecorded() async throws {
        var asked: [PendingRequest] = []
        let state = try await converse("bridge-claude-chat-approval.jsonl", message: "Create a.txt, or b.txt if that is denied.") { request in
            asked.append(request)
            return .approval(asked.count == 1 ? .deny : .once)
        }
        let approvals = asked.compactMap { if case let .approval(approval) = $0.kind { approval } else { nil } }
        #expect(approvals.count == 2)
        #expect(approvals.first?.command == "Edit /tmp/aeriportal-cwd/a.txt\n--- a/a.txt\n+++ b/a.txt\n+a\n")
        #expect(approvals.first?.reason == "Claude wants to change a file")
        #expect(approvals.first?.choices == [.once, .session, .deny])

        let all = contents(state)
        #expect(records(all).map(\.answer) == ["Denied", "Allowed once"])
        let runs = tools(all)
        #expect(runs.map(\.name) == ["write_file", "write_file"])
        #expect(runs.map(\.label) == ["a.txt", "b.txt"])
        #expect(runs[0].state == .failed)
        #expect(runs[0].output == "You denied this change — it was not made.")
        #expect(runs[1].state == .succeeded)
        #expect(runs[1].diff == "--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+b")
        #expect(texts(all).last == "Created b.txt with the letter b after the first write was denied.")
        #expect(state.openRequests.isEmpty)
    }

    @Test func askUserQuestionIsAQuestionCard() async throws {
        var asked: PendingRequest?
        let state = try await converse("bridge-claude-chat-clarify.jsonl", message: "Ask me which language I prefer.") { request in
            asked = request
            return .clarify(["q0": "Swift"])
        }
        guard case let .clarify(questions)? = asked?.kind else {
            Issue.record("expected a question, got \(String(describing: asked))")
            return
        }
        #expect(questions.map(\.text) == ["Which programming language do you prefer?"])
        #expect(questions[0].choices == ["Python", "Swift"])
        #expect(questions[0].allowsMultiple == false)

        let all = contents(state)
        // The question is the row; the tool call behind it is not shown too.
        #expect(tools(all).isEmpty)
        #expect(records(all).map(\.answer) == ["Swift"])
        #expect(texts(all).last == "You prefer Swift.")
    }

    @Test func anInterruptedTurnEndsInterruptedWithItsCommandRows() async throws {
        let state = try await converse("bridge-claude-chat-interrupt.jsonl", message: "Run sleep 30.")
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .interrupted)
        #expect(state.phase == .idle)
        let runs = tools(contents(state))
        #expect(runs.map(\.name) == ["terminal", "terminal"])
        // Dana's own settings refused a bare sleep; the row says so and failed.
        #expect(runs[0].state == .failed)
        #expect(runs[0].output?.contains("Blocked: standalone sleep 30") == true)
    }

    /// The snapshot a reattach starts from while Claude is still writing.
    @Test func aRunningThreadsSnapshotShowsWhatStreamedSoFar() throws {
        let resumed = try Fixtures.frames("bridge-claude-reattach-running.jsonl", direction: "in")
            .compactMap { $0["result"] }
            .first { $0["running"] != nil }
            .map { try $0.decode(HermesWire.SessionResumeResult.self) }
        let snapshot = HermesHistoryMapper.snapshot(from: try #require(resumed))
        #expect(snapshot.isRunning)
        #expect(snapshot.transcript.turns.count == 1)
        let turn = try #require(snapshot.transcript.turns.first)
        #expect(turn.isRunning)
        guard case let .user(message)? = turn.items.first?.content else {
            Issue.record("expected the turn to open with the message")
            return
        }
        #expect(message.text == "Count from 1 to 400, one number per line, with no other text. Do not use any tools.")
        guard case let .text(streamed)? = turn.items.last?.content else {
            Issue.record("expected the text streamed so far")
            return
        }
        #expect(streamed.hasPrefix("1\n2\n3\n"))
        #expect(snapshot.model == ModelSetting(model: "haiku", provider: "anthropic", level: nil))
    }

    @Test func aThreadWaitingOnAnApprovalIsReopenedAndAllowedOnce() async throws {
        let capture = "bridge-claude-reattach-approval.jsonl"
        let storedID = try #require(try Fixtures.frames(capture, direction: "out")
            .first { $0["method"]?.stringValue == "session.resume" }?["params"]?["session_id"]?.stringValue)
        let server = try RecordedServer(capture: capture, eventsFollow: .answer)
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()

        let ref = ThreadRef(id: ThreadRef.ID(rawValue: storedID), agent: Agent.ID(host: backend.host, name: "claude"))
        var state = ThreadState()
        state.adopt(try await backend.openThread(ref))
        #expect(state.isRunning)
        let request = try #require(state.openRequests.first)
        guard case let .approval(approval) = request.kind else {
            Issue.record("expected an approval")
            return
        }
        #expect(approval.command == "Edit /tmp/aeriportal-cwd/held.txt\n--- a/held.txt\n+++ b/held.txt\n+held\n")

        try await backend.respond(to: request.id, in: ref.id, with: .approval(.once))
        state.requestAnswered(request.id, with: .approval(.once))
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
        #expect(records(all).map(\.answer) == ["Allowed once"])
        // The write started before the app came back; its result still says what it was.
        let run = try #require(tools(all).first)
        #expect(run.name == "write_file")
        #expect(run.label == "held.txt")
        #expect(run.state == .succeeded)
        #expect(run.diff == "--- /dev/null\n+++ b/held.txt\n@@ -0,0 +1 @@\n+held")
        #expect(texts(all).last == "Created held.txt with the word \"held\" inside it.")
    }

    /// After a restart of the bridge, a thread is read back from Claude's own history:
    /// no structured results there, so the edit's diff is rebuilt from the edit itself.
    @Test func aThreadComesBackFromClaudesHistoryAfterARestart() throws {
        let result = try #require(try Fixtures.frames("bridge-claude-resume-tools.jsonl", direction: "in").last { $0["result"]?["messages"] != nil }?["result"])
        let resumed = try result.decode(HermesWire.SessionResumeResult.self)
        #expect(resumed.running == false)
        #expect(resumed.info?.title == "aeriportal-probe")
        let snapshot = HermesHistoryMapper.snapshot(from: resumed)
        #expect(!snapshot.isRunning)
        #expect(snapshot.transcript.turns.count == 1)
        let turn = try #require(snapshot.transcript.turns.first)
        #expect(turn.outcome == .completed)
        let all = turn.items.map(\.content)
        let runs = tools(all)
        #expect(runs.map(\.name) == ["read_file", "patch", "terminal"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs[1].diff == "--- a/hello.txt\n+++ b/hello.txt\n-hi\n+hello")
        #expect(runs[2].output == "hello")
        #expect(hasReasoning(all))
        #expect(texts(all).last == "Changed \"hi\" to \"hello\" in the file and confirmed it now reads \"hello\".")
    }
}
