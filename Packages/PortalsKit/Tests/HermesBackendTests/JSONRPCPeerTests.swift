import Testing
@testable import HermesBackend

@Suite struct JSONRPCPeerTests {
    @Test func aResumeReceiptKeepsTheOriginalRequestArrivalBoundary() async throws {
        let (peer, transport) = await makePeer()
        let response = Task { try await peer.requestWithReceipt("session.resume") }
        let id = try #require(await transport.nextSent()?["id"])
        transport.deliver(["jsonrpc": "2.0", "id": "before", "method": "approval", "params": ["session_id": "s1"]])
        transport.deliver(["jsonrpc": "2.0", "id": id, "result": [:]])
        transport.deliver(["jsonrpc": "2.0", "id": "after", "method": "approval", "params": ["session_id": "s1"]])
        // Deliberately consume inbound only after the independent RPC continuation.
        let receipt = try await response.value
        var iterator = peer.inbound.makeAsyncIterator()
        guard case let .request(before)? = await iterator.next(),
              case let .request(after)? = await iterator.next() else {
            Issue.record("expected both requests")
            await peer.close()
            return
        }
        #expect(try #require(before.receivedAtFrame) < receipt.frame)
        #expect(try #require(after.receivedAtFrame) > receipt.frame)
        await peer.close()
    }
    @Test func aRequestWhoseCallerWasAlreadyCancelledIsNotSent() async throws {
        let (peer, transport) = await makePeer()
        let cancelled = Task { () -> Result<JSONValue, any Error> in
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                return .success(try await peer.request("prompt.submit", timeout: .milliseconds(50)))
            } catch {
                return .failure(error)
            }
        }
        guard case let .failure(error) = await cancelled.value else {
            Issue.record("a request made by a cancelled caller must not succeed")
            await peer.close()
            return
        }
        #expect(error is CancellationError)

