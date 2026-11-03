import Foundation

/// Parses a reply that is being written, block by block, without parsing all of it again
/// at every step: what lies before the last point where a new block has to start is
/// kept with its blocks, and only what follows is parsed again. Its blocks are what
/// `Markdown.blocks` gives for the whole text, ids included.
///
/// Parsing the whole reply at every step of its reveal cost the Mac app a tenth of its
/// main thread at the end of a long reply, and grew with it (docs/perf-mac-scroll.md).
///
/// A point where a new block has to start (a cut) is a blank line outside fenced code,
/// followed by a whole line that starts in the first column and is neither a list item
/// nor a fence. A formula and a code span never run over a blank line
/// (`MathProtection`), a paragraph, a quote, a table and a list item end at one, and a
/// line in the first column that is not a list item ends a list: what can still run on
/// is fenced code. Fences are followed line by line as `Markdown.fencedLines` follows
/// them (it decides what is kept from formulas, and closes a fence left open), and the
/// parser is asked once at each new cut whether the text parsed in two there gives what
/// it gives in one: where a line only looks like a fence to that count (indented code,
/// a fence after a list item's marker), it does not, and from there on the reply is
/// parsed whole, the count being no longer to be trusted.
///
/// What a cut cannot keep apart is parsed whole for as long as the text carries on: a
/// reply with what may be a link or footnote definition (a link before one points to
/// it, in a quote or a list item too), an HTML block that runs over blank lines (not
/// looked for inside a fence the parser cannot see otherwise, where a widget's HTML
/// and CSS would look like both),
/// Windows line ends, a byte order mark (the parser leaves one out at the start of a
/// text, so a definition after it would not be seen as one here), or a character the
/// formulas' placeholders use (one anywhere leaves every formula unset).
///
/// Each step reads only the lines added since the step before, so a reply with no cut
/// (one long paragraph, a long list, a code block still open) costs what a whole parse
/// costs, and one with cuts costs what its last blocks cost.
public struct MarkdownStream: Sendable {
    /// The text given last: a text that starts with it carries on from it.
    private var last = ""
    /// How much of the text, in UTF-8 bytes, has been cut off and parsed.
    private var settledLength = 0
    private var settledBlocks: [MarkdownBlock] = []
    /// What the lines read so far say.
    private var lines = Lines()
    /// The text is parsed whole from now on, for as long as it carries on.
    private var parsesWhole = false

    public init() {}

    /// How many of the blocks last given are kept from the parse before: they are the
    /// very values given then.
    public var settledCount: Int { settledBlocks.count }

    /// How many times a text that did not carry on from the one before made it start over,
    /// its settled blocks with it: while this stays the same, a settled block is given
    /// again as it was, and a view of it need not be compared (`MarkdownBlocksView`).
    public private(set) var startedOver = 0

    /// Whether the text is parsed whole until it no longer carries on.
    var isParsingWhole: Bool { parsesWhole }

    /// The blocks of `source`, as `Markdown.blocks(source)` gives them.
    public mutating func blocks(_ source: String) -> [MarkdownBlock] {
        if !Self.carriesOn(source, from: last) {
            let count = startedOver
            self = MarkdownStream()
            startedOver = count + 1
        }
        last = source
        if !parsesWhole {
            parsesWhole = Self.withBytes(source) { lines.read($0) }
        }
        guard !parsesWhole else {
            settledLength = 0
            settledBlocks = []
            return Markdown.blocks(source)
        }
        let tail = Self.text(of: source, from: settledLength)
        guard let cut = lines.cut, cut > settledLength else {
            return settledBlocks + Self.numbered(Markdown.blocks(tail), from: settledBlocks.count)
        }
        let before = Markdown.blocks(Self.text(of: source, from: settledLength, to: cut))
        let after = Markdown.blocks(Self.text(of: source, from: cut))
        let whole = Markdown.blocks(tail)
        guard before + Self.numbered(after, from: before.count) == whole else {
            // The parser does not see the fences as they were counted: no later cut can
            // be trusted either, and asking at each would cost two parses more a time.
            // What is settled is still right, and gives this step's blocks with `whole`.
            let blocks = settledBlocks + Self.numbered(whole, from: settledBlocks.count)
            parsesWhole = true
            settledLength = 0
            settledBlocks = []
            return blocks
        }
        settledBlocks += Self.numbered(before, from: settledBlocks.count)
        settledLength = cut
        return settledBlocks + Self.numbered(after, from: settledBlocks.count)
    }

    private static func numbered(_ blocks: [MarkdownBlock], from first: Int) -> [MarkdownBlock] {
        guard first > 0 else { return blocks }
        var blocks = blocks
        for index in blocks.indices { blocks[index].id = first + index }
        return blocks
    }

    /// Whether `source` starts with `last`, byte for byte.
    private static func carriesOn(_ source: String, from last: String) -> Bool {
        let count = last.utf8.count
        guard count > 0 else { return true }
        guard source.utf8.count >= count else { return false }
        return withBytes(source) { new in
            withBytes(last) { old in memcmp(new.baseAddress!, old.baseAddress!, count) == 0 }
        }
    }

