import Foundation

// The newest words of a thought, on the status line after "Thinking ·" while the agent
// thinks (2026-10-20: "thoughts inside the line are good can u also pace it so the
// text doesnt jump"). The thought is one line of text (`ThoughtLine`), drawn with its end
// against the right of the room it has and cut on its left with a fade, and it slides to
// the left as the thought streams in, evenly, as fast as `ThoughtPace` says: one even
// glide from where it is to its new end for each piece heard, so the words never jump
// forward, whether the agent sends a word at a time, a burst or a whole paragraph.

/// A thought's text as one line, read piece by piece as it streams: Markdown's bold marks
/// taken out (Codex's summaries open with a bold title), each run of spaces and line breaks
/// one space, or " · " where a paragraph ends without a sentence's end (after a title),
/// none at the start or the end. Only its end is kept, and each piece is read
/// once, so what reading a piece costs does not grow with the thought. With `dropsTitles`,
/// a line that is a bold title by itself is left out (the status line above says it:
/// `StatusHeadline`), held back while it may still be one and written as it came once it
/// cannot.
public struct ThoughtLine: Sendable, Equatable {
    /// What reading the thought again changed.
    public enum Change: Sendable, Equatable {
        /// Nothing the line shows.
        case none
        /// That many characters were added at the line's end.
        case added(Int)
        /// The text did not carry on from what was read before: the line started over
        /// with it.
        case startedOver
    }

    /// The end of the line: its last `kept` characters, or up to a quarter more, as its
    /// start is cut in steps rather than at every piece.
    public private(set) var text = ""
    /// How many characters the line has had in all, its start cut off or not: where the
    /// end of `text` is, counted from the thought's start.
    public private(set) var total = 0
    /// How many characters of the line's end are kept.
    public let kept: Int

    /// The characters in `text`, counted as they are written.
    private var count = 0
    /// How much of the thought's text was read, in UTF-8 bytes, and the last few of those
    /// bytes, which tell a thought that carried on from one that is not the same.
    private var readBytes = 0
    private var readEnd: [UInt8] = []
    /// A space or a line break read and not written yet: one space before the next word.
    private var spaceDue = false
    /// The line breaks in that run: two or more end a paragraph (Codex's bold title, then
    /// its text), which is marked " · " unless what came before ends a sentence.
    private var breaksDue = 0
    /// A `*` read and not written yet: with another right after, it is a bold mark and goes.
    private var starDue = false
    /// Whether titles are left out.
    public let dropsTitles: Bool
    /// Nothing but spaces read since the last line break (or the start).
    private var atLineStart = true
    /// A line that may be a title, read and not written yet.
    private var held: String?

    public init(kept: Int = 640, dropsTitles: Bool = false) {
        self.kept = kept
        self.dropsTitles = dropsTitles
    }

    /// Reads the thought's whole text as it is now; only what was added since is looked at.
    public mutating func read(_ thought: String) -> Change {
        let bytes = thought.utf8
        if bytes.count == readBytes, carriesOn(bytes) { return .none }
        guard bytes.count > readBytes, carriesOn(bytes) else {
            self = ThoughtLine(kept: kept, dropsTitles: dropsTitles)
            _ = read(thought)
            return .startedOver
        }
        let start = String.Index(bytes.index(bytes.startIndex, offsetBy: readBytes), within: thought)
            ?? bytes.index(bytes.startIndex, offsetBy: readBytes)
        let before = total
        for character in thought[start...] {
            take(character)
        }
        readBytes = bytes.count
        readEnd = Array(bytes.suffix(8))
        trim()
        return total > before ? .added(total - before) : .none
    }

    /// Whether `bytes` holds what was read so far as its start, as far as its last few
    /// bytes tell.
    private func carriesOn(_ bytes: String.UTF8View) -> Bool {
        guard bytes.count >= readBytes else { return false }
        let start = bytes.index(bytes.startIndex, offsetBy: readBytes - readEnd.count)
        let end = bytes.index(start, offsetBy: readEnd.count)
        return bytes[start..<end].elementsEqual(readEnd)
    }

    private mutating func take(_ character: Character) {
        guard dropsTitles else { return write(raw: character) }
        if var line = held {
            if character.isNewline {
                held = nil
                // A title: left out, its line break kept as the paragraph's.
                if StatusHeadline.title(of: line[...]) == nil { line.forEach { write(raw: $0) } }
                write(raw: character)
                return
            }
            line.append(character)
            guard Self.mayBeTitle(line) else {
                held = nil
                return line.forEach { write(raw: $0) }
            }
            held = line
        } else if atLineStart, character == "*" {
            held = "*"
        } else {
            write(raw: character)
        }
    }

    /// Whether a line that starts so may still be a bold title by itself.
    private static func mayBeTitle(_ line: String) -> Bool {
        guard line.count <= StatusHeadline.longest + 8 else { return false }
        if line == "*" { return true }
        guard line.hasPrefix("**") else { return false }
        let rest = line.dropFirst(2)
        guard let close = rest.range(of: "**") else { return true }
        return close.lowerBound != rest.startIndex && rest[close.upperBound...].allSatisfy(\.isWhitespace)
    }

    /// One character of the thought, as the line takes it.
    private mutating func write(raw character: Character) {
        atLineStart = character.isNewline || (atLineStart && character.isWhitespace)
        if character == "*" {
            // The second of two in a row: a bold mark, which goes with the first.
            starDue.toggle()
            return
        }
        if starDue {
            starDue = false
            write("*")
        }
        if character.isWhitespace {
            spaceDue = true
            if character.isNewline { breaksDue += 1 }
        } else {
            write(character)
        }
    }

