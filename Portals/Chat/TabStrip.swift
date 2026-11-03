import AgentCore
import SwiftUI
import UIKit

/// The open threads as tabs over the chat, in place of the header a phone has: on a Mac
/// up in the window's bar, beside its buttons, and on an iPad beside the sidebar, under
/// the status bar (2026-10-23). Like Safari's and Ghostty's: the tabs share the
/// bar's width, the one on screen as wide as its whole title, each with its agent's logo
/// or a bot's avatar and, where the bar is tight, no title (`TabStrip.layout`); at its leading edge what its thread is doing, as the sidebar marks
/// it, and the close button in its place under the pointer, or on an iPad always; on a
/// Mac, at its trailing end, the key that goes to it, ⌘1 to ⌘9, always, as Ghostty's tabs have (2026-10-26:
/// "it should just show by default like in ghostty"). A new thread not yet sent
/// is a dashed tab at the end until its first message makes it a tab (`Fleet.tabs`); +,
/// at the bar's far end, starts one at once as ⌘T does, its secondary click or long press
/// one in a folder of the Mac on screen, or a bot's (`NewTabButton`). The sidebar's
/// button, the chat header's own (`HeaderButton`), leads the bar, the sidebar out or not,
/// as it led the window's bar and the header before the tabs (2026-10-24).
struct TabBar: View {
    let fleet: Fleet
    /// On a Mac, the chat reaches the window's leading edge, where the window's own
    /// buttons are (the sidebar hidden, or behind the chat): the sidebar's button keeps
    /// clear of them.
    let clearsWindowButtons: Bool
    /// A reply's image is open over the whole window (`ImageLightbox`): the bar is under
    /// it, takes no clicks, and leaves the window movable.
    var isCovered = false
    var onToggleSidebar: () -> Void
    /// A new thread with a bot, from +, as the sidebar starts one.
    var onNewThread: (Agent) -> Void
    var onEditLook: (Agent) -> Void
    /// Show in Its Folder, from a tab's menu.
    var onShowInFolder: (ThreadKey) -> Void

    /// A tab's height: the sidebar's button's, beside it (2026-10-25: "make the
    /// tabs as tall as the sidebar button so that is consistent", on an iPad too), which
    /// on a Mac fits the window's bar.
    static let tabHeight: CGFloat = sidebarButton
    /// The room at the bar's ends.
    static let inset: CGFloat = Theme.grid
    /// The room above the tabs. On a Mac the bar's middle stays where it was with tabs of
    /// 26, level with the window's own buttons, as the tabs grew to the sidebar button's 32.
    /// On an iPad the tabs sit just under the status bar, as the sidebar's search row does
    /// (2026-10-31: "there should be minimal padding at the top"; a grid before).
    static let top: CGFloat = Platform.isMac ? inset - (tabHeight - 26) / 2 : Theme.grid / 4
    /// The room the window's own buttons take at a Mac window's leading end, which the
    /// sidebar's button keeps clear of.
    private static let windowButtons: CGFloat = 70
    /// The sidebar's button: as tall as fits a Mac window's bar, and as tall on an iPad
    /// (2026-10-31: "i think the tabs are way too big on ipad", "cant we just make
    /// it consistent with the mac build?"; a phone header's 44 before).
    static let sidebarButton: CGFloat = 32

    @Environment(\.swipeGuard) private var swipeGuard

    /// How much of the top the bar takes over the chat. On a Mac the window's bar
    /// (`WindowLayout.windowBar`) as before, the tabs up in it: the chat's fade and blur
    /// under it stay as the user tuned them (`ChatScreen.TopFade`).
    static var height: CGFloat {
        Platform.isMac ? WindowLayout.windowBar : top + tabHeight + inset / 2
    }

    var body: some View {
        HStack(spacing: Theme.grid) {
            if Platform.isMac, clearsWindowButtons {
                Color.clear
                    .frame(width: Self.windowButtons, height: 1)
                    .accessibilityHidden(true)
            }
            HeaderButton(title: "Agents and threads", systemImage: "sidebar.leading", side: Self.sidebarButton) {
                swipeGuard(onToggleSidebar)
            }
            .keyboardShortcut("s", modifiers: [.control, .command])
            // Under a reply's image, nothing of the bar answers, its key neither.
            .disabled(isCovered)
            .tip("Show or Hide Sidebar (⌘S)")
            .accessibilityIdentifier("open-sidebar")
            TabStrip(slots: slots, isCovered: isCovered, fleet: fleet, onEditLook: onEditLook, onShowInFolder: onShowInFolder)
            NewTabButton(fleet: fleet, onNewThread: onNewThread)
        }
        // As tall as a tab, the buttons as tall.
        .frame(height: Self.tabHeight)
        .padding(.horizontal, Self.inset)
        .padding(.top, Self.top)
        .frame(height: Self.height, alignment: .top)
        .opacity(isCovered ? 0 : 1)
        .allowsHitTesting(!isCovered)
    }

    /// The tabs as they show, in their order, then a new thread kept with what was typed
    /// in it (`Fleet.draftTab`), then a new thread on screen. A tab whose thread is not
    /// listed (its host's list not read yet) is left out until it is.
    private var slots: [TabSlot] {
        Self.slots(of: fleet)
    }

    fileprivate static func slots(of fleet: Fleet) -> [TabSlot] {
        let shown = fleet.chat
        let shownKey = shown?.thread?.key
        var slots: [TabSlot] = fleet.tabs.keys.compactMap { key in
            guard let host = fleet.model(for: key.host), let record = host.record(for: key.id) else { return nil }
            let isSelected = key == shownKey
            return TabSlot(
                key: key, title: record.displayTitle, style: host.style(for: record.ref.agent),
                activity: host.activity(of: key.id), isUnseen: record.isUnseen && !isSelected,
                isSelected: isSelected, agent: record.ref.agent, isBot: fleet.isBot(record.ref.agent),
                shortcut: fleet.tabs.shortcut(of: key), isTucked: fleet.isTucked(record)
            )
        }
        if let kept = fleet.draftTab, kept !== shown, !kept.isClosed, let host = fleet.model(of: kept) {
            slots.append(TabSlot(
                key: nil, title: TabSlot.title(ofDraft: kept.composer.text), style: host.style(for: kept.agent.id),
                isSelected: false, agent: kept.agent.id, isKeptDraft: true
            ))
        }
        if let shown, shown.thread == nil, let host = fleet.model(of: shown) {
            slots.append(TabSlot(
                key: nil, title: TabSlot.newThreadTitle, style: host.style(for: shown.agent.id),
                isSelected: true, agent: shown.agent.id
            ))
        }
        return slots
    }
}

