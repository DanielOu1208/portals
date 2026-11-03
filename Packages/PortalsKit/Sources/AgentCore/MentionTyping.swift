import Foundation
import Observation

// Mentioning a file as it is typed in the composer (docs/plans/2026-10-26-file-mentions.md,
// section 8): an `@` at the start of a word opens a menu of the host's files, each keystroke
// after it searches, and a pick writes the file's token into the text. What a sent message's
// text mentions is read back with `FileMention.mentions(in:)`.

/// The `@` being typed at the caret, and what follows it: what the menu searches for.
public struct MentionQuery: Hashable, Sendable {
    /// What is typed after the `@` (after `@"`, for a path with a space), up to the caret.
    public var text: String
    /// Begun with `@"`: it may hold spaces.
    public var isQuoted: Bool
    /// From the `@` to the end of the word the caret is in (of a quoted one, to its closing
    /// quote on the line, when it has one): what a pick replaces.
    public var range: Range<String.Index>
    /// Where the `@` is, as a UTF-16 offset: tells this `@` from another one.
    public var anchor: Int

    /// The query the caret is in, or nil: an `@` at the start of a word (after white space,
    /// the start of the text, or CJK punctuation, where Claude Code reads one), then
    /// anything but white space up to the caret; or `@"` there, then anything but a quote
    /// or a line break. An `@` inside a word (an email address, `(@a.ts)`) is none, as
    /// Claude Code would read no mention there (2026-10-26).
    public static func at(_ caret: String.Index, in text: String) -> MentionQuery? {
        guard caret <= text.endIndex else { return nil }
        // On a character's boundary: an index from the text before the last change may not be.
        let caret = text.index(caret, offsetBy: 0)
        var end = caret
        while end < text.endIndex, !text[end].isWhitespace { end = text.index(after: end) }
        // Quoted: back to the nearest quote on the line, which must open with `@"`.
        var index = caret
        while index > text.startIndex {
            let before = text.index(before: index)
            let character = text[before]
            if character.isNewline { break }
            guard character == "\"" else {
                index = before
                continue
            }
            guard before > text.startIndex else { break }
            let at = text.index(before: before)
            if text[at] == "@", startsMention(at: at, in: text) {
                // Through the closing quote, a path with spaces being whole between the quotes.
                var close = caret
                while close < text.endIndex, text[close] != "\"", !text[close].isNewline { close = text.index(after: close) }
                let through = close < text.endIndex && text[close] == "\"" ? text.index(after: close) : end
                return MentionQuery(text: String(text[index ..< caret]), isQuoted: true, range: at ..< through, anchor: at.utf16Offset(in: text))
            }
            break
        }
        // Bare: the last `@` in the caret's word that starts a mention.
        var wordStart = caret
        while wordStart > text.startIndex, !text[text.index(before: wordStart)].isWhitespace { wordStart = text.index(before: wordStart) }
        var found: String.Index?
        var scan = wordStart
        while scan < caret {
            if text[scan] == "@", startsMention(at: scan, in: text) { found = scan }
            scan = text.index(after: scan)
        }
        guard let at = found else { return nil }
        let typed = text[text.index(after: at) ..< caret]
        // `@"…"` closed, or a quote in the word: no query.
        guard !typed.contains("\"") else { return nil }
        return MentionQuery(text: String(typed), isQuoted: false, range: at ..< end, anchor: at.utf16Offset(in: text))
    }

    /// Whether the `@` at `index` begins a mention as Claude Code reads one.
    private static func startsMention(at index: String.Index, in text: String) -> Bool {
        guard index > text.startIndex else { return true }
        let before = text[text.index(before: index)]
        return before.isWhitespace || FileMention.beforeMention.contains(before)
    }

    /// The text with the query replaced by `path`'s token and a space (none when one
    /// follows already), the caret after it: a file picked, or a folder mentioned itself.
    public func writing(_ path: String, in text: String) -> MentionEdit {
        let after = text[range.upperBound...]
        let token = FileMention.token(for: path)
        let spaced = after.first == " "
        return MentionEdit(before: text[..<range.lowerBound], inserted: spaced ? token : token + " ", caretPast: spaced ? 1 : 0, after: after)
    }

    /// The text with the query replaced by `folder` and a slash, the caret at its end: the
    /// menu goes on to the folder's files. `@"` for a folder with a space in its path.
    public func descending(into folder: String, in text: String) -> MentionEdit {
        let typed = folder + "/"
        let inserted = typed.contains(where: \.isWhitespace) ? "@\"" + typed : "@" + typed
        return MentionEdit(before: text[..<range.lowerBound], inserted: inserted, caretPast: 0, after: text[range.upperBound...])
    }
}

