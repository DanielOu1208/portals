import AgentCore
import SwiftUI

/// The Macs as tabs over the space below, in the look of the chat's tabs (2026-10-23): sharing the row alike, the one shown filled, the fill sliding to the next
/// as the space is swiped across; each with its Mac's kind, its name and, while it is not
/// connected, its connection's dot, and Retry once the app has stopped trying. One Mac is
/// one tab too. A tab dragged sideways moves its Mac among the others, the others sliding
/// to make room, which is the order of the user's Macs on every device
/// (`Fleet.moveHost`). At the row's end, a folder added on the Mac shown.
///
/// Once a name would be cut ("Mac…", "Danie…" with four Macs), only the tab of the Mac
/// shown keeps its name, taking the rest of the row, and the others are their icon alone
/// (2026-10-28: "when theres many devices just show the icon for the non selected
/// device so more devices can be shown without stuff getting cut off"). Measured, not a
/// number of Macs: two or three with short names keep every name, which says more than an
/// icon (every laptop has the same one).
struct MacTabs: View {
    let fleet: Fleet
    /// The Mac whose space shows (`Fleet.spaceOnScreen`).
    let shown: HostID?
    var onAddFolder: (HostID) -> Void
    var onDeskSessions: (Agent) -> Void

    @Namespace private var selection
    /// The tab being dragged along the row, and how far.
    @State private var dragging: HostID?
    @State private var dragX: CGFloat = 0
    /// Whether a drag is under way, which the system sets back however the drag ends: a
    /// drag called off (no `onEnded`) leaves no tab out of its place.
    @GestureState private var isDragging = false

    /// A tab's height: a pointer's on a Mac, more for a finger.
    static let height: CGFloat = Platform.isMac ? 26 : 32
    /// A tab's width with its Mac's icon alone: a pointer's on a Mac, more for a finger.
    static let iconWidth: CGFloat = Platform.isMac ? 34 : 40
    fileprivate static let spacing: CGFloat = 4
    /// The narrowest the named tab of the Mac shown gets before the row scrolls.
    private static let narrowest: CGFloat = 84

    var body: some View {
        let hosts = fleet.hosts
        HStack(spacing: Theme.grid / 2) {
            GeometryReader { proxy in
                let available = proxy.size.width
                // Every tab named, as wide as each other, while every name fits its share
                // (`SharedRow`); else the Mac shown named and the others an icon.
                ViewThatFits(in: .horizontal) {
                    SharedRow(spacing: Self.spacing, reserve: roomForFolderButton(hosts)) {
                        tabs(hosts, widths: Array(repeating: SharedRow.share(of: available, count: hosts.count, spacing: Self.spacing), count: hosts.count), named: true)
                    }
                    compact(hosts, available: available)
                }
            }
            .frame(height: Self.height)

            if let host = shown.flatMap(fleet.model(for:)), host.offersFolders {
                addFolder(on: host)
            }
        }
        .padding(.vertical, Theme.grid)
        .animation(.smooth(duration: 0.25), value: shown)
        .onChange(of: isDragging) { _, now in
            guard !now, dragging != nil else { return }
            withAnimation(.smooth(duration: 0.2)) {
                dragging = nil
                dragX = 0
            }
        }
    }

    /// The row with the Mac shown named across the rest of it, and the others their icon;
    /// scrolling once even that is too wide.
    @ViewBuilder
    private func compact(_ hosts: [HostModel], available: CGFloat) -> some View {
        let others = CGFloat(hosts.count - 1) * (Self.iconWidth + Self.spacing)
        let widths = hosts.map { $0.id == shown ? max(available - others, Self.narrowest) : Self.iconWidth }
        let total = widths.reduce(0, +) + Self.spacing * CGFloat(max(hosts.count - 1, 0))
        // A plain row while they fit; only once they are too many does it scroll.
        if total <= available + 0.5 {
            HStack(spacing: Self.spacing) { tabs(hosts, widths: widths, named: false) }
        } else {
            // The tab of the Mac shown is brought into sight as it changes from
            // elsewhere, as the chat's tabs are: a swipe across the spaces, the
            // keys, Show in Its Folder. It stayed out of sight past the row's end.
            ScrollViewReader { scroller in
                ScrollView(.horizontal) {
                    HStack(spacing: Self.spacing) { tabs(hosts, widths: widths, named: false) }
                }
                .scrollIndicators(.hidden)
                .scrollEdgeEffectHidden(true, for: .all)
                .onChange(of: shown, initial: true) {
                    guard let shown else { return }
                    withAnimation(.smooth(duration: 0.25)) { scroller.scrollTo(shown) }
                }
            }
        }
    }

