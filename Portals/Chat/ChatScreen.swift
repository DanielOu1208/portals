import AgentCore
import os
import SwiftUI

/// One thread with one agent: the header, the transcript and the composer.
///
/// The chat keeps to its end as a reply grows, unless you scroll away. The composer is
/// always at the bottom; when the agent asks for an approval or a question, its card
/// sits just above the composer.
struct ChatScreen: View {
    @Bindable var chat: ThreadController
    /// The Mac this thread belongs to, independent of the sidebar's selected space.
    let hostName: String
    /// The agent's look, for its avatar.
    var style: AgentAvatarStyle = .standard
    /// Whether the host can be reached right now, and if not, why the last try failed.
    /// As shown: the connection the app let go of while away shows as it was left until
    /// it is back (`HostModel.shownConnection`).
    var isConnected = true
    /// Whether the host is connected in fact: each time it is, what it takes is asked again
    /// (files), the bridge maybe updated meanwhile.
    var hostIsConnected = true
    var connectionProblem: String?
    /// The app gave up connecting until the host's settings are fixed.
    var connectionIsStopped = false
    var onEditHost: () -> Void = {}
    /// Whether the chat shows its header (the agent and the thread's title): on a phone,
    /// and on an iPad in a narrow window. On a Mac and beside an iPad's sidebar the tabs
    /// over the chat say what is on screen instead (`TabBar`).
    var showsHeader = true
    /// The tabs are down the side (`TabRail`): the chat names itself in the bar over it, on
    /// one line (`ChatTitleRow`).
    var titleInBar = false
    /// The chat's header goes up into the status bar's band this deep, on one line, for the
    /// chat's height (`WindowLayout.headerBand`, 2026-11-03: "better optimize the vertical
    /// space", "move the header and buttons up").
    var headerBand: CGFloat?
    /// A new thread starts by choosing a folder (a coding agent), so one can be started
    /// from an empty thread too, in another folder.
    var choosesFolder = false
    /// Under the intro of the first thread on a Mac: where the threads and the other
    /// agents are.
    var firstThreadHint: String?
    /// Under a new thread's question, where the tabs are: its agent and folder to change.
    var newThreadPickers: NewThreadPickers?
    var onNewThread: () -> Void
    var onOpenSidebar: () -> Void = {}
    var onEditLook: () -> Void = {}
    /// Forks a thread that is only read into one that can be continued.
    var offersFork = false
    var onFork: () async throws -> Void = {}
    var canForkMessage = false
    var onForkMessage: (MessageCheckpoint, Bool, ComposerDraft?) async throws -> Void = { _, _, _ in }
    var canUndoFiles = false
    var onPreviewFileUndo: (MessageCheckpoint) async throws -> TurnFileUndoPreview = { _ in throw TurnFileUndoError.unavailable }
    var onUndoFiles: (MessageCheckpoint, TurnFileUndoPreview) async throws -> TurnFileUndoResult = { _, _ in throw TurnFileUndoError.unavailable }
    /// The threads agents started from this one (`Fleet.startedThreads`): asked for by
    /// the line at the chat's foot as it is drawn, so that only it follows their news.
    var startedThreads: () -> [StartedThread] = { [] }
    /// Opens one of `startedThreads`, tapped at the chat's foot (`Fleet.openStarted`).
    var onOpenThread: (ThreadRecord) -> Void = { _ in }
    /// The back button: opens `parentThread` and closes this thread's tab (`Fleet.back`).
    var onBackToParent: (ThreadRecord) -> Void = { _ in }
    /// The thread an agent started this one from, when the app has it (`Fleet.parent`),
    /// which the back button over the chat opens: asked for by that button as it is drawn.
    var parentThread: () -> ThreadRecord? = { nil }
    /// Take over thread, or Hide from sidebar, on one of them (`TakeOver`).
    var onShareThread: (ThreadRecord, Bool) -> Void = { _, _ in }
    /// The host as the panel beside the chat says it (`ThreadPanel`).
    var panelHost = ThreadPanelHost(name: "", isConnected: true)
    /// Whether the chat is the one on screen: where the tabs are, the chats shown lately
    /// stay built out of sight (`Fleet.keptChats`). One out of sight has no keyboard focus
    /// and no keys, asks nothing of the screen, and holds its moving parts still
    /// (`isOutOfSight`).
    var isShown = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether the chat is washed in its agent's colour, or in grey (Settings, Appearance).
    @AppStorage(ChatWash.settingKey) private var tintsChats = true
    @Environment(\.swipeGuard) private var swipeGuard
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.chatIsAside) private var chatIsAside
    /// Something over the whole screen hides the chat as well (Settings, `RootView`): its
    /// keyboard is let go of as it is covered.
    @Environment(\.isOutOfSight) private var isCovered
    /// The window's image opened on its own, over the chat (`ImageLightbox`).
    @Environment(\.imageLightbox) private var lightbox

    @State private var messageActionProblem: String?
    @State private var isWorkingOnMessage = false
    @State private var fileUndo: MessageCheckpoint?
    @State private var openedFileUndoForDebug = false
    @State private var openedMessageForkForDebug = false
    /// When this chat was put on screen: a long reply new to it after a moment came while
    /// someone looked, and plays in (`ReplyTextView`).
    @State private var shownSince = Date.now
    /// True for a moment after a reply finishes, so the avatar's happy beat plays even
    /// while the composer keeps focus.
    @State private var celebrating = false
    /// How tall the composer's bar is, which the chat fades out above on a Mac.
    @State private var composerBar: CGFloat = 0
    /// How far down the screen the header's bar reaches on a phone and an iPad, which the
    /// blur under it reaches past (`TopFade`).
    @State private var headerBar: CGFloat = 0
    @State private var transcriptWidth: CGFloat = 0
    @FocusState private var isComposing: Bool
    /// Where the composer's caret is, or what is selected in it (`ChatComposer.caret`).
    @State private var caret: TextSelection?
    /// The composer's `@` menu (`ComposerMentions`).
    @State private var mentions = ComposerMentions()
    /// The composer's slash commands' menu (`ComposerCommands`).
    @State private var commands = ComposerCommands()
    /// The composer lost its focus as the app stopped being the one in use, which gives it
    /// back as it comes back, or as a panel opened over the chat, which gives it back as it
    /// closes: then nothing is done for it, as though it had kept it.
    @State private var focusWithApp = FocusWithApp()
    /// The composer had its focus as a reply's image opened over the window, which took it:
    /// it is given back as the image closes.
    @State private var composedUnderPicture = false
    @State private var scrollPhase: ScrollPhase = .idle
    /// Whether the chat keeps to its end as it grows (`transcript`): on when you send or
    /// start typing; off while you drag, and after a drag only if you let go away from
    /// the end.
    @State private var followsEnd = true
    /// Keeps what you read in place as a turn above it changes height, while the chat does
    /// not keep to its end; none with `PORTALS_DEBUG_NO_ANCHOR`.
    @State private var transcriptAnchor: TranscriptAnchor? = DebugLaunch.keepsNoAnchor ? nil : TranscriptAnchor()
    /// Whether the end of the chat is in view, as of the last scroll geometry.
    @State private var isAtEnd = true
    /// How the thread opened: kept out of sight until it sits at its end (`settle`).
    @State private var opening = Opening()
    /// The thread has been put at its end and shown (`settle`).
    @State private var hasSettled = false
    /// Which of the transcript's folds and rows are open. Kept here, since the
    /// transcript lets go of the turns far from the screen and of what their rows held.
    @State private var openRows = OpenRows()
    /// This screen, to the visuals' pool (`WidgetPool.chatShown`, `chatLeft`).
    @State private var widgetScreen = UUID()
    /// The host has been out of reach for more than a moment (`ConnectionBanner`).
    @State private var showsConnectionBanner = false
    @State private var showsModelPicker = DebugLaunch.opensModelPicker
    /// The subagent or workflow whose detail is open, from the subagents line.
    @State private var openedSubagent: Subagent.ID?
    /// `PORTALS_DEBUG_SUBAGENT` has opened one.
    private static var debugOpenedSubagent = false
    /// The panel is open over the chat, a card under its button (`ThreadPanel`).
    /// On a phone, the panel is open over the chat until a tap beside it (`ThreadPanel`).
    @State private var panelShownHere = DebugLaunch.opensPanel
    /// Where the tabs are (a Mac, an iPad beside its sidebar), it stays open, over every
    /// chat and from one launch to the next, until its close button (2026-11-01),
    /// beside the chat's column: out of the way while the window is too narrow for both,
    /// and back once it is wide enough (2026-11-01: "the panel should auto open if
    /// it was toggled open before the window was resized").
    @AppStorage(ThreadPanel.openKey) private var panelStaysOpen = false
    /// Opened where it does not fit beside the column: over the chat, until a click beside
    /// it, as on a phone (2026-11-01).
    @State private var panelFloats = false
    /// The panel is built though closed, while it fades (`panelOverlay`).
    @State private var panelStaysBuilt = false
    /// How far down the screen the header's button for the panel is, on a phone.
    @State private var panelButtonTop: CGFloat = 0
    /// How wide the chat is, for whether the panel fits beside its column.
    @State private var chatWidth: CGFloat = 0
    /// What the panel has heard from the host.
    @State private var panelState = ThreadPanelState()
    /// VoiceOver goes into the card as it opens and back to its button as it closes.
    @AccessibilityFocusState private var panelFocus: ThreadPanel.Focus?
    /// What this chat's selectable text names as the chat a key typed on it goes to
    /// (`ProseSelection.typed`).
    @State private var proseTyping = ProseTypingTarget()

    /// Whether a new thread can be started from this one: not from an empty one, unless
    /// it could be in another folder.
    private var offersNewThread: Bool {
        // An agent's one ongoing conversation is every new thread with it.
        chat.thread?.isOngoing != true && (!chat.isEmpty || choosesFolder)
    }

    // MARK: The panel over the chat

    /// Open beside the chat's column, which moves left to clear it.
    private var panelBeside: Bool {
        !showsHeader && panelStaysOpen && ThreadPanel.fits(chatWidth: chatWidth)
    }

    private var panelShown: Bool {
        showsHeader ? panelShownHere : panelBeside || panelFloats
    }

    private func panelButton(side: CGFloat) -> ThreadPanelButton {
        ThreadPanelButton(side: side, focus: $panelFocus) {
            swipeGuard { setPanel(shown: true) }
        }
    }

    private func setPanel(shown: Bool) {
        withAnimation(panelMotion) {
            if showsHeader {
                panelShownHere = shown
            } else if !shown {
                panelStaysOpen = false
                panelFloats = false
            } else if ThreadPanel.fits(chatWidth: chatWidth) {
                panelStaysOpen = true
            } else {
                panelFloats = true
            }
        }
        panelFocus = shown ? .card : .button
    }

    /// A tap or click beside it, or VoiceOver's escape: closes it over the chat; only for
    /// now, where the tabs are, if it had been left open beside the column before the window
    /// narrowed.
    private func dismissPanel() {
        guard !showsHeader, panelFloats else { return setPanel(shown: false) }
        withAnimation(panelMotion) { panelFloats = false }
        panelFocus = .button
    }

    /// The window resized, or the sidebar came or went. The panel comes and goes, and the
    /// column with it, in the same motion as at its button when that takes it past fitting;
    /// opened over the chat, it goes beside the column where it now fits.
    private func chatResized(to width: CGFloat) {
        let crosses = chatWidth > 0 && ThreadPanel.fits(chatWidth: chatWidth) != ThreadPanel.fits(chatWidth: width)
        withAnimation(crosses ? panelMotion : nil) {
            chatWidth = width
            if panelFloats, ThreadPanel.fits(chatWidth: width) {
                panelFloats = false
                panelStaysOpen = true
            }
        }
    }

    private var panelMotion: Animation {
        reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.2)
    }

    /// Over the chat, while open: the card in its button's place, with a close button of its
    /// own where the button was, which on a phone, and where it does not fit beside the
    /// column, a tap beside also closes.
    ///
    /// Closed, it stays built while it fades, taking no presses: a card taken away, glass and
    /// all, went on taking them for half a second, and a press on its button's place did
    /// nothing (2026-11-01: "when i close it and i click again it doesnt open again").
    @ViewBuilder
    private var panelOverlay: some View {
        let isOpen = panelShown
        if isOpen || panelStaysBuilt {
            ZStack(alignment: .topTrailing) {
                clickBesidePanel
                    .allowsHitTesting(showsHeader ? panelShownHere : panelFloats)
                ThreadPanelCard(isModal: showsHeader || panelFloats, onEscape: dismissPanel) {
                    ThreadPanelContent(
                        chat: chat, state: panelState, host: panelHost, onClose: { setPanel(shown: false) },
                        closeSide: showsHeader && headerBand == nil ? 44 : TabBar.sidebarButton, tint: style.tint, focus: $panelFocus
                    )
                }
                .padding(.top, showsHeader ? panelButtonTop : ThreadPanel.top)
                .padding(.trailing, showsHeader ? Theme.margin : TabBar.inset)
                .opacity(isOpen ? 1 : 0)
                .allowsHitTesting(isOpen)
                .accessibilityHidden(!isOpen)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.6, anchor: .topTrailing).combined(with: .opacity))
            }
            // On a phone the header's height is measured from the screen's top.
            .ignoresSafeArea(.container, edges: showsHeader ? .top : [])
        }
    }

    /// What is at the top of the chat where the tabs say the rest: back to the thread that
    /// started this one, the panel's button and, with the tabs down the side, the chat's name.
    private var barRow: some View {
        HStack(alignment: .top, spacing: Theme.grid) {
            ParentThreadButton(parent: parentThread, answersKeys: isShown && lightbox?.isOpen != true, onOpen: onBackToParent)
            if titleInBar, !showsStart {
                ChatTitleRow(agent: chat.agent, title: chat.title, mood: avatarMood, style: style, onEditLook: onEditLook)
                    .outOfSight(!isShown)
                    .frame(maxWidth: .infinity)
                    // As far from the sidebar's button as from the panel's, for the middle.
                    .padding(.leading, Theme.grid)
            } else {
                Spacer(minLength: 0)
            }
            // Gone while the panel is open in its place; its room kept, so
            // the chat does not move.
            if panelShown {
                Color.clear
                    .frame(width: TabBar.sidebarButton, height: TabBar.sidebarButton)
                    .accessibilityHidden(true)
            } else {
                // Where the panel's top is (2026-11-01: "should be the
                // same as the panel"), moved, not laid out: the chat stays.
                panelButton(side: TabBar.sidebarButton)
                    .offset(y: titleInBar ? 0 : ThreadPanel.top - Theme.grid)
            }
        }
        // Clear of the sidebar's button over the chat (`SidebarButtonOverChat`).
        .padding(.leading, titleInBar ? TabBar.inset + TabBar.sidebarButton : 0)
        .padding(.trailing, TabBar.inset)
    }

    /// Something for the bar over the chat to hold where what shows there is over the chat
    /// instead: with nothing in it, or a clear colour, the system's soft edge under it is gone,
    /// and the chat is sharp under the name (seen 2026-11-03).
    private var softEdgeRoom: some View {
        Color.black.opacity(0.001)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var chatHeader: some View {
        ChatHeader(
            agent: chat.agent,
            title: chat.title,
            mood: avatarMood,
            style: style,
            canStartNewThread: offersNewThread,
            showsAgent: !showsStart,
            onOpenSidebar: onOpenSidebar,
            onNewThread: onNewThread,
            onEditLook: onEditLook,
            panelButton: panelShownHere ? nil : panelButton(side: 44),
            onPanelButtonTop: { panelButtonTop = $0 }
        )
        // Slid aside for the sidebar, its avatar is past the window's edge,
        // and holds still there.
        .outOfSight(chatIsAside || !isShown)
    }

    private func bandHeader(depth: CGFloat) -> some View {
        ChatBandHeader(
            agent: chat.agent,
            title: chat.title,
            mood: avatarMood,
            style: style,
            canStartNewThread: offersNewThread,
            showsAgent: !showsStart,
            depth: depth,
            onOpenSidebar: onOpenSidebar,
            onNewThread: onNewThread,
            onEditLook: onEditLook,
            panelButton: panelShownHere ? nil : panelButton(side: TabBar.sidebarButton),
            onPanelButtonTop: { panelButtonTop = $0 }
        )
        .outOfSight(chatIsAside || !isShown)
    }

    /// Closes the card over the chat at a tap or click beside it.
    private var clickBesidePanel: some View {
        Color.clear
            .contentShape(.rect)
            .onTapGesture(perform: dismissPanel)
            .accessibilityHidden(true)
    }

    var body: some View {
        screen
            // Out of sight, behind the chat on screen: no focus, and what moves holds still.
            .onChange(of: isShown) { _, shown in
                if shown {
                    if let request = chat.screenRequest { handle(request) }
                } else {
                    // Its text selected, the chat's text view has the keyboard: let go of,
                    // or the keys typed next would go into this chat's draft, out of sight.
                    isComposing = false
                    SelectionClearer.shared.clear(of: proseTyping)
                    // Any other field of it with the keyboard (an answer, a note).
                    OutOfSightFocus.letGoIfHidden()
                }
            }
            // Covered by Settings: let go of the keyboard as when it leaves (`RootView`
            // resigns any other field's).
            .onChange(of: isCovered) { _, covered in
                guard isShown else { return }
                if covered {
                    isComposing = false
                    SelectionClearer.shared.clear(of: proseTyping)
                } else if let request = chat.screenRequest {
                    // What came while Settings was over it, as when the chat comes back.
                    handle(request)
                }
            }
            .outOfSight(!isShown)
            // The words held while it was out of sight, shown at once as it comes back.
            .environment(\.chatCaughtUpAt, chat.caughtUpAt)
            // Nothing in it animates out of sight: each frame of an animation anywhere in the
            // window brings the whole window up to date, and a run's status line changing
            // with each step kept three chats nobody saw animating most of the time.
            // Nor as it comes back with what it held meanwhile, which shows at once.
            .transaction { transaction in
                guard !isShown || chat.caughtUpAt.map({ Date.now.timeIntervalSince($0) < 0.1 }) == true else { return }
                transaction.disablesAnimations = true
                transaction.animation = nil
            }
    }

    /// The chat with its bars: the header or the bar under the tabs over it, the composer
    /// under it.
    private var chatWithBars: some View {
        transcript
            #if targetEnvironment(macCatalyst)
            // The chat fades out as it passes under the window's bar, where the tabs are,
            // and above the composer, which it would otherwise pass under in a band of its
            // own (`scrollEdgeEffectHidden` below).
            // The fade above the composer ends under its top (or the top of the card
            // over it), so the chat runs on lower and shows faintly through the glass.
            .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { composerBar = $0 }
            .mask {
                VStack(spacing: 0) {
                    LinearGradient(stops: TopFade.macStops, startPoint: .top, endPoint: .bottom)
                        .frame(height: TopFade.macFade)
                    Color.black
                    LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: Theme.grid * 3)
                    Color.clear
                        .frame(height: max(composerBar - Self.fadeUnderComposer, 0))
                }
                .ignoresSafeArea()
            }
            // A blur ramping in under the fade, as the phone's edge effect has (2026-10-22: "yes it should add some blur as well on the mac"): the chat going
            // under the bar softens as it fades. One material backdrop with a gradient
            // mask, which the render server draws as the chat scrolls and streams.
            .overlay(alignment: .top) {
                if TopFade.blurs {
                    TopFade.Blur(height: TopFade.macFade, solid: 0.15, eased: true, leadingFade: Theme.grid * 7)
                }
            }
            #else
            // A blur of the app's own reaching a little further down than the system's soft
            // edge under the header, which is as tall as it is whatever the header's height
            // (2026-10-22: "slightly increase the size of the gradient thing that is
            // coming from the top like the one with the blur"). Over the system's, where
            // they meet; one material backdrop with a gradient mask, as on a Mac.
            .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { headerBar = $0 }
            .overlay(alignment: .top) {
                if TopFade.blurs, headerBar > 0 {
                    // Beside a pinned sidebar, where the tabs are, it comes in from its leading
                    // edge as on a Mac (2026-10-23: "the sidebar vs top of the screen gradient
                    // still doenst transition correctly on ipad"). Not by the size class: an
                    // iPhone Duo open and upright is regular, with the sidebar behind the chat.
                    TopFade.Blur(height: headerBar + TopFade.belowHeader, solid: TopFade.phoneSolid,
                                 leadingFade: showsHeader ? 0 : Theme.grid * 7)
                }
            }
            #endif
            // A new thread's start, in the middle of the empty chat and over it, not in
            // it: as it gives way to the first message, nothing in the chat moves.
            .overlay {
                ZStack {
                    if showsStart {
                        NewThreadStart(
                            agent: chat.agent,
                            project: chat.folder.flatMap { $0.isGeneral ? nil : $0.name },
                            mood: avatarMood,
                            style: style,
                            hint: firstThreadHint,
                            pickers: newThreadPickers,
                            onEditLook: onEditLook
                        )
                        .outOfSight(chatIsAside || !isShown)
                        // Over the composer's column, wherever the panel beside it has moved it.
                        .movesWithChatColumn()
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                    }
                }
                // In the middle of the whole window's height, not of the room between the
                // header and the composer; the keyboard still lifts it.
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea(.container)
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.35), value: showsStart)
            }
            .environment(\.chatShownSince, shownSince)
            .background { AmbientGradient(tint: tintsChats ? style.tint : nil, mood: washMood) }
            .safeAreaBar(edge: .top) {
                VStack(spacing: Theme.grid) {
                    if showsHeader, headerBand == nil {
                        chatHeader
                    } else if showsHeader {
                        softEdgeRoom.frame(height: 1)
                    }
                    // Back to the thread that started this one, under the header or, where
                    // the tabs are its header, under them, with the panel's button at the
                    // other end: in the bar, so the chat starts under it, not behind it.
                    if showsHeader {
                        ParentThreadButton(parent: parentThread, answersKeys: isShown && lightbox?.isOpen != true, onOpen: onBackToParent)
                    } else {
                        if titleInBar {
                            // The bar's height alone, under the row over it.
                            softEdgeRoom.frame(height: ThreadPanel.top + TabBar.sidebarButton - TopFade.titleRowLift)
                        } else {
                            barRow
                                .padding(.top, Theme.grid)
                        }
                    }
                    if showsConnectionBanner {
                        ConnectionBanner(problem: connectionProblem, isStopped: connectionIsStopped) {
                            swipeGuard(onEditHost)
                        }
                        // Over the column, so clear of the panel beside it.
                        .frame(maxWidth: WindowLayout.chatColumnWidth)
                        .movesWithChatColumn()
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                // Room under the header for the system's soft edge, which is as tall as the
                // bar it is under: a little more of the chat fades and blurs as it goes
                // under the header (2026-10-22: "slightly increase the size of the
                // gradient thing that is coming from the top like the one with the blur").
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.3), value: showsConnectionBanner)
            }
            // The header's ⌘N, where there is no header: it starts a new thread with
            // nothing drawn, but not while a reply's image is open over the window. A
            // thread is started from the sidebar or the tabs' + otherwise.
            .background {
                if !showsHeader, offersNewThread, lightbox?.isOpen != true, isShown {
                    Button("New thread", action: onNewThread)
                        .keyboardShortcut("n", modifiers: .command)
                        .opacity(0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .task(id: isConnected) {
                // Coming back to the app reconnects within a moment: say nothing
                // unless it takes longer.
                if isConnected {
                    showsConnectionBanner = false
                } else {
                    try? await Task.sleep(for: ChatFeature.connectionGrace)
                    if !Task.isCancelled { showsConnectionBanner = true }
                }
            }
            // Known once the host has said what it is, on each connection: one made again
            // while the app shows it as it was left (`isConnected`) too.
            .task(id: hostIsConnected) {
                if hostIsConnected {
                    await chat.checkHost()
                } else {
                    chat.mcpAuth.clear()
                }
            }
            // Over the chat, not in the bar, where they reach past it: out of a bar's bounds a
            // touch does not reach them (the panel's button's foot, seen under a real tap).
            .overlay(alignment: .top) {
                if showsHeader, let headerBand {
                    bandHeader(depth: headerBand)
                        .ignoresSafeArea(.container, edges: .top)
                } else if titleInBar {
                    // Level with the panel's top.
                    barRow
                        .padding(.top, ThreadPanel.top)
                }
            }
            // The menu of what is being typed, over the chat just above the bar under it, the
            // safe area's edge: in the bar, it made the bar taller as it opened and with each
            // answer, and the chat glided to keep its end in view each time (2026-10-28: "it should not cause the chat to move as it is an overlay"). Hung
            // over the bar's top from inside it, it could not be touched.
            .overlay(alignment: .bottom) {
                let margin = composerMargin
                DraftReader {
                    composerMenu
                        .padding(.horizontal, margin)
                        .padding(.bottom, Theme.grid)
                        .chatColumn()
                        .animation(.easeInOut(duration: 0.15), value: composerMenuShown)
                }
            }
            .safeAreaBar(edge: .bottom) {
                VStack(spacing: Theme.grid) {
                    if hostIsConnected, chat.agent.kind == "droid", !chat.mcpAuth.shownCards.isEmpty || chat.mcpAuth.listFailed {
                        MCPAuthCards(state: chat.mcpAuth, onAction: chat.signIn, onRetry: { chat.refreshMCPAuth() })
                    }
                    if let request = chat.pendingRequest {
                        // The agent is blocked on you. Its question sits above the
                        // composer, where it cannot scroll out of view; a message sent
                        // from the composer instead tells the agent to do something else.
                        RequestCard(request: request, agentName: chat.agent.displayName, mode: chat.mode) { answer in
                            swipeGuard { chat.answer(request, with: answer) }
                        }
                        .id(request.id)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                    if chat.isReadOnly {
                        // A session a terminal has open, only read: there is nothing to
                        // send it, only a fork to continue in.
                        ReadOnlyNote(hostName: hostName, offersFork: offersFork, onFork: onFork)
                    } else {
                        if !chat.state.queued.isEmpty {
                            // Waiting for the turn to end, as the host lists them for
                            // every device: one can be steered in now, or taken off.
                            QueuedList(
                                messages: chat.state.queued,
                                canSteer: chat.state.canSteerQueued,
                                onSteer: { message in swipeGuard { chat.steerQueued(message.id) } },
                                onRemove: { message in swipeGuard { chat.removeQueued(message.id) } },
                                onPlace: { message, placement in swipeGuard { chat.placeQueued(message.id, at: placement) } }
                            )
                            .transition(.opacity)
                        }
                        if chat.editingMessage != nil || chat.isPreparingMessageEdit {
                            EditingMessageRow(isLoading: chat.isPreparingMessageEdit, isSending: chat.isSendingMessageEdit || isWorkingOnMessage) {
                                chat.cancelMessageEdit()
                            }
                            .transition(.opacity)
                        }
                        DraftReader { composer }
                            .disabled(chat.isSendingMessageEdit || chat.isPreparingMessageEdit || isWorkingOnMessage)
                    }
                }
                .padding(.horizontal, composerMargin)
                .bottomRoom()
                .chatColumn()
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.3), value: isComposing)
                .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth(duration: 0.3), value: chat.pendingRequest?.id)
                .animation(.smooth(duration: 0.2), value: chat.state.queued)
            }
            // Also on appearing: an answer can come while another thread is on screen. Kept
            // out of sight, the chat does it as it comes back.
            .onChange(of: chat.screenRequest, initial: true) { _, request in
                guard let request, isShown, !isCovered else { return }
                handle(request)
            }
            .onChange(of: chat.pendingRequest?.id) { _, id in
                // A question needs the keyboard out of the way to be seen.
                if id != nil { isComposing = false }
            }
            .scrollEdgeEffectStyle(.soft, for: .top)
            #if targetEnvironment(macCatalyst)
            // A Mac draws the edge under its window's bar as a band with a line under
            // it, whatever style is asked for, which over the wash is a strip of another
            // blue. The bar's controls are glass and read over the chat without it. The
            // edge above the composer is a grey box across the chat the same way: the
            // chat fades out there instead (the mask above).
            .scrollEdgeEffectHidden(true, for: .top)
            .scrollEdgeEffectHidden(true, for: .bottom)
            #endif
            .onChange(of: chat.turns.last?.outcome) { old, new in
                if old == nil, new == .completed { celebrating = true }
            }
            .onDebugLaunch(DebugLaunch.draft != nil) {
                if chat.composer.text.isEmpty { chat.composer.text = DebugLaunch.draft ?? "" }
            }
            .onDebugLaunch(DebugLaunch.typeBenchPath != nil, after: .seconds(10)) {
                await typeBench()
            }
            .onDebugLaunch(DebugLaunch.focusesComposer, after: .seconds(1)) {
                isComposing = true
            }
            .onDebugLaunch(DebugLaunch.draftImagePath != nil) {
                guard chat.composer.images.isEmpty, let path = DebugLaunch.draftImagePath,
                      let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return }
                for name in ["first", "second"] {
                    if let image = await ImageAttachment.prepared(from: data, name: name) { chat.composer.images.append(image) }
                }
            }
            .task(id: celebrating) {
                guard celebrating else { return }
                try? await Task.sleep(for: ChatFeature.celebration)
                celebrating = false
            }
    }

    /// The panel over the chat (`ThreadPanel`), over the chat with its bars, and inside what
    /// the chat opens over itself, so that the changes open from it as a turn's do.
    private func withPanel(_ content: some View) -> some View {
        content
            .overlay(alignment: .topTrailing) { panelOverlay }
            .task(id: panelShown) {
                guard !panelShown else { return panelStaysBuilt = true }
                panelState.stopFetchingChanges()
                try? await Task.sleep(for: .seconds(0.3))
                if !Task.isCancelled { panelStaysBuilt = false }
            }
            .modifier(PanelAsking(chat: chat, state: panelState, isShown: isShown, isOpen: panelShown, isConnected: hostIsConnected))
            .onChange(of: isShown) { _, shown in
                if !shown {
                    panelShownHere = false
                    panelFloats = false
                    panelState.stopFetchingChanges()
                }
            }
            // The column moved left of the middle as far as the panel beside it needs.
            .environment(\.chatColumnShift, panelBeside ? ThreadPanel.columnShift(chatWidth: chatWidth) : 0)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { chatResized(to: $0) }
    }

    private var screen: some View {
        withPanel(chatWithBars)
            // What the chat opens over itself, from here and not from the rows that ask:
            // a row the lazy transcript lets go of, or a line that comes and goes, would
            // take it with it. Select Text from any copy menu in the chat; a widget
            // expanded; the detail of a subagent or workflow from its line, while it is
            // still on the line; what a turn changed.
            .onChange(of: debugMessageForkTurn?.id, initial: true) { _, id in
                guard id != nil, let turn = debugMessageForkTurn,
                      let opener = turn.items.first(where: \.isUserMessage),
                      case let .user(message) = opener.content, let checkpoint = message.checkpoint,
                      let before = DebugLaunch.opensMessageFork else { return }
                openedMessageForkForDebug = true
                messageAction(message, checkpoint: checkpoint, before: before, focus: !Platform.isMac)
            }
            .alert("Couldn’t finish", isPresented: Binding(get: { messageActionProblem != nil }, set: { if !$0 { messageActionProblem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(messageActionProblem ?? "")
            }
            .onChange(of: debugFileUndoCheckpoint?.id, initial: true) { _, id in
                guard id != nil, let checkpoint = debugFileUndoCheckpoint else { return }
                openedFileUndoForDebug = true
                fileUndo = checkpoint
            }
            .sheet(isPresented: Binding(get: { fileUndo != nil }, set: { if !$0 { fileUndo = nil } })) {
                if let checkpoint = fileUndo {
                    FileUndoSheet(canUndo: canUndoFiles && chat.fileUndoTurn?.fileUndoCheckpoint == checkpoint,
                                  workingDirectory: chat.thread?.workingDirectory, turnDiff: chat.fileUndoTurn?.diff,
                                  onDone: { fileUndo = nil }, onPreview: { try await onPreviewFileUndo(checkpoint) },
                                  onUndo: { try await onUndoFiles(checkpoint, $0) })
                }
            }
            .selectsTextHere()
            .expandsWidgetsHere()
            .showsTurnDiffsHere()
            // "Open File" on a file a turn changed opens it in the viewer below.
            .opensChangedFiles()
            // The thread's files on the Mac: the images replies show, and a file a tool
            // row or a link names, opened over the chat (feature file_read).
            .showsFilesHere(chat)
            // One gone from the line is let go of, so that it does not open again by
            // itself should the same one come back.
            .onChange(of: chat.shownSubagents) {
                if let id = openedSubagent, !chat.shownSubagents.contains(where: { $0.id == id }) { openedSubagent = nil }
                // PORTALS_DEBUG_SUBAGENT: the first that can be read, opened once, for screenshots.
                if DebugLaunch.opensSubagent != nil, !Self.debugOpenedSubagent, let readable = chat.shownSubagents.first(where: \.canRead) {
                    Self.debugOpenedSubagent = true
                    openedSubagent = readable.id
                }
            }
            .sheetOrPanel(
                Binding(
                    get: { openedSubagent.flatMap { id in chat.shownSubagents.contains { $0.id == id } ? id : nil } },
                    set: { openedSubagent = $0 }
                ),
                width: 620
            ) { id, close in
                SubagentsLine.detail(of: id, in: chat.shownSubagents, read: chat.readsSubagents, onStop: { chat.stopSubagent($0) }, onDone: close)
            }
            // Any of the above open over the chat. On a Mac its panel takes the composer's
            // focus while it is open (the chat under it is disabled), and on an iPhone or iPad
            // a touch on the page in the sheet takes it with the keyboard up; either gives it
            // back as it closes, which is not you starting to type: a chat scrolled up to a visual,
            // expanded and closed again, was glided to its end (2026-10-20). It
            // stays where it was, the visual where you left it.
            .onPreferenceChange(PanelOpenKey.self) { isOpen in
                guard isOpen != focusWithApp.isCovered else { return }
                guard !isOpen else { return focusWithApp.coverOpened() }
                let token = focusWithApp.coverClosed()
                Task {
                    try? await Task.sleep(for: FocusWithApp.settle)
                    focusWithApp.coverSettled(token)
                }
            }
            // A reply's image opened on its own over the window takes the composer's focus,
            // and the keyboard with it, which would cover the image (and on a Mac take what
            // is typed); and gives it back as it closes, as a sheet does. Open over the chat,
            // it counts as a panel (`PanelOpenKey`, from `showsFilesHere`): the focus coming
            // back is not you starting to type, and the chat stays where it was.
            .onChange(of: lightbox?.isOpen == true) { _, isOpen in
                if isOpen {
                    composedUnderPicture = isComposing
                    isComposing = false
                } else if composedUnderPicture {
                    composedUnderPicture = false
                    isComposing = true
                }
            }
    }

    private var debugFileUndoCheckpoint: MessageCheckpoint? {
        guard DebugLaunch.opensFileUndo, !openedFileUndoForDebug, isShown, !isCovered, !hidesChat,
              !chat.isLoadingHistory, canUndoFiles else { return nil }
        return chat.fileUndoTurn?.fileUndoCheckpoint
    }

    private var debugMessageForkTurn: Turn? {
        guard !openedMessageForkForDebug, isShown, !isCovered, !hidesChat,
              !chat.isLoadingHistory, canForkMessage, let before = DebugLaunch.opensMessageFork else { return nil }
        return chat.turns.first { turn in
            guard !turn.isRunning, let opener = turn.items.first(where: \.isUserMessage),
                  case let .user(message) = opener.content, let checkpoint = message.checkpoint else { return false }
            if before { return checkpoint.canEdit }
            return checkpoint.canFork
        }
    }

    /// Does what a command or the app asked of the screen (`ThreadController.screenRequest`).
    private func handle(_ request: ThreadController.ScreenRequest) {
        chat.screenRequest = nil
        switch request {
        case .newThread:
            if offersNewThread { onNewThread() }
        case .showModels:
            isComposing = false
            showsModelPicker = true
        case let .draft(text):
            chat.composer.text = text
            isComposing = true
        case let .restore(text):
            if chat.composer.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { chat.composer.text = text }
            isComposing = true
        case .focusComposer:
            isComposing = true
        }
    }

    /// The wash moves while the agent is at work, and holds still, as at rest, while it
    /// only waits for your answer to an approval, a question or a plan: nothing goes on
    /// until you answer. It eases between the two, and moves again once the agent is
    /// back at work. Still too while the host is out of reach (`showsConnectionBanner`):
    /// what the agent does is not known until it is back, and a run cut off there kept
    /// the wash and the avatar going for as long as the Mac was away (9.2% of a core,
    /// where the thread at rest takes 0.7%).
    private var washMood: AmbientMood {
        chat.isRunning && !chat.waitsOnlyOnUser && !showsConnectionBanner ? .working : .calm
    }

    /// What the avatar shows: waiting while the agent is blocked on you, talking while
    /// the reply is being written, thinking through the rest of a run, listening while
    /// you type, a brief happy beat after a reply, idle otherwise; and while the host is
    /// out of reach, none of the run's.
    private var avatarMood: AgentMood {
        if chat.pendingRequest != nil { return .waiting }
        if chat.isRunning, !showsConnectionBanner {
            return chat.runStatus == nil ? .talking : .thinking
        }
        if celebrating { return .happy }
        if isComposing || focusWithApp.leftWithApp { return .listening }
        return .idle
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    // Offscreen turns keep explicit lightweight space; TranscriptTurn
                    // builds their content only near the viewport. This avoids both an
                    // eager transcript's rendering cost and a lazy stack's changing
                    // estimate for every unseen row as a tall visual enters view.
                    VStack(alignment: .leading, spacing: Theme.grid * 3) {
                        Color.clear
                            .frame(height: 0)
                            .id(Self.topID)
                            .accessibilityHidden(true)
                        if chat.state.hasEarlierHistory {
                            // An ongoing conversation opens with its last turns: the ones
                            // before come as its top is scrolled to.
                            EarlierTurns(isLoading: chat.isLoadingEarlier) { chat.loadEarlier(when: untilLetGo) }
                                .onScrollVisibilityChange(threshold: 0.01) { visible in
                                    if visible, hasSettled { chat.loadEarlier(when: untilLetGo) }
                                }
                        }
                        if chat.isEmpty {
                            if chat.isLoadingHistory {
                                // A thread with nothing of it on the device yet: not the
                                // intro of a new one while the host's copy comes, nor a
                                // spinner while the host is out of reach (the banner says so).
                                if isConnected { HistoryLoading() }
                            } else if !showsStart {
                                // A thread on the host with nothing to show (its history
                                // could not be had): the line as before, under its header.
                                intro
                            }
                        }
                        let turns = chat.turns
                        let listing = turns.turnListingStartedThreads
                        let lastID = turns.last?.id
                        // In blocks compared as a whole (`TranscriptBlock`): a streamed
                        // word builds the block with the last turn, not every turn.
                        let blocks = TranscriptBlocks.ranges(count: turns.count, origin: chat.state.turnOrigin)
                        // The last two blocks, whatever their places (they go below 0 as earlier turns come).
                        let lastBlocks = (blocks.last?.index ?? 0) - 1
                        ForEach(blocks, id: \.index) { block in
                            let blockTurns = turns[block.turns]
                            let hasLast = blockTurns.last?.id == lastID
                            let hasRunning = blockTurns.contains(where: \.isRunning)
                            TranscriptBlock(turns: blockTurns, heights: chat.transcriptHeights, shows: .init(
                                status: hasLast ? chat.runStatus : nil,
                                plan: hasRunning ? chat.state.runningPlan : nil,
                                canRetry: chat.canRetry,
                                offersMessageFork: chat.offersMessageFork,
                                canForkMessage: canForkMessage,
                                fileUndoTurn: chat.fileUndoTurn.flatMap { undo in blockTurns.contains { $0.id == undo.id } ? undo.id : nil },
                                canUndoFiles: canUndoFiles,
                                listing: listing.flatMap { id in blockTurns.contains { $0.id == id } ? id : nil },
                                staysBuilt: block.index >= lastBlocks || hasRunning
                            )) { turn in
                                let shows = TurnView(
                                    turn: turn,
                                    // What the agent is doing shows under the turn it is on.
                                    status: turn.id == lastID ? chat.runStatus : nil,
                                    plan: turn.isRunning ? chat.state.runningPlan : nil,
                                    canRetry: chat.canRetry,
                                    onRetry: { swipeGuard { chat.retry(turn.id) } },
                                    offersMessageFork: chat.offersMessageFork,
                                    canForkMessage: canForkMessage,
                                    onForkMessage: { message, checkpoint, before in
                                        swipeGuard { messageAction(message, checkpoint: checkpoint, before: before) }
                                    },
                                    offersFileUndo: turn.id == chat.fileUndoTurn?.id,
                                    canUndoFiles: canUndoFiles,
                                    onUndoFiles: { checkpoint in swipeGuard { fileUndo = checkpoint } },
                                    // The latest ended turn's footer lists the threads the agent started.
                                    startedThreads: turn.id == listing
                                        ? StartedThreadsLink(threads: startedThreads, onOpen: onOpenThread, onShare: onShareThread) : nil
                                )
                                // The last turn stays built, ended or not, while the chat
                                // is scrolled away from it: let go of as it ended, it kept the
                                // height it was measured at while running, with its status line
                                // for a footer and its reply only as far as it had played in
                                // (Claude Code sends the reply whole just before the turn
                                // ends), and grew by the rest as a flick down reached it,
                                // which left the chat short of its end.
                                TranscriptTurn(
                                    heights: chat.transcriptHeights,
                                    keepsBuilt: turn.isRunning || turn.id == lastID,
                                    shows: shows
                                ) {
                                    shows
                                        .equatable()
                                        .returnProbe("turn:\(turn.id)")
                                        .blankProbeTurn(turn.id)
                                        .notesBuilt(turn.id, in: opening) { watchForBlank(proxy) }
                                }
                                .equatable()
                                .id(turn.id)
                            }
                            .equatable()
                        }
                        // Sent while the agent was busy, and not part of a turn yet. One
                        // the host lists as waiting shows above the composer instead.
                        ForEach(chat.state.pending.filter { $0.queueID == nil }) { pending in
                            UserBubble(message: pending.message, id: pending.id, isWaiting: true)
                                .notesBuilt(pending.id, in: opening) { watchForBlank(proxy) }
                                .id(pending.id)
                                .transition(.opacity)
                        }
                        if let command = chat.commandInProgress {
                            RunStatusLine(status: .note("Running \(command)"))
                                .transition(.opacity)
                        }
                    }
                    .padding(.horizontal, ChatFeature.margin)
                    .padding(.top, Theme.grid)
                    .chatColumn()
                    .onGeometryChange(for: CGFloat.self) {
                        max(0, min($0.size.width, WindowLayout.chatColumnWidth) - ChatFeature.margin * 2)
                    } action: { transcriptWidth = $0 }
                    .environment(\.widgetLayoutWidth, transcriptWidth)
                    .environment(\.transcriptAnchor, transcriptAnchor)
                    .background {
                        if let transcriptAnchor {
                            TranscriptAnchor.ScrollFinder(anchor: transcriptAnchor).accessibilityHidden(true)
                        }
                    }
                    // Measurements of turns gone are let go when the count changes, not at
                    // every streamed word.
                    .onChange(of: chat.turns.count, initial: true) {
                        let ids = chat.turns.map(\.id)
                        chat.transcriptHeights.keep(Set(ids))
                        transcriptAnchor?.turns(ids)
                    }
                    .onChange(of: chat.turns.first?.id) { old, _ in keepPlace(asTurnsCameBefore: old) }
                    .environment(\.openRows, openRows)
                    .environment(\.dismissCommandAnswer, chat.commandAnswers)
                    .blankProbeMark("stack")
                    // Whether the stack reaches into the screen: with none of its rows
                    // built, a chat it left blank, rather than one scrolled past its turns.
                    .onGeometryChange(for: Bool.self) { $0.frame(in: .scrollView).maxY > 1 } action: { inView in
                        opening.builtTurns.stackInView = inView
                    }
                    // Agents set to work in the background, which is where they are once
                    // the turn that started them is over, the threads the agent started
                    // and the commands it left running: one line (`ChatFoot`).
                    ChatFoot(
                        subagents: chat.shownSubagents, threads: startedThreads,
                        listedInFooter: chat.turns.turnListingStartedThreads != nil, isRunning: chat.isRunning,
                        opened: $openedSubagent,
                        onStop: { chat.stopSubagent($0) }, onOpen: onOpenThread, onShare: onShareThread
                    ) {
                        // The line is the end of the chat: once its list has opened or
                        // closed, bring the end back into view.
                        followsEnd = true
                        scrollToEnd(proxy, smoothly: true)
                    }
                    // The end marker is the bottom margin itself, so scrolling to it
                    // shows the whole reply clear of the composer.
                    Color.clear
                        .frame(height: Theme.grid * 2)
                        .blankProbeMark("end")
                        .blankProbeFindsScrollView()
                        .id(Self.bottomID)
                        .accessibilityHidden(true)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: !hidesChat && isShown, initial: true) { _, inView in
                transcriptAnchor?.isInView = inView
                transcriptAnchor?.followsEnd = $followsEnd
            }
            // Out of sight until it sits at its end: the first frames of a long thread
            // can still precede the end turn's first real measurement. Moving to the
            // corrected end after showing it was seen as a little scroll.
            .opacity(hidesChat ? 0 : 1)
            .onChange(of: hidesChat, initial: true) { _, hides in
                OpenProbe.hides(chat.thread?.id.rawValue, hides)
            }
            .reportsOpening(of: chat.thread?.id.rawValue, turns: chat.turns.count, isShown: isShown)
            .blankProbe(thread: chat.thread?.id.rawValue, turnIDs: chat.turns.map(\.id), hidden: hidesChat, bottomID: Self.bottomID)
            .gapProbeScrollRun(first: { Self.topID }, bottom: Self.bottomID) { proxy.scrollTo($0, anchor: $1) }
            // A chat that has left the screen (another thread opened) is not looked at
            // for being blank: the stack lets go of all its rows as it goes.
            .onAppear {
                ReplyImages.prepareSizes()
                opening.isGone = false
                WidgetPool.shared.chatShown(screen: widgetScreen, chat: ObjectIdentifier(chat), turns: chat.turns.map(\.id))
            }
            // Kept out of sight (`isShown`), it is not looked at for being blank either,
            // until it is back.
            .onChange(of: isShown) { _, shown in
                opening.isGone = !shown
                if shown { watchForBlank(proxy) }
            }
            .onDisappear {
                opening.isGone = true
                // Its visuals' pages are kept for two minutes, then let go of.
                WidgetPool.shared.chatLeft(screen: widgetScreen, chat: ObjectIdentifier(chat), turns: chat.turns.map(\.id))
                // Folds belong to this screen and reset on navigation. Measurements
                // taken with custom folds open must reset with them: those of the turns
                // whose folds were opened or closed, not every turn's, which a status line
                // opened while the agent thought did (its live thought keeps itself open),
                // and the whole chat came back on estimates.
                if openRows.hasChoices {
                    let chosen = openRows.chosenItems
                    chat.transcriptHeights.forget(chat.turns.lazy.filter { turn in chosen.contains(turn.id) || turn.items.contains { chosen.contains($0.id) } }.map(\.id))
                }
            }
            .defaultScrollAnchor(chat.isEmpty ? .top : .bottom, for: .initialOffset)
            // While the chat keeps to its end, it stays there as the content grows, in the
            // same layout: a streamed line that wraps, a turn above it measured. Followed
            // a frame later instead (`scrollToEnd` from the geometry's change), the end
            // was seen to move 20 times in a thread opened while its reply streamed (open
            // bench `cold:running`, iPhone simulator; since the transcript's plain stack).
            // Not while scrolled up or being scrolled (`followsEnd` false), where an anchor
            // shifted the chat mid-scroll, nor while a thread opening finds its end out of
            // sight (`settle`), where it made long threads open later. A new thread, never
            // hidden, has it from the start.
            .defaultScrollAnchor(followsEnd && (hasSettled || opening.opensExisting == false) ? .bottom : nil, for: .sizeChanges)
            .onChange(of: isComposing) { _, composing in
                // The composer's focus going with the app (another app in front, the window
                // hidden) and coming back with it is not you starting to type, nor going
                // under a panel opened over the chat and coming back as it closes (a visual
                // expanded on a Mac): the chat stays where it was, scrolled up or not.
                guard composing else { return focusWithApp.lost(appActive: Platform.isAppActive) }
                guard focusWithApp.gained(), !chat.isEmpty else { return }
                followsEnd = true
                scrollToEnd(proxy, smoothly: true)
            }
            // Focus that did not come back with the app was moved elsewhere on purpose
            // meanwhile (a card asking for an answer): let go of, the avatar stops listening
            // and the next focus is you starting to type.
            .onReceive(NotificationCenter.default.publisher(for: Platform.appBecameActive)) { _ in
                let token = focusWithApp.appBecameActive()
                guard focusWithApp.leftWithApp else { return }
                Task {
                    try? await Task.sleep(for: FocusWithApp.settle)
                    guard Platform.isAppActive else { return }
                    focusWithApp.settled(token, composing: isComposing)
                }
            }
            // A key typed while the chat's text has the focus (`ProseTextView`) goes to the
            // composer, which takes the focus as a click on it would.
            // Only from this chat's own text (`proseTypingTarget`): with two windows open, a
            // key typed on the text of one went into the drafts of both.
            .onReceive(NotificationCenter.default.publisher(for: ProseSelection.typed)) { note in
                guard note.object as AnyObject? === proseTyping, isShown,
                      let typed = note.userInfo?["text"] as? String, !chat.isReadOnly else { return }
                chat.composer.text += typed
                isComposing = true
            }
            .environment(\.proseTypingTarget, proseTyping)
            // What you send (a message, a command, a retry) brings the end into view, and the
            // chat keeps to it to show what that becomes there: the turn it opens, the
            // command's answer, the turn it waited for on the host's list. Scrolled up after
            // sending, the chat stays where you put it.
            .onChange(of: chat.sentHere) {
                followsEnd = true
                scrollToEnd(proxy, smoothly: true)
            }
            // A new message scrolls to it, and the chat follows the reply, while the chat
            // keeps to its end. A turn begun on another device, or caught up as the app
            // comes back, leaves a chat scrolled up to read where it is.
            .onChange(of: lastMessageID) {
                guard followsEnd else { return }
                scrollToEnd(proxy, smoothly: true)
            }
            // Follow the end: as the reply grows or the bottom edge moves (keyboard,
            // composer), keep the end in view, unless you're scrolling. The app's own
            // animated scrolls don't pause it: one cut short by the keyboard can leave
            // the phase at `.animating` for good.
            .onScrollGeometryChange(for: Bool.self) { geometry in
                abs(ScrollExtent.endDistance(geometry)) < 1
            } action: { _, atEnd in
                isAtEnd = atEnd
            }
            .returnProbeScroll("chat-scroll")
            // Where the end is while the thread settles, kept where nothing is drawn
            // again for it.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                ScrollExtent.endDistance(geometry)
            } action: { _, distance in
                opening.distance = distance
            }
            // Past the end, with nothing but blank under the last reply: the lazy stack's
            // guess at a long thread's height can shrink under the chat as the turns near
            // its end are laid out, which leaves it scrolled below them until it is
            // scrolled by hand. Brought back to the end at once, unless it is being
            // scrolled (a bounce at the end goes past it too).
            .onScrollGeometryChange(for: Bool.self) { geometry in
                ScrollExtent.endDistance(geometry) < -1
            } action: { _, isPastEnd in
                if isPastEnd { AppLog.scroll.notice("past end; by hand \(isScrollingByHand, privacy: .public) phase \(String(describing: scrollPhase), privacy: .public)") }
                guard isPastEnd, !isScrollingByHand else { return }
                // Scrolled up, a turn above that shrank takes the chat past its end in the
                // layout the anchor moves the offset with it, in an order not known: moved
                // to the end as well, the chat went to its end, or as far above where it
                // was as the turn shrank (review of 2026-10-26). Looked at again once the
                // anchor has had its say, and moved only if still past the end.
                if transcriptAnchor?.holds == true {
                    Task {
                        try? await Task.sleep(for: .milliseconds(50))
                        guard opening.distance < -1, !isScrollingByHand, !opening.isGone else { return }
                        AppLog.scroll.notice("still past end by \(Int(-opening.distance), privacy: .public): to the end")
                        proxy.scrollTo(Self.bottomID, anchor: .bottom)
                    }
                    return
                }
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            .onScrollGeometryChange(for: ScrollExtent.self) { geometry in
                ScrollExtent(geometry)
            } action: { old, new in
                if abs(new.contentHeight - old.contentHeight) >= 20 {
                    AppLog.scroll.notice("content \(Int(old.contentHeight), privacy: .public) -> \(Int(new.contentHeight), privacy: .public) (\(Int(new.contentHeight - old.contentHeight), privacy: .public)); from end \(Int(opening.distance), privacy: .public); phase \(String(describing: scrollPhase), privacy: .public); follows \(followsEnd, privacy: .public)")
                }
                opening.contentHeight = new.contentHeight
                opening.fits = new.fits
                // A single turn is always built. Once it fits, reveal it in this
                // layout, including history arriving after an empty chat already fit.
                // More turns can have estimated heights and still settle as before.
                if Platform.isMac, new.fits, new.contentHeight > 0, chat.turns.count == 1, hidesChat,
                   !DebugLaunch.revealsAfterSettling {
                    revealChat(proxy)
                }
                guard followsEnd, !isScrollingByHand else { return }
                // Let go of past its end, the chat is brought back by `returnFromPastEnd`
                // alone: a reply streaming meanwhile changes the content's height every few
                // words, and moved to the end at each, the bounce jumped there in one frame.
                guard !(opening.returnsFromPastEnd && opening.distance < -1) else { return }
                // The keyboard or the composer moving the bottom edge is glided with,
                // once the chat is in view.
                scrollToEnd(proxy, smoothly: new.bottomInset != old.bottomInset && !hidesChat)
            }
            .onScrollPhaseChange { old, phase, context in
                AppLog.scroll.notice("phase \(String(describing: old), privacy: .public) -> \(String(describing: phase), privacy: .public); from end \(Int(ScrollExtent.distanceFromEnd(context.geometry)), privacy: .public); content \(Int(context.geometry.contentSize.height), privacy: .public); at \(Int(context.geometry.visibleRect.minY), privacy: .public)")
                scrollPhase = phase
                switch phase {
                case .interacting:
                    // You're scrolling: the chat stops following until you let go at the end,
                    // and is not brought back from past its end meanwhile.
                    followsEnd = false
                    opening.pastEndChecks += 1
                    opening.returnsFromPastEnd = false
                case .idle:
                    if old == .interacting || old == .decelerating {
                        followsEnd = ScrollExtent.distanceFromEnd(context.geometry) < 40
                        // Left below the last reply, with blank under it: the turns near
                        // the end, built as a fast flick reached them, came to less than
                        // the space kept for them, and the chat stayed past its end
                        // (2026-10-25: "if i scroll up a bit and then scroll down
                        // very quickly ... theres a lot of space under"). Brought back to
                        // its end once at rest (`returnFromPastEnd`): while it was scrolled
                        // by hand, the check for being past the end let it be, and is not
                        // made again until that changes.
                        if ScrollExtent.endDistance(context.geometry) < -1 {
                            returnFromPastEnd(proxy)
                        }
                    } else if followsEnd {
                        // An animated scroll aims where the end was when it started;
                        // the reply may have grown since.
                        proxy.scrollTo(Self.bottomID, anchor: .bottom)
                    }
                default:
                    break
                }
            }
            // Safeguard: once a reply ends, check twice more that its end is in view,
            // after the text has caught up.
            .task(id: lastTurnState) {
                // Once a turn ends while the thread is on screen; the thread opening is
                // `settle`'s.
                guard opening.lastTurnState != nil else {
                    opening.lastTurnState = lastTurnState
                    return
                }
                opening.lastTurnState = lastTurnState
                guard let turn = chat.turns.last, !turn.isRunning else { return }
                for delay in [0.3, 1.0] {
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled else { return }
                    if followsEnd, !isScrollingByHand {
                        scrollToEnd(proxy, smoothly: true)
                    }
                }
            }
            // Once a thread opens with something in it, and once what was fetched for
            // it arrives: put at its end out of sight, then shown.
            .task(id: chat.isEmpty) {
                await settle(proxy)
            }
            // And after that, as a safety net, running or not: a long one's turns near
            // the end are laid out, and the host's copy may take the place of the one kept
            // here, in the moments after its first frame. When the end is not in view, to
            // it; when the chat sits there blank, its lazy stack having built none of its
            // rows (opened right after a relaunch, a long thread was seen blank until
            // scrolled by hand), to its last turn and then to the end (`repairIfBlank`).
            // At the end with its turns shown, there is nothing to do, and nothing to be
            // seen.
            .task {
                for delay in [0.3, 1.0, 2.5] {
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled else { return }
                    guard !isScrollingByHand, !hidesChat else { continue }
                    if await repairIfBlank(proxy) { continue }
                    guard followsEnd, abs(opening.distance) >= 1, !opening.isGone, !hidesChat,
                          !opening.returnsFromPastEnd else { continue }
                    if DebugLaunch.settlesAsBefore, let last = chat.turns.last?.id {
                        proxy.scrollTo(last, anchor: .bottom)
                    }
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
        }
    }

    /// A new thread's start is shown in the middle of the chat (`NewThreadStart`), with the
    /// header's avatar there: while the thread is not on the host yet (its first message
    /// makes it there) and has nothing in it. One on the host whose history could not be
    /// had keeps its header, with its title.
    private var showsStart: Bool {
        chat.thread == nil && chat.isEmpty && !chat.isLoadingHistory && !DebugLaunch.newThreadAsBefore
    }

    /// The start of a new thread as it was before 2026-10-23 (`PORTALS_DEBUG_NEW_THREAD=before`):
    /// a one-line intro under the header, naming the folder a coding agent works in, and on
    /// a Mac's first thread, where the rest is.
    private var intro: some View {
        VStack(alignment: .leading, spacing: Theme.grid) {
            Text(
                chat.folder.flatMap { $0.isGeneral ? nil : $0 }.map { "What should \(chat.agent.displayName) work on in \($0.name)?" }
                    ?? "What should \(chat.agent.displayName) work on?"
            )
                .font(.app.body)
                .foregroundStyle(.secondary)
            if let firstThreadHint {
                Text(firstThreadHint)
                    .font(.app.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Scrolls to the end of the chat, with an animation when asked and when there is
    /// somewhere to go: an animated scroll to where the chat already is never ends,
    /// and the scroll view reports itself animating until something else moves it.
    /// (`isAtEnd` is as of the last layout.)
    private func scrollToEnd(_ proxy: ScrollViewProxy, smoothly: Bool) {
        if smoothly {
            guard !isAtEnd else { return }
            withAnimation(.smooth) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
        } else {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
    }

    /// Brings a chat left past its end by a scroll back to its end, once it has come to
    /// rest there. On a Mac's trackpad the scroll says it is idle while the chat still
    /// bounces back from past its end, and moved to the end then, it jumped there in one
    /// frame (by up to 172 points in the user's own scroll log of 2026-10-26): it is looked
    /// at again until it has stopped moving, and moved only if it is still past the end,
    /// gliding back over a small gap as a bounce would, and at once over a large one,
    /// left by content that shrank under it. A scroll by hand meanwhile calls it off.
    private func returnFromPastEnd(_ proxy: ScrollViewProxy) {
        opening.pastEndChecks += 1
        let check = opening.pastEndChecks
        opening.returnsFromPastEnd = true
        Task {
            defer { if check == opening.pastEndChecks { opening.returnsFromPastEnd = false } }
            var last = opening.distance
            for _ in 0..<8 {
                try? await Task.sleep(for: .milliseconds(150))
                guard check == opening.pastEndChecks, !opening.isGone, scrollPhase == .idle else { return }
                let distance = opening.distance
                // Bounced back to its end, or near enough not to be moved.
                guard distance < -1 else { return }
                let isStill = abs(distance - last) < 0.5
                last = distance
                if isStill { break }
            }
            guard check == opening.pastEndChecks, !opening.isGone, scrollPhase == .idle, opening.distance < -1 else { return }
            let gap = -opening.distance
            AppLog.scroll.notice("at rest past end by \(Int(gap), privacy: .public): to the end")
            if gap > Self.glidesBackUpTo {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            } else {
                withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            }
        }
    }

    /// The largest gap past the end a chat at rest glides back over (`returnFromPastEnd`).
    private static let glidesBackUpTo: CGFloat = 300

    /// Whether the chat is kept out of sight while it finds its end: a thread opened with
    /// something in it, or once the host's copy of it arrives, until `settle` has put it
    /// at its end. A new thread is never hidden, nor one already shown.
    private var hidesChat: Bool {
        // As the screen first saw the thread: a new thread gets a thread on the host
        // with its first message, which must not hide it.
        if opening.opensExisting == nil { opening.opensExisting = chat.thread != nil }
        guard !hasSettled, !chat.isEmpty else { return false }
        return opening.opensExisting == true
    }

    /// Puts a thread that opens at its end before it is shown: to its last turn, which
    /// the lazy stack then lays out for real, and to the end marker, frame after frame,
    /// until it is there and its height holds (`EndSettling`), then shows it at once.
    /// Never longer than `EndSettling.limit`, so a thread is never blank for long.
    private func settle(_ proxy: ScrollViewProxy) async {
        guard hidesChat else { return }
        var settling = EndSettling()
        let display = DisplayFrames()
        defer { display.stop() }
        var toLastTurn = true
        func moveToEnd() {
            if DebugLaunch.settlesAsBefore {
                if let last = chat.turns.last?.id { proxy.scrollTo(last, anchor: .bottom) }
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
                return
            }
            // One move a frame: to the last turn, then to the end marker. Both in one
            // frame, the second undid the first, and a long thread ending on turns shorter
            // than the stack's guess opened blank, at the end of a guess its rows do not
            // reach, where the stack built none of them (docs/blank-open.md).
            if toLastTurn, let last = chat.turns.last?.id {
                proxy.scrollTo(last, anchor: .bottom)
            } else {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
            toLastTurn.toggle()
        }
        moveToEnd()
        // Looked at once a frame, after the frame before was laid out.
        for await _ in display.frames {
            guard !Task.isCancelled else { return }
            if settling.frame(distance: opening.distance, height: opening.contentHeight, fits: opening.fits) { break }
            if EndSettling.needsMove(distance: opening.distance) { moveToEnd() }
        }
        guard !Task.isCancelled else { return }
        revealChat(proxy)
    }

    private func revealChat(_ proxy: ScrollViewProxy) {
        guard !hasSettled else { return }
        var shown = Transaction()
        shown.disablesAnimations = true
        withTransaction(shown) { hasSettled = true }
        watchForBlank(proxy)
    }

    /// A chat on screen whose lazy stack built none of its rows (`BuiltTurns`), for a few
    /// frames, is moved to its last turn, which the stack then builds for real, and once
    /// it has, to its end if it keeps to it; still blank, to the turn before the last,
    /// which moves it where the last one may not (the stack's guess already putting the
    /// chat there). Two moves at most each time it goes blank, one at a time. Scrolling by
    /// hand brought such a chat back; a move to the end marker alone did not, nor a turn
    /// and the end marker in one frame, where the second undid the first. True when it
    /// moved.
    @discardableResult
    private func repairIfBlank(_ proxy: ScrollViewProxy, from caller: String = "net") async -> Bool {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn {
            BlankProbe.write([
                "event": "repair-look", "from": caller, "thread": chat.thread?.id.rawValue ?? "",
                "built_none": opening.builtTurns.isEmpty, "stack_in_view": opening.builtTurns.stackInView,
                "blank": opening.builtTurns.isBlank(hasTurns: !chat.turns.isEmpty),
                "hides": hidesChat, "by_hand": isScrollingByHand, "follows": followsEnd,
            ])
        }
        #endif
        guard !DebugLaunch.settlesAsBefore, !opening.isGone, !hidesChat, !isScrollingByHand,
              !opening.isRepairing, await staysBlank(),
              // Again, after the frames looked at, in which the chat may have been left for
              // another tab's: kept out of sight, it would be moved where it was not left.
              !opening.isGone, !hidesChat, !isScrollingByHand, !opening.isRepairing,
              let move = opening.builtTurns.nextMove(hasTurns: !chat.turns.isEmpty),
              let turn = move == 1 ? chat.turns.last?.id : (chat.turns.dropLast().last ?? chat.turns.last)?.id
        else { return false }
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        if BlankProbe.isOn { BlankProbe.write(["event": "repair-move", "move": move, "from": caller, "thread": chat.thread?.id.rawValue ?? ""]) }
        #endif
        opening.isRepairing = true
        defer { opening.isRepairing = false }
        proxy.scrollTo(turn, anchor: .bottom)
        // To the end only once the stack has built a row there: moved to the end marker
        // sooner, the chat was back where it was blank.
        if await rowBuilt(within: 6), followsEnd, !isScrollingByHand, !opening.isGone, !hidesChat {
            proxy.scrollTo(Self.bottomID, anchor: .bottom)
        }
        // Looked at again, for the other move should this one have built nothing.
        watchForBlank(proxy)
        return true
    }

    /// Whether the lazy stack has built a row of the chat, now or within `frames` frames.
    private func rowBuilt(within frames: Int) async -> Bool {
        if !opening.builtTurns.isEmpty { return true }
        let display = DisplayFrames()
        defer { display.stop() }
        var seen = 0
        for await _ in display.frames {
            if !opening.builtTurns.isEmpty { return true }
            seen += 1
            if seen >= frames { return false }
        }
        return false
    }

    /// Whether the chat is blank (`BuiltTurns`) and stays so for a few frames: a frame or
    /// two with nothing built, as the stack lets go of a row and builds the next, is not,
    /// and moving it then would be seen.
    private func staysBlank(frames: Int = 3) async -> Bool {
        let isBlank = { opening.builtTurns.isBlank(hasTurns: !chat.turns.isEmpty) }
        guard isBlank() else { return false }
        let display = DisplayFrames()
        defer { display.stop() }
        var seen = 0
        for await _ in display.frames {
            guard isBlank() else { return false }
            seen += 1
            if seen >= frames { return true }
        }
        return false
    }

    /// Looks a few frames from now whether the chat is blank (`repairIfBlank`): once it
    /// is shown, and each time the lazy stack lets go of a row, the host's copy taking the
    /// place of the one kept here included. One look at a time.
    private func watchForBlank(_ proxy: ScrollViewProxy) {
        guard !opening.watchesForBlank, !opening.isGone else { return }
        opening.watchesForBlank = true
        Task {
            // Time for a row the stack builds as it lets go of another to say so.
            await DisplayFrames.wait(3)
            opening.watchesForBlank = false
            await repairIfBlank(proxy, from: "watch")
        }
    }

    /// Whether you're dragging the chat or it's still gliding from your flick.
    private var isScrollingByHand: Bool {
        scrollPhase == .interacting || scrollPhase == .decelerating
    }

    /// The newest thing in the chat that you put there: a turn, a message still
    /// waiting, a command's answer.
    private var lastMessageID: UUID? {
        chat.state.pending.last?.id ?? chat.turns.last?.id
    }

    /// The commands to offer for what is typed so far; none unless it is a slash and
    /// part of a name, or once Escape closed the menu.
    private var suggestions: [SlashCommand] {
        commands.rows(for: chat.composer.text, in: chat.commands)
    }

    /// Just above the composer, what is being typed is offered: the slash commands for a
    /// slash and part of a name, the host's files after an `@`.
    @ViewBuilder private var composerMenu: some View {
        let suggestions = suggestions
        if !suggestions.isEmpty {
            CommandMenu(commands: suggestions, menu: commands, text: chat.composer.text) { command in
                swipeGuard { pickCommand(command) }
            }
            .transition(.opacity)
        } else if showsMentionMenu {
            MentionMenu(mentions: mentions) { row in
                swipeGuard { pickMention(row) }
            }
            .transition(.opacity)
        }
    }

    /// Which menu is above the composer: none, the slash commands' (1), the `@` menu's (2).
    private var composerMenuShown: Int {
        !suggestions.isEmpty ? 1 : showsMentionMenu ? 2 : 0
    }

    /// The `@` menu is open and has something to show: rows, or why there are none.
    private var showsMentionMenu: Bool {
        mentions.isOpen && (!mentions.rows.isEmpty || mentions.emptyLine != nil)
    }

    /// How the composer reaches its menus: the slash commands' while it is open, otherwise
    /// the `@` menu, which only a host that searches files has.
    private var menuLink: ComposerMenuLink {
        ComposerMenuLink(
            isOpen: { !suggestions.isEmpty || showsMentionMenu },
            follow: {
                commands.follow(chat.composer.text)
                if chat.searchesFiles { followMentions() }
            },
            leave: { [mentions] in mentions.leave() },
            move: { step in
                let rows = suggestions
                if rows.isEmpty {
                    mentions.move(step)
                } else {
                    commands.move(step, in: rows, for: chat.composer.text)
                }
            },
            pick: { viaReturn in
                let rows = suggestions
                guard rows.isEmpty else { return pickHighlightedCommand(in: rows, viaReturn: viaReturn) }
                let mentionRows = mentions.rows
                guard showsMentionMenu, mentionRows.indices.contains(mentions.highlighted) else { return false }
                pickMention(mentionRows[mentions.highlighted])
                return true
            },
            close: closeComposerMenu
        )
    }

    /// Escape: the open menu closes, the slash commands' until the text changes, the `@`
    /// menu until the caret leaves its `@`.
    private func closeComposerMenu() {
        if suggestions.isEmpty {
            mentions.close()
        } else {
            commands.close(over: chat.composer.text)
        }
    }

    /// Return or Tab with the slash commands' menu open: the row the keyboard is on is
    /// written in. Return on a command already written out whole, its row the one marked,
    /// sends it as it did before the menu took Return; false then.
    private func pickHighlightedCommand(in rows: [SlashCommand], viaReturn: Bool) -> Bool {
        let text = chat.composer.text
        let index = commands.highlighted(in: rows, for: text)
        guard rows.indices.contains(index) else { return false }
        let command = rows[index]
        if viaReturn, text == "/\(command.name)" { return false }
        pickCommand(command)
        return true
    }

    /// A slash command picked: its name, then a space, the caret after it. The menu has
    /// done its part, and what follows the command can be typed (a beta tester, 2026-10-31:
    /// "the cursor doesn't move to the end of the text staying in the middle of the skill
    /// name").
    private func pickCommand(_ command: SlashCommand) {
        let text = ComposerCommands.written(command)
        chat.composer.text = text
        caret = TextSelection(insertionPoint: text.endIndex)
        isComposing = true
    }

    /// The `@` menu looks again at the composer, once its text and caret have settled.
    private func followMentions() {
        mentions.lookSoon {
            ComposerMentions.Snapshot(
                text: chat.composer.text, caret: caret, isShown: isShown, picked: chat.composer.mentions,
                scope: chat.mentionScope
            )
        } search: { [chat] query, scope in
            try await chat.searchFiles(query, in: scope, limit: ComposerMentions.limit)
        }
    }

    /// A row of the `@` menu picked: a file or the folder gone into is written into the
    /// message, its token and a space; a folder is gone into, the menu open on its files.
    private func pickMention(_ row: MentionRow) {
        guard let picked = mentions.edit(picking: row, in: chat.composer.text) else { return }
        if let path = picked.mentioned, !chat.composer.mentions.contains(path) { chat.composer.mentions.append(path) }
        chat.composer.text = picked.edit.text
        caret = TextSelection(insertionPoint: picked.edit.caret)
        isComposing = true
    }

    /// The last turn and whether it's still running, for the end safeguard.
    private var lastTurnState: String {
        guard let turn = chat.turns.last else { return "" }
        return "\(turn.id.uuidString)-\(turn.isRunning)"
    }

    /// The composer's side margin. On an iPhone it is set in by the page's margin while it
    /// rests in the screen's rounded corners, and widens to the chat's when the keyboard
    /// is up. On a wide window and on a Mac it is in line with the chat and stays there:
    /// nothing comes up under it, and a composer that changed width with every click in
    /// and out of it would only jump.
    private var composerMargin: CGFloat {
        if Platform.isMac || horizontalSizeClass == .regular { return ChatFeature.margin }
        return isComposing ? ChatFeature.margin : Theme.margin
    }

    /// The fade and blur of the chat going under the header (since 2026-10-23; before,
    /// with `PORTALS_DEBUG_TOP_FADE=before`).
    enum TopFade {
        /// How far past the header's bar the blur reaches on a phone and an iPad: half the
        /// grid since the user found 8 points a bit much (2026-10-23, "A bit less").
        static let belowHeader: CGFloat = Theme.grid / 2
        /// How far up the bar over the chat, and so the soft edge and blur under it, comes with
        /// the chat's name on one line (`ChatTitleRow`), over the chat past the bar's foot
        /// (2026-11-03: "too big at the top", "move the area up a bit"). The soft edge's own
        /// height cannot be set, and in its place a blur of the app's stopped too suddenly.
        static let titleRowLift: CGFloat = Theme.grid * 1.5
        /// The share of the blur's height it is whole over on a phone and an iPad, before
        /// it thins out: about the top third of the header (0.4 before "A bit less").
        static let phoneSolid = 0.3

        /// How far down the window the chat fades out on a Mac: the window's bar, and
        /// 12 points more since 2026-10-23 (20 at first: its foot a little higher since).
        static var macFade: CGFloat {
            WindowLayout.windowBar + (DebugLaunch.topFadeAsBefore ? 0 : Theme.grid * 1.5)
        }

        /// The chat's fade on a Mac: gone over the tabs, so the chat never shows through
        /// the ones not on screen (2026-10-24, seeing a reply's words between them),
        /// then coming in under them along a smooth step.
        static var macStops: [Gradient.Stop] {
            let clear = min((TabBar.top + TabBar.tabHeight + TabBar.inset / 2) / macFade, 0.9)
            let ramp = (0...8).map { step -> Gradient.Stop in
                let t = Double(step) / 8
                return .init(color: .black.opacity(t * t * (3 - 2 * t)), location: clear + (1 - clear) * t)
            }
            return [.init(color: .clear, location: 0)] + ramp
        }

        static var blurs: Bool { !DebugLaunch.topFadeAsBefore }

        /// The blur: the thinnest material, whole at the top and gone at its foot. It is
        /// only looked at. On a Mac its foot thins out along an eased curve rather than a
        /// straight ramp, which showed as a line (2026-10-23: "its not the blur is too
        /// strong its the edge is too harsh, just push it up very slightly by smoothening"),
        /// and it comes in from its leading edge over `leadingFade`, so it meets the sidebar
        /// with no edge of its own ("the overlap with the sidebar area is not a smooth
        /// transition").
        struct Blur: View {
            let height: CGFloat
            var solid = 0.45
            var eased = false
            var leadingFade: CGFloat = 0

            private var stops: [Gradient.Stop] {
                guard eased else {
                    return [.init(color: .black, location: 0), .init(color: .black, location: solid), .init(color: .clear, location: 1)]
                }
                // From whole to nothing along a smooth step sampled in twelfths, over most of
                // its height ("smooth the transition even a bit more", 2026-10-23).
                let span = 1 - solid
                let ramp = (0...12).map { step -> Gradient.Stop in
                    let t = Double(step) / 12
                    return .init(color: .black.opacity(1 - t * t * (3 - 2 * t)), location: solid + span * t)
                }
                return [.init(color: .black, location: 0)] + ramp
            }

            /// A blur with no tint of its own, which greyed the wash's colour under the header
            /// (2026-10-23: "on the top of the gradient on phone and ipad why is it less
            /// orange and more gray?", then "just apply the tint fix on every version").
            private var surface: some View { TintlessBlur() }

            var body: some View {
                surface
                    .mask {
                        LinearGradient(stops: stops, startPoint: .top, endPoint: .bottom)
                    }
                    .mask {
                        HStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                                .frame(width: leadingFade)
                            Color.black
                        }
                    }
                    .frame(height: height)
                    .frame(maxWidth: .infinity)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    /// Until no finger is on the chat, nor is it springing back from past its top: a drag
    /// sets the offset from where it began, and the spring pulls it to the top, either
    /// undoing the move that keeps the place as earlier turns are put above (scroll check
    /// of 2026-10-28: a page that came mid-drag at the top left the chat at its new first
    /// turn, 30 turns away). A fling's glide keeps the move. A minute at most.
    private func untilLetGo() async {
        for _ in 0..<1200 {
            guard let scrollView = transcriptAnchor?.scrollView else { return }
            let springsBack = scrollView.isDecelerating && scrollView.contentOffset.y < -scrollView.adjustedContentInset.top
            guard scrollView.isTracking || springsBack else { return }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Earlier turns were put before the first one the chat held (`ThreadController.loadEarlier`):
    /// the offset moves on by as much as they take, once laid out, so that what was read
    /// stays where it was rather than being pushed down out of sight.
    private func keepPlace(asTurnsCameBefore old: Turn.ID?) {
        guard let old, chat.turns.first?.id != old, chat.turns.dropFirst().contains(where: { $0.id == old }),
              let scrollView = transcriptAnchor?.scrollView else { return }
        let height = scrollView.contentSize.height
        DispatchQueue.main.async {
            let grown = scrollView.contentSize.height - height
            if grown > 0 { scrollView.contentOffset.y += grown }
        }
    }

    private static let topID = "chat-top"
    private static let bottomID = "chat-bottom"
    /// How far under the top of the composer's bar the chat's fade reaches on a Mac.
    private static let fadeUnderComposer: CGFloat = Theme.grid * 1.5

    // MARK: Composer

    private var composer: some View {
        ChatComposer(
            draft: $chat.composer.text,
            attachments: $chat.composer.images,
            files: $chat.composer.files,
            caret: $caret,
            isComposing: $isComposing,
            placeholder: "Message \(chat.agent.displayName) on \(hostName)",
            isRunning: chat.isRunning,
            takesFiles: chat.takesFiles,
            sendEnabled: chat.editingMessage == nil || (canForkMessage && !isWorkingOnMessage),
            onSend: send,
            onStop: { chat.stop() },
            isOutOfSight: { [chat] in chat.isKeptOffScreen || ScreenCommands.shared.showsSettings },
            menu: menuLink,
            mentioned: chat.composer.mentions
        ) { buttonSize in
            // A coding agent's mode: tap it for the modes.
            if let mode = chat.mode {
                ModeChip(mode: mode, height: buttonSize) { chat.pickMode($0) }
            }
            // Shown once the host has said which models the agent can run on.
            if let catalog = chat.offerings.models, let setting = chat.modelSetting {
                ModelChip(
                    catalog: catalog,
                    setting: setting,
                    height: buttonSize,
                    isPresented: $showsModelPicker,
                    onPickModel: { model, provider in chat.pickModel(model, provider: provider) },
                    onPickLevel: { chat.pickLevel($0) },
                    onReset: { chat.resetModel() }
                )
                // Its room first: in a narrow window the mode chip drops its name before
                // the model's is cut.
                .layoutPriority(1)
            }
        } status: { buttonSize in
            // Shown once the host has said how full the context is: after a turn.
            if let usage = chat.context {
                ContextRing(
                    usage: usage, height: buttonSize, showsCompact: chat.offersCompact, canCompact: chat.canCompact,
                    onCompact: { chat.compactContext() }
                )
                    .transition(.opacity)
            }
        }
        .alert(
            "Use this model?",
            isPresented: Binding(get: { chat.modelConfirmation != nil }, set: { if !$0 { chat.modelConfirmation = nil } }),
            presenting: chat.modelConfirmation
        ) { pending in
            Button("Use it") { chat.pickModel(pending.model, provider: pending.provider, confirmed: true) }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text(pending.message)
        }
        // A new thread's `@` menu searches its folder until the thread is on the host, then
        // the thread's; none until the host has said it searches files.
        .onChange(of: chat.mentionScope) { followMentions() }
        // Escape is the open menu's, to close it, while the chat is on screen: one kept out
        // of sight behind another tab's lets go of it. Taken for the chat's `@` menu, the
        // one for both of its menus; also for one open as the chat appears (a draft kept
        // with "/co" in it).
        .onChange(of: (!suggestions.isEmpty || showsMentionMenu) && isShown, initial: true) { _, shows in
            if shows {
                MenuEscapeKey.take(closeComposerMenu, for: mentions)
            } else {
                MenuEscapeKey.release(mentions)
            }
        }
        // Gone with its menu open (⌘W closed its tab), the chat lets go of Escape too: the
        // change above never comes then.
        .onDisappear { MenuEscapeKey.release(mentions) }
    }

    private func send() {
        let draft = chat.composer
        guard !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.images.isEmpty || !draft.files.isEmpty else { return }
        if let editing = chat.editingMessage {
            guard !chat.isSendingMessageEdit, !isWorkingOnMessage, canForkMessage else { return }
            isWorkingOnMessage = true
            Task {
                defer { isWorkingOnMessage = false }
                do { try await onForkMessage(editing.checkpoint, true, draft) }
                catch { messageActionProblem = error.localizedDescription }
            }
            return
        }
        chat.composer = ComposerDraft()
        // Every one picked that the text still names: its chips' (`SentMentionsMemory`); the
        // host gets them only where it takes them (`ThreadController.deliver`).
        let picked = FileMentionDraft.mentions(picked: draft.mentions, in: draft.text, hostTakesThem: true)
        chat.send(draft.text, images: draft.images, files: draft.files, mentions: picked)
    }

    private func messageAction(_ message: UserMessage, checkpoint: MessageCheckpoint, before: Bool, focus: Bool = true) {
        guard canForkMessage, !isWorkingOnMessage, !chat.isPreparingMessageEdit, !chat.isSendingMessageEdit else { return }
        isWorkingOnMessage = true
        Task {
            defer { isWorkingOnMessage = false }
            if before {
                do {
                    try await chat.editMessage(message, at: checkpoint)
                    caret = nil
                    if focus { isComposing = true }
                } catch { messageActionProblem = error.localizedDescription }
            } else {
                do { try await onForkMessage(checkpoint, false, nil) }
                catch { messageActionProblem = error.localizedDescription }
            }
        }
    }
}

/// In place of the composer in a thread only read (a session open in a terminal on the
/// host): what it is, and a way to continue it here, as a fork.
private struct ReadOnlyNote: View {
    /// The host's name, where the terminal is.
    let hostName: String
    var offersFork = false
    var onFork: () async throws -> Void

    @State private var isForking = false
    @State private var problem: String?
    @Environment(\.swipeGuard) private var swipeGuard

    var body: some View {
        HStack(spacing: Theme.grid * 1.5) {
            Image(systemName: "terminal")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(offersFork ? "View only on \(hostName). Fork it to continue here." : "View only on \(hostName).")
                    .font(.app.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let problem {
                    Text(problem)
                        .font(.app.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Theme.grid)
            if offersFork {
                Button {
                    swipeGuard { fork() }
                } label: {
                    if isForking {
                        ProgressView()
                    } else {
                        Text("Fork")
                    }
                }
                .buttonStyle(.monochromeProminent)
                .buttonBorderShape(.capsule)
                .disabled(isForking)
                .accessibilityIdentifier("fork-thread")
            }
        }
        .padding(.horizontal, Theme.grid * 2)
        .padding(.vertical, Theme.grid * 1.5)
        .background(.regularMaterial, in: .rect(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("read-only-note")
    }

    private func fork() {
        guard !isForking else { return }
        isForking = true
        problem = nil
        Task {
            defer { isForking = false }
            do {
                try await onFork()
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// What decides where the chat's end is: its content's height and the space it scrolls
/// in (the keyboard and composer change the bottom inset). When one changes, a
/// following chat scrolls to its end.
private struct ScrollExtent: Equatable {
    var contentHeight: CGFloat
    var containerHeight: CGFloat
    var bottomInset: CGFloat
    var fits: Bool

    init(_ geometry: ScrollGeometry) {
        contentHeight = geometry.contentSize.height
        containerHeight = geometry.containerSize.height
        bottomInset = geometry.contentInsets.bottom
        fits = Self.fits(geometry)
    }

    /// How far the chat is scrolled above its end, in points. The visible rect runs
    /// under the composer (the bottom inset), where the end is not in view.
    static func distanceFromEnd(_ geometry: ScrollGeometry) -> CGFloat {
        geometry.contentSize.height - (geometry.visibleRect.maxY - geometry.contentInsets.bottom)
    }

    /// As `distanceFromEnd`, but 0 for a chat shorter than its screen, which is at its
    /// end wherever it is drawn.
    static func endDistance(_ geometry: ScrollGeometry) -> CGFloat {
        fits(geometry) ? 0 : distanceFromEnd(geometry)
    }

    /// Whether all of the chat fits between the bars, with nothing to scroll. The
    /// container is already the room between them, on a Mac (660 points in a window 820
    /// tall, with insets of 52 and 108) as on a phone (632 of 874, with 128 and 114):
    /// taking the bars off it again, a chat that fitted counted as one that did not, and
    /// not at its end, and an animated scroll to its end went nowhere and never ended.
    static func fits(_ geometry: ScrollGeometry) -> Bool {
        geometry.contentSize.height <= geometry.containerSize.height + 1
    }
}

/// How a thread opened, for `ChatScreen`: kept apart from its state, as none of it is
/// drawn, and it changes with every frame of scrolling.
private final class Opening {
    /// Whether the screen opened on a thread the host has (not a new one).
    var opensExisting: Bool?
    /// How far the chat is from its end (`ScrollExtent.endDistance`), and how tall it is.
    var distance: CGFloat = .infinity
    var contentHeight: CGFloat = 0
    /// Whether all of it fits on the screen (`ScrollExtent.fits`).
    var fits = false
    /// The last turn's state as last seen (`lastTurnState`); nil until the screen has
    /// appeared.
    var lastTurnState: String?
    /// Which rows the lazy stack has built, to tell a chat it left blank
    /// (`ChatScreen.repairIfBlank`).
    var builtTurns = BuiltTurns()
    /// A look whether it is blank is on its way (`ChatScreen.watchForBlank`).
    var watchesForBlank = false
    /// The chat has left the screen.
    var isGone = false
    /// A move for a blank chat is being made (`ChatScreen.repairIfBlank`): one at a time.
    var isRepairing = false
    /// Counts the looks at a chat come to rest past its end (`ChatScreen.returnFromPastEnd`):
    /// only the newest acts.
    var pastEndChecks = 0
    /// One of those looks is under way: until it ends, a following chat is not moved to
    /// its end as its content changes.
    var returnsFromPastEnd = false
}

private extension View {
    /// Notes in `opening` this row of the lazy stack being built and let go of, and calls
    /// `letGo` as it is let go of.
    func notesBuilt(_ id: UUID, in opening: Opening, letGo: @escaping () -> Void) -> some View {
        modifier(NotesBuilt(id: id, opening: opening, letGo: letGo))
    }
}

/// `View.notesBuilt`. A turn kept built far from the screen (the last one, `TranscriptTurn`)
/// counts as built only while it is near: counted as soon as it was built, the chat always
/// had a row built, and one left blank was never brought back to its turns.
private struct NotesBuilt: ViewModifier {
    let id: UUID
    let opening: Opening
    let letGo: () -> Void

    @Environment(\.turnIsNear) private var isNear

    func body(content: Content) -> some View {
        content
            .onAppear { if isNear { opening.builtTurns.built(id) } }
            .onChange(of: isNear) { _, near in
                if near { opening.builtTurns.built(id) } else { lost() }
            }
            .onDisappear { if isNear { lost() } }
    }

    private func lost() {
        opening.builtTurns.letGo(id)
        letGo()
    }
}

/// Above the first turn an ongoing conversation holds, with more before it: a spinner while
/// those are asked for, else a button that asks for them, as scrolling up to it does.
private struct EarlierTurns: View {
    let isLoading: Bool
    let load: () -> Void

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .accessibilityLabel("Loading earlier messages")
            } else {
                Button("Earlier messages", systemImage: "arrow.up", action: load)
                    .font(.app.caption)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, minHeight: Theme.grid * 4)
    }
}

/// In place of the chat while the host's copy of a thread with nothing of it on the
/// device comes: nothing at first, then a spinner, should it take a moment.
private struct HistoryLoading: View {
    @State private var isShown = false

    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity)
            .padding(.top, Theme.grid * 6)
            .opacity(isShown ? 1 : 0)
            .task {
                try? await Task.sleep(for: .milliseconds(500))
                withAnimation(.easeIn(duration: 0.2)) { isShown = true }
            }
            .accessibilityLabel("Loading the thread")
    }
}

#Preview("Markdown reply") {
    @Previewable @State var chat: ThreadController? = nil
    Group {
        if let chat {
            ChatScreen(chat: chat, hostName: "Preview", onNewThread: {})
        }
    }
    .task {
        let backend = FakeBackend(script: .markdown)
        try? await backend.connect()
        guard let agent = try? await backend.listAgents().first else { return }
        let controller = ThreadController(agent: agent, backend: backend)
        chat = controller
        controller.send("What did you find?")
    }
    .tint(Theme.tint)
}

/// A blur of what is behind it with none of a material's tint: the system's thinnest blur
/// with its tint taken out, so the colour under it stays its own.
private struct TintlessBlur: UIViewRepresentable {
    func makeUIView(context: Context) -> TintlessBlurView {
        TintlessBlurView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    }

    func updateUIView(_ view: TintlessBlurView, context: Context) {}
}

extension ChatScreen {
    /// Once, in the chat on screen (`PORTALS_DEBUG_TYPE_BENCH`).
    @MainActor private static var typeBenchRan = false

    func typeBench() async {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
        guard isShown, !Self.typeBenchRan, let path = DebugLaunch.typeBenchPath else { return }
        Self.typeBenchRan = true
        if DebugLaunch.typeBenchField != "search" { isComposing = true }
        try? await Task.sleep(for: .seconds(1))
        let note = { (word: String) in
            let line = "\(word) \(ProcessInfo.processInfo.systemUptime)\n"
            if let handle = FileHandle(forWritingAtPath: path) {
                handle.seekToEndOfFile(); handle.write(Data(line.utf8)); try? handle.close()
            } else {
                FileManager.default.createFile(atPath: path, contents: Data(line.utf8))
            }
        }
        // Through the field's own input, as the keyboard puts a key in (`insertText`): the
        // composer's, or with `PORTALS_DEBUG_TYPE_BENCH_FIELD=search` the sidebar's search
        // field, where a word is typed and taken out again.
        let inSearch = DebugLaunch.typeBenchField == "search"
        func field(in view: UIView) -> (UIView & UIKeyInput)? {
            if inSearch, let field = view as? UITextField, field.placeholder == "Search threads" { return field }
            if !inSearch, let text = view as? UITextView, text.isEditable, text.isFirstResponder { return text }
            for sub in view.subviews { if let found = field(in: sub) { return found } }
            return nil
        }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let target = windows.lazy.compactMap({ field(in: $0) }).first else { note("no-field"); return }
        if inSearch {
            _ = target.becomeFirstResponder()
            try? await Task.sleep(for: .seconds(1))
        }
        note("typing")
        let letters = Array(inSearch ? "budget" : "the quick brown fox jumps over the lazy dog ")
        for index in 0..<300 {
            if inSearch, index % 12 >= 6 {
                target.deleteBackward()
            } else {
                target.insertText(String(letters[index % (inSearch ? 12 : letters.count)]))
            }
            try? await Task.sleep(for: .milliseconds(80))
        }
        note("typed")
        #endif
    }
}

final class TintlessBlurView: UIVisualEffectView {
    override func layoutSubviews() {
        super.layoutSubviews()
        isUserInteractionEnabled = false
        // The blur is the backdrop; the views over it are the material's tint and fill.
        // (Found by name, as UIKit gives no other way; not found, the blur keeps its tint,
        // as before.)
        for view in subviews where String(describing: type(of: view)).contains("VisualEffectSubview") {
            view.isHidden = true
        }
        // Since iOS 27 the material's tint is in the backdrop's own filters, with the blur:
        // a curve lifting the dark (and in light mode a brightening), and a saturation, which
        // greyed the wash under the bar again (2026-10-31: "why is there some slight
        // gray overlay it looks so bad, on phone as well, it makes the colors less vibrant
        // and also breaks the transition between sidebar"). Only the blur is kept; with no
        // blur found by its name, all of them, as before.
        for view in subviews {
            guard let filters = view.layer.filters, filters.count > 1 else { continue }
            let blur = filters.filter { ($0 as AnyObject).value(forKey: "name") as? String == "gaussianBlur" }
            if blur.count == 1 { view.layer.filters = blur }
        }
    }

    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        setNeedsLayout()
    }
}

/// Where a chat's draft is read: what reads it (the composer, and the menu over it of what
/// is typed) is worked out in this view's body, not in the chat screen's, so that a key
/// typed works out those again and not the whole chat screen with its transcript and bars
/// (2026-11-06: "look around generally for what things are slow and can be sped up
/// cheaply"; scripts/type-bench.sh). Made again with the chat screen, so nothing it shows
/// is older than the screen.
private struct DraftReader<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View { content() }
}
