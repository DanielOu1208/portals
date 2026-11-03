import Foundation

/// A folder on a host where a coding agent can work, as the host offers it for new
/// threads.
public struct Folder: Identifiable, Codable, Hashable, Sendable {
    /// The folder's full path on the host.
    public var path: String
    /// What to call it: its last path component, or "No project" for the host's General
    /// folder.
    public var name: String
    /// When an agent last worked there, or it was added, when the host knows.
    public var lastUsed: Date?
    /// Whether the user added it on the host (`FolderProviding.addFolder`): the host
    /// lists it until it is taken off, and the sidebar shows it as a project before any
    /// thread has run in it.
    public var isAdded: Bool
    /// Whether this is the host's General folder, independent of its display name.
    public var isGeneral: Bool
    /// As the host answered a folder the user chose (`FolderProviding.addFolder`): the
    /// folder chosen, when it is in a git worktree and this one, its repository's, was
    /// added in its place. nil otherwise.
    public var worktree: String?

    public init(
        path: String, name: String? = nil, lastUsed: Date? = nil, isAdded: Bool = false, isGeneral: Bool = false, worktree: String? = nil
    ) {
        self.path = path
        let given = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.name = given.isEmpty ? Self.lastComponent(of: path) : given
        self.lastUsed = lastUsed
        self.isAdded = isAdded
        self.isGeneral = isGeneral
        self.worktree = worktree
    }

    public var id: String { path }

    /// What the General folder is drawn with: work that belongs to no folder of its own.
    public static let generalSymbol = "tray"

    /// What the General folder is called, the one a thread starts in when none is chosen:
    /// it is where work goes that belongs to no folder of its own.
    public static let generalName = "No project"

    /// What to call the folder at `path`: "No project" when it is the host's General folder,
    /// its last path component otherwise.
    public static func name(of path: String, general: String?) -> String {
        if let general, path == general { return generalName }
        return lastComponent(of: path)
    }

    /// The path for reading, with a home folder under `/Users` (a Mac's) or `/home` (a
    /// Linux computer's) written as `~`: `~/coding_projects`.
    public static func tidyPath(_ path: String) -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].isEmpty, parts[1] == "Users" || parts[1] == "home", !parts[2].isEmpty else { return path }
        return (["~"] + parts.dropFirst(3).map(String.init)).joined(separator: "/")
    }

    static func lastComponent(of path: String) -> String {
        let trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        return trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    }
}

/// The folders a host offers for new threads: its General folder, then the ones its
/// agents worked in lately, most recent first.
public struct FolderList: Hashable, Sendable {
    public var general: Folder
    public var recent: [Folder]

    public init(general: Folder, recent: [Folder]) {
        self.general = general
        self.general.isGeneral = true
        self.recent = recent
    }

    /// Every folder, General first.
    public var all: [Folder] { [general] + recent }

    /// The folder with this name, General included, ignoring case: for picking one by
    /// name from a script.
    public func folder(named name: String) -> Folder? {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return all.first { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }
            ?? all.first { $0.path == wanted }
    }
}

/// A backend whose agents work in folders on their host, and which offers the folders
/// a new thread can start in. Hosts that do not (Hermes) say so, and their threads start
/// wherever the agent is set up to work.
public protocol FolderProviding: Sendable {
    /// Whether the host offers folders, as of the last connection; nil before the first.
    var offersFolders: Bool? { get async }
    /// The folders a new thread with `agent` can start in. Throws
    /// `FolderError.unavailable` for a host that offers none.
    func folders(for agent: Agent.ID) async throws -> FolderList
    /// Whether the host takes a folder the user chose on it (`addFolder`), as of the
    /// last connection; nil before the first.
    var addsFolders: Bool? { get async }
    /// The Mac the host runs on, when it says; nil before the first connection too.
    var machine: HostMachine? { get async }
    /// Puts the folder at `path` on the host on its list, so that a new thread can start
    /// there, and gives it as the host lists it (its real path). Throws
    /// `FolderError.refused` with the host's reason for a folder it does not take, and
    /// `FolderError.unavailable` for a host that takes none.
    func addFolder(at path: String) async throws -> Folder
    /// Takes a folder that was added off the host's list again. Throws
    /// `FolderError.unavailable` for a host that takes none.
    func removeFolder(at path: String) async throws
    /// Whether the host searches the folders under its home folder (`searchFolders`), as
    /// of the last connection; nil before the first.
    var searchesFolders: Bool? { get async }
    /// The best `limit` folders under the host's home folder for `query`: fuzzy, or a path
    /// typed as in a terminal (`~/cod/por`), completed a level at a time. Only folders the
    /// host would add (`addFolder`). Throws `FolderError.unavailable` for a host that does
    /// not search them, `FolderError.refused` with its sentence otherwise.
    func searchFolders(_ query: String, limit: Int) async throws -> FolderSearchResults
}

extension FolderProviding {
    public var searchesFolders: Bool? { get async { false } }

    public func searchFolders(_ query: String, limit: Int) async throws -> FolderSearchResults {
        throw FolderError.unavailable
    }
}

