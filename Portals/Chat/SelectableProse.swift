import AgentCore
import MathRendering
import SwiftUI
import UIKit

/// Whether the chat's text is selected where it is (`SelectableProse`,
/// `SelectablePlainText`): dragged across with the pointer on a Mac, held on an iPhone
/// and iPad (handles and the edit menu), instead of held for the copy menu (`copyMenu`).
/// On everywhere; `PORTALS_DEBUG_SELECTION=off` goes back to the copy menu.
enum ProseSelection {
    nonisolated static let isOn: Bool = DebugLaunch.proseSelection != "off"

    /// A key typed while selected text has the focus (`ProseTextView`): the chat puts it
    /// in the composer and gives the composer the focus. `userInfo["text"]` is what was
    /// typed; its object the `ProseTypingTarget` of the chat whose text it was, which only
    /// that chat takes.
    static let typed = Notification.Name("PortalsProseTyped")
}

/// Names the chat a key typed on its selectable text goes to (`ProseSelection.typed`):
/// one a chat, given to its text through the environment. Text outside a chat (none
/// given) keeps what is typed on it.
@MainActor
final class ProseTypingTarget {}

extension EnvironmentValues {
    @Entry var proseTypingTarget: ProseTypingTarget?
}

extension View {
    /// The copy menu for `text` where the text is not selected where it is: with
    /// `ProseSelection` on, a hold (a right click) is the text's own.
    @ViewBuilder
    func copyMenuWhenNotSelectable(_ text: String) -> some View {
        if ProseSelection.isOn {
            self
        } else {
            copyMenu(text)
        }
    }
}

/// A run of a reply's blocks set in one text view that is selected in where it is:
/// dragged across with the pointer, a word double-clicked or held, copied with ⌘C or from
/// the edit menu, a selection running from one block to the next, a code block, a quote,
/// a table, a rule and a display formula included. Laid out as the blocks' own views are
/// (`BlockView` in MarkdownBlocksView): the prose is the text view's own text, in the same
/// type, room between lines and between blocks, list markers, quote bars, formulas in the
/// line and links underlined; a code block, a table, a rule and a display formula are the
/// blocks' own views, drawn over the place the text keeps for them, so that they look and
/// scroll sideways as before, and a selection takes them whole.
///
/// Visuals and images stay views of their own, between runs: a selection does not cross
/// them, nor from one reply to another.
struct SelectableProse: View, Equatable {
    let blocks: [MarkdownBlock]
    /// The parse in which all of the run's blocks are settled, when they are
    /// (`MarkdownBlocksView.Settled`): a reply being written gives the same blocks for
    /// those from then on, which are told the same without comparing their text.
    var settledIn: Int?
    var textStyle: Font.TextStyle = .body
    var fillsColumn = true
    /// What the whole reply copies as (its item in the edit menu, Copy Reply).
    var copying: MarkdownBlocksView.Copying?
    /// Set in the secondary colour (`ProseStyle.isFaint`).
    var isFaint = false

    static func == (a: SelectableProse, b: SelectableProse) -> Bool {
        guard a.textStyle == b.textStyle, a.fillsColumn == b.fillsColumn, a.isFaint == b.isFaint,
              a.copying?.text == b.copying?.text, a.copying?.title == b.copying?.title,
              a.blocks.count == b.blocks.count,
              a.blocks.first?.id == b.blocks.first?.id else { return false }
        if let parse = a.settledIn, parse == b.settledIn { return true }
        return a.blocks == b.blocks
    }

    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        #if DEBUG
        let _ = ProseHeightProbe.runIfAsked()
        let _ = ProseChecks.runIfAsked()
        #endif
        ProseTextRepresentable(
            blocks: blocks, settledIn: settledIn,
            style: ProseStyle(textStyle: textStyle, fillsColumn: fillsColumn, isFaint: isFaint, dynamicTypeSize: dynamicTypeSize, displayScale: displayScale),
            wholeCopy: copying.map { ($0.title, $0.text) }, openURL: openURL
        )
    }

    /// A reply's blocks in the order they come: runs that one text view sets, and
    /// visuals and images on their own.
    struct Run: Identifiable {
        var blocks: [MarkdownBlock]
        var isProse: Bool
        var id: Int { blocks[0].id }
    }

    static func runs(of blocks: [MarkdownBlock]) -> [Run] {
        var runs: [Run] = []
        for block in blocks {
            if block.isWidget || block.isImage {
                runs.append(Run(blocks: [block], isProse: false))
            } else if let last = runs.last, last.isProse {
                runs[runs.count - 1].blocks.append(block)
            } else {
                runs.append(Run(blocks: [block], isProse: true))
            }
        }
        return runs
    }
}

/// Text as it was written, not Markdown, that is selected in where it is: a message of
/// yours, a tool's output.
struct SelectablePlainText: View, Equatable {
    let text: String
    var font: ProseStyle.Plain = .body
    /// As wide as the column, or as its longest line (a bubble).
    var fillsColumn = false
    /// The edit menu's item that copies all of the text, when it has one ("Copy All").
    var copiesAll: String?
    /// Each file the text mentions (`@path`) is a chip, its name in a pill, that opens it in
    /// the chat's file viewer: a message of yours, where the host reads its files. Only a
    /// path-like one, or one of `picked` (`FileMention.marked`).
    var chipsMentions = false
    /// The paths picked from the `@` menu for this message, chips whatever their shape.
    var picked: [String] = []

    static func == (a: SelectablePlainText, b: SelectablePlainText) -> Bool {
        a.text == b.text && a.font == b.font && a.fillsColumn == b.fillsColumn && a.copiesAll == b.copiesAll
            && a.chipsMentions == b.chipsMentions && a.picked == b.picked
    }

    @Environment(\.openURL) private var openURL
    @Environment(\.chatFiles) private var files
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ProseTextRepresentable(
            blocks: [MarkdownBlock(id: 0, kind: .paragraph, text: chipsMentions ? FileMention.marked(text, picked: picked) : AttributedString(text))], settledIn: nil,
            style: ProseStyle(fillsColumn: fillsColumn, lineSpacing: 0, plain: font, dynamicTypeSize: dynamicTypeSize, displayScale: displayScale),
            wholeCopy: copiesAll.map { ($0, text) }, openURL: openURL,
            openMention: chipsMentions ? { [files] path in files?.open(FileLocation(path: path)) } : nil
        )
    }
}

/// What a run's text is set in, beyond its blocks.
struct ProseStyle: Equatable {
    /// Plain text's type, which no Markdown sets.
    enum Plain: Equatable {
        case body
        /// A tool's output.
        case monospacedFootnote
    }

    var textStyle: Font.TextStyle = .body
    var fillsColumn = true
    /// Room between the lines of a paragraph: a reply's (`Theme.proseLineSpacing`), or
    /// none, as your message and a tool's output have.
    var lineSpacing: CGFloat = Theme.proseLineSpacing
    var plain: Plain?
    /// Text set in the secondary colour, as a relayed message's is in its quieter look
    /// (`RelayedLook`): the text view does not take SwiftUI's foreground style.
    var isFaint = false
    var dynamicTypeSize: DynamicTypeSize = .large
    var displayScale: CGFloat = 2

    /// The room between blocks, as `MarkdownBlocksView` has it.
    var blockSpacing: CGFloat { textStyle == .body ? Theme.blockSpacing : Theme.grid }
}

private struct ProseTextRepresentable: UIViewRepresentable {
    let blocks: [MarkdownBlock]
    let settledIn: Int?
    let style: ProseStyle
    /// The edit menu's item that copies all of it, and what it copies.
    let wholeCopy: (title: String, text: String)?
    let openURL: OpenURLAction
    /// Opens a mentioned file, its chip tapped (`SelectablePlainText.chipsMentions`).
    var openMention: ((String) -> Void)?

