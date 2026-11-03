import AgentCore
import Foundation
import HermesBackend

/// Which hosts the app talks to, and how it signs in to each.
enum HostDirectory {
    /// The id of the Hermes backend on the Mac the simulator runs on.
    nonisolated static let localID = HostID(rawValue: "local")

    /// The hosts to use at launch, where their passwords are kept, and where threads
    /// are saved.
    struct Starting {
        var hosts: [HostConfig]
        var credentials: any CredentialStore
        /// Changes to the list are saved: not for hosts the launch environment names.
        var savesHosts: Bool
        var store: ThreadStore
        /// The demo's (`Demo`): its hosts play the demo's script, and nothing of it is kept.
        var isDemo = false
    }

    /// The hosts the launch environment names (development), else the ones saved, else,
    /// in the simulator, the Hermes backend on this Mac. None on a device with no host
    /// set up.
    static func starting() -> Starting {
        if DebugLaunch.fakeScript != nil {
            // The scripted backend has its own folder, so trying it never touches real threads.
            let host = HostConfig(id: HostID(rawValue: "fake"), name: "Scripted", url: DebugLaunch.hermesURL)
            let scratch = ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("Portals-fake", isDirectory: true))
            return Starting(hosts: [host], credentials: InMemoryCredentialStore(), savesHosts: false, store: scratch)
        }
        if DebugLaunch.startsFirstRun {
            // A new phone: nothing added, and nothing added kept past this launch.
            let scratch = ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("Portals-first-run-\(UUID().uuidString)", isDirectory: true))
            return Starting(hosts: [], credentials: InMemoryCredentialStore(), savesHosts: false, store: scratch)
        }
        if let named = DebugLaunch.hosts {
            let passwords = Dictionary(named.compactMap { entry in entry.password.map { (entry.host.id, $0) } }) { first, _ in first }
            return Starting(hosts: named.map(\.host), credentials: InMemoryCredentialStore(passwords), savesHosts: false, store: .standard)
        }
        if DebugLaunch.overridesHost {
            let host = HostConfig(id: localID, name: "This Mac", url: DebugLaunch.hermesURL, username: DebugLaunch.hermesUser)
            let passwords = DebugLaunch.hermesPassword.map { [localID: $0] } ?? [:]
            return Starting(hosts: [host], credentials: InMemoryCredentialStore(passwords), savesHosts: false, store: .standard)
        }
        let saved = ThreadStore.standard.loadHosts()
        if !saved.isEmpty {
            return Starting(hosts: saved, credentials: KeychainCredentialStore(), savesHosts: true, store: .standard)
        }
        // A Release build for the simulator has no launch switch to start with no host, as
        // a new phone does: `-DPORTALS_WELCOME_BENCH` builds one that does, for measuring the
        // welcome at rest (WelcomeRestUITests) without reaching the Mac's own backend.
        #if targetEnvironment(simulator) && !PORTALS_WELCOME_BENCH
        let local = HostConfig(id: localID, name: "This Mac", url: DebugLaunch.hermesURL)
        return Starting(hosts: [local], credentials: KeychainCredentialStore(), savesHosts: true, store: .standard)
        #else
        return Starting(hosts: [], credentials: KeychainCredentialStore(), savesHosts: true, store: .standard)
        #endif
    }

    /// How to prove who we are to `host`. A Mac of the device's net is signed in to with
    /// the net's token; a host with a user name with its password; one without either is a
    /// backend on this Mac, which needs none.
    nonisolated static func authenticator(for host: HostConfig, credentials: any CredentialStore) -> any HermesAuthenticator {
        if host.isNetHost {
            return TokenAuthenticator(baseURL: host.url) { credentials.netToken() }
        }
        let id = host.id
        return authenticator(for: host) { credentials.password(for: id) }
    }

    /// As above, for a host signed in to with `password`, or with none.
    nonisolated static func authenticator(for host: HostConfig, password: @escaping @Sendable () -> String?) -> any HermesAuthenticator {
        guard let username = host.username, !username.isEmpty else {
            return LoopbackTokenAuthenticator(baseURL: host.url)
        }
        return PasswordAuthenticator(baseURL: host.url) {
            password().map { PasswordAuthenticator.Credentials(username: username, password: $0) }
        }
    }
}
