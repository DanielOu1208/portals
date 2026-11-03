import AgentCore
import Foundation
import Synchronization
import Testing
@testable import HermesBackend

/// Answers requests the way a `hermes serve` with a user name and password does:
/// signing in starts a session, and a ticket needs one.
final class SignInServer: HTTPLoader {
    struct State {
        var password = "right"
        var hasSession = false
        var tickets = 0
        var requests: [String] = []
        var bodies: [JSONValue] = []
        /// Answers the next sign-in with this status instead.
        var signInStatus: Int?
        var pushStatus = 200
        /// What `GET status` lists under `features`; nil leaves the key out, as a plugin or
        /// bridge from before the route that stops notifying one device does.
        var statusFeatures: [String]? = ["watcher"]
        /// Answers that route (`threads/{id}/watcher`) with this status instead.
        var watcherStatus: Int?
    }

    let state = Mutex(State())

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = try #require(request.url)
        let body = try JSONValue.parse(String(decoding: request.httpBody ?? Data("{}".utf8), as: UTF8.self))
        let (status, answer): (Int, JSONValue) = state.withLock { state in
            state.requests.append("\(request.httpMethod ?? "GET") \(url.path)")
            state.bodies.append(body)
            switch url.path {
            case let path where path.hasSuffix("/auth/password-login"):
                if let status = state.signInStatus {
                    state.signInStatus = nil
                    return (status, ["detail": "no"])
                }
                guard body["provider"] == "basic", body["username"] == "dana", body["password"]?.stringValue == state.password else {
                    return (401, ["detail": "Invalid credentials"])
                }
                state.hasSession = true
                return (200, ["ok": true, "next": "/"])
            case let path where path.hasSuffix("/api/auth/ws-ticket"):
                guard state.hasSession else { return (401, ["detail": "Unauthorized"]) }
                state.tickets += 1
                return (200, ["ticket": .string("ticket-\(state.tickets)"), "ttl_seconds": 30])
            case let path where path.contains("/api/plugins/"):
                // Any route behind the sign-in.
                guard state.hasSession else { return (401, ["detail": "Unauthorized"]) }
                if path.hasSuffix("/watcher"), let status = state.watcherStatus { return (status, ["detail": "no"]) }
                if path.hasSuffix("/status"), state.pushStatus == 200 {
                    var summary: [String: JSONValue] = ["devices": 1, "threads": 1, "apns_configured": false]
                    if let features = state.statusFeatures { summary["features"] = .array(features.map(JSONValue.string)) }
                    return (200, .object(summary))
                }
                return (state.pushStatus, ["ok": true])
            default:
                return (404, ["detail": "Not found"])
            }
        }
        let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(try answer.serialized().utf8), response)
    }

    var requests: [String] { state.withLock { $0.requests } }
}

@Suite struct PasswordAuthenticatorTests {
    private let base = URL(string: "https://mini.example.ts.net:8443")!

