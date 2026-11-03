import AgentCore
import SwiftUI
import UIKit

/// Reply text laid out block by block: paragraphs, headings, lists, quotes, code and
/// tables, with their formulas typeset.
struct MarkdownBlocksView: View {
    let blocks: [MarkdownBlock]
    /// The turn the blocks are in, when their widgets are drawn; nil shows a widget as
    /// its code (a plan, a preview).
    var widgets: UUID?
    /// Which of that turn's pieces of text this is (`WidgetKey.segment`).
    var widgetSegment = 0
    /// Whether the reply is still being written: a widget not finished yet says so.
    var isBeingWritten = false
    /// What holding the text copies and selects (`copyMenu`), when it offers to.
    var copying: Copying?
    /// Which of the blocks are settled: a reply being written (`MarkdownStream`) gives the
    /// same values for those from then on, so their views are not compared or made again
    /// at each step of its reveal, only the blocks after them.
    var settled: Settled?
    /// The style its prose is set in: the reply's body, or a smaller one in a bubble (a
    /// message another agent sent, `RelayedMessageRow`), whose headings and the room
    /// between its blocks are smaller to match.
    var textStyle: Font.TextStyle = .body
    /// Whether it is as wide as the column it is given, as a reply is, or only as wide as
    /// its longest line, as the text in a bubble is (`RelayedMessageRow`), so that a short
    /// message keeps its bubble small. Code, tables, rules, images and prose with a
    /// formula take the whole column either way.
    var fillsColumn = true
    /// Whether its prose is set in the secondary colour where it is selected in place
    /// (`SelectableProse`), which does not take SwiftUI's foreground style: a relayed
    /// message in its quieter look. Elsewhere the foreground style around it does this.
    var isFaint = false

    struct Copying {
        let text: String
        let selecting: () -> String
        /// Its item in the edit menu of text selected where it is (`SelectableProse`).
        var title = "Copy Reply"
    }

    /// The first `count` blocks are settled, for as long as the parse they came from goes
    /// on (`generation`), which starts over when the text no longer carries on from before.
    struct Settled: Equatable {
        var count: Int
        var generation: Int
    }

