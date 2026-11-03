import AgentCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Each Mac's space side by side, one page each, below the sidebar's groups (2026-10-23): swiped across with a finger, or two on a trackpad, snapping to a space,
/// in the Macs' order (`machine_order`). The space shown is the fleet's
/// (`Fleet.spaceOnScreen`), which the Macs' tabs over it and ⌘⌥← and → change too. The
/// sideways swipe that brings the sidebar out is the chat's, never the sidebar's, so the
/// two are not in each other's way. One Mac's space is there on its own, with nothing to
/// swipe to: a pager with its scrolling turned off would turn off the space's own too,
/// which reaches the lists inside it, and leave its lower folders out of reach.
struct SpacePager: View {
    let spaces: [SidebarSpace]
    let sidebar: AgentSidebar

    var body: some View {
        let fleet = sidebar.fleet
        Group {
            if spaces.count < 2 {
                if let space = spaces.first {
                    SpacePage(space: space, sidebar: sidebar)
                } else {
                    Color.clear
                }
            } else {
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 0) {
                        ForEach(spaces) { space in
                            SpacePage(space: space, sidebar: sidebar)
                                .containerRelativeFrame(.horizontal)
                        }
                    }
                    .scrollTargetLayout()
                    .background { if Platform.isMac { PagerGlide() } }
                }
                .modifier(SpaceSnapping.Applied())
                .scrollPosition(id: Binding(get: { fleet.spaceOnScreen }, set: { shown in if let shown { fleet.showSpace(shown) } }))
                .scrollIndicators(.hidden)
            }
        }
        .frame(maxHeight: .infinity)
    }
}

/// Where a swipe across the spaces comes to rest. On a touch screen UIKit's own paging
/// (`.paging`), as before. On a Mac, with two fingers on a trackpad, that went on to the
/// next Mac with any flick toward it, a scroll down the list that strayed sideways too
/// (2026-10-25: "cross device swipe is a little bit too sensitive"): there the next
/// Mac comes only once the swipe and its flick would carry the space `toNext` of the way to
/// it, and less goes back. The glide to it stays the system's paging one (`PagerGlide`).
struct SpaceSnapping: ScrollTargetBehavior {
    /// How far the swipe and its flick must carry, as a share of a space, to go on to the next.
    static let toNext: CGFloat = 0.35

    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        target.rect.origin.x = Self.landing(
            from: context.originalTarget.rect.minX, proposed: target.rect.minX,
            page: context.containerSize.width, content: context.contentSize.width,
            flick: context.velocity.dx
        )
    }

    /// Where a swipe that began at `start` and would come to rest at `proposed` lands, at
    /// a space's edge: one space on, or back, from where it began. With no flick (a size
    /// changed, the space shown set from elsewhere, a swipe let go of at rest), the space
    /// nearest where it would rest, as paging does.
    static func landing(from start: CGFloat, proposed: CGFloat, page: CGFloat, content: CGFloat, flick: CGFloat) -> CGFloat {
        guard page > 0 else { return proposed }
        let last = max(((content - page) / page).rounded(), 0)
        let clamp = { (index: CGFloat) in min(max(index, 0), last) * page }
        guard abs(flick) >= 1 else { return clamp((proposed / page).rounded()) }
        let from = min(max((start / page).rounded(), 0), last)
        let travel = proposed / page - from
        return clamp(abs(travel) < toNext ? from : from + (travel > 0 ? 1 : -1))
    }

    /// The pager's behavior: this one on a Mac, UIKit's paging elsewhere.
    struct Applied: ViewModifier {
        func body(content: Content) -> some View {
            if Platform.isMac {
                content.scrollTargetBehavior(SpaceSnapping())
            } else {
                content.scrollTargetBehavior(.paging)
            }
        }
    }
}

/// Gives the pager's scroll view the glide paging has (`.paging` sets it): a behavior of
/// our own leaves it the free scroll's, which glides on far longer. Placed in the
/// pager's content, whose first scroll view up is the pager's own.
private struct PagerGlide: UIViewRepresentable {
    func makeUIView(context: Context) -> Finder { Finder() }
    func updateUIView(_ view: Finder, context: Context) {}

