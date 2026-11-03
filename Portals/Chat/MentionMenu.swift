import AgentCore
import SwiftUI
import UIKit

// Mentioning a file with `@` in the composer (docs/plans/2026-10-26-file-mentions.md,
// section 8, as decided on 2026-10-26): an `@` at the start of a word opens a menu of
// the host's files above the composer, where the slash commands' is; each keystroke after
// it searches (`FileMentionSearch`); a file picked is written in as its `@path` token, which
// is coloured while it is typed, and a folder picked is gone into. Only on a host that
// searches files (a bridge's `file_search`).

/// The `@` menu of one chat: the query at the caret, the host's answer, and the row a
/// keyboard is on.
@MainActor
@Observable
final class ComposerMentions {
    let search = FileMentionSearch()
    /// The `@` being typed at the caret, while the menu is open for it.
    private(set) var query: MentionQuery?
    /// The folder searched, as of the last look.
    private(set) var scope: FileSearchScope?
    /// The row Return or Tab picks, by its id; nil for the first.
    private var highlightedID: String?
    /// The text `query` was found in, which a pick replaces it in.
    @ObservationIgnored private var queryText = ""
    /// An `@` whose menu Escape closed: it stays closed until the caret leaves it.
    @ObservationIgnored private var dismissed: Int?
    @ObservationIgnored private var looksSoon = false
    /// The last look found an `@` being typed at the caret while a word was being composed.
    @ObservationIgnored private var composingAtQuery = false

    /// How many hits to ask for; the menu shows fewer and scrolls to the rest.
    static let limit = 50

    var isOpen: Bool { query != nil }

    /// The answer for the folder searched now (an older query's until the new one's comes),
    /// none once the query was refused.
    var results: FileSearchResults? {
        guard let query, let scope else { return nil }
        return search.shown(for: .init(query: query.text, scope: scope))
    }

    var rows: [MentionRow] {
        guard let query, let results else { return [] }
        // An older query's answer, standing in until this one's comes.
        return MentionRow.rows(for: query.text, hits: results.hits)
    }

    /// What the menu says in place of rows: why the host gave none for this query, or that
    /// nothing matched it (or the query before it, until this one's answer comes).
    var emptyLine: String? {
        guard let query, let scope else { return nil }
        let asked = FileMentionSearch.Asked(query: query.text, scope: scope)
        if let problem = search.problem, problem.asked == asked { return problem.message }
        if search.findsNothing(for: asked) { return "No files match" }
        return nil
    }

    var highlighted: Int {
        rows.firstIndex { $0.id == highlightedID } ?? 0
    }

