import AgentCore
import SwiftUI

/// The sidebar the chat slides aside to reveal, the same on every device (2026-10-23). Its rows are one line each, of one height, with the icon in one column
/// and the text on one edge, so that most of what shows is threads.
///
/// On top, under the search field, any unsent drafts, then what is going on on every Mac
/// at once: the threads that need you, the ones running, the unread results, the pinned ones
/// at rest, and the recent ones, as many read, idle conversations as this device was asked to
/// show (`RecentChoice`, the same threads on every device where their host keeps them)
/// (`SidebarGroups`). Each group but Pinned is in the order its threads last ran, so that
/// going from tab to tab moves nothing here. These rows are on two
/// lines, the second saying whose the thread is, the folder it works in and, with more
/// than one Mac, which. A finished or recent one is dismissed, on every device, by its × on a Mac and a
/// swipe to the left elsewhere. They take as much room as their rows and drafts need,
/// up to half the room shared by the two scrolling lists, and scroll on their own past that,
/// until the divider under them is dragged: then as much as it was put at (`GroupsSplit`).
///
/// Below, one Mac at a time, its space (`SpacePager`), under a row of the Macs' tabs
/// (`MacTabs`) that says which is shown and how each one's connection is doing: swiped
/// across to the next, with a finger or two on a trackpad, or ⌘⌥← and →. A space has
/// the Mac's bots, the agents that are talked with rather than set to work in a folder,
/// as a strip of avatars (`BotStrip`); then its folders, every one of them, each where it
/// stays as work starts and ends (`SidebarSpace.folders`), with its threads, pinned ones
/// first and then the one created last first, so that a thread keeps its place as turns
/// start and end too; No project last; then what it archived. A thread in the groups on
/// top is in its folder as well. Search looks through every thread at once. A thread's
/// menu closes its tab, pins, renames, archives or removes it, under the git branch its
/// folder is on where the host says; on a Mac that keeps the list for every device,
/// removing waits until the thread is at rest. A thread an agent started has an arrow
/// before its title.
struct AgentSidebar: View {
    let fleet: Fleet
    var onOpen: (ThreadRecord) -> Void
    var onOpenRecoverableDraft: (RecoverableDraft) -> Void = { _ in }
    var onDiscardRecoverableDraft: (RecoverableDraft) -> Void = { _ in }
    /// A new thread with the agent: a bot's, from its avatar or its menu.
    var onNewThread: (Agent) -> Void
    /// A new thread with the agent in a folder already chosen: a folder's own.
    var onNewThreadInFolder: (Agent, Folder) -> Void = { _, _ in }
    /// Another folder on the host, still to choose: a folder of the sidebar's from then
    /// on, and a new thread in it with the agent the last one was started with.
    var onChooseFolder: (HostID) -> Void = { _ in }
    /// A new thread with the agent in a folder still to choose, for an agent whose new
    /// thread does not start by choosing one (a bot).
    var onNewThreadChoosingFolder: (Agent) -> Void = { _ in }
    /// Lists the agent's sessions started on its host, in a terminal, to take one up.
    var onDeskSessions: (Agent) -> Void = { _ in }
    var onEditLook: (Agent) -> Void
    /// A new thread as ⌘T and the tab bar's + start one (`Fleet.newTab`), from New thread
    /// at the end of the search's line.
    var onNewTab: () -> Void = {}
    var onShowHosts: () -> Void = {}
    /// Beside the chat, the sidebar's background fades out toward its far edge, over the
    /// chat's wash, which runs on under it there (`WindowLayout.sidebarEdgeFade`).
    var fadesIntoChat = false

