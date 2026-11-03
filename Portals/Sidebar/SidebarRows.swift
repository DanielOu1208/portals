import AgentCore
import SwiftUI

/// The sidebar's measures. A row is one line, its icon in one column and its text on
/// one edge, whatever it lists: a folder, a thread, a Mac's problem.
enum RowMetrics {
    /// A row's height: a pointer's on a Mac, a finger's on an iPhone and iPad.
    static let height: CGFloat = Platform.isMac ? 32 : 44
    /// A thread's row, and a row among threads (Show more): the same 44-point touch
    /// target as a folder on iPhone and iPad; denser for a pointer on Mac.
    static let threadHeight = height
    /// The height of a row of two lines: a thread listed away from its folder.
    static let tallHeight: CGFloat = Platform.isMac ? 46 : 50
    /// Needs you, Running and Recent on top: tighter than the rest of the list (the user's
    /// asks of 2026-10-17 and 2026-10-19), with a Mac's own measures.
    static let groups: GroupSpacing = Platform.isMac ? .mac(DebugLaunch.groupSpacing) : .touch(DebugLaunch.groupSpacing)
    /// Room inside a row's box, at each end.
    static let padding: CGFloat = Theme.grid
    /// The column a row's icon sits in: an agent's logo, a folder, a Mac's dot.
    static let icon: CGFloat = Platform.isMac ? 22 : 26
    /// The room an agent's mark takes before a thread's title, under a folder.
    static let mark: CGFloat = Platform.isMac ? 16 : 18
    /// Between the icon's column and the text.
    static let gap: CGFloat = Theme.grid
    /// The corners of a row's box.
    static let corner: CGFloat = 8
    /// From the sidebar's edge to every box in it: the search field, a row. With a row's
    /// own padding, what the rows say starts under the window's buttons on a Mac.
    static let inset: CGFloat = 12
    /// Between one row and the next.
    static let spacing: CGFloat = 2
    /// Above a folder's row that follows another's, on top of `spacing`:
    /// each with its threads reads as a group of its own, where a list's threads stay
    /// close together (2026-10-17).
    static let headerGap: CGFloat = Platform.isMac ? 8 : 10
    /// Between the search row and a list that begins with a row.
    static let blockGap: CGFloat = Theme.grid * 1.5
    /// Above a title that begins a part of the list (Running, Archived): clearly
    /// more than between two rows, so the parts read as parts.
    static let sectionGap: CGFloat = Platform.isMac ? 22 : 26
    /// About how tall a group's title's words are, for working out the groups' height
    /// before a title has been laid out and measured.
    static let groupTitleText: CGFloat = Platform.isMac ? 14 : 18
    /// Where a row's text starts, from its box's edge: after its icon's column.
    static let textEdge: CGFloat = padding + icon + gap
    /// How far a row swiped away goes: out of the sidebar, however wide.
    static let slideOut: CGFloat = 480
}

/// A label laid out as a row is: its icon in the middle of the icon's column, its words
/// on the text's edge.
struct RowLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: RowMetrics.gap) {
            configuration.icon
                .frame(width: RowMetrics.icon)
            configuration.title
        }
    }
}

/// A row's box: its height, and the fill that says it is the thread on screen or, with
/// a pointer, the row under it.
struct RowBox<Content: View>: View {
    private let isCurrent: Bool
    private let height: CGFloat
    private let content: Content

    /// Whether the pointer is on the row, where something else knows it (a thread row on a
    /// Mac, whose list draws that fill: `RowHover`); nil: the box knows itself.
    private let hover: Bool?
    @State private var isHovered = false

    init(isCurrent: Bool = false, height: CGFloat = RowMetrics.height, isHovered hover: Bool? = nil, @ViewBuilder content: () -> Content) {
        self.isCurrent = isCurrent
        self.height = height
        self.hover = hover
        self.content = content()
    }

    var body: some View {
        let box = content
            .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
            .background {
                if isCurrent || (hover ?? isHovered) {
                    RoundedRectangle(cornerRadius: RowMetrics.corner, style: .continuous)
                        .fill(Color(uiColor: isCurrent ? .tertiarySystemFill : .quaternarySystemFill))
                }
            }
            .contentShape(.rect)
        if hover == nil {
            box.onHover { isHovered = $0 }
        } else {
            box
        }
    }
}

