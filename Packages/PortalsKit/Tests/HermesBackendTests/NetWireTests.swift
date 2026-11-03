import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// The net on the wire (feature `net`): signing in with the device's token, joining with
/// a code, where a Mac's list is, and the methods a device calls.
@Suite struct NetWireTests {
    private static let base = URL(string: "https://studio.tailnet.ts.net:10010")!
    private static let netReady: JSONValue = [
        "replay_epoch": "e1", "heartbeat": false,
        "bridge": ["protocol": 1, "features": ["activity", "poll_now", "net"], "net": ["id": "3e5a9c1f0b7d2468", "revision": 12]],
    ]

    // MARK: Signing in with the token

    @Test func theTokenGoesInAHeaderOnTheUpgradeWithNoTicketAndOnEveryRESTCall() async throws {
        let loader = RecordingLoader()
        let authenticator = TokenAuthenticator(baseURL: Self.base, loader: loader) { "tok-123" }
        let socket = try await authenticator.webSocketRequest()
        #expect(socket.url?.absoluteString == "wss://studio.tailnet.ts.net:10010/api/ws")
        #expect(socket.value(forHTTPHeaderField: "Authorization") == "Bearer tok-123")

        _ = try await authenticator.send(URLRequest(url: Self.base.appendingPathComponent("api/plugins/aeriportal-push/status")))
        #expect(loader.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tok-123"])
        // No sign-in first, and no cookie of any.
        #expect(loader.requests.map { $0.url?.path } == ["/api/plugins/aeriportal-push/status"])
    }

    @Test func withNoTokenThereIsNothingToSignInWith() async {
        let authenticator = TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { nil }
        await #expect(throws: HermesAuthError.missingCredentials) { try await authenticator.webSocketRequest() }
        await #expect(throws: HermesAuthError.missingCredentials) { try await authenticator.send(URLRequest(url: Self.base)) }
    }

    // MARK: Joining

