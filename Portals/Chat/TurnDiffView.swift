import AgentCore
import SwiftUI

// What a turn changed, as one diff (a bridge's feature `turn_diff`): a quiet "3 files ·
// +40 −12" in the footer under an ended turn, which opens the files with their counts,
// each opening its diff. A sheet on iPhone and iPad, a panel drawn in the window on a Mac.

extension EnvironmentValues {
    /// Opens a file a turn changed in the chat's file viewer (`opensChangedFiles()`, the
    /// feature `file_read`): offered on a file's diff where set. Read by
    /// `showsTurnDiffsHere()`, so set outside it. Nil, from a host that reads no files,
    /// offers no "Open File".
    @Entry var openChangedFile: ((TurnDiff.File) -> Void)? = nil

    /// Opens what a turn changed over the chat (`showsTurnDiffsHere`); nil where there is
    /// nowhere to open it. An object, the same for as long as the chat is shown, as
    /// `widgetExpander` is.
    @Entry var turnDiffPresenter: TurnDiffPresenter? = nil
}

extension View {
    /// Opens what a turn changed from here, a sheet or a panel over the whole chat, not
    /// from the turn's footer: on a Mac the panel is drawn over what opens it, and the
    /// lazy chat lets a row go far from the screen.
    func showsTurnDiffsHere() -> some View {
        modifier(ShowsTurnDiffsHere())
    }
}

/// What a turn changed, open over the chat, if anything is.
@MainActor
@Observable
final class TurnDiffPresenter {
    fileprivate var shown: Shown?

    func show(_ diff: TurnDiff, origin: TurnDiff.Origin = .turn, onFirstFile: Bool = false) {
        shown = Shown(diff: diff, origin: origin, onFirstFile: onFirstFile)
    }

    fileprivate struct Shown: Hashable {
        let id = UUID()
        let diff: TurnDiff
        let origin: TurnDiff.Origin
        let onFirstFile: Bool

        static func == (a: Self, b: Self) -> Bool { a.id == b.id }
        func hash(into hasher: inout Hasher) { hasher.combine(id) }
    }
}

private struct ShowsTurnDiffsHere: ViewModifier {
    @State private var presenter = TurnDiffPresenter()
    @Environment(\.openChangedFile) private var openFile

    func body(content: Content) -> some View {
        @Bindable var presenter = presenter
        content
            .environment(\.turnDiffPresenter, presenter)
            .sheetOrPanel($presenter.shown, width: 760, height: 720) { shown, close in
                TurnDiffPanel(diff: shown.diff, origin: shown.origin, openFile: openFile.map { open in { file in close(); open(file) } }, onDone: close, opensFirstFile: shown.onFirstFile)
            }
    }
}

extension View {
    /// Opens a file a turn changed in the chat's file viewer (`showsFilesHere(_:)`, which
    /// must be outside this, as `showsTurnDiffsHere()` must be inside), at the first line
    /// the turn changed, where the host reads files.
    func opensChangedFiles() -> some View {
        modifier(OpensChangedFiles())
    }
}

private struct OpensChangedFiles: ViewModifier {
    @Environment(\.chatFiles) private var files

    func body(content: Content) -> some View {
        content.environment(\.openChangedFile, opener)
    }

    private var opener: ((TurnDiff.File) -> Void)? {
        guard let files, files.isAvailable else { return nil }
        return { file in
            let location = file.location
            // The diff's sheet closes first: one sheet goes before the next comes.
            Task { @MainActor in
                if UIDevice.current.userInterfaceIdiom != .mac { try? await Task.sleep(for: .milliseconds(450)) }
                files.open(location)
            }
        }
    }
}

/// After the turn's time and tokens, past a dot: what it changed, which opens the files.
struct TurnDiffFooterLink: View {
    let diff: TurnDiff
    /// After the turn's time and tokens, past a dot.
    var follows = true

    @Environment(\.swipeGuard) private var swipeGuard
    @Environment(\.turnDiffPresenter) private var presenter

