import AgentCore
import Foundation
import Synchronization
@testable import HermesBackend

/// A `WebSocketTransport` driven by the test: the test feeds inbound frames and reads
/// what the client sent.
final class ScriptedTransport: WebSocketTransport {
    struct Closed: Error {}

    private let inbound: AsyncStream<String>
    private let inboundContinuation: AsyncStream<String>.Continuation
    private let sent: AsyncStream<String>
    private let sentContinuation: AsyncStream<String>.Continuation
    private let closedFlag = Mutex(false)
    private let closeAsked = Mutex(false)
    private let closeHeld = Mutex(false)
    private let closeReleased = DispatchSemaphore(value: 0)
    /// What receiving throws once the server went away (`drop(with:)`); `Closed` when nil.
    private let dropError = Mutex<WebSocketClosed?>(nil)

    init() {
        (inbound, inboundContinuation) = AsyncStream.makeStream()
        (sent, sentContinuation) = AsyncStream.makeStream()
    }

    var isClosed: Bool { closedFlag.withLock { $0 } }

    /// `close()` was called: it may be held still (`holdClose`).
    var isClosing: Bool { closeAsked.withLock { $0 } }

    // MARK: WebSocketTransport

    func send(_ text: String) async throws {
        if isClosed { throw Closed() }
        sentContinuation.yield(text)
    }

    func receive() async throws -> String {
        for await text in inbound {
            return text
        }
        if let error = dropError.withLock({ $0 }) { throw error }
        throw Closed()
    }

    func close() {
        closeAsked.withLock { $0 = true }
        // A socket slow to close: the peer closing it, and whoever waits for that, wait too.
        if closeHeld.withLock({ $0 }) { _ = closeReleased.wait(timeout: .now() + .seconds(10)) }
        closedFlag.withLock { $0 = true }
        inboundContinuation.finish()
        sentContinuation.finish()
    }

    // MARK: Test side

    /// Delivers one frame to the client.
    func deliver(_ frame: JSONValue) {
        inboundContinuation.yield(try! frame.serialized())
    }

    func deliver(text: String) {
        inboundContinuation.yield(text)
    }

    /// The server went away.
    func drop() {
        inboundContinuation.finish()
    }

    /// The server closed the socket with a close code, as a bridge does refusing a token.
    func drop(with error: WebSocketClosed) {
        dropError.withLock { $0 = error }
        inboundContinuation.finish()
    }

    /// Holds `close()`, once called, until `releaseClose()` (or ten seconds), as a socket
    /// slow to close. `close()` is synchronous: it holds the thread it is called on.
    func holdClose() {
        closeHeld.withLock { $0 = true }
    }

    func releaseClose() {
        closeReleased.signal()
    }

    /// The next frame the client sent, parsed.
    func nextSent() async -> JSONValue? {
        for await text in sent {
            return try? JSONValue.parse(text)
        }
        return nil
    }

    /// The next sent frame a test is about: not a heartbeat ping, and not the question
    /// about who is at work for a session, which every reopened thread asks on the side
    /// and which is answered here with nobody. `includingRoster` hands that question to
    /// the test instead.
    func nextSentRequest(includingRoster: Bool = false) async -> JSONValue? {
        while let frame = await nextSent() {
            switch frame["method"]?.stringValue {
            case "gateway.ping":
                continue
            case "subagent.list" where !includingRoster:
                if let id = frame["id"] {
                    deliver(["jsonrpc": "2.0", "id": id, "result": ["subagents": [], "delegations": []]])
                }
            default:
                return frame
            }
        }
        return nil
    }
}

extension AsyncStream<ThreadEvent>.AsyncIterator {
    /// The next thing that happened in a thread, leaving out the list of who is at
    /// work for it, which follows every snapshot on the side.
    mutating func nextLeavingOutRoster() async -> ThreadEvent? {
        while let event = await next() {
            if case .subagentsListed = event { continue }
            return event
        }
        return nil
    }
}
