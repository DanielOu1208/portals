import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Frames recorded from `portals-bridge` running Codex (on the shared app-server
/// daemon, in a scratch folder), played through the same client code that talks to
/// Hermes. They show that the app needs nothing new for Codex: its tool rows (with a
/// file change's diff), commentary beside them, approval cards, a message steered into
/// a running turn, interrupts, reattaching to a running turn or to one waiting on an
/// approval (also after a restart of the bridge), and history read back after a restart.
///
/// Recorded with `portals-probe --user` against a bridge on 127.0.0.1:9120, cleaned by
/// `scripts/capture-frames.sh NAME --from RAW`. They are also in
/// `CapturedFrameTests.captures`, which checks every frame is recognized and every param
/// sent is in the contract subset.
@Suite struct BridgeCodexFrameTests {
    static let captures = [
        "bridge-codex-handshake-profiles.jsonl",
        "bridge-codex-chat-tools.jsonl",
        "bridge-codex-chat-approval.jsonl",
        "bridge-codex-chat-steer.jsonl",
        "bridge-codex-chat-interrupt.jsonl",
        "bridge-codex-reattach-running.jsonl",
        "bridge-codex-reattach-approval.jsonl",
        "bridge-codex-reattach-restart.jsonl",
        "bridge-codex-resume-tools.jsonl",
    ]

    private func makeBackend(_ server: RecordedServer) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "bridge"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
    }

    /// Sends the recorded message to a new Codex thread and applies what comes back
    /// until the turn ends. `answer` plays the user for each request, in order;
    /// `steer`, when given, is sent right after the message, while the turn runs.
    private func converse(
        _ capture: String,
        message: String,
        steer: String? = nil,
        answer: (PendingRequest) -> RequestAnswer = { _ in .cancelled }
    ) async throws -> ThreadState {
        let server = try RecordedServer(capture: capture)
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        let thread = try await backend.createThread(with: Agent.ID(host: backend.host, name: "codex"), options: ThreadOptions())

        var state = ThreadState()
        let item = state.messageSent(message)
        state.messageDelivered(item, outcome: try await backend.send(message, to: thread.id))
        if let steer {
            let second = state.messageSent(steer)
            state.messageDelivered(second, outcome: try await backend.send(steer, to: thread.id))
        }
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

    private func users(_ contents: [TurnItem.Content]) -> [UserMessage] {
        contents.compactMap { if case let .user(message) = $0 { message } else { nil } }
    }

    private func records(_ contents: [TurnItem.Content]) -> [RequestRecord] {
        contents.compactMap { if case let .request(record) = $0 { record } else { nil } }
    }

    @Test func codexIsListedAsAnAgent() async throws {
        let server = try RecordedServer(capture: "bridge-codex-handshake-profiles.jsonl")
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()
        let agents = try await backend.listAgents()
        await backend.disconnect()

        #expect(agents.map(\.id.name) == ["codex"])
        #expect(agents.first?.displayName == "Codex")
        #expect(agents.first?.model == "gpt-6.1-sol")
        #expect(agents.first?.isDefault == true)
    }

    @Test func aFileChangeShowsAsAnEditRowWithItsDiffBetweenTheCommands() async throws {
        let state = try await converse("bridge-codex-chat-tools.jsonl", message: "Change hi to hello in hello.txt.")
        let all = contents(state)
        let runs = tools(all)
        #expect(runs.map(\.name) == ["terminal", "patch", "terminal"])
        #expect(runs.map(\.label) == ["cat hello.txt", "hello.txt", "cat hello.txt"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs[0].output == "hi\n")
        // The edit is shown by its diff, with no input and no output.
        #expect(runs[1].diff == "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello")
        #expect(runs[1].input == nil)
        #expect(runs[1].output == nil)
        #expect(runs[2].input == "cat hello.txt")
        #expect(runs[2].output == "hello\n")

        // What Codex said beside the tools comes first; the reply closes the turn.
        #expect(texts(all).first == "I’ll patch `hello.txt`, then run `cat hello.txt` to verify it.")
        #expect(texts(all).last == "Patched `hello.txt` to `hello` and confirmed it with `cat hello.txt`.")
        #expect(state.transcript.turns.first?.outcome == .completed)
        #expect(state.context?.limit == 258_400)
        #expect(state.phase == .idle)
    }

    /// After `/mode ask`: the first file is denied, the second allowed once.
    @Test func approvalCardsShowTheChangeAndTheAnswersAreRecorded() async throws {
        var asked: [PendingRequest] = []
        let state = try await converse("bridge-codex-chat-approval.jsonl", message: "Create note.txt, or other.txt if that is denied.") { request in
            asked.append(request)
            return .approval(asked.count == 1 ? .deny : .once)
        }
        let approvals = asked.compactMap { if case let .approval(approval) = $0.kind { approval } else { nil } }
        #expect(approvals.count == 2)
        #expect(approvals.first?.command == "Edit /tmp/aeriportal-cwd/note.txt\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1 @@\n+note\n")
        #expect(approvals.first?.reason == "Codex wants to change a file")
        #expect(approvals.first?.choices == [.once, .session, .deny])

        let all = contents(state)
        #expect(records(all).map(\.answer) == ["Denied", "Allowed once"])
        let runs = tools(all)
        #expect(runs.map(\.name) == ["write_file", "write_file"])
        #expect(runs.map(\.label) == ["note.txt", "other.txt"])
        #expect(runs[0].state == .failed)
        #expect(runs[0].output == "You denied this change — it was not made.")
        #expect(runs[1].state == .succeeded)
        #expect(runs[1].diff == "--- /dev/null\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other")
        #expect(texts(all).last == "The patch for `note.txt` was rejected, so I created `other.txt` containing `other`.")
        #expect(state.openRequests.isEmpty)
    }

    @Test func aMessageSentMidTurnIsSteeredIntoTheRunningTurn() async throws {
        let state = try await converse(
            "bridge-codex-chat-steer.jsonl",
            message: "Count from 1 to 120.",
            steer: "When you have finished counting, also say the word banana."
        )
        #expect(state.transcript.turns.count == 1)
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .completed)
        let all = turn.items.map(\.content)
        #expect(users(all).map(\.delivery) == [.started, .steered])
        // The counting was closed off before the steered message's answer.
        #expect(texts(all).first?.hasPrefix("1\n2\n3\n") == true)
        #expect(texts(all).first?.hasSuffix("\n120") == true)
        #expect(texts(all).last == "banana")
    }

    @Test func anInterruptedTurnEndsInterruptedWithWhatStreamed() async throws {
        let state = try await converse("bridge-codex-chat-interrupt.jsonl", message: "Count from 1 to 600.")
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .interrupted)
        #expect(state.phase == .idle)
        #expect(texts(turn.items.map(\.content)).first?.hasPrefix("1\n2\n3\n") == true)
    }

    /// The snapshot a reattach starts from while Codex is still writing.
    @Test func aRunningThreadsSnapshotShowsWhatStreamedSoFar() throws {
        let resumed = try Fixtures.frames("bridge-codex-reattach-running.jsonl", direction: "in")
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
        #expect(message.text == "Count from 1 to 500, one number per line, with no other text. Do not use any tools.")
        guard case let .text(streamed)? = turn.items.last?.content else {
            Issue.record("expected the text streamed so far")
            return
        }
        #expect(streamed.hasPrefix("1\n2\n3\n"))
        #expect(snapshot.model == ModelSetting(model: "gpt-6.1-sol", provider: "openai", level: .high))
    }

    /// Reattaches to a thread whose approval was left open, and allows it once.
    private func reopenAndAllow(_ capture: String) async throws -> (approval: ApprovalRequest, state: ThreadState) {
        let storedID = try #require(try Fixtures.frames(capture, direction: "out")
            .first { $0["method"]?.stringValue == "session.resume" }?["params"]?["session_id"]?.stringValue)
        let server = try RecordedServer(capture: capture, eventsFollow: .answer)
        let backend = makeBackend(server)
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()

        let ref = ThreadRef(id: ThreadRef.ID(rawValue: storedID), agent: Agent.ID(host: backend.host, name: "codex"))
        var state = ThreadState()
        state.adopt(try await backend.openThread(ref))
        #expect(state.isRunning)
        let request = try #require(state.openRequests.first)
        guard case let .approval(approval) = request.kind else {
            Issue.record("expected an approval")
            throw CancellationError()
        }
        try await backend.respond(to: request.id, in: ref.id, with: .approval(.once))
        state.requestAnswered(request.id, with: .approval(.once))
        for await event in await backend.events(for: ref.id) {
            state.apply(event)
            if case .turnFinished = event { break }
        }
        await backend.disconnect()
        return (approval, state)
    }

    @Test func aThreadWaitingOnAnApprovalIsReopenedAndAllowedOnce() async throws {
        let (approval, state) = try await reopenAndAllow("bridge-codex-reattach-approval.jsonl")
        #expect(approval.command == "Edit /tmp/aeriportal-cwd/held.txt\n--- /dev/null\n+++ b/held.txt\n@@ -0,0 +1 @@\n+held\n")
        #expect(state.transcript.turns.count == 1)
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .completed)
        #expect(state.openRequests.isEmpty)
        let all = turn.items.map(\.content)
        #expect(records(all).map(\.answer) == ["Allowed once"])
        // The change started before the app came back; its row still says what it was.
        let run = try #require(tools(all).first)
        #expect(run.name == "write_file")
        #expect(run.label == "held.txt")
        #expect(run.state == .succeeded)
        #expect(run.diff == "--- /dev/null\n+++ b/held.txt\n@@ -0,0 +1 @@\n+held")
        #expect(texts(all).last == "Created `held.txt` containing the single word `held`.")
    }

    /// The bridge restarted while Codex waited on an approval: Codex asked again, and
    /// the card still shows the change it is about.
    @Test func anApprovalOpenAcrossARestartOfTheBridgeStillShowsItsChange() async throws {
        let (approval, state) = try await reopenAndAllow("bridge-codex-reattach-restart.jsonl")
        #expect(approval.command == "Edit /tmp/aeriportal-cwd/restart2.txt\n--- /dev/null\n+++ b/restart2.txt\n@@ -0,0 +1 @@\n+again\n")
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .completed)
        let all = turn.items.map(\.content)
        #expect(records(all).map(\.answer) == ["Allowed once"])
        #expect(tools(all).map(\.diff) == ["--- /dev/null\n+++ b/restart2.txt\n@@ -0,0 +1 @@\n+again"])
        #expect(texts(all).last == "Created restart2.txt containing the single word again.")
    }

    /// After a restart of the bridge, a thread is read back from Codex (`thread/read`),
    /// which keeps whole items: the same rows and diff as the live turn.
    @Test func aThreadComesBackFromCodexAfterARestart() throws {
        let result = try #require(try Fixtures.frames("bridge-codex-resume-tools.jsonl", direction: "in").last { $0["result"]?["messages"] != nil }?["result"])
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
        #expect(runs.map(\.name) == ["terminal", "patch", "terminal"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs[1].diff == "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello")
        #expect(runs[2].output == "hello\n")
        #expect(texts(all).last == "Patched `hello.txt` to `hello` and confirmed it with `cat hello.txt`.")
    }
}