    var body: some View {
        Button {
            swipeGuard { presenter?.show(diff) }
        } label: {
            HStack(spacing: 3) {
                Text((follows ? " · " : "") + diff.filesLine + " · ")
                ChangeCounts(added: diff.added, removed: diff.removed)
                Image(systemName: "chevron.right")
                    .font(.app.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .font(.app.caption)
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Changed \(diff.filesLine): \(diff.added) lines added, \(diff.removed) removed")
        .accessibilityHint("Shows what this turn changed")
        .accessibilityIdentifier("turn-footer-diff")
        .task {
            // PORTALS_DEBUG_TURN_DIFF: opened once, for screenshots.
            guard let wanted = DebugLaunch.opensTurnDiff, wanted.files == diff.files.count, !Self.debugOpened else { return }
            Self.debugOpened = true
            try? await Task.sleep(for: .seconds(1.5))
            presenter?.show(diff, onFirstFile: wanted.onFile)
        }
    }

    private static var debugOpened = false
}

/// "+40 −12": added in green, removed in red, each only when there is some.
struct ChangeCounts: View {
    let added: Int
    let removed: Int

    var body: some View {
        HStack(spacing: 4) {
            if added > 0 || removed == 0 { Text("+\(added)").foregroundStyle(Color.green) }
            if removed > 0 { Text("\u{2212}\(removed)").foregroundStyle(Color.red) }
        }
        .monospacedDigit()
    }
}

/// The files a turn changed, each opening its diff; a turn of one file opens on its diff.
struct TurnDiffPanel: View {
    let diff: TurnDiff
    var origin = TurnDiff.Origin.turn
    var openFile: ((TurnDiff.File) -> Void)?
    let onDone: () -> Void

    @State private var opened: TurnDiff.File.ID?
    /// The row at the top of the list, which it comes back to from a file: a repository's
    /// list runs to hundreds. None at the list's first, so that its head shows too.
    @State private var topRow: TurnDiff.File.ID?

    init(diff: TurnDiff, origin: TurnDiff.Origin = .turn, openFile: ((TurnDiff.File) -> Void)? = nil, onDone: @escaping () -> Void, opensFirstFile: Bool = false) {
        self.diff = diff
        self.origin = origin
        self.openFile = openFile
        self.onDone = onDone
        _opened = State(initialValue: diff.files.count == 1 || opensFirstFile ? diff.files.first?.id : nil)
    }

    private var openedFile: TurnDiff.File? {
        opened.flatMap { id in diff.files.first { $0.id == id } }
    }

    var body: some View {
        PanelChrome(title: openedFile?.name ?? "Changes", doneIdentifier: "turn-diff-done", onDone: onDone) {
            Group {
                if let file = openedFile {
                    TurnDiffFileView(file: file, origin: origin, onBack: diff.files.count > 1 ? { opened = nil } : nil, openFile: openFile)
                } else {
                    list
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.pageBackground)
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.pageBackground)
    }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.grid) {
                HStack(spacing: 6) {
                    Text(diff.listLine(origin))
                        .foregroundStyle(.secondary)
                    if diff.hasCounts { ChangeCounts(added: diff.added, removed: diff.removed) }
                }
                .font(.app.subheadline)
                .padding(.horizontal, Theme.grid * 0.5)
                LazyVStack(spacing: 0) {
                    ForEach(Array(diff.files.enumerated()), id: \.element.id) { index, file in
                        VStack(spacing: 0) {
                            if index > 0 { Divider().padding(.leading, Theme.grid * 5.5) }
                            Button { opened = file.id } label: { TurnDiffFileRow(file: file) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("turn-diff-file")
                        }
                    }
                }
                .scrollTargetLayout()
                .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                if diff.cut {
                    QuietNote(text: origin.someCutLine, systemImage: "scissors")
                        .padding(.horizontal, Theme.grid * 0.5)
                }
            }
            .padding(Theme.grid * 2)
        }
        .scrollPosition(id: Binding(get: { topRow }, set: { topRow = $0 == diff.files.first?.id ? nil : $0 }), anchor: .top)
    }
}

/// A changed file in the list: what happened to it, its name and folder, its counts.
private struct TurnDiffFileRow: View {
    let file: TurnDiff.File

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name)
                    .font(.app.body.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let folder = file.folder {
                    Text(folder)
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            Spacer(minLength: Theme.grid)
            if !file.uncounted {
                ChangeCounts(added: file.added, removed: file.removed)
                    .font(.app.caption)
            }
            Image(systemName: "chevron.right")
                .font(.app.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Theme.grid * 1.5)
        .padding(.vertical, Theme.grid * 1.25)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(file.uncounted ? "\(file.path), \(statusWord)" : "\(file.path), \(statusWord), \(file.added) added, \(file.removed) removed")
    }

    private var symbol: String {
        switch file.status {
        case .added: "doc.badge.plus"
        case .modified: "doc.text"
        case .deleted: "trash"
        }
    }

    private var tint: Color {
        switch file.status {
        case .added: .green
        case .modified: .secondary
        case .deleted: .red
        }
    }

    private var statusWord: String {
        switch file.status {
        case .added: "new"
        case .modified: "changed"
        case .deleted: "deleted"
        }
    }
}

/// One file's diff, whole: lines kept to one line each, scrolled across where long, with
/// the new file's line numbers beside them.
struct TurnDiffFileView: View {
    let file: TurnDiff.File
    var origin = TurnDiff.Origin.turn
    /// Back to the list, for a turn of several files.
    var onBack: (() -> Void)?
    var openFile: ((TurnDiff.File) -> Void)?

    /// Parsed once a file, not at every redraw.
    @State private var parsed: NumberedDiff?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let parsed {
                lines(parsed)
            } else {
                Color.clear
            }
        }
        .task(id: file.diff) {
            let diff = file.diff
            parsed = await Task.detached(priority: .userInitiated) { NumberedDiff(diff) }.value
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            if let onBack {
                Button(action: onBack) {
                    Label("All files", systemImage: "chevron.left")
                        .font(.app.subheadline)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .accessibilityIdentifier("turn-diff-back")
            }
            HStack(alignment: .firstTextBaseline, spacing: Theme.grid) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.path)
                        .font(.app.footnote.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.head)
                        .textSelection(.enabled)
                    HStack(spacing: 6) {
                        if file.status != .modified {
                            Text(file.status == .added ? "New file" : "Deleted")
                                .foregroundStyle(file.status == .added ? Color.green : Color.red)
                        }
                        if !file.uncounted { ChangeCounts(added: file.added, removed: file.removed) }
                    }
                    .font(.app.caption)
                }
                Spacer(minLength: Theme.grid)
                if let openFile, file.status != .deleted {
                    Button("Open File") { openFile(file) }
                        .font(.app.caption)
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("turn-diff-open-file")
                }
                Button {
                    UIPasteboard.general.string = file.diff
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .font(.app.caption)
                .buttonStyle(.bordered)
                .disabled(file.diff.isEmpty)
                .accessibilityLabel("Copy the diff")
                .accessibilityIdentifier("turn-diff-copy")
            }
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid * 1.5)
    }

    private func lines(_ parsed: NumberedDiff) -> some View {
        GeometryReader { frame in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if parsed.lines.isEmpty {
                        Text(file.cut ? origin.leftOutLine : "No lines changed.")
                            .font(.app.footnote)
                            .foregroundStyle(.secondary)
                            .padding(Theme.grid * 2)
                    }
                    ForEach(parsed.lines) { line in
                        DiffLineRow(line: line, gutter: parsed.gutter, minWidth: frame.size.width)
                    }
                    if file.cut, !parsed.lines.isEmpty {
                        Text(origin.cutShortLine)
                            .font(.app.footnote)
                            .foregroundStyle(.secondary)
                            .padding(Theme.grid * 2)
                    }
                }
                .padding(.vertical, Theme.grid / 2)
            }
            .scrollIndicators(.automatic)
        }
        .accessibilityIdentifier("turn-diff-lines")
    }
}

