import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Plays a recorded Hermes conversation back to the client: answers each request with
/// the recorded answer to that method, and delivers the recorded events once the client
/// has done what set them off in the recording.
struct RecordedServer {
    /// What the client does that the recorded events follow.
    enum Cue: Equatable {
        /// A request with this method, once it is answered.
        case request(String)
        /// The client's answer to one of the gateway's own questions.
        case answer
    }

    let transport: ScriptedTransport
    private let cue: Cue
    private let answers: [String: [JSONValue]]
    /// Everything the gateway sent unprompted: events and its own requests, in order.
    private let events: [JSONValue]

    init(capture: String, transport: ScriptedTransport = ScriptedTransport(), eventsFollow cue: Cue = .request("prompt.submit")) throws {
        self.transport = transport
        self.cue = cue
        let sent = try Fixtures.frames(capture, direction: "out")
        let received = try Fixtures.frames(capture, direction: "in")
        var answers: [String: [JSONValue]] = [:]
        for request in sent {
            guard let method = request["method"]?.stringValue, let id = request["id"] else { continue }
            if let answer = received.first(where: { $0["id"] == id && $0["method"] == nil }) {
                answers[method, default: []].append(answer)
            }
        }
        self.answers = answers
        events = received.filter { $0["method"] != nil }
    }

    /// Serves until the client stops sending.
    func run() async {
        var remaining = answers
        transport.deliver(events[0]) // gateway.ready
        while let request = await transport.nextSentRequest() {
            guard let method = request["method"]?.stringValue else {
                if cue == .answer { events.dropFirst().forEach(transport.deliver) }
                continue
            }
            guard let id = request["id"], var queue = remaining[method], !queue.isEmpty,
                  case var .object(answer) = queue.removeFirst() else { continue }
            remaining[method] = queue
            answer["id"] = id
            transport.deliver(.object(answer))
            if cue == .request(method) {
                events.dropFirst().forEach(transport.deliver)
            }
        }
    }
}

@Suite struct HermesBackendTests {
    private func makeBackend(serving capture: String) throws -> (HermesBackend, Task<Void, Never>) {
        let server = try RecordedServer(capture: capture)
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
        return (backend, Task { await server.run() })
    }

