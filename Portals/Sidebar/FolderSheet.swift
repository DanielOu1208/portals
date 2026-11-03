import AgentCore
import SwiftUI

/// Where a new thread works: the folders its host offers, General first, then the ones
/// its agents used lately, most recent first. The list is the host's, the same whichever
/// agent the thread is with, so the agent may be chosen after the folder (`agent` nil).
/// On a Mac, for a host on that same Mac, a row on top opens the Mac's own folder dialog
/// for a folder that is not on the list. A host that searches its folders (a bridge's
/// `folder_search`) has a search field on top: typing finds any folder under its home
/// folder, fuzzy, or completes a path typed as in a terminal (`~/cod/por`); one picked
/// that is not on the list is added on the host first, as one chosen in the folder dialog
/// is. Picking a folder dismisses the sheet and hands it over; dismissing the sheet does
/// nothing.
struct FolderSheet: View {
    /// The agent the thread is with, when that is chosen already.
    var agent: Agent?
    let host: HostModel
    var onPick: (Folder) -> Void

    /// Asking the host for the list, which may be on screen already from the last time.
    @State private var isLoading = false
    /// The Mac's folder dialog is open.
    @State private var showsDialog = false
    /// What the person typed in the search field.
    @State private var query = DebugLaunch.folderSearch ?? ""
    /// The host's answer for `searched`, kept on screen while the next query is asked.
    @State private var results: FolderSearchResults?
    /// The query `results` answer.
    @State private var searched = ""
    /// Asking the host for a query.
    @State private var isSearching = false
    /// Why the host did not search.
    @State private var searchProblem: String?
    /// A folder found being added on the host, before the thread starts there.
    @State private var adding: String?
    /// Adding it: called off when the sheet goes (Cancel), so no thread starts after.
    @State private var addition: Task<Void, Never>?
    /// Why the host did not take a folder found.
    @State private var addProblem: String?
    /// A folder found in a git worktree, whose repository's folder the host added.
    @State private var worktree: Folder?
    @FocusState private var isTyping: Bool

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        // On a Mac the panel's own bar: in the window's, the sheet's Cancel was cut to "C…".
        PanelChrome(
            title: agent.map { "Where should \($0.displayName) work?" } ?? "Where should the thread work?",
            doneIdentifier: "folder-sheet-cancel",
            cancels: true,
            onDone: { dismiss() }
        ) {
            // The field over what is under it, beside it in the stack: in a safe-area inset
            // of what is under it, which changes as the field is typed in (the list, a
            // spinner, the folders found), the field was made again at each change and the
            // keyboard went away after one letter (2026-10-27).
            VStack(spacing: 0) {
                if searches { searchField }
                content
                    .frame(maxHeight: .infinity)
                    // The first rows under the field, not a section's height below it.
                    .contentMargins(.top, searches ? Theme.grid : Theme.grid * 2, for: .scrollContent)
            }
            .task { await load() }
            .task(id: trimmedQuery) { await search(trimmedQuery) }
            .onDisappear { addition?.cancel() }
            .folderDialog(isPresented: $showsDialog, on: host) { folder in
                dismiss()
                onPick(folder)
            }
            .alert(
                "That folder can't be used",
                isPresented: Binding(get: { addProblem != nil }, set: { if !$0 { addProblem = nil } }),
                presenting: addProblem
            ) { _ in
                Button("OK", role: .cancel) {}
            } message: { problem in
                Text(problem)
            }
            .alert(
                worktree.map { "\($0.name) is the project" } ?? "",
                isPresented: Binding(get: { worktree != nil }, set: { if !$0 { worktree = nil } }),
                presenting: worktree
            ) { added in
                Button("OK") {
                    guard let path = added.worktree else { return }
                    dismiss()
                    onPick(Folder(path: path))
                }
            } message: { added in
                Text(FolderDialog.worktreeMessage(added))
            }
        }
        // One surface under the bar, the field and the lists, at every height: Settings'
        // page (2026-10-27: "partially liquid glass and partially solid"). The sheet
        // was glass at the medium height, where the list let it through but the field's
        // strip did not, and white at the large one, under a list in the grouped grey. On a
        // Mac the app's own white or black, with the rows a little off it (`settingsRows`).
        // Glass is for floating controls (`Theme`): the bar's Cancel.
        .modifier(SettingsSurface())
        .presentationBackground(SettingsScreen.background)
        .presentationDetents([.medium, .large])
        .sheetOnMac()
        .accessibilityIdentifier("folder-sheet")
    }

    /// What is under the field: the folders found for what is typed in it, else the host's list.
    @ViewBuilder private var content: some View {
        if searches, !trimmedQuery.isEmpty {
            found
        } else if let list = host.folders {
            folders(list)
        } else if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label("No folders", systemImage: "folder.badge.questionmark")
            } description: {
                Text(host.foldersProblem ?? "\(host.host.name) did not list its folders.")
            } actions: {
                Button("Try again") { Task { await load() } }
                    .buttonStyle(.borderedCapsule)
            }
        }
    }

    private func folders(_ list: FolderList) -> some View {
        List {
            // The ways to a folder that is not a recent one, together.
            Section {
                if host.choosesFoldersOnThisMac {
                    Button {
                        showsDialog = true
                    } label: {
                        FolderRow(symbol: "folder.badge.plus", name: Text("Choose a folder…"))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("folder-row-choose")
                }
                row(list.general, detail: Folder.tidyPath(list.general.path))
            }
            .settingsRows()
            if !list.recent.isEmpty {
                Section {
                    ForEach(list.recent) { folder in
                        // Two folders of one name are told apart by where they are.
                        let isAmbiguous = list.recent.contains { $0.path != folder.path && $0.name == folder.name }
                        row(folder, age: folder.lastUsed.map { Self.lastUsed($0) }, detail: isAmbiguous ? Folder.tidyPath(folder.path) : nil)
                    }
                } header: {
                    Text("Recent")
                        .formHeader()
                }
                .settingsRows()
            }
        }
    }

    private func row(_ folder: Folder, age: String? = nil, detail: String? = nil) -> some View {
        Button {
            dismiss()
            onPick(folder)
        } label: {
            FolderRow(
                symbol: folder.isGeneral ? Folder.generalSymbol : "folder",
                name: Text(folder.name),
                detail: detail.map { Text($0) },
                age: age
            )
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("folder-row-\(folder.name)")
    }

    // MARK: Searching the host's folders

    /// The host searches its folders: the field is shown.
    private var searches: Bool { host.searchesFolders }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The sidebar's search field, with the host's spinner while it looks.
    private var searchField: some View {
        SearchField(
            prompt: "Search, or type a path like ~/code",
            text: $query,
            isFocused: $isTyping,
            isBusy: isSearching || adding != nil,
            identifier: "folder-search-field"
        )
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.go)
        // Return takes the first folder found.
        .onSubmit {
            if let first = results?.hits.first, searched == trimmedQuery { pick(first) }
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid)
    }

    /// The folders the host found for the query, best first.
    @ViewBuilder private var found: some View {
        if let searchProblem {
            ContentUnavailableView {
                Label("Can't search", systemImage: "exclamationmark.magnifyingglass")
            } description: {
                Text(searchProblem)
            }
        } else if let results, !results.hits.isEmpty {
            List {
                Section {
                    ForEach(results.hits) { hit in
                        hitRow(hit)
                    }
                } footer: {
                    Group {
                        if results.refreshing {
                            Text("\(host.host.name) is still looking through its folders.")
                        } else if results.mode == .path, !trimmedQuery.hasSuffix("/") {
                            Text("Type / to see what a folder holds.")
                        }
                    }
                    .formFooter()
                }
                .settingsRows()
            }
            .scrollDismissesKeyboard(.immediately)
        } else if results != nil, searched == trimmedQuery, !isSearching {
            ContentUnavailableView {
                Label("No folders found", systemImage: "folder.badge.questionmark")
            } description: {
                Text(trimmedQuery.contains("/") || trimmedQuery.hasPrefix("~")
                    ? "No folder on \(host.host.name) is at that path."
                    : "No folder on \(host.host.name) matches \u{201C}\(trimmedQuery)\u{201D}. Try fewer letters, or a path like ~/code.")
            }
        } else {
            // The first answer is on its way: the field's spinner says so.
            Color.clear
        }
    }

    private func hitRow(_ hit: FolderSearchHit) -> some View {
        Button {
            pick(hit)
        } label: {
            FolderRow(
                symbol: hit.path == host.folders?.general.path ? Folder.generalSymbol : "folder",
                name: Text(Self.marked(hit, name: true)),
                detail: Self.place(of: hit),
                age: hit.lastUsed.map { Self.lastUsed($0) },
                isBusy: adding == hit.path
            )
        }
        .buttonStyle(.plain)
        .disabled(adding != nil)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("folder-hit-\(hit.relative)")
    }

    /// Where a folder found is (`~/coding_projects`), and for a git repository's top
    /// "git" after it, as a sidebar row says a thread's branch.
    private static func place(of hit: FolderSearchHit) -> Text {
        let place = Text(marked(hit, name: false))
        guard hit.isRepository else { return place }
        return Text("\(place) · \(Image(systemName: "arrow.triangle.branch")) git")
    }

    /// The folder's name (`name`), or the folders it is in (`~/coding_projects`, `~` for
    /// one in the home folder itself), with the letters the query matched in bold.
    static func marked(_ hit: FolderSearchHit, name: Bool) -> AttributedString {
        let relative = hit.relative
        let slash = relative.lastIndex(of: "/")
        let nameStart = slash.map { relative.index(after: $0) } ?? relative.startIndex
        let part = name ? nameStart ..< relative.endIndex : relative.startIndex ..< (slash ?? relative.startIndex)
        var text = AttributedString(name ? String(relative[part]) : part.isEmpty ? "~" : "~/" + relative[part])
        let lead = name ? 0 : 2
        for range in hit.matchedRanges {
            let clipped = range.clamped(to: part)
            guard !clipped.isEmpty else { continue }
            let from = lead + relative.distance(from: part.lowerBound, to: clipped.lowerBound)
            let to = lead + relative.distance(from: part.lowerBound, to: clipped.upperBound)
            let start = text.index(text.startIndex, offsetByCharacters: from)
            let end = text.index(text.startIndex, offsetByCharacters: to)
            text[start ..< end].inlinePresentationIntent = .stronglyEmphasized
        }
        return text
    }

    /// Asks the host for `query` once the person stops typing for a moment; a newer
    /// query cancels this one (`task(id:)`). An answer from a host still looking through
    /// its folders (`refreshing`) is shown, and asked for again shortly.
    private func search(_ query: String) async {
        // A problem was the last query's: this one says its own.
        searchProblem = nil
        guard searches, !query.isEmpty else {
            results = nil
            searched = ""
            return
        }
        do {
            try await Task.sleep(for: .milliseconds(180))
            for _ in 0 ..< 10 {
                isSearching = true
                defer { isSearching = false }
                let answer = try await host.searchFolders(query)
                try Task.checkCancellation()
                // The host took a newer query of this device's in its place: that one answers.
                if answer.superseded { return }
                results = answer
                searched = query
                searchProblem = nil
                guard answer.refreshing else { return }
                try await Task.sleep(for: .milliseconds(400))
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            searchProblem = error.localizedDescription
        }
    }

    /// A folder found: one on the list is handed over as when picked there; any other is
    /// added on the host first, as one chosen in the folder dialog is.
    private func pick(_ hit: FolderSearchHit) {
        if let list = host.folders, let listed = list.all.first(where: { $0.path == hit.path }) {
            dismiss()
            onPick(listed)
            return
        }
        guard adding == nil else { return }
        adding = hit.path
        addition = Task {
            defer { adding = nil }
            do {
                let added = try await host.addFolder(at: hit.path)
                // The sheet was cancelled meanwhile: the folder is on the host's list, and no thread starts.
                guard !Task.isCancelled else { return }
                if added.worktree != nil {
                    worktree = added
                } else {
                    dismiss()
                    onPick(added)
                }
            } catch {
                guard !Task.isCancelled else { return }
                addProblem = error.localizedDescription
            }
        }
    }

    // MARK: Loading

    private func load() async {
        // The list is the same for every agent; the host only wants one of its own named.
        guard !isLoading, let agent = agent ?? host.defaultAgent else { return }
        isLoading = true
        defer { isLoading = false }
        _ = try? await host.loadFolders(for: agent.id)
    }

    /// "just now", "5m ago", "2h ago", "3d ago", then the date.
    static func lastUsed(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "just now" }
        if seconds < 7 * 86_400 { return "\(AgentSidebar.age(of: date, now: now)) ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// A folder's row, in the host's list and in the folders found: its icon, its name, under
/// it where it is when that is said, and at its far end when an agent last worked there,
/// as a sidebar row has a thread's age.
private struct FolderRow: View {
    let symbol: String
    let name: Text
    var detail: Text?
    var age: String?
    /// Being added on the host, before the thread starts there.
    var isBusy = false

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: symbol)
                .font(.app.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                name
                    .lineLimit(1)
                if let detail {
                    detail
                        .font(.app.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: Theme.grid)
            if isBusy {
                ProgressView()
                    .controlSize(.small)
            } else if let age {
                Text(age)
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .listRowOnMac()
        .contentShape(.rect)
    }
}