    /// Looks at the text and the caret once the field has settled: its text and its caret
    /// change one after the other as a key is typed, and are read together.
    func lookSoon(_ read: @escaping () -> Snapshot, search: @escaping @MainActor (String, FileSearchScope) async throws -> FileSearchResults) {
        guard !looksSoon else { return }
        looksSoon = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            looksSoon = false
            look(at: read(), search: search)
            // A word being composed at an `@`: looked at again until the input method has
            // given it, which it can do without the text or the caret changing.
            if composingAtQuery {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.lookSoon(read, search: search) }
            }
        }
    }

    /// What the menu follows.
    struct Snapshot {
        var text: String
        var caret: TextSelection?
        /// The chat is on screen.
        var isShown: Bool
        var picked: [String]
        var scope: FileSearchScope?
    }

    func look(at snapshot: Snapshot, search: @escaping @MainActor (String, FileSearchScope) async throws -> FileSearchResults) {
        var found: MentionQuery?
        if snapshot.isShown, snapshot.scope != nil, let caret = Self.caret(snapshot.caret, in: snapshot.text) {
            found = MentionQuery.at(caret, in: snapshot.text)
        }
        // Not while a word is being composed (Chinese, Japanese): its keys are the input
        // method's, and the menu opens on the word it gives.
        composingAtQuery = found != nil && Platform.isComposingText
        if composingAtQuery { found = nil }
        // A token picked, the caret at its end: a mention made, not one being typed.
        if let typed = found, !typed.isQuoted, snapshot.picked.contains(typed.text) { found = nil }
        if let typed = found, typed.anchor == dismissed {
            found = nil
        } else {
            dismissed = nil
        }
        if found?.text != query?.text { highlightedID = nil }
        if found != query { query = found }
        if snapshot.scope != scope { scope = snapshot.scope }
        queryText = snapshot.text
        guard let found, let scope = snapshot.scope else { return self.search.stop() }
        self.search.ask(.init(query: found.text, scope: scope)) { try await search($0, scope) }
    }

    /// The arrows: the row above or below, no further than the first or the last.
    func move(_ step: Int) {
        let rows = rows
        guard !rows.isEmpty else { return }
        highlightedID = rows[min(max(highlighted + step, 0), rows.count - 1)].id
    }

    /// Escape: closed until the caret leaves this `@`.
    func close() {
        dismissed = query?.anchor
        leave()
    }

    /// The composer lost its focus: closed until it is typed in again.
    func leave() {
        if query != nil { query = nil }
        search.stop()
    }

    /// What picking `row` writes in place of the query, and the path it mentions (none for
    /// a folder gone into). nil when the text changed since the query was found.
    func edit(picking row: MentionRow, in text: String) -> (edit: MentionEdit, mentioned: String?)? {
        guard let query, text == queryText else { return nil }
        switch row {
        case let .folder(path):
            return (query.writing(path, in: text), path)
        case let .hit(hit) where hit.kind == .folder:
            return (query.descending(into: hit.path, in: text), nil)
        case let .hit(hit):
            return (query.writing(hit.path, in: text), hit.path)
        }
    }

    /// The caret in `text`: nil for a selection; the end of the text where the field has
    /// not said yet. An index from before the text last changed is taken by its offset.
    private static func caret(_ selection: TextSelection?, in text: String) -> String.Index? {
        guard let selection else { return text.endIndex }
        guard case let .selection(range) = selection.indices, range.isEmpty else { return nil }
        guard range.lowerBound <= text.endIndex else { return text.endIndex }
        return String.Index(utf16Offset: range.lowerBound.utf16Offset(in: text), in: text)
    }
}

/// How the composer's field reaches the menu above it, the slash commands' or the `@`
/// menu: the text or the caret moved, and the keys a keyboard gives the menu while it is
/// open (the arrows move through its rows, Return or Tab picks one, Escape closes it).
struct ComposerMenuLink {
    /// A menu is on screen.
    var isOpen: () -> Bool
    /// The text or the caret moved: the `@` menu opens for an `@` being typed, or closes.
    var follow: () -> Void
    /// The field lost its focus.
    var leave: () -> Void
    var move: (Int) -> Void
    /// Picks the row the keyboard is on, for Return (`viaReturn`) or Tab; false when there
    /// is none (nothing matched), or Return is to send what is typed as it is.
    var pick: (_ viaReturn: Bool) -> Bool
    var close: () -> Void
}

/// The files and folders that match what is typed after an `@`, just above the composer,
/// built as the slash commands' menu is (`CommandMenu`). A file picked is written into the
/// message; a folder is gone into, with a row at the top to mention the folder itself.
struct MentionMenu: View {
    let mentions: ComposerMentions
    var onPick: (MentionRow) -> Void

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    /// A row's text with a little room above and below it, less on a Mac, which is pointed at
    /// (2026-10-28: "making vertical padding slightly less").
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = Platform.isMac ? 32 : 36
    @ScaledMetric(relativeTo: .caption2) private var noteHeight: CGFloat = 15

    /// Between the menu's edge and its rows, whose marks are rounded within its corners.
    static let inset = Theme.grid * 0.75

    /// About six rows on a phone, so most of the chat stays in view above the keyboard;
    /// eight on a Mac and a wide iPad (2026-10-28: "reducing a few rows"; it was
    /// eight and twelve).
    private var visibleRows: CGFloat {
        Platform.isMac || horizontalSizeClass == .regular ? 8.4 : 6.4
    }

    /// Where a keyboard's Return picks a row, the row it picks is marked: a Mac, an iPad.
    private var marksHighlighted: Bool {
        Platform.isMac || UIDevice.current.userInterfaceIdiom == .pad
    }