    final class Finder: UIView {
        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            var above = superview
            while let view = above, !(view is UIScrollView) { above = view.superview }
            (above as? UIScrollView)?.decelerationRate = .fast
        }
    }
}

/// One Mac's space: what is wrong with its connection, if anything; its bots as a strip
/// of avatars (`BotStrip`); its folders, every one, each where it stays as work starts
/// and ends (`SidebarSpace.folders`), each a row that opens and closes the threads under
/// it and starts a new one there with the agent the last was started with, its pinned
/// threads first and then the one created last first, three until asked for all; No
/// project last; what it archived at the foot. A folder's row stays at the top while its
/// threads scroll under it, so it can be closed from wherever one is, and is held and
/// dragged to move it among the others.
struct SpacePage: View {
    let space: SidebarSpace
    let sidebar: AgentSidebar

    /// Where each folder's row is in the list's visible part, to tell one pinned at its
    /// top while its threads scroll under it (`pinnedHeader`).
    @State fileprivate var headerTops = HeaderTops()
    /// The row to bring back into sight: one closed while it was pinned at the top,
    /// whose place in the list was then above it.
    @State private var scrollBack: String?
    /// Where each folder's row is in the list, and which of them a drag began on, for
    /// moving one by dragging it. Read only while a row is dragged, so noting a place
    /// draws nothing again.
    @State private var rowFrames = RowFrames()
    /// Where the row being dragged would land, which only the line that shows it reads:
    /// the list is not drawn again as the drag moves.
    @State private var dropLine = DropLine()
    /// The pointer over the list's thread rows on a Mac, and the one control that takes
    /// their clicks (`RowHover`).
    @State fileprivate var rowHover = RowHover()

    private var fleet: Fleet { sidebar.fleet }