    func makeUIView(context: Context) -> ProseTextView {
        let view = ProseTextView()
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: ProseTextView, context: Context) {
        view.openURL = openURL
        view.openMention = openMention
        view.typingTarget = context.environment.proseTypingTarget
        view.wholeCopy = wholeCopy
        view.show(blocks, settledIn: settledIn, style: style)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ProseTextView, context: Context) -> CGSize? {
        view.fittingSize(width: proposal.width)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UITextViewDelegate {
        func textViewDidChangeSelection(_ textView: UITextView) {
            guard let view = textView as? ProseTextView else { return }
            view.selectionChanged()
            ProseCopyLog.selection(view)
        }

        /// A link clicked or tapped goes where the chat sends links (a file on the Mac
        /// opens in its viewer), as a link in the blocks' own text does.
        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            // A mentioned file's chip opens the file, as a link to it does.
            if case let .tag(path) = textItem.content, let view = textView as? ProseTextView, let open = view.openMention {
                return UIAction { [weak view] _ in
                    SelectionClearer.shared.clearAny()
                    view?.clearSelection()
                    open(path)
                }
            }
            guard case let .link(url) = textItem.content, let view = textView as? ProseTextView, let openURL = view.openURL else { return defaultAction }
            // A selection lets go as the link opens, in this text or another, as on a tap
            // anywhere else (the window's tap, `SelectionClearer`, does not end on a link's).
            return UIAction { [weak view] _ in
                SelectionClearer.shared.clearAny()
                view?.clearSelection()
                openURL(url)
            }
        }

        /// Whether the menu has the system's Copy already.
        private static func hasCopy(_ elements: [UIMenuElement]) -> Bool {
            elements.contains { element in
                if let command = element as? UICommand { return command.action == #selector(UIResponderStandardEditActions.copy(_:)) }
                if let menu = element as? UIMenu { return hasCopy(menu.children) }
                return false
            }
        }

        /// The text's own menu (Copy, Look Up, Share…) with the item that copies all of it
        /// after it (Copy Reply), which the copy menu offered as Copy.
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let view = textView as? ProseTextView else { return nil }
            var actions = suggestedActions
            // A right click on a block with nothing selected, which puts the insertion
            // point beside it (at the end of the line before, seen on an iPad): the block,
            // selected whole.
            if range.length == 0, let block = view.block(beside: range.location) {
                view.selectedRange = block.range
                if !Self.hasCopy(actions) {
                    actions.insert(UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { _ in
                        UIPasteboard.general.string = block.text
                        ProseCopyLog.write(block.text)
                    }, at: 0)
                }
            }
            guard let whole = view.wholeCopy else { return UIMenu(children: actions) }
            let copyAll = UIAction(title: whole.title, image: UIImage(systemName: "doc.on.doc")) { _ in
                UIPasteboard.general.string = whole.text
                ProseCopyLog.write(whole.text)
            }
            return UIMenu(children: actions + [UIMenu(options: .displayInline, children: [copyAll])])
        }
    }
}

/// A text view laid out once for the width it is given and as tall as its text, which
/// is read but not edited. TextKit 1: its layout is whole and its height known at once,
/// where TextKit 2 lays out only what is in sight. The blocks that are views of their own
/// (`BlockAttachment`) are drawn over the places the text keeps for them.
final class ProseTextView: UITextView {
    var wholeCopy: (title: String, text: String)?
    var openURL: OpenURLAction?
    /// Opens the file a chip names (`SelectablePlainText.chipsMentions`).
    var openMention: ((String) -> Void)?
    /// The chat a key typed on the text goes to (`ProseSelection.typed`).
    weak var typingTarget: ProseTypingTarget?

    /// The blocks shown, and where each one's text starts.
    private var shown: [MarkdownBlock] = []
    private var starts: [Int] = []
    private var shownSettledIn: Int?
    private var style: ProseStyle?
    /// The width the text is laid out for, and the size it came to there.
    private var measured: (width: CGFloat, size: CGSize)?
    /// The views of the blocks drawn over the text, by their attachment's key.
    private var overlays: [String: UIHostingController<AnyView>] = [:]
    /// A key typed and given to the composer (`ProseSelection.typed`), whose end is not
    /// the text's either.
    private var forwarded: Set<UIPress> = []
    /// What to show once the text has a width to be laid out at (`show`, `layOut`).
    private var waiting: (blocks: [MarkdownBlock], settledIn: Int?, style: ProseStyle)?

    init() {
        let storage = NSTextStorage()
        let layout = ProseLayoutManager()
        let container = OpenEndedContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        container.lineFragmentPadding = 0
        layout.allowsNonContiguousLayout = false
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        super.init(frame: .zero, textContainer: container)
        isEditable = false
        isSelectable = true
        isScrollEnabled = false
        backgroundColor = .clear
        textContainerInset = .zero
        dataDetectorTypes = []
        adjustsFontForContentSizeCategory = false
        clipsToBounds = false
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        linkTextAttributes = [
            .foregroundColor: UIColor.label,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
        ]
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Shows `blocks`, setting again only the text of those that changed, and of the last
    /// one before when there are more or fewer (the room after a block depends on what
    /// follows it), so that a reply being written lays out again only its end and a
    /// selection above it stays.
    func show(_ blocks: [MarkdownBlock], settledIn: Int?, style: ProseStyle) {
        // Not laid out yet: the text is set once its width is known (`layOut`). Set at
        // once, it was laid out a first time in a container of no width, as the text
        // storage's edit ends, and again at the column's (6% of the main thread's time
        // opening long threads, iPhone simulator).
        if textContainer.size.width == 0 {
            waiting = (blocks, settledIn, style)
            measured = nil
            setNeedsLayout()
            return
        }
        // A heading first in the run keeps the room above it a heading has (its padding
        // in `BlockView`), which a text view leaves out before its first paragraph. Set
        // before the text, as setting it sizes the container to the view's bounds: the
        // width it is laid out for is given back, before there is new text to lay out.
        let top: CGFloat = if style.textStyle == .body, case .heading = blocks.first?.kind { Theme.grid / 2 } else { 0 }
        if textContainerInset.top != top {
            let width = textContainer.size.width
            textContainerInset = UIEdgeInsets(top: top, left: 0, bottom: 0, right: 0)
            if textContainer.size.width != width { textContainer.size = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude) }
        }
        var from: Int
        if style != self.style || shown.isEmpty {
            from = 0
            if style.isFaint != (self.style?.isFaint ?? false) {
                linkTextAttributes[.foregroundColor] = style.isFaint ? UIColor.secondaryLabel : UIColor.label
            }
        } else if let parse = settledIn, parse == shownSettledIn, blocks.count == shown.count, blocks.first?.id == shown.first?.id {
            return
        } else {
            let same = zip(blocks, shown).prefix { $0.id == $1.id && $0 == $1 }.count
            if same == blocks.count, blocks.count == shown.count {
                shownSettledIn = settledIn
                return
            }
            from = blocks.count == shown.count ? same : max(min(same, blocks.count - 1, shown.count - 1), 0)
            // The break after a block copies as one line between two list items and a blank
            // line otherwise: set again when the block after it became or stopped being an
            // item ("2" growing into "2. Second").
            if from > 0, from < blocks.count, from < shown.count,
               ProseBuilder.isListItem(blocks[from]) != ProseBuilder.isListItem(shown[from]) {
                from -= 1
            }
        }
        let builder = ProseBuilder(style: style)
        let tail = NSMutableAttributedString()
        var tailStarts: [Int] = []
        let offset = from < starts.count ? starts[from] : 0
        for index in from..<blocks.count {
            tailStarts.append(offset + tail.length)
            let next = index + 1 < blocks.count ? blocks[index + 1] : nil
            tail.append(builder.text(of: blocks[index], isFirst: index == 0, next: next))
        }
        let storage = textStorage
        let kept = selectionToKeep(from: offset)
        storage.beginEditing()
        if from == 0 {
            storage.setAttributedString(tail)
        } else {
            storage.replaceCharacters(in: NSRange(location: offset, length: storage.length - offset), with: tail)
        }
        storage.endEditing()
        if let kept { keepSelection(kept) }
        let changed = NSRange(location: offset, length: storage.length - offset)
        self.style = style
        bindOverlays(in: changed)
        // What is new to the text fitted to the width it is laid out for already; at
        // another width, `layOut` fits it all.
        if textContainer.size.width > 0 { fit(changed, width: textContainer.size.width) }
        starts = Array(starts.prefix(from)) + tailStarts
        shown = blocks
        shownSettledIn = settledIn
        measured = nil
        setNeedsLayout()
        #if DEBUG
        ProseSelectProbe.selectIfAsked(self)
        #endif
    }