    /// The text from one UTF-8 offset to another; both are at the start of a line.
    private static func text(of source: String, from start: Int, to end: Int? = nil) -> String {
        let utf8 = source.utf8
        let from = utf8.index(utf8.startIndex, offsetBy: start)
        guard let end else { return String(source[from...]) }
        return String(source[from..<utf8.index(utf8.startIndex, offsetBy: end)])
    }

    private static func withBytes<Result>(_ text: String, _ body: (UnsafeBufferPointer<UInt8>) -> Result) -> Result {
        if let result = text.utf8.withContiguousStorageIfAvailable(body) { return result }
        var copy = text
        copy.makeContiguousUTF8()
        return copy.utf8.withContiguousStorageIfAvailable(body)!
    }

    /// The lines of the text read so far, one at a time as each is finished: where the
    /// last cut is, and whether the text has to be parsed whole.
    struct Lines: Sendable {
        /// Where the first line not yet read starts, in UTF-8 bytes.
        private var next = 0
        /// How far the text has been looked through for carriage returns, byte order
        /// marks and placeholders.
        private var checked = 0
        private var fence: Markdown.Fence?
        /// Whether the open fence is surely one to the parser as well, and its lines
        /// code: it opened in the first column while `fencesAreSure`. Inside it no line
        /// can define a link or open an HTML block, so none is looked for: a widget's
        /// `<style>`, `<script>` or `[data-x]:hover` had the whole reply parsed at every
        /// step.
        private var fenceIsSure = false
        /// Whether the fences counted so far are the parser's, as far as a line can
        /// tell: false from the first line that may make the two differ (a fence after
        /// a list item's marker or a quote mark, a fence indented, a line of backticks
        /// indented as code, backticks in a fence's info string, a line that may open
        /// an HTML block) to the end of the text.
        private var fencesAreSure = true
        private var afterBlank = false
        /// In a paragraph one of whose lines starts with `[`, after any quote or list
        /// marks: a link definition may be on its way, its label over several lines.
        private var mayDefine = false
        /// The start of the last line a cut was found before.
        private(set) var cut: Int?

        /// Reads what was added to the text; true when it has to be parsed whole.
        mutating func read(_ bytes: UnsafeBufferPointer<UInt8>) -> Bool {
            for index in checked..<bytes.count {
                switch bytes[index] {
                case UInt8(ascii: "\r"):
                    return true
                // U+F0000 to U+FFFFF: the formulas' placeholders are among them.
                case 0xF3 where index + 1 < bytes.count && bytes[index + 1] >= 0xB0:
                    return true
                // U+FEFF, a byte order mark.
                case 0xEF where index + 2 < bytes.count && bytes[index + 1] == 0xBB && bytes[index + 2] == 0xBF:
                    return true
                default:
                    continue
                }
            }
            checked = bytes.count
            while let newline = Self.index(of: UInt8(ascii: "\n"), in: bytes, from: next) {
                if line(bytes, from: next, to: newline) { return true }
                next = newline + 1
            }
            // The line still being written: a definition in it already applies to the
            // blocks above.
            if fence != nil, fenceIsSure, fencesAreSure { return false }
            return Self.defines(bytes, from: next, to: bytes.count, inParagraph: mayDefine)
        }

