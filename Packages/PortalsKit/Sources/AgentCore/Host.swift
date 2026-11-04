import Foundation

/// What answers at a host's address, as far as the app has seen. Both speak the same
/// gateway protocol.
public enum HostKind: String, Codable, Hashable, Sendable {
    /// `portals-bridge`, which runs coding agents on a Mac or a Linux computer. It says so
    /// when the app connects (`gateway.ready` carries a `bridge` block).
    case bridge
}

/// The Mac a host runs on, as the host describes it: enough for an app on a Mac to tell
/// that the host is on that same Mac, and that a folder chosen in the Mac's own folder
/// dialog is therefore one of the host's.
public struct HostMachine: Hashable, Sendable {
    /// The Mac's host name, as `gethostname` gives it there.
    public var hostname: String
    /// The home folder of the user the host runs as.
    public var home: String
    /// The id the host's bridge gave itself once and keeps, by which the order of the
    /// user's Macs names this one (`MachineOrder`); nil from a host that gives none.
    public var id: String?
    /// The system it runs on, `"macos"` or `"linux"` (docs/linux-plan.md); nil from a
    /// bridge from before Linux, which is a Mac's.
    public var os: String?

    public init(hostname: String, home: String, id: String? = nil, os: String? = nil) {
        self.hostname = hostname
        self.home = home
        self.id = id
        self.os = os
    }
}

/// How to reach one host, as the user set it up.
public struct HostConfig: Identifiable, Codable, Hashable, Sendable {
    public var id: HostID
    /// What to call it in the app.
    public var name: String
    /// Where its backend answers, for example `https://mini.example.ts.net:8443`.
    public var url: URL
    /// The sign-in name. nil for a host that needs no sign-in: a backend on the same
    /// machine as the app, which only the simulator can be.
    public var username: String?
    /// What the host turned out to be the last time the app connected. nil is
    /// `hermes serve`, or a host not reached yet.
    public var kind: HostKind?
    /// The path of the host's General folder, where its coding agents work when no other
    /// folder is chosen, as the host last said (`FolderProviding`). nil for a host that
    /// offers no folders, or has not been asked yet.
    public var generalFolder: String?
    /// The id the host's bridge gave itself, as it last said (`HostMachine.id`): the
    /// name the order of the user's Macs knows this one by, on every device, whatever
    /// each device calls it. nil for a host that gives none, or was not reached since.
    public var machineID: String?
    /// The system the host runs on, as it last said (`HostMachine.os`): `"linux"` for a
    /// Linux computer; nil for a Mac, or a host not reached since.
    public var machineOS: String?
    /// Whether the host lists a thread an agent started from another under that thread,
    /// and not in the sidebar (`AgentThreadNesting`), as it last said: so the sidebar lists
    /// the same threads before the host is reached again. nil is false.
    public var nestsAgentThreads: Bool?
    /// The Mac's id in the device's net (`NetMember.id`) when the host is that Mac of the
    /// net: signed in with the device's token, its address from the net's list. nil for a
    /// host added by hand.
    public var netMember: String?
    /// The name the net's list gave the Mac when it was last taken: while the host is
    /// still called that, a new name in the list is taken too; one the user gave it stays.
    public var netName: String?
    /// When that name was set from the app (`NetMember.named`), as last taken; nil for one
    /// never set so. A list with another stamp is a rename made since, here or on another
    /// device, which the host takes over a name the user gave it on this device.
    public var netNamed: Int?
    /// The Mac that set it (`NetMember.namedBy`): a rename at the same stamp by another Mac
    /// is another rename too.
    public var netNamedBy: String?

    public init(
        id: HostID = HostID(rawValue: UUID().uuidString), name: String, url: URL, username: String? = nil, kind: HostKind? = nil,
        generalFolder: String? = nil, machineID: String? = nil, nestsAgentThreads: Bool = false
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.username = username
        self.kind = kind
        self.generalFolder = generalFolder
        self.machineID = machineID
        self.nestsAgentThreads = nestsAgentThreads ? true : nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, url, username, kind, generalFolder, machineID, machineOS, nestsAgentThreads, netMember, netName, netNamed, netNamedBy
    }

