import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A later version of a host's bridge (feature `update_notice`, `HostUpdate`): read from
/// `gateway.ready`'s `bridge` block and from the `sessions.activity` answer, only from a
/// bridge that lists the feature, and only when it is a version; and what the app says
/// of it.
@Suite struct UpdateNoticeWireTests {
    private static func ready(_ features: [JSONValue], latest: JSONValue? = nil) -> JSONValue {
        var bridge: [String: JSONValue] = ["protocol": 1, "version": "0.3.0", "features": .array(features)]
        if let latest { bridge["latest"] = latest }
        return ["replay_epoch": "e1", "heartbeat": false, "bridge": .object(bridge)]
    }

    private static let saying = ready(["activity", "update_notice"])
    /// A bridge from before it said.
    private static let older = ready(["activity"])

    private func connect(ready: JSONValue) async throws -> (HermesBackend, ScriptedTransport) {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "mac"),
            authenticator: LoopbackTokenAuthenticator(baseURL: URL(string: "http://127.0.0.1:9120")!, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval", "clarify"]]])
        try await connecting.value
        return (backend, transport)
    }

    /// Answers the next `sessions.activity` with `result` and gives the report it made.
    private func activity(_ backend: HermesBackend, _ transport: ScriptedTransport, answering result: JSONValue) async throws -> ThreadActivityReport {
        let asking = Task { try await backend.threadActivity() }
        let request = try #require(await transport.nextSentRequest())
        #expect(request["method"]?.stringValue == "sessions.activity")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": result])
        return try await asking.value
    }

    @Test func gatewayReadySaysALaterVersionOnlyFromABridgeWithTheFeature() {
        let said = HermesWire.GatewayReady(payload: Self.ready(["update_notice"], latest: "0.3.1"))
        #expect(said.bridge?.latest == "0.3.1")
        #expect(said.bridge?.version == "0.3.0")
        // None said: none out.
        #expect(HermesWire.GatewayReady(payload: Self.ready(["update_notice"])).bridge?.latest == nil)
        // A bridge without the feature is not read, whatever it says.
        #expect(HermesWire.GatewayReady(payload: Self.ready([], latest: "0.3.1")).bridge?.latest == nil)
        // Hermes on its own says nothing of the kind.
        #expect(HermesWire.GatewayReady(payload: ["replay_epoch": "e1", "heartbeat": true, "latest": "9.0.0"]).bridge == nil)
    }

    @Test func onlyAVersionIsTaken() {
        for good in ["0.3.1", "1.0.0-beta.2", "10.20.30+build.7", " 0.4.0 "] {
            #expect(BridgeWire.laterVersion(.string(good)) == good.trimmingCharacters(in: .whitespaces), "\(good)")
        }
        for odd: JSONValue in ["", "latest", "v0.3.1", "0.3.1; rm -rf ~", "0.3.1 && echo", "0.3.1\nmore", .string(String(repeating: "1", count: 41)), "٣.٠.١", 3, .null, ["0.3.1"]] {
            #expect(BridgeWire.laterVersion(odd) == nil, "\(odd)")
        }
    }

    @Test func theActivityAnswerSaysALaterVersionAndThenNone() async throws {
        let (backend, transport) = try await connect(ready: Self.saying)
        let out = try await activity(backend, transport, answering: ["sessions": [], "latest": "0.3.1"])
        #expect(out.update == "0.3.1")
        // Updated, or taken back: the answer has none.
        let none = try await activity(backend, transport, answering: ["sessions": []])
        #expect(none.update == nil)
        // One that is no version costs only itself.
        let odd = try await activity(backend, transport, answering: ["sessions": [["session_id": "s1", "state": "running"]], "latest": ["0.3.1"]])
        #expect(odd.update == nil)
        #expect(odd.threads == [ThreadRef.ID(rawValue: "s1"): .running])
        await backend.disconnect()
    }

    @Test func aBridgeWithoutTheFeatureIsNotReadForIt() async throws {
        let (backend, transport) = try await connect(ready: Self.older)
        let report = try await activity(backend, transport, answering: ["sessions": [], "latest": "0.3.1"])
        #expect(report.update == nil)
        await backend.disconnect()
    }

    @Test func whatTheAppSaysOfIt() {
        let update = HostUpdate(latest: "0.3.1", running: "0.3.0")
        #expect(HostUpdate.command == "npx portals-host@latest update")
        #expect(update.message == "Portals host 0.3.1 is out (this host runs 0.3.0). To update, run npx portals-host@latest update on that computer.")
        #expect(update.headline == "Portals host 0.3.1 is out; this host runs 0.3.0.")
        // A bridge that did not say its own version.
        #expect(HostUpdate(latest: "0.3.1").message == "Portals host 0.3.1 is out. To update, run npx portals-host@latest update on that computer.")
        #expect(HostUpdate(latest: nil, running: "0.3.0") == nil)
        #expect(HostUpdate(latest: "0.3.1", running: nil) == HostUpdate(latest: "0.3.1"))
    }
}