        /// Reads a whole line; true when the text has to be parsed whole.
        private mutating func line(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> Bool {
            var first = start
            while first < end, bytes[first] == UInt8(ascii: " ") { first += 1 }
            let isBlank = (start..<end).allSatisfy { bytes[$0] == UInt8(ascii: " ") || bytes[$0] == UInt8(ascii: "\t") }
            let inSureFence = fence != nil && fenceIsSure && fencesAreSure
            if isBlank {
                mayDefine = false
            } else if !inSureFence {
                if Self.startsDefinition(bytes, from: start, to: end) { mayDefine = true }
                if Self.defines(bytes, from: start, to: end, inParagraph: mayDefine) { return true }
                if Self.startsLongHTML(bytes, from: start, to: end) { return true }
            }
            if fence == nil, fencesAreSure, Self.mayShakeFences(bytes, from: start, first: first, to: end) {
                fencesAreSure = false
            }
            if first < end, bytes[first] == UInt8(ascii: "`") || bytes[first] == UInt8(ascii: "~") {
                let wasOpen = fence != nil
                let text = Self.string(bytes, from: start, to: end)
                Markdown.fence(Substring(text), &fence)
                if first - start >= 4, wasOpen || fence != nil {
                    // A line of backticks indented as code: a fence to the count, not to
                    // the parser.
                    fencesAreSure = false
                }
                if !wasOpen, let opened = fence {
                    let info = text.drop { $0 == " " }.drop { $0 == opened.marker }
                    if first > start || (opened.marker == "`" && info.contains("`")) { fencesAreSure = false }
                    fenceIsSure = fencesAreSure
                }
                if wasOpen || fence != nil {
                    afterBlank = false
                    return false
                }
            }
            if fence != nil {
                afterBlank = false
            } else if isBlank {
                afterBlank = true
            } else {
                let column0 = bytes[start]
                if afterBlank, column0 != UInt8(ascii: " "), column0 != UInt8(ascii: "\t"), Self.listMarkerEnd(bytes, from: start, to: end) == nil {
                    cut = start
                }
                afterBlank = false
            }
            return false
        }

        /// Whether a line outside fenced code may have the parser count fences otherwise
        /// from here on: it opens a fence after a quote mark or a list item's marker, or
        /// starts with `<`, which may open an HTML block a fence's line is part of.
        private static func mayShakeFences(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, first: Int, to end: Int) -> Bool {
            guard first < end else { return false }
            if bytes[first] == UInt8(ascii: "<") { return true }
            var index = first
            var marked = false
            while index < end {
                if bytes[index] == UInt8(ascii: ">") {
                    index += 1
                } else if let after = listMarkerEnd(bytes, from: index, to: end), after > index {
                    index = after
                } else {
                    break
                }
                marked = true
                while index < end, bytes[index] == UInt8(ascii: " ") || bytes[index] == UInt8(ascii: "\t") { index += 1 }
            }
            guard marked, index + 2 < end else { return false }
            let marker = bytes[index]
            return (marker == UInt8(ascii: "`") || marker == UInt8(ascii: "~")) && bytes[index + 1] == marker && bytes[index + 2] == marker
        }

        /// Whether a line starts with `[` once its spaces, quote marks and list markers
        /// are left out.
        private static func startsDefinition(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> Bool {
            bracket(bytes, from: start, to: end) != nil
        }

        /// Where the `[` a definition would start with is in a line, after its spaces,
        /// quote marks and list markers.
        private static func bracket(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> Int? {
            var index = start
            while index < end {
                switch bytes[index] {
                case UInt8(ascii: " "), UInt8(ascii: "\t"), UInt8(ascii: ">"):
                    index += 1
                case UInt8(ascii: "["):
                    return index
                default:
                    guard let after = listMarkerEnd(bytes, from: index, to: end), after > index else { return nil }
                    index = after
                }
            }
            return nil
        }

        /// Whether a definition may be in a line: `]:` after the `[` it starts with, or
        /// anywhere in it when an earlier line of its paragraph started with one.
        private static func defines(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int, inParagraph: Bool) -> Bool {
            guard let from = inParagraph ? start : bracket(bytes, from: start, to: end) else { return false }
            var index = from
            while index + 1 < end {
                if bytes[index] == UInt8(ascii: "]"), bytes[index + 1] == UInt8(ascii: ":") { return true }
                index += 1
            }
            return false
        }

        /// Whether a line opens an HTML block that runs over blank lines: a comment, a
        /// processing instruction, a declaration, `<pre>`, `<script>`, `<style>` or
        /// `<textarea>`.
        private static func startsLongHTML(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> Bool {
            var index = start
            while index < end, bytes[index] == UInt8(ascii: " ") || bytes[index] == UInt8(ascii: "\t") { index += 1 }
            guard index < end, bytes[index] == UInt8(ascii: "<") else { return false }
            let opening = string(bytes, from: index, to: min(end, index + 10)).lowercased()
            return ["<!--", "<?", "<!", "<pre", "<script", "<style", "<textarea"].contains(where: opening.hasPrefix)
        }

        /// Where a list item's marker ends, after the space or tab that follows it, if the
        /// line starts with one: `-`, `+` or `*`, or a number of up to nine digits with `.`
        /// or `)`, then a space, a tab or the line's end. A thematic break of stars or
        /// dashes counts too, which only means no cut is made before it.
        static func listMarkerEnd(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> Int? {
            guard start < end else { return nil }
            var index = start
            switch bytes[index] {
            case UInt8(ascii: "-"), UInt8(ascii: "+"), UInt8(ascii: "*"):
                index += 1
            default:
                while index < end, index - start < 10, bytes[index] >= UInt8(ascii: "0"), bytes[index] <= UInt8(ascii: "9") { index += 1 }
                let digits = index - start
                guard digits > 0, digits <= 9, index < end, bytes[index] == UInt8(ascii: ".") || bytes[index] == UInt8(ascii: ")") else { return nil }
                index += 1
            }
            guard index < end else { return index }
            guard bytes[index] == UInt8(ascii: " ") || bytes[index] == UInt8(ascii: "\t") else { return nil }
            return index + 1
        }

        private static func index(of byte: UInt8, in bytes: UnsafeBufferPointer<UInt8>, from start: Int) -> Int? {
            guard start < bytes.count, let base = bytes.baseAddress,
                  let found = memchr(base + start, Int32(byte), bytes.count - start) else { return nil }
            return base.distance(to: found.assumingMemoryBound(to: UInt8.self))
        }

        private static func string(_ bytes: UnsafeBufferPointer<UInt8>, from start: Int, to end: Int) -> String {
            String(decoding: UnsafeBufferPointer(rebasing: bytes[start..<end]), as: UTF8.self)
        }
    }
}