        let sentinel = Task { try await peer.request("net.list") }
        var methods: [String] = []
        while true {
            let sent = try #require(await transport.nextSent())
            let method = try #require(sent["method"]?.stringValue)
            methods.append(method)
            guard method == "net.list" else { continue }
            transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": [:]])
            break
        }
        #expect(methods == ["net.list"])
        #expect(try await sentinel.value == [:])
        await peer.close()
    }

    @Test func aRequestAfterAnAcceptedUploadIsNotSentOnceTheCallerIsCancelled() async throws {
        let (peer, transport) = await makePeer()
        let calls = Task { () -> Result<Void, any Error> in
            do {
                _ = try await peer.request("image.attach_bytes")
                withUnsafeCurrentTask { $0?.cancel() }
                _ = try await peer.request("prompt.submit", timeout: .milliseconds(50))
                return .success(())
            } catch {
                return .failure(error)
            }
        }
        let upload = try #require(await transport.nextSent())
        #expect(upload["method"] == "image.attach_bytes")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(upload["id"]), "result": ["attached": true]])
        guard case let .failure(error) = await calls.value else {
            Issue.record("a prompt made by a cancelled caller must not succeed")
            await peer.close()
            return
        }
        #expect(error is CancellationError)

        let sentinel = Task { try await peer.request("net.list") }
        var methods: [String] = []
        while true {
            let sent = try #require(await transport.nextSent())
            let method = try #require(sent["method"]?.stringValue)
            methods.append(method)
            guard method == "net.list" else { continue }
            transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": [:]])
            break
        }
        #expect(methods == ["net.list"])
        #expect(try await sentinel.value == [:])
        await peer.close()
    }

    private func makePeer(_ configure: (inout JSONRPCPeer.Options) -> Void = { _ in }) async -> (JSONRPCPeer, ScriptedTransport) {
        let transport = ScriptedTransport()
        var options = JSONRPCPeer.Options()
        configure(&options)
        let peer = JSONRPCPeer(transport: transport, options: options)
        await peer.start()
        return (peer, transport)
    }

    /// A call the socket does not carry (one over the relay's limit) fails alone, before it
    /// is sent: the connection stays up for the next.
    @Test func aCallTheSocketDoesNotCarryFailsAloneAndTheConnectionStays() async throws {
        let transport = ScriptedTransport()
        let peer = JSONRPCPeer(transport: CarryingAtMost(base: transport, bytes: 200))
        await peer.start()
        await #expect(throws: TooLargeForRelay.self) {
            try await peer.request("file.attach_bytes", params: ["content_base64": .string(String(repeating: "A", count: 300))])
        }
        async let small = peer.request("net.list")
        let sent = try #require(await transport.nextSent())
        #expect(sent["method"] == "net.list")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": [:]])
        #expect(try await small == [:])
        #expect(await !peer.isClosed)
        await peer.close()
    }

    @Test func requestIsMatchedToItsResponse() async throws {
        let (peer, transport) = await makePeer()
        async let result = peer.request("profiles.list", params: ["profile": "aeri"])

        let sent = try #require(await transport.nextSent())
        #expect(sent["jsonrpc"] == "2.0")
        #expect(sent["method"] == "profiles.list")
        #expect(sent["params"] == ["profile": "aeri"])
        let id = try #require(sent["id"]?.stringValue)

        transport.deliver(["jsonrpc": "2.0", "id": .string(id), "result": ["profiles": []]])
        #expect(try await result == ["profiles": []])
        await peer.close()
    }

    @Test func responsesOutOfOrderReachTheRightCaller() async throws {
        let (peer, transport) = await makePeer()
        async let first = peer.request("a")
        let firstID = try #require(await transport.nextSent()?["id"]?.stringValue)
        async let second = peer.request("b")
        let secondID = try #require(await transport.nextSent()?["id"]?.stringValue)
        #expect(firstID != secondID)

        transport.deliver(["jsonrpc": "2.0", "id": .string(secondID), "result": "second"])
        transport.deliver(["jsonrpc": "2.0", "id": .string(firstID), "result": "first"])
        #expect(try await first == "first")
        #expect(try await second == "second")
        await peer.close()
    }

    @Test func errorResponseThrowsJSONRPCError() async throws {
        let (peer, transport) = await makePeer()
        // A Task, not `async let`: the expectation closure has to capture the result.
        let result = Task { try await peer.request("session.create", params: ["bogus": 1]) }
        let id = try #require(await transport.nextSent()?["id"]?.stringValue)
        transport.deliver(["jsonrpc": "2.0", "id": .string(id), "error": ["code": 4000, "message": "unknown param"]])

        await #expect(throws: JSONRPCError(code: 4000, message: "unknown param")) {
            _ = try await result.value
        }
        await peer.close()
    }

    @Test func typedCallEncodesParamsAndDecodesResult() async throws {
        let (peer, transport) = await makePeer()
        async let result: HermesWire.PromptSubmitResult = peer.call(
            HermesWire.Method.promptSubmit,
            HermesWire.PromptSubmitParams(sessionID: "s1", text: "hello")
        )
        let sent = try #require(await transport.nextSent())
        #expect(sent["params"] == ["session_id": "s1", "text": "hello"])
        let id = try #require(sent["id"]?.stringValue)
        transport.deliver(["jsonrpc": "2.0", "id": .string(id), "result": ["status": "streaming", "user_row_id": 12, "extra": true]])

        let decoded = try await result
        #expect(decoded.status == "streaming")
        #expect(decoded.userRowID == 12)
        await peer.close()
    }

    @Test func eventsArriveInOrder() async throws {
        let (peer, transport) = await makePeer()
        for (index, text) in ["one", "two", "three"].enumerated() {
            transport.deliver([
                "jsonrpc": "2.0", "method": "event",
                "params": ["type": "message.delta", "session_id": "s1", "seq": .number(Double(index)), "payload": ["text": .string(text)]],
            ])
        }
        var received: [String] = []
        for await message in peer.inbound {
            guard case let .event(event) = message else { continue }
            received.append(event.payload["text"]?.stringValue ?? "")
            if received.count == 3 { break }
        }
        #expect(received == ["one", "two", "three"])
        await peer.close()
    }

    @Test func serverRequestIsSurfacedAndAnsweredByID() async throws {
        let (peer, transport) = await makePeer()
        transport.deliver([
            "jsonrpc": "2.0", "id": "srq-7", "method": "approval",
            "params": ["session_id": "s1", "command": "rm -rf build", "choices": ["once", "deny"]],
        ])

        var iterator = peer.inbound.makeAsyncIterator()
        guard case let .request(request)? = await iterator.next() else {
            Issue.record("expected a server request")
            return
        }
        #expect(request.id == "srq-7")
        #expect(request.method == "approval")
        #expect(request.params["command"] == "rm -rf build")

        try await peer.respond(to: request.id, result: ["choice": "once"])
        #expect(await transport.nextSent() == ["jsonrpc": "2.0", "id": "srq-7", "result": ["choice": "once"]])

        try await peer.reject("srq-8", code: JSONRPCError.methodNotFoundCode, message: "unsupported")
        #expect(await transport.nextSent() == [
            "jsonrpc": "2.0", "id": "srq-8", "error": ["code": -32601, "message": "unsupported"],
        ])
        await peer.close()
    }

    @Test func aRequestAndItsCancellationKeepTheirOrder() async throws {
        let (peer, transport) = await makePeer()
        transport.deliver(["jsonrpc": "2.0", "id": "srq-1", "method": "approval", "params": ["session_id": "s1"]])
        transport.deliver([
            "jsonrpc": "2.0", "method": "event",
            "params": ["type": "request.cancel", "session_id": "s1", "payload": ["id": "srq-1", "method": "approval", "reason": "interrupt"]],
        ])

        var kinds: [String] = []
        for await message in peer.inbound {
            switch message {
            case let .request(request): kinds.append("request \(request.id)")
            case let .event(event): kinds.append("event \(event.type)")
            }
            if kinds.count == 2 { break }
        }
        #expect(kinds == ["request srq-1", "event request.cancel"])
        await peer.close()
    }

    @Test func malformedFrameIsSkipped() async throws {
        let (peer, transport) = await makePeer()
        async let result = peer.request("ping")
        let id = try #require(await transport.nextSent()?["id"]?.stringValue)
        transport.deliver(text: "{not json")
        transport.deliver(["jsonrpc": "2.0", "id": .string(id), "result": "ok"])
        #expect(try await result == "ok")
        await peer.close()
    }

    @Test func requestTimesOut() async throws {
        let (peer, _) = await makePeer()
        await #expect(throws: JSONRPCPeerError.timedOut(method: "slow")) {
            _ = try await peer.request("slow", timeout: .milliseconds(50))
        }
        await peer.close()
    }

    @Test func droppedSocketFailsPendingRequestsAndEndsStreams() async throws {
        let (peer, transport) = await makePeer()
        let result = Task { try await peer.request("session.resume") }
        _ = await transport.nextSent()
        transport.drop()

        await #expect(throws: (any Error).self) { _ = try await result.value }
        for await _ in peer.inbound {}
        #expect(await peer.isClosed)
        #expect(transport.isClosed)
        await #expect(throws: (any Error).self) { _ = try await peer.request("after") }
    }

    @Test func closeFailsPendingRequests() async throws {
        let (peer, transport) = await makePeer()
        let result = Task { try await peer.request("session.resume") }
        _ = await transport.nextSent()
        await peer.close()
        await #expect(throws: JSONRPCPeerError.closed) { _ = try await result.value }
    }

    @Test func heartbeatSendsPings() async throws {
        let (peer, transport) = await makePeer {
            $0.heartbeatInterval = .milliseconds(20)
            $0.heartbeatDeadline = .seconds(5)
        }
        await peer.startHeartbeat()
        let ping = try #require(await transport.nextSent())
        #expect(ping["method"] == "gateway.ping")
        #expect(ping["id"] == "heartbeat-1")
        #expect(ping["params"] == [:])

        // A pong is not an error and does not surface anywhere.
        transport.deliver(["jsonrpc": "2.0", "id": "heartbeat-1", "result": ["ok": true]])
        let second = try #require(await transport.nextSent())
        #expect(second["id"] == "heartbeat-2")
        #expect(await peer.isClosed == false)
        await peer.close()
    }

    @Test func silenceBeyondTheDeadlineClosesThePeer() async throws {
        let (peer, transport) = await makePeer {
            $0.heartbeatInterval = .milliseconds(20)
            $0.heartbeatDeadline = .milliseconds(60)
        }
        await peer.startHeartbeat()
        for await _ in peer.inbound {}

        #expect(await peer.isClosed)
        #expect(await peer.closeError as? JSONRPCPeerError == .heartbeatTimedOut)
        #expect(transport.isClosed)
    }
}

/// A socket that carries frames up to `bytes`, as the relay's tunnel does up to 16 MiB.
private struct CarryingAtMost: WebSocketTransport {
    let base: ScriptedTransport
    let bytes: Int

    func send(_ text: String) async throws { try await base.send(text) }
    func receive() async throws -> String { try await base.receive() }
    func close() { base.close() }

    func checkCarries(_ text: String) throws {
        if text.utf8.count > bytes { throw TooLargeForRelay() }
    }
}