/// The tabs down the column beside the chat, where a status bar at the side leaves one: an
/// iPhone Duo open and wide (2026-11-03: "put the tabs vertically on the right side bar").
/// Each its logo and what its thread is doing, as a tab with no room for a title is; closed
/// from its menu. + ends it; the sidebar's button is at the other side of the chat, on the
/// sidebar's side (`SidebarButtonOverChat`).
struct TabRail: View {
    let fleet: Fleet
    let isCovered: Bool
    var onNewThread: (Agent) -> Void
    var onEditLook: (Agent) -> Void
    var onShowInFolder: (ThreadKey) -> Void

    /// The least column it needs, with a little room each side of a tab.
    static let leastColumn: CGFloat = TabChip.compactWidth + Theme.grid
    /// How far down the column the status bar and camera reach, on an iPhone Duo.
    static let statusBar: CGFloat = 124
    /// How far the tabs fade out at each end of the column, once they scroll.
    private static let fade: CGFloat = Theme.grid

    @State private var dragNote = TabDragNote()

    var body: some View {
        let slots = TabBar.slots(of: fleet)
        VStack(spacing: Theme.grid) {
            ScrollViewReader { scroller in
                ScrollView(.vertical) {
                    // Lazily: a tab's edge says what its thread is doing in a tree of animated
                    // layers (`TabStatusFill`), for the ones past the column's end too.
                    LazyVStack(spacing: 6) {
                        ForEach(slots) { slot in
                            chip(slot)
                                .frame(width: TabChip.compactWidth)
                                .id(slot.id)
                                .transition(.opacity.combined(with: .scale(scale: 0.92)))
                        }
                    }
                    .padding(.vertical, Self.fade)
                }
                .scrollIndicators(.hidden)
                .scrollBounceBehavior(.basedOnSize, axes: .vertical)
                .scrollEdgeEffectHidden(true, for: .all)
                .scrollClipDisabled()
                .onChange(of: slots.first(where: \.isSelected)?.id, initial: true) { _, selected in
                    if let selected { scroller.scrollTo(selected) }
                }
                .mask {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: Self.fade)
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: Self.fade)
                    }
                    // The edge and shadow of the tab on screen's glass are the tab's.
                    .padding(.horizontal, -Theme.grid)
                }
            }
            NewTabButton(fleet: fleet, onNewThread: onNewThread)
        }
        .animation(.settling(.smooth(duration: 0.25)), value: slots.map(\.id))
        .opacity(isCovered ? 0 : 1)
        .allowsHitTesting(!isCovered)
    }

    @ViewBuilder
    private func chip(_ slot: TabSlot) -> some View {
        if let key = slot.key {
            TabChip(slot: slot, key: key, showsTitle: false, fleet: fleet, dragNote: dragNote, onEditLook: onEditLook, onShowInFolder: onShowInFolder)
                .equatable()
        } else {
            DraftChip(slot: slot, showsTitle: false, fleet: fleet)
        }
    }
}

/// The sidebar's button where the tabs are down the side (`TabRail`): over the chat at its
/// leading end, on the sidebar's side of the screen (2026-11-03: "why on horizontal unfolded is
/// the sidebar toggle on the right?"), level with the chat's name (`ChatScreen.barRow`).
struct SidebarButtonOverChat: View {
    let isCovered: Bool
    var onToggle: () -> Void

    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        HeaderButton(title: "Agents and threads", systemImage: "sidebar.leading", side: TabBar.sidebarButton) {
            swipeGuard(onToggle)
        }
        .keyboardShortcut("s", modifiers: [.control, .command])
        .disabled(isCovered)
        .tip("Show or Hide Sidebar (⌘S)")
        .accessibilityIdentifier("open-sidebar")
        .padding(.top, ThreadPanel.top)
        .padding(.leading, TabBar.inset)
        .opacity(isCovered ? 0 : 1)
        .allowsHitTesting(!isCovered)
    }
}

/// Whether a tab is being dragged along the row (`TabStrip.reorder`), for its button: the
/// press that ends a drag is not also a click. Its end is noted a moment late, as the
/// button may hear the release after the drag does.
@MainActor
final class TabDragNote {
    var isDragging = false

    func endSoon() {
        guard isDragging else { return }
        DispatchQueue.main.async { self.isDragging = false }
    }
}

/// What a tab shows: a thread's, or (no `key`) a new thread's not yet sent: the one on
/// screen, or the one kept with what was typed in it (`isKeptDraft`).
struct TabSlot: Identifiable, Equatable {
    enum ID: Hashable {
        case thread(ThreadKey)
        case keptDraft
        case newThread
    }

    let key: ThreadKey?
    let title: String
    let style: AgentAvatarStyle
    var activity: HostModel.Activity = .idle
    var isUnseen = false
    let isSelected: Bool
    let agent: Agent.ID
    var isBot = false
    /// The ⌘ key's number that goes to the tab, 1 to 9 (`OpenTabs.shortcut(of:)`).
    var shortcut: Int?
    /// A thread an agent started, under the thread that started it and in no folder of the
    /// sidebar (`Fleet.isTucked`): its menu takes it over rather than showing its folder.
    var isTucked = false
    var isKeptDraft = false

    var id: ID {
        if let key { .thread(key) } else if isKeptDraft { .keptDraft } else { .newThread }
    }

    /// What a tab says under the pointer: its title, and the key that goes to it.
    var tip: String {
        shortcut.map { "\(title) (⌘\($0))" } ?? title
    }

