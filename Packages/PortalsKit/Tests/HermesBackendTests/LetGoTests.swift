import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A thread nobody listens to any more (the app let go of it: at rest, off screen, past
/// the few it keeps open) is not followed any more: a bridge with `session_leave` is told,
/// and what still comes for it is dropped unread, its questions unanswered rather than
/// refused, and a reconnect does not resume it.
@Suite struct LetGoTests {
    private let leaves = [BridgeWire.Feature.sessionLeave]

    private func connected(features: [String] = []) async throws -> (HermesBackend, TransportSequence, ScriptedTransport) {
        let transports = TransportSequence()
        let backend = HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            reconnectDelays: [.milliseconds(5)],
            makeTransport: { _ in transports.make() }
        )
        let connecting = Task { try await backend.connect() }
        let transport = try #require(await transports.next())
        try await transport.shakeHands(epoch: "e1", features: features)
        try await connecting.value
        return (backend, transports, transport)
    }

    /// A thread stored as `stored-1` and live as `run-1`, made on this connection.
    private func createThread(_ backend: HermesBackend, _ transport: ScriptedTransport) async throws -> ThreadRef {
        let creating = Task { try await backend.createThread(with: Agent.ID(host: backend.host, name: "aeri"), options: ThreadOptions()) }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1", "stored_session_id": "stored-1"])
        return try await creating.value
    }

    /// Listens to the thread as a thread's controller does, until the task is cancelled
    /// (the controller closed); what it heard goes to `heard`.
    private func listen(to thread: ThreadRef.ID, on backend: HermesBackend, heard: AsyncStream<ThreadEvent>.Continuation) -> Task<Void, Never> {
        Task {
            for await event in await backend.events(for: thread) {
                heard.yield(event)
            }
        }
    }

    /// The next frame the app sends after asking for the agents: the request it is waiting
    /// for, unless something was sent before it (an answer to a question, a resume).
    private func nextAfterListingAgents(_ backend: HermesBackend, _ transport: ScriptedTransport) async throws -> JSONValue {
        let listing = Task { try await backend.listAgents() }
        let frame = try #require(await transport.nextSentRequest())
        if frame["method"]?.stringValue == "profiles.list" {
            try transport.answer(frame, ["profiles": [["name": "aeri"]]])
            _ = try await listing.value
        } else {
            listing.cancel()
        }
        return frame
    }

    @Test func aBridgeThatOffersItIsToldWhenNobodyListensAndWhatComesAfterIsDropped() async throws {
        let (backend, _, transport) = try await connected(features: leaves)
        let thread = try await createThread(backend, transport)
        let (heard, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        var events = heard.makeAsyncIterator()
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        transport.event("message.start", seq: 1)
        #expect(await events.next() == .turnStarted)

        listening.cancel()
        let leave = try await transport.expect("session.leave")
        #expect(leave["params"] == ["session_id": "run-1", "profile": "aeri"])
        try transport.answer(leave, [:])

        // Another device sets it to work: a reply, then a question for this thread.
        transport.event("message.delta", seq: 2, ["text": "Hel"])
        transport.approval("srq-1", command: "rm -rf build")
        // No answer to the question went back, no refusal: the next frame is the app's own.
        let next = try await nextAfterListingAgents(backend, transport)
        #expect(next["method"]?.stringValue == "profiles.list")
        await backend.disconnect()
    }

    @Test func aHostWithoutTheFeatureIsToldNothingButItsQuestionsAreNotRefusedAndAReconnectDoesNotResumeIt() async throws {
        let (backend, transports, transport) = try await connected()
        var states = backend.connectionStates.makeAsyncIterator()
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        let thread = try await createThread(backend, transport)
        let (heard, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        var events = heard.makeAsyncIterator()
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        // A run under way: such a thread is resumed at once after a reconnect, while followed.
        transport.event("message.start", seq: 1)
        #expect(await events.next() == .turnStarted)

        listening.cancel()
        // Nothing is sent to such a host to say it was let go of: give it a moment.
        try await Task.sleep(for: .milliseconds(50))
        let first = try await nextAfterListingAgents(backend, transport)
        #expect(first["method"]?.stringValue == "profiles.list")

        transport.event("message.delta", seq: 2, ["text": "Hel"])
        transport.approval("srq-1", command: "rm -rf build")
        let next = try await nextAfterListingAgents(backend, transport)
        #expect(next["method"]?.stringValue == "profiles.list", "nothing answered the question: \(next)")

        // On the next connection it is not resumed: the first thing sent is the app's own call.
        transport.drop()
        guard case .disconnected? = await states.next() else {
            Issue.record("expected a disconnected state")
            return
        }
        let second = try #require(await transports.next())
        try await second.shakeHands(epoch: "e1")
        #expect(await states.next() == .connecting)
        #expect(await states.next() == .connected)
        let afterReconnect = try await nextAfterListingAgents(backend, second)
        #expect(afterReconnect["method"]?.stringValue == "profiles.list", "resumed though let go of: \(afterReconnect)")
        await backend.disconnect()
    }

    @Test func aThreadOpenedAgainAfterItWasLetGoOfIsResumedOnlyOnceTheLeaveIsAnswered() async throws {
        let (backend, _, transport) = try await connected(features: leaves)
        let thread = try await createThread(backend, transport)
        let (_, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        // Listening before it is let go of.
        let ready = try await nextAfterListingAgents(backend, transport)
        #expect(ready["method"]?.stringValue == "profiles.list")
        listening.cancel()
        let leave = try await transport.expect("session.leave")

        // Opened again at once: its resume waits for the leave, which would otherwise come
        // after it and leave the thread unfollowed.
        let opening = Task { try await backend.openThread(thread) }
        try transport.answer(leave, [:])
        let resume = try await transport.expect("session.resume")
        #expect(resume["params"]?["session_id"]?.stringValue == "stored-1")
        try transport.answer(resume, ["session_id": "run-1", "running": false, "messages": []])
        _ = try await opening.value

        // Followed again: its events reach whoever listens now.
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        transport.event("message.start", seq: 1)
        #expect(await events.nextLeavingOutRoster() == .turnStarted)
        await backend.disconnect()
    }

    /// What comes for a thread opened again, between the resume's answer and the snapshot
    /// being taken in, is kept for it: the answer and those events reach the backend by
    /// separate ways, and the events can come first. Delivered here before the answer.
    // Lost, it never comes: the limit makes that a failure, not a hang.
    @Test(.timeLimit(.minutes(1))) func aThreadOpenedAgainKeepsWhatComesBeforeItsSnapshotIsTakenIn() async throws {
        let (backend, _, transport) = try await connected(features: leaves)
        let thread = try await createThread(backend, transport)
        let (_, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        let ready = try await nextAfterListingAgents(backend, transport)
        #expect(ready["method"]?.stringValue == "profiles.list")
        listening.cancel()
        try transport.answer(try await transport.expect("session.leave"), [:])

        let opening = Task { try await backend.openThread(thread) }
        let resume = try await transport.expect("session.resume")
        transport.event("message.start", seq: 1)
        transport.approval("srq-9", command: "make test")
        try transport.answer(resume, ["session_id": "run-1", "running": false, "latest_seq": 0, "messages": []])
        _ = try await opening.value

        var events = await backend.events(for: thread.id).makeAsyncIterator()
        #expect(await events.nextLeavingOutRoster() == .turnStarted)
        guard case let .requestOpened(request)? = await events.nextLeavingOutRoster() else {
            Issue.record("the question was lost")
            return
        }
        #expect(request.id == "srq-9")
        // And not refused: the next frame sent is the app's own.
        let next = try await nextAfterListingAgents(backend, transport)
        #expect(next["method"]?.stringValue == "profiles.list", "\(next)")
        await backend.disconnect()
    }

    /// The same for a thread a bridge's connection opens for the first time: a bridge keeps
    /// a thread's id as its session's, so what comes for it is known to be the thread's.
    // Lost, it never comes: the limit makes that a failure, not a hang.
    @Test(.timeLimit(.minutes(1))) func aThreadOpenedFromABridgeKeepsWhatComesBeforeItsSnapshotIsTakenIn() async throws {
        let (backend, _, transport) = try await connected(features: leaves)
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: backend.host, name: "aeri"))
        let opening = Task { try await backend.openThread(thread) }
        let resume = try await transport.expect("session.resume")
        transport.event("message.start", seq: 1, session: "stored-1")
        transport.approval("srq-9", command: "make test", session: "stored-1")
        try transport.answer(resume, ["session_id": "stored-1", "running": false, "latest_seq": 0, "messages": []])
        _ = try await opening.value

        var events = await backend.events(for: thread.id).makeAsyncIterator()
        #expect(await events.nextLeavingOutRoster() == .turnStarted)
        guard case let .requestOpened(request)? = await events.nextLeavingOutRoster() else {
            Issue.record("the question was lost")
            return
        }
        #expect(request.id == "srq-9")
        let next = try await nextAfterListingAgents(backend, transport)
        #expect(next["method"]?.stringValue == "profiles.list", "\(next)")
        await backend.disconnect()
    }

    @Test func aThreadLetGoOfWhileItIsResumedIsLetGoOfOnceTheResumeIsOver() async throws {
        let (backend, transports, transport) = try await connected(features: leaves)
        let thread = try await createThread(backend, transport)
        let (heard, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        var events = heard.makeAsyncIterator()
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        transport.event("message.start", seq: 1)
        #expect(await events.next() == .turnStarted)

        // Reconnected: the running thread is resumed at once, and its listener goes meanwhile.
        transport.drop()
        let second = try #require(await transports.next())
        try await second.shakeHands(epoch: "e1", features: leaves)
        let resume = try await second.expect("session.resume")
        listening.cancel()
        try second.answer(resume, ["session_id": "run-1", "running": true, "messages": []])
        // The same server run: the events it missed are asked for, as for any running thread.
        try second.answer(try await second.expect("session.events.since"), ["events": [], "truncated": false, "open_requests": []])
        let leave = try await second.expect("session.leave")
        #expect(leave["params"] == ["session_id": "run-1", "profile": "aeri"])
        try second.answer(leave, [:])
        await backend.disconnect()
    }

    @Test func aThreadStillListenedToIsKept() async throws {
        let (backend, _, transport) = try await connected(features: leaves)
        let thread = try await createThread(backend, transport)
        let (heard, heardContinuation) = AsyncStream.makeStream(of: ThreadEvent.self)
        var events = heard.makeAsyncIterator()
        let listening = listen(to: thread.id, on: backend, heard: heardContinuation)
        transport.event("message.start", seq: 1)
        #expect(await events.next() == .turnStarted)
        // Reopened while listened to: the old stream ends because a new one replaces it, which
        // lets nothing go.
        let opening = Task { try await backend.openThread(thread) }
        try transport.answer(try await transport.expect("session.resume"), ["session_id": "run-1", "running": true, "messages": []])
        _ = try await opening.value
        let next = try await nextAfterListingAgents(backend, transport)
        #expect(next["method"]?.stringValue == "profiles.list")
        listening.cancel()
        _ = heard
        await backend.disconnect()
    }
}