    var body: some View {
        if let copying, widgets != nil {
            // Held, the text around a widget offers to copy; the widget is left to its
            // page, which takes its own touches. Laid out in runs whether or not the reply
            // has a visual yet, so that the first one to come does not make the text above
            // it anew.
            VStack(alignment: .leading, spacing: spacing) {
                ForEach(Self.stretches(blocks), id: \.first?.id) { stretch in
                    if stretch.count == 1, stretch[0].isWidget {
                        view(for: stretch[0])
                    } else {
                        column(stretch)
                            .copyMenuUnlessSelectable(copying, selectsInPlace: selectsInPlace)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let copying {
            column(blocks)
                .copyMenuUnlessSelectable(copying, selectsInPlace: selectsInPlace)
        } else {
            column(blocks)
        }
    }

    /// The room between blocks.
    private var spacing: CGFloat { textStyle == .body ? Theme.blockSpacing : Theme.grid }

    /// Whether it is set in text views that are selected in where they are
    /// (`SelectableProse`): a reply's, a relayed message's, where that is on
    /// (`ProseSelection`). The text then has a menu of its own, not the copy menu.
    private var selectsInPlace: Bool { ProseSelection.isOn && copying != nil }

    private func column(_ blocks: [MarkdownBlock]) -> some View {
        VStack(alignment: .leading, spacing: spacing) {
            if selectsInPlace {
                ForEach(SelectableProse.runs(of: blocks)) { run in
                    if run.isProse {
                        SelectableProse(
                            blocks: run.blocks,
                            settledIn: settled.flatMap { run.blocks.last!.id < $0.count ? $0.generation : nil },
                            textStyle: textStyle, fillsColumn: fillsColumn, copying: copying, isFaint: isFaint
                        )
                        .equatable()
                    } else {
                        view(for: run.blocks[0])
                    }
                }
            } else {
                ForEach(blocks) { block in
                    view(for: block)
                }
            }
        }
        .frame(maxWidth: fillsColumn ? .infinity : nil, alignment: .leading)
    }

    private func view(for block: MarkdownBlock) -> some View {
        BlockView(
            block: block,
            settledIn: settled.flatMap { block.id < $0.count ? $0.generation : nil },
            widgets: widgets, widgetSegment: widgetSegment, isBeingWritten: isBeingWritten,
            textStyle: textStyle, fillsColumn: fillsColumn
        )
        .equatable()
    }

    /// The blocks in runs between widgets, each widget a run of its own.
    private static func stretches(_ blocks: [MarkdownBlock]) -> [[MarkdownBlock]] {
        var stretches: [[MarkdownBlock]] = []
        for block in blocks {
            if block.isWidget || stretches.last?.last?.isWidget ?? true {
                stretches.append([block])
            } else {
                stretches[stretches.count - 1].append(block)
            }
        }
        return stretches
    }

    /// The tint is the label colour, so a link would look like plain text: underline it.
    static func withLinksMarked(_ text: AttributedString) -> AttributedString {
        var marked = text
        for run in text.runs where run.link != nil {
            marked[run.range].underlineStyle = .single
        }
        return marked
    }
}

extension MarkdownBlocksView {
    /// A block as the column draws it, on its own: what a run of selectable text draws
    /// over the place it keeps for a code block, a table or a rule (`SelectableProse`).
    static func blockContent(_ block: MarkdownBlock, textStyle: Font.TextStyle, fillsColumn: Bool) -> some View {
        BlockView(block: block, settledIn: nil, widgets: nil, widgetSegment: 0, isBeingWritten: false,
                  textStyle: textStyle, fillsColumn: fillsColumn)
    }
}

private extension View {
    /// The reply's copy menu (`copyMenu`), unless its text is selected in where it is.
    @ViewBuilder
    func copyMenuUnlessSelectable(_ copying: MarkdownBlocksView.Copying?, selectsInPlace: Bool) -> some View {
        if let copying, !selectsInPlace {
            copyMenu(copying.text, selecting: copying.selecting)
        } else {
            self
        }
    }
}

/// One block of reply text. Compared before it is made again: a settled block of a reply
/// being written (`settledIn`) is the same as long as its parse goes on, which is told
/// without comparing its text; any other block by its value. A reply's reveal steps
/// twenty times a second, and every block of it, paragraphs, tables and formulas far
/// above the one being written, was made and compared again at each.
private struct BlockView: View, Equatable {
    let block: MarkdownBlock
    /// The parse in which the block is settled, when it is.
    let settledIn: Int?
    let widgets: UUID?
    let widgetSegment: Int
    let isBeingWritten: Bool
    let textStyle: Font.TextStyle
    let fillsColumn: Bool

    static func == (a: BlockView, b: BlockView) -> Bool {
        guard a.block.id == b.block.id, a.widgets == b.widgets, a.widgetSegment == b.widgetSegment,
              a.isBeingWritten == b.isBeingWritten, a.textStyle == b.textStyle,
              a.fillsColumn == b.fillsColumn else { return false }
        if let parse = a.settledIn, parse == b.settledIn { return true }
        return a.block == b.block
    }

    var body: some View {
        switch block.kind {
        case .paragraph:
            prose(block)
        case .heading where textStyle != .body:
            // In a bubble's smaller type, a heading is its text in bold.
            prose(block, font: .app.font(textStyle).weight(.semibold))
                .accessibilityAddTraits(.isHeader)
        case let .heading(level):
            prose(block, font: Self.headingFont(level), style: Self.headingStyle(level))
                .padding(.top, Theme.grid / 2)
                .accessibilityAddTraits(.isHeader)
        case let .code(language):
            CodeBlockView(code: block.plainText, language: language)
        case let .listItem(marker, depth):
            HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                ListMarkerView(marker: marker)
                prose(block)
            }
            .padding(.leading, CGFloat(depth - 1) * Theme.grid * 2.5)
        case .quote:
            prose(block)
                .foregroundStyle(.secondary)
                .padding(.leading, Theme.grid * 1.5)
                .overlay(alignment: .leading) {
                    Capsule().fill(.tertiary).frame(width: 3)
                }
        case .rule:
            Divider()
        case let .table(table):
            MarkdownTableView(table: table)
        case let .widget(widget):
            if let turn = widgets {
                // Not hashed while it is written: its HTML changes at every step.
                WidgetBlockView(widget: widget, key: WidgetKey(turn: turn, segment: widgetSegment, block: block.id, source: widget.isComplete ? widget.sourceHash : 0), isBeingWritten: isBeingWritten)
            } else {
                CodeBlockView(code: widget.source, language: MarkdownWidget.language)
            }
        case let .image(image):
            ReplyImageView(image: image, isBeingWritten: isBeingWritten)
        }
    }

    /// A block's text, with any display formula in it on a line of its own.
    private func prose(_ block: MarkdownBlock, font: Font? = nil, style: Font.TextStyle? = nil) -> some View {
        let style = style ?? textStyle
        let font = font ?? .app.font(textStyle)
        return VStack(alignment: .leading, spacing: textStyle == .body ? Theme.blockSpacing : Theme.grid) {
            ForEach(Array(block.pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case let .text(text):
                    ProseText(text: MarkdownBlocksView.withLinksMarked(text), font: font, style: style, fillsColumn: fillsColumn)
                case let .formula(formula):
                    DisplayMathView(formula: formula)
                }
            }
        }
    }

    private static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .app.title2.weight(.semibold)
        case 2: .app.title3.weight(.semibold)
        default: .app.headline
        }
    }

    /// The style of `headingFont`, which formulas in the heading are sized to.
    private static func headingStyle(_ level: Int) -> Font.TextStyle {
        switch level {
        case 1: .title2
        case 2: .title3
        default: .headline
        }
    }
}

/// Text of a block, as wide as the column it is in, its formulas fitted to that width; or,
/// where the column does not fill its width (`MarkdownBlocksView.fillsColumn`), as wide as
/// its longest line, unless it holds a formula.
private struct ProseText: View {
    let text: AttributedString
    let font: Font
    let style: Font.TextStyle
    var fillsColumn = true

