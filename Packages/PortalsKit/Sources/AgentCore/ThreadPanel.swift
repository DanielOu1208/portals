import Foundation

// What the panel beside a chat asks the host for (2026-10-31): how much of the
// plan the thread's agent has used, what the thread's repository holds uncommitted, and
// the apps on the host its folder opens in. A Portals bridge's `usage_read`, `git_status`
// and `open_on_host`.

/// How much of the user's plan an agent has used, as the agent tells it (`/usage`).
public struct UsageLimits: Hashable, Codable, Sendable {
    /// One window the plan is counted in: "5-hour", "weekly", "weekly Opus".
    public struct Window: Hashable, Codable, Sendable, Identifiable {
        public var name: String
        /// How much of it is used, 0 to 100; nil when the agent does not say.
        public var percent: Double?
        /// When it starts again; nil when not known.
        public var resetsAt: Date?
        /// Used up: the agent turns work away until it resets.
        public var reached: Bool
        /// How long the window is, where the agent says.
        public var length: TimeInterval?
        /// When the agent said this, for a window kept from an earlier answer because the
        /// last one did not mention it; nil for one the last answer said.
        public var heardAt: Date?

        public var id: String { name }

        public init(name: String, percent: Double?, resetsAt: Date?, reached: Bool = false, length: TimeInterval? = nil, heardAt: Date? = nil) {
            self.name = name
            self.percent = percent
            self.resetsAt = resetsAt
            self.reached = reached
            self.length = length
            self.heardAt = heardAt
        }

        /// None of it is left: the agent says so, or all of it is used.
        public var isUsedUp: Bool {
            reached || (percent ?? 0) >= 100
        }

        /// How much of it is left, 0 to 100; nil when the agent does not say how much is used.
        public var left: Double? {
            isUsedUp ? 0 : percent.map { min(max(100 - $0, 0), 100) }
        }

        /// Its name in a letter or two, for a ring too small to hold more, where that says what
        /// it means: "5h" for "5-hour", "W" for "weekly". nil for one it would not ("O" for
        /// "weekly Opus", "I" for "included"), which goes by its full name where there is room.
        public var shortName: String? {
            let parts = name.lowercased().split(separator: "-")
            if parts.count == 2, Int(parts[0]) != nil, let unit = parts[1].first, ["hour", "day"].contains(parts[1]) { return "\(parts[0])\(unit)" }
            switch name.lowercased() {
            case "daily": return "D"
            case "weekly": return "W"
            case "monthly": return "Mo"
            default: return nil
            }
        }

        /// The time it counts has ended, so nothing said of it holds any more, used up or not.
        public func hasReset(at now: Date = .now) -> Bool {
            resetsAt.map { $0 <= now } ?? false
        }

        /// How it is being used against the time gone in it, as CodexBar paces it; nil
        /// without the window's length or reset, used up, or too early in it to say. For
        /// numbers from a while ago, `now` is when they were heard: an old percent against
        /// the time since looks like far more in reserve than it is.
        public func pace(at now: Date = .now) -> UsagePace? {
            guard let length, length > 0, let resetsAt, let used = percent, !isUsedUp else { return nil }
            let remaining = resetsAt.timeIntervalSince(now)
            guard remaining > 0, remaining <= length else { return nil }
            let elapsed = length - remaining
            guard elapsed >= length * UsagePace.earliest else { return nil }
            let expectedUsed = elapsed / length * 100
            var runsOut: Date?
            if used > 0 {
                // At the rate so far, it is empty this long from now.
                let toEmpty = max(100 - used, 0) / (used / elapsed)
                if toEmpty < remaining { runsOut = now.addingTimeInterval(toEmpty) }
            }
            return UsagePace(reserve: expectedUsed - used, runsOutAt: runsOut, expectedLeft: 100 - expectedUsed)
        }
    }

    /// The plan as people name it ("Claude Max", "Codex Pro 100"), as the host says it.
    public var title: String?
    public var windows: [Window]
    /// For limits as last heard, not asked for now: when they were.
    public var heardAt: Date?
    /// What else the agent says: why there are none (an API key has none), credits left.
    public var note: String?