    /// Runs one message through the backend and returns the resulting state. `answer`
    /// plays the user for any request the agent raises.
    private func converse(
        _ capture: String,
        agent: String = "default",
        message: String = "hello",
        answer: (PendingRequest) -> RequestAnswer = { _ in .cancelled }
    ) async throws -> ThreadState {
        let (backend, serving) = try makeBackend(serving: capture)
        defer { serving.cancel() }
        try await backend.connect()
        let thread = try await backend.createThread(
            with: Agent.ID(host: backend.host, name: agent), options: ThreadOptions()
        )

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

    private func items(_ state: ThreadState) -> [TurnItem.Content] {
        state.transcript.turns.flatMap(\.items).map(\.content)
    }

    private func tools(_ state: ThreadState) -> [ToolRun] {
        items(state).compactMap { if case let .tool(run) = $0 { run } else { nil } }
    }

    @Test func agentsAreTheHostsProfiles() async throws {
        let (backend, serving) = try makeBackend(serving: "handshake-profiles.jsonl")
        defer { serving.cancel() }
        try await backend.connect()
        let agents = try await backend.listAgents()

        #expect(agents.map(\.id.name) == ["default", "aeri"])
        #expect(agents.map(\.displayName) == ["default", "aeri"]) // empty display names fall back
        #expect(agents.map(\.isDefault) == [true, false])
        #expect(agents.allSatisfy { $0.id.host == backend.host })
        await backend.disconnect()
    }

    @Test func aCompletedTurnBecomesATranscript() async throws {
        let state = try await converse("chat-text-complete.jsonl")
        #expect(state.phase == .idle)
        #expect(state.statusLine == nil)
        #expect(state.title == "Greeting from Hermes")

        let turn = try #require(state.transcript.turns.first)
        #expect(state.transcript.turns.count == 1)
        #expect(turn.outcome == .completed)
        #expect(turn.items.map(\.content) == [
            .user(UserMessage(text: "hello", sentAt: turn.items[0].sentAt, delivery: .started)),
            .text("Hello from Hermes!"),
        ])
    }

    @Test func aProviderFailureEndsTheTurnWithAReadableMessage() async throws {
        let state = try await converse("chat-provider-error.jsonl")
        let turn = try #require(state.transcript.turns.first)
        guard case let .failed(failure) = turn.outcome else {
            Issue.record("expected a failed turn, got \(String(describing: turn.outcome))")
            return
        }
        #expect(failure.message.hasPrefix("GMI Cloud didn't answer after 3 attempts"))
        #expect(failure.detail == "HTTP 404: No matching target server found for model z-ai/glm-5.2")
        #expect(failure.retryable)
        #expect(state.statusLine == nil)

        // The warning stays; the transient retry lines do not.
        let notices = turn.items.compactMap { if case let .notice(notice) = $0.content { notice } else { nil } }
        #expect(notices.map(\.level) == [.warning])
        #expect(turn.items.contains { if case .text = $0.content { true } else { false } } == false)
    }

    @Test func aProfileWithNoProviderFailsWithoutRepeatingTheError() async throws {
        let state = try await converse("chat-no-provider.jsonl", agent: "aeri")
        let turn = try #require(state.transcript.turns.first)
        guard case let .failed(failure) = turn.outcome else {
            Issue.record("expected a failed turn")
            return
        }
        #expect(failure.message.contains("not connected to any AI provider"))
        // The two `error` events are replaced by the failure, not shown beside it.
        #expect(turn.items.count == 1)
    }

    /// A backend connected to a transport the test drives by hand.
    /// `features`: what the bridge says it offers in `gateway.ready`, none by default.
    private func connectByHand(features: [String] = []) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        var ready: JSONValue = ["replay_epoch": "e1", "heartbeat": false]
        if !features.isEmpty, case var .object(fields) = ready {
            fields["bridge"] = ["protocol": 1, "features": .array(features.map { .string($0) })]
            ready = .object(fields)
        }
        transport.deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": ["type": "gateway.ready", "payload": ready],
        ])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    /// Creates a thread whose runtime session is `run-1` and durable id is `stored-1`.
    private func createThreadByHand(
        _ backend: HermesBackend, _ transport: ScriptedTransport, agent: String = "aeri", options: ThreadOptions = ThreadOptions()
    ) async throws -> (ThreadRef, JSONValue) {
        let creating = Task { try await backend.createThread(with: Agent.ID(host: backend.host, name: agent), options: options) }
        let request = try #require(await transport.nextSentRequest())
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(request["id"]),
            "result": ["session_id": "run-1", "stored_session_id": "stored-1"],
        ])
        return (try await creating.value, request)
    }

    @Test func requestsCarryTheProfileAndTheRuntimeSessionID() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, create) = try await createThreadByHand(
            backend, transport,
            options: ThreadOptions(workingDirectory: "/tmp/x", model: ModelOverride(model: "m", provider: "p"))
        )
        #expect(create["method"] == "session.create")
        #expect(create["params"] == ["profile": "aeri", "source": "tui", "cwd": "/tmp/x", "model": "m", "provider": "p"])
        // The durable id names the thread, not the runtime id.
        #expect(thread.id.rawValue == "stored-1")
        #expect(thread.agent.name == "aeri")

        let sending = Task { try await backend.send("hi", to: thread.id) }
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["params"] == ["session_id": "run-1", "text": "hi", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "queued"]])
        #expect(try await sending.value == .queued)

        let stopping = Task { try await backend.interrupt(thread.id) }
        let interrupt = try #require(await transport.nextSentRequest())
        #expect(interrupt["method"] == "session.interrupt")
        #expect(interrupt["params"] == ["session_id": "run-1", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(interrupt["id"]), "result": ["status": "interrupted"]])
        #expect(try await stopping.value)
        await backend.disconnect()
    }

    // MARK: Models

    @Test func theCatalogListsSignedInProvidersAndTheAgentsOwnSetting() async throws {
        let (backend, transport) = try await connectByHand()
        let loading = Task { try await backend.modelCatalog(for: Agent.ID(host: backend.host, name: "aeri")) }
        let options = try #require(await transport.nextSentRequest())
        #expect(options["method"] == "model.options")
        #expect(options["params"] == ["profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(options["id"]), "result": [
            "model": "gpt-6.1-sol", "provider": "openai-codex",
            "providers": [
                ["slug": "openrouter", "name": "OpenRouter", "authenticated": true, "models": ["anthropic/claude-fable-5.1", "z-ai/glm-5.3"]],
                ["slug": "openai-codex", "name": "ChatGPT or Codex Subscription", "authenticated": true, "models": ["gpt-6.1-sol"]],
                ["slug": "nobody", "name": "Not signed in", "authenticated": false, "models": ["x"]],
            ],
        ]])
        let reasoning = try #require(await transport.nextSentRequest())
        #expect(reasoning["method"] == "config.get")
        #expect(reasoning["params"] == ["key": "reasoning", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(reasoning["id"]), "result": ["value": "xhigh", "display": "show"]])

        let catalog = try await loading.value
        #expect(catalog.providers.map(\.id) == ["openrouter", "openai-codex"])
        #expect(catalog.providers[0].models == ["anthropic/claude-fable-5.1", "z-ai/glm-5.3"])
        #expect(catalog.agentDefault == ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .extraHigh))
        await backend.disconnect()
    }

    @Test func aModelChangeIsForTheSessionOnlyAndCanAskFirst() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let switching = Task { try await backend.setModel("anthropic/claude-fable-5.1", provider: "openrouter", in: thread.id, confirmed: false) }
        let first = try #require(await transport.nextSentRequest())
        #expect(first["method"] == "config.set")
        // Always for the session, and said so: without `--session` Hermes saves the
        // pick as the profile's default when the profile has none yet.
        #expect(first["params"] == ["key": "model", "value": "anthropic/claude-fable-5.1 --provider openrouter --session", "session_id": "run-1", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(first["id"]), "result": [
            "key": "model", "value": "", "confirm_required": true, "confirm_message": "This model is expensive.",
        ]])
        #expect(try await switching.value == .needsConfirmation("This model is expensive."))

        let confirming = Task { try await backend.setModel("anthropic/claude-fable-5.1", provider: "openrouter", in: thread.id, confirmed: true) }
        let second = try #require(await transport.nextSentRequest())
        #expect(second["params"]?["confirm_expensive_model"] == true)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "result": ["key": "model", "value": "anthropic/claude-fable-5.1", "deferred": true]])
        #expect(try await confirming.value == .applied(note: "The model changes when this run is over."))

        let thinking = Task { try await backend.setThinkingLevel(.extraHigh, in: thread.id) }
        let third = try #require(await transport.nextSentRequest())
        #expect(third["params"] == ["key": "reasoning", "value": "xhigh", "session_id": "run-1", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(third["id"]), "result": ["key": "reasoning", "value": "xhigh"]])
        try await thinking.value
        await backend.disconnect()
    }

    @Test func aReopenedThreadIsToldWhoIsAtWorkForIt() async throws {
        let (backend, transport) = try await connectByHand()
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "stored-9"), agent: Agent.ID(host: backend.host, name: "hanni"))

        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest(includingRoster: true))
        #expect(resume["method"] == "session.resume")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "run-9", "messages": []]])
        _ = try await opening.value

        // Asked on the side, of the session as it runs now.
        let roster = try #require(await transport.nextSentRequest(includingRoster: true))
        #expect(roster["method"] == "subagent.list")
        #expect(roster["params"] == ["session_id": "run-9", "profile": "hanni"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(roster["id"]), "result": [
            "delegations": [],
            "subagents": [
                ["subagent_id": "sa-0", "goal": "Audit the simulation", "last_tool": "terminal", "status": "running"],
                ["subagent_id": "sa-1", "goal": "Already done", "status": "completed"],
            ],
        ]])
        var events = await backend.events(for: ref.id).makeAsyncIterator()
        #expect(await events.next() == .subagentsListed([Subagent(id: "sa-0", goal: "Audit the simulation", tool: "terminal")]))
        await backend.disconnect()
    }

    @Test func theCommandListIsAskedForTheAgentsProfile() async throws {
        let (backend, transport) = try await connectByHand()
        let loading = Task { try await backend.commandCatalog(for: Agent.ID(host: backend.host, name: "aeri")) }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"] == "commands.catalog")
        #expect(request["params"] == ["profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": try Fixtures.json("commands-catalog.json")])
        #expect(try await loading.value.commands.contains { $0.name == "status" })
        await backend.disconnect()
    }

    @Test func aCommandRunsAsATerminalCommandInTheThreadsSession() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let running = Task { try await backend.runCommand(SlashInput(name: "insights", argument: "7"), in: thread.id) }
        let exec = try #require(await transport.nextSentRequest())
        #expect(exec["method"] == "slash.exec")
        // Without the slash, as Hermes's own clients send it.
        #expect(exec["params"] == ["session_id": "run-1", "command": "insights 7", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(exec["id"]), "result": ["output": "  12 sessions this week."]])
        #expect(try await running.value == .output("12 sessions this week."))
        await backend.disconnect()
    }

    @Test func aCommandThatRewritesTheConversationIsFollowedByWhatTheHostHasNow() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        let events = await backend.events(for: thread.id)

        let running = Task { try await backend.runCommand(SlashInput(name: "undo"), in: thread.id) }
        let exec = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(exec["id"]), "result": ["type": "prefill", "message": "what I said"]])
        // No event says the turn is gone, so the session is read again, before the
        // command is done: what is sent next must not be overtaken by it.
        let resume = try #require(await transport.nextSentRequest())
        #expect(resume["method"] == "session.resume")
        #expect(resume["params"]?["session_id"] == "stored-1")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "result": ["session_id": "run-1", "running": false, "messages": []]])
        #expect(try await running.value == .draft("what I said", note: nil))

        var iterator = events.makeAsyncIterator()
        guard case let .snapshot(snapshot)? = await iterator.next() else {
            Issue.record("the thread should be told what the host has")
            return
        }
        #expect(snapshot.transcript.isEmpty)
        await backend.disconnect()
    }

    /// A bridge's `/compact` comes back as a message for the agent: nothing is rewritten
    /// until its turn runs, whose events say where it compacted.
    @Test func aCommandThatBecomesAMessageHasRewrittenNothingYet() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let running = Task { try await backend.runCommand(SlashInput(name: "compact"), in: thread.id) }
        let exec = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(exec["id"]), "error": ["code": 4018, "message": "/compact is not one of the bridge's own commands."]])
        let dispatch = try #require(await transport.nextSentRequest())
        #expect(dispatch["method"] == "command.dispatch")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(dispatch["id"]), "result": ["type": "send", "message": "/compact"]])
        #expect(try await running.value == .message("/compact", shownAs: nil, note: nil))

        // The message goes next, with no session.resume before it.
        let sending = Task { try await backend.send("/compact", to: thread.id) }
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["method"] == "prompt.submit")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "streaming"]])
        #expect(try await sending.value == .started)
        await backend.disconnect()
    }

    @Test func aSkillIsAskedForWhenHermesSaysItIsNotATerminalCommand() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let running = Task { try await backend.runCommand(SlashInput(name: "arxiv", argument: "transformers"), in: thread.id) }
        let exec = try #require(await transport.nextSentRequest())
        #expect(exec["method"] == "slash.exec")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(exec["id"]), "error": ["code": 4018, "message": "skill command: use command.dispatch for /arxiv"]])

        let dispatch = try #require(await transport.nextSentRequest())
        #expect(dispatch["method"] == "command.dispatch")
        #expect(dispatch["params"] == ["name": "arxiv", "arg": "transformers", "session_id": "run-1", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(dispatch["id"]), "result": [
            "type": "skill", "name": "arxiv", "message": "[instructions] transformers", "display": "/arxiv transformers",
        ]])
        #expect(try await running.value == .message("[instructions] transformers", shownAs: "/arxiv transformers", note: nil))
        await backend.disconnect()
    }

    @Test func anAliasIsFollowedToTheCommandItStandsFor() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let running = Task { try await backend.runCommand(SlashInput(name: "bp"), in: thread.id) }
        let first = try #require(await transport.nextSentRequest())
        #expect(first["params"]?["command"] == "bp")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(first["id"]), "result": ["type": "alias", "target": "blueprint"]])
        let second = try #require(await transport.nextSentRequest())
        #expect(second["params"]?["command"] == "blueprint")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "result": ["output": "No blueprints."]])
        #expect(try await running.value == .output("No blueprints."))
        await backend.disconnect()
    }

    @Test func aCommandHermesCannotRunFailsWithItsReason() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        let running = Task { try await backend.runCommand(SlashInput(name: "status"), in: thread.id) }
        let exec = try #require(await transport.nextSentRequest())
        // A helper that timed out is not a reason to ask what the command stands for.
        transport.deliver(["jsonrpc": "2.0", "id": try #require(exec["id"]), "error": ["code": 5030, "message": "slash worker timed out"]])
        await #expect(throws: JSONRPCError.self) { try await running.value }
        await backend.disconnect()
    }

    @Test func aThreadCanStartOnAChosenModelAndThinkingLevel() async throws {
        let (backend, transport) = try await connectByHand()
        let (_, create) = try await createThreadByHand(
            backend, transport,
            options: ThreadOptions(model: ModelOverride(model: "glm-5.3", provider: "zai"), thinkingLevel: .off)
        )
        #expect(create["params"] == ["profile": "aeri", "source": "tui", "model": "glm-5.3", "provider": "zai", "reasoning_effort": "none"])
        await backend.disconnect()
    }

    @Test func imagesAreQueuedOnTheSessionBeforeTheMessage() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        let photo = ImageAttachment(data: Data([0xFF, 0xD8, 0xFF, 0xE0]), filename: "photo.jpg")

        let sending = Task { try await backend.send("what is this?", images: [photo], to: thread.id) }
        let attach = try #require(await transport.nextSentRequest())
        #expect(attach["method"] == "image.attach_bytes")
        #expect(attach["params"] == ["session_id": "run-1", "content_base64": "/9j/4A==", "filename": "photo.jpg", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(attach["id"]), "result": ["attached": true, "name": "upload_1.jpg"]])
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["method"] == "prompt.submit")
        #expect(submit["params"] == ["session_id": "run-1", "text": "what is this?", "profile": "aeri"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "streaming"]])
        #expect(try await sending.value == .started)
        await backend.disconnect()
    }

    @Test func aSendWhoseCallerWasAlreadyCancelledUploadsNothing() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        let photo = ImageAttachment(data: Data([0xFF, 0xD8, 0xFF, 0xE0]), filename: "photo.jpg")
        let sending = Task { () -> Result<SendOutcome, any Error> in
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                return .success(try await backend.send("what is this?", images: [photo], to: thread.id))
            } catch {
                return .failure(error)
            }
        }

        guard case let .failure(error) = await sending.value else {
            Issue.record("a send made by a cancelled caller must not succeed")
            await backend.disconnect()
            return
        }
        #expect(error is CancellationError)
        let sent = await within(.milliseconds(200)) { await transport.nextSentRequest() }
        #expect(sent == nil, "a cancelled send must not upload its image or submit its prompt")
        await backend.disconnect()
    }

    @Test func anImageTheHostRefusesStopsTheMessage() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        let photo = ImageAttachment(data: Data([1, 2, 3]), filename: "photo.heic")

        let sending = Task { try await backend.send("look", images: [photo], to: thread.id) }
        let attach = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(attach["id"]), "error": ["code": 4016, "message": "unsupported image extension: .heic"]])
        await #expect(throws: JSONRPCError(code: 4016, message: "unsupported image extension: .heic")) { _ = try await sending.value }
        await backend.disconnect()
    }

    @Test func statusLinesLoseTheTerminalUISymbols() {
        #expect(HermesEventMapper.plain("⚠ Auxiliary title generation failed") == "Auxiliary title generation failed")
        #expect(HermesEventMapper.plain("❌ API failed after 3 retries") == "API failed after 3 retries")
        #expect(HermesEventMapper.plain("⏳ Retrying in 2.4s (attempt 1/3)...") == "Retrying in 2.4s (attempt 1/3)...")
        #expect(HermesEventMapper.plain("⚠️  spaced") == "spaced")
        #expect(HermesEventMapper.plain("plain text") == "plain text")
        #expect(HermesEventMapper.plain("(◔_◔) processing...") == "(◔_◔) processing...")
        #expect(HermesEventMapper.plain("") == "")

        let warning = HermesEventMapper.threadEvents(for: GatewayEvent(
            type: "status.update", sessionID: "s", payload: ["kind": "warn", "text": "⚠ Title generation failed"]
        ))
        #expect(warning == [.notice(Notice(.warning, "Title generation failed"))])
        let status = HermesEventMapper.threadEvents(for: GatewayEvent(
            type: "thinking.delta", sessionID: "s", payload: ["text": "⏳ waiting on provider"]
        ))
        #expect(status == [.status("Waiting on provider")])
    }

    /// The shapes Hermes 0.21.5's source sends: commentary beside tool calls closed as a
    /// piece of its own, and a final reply that already came that way.
    @Test func commentaryBesideToolCallsAndAReplyAlreadyShown() {
        func events(_ type: String, _ payload: JSONValue) -> [ThreadEvent] {
            HermesEventMapper.threadEvents(for: GatewayEvent(type: type, sessionID: "s", payload: payload))
        }
        #expect(events("message.interim", ["text": "Checking the logs.", "already_streamed": false])
            == [.interimText("Checking the logs.", alreadyStreamed: false)])
        #expect(events("message.interim", ["text": "Streamed first.", "already_streamed": true])
            == [.interimText("Streamed first.", alreadyStreamed: true)])
        #expect(events("message.interim", ["text": "", "already_streamed": false]).isEmpty)

        #expect(events("message.complete", ["text": "Done.", "status": "complete", "response_previewed": true])
            == [.turnFinished(.completed, finalText: nil)])
        #expect(events("message.complete", ["text": "Done.", "status": "complete"])
            == [.turnFinished(.completed, finalText: "Done.")])
    }

    /// Hermes's terminal spinner sends a face and a random verb as its status. That is
    /// decoration, not what the agent is doing, so it clears the status instead.
    @Test(arguments: [
        "(⌐■_■) reflecting...", "(°ロ°) reflecting...", "(¬_¬) brainstorming...", "( ˘⌣˘)♡ deliberating...",
        "ヽ(>∀<☆)☆ computing...", "(⊙_⊙) brainstorming...", "( •_•)>⌐■-■ reflecting...", "(◔_◔) synthesizing...",
        "ಠ_ಠ musing...", "(´･_･`) contemplating...", "(¬‿¬) processing...", "( ͡° ͜ʖ ͡°) pondering...",
        "٩(๑❛ᴗ❛๑)۶ mulling…", "(o_o) reasoning...", "(◔_◔)", "pondering...", "",
    ])
    func theSpinnersFaceAndVerbAreNotAStatus(line: String) {
        #expect(HermesEventMapper.statusText(line) == nil)
        let event = GatewayEvent(type: "thinking.delta", sessionID: "s", payload: ["text": .string(line)])
        #expect(HermesEventMapper.threadEvents(for: event) == [.status(nil)])
    }

    @Test func statusLinesThatSaySomethingAreKeptWithoutTheirDecoration() {
        #expect(HermesEventMapper.statusText("⏳ waiting on provider — retrying in 2s (attempt 1/3)") == "Waiting on provider — retrying in 2s (attempt 1/3)")
        #expect(HermesEventMapper.statusText("⏳ Retrying in 2.4s (attempt 1/3)...") == "Retrying in 2.4s (attempt 1/3)...")
        #expect(HermesEventMapper.statusText("❌ API failed after 3 retries — HTTP 404") == "API failed after 3 retries — HTTP 404")
        // A face in front of real words goes; the words stay.
        #expect(HermesEventMapper.statusText("(◕‿◕✿) running swift test...") == "Running swift test...")
        #expect(HermesEventMapper.statusText("Compressing context") == "Compressing context")
    }

    @Test func eventsForOtherSessionsAreNotDelivered() async throws {
        let (backend, serving) = try makeBackend(serving: "chat-text-complete.jsonl")
        defer { serving.cancel() }
        try await backend.connect()
        let thread = try await backend.createThread(with: Agent.ID(host: backend.host, name: "default"), options: ThreadOptions())
        _ = try await backend.send("hello", to: thread.id)

        var deltas: [String] = []
        for await event in await backend.events(for: thread.id) {
            if case let .textDelta(text) = event { deltas.append(text) }
            if case .turnFinished = event { break }
        }
        // `sessions.changed` (no session) and nothing else leaked in.
        #expect(deltas == ["Hello from Hermes!"])
        await backend.disconnect()
    }

    @Test func callsFailWhenNotConnected() async throws {
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            makeTransport: { _ in ScriptedTransport() }
        )
        await #expect(throws: AgentBackendError.notConnected) { _ = try await backend.listAgents() }
        await #expect(throws: AgentBackendError.unknownThread) {
            _ = try await backend.send("hi", to: ThreadRef.ID(rawValue: "nope"))
        }
    }

    // MARK: Tools, reasoning and requests, from recordings

    @Test func aToolUsingTurnBecomesToolRunsWithDiffs() async throws {
        let state = try await converse("chat-tools.jsonl")
        let runs = tools(state)
        #expect(runs.map(\.name) == ["write_file", "read_file", "patch"])
        #expect(runs.map(\.label) == ["hello.txt", "hello.txt", "hello.txt"])
        #expect(runs.allSatisfy { $0.state == .succeeded })
        #expect(runs.allSatisfy { ($0.duration ?? 0) > 0 })

        // A new file shows what was written; an edit shows only its diff.
        #expect(runs[0].input == "hi\n")
        #expect(runs[0].diff == "--- a//tmp/aeriportal-cwd/hello.txt\n+++ b//tmp/aeriportal-cwd/hello.txt\n@@ -0,0 +1 @@\n+hi")
        #expect(runs[1].output == "1|hi")
        #expect(runs[1].diff == nil)
        #expect(runs[2].input == nil)
        #expect(runs[2].diff?.hasSuffix("@@ -1 +1 @@\n-hi\n+hello") == true)
        #expect(runs[2].diff?.contains("\u{1B}") == false)

        #expect(state.transcript.turns.first?.outcome == .completed)
        #expect(items(state).last == .text("The file `hello.txt` was created, verified, and updated to contain \"hello\"."))
    }

    @Test func aDeniedApprovalIsAnsweredOnTheWireAndRecorded() async throws {
        var asked: PendingRequest?
        let state = try await converse("chat-approval-denied.jsonl") { request in
            asked = request
            return .approval(.deny)
        }

        guard case let .approval(approval)? = asked?.kind else {
            Issue.record("expected an approval request, got \(String(describing: asked))")
            return
        }
        #expect(approval.command.hasPrefix("rm -rf /nonexistent-aeriportal-approval-test"))
        #expect(approval.reason == "delete in root path")
        #expect(approval.choices == [.once, .session, .always, .deny])

        // The answer is in the transcript, and the blocked command says so in Hermes's words.
        let records = items(state).compactMap { if case let .request(record) = $0 { record } else { nil } }
        #expect(records.map(\.answer) == ["Denied"])
        #expect(records.first?.kind == .approval)
        let run = try #require(tools(state).first)
        #expect(run.name == "terminal")
        #expect(run.state == .failed)
        #expect(run.output == "You denied this command — it did not run.")
        #expect(state.openRequests.isEmpty)
    }

    @Test func aClarifyingQuestionIsAskedAnsweredAndRecorded() async throws {
        var asked: PendingRequest?
        let state = try await converse("chat-clarify.jsonl") { request in
            asked = request
            return .clarify(["q0": "Swift"])
        }

        guard case let .clarify(questions)? = asked?.kind else {
            Issue.record("expected a clarify request")
            return
        }
        #expect(questions.map(\.text) == ["Which language should I use?"])
        #expect(questions[0].choices == ["Python (Recommended)", "Swift"])
        #expect(questions[0].allowsMultiple == false)

        let contents = items(state)
        // The clarify tool call is the question, not also a tool row.
        #expect(tools(state).isEmpty)
        #expect(contents.contains(.request(RequestRecord(
            id: try #require(asked?.id), kind: .question, prompt: "Which language should I use?", answer: "Swift"
        ))))
        // Reasoning streamed before and after the question, and each stretch ended.
        let reasoning = contents.compactMap { if case let .reasoning(reasoning) = $0 { reasoning } else { nil } }
        #expect(reasoning.count == 2)
        #expect(reasoning[0].text.hasPrefix("The user wants me to use the clarify tool"))
        #expect(reasoning.allSatisfy { $0.endedAt != nil })
        #expect(contents.last == .text("You chose Swift."))
    }

    @Test func anInterruptedRunEndsInterrupted() async throws {
        let state = try await converse("chat-interrupt.jsonl")
        #expect(state.transcript.turns.first?.outcome == .interrupted)
        #expect(state.phase == .idle)
    }

    /// On Hermes 0.21.5 with its default settings, a message sent during a run is not
    /// queued: the run is redirected to it and answers it in the same turn.
    @Test func aMessageSentMidRunRedirectsTheRunAndIsLabelled() async throws {
        let (backend, serving) = try makeBackend(serving: "chat-redirected.jsonl")
        defer { serving.cancel() }
        try await backend.connect()
        let thread = try await backend.createThread(with: Agent.ID(host: backend.host, name: "default"), options: ThreadOptions())

        var state = ThreadState()
        let first = state.messageSent("Count slowly from one to twenty.")
        state.messageDelivered(first, outcome: try await backend.send("Count slowly from one to twenty.", to: thread.id))
        let second = state.messageSent("Now say the single word: second.")
        #expect(state.pending.count == 1)
        let outcome = try await backend.send("Now say the single word: second.", to: thread.id)
        #expect(outcome == .redirected)
        state.messageDelivered(second, outcome: outcome)

        for await event in await backend.events(for: thread.id) {
            state.apply(event)
            if case .turnFinished = event { break }
        }
        await backend.disconnect()

        // One turn: both messages, then the answer to the second.
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.count == 1)
        let contents = items(state)
        #expect(contents.count == 3)
        guard case let .user(redirect) = contents[1] else {
            Issue.record("expected the second message in the same turn")
            return
        }
        #expect(redirect.delivery == .redirected)
        #expect(contents.last == .text("second"))
        #expect(state.transcript.turns[0].outcome == .completed)
    }

    // MARK: Opening an existing thread

    @Test func openingAThreadResumesItByItsDurableIDAndFollowsItsNewRuntimeID() async throws {
        let (backend, transport) = try await connectByHand()
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "stored-9"), agent: Agent.ID(host: backend.host, name: "hanni"), title: "Old thread")

        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest())
        #expect(resume["method"] == "session.resume")
        #expect(resume["params"] == ["session_id": "stored-9", "profile": "hanni", "inline_images": false])
        transport.deliver([
            "jsonrpc": "2.0", "id": try #require(resume["id"]),
            "result": [
                "session_id": "run-a", "session_key": "stored-9", "running": false, "status": "idle",
                "info": ["title": "Old thread, renamed"],
                "messages": [
                    ["role": "user", "text": "hello", "timestamp": 10],
                    ["role": "assistant", "text": "Hi there.", "timestamp": 12],
                ],
            ],
        ])
        let snapshot = try await opening.value
        #expect(snapshot.isRunning == false)
        #expect(snapshot.title == "Old thread, renamed")
        #expect(snapshot.transcript.turns.count == 1)
        #expect(snapshot.transcript.turns[0].items.last?.content == .text("Hi there."))

        // Events under the runtime id reach the thread, and messages go to it.
        var iterator = await backend.events(for: ref.id).makeAsyncIterator()
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.delta", "session_id": "run-a", "payload": ["text": "more"]]])
        #expect(await iterator.next() == .textDelta("more"))
        let sending = Task { try await backend.send("again", to: ref.id) }
        let submit = try #require(await transport.nextSentRequest())
        #expect(submit["params"] == ["session_id": "run-a", "text": "again", "profile": "hanni"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(submit["id"]), "result": ["status": "streaming"]])
        _ = try await sending.value

        // Opened again after the host reloaded the session. What follows the new
        // snapshot is on a new stream, which follows the new runtime id; the stream
        // from before ends, so nothing older can be applied on top of the snapshot.
        let reopening = Task { try await backend.openThread(ref) }
        let second = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(second["id"]), "result": ["session_id": "run-b", "messages": []]])
        _ = try await reopening.value
        #expect(await iterator.nextLeavingOutRoster() == nil)
        var reopened = await backend.events(for: ref.id).makeAsyncIterator()
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.delta", "session_id": "run-a", "payload": ["text": "stale"]]])
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "message.delta", "session_id": "run-b", "payload": ["text": "fresh"]]])
        #expect(await reopened.next() == .textDelta("fresh"))
        await backend.disconnect()
    }

    @Test func openingAThreadThatIsGoneFailsWithTheHostsReason() async throws {
        let (backend, transport) = try await connectByHand()
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "missing"), agent: Agent.ID(host: backend.host, name: "hanni"))
        let opening = Task { try await backend.openThread(ref) }
        let resume = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(resume["id"]), "error": ["code": 4007, "message": "session not found"]])
        await #expect(throws: JSONRPCError(code: 4007, message: "session not found")) { _ = try await opening.value }
        await backend.disconnect()
    }

    // MARK: Requests, by hand

    @Test func anApprovalIsShownThenAnsweredWithTheChosenOption() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        transport.deliver([
            "jsonrpc": "2.0", "id": "srq-1", "method": "approval",
            "params": ["session_id": "run-1", "command": "rm -rf build", "description": "recursive delete", "choices": ["once", "deny"]],
        ])

        var iterator = await backend.events(for: thread.id).makeAsyncIterator()
        guard case let .requestOpened(request)? = await iterator.next(), case let .approval(approval) = request.kind else {
            Issue.record("expected the approval to be shown")
            return
        }
        #expect(request.id == "srq-1")
        #expect(approval == ApprovalRequest(command: "rm -rf build", reason: "recursive delete", choices: [.once, .deny]))

        try await backend.respond(to: request.id, in: thread.id, with: .approval(.once))
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-1", "result": ["choice": "once"]])

        // It can only be answered once.
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: request.id, in: thread.id, with: .approval(.deny))
        }
        await backend.disconnect()
    }

    @Test func dismissingAnApprovalDeniesIt() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": ["session_id": "run-1", "command": "x"]])
        var iterator = await backend.events(for: thread.id).makeAsyncIterator()
        _ = await iterator.next()

        try await backend.respond(to: "srq-1", in: thread.id, with: .cancelled)
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-1", "result": ["choice": "deny"]])
        await backend.disconnect()
    }

    @Test func clarifyAnswersCoverEveryQuestionAndCancelSendsNone() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        let questions: JSONValue = [
            ["qid": "q0", "question": "Language?", "choices": ["Python", "Swift"], "multi_select": false],
            ["qid": "q1", "question": "Name?"],
        ]
        var iterator = await backend.events(for: thread.id).makeAsyncIterator()

        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "clarify", "params": ["session_id": "run-1", "questions": questions]])
        _ = await iterator.next()
        try await backend.respond(to: "srq-1", in: thread.id, with: .clarify(["q0": "Swift"]))
        // The unanswered question is sent as null: skipped.
        #expect(await transport.nextSentRequest() == [
            "jsonrpc": "2.0", "id": "srq-1", "result": ["answers": ["q0": "Swift", "q1": nil]],
        ])

        transport.deliver(["jsonrpc": "2.0", "id": "srq-2", "method": "clarify", "params": ["session_id": "run-1", "questions": questions]])
        _ = await iterator.next()
        try await backend.respond(to: "srq-2", in: thread.id, with: .cancelled)
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-2", "result": [:]])
        await backend.disconnect()
    }

    @Test func aWithdrawnRequestClosesAndCanNoLongerBeAnswered() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)
        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": ["session_id": "run-1", "command": "x"]])
        transport.deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": ["type": "request.cancel", "session_id": "run-1", "payload": ["id": "srq-1", "method": "approval", "reason": "resolved"]],
        ])

        var iterator = await backend.events(for: thread.id).makeAsyncIterator()
        guard case .requestOpened? = await iterator.next() else {
            Issue.record("expected the request to open first")
            return
        }
        #expect(await iterator.next() == .requestClosed(id: "srq-1", reason: "Answered elsewhere"))
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
        }
        await backend.disconnect()
    }

    /// A card the thread's starter answered (a bridge's `agent_threads`) is closed here as
    /// one answered elsewhere is: it cannot be answered again, nor shown again on a catch-up.
    @Test func aRequestTheStarterAnsweredClosesAndCanNoLongerBeAnswered() async throws {
        let (backend, transport) = try await connectByHand(features: [BridgeWire.Feature.agentThreads])
        let (thread, _) = try await createThreadByHand(backend, transport)
        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": ["session_id": "run-1", "command": "x"]])
        transport.deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": [
                "type": "request.cancel", "session_id": "run-1",
                "payload": ["id": "srq-1", "reason": "resolved", "by": "Claude Code", "answer": ["choice": "deny"]],
            ],
        ])

        var iterator = await backend.events(for: thread.id).makeAsyncIterator()
        guard case .requestOpened? = await iterator.next() else {
            Issue.record("expected the request to open first")
            return
        }
        #expect(await iterator.next() == .requestAnswered(id: "srq-1", answer: .approval(.deny), by: "Claude Code"))
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
        }
        await backend.disconnect()
    }

    @Test func requestsThisAppDoesNotShowAreAnsweredSoTheAgentDoesNotWait() async throws {
        let (backend, transport) = try await connectByHand()
        let (thread, _) = try await createThreadByHand(backend, transport)

        // A password prompt is skipped, and the thread says so.
        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "sudo", "params": ["session_id": "run-1", "command": "sudo ls"]])
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-1", "result": ["value": ""]])
        var iterator = await backend.events(for: thread.id).makeAsyncIterator()
        guard case let .notice(notice)? = await iterator.next() else {
            Issue.record("expected a notice about the skipped prompt")
            return
        }
        #expect(notice.level == .warning)

        // A desktop-only request is declined.
        transport.deliver(["jsonrpc": "2.0", "id": "srq-2", "method": "terminal.read", "params": ["session_id": "run-1"]])
        let declined = try #require(await transport.nextSentRequest())
        #expect(declined["id"] == "srq-2")
        #expect(declined["error"]?["code"] == -32601)

        // An approval for a session this app does not know is refused, never allowed.
        transport.deliver(["jsonrpc": "2.0", "id": "srq-3", "method": "approval", "params": ["session_id": "someone-else", "command": "x"]])
        #expect(await transport.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-3", "result": ["choice": "deny"]])
        await backend.disconnect()
    }

    @Test func aDroppedConnectionIsReported() async throws {
        let (backend, transport) = try await connectByHand()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        transport.drop()
        guard case .disconnected? = await states.next() else {
            Issue.record("expected a disconnected state")
            return
        }
        await #expect(throws: AgentBackendError.notConnected) { _ = try await backend.listAgents() }
        await backend.disconnect()
    }
}

extension TurnItem {
    /// The send time of a user item, to compare the rest of the message exactly.
    fileprivate var sentAt: Date {
        if case let .user(message) = content { message.sentAt } else { .distantPast }
    }
}
