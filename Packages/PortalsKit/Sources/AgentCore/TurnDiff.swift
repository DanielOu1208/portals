import Foundation

/// What one of the agent's turns changed, as the host tells it once the turn has ended
/// (a bridge's feature `turn_diff`): every file it edited, wrote, added or deleted, each
/// with its unified diff (its edits' diffs joined in the order they were made) and the
/// lines added and removed, and the turn's totals. Shown under the turn as "3 files ·
/// +40 −12", which opens the files and their diffs.
public struct TurnDiff: Codable, Hashable, Sendable {
    /// What a diff being viewed is of, which what the viewer says of what is missing follows.
    public enum Origin: Hashable, Sendable {
        /// A turn's, which the host keeps so much of.
        case turn
        /// What a repository holds uncommitted, of which the host lists the first so many:
        /// how many files differ in all. A file can be missing for several reasons here (too
        /// long, past what is read, unreadable), and no turn is involved.
        case uncommitted(total: Int)

        /// For a file with no diff to show.
        public var leftOutLine: String {
            switch self {
            case .turn: "Too long to keep: the turn's diffs passed what is kept of one."
            case .uncommitted: "Not shown: this file's diff was left out."
            }
        }

        /// For a file with part of its diff to show.
        public var cutShortLine: String {
            switch self {
            case .turn: "Cut short: the rest of this file's diff was too long to keep."
            case .uncommitted: "Cut short: the rest of this file's diff was left out."
            }
        }

        /// For the list of files, some of them cut.
        public var someCutLine: String {
            switch self {
            case .turn: "Some diffs were too long to keep whole: they are cut short."
            case .uncommitted: "Some of these diffs were left out or cut short."
            }
        }
    }

    public struct File: Codable, Hashable, Sendable, Identifiable {
        public enum Status: String, Codable, Hashable, Sendable {
            /// The turn created it.
            case added
            case modified
            /// The turn's last change to it removed it.
            case deleted
        }

        /// As the diffs name it: relative to the thread's folder when inside it.
        public var path: String
        public var status: Status
        public var added: Int
        public var removed: Int
        /// Its unified diff; empty when the turn's diffs passed the host's cap before it.
        public var diff: String
        /// Its diff was cut short or left out (the host keeps about 512 KB a turn); its
        /// counts are whole.
        public var cut: Bool
        /// Git gave no count of its lines (a binary file, one too large to count or past those
        /// counted): `added` and `removed` say nothing. A repository's file, never a turn's, so
        /// not kept with one.
        public var uncounted = false

        public var id: String { path }

        private enum CodingKeys: String, CodingKey {
            case path, status, added, removed, diff, cut
        }

        public init(path: String, status: Status = .modified, added: Int = 0, removed: Int = 0, diff: String = "", cut: Bool = false, uncounted: Bool = false) {
            self.path = path
            self.status = status
            self.added = added
            self.removed = removed
            self.diff = diff
            self.cut = cut
            self.uncounted = uncounted
        }

        /// The file's name alone, for its row.
        public var name: String {
            let name = (path as NSString).lastPathComponent
            return name.isEmpty ? path : name
        }

        /// The folder it is in, as the path names it, or nil at the top.
        public var folder: String? {
            let folder = (path as NSString).deletingLastPathComponent
            return folder.isEmpty ? nil : folder
        }

        /// Where the file viewer opens it (`file.read`), at the first line its diff changed:
        /// by its path as the host names it, relative to the thread's folder when inside it,
        /// else absolute (with its "/"), so one outside is said to be outside.
        public var location: FileLocation {
            FileLocation(path: path, line: firstChangedLine)
        }