    static let newThreadTitle = "New thread"

    /// A kept new thread's title: the first line of what was typed in it, or else what a
    /// new thread is called (only images or files attached).
    static func title(ofDraft text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).lazy
            .map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
        return line.map { String($0.prefix(60)) } ?? newThreadTitle
    }
}

/// The tabs in a row. A plain row, not a scroll view, while they fit: a scroll view in a
/// Mac window's bar gets the system's blur at its edge, which greyed the tabs; only once
/// they are too many for the bar, with half of it kept for the title on screen, is the
/// row a scroll view, with no such edge and with soft ones of its own (`ScrollEdgeFade`).
/// Which of the two it is goes by how many tabs there are and how wide the bar is alone
/// (`TabStrip.layout`): going from one to the other builds every tab anew.
private struct TabStrip: View {
    let slots: [TabSlot]
    let isCovered: Bool
    let fleet: Fleet
    let onEditLook: (Agent) -> Void
    let onShowInFolder: (ThreadKey) -> Void

    /// The tab being dragged along the row, and how far.
    @State private var dragging: ThreadKey?
    @State private var dragX: CGFloat = 0
    /// Whether a drag is under way, which the system sets back however the drag ends: a
    /// drag called off (no `onEnded`) leaves no tab out of its place, and the window
    /// movable again.
    @GestureState private var isDragging = false
    /// The tab a finger has held until it lifted (`liftThenReorder`), which the system sets
    /// back in the same way: the row stands still under it, and it settles as it is let go
    /// or as its menu takes over.
    @GestureState private var lifted: ThreadKey?
    /// The tabs under the pointer: while any is, a drag in the window's bar is the tab's.
    @State private var hovered: Set<ThreadKey> = []
    /// Whether a tab is being dragged, as its button hears it: let go, the drag is not
    /// also a click showing the tab. Not observed.
    @State private var dragNote = TabDragNote()
    /// Whether the row, once it scrolls, is being scrolled, or gliding.
    @State private var scrollPhase: ScrollPhase = .idle
    /// Whether a finger or the pointer left the row with the tab on screen not all in sight,
    /// and nothing has brought it back since. Not observed.
    @State private var scrolledFromSelected = false

    private static let spacing: CGFloat = 6
    /// The narrowest a tab with a title gets: a few letters between its ends. On a Mac,
    /// with its key at the far end, wider for the same letters.
    private static let narrowest: CGFloat = Platform.isMac ? 120 : 104
    /// The most of the bar the tab on screen takes for its title once the others have none.
    private static let widestShare: CGFloat = 0.5
    /// How long a finger holds a tab before it lifts and can be moved (2026-11-02:
    /// "how can we differentiate between reordering a tab and moving the slider"): a drag
    /// sooner scrolls the row, and its menu comes later.
    private static let liftAfter: TimeInterval = 0.25
    /// How much a lifted tab grows.
    private static let liftedScale: CGFloat = 1.06
    /// How the tabs move as one is shown, opened or closed. Over once nothing moves by a
    /// pixel any more: SwiftUI's own spring went on 0.2 s longer, every frame of it as
    /// costly as one of the motion (`Animation.settling`).
    private static let motion = Animation.settling(.smooth(duration: 0.25))

