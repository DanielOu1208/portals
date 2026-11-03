// Compiled by native-setup-tests.py with the full actual credential store and relay,
// and verbatim current connection-test/registration bodies. No OS service is used.
import AgentCore
import Darwin
import Foundation
import Security

nonisolated struct TestLogMessage: ExpressibleByStringInterpolation {
    enum Privacy { case `public` }
    struct StringInterpolation: StringInterpolationProtocol {
        init(literalCapacity: Int, interpolationCount: Int) {}
        mutating func appendLiteral(_ text: String) {}
        mutating func appendInterpolation<T>(_ value: T) {}
        mutating func appendInterpolation<T>(_ value: T, privacy: Privacy) {}
    }
    init(stringLiteral: String) {}
    init(stringInterpolation: StringInterpolation) {}
}
nonisolated struct QuietLog {
    func notice(_ message: TestLogMessage) {}
    func error(_ message: TestLogMessage) {}
}
nonisolated enum AppLog {
    static let push = QuietLog()
    static let chat = QuietLog()
}
nonisolated enum DebugLaunch {
    static let relayURL: URL? = nil
}

// These module-local names intercept only the two production files compiled here.
// AgentCore remains a separate module. Nothing reads real app preferences or bundles.
nonisolated struct SyntheticBundle: Sendable {
    let bundleIdentifier: String? = "synthetic.portals.tests"
    func object(forInfoDictionaryKey key: String) -> Any? {
        switch key {
        case "PortalsRelayURL": "https://relay.invalid"
        case "PortalsPushEnvironment": "development"
        default: nil
        }
    }
}
nonisolated enum Bundle { static let main = SyntheticBundle() }
nonisolated final class MemoryDefaults: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    func data(forKey key: String) -> Data? { lock.withLock { storage[key] } }
    func set(_ data: Data?, forKey key: String) { lock.withLock { storage[key] = data } }
    func string(forKey key: String) -> String? { data(forKey: key).flatMap { String(data: $0, encoding: .utf8) } }
    func set(_ string: String?, forKey key: String) { set(string.map { Data($0.utf8) }, forKey: key) }
    func reset() { lock.withLock { storage = [:] } }
}
nonisolated enum UserDefaults { static let standard = MemoryDefaults() }
nonisolated struct SyntheticSession {
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await RelayHTTP.shared.data(for: request)
    }
}
nonisolated enum URLSession { static let shared = SyntheticSession() }

actor RelayHTTP {
    static let shared = RelayHTTP()
    private var requests: [String] = []
    private var waiting: [String: CheckedContinuation<(Data, URLResponse), any Error>] = [:]
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        precondition(request.url?.host == "relay.invalid")
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
        precondition(body["environment"] != nil && body["bundle_id"] == Bundle.main.bundleIdentifier)
        let device = body["token"]!
        requests.append(device)
        return try await withCheckedThrowingContinuation { waiting[device] = $0 }
    }
    func count(for device: String) -> Int { requests.filter { $0 == device }.count }
    func fail(_ device: String) {
        precondition(waiting[device] != nil)
        waiting.removeValue(forKey: device)!.resume(throwing: URLError(.notConnectedToInternet))
    }
    func succeed(_ device: String, receipt: String) throws {
        precondition(waiting[device] != nil)
        let data = try JSONSerialization.data(withJSONObject: ["relay_token": receipt])
        let response = HTTPURLResponse(url: URL(string: "https://relay.invalid/v1/devices")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        waiting.removeValue(forKey: device)!.resume(returning: (data, response))
    }
}

final class PushCoordinator {
    static let shared = PushCoordinator()
    private(set) var deviceToken: String? {
        didSet {
            if let deviceToken { tokenPublications.append((deviceToken, relayToken)) }
        }
    }
    private(set) var relayToken: String?
    // Capture the pair when the new device token is published, not only at task end.
    var tokenPublications: [(String, String?)] = []
    func configure(device: String?, relay: String?) {
        relayToken = relay
        deviceToken = device
    }
    /* PRODUCTION_REGISTERED */
    /* PRODUCTION_LAST_TOKEN */
    /* PRODUCTION_LAST_TOKEN_KEY */
    /* PRODUCTION_ENVIRONMENT */
}