    /// What is selected, when the text from `offset` on is about to be set again and the
    /// selection reaches into it: its words, a little of the text on either side of them,
    /// and where they were.
    private func selectionToKeep(from offset: Int) -> KeptSelection? {
        let selected = selectedRange
        let text = textStorage.string as NSString
        guard selected.length > 0, NSMaxRange(selected) > offset, NSMaxRange(selected) <= text.length else { return nil }
        let context = 16
        let before = max(selected.location - context, 0)
        let after = min(NSMaxRange(selected) + context, text.length)
        return KeptSelection(
            before: text.substring(with: NSRange(location: before, length: selected.location - before)),
            words: text.substring(with: selected),
            after: text.substring(with: NSRange(location: NSMaxRange(selected), length: after - NSMaxRange(selected))),
            location: selected.location
        )
    }

    /// Selects the same words again in the text set anew (a reply's parse can take
    /// characters out before them: marks closed, a link's definition come): where they
    /// stand between the same text as before, the place nearest the old one; else where
    /// they stand after or before the same text, or alone, when that is one place only.
    /// Nothing when they are gone or could be in more than one place: another of the same
    /// words selected would be wrong.
    private func keepSelection(_ kept: KeptSelection) {
        let text = textStorage.string as NSString
        let whole = text.length
        /// Where `pattern` is in the text: none, the one nearest the old place, and
        /// whether it is there more than once.
        func find(_ pattern: String) -> (location: Int, once: Bool)? {
            var found: [Int] = []
            var from = 0
            while from < whole {
                let range = text.range(of: pattern, options: [], range: NSRange(location: from, length: whole - from))
                guard range.location != NSNotFound else { break }
                found.append(range.location)
                from = range.location + 1
            }
            guard let nearest = found.min(by: { abs($0 - kept.location) < abs($1 - kept.location) }) else { return nil }
            return (nearest, found.count == 1)
        }
        let length = kept.words.utf16.count
        var place: Int?
        if let full = find(kept.before + kept.words + kept.after) {
            place = full.location + kept.before.utf16.count
        } else if !kept.after.isEmpty, let next = find(kept.words + kept.after), next.once {
            place = next.location
        } else if !kept.before.isEmpty, let previous = find(kept.before + kept.words), previous.once {
            place = previous.location + kept.before.utf16.count
        } else if let alone = find(kept.words), alone.once {
            place = alone.location
        }
        if let place {
            let range = NSRange(location: place, length: length)
            if selectedRange != range { selectedRange = range }
        } else {
            clearSelection()
        }
    }

    /// The size the text takes at `width` (the column's): as wide, or as its longest
    /// line where it does not fill the column, and as tall as its lines; laid out for
    /// that width from then on.
    func fittingSize(width: CGFloat?) -> CGSize {
        // Asked without a width (rare in a column), the one it was laid out for.
        let width = width.map { $0.isFinite ? max($0, 1) : 10_000 } ?? measured?.width ?? (bounds.width > 0 ? bounds.width : 10_000)
        if let measured, measured.width == width { return measured.size }
        layOut(width: width)
        layoutManager.ensureLayout(for: textContainer)
        let used = layoutManager.usedRect(for: textContainer)
        let scale = max(style?.displayScale ?? 2, 1)
        let height = (max(used.height, 0) * scale).rounded(.up) / scale + textContainerInset.top + textContainerInset.bottom
        // As wide as its longest line where it does not fill the column: the lines' own
        // widths, the text's used rectangle being as wide as its container.
        var longest: CGFloat = 0
        if !(style?.fillsColumn ?? true) {
            layoutManager.enumerateLineFragments(forGlyphRange: layoutManager.glyphRange(for: textContainer)) { _, line, _, _, _ in
                longest = max(longest, line.maxX)
            }
        }
        let fits = style?.fillsColumn ?? true ? width : min(width, (longest * scale).rounded(.up) / scale)
        let size = CGSize(width: fits, height: height)
        measured = (width, size)
        return size
    }

    override func layoutSubviews() {
        if bounds.width > 0, textContainer.size.width != bounds.width, style?.fillsColumn ?? true {
            layOut(width: bounds.width)
        }
        super.layoutSubviews()
        placeOverlays()
    }

    private func layOut(width: CGFloat) {
        guard textContainer.size.width != width else { return }
        if let waiting {
            textContainer.size = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            self.waiting = nil
            show(waiting.blocks, settledIn: waiting.settledIn, style: waiting.style)
            return
        }
        textContainer.size = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        fit(NSRange(location: 0, length: textStorage.length), width: width)
    }

    // MARK: Blocks drawn over the text

    /// Gives each block in `range` that is a view of its own its view, the one it had
    /// when the block was there before; lets go of the views of blocks no longer there.
    private func bindOverlays(in range: NSRange) {
        var keys = Set<String>()
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, place, _ in
            guard let block = value as? BlockAttachment, let view = block.content else { return }
            keys.insert(block.key)
            guard NSIntersectionRange(place, range).length > 0 || place.location == range.location else { return }
            // Measured before it is in a window, where its scale would be 1 (a divider a
            // point, not a pixel): the chat's own, given.
            // Faint as the text around it (`ProseStyle.isFaint`): the hosted view does not
            // take the foreground style of the SwiftUI around the text view either.
            let content = AnyView(view
                .environment(\.displayScale, style?.displayScale ?? 2)
                .environment(\.openURL, openURL ?? OpenURLAction { _ in .systemAction })
                .appDefaultFont()
                .foregroundStyle(style?.isFaint == true ? HierarchicalShapeStyle.secondary : .primary)
                .tint(Theme.tint))
            if let host = overlays[block.key] {
                host.rootView = content
            } else {
                let host = UIHostingController(rootView: content)
                host.view.backgroundColor = .clear
                host.safeAreaRegions = []
                // Held, or clicked with the right button, the block is selected whole, with
                // the edit menu: the text's own gestures do not start on the block's view.
                let hold = UILongPressGestureRecognizer(target: self, action: #selector(selectBlock(_:)))
                hold.delegate = BlockGestures.shared
                host.view.addGestureRecognizer(hold)
                // Under the text's own views, so that a selection's highlight shows over it.
                insertSubview(host.view, at: 0)
                overlays[block.key] = host
            }
        }
        for key in overlays.keys where !keys.contains(key) {
            overlays.removeValue(forKey: key)?.view.removeFromSuperview()
        }
    }

    /// Fits the formulas in the lines and the blocks drawn over the text in `range` to
    /// `width`.
    private func fit(_ range: NSRange, width: CGFloat) {
        var changed = false
        textStorage.enumerateAttribute(.attachment, in: range) { value, place, _ in
            let paragraph = textStorage.attribute(.paragraphStyle, at: place.location, effectiveRange: nil) as? NSParagraphStyle
            let room = width - (paragraph?.headIndent ?? 0)
            if let formula = value as? FormulaAttachment {
                let before = formula.bounds
                formula.fit(lineWidth: room)
                if formula.bounds != before {
                    textStorage.addAttribute(.baselineOffset, value: formula.baselineOffset, range: place)
                    changed = true
                }
            } else if let block = value as? BlockAttachment, let host = overlays[block.key] {
                // On whole pixels, as a stack of the blocks' views lays them out.
                let scale = max(style?.displayScale ?? 2, 1)
                let height = (host.sizeThatFits(in: CGSize(width: room, height: CGFloat.greatestFiniteMagnitude)).height * scale).rounded() / scale
                let bounds = CGRect(x: 0, y: 0, width: max(room, 1), height: max(height, 1))
                if block.bounds != bounds {
                    block.bounds = bounds
                    changed = true
                }
            }
        }
        if changed {
            layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
        }
    }