    var body: some View {
        GeometryReader { proxy in
            let bar = proxy.size.width
            let layout = Self.layout(for: slots, in: bar)
            Group {
                if layout.fits {
                    row(layout)
                } else {
                    // The tab on screen is brought into sight as it changes: opened from
                    // the sidebar, a new one at the end, or gone to with the keys.
                    ScrollViewReader { scroller in
                        ScrollView(.horizontal) { row(layout) }
                            .scrollIndicators(.hidden)
                            .scrollEdgeEffectHidden(true, for: .all)
                            // A row that is no wider than the bar stays put.
                            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                            // What shows of the row is its mask's (`ScrollEdgeFade`), which
                            // leaves the tab on screen the edge and shadow of its glass.
                            .scrollClipDisabled()
                            // Under a lifted tab the finger moves the tab alone.
                            .scrollDisabled(lifted != nil)
                            .onChange(of: selected?.id, initial: true) { showSelected(scroller) }
                            // And as the window is resized, at once.
                            .onChange(of: proxy.size.width) {
                                scrolledFromSelected = false
                                if let selected { scroller.scrollTo(TabInSight(id: selected.id)) }
                            }
                            // And as the sidebar's slide narrows the bar: the bar has its width as
                            // the slide starts and the scroll view comes down to it through the
                            // slide, so the scroll above finds the tab in sight, and it stayed past
                            // + (seen 2026-11-02 at 16 tabs on an iPad). So the row goes to it as it
                            // leaves sight, and as the slide lands, whose last points a scroll under
                            // way can miss. Scrolling and a window's edge dragged leave the scroll
                            // view as wide as the bar: for them this measures nothing and does nothing.
                            .onScrollGeometryChange(for: Bool?.self) { geometry in
                                geometry.containerSize.width > bar + 0.5 ? showsSelected(layout, in: geometry) : nil
                            } action: { old, inSight in
                                if inSight == false || (old != nil && inSight == nil), mayFollowSelected { showSelected(scroller) }
                            }
                            // And once the tabs have moved, as the tab on screen is shown or
                            // named: while they move the row scrolls no further than it could
                            // before, none at all for a long title's outgrowing a bar it fitted
                            // (seen 2026-11-02, the last tab left past +). Not under a finger
                            // or the pointer, nor when they left it away from that tab: its
                            // being named does not pull the row back from under the pointer.
                            .task(id: selectedInRow(layout)) {
                                try? await Task.sleep(for: .milliseconds(300))
                                guard !Task.isCancelled, mayFollowSelected else { return }
                                showSelected(scroller)
                            }
                            // A tab gone from the row's end (closed, or a new thread's as a
                            // thread is opened) left the row scrolled past its end, a gap
                            // before + (seen 2026-10-31 on an iPad simulator): it goes back to
                            // its end. Not while a finger or the pointer bounces it there.
                            .onScrollPhaseChange { old, phase, context in
                                scrollPhase = phase
                                if phase == .idle, old == .interacting || old == .decelerating {
                                    scrolledFromSelected = !showsSelected(layout, in: context.geometry)
                                }
                            }
                            .onScrollGeometryChange(for: Bool.self) { geometry in
                                geometry.contentOffset.x > geometry.contentSize.width - geometry.containerSize.width + 1
                            } action: { _, isPast in
                                guard isPast, scrollPhase == .idle, let last = slots.last else { return }
                                withAnimation(Self.motion) { scroller.scrollTo(last.id, anchor: .trailing) }
                            }
                            // Last: the scroll view's modifiers above do not reach it from
                            // outside the mask.
                            .modifier(ScrollEdgeFade())
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .leading)
            // Every tab is built anew here, and says nothing of the pointer until it next
            // moves: the old ones' hovering is not heard to end, and would hold the window
            // still with the pointer gone.
            .onChange(of: layout.fits) { hovered.removeAll() }
        }
        .frame(height: TabBar.tabHeight)
        .animation(Self.motion, value: slots.map(\.id))
        .animation(DebugLaunch.tabsMoveAtOnce ? nil : Self.motion, value: slots.first(where: \.isSelected)?.id)
        // A tab closed under the pointer, or while it was dragged, says nothing more.
        .onChange(of: slots.map(\.id)) {
            let present = Set(slots.compactMap(\.key))
            hovered.formIntersection(present)
            if let dragging, !present.contains(dragging) {
                self.dragging = nil
                dragX = 0
            }
        }
        .onChange(of: isDragging) { _, now in
            if !now { dragNote.endSoon() }
            guard !now, dragging != nil else { return }
            withAnimation(.smooth(duration: 0.2)) {
                dragging = nil
                dragX = 0
            }
        }
        .sensoryFeedback(.impact(weight: .medium), trigger: lifted) { _, new in new != nil }
        .onChange(of: isMovable, initial: true) { _, movable in WindowMover.setMovable(movable) }
        .onDisappear { WindowMover.setMovable(true) }
    }

    /// The tab on screen, or a new thread's.
    private var selected: TabSlot? {
        slots.first(where: \.isSelected)
    }

    /// Which tab is on screen, and how wide it comes out.
    private func selectedInRow(_ layout: TabLayout) -> SelectedInRow? {
        guard let index = slots.firstIndex(where: \.isSelected) else { return nil }
        return SelectedInRow(id: slots[index].id, width: layout.widths[index])
    }

    /// Whether all of the tab on screen is in the part of the row that shows.
    private func showsSelected(_ layout: TabLayout, in geometry: ScrollGeometry) -> Bool {
        guard let index = slots.firstIndex(where: \.isSelected) else { return true }
        let start = layout.widths[..<index].reduce(0, +) + CGFloat(index) * Self.spacing
        return start >= geometry.visibleRect.minX - 1 && start + layout.widths[index] <= geometry.visibleRect.maxX + 1
    }

    /// Whether the row may go to the tab on screen unasked: not under a finger or the pointer,
    /// nor when they left it away from that tab.
    private var mayFollowSelected: Bool {
        !scrolledFromSelected && (scrollPhase == .idle || scrollPhase == .animating)
    }

    /// Brings the tab on screen into sight in a row that scrolls.
    private func showSelected(_ scroller: ScrollViewProxy) {
        guard let selected else { return }
        scrolledFromSelected = false
        if DebugLaunch.tabsMoveAtOnce {
            scroller.scrollTo(TabInSight(id: selected.id))
        } else {
            withAnimation(Self.motion) { scroller.scrollTo(TabInSight(id: selected.id)) }
        }
    }

    /// Whether a drag in the window's bar moves the window: not while the pointer is on
    /// a tab, or a tab is dragged.
    private var isMovable: Bool {
        isCovered || (hovered.isEmpty && dragging == nil)
    }

    private func row(_ layout: TabLayout) -> some View {
        let widths = layout.widths
        let dragged = dragging.flatMap { key in slots.firstIndex { $0.key == key } }
        let target = dragged.map { landing(of: $0, widths: widths) }
        return HStack(spacing: Self.spacing) {
            ForEach(Array(slots.enumerated()), id: \.element.id) { index, slot in
                let isLifted = lifted != nil && lifted == slot.key
                chip(slot, at: index, showsTitle: layout.showsTitle[index], widths: widths)
                    .frame(width: widths[index])
                    // What the row is scrolled to, once it scrolls.
                    .id(slot.id)
                    .background {
                        Color.clear
                            .id(TabInSight(id: slot.id))
                            .padding(.horizontal, -ScrollEdgeFade.length)
                    }
                    .scaleEffect(isLifted ? Self.liftedScale : 1)
                    .animation(.smooth(duration: 0.18), value: isLifted)
                    .offset(x: offset(of: index, dragged: dragged, target: target, widths: widths))
                    .animation(index == dragged ? nil : .smooth(duration: 0.18), value: target ?? -1)
                    .zIndex(index == dragged || isLifted ? 1 : 0)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
    }

    @ViewBuilder
    private func chip(_ slot: TabSlot, at index: Int, showsTitle: Bool, widths: [CGFloat]) -> some View {
        if let key = slot.key {
            TabChip(slot: slot, key: key, showsTitle: showsTitle, fleet: fleet, dragNote: dragNote, onEditLook: onEditLook, onShowInFolder: onShowInFolder)
                .equatable()
                .onHover { inside in
                    if inside { hovered.insert(key) } else { hovered.remove(key) }
                }
                // By the pointer at once, as a Mac's; on an iPad a pointer is over a tab (`hovered`)
                // and a finger never is.
                .simultaneousGesture(reorder(key, from: index, widths: widths), including: movesAtOnce(key) ? .all : .subviews)
                .simultaneousGesture(liftThenReorder(key, from: index, widths: widths), including: movesAtOnce(key) ? .subviews : .all)
        } else {
            DraftChip(slot: slot, showsTitle: showsTitle, fleet: fleet)
        }
    }

    // MARK: Moving a tab

    /// A tab dragged sideways follows the pointer, the others sliding to make room where
    /// it would land; let go, it stays there. Safari's way. Measured in the window's space:
    /// in the tab's own, which moves with it, the pointer's way seemed shorter by however
    /// far the tab had moved, and the tab shook about half way behind the pointer
    /// (2026-10-25: "dragging a tab around at the top feels pretty bad").
    private func reorder(_ key: ThreadKey, from index: Int, widths: [CGFloat]) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .global)
            .updating($isDragging) { _, isDragging, _ in isDragging = true }
            .onChanged { dragged(key, by: $0) }
            .onEnded { dropped(key, from: index, widths: widths, at: $0) }
    }

    /// The same under a finger, which moves a tab only once it has held it until it lifts: a
    /// drag taken at once by each tab was a drag the row never got to scroll with. Let go
    /// without moving, it was a slow tap, and the tab's button hears it as one.
    private func liftThenReorder(_ key: ThreadKey, from index: Int, widths: [CGFloat]) -> some Gesture {
        LongPressGesture(minimumDuration: Self.liftAfter)
            .sequenced(before: DragGesture(minimumDistance: 4, coordinateSpace: .global))
            .updating($lifted) { value, lifted, _ in
                if case .second(true, _) = value { lifted = key }
            }
            .updating($isDragging) { value, isDragging, _ in
                if case .second(true, _) = value { isDragging = true }
            }
            .onChanged { value in
                if case .second(true, let drag?) = value { dragged(key, by: drag) }
            }
            .onEnded { value in
                if case .second(true, let drag?) = value { dropped(key, from: index, widths: widths, at: drag) }
            }
    }

    /// Whether a drag on this tab moves it at once, with nothing held first: the pointer's.
    private func movesAtOnce(_ key: ThreadKey) -> Bool {
        Platform.isMac || hovered.contains(key)
    }

    private func dragged(_ key: ThreadKey, by value: DragGesture.Value) {
        if dragging == nil { dragging = key }
        dragNote.isDragging = true
        dragX = value.translation.width
    }

    private func dropped(_ key: ThreadKey, from index: Int, widths: [CGFloat], at value: DragGesture.Value) {
        dragNote.endSoon()
        dragX = value.translation.width
        let target = landing(of: index, widths: widths)
        // The tabs alone, in their order: a new thread's is last, past them.
        let keys = slots.compactMap(\.key)
        withAnimation(.smooth(duration: 0.2)) {
            if target > index {
                fleet.moveTab(key, before: keys.indices.contains(target + 1) ? keys[target + 1] : nil)
            } else if target < index, keys.indices.contains(target) {
                fleet.moveTab(key, before: keys[target])
            }
            dragging = nil
            dragX = 0
        }
    }

    /// Where the dragged tab would land: past every tab whose middle its own middle
    /// passed, and never past the tabs, onto a new thread's.
    private func landing(of dragged: Int, widths: [CGFloat]) -> Int {
        guard widths.indices.contains(dragged) else { return dragged }
        var starts: [CGFloat] = []
        var x: CGFloat = 0
        for width in widths {
            starts.append(x)
            x += width + Self.spacing
        }
        let middle = starts[dragged] + widths[dragged] / 2 + dragX
        var target = dragged
        for index in widths.indices where index != dragged {
            let other = starts[index] + widths[index] / 2
            if index > dragged, middle > other { target = max(target, index) }
            if index < dragged, middle < other { target = min(target, index) }
        }
        let tabs = slots.count { $0.key != nil }
        return min(target, max(tabs - 1, 0))
    }

    private func offset(of index: Int, dragged: Int?, target: Int?, widths: [CGFloat]) -> CGFloat {
        guard let dragged, let target, widths.indices.contains(dragged) else { return 0 }
        if index == dragged { return dragX }
        let room = widths[dragged] + Self.spacing
        if dragged < index, index <= target { return -room }
        if target <= index, index < dragged { return room }
        return 0
    }

    // MARK: Widths

    /// How the tabs share the bar, tightest last (2026-11-01: "if we are really tight
    /// on space we shouldnt even show the text in the thread name"):
    /// - The tab on screen as wide as its whole title (up to most of the bar), the others
    ///   sharing what is left alike, none narrower than `narrowest`.
    /// - No room for that beside its title: the others lose theirs, down to
    ///   `TabChip.compactWidth`. So the title decides how soon the others lose theirs, and
    ///   the tab on screen only ever grows as the bar does.
    /// - Too many even so: the row scrolls.
    /// The tab on screen keeps its title all the way, up to half the bar (2026-11-01:
    /// "for the selected tab when theres overflow it should still show the name"). With none
    /// on screen, none has a title once they are too many.
    ///
    /// The row is a scroll view (`fits`) by how many tabs there are and how wide the bar is,
    /// never by the title on screen, whose tab would otherwise build every tab anew as it is
    /// shown or named: half the bar is held for a title, however short this one's. A short
    /// one leaves the row no wider than the bar, with nothing to scroll.
    private static func layout(for slots: [TabSlot], in total: CGFloat) -> TabLayout {
        guard !slots.isEmpty else { return TabLayout(widths: [], showsTitle: [], fits: true) }
        let gaps = spacing * CGFloat(slots.count - 1)
        let room = max(total - gaps, 0)
        let others = CGFloat(slots.count - 1)
        let fits = others == 0 || max(total * widestShare, narrowest) + others * TabChip.compactWidth <= room + 0.5
        guard let selected = slots.firstIndex(where: \.isSelected) else {
            let equal = room / CGFloat(slots.count)
            let haveTitles = equal >= narrowest
            return TabLayout(
                widths: Array(repeating: haveTitles ? equal : max(equal, TabChip.compactWidth), count: slots.count),
                showsTitle: Array(repeating: haveTitles, count: slots.count),
                fits: fits
            )
        }
        let full = TabChip.fullWidth(of: slots[selected].title)
        guard others > 0 else {
            return TabLayout(widths: [min(full, room)], showsTitle: [true], fits: fits)
        }
        let kept = max(min(full, total * widestShare), narrowest)
        let othersHaveTitles = (room - kept) / others >= narrowest
        let selectedWidth = othersHaveTitles ? min(max(full, room / (others + 1)), room - others * narrowest) : kept
        let otherWidth = max((room - selectedWidth) / others, TabChip.compactWidth)
        return TabLayout(
            widths: slots.indices.map { $0 == selected ? selectedWidth : otherWidth },
            showsTitle: slots.indices.map { $0 == selected || othersHaveTitles },
            fits: fits
        )
    }
}

/// What the row scrolls to to show a tab: the tab and the fade's length each side of it,
/// so that the tab on screen is clear of the row's soft edges (`ScrollEdgeFade`).
private struct TabInSight: Hashable {
    let id: TabSlot.ID
}

/// The tab on screen and its width, for bringing it into sight as either changes.
private struct SelectedInRow: Hashable {
    let id: TabSlot.ID
    let width: CGFloat
}

/// How wide each tab is, whether it has room for its title, and whether the row is a plain
/// one or a scroll view (`TabStrip.layout`).
private struct TabLayout {
    let widths: [CGFloat]
    let showsTitle: [Bool]
    let fits: Bool
}

/// Soft edges on the row once it scrolls (2026-11-01: "the edge around the left and
/// right of the scrollable area is very abrupt"): the tabs fade out towards an edge with
/// more past it, and an edge with none past it stays as it is, the fade coming in over the
/// first points scrolled. Only that stretch of scrolling draws this anew.
private struct ScrollEdgeFade: ViewModifier {
    static let length: CGFloat = 28
    /// How far above and below the row it still shows: the glass of the tab on screen has an
    /// edge just past the row, and a shadow to 10 points below it (measured on an iPad).
    private static let glassRoom: CGFloat = 12

    /// How much each edge is faded, from none to all of it.
    private struct Edges: Equatable {
        var leading: CGFloat = 0
        var trailing: CGFloat = 0
    }

    @State private var edges = Edges()

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: Edges.self) { geometry in
                let past = geometry.contentSize.width - geometry.containerSize.width - geometry.contentOffset.x
                return Edges(
                    leading: min(max(geometry.contentOffset.x, 0) / Self.length, 1),
                    trailing: min(max(past, 0) / Self.length, 1)
                )
            } action: { _, now in edges = now }
            .mask {
                HStack(spacing: 0) {
                    Self.ramp(fading: edges.leading, from: .leading)
                    Rectangle()
                    Self.ramp(fading: edges.trailing, from: .trailing)
                }
                .padding(.vertical, -Self.glassRoom)
            }
    }