    private mutating func write(_ character: Character) {
        if spaceDue, total > 0 {
            let ended = text.last.map { ".:;!?".contains($0) } ?? true
            let gap = breaksDue >= 2 && !ended ? " · " : " "
            text.append(gap)
            count += gap.count
            total += gap.count
        }
        spaceDue = false
        breaksDue = 0
        text.append(character)
        count += 1
        total += 1
    }

    private mutating func trim() {
        guard count > kept + kept / 4 else { return }
        // A piece can end inside a character (a virama, an accent, an emoji's next part come
        // with the next piece), which then joins the one before it in `text`: the count kept
        // as characters are written runs ahead of the text's own, so it is read again (about
        // 800 characters, once every 160 or so) before cutting, and the cut never asks for
        // more than there is.
        count = text.count
        guard count > kept + kept / 4 else { return }
        text.removeFirst(min(count - kept, text.count))
        count = text.count
    }
}

/// How the line of a thought moves as the thought streams in: evenly, never by a jump.
/// Each piece heard starts one even glide from where the line is now to its new end,
/// which the app hands to Core Animation as one linear move, so nothing is worked out
/// again frame by frame.
///
/// - A burst glides in at `even` (70 characters in a little over half a second), never
///   faster than over `shortest`, nor more slowly than over `longest`.
/// - Each glide lasts half as long again as the usual time between pieces, so a steady
///   stream moves on at its own speed without stopping between pieces, a piece late by a
///   little included.
/// - Far behind, the line goes faster: the further, the shorter the glide, so it is never
///   more than about a second behind, nor more than about `farthest / 2` characters while
///   the agent writes 900 characters a second or less.
/// - A piece that would leave it more than `farthest` behind (a whole long paragraph at
///   once) skips to that piece's last `farthest / 2` characters, which then glide in.
public struct ThoughtPace: Sendable, Equatable {
    /// One glide of the line, in characters of it.
    public struct Glide: Sendable, Equatable {
        /// Where it starts: where the line was, or further on when it skipped.
        public var from: Double
        /// Where it ends: the end of the line.
        public var to: Int
        public var duration: TimeInterval
        /// Whether characters were passed over to catch up: the line is shown anew from
        /// `from` rather than going on from where it was.
        public var skipped: Bool

        /// How many characters it has to go.
        public var behind: Double { Double(to) - from }
    }

    /// The pace of a burst, in characters a second: the slowest a reply comes in at
    /// (`ReplyTextView`).
    public static let even: Double = 120
    /// The shortest glide: a word heard alone still slides in.
    public static let shortest: TimeInterval = 0.3
    /// The longest glide.
    public static let longest: TimeInterval = 1
    /// Reduce Motion: the line does not move, its newest words are put in place at most
    /// once in this long.
    public static let calm: TimeInterval = 1

    /// The most characters the line may be behind: what the app holds drawn beyond the
    /// right edge, to glide in.
    public let farthest: Int

    /// Where the line ends, in characters: all it was told of.
    public private(set) var target = 0
    private var from: Double = 0
    private var started: TimeInterval = 0
    private var duration: TimeInterval = 0
    private var lastHeard: TimeInterval?
    /// About how long goes by between pieces, from the last few.
    private var gap: TimeInterval = 0.1

    public init(farthest: Int = 480) {
        self.farthest = max(2, farthest)
    }

    /// Where the line is at `now`, in characters: how much of it has glided in.
    public func shown(at now: TimeInterval) -> Double {
        guard duration > 0 else { return Double(target) }
        let done = min(1, max(0, (now - started) / duration))
        return from + (Double(target) - from) * done
    }

    /// How far it is behind its end at `now`, in characters.
    public func behind(at now: TimeInterval) -> Double {
        Double(target) - shown(at: now)
    }

    /// The line now ends at `total` characters: the glide to there, nil when it did not
    /// grow. A line shorter than before is another thought: it starts over from nothing.
    public mutating func heard(_ total: Int, at now: TimeInterval) -> Glide? {
        if total < target { reset() }
        guard total > target else { return nil }
        if let lastHeard, now - lastHeard < Self.longest {
            gap = (gap + now - lastHeard) / 2
        }
        lastHeard = now
        var start = shown(at: now)
        var skipped = false
        let half = Double(farthest) / 2
        if Double(total) - start > Double(farthest) {
            start = Double(total) - half
            skipped = true
        }
        let behind = Double(total) - start
        let upper = Self.longest * min(1, half / behind)
        let lower = max(Self.shortest, gap * 1.5)
        duration = min(upper, max(lower, behind / Self.even))
        target = total
        from = start
        started = now
        return Glide(from: start, to: total, duration: duration, skipped: skipped)
    }

    /// The line is shown whole, with no glide: a thought already well under way when
    /// the line is first drawn, or with Reduce Motion.
    public mutating func settle(_ total: Int, at now: TimeInterval) {
        target = total
        from = Double(total)
        duration = 0
        started = now
        lastHeard = now
    }

    /// A new thought: nothing shown, nothing heard.
    public mutating func reset() {
        self = ThoughtPace(farthest: farthest)
    }

    /// Reduce Motion: how long to wait before putting the newest words in place, when the
    /// line was last put in place at `last`.
    public static func calmDelay(since last: TimeInterval?, at now: TimeInterval) -> TimeInterval {
        guard let last else { return 0 }
        return max(0, last + calm - now)
    }
}