    /// Puts each block's view over the place the text keeps for it.
    private func placeOverlays() {
        guard !overlays.isEmpty else { return }
        layoutManager.ensureLayout(for: textContainer)
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, place, _ in
            guard let block = value as? BlockAttachment, let host = overlays[block.key] else { return }
            let glyph = layoutManager.glyphIndexForCharacter(at: place.location)
            let line = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let location = layoutManager.location(forGlyphAt: glyph)
            // Its bottom on the line's baseline, as an attachment is drawn.
            let frame = CGRect(x: line.minX + location.x + textContainerInset.left,
                               y: line.minY + location.y - block.bounds.height + textContainerInset.top,
                               width: block.bounds.width, height: block.bounds.height)
            if host.view.frame != frame { host.view.frame = frame }
        }
    }

    /// Selects the block whose view was held or right-clicked, and shows the edit menu
    /// there (Copy takes its text, `proseCopiesAs`).
    @objc private func selectBlock(_ gesture: UIGestureRecognizer) {
        guard gesture.state == .began || gesture.state == .ended,
              let view = gesture.view, let key = overlays.first(where: { $0.value.view === view })?.key else { return }
        var place: NSRange?
        textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textStorage.length)) { value, range, stop in
            if (value as? BlockAttachment)?.key == key {
                place = range
                stop.pointee = true
            }
        }
        guard let place else { return }
        selectedRange = place
        _ = becomeFirstResponder()
        if blockMenu == nil {
            let menu = UIEditMenuInteraction(delegate: self)
            addInteraction(menu)
            blockMenu = menu
        }
        blockMenu?.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: gesture.location(in: self)))
    }

    /// The edit menu shown for a block selected whole (`selectBlock`).
    private var blockMenu: UIEditMenuInteraction?

    /// The block drawn over the text at `location`, or just after or before it, where it
    /// is in the text and what it copies as.
    func block(beside location: Int) -> (range: NSRange, text: String)? {
        for index in [location, location + 1, location - 1] where index >= 0 && index < textStorage.length {
            guard textStorage.attribute(.attachment, at: index, effectiveRange: nil) is BlockAttachment else { continue }
            let text = (textStorage.attribute(.proseCopiesAs, at: index, effectiveRange: nil) as? ProseCopiesAs)?.text ?? ""
            return (NSRange(location: index, length: 1), text)
        }
        return nil
    }

    /// A touch on a block drawn over the text is its view's (Copy, scrolling a long line
    /// sideways), and the text's too: a drag or a hold there selects as anywhere.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        for host in overlays.values where !host.view.isHidden {
            let local = convert(point, to: host.view)
            if host.view.bounds.contains(local), let hit = host.view.hitTest(local, with: event) { return hit }
        }
        return super.hitTest(point, with: event)
    }

    /// The focus only for a selection: a hold, a drag (a click and drag on a Mac), a
    /// double tap or click, a block held or right-clicked. A plain tap or click on the text
    /// leaves the focus where it was, the composer's and the keyboard up on a phone, as
    /// before the text was selected where it is.
    override var canBecomeFirstResponder: Bool {
        selectedRange.length > 0 || isSelecting
    }

    /// Whether one of the text's own gestures that select is under way or just ended: a
    /// hold, a drag, two or three taps. A single tap is not one. A touch down longer than
    /// a tap counts too: the hold asks for the focus as it starts, sometimes before its
    /// gesture has said so.
    private var isSelecting: Bool {
        if let touchedSince, Date.now.timeIntervalSince(touchedSince) > 0.25 { return true }
        return (gestureRecognizers ?? []).contains { gesture in
            guard gesture.isEnabled, [.began, .changed, .ended].contains(gesture.state) else { return false }
            if let tap = gesture as? UITapGestureRecognizer { return tap.numberOfTapsRequired > 1 }
            return gesture is UILongPressGestureRecognizer || gesture is UIPanGestureRecognizer
        }
    }

    /// Since when a touch (or a pointer's button) is down on the text, while it is.
    private var touchedSince: Date?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchedSince = .now
        super.touchesBegan(touches, with: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchedSince = nil
        super.touchesEnded(touches, with: event)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touchedSince = nil
        super.touchesCancelled(touches, with: event)
    }

    // MARK: Letting go of a selection

    /// Something selected holds the text (`SelectionClearer`), and nothing selected lets
    /// it go, with the focus once no touch is down (a hold on another word of this text
    /// passes through nothing selected).
    func selectionChanged() {
        if selectedRange.length > 0 {
            SelectionClearer.shared.hold(self)
            return
        }
        SelectionClearer.shared.letGo(self)
        DispatchQueue.main.async { [weak self] in
            guard let self, selectedRange.length == 0, touchedSince == nil, isFirstResponder else { return }
            _ = resignFirstResponder()
        }
    }

    /// Nothing selected, the edit menu gone, the focus let go of.
    func clearSelection() {
        blockMenu?.dismissMenu()
        if selectedRange.length > 0 { selectedRange = NSRange(location: selectedRange.location, length: 0) }
        SelectionClearer.shared.letGo(self)
        if isFirstResponder { _ = resignFirstResponder() }
    }

    /// Whether `point` is on what is selected, or close enough to it for its handles.
    func selectionContains(_ point: CGPoint) -> Bool {
        guard selectedRange.length > 0, let range = selectedTextRange else { return false }
        return selectionRects(for: range).contains { $0.rect.insetBy(dx: -8, dy: -12).contains(point) }
    }

    override func willMove(toWindow newWindow: UIWindow?) {
        if newWindow == nil { SelectionClearer.shared.letGo(self) }
        super.willMove(toWindow: newWindow)
    }

    // MARK: Copying

    /// What is selected, copied as plain text that reads as the reply: formulas as
    /// written, list markers and the room between blocks as `Markdown.plainText` has them,
    /// a code block's code, a table's cells.
    override func copy(_ sender: Any?) {
        guard let range = Range(selectedRange, in: textStorage.string), !range.isEmpty else { return }
        let text = plainText(in: selectedRange)
        UIPasteboard.general.string = text
        ProseCopyLog.write(text)
    }

    func plainText(in range: NSRange) -> String {
        var text = ""
        textStorage.enumerateAttribute(.proseCopiesAs, in: range) { value, run, _ in
            if let copiesAs = value as? ProseCopiesAs {
                text += copiesAs.text
            } else {
                text += (textStorage.string as NSString).substring(with: run)
            }
        }
        return text.replacingOccurrences(of: "\u{2028}", with: "\n")
    }

    // MARK: Typing

    /// A character typed while the text has the focus goes to the composer, which takes
    /// the focus with it (`ProseSelection.typed`), as in a chat app on a desk. Shortcuts
    /// (⌘C, ⌘A), the arrows and the other keys stay the text's.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if typingTarget != nil, let typed = Self.typed(presses) {
            forwarded.formUnion(presses)
            forwardTyped(typed)
            return
        }
        super.pressesBegan(presses, with: event)
    }

    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let own = presses.subtracting(forwarded)
        forwarded.subtract(presses)
        if !own.isEmpty { super.pressesEnded(own, with: event) }
    }

    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let own = presses.subtracting(forwarded)
        forwarded.subtract(presses)
        if !own.isEmpty { super.pressesCancelled(own, with: event) }
    }

    func forwardTyped(_ text: String) {
        guard let typingTarget else { return }
        NotificationCenter.default.post(name: ProseSelection.typed, object: typingTarget, userInfo: ["text": text])
    }

    /// The text of a key that types it: printable, with no ⌘ or ⌃ held.
    private static func typed(_ presses: Set<UIPress>) -> String? {
        guard presses.count == 1, let key = presses.first?.key,
              key.modifierFlags.intersection([.command, .control]).isEmpty else { return nil }
        let text = key.characters
        let printable = text.unicodeScalars.allSatisfy { scalar in
            !CharacterSet.controlCharacters.contains(scalar) && !(0xF700...0xF8FF).contains(scalar.value)
        }
        return !text.isEmpty && printable ? text : nil
    }
}

extension ProseTextView: UIEditMenuInteractionDelegate {
    /// The menu a block selected whole shows: the text's own (Copy, Share…) and the item
    /// that copies all of it.
    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        (delegate as? UITextViewDelegate)?.textView?(self, editMenuForTextIn: selectedRange, suggestedActions: suggestedActions)
            ?? UIMenu(children: suggestedActions)
    }
}

/// Lets go of a selection on the first tap or click anywhere else in the window: on the same
/// text away from it, another text, your message, the room between turns, a block drawn
/// over the text, the bar over the chat. A text view's own tap clears its selection only
/// within itself, and a tap elsewhere that takes no focus (`canBecomeFirstResponder`) left
/// it selected. A tap on a link still opens it; one on the selection is the text's own
/// (its menu shown or hidden); a drag, scrolling, is not a tap.
@MainActor
final class SelectionClearer: NSObject, UIGestureRecognizerDelegate {
    static let shared = SelectionClearer()

