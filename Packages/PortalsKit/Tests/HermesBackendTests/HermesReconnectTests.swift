import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// Hands the backend a new scripted transport for each connection it opens, and the
/// test the same transport to play the gateway on.
final class TransportSequence: Sendable {
    private let made: AsyncStream<ScriptedTransport>
    private let continuation: AsyncStream<ScriptedTransport>.Continuation
    private let madeCount = Mutex(0)

    init() {
        (made, continuation) = AsyncStream.makeStream()
    }

    /// How many connections the backend has tried to open.
    var count: Int { madeCount.withLock { $0 } }

    func make() -> ScriptedTransport {
        let transport = ScriptedTransport()
        madeCount.withLock { $0 += 1 }
        continuation.yield(transport)
        return transport
    }

    /// The transport of the next connection the backend opens.
    func next() async -> ScriptedTransport? {
        for await transport in made {
            return transport
        }
        return nil
    }
}

extension ScriptedTransport {
    /// Plays the gateway's side of the handshake.
    func shakeHands(epoch: String, features: [String] = []) async throws {
        // A bridge that lists features, for what only such a host does.
        let payload: JSONValue = features.isEmpty
            ? ["replay_epoch": .string(epoch), "heartbeat": false]
            : ["replay_epoch": .string(epoch), "heartbeat": false, "bridge": ["protocol": 1, "features": .array(features.map(JSONValue.string))]]
        deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": ["type": "gateway.ready", "payload": payload],
        ])
        let capabilities = try await expect("client.capabilities")
        #expect(capabilities["params"]?["session_resync"]?.boolValue == (features.contains(BridgeWire.Feature.sessionResync) ? true : nil))
        try answer(capabilities, ["server_requests": ["approval", "clarify"]])
    }

    /// The next request the client sends, which must be for `method`.
    func expect(_ method: String, sourceLocation: SourceLocation = #_sourceLocation) async throws -> JSONValue {
        let request = try #require(await nextSentRequest(), sourceLocation: sourceLocation)
        #expect(request["method"]?.stringValue == method, sourceLocation: sourceLocation)
        return request
    }

    func answer(_ request: JSONValue, _ result: JSONValue) throws {
        deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": result])
    }

    func fail(_ request: JSONValue, code: Int, message: String) throws {
        deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "error": ["code": .number(Double(code)), "message": .string(message)]])
    }

    /// Delivers one event for a session.
    func event(_ type: String, seq: Int? = nil, session: String = "run-1", _ payload: JSONValue = [:]) {
        deliver(["jsonrpc": "2.0", "method": "event", "params": Self.eventParams(type, seq: seq, session: session, payload)])
    }

    /// An event as `session.events.since` lists it.
    static func eventParams(_ type: String, seq: Int?, session: String = "run-1", _ payload: JSONValue = [:]) -> JSONValue {
        var params: [String: JSONValue] = ["type": .string(type), "session_id": .string(session), "payload": payload]
        if let seq { params["seq"] = .number(Double(seq)) }
        return .object(params)
    }

    func approval(_ id: String, command: String, session: String = "run-1") {
        deliver(["jsonrpc": "2.0", "id": .string(id), "method": "approval", "params": Self.approvalParams(command, session: session)])
    }

    static func approvalParams(_ command: String, session: String = "run-1") -> JSONValue {
        ["session_id": .string(session), "command": .string(command), "choices": ["once", "deny"]]
    }

    /// A request still open, as `session.resume` and `session.events.since` list it.
    static func openApproval(_ id: String, command: String) -> JSONValue {
        ["id": .string(id), "method": "approval", "params": approvalParams(command)]
    }
}

/// Occupies the old peer after shutdown, so reading its close error must wait.
private final class PeerTurnGate: Sendable {
    private let flags = Mutex((asked: false, held: false))
    private let released = DispatchSemaphore(value: 0)

    var isAsked: Bool { flags.withLock { $0.asked } }
    var isHeld: Bool { flags.withLock { $0.held } }
    func ask() { flags.withLock { $0.asked = true } }
    func hold() {
        flags.withLock { $0.held = true }
        _ = released.wait(timeout: .now() + .seconds(10))
    }
    func release() { released.signal() }
}

private extension JSONRPCPeer {
    func holdTurn(for gate: PeerTurnGate) { gate.hold() }
}