#if TEST_HOSTPUSH
struct ThreadRecord {
    var ref: ThreadRef
    var isFromHost = false
    var id: ThreadRef.ID { ref.id }
}
enum NotificationChoices {
    static var muted: Set<NotificationKind> = []
}
struct SyntheticNotificationKeys {
    func makeKey(for host: HostID) -> Data { Data() }
}
enum NotificationKeys {
    static let shared: SyntheticNotificationKeys? = nil
}
actor PushHost: PushRegistering {
    private(set) var devices: [PushDevice] = []
    private(set) var watches: [[WatchedThread]] = []
    private var first: CheckedContinuation<Void, Never>?
    func register(_ device: PushDevice, watching threads: [WatchedThread]) async throws {
        devices.append(device)
        watches.append(threads)
        if devices.count == 1 { await withCheckedContinuation { first = $0 } }
    }
    func unwatch(_ thread: ThreadRef.ID, deviceToken: String) async throws {}
    func release() { first?.resume(); first = nil }
}
final class HostPushHarness {
    enum Connection { case connected }
    var isRetired = false
    var connection = Connection.connected
    var backend: Any
    var host: HostConfig
    var threads: [ThreadRecord]
    private var pushRegistration: Task<Void, Never>?
    init(host: HostConfig, backend: PushHost) {
        self.host = host
        self.backend = backend
        threads = [.init(ref: .init(id: .init(rawValue: "watched"), agent: .init(host: host.id, name: "codex"), title: "Watched"))]
    }
    func agent(_ id: Agent.ID) -> Agent? { nil }
    func finish() async { await pushRegistration?.value }
    /* PRODUCTION_HOST_REGISTER */
}
#endif

nonisolated final class SyntheticKeychain: @unchecked Sendable {
    static let shared = SyntheticKeychain()
    private let lock = NSLock()
    private var values: [String: Data] = [:]
    private var failsNextWrite = false
    private var calls: [String] = []
    func failNextWrite() { lock.withLock { failsNextWrite = true } }
    func operationCount(_ operation: String) -> Int { lock.withLock { calls.filter { $0 == operation }.count } }
    private func account(_ query: CFDictionary) -> String { (query as NSDictionary)[kSecAttrAccount] as! String }
    func delete(_ query: CFDictionary) -> OSStatus {
        lock.withLock {
            calls.append("delete")
            return values.removeValue(forKey: account(query)) == nil ? errSecItemNotFound : errSecSuccess
        }
    }
    func add(_ query: CFDictionary) -> OSStatus {
        lock.withLock {
            calls.append("add")
            if failsNextWrite { failsNextWrite = false; return errSecNotAvailable }
            guard values[account(query)] == nil else { return errSecDuplicateItem }
            values[account(query)] = (query as NSDictionary)[kSecValueData] as? Data
            return errSecSuccess
        }
    }
    func update(_ query: CFDictionary, _ changes: CFDictionary) -> OSStatus {
        lock.withLock {
            calls.append("update")
            guard values[account(query)] != nil else { return errSecItemNotFound }
            if failsNextWrite { failsNextWrite = false; return errSecNotAvailable }
            values[account(query)] = (changes as NSDictionary)[kSecValueData] as? Data
            return errSecSuccess
        }
    }
    func copy(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
        lock.withLock {
            calls.append("read")
            guard let data = values[account(query)] else { return errSecItemNotFound }
            result?.pointee = data as CFData
            return errSecSuccess
        }
    }
}
@discardableResult nonisolated func SecItemDelete(_ query: CFDictionary) -> OSStatus {
    SyntheticKeychain.shared.delete(query)
}
@discardableResult nonisolated func SecItemAdd(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    SyntheticKeychain.shared.add(query)
}
@discardableResult nonisolated func SecItemUpdate(_ query: CFDictionary, _ changes: CFDictionary) -> OSStatus {
    SyntheticKeychain.shared.update(query, changes)
}
@discardableResult nonisolated func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    SyntheticKeychain.shared.copy(query, result)
}