    /// The text view holding a selection, one at a time.
    private weak var holder: ProseTextView?
    /// On the holder's window while it holds one.
    private var tap: UITapGestureRecognizer?

    func hold(_ view: ProseTextView) {
        guard let window = view.window else { return }
        if let old = holder, old !== view { old.clearSelection() }
        holder = view
        guard tap?.view !== window else { return }
        if let tap { tap.view?.removeGestureRecognizer(tap) }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        window.addGestureRecognizer(tap)
        self.tap = tap
    }

    /// Lets go of the selection, wherever it is (a link tapped in another text).
    func clearAny() {
        holder?.clearSelection()
    }

    /// Lets go of the selection if it is in the text of the chat `target` names (a chat
    /// leaving the screen, kept built out of sight).
    func clear(of target: ProseTypingTarget) {
        guard let holder, holder.typingTarget === target else { return }
        holder.clearSelection()
    }

    func letGo(_ view: ProseTextView) {
        guard holder === view else { return }
        holder = nil
        if let tap { tap.view?.removeGestureRecognizer(tap) }
        tap = nil
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, let holder else { return }
        guard !holder.selectionContains(gesture.location(in: holder)) else { return }
        holder.clearSelection()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }

    /// Not a tap on the selection's own menu, which a right click opens in the window
    /// (Copy, Copy Reply): letting go of the selection first left Copy nothing to copy.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view {
            let name = NSStringFromClass(type(of: current))
            if name.contains("ContextMenu") || name.contains("EditMenu") { return false }
            view = current.superview
        }
        return true
    }
}

/// The gestures that select a block drawn over the text recognize beside the block's own
/// (scrolling a long line, Copy) and the text's.
private final class BlockGestures: NSObject, UIGestureRecognizerDelegate {
    static let shared = BlockGestures()

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

/// A selection kept across its text set again (`ProseTextView.keepSelection`).
private struct KeptSelection {
    let before: String
    let words: String
    let after: String
    let location: Int
}

/// A text container as tall as its text, whatever the text view sets: one that does not
/// scroll makes its container as tall as itself, and the text's last line could be left
/// out.
private nonisolated final class OpenEndedContainer: NSTextContainer {
    override var size: CGSize {
        get { super.size }
        set { super.size = CGSize(width: newValue.width, height: CGFloat.greatestFiniteMagnitude) }
    }
}

/// Draws a quote's bar beside its lines (`proseQuote`), as the quote's row has it: three
/// points wide, rounded, in the tertiary colour, as tall as its lines.
private nonisolated final class ProseLayoutManager: NSLayoutManager {
    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let storage = textStorage else { return }
        // A mentioned file's pill, behind its name, a piece of it on each line it is on.
        ProseMention.fill.setFill()
        storage.enumerateAttribute(.proseMention, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard value is ProseMention else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            guard glyphs.length > 0, NSIntersectionRange(glyphs, glyphsToShow).length > 0,
                  let container = textContainer(forGlyphAt: glyphs.location, effectiveRange: nil) else { return }
            enumerateEnclosingRects(forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container) { rect, _ in
                let pill = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: 0, dy: 1)
                UIBezierPath(roundedRect: pill, cornerRadius: pill.height / 2).fill()
            }
        }
        UIColor.tertiaryLabel.setFill()
        storage.enumerateAttribute(.proseQuote, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            guard value is ProseQuote else { return }
            let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            guard glyphs.length > 0, NSIntersectionRange(glyphs, glyphsToShow).length > 0 else { return }
            var top: CGFloat?
            var bottom: CGFloat = 0
            enumerateLineFragments(forGlyphRange: glyphs) { _, used, _, _, _ in
                top = top ?? used.minY
                bottom = used.maxY
            }
            guard let top else { return }
            // TextKit puts the room between lines after a paragraph's last line too, but for
            // the text's last line: the bar ends with the letters.
            let isLast = NSMaxRange(glyphs) >= numberOfGlyphs
            let spacing = (storage.attribute(.paragraphStyle, at: max(NSMaxRange(range) - 1, 0), effectiveRange: nil) as? NSParagraphStyle)?.lineSpacing ?? 0
            let height = bottom - top - (isLast ? 0 : spacing)
            let bar = CGRect(x: origin.x, y: origin.y + top, width: 3, height: max(height, 0))
            UIBezierPath(roundedRect: bar, cornerRadius: 1.5).fill()
        }
    }
}

/// What is copied from a run's text, written to a file too where a test asks
/// (`DebugLaunch.copyLogPath`).
enum ProseCopyLog {
    static func write(_ text: String) {
        guard let path = DebugLaunch.copyLogPath else { return }
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    }

