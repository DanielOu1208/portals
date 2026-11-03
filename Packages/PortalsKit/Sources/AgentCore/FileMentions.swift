import Foundation

// Mentioning a file with `@` (docs/plans/2026-10-26-file-mentions.md): the host ranks the
// files and folders of a thread's folder against what the person types (a Portals bridge's
// `files.search`, feature `file_search`), and a message names each one picked as `@path`
// in its text (`@"path"` with a space), with the list beside it for a bridge that lists
// `file_mentions`. No view here: where the menu goes is the app's.

/// Where to search: a thread's folder, or a folder a new thread may start in.
public enum FileSearchScope: Hashable, Sendable {
    case thread(ThreadRef.ID)
    /// A path from the host's folder list (General, a listed folder, or a git worktree of
    /// one): the folder chosen on the new-thread screen, searched before the thread exists.
    case folder(String)
}

/// One file or folder the host found.
public struct FileSearchHit: Hashable, Sendable, Identifiable {
    public enum Kind: String, Hashable, Sendable {
        case file
        case folder
    }

    /// Relative to the folder searched, with `/` between its parts.
    public var path: String
    /// Its last part.
    public var name: String
    public var kind: Kind
    /// Higher is better; only for ordering the hits of one answer.
    public var score: Int
    /// The parts of `path` the query matched, as UTF-16 offsets, in order.
    public var ranges: [Range<Int>]
    /// A file's size in bytes, from a host that says it; nil for a folder or a link.
    public var size: Int?

    public var id: String { path }

    public init(path: String, name: String, kind: Kind, score: Int, ranges: [Range<Int>], size: Int? = nil) {
        self.path = path
        self.name = name
        self.kind = kind
        self.score = score
        self.ranges = ranges
        self.size = size
    }

    /// `ranges` as ranges of `path`'s characters, to draw the matched letters bold. A range
    /// that does not fall on characters of `path` is left out.
    public var matchedRanges: [Range<String.Index>] {
        ranges.compactMap { range in
            let utf16 = path.utf16
            guard range.lowerBound >= 0, range.upperBound <= utf16.count,
                  let lower = utf16.index(utf16.startIndex, offsetBy: range.lowerBound, limitedBy: utf16.endIndex)
                      .flatMap({ $0.samePosition(in: path) }),
                  let upper = utf16.index(utf16.startIndex, offsetBy: range.upperBound, limitedBy: utf16.endIndex)
                      .flatMap({ $0.samePosition(in: path) })
            else { return nil }
            return lower ..< upper
        }
    }

    /// How the message names it: `FileMention.token(for:)`.
    public var token: String { FileMention.token(for: path) }

    /// The folder it is in, relative to the one searched: empty at the top.
    public var folder: String {
        guard path.hasSuffix(name), path.count > name.count else { return "" }
        return String(path.dropLast(name.count).dropLast())
    }

    /// The matched letters that fall in `name`, as ranges of `name`'s characters, for a row
    /// that shows the name apart from its folder.
    public var nameMatches: [Range<String.Index>] {
        guard path.hasSuffix(name) else { return [] }
        let offset = path.utf16.count - name.utf16.count
        let utf16 = name.utf16
        return ranges.compactMap { range in
            let lower = max(range.lowerBound - offset, 0), upper = min(range.upperBound - offset, utf16.count)
            guard lower < upper,
                  let start = utf16.index(utf16.startIndex, offsetBy: lower, limitedBy: utf16.endIndex)?.samePosition(in: name),
                  let end = utf16.index(utf16.startIndex, offsetBy: upper, limitedBy: utf16.endIndex)?.samePosition(in: name)
            else { return nil }
            return start ..< end
        }
    }
}

/// What the host answered for one query.
public struct FileSearchResults: Hashable, Sendable {
    /// The folder searched, as the host's real path.
    public var folder: String
    public var hits: [FileSearchHit]
    /// How many files and folders the host's listing holds.
    public var total: Int
    /// How many the query matched.
    public var matched: Int
    /// Whether the listing is git's (`git`) or a walk of the folder (`walk`).
    public var source: String
    /// The folder holds more than the host lists: what was left out is never found.
    public var truncated: Bool
    /// The folder changed and is being listed again: this is the listing before; asking
    /// again shortly gives the new one.
    public var refreshing: Bool
    /// How large a mentioned file the agent reads in with the message, for one that reads
    /// mentions in itself (Claude Code); nil for the others, whose model reads a file with
    /// its tools, and from a host that does not say.
    public var mentionLimit: FileMentionLimit?

    public init(
        folder: String, hits: [FileSearchHit], total: Int, matched: Int, source: String, truncated: Bool = false, refreshing: Bool = false,
        mentionLimit: FileMentionLimit? = nil
    ) {
        self.folder = folder
        self.hits = hits
        self.total = total
        self.matched = matched
        self.source = source
        self.truncated = truncated
        self.refreshing = refreshing
        self.mentionLimit = mentionLimit
    }