    /// Reads hosts saved by any version of the app. A kind this version does not know
    /// reads as none: the list is decoded as a whole, so one bad field would lose every
    /// host.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(HostID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        url = try container.decode(URL.self, forKey: .url)
        username = try container.decodeIfPresent(String.self, forKey: .username)
        kind = (try? container.decodeIfPresent(HostKind.self, forKey: .kind)) ?? nil
        generalFolder = (try? container.decodeIfPresent(String.self, forKey: .generalFolder)) ?? nil
        machineID = (try? container.decodeIfPresent(String.self, forKey: .machineID)) ?? nil
        machineOS = (try? container.decodeIfPresent(String.self, forKey: .machineOS)) ?? nil
        nestsAgentThreads = (try? container.decodeIfPresent(Bool.self, forKey: .nestsAgentThreads)) ?? nil
        netMember = (try? container.decodeIfPresent(String.self, forKey: .netMember)) ?? nil
        netName = (try? container.decodeIfPresent(String.self, forKey: .netName)) ?? nil
        netNamed = (try? container.decodeIfPresent(Int.self, forKey: .netNamed)) ?? nil
        netNamedBy = (try? container.decodeIfPresent(String.self, forKey: .netNamedBy)) ?? nil
    }

    public var needsSignIn: Bool { username?.isEmpty == false }

    /// A host address as typed: surrounding space dropped, `https://` assumed when no
    /// scheme is given, and a trailing slash removed. nil when it is not an address.
    public static func url(fromTyped text: String) -> URL? {
        var address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !address.isEmpty else { return nil }
        if !address.contains("://") { address = "https://" + address }
        while address.hasSuffix("/") { address.removeLast() }
        guard let components = URLComponents(string: address),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        return components.url
    }
}

extension URL {
    /// Whether this address reaches only the computer using it: 127.x.x.x, localhost or ::1.
    /// A host at one was set up for Portals on its own Mac alone (the host's
    /// `isLoopbackAddress`, docs/net-plan.md); anything else reaches it through Tailscale.
    public var isLoopback: Bool {
        guard let name = host()?.lowercased() else { return false }
        if name == "localhost" || name == "::1" || name == "[::1]" { return true }
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "127" && parts.allSatisfy { UInt8($0) != nil }
    }
}

/// Where sign-in passwords are kept: the Keychain in the app, memory in tests.
public protocol CredentialStore: Sendable {
    func password(for host: HostID) -> String?
    /// Stores the password; nil or empty removes it.
    func setPassword(_ password: String?, for host: HostID)
    /// The token this device signs in to the Macs of its net with (`NetMembership`); nil
    /// in no net.
    func netToken() -> String?
    /// Stores the token; nil or empty removes it.
    func setNetToken(_ token: String?)
    /// The token of a net the device switched away from, kept until a Mac of it takes the
    /// device out (`NetLeftBehind`); nil once let go of.
    func leftNetToken(for net: String) -> String?
    /// Stores it; nil or empty removes it.
    func setLeftNetToken(_ token: String?, for net: String)
}

/// A `CredentialStore` that forgets everything when the process ends.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var passwords: [HostID: String]
    private var token: String?
    private var leftTokens: [String: String] = [:]

    public init(_ passwords: [HostID: String] = [:], netToken: String? = nil) {
        self.passwords = passwords
        token = netToken
    }

    public func password(for host: HostID) -> String? {
        lock.withLock { passwords[host] }
    }

    public func setPassword(_ password: String?, for host: HostID) {
        lock.withLock { passwords[host] = password?.isEmpty == false ? password : nil }
    }

    public func netToken() -> String? {
        lock.withLock { token }
    }

    public func setNetToken(_ token: String?) {
        lock.withLock { self.token = token?.isEmpty == false ? token : nil }
    }

    public func leftNetToken(for net: String) -> String? {
        lock.withLock { leftTokens[net] }
    }

    public func setLeftNetToken(_ token: String?, for net: String) {
        lock.withLock { leftTokens[net] = token?.isEmpty == false ? token : nil }
    }
}

extension HostConfig {
    /// Whether the host runs on Linux, as it last said.
    public var isLinux: Bool { machineOS == "linux" }

    /// What to call the computer the host runs on: "Mac", or "Linux computer" (2026-10-28: "Linux computer is ok for now").
    public var machineWord: String { isLinux ? "Linux computer" : "Mac" }
}