    @Test func aDeviceJoinsWithTheCodeAndIsGivenItsTokenAndTheList() async throws {
        let loader = RecordingLoader(status: 200, answer: [
            "net": "3e5a9c1f0b7d2468",
            "member": ["id": "phone-0003", "kind": "device", "name": "iPhone", "platform": "ios", "changed": 5, "by": "studio-0001"],
            "token": "tok-new",
            "members": [
                ["id": "studio-0001", "kind": "mac", "name": "Studio", "url": "https://studio.tailnet.ts.net:10010", "key": "k", "relay": "r", "changed": 1, "by": "studio-0001",
                 "token_tag": "0123456789abcdef"],
                ["id": "phone-0003", "kind": "device", "name": "iPhone", "platform": "ios", "changed": 5, "by": "studio-0001"],
                ["id": "bad id!", "kind": "mac", "name": "Dropped"],
            ],
        ])
        let joined = try await NetJoinClient(loader: loader).join(
            at: Self.base, code: "x7Hq2b9LkPz0aW4vR1sYtA", as: NetDevice(id: "phone-0003", name: "iPhone", platform: "ios")
        )
        #expect(joined.net == "3e5a9c1f0b7d2468" && joined.token == "tok-new")
        #expect(joined.members.map(\.id) == ["studio-0001", "phone-0003"])
        #expect(joined.members.first?.url == Self.base)
        // The token's tag, from a bridge that gives it (net-5); none from one that does not.
        #expect(joined.members.map(\.tokenTag) == ["0123456789abcdef", nil])

        let request = try #require(loader.requests.first)
        #expect(request.httpMethod == "POST" && request.url?.path == "/net/join")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONValue.parse(String(decoding: try #require(request.httpBody), as: UTF8.self))
        #expect(body == [
            "code": "x7Hq2b9LkPz0aW4vR1sYtA",
            "member": ["id": "phone-0003", "kind": "device", "name": "iPhone", "platform": "ios"],
        ])
    }

    @Test func aMacThatSaysNoIsHeardInItsWords() async {
        let device = NetDevice(id: "phone-0003", name: "iPhone", platform: "ios")
        let used = RecordingLoader(status: 401, answer: ["detail": "This join code is used, expired or wrong. Make a new one on a device in the net."])
        await #expect(throws: NetError.refused("This join code is used, expired or wrong. Make a new one on a device in the net.")) {
            try await NetJoinClient(loader: used).join(at: Self.base, code: "c", as: device)
        }
        // A bridge from before the net has no such route.
        await #expect(throws: NetError.unavailable) {
            try await NetJoinClient(loader: RecordingLoader(status: 404, answer: ["detail": "Not found."])).join(at: Self.base, code: "c", as: device)
        }
    }

    // MARK: Where the list is

    @Test func gatewayReadySaysWhereTheListIsOnlyFromABridgeWithTheNet() {
        #expect(HermesWire.GatewayReady(payload: Self.netReady).bridge?.net == NetRevision(net: "3e5a9c1f0b7d2468", revision: 12))
        let without: JSONValue = ["bridge": ["protocol": 1, "features": ["activity"], "net": ["id": "3e5a9c1f0b7d2468", "revision": 12]]]
        #expect(HermesWire.GatewayReady(payload: without).bridge?.net == nil)
    }

    @Test func eachConnectionAndEachPollNowSayWhereTheListIs() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { "tok" },
            makeTransport: { _ in transport }
        )
        #expect(await backend.offersNet == nil)
        let heard = NewsHeard(backend.netNews)
        try await connect(backend, transport, ready: Self.netReady)
        #expect(await backend.offersNet == true)
        #expect(await within { heard.news.count == 1 ? true : nil } == true)
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": [
            "type": "poll.now", "payload": ["thread_list": ["id": "l", "revision": 3], "net": ["id": "3e5a9c1f0b7d2468", "revision": 13]],
        ]])
        #expect(await within { heard.news.count == 2 ? true : nil } == true)
        #expect(heard.news == [
            .at(NetRevision(net: "3e5a9c1f0b7d2468", revision: 12)), .at(NetRevision(net: "3e5a9c1f0b7d2468", revision: 13)),
        ])
        await backend.disconnect()
    }

    @Test func aTokenRefusedIsHeardWithTheMacsSentence() async throws {
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { "tok" },
            reconnectDelays: [.seconds(60)],
            makeTransport: { _ in RefusingTransport(reason: "This device was removed from the net.") }
        )
        let heard = NewsHeard(backend.netNews)
        await #expect(throws: (any Error).self) { try await backend.connect() }
        #expect(await within { heard.news.isEmpty ? nil : true } == true)
        #expect(heard.news.first == .refused("This device was removed from the net."))
        await backend.disconnect()
    }

    @Test func aTicketRefusedIsNoNewsOfTheNet() async throws {
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: LoopbackTokenAuthenticator(baseURL: Self.base, fixedToken: "t"),
            reconnectDelays: [.seconds(60)],
            makeTransport: { _ in RefusingTransport(reason: "The ticket was not accepted.") }
        )
        let heard = NewsHeard(backend.netNews)
        await #expect(throws: (any Error).self) { try await backend.connect() }
        try await Task.sleep(for: .milliseconds(200))
        #expect(heard.news.isEmpty)
        await backend.disconnect()
    }

    // MARK: The methods

    @Test func theListACodeARemovalAndAJoinAreAskedForAsTheBridgeTakesThem() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { "tok" },
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, ready: Self.netReady)
        let list: JSONValue = [
            "net": "3e5a9c1f0b7d2468", "here": "studio-0001", "you": "phone-0003", "revision": 14,
            "members": [["id": "studio-0001", "kind": "mac", "name": "Studio", "url": "https://studio.tailnet.ts.net:10010", "changed": 1, "by": "studio-0001"]],
        ]

        async let listed = backend.netList()
        var sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.list" && sent["params"] == [:])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": list])
        #expect(try await listed == NetList(net: "3e5a9c1f0b7d2468", here: "studio-0001", you: "phone-0003", revision: 14, members: [
            NetMember(id: "studio-0001", kind: .mac, name: "Studio", url: Self.base, changed: 1, by: "studio-0001"),
        ]))

        async let invited = backend.netInvite()
        sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.invite" && sent["params"] == [:])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": [
            "link": "portals://join?v=1&url=x&code=c", "code": "c", "url": "https://studio.tailnet.ts.net:10010", "expires_at": 1_800_000_600_000,
        ]])
        #expect(try await invited == NetInvite(link: "portals://join?v=1&url=x&code=c", code: "c", expiresAt: Date(timeIntervalSince1970: 1_800_000_600)))

        async let removed = backend.netRemove("pad-000004")
        sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.remove" && sent["params"] == ["member": "pad-000004"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": list])
        #expect(try await removed.revision == 14)

        // The new Mac's no is the device's to read.
        let joining = Task { try await backend.netJoin(with: "portals://join?v=1&url=x&code=c") }
        sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.join_with" && sent["params"] == ["link": "portals://join?v=1&url=x&code=c"])
        let refusal = "This Mac is in a net with other Macs. Run `portals net leave` on it first."
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "error": ["code": -32602, "message": .string(refusal)]])
        await #expect(throws: NetError.refused(refusal)) { try await joining.value }
        await backend.disconnect()
    }

    @Test func aMacIsRenamedForTheNetWithTheStampOfTheNameHeldAndItsNamesAreRead() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { "tok" },
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, ready: [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["activity", "poll_now", "net", "net_rename"], "net": ["id": "3e5a9c1f0b7d2468", "revision": 12]],
        ])
        #expect(await backend.renamesNetMacs == true)
        // A device is renamed only by a bridge that says so (`net_rename_devices`).
        #expect(await backend.renamesNetDevices == false)
        let list: JSONValue = [
            "net": "3e5a9c1f0b7d2468", "here": "studio-0001", "you": "phone-0003", "revision": 15,
            "members": [
                ["id": "mini-00002", "kind": "mac", "name": "Office", "url": "https://mini.tailnet.ts.net:10010", "changed": 1, "by": "mini-00002", "named": 1_800_000_000_123, "named_by": "studio-0001"],
                // A stamp without who set it is not read; one on a device is (2026-10-28).
                ["id": "laptop-003", "kind": "mac", "name": "Laptop", "url": "https://laptop.tailnet.ts.net:10010", "changed": 1, "by": "laptop-003", "named": 5],
                ["id": "phone-0003", "kind": "device", "name": "iPhone", "platform": "ios", "changed": 1, "by": "studio-0001", "named": 5, "named_by": "studio-0001"],
            ],
        ]

        async let renamed = backend.netRename("mini-00002", to: "Office", after: 1_800_000_000_000, inNet: "3e5a9c1f0b7d2468")
        var sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.rename" && sent["params"] == ["member": "mini-00002", "name": "Office", "after": 1_800_000_000_000, "net": "3e5a9c1f0b7d2468"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": list])
        let members = try await renamed.members
        #expect(members.map(\.named) == [1_800_000_000_123, nil, 5])
        #expect(members.map(\.namedBy) == ["studio-0001", nil, "studio-0001"])

        // Holding no stamp, the device sends none; the Mac's no is heard in its words.
        let refusing = Task { try await backend.netRename("mini-00002", to: "", after: nil, inNet: nil) }
        sent = try #require(await transport.nextSentRequest())
        #expect(sent["params"] == ["member": "mini-00002", "name": ""])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "error": ["code": -32602, "message": "A Mac's name cannot be empty."]])
        await #expect(throws: NetError.refused("A Mac's name cannot be empty.")) { try await refusing.value }
        await backend.disconnect()
    }

    @Test func aBridgeWithTheNetButNotItsRenamesIsNotAskedToRename() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: LoopbackTokenAuthenticator(baseURL: Self.base, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, ready: Self.netReady)
        #expect(await backend.renamesNetMacs == false)
        #expect(await backend.renamesNetDevices == false)
        await #expect(throws: NetError.unavailable) { try await backend.netRename("mini-00002", to: "Office", after: nil, inNet: nil) }
        await backend.disconnect()
    }

    /// 2026-10-28: a device of the net renamed from the app, as a Mac is, where the
    /// bridge takes it (`net_rename_devices`): the same call, with the device's id.
    @Test func aDeviceIsRenamedForTheNetWhereTheBridgeTakesIt() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: TokenAuthenticator(baseURL: Self.base, loader: RecordingLoader()) { "tok" },
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, ready: [
            "replay_epoch": "e1", "heartbeat": false,
            "bridge": ["protocol": 1, "features": ["activity", "poll_now", "net", "net_rename", "net_rename_devices"], "net": ["id": "3e5a9c1f0b7d2468", "revision": 12]],
        ])
        #expect(await backend.renamesNetMacs == true)
        #expect(await backend.renamesNetDevices == true)
        async let renamed = backend.netRename("macapp-0004", to: "MacBook Pro 16", after: nil, inNet: "3e5a9c1f0b7d2468")
        let sent = try #require(await transport.nextSentRequest())
        #expect(sent["method"] == "net.rename" && sent["params"] == ["member": "macapp-0004", "name": "MacBook Pro 16", "net": "3e5a9c1f0b7d2468"])
        transport.deliver(["jsonrpc": "2.0", "id": try #require(sent["id"]), "result": [
            "net": "3e5a9c1f0b7d2468", "here": "studio-0001", "you": "macapp-0004", "revision": 16,
            "members": [["id": "macapp-0004", "kind": "device", "name": "MacBook Pro 16", "platform": "macos", "changed": 1, "by": "studio-0001", "named": 1_800_000_000_500, "named_by": "studio-0001"]],
        ]])
        let entry = try #require(try await renamed.members.first)
        #expect(entry.name == "MacBook Pro 16" && entry.named == 1_800_000_000_500 && entry.namedBy == "studio-0001")
        await backend.disconnect()
    }

    @Test func aBridgeWithoutTheNetIsAskedNothingOfIt() async throws {
        let transport = ScriptedTransport()
        let backend = HermesBackend(
            host: HostID(rawValue: "studio"),
            authenticator: LoopbackTokenAuthenticator(baseURL: Self.base, fixedToken: "t"),
            makeTransport: { _ in transport }
        )
        try await connect(backend, transport, ready: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["activity"]]])
        #expect(await backend.offersNet == false)
        await #expect(throws: NetError.unavailable) { try await backend.netList() }
        await #expect(throws: NetError.unavailable) { try await backend.netInvite() }
        await backend.disconnect()
    }

    @Test func theNetMethodsStayInsideTheBridgesPartOfTheContract() throws {
        let subset = try Fixtures.json("contract-subset.json")
        let methods = try #require(subset["bridge"]?["methods"])
        let expected: [(String, any Encodable)] = [
            (BridgeWire.Method.netList, BridgeWire.NetListParams()),
            (BridgeWire.Method.netInvite, BridgeWire.NetListParams()),
            (BridgeWire.Method.netRemove, BridgeWire.NetRemoveParams(member: "m", net: "n")),
            (BridgeWire.Method.netJoinWith, BridgeWire.NetJoinWithParams(link: "l")),
            (BridgeWire.Method.netRename, BridgeWire.NetRenameParams(member: "m", name: "n", after: 1, net: "n")),
        ]
        for (name, params) in expected {
            let entry = try #require(methods[name], "\(name) is missing from contract-subset.json")
            #expect(entry["feature"]?.stringValue == (name == BridgeWire.Method.netRename ? BridgeWire.Feature.netRename : BridgeWire.Feature.net))
            let allowed = Set(try #require(entry["params"]?.arrayValue).compactMap(\.stringValue))
            let encoded = try #require(try JSONValue(encoding: params).objectValue)
            #expect(Set(encoded.keys) == allowed, "\(name)")
            #expect(subset["methods"]?[name] == nil, "\(name) is never sent to Hermes")
        }
    }

    // MARK: Helpers

    private func connect(_ backend: HermesBackend, _ transport: ScriptedTransport, ready: JSONValue) async throws {
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        #expect(capabilities["method"]?.stringValue == "client.capabilities")
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": [:]])
        try await connecting.value
    }
}