/// One line of a diff: its number in the new file, its mark, its text, on green or red.
private struct DiffLineRow: View {
    let line: NumberedDiff.Line
    /// Characters the numbers take.
    let gutter: Int
    /// The view's width: a short line's colour still runs across it.
    let minWidth: CGFloat

    var body: some View {
        HStack(spacing: Theme.grid) {
            Text(line.number.map(String.init) ?? "")
                .foregroundStyle(.tertiary)
                .frame(width: CGFloat(gutter) * 8 + 4, alignment: .trailing)
            Text(mark)
                .foregroundStyle(.secondary)
                .frame(width: 10, alignment: .leading)
            Text(line.text.isEmpty ? " " : line.text)
                .foregroundStyle(line.kind == .hunk ? .secondary : .primary)
                .lineLimit(1)
                .fixedSize()
        }
        .font(.app.footnote.monospaced())
        .padding(.horizontal, Theme.grid * 1.5)
        .padding(.vertical, 1.5)
        .frame(minWidth: minWidth, alignment: .leading)
        .background(background)
    }

    private var mark: String {
        switch line.kind {
        case .added: "+"
        case .removed: "\u{2212}"
        case .context, .hunk: " "
        }
    }

    private var background: Color {
        switch line.kind {
        case .added: .green.opacity(0.16)
        case .removed: .red.opacity(0.16)
        case .hunk: .secondary.opacity(0.08)
        case .context: .clear
        }
    }
}
