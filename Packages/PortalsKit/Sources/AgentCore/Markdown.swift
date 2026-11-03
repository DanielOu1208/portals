import Foundation

/// One block of a Markdown reply, ready to lay out.
public struct MarkdownBlock: Identifiable, Hashable, Sendable {
    public enum ListMarker: Hashable, Sendable {
        case bullet
        case number(Int)
        /// A further paragraph of an item that already has its marker.
        case none
    }

    public enum Kind: Hashable, Sendable {
        case paragraph
        case heading(level: Int)
        /// A fenced or indented code block. `text` is the code, unstyled.
        case code(language: String?)
        /// `depth` is 1 for a top-level item.
        case listItem(ListMarker, depth: Int)
        case quote
        case rule
        case table(MarkdownTable)
        /// A fenced code block at the top level whose language is `portals-widget`:
        /// HTML the app draws as a card (`MarkdownWidget`). `text` is empty.
        case widget(MarkdownWidget)
        /// A Markdown image of a file in a paragraph at the top level, which the app draws
        /// (`MarkdownImage`). `text` is empty.
        case image(MarkdownImage)
    }

    /// Position in the reply. Stable while a reply streams, since blocks only get added.
    public var id: Int
    public var kind: Kind
    /// The block's text with its inline styling (bold, italic, code, links). Empty for a
    /// rule, a table or a widget.
    public var text: AttributedString

    public init(id: Int, kind: Kind, text: AttributedString = AttributedString()) {
        self.id = id
        self.kind = kind
        self.text = text
    }

    public var plainText: String { String(text.characters) }
}

public struct MarkdownTable: Hashable, Sendable {
    public var header: [AttributedString]
    public var rows: [[AttributedString]]

    public init(header: [AttributedString] = [], rows: [[AttributedString]] = []) {
        self.header = header
        self.rows = rows
    }

    public var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }
}

/// Splits Markdown into blocks with Foundation's parser, which handles CommonMark plus
/// tables. Safe to call on a reply that is still streaming.
public enum Markdown {
    /// The reply as plain text, for selecting part of it: what it says, without the
    /// marks that style it. Lists keep a bullet or number, tables a tab between cells.
    public static func plainText(_ source: String) -> String {
        var text = ""
        var previous: MarkdownBlock.Kind?
        for block in blocks(source) {
            let line: String
            switch block.kind {
            case let .listItem(marker, depth):
                let indent = String(repeating: "    ", count: max(depth - 1, 0))
                let prefix = switch marker {
                case .bullet: "• "
                case let .number(number): "\(number). "
                case .none: "  "
                }
                line = indent + prefix + block.plainText
            case .rule:
                line = "———"
            case let .widget(widget):
                line = widget.name
            case let .image(image):
                line = image.name
            case let .table(table):
                line = ([table.header] + table.rows)
                    .filter { !$0.isEmpty }
                    .map { row in row.map { String($0.characters) }.joined(separator: "\t") }
                    .joined(separator: "\n")
            default:
                line = block.plainText
            }
            if let previous {
                // A list's items follow each other line by line; other blocks have a
                // blank line between them.
                let bothItems = if case .listItem = previous, case .listItem = block.kind { true } else { false }
                text += bothItems ? "\n" : "\n\n"
            }
            text += line
            previous = block.kind
        }
        return text
    }