/// Answers every request with one status and body, and keeps the requests.
private final class RecordingLoader: HTTPLoader {
    private let status: Int
    private let answer: JSONValue
    private let kept = Mutex<[URLRequest]>([])

    init(status: Int = 200, answer: JSONValue = [:]) {
        self.status = status
        self.answer = answer
    }

    var requests: [URLRequest] { kept.withLock { $0 } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        kept.withLock { $0.append(request) }
        let url = try #require(request.url)
        let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(try answer.serialized().utf8), response)
    }
}

/// A socket the Mac closes with 4401 as it opens, as a bridge does for a token or ticket
/// it does not take.
private final class RefusingTransport: WebSocketTransport {
    private let reason: String

    init(reason: String) {
        self.reason = reason
    }

    func send(_ text: String) async throws {
        throw WebSocketClosed(code: 4401, reason: reason)
    }

    func receive() async throws -> String {
        throw WebSocketClosed(code: 4401, reason: reason)
    }

    func close() {}
}

/// What a backend said of the net, gathered from any task.
private final class NewsHeard: Sendable {
    private let heard = Mutex<[NetNews]>([])

    init(_ news: AsyncStream<NetNews>) {
        Task {
            for await said in news {
                self.add(said)
            }
        }
    }

    private func add(_ said: NetNews) {
        heard.withLock { $0.append(said) }
    }

    var news: [NetNews] { heard.withLock { $0 } }
}