    /// A limit that turns work away, even when the host has no window to draw.
    /// The host's note is plain text; keep only its blocking lines without windows.
    public var blockingNote: String? {
        let lines = (note ?? "").split(separator: "\n").filter {
            $0 == "The workspace's credits are used up." ||
                $0.hasPrefix("The ") && $0.hasSuffix(" usage limit is reached.")
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    public init(title: String? = nil, windows: [Window], heardAt: Date? = nil, note: String? = nil) {
        self.title = title
        self.windows = windows
        self.heardAt = heardAt
        self.note = note
    }
}

/// How a usage window is being used against the time gone in it.
public struct UsagePace: Hashable, Sendable {
    /// Points of the window under an even pace by now: in reserve when positive, over pace
    /// when negative.
    public var reserve: Double
    /// When it runs out at the rate so far; nil when it lasts until it resets.
    public var runsOutAt: Date?
    /// How much an even pace would have left by now, 0 to 100: where the bar's mark goes.
    public var expectedLeft: Double

    /// The share of a window that must have gone before its pace says anything.
    static let earliest = 0.02

    public init(reserve: Double, runsOutAt: Date?, expectedLeft: Double) {
        self.reserve = reserve
        self.runsOutAt = runsOutAt
        self.expectedLeft = expectedLeft
    }
}

/// One file that differs from HEAD in a thread's repository.
public struct GitFileChange: Hashable, Sendable {
    /// From the repository's top.
    public var path: String
    /// Lines added and removed; nil for a binary file, or one too large to count.
    public var added: Int?
    public var removed: Int?

    public init(path: String, added: Int?, removed: Int?) {
        self.path = path
        self.added = added
        self.removed = removed
    }
}

/// What a thread's repository holds that is not committed.
public struct GitStatus: Hashable, Sendable {
    /// The branch checked out; nil on a detached HEAD.
    public var branch: String?
    /// The commit checked out, shortened; nil before the first commit.
    public var commit: String?
    /// The branch it follows (`origin/main`).
    public var upstream: String?
    public var ahead: Int
    public var behind: Int
    /// The first of them, as many as the host lists.
    public var files: [GitFileChange]
    /// How many files differ in all: more than `files` holds when the host cut the list.
    public var total: Int
    public var added: Int
    public var removed: Int

    public init(branch: String?, commit: String?, upstream: String? = nil, ahead: Int = 0, behind: Int = 0,
                files: [GitFileChange], total: Int? = nil, added: Int? = nil, removed: Int? = nil) {
        self.branch = branch
        self.commit = commit
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
        self.files = files
        self.total = total ?? files.count
        self.added = added ?? files.reduce(0) { $0 + ($1.added ?? 0) }
        self.removed = removed ?? files.reduce(0) { $0 + ($1.removed ?? 0) }
    }

    /// The host listed fewer files than differ.
    public var isListCut: Bool { total > files.count }

    /// There is a count to show: none where its only files are ones git gave none for.
    public var hasCounts: Bool {
        added > 0 || removed > 0 || !isListCut && !files.contains { $0.added == nil || $0.removed == nil }
    }
}

/// What the host says of a thread's repository.
public enum GitState: Hashable, Sendable {
    /// The thread's folder is in no repository.
    case noRepository
    /// No git on the host to run (a Mac without the developer tools): the branch alone.
    case branchOnly(branch: String?, commit: String?)
    case status(GitStatus)
}

/// An app on the host a thread's folder opens in.
public struct HostApp: Hashable, Codable, Sendable, Identifiable {
    public enum Kind: String, Hashable, Codable, Sendable {
        case files, editor, terminal
    }

    public var id: String
    public var name: String
    public var kind: Kind
    /// Its icon as the host drew it, a PNG; nil where it could not.
    public var icon: Data?

    public init(id: String, name: String, kind: Kind, icon: Data? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.icon = icon
    }
}

public enum ThreadPanelError: LocalizedError, Hashable, Sendable {
    /// The host does not do this (Hermes, an older bridge).
    case unavailable
    /// The host would not, and says why.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host cannot do this. Update Portals on it."
        case let .refused(message): message
        }
    }
}

/// A host that tells the panel beside a chat about a thread.
public protocol ThreadPanelProviding: Sendable {
    /// Whether the host says how much of a plan an agent has used; nil before the first connection.
    var readsUsage: Bool? { get async }
    /// Whether the host says what a thread's repository holds uncommitted.
    var readsGitStatus: Bool? { get async }
    /// Whether the host opens a thread's folder in its own apps.
    var opensFolders: Bool? { get async }

    /// The plan's limits as the thread's agent tells them; nil for an agent that cannot say.
    func usage(of thread: ThreadRef.ID) async throws -> UsageLimits?
    func gitStatus(of thread: ThreadRef.ID) async throws -> GitState
    /// Everything not committed, against HEAD, as one diff, its files' paths from the
    /// repository's top (`root`).
    func gitDiff(of thread: ThreadRef.ID) async throws -> (root: String, diff: TurnDiff, total: Int)
    func hostApps() async throws -> [HostApp]
    func openFolder(of thread: ThreadRef.ID, in app: HostApp.ID) async throws
}