    @State private var query = DebugLaunch.sidebarSearch ?? ""
    @FocusState private var isSearching: Bool
    /// The folders whose every thread is shown, not just the recent ones.
    @State var showsAllProjectThreads: Set<SidebarProject.ID> = []
    /// The Macs whose archived threads show, at the foot of their space.
    @State var showsArchived: Set<HostID> = []
    /// A thread's row to bring into sight in its Mac's space, Show in Its Folder's: the
    /// space's list scrolls to it, and sets it back to nil.
    @State var revealedRow: RowInSight?
    /// Where a thread's row in Needs you, Running or Recent goes from or to as it
    /// moves between them: one row gliding from its old place to its new one.
    @Namespace private var groupRows
    /// The Mac selector between the two scrolling lists, excluded from their shared room.
    @State private var macTabsHeight = MacTabs.height + Theme.grid * 2
    /// How tall the groups' titles are, and their rows, as laid out: every title is as
    /// tall as the others and every row too, so the groups' whole height is worked out
    /// from them (`GroupSpacing.height`). Zero until one has been laid out; never less
    /// for the rows built later (with a large text size, a row without its second line
    /// could be less tall than the others), until the text size changes.
    @State private var groupTitleHeight: CGFloat = 0
    @State private var groupRowHeight: CGFloat = 0
    /// How tall the unsent drafts are, over the groups, as laid out.
    @State private var draftsHeight: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Ends the demo, while it is on (`Demo`).
    @Environment(\.endDemo) private var endDemo
    /// Whether more of the groups is above or below what shows of them.
    @State private var groupsCut = GroupsCut()
    /// The pointer over the thread rows of the groups on top and of a search's results, on
    /// a Mac (`RowHover`).
    @State private var groupsHover = RowHover()
    @State private var searchHover = RowHover()
    /// The thread being renamed, and its title as typed so far.
    @State private var renaming: ThreadRecord?
    @State private var newTitle = ""

    /// A row in a Mac's space to scroll to: which Mac's, and the row's id there.
    struct RowInSight: Equatable {
        var host: HostID
        var id: String
    }

    /// How many of a folder's threads show before the rest are folded away (2026-10-23). A Mac's folders are every one listed (2026-10-24).
    static let recentThreads = 3

    /// The sidebar's colour, which also fades over the edge of the chat.
    static let background = Theme.plainBackground

    /// How the background thins out toward the chat: slowly at first and at the end,
    /// so that neither end of the fade shows as an edge, and most of it near the chat,
    /// so that the wash does not reach far into the sidebar.
    private static let edgeFade: [Gradient.Stop] = [
        .init(color: .black, location: 0),
        .init(color: .black.opacity(0.95), location: 0.3),
        .init(color: .black.opacity(0.75), location: 0.55),
        .init(color: .black.opacity(0.42), location: 0.75),
        .init(color: .black.opacity(0.14), location: 0.9),
        .init(color: .clear, location: 1),
    ]

    var body: some View {
        let layout = isFiltering ? nil : fleet.layout
        let drafts = visibleDrafts
        // The search row and the rows' boxes share their two edges (`RowMetrics.inset`),
        // and what comes under one another is apart by the measures there, so nothing is
        // spaced by the stack itself.
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Platform.isMac ? Theme.grid : Theme.grid / 2) {
                searchField
                newThreadButton
            }
            .padding(.horizontal, RowMetrics.inset)

            if let layout {
                lists(layout, drafts: drafts)
            } else {
                searchResults(drafts: drafts)
            }