    /// What becomes of `hit` mentioned in a message to this agent: for the note the menu
    /// and the composer show beside a large file (`FileMentionFit.note`). A PDF has none:
    /// Claude Code reads one its own way, whatever its size.
    public func fit(of hit: FileSearchHit) -> FileMentionFit {
        guard hit.kind == .file, let mentionLimit, !Self.isPDF(hit.name) else { return .whole }
        return mentionLimit.fit(size: hit.size)
    }

    /// Whether Claude Code takes a file of this name for a PDF: its extension as Node's
    /// `extname` reads one, so `.pdf` alone is a name with none.
    static func isPDF(_ name: String) -> Bool {
        name.count > 4 && name.lowercased().hasSuffix(".pdf")
    }
}

/// How large a mentioned file an agent that reads a message's mentions in itself gives its
/// model (a Portals bridge's `mention_limit`; Claude Code 2.1.299: 262,144 bytes and
/// 25,000 tokens, docs/plans/2026-10-26-file-mentions.md, section 3).
public struct FileMentionLimit: Hashable, Sendable {
    /// Over this the file is never read in (Claude Code tells its model to read it in parts).
    public var maxBytes: Int
    /// Over this many tokens it is left out without a word (or only its first 2,000 lines
    /// given, when they fit): only the agent's own count says, so
    public var maxTokens: Int
    /// from this size on the app says the file may be left out.
    public var noteBytes: Int

    public init(maxBytes: Int, maxTokens: Int, noteBytes: Int) {
        self.maxBytes = maxBytes
        self.maxTokens = maxTokens
        self.noteBytes = noteBytes
    }

    /// What becomes of a file of `size` bytes; one of unknown size is taken as read in.
    public func fit(size: Int?) -> FileMentionFit {
        guard let size else { return .whole }
        if size > maxBytes { return .unread }
        return size > noteBytes ? .maybe : .whole
    }
}

/// What becomes of a mentioned file in a message to an agent that reads mentions in itself.
public enum FileMentionFit: String, Hashable, Sendable {
    /// Read in with the message.
    case whole
    /// Large: it may be left out of the message, without the agent being told.
    case maybe
    /// Too large: not read in; the agent is told to read it in parts with its tools.
    case unread

    /// The small note for a mention, or nil for one read in whole. 2026-10-26:
    /// "Yes, a small note".
    public var note: String? {
        switch self {
        case .whole: nil
        case .maybe: "Large file: the agent may not get all of it with the message."
        case .unread: "Too large to send with the message: the agent reads it in parts."
        }
    }
}

/// A file a sent message mentions that its agent may not have read in (a Portals bridge's
/// `prompt.submit` answer, `large_mentions`), for the note on the sent message's chip.
public struct LargeFileMention: Hashable, Sendable {
    /// As the message mentions it, relative to the thread's folder.
    public var path: String
    public var size: Int
    /// `.maybe` or `.unread`.
    public var fit: FileMentionFit

    public init(path: String, size: Int, fit: FileMentionFit) {
        self.path = path
        self.size = size
        self.fit = fit
    }
}

public enum FileSearchError: LocalizedError, Hashable, Sendable {
    /// The host does not search files (Hermes, an older bridge).
    case unavailable
    /// The host would not search there: its sentence for the person.
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .unavailable: "This host cannot search its files. Update Portals on it."
        case let .refused(message): message
        }
    }
}

/// A host that ranks the files of a folder for an `@` mention (a Portals bridge's `file_search`).
public protocol FileSearching: Sendable {
    /// Whether the host searches files, as of the last connection; nil before the first.
    var searchesFiles: Bool? { get async }
    /// Whether the host takes the files a message mentions beside its text (`file_mentions`), as of the last connection.
    var takesFileMentions: Bool? { get async }
    /// The best `limit` files and folders for `query` (empty: the shallowest ones). `agent`:
    /// for a `.folder` (the new-thread screen), the profile name of the agent the new thread
    /// will run, whose `mentionLimit` the answer then has; a thread's own agent is known.
    /// Throws `FileSearchError`.
    func searchFiles(_ query: String, in scope: FileSearchScope, limit: Int, agent: String?) async throws -> FileSearchResults
}

public extension FileSearching {
    /// `searchFiles(_:in:limit:agent:)` naming no agent.
    func searchFiles(_ query: String, in scope: FileSearchScope, limit: Int) async throws -> FileSearchResults {
        try await searchFiles(query, in: scope, limit: limit, agent: nil)
    }
}

