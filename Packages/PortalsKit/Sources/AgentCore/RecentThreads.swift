import Foundation

/// The conversations used on this device that no host keeps for it, independent of its open
/// tabs: those of a host that does not offer `recent_threads`, of a thread kept here only,
/// and of a thread this device has not heard of yet. A host that does offer it keeps them
/// itself, for every device (`ThreadRecord.recent`), and what this device held of its
/// threads goes up once (`HostSync`). Read, idle entries keep, of each host, the twenty-five
/// that last ran (`readLimit`), those here and those on the host together; unread results
/// stay until acknowledged. An archived thread is not among them unless unread (2026-11-02). How many of them show, from every host at once, is another matter, each
/// device's own (`RecentChoice`). Stored by the app only, never sent to a host as it is.
public struct RecentThreads: Codable, Hashable, Sendable {
    /// How many read, idle entries are kept of each host, whatever each device shows of
    /// them: the most any device can ask for (`RecentChoice.counts`). Of each host, as devices
    /// need not have the same hosts: the most any device can show are among these, whichever
    /// hosts it has, so what one device lets go of is nothing another can show.
    public static let readLimit = 25
    public private(set) var keys: Set<ThreadKey>

    /// Old installations seed this once from their local open tabs.
    public init(keys: Set<ThreadKey> = []) {
        self.keys = keys
    }

    public static func restored(from data: Data?, legacyTabs: OpenTabs) -> RecentThreads {
        if let data, let saved = try? JSONDecoder().decode(Self.self, from: data) { return saved }
        return RecentThreads(keys: Set(legacyTabs.keys))
    }

    public mutating func open(_ key: ThreadKey) {
        keys.insert(key)
    }

    public mutating func dismiss(_ key: ThreadKey) {
        keys.remove(key)
    }

    public mutating func remove(where gone: (ThreadKey) -> Bool) {
        keys = keys.filter { !gone($0) }
    }

    /// Prunes only known, read, idle entries. Unknown keys survive a partial/offline
    /// list; explicit thread or host removal clears them. Active conversations and
    /// unread results do not consume the read-entry allowance. A host's marks count in its
    /// allowance and are not touched here: taking one off is for every device (`pastKept`).
    func reconciled(newestFirst threads: [ThreadRecord], active: Set<ThreadKey>, tucked: Set<ThreadKey>) -> RecentThreads {
        var kept = self
        kept.keys.subtract(tucked)
        var read: [HostID: Int] = [:]
        for record in threads where keys.contains(record.key) || record.isRecent {
            let key = record.key
            guard !record.isUnseen, !record.isArchived, !active.contains(key), !tucked.contains(key) else { continue }
            read[key.host, default: 0] += 1
            if read[key.host, default: 0] > Self.readLimit { kept.keys.remove(key) }
        }
        return kept
    }

    /// The marks to take off a host, of `marked` (`SidebarGroups.marked`, the read, idle
    /// ones, the one that last ran first): those of the host past `readLimit`, whichever
    /// number each device shows and whichever other hosts it has.
    public static func pastKept(_ marked: [ThreadKey], of host: HostID) -> [ThreadKey] {
        Array(marked.lazy.filter { $0.host == host }.dropFirst(readLimit))
    }
}

/// How much of Recent this device shows in its sidebar (Settings, Appearance). Kept on the
/// device, never sent to a host, and it limits only what shows here: what every device
/// keeps is `RecentThreads.readLimit`. Off, or at any number, Finished stays as it is.
public struct RecentChoice: Hashable, Sendable {
    /// What can be chosen, the last no more than is kept.
    public static let counts = [5, 10, 15, 25]
    public static let defaultCount = 15
    public static let showsKey = "sidebar.showsRecent"
    public static let countKey = "sidebar.recentCount"

    public var shows: Bool
    /// How many read threads show. Always one of `counts`.
    public var count: Int {
        didSet { if !Self.counts.contains(count) { count = Self.defaultCount } }
    }

    public init(shows: Bool = true, count: Int = RecentChoice.defaultCount) {
        self.shows = shows
        self.count = Self.counts.contains(count) ? count : Self.defaultCount
    }

    /// As last chosen on this device: shown, fifteen, until it is.
    public init(from defaults: UserDefaults) {
        self.init(shows: defaults.object(forKey: Self.showsKey) as? Bool ?? true, count: defaults.integer(forKey: Self.countKey))
    }

    public func save(to defaults: UserDefaults) {
        defaults.set(shows, forKey: Self.showsKey)
        defaults.set(count, forKey: Self.countKey)
    }

    /// How many read threads Recent lists.
    var readShown: Int { shows ? count : 0 }
}