    /// What `view` has selected now, "none" when nothing, written where a test asks
    /// (`DebugLaunch.selectionLogPath`).
    static func selection(_ view: ProseTextView) {
        guard let path = DebugLaunch.selectionLogPath else { return }
        let text = view.selectedRange.length > 0 ? "selected: " + view.plainText(in: view.selectedRange) : "none"
        try? text.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

extension NSAttributedString.Key {
    /// What a piece of a run's text is copied as, where that is not its characters: a
    /// formula's source, a list marker, the break between two blocks, a code block's code.
    nonisolated static let proseCopiesAs = NSAttributedString.Key("PortalsProseCopiesAs")
    /// The text of one quote (`ProseQuote`), which has a bar beside it.
    nonisolated static let proseQuote = NSAttributedString.Key("PortalsProseQuote")
    /// A mentioned file's chip (`ProseMention`), drawn in a pill.
    nonisolated static let proseMention = NSAttributedString.Key("PortalsProseMention")
}

/// One piece's copy (`proseCopiesAs`). An object, so that two pieces side by side that
/// copy as the same text stay two runs.
final class ProseCopiesAs: NSObject {
    let text: String
    init(_ text: String) { self.text = text }
}

/// One quote's text (`proseQuote`). An object, so that two quotes one after the other
/// stay two, each with its bar.
nonisolated final class ProseQuote: NSObject {}

/// A mentioned file's chip in a message (`proseMention`): its name in a pill, which a tap
/// opens (its `textItemTag`, the path) and which copies as the `@path` it was written as.
/// An object, so that two chips side by side stay two pills.
nonisolated final class ProseMention: NSObject {
    /// The pill: a shade darker than the bubble it is in.
    static let fill = UIColor.secondarySystemFill

    /// The chip's text: the name, set in a little from the pill's ends by a narrow space
    /// that does not break.
    @MainActor static func chip(path: String, token: String, font: UIFont, color: UIColor) -> NSAttributedString {
        let name = (path as NSString).lastPathComponent
        let medium = UIFont.systemFont(ofSize: font.pointSize, weight: .medium)
        return NSAttributedString(string: "\u{202F}\(name.isEmpty ? path : name)\u{202F}", attributes: [
            .font: medium, .foregroundColor: color, .proseMention: ProseMention(),
            .proseCopiesAs: ProseCopiesAs(token), .textItemTag: path,
        ])
    }
}

/// A formula in a line of text: as typeset, made smaller when it is longer than the line
/// (as `MathText` makes it), on the text's baseline.
nonisolated final class FormulaAttachment: NSTextAttachment {
    private var natural = CGSize.zero
    private var baseline: CGFloat = 0
    private var fontSize: CGFloat = 0

    @MainActor
    static func make(_ formula: MathFormula, fontSize: CGFloat, scale: CGFloat, color: UIColor) -> FormulaAttachment? {
        guard let typeset = MathTypesetter.typeset(formula.latex, size: fontSize, style: .inline, scale: scale) else { return nil }
        let attachment = FormulaAttachment(data: nil, ofType: nil)
        // In the text's colour, which a dynamic colour follows as the look changes.
        let image = UIImage(cgImage: typeset.image, scale: typeset.scale, orientation: .up)
            .withTintColor(color, renderingMode: .alwaysOriginal)
        // Read by VoiceOver as written, as `MathText`'s label had it.
        image.accessibilityLabel = formula.latex
        attachment.image = image
        attachment.accessibilityLabel = formula.latex
        attachment.natural = typeset.size
        attachment.baseline = typeset.baseline
        attachment.fontSize = fontSize
        attachment.fit(lineWidth: .infinity)
        return attachment
    }

    /// How far it is lowered, which its run's `baselineOffset` says: as `MathText`
    /// lowers it, which gives its line the same height as there, where lowering it by
    /// its bounds gave a shorter one.
    private(set) var baselineOffset: CGFloat = 0

    /// Fitted with room left for a stop or a comma after it, which would otherwise begin
    /// the next line.
    func fit(lineWidth: CGFloat) {
        let room = lineWidth - fontSize / 2
        let shrink = room > 0 ? max(natural.width / room, 1) : 1
        bounds = CGRect(x: 0, y: 0, width: natural.width / shrink, height: natural.height / shrink)
        baselineOffset = -baseline / shrink
    }
}

/// The place a block that is a view of its own keeps in the text (a code block, a table,
/// a rule, a display formula): a line of its own, as wide as the column and as tall as the
/// view, which `ProseTextView` draws over it. It draws nothing itself. Copied as its
/// text (`proseCopiesAs`).
nonisolated final class BlockAttachment: NSTextAttachment {
    /// Names the block's view across the text set again.
    var key = ""
    /// The block's view, as the column draws it.
    var content: AnyView?

    private static let nothing = UIImage()

    override func image(forBounds imageBounds: CGRect, textContainer: NSTextContainer?, characterIndex charIndex: Int) -> UIImage? {
        Self.nothing
    }

    /// Its bounds as fitted (`ProseTextView.fit`), none before. Left to TextKit, a place
    /// with no bounds yet and no image was measured by the icon of a file of no type,
    /// looked up for each block as a long reply's text was first set (2% of the main
    /// thread's time opening threads on an iPhone simulator).
    override func attachmentBounds(
        for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect, glyphPosition position: CGPoint,
        characterIndex charIndex: Int
    ) -> CGRect {
        bounds
    }
}

/// Sets a run's blocks as attributed text, as `BlockView` and `MathText` draw them.
@MainActor
struct ProseBuilder {
    let style: ProseStyle

    /// One block's text, ending with the break before `next` unless it is the last.
    func text(of block: MarkdownBlock, isFirst: Bool, next: MarkdownBlock?) -> NSAttributedString {
        let text = NSMutableAttributedString()
        let isLast = next == nil
        switch block.kind {
        case .code, .table, .rule, .widget, .image:
            text.append(place(
                for: MarkdownBlocksView.blockContent(block, textStyle: style.textStyle, fillsColumn: style.fillsColumn),
                key: "\(block.id)", copiesAs: Self.copied(block), paragraph: paragraph(isLast: isLast)
            ))
        case .paragraph, .heading, .listItem, .quote:
            // A paragraph a piece: its text, or a display formula on a line of its own, as
            // the block's view stacks them.
            let pieces = block.pieces
            for (index, piece) in pieces.enumerated() {
                let paragraph = paragraph(isLast: isLast && index == pieces.count - 1)
                if index == 0, case .heading = block.kind, style.textStyle == .body, !isFirst {
                    paragraph.paragraphSpacingBefore = Theme.grid / 2
                }
                let marker = indent(for: block, paragraph: paragraph, marked: index == 0)
                let start = text.length
                // Before the item's first piece, a display formula too: its number was lost.
                if let marker { text.append(marker) }
                switch piece {
                case let .text(words):
                    text.append(inline(words, kind: block.kind))
                case let .formula(formula):
                    text.append(place(for: DisplayMathView(formula: formula), key: "\(block.id).\(index)",
                                      copiesAs: formula.source, paragraph: paragraph))
                }
                if index < pieces.count - 1 {
                    text.append(NSAttributedString(string: "\n", attributes: [.font: font(for: block.kind).0, .proseCopiesAs: ProseCopiesAs("\n")]))
                }
                text.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: start, length: text.length - start))
            }
            if case .quote = block.kind {
                text.addAttribute(.proseQuote, value: ProseQuote(), range: NSRange(location: 0, length: text.length))
            }
        }
        if let next {
            let bothItems = Self.isListItem(block) && Self.isListItem(next)
            let paragraph = text.length > 0 ? text.attribute(.paragraphStyle, at: text.length - 1, effectiveRange: nil) : nil
            text.append(NSAttributedString(string: "\n", attributes: [
                .font: font(for: block.kind).0, .paragraphStyle: paragraph ?? self.paragraph(isLast: false),
                .proseCopiesAs: ProseCopiesAs(bothItems ? "\n" : "\n\n"),
            ]))
        }
        return text
    }

    /// The room after a paragraph and between its lines: none after the run's last.
    private func paragraph(isLast: Bool) -> NSMutableParagraphStyle {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = style.lineSpacing
        // TextKit puts the room between lines after a paragraph's last line too (all but
        // the text's last), where the blocks' own views have only the room between them.
        paragraph.paragraphSpacing = isLast ? 0 : style.blockSpacing - style.lineSpacing
        // As SwiftUI's text breaks its lines: a last line of one short word is avoided.
        paragraph.lineBreakStrategy = .standard
        return paragraph
    }

    /// Where a block's lines start: a list item after its marker (which comes with its
    /// first paragraph), nested items further in; a quote after the room its bar has.
    private func indent(for block: MarkdownBlock, paragraph: NSMutableParagraphStyle, marked: Bool) -> NSAttributedString? {
        switch block.kind {
        case let .listItem(marker, depth):
            // As the item's row has it: the marker in the secondary colour, the text a
            // grid's room after it, the lines that wrap lined up with the text.
            let body = Self.font(.body, at: style.dynamicTypeSize)
            let indent = CGFloat(depth - 1) * Theme.grid * 2.5
            // Copied as `Markdown.plainText` has it: nested items four spaces further in,
            // an item's later paragraph two spaces in, with no marker.
            let nesting = String(repeating: "    ", count: max(depth - 1, 0))
            let (shown, copiesAs, markerFont): (String, String, UIFont) = switch marker {
            case .bullet: ("•", nesting + "• ", body)
            case let .number(number): ("\(number).", nesting + "\(number). ", Self.monospacedDigits(body))
            case .none: ("•", nesting + "  ", body)
            }
            // On a whole pixel, as the row lays the marker's view out.
            let scale = max(style.displayScale, 1)
            let width = ((shown as NSString).size(withAttributes: [.font: markerFont]).width * scale).rounded(.up) / scale
            let start = indent + width + Theme.grid
            paragraph.headIndent = start
            paragraph.tabStops = [NSTextTab(textAlignment: .left, location: start)]
            paragraph.defaultTabInterval = 0
            guard marked, marker != .none else {
                paragraph.firstLineHeadIndent = start
                // Nothing shown, but copied: the room in before a later paragraph's text.
                guard marked else { return nil }
                return NSAttributedString(string: "\u{200B}", attributes: [.font: UIFont.systemFont(ofSize: 0.01), .proseCopiesAs: ProseCopiesAs(copiesAs)])
            }
            paragraph.firstLineHeadIndent = indent
            return NSAttributedString(string: shown + "\t", attributes: [
                .font: markerFont, .foregroundColor: UIColor.secondaryLabel, .proseCopiesAs: ProseCopiesAs(copiesAs),
            ])
        case .quote:
            paragraph.headIndent = Theme.grid * 1.5
            paragraph.firstLineHeadIndent = Theme.grid * 1.5
            return nil
        default:
            return nil
        }
    }

    /// The place a block's view keeps: one character, on a line of its own whose type is
    /// too small to add to the view's height.
    private func place(for content: some View, key: String, copiesAs: String, paragraph: NSParagraphStyle) -> NSAttributedString {
        let attachment = BlockAttachment(data: nil, ofType: nil)
        attachment.key = key
        attachment.content = AnyView(content)
        let place = NSMutableAttributedString(attachment: attachment)
        place.addAttributes([
            .font: UIFont.systemFont(ofSize: 0.01), .paragraphStyle: paragraph, .proseCopiesAs: ProseCopiesAs(copiesAs),
        ], range: NSRange(location: 0, length: place.length))
        return place
    }

    /// What a block that is a view of its own copies as, as `Markdown.plainText` has it.
    private static func copied(_ block: MarkdownBlock) -> String {
        switch block.kind {
        case let .table(table):
            ([table.header] + table.rows)
                .filter { !$0.isEmpty }
                .map { row in row.map { String($0.characters) }.joined(separator: "\t") }
                .joined(separator: "\n")
        case .rule: "———"
        case let .widget(widget): widget.source
        default: block.plainText
        }
    }

