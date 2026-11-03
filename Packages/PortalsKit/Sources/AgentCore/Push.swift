import Foundation

/// Where a host can reach this device with a notification.
public struct PushDevice: Hashable, Sendable {
    public enum Environment: String, Hashable, Sendable {
        /// Builds installed from Xcode.
        case sandbox
        /// TestFlight and App Store builds.
        case production
    }

    /// The address Apple gave this installation, as hex.
    public var token: String
    public var environment: Environment
    /// The app the token belongs to.
    public var bundleID: String
    /// What the Portals relay calls this device (docs/pairing-and-relay.md): a bridge
    /// without an APNs key of its own sends through the relay with it. nil until the
    /// relay has answered, or when the build names no relay.
    public var relayToken: String?
    /// The key this host seals its notifications to (`SealedNotification`): one per host,
    /// kept where the notification extension can read it. nil sends none.
    public var key: Data?
    /// The kinds of notification the device wants none of (Settings, Notifications).
    public var muted: Set<NotificationKind>

    public init(
        token: String, environment: Environment, bundleID: String, relayToken: String? = nil, key: Data? = nil,
        muted: Set<NotificationKind> = []
    ) {
        self.token = token
        self.environment = environment
        self.bundleID = bundleID
        self.relayToken = relayToken
        self.key = key
        self.muted = muted
    }
}

/// What a notification is about, as a host names it (`aeriportal.kind`).
public enum NotificationKind: String, CaseIterable, Comparable, Hashable, Sendable {
    /// An agent asks to run something.
    case approval
    /// An agent asks a question.
    case question
    /// A turn ended.
    case finished
    /// A turn failed.
    case failed

    /// An agent needs an answer: the two kinds Settings' "When an agent needs you" covers.
    public static let needsYou: Set<NotificationKind> = [.approval, .question]
    /// A turn came to an end: "When an agent is done".
    public static let done: Set<NotificationKind> = [.finished, .failed]

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// A thread the app wants to hear about, with the words a notification about it uses.
public struct WatchedThread: Hashable, Sendable {
    public var id: ThreadRef.ID
    /// The agent's name on the host, and what to call it.
    public var agent: String
    public var agentName: String
    public var title: String?

    public init(id: ThreadRef.ID, agent: String, agentName: String, title: String? = nil) {
        self.id = id
        self.agent = agent
        self.agentName = agentName
        self.title = title
    }
}

/// A backend whose host can send this device notifications: when a watched thread
/// needs an answer, or its run ends, and the app is not there to see it.
public protocol PushRegistering: Sendable {
    /// Tells the host where to send, and which threads to send about. The list replaces
    /// nothing: threads are added or updated, and stay watched until `unwatch`.
    func register(_ device: PushDevice, watching threads: [WatchedThread]) async throws
    /// Removes only this device's watch, never another device's subscription.
    func unwatch(_ thread: ThreadRef.ID, deviceToken: String) async throws
}

/// Which thread a notification is about: what its payload names under `aeriportal`.
/// A host that was told its id when the app registered names itself too
/// (`aeriportal.host`); one that was not, such as the `aeriportal-push` Hermes plugin,
/// names only the thread.
public struct PushRoute: Hashable, Sendable {
    public var host: HostID?
    public var thread: ThreadRef.ID

    public init(host: HostID? = nil, thread: ThreadRef.ID) {
        self.host = host
        self.thread = thread
    }

    /// The route a notification's payload names; nil when it names no thread.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let details = userInfo["aeriportal"] as? [String: Any],
              let id = details["thread"] as? String, !id.isEmpty else { return nil }
        thread = ThreadRef.ID(rawValue: id)
        host = (details["host"] as? String).flatMap { $0.isEmpty ? nil : HostID(rawValue: $0) }
    }

    /// The thread this is about among every host's. With a host, only that host's thread
    /// will do. Without one the id is looked for on every host, and when more than one
    /// has it, the most recently active is taken.
    public func resolve(in threads: [ThreadRecord]) -> ThreadRecord? {
        let named = threads.filter { $0.id == thread && (host == nil || $0.ref.agent.host == host) }
        return named.max { $0.updatedAt < $1.updatedAt }
    }

    /// Whether this and `other` may be the same thread. Hosts are compared only when
    /// both name one.
    public func matches(_ other: PushRoute) -> Bool {
        guard thread == other.thread else { return false }
        guard let host, let otherHost = other.host else { return true }
        return host == otherHost
    }
}

/// Each agent's avatar as a picture, which the app leaves in the container it shares
/// with its notification extension. The extension puts it on the agent's notifications,
/// as a contact's photo is put on a message.
public struct NotificationAvatars: Sendable {
    public var directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// The folder in the app group this build names under `PortalsAppGroup` in its
    /// Info.plist. nil when the build has none, or is not signed for it.
    public static var shared: NotificationAvatars? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PortalsAppGroup") as? String, !group.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return NotificationAvatars(directory: container.appendingPathComponent("NotificationAvatars"))
    }

    /// The picture of an agent, by what a notification names: its name on the host
    /// (`aeriportal.agent`), and the host when the notification says (`aeriportal.host`).
    public func url(forAgent name: String, on host: HostID? = nil) -> URL {
        directory.appendingPathComponent(Self.fileName(forAgent: name, on: host))
    }

    /// `<host>--<agent>.png`, or `<agent>.png` without a host. The host's part never
    /// holds `--` (its dashes are encoded), so agents of different hosts never share one.
    public static func fileName(forAgent name: String, on host: HostID? = nil) -> String {
        let agent = safeFileName(name, otherwise: "agent")
        guard let host else { return "\(agent).png" }
        let hostPart = safeFileName(host.rawValue, otherwise: "host").replacingOccurrences(of: "-", with: "%2D")
        return "\(hostPart)--\(agent).png"
    }

    /// The pictures to keep for these agents, by file name: each agent under its host,
    /// and under its bare name too when no agent of another host has that name, for a
    /// host that does not say which it is.
    public static func files(for agents: [Agent.ID]) -> [String: Agent.ID] {
        var files: [String: Agent.ID] = [:]
        let hostsByName = Dictionary(grouping: agents, by: \.name).mapValues { Set($0.map(\.host)) }
        for agent in agents {
            files[fileName(forAgent: agent.name, on: agent.host)] = agent
            if hostsByName[agent.name]?.count == 1 {
                files[fileName(forAgent: agent.name)] = agent
            }
        }
        return files
    }
}

/// `text` as a file name: anything outside letters, digits, `-` and `_` is
/// percent-encoded, so it can never name a path.
func safeFileName(_ text: String, otherwise fallback: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    let name = text.addingPercentEncoding(withAllowedCharacters: allowed) ?? fallback
    return name.isEmpty ? fallback : name
}