    /// The Macs' tabs, `widths` wide: each named, or only the one shown. Named, the row
    /// (`SharedRow`) gives them their width.
    private func tabs(_ hosts: [HostModel], widths: [CGFloat], named: Bool) -> some View {
        let dragged = dragging.flatMap { id in hosts.firstIndex { $0.id == id } }
        let target = dragged.map { landing(of: $0, widths: widths) }
        return ForEach(Array(hosts.enumerated()), id: \.element.id) { index, host in
            MacTab(
                host: host, isShown: host.id == shown, showsName: named || host.id == shown, selection: selection,
                siblings: hosts.map(\.id), fleet: fleet, onDeskSessions: onDeskSessions
            )
            .frame(width: named ? nil : widths[index])
            // What the row is scrolled to, once it scrolls.
            .id(host.id)
            .offset(x: offset(of: index, dragged: dragged, target: target, widths: widths))
            .animation(index == dragged ? nil : .smooth(duration: 0.18), value: target ?? -1)
            .zIndex(index == dragged ? 1 : 0)
            .simultaneousGesture(hosts.count > 1 ? reorder(host.id, from: index, among: hosts, widths: widths) : nil)
        }
    }

    /// The room the add-folder button takes on another Mac's space when it is not on this
    /// one's: kept in the reckoning of whether the names fit, so that swiping across the
    /// spaces does not turn the names on and off.
    private func roomForFolderButton(_ hosts: [HostModel]) -> CGFloat {
        let isShowing = shown.flatMap(fleet.model(for:))?.offersFolders == true
        return !isShowing && hosts.contains(where: \.offersFolders) ? Self.height + Theme.grid / 2 : 0
    }

    /// Adds a folder on the Mac shown: chosen first, then the agent of its first thread,
    /// asked from here.
    private func addFolder(on host: HostModel) -> some View {
        Button { onAddFolder(host.id) } label: {
            Image(systemName: "folder.badge.plus")
                .font(.app.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: Self.height, height: Self.height)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .tip("Add a folder on \(host.host.name)")
        .accessibilityLabel("Add a folder on \(host.host.name)")
        .accessibilityIdentifier("new-project")
    }

    // MARK: Moving a Mac

    /// A tab dragged sideways follows the pointer or the finger, the others sliding to
    /// make room where it would land; let go, its Mac goes there. Measured in the window's
    /// space, as the chat's tabs are: in the tab's own, which moves with it, the pointer's
    /// way seemed shorter by however far the tab had moved, and the tab shook behind it.
    private func reorder(_ id: HostID, from index: Int, among hosts: [HostModel], widths: [CGFloat]) -> some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .updating($isDragging) { _, isDragging, _ in isDragging = true }
            .onChanged { value in
                if dragging == nil { dragging = id }
                dragX = value.translation.width
            }
            .onEnded { value in
                dragX = value.translation.width
                let target = landing(of: index, widths: widths)
                let ids = hosts.map(\.id)
                withAnimation(.smooth(duration: 0.2)) {
                    if target > index {
                        fleet.moveHost(id, before: ids.indices.contains(target + 1) ? ids[target + 1] : nil)
                    } else if target < index {
                        fleet.moveHost(id, before: ids[target])
                    }
                    dragging = nil
                    dragX = 0
                }
            }
    }