/// A host to which a message can say, beside its text, which files it mentions (a Portals
/// bridge's `file_mentions`). One that does not take them is sent the text alone, which
/// names them too.
public protocol FileMentionSending: Sendable {
    /// `AgentBackend.send` with this app's id for the message, and `mentions`: paths relative
    /// to the thread's folder, each written in `text` as `FileMention.token(for:)`.
    func send(
        _ text: String, images: [ImageAttachment], files: [FileAttachment], mentions: [String], whenBusy: WhenBusy, messageID: UUID,
        to thread: ThreadRef.ID
    ) async throws -> SendReceipt
}

/// How a message names a file it mentions, as Claude Code reads one and the bridge writes
/// one the text lacks (`bridge/src/sessions/mentions.ts`).
public enum FileMention {
    /// Characters Claude Code reads a word's `@` after, besides white space (CJK punctuation).
    static let beforeMention: Set<Character> = ["\u{3002}", "\u{3001}", "\u{FF1F}", "\u{FF01}"]

    /// Whether Claude Code ends a bare `@path` on this character: an ASCII letter, digit or `_`.
    private static func isWordCharacter(_ character: Character?) -> Bool {
        guard let character, character.isASCII else { return false }
        return character.isLetter || character.isNumber || character == "_"
    }

    /// `@path`, or `@"path"` when Claude Code would read the bare one otherwise: a path with
    /// white space, or one not ending on an ASCII letter, digit or `_` (it drops what follows
    /// the last of those, so `@notes.md,` would be notes.md and `@café` caf).
    public static func token(for path: String) -> String {
        path.contains(where: \.isWhitespace) || !isWordCharacter(path.last) ? "@\"\(path)\"" : "@\(path)"
    }

    /// The paths a message's text mentions as Claude Code reads them, in order, each once:
    /// `@"path"` after the start or white space, and in each word an `@` at its start (or
    /// after CJK punctuation) up to the word's last ASCII letter, digit or `_`. An `@`
    /// inside a word (an email address, `(@a.ts)`) is none.
    public static func paths(in text: String) -> [String] {
        var found: [String] = []
        for mention in mentions(in: text) where !found.contains(mention.path) {
            found.append(mention.path)
        }
        return found
    }

    /// One mention in a text: the path, and where its token stands (from the `@` to the
    /// end of the path, or of the closing quote).
    public struct Written: Hashable, Sendable {
        public var path: String
        public var range: Range<String.Index>
    }

    /// The mentions of `text` as written, each once where it stands: an `@` inside a quoted
    /// path (`@"my @notes.md"`), which Claude Code reads as a mention too, is part of the
    /// quoted one here, for what is drawn (a chip, a coloured token).
    public static func tokens(in text: String) -> [Written] {
        var tokens: [Written] = []
        for mention in mentions(in: text) where tokens.last.map({ $0.range.upperBound <= mention.range.lowerBound }) ?? true {
            tokens.append(mention)
        }
        return tokens
    }

    /// Every mention in `text` as `paths(in:)` reads them, in order, each where it stands.
    public static func mentions(in text: String) -> [Written] {
        let characters = Array(text)
        // Where each character starts in the text.
        var indices = Array(text.indices)
        indices.append(text.endIndex)
        var mentions: [(at: Int, end: Int, path: String)] = []
        // Quoted: `@"path"` after the start, white space or CJK punctuation.
        var index = 0
        while index + 1 < characters.count {
            defer { index += 1 }
            guard characters[index] == "@", characters[index + 1] == "\"" else { continue }
            if index > 0, !(characters[index - 1].isWhitespace || beforeMention.contains(characters[index - 1])) { continue }
            guard let close = characters[(index + 2)...].firstIndex(of: "\""), close > index + 2 else { continue }
            mentions.append((index, close + 1, String(characters[(index + 2) ..< close])))
            index = close
        }
        // Bare: word by word.
        var wordStart = 0
        while wordStart < characters.count {
            if characters[wordStart].isWhitespace {
                wordStart += 1
                continue
            }
            var wordEnd = wordStart
            while wordEnd < characters.count, !characters[wordEnd].isWhitespace { wordEnd += 1 }
            defer { wordStart = wordEnd }
            var at = characters[wordStart ..< wordEnd].firstIndex(of: "@")
            while let found = at, found > wordStart, !beforeMention.contains(characters[found - 1]) {
                at = characters[(found + 1) ..< wordEnd].firstIndex(of: "@")
            }
            guard let start = at else { continue }
            var end = wordEnd
            while end >= start + 2, isWordCharacter(characters[end - 1]) == isWordCharacter(end < wordEnd ? characters[end] : nil) { end -= 1 }
            guard end >= start + 2, characters[start + 1] != "\"" else { continue }
            mentions.append((start, end, String(characters[(start + 1) ..< end])))
        }
        return mentions.sorted { $0.at < $1.at }.map { Written(path: $0.path, range: indices[$0.at] ..< indices[$0.end]) }
    }
}
