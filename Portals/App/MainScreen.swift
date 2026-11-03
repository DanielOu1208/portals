import AgentCore
import SwiftUI
import UIKit

/// The whole app: the chat, and the sidebar of every host's agents and threads.
///
/// - On a narrow window (an iPhone, an iPad in Split View, a small Mac window) the
///   sidebar is behind the chat: swipe right on the chat, or tap the sidebar button, to
///   slide the chat aside.
/// - On a wide one (`WindowLayout.wideWidth`) the sidebar stays beside the chat, and the
///   sidebar button hides and shows it.
struct MainScreen: View {
    let fleet: Fleet
    /// Opens a host's settings.
    var onEditHost: (HostID) -> Void = { _ in }
    /// Opens the list of hosts.
    var onShowHosts: () -> Void = {}

    /// Whether the chat is slid aside, on a narrow window.
    @State private var showsSidebar = false
    /// Whether the sidebar is beside the chat, on a wide window. Kept between launches.
    @AppStorage(MainScreen.pinsSidebarKey) private var pinsSidebar = true
    static let pinsSidebarKey = "sidebar.pinned"
    /// Whether the window is wide, as of its last layout, for what is decided outside
    /// the layout itself (which reads the width directly).
    @State private var isWide = false
    /// How far a swipe has moved the chat while opening or closing the sidebar, read only
    /// where it moves things (`SidebarSlide`).
    @State private var slide = SidebarSlide()
    /// Whether the swipe's pan is under way (`SidebarSwipe`).
    @State private var sidebarSwipe = SidebarSwipe.Tracker()
    /// The agent whose look is being edited.
    @State private var lookEditor: Agent?
    /// The coding agent a new thread is being opened with, while its folder is chosen.
    @State private var folderPicker: Agent?
    /// The folder is chosen for the new thread on screen, from its own screen
    /// (`NewThreadPickers`): it takes that thread's place, and what was typed in it.
    @State private var folderPickerRemakes = false
    /// The coding agent whose sessions from the desk are listed, to take one up.
    @State private var deskPicker: Agent?
    /// The host a new thread's folder is being chosen on before its agent is, from the
    /// host's list of folders.
    @State private var projectPicker: HostConfig?
    /// The same on a host that is on this Mac: in the Mac's own folder dialog, which is
    /// open or not, for the host it was last opened for.
    @State private var showsProjectDialog = false
    @State private var projectDialogHost: HostID?
    /// The folder picked in the sheet, kept until the sheet is gone: a question asked
    /// while a sheet is leaving is not shown.
    @State private var pickedProjectFolder: NewThreadChoice?

    @Environment(\.scenePhase) private var scenePhase
    /// The window's image opened on its own (`ImageLightbox`): the tabs are away while it
    /// is open.
    @Environment(\.imageLightbox) private var lightbox