/// A pick written into the composer's text.
public struct MentionEdit: Hashable, Sendable {
    public var text: String
    /// Where the caret goes, in `text`.
    public var caret: String.Index

    init(before: Substring, inserted: String, caretPast: Int, after: Substring) {
        text = before + inserted + after
        let offset = before.utf16.count + inserted.utf16.count + caretPast
        caret = String.Index(utf16Offset: offset, in: text)
    }
}

/// A row of the `@` menu.
public enum MentionRow: Hashable, Identifiable, Sendable {
    /// The folder the query went into, to mention the folder itself: at the top.
    case folder(String)
    case hit(FileSearchHit)

    public var id: String {
        switch self {
        case let .folder(path): "folder:" + path
        case let .hit(hit): "hit:" + hit.path
        }
    }

    /// The rows for `query`: the host's hits, and above them the folder the query went
    /// into (`folder/`, once some hit is in it), which a pick mentions itself. The folder's
    /// own hit is left out under that row.
    public static func rows(for query: String, hits: [FileSearchHit]) -> [MentionRow] {
        let folder = query.hasSuffix("/") && query.count > 1 ? String(query.dropLast()) : nil
        guard let folder, hits.contains(where: { $0.path.hasPrefix(query) || ($0.kind == .folder && $0.path == folder) }) else {
            return hits.map(MentionRow.hit)
        }
        return [.folder(folder)] + hits.filter { !($0.kind == .folder && $0.path == folder) }.map(MentionRow.hit)
    }
}

/// What a message names beside its text.
public enum FileMentionDraft {
    /// The paths picked from the menu that the text still mentions, in the order picked,
    /// each once: what goes with the message as `mentions`. A token edited or deleted since
    /// is not one any more (the text is the truth). None to a host that does not take them
    /// (`FileSearching.takesFileMentions`): it gets the text alone, which names them too.
    public static func mentions(picked: [String], in text: String, hostTakesThem: Bool) -> [String] {
        guard hostTakesThem, !picked.isEmpty else { return [] }
        let written = Set(FileMention.paths(in: text))
        var sent: [String] = []
        for path in picked where written.contains(path) && !sent.contains(path) {
            sent.append(path)
        }
        return sent
    }

    /// Where the picked paths' tokens stand in `text`: what the composer colours.
    public static func tokens(picked: [String], in text: String) -> [Range<String.Index>] {
        guard !picked.isEmpty else { return [] }
        let picked = Set(picked)
        return FileMention.tokens(in: text).filter { picked.contains($0.path) }.map(\.range)
    }
}

/// The host's answers to what is typed after an `@`, one query at a time: a newer query
/// drops what an older one answers late, and an answer from a folder being listed again
/// (`refreshing`) is asked for again shortly, until the new listing answers.
@MainActor
@Observable
public final class FileMentionSearch {
    /// One query, in one folder.
    public struct Asked: Hashable, Sendable {
        public var query: String
        public var scope: FileSearchScope

        public init(query: String, scope: FileSearchScope) {
            self.query = query
            self.scope = scope
        }
    }

    public struct Answer: Hashable, Sendable {
        public var asked: Asked
        public var results: FileSearchResults
    }

    /// The answer to the last query answered; kept while a newer one is asked.
    public private(set) var answer: Answer?
    /// Why the last query asked got no answer.
    public private(set) var problem: (asked: Asked, message: String)?

    @ObservationIgnored private var asking: Asked?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let refreshAfter: Duration

    public init(refreshAfter: Duration = .milliseconds(500)) {
        self.refreshAfter = refreshAfter
    }

    /// What the menu shows for `asked`: the last answer in its folder, an older query's while
    /// this one is asked, and none once this one was refused (its `problem` is said instead).
    public func shown(for asked: Asked) -> FileSearchResults? {
        guard let answer, answer.asked.scope == asked.scope else { return nil }
        if let problem, problem.asked == asked { return nil }
        return answer.results
    }

    /// Nothing matches `asked`, as far as is known: what stands for it (its own answer, or an
    /// older query's while it is asked) has no hits. A key typed after a query that matched
    /// nothing leaves the menu saying so, rather than closing it until the answer comes.
    public func findsNothing(for asked: Asked) -> Bool {
        shown(for: asked)?.hits.isEmpty == true
    }