    /// Where the dragged tab would land: past every tab whose middle its edge crossed, its
    /// trailing edge going right and its leading edge going left. The tabs are `widths` wide:
    /// all alike while named, the one shown wider than the others' icons.
    private func landing(of dragged: Int, widths: [CGFloat]) -> Int {
        let leadings = Self.leadings(of: widths)
        let start = leadings[dragged] + dragX, end = start + widths[dragged]
        var target = dragged
        if dragX > 0 {
            for index in dragged + 1 ..< widths.count where end > leadings[index] + widths[index] / 2 { target = index }
        } else {
            for index in (0 ..< dragged).reversed() where start < leadings[index] + widths[index] / 2 { target = index }
        }
        return target
    }

    /// The others slide by the dragged tab's width to make room where it would land.
    private func offset(of index: Int, dragged: Int?, target: Int?, widths: [CGFloat]) -> CGFloat {
        guard let dragged, let target else { return 0 }
        if index == dragged { return dragX }
        let room = widths[dragged] + Self.spacing
        if dragged < index, index <= target { return -room }
        if target <= index, index < dragged { return room }
        return 0
    }

    /// Where each tab of `widths` begins along the row.
    private static func leadings(of widths: [CGFloat]) -> [CGFloat] {
        var leadings: [CGFloat] = []
        var x: CGFloat = 0
        for width in widths {
            leadings.append(x)
            x += width + spacing
        }
        return leadings
    }
}

/// The Macs' tabs named, all as wide as each other across the row. Its ideal width is its
/// widest tab's times their number, and `reserve` more: `ViewThatFits` takes it only while
/// every name fits its share, with the room the add-folder button may take kept.
private struct SharedRow: Layout {
    var spacing: CGFloat
    var reserve: CGFloat

    /// Each tab's width in a row `width` wide.
    static func share(of width: CGFloat, count: Int, spacing: CGFloat) -> CGFloat {
        let count = CGFloat(max(count, 1))
        return max((width - spacing * (count - 1)) / count, 0)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let height = proposal.height ?? subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        if let width = proposal.width { return CGSize(width: width, height: height) }
        let widest = subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0
        let count = CGFloat(subviews.count)
        return CGSize(width: widest * count + spacing * max(count - 1, 0) + reserve, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let share = Self.share(of: bounds.width, count: subviews.count, spacing: spacing)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: bounds.minX + CGFloat(index) * (share + spacing), y: bounds.midY), anchor: .leading,
                proposal: ProposedViewSize(width: share, height: bounds.height)
            )
        }
    }
}

/// One Mac's tab: its kind, its name and, while it is not connected, its connection's dot
/// (connected, the dot would only take the room its name needs: "Mac mini" read "Mac…"
/// on a 360-point sidebar, 2026-10-24, or Retry once the app has stopped trying;
/// filled while its space shows. Without its name (`showsName`) it is its kind alone, with
/// the dot whenever it is not connected (Retry is in its menu then); its name is still its
/// accessibility label, its pointer's tip and its menu's title. Its menu says how the
/// connection is doing, and offers Retry, the coding agents' sessions from the desk, and its
/// place among the Macs.
private struct MacTab: View {
    let host: HostModel
    let isShown: Bool
    let showsName: Bool
    let selection: Namespace.ID
    let siblings: [HostID]
    let fleet: Fleet
    let onDeskSessions: (Agent) -> Void

    @State private var isHovered = false