/// The second line of a thread listed away from its folder (`AgentSidebar.caption(of:)`):
/// who started it when an agent did, whose it is (a bot's; a coding agent's logo says
/// it), the folder it works in and, with several hosts, which.
struct ThreadCaption: Equatable {
    var starter: String?
    /// Whose it is: read out always, and shown where `showsAgent`.
    var agent: String?
    /// Whose it is shows: a bot's name, not a coding agent's, whose logo before the title
    /// says it. Its name is still read out, the logo being no words (as the chat's header
    /// has it).
    var showsAgent = true
    var folder: String?
    /// For a thread working in a git worktree: its branch (`ThreadRecord.worktreeBranch`).
    var branch: String?
    var host: String?

    /// Whether the line shows nothing.
    var isEmpty: Bool { starter == nil && shownAgent == nil && folder == nil && branch == nil && host == nil }

    private var shownAgent: String? { showsAgent ? agent : nil }

    /// Apart by dots ("Hanni · aerirc · MBP16").
    var text: Text {
        var parts: [Text] = []
        if let starter { parts.append(Text("\(Image(systemName: "arrow.turn.down.right")) \(starter)")) }
        if let agent = shownAgent { parts.append(Text(agent)) }
        if let folder { parts.append(Text(folder)) }
        if let branch { parts.append(Text("\(Image(systemName: "arrow.triangle.branch")) \(branch)")) }
        if let host { parts.append(Text(host)) }
        guard let first = parts.first else { return Text(verbatim: "") }
        return parts.dropFirst().reduce(first) { Text("\($0) · \($1)") }
    }

    /// The same, as it is read out, with whose it is also where that does not show
    /// ("Claude Code, in aerirc, on MBP16").
    var spoken: String {
        [starter, agent, folder.map { "in \($0)" }, branch.map { "on branch \($0)" }, host.map { "on \($0)" }]
            .compactMap(\.self).joined(separator: ", ")
    }
}

/// A thread's row: its title, in bold while it waits for you or is not opened yet,
/// and at its far end what it is doing or how long ago it was active.
///
/// Compared by what it shows, and not by the fleet and the actions it is handed, which
/// stay the same: a row whose thread, place and state did not change is not drawn
/// again when something else in the sidebar does (a turn ending in another thread, a
/// title, the groups on top), so a change costs the rows it changes.
struct ThreadRow: View, Equatable {
    let record: ThreadRecord
    let kind: AgentSidebar.ThreadRowKind
    /// Its box's height: tall for two lines, and less tall in the groups on top of the
    /// sidebar (`RowMetrics.groups`).
    let height: CGFloat
    /// Whether its thread is the one on screen (`Fleet.currentRows`): read by the row
    /// itself, so that a switch draws again the rows it changes alone.
    let current: CurrentRows.Flag
    let activity: HostModel.Activity
    /// The agent's look, for a row that shows its avatar (under a folder, or apart).
    let style: AgentAvatarStyle?
    let caption: ThreadCaption?
    /// How long ago it was active (`AgentSidebar.age(of:)`), worked out by the list, so
    /// that the row is drawn again when that changes.
    let age: String
    let offersRemoval: Bool
    /// What closing the row does, under Recent: nil elsewhere, where it is not closed.
    let closing: String?
    /// Its thread is open as a tab on this device: its menu closes the tab.
    let isTab: Bool
    /// Its thread is a bot's (`Fleet.isBot`), which its menu shows in the sidebar rather
    /// than in a folder.
    let isBot: Bool
    let fleet: Fleet
    let onOpen: (ThreadRecord) -> Void
    let onRename: (ThreadRecord) -> Void

    #if targetEnvironment(macCatalyst)
    /// The list's tracker of the pointer, which the row tells where it is in the list, and
    /// which tells a row under Recent when the pointer is on it (`RowHover`).
    @Environment(RowHover.self) private var rowHover: RowHover?
    /// This row view's own, which its place in the list is noted and forgotten by: a row of
    /// the same thread made in another group before this one is let go keeps its place.
    @State private var rowToken = UUID()
    /// Whether the pointer is on this row, which the list sets (`RowHover.Flag`).
    @State private var hoverFlag = RowHover.Flag()
    /// Where the row was last laid out in its list, and whether the list shows it: noted
    /// again from it as the list shows the row again (`RowHover.Spot`).
    @State private var hoverSpot = RowHover.Spot()
    #endif
    /// How far a swipe to the left has moved the row, under Recent on a touch screen.
    @State private var swipeDistance: CGFloat = 0
    /// When a swipe last moved it: the finger lifting over the row at a swipe's end is
    /// no tap on it.
    @State private var swipedAt = Date.distantPast

