import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite(.timeLimit(.minutes(1))) struct LeanDeltaRecoveryTests {
    private static let route = RelayRoute(
        relay: URL(string: "http://127.0.0.1:8790")!, relayID: "q1w2e3r4t5y6u7i8o9p0aZ",
        macKey: String(repeating: "A", count: 43), token: "test-token"
    )!

    @Test func aMalformedOpeningDisablesLeanBeforeTheRelayIsTried() async throws {
        let host = HostID(rawValue: "lean-opening-\(UUID())")
        let direct = TransportSequence()
        let relay = TransportSequence()
        let backend = HermesBackend(
            host: host,
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            relay: { Self.route },
            makeTransport: { _ in direct.make() },
            makeRelayTransport: { _ in relay.make() }
        )
        let connecting = Task { try await backend.connect() }
        let address = try #require(await direct.next())
        address.deliver(["d": ["run-1", 1, 42]])
        try await handshake(try #require(await relay.next()), lean: false)
        try await connecting.value
        #expect(address.isClosed)
        await backend.disconnect()
    }

    @Test(arguments: [false, true])
    func aReconnectReplaysMissingTextAndToolsWithoutSkippingSeq(malformed: Bool) async throws {
        let host = HostID(rawValue: "lean-recovery-\(UUID())")
        let transports = TransportSequence()
        let backend = makeBackend(host, transports)
        let connecting = Task { try await backend.connect() }
        let first = try #require(await transports.next())
        try await handshake(first, lean: true)
        try await connecting.value
        let thread = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: host, name: "fake"))
        let opening = Task { try await backend.openThread(thread) }
        try first.answer(try await first.expect("session.resume"), [
            "session_id": "run-1", "running": false, "latest_seq": 0, "replay_base": 0, "messages": [], "open_requests": [],
        ])
        let snapshot = try await opening.value
        var state = ThreadState(transcript: snapshot.transcript)
        var received: [ThreadEvent] = []
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        first.event("message.start", seq: 1)
        first.deliver(["t": ["run-1", 2, "Plan "]])
        first.deliver(["d": ["run-1", 3, "Hel"]])
        first.event("tool.start", seq: 4, ["tool_id": "tool-1", "name": "terminal", "args": ["command": "pwd"]])
        for _ in 0..<4 {
            let event = try #require(await events.nextLeavingOutRoster())
            received.append(event)
            state.apply(event)
        }
        if malformed {
            first.deliver(["d": ["run-1", 5, 42]])
            // This valid but later frame must not advance lastSeq past the missing text.
            first.deliver(["d": ["run-1", 6, "must not be applied"]])
        } else {
            first.drop()
        }

        let second = try #require(await transports.next())
        try await handshake(second, lean: !malformed)
        let resume = try await second.expect("session.resume")
        #expect(resume["params"]?["since"] == 4)
        #expect(resume["params"]?["replay_epoch"] == "e1")
        #expect(resume["params"]?["replay_base"] == 0)
        if malformed {
            #expect(first.isClosed)
            second.event("message.delta", seq: 9, ["text": "!"])
        } else {
            second.deliver(["d": ["run-1", 9, "!"]])
        }
        try second.answer(resume, [
            "session_id": "run-1", "running": true, "replayed": true, "latest_seq": 8, "replay_base": 0, "open_requests": [],
            "events": [
                ScriptedTransport.eventParams("message.delta", seq: 5, ["text": "lo"]),
                ScriptedTransport.eventParams("reasoning.delta", seq: 6, ["text": "more."]),
                ScriptedTransport.eventParams("tool.complete", seq: 7, [
                    "tool_id": "tool-1", "name": "terminal", "args": ["command": "pwd"],
                    "result": ["output": "/scratch\n", "exit_code": 0], "duration_s": 0.1,
                ]),
                ScriptedTransport.eventParams("message.delta", seq: 8, ["text": " world"]),
            ],
        ])
        while let event = await events.nextLeavingOutRoster() {
            received.append(event)
            state.apply(event)
            if event == .textDelta("!") { break }
        }
        let contents = state.transcript.turns.flatMap(\.items).map(\.content)
        // Check before message.complete, whose final text could mask a missing delta.
        #expect(received.compactMap { if case let .textDelta(text) = $0 { text } else { nil } }.joined() == "Hello world!")
        #expect(received.compactMap { if case let .reasoningDelta(text) = $0 { text } else { nil } }.joined() == "Plan more.")
        #expect(contents.contains { if case let .tool(run) = $0 { run.state == .succeeded && run.output == "/scratch\n" } else { false } })
        // An overlapping replay/live event still must not be applied twice.
        second.event("message.delta", seq: 5, ["text": "lo"])
        second.event("message.complete", seq: 10, ["text": "Hello world!", "status": "complete"])
        #expect(await events.nextLeavingOutRoster() == .turnFinished(.completed, finalText: "Hello world!"))
        await backend.disconnect()

        // The fallback survives backend recreation, but is not global to other hosts.
        for (nextHost, lean, viaRelay) in [
            (host, !malformed, false), (host, !malformed, true), (HostID(rawValue: "another-\(UUID())"), true, false),
        ] {
            let nextTransports = TransportSequence()
            let nextBackend = makeBackend(nextHost, nextTransports, viaRelay: viaRelay)
            let nextConnecting = Task { try await nextBackend.connect() }
            try await handshake(try #require(await nextTransports.next()), lean: lean)
            try await nextConnecting.value
            await nextBackend.disconnect()
        }
    }

    private func makeBackend(_ host: HostID, _ transports: TransportSequence, viaRelay: Bool = false) -> HermesBackend {
        HermesBackend(
            host: host,
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "t"),
            reconnectDelays: [.milliseconds(5)],
            relay: { viaRelay ? Self.route : nil },
            makeTransport: { _ in
                if !viaRelay { return transports.make() }
                let unreachable = ScriptedTransport()
                unreachable.drop()
                return unreachable
            },
            makeRelayTransport: { _ in transports.make() }
        )
    }

    private func handshake(_ transport: ScriptedTransport, lean: Bool) async throws {
        transport.deliver([
            "jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": [
                "replay_epoch": "e1", "heartbeat": false,
                "bridge": ["protocol": 1, "features": ["lean_deltas", "resume_replay", "session_resync"]],
            ]],
        ])
        let capabilities = try await transport.expect("client.capabilities")
        #expect(capabilities["params"]?["lean_deltas"] == (lean ? true : nil))
        try transport.answer(capabilities, ["server_requests": ["approval", "clarify"]])
    }
}
