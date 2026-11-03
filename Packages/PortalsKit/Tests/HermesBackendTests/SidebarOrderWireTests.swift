import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// The sidebar's order on every device (feature `sidebar_order`, `BridgeWire`): what is
/// sent and how the answers read, and that nothing of it goes to a host that does not
/// list the feature.
@Suite struct SidebarOrderWireTests {
    private static let keeping: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "agent_looks", "sidebar_order"]],
    ]
    /// A bridge from before the order was kept.
    private static let older: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity", "thread_sync", "agent_looks"]],
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

    private let list: JSONValue = ["id": "4be07c1d9a2f6e35", "revision": 3]
    private let revision = SidebarOrderRevision(id: "4be07c1d9a2f6e35", revision: 3)

    @Test func aBridgeThatKeepsTheOrderGivesBothLists() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)
        #expect(await backend.syncsSidebarOrder == true)
        let asking = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: [
            // A name that is no text, or empty, costs only itself.
            "list": list, "agents": ["codex", 3, "claude", ""], "folders": ["/Users/dev/notes", "/Users/dev/app"],
        ])
        #expect(try await asking.value == HostSidebarOrder(
            list: revision, order: SidebarOrder(agents: ["codex", "claude"], folders: ["/Users/dev/notes", "/Users/dev/app"])
        ))

        // No order yet, and an answer that does not say which order it is.
        let none = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: ["list": ["id": "4be07c1d9a2f6e35", "revision": 0], "agents": [], "folders": []])
        #expect(try await none.value == HostSidebarOrder(list: SidebarOrderRevision(id: "4be07c1d9a2f6e35", revision: 0)))
        let bare = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: ["agents": ["codex"]])
        await #expect(throws: DecodingError.self) { try await bare.value }
        await backend.disconnect()
    }

    @Test func onlyTheListArrangedIsSentAndTheAnswerIsTheOrderNow() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)
        let agents = Task { try await backend.setSidebarOrder(agents: ["claude", "codex"], folders: nil) }
        try await answer(
            transport, method: "order.set", params: ["agents": ["claude", "codex"]],
            with: ["list": list, "agents": ["claude", "codex"], "folders": ["/Users/dev/notes"]]
        )
        #expect(try await agents.value.order == SidebarOrder(agents: ["claude", "codex"], folders: ["/Users/dev/notes"]))

        // An empty list is sent as one: the folders are by last use again.
        let folders = Task { try await backend.setSidebarOrder(agents: nil, folders: []) }
        try await answer(
            transport, method: "order.set", params: ["folders": []],
            with: ["list": ["id": "4be07c1d9a2f6e35", "revision": 4], "agents": ["claude", "codex"], "folders": []]
        )
        #expect(try await folders.value == HostSidebarOrder(
            list: SidebarOrderRevision(id: "4be07c1d9a2f6e35", revision: 4), order: SidebarOrder(agents: ["claude", "codex"])
        ))

        // The host's sentence on why not, as it gave it.
        let refused = Task { try await backend.setSidebarOrder(agents: [""], folders: nil) }
        let asked = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(asked["id"]), "error": ["code": -32602, "message": "agents must be a list of at most 500 names, none of them empty."]])
        await #expect(throws: JSONRPCError.self) { try await refused.value }
        await backend.disconnect()
    }

    @Test func theActivityAnswerSaysWhereTheOrderIs() async throws {
        let (backend, transport) = try await connect(ready: Self.keeping)
        let asking = Task { try await backend.threadActivity() }
        try await answer(transport, method: "sessions.activity", params: [:], with: [
            "sessions": [], "thread_list": ["id": "3f9a1c0e7b2d4a65", "revision": 812], "looks": ["id": "9c1e04b7a2d35f68", "revision": 14], "order": list,
        ])
        let report = try await asking.value
        #expect(report.order == revision)
        #expect(report.looks == LookListRevision(id: "9c1e04b7a2d35f68", revision: 14))

        // One that cannot be read costs only itself.
        let again = Task { try await backend.threadActivity() }
        try await answer(transport, method: "sessions.activity", params: [:], with: [
            "sessions": [["session_id": "s1", "state": "running"]], "order": "third",
        ])
        let odd = try await again.value
        #expect(odd.order == nil)
        #expect(odd.threads == [ThreadRef.ID(rawValue: "s1"): .running])
        await backend.disconnect()
    }

    @Test func nothingOfItGoesToAHostThatKeepsNoOrder() async throws {
        for ready in [Self.older, Self.hermes] {
            let (backend, transport) = try await connect(ready: ready)
            #expect(await backend.syncsSidebarOrder == false)
            await #expect(throws: SidebarOrderError.unavailable) { try await backend.sidebarOrder() }
            await #expect(throws: SidebarOrderError.unavailable) { try await backend.setSidebarOrder(agents: ["claude"], folders: nil) }
            if ready == Self.older {
                // The key is not read from a bridge that does not list the feature.
                let asking = Task { try await backend.threadActivity() }
                try await answer(transport, method: "sessions.activity", params: [:], with: ["sessions": [], "order": list])
                #expect(try await asking.value.order == nil)
            }
            await backend.disconnect()
            // Nothing else was sent.
            #expect(await transport.nextSentRequest() == nil)
        }
    }

    // MARK: The Macs (feature machine_order)

    private static let keepingMacs: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": [
            "protocol": 1, "features": ["activity", "machine", "sidebar_order", "machine_order"],
            "machine": ["hostname": "mbp.local", "home": "/Users/dev", "id": "bb22bb22bb22bb22"],
        ],
    ]

    @Test func aBridgeThatKeepsTheMacsOrderSaysItsOwnIdAndTakesTheOrderWithItsMoment() async throws {
        let (backend, transport) = try await connect(ready: Self.keepingMacs)
        #expect(await backend.syncsMachineOrder == true)
        #expect(await backend.machineID == "bb22bb22bb22bb22")
        #expect(await backend.machine == HostMachine(hostname: "mbp.local", home: "/Users/dev", id: "bb22bb22bb22bb22"))

        let asking = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: [
            "list": list, "agents": [], "folders": [], "machines": ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], "machines_at": 1_791_940_000_000,
        ])
        #expect(try await asking.value.machines == MachineOrder(ids: ["aa11aa11aa11aa11", "bb22bb22bb22bb22"], at: 1_791_940_000_000))

        // Giving it an order: only the Macs and their moment are sent, and the answer is the copy it keeps now.
        let order = MachineOrder(ids: ["bb22bb22bb22bb22", "aa11aa11aa11aa11"], at: 1_791_940_500_000)
        let giving = Task { try await backend.setMachineOrder(order) }
        try await answer(
            transport, method: "order.set", params: ["machines": ["bb22bb22bb22bb22", "aa11aa11aa11aa11"], "machines_at": 1_791_940_500_000],
            with: ["list": ["id": "4be07c1d9a2f6e35", "revision": 4], "agents": [], "folders": [], "machines": ["bb22bb22bb22bb22", "aa11aa11aa11aa11"], "machines_at": 1_791_940_500_000]
        )
        #expect(try await giving.value.machines == order)

        // Never arranged: no order of the Macs, whatever the list holds.
        let none = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: ["list": list, "agents": [], "folders": [], "machines": [], "machines_at": 0])
        #expect(try await none.value.machines == nil)
        await backend.disconnect()
    }

    @Test func aBridgeFromBeforeTheMacsWereOrderedGivesNoIdAndIsSentNoOrderOfThem() async throws {
        // It keeps the agents' and folders' order, and names its Mac, with no id.
        let before: JSONValue = [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["machine", "sidebar_order"], "machine": ["hostname": "mbp.local", "home": "/Users/dev", "id": "stray"]],
        ]
        let (backend, transport) = try await connect(ready: before)
        #expect(await backend.syncsMachineOrder == false)
        #expect(await backend.machineID == nil)
        await #expect(throws: SidebarOrderError.unavailable) { try await backend.setMachineOrder(MachineOrder(ids: ["aa11aa11aa11aa11"], at: 5)) }
        // What it says of the Macs is not read either.
        let asking = Task { try await backend.sidebarOrder() }
        try await answer(transport, method: "order.list", params: [:], with: ["list": list, "agents": ["codex"], "folders": [], "machines": ["x"], "machines_at": 9])
        #expect(try await asking.value == HostSidebarOrder(list: revision, order: SidebarOrder(agents: ["codex"])))
        await backend.disconnect()
        #expect(await transport.nextSentRequest() == nil)
    }

    @Test func aListThatWasNotArrangedIsLeftOutOfWhatIsSent() throws {
        #expect(try JSONValue(encoding: BridgeWire.OrderSetParams(agents: nil, folders: ["/Users/dev/app"])).serialized() == #"{"folders":["/Users/dev/app"]}"#)
        #expect(try JSONValue(encoding: BridgeWire.OrderListParams()).objectValue?.isEmpty == true)
    }
}