        /// The new file's number of the first line the diff adds or removes (where a
        /// removal was), from its first hunk's header; nil without numbers.
        public var firstChangedLine: Int? {
            var number: Int?
            for line in diff.split(separator: "\n", omittingEmptySubsequences: false).prefix(4000) {
                if line.hasPrefix("@@") {
                    // "@@ -3,4 +5,6 @@": the new file's hunk starts at 5.
                    guard let plus = line.split(separator: " ").first(where: { $0.hasPrefix("+") }),
                          let start = Int(plus.dropFirst().prefix { $0.isNumber })
                    else { number = nil; continue }
                    number = start
                } else if let current = number {
                    if line.hasPrefix("+") || line.hasPrefix("-") { return max(current, 1) }
                    if line.hasPrefix(" ") { number = current < Int.max ? current + 1 : nil }
                }
            }
            return nil
        }
    }

    /// In the order the turn first changed them.
    public var files: [File]
    public var added: Int
    public var removed: Int
    /// One file's diff or more was cut short or left out.
    public var cut: Bool

    public init(files: [File], added: Int? = nil, removed: Int? = nil, cut: Bool? = nil) {
        self.files = files
        self.added = added ?? files.reduce(0) { $0 + $1.added }
        self.removed = removed ?? files.reduce(0) { $0 + $1.removed }
        self.cut = cut ?? files.contains(where: \.cut)
    }

    /// "3 files", "1 file".
    public var filesLine: String {
        files.count == 1 ? "1 file" : "\(files.count) files"
    }

    /// "3 files changed", or as many as are here of how many there are.
    public func listLine(_ origin: Origin) -> String {
        if case let .uncommitted(total) = origin, total > files.count { return "Showing \(files.count) of \(total) files" }
        return "\(filesLine) changed"
    }

    /// There is a count to show: none where its only files are ones git gave none for.
    public var hasCounts: Bool {
        added > 0 || removed > 0 || !files.contains(where: \.uncounted)
    }

    /// "+40 −12", "+3", "−2": what changed, each side only when it is there.
    public static func counts(added: Int, removed: Int) -> String {
        var parts: [String] = []
        if added > 0 || removed == 0 { parts.append("+\(added)") }
        if removed > 0 { parts.append("\u{2212}\(removed)") }
        return parts.joined(separator: " ")
    }
}

/// A diff's lines (`DiffText`) with each one's number in the new file, read from the
/// hunks' headers: none for a removed line, a hunk's header, or a diff without numbers.
public struct NumberedDiff: Sendable {
    public struct Line: Identifiable, Sendable {
        public var id: Int
        public var kind: DiffText.Kind
        public var text: String
        /// Its number in the new file; nil for a removed line or a hunk's header.
        public var number: Int?
    }

    public let lines: [Line]
    /// The widest number's characters, two at least.
    public let gutter: Int

    /// The longest line shown whole, in characters: a line of a minified file can be
    /// hundreds of KB, drawn on one line. Past it the line is cut with "…" (the diff's
    /// copy keeps it whole).
    public static let shownLineLimit = 2000

    public init(_ diff: String) {
        var next: Int?
        var lines: [Line] = []
        for line in DiffText(diff).lines {
            var number: Int?
            switch line.kind {
            case .hunk:
                next = Self.newStart(line.text)
            case .added, .context:
                number = next
                next = next.flatMap { $0 < Int.max ? $0 + 1 : nil }
            case .removed:
                break
            }
            // utf8.count first: cheap, and a line that short has no more characters.
            let text = line.text.utf8.count > Self.shownLineLimit && line.text.count > Self.shownLineLimit
                ? String(line.text.prefix(Self.shownLineLimit)) + "\u{2026}" : line.text
            lines.append(Line(id: line.id, kind: line.kind, text: text, number: number))
        }
        self.lines = lines
        gutter = max(2, String(lines.compactMap(\.number).max() ?? 0).count)
    }

    /// Where the new side of a hunk starts: "@@ -1,3 +4,5 @@" is 4.
    public static func newStart(_ header: String) -> Int? {
        guard let plus = header.range(of: " +") else { return nil }
        let digits = header[plus.upperBound...].prefix { $0.isNumber }
        return Int(digits)
    }
}