    /// Asks for `asked` with `search`, unless it is being asked or answered already.
    public func ask(_ asked: Asked, with search: @escaping @MainActor (String) async throws -> FileSearchResults) {
        guard asked != asking else { return }
        task?.cancel()
        asking = asked
        task = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let results = try await search(asked.query)
                    guard let self, !Task.isCancelled, self.asking == asked else { return }
                    self.answer = Answer(asked: asked, results: results)
                    self.problem = nil
                    guard results.refreshing else { return }
                    try await Task.sleep(for: self.refreshAfter)
                } catch {
                    guard let self, !Task.isCancelled, self.asking == asked, !(error is CancellationError) else { return }
                    self.problem = (asked, error.localizedDescription)
                    return
                }
            }
        }
    }

    /// Stops asking: the menu closed. The last answer is let go of too.
    public func stop() {
        task?.cancel()
        task = nil
        asking = nil
        // Set only when it changes: whatever reads them is drawn again when they are set.
        if answer != nil { answer = nil }
        if problem != nil { problem = nil }
    }
}

// MARK: - In a sent message

/// The files picked from the `@` menu that the messages sent from this device named, by
/// message, while the app runs: the chips of that message whatever their shape, what "Try
/// again" sends with it again once its saved copy has been let go (a message the host took),
/// and the note on each file its agent may not have read in whole (`SendReceipt.largeMentions`),
/// on that message's chips and no other's. The newest `kept` messages.
public struct SentMentions: Hashable, Sendable {
    public static let kept = 200

    private struct Sent: Hashable, Sendable {
        var paths: [String]
        var notes: [String: FileMentionFit] = [:]
    }

    private var sent: [UUID: Sent] = [:]
    private var order: [UUID] = []

    public init() {}

    /// A message sent with `paths` beside its text.
    public mutating func sent(_ paths: [String], as message: UUID) {
        guard !paths.isEmpty else { return }
        if sent[message] == nil { order.append(message) }
        sent[message] = Sent(paths: paths)
        while order.count > Self.kept { sent[order.removeFirst()] = nil }
    }

    /// The host's answer to it: the files its agent may not read in whole.
    public mutating func answered(_ large: [LargeFileMention], for message: UUID) {
        guard sent[message] != nil else { return }
        sent[message]?.notes = Dictionary(large.map { ($0.path, $0.fit) }) { first, _ in first }
    }

    /// What `message` was sent with beside its text; none once let go.
    public func paths(of message: UUID) -> [String] {
        sent[message]?.paths ?? []
    }

    /// What became of `path` mentioned in `message`, when its agent may not have read it in whole.
    public func fit(of path: String, in message: UUID) -> FileMentionFit? {
        sent[message]?.notes[path]
    }
}

/// Marks the characters of a message's text that mention a file (`FileMention.mentions`),
/// with its path: a chip is drawn in their place.
public enum FileMentionAttribute: AttributedStringKey {
    public typealias Value = String
    public static let name = "AgentCore.fileMention"
}

extension FileMention {
    /// `text` with the tokens that are a chip marked with their path (`FileMentionAttribute`):
    /// a path-like one (`isPathLike`), and any of `picked`, the paths picked from the menu
    /// for this message. "ask @claude" stays text (2026-10-27).
    public static func marked(_ text: String, picked: [String] = []) -> AttributedString {
        var marked = AttributedString(text)
        for mention in tokens(in: text) where isPathLike(mention.path) || picked.contains(mention.path) {
            guard let lower = AttributedString.Index(mention.range.lowerBound, within: marked),
                  let upper = AttributedString.Index(mention.range.upperBound, within: marked) else { continue }
            marked[lower ..< upper].fileMention = mention.path
        }
        return marked
    }

    /// Whether a mention looks like a path whatever the host holds: one with a `/`, or a name
    /// with an extension, that is something before its last dot and after it letters or
    /// digits with a letter among them (`plan.md`, `main.c`, `photo.7z`; not `v1.2`, `3.14`,
    /// `.env`).
    public static func isPathLike(_ path: String) -> Bool {
        if path.contains("/") { return true }
        guard let dot = path.lastIndex(of: "."), dot > path.startIndex else { return false }
        let ending = path[path.index(after: dot)...]
        return !ending.isEmpty && ending.allSatisfy { $0.isLetter || $0.isNumber } && ending.contains(where: \.isLetter)
    }
}