    var body: some View {
        let _ = RowProbe.countList()
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: RowMetrics.spacing, pinnedViews: .sectionHeaders) {
                    if let host = fleet.model(for: space.id) {
                        connection(of: host)
                    }
                    if !space.bots.isEmpty {
                        BotStrip(bots: space.bots, sidebar: sidebar)
                            .padding(.bottom, Theme.grid / 2)
                            // Show in Sidebar, for a bot's thread in no folder.
                            .id(BotStrip.rowID)
                    }
                    folders
                    archived
                }
                .threadRowHover(rowHover)
                .coordinateSpace(.named(Self.listSpace))
                // A row held and dragged is let go anywhere on the list: where it lands
                // is read from how far down that is (`RowDrop`). The gaps between rows
                // are the list too, so a drag going from one row to the next stays on it.
                .contentShape(.rect)
                .onDrop(of: [.sidebarRow], delegate: RowDrop(page: self))
                .overlay(alignment: .top) {
                    DropLineMark(line: dropLine)
                }
                .padding(.horizontal, RowMetrics.inset)
                .padding(.bottom, Theme.grid * 2)
            }
            .scrollDismissesKeyboard(.immediately)
            .onChange(of: scrollBack) {
                guard let id = scrollBack else { return }
                scrollBack = nil
                withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
            }
            // Show in Its Folder: once the space has slid in and the folder opened. The
            // bots, on top of the space, are brought to its top.
            .task(id: sidebar.revealedRow) {
                guard let row = sidebar.revealedRow, row.host == space.id else { return }
                try? await Task.sleep(for: .milliseconds(350))
                guard !Task.isCancelled else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(row.id, anchor: row.id == BotStrip.rowID ? .top : .center) }
                sidebar.revealedRow = nil
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("space-\(space.id.rawValue)")
    }

    // MARK: The Mac

    /// What keeps the Mac's space empty, said on top of it: the connection's problem,
    /// with Retry once the app has stopped trying; that the Mac offers no agents; that
    /// it is being reached, while nothing of it is known yet; or, quietly, that it is
    /// reached through the relay.
    @ViewBuilder
    private func connection(of host: HostModel) -> some View {
        let isEmpty = space.bots.isEmpty && space.folders.isEmpty
        let text: String? = if host.status == .problem {
            host.statusText
        } else if host.offersNoAgents {
            "No agents on this host yet"
        } else if host.status == .connecting, isEmpty {
            "Connecting to \(host.host.name)…"
        } else if host.isViaRelay {
            // Main's Mac header said so under the Mac's name (the net plan's relay).
            "via relay"
        } else {
            nil
        }
        if let text {
            RowBox(height: RowMetrics.threadHeight) {
                HStack(spacing: RowMetrics.gap) {
                    HostStatusDot(status: host.status)
                        .frame(width: RowMetrics.icon)
                    Text(text)
                        .font(.app.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if host.connectionIsStopped {
                        Button("Retry") { Task { await host.start() } }
                            .font(.app.footnote)
                            .buttonStyle(.borderedCapsule)
                            .controlSize(.small)
                    }
                }
                .padding(.horizontal, RowMetrics.padding)
            }
            .padding(.bottom, Theme.grid / 2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("space-connection-\(host.id.rawValue)")
        }
    }

    // MARK: Folders

    /// The Mac's folders, every one, where each stays (`SidebarSpace.folders`); No project
    /// at the foot of them. A folder that is not among them is added from the button at
    /// the end of the Macs' tabs (`MacTabs`), or, while the Mac has none, from a row here.
    @ViewBuilder
    private var folders: some View {
        let all = space.folders
        // No project stays at the foot of them, apart, and always there: it is the place
        // for what has none of its own. It is moved by none, and moves none.
        let named = all.filter { !$0.isGeneral }
        let general = all.first(where: \.isGeneral)
        // Two folders of one name are told apart by where each is.
        let shared = Set(Dictionary(grouping: all, by: \.name).filter { $0.value.count > 1 }.keys)
        let movable = named.map(\.id)
        let startsList = space.bots.isEmpty
        ForEach(named) { project in
            section(for: project, saysWhere: shared.contains(project.name), among: movable, isFirst: startsList && project.id == named.first?.id)
        }
        if let general {
            section(for: general, saysWhere: false, among: [], isFirst: startsList && named.isEmpty)
        }
        if fleet.model(for: space.id)?.offersFolders == true, all.isEmpty {
            Button { sidebar.onChooseFolder(space.id) } label: {
                AgentSidebar.actionLabel("Choose a folder", systemImage: "folder.badge.plus")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("choose-folder")
        }
    }

    /// `siblings` are the folders shown with it, its Mac's, in their order: the rows it
    /// can be moved among.
    private func section(for project: SidebarProject, saysWhere: Bool, among siblings: [SidebarProject.ID], isFirst: Bool) -> some View {
        let isOpen = !fleet.foldedProjects.contains(project.id)
        let unfolded = sidebar.showsAllProjectThreads.contains(project.id)
        let headerID = "project-header|\(project.id.host.rawValue)|\(project.id.path)"
        return Section {
            if isOpen {
                foldedThreads(project.threads, showsAll: unfolded, identifier: project.name) {
                    sidebar.showsAllProjectThreads.formSymmetricDifference([project.id])
                }
                .transition(.opacity)
            }
        } header: {
            let folds = isOpen && showsMore(project.threads, unfolded: unfolded)
            projectRow(
                project, saysWhere: saysWhere, isOpen: isOpen, among: siblings, headerID: headerID,
                onShowFewer: folds ? { keepingInSight(headerID) { sidebar.showsAllProjectThreads.remove(project.id) } } : nil
            )
            .pinnedHeader(headerID, gap: isFirst ? 0 : RowMetrics.headerGap, in: self)
        }
    }

    @ViewBuilder
    private func projectRow(
        _ project: SidebarProject, saysWhere: Bool, isOpen: Bool, among siblings: [SidebarProject.ID], headerID: String,
        onShowFewer: (() -> Void)?
    ) -> some View {
        let activity = fleet.activity(of: project.id)
        let path = Folder.tidyPath(project.id.path)
        HeaderRow(
            name: project.name,
            detail: saysWhere ? Folder.tidyPath((project.id.path as NSString).deletingLastPathComponent) : nil,
            // Open, its threads say it themselves.
            activity: isOpen ? .idle : activity,
            isOpen: isOpen,
            label: "\(project.name), \(AgentSidebar.statusLine(activity) ?? path)",
            identifier: "project-row-\(project.name)",
            // Where the folder is, which its row has no room to say.
            tip: path,
            // No project reads as the catch-all it is, quieter than the folders.
            isQuiet: project.isGeneral,
            onShowFewer: onShowFewer
        ) {
            keepingInSight(headerID) { fleet.foldedProjects.formSymmetricDifference([project.id]) }
        } icon: {
            // No project is no folder of its own: a tray, where the folders are folders.
            Image(systemName: project.isGeneral ? (isOpen ? "\(Folder.generalSymbol).fill" : Folder.generalSymbol) : (isOpen ? "folder.fill" : "folder"))
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        } controls: {
            let folder = Folder(path: project.id.path, name: project.name, isGeneral: project.isGeneral)
            let agents = fleet.agentsForFolder(on: project.id.host)
            // At once, with the agent the last thread was started with, or the Mac's
            // default, which the new thread's own screen changes (2026-10-31: "when
            // we click new thread on the sidebar it should just bring us to the new thread
            // page as well with the last agent used"); with several agents it asked which.
            let newThread = {
                if let agent = fleet.agentForNewThread(in: project.id.host) { sidebar.onNewThreadInFolder(agent, folder) }
            }
            Group {
                if Platform.isMac || siblings.count <= 1 {
                    // No agent a thread in a folder can be with: no button.
                    if !agents.isEmpty {
                        Button(action: newThread) {
                            RowControl(systemImage: RowControl.newThread)
                        }
                        .buttonStyle(.plain)
                        .tip("New thread")
                    }
                } else {
                    // The row is held to move it: its menu is this button's. A tap
                    // starts a thread; held, the folder's menu.
                    ProjectMenuButton(
                        project: project.id, folder: folder, isOnlyAdded: project.isOnlyAdded, siblings: siblings,
                        agents: agents, sortsByLastUse: fleet.sortsFoldersByLastUse(on: project.id.host),
                        menu: { actions(for: project, among: siblings) }, onNewThread: newThread
                    )
                    .equatable()
                }
            }
            .accessibilityLabel("New thread")
            .accessibilityIdentifier("new-thread-in-\(project.name)")
        }
        .movable(project.id, among: siblings, in: self)
        .rowMenu(isMovable: siblings.count > 1) { actions(for: project, among: siblings) }
        .onAppear { SidebarProbe.mark("sidebar-row", once: true, detail: fleet.hosts.contains { $0.connection == .connected } ? "host" : "saved") }
    }

    /// What a folder's row offers, from its menu: taking a folder that is there only for
    /// having been added off the list, its place among its Mac's, and listing them by
    /// when each was last worked in, which only the user turns on (they stay where they
    /// are otherwise: `SidebarSpace.folders`).
    @ViewBuilder
    private func actions(for project: SidebarProject, among siblings: [SidebarProject.ID]) -> some View {
        let host = project.id.host
        // One with threads stays for as long as they do.
        if project.isOnlyAdded {
            Button("Remove from Sidebar", systemImage: "folder.badge.minus", role: .destructive) {
                withAnimation(.smooth(duration: 0.25)) { fleet.removeProject(project.id) }
            }
        }
        moves(of: project.id, among: siblings, identifier: project.name)
        Toggle("Sort folders by last use", systemImage: "clock.arrow.circlepath", isOn: Binding {
            fleet.sortsFoldersByLastUse(on: host)
        } set: { on in
            withAnimation(.smooth(duration: 0.25)) { fleet.sortFoldersByLastUse(on, on: host) }
        })
        .accessibilityIdentifier("sort-folders-by-last-use")
    }

    /// Moving a folder's row among the rows listed with it, from its menu: one place up
    /// or down, and to either end from further away. A row is also moved by dragging it
    /// (`movable`): with a pointer at once; with a finger held until it lifts, which on
    /// an iPhone or an iPad is all holding a movable row does (`rowMenu`). Threads are
    /// not moved.
    @ViewBuilder
    private func moves(of id: SidebarProject.ID, among siblings: [SidebarProject.ID], identifier: String) -> some View {
        if siblings.count > 1 {
            Divider()
            ForEach(SidebarMove.allCases, id: \.self) { step in
                if let made = step.step(of: id, among: siblings) {
                    Button(step.title, systemImage: step.systemImage) {
                        withAnimation(.smooth(duration: 0.25)) { fleet.move(made.moved, before: made.before) }
                    }
                    .accessibilityIdentifier("move-\(step.rawValue)-\(identifier)")
                }
            }
        }
    }

    // MARK: Threads

    /// A folder's threads: the recent ones, and the rest behind a Show more row; a quiet
    /// line where it has none yet.
    @ViewBuilder
    private func foldedThreads(_ threads: [ThreadRecord], showsAll unfolded: Bool, identifier: String, onToggle: @escaping () -> Void) -> some View {
        let folded = SidebarSections.recent(threads, count: AgentSidebar.recentThreads, keeping: sidebar.listedCurrent)
        let showsAll = unfolded || folded.count == threads.count
        ForEach(showsAll ? threads : folded, id: \.key) { record in
            sidebar.threadRow(record, as: .underProject)
                .id(AgentSidebar.rowID(record, in: "project"))
        }
        if threads.isEmpty {
            Text("No threads yet")
                .font(.app.caption)
                .foregroundStyle(.tertiary)
                .padding(.leading, RowMetrics.textEdge)
                .frame(minHeight: RowMetrics.threadHeight - 6)
        }
        if folded.count < threads.count {
            Button {
                withAnimation(.smooth(duration: 0.25), onToggle)
            } label: {
                AgentSidebar.actionLabel(showsAll ? "Show fewer" : "Show \(threads.count - folded.count) more")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("show-more-\(identifier)")
        }
    }

    /// Whether a folder shows all its threads where it could show only its recent ones:
    /// its row then folds it from wherever one is in it (Show fewer).
    private func showsMore(_ threads: [ThreadRecord], unfolded: Bool) -> Bool {
        unfolded && SidebarSections.recent(threads, count: AgentSidebar.recentThreads, keeping: sidebar.listedCurrent).count < threads.count
    }

    /// Opens, closes or folds a folder's threads. Its row, closed or folded from where it
    /// was pinned at the top of the list, its place far above, is brought back into
    /// sight, rather than leave the list where the threads were.
    private func keepingInSight(_ headerID: String, _ change: () -> Void) {
        let wasPinned = headerTops.isPinned(headerID)
        withAnimation(.smooth(duration: 0.25), change)
        if wasPinned { scrollBack = headerID }
    }

    // MARK: Archived

    /// The Mac's archived threads, folded under one row at the foot of its space.
    @ViewBuilder
    private var archived: some View {
        let threads = space.archived
        if !threads.isEmpty {
            let shows = sidebar.showsArchived.contains(space.id)
            Button {
                withAnimation(.smooth(duration: 0.25)) { sidebar.showsArchived.formSymmetricDifference([space.id]) }
            } label: {
                AgentSidebar.actionLabel("Archived · \(threads.count)", systemImage: shows ? "chevron.up" : "archivebox")
            }
            .buttonStyle(.plain)
            // As far under the rows before it as a title is: its words sit in a row's box.
            .padding(.top, RowMetrics.sectionGap - (RowMetrics.threadHeight - RowMetrics.icon) / 2)
            .accessibilityIdentifier("sidebar-archived")
            if shows {
                ForEach(threads, id: \.key) { record in
                    sidebar.threadRow(record, as: .apart)
                        .id(AgentSidebar.rowID(record, in: "archived"))
                }
            }
        }
    }

    // MARK: Moving a folder

    /// Behind a folder's row while it is pinned at the top: the sidebar's own
    /// background, whole under the row, so that the threads scrolling under it do not
    /// show through (the sidebar's fade toward the chat would let them, under the row's
    /// controls). From the sidebar's edge to the row's end, where it fades out over a few
    /// points rather than stand as a block over the chat's wash.
    fileprivate var pinnedBackground: some View {
        AgentSidebar.background
            .mask {
                HStack(spacing: 0) {
                    Color.black
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: RowMetrics.padding / 2)
                }
            }
            .padding(.leading, -RowMetrics.inset)
    }

    /// Which folders' rows are at the very top of the list's visible part, kept apart
    /// from what the page draws.
    fileprivate final class HeaderTops {
        var pinned: Set<String> = []

        /// Whether the row is at the very top: pinned there while its threads scroll
        /// under it, or pushed up past it by the next part of the list.
        func isPinned(_ id: String) -> Bool {
            pinned.contains(id)
        }
    }

    /// Where the row being dragged would land, if anywhere: how far down the list the
    /// line that says so is. Observed on its own, by the line alone.
    @Observable fileprivate final class DropLine {
        var y: CGFloat?
        /// The row being dragged over the list, faded where it was from the moment the
        /// drag reaches the list; nil once it is over.
        var row: SidebarProject.ID?
    }

    /// The rows' places in the list and the row a drag began on, kept apart from what
    /// the page draws.
    fileprivate final class RowFrames {
        var places: [SidebarProject.ID: CGRect] = [:]

        /// The row a drag began on, with the rows it can be moved among, itself
        /// included, in their order.
        var lifted: (row: SidebarProject.ID, siblings: [SidebarProject.ID])?
        /// Where among those rows the drag would put it last: the index of the row it
        /// would go before, or their count for after them all. Held a little past each
        /// row's middle (`landingHold`), so a drag that rests near one does not make
        /// the line jump back and forth.
        var lastSlot: Int?
        /// Putting the line away, a moment after the drag said it left the list.
        var leaving: Task<Void, Never>?
    }

    /// How far past a row's middle a drag goes before the line moves to the other side
    /// of it.
    private static let landingHold: CGFloat = 2

    /// How long the line stays after a drag says it left the list. The system says so,
    /// and that it is back, each time a drag goes from one row onto the next: the line
    /// does not blink for that.
    private static let leavingWait: Duration = .milliseconds(150)

    /// The space the rows' places and a drag's are measured in: the list's own, so
    /// scrolling changes neither.
    fileprivate nonisolated static let listSpace = "space-list"

    fileprivate func noted(_ frame: CGRect, of row: SidebarProject.ID) {
        rowFrames.places[row] = frame
    }

    /// A drag began on `row`: what the system carries for it, which only this list
    /// takes. Nothing shows yet, as the row may only have been held for its menu.
    /// SwiftUI asks again while the drag goes on, each time the row is drawn, so
    /// this only notes the row: where it would land is the drop's own (`RowDrop`).
    fileprivate func lifted(_ row: SidebarProject.ID, among siblings: [SidebarProject.ID]) -> NSItemProvider {
        if rowFrames.lifted?.row != row { rowFrames.lastSlot = nil }
        rowFrames.lifted = (row, siblings)
        let carried = NSItemProvider()
        carried.registerDataRepresentation(forTypeIdentifier: UTType.sidebarRow.identifier, visibility: .ownProcess) { loaded in
            loaded(Data(), nil)
            return nil
        }
        return carried
    }

    fileprivate var hasLiftedRow: Bool {
        rowFrames.lifted != nil
    }

    /// Where the row a drag began on lands when it is let go `y` down the list: before
    /// which of the rows it is moved among, or after the last of them (`before` nil),
    /// and how far down to draw the line that says so. nil when it would stay where it
    /// is.
    private func landing(at y: CGFloat) -> (before: SidebarProject.ID?, line: CGFloat)? {
        guard let lifted = rowFrames.lifted else { return nil }
        let frames = lifted.siblings.map { rowFrames.places[$0] }
        guard lifted.siblings.count > 1, let from = lifted.siblings.firstIndex(of: lifted.row) else { return nil }
        // The first row whose middle the drag is above; none when it is under them all.
        let slot = SidebarLanding.slot(at: y, middles: frames.map { $0?.midY }, previous: rowFrames.lastSlot, hold: Self.landingHold)
        rowFrames.lastSlot = slot
        guard slot != from, slot != from + 1 else { return nil }
        let line: CGFloat
        if slot < frames.count, let frame = frames[slot] {
            // Folders after the first have a larger gap above them.
            let gap = slot > 0 ? RowMetrics.spacing + RowMetrics.headerGap : RowMetrics.spacing
            line = frame.minY - gap / 2
        } else if slot > 0, let frame = frames[slot - 1] {
            line = frame.maxY + RowMetrics.spacing / 2
        } else {
            return nil
        }
        return (slot < lifted.siblings.count ? lifted.siblings[slot] : nil, line)
    }

    /// The drag is over the list, `y` down it. Only the line is drawn again, and only
    /// when where the row would land changes.
    fileprivate func dragged(to y: CGFloat) {
        rowFrames.leaving?.cancel()
        rowFrames.leaving = nil
        if let row = rowFrames.lifted?.row, dropLine.row != row { dropLine.row = row }
        let line = landing(at: y)?.line
        if dropLine.y != line { dropLine.y = line }
    }

    /// The drag said it left the list: unless it is back in a moment, the row would go
    /// nowhere.
    fileprivate func dragLeft() {
        rowFrames.leaving?.cancel()
        rowFrames.leaving = Task { [rowFrames, dropLine] in
            try? await Task.sleep(for: Self.leavingWait)
            guard !Task.isCancelled else { return }
            rowFrames.lastSlot = nil
            if dropLine.y != nil { dropLine.y = nil }
            if dropLine.row != nil { dropLine.row = nil }
        }
    }

    /// Nothing of a drag shows any more.
    private func dragEnded() {
        rowFrames.leaving?.cancel()
        rowFrames.leaving = nil
        rowFrames.lastSlot = nil
        if dropLine.y != nil { dropLine.y = nil }
        if dropLine.row != nil { dropLine.row = nil }
    }

    /// Whether `row` is the one being dragged over the list.
    fileprivate func isDragged(_ row: SidebarProject.ID) -> Bool {
        dropLine.row == row
    }

    /// The row was let go `y` down the list: it goes where the line was, if anywhere.
    fileprivate func dropped(at y: CGFloat) -> Bool {
        guard let lifted = rowFrames.lifted else { return false }
        let landing = landing(at: y)
        rowFrames.lifted = nil
        dragEnded()
        guard let landing else { return true }
        withAnimation(.smooth(duration: 0.25)) { fleet.move(lifted.row, before: landing.before) }
        return true
    }

    /// The list as the place a held row is dragged over and let go on. The system
    /// carries the row (`lifted`): a pointer drags it at once and opens its menu with a
    /// secondary click; a finger holds it until it lifts and drags, as anywhere on an
    /// iPhone, with no menu in the way (`rowMenu`).
    fileprivate struct RowDrop: DropDelegate {
        let page: SpacePage

        func validateDrop(info: DropInfo) -> Bool {
            page.hasLiftedRow && info.hasItemsConforming(to: [.sidebarRow])
        }

        func dropEntered(info: DropInfo) {
            page.dragged(to: info.location.y)
        }

        func dropUpdated(info: DropInfo) -> DropProposal? {
            page.dragged(to: info.location.y)
            return DropProposal(operation: .move)
        }

        func dropExited(info: DropInfo) {
            page.dragLeft()
        }

        func performDrop(info: DropInfo) -> Bool {
            page.dropped(at: info.location.y)
        }
    }
}

private extension SidebarMove {
    var title: String {
        switch self {
        case .up: "Move up"
        case .down: "Move down"
        case .top: "Move to top"
        case .bottom: "Move to bottom"
        }
    }

    var systemImage: String {
        switch self {
        case .up: "arrow.up"
        case .down: "arrow.down"
        case .top: "arrow.up.to.line"
        case .bottom: "arrow.down.to.line"
        }
    }
}

private extension UTType {
    /// A row of the sidebar while it is dragged to another place. The app's own
    /// (Info.plist exports it), and nothing outside the app is given it.
    nonisolated static let sidebarRow = UTType(exportedAs: "com.danielou.portals.sidebar-row")
}

/// The line that shows where a dragged row lands, gliding from one gap to the next.
private struct DropLineMark: View {
    let line: SpacePage.DropLine

    var body: some View {
        ZStack(alignment: .top) {
            if let y = line.y {
                Capsule()
                    .fill(Theme.tint)
                    .frame(height: 2)
                    .padding(.horizontal, RowMetrics.padding)
                    .offset(y: y - 1)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .animation(.snappy(duration: 0.1), value: line.y)
        // A finger feels the line move from one gap to the next.
        .sensoryFeedback(.selection, trigger: line.y) { _, new in new != nil }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private extension View {
    /// A folder's row as the header of its threads, which stays at the top of the list
    /// while they scroll under it: `gap` above it, the sidebar's background behind it
    /// while it is pinned there, where it is noted (to tell when it is), and an id to
    /// bring it back into sight by.
    func pinnedHeader(_ id: String, gap: CGFloat, in page: SpacePage) -> some View {
        modifier(PinnedHeader(id: id, gap: gap, page: page))
    }

    /// A folder's row, which can be moved among `siblings`: its place in the list is
    /// noted, and holding it and dragging moves it, under a finger as under a pointer, a
    /// line showing where it lands, and the row faded where it was while it is on its
    /// way. A row with none like it has nowhere to go.
    @ViewBuilder
    func movable(_ row: SidebarProject.ID, among siblings: [SidebarProject.ID], in page: SpacePage) -> some View {
        if siblings.count > 1 {
            onGeometryChange(for: CGRect.self) { $0.frame(in: .named(SpacePage.listSpace)) } action: { page.noted($0, of: row) }
                .opacity(page.isDragged(row) ? 0.4 : 1)
                .onDrag { page.lifted(row, among: siblings) }
        } else {
            self
        }
    }

    /// A row's menu, on a secondary click, or on a long press where that does not move
    /// the row. On an iPhone or an iPad a row that can be moved is held to move it, and
    /// nothing else: a menu opening under the finger would take the drag for a pick from
    /// it, the system's way, so there the menu is the row's New thread button's, held.
    @ViewBuilder
    func rowMenu(isMovable: Bool, @ViewBuilder _ items: () -> some View) -> some View {
        if Platform.isMac || !isMovable {
            contextMenu(menuItems: items)
        } else {
            self
        }
    }
}

/// `pinnedHeader`. Whether the row is pinned is its own state, which changes only as it
/// reaches the top or leaves it, not at each step of a scroll.
private struct PinnedHeader: ViewModifier {
    let id: String
    let gap: CGFloat
    let page: SpacePage

    @State private var isPinned = false

    func body(content: Content) -> some View {
        content
            .padding(.top, gap)
            .background {
                if isPinned { page.pinnedBackground }
            }
            // Told only as it reaches the top or leaves it, not at each step of a scroll.
            .onGeometryChange(for: Bool.self) { $0.frame(in: .scrollView).minY <= 0.5 } action: { pinned in
                if pinned {
                    page.headerTops.pinned.insert(id)
                } else {
                    page.headerTops.pinned.remove(id)
                }
                if pinned != isPinned { isPinned = pinned }
            }
            // Pinned over the threads scrolling under it, the row is what the pointer is on.
            .coversThreadRows(page.rowHover, id: id)
            .id(id)
    }
}

/// A folder's New thread on an iPhone or an iPad, which held is the folder's menu (its
/// row is held to move it): a button of UIKit's with its menu made up front, made again
/// only when what the menu offers changes, not each time the sidebar is drawn.
private struct ProjectMenuButton<Items: View>: View, Equatable {
    let project: SidebarProject.ID
    /// The folder New thread starts a thread in, its path and its name.
    let folder: Folder
    let isOnlyAdded: Bool
    let siblings: [SidebarProject.ID]
    /// The agents a thread in the folder can be with, which New thread starts or asks:
    /// compared whole, as New thread hands one on (its name and model with it).
    let agents: [Agent]
    /// The folders are listed by last use, which its menu says.
    let sortsByLastUse: Bool
    @ViewBuilder let menu: () -> Items
    let onNewThread: () -> Void

    static func == (one: ProjectMenuButton, other: ProjectMenuButton) -> Bool {
        one.project == other.project && one.folder == other.folder && one.isOnlyAdded == other.isOnlyAdded
            && one.siblings == other.siblings && one.agents == other.agents && one.sortsByLastUse == other.sortsByLastUse
    }

    var body: some View {
        Menu {
            menu()
        } label: {
            RowControl(systemImage: RowControl.newThread)
        } primaryAction: {
            onNewThread()
        }
        .accessibilityHint("Hold for more")
    }
}
