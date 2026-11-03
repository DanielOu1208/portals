import Foundation

/// A LaTeX formula in a reply: inline between `$` or `\(` and `\)`, display between `$$`
/// or `\[` and `\]`.
public struct MathFormula: Hashable, Sendable {
    /// The LaTeX between the delimiters, without the spaces around it.
    public var latex: String
    /// A display formula stands on its own line; an inline one sits in the text.
    public var isDisplay: Bool
    /// The formula as written, delimiters included: what is copied, and what shows when
    /// it cannot be typeset.
    public var source: String

    public init(latex: String, isDisplay: Bool, source: String) {
        self.latex = latex
        self.isDisplay = isDisplay
        self.source = source
    }
}

/// Marks the characters of a block's text that are a formula. They are the formula's
/// source, so a block's plain text keeps it as written.
public enum MathFormulaAttribute: AttributedStringKey {
    public typealias Value = MathFormula
    public static let name = "AgentCore.mathFormula"
}

extension AttributeScopes {
    public struct AgentCoreAttributes: AttributeScope {
        public let mathFormula: MathFormulaAttribute
        public let fileMention: FileMentionAttribute
    }

    public var agentCore: AgentCoreAttributes.Type { AgentCoreAttributes.self }
}

extension AttributeDynamicLookup {
    public subscript<T: AttributedStringKey>(dynamicMember keyPath: KeyPath<AttributeScopes.AgentCoreAttributes, T>) -> T {
        self[T.self]
    }
}

extension MarkdownBlock {
    /// A stretch of a block's text as it is laid out: text, or a display formula that
    /// stands between lines of it.
    public enum Piece: Hashable, Sendable {
        case text(AttributedString)
        case formula(MathFormula)
    }

    /// The block's text cut at its display formulas, without the spaces either side of
    /// each cut. Just the text when it has none.
    public var pieces: [Piece] {
        guard text.runs.contains(where: { $0.mathFormula?.isDisplay == true }) else { return [.text(text)] }
        var pieces: [Piece] = []
        var pending = AttributedString()
        func flush() {
            let trimmed = pending.trimmingWhitespace()
            if !trimmed.characters.isEmpty { pieces.append(.text(trimmed)) }
            pending = AttributedString()
        }
        for run in text.runs {
            if let formula = run.mathFormula, formula.isDisplay {
                flush()
                pieces.append(.formula(formula))
            } else {
                pending.append(text[run.range])
            }
        }
        flush()
        return pieces
    }
}

extension AttributedString {
    /// Without the whitespace at either end.
    func trimmingWhitespace() -> AttributedString {
        let characters = self.characters
        guard let first = characters.firstIndex(where: { !$0.isWhitespace }),
              let last = characters.lastIndex(where: { !$0.isWhitespace }) else { return AttributedString() }
        return AttributedString(self[first...last])
    }
}

/// Finds the formulas in a reply and keeps them away from the Markdown parser, which
/// would take a formula's underscores for emphasis and eat its backslashes. Each one is
/// swapped for a placeholder character before parsing and given back afterwards, as its
/// source marked with `MathFormulaAttribute`.
///
/// The rules are pandoc's: an opening `$` has a non-space after it, a closing `$` a
/// non-space before it and no digit after it, so "$5 and $10" stays text. No formula
/// spans a blank line or holds a backtick. Code spans, fenced code and URLs are left
/// alone.
struct MathProtection {
    /// What a placeholder stands for: a formula, or text that is shown as written
    /// because its formula has not closed yet.
    struct Span {
        var source: String
        var formula: MathFormula?
    }

    /// The source with each span replaced by its placeholder.
    let text: String
    let spans: [Span]

    /// Placeholders are characters of the supplementary private use area, one per span,
    /// numbered from here.
    private static let firstPlaceholder: UInt32 = 0xF0000
    private static let lastPlaceholder: UInt32 = 0xFFFFD