    /// From what shows at the edge to all of it, eased so that no line shows where it ends.
    private static func ramp(fading amount: CGFloat, from edge: UnitPoint) -> some View {
        LinearGradient(
            stops: [
                .init(color: .black.opacity(1 - amount), location: 0),
                .init(color: .black.opacity(1 - amount * 0.5), location: 0.45),
                .init(color: .black.opacity(1 - amount * 0.12), location: 0.75),
                .init(color: .black, location: 1),
            ],
            startPoint: edge,
            endPoint: edge == .leading ? .trailing : .leading
        )
        .frame(width: length)
    }
}

/// One thread's tab. Compared by what it shows, not by the fleet and actions it is
/// handed: a tab whose thread did not change is not drawn again as another's does, or
/// as one is dragged along the row.
private struct TabChip: View, Equatable {
    let slot: TabSlot
    let key: ThreadKey
    /// With no room for it, the tab is its logo, what its thread is doing and its key.
    let showsTitle: Bool
    let fleet: Fleet
    let dragNote: TabDragNote
    let onEditLook: (Agent) -> Void
    let onShowInFolder: (ThreadKey) -> Void

    @State private var isHovered = false

    /// What the tab's thread is doing (`TabStatus`).
    private var status: TabStatus {
        TabStatus.forced(shortcut: slot.shortcut) ?? TabStatus(slot.activity, unseen: slot.isUnseen)
    }