    var body: some View {
        // Only text with a formula in it needs the column's width. Measuring every
        // block cost the chat a geometry update per paragraph on every frame it
        // scrolled, which in a long thread is thousands (docs/perf-mac-scroll.md).
        if text.runs.contains(where: { $0.mathFormula != nil }) {
            FittedMathText(text: text, font: font, style: style)
        } else {
            MathText(text: text, style: style)
                .modifier(ProseLayout(font: font, fillsColumn: fillsColumn))
        }
    }
}

/// Prose with formulas in it, which are fitted to the width of the column it is in.
private struct FittedMathText: View {
    let text: AttributedString
    let font: Font
    let style: Font.TextStyle

    @State private var width: CGFloat?

    var body: some View {
        MathText(text: text, style: style, lineWidth: width)
            .modifier(ProseLayout(font: font))
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }
}

private struct ProseLayout: ViewModifier {
    let font: Font
    var fillsColumn = true

    func body(content: Content) -> some View {
        content
            .font(font)
            .lineSpacing(Theme.proseLineSpacing)
            // The column's width whatever the text holds, a formula too long for it
            // included, so that the width measured is the column's. Not filling it, the
            // width of its longest line, and still no more than the column's.
            .frame(minWidth: 0, maxWidth: fillsColumn ? .infinity : nil, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ListMarkerView: View {
    let marker: MarkdownBlock.ListMarker

    var body: some View {
        switch marker {
        case .bullet:
            Text("•").foregroundStyle(.secondary)
        case let .number(number):
            Text("\(number).").foregroundStyle(.secondary).monospacedDigit()
        case .none:
            // Lines a continuation up with the text of the item above.
            Text("•").hidden()
        }
    }
}

/// A code block: the language and Copy on top, the code below, scrolling sideways
/// instead of wrapping.
struct CodeBlockView: View {
    let code: String
    let language: String?

    var body: some View {
        CopyableBlock(title: language ?? "code", copies: code) {
            SidewaysText(text: code, font: .app.callout.monospaced())
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(language.map { "\($0) code" } ?? "Code")
    }
}

/// A card with a title and Copy on top and text to copy below: the frame of a code
/// block, and of anything else that is shown to be copied.
struct CopyableBlock<Content: View>: View {
    let title: String
    /// What Copy takes, which can be more than what shows.
    let copies: String
    /// A symbol before the title, saying what became of it (a command that ran).
    var titleSymbol: String?
    var onClose: (() -> Void)?
    @ViewBuilder var content: () -> Content

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let titleSymbol {
                    Label(title, systemImage: titleSymbol)
                        .labelStyle(.titleAndIcon)
                        .font(.app.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                } else {
                    Text(title)
                        .font(.app.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "square.on.square") {
                    UIPasteboard.general.string = copies
                    copied = true
                }
                .font(.app.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .contentTransition(.symbolEffect(.replace))
                if let onClose { CommandCloseButton(command: title, action: onClose) }
            }
            .padding(.horizontal, Theme.grid * 1.5)
            .padding(.vertical, Theme.grid)
            Divider()
            content()
        }
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// Text whose lines keep their length and scroll sideways, as code and columns must.
struct SidewaysText: View {
    let text: String
    let font: Font

    var body: some View {
        ScrollView(.horizontal) {
            Text(text)
                .font(font)
                .fixedSize(horizontal: true, vertical: true)
                .padding(Theme.grid * 1.5)
        }
        .scrollIndicators(.hidden)
    }
}

/// A table as a grid, scrolling sideways when it is wider than the screen.
private struct MarkdownTableView: View {
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: Theme.grid * 2.5, verticalSpacing: Theme.grid) {
                if !table.header.isEmpty {
                    GridRow {
                        ForEach(Array(table.header.enumerated()), id: \.offset) { _, cell in
                            MathText(text: cell, style: .subheadline).font(.app.subheadline.weight(.semibold))
                        }
                    }
                    Divider()
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            MathText(text: MarkdownBlocksView.withLinksMarked(cell), style: .subheadline).font(.app.subheadline)
                        }
                    }
                }
            }
            .padding(Theme.grid * 1.5)
        }
        .scrollIndicators(.hidden)
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

#Preview("Blocks") {
    ScrollView {
        MarkdownBlocksView(blocks: Markdown.blocks(FakeBackend.markdownShowcase))
            .padding(Theme.margin)
    }
    .background(Theme.pageBackground)
}

#Preview("Math") {
    ScrollView {
        MarkdownBlocksView(blocks: Markdown.blocks(FakeBackend.mathShowcase))
            .padding(Theme.margin)
    }
    .background(Theme.pageBackground)
}