    init(_ source: String) {
        // Nothing to find; or placeholders already in the text, which would be mistaken
        // for spans.
        guard source.contains("$") || source.contains("\\"),
              !source.unicodeScalars.contains(where: { Self.isPlaceholder($0) }) else {
            text = source
            spans = []
            return
        }
        var scanner = Scanner(lines: source.split(separator: "\n", omittingEmptySubsequences: false))
        scanner.run()
        text = scanner.output
        spans = scanner.spans
    }

    private static func isPlaceholder(_ scalar: Unicode.Scalar) -> Bool {
        (firstPlaceholder...lastPlaceholder).contains(scalar.value)
    }

    private func span(for character: Character) -> Span? {
        guard let scalar = character.unicodeScalars.first, Self.isPlaceholder(scalar) else { return nil }
        let index = Int(scalar.value - Self.firstPlaceholder)
        return spans.indices.contains(index) ? spans[index] : nil
    }

    /// `text` with its placeholders given back as their sources, each marked as a
    /// formula unless it is code.
    func restoring(_ text: AttributedString) -> AttributedString {
        guard !spans.isEmpty else { return text }
        var restored = AttributedString()
        var copied = text.startIndex
        for index in text.characters.indices {
            guard let span = span(for: text.characters[index]) else { continue }
            let after = text.characters.index(after: index)
            restored.append(text[copied..<index])
            var replacement = AttributedString(span.source, attributes: text[index..<after].runs.first?.attributes ?? AttributeContainer())
            let isCode = replacement.runs.first?.inlinePresentationIntent?.contains(.code) == true
            if let formula = span.formula, !isCode {
                replacement.mathFormula = formula
            }
            restored.append(replacement)
            copied = after
        }
        restored.append(text[copied...])
        return restored
    }

    /// `text` with its placeholders given back as their sources, unmarked: for code.
    func restoring(_ text: String) -> String {
        guard !spans.isEmpty else { return text }
        var restored = ""
        for character in text {
            if let span = span(for: character) {
                restored += span.source
            } else {
                restored.append(character)
            }
        }
        return restored
    }

    // MARK: Scanning

    private struct Scanner {
        let lines: [Substring]
        var output = ""
        var spans: [Span] = []

        init(lines: [Substring]) {
            self.lines = lines
        }

        mutating func run() {
            // Fenced code goes through as it is; the prose between fences is scanned a
            // stretch at a time, so no formula reaches into code.
            let inCode = Markdown.fencedLines(lines).inCode
            var start = 0
            while start < lines.count {
                var end = start
                while end < lines.count, inCode[end] == inCode[start] { end += 1 }
                let stretch = lines[start..<end].joined(separator: "\n")
                if start > 0 { output += "\n" }
                if inCode[start] {
                    output += stretch
                } else {
                    scan(Array(stretch), isLast: end == lines.count)
                }
                start = end
            }
        }

        /// Puts a placeholder for `text[start..<end]` in the output. `source` is what it
        /// stands for, when that differs from the text.
        private mutating func emit(_ text: [Character], from start: Int, to end: Int, source: String? = nil, formula: MathFormula?) {
            guard let scalar = Unicode.Scalar(MathProtection.firstPlaceholder + UInt32(spans.count)),
                  scalar.value <= MathProtection.lastPlaceholder else {
                output += String(text[start..<end])
                return
            }
            spans.append(Span(source: source ?? String(text[start..<end]), formula: formula))
            output.unicodeScalars.append(scalar)
        }