    static func == (one: TabChip, other: TabChip) -> Bool {
        one.slot == other.slot && one.key == other.key && one.showsTitle == other.showsTitle && one.fleet === other.fleet && one.dragNote === other.dragNote
    }

    /// Room at each end, for the activity mark or the close button and for the tab's key
    /// (a Mac's), so that the title stays in the middle.
    static let endRoom: CGFloat = Platform.isMac ? 30 : 24
    /// Room at the trailing end: on an iPad, with no key there, a little, the title taking
    /// the rest (2026-10-31, of narrow tabs: "then there can be more space").
    static let trailingRoom: CGFloat = Platform.isMac ? endRoom : Theme.grid
    static let iconSide: CGFloat = Platform.isMac ? 15 : 17
    /// A tab with no title: its logo in the middle, clear of what is at each end.
    static let compactWidth: CGFloat = Platform.isMac ? 72 : 64

    /// The title's type at its widest, the tab on screen's, for working out how wide that
    /// tab is: the app's footnote, as `Text` sets it below.
    static var titleFont: UIFont {
        let size = AppTextStyles.fixedSize(of: .footnote) ?? UIFont.preferredFont(forTextStyle: .footnote).pointSize
        return UIFont.systemFont(ofSize: size, weight: .semibold)
    }

    /// How wide a tab is with its whole title.
    static func fullWidth(of title: String) -> CGFloat {
        let text = (title as NSString).size(withAttributes: [.font: titleFont]).width
        return (endRoom + trailingRoom + iconSide + 6 + text + 4).rounded(.up)
    }