/// What the backend does when the connection to the host is lost and comes back.
@Suite struct HermesReconnectTests {
    @Test func anInvalidatedSessionRefreshesCanonicallyAtTheSocketBoundary() async throws {
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let (_, initialEvents) = try await openedThread(backend, transport)
        var events = initialEvents
        transport.event("message.start", seq: 1)
        transport.event("message.delta", seq: 2, ["text": "obsolete"])
        #expect(await events.next() == .turnStarted)
        #expect(await events.next() == .textDelta("obsolete"))
        transport.event("session.invalidated", seq: 3, ["replay_base": 3])
        let refresh = try await transport.expect("session.resume")
        #expect(refresh["params"]?["since"] == nil)
        transport.approval("obsolete-request", command: "old")
        transport.event("message.delta", seq: 4, ["text": "already in snapshot"])
        try transport.answer(refresh, [
            "session_id": "run-1", "running": true, "latest_seq": 5, "replay_base": 3,
            "messages": [["role": "user", "text": "hi", "timestamp": 1]],
            "inflight": ["user": "hi", "assistant": "repaired", "reasoning": "current reasoning"],
            "open_requests": [],
        ])
        transport.approval("new-request", command: "new")
        transport.event("message.delta", seq: 6, ["text": " plus"])
        guard case let .snapshot(snapshot)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected canonical snapshot")
            await backend.disconnect()
            return
        }
        #expect(snapshot.authoritative)
        #expect(snapshot.transcript.turns.last?.items.contains {
            if case let .reasoning(reasoning) = $0.content { reasoning.text == "current reasoning" } else { false }
        } == true)
        guard case let .requestOpened(request)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected only the new request")
            await backend.disconnect()
            return
        }
        #expect(request.id == "new-request")
        #expect(await events.nextLeavingOutRoster() == .textDelta(" plus"))
        await backend.disconnect()
    }

    @Test func aSecondInvalidationDoesNotReleaseAnOlderSnapshot() async throws {
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let (_, initialEvents) = try await openedThread(backend, transport)
        var events = initialEvents
        transport.event("session.invalidated", seq: 1, ["replay_base": 1])
        let first = try await transport.expect("session.resume")
        transport.event("session.invalidated", seq: 2, ["replay_base": 2])
        try transport.answer(first, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 1, "replay_base": 1])
        let second = try await transport.expect("session.resume")
        try transport.answer(second, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 2, "replay_base": 2])
        guard case let .snapshot(snapshot)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected one up-to-date snapshot")
            await backend.disconnect()
            return
        }
        #expect(snapshot.authoritative)
        transport.event("message.delta", seq: 3, ["text": "new"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("new"))
        await backend.disconnect()
    }

    @Test func anOpenThatOvertakesRepairDoesNotLoseTheInvalidation() async throws {
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let (thread, _) = try await openedThread(backend, transport)
        transport.event("session.invalidated", seq: 1, ["replay_base": 1])
        let repair = try await transport.expect("session.resume")
        let opening = Task { try await backend.openThread(thread) }
        let open = try await transport.expect("session.resume")
        try transport.answer(open, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 0, "replay_base": 0])
        _ = try await opening.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        try transport.answer(repair, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 1, "replay_base": 1])
        let newer = try await transport.expect("session.resume")
        try transport.answer(newer, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 1, "replay_base": 1])
        guard case let .snapshot(snapshot)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected repair on the stream installed by the explicit open")
            await backend.disconnect()
            return
        }
        #expect(snapshot.authoritative)
        await backend.disconnect()
    }

    @Test func aFailedCanonicalRefreshLeavesAThreadReopenable() async throws {
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let (thread, initialEvents) = try await openedThread(backend, transport)
        var events = initialEvents
        transport.event("session.invalidated", seq: 1, ["replay_base": 1])
        let repair = try await transport.expect("session.resume")
        try transport.fail(repair, code: 5000, message: "unavailable")
        guard case .notice? = await events.nextLeavingOutRoster() else {
            Issue.record("expected a refresh failure notice")
            await backend.disconnect()
            return
        }
        #expect(await events.nextLeavingOutRoster() == .detached)
        let reopening = Task { try await backend.openThread(thread) }
        let reopened = try await transport.expect("session.resume")
        try transport.answer(reopened, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 1, "replay_base": 1])
        _ = try await reopening.value
        var newEvents = await backend.events(for: thread.id).makeAsyncIterator()
        transport.event("session.invalidated", seq: 2, ["replay_base": 2])
        let nextRepair = try await transport.expect("session.resume")
        try transport.answer(nextRepair, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 2, "replay_base": 2])
        guard case .snapshot? = await newEvents.nextLeavingOutRoster() else {
            Issue.record("a failed repair must not poison a successfully reopened thread")
            await backend.disconnect()
            return
        }
        await backend.disconnect()
    }

    @Test func replayDropsObsoletePreResponseRequestsButKeepsNewOnes() async throws {
        let features = [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync]
        let (backend, _, transport) = try await connected(features: features)
        let (thread, initialEvents) = try await openedThread(backend, transport)
        var events = initialEvents
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await transport.expect("session.resume")
        transport.approval("obsolete-replay-request", command: "answered before snapshot")
        try transport.answer(resume, [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 0, "replay_base": 0,
            "events": [], "open_requests": [], "info": [:],
        ])
        transport.approval("new-replay-request", command: "asked after snapshot")
        #expect(try await catchingUp.value == nil)
        #expect(await events.nextLeavingOutRoster() == .catchUpBegan)
        #expect(await events.nextLeavingOutRoster() == .caughtUp(ThreadInfo()))
        guard case let .requestOpened(request)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected only the request after the replay receipt")
            await backend.disconnect()
            return
        }
        #expect(request.id == "new-replay-request")
        await backend.disconnect()
    }

    @Test func reconnectDuringRepairDoesNotKeepAnOldEpochInvalidationTarget() async throws {
        let features = [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync]
        let (backend, transports, first) = try await connected(features: features)
        var (thread, events) = try await runningThread(backend, first, openedWhole: true)
        first.event("session.invalidated", seq: 100, ["replay_base": 100])
        _ = try await first.expect("session.resume")
        first.drop()
        let second = try await reconnected(transports, epoch: "e2", features: features)
        let resumed = try await second.expect("session.resume")
        try second.answer(resumed, ["session_id": "run-1", "running": true, "messages": [], "latest_seq": 0, "replay_base": 0])
        var receivedNewEpochSnapshot = false
        awaitingSnapshot: while let event = await events.nextLeavingOutRoster() {
            switch event {
            case .notice, .detached:
                // The old socket can report its failure before the new one wins.
                continue
            case .snapshot:
                receivedNewEpochSnapshot = true
                break awaitingSnapshot
            default:
                break awaitingSnapshot
            }
        }
        guard receivedNewEpochSnapshot else {
            Issue.record("expected the new epoch snapshot")
            await backend.disconnect()
            return
        }
        second.event("session.invalidated", seq: 1, ["replay_base": 1])
        let refresh = try await second.expect("session.resume")
        try second.answer(refresh, ["session_id": "run-1", "running": false, "messages": [], "latest_seq": 1, "replay_base": 1])
        let stream = await backend.events(for: thread.id)
        let repaired = await withTaskGroup(of: ThreadEvent?.self) { group in
            group.addTask {
                var next = stream.makeAsyncIterator()
                return await next.nextLeavingOutRoster()
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(2))
                return nil
            }
            let result = await group.next() ?? nil
            group.cancelAll()
            return result
        }
        guard case .snapshot? = repaired else {
            Issue.record("a new epoch base 1 must not loop waiting for the obsolete epoch's base 100")
            await backend.disconnect()
            return
        }
        second.event("message.delta", seq: 2, ["text": "after repair"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("after repair"))
        await backend.disconnect()
    }

    @Test func anOrdinaryOpenFromABridgeThatRepairsKeepsTheDetailSeenLive() async throws {
        // A bridge that lists session_resync: opening a thread (after a relaunch, or one let go
        // of at rest) is no repair, and must not replace what the app saw live.
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        try transport.answer(try await transport.expect("session.resume"), [
            "session_id": "run-1", "running": false, "latest_seq": 7, "replay_base": 3, "open_requests": [],
            "messages": [["role": "user", "text": "hi", "timestamp": 1], ["role": "assistant", "text": "hello", "timestamp": 2]],
        ])
        #expect(try await opening.value.authoritative == false)

        // Caught up whole with nothing repaired meanwhile (the replay could not reach back):
        // no repair either.
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await transport.expect("session.resume")
        #expect(resume["params"]?["replay_base"] == 3)
        try transport.answer(resume, ["session_id": "run-1", "running": false, "latest_seq": 9, "replay_base": 3, "messages": [], "open_requests": []])
        #expect(try await catchingUp.value?.authoritative == false)
        await backend.disconnect()
    }

    @Test func aRepairMissedWhileAwayIsTakenWhole() async throws {
        // The bridge repaired the thread while the app did not follow it: where its replay
        // begins moved on in the same run, so the whole answer the catch-up gets is a repair.
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync])
        let (thread, _) = try await openedThread(backend, transport)
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await transport.expect("session.resume")
        #expect(resume["params"]?["replay_base"] == 0)
        try transport.answer(resume, ["session_id": "run-1", "running": false, "latest_seq": 5, "replay_base": 4, "messages": [], "open_requests": []])
        #expect(try await catchingUp.value?.authoritative == true)
        await backend.disconnect()
    }

    @Test func aRepairAskedForAsTheBridgeComesBackFromARestartIsNotLost() async throws {
        let features = [BridgeWire.Feature.resumeReplay, BridgeWire.Feature.sessionResync]
        let (backend, transports, first) = try await connected(features: features)
        // Followed a long while in the bridge's first run: its numbers are high.
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        try first.answer(try await first.expect("session.resume"), [
            "session_id": "run-1", "running": false, "latest_seq": 40, "replay_base": 40, "open_requests": [], "messages": [],
        ])
        _ = try await opening.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        let sending = Task { try await backend.send("hi", to: thread.id) }
        try first.answer(try await first.expect("prompt.submit"), ["status": "streaming"])
        _ = try await sending.value
        first.event("message.start", seq: 41)
        first.event("message.delta", seq: 900, ["text": "obsolete"])
        #expect(await events.nextLeavingOutRoster() == .turnStarted)
        #expect(await events.nextLeavingOutRoster() == .textDelta("obsolete"))

        // The bridge restarted (an update): a new run, numbering from the start.
        first.drop()
        let second = try await reconnected(transports, epoch: "e2", features: features)
        let resumed = try await second.expect("session.resume")
        // The repair after the resume's answer reaches the backend first (the answer and the
        // events come to it by separate ways); its numbers are below the first run's.
        second.event("session.invalidated", seq: 4, ["replay_base": 3])
        try second.answer(resumed, [
            "session_id": "run-1", "running": true, "latest_seq": 2, "replay_base": 1, "open_requests": [],
            "messages": [["role": "user", "text": "hi", "timestamp": 1]], "inflight": ["user": "hi", "assistant": "obsolete"],
        ])
        let refresh = await within { await second.nextSentRequest() }
        guard let refresh, refresh["method"]?.stringValue == "session.resume" else {
            Issue.record("the repair asked for as the thread was resumed must be fetched, not dropped")
            await backend.disconnect()
            return
        }
        #expect(refresh["params"]?["since"] == nil)
        try second.answer(refresh, [
            "session_id": "run-1", "running": true, "latest_seq": 4, "replay_base": 3, "open_requests": [],
            "messages": [["role": "user", "text": "hi", "timestamp": 1]], "inflight": ["user": "hi", "assistant": "repaired"],
        ])
        var repaired: ThreadSnapshot?
        while let event = await events.nextLeavingOutRoster() {
            guard case let .snapshot(snapshot) = event else { continue }
            if snapshot.authoritative {
                repaired = snapshot
                break
            }
        }
        #expect(repaired?.transcript.turns.last?.items.last?.content == .text("repaired"))
        await backend.disconnect()
    }

    @Test(arguments: [false, true])
    func anInterruptedStagedUploadNeverSendsAnAttachmentlessPrompt(afterImageAccepted: Bool) async throws {
        let (backend, _, transport) = try await connected(features: [BridgeWire.Feature.files])
        let thread = try await createThread(backend, transport)
        let image = ImageAttachment(data: Data([1, 2]), filename: "photo.jpg")
        let file = FileAttachment(data: Data([3, 4]), filename: "notes.txt")
        let sending = Task {
            try await backend.send("with both attachments", images: [image], files: [file], whenBusy: .steer, to: thread.id)
        }
        let imageUpload = try await transport.expect("image.attach_bytes")
        #expect(imageUpload["params"]?["content_base64"]?.stringValue == image.data.base64EncodedString())
        if afterImageAccepted {
            try transport.answer(imageUpload, ["attached": true])
            let fileUpload = try await transport.expect("file.attach_bytes")
            #expect(fileUpload["params"]?["id"]?.stringValue == file.id.uuidString)
            #expect(fileUpload["params"]?["content_base64"]?.stringValue == file.data.base64EncodedString())
        }
        transport.drop()
        switch await sending.result {
        case .failure: break
        case .success: Issue.record("a dropped attachment upload must fail the send")
        }
        await backend.disconnect()
        #expect(await transport.nextSentRequest() == nil, "no prompt.submit may follow a failed upload")
    }
    private func makeBackend(_ transports: TransportSequence) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            reconnectDelays: [.milliseconds(5)],
            makeTransport: { _ in transports.make() }
        )
    }

    /// A backend connected to a gateway whose server run is `e1`; a bridge's that lists
    /// `features`, when there are any.
    private func connected(features: [String] = []) async throws -> (HermesBackend, TransportSequence, ScriptedTransport) {
        let transports = TransportSequence()
        let backend = makeBackend(transports)
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        try await transport.shakeHands(epoch: "e1", features: features)
        try await connecting.value
        return (backend, transports, transport)
    }

    /// The connection the backend opens next, with the handshake done.
    private func reconnected(_ transports: TransportSequence, epoch: String = "e1", features: [String] = []) async throws -> ScriptedTransport {
        let transport = try #require(await transports.next())
        try await transport.shakeHands(epoch: epoch, features: features)
        return transport
    }

    /// A thread stored as `stored-1` and live as `run-1`.
    private func createThread(_ backend: HermesBackend, _ transport: ScriptedTransport) async throws -> ThreadRef {
        let creating = Task { try await backend.createThread(with: Agent.ID(host: backend.host, name: "aeri"), options: ThreadOptions()) }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1", "stored_session_id": "stored-1"])
        return try await creating.value
    }

    /// The thread `stored-1`, with nothing said in it yet, opened whole from a bridge that
    /// replays (live as `run-1`, its replay beginning at 0), and the stream it follows from
    /// there, past the list of who is at work for it.
    private func openedThread(
        _ backend: HermesBackend, _ transport: ScriptedTransport
    ) async throws -> (ThreadRef, AsyncStream<ThreadEvent>.AsyncIterator) {
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        let open = try await transport.expect("session.resume")
        #expect(open["params"] == wholeParams())
        try transport.answer(open, ["session_id": "run-1", "running": false, "latest_seq": 0, "replay_base": 0, "open_requests": [], "messages": []])
        _ = try await opening.value
        let roster = try #require(await transport.nextSentRequest(includingRoster: true))
        #expect(roster["method"]?.stringValue == "subagent.list")
        try transport.answer(roster, ["subagents": [], "delegations": []])
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        #expect(await events.next() == .subagentsListed([]))
        return (thread, events)
    }

    /// A thread with a run in progress that has streamed "Hel" so far, as events 1 and 2:
    /// made here, or opened whole first (`openedWhole`, `openedThread`).
    private func runningThread(
        _ backend: HermesBackend, _ transport: ScriptedTransport, openedWhole: Bool = false
    ) async throws -> (ThreadRef, AsyncStream<ThreadEvent>.AsyncIterator) {
        let thread: ThreadRef
        var events: AsyncStream<ThreadEvent>.AsyncIterator
        if openedWhole {
            (thread, events) = try await openedThread(backend, transport)
        } else {
            thread = try await createThread(backend, transport)
            events = await backend.events(for: thread.id).makeAsyncIterator()
        }
        let sending = Task { try await backend.send("hi", to: thread.id) }
        try transport.answer(try await transport.expect("prompt.submit"), ["status": "streaming"])
        _ = try await sending.value

        transport.event("message.start", seq: 1)
        transport.event("message.delta", seq: 2, ["text": "Hel"])
        #expect(await events.next() == .turnStarted)
        #expect(await events.next() == .textDelta("Hel"))
        return (thread, events)
    }

    private let resumeParams: JSONValue = ["session_id": "stored-1", "profile": "aeri", "inline_images": false]

    // MARK: The connection

    @Test func anOldCloseErrorCannotDisconnectAReplacementConnection() async throws {
        let (backend, transports, first) = try await connected()
        let oldPeer = try await backend.peer()
        let states = Mutex<[ConnectionState]>([])
        let listening = Task {
            for await state in backend.connectionStates { states.withLock { $0.append(state) } }
        }
        defer { listening.cancel() }
        first.holdClose()
        defer { first.releaseClose() }
        first.drop()
        try #require(await within { first.isClosing ? true : nil } == true)

        let gate = PeerTurnGate()
        defer { gate.release() }
        let occupying = Task(priority: .high) {
            gate.ask()
            await oldPeer.holdTurn(for: gate)
        }
        try #require(await within { gate.isAsked ? true : nil } == true)
        first.releaseClose()
        try #require(await within { gate.isHeld ? true : nil } == true)
        // Let the end handler reach its close-error read. Before the fix it has already
        // cleared the connection; afterward the explicit suspension below clears it.
        _ = await within(.milliseconds(150)) {
            do { _ = try await backend.peer(); return nil as Bool? }
            catch { return true }
        }
        let suspended = Mutex(false)
        let suspending = Task {
            await backend.suspend()
            suspended.withLock { $0 = true }
        }
        try #require(await within {
            suspended.withLock { $0 } || states.withLock { $0.contains(.disconnected(reason: nil)) } ? true : nil
        } == true)

        let connecting = Task { try await backend.connect() }
        let second = try await reconnected(transports)
        try await connecting.value
        try #require(await within { states.withLock { $0.last == .connected ? true : nil } } == true)
        let afterConnected = states.withLock { $0.count }
        gate.release()
        await occupying.value
        await suspending.value
        let stale = await within(.milliseconds(150)) {
            states.withLock { values in
                values.dropFirst(afterConnected).first { if case .disconnected = $0 { true } else { false } }
            }
        }
        #expect(stale == nil)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "current"]]])
        #expect(try await listing.value.map(\.id.name) == ["current"])
        await backend.disconnect()
    }

    @Test func aRosterFromAReplacedPeerCannotClearCurrentSubagentNews() async throws {
        let (backend, transports, first) = try await connected()
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        try first.answer(try await first.expect("session.resume"), ["session_id": "run-1", "running": false, "messages": []])
        _ = try await opening.value
        let roster = try #require(await first.nextSentRequest(includingRoster: true))
        #expect(roster["method"] == "subagent.list")
        let state = Mutex(ThreadState())
        let events = await backend.events(for: thread.id)
        let listening = Task {
            for await event in events { state.withLock { $0.apply(event) } }
        }
        defer { listening.cancel() }
        first.holdClose()
        defer { first.releaseClose() }
        let suspending = Task { await backend.suspend() }
        try #require(await within { first.isClosing ? true : nil } == true)
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports)
        await resuming.value
        // At rest, reconnect detaches instead of adopting: generation and runtime stay the same.
        second.event("subagent.start", session: "run-1", ["subagent_id": "current", "goal": "Current work", "status": "running"])
        try #require(await within { state.withLock { $0.subagents.first?.id == "current" ? true : nil } } == true)

        first.releaseClose()
        await suspending.value
        let cleared = await within(.milliseconds(150)) {
            state.withLock { $0.subagents.isEmpty ? true : nil }
        }
        #expect(cleared == nil)
        #expect(state.withLock { $0.subagents.map(\.id) } == ["current"])
        await backend.disconnect()
    }

    @Test func aResyncFromAReplacedPeerCannotAdoptItsOldSnapshot() async throws {
        let (backend, transports, first) = try await connected()
        let (thread, _) = try await runningThread(backend, first)
        let snapshots = Mutex<[ThreadSnapshot]>([])
        let events = await backend.events(for: thread.id)
        let listening = Task {
            for await event in events {
                if case let .snapshot(snapshot) = event { snapshots.withLock { $0.append(snapshot) } }
            }
        }
        defer { listening.cancel() }
        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, epoch: "e2")
        await resuming.value
        try second.answer(try await second.expect("session.resume"), [
            "session_id": "obsolete-run", "running": true, "messages": [],
            "info": ["spec_model": "large", "title": "Obsolete snapshot"],
        ])
        _ = try await second.expect("session.set_spec_model")
        second.holdClose()
        defer { second.releaseClose() }
        let suspending = Task { await backend.suspend() }
        try #require(await within { second.isClosing ? true : nil } == true)

        let replacing = Task { await backend.resume() }
        let third = try await reconnected(transports, epoch: "e3")
        await replacing.value
        let currentResume = try await third.expect("session.resume")
        // Keep the replacement's resume pending, so no newer adoption changes generation.
        second.releaseClose()
        await suspending.value
        let obsolete = await within(.milliseconds(150)) {
            snapshots.withLock { $0.first { $0.title == "Obsolete snapshot" } }
        }
        #expect(obsolete == nil)
        try third.answer(currentResume, [
            "session_id": "current-run", "running": true, "messages": [], "info": ["title": "Current snapshot"],
        ])
        #expect(await within { snapshots.withLock { $0.last?.title == "Current snapshot" ? true : nil } } == true)
        await backend.disconnect()
    }

    @Test func aDroppedConnectionIsReopened() async throws {
        let (backend, transports, first) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        first.drop()
        guard case .disconnected? = await states.next() else {
            Issue.record("expected a disconnected state")
            return
        }
        let second = try await reconnected(transports)
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        // The new connection is the one in use.
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.map(\.id.name) == ["default"])
        await backend.disconnect()
    }

    @Test func aHostThatCannotBeReachedIsTriedAgainUntilItCan() async throws {
        let transports = TransportSequence()
        let backend = makeBackend(transports)
        let connecting = Task { try await backend.connect() }
        let first = try #require(await transports.next())
        first.drop()
        await #expect(throws: (any Error).self) { try await connecting.value }

        // Nobody asked again: the backend keeps trying by itself.
        let second = try await reconnected(transports)
        var seen: [ConnectionState] = []
        for await state in backend.connectionStates {
            seen.append(state)
            if state == .connected { break }
        }
        #expect(seen.first == .connecting)
        #expect(seen.contains { if case .disconnected = $0 { true } else { false } })

        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        await backend.disconnect()
    }

    @Test func suspendingClosesTheConnectionAndResumingReopensIt() async throws {
        let (backend, transports, first) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        await backend.suspend()
        #expect(first.isClosed)
        #expect(await states.next() == .disconnected(reason: nil))
        // Nothing tries to reconnect while the app is in the background.
        try await Task.sleep(for: .milliseconds(60))
        #expect(transports.count == 1)

        let resuming = Task { await backend.resume() }
        _ = try await reconnected(transports)
        await resuming.value
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        await backend.disconnect()
    }

    /// The app comes back while the socket it let go of as it went to the background is slow
    /// to close: that it went is said before the connection in its place connects, where it
    /// came after, and the app showed that one disconnected though it works.
    @Test func aSocketSlowToCloseAsTheAppComesBackIsSaidGoneBeforeTheOneInItsPlaceConnects() async throws {
        let (backend, transports, first) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)

        first.holdClose()
        defer { first.releaseClose() }
        let suspending = Task { await backend.suspend() }
        #expect(await within { first.isClosing ? true : nil } == true)
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports)
        await resuming.value
        first.releaseClose()
        await suspending.value

        #expect(await states.next() == .disconnected(reason: nil))
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        #expect(try await listing.value.count == 1)
        // The next the app hears of is that one's end.
        second.drop()
        #expect(await states.next() == .disconnected(reason: ScriptedTransport.Closed().localizedDescription))
        await backend.disconnect()
    }

    @Test func anOpenAnsweredByAReplacedConnectionCannotReplaceTheNewThreadsStream() async throws {
        let (backend, transports, first) = try await connected()
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "droid"))
        let oldOpening = Task { try await backend.openThread(thread) }
        try first.answer(try await first.expect("session.resume"), [
            "session_id": "old-run", "messages": [], "info": ["spec_model": "large"],
        ])
        // The resume succeeded, but compatibility work still holds its answer.
        _ = try await first.expect("session.set_spec_model")
        first.holdClose()
        defer { first.releaseClose() }
        let suspending = Task { await backend.suspend() }
        #expect(await within { first.isClosing ? true : nil } == true)

        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports)
        await resuming.value
        let newOpening = Task { try await backend.openThread(thread) }
        try second.answer(try await second.expect("session.resume"), [
            "session_id": "current-run", "messages": [], "info": ["title": "Current thread"],
        ])
        #expect(try await newOpening.value.title == "Current thread")
        var events = await backend.events(for: thread.id).makeAsyncIterator()

        first.releaseClose()
        await suspending.value
        await #expect(throws: CancellationError.self) { _ = try await oldOpening.value }
        second.event("message.delta", session: "current-run", ["text": "still live"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("still live"))

        let sending = Task { try await backend.send("continue", to: thread.id) }
        let submit = try await second.expect("prompt.submit")
        #expect(submit["params"]?["session_id"] == "current-run")
        try second.answer(submit, ["status": "streaming"])
        _ = try await sending.value
        await backend.disconnect()
    }

    /// Counts how often it is asked, and always fails the same way.
    private final class RefusedSignIn: HermesAuthenticator {
        let error: HermesAuthError
        let attempts = Mutex(0)

        init(error: HermesAuthError) {
            self.error = error
        }

        func webSocketRequest() async throws -> URLRequest {
            attempts.withLock { $0 += 1 }
            throw error
        }

        let baseURL = URL(string: "http://127.0.0.1:9119")!

        func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            throw error
        }
    }

    @Test(arguments: [HermesAuthError.invalidCredentials, .missingCredentials, .passwordSignInUnavailable])
    func aSignInTheHostRefusesIsNotTriedAgainByItself(error: HermesAuthError) async throws {
        let authenticator = RefusedSignIn(error: error)
        let backend = HermesBackend(
            host: HostID(rawValue: "test"), authenticator: authenticator,
            reconnectDelays: [.milliseconds(5)], makeTransport: { _ in ScriptedTransport() }
        )
        await #expect(throws: error) { try await backend.connect() }
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .stopped(reason: error.localizedDescription))

        // Each try would count against the host's limit on sign-in attempts.
        try await Task.sleep(for: .milliseconds(60))
        #expect(authenticator.attempts.withLock { $0 } == 1)

        // Asked again (the Retry button, or coming back to the app), it does try.
        await backend.resume()
        #expect(authenticator.attempts.withLock { $0 } == 2)
        await backend.disconnect()
    }

    @Test func aHostThatIsBusyWithSignInsIsTriedAgain() async throws {
        let authenticator = RefusedSignIn(error: .tooManyAttempts)
        let backend = HermesBackend(
            host: HostID(rawValue: "test"), authenticator: authenticator,
            reconnectDelays: [.milliseconds(5)], makeTransport: { _ in ScriptedTransport() }
        )
        await #expect(throws: HermesAuthError.tooManyAttempts) { try await backend.connect() }
        try await Task.sleep(for: .milliseconds(80))
        #expect(authenticator.attempts.withLock { $0 } > 1)
        await backend.disconnect()
    }

    // MARK: A thread with a run in progress

    @Test func aRunningThreadGetsExactlyTheEventsItMissed() async throws {
        let (backend, transports, first) = try await connected()
        var (_, events) = try await runningThread(backend, first)
        first.drop()

        let second = try await reconnected(transports)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == resumeParams)
        try second.answer(resume, ["session_id": "run-1", "running": true, "messages": [["role": "user", "text": "hi", "timestamp": 1]]])
        let since = try await second.expect("session.events.since")
        #expect(since["params"] == ["session_id": "run-1", "last_seen": 2, "profile": "aeri"])

        // A live event that arrives before the missed ones waits behind them.
        second.event("message.delta", seq: 5, ["text": "!"])
        try second.answer(since, [
            "events": [
                ScriptedTransport.eventParams("message.delta", seq: 2, ["text": "Hel"]),
                ScriptedTransport.eventParams("message.delta", seq: 3, ["text": "lo"]),
                ScriptedTransport.eventParams("message.delta", seq: 4, ["text": " there"]),
            ],
            "latest_seq": 4, "truncated": false, "open_requests": [],
        ])
        #expect(await events.next() == .textDelta("lo"))
        #expect(await events.next() == .textDelta(" there"))
        #expect(await events.next() == .textDelta("!"))

        // An event seen already is not applied twice.
        second.event("message.delta", seq: 4, ["text": " there"])
        second.event("message.complete", seq: 6, ["text": "Hello there!", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello there!"))
        await backend.disconnect()
    }

    @Test func aTurnAWaitingMessageOpenedIsCaughtUpOnAfterReconnectingBeforeItSaysAnything() async throws {
        let transports = TransportSequence()
        let backend = makeBackend(transports)
        let connecting = Task { try await backend.connect() }
        let first = try #require(await transports.next())
        try await first.shakeHands(epoch: "e1", features: ["queue"])
        try await connecting.value
        var (_, events) = try await runningThread(backend, first)
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))
        // The message that waited opens the next turn, which has said nothing yet.
        first.event("message.start", seq: 4, ["queue_id": "1"])
        #expect(await events.next() == .queuedTurnStarted("1"))
        first.drop()

        let second = try await reconnected(transports)
        let host = Task {
            let resume = try await second.expect("session.resume")
            try second.answer(resume, ["session_id": "run-1", "running": true, "messages": []])
            let since = try await second.expect("session.events.since")
            #expect(since["params"]?["last_seen"] == 4)
            try second.answer(since, [
                "events": [ScriptedTransport.eventParams("message.delta", seq: 5, ["text": "On it"])],
                "latest_seq": 5, "truncated": false, "open_requests": [],
            ])
        }
        // Followed again, as a turn that began any other way is: not let go of.
        #expect(await events.next() == .textDelta("On it"))
        host.cancel()
        await backend.disconnect()
    }

    @Test func aRestartedHostSendsWhatItHasAsASnapshot() async throws {
        let (backend, transports, first) = try await connected()
        var (thread, events) = try await runningThread(backend, first)
        first.drop()

        // Another server run: its replay log knows nothing of the old events.
        let second = try await reconnected(transports, epoch: "e2")
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == resumeParams)
        try second.answer(resume, [
            "session_id": "run-2", "running": false, "info": ["title": "Greeting"],
            "messages": [
                ["role": "user", "text": "hi", "timestamp": 1],
                ["role": "assistant", "text": "Hello there!", "timestamp": 2],
            ],
        ])
        guard case let .snapshot(snapshot)? = await events.next() else {
            Issue.record("expected a snapshot")
            return
        }
        #expect(snapshot.isRunning == false)
        #expect(snapshot.title == "Greeting")
        #expect(snapshot.transcript.turns.count == 1)
        #expect(snapshot.transcript.turns[0].items.last?.content == .text("Hello there!"))

        // No replay was asked for. The thread now lives under the new runtime id, and
        // its events are taken whatever their numbers.
        let sending = Task { try await backend.send("again", to: thread.id) }
        let submit = try await second.expect("prompt.submit")
        #expect(submit["params"] == ["session_id": "run-2", "text": "again", "profile": "aeri"])
        try second.answer(submit, ["status": "streaming"])
        _ = try await sending.value
        second.event("message.delta", seq: 9, session: "run-1", ["text": "stale"])
        second.event("message.delta", seq: 1, session: "run-2", ["text": "fresh"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("fresh"))
        await backend.disconnect()
    }

    @Test func aReplayLogThatNoLongerReachesBackSendsASnapshot() async throws {
        let (backend, transports, first) = try await connected()
        var (_, events) = try await runningThread(backend, first)
        first.drop()

        let second = try await reconnected(transports)
        try second.answer(try await second.expect("session.resume"), [
            "session_id": "run-1", "running": true,
            "messages": [["role": "user", "text": "hi", "timestamp": 1]],
            "inflight": ["user": "hi", "assistant": "Hello th", "streaming": true],
        ])
        try second.answer(try await second.expect("session.events.since"), ["events": [], "latest_seq": 900, "truncated": true])

        guard case let .snapshot(snapshot)? = await events.next() else {
            Issue.record("expected a snapshot")
            return
        }
        #expect(snapshot.isRunning)
        let turn = try #require(snapshot.transcript.turns.last)
        #expect(turn.isRunning)
        #expect(turn.items.map(\.content).last == .text("Hello th"))

        // What comes next follows the snapshot.
        second.event("message.delta", seq: 901, ["text": "ere!"])
        #expect(await events.next() == .textDelta("ere!"))
        await backend.disconnect()
    }

    @Test func aThreadThatCannotBeResumedSaysSo() async throws {
        let (backend, transports, first) = try await connected()
        var (_, events) = try await runningThread(backend, first)
        first.drop()

        let second = try await reconnected(transports)
        try second.fail(try await second.expect("session.resume"), code: 4007, message: "session not found")
        guard case let .notice(notice)? = await events.next() else {
            Issue.record("expected a notice")
            return
        }
        #expect(notice.level == .warning)
        #expect(notice.text.contains("session not found"))
        await backend.disconnect()
    }

    // MARK: What the agent is waiting for

    @Test func whatTheAgentWaitsForIsShownAgainAfterReconnecting() async throws {
        let (backend, transports, first) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        var (thread, events) = try await runningThread(backend, first)
        first.approval("srq-1", command: "rm -rf build")
        first.approval("srq-2", command: "make clean")
        for id in ["srq-1", "srq-2"] {
            guard case let .requestOpened(request)? = await events.next() else {
                Issue.record("expected \(id) to open")
                return
            }
            #expect(request.id == id)
        }

        first.drop()
        while let state = await states.next() {
            if case .disconnected = state { break }
        }
        // An answer given while the connection is down does not reach the host.
        await #expect(throws: AgentBackendError.notConnected) {
            try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
        }

        // Back: the first is still open, the second was answered from elsewhere, and a
        // third was raised while the app was away.
        let stillOpen: JSONValue = [
            ScriptedTransport.openApproval("srq-1", command: "rm -rf build"),
            ScriptedTransport.openApproval("srq-3", command: "git push"),
        ]
        let second = try await reconnected(transports)
        try second.answer(try await second.expect("session.resume"), ["session_id": "run-1", "running": true, "open_requests": stillOpen])
        try second.answer(try await second.expect("session.events.since"), ["events": [], "truncated": false, "open_requests": stillOpen])

        #expect(await events.next() == .requestClosed(id: "srq-2", reason: "Answered elsewhere"))
        var reopened: [String] = []
        for _ in 0..<2 {
            guard case let .requestOpened(request)? = await events.next() else {
                Issue.record("expected a request to open")
                return
            }
            reopened.append(request.id)
        }
        #expect(reopened == ["srq-1", "srq-3"])

        // Answered again, it goes out on the new connection.
        try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-1", "result": ["choice": "once"]])
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: "srq-2", in: thread.id, with: .approval(.once))
        }
        await backend.disconnect()
    }

    /// An answer given to a card as the connection comes back, while the thread's resume
    /// is under way: a bridge takes no answer from a connection that does not follow the
    /// thread yet, and says nothing of it. The answer goes once the thread is followed
    /// again, and the card the catch-up shows again closes with it.
    @Test func anAnswerGivenWhileTheThreadIsFollowedAgainGoesOnceItIs() async throws {
        let (backend, transports, first) = try await connected()
        var (thread, events) = try await runningThread(backend, first)
        first.approval("srq-1", command: "rm -rf build")
        guard case .requestOpened? = await events.next() else {
            Issue.record("expected the approval")
            return
        }
        first.drop()

        let second = try await reconnected(transports)
        let resume = try await second.expect("session.resume")
        let answered = AnsweredFlag()
        let answering = Task {
            try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
            await answered.set()
        }
        // Not given while the thread is not followed.
        let early = await within(.milliseconds(300)) { await answered.isSet ? true : nil }
        #expect(early == nil)
        guard early == nil else {
            await backend.disconnect()
            return
        }
        let stillOpen: JSONValue = [ScriptedTransport.openApproval("srq-1", command: "rm -rf build")]
        try second.answer(resume, ["session_id": "run-1", "running": true, "open_requests": stillOpen])
        try second.answer(try await second.expect("session.events.since"), ["events": [], "truncated": false, "open_requests": stillOpen])
        try await answering.value
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-1", "result": ["choice": "once"]])
        guard case .requestOpened? = await events.next() else {
            Issue.record("expected the approval shown again by the catch-up")
            return
        }
        #expect(await events.next() == .requestAnswered(id: "srq-1", answer: .approval(.once), by: nil))
        await backend.disconnect()
    }

    @Test func aRequestRaisedWhileCatchingUpIsNotMistakenForAnAnsweredOne() async throws {
        let (backend, transports, first) = try await connected()
        var (thread, events) = try await runningThread(backend, first)
        first.drop()

        let second = try await reconnected(transports)
        try second.answer(try await second.expect("session.resume"), ["session_id": "run-1", "running": true])
        let since = try await second.expect("session.events.since")
        // Raised after the host listed what was open, so it is in neither answer.
        second.approval("srq-9", command: "git push")
        try second.answer(since, ["events": [], "truncated": false, "open_requests": []])

        guard case let .requestOpened(request)? = await events.next() else {
            Issue.record("expected the request to open")
            return
        }
        #expect(request.id == "srq-9")
        // It stays open: the next thing is the next event, and it can be answered.
        second.event("message.delta", seq: 3, ["text": "lo"])
        #expect(await events.next() == .textDelta("lo"))
        try await backend.respond(to: "srq-9", in: thread.id, with: .approval(.deny))
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-9", "result": ["choice": "deny"]])
        await backend.disconnect()
    }

    @Test func aThreadReopenedWhileFollowedDoesNotShowAgainAMessageSteeredInThatItsSnapshotHolds() async throws {
        let transports = TransportSequence()
        let backend = makeBackend(transports)
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        try await transport.shakeHands(epoch: "e1", features: ["queue", "turn_messages"])
        try await connecting.value
        let (thread, _) = try await runningThread(backend, transport)
        // One of this app's own, handed to the run.
        let steering = Task { try await backend.send("and spaces", images: [], files: [], whenBusy: .steer, to: thread.id) }
        let submit = try await transport.expect("prompt.submit")
        let mine = try #require(submit["params"]?["message_id"]?.stringValue)
        try transport.answer(submit, ["status": "steered"])
        _ = try await steering.value

        // Opened again while the connection follows it: what comes before the answer waits.
        let opening = Task { try await backend.openThread(thread) }
        let resume = try await transport.expect("session.resume")
        transport.event("message.steered", seq: 3, ["text": "and use tabs", "sender": "user"])
        transport.event("message.steered", seq: 4, ["text": "and spaces", "sender": "user", "message_id": .string(mine)])
        // A card raised and taken back, and the turn's end: the snapshot has neither card nor
        // turn, and the card's frame has no number, so its closing still applies.
        transport.approval("srq-9", command: "rm -rf build")
        transport.event("request.cancel", seq: 5, ["id": "srq-9"])
        transport.event("message.complete", seq: 6, ["text": "Hello", "status": "complete"])
        // The bridge's answer holds them all (it was built after them), and says so.
        try transport.answer(resume, [
            "session_id": "run-1", "running": false, "latest_seq": 6, "open_requests": [],
            "messages": [
                ["role": "user", "text": "hi", "timestamp": 1],
                ["role": "user", "text": "and use tabs", "timestamp": 2],
                ["role": "assistant", "text": "Hello", "timestamp": 3],
            ],
        ])
        _ = try await opening.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        // This app's own still settles the send it was, as shown already.
        #expect(await events.nextLeavingOutRoster() == .ownMessageSteered(try #require(UUID(uuidString: mine)), shownAlready: true))
        guard case let .requestOpened(request)? = await events.nextLeavingOutRoster() else {
            Issue.record("expected the card's frame")
            return
        }
        #expect(request.id == "srq-9")
        #expect(await events.nextLeavingOutRoster() == .requestClosed(id: "srq-9", reason: "Withdrawn"))
        #expect(await events.nextLeavingOutRoster() == .turnFinished(.completed, finalText: "Hello"))
        // A message steered in after the answer shows.
        transport.event("message.steered", seq: 7, ["text": "and more", "sender": "user"])
        #expect(await events.nextLeavingOutRoster() == .messageSteered("and more"))
        await backend.disconnect()
    }

    @Test func aSnapshotCarriesWhatTheAgentWaitsFor() async throws {
        let (backend, transports, first) = try await connected()
        var (thread, events) = try await runningThread(backend, first)
        first.approval("srq-1", command: "rm -rf build")
        _ = await events.next()
        first.drop()

        // The host restarted the connection's server run, but the session lives on.
        let second = try await reconnected(transports, epoch: "e2")
        try second.answer(try await second.expect("session.resume"), [
            "session_id": "run-1", "running": true,
            "messages": [["role": "user", "text": "hi", "timestamp": 1]],
            "open_requests": [
                ScriptedTransport.openApproval("srq-4", command: "git push"),
                // A kind this app never shows is answered at once, so the agent moves on.
                ["id": "srq-5", "method": "sudo", "params": ["session_id": "run-1"]],
            ],
        ])
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-5", "result": ["value": ""]])

        var snapshot: ThreadSnapshot?
        while let event = await events.next() {
            if case let .snapshot(found) = event {
                snapshot = found
                break
            }
        }
        #expect(snapshot?.openRequests.map(\.id) == ["srq-4"])
        // The one from before is gone with the old state; the new one can be answered.
        await #expect(throws: AgentBackendError.unknownRequest) {
            try await backend.respond(to: "srq-1", in: thread.id, with: .approval(.once))
        }
        try await backend.respond(to: "srq-4", in: thread.id, with: .approval(.once))
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-4", "result": ["choice": "once"]])
        await backend.disconnect()
    }

    // MARK: A thread with nothing running

    /// A subagent's question outlives the turn, and the thread at rest is not followed
    /// again on reconnecting (`.detached`) until it is used. Its card is still up, and the
    /// answer given to it is such a use: the thread is resumed first, as for a message, so
    /// the bridge takes the answer (it takes none from a connection that does not follow
    /// the thread, and says nothing of it), and one no longer asked is said to be so.
    @Test func anAnswerToAThreadAtRestIsGivenOnceTheThreadIsFollowedAgain() async throws {
        let (backend, transports, first) = try await connected(features: ["subagents"])
        var (thread, events) = try await runningThread(backend, first)
        first.deliver([
            "jsonrpc": "2.0", "id": "srq-7", "method": "approval",
            "params": ["session_id": "run-1", "command": "ls", "choices": ["once", "deny"], "subagent": "a1"],
        ])
        guard case .requestOpened? = await events.next() else {
            Issue.record("expected the subagent's question")
            return
        }
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))
        first.drop()

        let second = try await reconnected(transports, features: ["subagents"])
        #expect(await events.next() == .detached)
        let answering = Task { try await backend.respond(to: "srq-7", in: thread.id, with: .approval(.once)) }
        let resume = try await second.expect("session.resume")
        // The answer itself, first: what follows would wait for a resume never sent.
        guard resume["method"]?.stringValue == "session.resume" else {
            await backend.disconnect()
            return
        }
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "messages": [],
            "open_requests": [["id": "srq-7", "method": "approval", "params": ["session_id": "run-1", "command": "ls", "choices": ["once", "deny"], "subagent": "a1"]]],
        ])
        try await answering.value
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-7", "result": ["choice": "once"]])
        await backend.disconnect()
    }

    /// The same thread at rest, opened again on screen while the answer's own resume is
    /// under way: the answer waits for that other resume too, whose answer was taken before
    /// it and shows the card again, and goes once the thread is in step.
    @Test func anAnswerWaitsForAResumeBegunWhileItFollowedTheThread() async throws {
        let (backend, transports, first) = try await connected(features: ["subagents"])
        var (thread, events) = try await runningThread(backend, first)
        let asked: JSONValue = ["session_id": "run-1", "command": "ls", "choices": ["once", "deny"], "subagent": "a1"]
        first.deliver(["jsonrpc": "2.0", "id": "srq-7", "method": "approval", "params": asked])
        guard case .requestOpened? = await events.next() else {
            Issue.record("expected the subagent's question")
            return
        }
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))
        first.drop()

        let second = try await reconnected(transports, features: ["subagents"])
        #expect(await events.next() == .detached)
        let answered = AnsweredFlag()
        let ref = thread
        let answering = Task {
            try await backend.respond(to: "srq-7", in: ref.id, with: .approval(.once))
            await answered.set()
        }
        let ownResume = try await second.expect("session.resume")
        let opening = Task { try await backend.openThread(ref) }
        let reopen = try await second.expect("session.resume")
        let open: JSONValue = ["session_id": "run-1", "running": false, "messages": [], "open_requests": [["id": "srq-7", "method": "approval", "params": asked]]]
        try second.answer(ownResume, open)
        let early = await within(.milliseconds(300)) { await answered.isSet ? true : nil }
        #expect(early == nil)
        try second.answer(reopen, open)
        _ = try await opening.value
        try await answering.value
        #expect(await second.nextSentRequest() == ["jsonrpc": "2.0", "id": "srq-7", "result": ["choice": "once"]])
        await backend.disconnect()
    }

    @Test func aThreadWithNothingRunningIsResumedOnlyWhenItIsUsed() async throws {
        let (backend, transports, first) = try await connected()
        var (thread, events) = try await runningThread(backend, first)
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))
        first.drop()

        let second = try await reconnected(transports)
        #expect(await events.next() == .detached)

        // Nothing was sent for it until now: the resume comes with its first use.
        let sending = Task { try await backend.send("again", to: thread.id) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == resumeParams)
        try second.answer(resume, ["session_id": "run-2", "running": false, "messages": []])
        let submit = try await second.expect("prompt.submit")
        #expect(submit["params"] == ["session_id": "run-2", "text": "again", "profile": "aeri"])
        try second.answer(submit, ["status": "streaming"])
        _ = try await sending.value

        // And it is followed again, with no snapshot in between.
        second.event("message.delta", seq: 1, session: "run-2", ["text": "Sure"])
        #expect(await events.next() == .textDelta("Sure"))
        await backend.disconnect()
    }

    @Test func aSessionTheHostUnloadedIsResumedAndTheCallRetried() async throws {
        let (backend, _, transport) = try await connected()
        let thread = try await createThread(backend, transport)

        let sending = Task { try await backend.send("hi", to: thread.id) }
        try transport.fail(try await transport.expect("prompt.submit"), code: 4001, message: "session not found")
        let resume = try await transport.expect("session.resume")
        #expect(resume["params"] == resumeParams)
        try transport.answer(resume, ["session_id": "run-2", "messages": []])
        let retried = try await transport.expect("prompt.submit")
        #expect(retried["params"] == ["session_id": "run-2", "text": "hi", "profile": "aeri"])
        try transport.answer(retried, ["status": "streaming"])
        #expect(try await sending.value == .started)
        await backend.disconnect()
    }

    @Test func aSessionThatStaysGoneFailsTheCall() async throws {
        let (backend, _, transport) = try await connected()
        let thread = try await createThread(backend, transport)

        let sending = Task { try await backend.send("hi", to: thread.id) }
        try transport.fail(try await transport.expect("prompt.submit"), code: 4001, message: "session not found")
        try transport.fail(try await transport.expect("session.resume"), code: 4007, message: "session not found")
        await #expect(throws: JSONRPCError(code: 4007, message: "session not found")) { _ = try await sending.value }
        await backend.disconnect()
    }

    // MARK: A bridge that replays (resume_replay)

    private let replays = ["resume_replay"]

    /// What a resume from event `since` of the run `epoch` sends a bridge that replays, for a
    /// conversation taken where the replay began at `base` (0 for one `openedThread` opens).
    private func replayParams(since: Int, epoch: String = "e1", base: Int = 0) -> JSONValue {
        [
            "session_id": "stored-1", "profile": "aeri", "inline_images": false, "since": .number(Double(since)), "replay_epoch": .string(epoch),
            "replay_base": .number(Double(base)),
        ]
    }

    /// What a resume for the whole thread sends a bridge that replays: the run, so that the
    /// answer says where the replay of the conversation it gives begins (`replay_base`).
    private func wholeParams(epoch: String = "e1") -> JSONValue {
        ["session_id": "stored-1", "profile": "aeri", "inline_images": false, "replay_epoch": .string(epoch)]
    }

    @Test func aBridgeThatReplaysBringsWhatARunningThreadMissedInItsAnswerToTheResume() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        var (_, events) = try await runningThread(backend, first, openedWhole: true)
        first.drop()

        let second = try await reconnected(transports, features: replays)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 2))
        // A live event that arrives before the answer waits behind what it brings.
        second.event("message.delta", seq: 5, ["text": "!"])
        try second.answer(resume, [
            "session_id": "run-1", "running": true, "replayed": true, "latest_seq": 4, "open_requests": [],
            "events": [
                ScriptedTransport.eventParams("message.delta", seq: 3, ["text": "lo"]),
                ScriptedTransport.eventParams("message.delta", seq: 4, ["text": " there"]),
            ],
            "info": ["model": "gpt-6", "provider": "openai", "reasoning_effort": "high", "usage": ["context_used": 1200, "context_max": 200_000]],
        ])
        // Said first, so that what shows the thread takes the replay in as one change.
        #expect(await events.next() == .catchUpBegan)
        #expect(await events.next() == .textDelta("lo"))
        #expect(await events.next() == .textDelta(" there"))
        #expect(await events.next() == .caughtUp(ThreadInfo(
            model: ModelSetting(model: "gpt-6", provider: "openai", level: .high), context: ContextUsage(used: 1200, limit: 200_000)
        )))
        #expect(await events.next() == .textDelta("!"))

        // One call where it was two: what comes next is what the app asks next, no session.events.since.
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        _ = try await listing.value
        // And it is followed as before: an event seen already is not applied twice.
        second.event("message.delta", seq: 4, ["text": " there"])
        second.event("message.complete", seq: 6, ["text": "Hello there!", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello there!"))
        await backend.disconnect()
    }

    /// 2026-10-26: after a reconnect the status line kept "Claude's API did not
    /// answer; trying again (attempt 6 of 10)…" as the work went on. The line the bridge
    /// took off while the device was away (its retry went through) is off once the device
    /// caught up, and the reply shows under no line.
    @Test func aStatusLineTheBridgeClearedWhileTheDeviceWasAwayIsGoneOnceItCatchesUp() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        var (_, events) = try await runningThread(backend, first, openedWhole: true)
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.textDelta("Hel"))
        let retrying = "Claude's API did not answer; trying again (attempt 6 of 10)…"
        first.event("thinking.delta", seq: 3, ["text": .string(retrying)])
        let shown = await events.next()
        #expect(shown == .status(retrying))
        if let shown { state.apply(shown) }
        #expect(state.statusLine == retrying)
        first.drop()

        let second = try await reconnected(transports, features: replays)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 3))
        try second.answer(resume, [
            "session_id": "run-1", "running": true, "replayed": true, "latest_seq": 5, "open_requests": [],
            "events": [
                ScriptedTransport.eventParams("thinking.delta", seq: 4, ["text": ""]),
                ScriptedTransport.eventParams("message.delta", seq: 5, ["text": "lo"]),
            ],
            "info": [:],
        ])
        while let event = await events.next() {
            state.apply(event)
            if case .caughtUp = event { break }
        }
        #expect(state.statusLine == nil)
        #expect(state.runStatus(replyIsArriving: true) == nil)
        await backend.disconnect()
    }

    @Test func aBridgeThatCannotReplaySendsTheWholeThreadAndIsAskedNothingMore() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        var (_, events) = try await runningThread(backend, first, openedWhole: true)
        first.drop()

        let second = try await reconnected(transports, features: replays)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 2))
        try second.answer(resume, [
            "session_id": "run-1", "running": true, "latest_seq": 900, "open_requests": [],
            "messages": [["role": "user", "text": "hi", "timestamp": 1]],
            "inflight": ["user": "hi", "assistant": "Hello th", "streaming": true],
        ])
        guard case let .snapshot(snapshot)? = await events.next() else {
            Issue.record("expected a snapshot")
            return
        }
        #expect(snapshot.transcript.turns.last?.items.map(\.content).last == .text("Hello th"))
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        _ = try await listing.value
        second.event("message.delta", seq: 901, ["text": "ere!"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("ere!"))
        await backend.disconnect()
    }

    /// Hermes, and a bridge from before the feature, are resumed as ever: never sent `since`
    /// or `replay_epoch`, which Hermes rejects, and asked for the events missed after.
    @Test(arguments: [[String](), ["queue", "turn_messages", "subagents"]])
    func aHostThatDoesNotReplayIsNeverSentTheKeys(features: [String]) async throws {
        let (backend, transports, first) = try await connected(features: features)
        var (thread, events) = try await runningThread(backend, first)
        first.drop()

        let second = try await reconnected(transports, features: features)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == resumeParams)
        try second.answer(resume, ["session_id": "run-1", "running": true, "messages": [["role": "user", "text": "hi", "timestamp": 1]]])
        let since = try await second.expect("session.events.since")
        try second.answer(since, [
            "events": [ScriptedTransport.eventParams("message.delta", seq: 3, ["text": "lo"])], "latest_seq": 3, "truncated": false, "open_requests": [],
        ])
        #expect(await events.next() == .textDelta("lo"))
        second.event("message.complete", seq: 4, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))

        // Back from the background, the thread at rest is opened whole, as ever.
        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let third = try await reconnected(transports, features: features)
        await resuming.value
        #expect(await events.next() == .detached)
        let catchingUp = Task { try await backend.catchUp(thread) }
        let reopen = try await third.expect("session.resume")
        #expect(reopen["params"] == resumeParams)
        try third.answer(reopen, ["session_id": "run-1", "running": false, "messages": [["role": "user", "text": "hi", "timestamp": 1]]])
        #expect(try await catchingUp.value != nil)
        await backend.disconnect()
    }

    /// Back from the background, the thread on screen at rest: only what it missed, on the
    /// stream it follows, where it was opened whole.
    @Test func theThreadOnScreenCatchesUpOnTheStreamItFollows() async throws {
        let (backend, transports, first) = try await connected(features: replays + ["modes"])
        var (thread, events) = try await runningThread(backend, first, openedWhole: true)
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))

        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, features: replays + ["modes"])
        await resuming.value
        #expect(await events.next() == .detached)

        // Another device's turn ran meanwhile, and the model was changed.
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 3))
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 6, "open_requests": [],
            "events": [
                ScriptedTransport.eventParams("message.start", seq: 4),
                ScriptedTransport.eventParams("message.delta", seq: 5, ["text": "Sure"]),
                ScriptedTransport.eventParams("message.complete", seq: 6, ["text": "Sure", "status": "complete"]),
            ],
            "info": ["title": "Greeting", "model": "fake-2", "provider": "fake", "mode": "plan"],
        ])
        #expect(try await catchingUp.value == nil)
        var state = ThreadState(transcript: Transcript(turns: [
            Turn(startedAt: .now, endedAt: .now, outcome: .completed, items: [TurnItem(.user(UserMessage(text: "hi"))), TurnItem(.text("Hello"))]),
        ]))
        // Said first: what follows up to `.caughtUp` is one change.
        #expect(await events.next() == .catchUpBegan)
        for _ in 0..<4 {
            state.apply(try #require(await events.next()))
        }
        #expect(state.transcript.turns.count == 2)
        #expect(state.title == "Greeting")
        #expect(state.model == ModelSetting(model: "fake-2", provider: "fake"))
        #expect(state.mode?.mode == .plan)
        #expect(state.phase == .idle)

        // Followed again on the same stream: no snapshot, nothing more asked.
        second.event("message.start", seq: 7)
        #expect(await events.next() == .turnStarted)
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        _ = try await listing.value
        await backend.disconnect()
    }

    @Test func aThreadOpenedWithNoEventSinceCatchesUpFromWhatItsSnapshotHeld() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        let open = try await first.expect("session.resume")
        #expect(open["params"] == wholeParams())
        try first.answer(open, ["session_id": "run-1", "running": false, "latest_seq": 41, "replay_base": 37, "messages": []])
        _ = try await opening.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        first.drop()
        let second = try await reconnected(transports, features: replays)
        #expect(await events.nextLeavingOutRoster() == .detached)

        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 41, base: 37))
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 41, "replay_base": 37, "events": [], "open_requests": [], "info": [:],
        ])
        #expect(try await catchingUp.value == nil)
        #expect(await events.nextLeavingOutRoster() == .catchUpBegan)
        #expect(await events.nextLeavingOutRoster() == .caughtUp(ThreadInfo()))
        await backend.disconnect()
    }

    /// A conversation that changed with no event while the thread followed it on (a running
    /// Codex turn taken for a /compact, found to be opened by a message): the thread holds
    /// events after the change, with the opener from before it. Back at the front it sends
    /// where the replay of the conversation it took began, which the bridge has moved on
    /// from: the whole thread then, with the message as its opener, and the next catch-up
    /// sends where the replay of that one begins. Whether it is taken whole is the bridge's
    /// to say (bridge/test/sync.test.ts), and the answers here are whole whatever is sent:
    /// what this tests is the app's part, what it sends and the base it keeps.
    @Test func aThreadThatFollowedAChangeNoEventToldOfIsTakenWholeWithItsOpenerReplaced() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        let open = try await first.expect("session.resume")
        #expect(open["params"] == wholeParams())
        try first.answer(open, [
            "session_id": "run-1", "running": true, "latest_seq": 1, "replay_base": 0, "open_requests": [],
            "messages": [["role": "user", "text": "/compact", "timestamp": 1]],
            "inflight": ["user": "/compact", "assistant": ""],
        ])
        _ = try await opening.value
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        // The bridge found the turn opened by a message (its replay now begins at 2), which
        // no event tells; the thread follows the turn on to its end.
        first.event("message.delta", seq: 3, ["text": "Working on it."])
        first.event("message.complete", seq: 4, ["text": "Working on it.", "status": "complete"])
        #expect(await events.nextLeavingOutRoster() == .textDelta("Working on it."))
        #expect(await events.nextLeavingOutRoster() == .turnFinished(.completed, finalText: "Working on it."))

        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, features: replays)
        await resuming.value
        #expect(await events.nextLeavingOutRoster() == .detached)
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 4, base: 0))
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "latest_seq": 4, "replay_base": 2, "open_requests": [],
            "messages": [["role": "user", "text": "Asked at the desk", "timestamp": 1], ["role": "assistant", "text": "Working on it.", "timestamp": 2]],
        ])
        let snapshot = try #require(try await catchingUp.value)
        #expect(snapshot.transcript.turns.count == 1)
        guard case let .user(opener)? = snapshot.transcript.turns.first?.items.first?.content else {
            Issue.record("expected the turn to open with the user's message")
            return
        }
        #expect(opener.text == "Asked at the desk")
        events = await backend.events(for: thread.id).makeAsyncIterator()

        await backend.suspend()
        let resumingAgain = Task { await backend.resume() }
        let third = try await reconnected(transports, features: replays)
        await resumingAgain.value
        #expect(await events.nextLeavingOutRoster() == .detached)
        let catchingUpAgain = Task { try await backend.catchUp(thread) }
        let again = try await third.expect("session.resume")
        #expect(again["params"] == replayParams(since: 4, base: 2))
        try third.answer(again, [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 4, "replay_base": 2, "events": [], "open_requests": [], "info": [:],
        ])
        #expect(try await catchingUpAgain.value == nil)
        await backend.disconnect()
    }

    /// Back at the front, from a bridge that replays but answers whole (its log no longer
    /// reaches back, or the conversation is the lighter): the thread is opened on a new
    /// stream, with nothing more asked.
    @Test func aThreadOnScreenTheBridgeAnswersWholeIsOpenedOnANewStream() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let (thread, running) = try await runningThread(backend, first, openedWhole: true)
        var events = running
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))

        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, features: replays)
        await resuming.value
        #expect(await events.next() == .detached)

        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == replayParams(since: 3))
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "latest_seq": 9, "open_requests": [],
            "messages": [
                ["role": "user", "text": "hi", "timestamp": 1], ["role": "assistant", "text": "Hello", "timestamp": 2],
                ["role": "user", "text": "more", "timestamp": 3], ["role": "assistant", "text": "Sure", "timestamp": 4],
            ],
        ])
        let snapshot = try #require(try await catchingUp.value)
        #expect(snapshot.transcript.turns.count == 2)
        // What follows the snapshot is on a new stream: the one before ends.
        #expect(await events.next() == nil)
        var reopened = await backend.events(for: thread.id).makeAsyncIterator()

        // Nothing more asked: what comes next is what the app asks next, no session.events.since.
        let listing = Task { try await backend.listAgents() }
        try second.answer(try await second.expect("profiles.list"), ["profiles": [["name": "default"]]])
        _ = try await listing.value
        second.event("message.start", seq: 10)
        #expect(await reopened.nextLeavingOutRoster() == .turnStarted)
        await backend.disconnect()
    }

    /// A light answer that comes after the session was resumed for a call (a message sent as
    /// the thread came back) follows numbers the thread no longer holds: it is opened whole.
    @Test func aCatchUpOvertakenByAResumeForACallOpensTheThreadWhole() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let (thread, running) = try await runningThread(backend, first, openedWhole: true)
        var events = running
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))

        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, features: replays)
        await resuming.value
        #expect(await events.next() == .detached)

        let catchingUp = Task { try await backend.catchUp(thread) }
        let light = try await second.expect("session.resume")
        #expect(light["params"] == replayParams(since: 3))
        // A message sent meanwhile resumes the session for itself, and is answered first.
        let sending = Task { try await backend.send("again", to: thread.id) }
        let attaching = try await second.expect("session.resume")
        #expect(attaching["params"] == wholeParams())
        try second.answer(attaching, ["session_id": "run-1", "running": false, "latest_seq": 3, "replay_base": 0, "open_requests": [], "messages": []])
        try second.answer(try await second.expect("prompt.submit"), ["status": "streaming"])
        _ = try await sending.value

        try second.answer(light, [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 3, "replay_base": 0, "events": [], "open_requests": [], "info": [:],
        ])
        let reopen = try await second.expect("session.resume")
        #expect(reopen["params"] == wholeParams())
        try second.answer(reopen, [
            "session_id": "run-1", "running": true, "latest_seq": 4, "open_requests": [],
            "messages": [
                ["role": "user", "text": "hi", "timestamp": 1], ["role": "assistant", "text": "Hello", "timestamp": 2],
                ["role": "user", "text": "again", "timestamp": 3],
            ],
            "inflight": ["user": "again", "assistant": ""],
        ])
        let snapshot = try #require(try await catchingUp.value)
        #expect(snapshot.transcript.turns.count == 2)
        #expect(snapshot.isRunning)
        var reopened = await backend.events(for: thread.id).makeAsyncIterator()
        second.event("message.delta", seq: 5, ["text": "Sure"])
        #expect(await reopened.nextLeavingOutRoster() == .textDelta("Sure"))
        await backend.disconnect()
    }

    /// A thread that holds no event number from this run of the bridge is opened whole: the
    /// bridge restarted, or the session was resumed for a call without the thread being told.
    @Test func aThreadWithNoNumberFromThisRunIsOpenedWhole() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let (thread, running) = try await runningThread(backend, first)
        var events = running
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))
        first.drop()

        // Another run of the bridge.
        let second = try await reconnected(transports, epoch: "e2", features: replays)
        #expect(await events.next() == .detached)
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == wholeParams(epoch: "e2"))
        try second.answer(resume, [
            "session_id": "run-1", "running": false, "latest_seq": 2, "replay_base": 0, "messages": [["role": "user", "text": "hi", "timestamp": 1]],
        ])
        #expect(try await catchingUp.value?.transcript.turns.count == 1)
        events = await backend.events(for: thread.id).makeAsyncIterator()

        // Detached again, then resumed for a message without the thread being told: its
        // stream does not hold what the session is now.
        second.drop()
        let third = try await reconnected(transports, epoch: "e2", features: replays)
        #expect(await events.nextLeavingOutRoster() == .detached)
        let sending = Task { try await backend.send("again", to: thread.id) }
        let attaching = try await third.expect("session.resume")
        #expect(attaching["params"] == wholeParams(epoch: "e2"))
        try third.answer(attaching, ["session_id": "run-1", "running": false, "latest_seq": 2, "replay_base": 0, "messages": []])
        try third.answer(try await third.expect("prompt.submit"), ["status": "streaming"])
        _ = try await sending.value
        third.event("message.start", seq: 3)
        third.event("message.complete", seq: 4, ["text": "Sure", "status": "complete"])
        #expect(await events.nextLeavingOutRoster() == .turnStarted)
        #expect(await events.nextLeavingOutRoster() == .turnFinished(.completed, finalText: "Sure"))
        third.drop()
        let fourth = try await reconnected(transports, epoch: "e2", features: replays)
        #expect(await events.nextLeavingOutRoster() == .detached)
        let catchingUpAgain = Task { try await backend.catchUp(thread) }
        let reopen = try await fourth.expect("session.resume")
        #expect(reopen["params"] == wholeParams(epoch: "e2"))
        try fourth.answer(reopen, ["session_id": "run-1", "running": false, "latest_seq": 4, "messages": []])
        #expect(try await catchingUpAgain.value != nil)
        await backend.disconnect()
    }

    /// A thread made here may be one the session held a conversation for already, as an
    /// older bridge's Aeri gave from `session.create`, with what was said before, and
    /// which no event tells. The thread holds none of it, so its first catch-up takes it
    /// whole, what was said before and all, where the bridge would have replayed from its
    /// first event and the thread kept only its own turn; the next, from the answer it took,
    /// only what it missed.
    @Test func aThreadMadeHereIsTakenWholeAtItsFirstCatchUp() async throws {
        let (backend, transports, first) = try await connected(features: replays)
        let (thread, running) = try await runningThread(backend, first)
        var events = running
        first.event("message.complete", seq: 3, ["text": "Hello", "status": "complete"])
        #expect(await events.next() == .turnFinished(.completed, finalText: "Hello"))

        await backend.suspend()
        let resuming = Task { await backend.resume() }
        let second = try await reconnected(transports, features: replays)
        await resuming.value
        #expect(await events.next() == .detached)
        let catchingUp = Task { try await backend.catchUp(thread) }
        let resume = try await second.expect("session.resume")
        #expect(resume["params"] == wholeParams())
        // Answered as the bridge answers what it is sent: from event 3 of a replay begun at 0
        // it has every event, and replays them, with none of what was said before.
        let whole: JSONValue = [
            "session_id": "run-1", "running": false, "latest_seq": 3, "replay_base": 0, "open_requests": [],
            "messages": [
                ["role": "user", "text": "Good morning", "timestamp": 1], ["role": "assistant", "text": "Morning!", "timestamp": 2],
                ["role": "user", "text": "hi", "timestamp": 3], ["role": "assistant", "text": "Hello", "timestamp": 4],
            ],
        ]
        let light: JSONValue = [
            "session_id": "run-1", "running": false, "replayed": true, "latest_seq": 3, "replay_base": 0, "events": [], "open_requests": [], "info": [:],
        ]
        try second.answer(resume, resume["params"] == wholeParams() ? whole : light)
        let snapshot = try #require(try await catchingUp.value)
        #expect(snapshot.transcript.turns.count == 2)
        guard case let .user(opener)? = snapshot.transcript.turns.first?.items.first?.content else {
            Issue.record("expected the conversation to open with what was said before")
            return
        }
        #expect(opener.text == "Good morning")
        events = await backend.events(for: thread.id).makeAsyncIterator()

        await backend.suspend()
        let resumingAgain = Task { await backend.resume() }
        let third = try await reconnected(transports, features: replays)
        await resumingAgain.value
        #expect(await events.nextLeavingOutRoster() == .detached)
        let catchingUpAgain = Task { try await backend.catchUp(thread) }
        let again = try await third.expect("session.resume")
        #expect(again["params"] == replayParams(since: 3, base: 0))
        try third.answer(again, light)
        #expect(try await catchingUpAgain.value == nil)
        await backend.disconnect()
    }

    // MARK: Recordings of a real reattach

    /// What the probe sent and received when it reattached to a run in progress.
    private struct Recording {
        let storedID: String
        let runtimeID: String
        let lastSeen: Int
        let epoch: String
        /// The reply text in the events the client had missed, then in those that
        /// arrived live after it caught up.
        let missed: [String]
        let live: [String]

        init(_ capture: String) throws {
            let sent = try Fixtures.frames(capture, direction: "out")
            let received = try Fixtures.frames(capture, direction: "in")
            func params(_ method: String) throws -> JSONValue {
                try #require(sent.first { $0["method"]?.stringValue == method }?["params"])
            }
            storedID = try #require(try params("session.resume")["session_id"]?.stringValue)
            runtimeID = try #require(try params("session.events.since")["session_id"]?.stringValue)
            lastSeen = try #require(try params("session.events.since")["last_seen"]?.intValue)
            epoch = try #require(received.first?["params"]?["payload"]?["replay_epoch"]?.stringValue)

            func deltas(_ events: [JSONValue]) -> [String] {
                events.filter { $0["type"]?.stringValue == "message.delta" }.compactMap { $0["payload"]?["text"]?.stringValue }
            }
            let since = received.first { $0["result"]?["latest_seq"] != nil }?["result"]
            missed = deltas(since?["events"]?.arrayValue ?? [])
            live = deltas(received.filter { $0["method"]?.stringValue == "event" }.compactMap { $0["params"] })
        }
    }

    @Test(arguments: ["reattach-running.jsonl", "reattach-midtext.jsonl", "bridge-reattach-running.jsonl", "bridge-claude-reattach-running.jsonl"])
    func aRecordedReattachContinuesTheReplyWhereItWas(capture: String) async throws {
        let recording = try Recording(capture)
        let transports = TransportSequence()
        let backend = makeBackend(transports)

        // The first connection, by hand: the thread is open with a run in progress, and
        // has seen events up to where the recording picks up.
        let connecting = Task { try await backend.connect() }
        let first = try #require(await transports.next())
        try await first.shakeHands(epoch: recording.epoch)
        try await connecting.value
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: recording.storedID), agent: Agent.ID(host: backend.host, name: "default"))
        let opening = Task { try await backend.openThread(ref) }
        try first.answer(try await first.expect("session.resume"), [
            "session_id": .string(recording.runtimeID), "running": true,
            "messages": [["role": "user", "text": "Write an essay.", "timestamp": 1]],
        ])
        var state = ThreadState()
        state.adopt(try await opening.value)
        #expect(state.isRunning)
        var events = await backend.events(for: ref.id).makeAsyncIterator()
        first.event("message.delta", seq: recording.lastSeen, session: recording.runtimeID, ["text": "Before the drop. "])
        state.apply(try #require(await events.next()))
        first.drop()

        // The second connection is the recording.
        let second = try #require(await transports.next())
        let server = try RecordedServer(capture: capture, transport: second, eventsFollow: .request("session.events.since"))
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        while let event = await events.next() {
            state.apply(event)
            if case .turnFinished = event { break }
        }
        await backend.disconnect()

        // One turn, whose reply is what was seen before the drop, then what was missed,
        // then what arrived live: nothing lost and nothing twice.
        #expect(!recording.live.isEmpty)
        #expect(state.transcript.turns.count == 1)
        let turn = try #require(state.transcript.turns.first)
        #expect(turn.outcome == .completed)
        let reply = turn.items.compactMap { if case let .text(text) = $0.content { text } else { nil } }
        #expect(reply == ["Before the drop. " + (recording.missed + recording.live).joined()])
        #expect(state.phase == .idle)
    }

    @Test func aRecordedThreadBlockedOnAnApprovalIsReopenedAndAnswered() async throws {
        let capture = "reattach-approval.jsonl"
        let recording = try Recording(capture)
        let server = try RecordedServer(capture: capture, eventsFollow: .answer)
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            makeTransport: { _ in server.transport }
        )
        let serving = Task { await server.run() }
        defer { serving.cancel() }
        try await backend.connect()

        // Opened the way the app opens a saved thread: the host says a run is going on
        // and what it is waiting for.
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: recording.storedID), agent: Agent.ID(host: backend.host, name: "default"))
        let snapshot = try await backend.openThread(ref)
        var state = ThreadState()
        state.adopt(snapshot)
        #expect(state.isRunning)
        let request = try #require(state.openRequests.first)
        guard case let .approval(approval) = request.kind else {
            Issue.record("expected an approval")
            return
        }
        #expect(approval.command.hasPrefix("rm -rf /nonexistent-aeriportal-approval-test"))
        #expect(approval.choices == [.once, .session, .always, .deny])
        let running = try #require(state.transcript.turns.last)
        #expect(running.isRunning)
        #expect(running.items.first?.isUserMessage == true)

        // Answered by its id, the run carries on to its end.
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
        let contents = turn.items.map(\.content)
        #expect(contents.contains { if case let .request(record) = $0 { record.answer == "Denied" } else { false } })
        // The command's start was before the app came back; its result still shows
        // which command it was.
        let run = try #require(contents.compactMap { if case let .tool(run) = $0 { run } else { nil } }.first)
        #expect(run.name == "terminal")
        #expect(run.label?.hasPrefix("rm -rf /nonexistent-aeriportal-approval-test") == true)
        #expect(run.state == .failed)
        #expect(run.output == "You denied this command — it did not run.")
        guard case let .text(reply)? = contents.last else {
            Issue.record("expected the turn to end with the reply")
            return
        }
        #expect(reply.hasPrefix("The command was blocked"))
    }
}

/// Whether an answer has been given, for a test that waits to see it has not.
private actor AnsweredFlag {
    private(set) var isSet = false
    func set() { isSet = true }
}