    var body: some View {
        GeometryReader { proxy in
            let isWide = proxy.size.width >= WindowLayout.wideWidth
            let width = WindowLayout.sidebarWidth(window: proxy.size.width)
            let isOut = isWide ? pinsSidebar : showsSidebar
            // Where the chat rests; a swipe's moves are added where things move with them
            // (`SidebarSlide`), so they change those alone and not this screen, which made
            // the whole sidebar and the whole chat again at each move.
            let position = SidebarSlide.Position(isWide: isWide, isOut: isOut, width: width)
            let offset = position.offset(adding: 0)
            // A status bar at the side leaves a column for the tabs (`TabRail`).
            let column = proxy.safeAreaInsets.trailing
            let tabsAside = !Platform.isMac && isWide && column >= TabRail.leastColumn
            let headerBand = WindowLayout.headerBand(window: proxy.size.width, top: proxy.safeAreaInsets.top)
            let bottomTrim = WindowLayout.bottomTrim(window: proxy.size.width, column: column, inset: proxy.safeAreaInsets.bottom)
            ZStack(alignment: .leading) {
                AgentSidebar(
                    fleet: fleet,
                    onOpen: { record in
                        // Slid away with the thread in place, once its saved copy is read.
                        fleet.open(record) { showsSidebar = false }
                    },
                    onOpenRecoverableDraft: { draft in
                        fleet.openRecoverableDraft(draft) { showsSidebar = false }
                    },
                    onDiscardRecoverableDraft: { draft in
                        fleet.discardRecoverableDraft(draft)
                    },
                    onNewThread: { agent in
                        // A bot's thread starts at once, unless Settings asks Hermes
                        // agents for a folder: the sidebar stays until one is chosen.
                        if fleet.choosesFolder(for: agent.id) {
                            folderPicker = agent
                        } else {
                            fleet.newThread(with: agent)
                            showsSidebar = false
                        }
                    },
                    onNewThreadInFolder: { agent, folder in
                        fleet.newThread(with: agent, in: folder)
                        showsSidebar = false
                    },
                    onChooseFolder: { host in
                        guard let model = fleet.model(for: host) else { return }
                        if model.choosesFoldersOnThisMac {
                            projectDialogHost = host
                            showsProjectDialog = true
                        } else {
                            projectPicker = model.host
                        }
                    },
                    onNewThreadChoosingFolder: { folderPicker = $0 },
                    onDeskSessions: { deskPicker = $0 },
                    onEditLook: { lookEditor = $0 },
                    onNewTab: {
                        // A new tab where the tabs are, as + does, the cursor in its composer
                        // (a Mac's narrow window too); on a phone the sidebar goes for the new
                        // thread's screen, its chips to choose from first.
                        fleet.newTab(focusesComposer: Platform.isMac || isWide)
                        if !isWide { showsSidebar = false }
                    },
                    onShowHosts: onShowHosts,
                    fadesIntoChat: isWide
                )
                .frame(width: width)
                // Beside the chat the sidebar is over it, its far edge fading out over
                // the chat's wash, and leaves the window when it is hidden. Behind the
                // chat, on a narrow window, it stays where it is and the chat slides.
                .offset(x: isWide ? offset - width : 0)
                .zIndex(isWide ? 1 : 0)
                .accessibilityHidden(!isOut)
                // Behind the chat, or out of the window, from the moment a swipe or the
                // slide back has covered it whole until one uncovers it. A live avatar there
                // (an agent's at work) drew 30 frames a second: 0.7% of a core with the
                // thread on screen at rest became 8.8% while the agent worked.
                .modifier(SidebarSlide.OutOfSight(slide: slide, position: position))

                chatArea(isWide: isWide, tabsAside: tabsAside, headerBand: headerBand, washBleed: isWide ? min(offset, WindowLayout.sidebarEdgeFade) : 0)
                    .overlay {
                        // The chat dims as it slides aside; tap it to come back.
                        Color.black
                            .modifier(SidebarSlide.Dims(slide: slide, position: position, by: 0.12))
                            .ignoresSafeArea()
                            .allowsHitTesting(!isWide && showsSidebar)
                            .onTapGesture { showsSidebar = false }
                            .accessibilityHidden(true)
                    }
                    // Beside the sidebar, the chat keeps to the room that is left;
                    // slid aside, it keeps its width and leaves the screen.
                    .frame(width: isWide ? proxy.size.width - offset : nil)
                    .modifier(SidebarSlide.Moves(slide: slide, position: position))
                    .gesture(SidebarSwipe(
                        tracker: sidebarSwipe,
                        isEnabled: !isWide,
                        onChange: sidebarSwipeChanged,
                        onEnd: { settleSidebar(at: $0, width: width) }
                    ))

                // Behind the chat, the sidebar fades gently into it instead of ending
                // at a hard edge. Beside the chat it fades out over the chat's wash
                // instead (`AgentSidebar.fadesIntoChat`), and nothing is drawn over the
                // chat.
                LinearGradient(
                    colors: [AgentSidebar.background, AgentSidebar.background.opacity(0)],
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: 48)
                .ignoresSafeArea()
                .modifier(SidebarSlide.Moves(slide: slide, position: position))
                .modifier(SidebarSlide.Dims(slide: slide, position: position, by: 1))
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            // Watchdog: a swipe that stops moving without an end (the view went away
            // mid-swipe, say) mustn't leave the chat partway across.
            .modifier(SidebarSlide.StuckCheck(slide: slide, tracker: sidebarSwipe) { settleSidebar(at: $0, width: width) })
            // From the window's leading edge: this stack is as wide as the chat alone, which
            // the sidebar's room moves along.
            .overlay(alignment: .topLeading) {
                if tabsAside {
                    TabRail(
                        fleet: fleet,
                        isCovered: lightbox?.isOpen == true,
                        onNewThread: { startNewThread(with: $0) },
                        onEditLook: { lookEditor = $0 },
                        onShowInFolder: showInSidebar
                    )
                    .padding(.top, TabRail.statusBar)
                    .padding(.bottom, Theme.grid - bottomTrim)
                    .frame(width: column)
                    .offset(x: proxy.size.width)
                }
            }
            .safeAreaPadding(.top, max(0, WindowLayout.leastTopRoom - proxy.safeAreaInsets.top))
            .environment(\.bottomTrim, bottomTrim)
        }
        .animation(.smooth(duration: 0.3), value: showsSidebar)
        .animation(.smooth(duration: 0.3), value: pinsSidebar)
        .onGeometryChange(for: Bool.self) { $0.size.width >= WindowLayout.wideWidth } action: { wide in
            isWide = wide
            // A swipe under way when the window widens has nothing left to move.
            if wide { slide.distance = 0 }
        }
        // Where the tabs are, the chats shown lately are kept built (`Fleet.keptChats`).
        .onChange(of: showsTabBar(isWide: isWide), initial: true) { _, tabs in
            fleet.chatsKeptBehind = tabs ? Self.chatsKeptBehind : 0
        }
        // Short of memory, the system asks apps to let go of what they can: the chats kept
        // out of sight first, which are built again as they are shown.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            fleet.letGoOfKeptChats()
        }
        .environment(\.swipeGuard, SwipeGuard(slide))
        .environment(\.chatIsAside, !isWide && showsSidebar)
        .environment(\.imageStore, fleet.store)
        .environment(\.macNames, fleet.macNames)
        .onChange(of: !isWide && showsSidebar) { _, aside in
            // The keyboard would cover the sidebar it slid aside for. Also as a wider window
            // narrows with the sidebar left out: the chat stays the same view, its focus with it.
            if aside { Self.dismissKeyboard() }
        }
        // While the sidebar is out, what each host's threads are doing, also the ones
        // not open here (a turn started at the desk, an approval waiting), and the list of
        // a host that keeps it for every device, so a change made on another shows here
        // within a few seconds.
        .task(id: sidebarIsOut) {
            guard sidebarIsOut else { return }
            while !Task.isCancelled {
                fleet.refreshActivity()
                try? await Task.sleep(for: .seconds(5))
            }
        }
        .onChange(of: scenePhase) { old, phase in
            ReturnProbe.shared?.note("phase", "\(phase)")
            switch phase {
            case .active: fleet.enterForeground()
            case .background: fleet.enterBackground()
            // On its way back from the background, the screen already showing: the hosts
            // are reached from now, not once it is active, which on a phone is about half
            // a second later (the system's animation into the app).
            case .inactive where old == .background: fleet.enterForeground()
            default: fleet.saveAll()
            }
        }
        // A tapped notification opens its thread, on whichever host has it, here or as
        // soon as this screen exists.
        .onChange(of: PushCoordinator.shared.requestedThread, initial: true) { _, route in
            guard let route else { return }
            PushCoordinator.shared.requestedThread = nil
            if fleet.open(route) { showsSidebar = false }
        }
        // The device's address arrived, or changed, or the relay named the device: every
        // host needs it.
        .onChange(of: PushCoordinator.shared.deviceToken) {
            fleet.registerForPush()
        }
        .onChange(of: PushCoordinator.shared.relayToken) {
            fleet.registerForPush()
        }
        // The thread in sight, the one looked at and what the watchdog notes was on screen,
        // in a modifier of its own (`ChatWatch`), which reads the chat on screen as only
        // `ChatDeck` does besides: a tab switch does not work out this whole screen again.
        .modifier(ChatWatch(fleet: fleet, isWide: isWide, showsSidebar: showsSidebar, scenePhase: scenePhase))
        .alert(
            fleet.refusal?.heading ?? "",
            isPresented: Binding(get: { fleet.refusal != nil }, set: { if !$0 { fleet.refusalRead() } }),
            presenting: fleet.refusal
        ) { _ in
            Button("OK", role: .cancel) {}
        } message: { refusal in
            Text(refusal.text)
        }
        .sheet(item: $lookEditor) { agent in
            AgentLookEditor(agent: agent, look: fleet.look(for: agent.id), logo: fleet.logo(for: agent.id)) { look in
                fleet.setLook(look, for: agent.id)
            }
        }
        .sheet(item: $folderPicker, onDismiss: { folderPickerRemakes = false }) { agent in
            if let host = fleet.model(for: agent.id.host) {
                FolderSheet(agent: agent, host: host) { folder in
                    if folderPickerRemakes {
                        fleet.remakeNewThread(with: agent, in: folder)
                    } else {
                        fleet.newThread(with: agent, in: folder)
                    }
                    showsSidebar = false
                }
            }
        }
        .sheet(item: $projectPicker) {
            if let picked = pickedProjectFolder {
                pickedProjectFolder = nil
                folderPicked(picked.folder, on: picked.host)
            }
        } content: { config in
            if let host = fleet.model(for: config.id) {
                FolderSheet(host: host) { folder in
                    pickedProjectFolder = NewThreadChoice(host: config.id, folder: folder)
                }
            }
        }
        .folderDialog(isPresented: $showsProjectDialog, on: projectDialogHost.flatMap { fleet.model(for: $0) }) { folder in
            if let host = projectDialogHost { folderChosen(folder, on: host) }
        }
        .sheet(item: $deskPicker) { agent in
            if let host = fleet.model(for: agent.id.host) {
                DeskSheet(agent: agent, host: host) {
                    showsSidebar = false
                }
            }
        }
        .onAppear {
            // ⌘S, from the menu bar (`TabCommands`), as the sidebar's own button does.
            ScreenCommands.shared.toggleSidebar = toggleSidebar
        }
        .task {
            await fleet.start()
            if DebugLaunch.opensSidebar { showsSidebar = true }
            if let name = DebugLaunch.lookEditorAgent {
                lookEditor = fleet.hosts.lazy.flatMap(\.agents).first { $0.id.name == name }
            }
            if let name = DebugLaunch.folderSheetAgent {
                // A moment after the screen settles, as a tap would.
                try? await Task.sleep(for: .seconds(0.5))
                if let agent = fleet.hosts.lazy.flatMap(\.agents).first(where: { $0.id.name == name }) { startNewThread(with: agent) }
            }
            if let name = DebugLaunch.deskSheetAgent {
                // Once the host has said it lists its sessions, as a tap could only then.
                for _ in 0..<40 {
                    if let agent = fleet.hosts.lazy.flatMap(\.agents).first(where: { $0.id.name == name }), fleet.offersDeskSessions(for: agent.id) {
                        try? await Task.sleep(for: .seconds(0.5))
                        deskPicker = agent
                        break
                    }
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
        }
    }

    /// The chat, under the tabs on a Mac and beside the sidebar on an iPad (`TabBar`), in
    /// place of the header the chat has on a phone. On a Mac the tabs are up in the
    /// window's bar: the chat goes up under it, and is told the room the bar takes.
    private func chatArea(isWide: Bool, tabsAside: Bool, headerBand: CGFloat?, washBleed: CGFloat) -> some View {
        // The chat is the same view with the tabs or without them: an iPhone Duo opened or
        // closed crosses from one to the other with what is open in the chat left as it is.
        content(isWide: isWide, tabsAside: tabsAside, headerBand: headerBand, washBleed: washBleed)
            .safeAreaInset(edge: .top, spacing: 0) {
                if showsTabBar(isWide: isWide), !tabsAside {
                    TabBar(
                        fleet: fleet,
                        clearsWindowButtons: !isWide || !pinsSidebar,
                        isCovered: lightbox?.isOpen == true,
                        onToggleSidebar: toggleSidebar,
                        onNewThread: { startNewThread(with: $0) },
                        onEditLook: { lookEditor = $0 },
                        onShowInFolder: showInSidebar
                    )
                }
            }
            .ignoresSafeArea(.container, edges: Platform.isMac ? .top : [])
            // Here, not in the chat: there is none while a host connects, and with the sidebar
            // hidden and no swipe on a wide window, this is the way back to it.
            .overlay(alignment: .topLeading) {
                if tabsAside {
                    SidebarButtonOverChat(isCovered: lightbox?.isOpen == true, onToggle: toggleSidebar)
                }
            }
    }

    /// Whether the tabs show over the chat: always on a Mac, whose header they are; on an
    /// iPad beside the sidebar. A phone, and an iPad in a narrow window, keep the chat's
    /// header and list the tabs under Recent.
    private func showsTabBar(isWide: Bool) -> Bool {
        Platform.isMac || isWide
    }

    /// The chat, with the connection of the host it is on; before any thread, the first
    /// host connecting. A view of its own (`ChatDeck`), which alone reads the chat on screen:
    /// a tab switch works out the chats, not this whole screen (the sidebar, the tabs and
    /// what they are handed).
    private func content(isWide: Bool, tabsAside: Bool, headerBand: CGFloat?, washBleed: CGFloat) -> some View {
        ChatDeck(
            fleet: fleet,
            isWide: isWide,
            washBleed: washBleed,
            showsTabs: showsTabBar(isWide: isWide),
            tabsAside: tabsAside,
            headerBand: headerBand,
            pinsSidebar: pinsSidebar,
            onEditHost: onEditHost,
            // ⌘N and /new, as the sidebar's New thread: with the agent the last thread was
            // started with, its Mac and folder changed on its own screen.
            onNewThread: { fleet.newTab(focusesComposer: Platform.isMac || isWide) },
            onChooseFolder: { agent in
                folderPickerRemakes = true
                folderPicker = agent
            },
            onOpenSidebar: { if isWide { pinsSidebar.toggle() } else { showsSidebar = true } },
            onEditLook: { lookEditor = $0 }
        )
    }

    /// Shows or hides the sidebar: beside the chat on a wide window, or behind it.
    private func toggleSidebar() {
        if isWide { pinsSidebar.toggle() } else { showsSidebar.toggle() }
    }

    /// Show in Its Folder, from a tab's menu: the sidebar shows, and is asked to bring the
    /// thread's Mac and folder into view (`Fleet.revealedThread`).
    private func showInSidebar(_ key: ThreadKey) {
        if isWide { pinsSidebar = true } else { showsSidebar = true }
        fleet.revealedThread = key
    }

    /// A new thread with `agent`: at once for a Hermes agent; a coding agent's starts by
    /// choosing its folder.
    private func startNewThread(with agent: Agent) {
        if fleet.choosesFolder(for: agent.id) {
            folderPicker = agent
        } else {
            fleet.newThread(with: agent)
        }
    }

    /// A folder was picked from `host`'s list for a new thread: a host that keeps what
    /// the user adds has it as a project from now on, as one chosen in the Mac's folder
    /// dialog is. Then the agent, either way.
    private func folderPicked(_ folder: Folder, on host: HostID) {
        guard let model = fleet.model(for: host), model.addsFolders else { return folderChosen(folder, on: host) }
        Task {
            let added = try? await model.addFolder(at: folder.path)
            folderChosen(added ?? folder, on: host)
        }
    }

    /// A folder is chosen for a new thread on `host` and its agent is not: the thread
    /// opens with the agent the last one was started with, or the Mac's default
    /// (`Fleet.agentForNewThread`), which its own screen changes.
    private func folderChosen(_ folder: Folder, on host: HostID) {
        guard let agent = fleet.agentForNewThread(in: host) else { return }
        fleet.newThread(with: agent, in: folder)
        showsSidebar = false
    }

    /// Whether the sidebar shows: beside the chat on a wide window, or with the chat
    /// slid aside on a narrow one.
    private var sidebarIsOut: Bool {
        isWide ? pinsSidebar : showsSidebar
    }

    // MARK: Swipe

    private func sidebarSwipeChanged(_ distance: CGFloat) {
        slide.distance = distance
        slide.movedAt = .now
    }

    /// Ends a swipe: open or closed by where it would come to rest (`projected`), or
    /// back where it was when it was cancelled (nil).
    private func settleSidebar(at projected: CGFloat?, width: CGFloat) {
        slide.movedAt = .now
        withAnimation(.smooth(duration: 0.3)) {
            if let projected {
                showsSidebar = (showsSidebar ? width : 0) + projected > width / 2
            }
            slide.distance = 0
        }
    }

    /// How many chats are kept built behind the one on screen, where the tabs are: the
    /// tabs shown last, which most switches go back to. Nine, ten chats built in all
    /// (2026-10-26: "10 threads is ok", "ipad should keep 10 as well"): with ten of
    /// real threads as tabs, about 60 MB more than five; all let go of when the system
    /// runs short of memory (`Fleet.letGoOfKeptChats`). Keeping only a kept chat's screen
    /// and a page above it built was tried and saved next to nothing: an agent's thread is
    /// one to three long turns, and a turn is built whole (docs/perf-tabs.md).
    static var chatsKeptBehind: Int { DebugLaunch.chatsKeptBehind ?? 9 }

    private static func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// The chat on screen (`MainScreen`), and where the tabs are those kept built behind it
/// (`Fleet.keptChats`); before any thread, the first host connecting.
private struct ChatDeck: View {
    let fleet: Fleet
    let isWide: Bool
    /// How far the chat's wash goes on under the sidebar's edge (`AmbientGradient`), which
    /// follows the sidebar as it slides. Handed to the chat on screen alone: in the
    /// environment of the whole deck, its change as the sidebar is shown or hidden (⌘S) went
    /// through every chat kept out of sight.
    let washBleed: CGFloat
    /// Whether the tabs show over the chat (`MainScreen.showsTabBar`).
    let showsTabs: Bool
    /// Whether they are down the side (`TabRail`), not over the chat.
    let tabsAside: Bool
    /// `WindowLayout.headerBand`.
    let headerBand: CGFloat?
    let pinsSidebar: Bool
    let onEditHost: (HostID) -> Void
    let onNewThread: () -> Void
    /// The folder is chosen for the new thread on screen, from its own screen.
    let onChooseFolder: (Agent) -> Void
    let onOpenSidebar: () -> Void
    let onEditLook: (Agent) -> Void

    /// The size each chat out of sight keeps (`body`).
    @State private var keptSizes = KeptSizes()

    var body: some View {
        if let chat = fleet.chat, let host = fleet.model(of: chat) {
            // Where the tabs are, the chats shown lately stay built behind the one on
            // screen, out of sight (`Fleet.keptChats`): going back to one shows it at
            // once, as it was left. Each is compared by what it shows, so that those out
            // of sight are not worked out again as this screen is. Without the tabs it is
            // the one on screen alone, in the same place: the window crossing between the
            // two (an iPhone Duo opened or closed) keeps it. Another thread starts with a
            // fresh screen: draft, scroll, composer.
            let drawn = showsTabs ? chatsDrawn(with: chat) : [chat]
            let sizes = DebugLaunch.keepsChatsInPlace ? keptSizes.sizes(of: drawn, shown: chat) : [:]
            ZStack {
                ForEach(drawn) { kept in
                    if let keptHost = fleet.model(of: kept) {
                        let isShown = kept === chat
                        let size = sizes[ObjectIdentifier(kept)]
                        // Each in a place of the deck's size that its size does not change
                        // (an overlay): out of sight, it keeps the size the deck had as it
                        // left the screen, by the deck's top trailing corner, which stays
                        // where it is as the sidebar is shown or hidden (⌘S) beside it. The
                        // sidebar sliding, or the window resized, lays out and moves the
                        // chat on screen alone, not every one kept: each frame of the slide
                        // laid out the chats kept and moved each of their UIKit views (the
                        // replies' text views among them), which made ⌘S a quarter dearer.
                        // One comes back at the deck's size then.
                        Color.clear.overlay(alignment: .topTrailing) {
                            KeptChat(screen: chatScreen(kept, on: keptHost, isShown: isShown), isShown: isShown)
                                .equatable()
                                .frame(width: size?.width, height: size?.height)
                                // The wash's bleed under the sidebar's edge follows the sidebar
                                // as it slides; a chat out of sight keeps the one it left with.
                                .environment(\.washBleed, isShown ? washBleed : keptSizes.bleed(of: kept, now: washBleed))
                                // On the chat itself, not on its place: the place changes
                                // with the deck, and what is hidden here is drawn in a
                                // UIKit view of its own, which would change with it.
                                .opacity(isShown ? 1 : 0)
                                .allowsHitTesting(isShown)
                                .accessibilityHidden(!isShown)
                                // One leaving the screen with a panel open over it is let go
                                // of, the panel with it, as before.
                                .onPreferenceChange(PanelOpenKey.self) { isOpen in
                                    if isOpen {
                                        fleet.chatsWithPanels.insert(ObjectIdentifier(kept))
                                    } else {
                                        fleet.chatsWithPanels.remove(ObjectIdentifier(kept))
                                    }
                                }
                        }
                        .zIndex(isShown ? 1 : 0)
                    }
                }
            }
            .onGeometryChange(for: CGSize.self) { $0.size } action: { keptSizes.deck = $0 }
        } else if let host = fleet.hosts.first {
            if host.offersNoAgents {
                NoAgentsView(hostName: host.host.name, onEditHost: { onEditHost(host.id) }) {
                    await host.start()
                }
            } else {
                ConnectingView(hostName: host.host.name, problem: host.problem, onEditHost: { onEditHost(host.id) }) {
                    Task { await host.start() }
                }
            }
        }
    }

    /// The chats drawn where the tabs are: those kept, in the order they were first kept,
    /// and the one on screen.
    private func chatsDrawn(with chat: ThreadController) -> [ThreadController] {
        fleet.keptChats.contains { $0 === chat } ? fleet.keptChats : fleet.keptChats + [chat]
    }

    /// One thread's chat.
    private func chatScreen(_ chat: ThreadController, on host: HostModel, isShown: Bool) -> ChatScreen {
        ChatScreen(
            chat: chat,
            hostName: host.host.name,
            style: host.style(for: chat.agent.id),
            isConnected: host.shownConnection == .connected,
            hostIsConnected: host.connection == .connected,
            connectionProblem: host.connectionProblem,
            connectionIsStopped: host.connectionIsStopped,
            onEditHost: { onEditHost(host.id) },
            showsHeader: !showsTabs,
            titleInBar: tabsAside,
            headerBand: headerBand,
            choosesFolder: fleet.choosesFolder(for: chat.agent.id),
            firstThreadHint: firstThreadHint(for: chat, on: host),
            // On a phone too (2026-10-27: "can we have this on mobile as well").
            newThreadPickers: NewThreadPickers(fleet: fleet, chat: chat, onOtherFolder: onChooseFolder),
            onNewThread: onNewThread,
            onOpenSidebar: onOpenSidebar,
            onEditLook: { onEditLook(chat.agent) },
            offersFork: chat.thread.map(host.offersFork) == true,
            onFork: { try await host.forkViewOnly(chat) },
            startedThreads: { chat.thread.map { fleet.startedThreads(from: $0.key) } ?? [] },
            onOpenThread: { fleet.openStarted($0) },
            onBackToParent: { parent in
                if let key = chat.thread?.key { fleet.back(to: parent, from: key) } else { fleet.open(parent) }
            },
            parentThread: { chat.thread.flatMap { fleet.parent(of: $0.key) } },
            onShareThread: { fleet.setShared($1, for: $0) },
            panelHost: ThreadPanelHost(
                name: host.host.name, symbol: host.host.macSymbol, generalFolder: host.host.generalFolder, isConnected: host.shownConnection == .connected, problem: host.connectionProblem,
                route: host.route, address: host.host.url.host(), version: host.bridgeVersion, latest: host.update?.latest
            ),
            isShown: isShown
        )
    }

    /// What the first thread on a Mac says under its question, for someone new: that the
    /// threads, the Mac's folders (where a new thread starts with any of its agents) and
    /// its bots are in the sidebar, and how to get to it.
    private func firstThreadHint(for chat: ThreadController, on host: HostModel) -> String? {
        guard host.listedThreads.isEmpty else { return nil }
        let what = host.offersFolders
            ? "your threads and the folders on \(host.host.name), each with New thread for any agent"
            : "your threads and the bots on \(host.host.name)"
        if !isWide { return "Swipe right for \(what)." }
        return pinsSidebar ? "The sidebar has \(what)." : "Open the sidebar for \(what)."
    }
}

/// What the screen tells others of the chat on screen (`MainScreen`): the thread in sight
/// (`Fleet.threadInSight`), the one looked at (`PushCoordinator.visibleThread`, whatever
/// finished in it has been seen) and what the main thread's watchdog notes was on screen.
/// A modifier of its own, so that only it, and not the whole screen, is worked out again
/// as the chat on screen changes.
private struct ChatWatch: ViewModifier {
    let fleet: Fleet
    let isWide: Bool
    let showsSidebar: Bool
    let scenePhase: ScenePhase
    /// Settings is over the whole screen (`RootView`): no chat is looked at under it.
    @Environment(\.isOutOfSight) private var isCovered

    func body(content: Content) -> some View {
        content
            // Notifications about the thread being looked at are not shown, and whatever
            // finished in it has been seen.
            // The thread in sight is not listed under Finished for having ended out of sight: a
            // turn that ended in it while the app was away would show there as the app comes
            // back, and leave again once the host was told it is seen, moving the list.
            .onChange(of: threadInSight, initial: true) { _, key in fleet.threadInSight = key }
            // The sidebar's rows mark the thread on screen (`Fleet.currentRows`), also once a
            // new thread on screen is made.
            .onChange(of: fleet.chat?.thread?.key) { fleet.noteCurrent() }
            // What the main thread's watchdog says was on screen, should it find the main
            // thread stuck. Made of what this reads anyway.
            .onChange(of: watchdogScreen, initial: true) { _, screen in AppWatchdog.note(screen: screen) }
            .onChange(of: visibleThread, initial: true) { _, thread in
                PushCoordinator.shared.visibleThread = thread
                fleet.threadLookedAt(thread)
            }
    }

    /// The thread whose chat shows, the app in front or not: the chat is not slid aside.
    private var threadInSight: ThreadKey? {
        guard isWide || !showsSidebar, !isCovered else { return nil }
        return fleet.chat?.thread?.key
    }

    /// `active · narrow · chat with Claude, thread 1f9de45b`: what is on screen, for the
    /// watchdog's entries.
    private var watchdogScreen: String {
        let shown = if let thread = fleet.chat?.thread {
            "\(isWide || !showsSidebar ? "chat" : "sidebar over the chat") with \(thread.agent.name), thread \(thread.id.rawValue.prefix(8))"
        } else {
            "sidebar, no chat"
        }
        return "\(scenePhase) · \(isWide ? "wide" : "narrow") · \(isCovered ? "under Settings: " : "")\(shown)"
    }

    /// The thread on screen, while the app is in front and the chat is not slid aside.
    private var visibleThread: PushRoute? {
        guard scenePhase == .active, isWide || !showsSidebar, !isCovered, let thread = fleet.chat?.thread else { return nil }
        return PushRoute(host: thread.agent.host, thread: thread.id)
    }
}

/// The size each chat kept built out of sight keeps (`ChatDeck`): the deck's as it left the
/// screen. Not observed: the deck's size changes with every layout, and is read only as
/// the deck is worked out.
private final class KeptSizes {
    /// The deck's size, as of its last layout.
    var deck: CGSize?
    private var kept: [ObjectIdentifier: CGSize] = [:]
    /// The wash's bleed under the sidebar's edge each chat out of sight keeps: the one it
    /// had as it left the screen, so that leaving it, coming back to it (the sidebar as it
    /// was) or showing or hiding the sidebar meanwhile changes nothing in its environment.
    private var bleeds: [ObjectIdentifier: CGFloat] = [:]

    /// The bleed `chat` keeps out of sight; `now`, the one on screen's, as it leaves.
    func bleed(of chat: ThreadController, now: CGFloat) -> CGFloat {
        let id = ObjectIdentifier(chat)
        if let bleed = bleeds[id] { return bleed }
        bleeds[id] = now
        return now
    }

    /// The sizes of the chats `drawn` out of sight: each the deck's as it left the screen
    /// (`shown`, on screen, has none: it takes the deck's). Those no longer drawn are
    /// forgotten.
    func sizes(of drawn: [ThreadController], shown: ThreadController) -> [ObjectIdentifier: CGSize] {
        var sizes: [ObjectIdentifier: CGSize] = [:]
        for chat in drawn where chat !== shown {
            let id = ObjectIdentifier(chat)
            sizes[id] = kept[id] ?? deck
        }
        kept = sizes
        bleeds = bleeds.filter { sizes[$0.key] != nil }
        return sizes
    }
}

/// A chat kept built where the tabs are (`MainScreen.content`), compared by what it shows
/// and not by the actions it is handed, which never compare equal: one out of sight is not
/// worked out again each time the screen is (a tab switch, a thread's change anywhere).
/// The one on screen always is, as before.
private struct KeptChat: View, Equatable {
    let screen: ChatScreen
    let isShown: Bool

    static func == (one: KeptChat, other: KeptChat) -> Bool {
        let a = one.screen, b = other.screen
        return !one.isShown && !other.isShown && a.isShown == b.isShown && a.chat === b.chat && a.style == b.style
            && a.hostName == b.hostName && a.isConnected == b.isConnected && a.hostIsConnected == b.hostIsConnected
            && a.connectionProblem == b.connectionProblem && a.connectionIsStopped == b.connectionIsStopped
            && a.showsHeader == b.showsHeader && a.titleInBar == b.titleInBar && a.headerBand == b.headerBand && a.choosesFolder == b.choosesFolder
            && a.firstThreadHint == b.firstThreadHint && (a.newThreadPickers == nil) == (b.newThreadPickers == nil)
            && a.panelHost == b.panelHost
    }

    var body: some View { screen }
}

/// Keeps a swipe that ends on a button from also pressing it. The sidebar swipe runs
/// alongside every other gesture, so a finger lifting over Approve at the end of a
/// swipe would otherwise approve.
///
///     @Environment(\.swipeGuard) private var swipeGuard
///     Button("Once") { swipeGuard { answer(.once) } }
///
/// It holds the screen's slide itself, not a closure: a closure made in `MainScreen`'s body
/// was a new value at each of its updates (every tab switch), and every view reading the
/// guard, in every chat kept built, was worked out again for it.
struct SwipeGuard {
    private var slide: SidebarSlide?

    init() {}

    init(_ slide: SidebarSlide) {
        self.slide = slide
    }

    /// True while a sideways swipe moves the chat, and for a moment after: the finger
    /// lifting over a button at the end of a swipe isn't a tap.
    var isSwiping: Bool {
        guard let slide else { return false }
        return slide.distance != 0 || Date.now.timeIntervalSince(slide.movedAt) < 0.4
    }

    func callAsFunction(_ action: () -> Void) {
        if !isSwiping { action() }
    }
}

/// A sidebar swipe under way: how far it has moved the chat, and when it last did. Read only
/// by the few modifiers that move things with it, never by `MainScreen`'s body: a swipe
/// moves 60 to 120 times a second, and each move made the whole sidebar and the whole chat
/// screen again (their closures never compare equal), which cost a core a third of the
/// time on an iPhone simulator while swiping.
@Observable
final class SidebarSlide {
    /// The swipe's sideways distance so far, in points; 0 with no swipe under way.
    var distance: CGFloat = 0
    /// When it last moved, or ended (`SwipeGuard`, `StuckCheck`).
    @ObservationIgnored var movedAt = Date.distantPast

    /// Where the chat rests, for the offsets a swipe's distance is added to.
    struct Position: Equatable {
        var isWide: Bool
        var isOut: Bool
        var width: CGFloat

        /// The chat's offset with a swipe of `distance`: none on a wide window, where the
        /// sidebar is beside the chat.
        func offset(adding distance: CGFloat) -> CGFloat {
            min(max((isOut ? width : 0) + (isWide ? 0 : distance), 0), width)
        }
    }

    /// Moves the view with the chat.
    struct Moves: ViewModifier {
        let slide: SidebarSlide
        let position: Position

        func body(content: Content) -> some View {
            content.offset(x: position.offset(adding: slide.distance))
        }
    }

    /// Shows the view more the further the chat is slid aside, up to `by`; not at all on a
    /// wide window.
    struct Dims: ViewModifier {
        let slide: SidebarSlide
        let position: Position
        let by: Double

        func body(content: Content) -> some View {
            content.opacity(position.isWide ? 0 : by * position.offset(adding: slide.distance) / position.width)
        }
    }

    /// The sidebar can't be seen while the chat covers it whole (`isOutOfSight`).
    struct OutOfSight: ViewModifier {
        let slide: SidebarSlide
        let position: Position

        func body(content: Content) -> some View {
            content.outOfSight(position.offset(adding: slide.distance) == 0)
        }
    }

    /// A swipe that stops moving without an end (the view went away mid-swipe, say) mustn't
    /// leave the chat partway across: one check for the whole swipe, which made a task of
    /// its own at each move before (`StuckSwipe`).
    struct StuckCheck: ViewModifier {
        let slide: SidebarSlide
        let tracker: SidebarSwipe.Tracker
        let settle: (CGFloat) -> Void

        func body(content: Content) -> some View {
            content.task(id: slide.distance != 0) {
                while slide.distance != 0, !Task.isCancelled {
                    switch StuckSwipe.step(still: Date.now.timeIntervalSince(slide.movedAt), fingerDown: tracker.isActive) {
                    case let .wait(seconds):
                        try? await Task.sleep(for: .seconds(seconds))
                    case .settle:
                        tracker.isActive = false
                        settle(slide.distance)
                        return
                    }
                }
            }
        }
    }
}

extension EnvironmentValues {
    @Entry var swipeGuard = SwipeGuard()
    /// Whether the chat is slid aside for the sidebar, on a narrow window.
    @Entry var chatIsAside = false
    /// Whether the views can't be seen though their window can: the sidebar behind the
    /// chat on a narrow window, or out of a wide one, or the whole screen under Settings.
    /// Live avatars there hold still. Set with `outOfSight(_:)`, never directly.
    @Entry var isOutOfSight = false
}

extension View {
    /// Out of sight when `hidden`, and always when what this is in is out of sight
    /// already (the whole screen under Settings, `RootView`): a part that sets its own
    /// never uncovers itself.
    func outOfSight(_ hidden: Bool) -> some View {
        modifier(OutOfSightWhen(hidden: hidden))
    }
}

/// `outOfSight(_:)`.
private struct OutOfSightWhen: ViewModifier {
    let hidden: Bool
    @Environment(\.isOutOfSight) private var inherited

    func body(content: Content) -> some View {
        content.environment(\.isOutOfSight, inherited || hidden)
    }
}

/// Shown before the first thread: connecting, or why that failed.
private struct ConnectingView: View {
    let hostName: String
    let problem: String?
    var onEditHost: () -> Void
    var onRetry: () -> Void

    var body: some View {
        VStack(spacing: Theme.grid * 2) {
            AgentAvatarView(mood: problem == nil ? .thinking : .idle, size: 96)
            if let problem {
                Text("Can't reach \(hostName)")
                    .font(.app.headline)
                Text(problem)
                    .font(.app.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Try again", action: onRetry)
                    .buttonStyle(.monochromeProminent)
                    .buttonBorderShape(.capsule)
                    .padding(.top, Theme.grid)
                Button("Host settings", action: onEditHost)
                    .font(.app.subheadline)
            } else {
                Text("Connecting to \(hostName)…")
                    .font(.app.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .pageMargins()
        .frame(maxWidth: WindowLayout.pageWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { AmbientGradient(mood: problem == nil ? .working : .calm) }
    }
}

/// Shown when the only host answers but offers no agents: none of Claude Code, Codex, Pi,
/// Cursor or Hermes is set up on it yet.
private struct NoAgentsView: View {
    let hostName: String
    var onEditHost: () -> Void
    var onCheckAgain: () async -> Void

    @State private var isChecking = false

    var body: some View {
        VStack(spacing: Theme.grid * 2) {
            AgentAvatarView(mood: .idle, size: 96)
            Text("No agents on \(hostName) yet")
                .font(.app.headline)
            Text("Install Claude Code, Codex, Pi, Cursor or Hermes on it, then run `\(PairingLink.setupCommand)` there again.")
                .font(.app.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                Task {
                    isChecking = true
                    await onCheckAgain()
                    isChecking = false
                }
            } label: {
                if isChecking {
                    ProgressView()
                } else {
                    Text("Check again")
                }
            }
            .buttonStyle(.monochromeProminent)
            .buttonBorderShape(.capsule)
            .disabled(isChecking)
            .padding(.top, Theme.grid)
            .accessibilityIdentifier("check-agents-again")
            Button("Host settings", action: onEditHost)
                .font(.app.subheadline)
        }
        .pageMargins()
        .frame(maxWidth: WindowLayout.pageWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { AmbientGradient(mood: .calm) }
    }
}
