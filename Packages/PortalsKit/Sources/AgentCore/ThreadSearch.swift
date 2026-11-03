import Foundation

// Search inside threads (a Portals bridge's `thread_search`, docs/gateway-protocol.md
// section 11, docs/plans/2026-10-26-thread-search.md): words found in the user's messages
// and the agent's replies of every thread a host lists, grouped by thread, newest first,
// a page at a time. The model only: where the app shows it is the app's.

/// What to look for, and in which threads.
public struct ThreadSearchQuery: Hashable, Sendable {
    /// Words and `"quoted phrases"`; a message must hold every one. Case and accents are
    /// ignored, and a word is found where a word begins (`deploy` finds `deployment`,
    /// `log` finds `login` but not `catalog`, `search` finds `threadSearch`); in scripts
    /// written without spaces, anywhere.
    public var text: String
    /// Threads per page (the host's default when nil: 20; at most 50).
    public var limit: Int?
    /// Hits shown per thread, newest first (the host's default when nil: 3; at most 10).
    public var hits: Int?
    /// Only this agent's threads: its name on the host.
    public var agent: String?
    /// Only the threads in this folder on the host, or in a folder inside it.
    public var folder: String?

    public init(text: String, limit: Int? = nil, hits: Int? = nil, agent: String? = nil, folder: String? = nil) {
        self.text = text
        self.limit = limit
        self.hits = hits
        self.agent = agent
        self.folder = folder
    }

    /// Whether there is anything to look for: the host refuses a query of white space and quotes only.
    public var isEmpty: Bool {
        text.allSatisfy { $0.isWhitespace || $0 == "\"" }
    }
}

/// One page of a search.
public struct ThreadSearchPage: Hashable, Sendable {
    /// The threads with hits on this page, newest first.
    public var threads: [ThreadSearchResult]
    /// What to ask with for the next page; nil when every thread was searched.
    public var cursor: String?
    /// How many threads the page searched, hits or not.
    public var scanned: Int
    /// Threads the host could not search, by agent (Hermes's, unless open), with its sentence why.
    public var unsearched: [ThreadSearchGap]
    /// A newer search on the same connection took this one's place: drop it.
    public var replaced: Bool

    public init(threads: [ThreadSearchResult], cursor: String? = nil, scanned: Int = 0, unsearched: [ThreadSearchGap] = [], replaced: Bool = false) {
        self.threads = threads
        self.cursor = cursor
        self.scanned = scanned
        self.unsearched = unsearched
        self.replaced = replaced
    }

    /// Whether there is another page to ask for.
    public var hasMore: Bool { cursor != nil }
}

/// A thread with hits.
public struct ThreadSearchResult: Hashable, Sendable, Identifiable {
    /// The thread's id on the host, as its thread list has it.
    public var threadID: ThreadRef.ID
    /// The agent's name on the host, and what to call it.
    public var agent: String
    public var agentName: String
    public var title: String?
    /// Its folder on the host.
    public var folder: String
    /// Its place in the list.
    public var updated: Date
    public var archived: Bool
    /// How many of its messages hold every word.
    public var count: Int
    /// The newest of them, newest first.
    public var hits: [ThreadSearchHit]
    /// Its file was too large to search whole: only its end was.
    public var partial: Bool
    /// When the thread's latest compaction was: the time of the compaction row its history
    /// shows, to open the thread at for a hit `beforeCompaction`. Nil when no hit is.
    public var compactedAt: Date?

    public var id: ThreadRef.ID { threadID }

    public init(
        threadID: ThreadRef.ID, agent: String, agentName: String, title: String? = nil, folder: String, updated: Date,
        archived: Bool = false, count: Int, hits: [ThreadSearchHit], partial: Bool = false, compactedAt: Date? = nil
    ) {
        self.threadID = threadID
        self.agent = agent
        self.agentName = agentName
        self.title = title
        self.folder = folder
        self.updated = updated
        self.archived = archived
        self.count = count
        self.hits = hits
        self.partial = partial
        self.compactedAt = compactedAt
    }
}

/// A message that holds every word, as a snippet with the matches marked.
public struct ThreadSearchHit: Hashable, Sendable {
    public enum Role: String, Hashable, Sendable {
        case user
        case assistant
    }

    public var role: Role
    /// About 200 characters around the first match, white space shown as spaces, `…`
    /// where text was left out.
    public var snippet: String
    /// The matches in `snippet`, in UTF-16 code units, as the host counts them.
    public var utf16Ranges: [Range<Int>]
    /// When the message was sent: with `role`, how the app finds its row in the thread.
    public var timestamp: Date
    /// The agent's own id for the message, where its file has one (not the app's).
    public var agentMessageID: String?
    /// Said before the thread's latest compaction, which the thread no longer shows (a
    /// Claude Code thread's): its row will not be found, so the thread is opened at the
    /// compaction row (the result's `compactedAt`) with the snippet in a note.
    public var beforeCompaction: Bool

    public init(
        role: Role, snippet: String, utf16Ranges: [Range<Int>], timestamp: Date, agentMessageID: String? = nil, beforeCompaction: Bool = false
    ) {
        self.role = role
        self.snippet = snippet
        self.utf16Ranges = utf16Ranges
        self.timestamp = timestamp
        self.agentMessageID = agentMessageID
        self.beforeCompaction = beforeCompaction
    }

    /// The matches as ranges of `snippet`, for marking them; a range that does not fall on
    /// characters of it (a host's mistake) is left out rather than trusted.
    public var matchRanges: [Range<String.Index>] {
        let utf16 = snippet.utf16
        return utf16Ranges.compactMap { range in
            guard range.lowerBound >= 0, range.upperBound <= utf16.count, range.lowerBound < range.upperBound else { return nil }
            let start = utf16.index(utf16.startIndex, offsetBy: range.lowerBound)
            let end = utf16.index(utf16.startIndex, offsetBy: range.upperBound)
            guard let lower = start.samePosition(in: snippet), let upper = end.samePosition(in: snippet) else { return nil }
            return lower ..< upper
        }
    }
}

/// Threads a host could not search.
public struct ThreadSearchGap: Hashable, Sendable {
    public var agent: String
    public var count: Int
    /// The host's sentence for the person.
    public var reason: String

    public init(agent: String, count: Int, reason: String) {
        self.agent = agent
        self.count = count
        self.reason = reason
    }
}

public enum ThreadSearchError: Error, Hashable, Sendable, LocalizedError {
    /// The host cannot search inside threads (Hermes, a bridge from before it).
    case unavailable
    /// The host said no, with its sentence: an empty query, a cursor from another search.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host cannot search inside threads. Update Portals on it."
        case let .refused(message): message
        }
    }
}

/// A host that searches inside its threads.
public protocol ThreadSearching: Sendable {
    /// Whether the host searches inside threads, as of the last connection; nil before the first.
    var searchesThreads: Bool? { get async }
    /// A page of the threads that hold `query`; `cursor` the last page's, for the next.
    /// A newer search on the same host replaces one still under way, which comes back
    /// `replaced`. Throws `ThreadSearchError`.
    func searchThreads(_ query: ThreadSearchQuery, cursor: String?) async throws -> ThreadSearchPage
}