        /// `isLast`: whether this prose runs to the end of the reply, where a formula
        /// that has not closed may still be on its way.
        private mutating func scan(_ text: [Character], isLast: Bool) {
            var index = 0
            while index < text.count {
                let character = text[index]
                let next = index + 1 < text.count ? text[index + 1] : nil
                if character == "`" {
                    let end = Self.codeSpanEnd(in: text, from: index)
                    output += String(text[index..<end])
                    index = end
                    continue
                }
                if let end = Self.urlEnd(in: text, from: index) {
                    output += String(text[index..<end])
                    index = end
                    continue
                }
                let found: Found?
                switch (character, next) {
                case ("\\", "("):
                    found = Self.closed(in: text, from: index, opener: 2, closer: [#"\"#, ")"], isDisplay: false)
                case ("\\", "["):
                    found = Self.closed(in: text, from: index, opener: 2, closer: [#"\"#, "]"], isDisplay: true)
                case ("$", "$"):
                    found = Self.closed(in: text, from: index, opener: 2, closer: ["$", "$"], isDisplay: true)
                case ("$", _):
                    found = Self.inlineDollar(in: text, from: index)
                default:
                    found = nil
                }
                switch found {
                case let .formula(formula, end):
                    emit(text, from: index, to: end, source: formula.source, formula: formula)
                    index = end
                case .unclosed where isLast:
                    // Shown as written until it closes, so that half a formula is not
                    // set as Markdown. Trailing space stays outside, as the parser
                    // would drop it.
                    var end = text.count
                    while end > index, text[end - 1].isWhitespace { end -= 1 }
                    emit(text, from: index, to: end, source: Self.source(in: text, from: index, to: end), formula: nil)
                    output += String(text[end...])
                    index = text.count
                case .unclosed, nil:
                    if character == "\\" || (character == "$" && next == "$") {
                        // An escape, or a pair of dollars that opens nothing: both
                        // characters go through, so the second starts nothing either.
                        output += String(text[index..<min(index + 2, text.count)])
                        index += 2
                    } else {
                        output.append(character)
                        index += 1
                    }
                }
            }
        }

        private enum Found {
            case formula(MathFormula, end: Int)
            /// No closer before the text ends, and nothing that rules one out.
            case unclosed
        }

        /// Where a code span that starts at `start` ends: after its closing backticks, or
        /// after its opening ones when it does not close.
        private static func codeSpanEnd(in text: [Character], from start: Int) -> Int {
            var opened = start
            while opened < text.count, text[opened] == "`" { opened += 1 }
            let length = opened - start
            var index = opened
            while index < text.count {
                if isBlankLine(in: text, at: index) { break }
                guard text[index] == "`" else {
                    index += 1
                    continue
                }
                var run = index
                while run < text.count, text[run] == "`" { run += 1 }
                if run - index == length { return run }
                index = run
            }
            return opened
        }

        /// Where a URL that starts at `start` ends, if one does: a link's destination
        /// after its `](`, an autolink in angle brackets, or a bare web address. Their
        /// dollars and backslashes are part of the address (`?$top=10&$skip=5`), and a
        /// placeholder in one would break the link.
        private static func urlEnd(in text: [Character], from start: Int) -> Int? {
            switch text[start] {
            case "]":
                guard start + 1 < text.count, text[start + 1] == "(" else { return nil }
                var depth = 0
                var index = start + 1
                while index < text.count, !isBlankLine(in: text, at: index) {
                    switch text[index] {
                    case "(":
                        depth += 1
                    case ")":
                        depth -= 1
                        if depth == 0 { return index + 1 }
                    case "\\":
                        index += 1
                    default:
                        break
                    }
                    index += 1
                }
                return nil
            case "<":
                // A scheme of two letters or more, a colon, and no spaces up to the `>`.
                var index = start + 1
                while index < text.count, text[index].isASCII, text[index].isLetter || text[index].isNumber || "+.-".contains(text[index]) {
                    index += 1
                }
                guard index - start > 2, text[start + 1].isLetter, index < text.count, text[index] == ":" else { return nil }
                while index < text.count, text[index] != ">", text[index] != "<", !text[index].isWhitespace { index += 1 }
                return index < text.count && text[index] == ">" ? index + 1 : nil
            case "h":
                guard start == 0 || !(text[start - 1].isLetter || text[start - 1].isNumber) else { return nil }
                let scheme = String(text[start..<min(start + 8, text.count)])
                guard scheme.hasPrefix("http://") || scheme.hasPrefix("https://") else { return nil }
                var index = start
                while index < text.count, !text[index].isWhitespace, text[index] != "<", text[index] != ">" { index += 1 }
                return index
            default:
                return nil
            }
        }

        /// Whether a newline at `index` ends a paragraph: the line after it is blank.
        private static func isBlankLine(in text: [Character], at index: Int) -> Bool {
            guard text[index].isNewline else { return false }
            var next = index + 1
            while next < text.count, text[next] == " " || text[next] == "\t" { next += 1 }
            return next < text.count && text[next].isNewline
        }

        /// What `text[start..<end]` says. Written over several lines of a quote, the lines
        /// after the first begin with the quote's `>`, which belong to the quote: the
        /// parser takes them off the text around it, and they are taken off here.
        private static func source(in text: [Character], from start: Int, to end: Int) -> String {
            let written = String(text[start..<end])
            guard written.contains(where: \.isNewline) else { return written }
            var lineStart = start
            while lineStart > 0, !text[lineStart - 1].isNewline { lineStart -= 1 }
            let depth = text[lineStart..<start].prefix { $0 == ">" || $0 == " " || $0 == "\t" }.filter { $0 == ">" }.count
            guard depth > 0 else { return written }
            return written.split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { number, line in
                guard number > 0 else { return line }
                var rest = line.drop { $0 == " " || $0 == "\t" }
                for _ in 0..<depth where rest.first == ">" {
                    rest = rest.dropFirst()
                    if rest.first == " " { rest = rest.dropFirst() }
                }
                return rest
            }
            .joined(separator: "\n")
        }

        /// The formula in `text[start..<end]`, whose delimiters are `opener` and `closer`
        /// characters long; nil when there is nothing between them.
        private static func formula(in text: [Character], from start: Int, to end: Int, opener: Int, closer: Int, isDisplay: Bool) -> Found? {
            let source = source(in: text, from: start, to: end)
            let latex = String(source.dropFirst(opener).dropLast(closer)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !latex.isEmpty else { return nil }
            return .formula(MathFormula(latex: latex, isDisplay: isDisplay, source: source), end: end)
        }

        /// A formula whose delimiters may have spaces inside them: `$$`, `\[` and `\(`.
        private static func closed(in text: [Character], from start: Int, opener: Int, closer: [Character], isDisplay: Bool) -> Found? {
            var index = start + opener
            while index < text.count {
                let character = text[index]
                if character == "`" || isBlankLine(in: text, at: index) { return nil }
                if character == closer[0], index + 1 < text.count, text[index + 1] == closer[1] {
                    return formula(in: text, from: start, to: index + 2, opener: opener, closer: 2, isDisplay: isDisplay)
                }
                // An escaped character cannot close the formula.
                index += character == "\\" ? 2 : 1
            }
            return .unclosed
        }

        /// An inline formula between single dollars, by pandoc's rules: the first dollar
        /// after the opening one decides.
        private static func inlineDollar(in text: [Character], from start: Int) -> Found? {
            guard start + 1 < text.count, !text[start + 1].isWhitespace else { return nil }
            var index = start + 1
            while index < text.count {
                let character = text[index]
                if character == "`" || isBlankLine(in: text, at: index) { return nil }
                if character == "\\" {
                    index += 2
                    continue
                }
                if character == "$" {
                    let isAfterSpace = text[index - 1].isWhitespace
                    let isBeforeDigit = index + 1 < text.count && text[index + 1].isNumber
                    guard !isAfterSpace, !isBeforeDigit else { return nil }
                    return formula(in: text, from: start, to: index + 1, opener: 1, closer: 1, isDisplay: false)
                }
                index += 1
            }
            return nil
        }
    }
}