actor ConnectionPlan {
    static let shared = ConnectionPlan()
    private var waiting: [HostID: CheckedContinuation<Void, any Error>] = [:]
    private var counts: [HostID: Int] = [:]
    private var disconnected: [HostID] = []
    func connect(_ host: HostID) async throws {
        try await withCheckedThrowingContinuation { waiting[host] = $0 }
    }
    func hasRequest(_ host: HostID) -> Bool { waiting[host] != nil }
    func succeed(_ host: HostID, agents: Int) {
        counts[host] = agents
        waiting.removeValue(forKey: host)!.resume()
    }
    func fail(_ host: HostID) {
        waiting.removeValue(forKey: host)!.resume(throwing: URLError(.cannotConnectToHost))
    }
    func agents(_ host: HostID) -> [Agent] {
        (0..<(counts[host] ?? 0)).map { Agent(id: .init(host: host, name: "synthetic-\($0)")) }
    }
    func disconnect(_ host: HostID) { disconnected.append(host) }
    func disconnectCount(_ host: HostID) -> Int { disconnected.filter { $0 == host }.count }
}
nonisolated enum HostDirectory {
    static func authenticator(for host: HostConfig, password: @escaping @Sendable () -> String?) -> HostID { host.id }
    static func authenticator(for host: HostConfig, credentials: any CredentialStore) -> HostID { host.id }
}
nonisolated struct HermesBackend {
    let host: HostID
    init(host: HostID, authenticator: HostID) { self.host = host }
    func connect() async throws { try await ConnectionPlan.shared.connect(host) }
    func listAgents() async throws -> [Agent] { await ConnectionPlan.shared.agents(host) }
    func disconnect() async { await ConnectionPlan.shared.disconnect(host) }
}
final class HostSettingsHarness {
    struct Net { var token: String }
    var config: HostConfig?
    var password = "synthetic-test-password"
    var netProblem: String?
    var macRefused: String?
    var isNetHost = false
    var net: Net?
    private var trial = ConnectionTrial()
    private var probe: Task<Void, Never>?
    init(_ config: HostConfig) { self.config = config }
    var status: String { "\(trial.phase)" }
    // Same invalidation as HostSettingsSheet's address/credential onChange.
    func edit(to config: HostConfig) { self.config = config; /* PRODUCTION_INVALIDATION */ }
    func test() async {
        startTrial()
        await probe?.value
    }
    func stop() { stopTrial() }
    /* PRODUCTION_START_TRIAL */
    /* PRODUCTION_STOP_TRIAL */
    /* PRODUCTION_TRIAL_LIMIT */
    /* PRODUCTION_TRY_CONNECTION */
}