    static func isListItem(_ block: MarkdownBlock) -> Bool {
        if case .listItem = block.kind { true } else { false }
    }

    /// A block's runs: bold, italic, code, struck through, links underlined, formulas
    /// typeset into the line; a line break inside the block a break of the line, not of
    /// the paragraph, which would add the room between blocks.
    private func inline(_ text: AttributedString, kind: MarkdownBlock.Kind) -> NSAttributedString {
        let (font, fontStyle) = font(for: kind)
        let color: UIColor = if style.isFaint { .secondaryLabel } else if case .quote = kind { .secondaryLabel } else { .label }
        let result = NSMutableAttributedString()
        let mathSize = MathSize.inline(for: fontStyle, at: style.dynamicTypeSize)
        for run in text.runs {
            let characters = String(text[run.range].characters)
            if let path = run.fileMention {
                result.append(ProseMention.chip(path: path, token: characters, font: font, color: color))
                continue
            }
            if let formula = run.mathFormula {
                if let attachment = FormulaAttachment.make(formula, fontSize: mathSize, scale: style.displayScale, color: color) {
                    let piece = NSMutableAttributedString(attachment: attachment)
                    piece.addAttributes([.font: font, .foregroundColor: color, .baselineOffset: attachment.baselineOffset,
                                         .proseCopiesAs: ProseCopiesAs(formula.source)],
                                        range: NSRange(location: 0, length: piece.length))
                    result.append(piece)
                } else {
                    result.append(NSAttributedString(string: formula.source, attributes: [
                        .font: Self.monospaced(font), .foregroundColor: color,
                    ]))
                }
                continue
            }
            let intent = run.inlinePresentationIntent ?? []
            var runFont = font
            if intent.contains(.code) { runFont = Self.monospaced(runFont) }
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty, let descriptor = runFont.fontDescriptor.withSymbolicTraits(runFont.fontDescriptor.symbolicTraits.union(traits)) {
                runFont = UIFont(descriptor: descriptor, size: runFont.pointSize)
            }
            var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: color]
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link {
                attributes[.link] = link
                attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            result.append(NSAttributedString(string: characters.replacingOccurrences(of: "\n", with: "\u{2028}"), attributes: attributes))
        }
        return result
    }

    // MARK: Type

    /// The type a block is set in, as `BlockView` sets it, and the style its formulas are
    /// sized to: plain text's own, a heading's, in a bubble's smaller type a heading is its
    /// text in bold.
    func font(for kind: MarkdownBlock.Kind) -> (UIFont, Font.TextStyle) {
        let size = style.dynamicTypeSize
        switch style.plain {
        case .body: return (Self.font(.body, at: size), .body)
        case .monospacedFootnote: return (Self.monospaced(Self.font(.footnote, at: size)), .footnote)
        case nil: break
        }
        guard case let .heading(level) = kind else { return (Self.font(style.textStyle, at: size), style.textStyle) }
        guard style.textStyle == .body else { return (Self.font(style.textStyle, weight: .semibold, at: size), style.textStyle) }
        return switch level {
        case 1: (Self.font(.title2, weight: .semibold, at: size), .title2)
        case 2: (Self.font(.title3, weight: .semibold, at: size), .title3)
        default: (Self.font(.headline, at: size), .headline)
        }
    }

    /// The app's text style (`AppTextStyles`) as a font: a Mac's fixed size, else the
    /// system's at the reader's text size.
    static func font(_ style: Font.TextStyle, weight: UIFont.Weight? = nil, at size: DynamicTypeSize) -> UIFont {
        if let points = AppTextStyles.fixedSize(of: style) {
            return .systemFont(ofSize: points, weight: weight ?? (style == .headline ? .semibold : .regular))
        }
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
        let font = UIFont.preferredFont(forTextStyle: textStyle(style), compatibleWith: traits)
        guard let weight else { return font }
        return .systemFont(ofSize: font.pointSize, weight: weight)
    }

    private static func monospaced(_ font: UIFont) -> UIFont {
        let weight = (font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat
        return .monospacedSystemFont(ofSize: font.pointSize, weight: UIFont.Weight(weight ?? 0))
    }

    private static func monospacedDigits(_ font: UIFont) -> UIFont {
        .monospacedDigitSystemFont(ofSize: font.pointSize, weight: .regular)
    }

    private static func textStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}

private extension MarkdownBlock {
    var isImage: Bool {
        if case .image = kind { true } else { false }
    }
}

#if DEBUG
/// `PORTALS_DEBUG_PROSE_SELECT`: the first run long enough selects the range asked for
/// two seconds after it shows it, and copies it a second later (`DebugLaunch.copyLogPath`
/// says what was copied), as a drag and ⌘C would; with `PORTALS_DEBUG_PROSE_TYPE`, that
/// text is then typed into it, as keys would be.
enum ProseSelectProbe {
    private static var done = false

    static func selectIfAsked(_ view: ProseTextView) {
        guard !done, let range = DebugLaunch.proseSelectRange, view.textStorage.length >= NSMaxRange(range) else { return }
        done = true
        Task { @MainActor [weak view] in
            try? await Task.sleep(for: .seconds(2))
            guard let view else { return }
            view.selectedRange = range
            _ = view.becomeFirstResponder()
            try? await Task.sleep(for: .seconds(1))
            view.copy(nil)
            guard let typed = DebugLaunch.proseTyped else { return }
            try? await Task.sleep(for: .seconds(1))
            view.forwardTyped(typed)
        }
    }
}

/// `PORTALS_DEBUG_PROSE_HEIGHTS`: once, the height of every run in the scripted
/// showcases, set by the blocks' own views and by `SelectableProse`, at a few widths,
/// written to the file asked for: the two should match for a reply to look as it did.
/// Then what making and laying out each costs.
enum ProseHeightProbe {
    private static var ran = false