    @Test(arguments: [404, 422])
    func aServerWithTheScopedRouteIsNeverAskedToStopEveryDeviceInstead(status: Int) async throws {
        let server = SignInServer()
        server.state.withLock { $0.watcherStatus = status }
        let backend = HermesBackend(host: HostID(rawValue: "host"), authenticator: authenticator(server), makeTransport: { _ in ScriptedTransport() })
        await #expect(throws: (any Error).self) {
            try await backend.unwatch(ThreadRef.ID(rawValue: "thread"), deviceToken: "ExactCaseToken")
        }
        #expect(server.requests.filter { $0.hasPrefix("DELETE ") } == ["DELETE /api/plugins/aeriportal-push/threads/thread/watcher"])
        #expect(server.state.withLock { $0.bodies.last } == ["device_token": "ExactCaseToken"])
    }

    @Test func aPluginOrBridgeFromBeforeTheScopedRouteIsAskedTheOldWay() async throws {
        // Its status lists no features: the old route, which every server has, still stops
        // this device's notifications about a thread it removed.
        let server = SignInServer()
        server.state.withLock { $0.statusFeatures = nil }
        let backend = HermesBackend(host: HostID(rawValue: "host"), authenticator: authenticator(server), makeTransport: { _ in ScriptedTransport() })
        try await backend.unwatch(ThreadRef.ID(rawValue: "thread"), deviceToken: "ExactCaseToken")
        try await backend.unwatch(ThreadRef.ID(rawValue: "other"), deviceToken: "ExactCaseToken")
        // Asked once, not for every thread.
        #expect(server.requests.filter { !$0.hasPrefix("POST ") } == [
            "GET /api/plugins/aeriportal-push/status",
            "DELETE /api/plugins/aeriportal-push/threads/thread",
            "DELETE /api/plugins/aeriportal-push/threads/other",
        ])
    }

    @Test func aHostWhoseStatusListsTheScopedRouteIsAskedOnceAndStopsOnlyThisDevice() async throws {
        let server = SignInServer()
        let backend = HermesBackend(host: HostID(rawValue: "host"), authenticator: authenticator(server), makeTransport: { _ in ScriptedTransport() })
        try await backend.unwatch(ThreadRef.ID(rawValue: "thread"), deviceToken: "ExactCaseToken")
        try await backend.unwatch(ThreadRef.ID(rawValue: "other"), deviceToken: "ExactCaseToken")
        #expect(server.requests.filter { !$0.hasPrefix("POST ") } == [
            "GET /api/plugins/aeriportal-push/status",
            "DELETE /api/plugins/aeriportal-push/threads/thread/watcher",
            "DELETE /api/plugins/aeriportal-push/threads/other/watcher",
        ])
    }

    @Test(arguments: [true, false])
    func aBridgeSaysAsItConnectsWhetherItHasTheScopedRoute(listsIt: Bool) async throws {
        let server = SignInServer()
        let transport = ScriptedTransport()
        let backend = HermesBackend(host: HostID(rawValue: "mbp"), authenticator: authenticator(server), makeTransport: { _ in transport })
        let features: JSONValue = .array((listsIt ? ["push_host", "push_watcher"] : ["push_host"]).map(JSONValue.string))
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": [
            "replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": features],
        ]]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval"]]])
        try await connecting.value
        try await backend.unwatch(ThreadRef.ID(rawValue: "thread"), deviceToken: "ExactCaseToken")
        await backend.disconnect()
        // Nothing to ask: an older bridge, which refuses the scoped route, is asked the old way.
        #expect(server.requests.filter { !$0.hasPrefix("POST ") } == [
            listsIt ? "DELETE /api/plugins/aeriportal-push/threads/thread/watcher" : "DELETE /api/plugins/aeriportal-push/threads/thread",
        ])
    }

    @Test func aTokenlessUnwatchMakesNoRequest() async throws {
        let server = SignInServer()
        let backend = HermesBackend(host: HostID(rawValue: "host"), authenticator: authenticator(server), makeTransport: { _ in ScriptedTransport() })
        try await backend.unwatch(ThreadRef.ID(rawValue: "thread"), deviceToken: "")
        #expect(server.requests.isEmpty)
    }

    private func authenticator(
        _ server: SignInServer, password: String? = "right", base: URL? = nil
    ) -> PasswordAuthenticator {
        PasswordAuthenticator(baseURL: base ?? self.base, loader: server) {
            password.map { PasswordAuthenticator.Credentials(username: "dana", password: $0) }
        }
    }

    @Test func signsInThenOpensTheSocketWithATicket() async throws {
        let server = SignInServer()
        let request = try await authenticator(server).webSocketRequest()
        #expect(request.url?.absoluteString == "wss://mini.example.ts.net:8443/api/ws?ticket=ticket-1")
        #expect(server.requests == ["POST /auth/password-login", "POST /api/auth/ws-ticket"])
        // Only what the host's sign-in route takes.
        #expect(server.state.withLock { $0.bodies[0] } == ["provider": "basic", "username": "dana", "password": "right"])
    }

    @Test func eachSocketGetsItsOwnTicketFromTheSameSession() async throws {
        let server = SignInServer()
        let authenticator = authenticator(server)
        _ = try await authenticator.webSocketRequest()
        let second = try await authenticator.webSocketRequest()
        #expect(second.url?.query() == "ticket=ticket-2")
        #expect(server.requests.filter { $0.hasSuffix("password-login") }.count == 1)
    }

    @Test func aSessionTheHostNoLongerAcceptsIsRenewed() async throws {
        let server = SignInServer()
        let authenticator = authenticator(server)
        _ = try await authenticator.webSocketRequest()
        // The host restarted with a new signing key, say.
        server.state.withLock { $0.hasSession = false }
        let request = try await authenticator.webSocketRequest()
        #expect(request.url?.query() == "ticket=ticket-2")
        #expect(server.requests == [
            "POST /auth/password-login", "POST /api/auth/ws-ticket",
            "POST /api/auth/ws-ticket", "POST /auth/password-login", "POST /api/auth/ws-ticket",
        ])
    }

    @Test func aWrongPasswordIsReportedAsSuch() async throws {
        let server = SignInServer()
        await #expect(throws: HermesAuthError.invalidCredentials) {
            _ = try await authenticator(server, password: "wrong").webSocketRequest()
        }
        // No ticket was asked for without a session.
        #expect(server.requests == ["POST /auth/password-login"])
    }

    @Test func missingCredentialsNeverReachTheHost() async throws {
        let server = SignInServer()
        await #expect(throws: HermesAuthError.missingCredentials) {
            _ = try await authenticator(server, password: nil).webSocketRequest()
        }
        await #expect(throws: HermesAuthError.missingCredentials) {
            _ = try await authenticator(server, password: "").webSocketRequest()
        }
        #expect(server.requests.isEmpty)
    }

    @Test(arguments: [
        (404, HermesAuthError.passwordSignInUnavailable),
        (429, HermesAuthError.tooManyAttempts),
        (503, HermesAuthError.unexpectedStatus(503)),
    ])
    func signInFailuresSayWhy(status: Int, expected: HermesAuthError) async throws {
        let server = SignInServer()
        server.state.withLock { $0.signInStatus = status }
        await #expect(throws: expected) {
            _ = try await authenticator(server).webSocketRequest()
        }
    }

    @Test func aPasswordChangedInTheAppIsUsedAtTheNextSignIn() async throws {
        let server = SignInServer()
        let current = Mutex("old")
        let authenticator = PasswordAuthenticator(baseURL: base, loader: server) {
            PasswordAuthenticator.Credentials(username: "dana", password: current.withLock { $0 })
        }
        await #expect(throws: HermesAuthError.invalidCredentials) { _ = try await authenticator.webSocketRequest() }
        current.withLock { $0 = "right" }
        #expect(try await authenticator.webSocketRequest().url?.query() == "ticket=ticket-1")
    }

    @Test func restRequestsSignInFirstAndAgainWhenTheSessionIsGone() async throws {
        let server = SignInServer()
        let authenticator = authenticator(server)
        let request = URLRequest(url: base.appendingPathComponent("api/plugins/aeriportal-push/device"))

        #expect(try await authenticator.send(request).1.statusCode == 200)
        #expect(server.requests == ["POST /auth/password-login", "GET /api/plugins/aeriportal-push/device"])

        // The session ended on the host: one new sign-in, then the request again.
        server.state.withLock { $0.hasSession = false }
        #expect(try await authenticator.send(request).1.statusCode == 200)
        #expect(server.requests.suffix(3) == [
            "GET /api/plugins/aeriportal-push/device", "POST /auth/password-login", "GET /api/plugins/aeriportal-push/device",
        ])
    }

    @Test func registeringForNotificationsCallsThePluginsRoutes() async throws {
        let server = SignInServer()
        let backend = HermesBackend(
            host: HostID(rawValue: "test"), authenticator: authenticator(server), makeTransport: { _ in ScriptedTransport() }
        )
        let device = PushDevice(token: String(repeating: "ab", count: 32), environment: .sandbox, bundleID: "com.danielou.portals")
        let thread = WatchedThread(id: ThreadRef.ID(rawValue: "20261005_000000_abc123"), agent: "karina", agentName: "Karina", title: "Fix the build")

        try await backend.register(device, watching: [thread])
        try await backend.unwatch(thread.id, deviceToken: device.token)

        #expect(server.requests.suffix(3) == [
            "PUT /api/plugins/aeriportal-push/registration",
            "GET /api/plugins/aeriportal-push/status",
            "DELETE /api/plugins/aeriportal-push/threads/20261005_000000_abc123/watcher",
        ])
        let sent = server.state.withLock { $0.bodies[$0.bodies.count - 3] }
        #expect(sent == [
            "device": ["token": .string(device.token), "environment": "sandbox", "bundle_id": "com.danielou.portals"],
            "threads": [["id": "20261005_000000_abc123", "agent": "karina", "agent_name": "Karina", "title": "Fix the build"]],
        ])
        #expect(server.state.withLock { $0.bodies.last } == ["device_token": .string(device.token)])
    }

    /// What a backend sends to register, once connected to a host that said `ready`.
    private func registration(
        after ready: JSONValue, relayToken: String? = nil, key: Data? = nil, muted: Set<NotificationKind> = []
    ) async throws -> JSONValue {
        let server = SignInServer()
        let transport = ScriptedTransport()
        let backend = HermesBackend(host: HostID(rawValue: "mbp"), authenticator: authenticator(server), makeTransport: { _ in transport })
        transport.deliver(["jsonrpc": "2.0", "method": "event", "params": ["type": "gateway.ready", "payload": ready]])
        let connecting = Task { try await backend.connect() }
        let capabilities = try #require(await transport.nextSentRequest())
        transport.deliver(["jsonrpc": "2.0", "id": try #require(capabilities["id"]), "result": ["server_requests": ["approval"]]])
        try await connecting.value

        let device = PushDevice(
            token: String(repeating: "ab", count: 32), environment: .sandbox, bundleID: "com.danielou.portals", relayToken: relayToken, key: key,
            muted: muted
        )
        let thread = WatchedThread(id: ThreadRef.ID(rawValue: "t1"), agent: "claude", agentName: "Claude Code")
        try await backend.register(device, watching: [thread])
        await backend.disconnect()
        return try #require(server.state.withLock { $0.bodies.last })
    }

    @Test func aBridgeThatAsksIsToldWhichHostItIs() async throws {
        let sent = try await registration(after: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["push_host"]]])
        #expect(sent["host"] == "mbp")
        #expect(sent["threads"] == [["id": "t1", "agent": "claude", "agent_name": "Claude Code", "title": ""]])
    }

    @Test func noOtherHostIsSentTheHostKey() async throws {
        // Hermes rejects keys its plugin does not know.
        let hermes = try await registration(after: ["replay_epoch": "e1", "heartbeat": false])
        #expect(hermes["host"] == nil)
        #expect(hermes.objectValue.map { Set($0.keys) } == ["device", "threads"])
        let bridge = try await registration(after: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": []]])
        #expect(bridge["host"] == nil)
    }

    @Test func aBridgeThatTakesThemIsGivenTheRelayTokenAndTheKey() async throws {
        let key = Data(repeating: 9, count: 32)
        let bridge = try await registration(
            after: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["push_relay", "push_sealed"]]],
            relayToken: "v1.claims.signature", key: key
        )
        #expect(bridge["device"]?["relay_token"] == "v1.claims.signature")
        #expect(bridge["device"]?["key"] == .string(key.base64EncodedString()))

        // Each only with its own feature, and neither to Hermes.
        let relayOnly = try await registration(
            after: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["push_relay"]]],
            relayToken: "v1.claims.signature", key: key
        )
        #expect(relayOnly["device"]?["relay_token"] == "v1.claims.signature")
        #expect(relayOnly["device"]?["key"] == nil)
        let hermes = try await registration(after: ["replay_epoch": "e1", "heartbeat": false], relayToken: "v1.claims.signature", key: key)
        #expect(hermes["device"]?.objectValue.map { Set($0.keys) } == ["token", "environment", "bundle_id"])
    }

    @Test func aBridgeThatMutesIsToldWhichKindsTheDeviceWantsNoneOfEveryTime() async throws {
        let muting: JSONValue = ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": ["push_muting"]]]
        let muted = try await registration(after: muting, muted: NotificationKind.done)
        #expect(muted["device"]?["muted"] == ["failed", "finished"])
        // None muted is said too: the bridge keeps a list left out.
        let none = try await registration(after: muting)
        #expect(none["device"]?["muted"] == [])
        // Only to a bridge that takes it; never to Hermes.
        let older = try await registration(after: ["replay_epoch": "e1", "heartbeat": false, "bridge": ["protocol": 1, "features": []]], muted: [.approval])
        #expect(older["device"]?["muted"] == nil)
        let hermes = try await registration(after: ["replay_epoch": "e1", "heartbeat": false], muted: [.approval])
        #expect(hermes["device"]?.objectValue.map { Set($0.keys) } == ["token", "environment", "bundle_id"])
    }

    @Test func aPlainHTTPHostUsesAPlainSocketAndKeepsItsPathPrefix() async throws {
        let server = SignInServer()
        let request = try await authenticator(server, base: URL(string: "http://192.168.1.20:9119/hermes/")!).webSocketRequest()
        #expect(request.url?.absoluteString == "ws://192.168.1.20:9119/hermes/api/ws?ticket=ticket-1")
        #expect(server.requests == ["POST /hermes/auth/password-login", "POST /hermes/api/auth/ws-ticket"])
    }
}