    public static func blocks(_ source: String) -> [MarkdownBlock] {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        let (_, open, openedAt) = fencedLines(lines)
        let prepared = open.map { closing(source, $0) } ?? source
        guard !prepared.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let math = MathProtection(prepared)
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard let parsed = try? AttributedString(markdown: math.text, options: options) else {
            return [MarkdownBlock(id: 0, kind: .paragraph, text: AttributedString(source))]
        }

        var blocks: [MarkdownBlock] = []
        /// The innermost component of a run names its block.
        var blockByIdentity: [Int: Int] = [:]
        var tables: [Int: TableBuilder] = [:]
        var markedItems: Set<Int> = []

        for run in parsed.runs {
            let piece = AttributedString(parsed[run.range])
            guard let components = run.presentationIntent?.components, let innermost = components.first else {
                // Text outside any block: keep it rather than lose it.
                if blocks.last?.kind == .paragraph {
                    blocks[blocks.count - 1].text.append(piece)
                } else {
                    blocks.append(MarkdownBlock(id: blocks.count, kind: .paragraph, text: piece))
                }
                continue
            }

            if case let .tableCell(column) = innermost.kind {
                guard let table = components.first(where: { if case .table = $0.kind { true } else { false } }) else { continue }
                if tables[table.identity] == nil {
                    tables[table.identity] = TableBuilder(blockIndex: blocks.count)
                    blocks.append(MarkdownBlock(id: blocks.count, kind: .table(MarkdownTable())))
                }
                let row = components.lazy.compactMap { component -> Int? in
                    switch component.kind {
                    case .tableHeaderRow: TableBuilder.headerRow
                    case let .tableRow(index): index
                    default: nil
                    }
                }.first ?? TableBuilder.headerRow
                tables[table.identity]?.append(piece, row: row, column: column)
                continue
            }

            if let index = blockByIdentity[innermost.identity] {
                blocks[index].text.append(piece)
            } else {
                blockByIdentity[innermost.identity] = blocks.count
                blocks.append(MarkdownBlock(id: blocks.count, kind: kind(of: components, markedItems: &markedItems), text: piece))
            }
        }

        for builder in tables.values {
            blocks[builder.blockIndex].kind = .table(builder.table)
        }
        for index in blocks.indices {
            switch blocks[index].kind {
            case .code:
                // Unstyled, and without the newline that ends the last line.
                var code = math.restoring(blocks[index].plainText)
                if code.hasSuffix("\n") { code.removeLast() }
                blocks[index].text = AttributedString(code)
            case var .widget(widget):
                // The HTML as written, and nothing to draw as text.
                var code = math.restoring(blocks[index].plainText)
                if code.hasSuffix("\n") { code.removeLast() }
                widget.source = code
                blocks[index].kind = .widget(widget)
                blocks[index].text = AttributedString()
            case .rule:
                blocks[index].text = AttributedString()
            case var .table(table):
                table.header = table.header.map { math.restoring(withoutBlockMarks($0)) }
                table.rows = table.rows.map { $0.map { math.restoring(withoutBlockMarks($0)) } }
                blocks[index].kind = .table(table)
            default:
                blocks[index].text = math.restoring(withoutBlockMarks(blocks[index].text))
            }
        }
        // A visual's fence still open is the last block's (a blank one's, when nothing is
        // in it yet): that visual is not finished yet. Not so a visual that has ended, with
        // the fence of other code, or of a visual with nothing in it, opened after it.
        if let open, open.visual, let openedAt, let last = blocks.indices.last, case var .widget(widget) = blocks[last].kind,
           widget.source.allSatisfy(\.isWhitespace) || lines[(openedAt + 1)...].contains(where: { !$0.allSatisfy(\.isWhitespace) }) {
            widget.isComplete = false
            blocks[last].kind = .widget(widget)
        }
        return withImages(blocks)
    }

    /// Without the parser's marks of which block each run is in. They number the blocks
    /// of the whole text, which nothing drawn reads, and would make a block parsed from
    /// the end of a reply (`MarkdownStream`) differ from the same block parsed with all
    /// of it.
    private static func withoutBlockMarks(_ text: AttributedString) -> AttributedString {
        var text = text
        text.presentationIntent = nil
        if #available(macOS 26, *) { text.listItemDelimiter = nil }
        return text
    }

    /// While a reply streams, a code block has its opening fence long before its closing
    /// one. Closing it here keeps the half-written code a code block instead of letting
    /// it reflow as prose.
    static func closingOpenFence(_ source: String) -> String {
        guard let open = fencedLines(source.split(separator: "\n", omittingEmptySubsequences: false)).open else { return source }
        return closing(source, open)
    }

    private static func closing(_ source: String, _ open: Fence) -> String {
        source + (source.hasSuffix("\n") ? "" : "\n") + String(repeating: open.marker, count: open.length)
    }

    /// A fence of code: its mark, how many, how far its opening line is indented, and
    /// whether it opens a visual (```portals-visual …).
    typealias Fence = (marker: Character, length: Int, indent: Int, visual: Bool)

