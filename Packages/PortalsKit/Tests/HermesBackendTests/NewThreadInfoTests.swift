import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct NewThreadInfoTests {
    @Test(arguments: [false, true])
    func creationBuffersAllSessionInfoBeforeLiveEventsWithoutReplacingTheFirstMessage(isBridge: Bool) async throws {
        let transport = ScriptedTransport()
        let backend = Self.backend(transport)
        let features: Set<String> = isBridge ? [BridgeWire.Feature.modes] : []
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1", features: Array(features))
        try await connecting.value
        var fields = try #require(Fixtures.json("droid-parity-phase1.json").objectValue)
        fields.merge([
            "cwd": "/actual", "title": "Created on the host", "model": "normal", "provider": "factory",
            // An older bridge's Spec model for a Droid thread, read past since 2026-10-23.
            "reasoning_effort": "medium", "spec_model": "default", "spec_reasoning_effort": "default",
            "usage": ["context_used": 2048, "context_max": 32768, "context_estimated": true],
        ]) { _, new in new }
        let info = JSONValue.object(fields)
        let creating = Task {
            try await backend.createThread(
                with: Agent.ID(host: backend.host, name: "droid"), options: ThreadOptions(workingDirectory: "/requested")
            )
        }
        try transport.answer(try await transport.expect("session.create"), [
            "session_id": "run-1", "stored_session_id": "stored-1", "info": info,
        ])
        let thread = try await creating.value
        #expect(thread.workingDirectory == "/actual")
        // A marker makes this fail promptly if the creation info was dropped, not hang
        // waiting for an event a newly created stream never received.
        transport.event("message.start", seq: 1)
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        let first = try #require(await events.next())
        guard case let .caughtUp(received) = first else {
            Issue.record("Expected creation info before the first live event, got \(first)")
            await backend.disconnect()
            return
        }
        let resumed = try JSONValue.object(["session_id": "run-1", "info": info]).decode(HermesWire.SessionResumeResult.self)
        #expect(received == HermesHistoryMapper.info(from: resumed, features: features))
        #expect(received.model == ModelSetting(model: "normal", provider: "factory", level: .medium))
        #expect(received.context != nil)
        #expect(received.mode?.options?.isEmpty == false || !isBridge)
        #expect((received.mode != nil) == isBridge)
        var state = ThreadState()
        _ = state.messageSent("The first optimistic message")
        let transcript = state.transcript
        let pending = state.pending
        state.apply(first)
        #expect(state.transcript == transcript)
        #expect(state.pending == pending)
        #expect(state.model == received.model)
        #expect(state.mode == received.mode)
        #expect(state.context == received.context)
        #expect(await events.next() == .turnStarted)
        await backend.disconnect()
    }

    @Test func creationWithoutInfoDoesNotInventSettingsOrAnExtraEvent() async throws {
        let transport = ScriptedTransport()
        let backend = Self.backend(transport)
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1")
        try await connecting.value
        let creating = Task {
            try await backend.createThread(with: Agent.ID(host: backend.host, name: "default"), options: ThreadOptions())
        }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1"])
        let thread = try await creating.value
        transport.event("message.start", seq: 1)
        var events = await backend.events(for: thread.id).makeAsyncIterator()
        let first = try #require(await events.next())
        #expect(first == .turnStarted)
        var state = ThreadState()
        state.apply(first)
        #expect(state.model == nil)
        #expect(state.mode == nil)
        await backend.disconnect()
    }

    private static func backend(_ transport: ScriptedTransport) -> HermesBackend {
        HermesBackend(
            host: HostID(rawValue: "test"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9119")!, fixedToken: "test"),
            makeTransport: { _ in transport }
        )
    }
}