    static func runIfAsked() {
        guard !ran, let path = DebugLaunch.proseHeightsPath else { return }
        ran = true
        let extra = [
            "A line with $x$ in it.", "A line with $\\frac{a}{b}$ in it.",
            "> A quote with **bold** and a [link](https://example.com).\n\n> A second quote paragraph.",
            "Before.\n\n```swift\nlet x = 1\nprint(x)\n```\n\nAfter.\n\n---\n\nThe end.",
        ]
        var out = ""
        let sources = [FakeBackend.markdownShowcase, FakeBackend.mathShowcase] + extra
        for width in [812.0, 520.0, 300.0] as [CGFloat] {
            for (index, source) in sources.enumerated() {
                for run in SelectableProse.runs(of: Markdown.blocks(source)) where run.isProse {
                    let old = UIHostingController(rootView: MarkdownBlocksView(blocks: run.blocks).appDefaultFont().environment(\.displayScale, 2))
                    let new = UIHostingController(rootView: SelectableProse(blocks: run.blocks).appDefaultFont().environment(\.displayScale, 2))
                    let fit = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
                    let a = old.sizeThatFits(in: fit).height, b = new.sizeThatFits(in: fit).height
                    let label = String(run.blocks.map(\.plainText).joined(separator: " | ").prefix(60)).replacingOccurrences(of: "\n", with: " ")
                    out += String(format: "%@ w=%.0f src=%d old=%.2f new=%.2f diff=%.2f  %@\n", abs(a - b) < 0.6 ? "ok " : "BAD", width, index, a, b, b - a, label)
                }
            }
        }
        for width in [800.0, 200.0, 40.0] as [CGFloat] {
            let plain = UIHostingController(rootView: SelectablePlainText(text: "Show me").appDefaultFont().environment(\.displayScale, 2))
            let text = UIHostingController(rootView: Text("Show me").font(.app.body).environment(\.displayScale, 2))
            let fit = CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            out += "plain at \(width): \(plain.sizeThatFits(in: fit)) Text: \(text.sizeThatFits(in: fit))\n"
        }
        // Every run of both showcases made anew and measured at the Mac's column width,
        // 30 times, each way.
        let runs = [FakeBackend.markdownShowcase, FakeBackend.mathShowcase].flatMap { SelectableProse.runs(of: Markdown.blocks($0)) }.filter(\.isProse)
        for way in ["old", "new", "old", "new"] {
            let start = Date.now
            for _ in 0..<30 {
                for run in runs {
                    let fit = CGSize(width: 812, height: CGFloat.greatestFiniteMagnitude)
                    if way == "old" {
                        _ = UIHostingController(rootView: MarkdownBlocksView(blocks: run.blocks).appDefaultFont()).sizeThatFits(in: fit)
                    } else {
                        _ = UIHostingController(rootView: SelectableProse(blocks: run.blocks).appDefaultFont()).sizeThatFits(in: fit)
                    }
                }
            }
            let took = Date.now.timeIntervalSince(start) * 1000
            out += String(format: "%@: %d runs x 30 made and measured in %.0f ms (%.2f ms a run)\n", way, runs.count, took, took / Double(30 * runs.count))
        }
        try? out.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

/// `PORTALS_DEBUG_PROSE_CHECKS`: once, a few cases of what a run's text copies and keeps
/// selected, set in a text view off screen, "ok" or "FAIL" a line in the file asked for,
/// which a UI test reads (`ProseCheckUITests`).
enum ProseChecks {
    private static var ran = false

    static func runIfAsked() {
        guard !ran, let path = DebugLaunch.proseChecksPath else { return }
        ran = true
        var out = ""
        func check(_ name: String, _ got: String, _ expected: String) {
            out += got == expected ? "ok   \(name)\n" : "FAIL \(name): got \(got.debugDescription), expected \(expected.debugDescription)\n"
        }
        func shown(_ sources: String...) -> ProseTextView {
            let view = ProseTextView()
            for source in sources {
                view.show(Markdown.blocks(source), settledIn: nil, style: ProseStyle())
                _ = view.fittingSize(width: 390)
            }
            return view
        }
        func copied(_ view: ProseTextView) -> String {
            view.plainText(in: NSRange(location: 0, length: view.textStorage.length))
        }
        func selected(_ view: ProseTextView) -> String {
            view.selectedRange.length > 0 ? (view.textStorage.string as NSString).substring(with: view.selectedRange) : "(nothing)"
        }

        // A list item that starts with a display formula keeps its number.
        check("formula-first item keeps its marker", String(copied(shown("1. $$x = 1$$\n2. Two")).prefix(3)), "1. ")
        // Nested items and an item's later paragraph copy as `Markdown.plainText` has them.
        for source in ["- One\n    - Inner\n- Two", "1. One\n\n   More of one.\n2. Two"] {
            check("copies as the reply: \(source.debugDescription)", copied(shown(source)), Markdown.plainText(source))
        }
        // The break after a block follows what the block after it became.
        let grown = shown("1. First\n\n2", "1. First\n\n2. Second")
        check("break follows the next block's kind", copied(grown), Markdown.plainText("1. First\n\n2. Second"))
        // A selection in a block set again stays on its words: marks closed before it
        // take characters out.
        let marked = shown("Here is **bold and then some")
        let words = ((marked.textStorage.string as NSString).range(of: "then some"))
        marked.selectedRange = words
        marked.show(Markdown.blocks("Here is **bold** and then some more"), settledIn: nil, style: ProseStyle())
        check("selection stays on its words", selected(marked), "then some")
        // A selection whose words are gone lets go.
        let gone = shown("First.\n\nSecond words here")
        gone.selectedRange = (gone.textStorage.string as NSString).range(of: "words here")
        gone.show(Markdown.blocks("First.\n\nSecond"), settledIn: nil, style: ProseStyle())
        check("selection of words gone lets go", selected(gone), "(nothing)")
        // Of the same word twice, the one selected stays selected when a link's definition
        // comes and takes characters out before both.
        let twice = shown("See [a][long-reference-name] word word")
        let first = (twice.textStorage.string as NSString).range(of: "word")
        twice.selectedRange = first
        twice.show(Markdown.blocks("See [a][long-reference-name] word word\n\n[long-reference-name]: https://example.com"), settledIn: nil, style: ProseStyle())
        let string = twice.textStorage.string as NSString
        check("the same of two words stays selected", twice.selectedRange == string.range(of: "word") ? "first" : "\(twice.selectedRange) in \(string)", "first")
        // A formula in the line is read by VoiceOver as written.
        let formula = shown("Use $x+1$ here.")
        var label = "(none)"
        formula.textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: formula.textStorage.length)) { value, _, _ in
            if let attachment = value as? FormulaAttachment { label = attachment.accessibilityLabel ?? "(no label)" }
        }
        check("formula in the line has its source as its label", label, "x+1")
        // A key typed goes to the chat whose text it was, and nowhere from text in no chat.
        final class Posted: @unchecked Sendable { var items: [String] = [] }
        let posted = Posted()
        let observer = NotificationCenter.default.addObserver(forName: ProseSelection.typed, object: nil, queue: nil) { note in
            posted.items.append(note.object == nil ? "nil" : "target")
        }
        let target = ProseTypingTarget()
        let inChat = shown("Typed on.")
        inChat.typingTarget = target
        inChat.forwardTyped("a")
        shown("Typed on too.").forwardTyped("b")
        NotificationCenter.default.removeObserver(observer)
        check("a key typed goes to its own chat only", posted.items.joined(separator: ","), "target")
        // A relayed message in its quieter look is set in the secondary colour, its links
        // too; set again in the plain style, it is in the label colour.
        func colour(_ view: ProseTextView, of word: String) -> String {
            let at = (view.textStorage.string as NSString).range(of: word).location
            guard at != NSNotFound else { return "(no \(word))" }
            let colour = view.textStorage.attribute(.foregroundColor, at: at, effectiveRange: nil) as? UIColor
            return colour == .secondaryLabel ? "secondary" : colour == .label ? "label" : "\(String(describing: colour))"
        }
        let faint = ProseTextView()
        let relayedSource = "Docs are **updated**, see [the guide](https://example.com)"
        faint.show(Markdown.blocks(relayedSource), settledIn: nil, style: ProseStyle(textStyle: .subheadline, fillsColumn: false, isFaint: true))
        // Laid out, as on screen: a text view's text is set once it has a width.
        _ = faint.fittingSize(width: 390)
        check("faint text is secondary", colour(faint, of: "updated"), "secondary")
        check("faint links are secondary", (faint.linkTextAttributes[.foregroundColor] as? UIColor) == .secondaryLabel ? "secondary" : "other", "secondary")
        faint.show(Markdown.blocks(relayedSource), settledIn: nil, style: ProseStyle(textStyle: .subheadline, fillsColumn: false))
        _ = faint.fittingSize(width: 390)
        check("plain again is label", colour(faint, of: "updated"), "label")
        check("plain links are label again", (faint.linkTextAttributes[.foregroundColor] as? UIColor) == .label ? "label" : "other", "label")
        // Opening a thread: a text view's text is set once it has a width, laid out there
        // once, not first in a container of no width; and a block's place is measured by
        // its bounds, not by a file icon's.
        let waits = ProseTextView()
        waits.show(Markdown.blocks("Set **once** it has a width.\n\n```\ncode\n```"), settledIn: nil, style: ProseStyle())
        let before = waits.textStorage.length
        let size = waits.fittingSize(width: 390)
        check("text waits for its width", "\(before) then \(waits.textStorage.length > 0 && size.height > 0)", "0 then true")
        // A run that starts with a heading (the text view's top inset), set before it has
        // a width: laid out at the width it is given, narrower taller. Setting the inset
        // sized the container to the view's bounds, none yet, and every width measured
        // the same.
        let headed = "## A heading first\n\nA paragraph long enough to wrap at a narrow width and not at a wide one, so that the two heights differ."
        func headedHeight(_ width: CGFloat) -> CGFloat {
            let view = ProseTextView()
            view.show(Markdown.blocks(headed), settledIn: nil, style: ProseStyle())
            return view.fittingSize(width: width).height
        }
        check("a heading first is laid out at its width", headedHeight(300) > headedHeight(812) ? "narrower taller" : "same", "narrower taller")
        let place = BlockAttachment(data: nil, ofType: nil)
        let bounds = place.attachmentBounds(for: nil, proposedLineFragment: CGRect(x: 0, y: 0, width: 390, height: 20), glyphPosition: .zero, characterIndex: 0)
        check("a block's place unfitted takes no room", "\(bounds.size)", "\(CGSize.zero)")
        try? out.write(toFile: path, atomically: true, encoding: .utf8)
    }
}
#endif