    /// Which lines are inside fenced code, the fences included, the fence still open
    /// after the last line, and the line it opened on.
    static func fencedLines(_ lines: [Substring]) -> (inCode: [Bool], open: Fence?, openedAt: Int?) {
        var open: Fence?
        var openedAt: Int?
        var inCode: [Bool] = []
        for (index, line) in lines.enumerated() {
            let wasOpen = open != nil
            fence(line, &open)
            if !wasOpen, open != nil { openedAt = index }
            inCode.append(wasOpen || open != nil)
        }
        return (inCode, open, open == nil ? nil : openedAt)
    }

    /// What one line does to the fenced code it may be in: a line of three or more
    /// backticks or tildes, after any spaces, opens a fence when none is open, and closes
    /// the open one when it has its mark, at least as many, nothing after them but space,
    /// and is not indented as the code's own lines are: by more than three spaces at the
    /// top level, as the parser has it (say, a fence shown in a visual's `<pre>`); a
    /// visual is always there (elsewhere it is code), and so is other code that opened
    /// less than two spaces in. Other code may be in a list, whose closing fence lines up
    /// with the item's text: up to three spaces past its opening line. `MarkdownStream`
    /// follows fences line by line the same way.
    static func fence(_ line: Substring, _ open: inout Fence?) {
        let indent = line.prefix { $0 == " " }.count
        let content = line.dropFirst(indent)
        guard let marker = content.first, marker == "`" || marker == "~" else { return }
        let length = content.prefix { $0 == marker }.count
        guard length >= 3 else { return }
        if let current = open {
            let rest = content.dropFirst(length)
            if marker == current.marker, length >= current.length, indent <= (current.visual || current.indent < 2 ? 3 : current.indent + 3), rest.allSatisfy(\.isWhitespace) {
                open = nil
            }
        } else {
            open = (marker, length, indent, MarkdownWidget(infoString: String(content.dropFirst(length))) != nil)
        }
    }

    private static func kind(
        of components: [PresentationIntent.IntentType],
        markedItems: inout Set<Int>
    ) -> MarkdownBlock.Kind {
        switch components[0].kind {
        case let .codeBlock(language):
            let trimmed = language?.trimmingCharacters(in: .whitespaces) ?? ""
            // A widget only at the top level: in a list or a quote it is code.
            if components.count == 1, let widget = MarkdownWidget(infoString: trimmed) {
                return .widget(widget)
            }
            return .code(language: trimmed.isEmpty ? nil : trimmed)
        case let .header(level):
            return .heading(level: level)
        case .thematicBreak:
            return .rule
        default:
            break
        }

        if let position = components.firstIndex(where: { if case .listItem = $0.kind { true } else { false } }),
           case let .listItem(ordinal) = components[position].kind {
            let lists = components.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
            let isOrdered = components[position...].first { $0.kind == .orderedList || $0.kind == .unorderedList }?.kind == .orderedList
            // Only an item's first block carries the marker.
            let isFirstBlock = markedItems.insert(components[position].identity).inserted
            let marker: MarkdownBlock.ListMarker = !isFirstBlock ? .none : (isOrdered ? .number(ordinal) : .bullet)
            return .listItem(marker, depth: max(lists.count, 1))
        }
        if components.contains(where: { $0.kind == .blockQuote }) {
            return .quote
        }
        return .paragraph
    }

    private struct TableBuilder {
        static let headerRow = -1

        let blockIndex: Int
        private var cells: [Int: [Int: AttributedString]] = [:]

        init(blockIndex: Int) {
            self.blockIndex = blockIndex
        }

        mutating func append(_ piece: AttributedString, row: Int, column: Int) {
            cells[row, default: [:]][column, default: AttributedString()].append(piece)
        }

        var table: MarkdownTable {
            let width = (cells.values.flatMap(\.keys).max() ?? -1) + 1
            func line(_ row: Int) -> [AttributedString] {
                (0..<width).map { cells[row]?[$0] ?? AttributedString() }
            }
            return MarkdownTable(
                header: cells[Self.headerRow] == nil ? [] : line(Self.headerRow),
                rows: cells.keys.filter { $0 != Self.headerRow }.sorted().map(line)
            )
        }
    }
}