    var body: some View {
        Button {
            // Let go after a drag: the tab moved, and is not shown for it.
            if !slot.isSelected, !dragNote.isDragging { fleet.showTab(key) }
        } label: {
            HStack(spacing: 6) {
                RowAvatar(style: slot.style, side: Self.iconSide)
                if showsTitle {
                    Text(slot.title)
                        .font(.app.footnote.weight(slot.isSelected || slot.isUnseen ? .semibold : .regular))
                        // Not the secondary grey, which sank into the wash (2026-10-24).
                        .foregroundStyle(Color.primary.opacity(slot.isSelected ? 1 : 0.8))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        // Its weight changes at once as the tab is shown or left, while the
                        // tabs move: drawn over the motion as glyphs morphing between the two
                        // weights, the titles took a fifth of a switch's CPU (Time Profiler:
                        // the interpolated text, frame by frame).
                        .modifier(TitleSnaps(snaps: !DebugLaunch.tabTitlesMorph))
                }
            }
            .padding(.leading, showsTitle ? Self.endRoom : 0)
            .padding(.trailing, showsTitle ? Self.trailingRoom : 0)
            .frame(maxWidth: .infinity, minHeight: TabBar.tabHeight, maxHeight: TabBar.tabHeight)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        // On the tab's button alone: its close button keeps its own name.
        .accessibilityLabel(slot.title)
        .accessibilityAddTraits(slot.isSelected ? .isSelected : [])
        .accessibilityIdentifier("tab-\(key.id.rawValue)")
        .accessibilityActions {
            Button("Close Tab") { fleet.closeTab(key) }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .background {
            ZStack {
                if slot.isSelected {
                    Capsule().fill(.clear).glassEffect(.regular, in: .capsule)
                } else {
                    TabCapsule(isHovered: isHovered, overWash: true)
                }
                TabStatusFill(status: status)
            }
        }
        .overlay(alignment: .leading) {
            if isHovered || TabCloseButton.shown(showsTitle: showsTitle) {
                TabCloseButton { fleet.closeTab(key) }
                    .transition(.opacity)
            } else {
                ActivityMark(activity: status.activity, unseen: status == .unseen)
                    .padding(.leading, 6)
                    .allowsHitTesting(false)
                    .animation(.smooth(duration: 0.25), value: slot.activity)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .trailing) {
            // An iPad's tabs have none: most are used without a keyboard.
            if Platform.isMac, let shortcut = slot.shortcut {
                Text("⌘\(shortcut)")
                    .font(.app.caption2.weight(.medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 7)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering } }
        .tip(slot.tip)
        .contextMenu { menu }
    }

    @ViewBuilder
    private var menu: some View {
        Button("Close Tab", systemImage: "xmark") { fleet.closeTab(key) }
        Button("Close Other Tabs") { fleet.closeOtherTabs(than: key) }
        if let record = fleet.model(for: key.host)?.record(for: key.id), fleet.offersFork(record) {
            Button("Fork thread", systemImage: "arrow.triangle.branch") { fleet.fork(record) }
                .disabled(!fleet.canFork(record))
                .accessibilityIdentifier("fork-thread")
        }
        Divider()
        if slot.isTucked {
            // In no folder, under the thread that started it: taken over, it is in its
            // folder, and in Running and Recent, on every device (2026-10-27).
            Button(TakeOver.nameInMenu, systemImage: TakeOver.symbol) {
                if let record = fleet.model(for: key.host)?.record(for: key.id) { fleet.setShared(true, for: record) }
            }
        } else {
            // A bot's threads are under its avatar, not in a folder.
            Button(slot.isBot ? "Show in Sidebar" : "Show in Its Folder", systemImage: slot.isBot ? "sidebar.leading" : "folder") {
                onShowInFolder(key)
            }
        }
        if slot.isBot, let agent = fleet.model(for: key.host)?.agent(slot.agent) {
            Button("Change look", systemImage: "paintpalette") { onEditLook(agent) }
        }
    }
}

/// A new thread not yet sent, a dashed tab at the row's end: the one on screen, until its
/// first message makes it a tab, whose close button goes back to the tab shown before it,
/// so it has none while there is no tab to go back to; or the one kept with what was
/// typed in it (`Fleet.draftTab`), named by its first words, which shows it again and
/// whose close button lets it go.
private struct DraftChip: View {
    let slot: TabSlot
    let showsTitle: Bool
    let fleet: Fleet

    @State private var isHovered = false

    /// Whether it can be closed: the one on screen goes back to the tab before it.
    private var closes: Bool {
        slot.isKeptDraft || !fleet.tabs.isEmpty
    }

    private func close() {
        if slot.isKeptDraft { fleet.closeDraftTab() } else { fleet.closeShownTab() }
    }

    var body: some View {
        Button {
            if !slot.isSelected { fleet.showDraftTab() }
        } label: {
            HStack(spacing: 6) {
                RowAvatar(style: slot.style, side: TabChip.iconSide)
                if showsTitle {
                    Text(slot.title)
                        .font(.app.footnote.weight(slot.isSelected ? .semibold : .regular).italic())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.leading, showsTitle ? TabChip.endRoom : 0)
            .padding(.trailing, showsTitle ? TabChip.trailingRoom : 0)
            .frame(maxWidth: .infinity, minHeight: TabBar.tabHeight, maxHeight: TabBar.tabHeight)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(slot.title)
        .accessibilityAddTraits(slot.isSelected ? .isSelected : [])
        .accessibilityIdentifier(slot.isKeptDraft ? "tab-kept-draft" : "tab-new-thread")
        .accessibilityActions {
            if slot.isKeptDraft { Button("Close Tab") { fleet.closeDraftTab() } }
        }
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .background {
            ZStack {
                if !slot.isSelected { TabCapsule(isHovered: isHovered, overWash: true) }
                Capsule().strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
        .overlay(alignment: .leading) {
            if isHovered || TabCloseButton.shown(showsTitle: showsTitle), closes {
                TabCloseButton(action: close)
                    .transition(.opacity)
            }
        }
        .onHover { hovering in withAnimation(.easeOut(duration: 0.12)) { isHovered = hovering } }
        .tip(slot.isKeptDraft ? "\(slot.title) (not sent)" : nil)
        // For a finger where it has no title, and so no close button (`TabRail`, a full row).
        .contextMenu {
            if closes { Button("Close Tab", systemImage: "xmark", action: close) }
        }
    }
}

/// A tab's capsule while it is not the one shown: faint, and a little less so under the
/// pointer. The chat's tabs have it, and the Macs' (`MacTabs`), drawn in their look.
struct TabCapsule: View {
    var isHovered = false
    /// Over the chat's wash, whose top can be light: half the page's own colour under the
    /// fill, and a fine edge, keep a tab plain to see there too (2026-10-24: "a
    /// bit more opaque, it's hard to see sometimes when background is light", then "still
    /// too hard to see"). The Macs' tabs sit
    /// on the sidebar's plain background and need none.
    var overWash = false

    var body: some View {
        ZStack {
            if overWash {
                Capsule().fill(Theme.plainBackground.opacity(isHovered ? 0.6 : 0.5))
            }
            Capsule().fill(Color.primary.opacity(isHovered ? 0.12 : (overWash ? 0.08 : 0.045)))
            if overWash {
                // A fine edge, so a tab keeps its shape on any part of the wash.
                Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.5)
            }
        }
    }
}

/// The × at a tab's leading edge, under the pointer. The whole of its circle and a little
/// past it is pressed: its shape was the button's, outside its label, and only the cross
/// took a click (a beta tester, 2026-10-31: "my pointer needs to be right in the middle of
/// the button for it to function"). Drawn where it was.
private struct TabCloseButton: View {
    let action: () -> Void

    /// On an iPad on every tab, in place of its activity mark: a finger brings no pointer
    /// to show it, and a tab closed only from its menu (2026-10-31: "i cant close
    /// tabs on ipad easily just remove the spinner i think to make some space to close the
    /// tab?"). The tab's edge still says what its thread is doing (`TabStatusFill`).
    /// A tab with no title is its logo and what its thread is doing (2026-11-01):
    /// too small a thing to touch beside the next one. The tab on screen always has one.
    static func shown(showsTitle: Bool) -> Bool {
        !Platform.isMac && showsTitle
    }

    private static let side: CGFloat = 18
    /// Past the circle on each side, still the button's.
    private static let margin: CGFloat = 4

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .frame(width: Self.side, height: Self.side)
                .padding(Self.margin)
                .contentShape(.rect)
        }
        .foregroundStyle(.secondary)
        .buttonStyle(.plain)
        .background {
            Circle()
                .fill(Color.primary.opacity(0.08))
                .frame(width: Self.side, height: Self.side)
        }
        .padding(.leading, 5 - Self.margin)
        .tip("Close Tab (⌘W)")
        .accessibilityLabel("Close Tab")
        .accessibilityIdentifier("tab-close")
    }
}

/// + at the bar's far end, where it stays as tabs come and go: a click or a tap starts a
/// new tab at once, as ⌘T does and a browser's +, with the agent the last thread was
/// started with and in the folder of the tab on screen (`Fleet.newTab`), whose agent and
/// folder its own screen then changes
/// (`NewThreadPickers`). 2026-10-24: "try to find a better system for creating
/// new tabs (for example, moving the button to the top right or using Command T). The
/// current system is a bit unintuitive". Its secondary click on a Mac, a long press on
/// an iPad, still has the menu + opened before: a new thread in one of the folders of the
/// Mac on screen, with the agent picked from the folder's own menu, or with one of its
/// bots.
private struct NewTabButton: View {
    let fleet: Fleet
    var onNewThread: (Agent) -> Void

    var body: some View {
        Button {
            fleet.newTab()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: TabBar.tabHeight, height: TabBar.tabHeight)
                // Glass, as the tab on screen is (2026-10-26: "make this add button
                // liquid glass too").
                .glassEffect(.regular.interactive(), in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .contextMenu { NewTabMenu(fleet: fleet, onNewThread: onNewThread) }
        .tip("New Tab (⌘T)")
        .accessibilityLabel("New tab")
        .accessibilityIdentifier("new-tab")
    }
}

/// +'s menu: the folders of the Mac on screen, each with its agents, then its bots. A
/// view of its own, so that the layout it reads is read where the menu is made, not each
/// time the bar is.
private struct NewTabMenu: View {
    let fleet: Fleet
    var onNewThread: (Agent) -> Void

    var body: some View {
        if let host = fleet.hostOnScreen {
            let space = fleet.layout.spaces.first { $0.id == host.id }
            let folders = host.offersFolders ? space?.folders ?? [] : []
            if !folders.isEmpty {
                // The agents a folder's own New thread asks between (`AgentPicker`).
                let agents = fleet.agentsForFolder(on: host.id)
                Section {
                    ForEach(folders) { project in
                        let folder = Folder(project: project)
                        Menu(project.name) {
                            ForEach(agents) { agent in
                                Button {
                                    fleet.newThread(with: agent, in: folder)
                                } label: {
                                    Label { Text(agent.displayName) } icon: { fleet.menuIcon(of: agent) }
                                }
                            }
                        }
                    }
                } header: {
                    // Which Mac's folders these are, once there is more than one.
                    if fleet.hosts.count > 1 { Text(host.host.name) }
                }
            }
            if let bots = space?.bots, !bots.isEmpty {
                Section {
                    ForEach(bots) { bot in
                        Button {
                            onNewThread(bot.agent)
                        } label: {
                            Label { Text(bot.agent.displayName) } icon: { fleet.menuIcon(of: bot.agent) }
                        }
                    }
                }
            }
        }
    }
}

extension Fleet {
    /// A menu item's icon for an agent: the maker's logo, or a speech bubble for a bot,
    /// whose avatar a menu cannot draw.
    func menuIcon(of agent: Agent) -> Image {
        logo(for: agent.id)?.image ?? Image(systemName: "bubble.left")
    }
}

/// The title's weight changes at once (`TabChip`); morphs over the tabs' motion with
/// `PORTALS_DEBUG_TAB_TEXT=morph`, as before.
private struct TitleSnaps: ViewModifier {
    let snaps: Bool

    func body(content: Content) -> some View {
        if snaps { content.contentTransition(.identity) } else { content }
    }
}