    var body: some View {
        let rows = mentions.rows
        let results = mentions.results
        let highlighted = mentions.highlighted
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if rows.isEmpty, let line = mentions.emptyLine {
                        Text(line)
                            .font(.app.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .padding(.horizontal, Theme.grid * 1.25)
                            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
                    }
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        self.row(row, note: note(of: row, in: results), isHighlighted: marksHighlighted && index == highlighted)
                            .id(row.id)
                    }
                }
                .padding(Self.inset)
            }
            .scrollIndicators(.hidden)
            .onChange(of: highlighted) { _, index in
                guard rows.indices.contains(index) else { return }
                reader.scrollTo(rows[index].id)
            }
        }
        .frame(height: height(of: rows, results: results))
        .composerMenuGlass()
        .accessibilityIdentifier("mention-menu")
    }

    /// As tall as its rows, up to `visibleRows` of them.
    private func height(of rows: [MentionRow], results: FileSearchResults?) -> CGFloat {
        guard !rows.isEmpty else { return rowHeight + Self.inset * 2 }
        let all = rows.reduce(CGFloat(0)) { $0 + rowHeight + (note(of: $1, in: results) == nil ? 0 : noteHeight) }
        return min(all, visibleRows * rowHeight) + Self.inset * 2
    }

    /// The small note on a file the agent may not get all of with the message (2026-10-26: "Yes, a small note").
    private func note(of row: MentionRow, in results: FileSearchResults?) -> String? {
        guard case let .hit(hit) = row else { return nil }
        return results?.fit(of: hit).note
    }

    private func row(_ row: MentionRow, note: String?, isHighlighted: Bool) -> some View {
        Button { onPick(row) } label: {
            HStack(spacing: Theme.grid * 1.25) {
                Image(systemName: symbol(of: row))
                    .font(.app.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.grid * 0.75) {
                        Text(name(of: row))
                            .font(.app.subheadline)
                            .lineLimit(1)
                            .layoutPriority(1)
                        if let folder = folder(of: row) {
                            Text(folder)
                                .font(.app.footnote)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    if let note {
                        Text(note)
                            .font(.app.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if case let .hit(hit) = row, hit.kind == .folder {
                    Image(systemName: "chevron.right")
                        .font(.app.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, Theme.grid * 1.25)
            .frame(height: rowHeight + (note == nil ? 0 : noteHeight))
            .background(isHighlighted ? Color(uiColor: .tertiarySystemFill) : .clear)
            .contentShape(.rect)
        }
        .buttonStyle(PressedRowStyle())
        // Its mark, picked by the keyboard or pressed, as round as the menu's corner within it.
        .clipShape(.rect(cornerRadius: ComposerMenuGlass.corner - Self.inset))
        .accessibilityLabel(label(of: row, note: note))
        .accessibilityHint(hint(of: row))
    }

    private func symbol(of row: MentionRow) -> String {
        switch row {
        case .folder: "folder"
        case let .hit(hit): hit.kind == .folder ? "folder" : FileChip.symbol(for: hit.name)
        }
    }

    /// The name, its matched letters in bold.
    private func name(of row: MentionRow) -> AttributedString {
        switch row {
        case let .folder(path):
            return AttributedString((path as NSString).lastPathComponent)
        case let .hit(hit):
            var name = AttributedString(hit.name)
            for range in hit.nameMatches {
                guard let lower = AttributedString.Index(range.lowerBound, within: name),
                      let upper = AttributedString.Index(range.upperBound, within: name) else { continue }
                name[lower ..< upper].font = Font.app.subheadline.bold()
            }
            return name
        }
    }

    /// The folder it is in, or for the folder gone into, what its row does.
    private func folder(of row: MentionRow) -> String? {
        switch row {
        case .folder: "This folder"
        case let .hit(hit): hit.folder.isEmpty ? nil : hit.folder
        }
    }

    private func label(of row: MentionRow, note: String?) -> String {
        let said: String = switch row {
        case let .folder(path): "This folder, \(path)"
        case let .hit(hit): hit.folder.isEmpty ? hit.name : "\(hit.name), in \(hit.folder)"
        }
        return [said, note].compactMap(\.self).joined(separator: ". ")
    }

    private func hint(of row: MentionRow) -> String {
        if case let .hit(hit) = row, hit.kind == .folder { return "Shows the files in it" }
        return "Mentions it in the message"
    }
}

// MARK: - The menus' glass

/// The glass of a menu just above the composer, the slash commands' or the `@` menu, which
/// lies over the chat (`ChatScreen.composerMenu`).
enum ComposerMenuGlass {
    /// The composer's corner (`ChatComposer.shape`).
    static var corner: CGFloat {
        ChatFeature.composerSend / 2 + Theme.grid * (Platform.isMac ? 0.75 : 0.5)
    }
}

extension View {
    /// In the composer's corners, what scrolls in it cut by them (rows showed square
    /// there), and tinted with the background so that its rows read over the replies
    /// behind it, as they did when the chat faded out under it.
    func composerMenuGlass() -> some View {
        let shape = RoundedRectangle(cornerRadius: ComposerMenuGlass.corner)
        return clipShape(shape)
            .glassEffect(.regular.tint(Color(uiColor: .systemBackground).opacity(0.6)), in: shape)
    }
}

// MARK: - Escape

/// Escape closes the `@` menu. A Mac's field takes the key itself before SwiftUI's
/// `onKeyPress` would see it, and lets go of the focus; so while the menu is open, a key
/// command that comes before the field's own handling of it is added where the field's
/// keys go, the view controller it is in, and taken away as the menu closes, or as the
/// chat whose menu it is goes (`release`).
@MainActor
enum MenuEscapeKey {
    private static var added: (controller: UIViewController, command: UIKeyCommand)?
    private static var action: (() -> Void)?
    /// The menu Escape is taken for (its `ComposerMentions`), while one is.
    private static weak var owner: AnyObject?

    /// Escape does `action` for `owner`'s menu from now on, or nothing of a menu's for nil.
    static func take(_ action: (() -> Void)?, for owner: AnyObject) {
        if let added {
            added.controller.removeKeyCommand(added.command)
            self.added = nil
        }
        self.action = action
        self.owner = action == nil ? nil : owner
        guard action != nil else { return }
        ComposerTokens.FieldFinder.found = nil
        UIApplication.shared.sendAction(#selector(UIResponder.composerTokenFieldFind), to: nil, from: nil, for: nil)
        var next = ComposerTokens.FieldFinder.found?.next
        while let responder = next, !(responder is UIViewController) { next = responder.next }
        guard let controller = next as? UIViewController else { return }
        let command = UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(UIResponder.composerMenuEscape))
        command.wantsPriorityOverSystemBehavior = true
        controller.addKeyCommand(command)
        added = (controller, command)
    }

    /// `owner`'s menu is gone, with its chat (⌘W closed its tab) or out of sight: Escape is
    /// let go of, unless another menu has taken it since. Left taken, the command stayed on
    /// the window's controller and took Escape from Settings and the lightbox, to close a
    /// menu that was gone (bug hunt round 4, APP3).
    static func release(_ owner: AnyObject) {
        guard self.owner === owner else { return }
        take(nil, for: owner)
    }

    fileprivate static func pressed() {
        action?()
    }
}

// MARK: - The tokens while typing

/// Colours the `@path` tokens picked from the menu in the composer's field while it is
/// typed in (2026-10-26: "coloured @path text"). SwiftUI's field takes a string and
/// sets its text's attributes again as it likes, so the colour is not put in the text: it is
/// how the field's text view draws it (TextKit 2's rendering attributes, asked for as each
/// piece of the text is laid out), the characters and their attributes left as SwiftUI has
/// them. What is sent never changes; should the colour ever be lost, the tokens are plain
/// text until the field is laid out again.
@MainActor
enum ComposerTokens {
    /// The app's tint is the text's own colour; a token stands out from it in blue.
    static let colour = UIColor.systemBlue

    /// The paths picked in the composer being typed in, whose tokens are coloured. Set as
    /// the text changes, before the field lays the new text out.
    private static var picked: [String] = []
    /// The field they are drawn in: the composer's, found as the first responder.
    private static weak var field: UITextView?
    /// The tokens' ranges in the text last drawn, for the pieces of it laid out one by one.
    private static var found: (text: String, picked: [String], ranges: [NSRange])?

    /// Colours `picked`'s tokens in the composer's field, which holds `text`, and nothing else.
    static func colour(_ text: String, picked: [String]) {
        let changed = picked != self.picked
        self.picked = picked
        guard !picked.isEmpty || changed else { return }
        // Once the field has the text: it is the first responder as it is typed in.
        DispatchQueue.main.async {
            FieldFinder.found = nil
            UIApplication.shared.sendAction(#selector(UIResponder.composerTokenFieldFind), to: nil, from: nil, for: nil)
            guard let field = FieldFinder.found as? UITextView, field.isEditable, field.text == text, let layout = field.textLayoutManager else { return }
            self.field = field
            if layout.renderingAttributesValidator == nil {
                layout.renderingAttributesValidator = { manager, fragment in
                    MainActor.assumeIsolated { draw(in: manager, fragment) }
                }
            }
            // Drawn again with the tokens now picked: a pick changes them, not the text laid out.
            layout.invalidateRenderingAttributes(for: layout.documentRange)
            unmarkSpelling(in: field, layout: layout, text: text)
            spareFromSpelling()
        }
    }

    /// The text checker's mark on a word it found misspelled, drawn as a red underline, and its
    /// twin for VoiceOver (Catalyst's text view puts them on its text and as TextKit 2's
    /// rendering attributes both).
    private static let spelling = [NSAttributedString.Key("NSSpellingState"), NSAttributedString.Key("NSAccessibilitySpellingState")]
    /// Takes the checker's marks off the tokens while the field holds some.
    private static var sweeping: Timer?

    /// No red underline in a token (2026-10-27, `plan.md` underlined on a Mac). The
    /// text checker marks a word some time after it is typed, as it likes, and the field
    /// gives no word of it: the marks in the tokens are taken off now and every half second
    /// while the field is typed in and holds tokens. The rest of the text is checked as before.
    private static func spareFromSpelling() {
        guard sweeping == nil, Platform.isMac else { return }
        sweeping = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated {
                guard let field, field.isFirstResponder, let layout = field.textLayoutManager, !picked.isEmpty, let text = field.text,
                      !FileMentionDraft.tokens(picked: picked, in: text).isEmpty else {
                    sweeping?.invalidate()
                    sweeping = nil
                    return
                }
                unmarkSpelling(in: field, layout: layout, text: text)
            }
        }
    }

    /// Takes the checker's marks off the tokens of `text`, the field's: only where it put
    /// some, as a change of the text's attributes lays the line out again.
    private static func unmarkSpelling(in field: UITextView, layout: NSTextLayoutManager, text: String) {
        guard field.markedTextRange == nil else { return }
        let storage = field.textStorage
        let start = layout.documentRange.location
        for range in FileMentionDraft.tokens(picked: picked, in: text).map({ NSRange($0, in: text) }) where NSMaxRange(range) <= storage.length {
            var marked = false
            storage.enumerateAttribute(spelling[0], in: range) { value, _, stop in
                if value != nil { marked = true; stop.pointee = true }
            }
            if marked {
                storage.beginEditing()
                for key in spelling { storage.removeAttribute(key, range: range) }
                storage.endEditing()
            }
            guard let from = layout.location(start, offsetBy: range.location), let to = layout.location(from, offsetBy: range.length),
                  let token = NSTextRange(location: from, end: to) else { continue }
            for key in spelling { layout.removeRenderingAttribute(key, for: token) }
        }
    }

    /// Colours the tokens that fall in `fragment`, as TextKit lays it out.
    private static func draw(in manager: NSTextLayoutManager, _ fragment: NSTextLayoutFragment) {
        guard !picked.isEmpty, let field, field.textLayoutManager === manager, let text = field.text else { return }
        if found?.text != text || found?.picked != picked {
            found = (text, picked, FileMentionDraft.tokens(picked: picked, in: text).map { NSRange($0, in: text) })
        }
        let start = manager.documentRange.location
        for range in found?.ranges ?? [] {
            guard let from = manager.location(start, offsetBy: range.location), let to = manager.location(from, offsetBy: range.length),
                  let token = NSTextRange(location: from, end: to), let piece = token.intersection(fragment.rangeInElement) else { continue }
            manager.setRenderingAttributes([.foregroundColor: colour], for: piece)
        }
    }

    /// The responder found by `composerTokenFieldFind`, for as long as the call takes.
    enum FieldFinder {
        static weak var found: UIResponder?
    }
}

private extension UIResponder {
    /// Sent to the first responder: the one receiving it says it is.
    @objc func composerTokenFieldFind() {
        MainActor.assumeIsolated { ComposerTokens.FieldFinder.found = self }
    }

    /// Escape pressed while the `@` menu is open (`MenuEscapeKey`).
    @objc func composerMenuEscape() {
        MainActor.assumeIsolated { MenuEscapeKey.pressed() }
    }
}
