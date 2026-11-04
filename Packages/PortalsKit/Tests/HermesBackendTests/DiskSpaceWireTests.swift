import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The free space on a host's disk (feature `disk_space`, `HostDisk`): read from
/// `gateway.ready`'s `bridge` block and from the `sessions.activity` answer, only from a
/// bridge that lists the feature, and only when it is a sound pair of sizes; and what
/// Settings says of it.
@Suite struct DiskSpaceWireTests {
    private static func ready(_ features: [JSONValue], disk: JSONValue? = nil) -> JSONValue {
        var bridge: [String: JSONValue] = ["protocol": 1, "version": "0.3.2", "features": .array(features)]
        if let disk { bridge["disk"] = disk }
        return ["replay_epoch": "e1", "heartbeat": false, "bridge": .object(bridge)]
    }

    private static let roomy: JSONValue = ["free": 200_000_000_000, "total": 500_000_000_000, "level": "ok"]
    private static let low: JSONValue = ["free": 3_200_000_000, "total": 500_000_000_000, "level": "low"]

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

    @Test func gatewayReadySaysTheFreeSpaceOnlyFromABridgeWithTheFeature() {
        let said = HermesWire.GatewayReady(payload: Self.ready(["disk_space"], disk: Self.low))
        #expect(said.bridge?.disk == HostDisk(free: 3_200_000_000, total: 500_000_000_000, level: .low))
        // Not read yet.
        #expect(HermesWire.GatewayReady(payload: Self.ready(["disk_space"])).bridge?.disk == nil)
        // A bridge without the feature is not read, whatever it says.
        #expect(HermesWire.GatewayReady(payload: Self.ready([], disk: Self.low)).bridge?.disk == nil)
    }

    @Test func onlySoundSizesAreTaken() {
        #expect(BridgeWire.hostDisk(Self.roomy)?.level == .ok)
        // A level this app does not know is read as room enough.
        #expect(BridgeWire.hostDisk(["free": 1, "total": 2, "level": "dire"]) == HostDisk(free: 1, total: 2, level: .ok))
        #expect(BridgeWire.hostDisk(["free": 0, "total": 2, "level": "critical"])?.level == .critical)
        for odd: JSONValue in [["free": -1, "total": 2], ["free": 3, "total": 2], ["free": 1, "total": 0], ["free": 1.5, "total": 2], ["free": "1", "total": 2], ["total": 2], "full", .null] {
            #expect(BridgeWire.hostDisk(odd) == nil, "\(odd)")
        }
    }

    @Test func theActivityAnswerSaysTheFreeSpaceAsItChanges() async throws {
        let (backend, transport) = try await connect(ready: Self.ready(["activity", "disk_space"], disk: Self.roomy))
        let roomy = try await activity(backend, transport, answering: ["sessions": [], "disk": Self.roomy])
        #expect(roomy.disk?.level == .ok)
        let low = try await activity(backend, transport, answering: ["sessions": [], "disk": Self.low])
        #expect(low.disk == HostDisk(free: 3_200_000_000, total: 500_000_000_000, level: .low))
        // One that cannot be read costs only itself.
        let odd = try await activity(backend, transport, answering: ["sessions": [["session_id": "s1", "state": "running"]], "disk": "full"])
        #expect(odd.disk == nil)
        #expect(odd.threads == [ThreadRef.ID(rawValue: "s1"): .running])
        await backend.disconnect()
    }

    @Test func aBridgeWithoutTheFeatureIsNotReadForIt() async throws {
        let (backend, transport) = try await connect(ready: Self.ready(["activity"]))
        let report = try await activity(backend, transport, answering: ["sessions": [], "disk": Self.low])
        #expect(report.disk == nil)
        await backend.disconnect()
    }

    @Test func whatSettingsSaysOfIt() {
        let free = ByteCountFormatter.string(fromByteCount: 3_200_000_000, countStyle: .file)
        #expect(HostDisk(free: 3_200_000_000, total: 500_000_000_000, level: .ok).message == "\(free) free")
        #expect(HostDisk(free: 3_200_000_000, total: 500_000_000_000, level: .low).message == "Low on disk space: \(free) free")
        #expect(HostDisk(free: 3_200_000_000, total: 500_000_000_000, level: .critical).message == "Almost out of disk space: \(free) free")
        #expect(HostDisk(free: 1, total: 2, level: .low).isLow)
        #expect(!HostDisk(free: 1, total: 2, level: .ok).isLow)
    }
}