@main struct NativeSetupTests {
    static var failures = 0
    static func check(_ condition: Bool, _ description: String) {
        if condition { print("PASS \(description)") }
        else { failures += 1; print("FAIL \(description)") }
    }
    static func eventually(_ ready: () async -> Bool) async throws {
        let until = ContinuousClock.now + .seconds(3)
        while !(await ready()) {
            guard ContinuousClock.now < until else { throw NSError(domain: "NativeSetupTestTimeout", code: 1) }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    static func host(_ name: String) -> HostConfig {
        HostConfig(id: .init(rawValue: name), name: name, url: URL(string: "https://\(name.lowercased()).invalid")!, username: "synthetic")
    }
    static func primeRelay(device: String, receipt: String, environment: String = "sandbox", age: TimeInterval = 0) throws {
        let saved: [String: Any] = [
            "relay": "https://relay.invalid", "token": device, "environment": environment,
            "relayToken": receipt, "at": Date().addingTimeInterval(-age).timeIntervalSinceReferenceDate,
        ]
        UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: saved), forKey: "PortalsRelayRegistration")
    }
    static func cachedRelayDevice() -> String? {
        guard let data = UserDefaults.standard.data(forKey: "PortalsRelayRegistration"),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return saved["token"] as? String
    }
    // TEST_TOPIC: registration
    #if TEST_REGISTRATION
    static func registrationTests() async throws {
        try primeRelay(device: "01", receipt: "receipt-01")
        let rotating = PushCoordinator()
        rotating.registered(with: Data([1]))
        try await eventually { rotating.relayToken == "receipt-01" }
        check(await RelayHTTP.shared.count(for: "01") == 0, "fresh matching relay cache avoids a network request")
        rotating.registered(with: Data([2]))
        check(rotating.deviceToken == "02" && rotating.relayToken == nil, "rotating APNs token invalidates old receipt immediately")
        check(rotating.tokenPublications.last?.1 == nil, "old receipt clears before the changed token is published")
        try await eventually { await RelayHTTP.shared.count(for: "02") == 1 }
        await RelayHTTP.shared.fail("02")
        try await Task.sleep(for: .milliseconds(20))
        check(rotating.relayToken == nil, "failed rotated registration cannot retain old recipient capability")

        UserDefaults.standard.reset()
        let racing = PushCoordinator()
        racing.registered(with: Data([3]))
        try await eventually { await RelayHTTP.shared.count(for: "03") == 1 }
        racing.registered(with: Data([4]))
        try await eventually { await RelayHTTP.shared.count(for: "04") == 1 }
        try await RelayHTTP.shared.succeed("04", receipt: "receipt-04")
        try await eventually { racing.relayToken == "receipt-04" }
        try await RelayHTTP.shared.succeed("03", receipt: "receipt-03")
        try await eventually { cachedRelayDevice() == "03" }
        try await Task.sleep(for: .milliseconds(20))
        check(racing.deviceToken == "04" && racing.relayToken == "receipt-04", "late old registration cannot overwrite current pair")
        let recache = Task { await RelayRegistration.token(for: "04", environment: .sandbox, bundleID: Bundle.main.bundleIdentifier!) }
        try await eventually { await RelayHTTP.shared.count(for: "04") == 2 }
        try await RelayHTTP.shared.succeed("04", receipt: "receipt-04-new")
        check(await recache.value == "receipt-04-new", "different-device cached receipt is rejected")

        try primeRelay(device: "04", receipt: "receipt-04", age: 8 * 24 * 3600)
        racing.registered(with: Data([4]))
        try await eventually { await RelayHTTP.shared.count(for: "04") == 3 }
        await RelayHTTP.shared.fail("04")
        try await Task.sleep(for: .milliseconds(20))
        check(racing.relayToken == "receipt-04", "same-device renewal failure preserves correctly bound receipt")
        try primeRelay(device: "05", receipt: "sandbox-receipt")
        let production = Task { await RelayRegistration.token(for: "05", environment: .production, bundleID: Bundle.main.bundleIdentifier!) }
        try await eventually { await RelayHTTP.shared.count(for: "05") == 1 }
        try await RelayHTTP.shared.succeed("05", receipt: "production-receipt")
        check(await production.value == "production-receipt", "other-environment cached receipt is rejected")

        // A later launch with no address yet (not registered so far, or notifications
        // switched off since) still knows the one hosts were given: removing a thread
        // asks them to stop notifying it about that thread.
        UserDefaults.standard.reset()
        try primeRelay(device: "0a", receipt: "receipt-0a")
        let earlierLaunch = PushCoordinator()
        check(earlierLaunch.lastDeviceToken == nil, "no device token is known before any registration")
        earlierLaunch.registered(with: Data([0x0a]))
        let relaunched = PushCoordinator()
        check(relaunched.deviceToken == nil && relaunched.lastDeviceToken == "0a",
              "the last device token survives a relaunch, for a scoped unwatch before registration")
    }
    #endif
    // TEST_TOPIC: connection
    #if TEST_CONNECTION
    static func connectionTests() async throws {
        let a = host("A1"), b = host("B1")
        let editing = HostSettingsHarness(a)
        let oldTest = Task { await editing.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(a.id) }
        editing.edit(to: b)
        await ConnectionPlan.shared.succeed(a.id, agents: 7)
        await oldTest.value
        check(editing.status == "none", "success for settings edited meanwhile is ignored")
        check(await ConnectionPlan.shared.disconnectCount(a.id) >= 1, "obsolete successful trial backend disconnects")

        let old = host("A2"), current = host("B2")
        let overlapping = HostSettingsHarness(old)
        let first = Task { await overlapping.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(old.id) }
        overlapping.edit(to: current)
        let second = Task { await overlapping.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(current.id) }
        await ConnectionPlan.shared.succeed(current.id, agents: 3)
        await second.value
        check(overlapping.status == "passed(agents: 3)", "current trial publishes its own agent count")
        await ConnectionPlan.shared.fail(old.id)
        await first.value
        check(overlapping.status == "passed(agents: 3)", "late obsolete trial failure cannot overwrite newer success")
        let oldDisconnects = await ConnectionPlan.shared.disconnectCount(old.id)
        let currentDisconnects = await ConnectionPlan.shared.disconnectCount(current.id)
        check(oldDisconnects >= 1 && currentDisconnects >= 1, "both overlapping temporary backends disconnect")

        let oldPending = host("A3"), newPending = host("B3")
        let pending = HostSettingsHarness(oldPending)
        let pendingOld = Task { await pending.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(oldPending.id) }
        pending.edit(to: newPending)
        let pendingNew = Task { await pending.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(newPending.id) }
        await ConnectionPlan.shared.succeed(oldPending.id, agents: 9)
        await pendingOld.value
        check(pending.status == "running", "obsolete success cannot end a newer trial's running state")
        await ConnectionPlan.shared.succeed(newPending.id, agents: 2)
        await pendingNew.value
        check(pending.status == "passed(agents: 2)", "new trial still finishes after obsolete success")

        let failing = host("Failure")
        let failure = HostSettingsHarness(failing)
        let task = Task { await failure.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(failing.id) }
        await ConnectionPlan.shared.fail(failing.id)
        await task.value
        check(failure.status.hasPrefix("failed("), "current trial failure is visible")
        check(await ConnectionPlan.shared.disconnectCount(failing.id) >= 1, "failed trial backend disconnects")

        let stoppedHost = host("Stopped")
        let stopped = HostSettingsHarness(stoppedHost)
        let stopping = Task { await stopped.test() }
        try await eventually { await ConnectionPlan.shared.hasRequest(stoppedHost.id) }
        stopped.stop()
        await stopping.value
        check(stopped.status == "none", "stopping a trial clears the running state without waiting for the host")
        check(await ConnectionPlan.shared.disconnectCount(stoppedHost.id) >= 1, "stopped trial backend disconnects")
        await ConnectionPlan.shared.succeed(stoppedHost.id, agents: 4)
        try await eventually { await ConnectionPlan.shared.disconnectCount(stoppedHost.id) >= 2 }
        check(stopped.status == "none", "a host connecting after stop disconnects without publishing success")
    }
    #endif
    // TEST_TOPIC: credentials
    #if TEST_CREDENTIALS
    static func credentialTests() {
        let store = KeychainCredentialStore()
        let existing = HostID(rawValue: "credential-existing")
        store.setPassword("synthetic-old", for: existing)
        check(store.password(for: existing) == "synthetic-old", "first credential is added")
        let adds = SyntheticKeychain.shared.operationCount("add")
        SyntheticKeychain.shared.failNextWrite()
        store.setPassword("synthetic-new", for: existing)
        check(store.password(for: existing) == "synthetic-old", "failed credential update preserves previous password")
        check(SyntheticKeychain.shared.operationCount("add") == adds, "failed update never falls through to add")
        store.setPassword("synthetic-new", for: existing)
        check(store.password(for: existing) == "synthetic-new", "existing credential updates successfully")
        store.setPassword(nil, for: existing)
        check(store.password(for: existing) == nil, "explicit nil removes credential")
        store.setPassword("synthetic-again", for: existing)
        store.setPassword("", for: existing)
        check(store.password(for: existing) == nil, "explicit empty removes credential")
        let fresh = HostID(rawValue: "credential-fresh")
        SyntheticKeychain.shared.failNextWrite()
        store.setPassword("synthetic-value", for: fresh)
        check(store.password(for: fresh) == nil, "failed first add creates no credential")
        check(SyntheticKeychain.shared.operationCount("update") > 0, "nonempty writes use intercepted SecItemUpdate")
    }
    #endif
    // TEST_TOPIC: hostpush
    #if TEST_HOSTPUSH
    static func hostPushTests() async throws {
        let receiver = PushHost()
        let model = HostPushHarness(host: host("Push"), backend: receiver)
        PushCoordinator.shared.configure(device: "old-device", relay: "old-receipt")
        model.registerForPush()
        try await eventually { await receiver.devices.count == 1 }
        model.registerForPush()
        PushCoordinator.shared.configure(device: "new-device", relay: "new-receipt")
        model.registerForPush()
        await receiver.release()
        await model.finish()
        let sent = await receiver.devices
        check(sent.count == 3, "queued host registrations remain serialized without dropping watches")
        check(sent.first?.token == "old-device" && sent.first?.relayToken == "old-receipt",
              "the registration already in flight keeps its original matching pair")
        check(sent.dropFirst().allSatisfy { $0.token == "new-device" && $0.relayToken == "new-receipt" },
              "every queued host registration uses the current matching device and receipt")
        let watches = await receiver.watches
        check(watches.allSatisfy { $0.map(\.id) == model.threads.map(\.id) },
              "token rotation preserves the queued watched threads")

        let removed = PushHost()
        let clearing = HostPushHarness(host: host("Cleared"), backend: removed)
        PushCoordinator.shared.configure(device: "old-device", relay: "old-receipt")
        clearing.registerForPush()
        try await eventually { await removed.devices.count == 1 }
        clearing.registerForPush()
        PushCoordinator.shared.configure(device: nil, relay: nil)
        await removed.release()
        await clearing.finish()
        check(await removed.devices.count == 1, "a queued registration stops if the device token is no longer known")
    }
    #endif
    static func main() async throws {
        #if TEST_REGISTRATION
        try await registrationTests()
        #endif
        #if TEST_CONNECTION
        try await connectionTests()
        #endif
        #if TEST_CREDENTIALS
        credentialTests()
        #endif
        #if TEST_HOSTPUSH
        try await hostPushTests()
        #endif
        print("Native setup regression failures: \(failures). No real Keychain, network, preferences, app or permissions.")
        exit(failures == 0 ? 0 : 1)
    }
}