    var body: some View {
        // Retry on the tab while it is named; an icon alone has its dot, and Retry in its menu.
        let offersRetry = host.connectionIsStopped && showsName
        Button {
            withAnimation(.smooth(duration: 0.3)) { fleet.showSpace(host.id) }
        } label: {
            HStack(spacing: showsName ? 5 : 3) {
                Image(systemName: host.host.macSymbol)
                    .font(.system(size: 11, weight: .medium))
                    .accessibilityHidden(true)
                if showsName {
                    // As wide as when shown, whichever tab is: whether the names fit the row
                    // (`MacTabs`) does not change as the spaces are swiped across.
                    Text(host.host.name)
                        .font(.app.footnote.weight(.semibold))
                        .lineLimit(1)
                        .hidden()
                        .overlay {
                            Text(host.host.name)
                                .font(.app.footnote.weight(isShown ? .semibold : .regular))
                                .lineLimit(1)
                        }
                }
                if !offersRetry, host.status != .connected {
                    HostStatusDot(status: host.status)
                }
            }
            .foregroundStyle(isShown ? Color.primary : Color.secondary)
            .padding(.horizontal, showsName ? Theme.grid : 0)
            // Room for Retry, over the tab's end.
            .padding(.trailing, offersRetry ? Self.retryWidth : 0)
            .frame(maxWidth: .infinity, minHeight: MacTabs.height, maxHeight: MacTabs.height)
            .background {
                if isShown {
                    Capsule()
                        .fill(Color.primary.opacity(0.14))
                        .matchedGeometryEffect(id: "shown-mac", in: selection)
                } else {
                    TabCapsule(isHovered: isHovered)
                }
            }
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(host.host.name)
        .accessibilityValue(host.statusText)
        .accessibilityAddTraits(isShown ? .isSelected : [])
        .accessibilityIdentifier("mac-tab-\(host.id.rawValue)")
        .overlay(alignment: .trailing) {
            if offersRetry {
                Button("Retry", systemImage: "arrow.clockwise") { Task { await host.start() } }
                    .labelStyle(.iconOnly)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.orange)
                    .frame(width: Self.retryWidth, height: MacTabs.height)
                    .contentShape(.rect)
                    .buttonStyle(.plain)
                    .padding(.trailing, 2)
                    .tip("Retry")
                    .accessibilityIdentifier("mac-tab-retry-\(host.id.rawValue)")
            }
        }
        .onHover { isHovered = $0 }
        .tip("\(host.host.name): \(host.statusText)")
        .contextMenu { menu }
    }

    private static let retryWidth: CGFloat = 22

    @ViewBuilder
    private var menu: some View {
        // Its name too: a tab may show its icon alone.
        Section("\(host.host.name): \(host.statusText)") {
            if host.connectionIsStopped {
                Button("Retry", systemImage: "arrow.clockwise") { Task { await host.start() } }
            }
        }
        // Sessions started in a terminal on the host, for its coding agents.
        let desk = host.agents.filter { fleet.offersDeskSessions(for: $0.id) && fleet.choosesFolder(for: $0.id) }
        if !desk.isEmpty {
            Menu("From Terminal", systemImage: "terminal") {
                ForEach(desk) { agent in
                    Button(agent.displayName) { onDeskSessions(agent) }
                        .accessibilityIdentifier("desk-sessions-\(agent.id.name)")
                }
            }
        }
        // Its place among the Macs, one along the row, as a folder's is one up or down
        // (`SidebarMove`).
        if siblings.count > 1 {
            Divider()
            if let made = SidebarMove.up.step(of: host.id, among: siblings) {
                Button("Move Left", systemImage: "arrow.left") {
                    withAnimation(.smooth(duration: 0.25)) { fleet.moveHost(made.moved, before: made.before) }
                }
            }
            if let made = SidebarMove.down.step(of: host.id, among: siblings) {
                Button("Move Right", systemImage: "arrow.right") {
                    withAnimation(.smooth(duration: 0.25)) { fleet.moveHost(made.moved, before: made.before) }
                }
            }
        }
    }
}

extension HostConfig {
    /// What kind of computer it is: a Linux computer as it says, else what kind of Mac,
    /// as far as its name says: a Mac mini, a Mac Studio, an iMac, or else a laptop. On
    /// its tab over the sidebar's space, and on the Mac chip of a new thread
    /// (`NewThreadPickers`).
    var macSymbol: String {
        if isLinux { return "pc" }
        let name = name.lowercased()
        if name.contains("mini") { return "macmini" }
        if name.contains("studio") { return "macstudio" }
        if name.contains("imac") { return "desktopcomputer" }
        return "laptopcomputer"
    }
}
