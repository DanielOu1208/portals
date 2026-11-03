import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// How the agents look on every device (feature `agent_looks`, `BridgeWire`): what is
/// sent and how the answers read, and that nothing of it goes to a host that does not
/// list the feature.
@Suite struct LookSyncWireTests {
    private static let keeping: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "agent_looks"]],
    ]
    /// A bridge from before looks were kept.
    private static let older: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "agent_kinds"]],
    ]
    private static let hermes: JSONValue = ["replay_epoch": "e1", "heartbeat": true]

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

    /// Answers the next request, after checking what it asked.
    private func answer(
        _ transport: ScriptedTransport, method: String, params: JSONValue, with result: JSONValue,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws {
        let request = try #require(await transport.nextSentRequest(), sourceLocation: sourceLocation)
        #expect(request["method"]?.stringValue == method, sourceLocation: sourceLocation)
        #expect(request["params"] == params, sourceLocation: sourceLocation)
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": result])
    }

    private let claude = Agent.ID(host: HostID(rawValue: "mac"), name: "claude")
    private let list: JSONValue = ["id": "9c1e04b7a2d35f68", "revision": 14]

    @Test func aBridgeThatKeepsLooksListsThem() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)
        #expect(await backend.syncsLooks == true)

        let asking = Task { try await backend.hostLooks() }
        try await answer(transport, method: "looks.list", params: [:], with: [
            "list": list,
            "looks": [
                ["agent": "claude", "shape": 1, "face": 2, "tint": 3, "shows_logo": false, "origin": "chosen"],
                ["agent": "codex", "shape": 5, "face": 0, "tint": 8, "origin": "assigned"],
                // Each of these costs only itself.
                ["agent": "pi", "shape": 1, "face": 2, "origin": "assigned"],
                ["agent": "cursor", "shape": 1, "face": 2, "tint": 3, "origin": "somebody"],
                ["agent": "karina", "shape": -1, "face": 2, "tint": 3, "origin": "chosen"],
                ["agent": "hanni", "shape": 1.5, "face": 2, "tint": 3, "origin": "chosen"],
                ["agent": "", "shape": 1, "face": 2, "tint": 3, "origin": "chosen"],
                ["shape": 1, "face": 2, "tint": 3, "origin": "chosen"],
                "odd",
                // A logo setting that is neither true nor false is no choice.
                ["agent": "aeri", "shape": 0, "face": 1, "tint": 6, "shows_logo": "yes", "origin": "assigned"],
            ],
        ])
        let looks = try await asking.value
        #expect(looks.list == LookListRevision(id: "9c1e04b7a2d35f68", revision: 14))
        #expect(looks.looks == [
            "claude": HostLook(AgentLook(shape: 1, face: 2, tint: 3, showsLogo: false), origin: .chosen),
            "codex": HostLook(AgentLook(shape: 5, face: 0, tint: 8), origin: .assigned),
            "aeri": HostLook(AgentLook(shape: 0, face: 1, tint: 6), origin: .assigned),
        ])

        // With no looks kept yet.
        let none = Task { try await backend.hostLooks() }
        try await answer(transport, method: "looks.list", params: [:], with: ["list": ["id": "9c1e04b7a2d35f68", "revision": 0], "looks": []])
        #expect(try await none.value == HostLooks(list: LookListRevision(id: "9c1e04b7a2d35f68", revision: 0)))

        // An answer that does not say where the list is cannot be told from a later one.
        let bare = Task { try await backend.hostLooks() }
        try await answer(transport, method: "looks.list", params: [:], with: ["looks": []])
        await #expect(throws: DecodingError.self) { try await bare.value }
        await backend.disconnect()
    }

    @Test func aLookIsSentWithWhoDecidedItAndWhenToLeaveTheHostsOwn() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)

        // Chosen here: over whatever the host has, with the logo turned off.
        let chosen = HostLook(AgentLook(shape: 1, face: 2, tint: 3, showsLogo: false), origin: .chosen)
        let choosing = Task { try await backend.setLook(chosen, for: claude, unless: nil) }
        try await answer(
            transport, method: "look.set",
            params: ["profile": "claude", "shape": 1, "face": 2, "tint": 3, "shows_logo": false, "origin": "chosen"],
            with: ["list": list, "look": ["agent": "claude", "shape": 1, "face": 2, "tint": 3, "shows_logo": false, "origin": "chosen"], "taken": true]
        )
        #expect(try await choosing.value == chosen)

        // A look the app gave, for an agent that has none: the host answers with the one
        // another device gave it first.
        let given = HostLook(AgentLook(shape: 4, face: 0, tint: 7), origin: .assigned)
        let giving = Task { try await backend.setLook(given, for: claude, unless: .any) }
        try await answer(
            transport, method: "look.set",
            params: ["profile": "claude", "shape": 4, "face": 0, "tint": 7, "origin": "assigned", "unless": "any"],
            with: ["list": list, "look": ["agent": "claude", "shape": 6, "face": 1, "tint": 9, "origin": "assigned"], "taken": false]
        )
        #expect(try await giving.value == HostLook(AgentLook(shape: 6, face: 1, tint: 9), origin: .assigned))

        // A choice from before the host kept looks.
        let carrying = Task { try await backend.setLook(chosen, for: claude, unless: .chosen) }
        try await answer(
            transport, method: "look.set",
            params: ["profile": "claude", "shape": 1, "face": 2, "tint": 3, "shows_logo": false, "origin": "chosen", "unless": "chosen"],
            with: ["list": list, "look": ["agent": "claude", "shape": 1, "face": 2, "tint": 3, "shows_logo": false, "origin": "chosen"], "taken": true]
        )
        #expect(try await carrying.value == chosen)

        // An answer without the look says nothing of what the agent has now.
        let odd = Task { try await backend.setLook(chosen, for: claude, unless: nil) }
        let request = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(request["id"]), "result": ["taken": true]])
        await #expect(throws: DecodingError.self) { try await odd.value }

        // The host's sentence on why not, as it gave it.
        let refused = Task { try await backend.setLook(chosen, for: Agent.ID(host: HostID(rawValue: "mac"), name: "nobody"), unless: nil) }
        let asked = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(asked["id"]), "error": ["code": -32602, "message": "There is no agent called nobody on this bridge."]])
        await #expect(throws: JSONRPCError.self) { try await refused.value }
        await backend.disconnect()
    }

    @Test func theActivityAnswerSaysWhereTheLooksAre() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)
        let asking = Task { try await backend.threadActivity() }
        try await answer(transport, method: "sessions.activity", params: [:], with: [
            "sessions": [], "thread_list": ["id": "3f9a1c0e7b2d4a65", "revision": 812], "looks": list,
        ])
        let report = try await asking.value
        #expect(report.looks == LookListRevision(id: "9c1e04b7a2d35f68", revision: 14))
        #expect(report.list == ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 812))

        // One that cannot be read costs only itself.
        let again = Task { try await backend.threadActivity() }
        try await answer(transport, method: "sessions.activity", params: [:], with: [
            "sessions": [["session_id": "s1", "state": "running"]], "thread_list": ["id": "3f9a1c0e7b2d4a65", "revision": 813], "looks": 14,
        ])
        let odd = try await again.value
        #expect(odd.looks == nil)
        #expect(odd.threads == [ThreadRef.ID(rawValue: "s1"): .running])
        await backend.disconnect()
    }

    @Test func nothingOfItGoesToAHostThatKeepsNoLooks() async throws {
        for ready in [Self.older, Self.hermes] {
            let (backend, transport) = try await connect(ready: ready)
            #expect(await backend.syncsLooks == false)
            await #expect(throws: LookSyncError.unavailable) { try await backend.hostLooks() }
            await #expect(throws: LookSyncError.unavailable) {
                try await backend.setLook(HostLook(AgentLook(shape: 1, face: 2, tint: 3), origin: .chosen), for: claude, unless: nil)
            }
            if ready == Self.older {
                // The key is not read from a bridge that does not list the feature.
                let asking = Task { try await backend.threadActivity() }
                try await answer(transport, method: "sessions.activity", params: [:], with: ["sessions": [], "looks": list])
                #expect(try await asking.value.looks == nil)
            }
            await backend.disconnect()
            // Nothing else was sent.
            #expect(await transport.nextSentRequest() == nil)
        }
    }

    @Test func aLookWithNoChoiceOfLogoLeavesTheKeyOut() throws {
        let params = BridgeWire.LookSetParams(profile: "codex", look: HostLook(AgentLook(shape: 5, face: 0, tint: 8), origin: .assigned), unless: .any)
        #expect(try JSONValue(encoding: params).serialized() == #"{"face":0,"origin":"assigned","profile":"codex","shape":5,"tint":8,"unless":"any"}"#)
        #expect(try JSONValue(encoding: BridgeWire.LooksListParams()).objectValue?.isEmpty == true)
    }
}