    static func == (one: ThreadRow, other: ThreadRow) -> Bool {
        one.record == other.record && one.kind == other.kind && one.height == other.height && one.current === other.current
            && one.activity == other.activity && one.style == other.style && one.caption == other.caption
            && one.age == other.age && one.offersRemoval == other.offersRemoval && one.closing == other.closing
            && one.isTab == other.isTab && one.isBot == other.isBot && one.fleet === other.fleet
    }

    /// How far a swipe goes, with its flick, to close the row rather than slide back.
    private static let swipeToClose: CGFloat = 90

    var body: some View {
        let _ = RowProbe.countBody()
        let isCurrent = current.isCurrent
        let standsOut = record.isUnseen || activity == .waiting
        // On a Mac the list draws the fill of the row under the pointer (`RowHover`).
        let label = RowBox(isCurrent: isCurrent, height: height, isHovered: Platform.isMac ? false : nil) {
            HStack(spacing: RowMetrics.gap) {
                switch kind {
                case .underProject:
                    starterMark
                    if let style { RowAvatar(style: style, side: RowMetrics.mark) }
                case .apart:
                    if let style { RowAvatar(style: style) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(record.displayTitle)
                        .font(.app.subheadline.weight(standsOut ? .semibold : .regular))
                        .lineLimit(1)
                        .foregroundStyle(Color.primary.opacity(isCurrent || standsOut ? 1 : 0.86))
                        .rowInk()
                        // Whose it is, when that is all its second line would say and its
                        // logo shows it: read out with the title.
                        .accessibilityLabel(caption.flatMap { $0.isEmpty ? "\(record.displayTitle), \($0.spoken)" : nil } ?? record.displayTitle)
                    if let caption, !caption.isEmpty {
                        caption.text
                            .font(.app.caption)
                            .lineLimit(1)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel(caption.spoken)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                roomyFarEnd
            }
            .padding(.horizontal, RowMetrics.padding)
        }
        #if targetEnvironment(macCatalyst)
        // On a Mac the row is only drawn: it takes no hit, tracks no pointer and has no
        // UIKit view of its own. Its list's one control takes the clicks where a row is,
        // and opens the row's menu as a pull-down one, made as it opens, which a secondary
        // click opens under the row (`RowHover`); assistive apps reach the row as the
        // button it was, its parts read out in their order (`accessibilityText`).
        return label
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
            .accessibilityIdentifier("thread-row")
            .accessibilityAction { onOpen(record) }
            .accessibilityActions {
                if let closing {
                    Button(closing) { fleet.closeOrDismiss(record) }
                }
            }
            .overlay(alignment: .trailing) { closeButton }
            // Where the row is in its list, noted again when a layout moves it, and when the
            // list shows it again after letting it go: scrolled out of sight and back, or
            // its Mac's space swiped away and back, it is where it was, so no layout moves it,
            // and with its place forgotten a click on it opened nothing (2026-10-30:
            // "some threads won't open when clicking in the bottom half").
            .onGeometryChange(for: RowHover.Place.self) { proxy in
                RowHover.Place(frame: proxy.frame(in: .named(RowHover.space)), kind: kind, closes: closing != nil, isCurrent: isCurrent)
            } action: { place in
                if let shown = hoverSpot.spot.laidOut(at: place) {
                    rowHover?.note(shown, of: self, token: rowToken, flag: hoverFlag)
                }
            }
            .onAppear {
                if let place = hoverSpot.spot.appeared() {
                    rowHover?.note(place, of: self, token: rowToken, flag: hoverFlag)
                }
            }
            .onDisappear {
                hoverSpot.spot.disappeared()
                rowHover?.forget(record.key, token: rowToken)
            }
        #else
        let row = Button {
            guard Date.now.timeIntervalSince(swipedAt) > 0.4 else { return }
            onOpen(record)
        } label: {
            label
        }
        .buttonStyle(.plain)
        .contextMenu { menu }
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("thread-row")
        .accessibilityActions {
            if let closing {
                Button(closing) { fleet.closeOrDismiss(record) }
            }
        }
        return Group {
            if closing == nil {
                row
            } else {
                row
                    .offset(x: swipeDistance)
                    .background(alignment: .trailing) { swipeMark }
                    .gesture(RowSwipe(onChange: swiped, onEnd: swipeEnded))
            }
        }
        #endif
    }

    /// The × at the row's far end while the pointer is on it, under Recent on a Mac:
    /// dismisses its Recent entry. Only such a row asks
    /// whether the pointer is on it, and is drawn again as that changes.
    private var showsClose: Bool {
        #if targetEnvironment(macCatalyst)
        closing != nil && hoverFlag.isOn
        #else
        false
        #endif
    }

    @ViewBuilder
    private var closeButton: some View {
        if let closing, showsClose {
            Button(closing, systemImage: "xmark") { fleet.closeOrDismiss(record) }
                .labelStyle(.iconOnly)
                .font(.app.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: RowMetrics.mark + Theme.grid, height: RowMetrics.mark + Theme.grid)
                .contentShape(.rect)
                .buttonStyle(.plain)
                .padding(.trailing, RowMetrics.padding / 2)
                .tip(closing)
                .accessibilityIdentifier("recent-close")
        }
    }

    /// What the row's swipe does, in the room it leaves as it moves: the more it shows,
    /// the nearer the swipe is to closing it.
    @ViewBuilder
    private var swipeMark: some View {
        if swipeDistance < 0, let closing {
            Label(closing, systemImage: "xmark")
                .labelStyle(.iconOnly)
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: RowMetrics.icon, height: RowMetrics.icon)
                .padding(.trailing, RowMetrics.padding * 2)
                .opacity(min(1, -swipeDistance / Self.swipeToClose))
                .accessibilityHidden(true)
        }
    }

    /// A swipe moved: the row follows it to the left, and not past its place to the right.
    private func swiped(_ distance: CGFloat) {
        swipeDistance = min(distance, 0)
        swipedAt = .now
    }

    /// A swipe ended where it would come to rest (`projected`), or was cancelled (nil):
    /// far enough to the left, the row leaves and closes; else it slides back. Should it
    /// stay listed (its host not yet told), it slides back a moment later.
    private func swipeEnded(_ projected: CGFloat?) {
        swipedAt = .now
        guard let projected, projected < -Self.swipeToClose else {
            withAnimation(.smooth(duration: 0.25)) { swipeDistance = 0 }
            return
        }
        withAnimation(.smooth(duration: 0.2)) { swipeDistance = -RowMetrics.slideOut }
        fleet.closeOrDismiss(record)
        Task {
            try? await Task.sleep(for: .seconds(0.6))
            withAnimation(.smooth(duration: 0.25)) { swipeDistance = 0 }
        }
    }

    /// The thread's menu: closing its tab, showing it in its folder (a row on top, or a
    /// search's), pin, rename, archive, show in the sidebar or not (one an agent started)
    /// and remove, headed by its branch.
    @ViewBuilder
    private var menu: some View {
        // Show in Its Folder not for one in no folder, under the thread that started it:
        // Take Over Thread, below, puts it in one.
        let showsFolder = kind == .apart && !fleet.isTucked(record)
        if isTab || showsFolder || closing != nil {
            Section {
                if let closing {
                    Button(closing, systemImage: "xmark") { fleet.closeOrDismiss(record) }
                }
                if isTab {
                    // Its agent goes on with whatever it was doing.
                    Button("Close Tab", systemImage: "xmark") { fleet.closeTab(record.key) }
                }
                if showsFolder {
                    // Its Mac's space, at the thread's folder; a bot's at its avatar.
                    Button(isBot ? "Show in Sidebar" : "Show in Its Folder", systemImage: isBot ? "sidebar.leading" : "folder") {
                        fleet.revealedThread = record.key
                    }
                }
            }
        }
        // Headed by the git branch its folder was on at its last turn, where the host
        // says: where the work lands, at no cost to the row.
        Section {
            Button(record.isPinned ? "Unpin" : "Pin", systemImage: record.isPinned ? "pin.slash" : "pin") {
                fleet.setPinned(!record.isPinned, for: record)
            }
            // An agent's one ongoing conversation keeps the agent's name.
            if !record.ref.isOngoing {
                Button("Rename…", systemImage: "pencil") {
                    onRename(record)
                }
            }
            if fleet.offersFork(record) {
                Button("Fork thread", systemImage: "arrow.triangle.branch") { fleet.fork(record) }
                    .disabled(!fleet.canFork(record))
                    .accessibilityIdentifier("fork-thread")
            }
            Button(record.isArchived ? "Unarchive" : "Archive", systemImage: record.isArchived ? "tray.and.arrow.up" : "archivebox") {
                fleet.setArchived(!record.isArchived, for: record)
            }
            // One an agent started from another thread: listed under that one, or here too.
            if fleet.nestsUnderItsStarter(record) {
                Button(record.isShared ? TakeOver.undoInMenu : TakeOver.nameInMenu, systemImage: TakeOver.symbol) {
                    fleet.setShared(!record.isShared, for: record)
                }
            }
        } header: {
            if let heading = Self.menuHeading(of: record) {
                Text(heading)
            }
        }
        // Where it leaves every device, not while it is at work: it is stopped first.
        if offersRemoval {
            Divider()
            Button("Remove from Portals", systemImage: "trash", role: .destructive) { fleet.delete(record) }
        }
    }

    /// What heads the menu's section of pin, rename and archive: the worktree and the git
    /// branch its folder was on at its last turn, where the host says.
    static func menuHeading(of record: ThreadRecord) -> String? {
        if let repo = record.repo, !repo.isEmpty {
            let project = Folder.name(of: repo, general: nil)
            return record.branch.map { "In a worktree of \(project), on branch \($0)" } ?? "In a worktree of \(project)"
        }
        return record.branch.map { "On branch \($0)" }
    }

    #if targetEnvironment(macCatalyst)
    /// The row as assistive apps read it on a Mac: what SwiftUI made of the label of the
    /// menu button that drew the row before, its parts in their order, apart by commas ("A
    /// title, Claude Code, in aerirc, 2h, Not opened yet"); the far end not while the × is
    /// over it, unseen then (`farEnd`, at no opacity), as SwiftUI left it out.
    private var accessibilityText: String {
        var parts: [String] = []
        if kind == .underProject, let starter = record.startedBy?.caption { parts.append(starter) }
        parts.append(caption.flatMap { $0.isEmpty ? "\(record.displayTitle), \($0.spoken)" : nil } ?? record.displayTitle)
        if let caption, !caption.isEmpty { parts.append(caption.spoken) }
        guard !showsClose else { return parts.filter { !$0.isEmpty }.joined(separator: ", ") }
        if record.isPinned { parts.append("Pinned") }
        switch activity {
        case .idle:
            if kind != .apart, let branch = record.worktreeBranch { parts.append("on branch \(branch)") }
            parts.append(age)
            if record.isUnseen { parts.append("Not opened yet") }
        case .working:
            parts.append("Working")
        case .waiting:
            parts.append("Waiting for you")
        }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
    #endif

    /// What stands in the icon's column of a thread under its folder: an arrow when an
    /// agent started it, and nothing otherwise.
    private var starterMark: some View {
        Group {
            if let starter = record.startedBy?.caption {
                Image(systemName: "arrow.turn.down.right")
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(starter)
                    // On a Mac the list's control shows it (`RowHover.Target.tip`).
                    .tip(Platform.isMac ? nil : starter)
            } else {
                Color.clear
            }
        }
        .frame(width: RowMetrics.icon, height: RowMetrics.icon)
    }

    /// The far end: its pin, whatever the thread is doing (2026-11-02: "if i pin a
    /// thread in running status it does not show a pinned icon"); then turning while it works
    /// and an amber dot while it waits for you; at rest, how long ago it was active, and a
    /// blue dot when it finished out of sight and is not opened yet (`ActivityMark`'s).
    @ViewBuilder
    private var farEnd: some View {
        HStack(spacing: Theme.grid * 0.75) {
            if record.isPinned {
                Image(systemName: "pin.fill")
                    .font(.app.caption2)
                    .accessibilityLabel("Pinned")
            }
            if activity == .idle {
                // In a git worktree, under its repository's folder: its branch, which the
                // menu names with the folder. A thread of the main checkout says its branch
                // only at the top of its menu.
                if kind != .apart, let branch = record.worktreeBranch {
                    Text("\(Image(systemName: "arrow.triangle.branch")) \(AgentSidebar.shortBranch(branch))")
                        .lineLimit(1)
                        .accessibilityLabel("on branch \(branch)")
                }
                RowAge(age: age, key: record.key, fleet: fleet)
                if record.isUnseen {
                    UnseenDot()
                        .rowInk()
                }
            } else {
                ActivityMark(activity: activity)
            }
        }
        .font(.app.caption)
        .foregroundStyle(.secondary)
        .overlay(alignment: .leading) {
            if activity != .idle {
                // Just before the far end, from a point of no width there.
                Color.clear
                    .frame(width: 0)
                    .overlay(alignment: .trailing) {
                        RowShortcutOverlay(key: record.key, fleet: fleet)
                            .padding(.trailing, Theme.grid * 0.75)
                    }
            }
        }
        .layoutPriority(1)
    }

    /// The far end, on a Mac with room kept for what shows there instead under the pointer
    /// (`RowHover`), so that a long title never runs under it and nothing moves as it comes
    /// and goes.
    @ViewBuilder
    private var roomyFarEnd: some View {
        #if targetEnvironment(macCatalyst)
        farEnd
            .modifier(HiddenUnderPointer(flag: hoverFlag))
            .frame(minWidth: RowHover.controlsRoom(closes: closing != nil), alignment: .trailing)
        #else
        farEnd
        #endif
    }
}

/// A row that opens and closes the threads under it: a folder's. One line: its icon,
/// its name, what its threads are doing while it is closed, an arrow, and at
/// its far end its controls (New thread), open or closed: a thread is started from the
/// row as it is, with no need to open it first.
struct HeaderRow<Icon: View, Controls: View>: View {
    private let name: String
    /// Said after the name, quieter: what tells two of one name apart.
    private let detail: String?
    private let activity: HostModel.Activity
    private let isOpen: Bool
    /// How the row is read out, and what names it for tests.
    private let label: String
    private let identifier: String
    /// What the pointer shows on the row, apart from its controls, which say their own.
    private let tip: String?
    /// Its name in the secondary colour and weight: No project, among the folders.
    private let isQuiet: Bool
    /// Folds its list back to the recent threads, while it shows them all: from the row,
    /// which stays at the top while they scroll, rather than from the list's end.
    private let onShowFewer: (() -> Void)?
    private let onToggle: () -> Void
    private let icon: Icon
    private let controls: Controls

    init(
        name: String, detail: String? = nil, activity: HostModel.Activity, isOpen: Bool, label: String, identifier: String,
        tip: String? = nil, isQuiet: Bool = false, onShowFewer: (() -> Void)? = nil, onToggle: @escaping () -> Void,
        @ViewBuilder icon: () -> Icon, @ViewBuilder controls: () -> Controls
    ) {
        self.name = name
        self.detail = detail
        self.activity = activity
        self.isOpen = isOpen
        self.label = label
        self.identifier = identifier
        self.tip = tip
        self.isQuiet = isQuiet
        self.onShowFewer = onShowFewer
        self.onToggle = onToggle
        self.icon = icon()
        self.controls = controls()
    }

    /// Open or closed: an open row, pinned at the top while its threads scroll, is
    /// closed from here.
    private var arrow: some View {
        Image(systemName: isOpen ? "chevron.down" : "chevron.right")
            .font(.app.caption2.weight(.semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 16, height: RowMetrics.height)
            .contentShape(.rect)
    }

    var body: some View {
        RowBox {
            HStack(spacing: 0) {
                Button(action: onToggle) {
                    HStack(spacing: RowMetrics.gap) {
                        icon
                            .frame(width: RowMetrics.icon, height: RowMetrics.icon)
                        Text(name)
                            .font(.app.subheadline.weight(isQuiet ? .regular : .semibold))
                            .foregroundStyle(isQuiet ? Color.secondary : Color.primary)
                            .lineLimit(1)
                        if let detail {
                            Text(detail)
                                .font(.app.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        Spacer(minLength: Theme.grid / 2)
                        ActivityMark(activity: activity)
                        if onShowFewer == nil { arrow }
                    }
                    .frame(maxWidth: .infinity, minHeight: RowMetrics.height, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .tip(tip)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(label)
                .accessibilityHint(isOpen ? "Hides its threads" : "Shows its threads")
                .accessibilityIdentifier(identifier)

                if let onShowFewer {
                    Button(action: onShowFewer) {
                        Text("Show fewer")
                            .font(.app.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, Theme.grid / 2)
                            .frame(minHeight: RowMetrics.height)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("show-fewer-\(identifier)")
                    Button(action: onToggle) { arrow }
                        .buttonStyle(.plain)
                        .accessibilityHidden(true)
                }

                controls
            }
            .padding(.leading, RowMetrics.padding)
            .padding(.trailing, RowMetrics.padding / 2)
        }
    }
}

/// A small control at a row's far end: New thread, More.
struct RowControl: View {
    let systemImage: String

    /// New thread's mark, the compose symbol, told apart from adding a folder's.
    static let newThread = "square.and.pencil"

    var body: some View {
        Image(systemName: systemImage)
            .font(.app.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: Platform.isMac ? 24 : 36, height: RowMetrics.height)
            .contentShape(.rect)
    }
}

/// An agent's avatar as a row's icon, in a still pose: whose row it is, or whose thread.
/// Drawn again only when its look or its room changes.
struct RowAvatar: View, Equatable {
    let style: AgentAvatarStyle
    /// The side of the room it has: the icon's column, or a mark's before a title.
    var side = RowMetrics.icon

    var body: some View {
        if let logo = style.logo, style.showsLogo {
            // A maker's logo stands in a row by itself and fills its room, with no glass
            // circle round it as it has in the chat: the circle took the room, and left
            // the logo a speck.
            logo.image
                .resizable()
                .scaledToFit()
                .frame(width: side, height: side)
                .accessibilityHidden(true)
        } else {
            // An avatar's square keeps room round its body, so it is drawn larger than
            // its room, over its edges, and comes out about a logo's size.
            AgentAvatarView(state: .idle, frozenAt: 1, size: side * 1.36, style: style)
                .frame(width: side, height: side)
        }
    }
}

/// What a thread is doing, or a folder or a bot with such a thread, at its row's far
/// end, and at a tab's (`TabStrip`): turning while it works, an amber dot while it waits
/// for you, nothing at rest, or a blue dot for a thread at rest that ended out of sight
/// and is not opened yet (`unseen`). The amber is the sidebar's one colour for what asks
/// for something; the blue only says there is something new to read.
struct ActivityMark: View {
    let activity: HostModel.Activity
    var unseen = false

    var body: some View {
        switch activity {
        case .working:
            ProgressView()
                .controlSize(.mini)
                .frame(width: 16)
                .accessibilityLabel("Working")
        case .waiting:
            Circle()
                .fill(.orange)
                .frame(width: 8, height: 8)
                .frame(width: 16)
                .accessibilityLabel("Waiting for you")
        case .idle where unseen:
            UnseenDot()
                .frame(width: 16)
        case .idle:
            EmptyView()
        }
    }
}

/// The blue dot of a thread that ended out of sight and is not opened yet: at its row's
/// far end, and as what a tab or a bot shows at rest (`ActivityMark`).
struct UnseenDot: View {
    var body: some View {
        Circle()
            .fill(.blue)
            .frame(width: 7, height: 7)
            .accessibilityLabel("Not opened yet")
    }
}

extension View {
    /// What the pointer shows when it rests on the view, where there is something to
    /// say.
    @ViewBuilder
    func tip(_ text: String?) -> some View {
        if let text, !text.isEmpty {
            help(text)
        } else {
            self
        }
    }
}

/// The title over a group of threads from every host: Needs you, Running, Recent.
struct GroupTitle: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.app.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            .contentTransition(.opacity)
            // On the text's edge, as a row's words are.
            .padding(.leading, RowMetrics.textEdge)
            .padding(.trailing, RowMetrics.padding)
            .padding(.top, RowMetrics.groups.titleTop)
            .padding(.bottom, RowMetrics.groups.titleBottom)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// A thread row's title and unseen dot on a Mac, drawn as SwiftUI drew them while the
    /// row was its menu button: as a control's label in a Mac's sidebar, over a material,
    /// with the system's colours for vibrancy, a shade brighter in dark mode than the
    /// list's own (the title at white 0.898 where the list's primary is 0.847, the blue
    /// dot up to 8 levels brighter). The same pixel for pixel, in dark and light mode, as
    /// that button drew them; the captions are left as they are, which a material would
    /// draw vibrantly. Elsewhere, the list's own.
    @ViewBuilder
    func rowInk() -> some View {
        #if targetEnvironment(macCatalyst)
        environment(\.backgroundMaterial, .regular)
        #else
        self
        #endif
    }
}