            footer
        }
        // The mobile row's 44-point target centres beside the chat header's sidebar
        // button; its visible search field and compose circle are both 40 points high.
        .padding(.top, Platform.isMac ? Theme.grid : Theme.grid / 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(fleet.isCatchingUp ? nil : .smooth(duration: 0.25), value: layout.map(Self.groups))
        .onChange(of: fleet.recent, initial: true) { _, _ in
            fleet.reconcileRecentHistory()
        }
        .onChange(of: layout?.top.history, initial: true) { _, history in
            guard history != nil else { return }
            fleet.reconcileRecentHistory()
        }
        .onReceive(NotificationCenter.default.publisher(for: SidebarProbe.fold)) { _ in foldEveryList() }
        // Show in Its Folder, from a tab's menu or a row's.
        .onChange(of: fleet.revealedThread, initial: true) { _, key in
            guard let key else { return }
            fleet.revealedThread = nil
            reveal(key)
        }
        .background {
            Self.background
                .mask {
                    HStack(spacing: 0) {
                        Color.black
                        if fadesIntoChat {
                            LinearGradient(stops: Self.edgeFade, startPoint: .leading, endPoint: .trailing)
                                .frame(width: WindowLayout.sidebarEdgeFade)
                        }
                    }
                }
                .ignoresSafeArea()
        }
        .alert(
            "Rename thread",
            isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
            presenting: renaming
        ) { record in
            TextField("Title", text: $newTitle)
                .submitLabel(.done)
            Button("Rename") { fleet.rename(record, to: newTitle) }
                .disabled(ThreadRecord.tidyTitle(newTitle) == nil)
            Button("Cancel", role: .cancel) {}
        } message: { record in
            Text(fleet.renamesOnHost(record) ? "The host calls the session this too." : "The name is kept in this app.")
        }
    }

    // MARK: Groups

    /// Search and the footer have taken their room. The two scrolling lists share what
    /// remains after the Mac selector and divider, rather than the whole sidebar's height,
    /// as the divider has it (`GroupsSplit`). Until it is dragged, a short top list gives its
    /// unused room to the Mac's space.
    private func lists(_ layout: SidebarLayout, drafts: [RecoverableDraft]) -> some View {
        GeometryReader { proxy in
            let hasGroups = !layout.top.isEmpty || !drafts.isEmpty
            let dividerHeight: CGFloat = hasGroups ? 1 + Theme.grid / 2 : 0
            VStack(alignment: .leading, spacing: 0) {
                GroupsSplit(
                    split: SidebarSplit(
                        room: max(0, proxy.size.height - macTabsHeight - dividerHeight),
                        topMinimum: groupsHeight(titles: 1, rows: 1),
                        bottomMinimum: Self.spaceMinimum
                    ),
                    rows: hasGroups ? groupsHeight(of: layout, drafts: drafts) : nil,
                    animation: fleet.isCatchingUp ? nil : .smooth(duration: 0.25),
                    step: RowMetrics.groups.rowHeight
                ) {
                    pinnedGroups(layout, drafts: drafts)
                }
                MacTabs(
                    fleet: fleet, shown: fleet.spaceOnScreen, onAddFolder: onChooseFolder, onDeskSessions: onDeskSessions
                )
                .padding(.horizontal, RowMetrics.inset)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { macTabsHeight = $0 }
                SpacePager(spaces: layout.spaces, sidebar: self)
                    .accessibilityIdentifier("sidebar-space")
            }
        }
    }

    /// Needs you, Running, Finished, Pinned and Recent: threads from every host under a title,
    /// for the groups that have any (`SidebarGroups`). A thread moving from one group to
    /// another is one row going there (`groupRows`); one leaving fades as the space under it
    /// folds away. A finished or recent one's row dismisses it (`closeOrDismiss`).
    ///
    /// The groups shown are told apart by their place, not by which they are: when
    /// Running goes and Recent takes its place, the title there changes its words where
    /// it is, rather than one title fading and the next crossing the rows on its way up.
    /// Titles and rows are one list, each line with an identity no other line has at the
    /// same time (`SidebarGroups.Line`): a row is brought up to date wherever its group
    /// moves.
    private func groups(of layout: SidebarLayout) -> some View {
        ForEach(layout.top.lines) { line in
            switch line {
            case let .title(group, _):
                GroupTitle(text: Self.title(of: group))
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { groupTitleHeight = max(groupTitleHeight, $0) }
                    .accessibilityIdentifier("sidebar-group-\(group.rawValue)")
                    .returnProbe("group:\(group.rawValue)")
                    // A title coming in shows once the rows have moved out of its way,
                    // rather than over one passing under it.
                    .transition(.asymmetric(insertion: .opacity.animation(.smooth(duration: 0.2).delay(0.2)), removal: .opacity))
            case let .thread(record, group):
                threadRow(record, as: .apart, height: RowMetrics.groups.rowHeight, closes: group == .finished || group == .recent)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { groupRowHeight = max(groupRowHeight, $0) }
                    .matchedGeometryEffect(id: record.key, in: groupRows)
                    .transition(.opacity)
            }
        }
    }

    /// A group's title.
    private static func title(of group: SidebarGroups.Group) -> String {
        switch group {
        case .waiting: "Needs you"
        case .running: "Running"
        case .finished: "Finished"
        case .pinned: "Pinned"
        case .recent: "Recent"
        }
    }

    /// Which threads are in each group, in order: what the groups' moves are animated by.
    private static func groups(_ layout: SidebarLayout) -> [[ThreadKey]] {
        [layout.top.waiting, layout.top.running, layout.top.finished, layout.top.pinned, layout.top.recent].map { $0.map(\.key) }
    }

    var hasSeveralHosts: Bool { fleet.hosts.count > 1 }

    /// Needs you, Running and Recent, above the spaces and not in them, so that they stay
    /// in sight whichever Mac is shown and however far its list scrolls (2026-10-17 and 2026-10-23), under any unsent drafts. As tall as `GroupsSplit` has
    /// them, scrolling on their own past that, the drafts with them, so that many drafts
    /// never push the Macs' tabs and spaces out of reach, even on a short screen.
    /// Lazy, as the lists are: a long Recent builds only the rows in sight. The drafts,
    /// which are few, are not lazy: they are measured as they are laid out.
    private func pinnedGroups(_ layout: SidebarLayout, drafts: [RecoverableDraft]) -> some View {
        let spacing = RowMetrics.groups
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !drafts.isEmpty {
                    RecoverableDraftsSection(
                        drafts: drafts, caption: draftCaption,
                        onOpen: onOpenRecoverableDraft, onDiscard: onDiscardRecoverableDraft
                    )
                    .padding(.top, RowMetrics.blockGap)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { draftsHeight = $0 }
                }
                LazyVStack(alignment: .leading, spacing: spacing.rowGap) {
                    groups(of: layout)
                }
                .animation(fleet.isCatchingUp ? nil : .smooth(duration: 0.25), value: Self.groups(layout))
                .threadRowHover(groupsHover)
            }
            .padding(.horizontal, RowMetrics.inset)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onScrollGeometryChange(for: GroupsCut.self) { geometry in
            GroupsCut(
                above: geometry.visibleRect.minY > 1,
                below: geometry.contentSize.height - geometry.visibleRect.maxY > 1
            )
        } action: { _, cut in
            groupsCut = cut
        }
        // Cut short, they fade out at the edge where there is more, so the cut reads as
        // more to scroll to; scrolled to either end, the row there shows whole.
        .mask {
            VStack(spacing: 0) {
                if groupsCut.above {
                    LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                        .frame(height: Theme.grid * 2)
                }
                Color.black
                if groupsCut.below {
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: Theme.grid * 3)
                }
            }
        }
        .onChange(of: typeSize) {
            groupTitleHeight = 0
            groupRowHeight = 0
        }
    }

    /// How tall the groups' titles and rows need, with the drafts over them.
    ///
    /// Worked out from how many titles and rows they have, not measured on the lazy stack:
    /// its height depends on which rows it has built, which depends on how tall the frame
    /// given to it is, so with that height as the frame the two went round and round for
    /// good (seen on 2026-10-19 on an iPad: 362, 349, 346 and 362 points again every few
    /// milliseconds, the app busy with nothing else).
    private func groupsHeight(of layout: SidebarLayout, drafts: [RecoverableDraft]) -> CGFloat {
        let shown = Self.groups(layout).filter { !$0.isEmpty }
        return groupsHeight(titles: shown.count, rows: shown.reduce(0) { $0 + $1.count })
            + (drafts.isEmpty ? 0 : draftsHeight)
    }

    private func groupsHeight(titles: Int, rows: Int) -> CGFloat {
        let spacing = RowMetrics.groups
        return spacing.height(
            titles: titles,
            rows: rows,
            title: groupTitleHeight > 0 ? groupTitleHeight : spacing.titleTop + spacing.titleBottom + RowMetrics.groupTitleText,
            row: groupRowHeight
        )
    }

    /// The least the divider leaves a Mac's space: about three of its rows.
    private static let spaceMinimum = 3 * RowMetrics.threadHeight + 2 * RowMetrics.spacing

    /// Where the groups, scrolling on their own, have more than shows of them.
    private struct GroupsCut: Equatable {
        var above = false
        var below = false
    }

    // MARK: Folding

    /// Show more, or Show fewer, on every folder at once: for measuring (`SidebarProbe`),
    /// as each folder's own button does it.
    private func foldEveryList() {
        let showsMore = showsAllProjectThreads.isEmpty
        withAnimation(.smooth(duration: 0.25)) {
            showsAllProjectThreads = showsMore ? Set(fleet.layout.spaces.flatMap(\.folders).map(\.id)) : []
        }
        SidebarProbe.markNextFrame(showsMore ? "show-more" : "show-fewer")
    }

    /// Show in Its Folder: the thread's Mac's space shows, with its folder open and the
    /// thread's row in it, which the space's list scrolls to (`revealedRow`). A bot's
    /// thread in no folder brings its Mac's space, scrolled to the bots' avatars on top.
    private func reveal(_ key: ThreadKey) {
        query = ""
        withAnimation(.smooth(duration: 0.3)) { fleet.showSpace(key.host) }
        guard let space = fleet.layout.spaces.first(where: { $0.id == key.host }) else { return }
        guard let folder = space.folders.first(where: { $0.threads.contains { $0.key == key } }),
              let record = folder.threads.first(where: { $0.key == key }) else {
            if space.bots.contains(where: { $0.threads.contains { $0.key == key } }) {
                revealedRow = RowInSight(host: key.host, id: BotStrip.rowID)
            }
            return
        }
        let shown = SidebarSections.recent(folder.threads, count: Self.recentThreads, keeping: currentThread)
        withAnimation(.smooth(duration: 0.25)) {
            fleet.foldedProjects.remove(folder.id)
            if !shown.contains(where: { $0.key == key }) { showsAllProjectThreads.insert(folder.id) }
        }
        revealedRow = RowInSight(host: key.host, id: Self.rowID(record, in: "project"))
    }

    /// The thread on screen, among every host's.
    var currentThread: ThreadKey? {
        fleet.chat?.thread?.key
    }

    /// The thread on screen, for what the folders list (`SidebarSections.recent`), read as
    /// the lists are worked out only when it changes what they list
    /// (`Fleet.listedCurrentChanges`): a tab switch does not work every list out again.
    var listedCurrent: ThreadKey? {
        _ = fleet.listedCurrentChanges
        return fleet.listedCurrent
    }

    // MARK: Threads

    /// How a thread's row says whose the thread is and where it works.
    nonisolated enum ThreadRowKind: Sendable {
        /// Under its folder: one line, with its agent's mark before the title.
        case underProject
        /// Away from it, among threads of every agent and host (on top, archived, or
        /// found by a search): two lines, the second saying the agent, the folder and
        /// the host.
        case apart
    }

    /// A thread's row (`ThreadRow`), with what it shows worked out here: a row whose
    /// thread, place and state are what they were is not drawn again when anything
    /// else in the sidebar changes. `closes`: under Finished or Recent, where the row closes its
    /// thread's tab, or dismisses a thread that is no tab.
    func threadRow(_ record: ThreadRecord, as kind: ThreadRowKind, height: CGFloat? = nil, closes: Bool = false) -> some View {
        let activity = fleet.activity(of: record.key)
        let isTab = fleet.tabs.contains(record.key)
        let style = fleet.style(for: record.ref.agent)
        return ThreadRow(
            record: record,
            kind: kind,
            height: height ?? (kind == .apart ? RowMetrics.tallHeight : RowMetrics.threadHeight),
            current: fleet.currentRows.flag(for: record.key),
            activity: activity,
            style: style,
            caption: kind == .apart ? caption(of: record, hasLogo: style.logo != nil) : nil,
            age: Self.age(of: record.updatedAt),
            offersRemoval: fleet.offersRemoval(record),
            closing: closes ? "Dismiss" : nil,
            isTab: isTab,
            isBot: kind == .apart && fleet.isBot(record.ref.agent),
            fleet: fleet,
            onOpen: onOpen,
            onRename: rename
        )
        .equatable()
        .returnProbe("thread:\(kind):\(record.id.rawValue)")
    }

    /// Asks for a thread's new title.
    private func rename(_ record: ThreadRecord) {
        newTitle = record.displayTitle
        renaming = record
    }

    /// The folder a thread works in, where saying so tells something: nil for a thread
    /// with none, and for one in the host's General folder, where a thread works unless
    /// another folder was chosen.
    private func folder(of record: ThreadRecord) -> String? {
        guard let host = fleet.model(for: record.key.host), let path = record.ref.workingDirectory,
              path != host.host.generalFolder else { return nil }
        return host.folderName(of: record)
    }

    /// The second line of a thread listed away from its folder: who started it when an
    /// agent did, whose it is, the folder it works in and, with several hosts,
    /// which, apart by dots ("Hanni · aerirc · MBP16"), and the same as it is read out.
    /// Whose it is goes unshown for a coding agent, whose logo before the title says it
    /// (`hasLogo`, the logo of the look its row's icon is drawn with), as the chat's
    /// header has it (2026-10-24): "aerirc · MBP16" under a Claude Code thread,
    /// not "Claude Code · aerirc · MBP16"; and as there, still read out. A bot's name
    /// shows.
    private func caption(of record: ThreadRecord, hasLogo: Bool) -> ThreadCaption? {
        let host = fleet.model(for: record.key.host)
        let caption = ThreadCaption(
            starter: record.startedBy?.caption(macName: fleet.macName(forMachine:)),
            agent: host?.agent(record.ref.agent)?.displayName,
            showsAgent: !hasLogo,
            folder: folder(of: record),
            branch: record.worktreeBranch.map(Self.shortBranch),
            host: hasSeveralHosts ? host?.host.name : nil
        )
        return caption.isEmpty && caption.agent == nil ? nil : caption
    }

    /// A branch as a row's far end has room for it: its last part, which tells it from the
    /// others (`login-crash` of `fix/login-crash`), clipped as a folder's name is.
    static func shortBranch(_ branch: String) -> String {
        let last = branch.split(separator: "/").last.map(String.init) ?? branch
        return clipped(last, to: 16)
    }

    /// A folder's name as a row's far end has room for it: a long one keeps its start
    /// and its end, so that the title before it keeps most of the line.
    static func clipped(_ folder: String, to length: Int = 18) -> String {
        guard folder.count > length else { return folder }
        let half = (length - 1) / 2
        return "\(folder.prefix(length - 1 - half))…\(folder.suffix(half))"
    }

    /// A row's identity in a Mac's space, under its folder or among the archived ones, as
    /// the groups on top tell theirs apart (`SidebarGroups.Line`): what Show in Its Folder
    /// scrolls to.
    static func rowID(_ record: ThreadRecord, in group: String) -> String {
        "\(group)|\(record.key.host.rawValue)|\(record.id.rawValue)"
    }

    /// "Working" or "Waiting for you", for a row whose threads are (a folder's, a bot's);
    /// nil at rest.
    static func statusLine(_ activity: HostModel.Activity) -> String? {
        switch activity {
        case .working: "Working"
        case .waiting: "Waiting for you"
        case .idle: nil
        }
    }

    /// "now", "5m", "3h", "2d", then the date.
    static func age(of date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return date.formatted(dayStyle)
    }

    /// "Oct 9": made once, not for each row each time the list is drawn.
    private static let dayStyle = Date.FormatStyle.dateTime.month(.abbreviated).day()

    /// A row that does something to the list it is in, quieter than a thread: Show
    /// more, Archived, Choose a folder. Its icon, when it has one, is in the icon's
    /// column; with none, its title is on the text's edge all the same.
    static func actionLabel(_ title: String, systemImage: String? = nil) -> some View {
        RowBox(height: RowMetrics.threadHeight) {
            HStack(spacing: RowMetrics.gap) {
                Group {
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.app.footnote)
                    } else {
                        Color.clear
                    }
                }
                .frame(width: RowMetrics.icon, height: RowMetrics.icon)
                Text(title)
                    .font(.app.subheadline)
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, RowMetrics.padding)
        }
    }

    // MARK: Search

    private var visibleDrafts: [RecoverableDraft] {
        let drafts = fleet.recoverableDrafts
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !search.isEmpty else { return drafts }
        return drafts.filter {
            [$0.title, $0.preview, draftCaption($0)].joined(separator: " ").localizedStandardContains(search)
        }
    }

    private func draftCaption(_ draft: RecoverableDraft) -> String {
        let host = fleet.model(for: draft.agent.host)
        let agent = host?.agents.first { $0.id == draft.agent }?.displayName ?? draft.agent.name
        let folder = draft.workingDirectory.map { path in
            path == host?.host.generalFolder ? "General" : URL(fileURLWithPath: path).lastPathComponent
        }
        return [agent, folder, host?.host.name ?? draft.agent.host.rawValue].compactMap { $0 }.joined(separator: " · ")
    }

    private var isFiltering: Bool {
        !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A search's results, from every host, in place of both halves of the sidebar; the
    /// unsent drafts that match too.
    private func searchResults(drafts: [RecoverableDraft]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: RowMetrics.spacing) {
                if !drafts.isEmpty {
                    RecoverableDraftsSection(
                        drafts: drafts, caption: draftCaption,
                        onOpen: onOpenRecoverableDraft, onDiscard: onDiscardRecoverableDraft
                    )
                }
                let matches = SidebarSections.search(query, in: fleet.allThreads)
                if matches.isEmpty {
                    if drafts.isEmpty {
                        ContentUnavailableView.search(text: query)
                            .padding(.top, Theme.grid * 4)
                    }
                } else {
                    ForEach(matches, id: \.key) { record in
                        threadRow(record, as: .apart)
                    }
                }
            }
            .threadRowHover(searchHover)
            .padding(.horizontal, RowMetrics.inset)
            .padding(.top, RowMetrics.blockGap)
            .padding(.bottom, Theme.grid * 2)
        }
        .scrollDismissesKeyboard(.immediately)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var searchField: some View {
        SearchField(prompt: "Search threads", text: $query, isFocused: $isSearching)
            .submitLabel(.search)
            .autocorrectionDisabled()
    }

    /// New thread, at the end of the search's line, as high as the field and in its fill,
    /// the compose mark a folder's New thread has (2026-10-27: "lets also add a new
    /// thread button inline with the search bar which will bring us to the new tab screen
    /// wiht the 3 dropdowns, can we have this on mobile as well"): a new thread with the
    /// agent the last thread was started with, in the folder of the one on screen
    /// (`Fleet.newTab`), whose Mac, agent and folder its own screen then changes
    /// (`NewThreadPickers`).
    private var newThreadButton: some View {
        Button {
            // The search lets go of the keyboard: on a phone it goes with the sidebar, and
            // kept it behind the chat, taking what was typed (Codex's review, 2026-10-27).
            isSearching = false
            onNewTab()
        } label: {
            Image(systemName: RowControl.newThread)
                .font(.app.body.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: SearchField.height, height: SearchField.height)
                .background(Color(uiColor: .tertiarySystemFill), in: .circle)
                .padding(Platform.isMac ? 0 : max(0, (44 - SearchField.height) / 2))
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .tip("New Thread (⌘T)")
        .accessibilityLabel("New thread")
        .accessibilityHint("Starts a new thread with the agent you last started one with, in the folder of the one on screen")
        .accessibilityIdentifier("sidebar-new-thread")
    }

    // MARK: Hosts

    /// The way to Settings, the Macs among them (`SettingsScreen`). How each Mac's
    /// connection is doing is said by its tab and in its space. Beside it, while a host's
    /// bridge has a later version out, a quiet word of it (`HostUpdateButton`); in the demo,
    /// which has no bridge to update, the way out of it instead.
    private var footer: some View {
        HStack(spacing: Theme.grid) {
            Button(action: onShowHosts) {
                Label("Settings", systemImage: "gearshape")
                    .frame(minHeight: Platform.isMac ? 36 : 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("host-settings")
            Spacer(minLength: Theme.grid)
            if fleet.isDemo {
                if let endDemo {
                    Button(action: endDemo.end) {
                        Text("End the demo")
                            .frame(minHeight: Platform.isMac ? 36 : 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.primary)
                    .accessibilityIdentifier("sidebar-end-demo")
                }
            } else {
                let updating = fleet.hosts.filter { $0.update != nil }
                if !updating.isEmpty {
                    HostUpdateButton(hosts: updating)
                }
            }
        }
        .font(.app.footnote)
        .foregroundStyle(.secondary)
        .symbolRenderingMode(.hierarchical)
        // As a row: its icon in the icon's column, its words on the text's edge.
        .labelStyle(RowLabelStyle())
        .padding(.horizontal, RowMetrics.inset + RowMetrics.padding)
        .padding(.bottom, Theme.grid)
        .accessibilityIdentifier("sidebar-connection")
    }
}