/// One folder a host found for what the person typed in the folder picker (a Portals
/// bridge's `folders.search`, feature `folder_search`). Picking one adds it on the host
/// (`FolderProviding.addFolder`), as a folder chosen in the Mac's folder dialog is.
public struct FolderSearchHit: Hashable, Sendable, Identifiable {
    /// Its real path on the host: what `addFolder` takes.
    public var path: String
    /// Its last part.
    public var name: String
    /// Its path under the host's home folder, with `/` between its parts.
    public var relative: String
    /// The parts of `relative` the query matched, as UTF-16 offsets, in order.
    public var ranges: [Range<Int>]
    /// Higher is better; only for ordering the hits of one answer.
    public var score: Int
    /// The top of a git repository.
    public var isRepository: Bool
    /// When an agent last worked there, for a folder the host lists.
    public var lastUsed: Date?
    /// The host lists it as added.
    public var isAdded: Bool
    /// In a git worktree: the folder the host adds in its place, its repository's.
    public var repo: String?

    public var id: String { path }

    public init(
        path: String, name: String? = nil, relative: String, ranges: [Range<Int>] = [], score: Int = 0, isRepository: Bool = false,
        lastUsed: Date? = nil, isAdded: Bool = false, repo: String? = nil
    ) {
        self.path = path
        let given = name ?? ""
        self.name = given.isEmpty ? Folder.lastComponent(of: relative.isEmpty ? path : relative) : given
        self.relative = relative
        self.ranges = ranges
        self.score = score
        self.isRepository = isRepository
        self.lastUsed = lastUsed
        self.isAdded = isAdded
        self.repo = repo
    }

    /// Where it is, for reading: `~/` and the folders it is in, `~/coding_projects/`.
    public var head: String {
        guard let slash = relative.lastIndex(of: "/") else { return "~/" }
        return "~/" + relative[...slash]
    }

    /// `ranges` as ranges of `relative`'s characters, to draw the matched letters bold. A
    /// range that does not fall on characters of `relative` is left out.
    public var matchedRanges: [Range<String.Index>] {
        let utf16 = relative.utf16
        return ranges.compactMap { range in
            guard range.lowerBound >= 0, range.upperBound <= utf16.count,
                  let lower = utf16.index(utf16.startIndex, offsetBy: range.lowerBound, limitedBy: utf16.endIndex)
                      .flatMap({ $0.samePosition(in: relative) }),
                  let upper = utf16.index(utf16.startIndex, offsetBy: range.upperBound, limitedBy: utf16.endIndex)
                      .flatMap({ $0.samePosition(in: relative) })
            else { return nil }
            return lower ..< upper
        }
    }
}

/// What the host answered for one query of the folder picker.
public struct FolderSearchResults: Hashable, Sendable {
    public enum Mode: String, Hashable, Sendable {
        /// Fuzzy over every folder under the home folder.
        case fuzzy
        /// A path typed as in a terminal, completed a level at a time.
        case path
    }

    /// The host's home folder, as its real path.
    public var home: String
    public var hits: [FolderSearchHit]
    public var total: Int
    public var matched: Int
    public var mode: Mode
    /// Not every folder was looked at (the host keeps at most so many, or ran out of time).
    public var truncated: Bool
    /// The host is still walking its folders, or reading what changed: asking again
    /// shortly may find more.
    public var refreshing: Bool
    /// A newer query from this device replaced this one on the host: no hits, and nothing
    /// to show.
    public var superseded: Bool

    public init(
        home: String, hits: [FolderSearchHit], total: Int = 0, matched: Int = 0, mode: Mode = .fuzzy, truncated: Bool = false,
        refreshing: Bool = false, superseded: Bool = false
    ) {
        self.home = home
        self.hits = hits
        self.total = total
        self.matched = matched
        self.mode = mode
        self.truncated = truncated
        self.refreshing = refreshing
        self.superseded = superseded
    }
}

public enum FolderError: LocalizedError, Hashable, Sendable {
    /// The host does not offer folders.
    case unavailable
    /// The host does not take the folder; why, in its words.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host does not offer folders to work in."
        case let .refused(reason): reason
        }
    }
}

extension Agent {
    /// Whether the agent is one that is talked with rather than set to work in a folder:
    /// a Hermes profile on a bridge. Its new thread need not start by choosing a folder.
    /// What the bridge says the agent is decides (`kind`); a bridge that says no kind
    /// runs its coding agents under their own names (`CodingAgentLogo`), and whatever
    /// else it lists is a Hermes profile. False on every other host, where no agent
    /// chooses a folder at all.
    public func needsNoFolder(on hostKind: HostKind?) -> Bool {
        guard hostKind == .bridge else { return false }
        if let kind { return kind == "hermes" }
        return CodingAgentLogo(rawValue: id.name) == nil
    }
}

extension Agent {
    /// Whether the agent is Aeri, the agent of its own that a bridge from before
    /// 2026-10-21 may still run to manage the others. Aeri was taken out of Portals that
    /// day (its code is kept on the branch `aeri-kept`), so the app lists it nowhere,
    /// nor its conversation. What the bridge says the agent is decides (`kind`), which
    /// only a Portals bridge says; a Hermes profile named Aeri is a Hermes agent like any
    /// other.
    public var isAeri: Bool { kind == "aeri" }
}

extension ThreadRef {
    /// What to call the folder the thread works in: "No project" for the host's General
    /// folder (`general`, its path), its last path component otherwise; nil for a thread
    /// with no folder.
    public func folderName(general: String?) -> String? {
        guard let workingDirectory, !workingDirectory.isEmpty else { return nil }
        return Folder.name(of: workingDirectory, general: general)
    }
}
