import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct ThreadCommandCatalogWireTests {
    private static func result(_ name: String) -> JSONValue {
        ["categories": [["name": "Droid", "pairs": [[.string("/\(name)"), "Command"]]]], "skills": [:], "canon": [:]]
    }

    @Test func onlyBridgeParamsIncludeTheSessionKey() throws {
        let params = BridgeWire.CommandsCatalogParams(profile: "droid", sessionID: "run-1")
        #expect(try JSONValue(encoding: params) == ["profile": "droid", "session_id": "run-1"])
        #expect(try JSONValue(encoding: HermesWire.CommandsCatalogParams(profile: "hermes")) == ["profile": "hermes"])
        let keys = try #require(Fixtures.json("contract-subset.json")["bridge"]?["methods"]?["commands.catalog"]?["params"]?.arrayValue)
        #expect(Set(keys.compactMap(\.stringValue)) == Set(try #require(JSONValue(encoding: params).objectValue).keys))
    }

    @Test(arguments: [false, true])
    func threadCatalogUsesItsLiveSessionOnlyOnABridge(isBridge: Bool) async throws {
        let transport = ScriptedTransport()
        let backend = Self.backend(transport)
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1", features: isBridge ? [BridgeWire.Feature.modes] : [])
        try await connecting.value
        let agent = Agent.ID(host: backend.host, name: "droid")
        let creating = Task { try await backend.createThread(with: agent, options: ThreadOptions()) }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1", "stored_session_id": "stored-1"])
        let thread = try await creating.value
        let fetching = Task { try await backend.commandCatalog(for: agent, in: thread.id) }
        let request = try await transport.expect("commands.catalog")
        #expect(request["params"] == (isBridge ? ["profile": "droid", "session_id": "run-1"] : ["profile": "droid"]))
        try transport.answer(request, Self.result("project"))
        #expect(try await fetching.value.commands.map(\.name) == ["project"])
        let personal = Task { try await backend.commandCatalog(for: agent) }
        let baseline = try await transport.expect("commands.catalog")
        #expect(baseline["params"] == ["profile": "droid"])
        try transport.answer(baseline, Self.result("personal"))
        #expect(try await personal.value.commands.map(\.name) == ["personal"])
        await backend.disconnect()
    }

    @Test(arguments: [4000, -32602])
    func olderBridgesCanRejectTheNewKeyWithoutBreakingTheMenu(code: Int) async throws {
        let transport = ScriptedTransport()
        let backend = Self.backend(transport)
        let connecting = Task { try await backend.connect() }
        try await transport.shakeHands(epoch: "e1", features: [BridgeWire.Feature.modes])
        try await connecting.value
        let agent = Agent.ID(host: backend.host, name: "droid")
        let creating = Task { try await backend.createThread(with: agent, options: ThreadOptions()) }
        try transport.answer(try await transport.expect("session.create"), ["session_id": "run-1", "stored_session_id": "stored-1"])
        let thread = try await creating.value
        let fetching = Task { try await backend.commandCatalog(for: agent, in: thread.id) }
        let scoped = try await transport.expect("commands.catalog")
        #expect(scoped["params"]?["session_id"] == "run-1")
        try transport.fail(scoped, code: code, message: "Unknown parameter session_id")
        let fallback = try await transport.expect("commands.catalog")
        #expect(fallback["params"] == ["profile": "droid"])
        try transport.answer(fallback, Self.result("personal"))
        #expect(try await fetching.value.commands.map(\.name) == ["personal"])
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
