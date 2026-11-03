import AgentCore
import Observation
import os
import SwiftUI
import UIKit
import WebKit

/// Which widget a session draws: one block of one turn, with its HTML (a hash of it, 0
/// while it is still being written). A turn keeps its id when the host's copy of it
/// replaces this one, which its items do not.
struct WidgetKey: Hashable {
    let turn: UUID
    /// Which of the turn's pieces of text it is in: the same visual in two of them is two.
    var segment = 0
    let block: Int
    let source: UInt64

    /// The same block while it is being written.
    var drafting: WidgetKey { WidgetKey(turn: turn, segment: segment, block: block, source: 0) }
}

/// The widgets' web views, kept outside the transcript. The chat lets go of the turns
/// far from the screen and makes them again when they come back (docs/perf-mac-scroll.md):
/// a widget's web view moves to the new row as it is, with what was done in it, instead
/// of loading again. The least recently shown are let go past a few, and all those not
/// on screen when memory runs short. One for the app, which has one window.
@MainActor
final class WidgetPool {
    static let shared = WidgetPool()

    /// How many widgets keep their pages while off screen.
    /// On a phone, three (with the two WebKit processes all pages share, about 100 MB: a
    /// page took 24 to 42 MB, the GPU process 12 to 19 MB and the network's 7.5 to 8.5 MB
    /// on the iPhone simulator, docs/visuals.md); an iPad and a Mac have the room for more.
    private let capacity = Platform.isMac ? 8 : UIDevice.current.userInterfaceIdiom == .pad ? 4 : 3
    private var sessions: [WidgetKey: WidgetSession] = [:]
    /// Least recently shown first.
    private var order: [WidgetKey] = []
    private var memoryWarning: NSObjectProtocol?
    private var lifecycle: [NSObjectProtocol] = []
    /// How often the app has gone into the background: a page asked whether it answers
    /// while that happened (WebKit suspends its process with the app) did not answer for
    /// that reason alone (`WidgetSession.checkAnswersOnLeaving`, `checkLoad`).
    private(set) var backgroundings = 0

    /// A page made ahead of the visual that will be drawn in it (`warm`), its process
    /// started, and when it is let go of unused.
    private var spare: (view: WKWebView, messages: WidgetMessages)?
    private var isWarming = false
    private var spareExpiry: Task<Void, Never>?
    /// Visuals given up on (`WidgetFailure`), by their HTML, for as long as the app runs:
    /// one drawn again from the reply after its page was let go of is not tried again.
    private var failures: [UInt64: WidgetFailure] = [:]
    /// How often each visual was tried again (`tryAgain`), by its HTML, for as long as the
    /// app runs: after `triesAllowed` its card no longer offers it (2026-10-22:
    /// "maybe after like 3 tries").
    private var tries: [UInt64: Int] = [:]
    static let triesAllowed = 3
    /// The pages of chats that were left, let go of two minutes on (`WidgetsLeft`), on one
    /// timer for them all, which sleeps until the next are due.
    private var left = WidgetsLeft<ObjectIdentifier>(life: DebugLaunch.visualsKeptAfterLeaving ?? WidgetsLeft<ObjectIdentifier>.life)
    private var leftTimer: Task<Void, Never>?

    private init() {
        memoryWarning = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                let pool = WidgetPool.shared
                pool.letGo(keeping: 0)
                pool.dropSpare()
                // Those of left chats went too: nothing left to wait for.
                pool.left.keep(only: Set(pool.sessions.keys.map(\.turn)))
                pool.scheduleLeft()
            }
        }
        lifecycle = [
            NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { WidgetPool.shared.backgroundings += 1 }
            },
            // A slow page's look that was due while the app was away is taken now, for
            // the pages on screen (`WidgetSession.resumeChecks`).
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    for session in WidgetPool.shared.sessions.values { session.resumeChecks() }
                }
            },
        ]
    }

    /// Makes a page ready for a visual about to be drawn: as the agent starts planning
    /// one, and as a visual whose page was let go of comes towards the screen. WebKit
    /// starts a page's process when it first loads something, which would otherwise come
    /// between the visual and its first frame. Let go of after a minute unused.
    func warm() {
        guard spare == nil, !isWarming else { return }
        isWarming = true
        Task {
            defer { isWarming = false }
            guard let rules = await WidgetSandbox.contentRules(), spare == nil else { return }
            let messages = WidgetMessages(nil)
            let view = WidgetSandbox.webView(rules: rules, messages: messages)
            WidgetSandbox.startProcess(of: view)
            #if DEBUG
            AppLog.chat.info("Visual page made ready")
            #endif
            spare = (view, messages)
            spareExpiry?.cancel()
            spareExpiry = Task {
                try? await Task.sleep(for: Self.spareLife)
                guard !Task.isCancelled else { return }
                WidgetPool.shared.dropSpare()
            }
        }
    }

    private static let spareLife = Duration.seconds(60)

    /// The page made ready, if there is one, for `session` to draw in.
    fileprivate func takeSpare(for session: WidgetSession) -> WKWebView? {
        guard let spare else { return nil }
        self.spare = nil
        spareExpiry?.cancel()
        spare.messages.session = session
        return spare.view
    }

    private func dropSpare() {
        spareExpiry?.cancel()
        spare?.view.stopLoading()
        spare = nil
    }

    /// The session for a widget, made the first time it is asked for. A widget still being
    /// written has one under its block alone, shown as far as it goes; once it is
    /// finished, that session carries on as the finished widget's, in the same web view,
    /// so the page is not drawn anew in another place.
    func session(for key: WidgetKey, widget: MarkdownWidget) -> WidgetSession {
        if !widget.isComplete {
            let session = sessions[key.drafting] ?? added(WidgetSession(key: key.drafting, widget: widget, isDraft: true))
            session.draft(widget)
            return session
        }
        if let session = sessions[key] { return session }
        if let draft = sessions.removeValue(forKey: key.drafting) {
            draft.finish(as: key, widget: widget)
            sessions[key] = draft
            order = order.map { $0 == key.drafting ? key : $0 }
            if let failure = failures[key.source] { draft.fail(failure) }
            return draft
        }
        return added(WidgetSession(key: key, widget: widget, isDraft: false))
    }

    private func added(_ session: WidgetSession) -> WidgetSession {
        sessions[session.key] = session
        order.append(session.key)
        if session.key.source != 0, let failure = failures[session.key.source] { session.fail(failure) }
        return session
    }

    /// `session` was given up on: so it stays, wherever its visual is drawn again.
    fileprivate func failed(_ session: WidgetSession, _ failure: WidgetFailure) {
        guard session.key.source != 0 else { return }
        failures[session.key.source] = failure
    }

    /// Try again, on a visual given up on: it is drawn again from the reply's own source,
    /// as if it had never been tried, here and wherever it is drawn again. Nothing is sent
    /// to the agent or the bridge. Given up on again, its card comes back.
    func tryAgain(_ session: WidgetSession) {
        guard session.failure != nil, canTryAgain(session) else { return }
        if session.key.source != 0 {
            failures[session.key.source] = nil
            tries[session.key.source, default: 0] += 1
        }
        session.tryAgain()
    }

    /// Whether a visual given up on may be tried again: not once it was `triesAllowed`
    /// times, here or in a row of it drawn before (by its HTML), else in this session.
    func canTryAgain(_ session: WidgetSession) -> Bool {
        let tried = session.key.source != 0 ? tries[session.key.source] ?? 0 : session.triedAgain
        return tried < Self.triesAllowed
    }

    /// A session was put on screen: it is the last to be let go. One let go of while its
    /// row was kept out of the window is taken back, so that it counts again.
    func shown(_ session: WidgetSession) {
        let key = session.key
        if sessions[key] == nil {
            sessions[key] = session
            session.reopen()
        }
        if let index = order.firstIndex(of: key) { order.remove(at: index) }
        order.append(key)
        letGo(keeping: capacity)
    }

    /// A session's page went out of the window: past the most recently seen few, the
    /// oldest are let go.
    func trim() {
        letGo(keeping: capacity)
    }

    private var trimQueued = false

    /// `trim`, once the views being changed now have settled: a row let go of in the same
    /// update as another takes up a page does not cost that page.
    func trimSoon() {
        guard !trimQueued else { return }
        trimQueued = true
        Task { @MainActor in
            self.trimQueued = false
            self.trim()
        }
    }

    // MARK: Chats left

    /// The chat screen `screen`, showing `chat` with `turns` in it, left the screen
    /// (another thread opened): its visuals' pages kept among the most recently seen few stay for two
    /// minutes, so that going back to it at once finds them as they were, and are then let
    /// go of. Nothing while another screen shows the same chat.
    func chatLeft(screen: UUID, chat: ObjectIdentifier, turns: [UUID]) {
        let withPages = Set(sessions.keys.map(\.turn))
        let turns = turns.filter(withPages.contains)
        #if DEBUG
        AppLog.chat.info("Visuals: a chat left, \(turns.count, privacy: .public) of its turns with pages kept for \(Int(self.left.life), privacy: .public) s")
        #endif
        left.left(turns, of: chat, from: screen, at: .now)
        scheduleLeft()
    }

    /// The chat screen `screen`, showing `chat` with `turns` in it, is on screen: its pages
    /// stay.
    func chatShown(screen: UUID, chat: ObjectIdentifier, turns: [UUID]) {
        let waited = !left.isEmpty
        left.shown(turns, of: chat, on: screen)
        if waited { scheduleLeft() }
    }

    /// Sleeps until the next left chat's pages are due, if any wait.
    private func scheduleLeft() {
        leftTimer?.cancel()
        leftTimer = nil
        guard let due = left.nextDue else { return }
        leftTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, due.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self else { return }
            self.leftTimer = nil
            self.letGoOfLeft()
        }
    }

    private func letGoOfLeft() {
        let turns = left.due(at: .now)
        for (key, session) in sessions where turns.contains(key.turn) && !session.isShown {
            #if DEBUG
            AppLog.chat.info("Visual \(key.block, privacy: .public) let go, its chat left \(Int(self.left.life), privacy: .public) s ago")
            #endif
            session.close()
            sessions[key] = nil
        }
        order.removeAll { sessions[$0] == nil }
        scheduleLeft()
    }

    /// Lets go of the least recently shown sessions not on screen, until `keeping` are left.
    private func letGo(keeping: Int) {
        var excess = sessions.count - keeping
        for key in order where excess > 0 {
            guard let session = sessions[key], !session.isShown else { continue }
            #if DEBUG
            AppLog.chat.info("Visual \(key.block, privacy: .public) let go, \(self.sessions.count - 1, privacy: .public) kept")
            #endif
            session.close()
            sessions[key] = nil
            excess -= 1
        }
        order.removeAll { sessions[$0] == nil }
    }
}

/// One widget's page: its web view, made when it is first shown, and how tall it says
/// it is.
@MainActor
@Observable
final class WidgetSession: NSObject {
    @ObservationIgnored private(set) var key: WidgetKey
    @ObservationIgnored private(set) var widget: MarkdownWidget
    /// Whether the widget is still being written: the page shows its elements and styles
    /// as far as they go (`WidgetPage.draft`), and runs no script. Observed: once it is
    /// finished, its frame no longer keeps the room a draft starts with.
    private(set) var isDraft: Bool

    /// How tall the page said it is, and at what width; nil until it has.
    private(set) var measured: (height: CGFloat, width: CGFloat)?

    /// Whether the page is worth looking at: until it is, the orb is shown over it and the
    /// page only faded (WidgetViews.swift). A visual being written is once its elements
    /// show something (text or shapes, at least `WidgetSizing.floor` tall) and nothing its
    /// script is to work (a control, a canvas): SVG and CSS draw as they are written, what
    /// a script draws waits for it. A finished one is once it has loaded, after its
    /// scripts ran. Once it is, it stays so, through the page loaded whole when the
    /// visual is finished and loaded again in the other look: the page shows what it
    /// showed until the new one is drawn.
    private(set) var isPresentable = false {
        didSet {
            if isPresentable { keepsDraftRoom = false }
            #if DEBUG
            if isPresentable, !oldValue, let madeAt {
                AppLog.chat.info("Visual \(self.key.block, privacy: .public) presentable \(Int(Date.now.timeIntervalSince(madeAt) * 1000), privacy: .public) ms after its page was asked for (\(self.madeWarm ? "warm" : "cold", privacy: .public)), seen: \(self.host?.sight == .seen, privacy: .public)")
            }
            #endif
        }
    }
    /// Finished before it showed anything (what its script draws): it keeps the room it
    /// had while written, under the orb, until the page is presentable, instead of
    /// shrinking to what the empty draft measured and growing again.
    @ObservationIgnored private(set) var keepsDraftRoom = false
    #if DEBUG
    @ObservationIgnored private var madeAt: Date?
    @ObservationIgnored private var madeWarm = false
    #endif

    @ObservationIgnored private var webView: WKWebView?
    /// The views that want to show it, the one that does last: the row in the chat, and
    /// over it the expanded view while it is open (`expandsWidgetsHere`).
    @ObservationIgnored private var hosts: [WeakHost] = []
    /// The address the page is being loaded at, until its navigation is allowed.
    @ObservationIgnored private var loading: URL?
    /// What the page was loaded with: a different theme loads it again.
    @ObservationIgnored private var loadedTheme: WidgetPage.Theme?
    @ObservationIgnored private var loadedStyle: UIUserInterfaceStyle?
    /// The page's growth by itself is bounded, a shrink giving nothing back; the user's
    /// expand/collapse interactions keep working, and refused frame growth still remembers
    /// the content's overflow.
    @ObservationIgnored private var growth = WidgetGrowth()
    @ObservationIgnored private var isMaking = false
    /// Let go of by the pool (`close`): a web view on its way is not made.
    @ObservationIgnored private var isClosed = false
    /// The last address opened in the browser, and when: a tapped link can ask twice.
    @ObservationIgnored private var opened: (url: URL, at: Date)?
    /// Whether the page has loaded, so a draft can be put in it.
    @ObservationIgnored private var isLoaded = false
    /// The load of the visual's own page: the page made ready (`WidgetPool.warm`) may still
    /// be loading its empty page, whose end is not this one's.
    @ObservationIgnored private var navigation: WKNavigation?
    /// Whether that page has replaced the one before it: what the one before posts (the
    /// empty page made ready, the page in the other look) is not this page's height.
    @ObservationIgnored private var isCommitted = false
    /// The draft the page shows, and the next one waiting to be put in it.
    @ObservationIgnored private var draftShown = ""
    @ObservationIgnored private var nextDraft: Task<Void, Never>?
    /// The width the page last measured itself at, whether its height was taken or not.
    @ObservationIgnored private var pageWidth: CGFloat?
    /// Whether the page is shown wider than it was drawn (`WidgetWidening`), and the page
    /// drawn again once the width has settled.
    @ObservationIgnored private var widening = WidgetWidening()
    @ObservationIgnored private var redraw: Task<Void, Never>?
    /// A redraw that fell due while the page was out of its row (scrolled away, or in the
    /// expanded view): done when it is back there, where it measures the same width and so
    /// says nothing new.
    @ObservationIgnored private var redrawsWhenBack = false
    /// Drawn again as it came back into its row from the expanded view, the row's picture
    /// of it held over it until it has loaded (`placeBack`).
    @ObservationIgnored private var redrawsBehindPicture = false
    /// How often the page's process ended while it was shown (`WidgetEndings`).
    @ObservationIgnored private var endings = WidgetEndings()
    /// A finished page's load taking long (`watchLoad`), and whether to look at it the next
    /// time it is shown, as it was out of the window when it was due.
    @ObservationIgnored private var loadWatch: Task<Void, Never>?
    @ObservationIgnored private var checksLoadWhenShown = false

    /// Why the visual was given up on, if it was: it is then shown as its source, with a
    /// line that says why (WidgetViews.swift), and its page is let go of.
    private(set) var failure: WidgetFailure?
    /// How often it was tried again (`WidgetPool.canTryAgain`, for a visual with no HTML key).
    private(set) var triedAgain = 0

    init(key: WidgetKey, widget: MarkdownWidget, isDraft: Bool) {
        self.key = key
        self.widget = widget
        self.isDraft = isDraft
    }

    /// The view that shows the page.
    private var host: WidgetHostView? { hosts.last?.view }

    /// Whether a view shows the page, or keeps it drawn near the screen.
    var isShown: Bool { hosts.contains { $0.view?.window != nil && $0.view?.sight.isOut == false } }

    // MARK: Showing

    /// Puts the page in `host`, loading it the first time and when the app's look changed.
    /// A row that comes back into view while the widget is expanded waits under it.
    func show(in host: WidgetHostView) {
        hosts.removeAll { $0.view == nil || $0.view === host }
        if !host.isExpanded, let expanded = hosts.lastIndex(where: { $0.view?.isExpanded == true }) {
            hosts.insert(WeakHost(view: host), at: expanded)
        } else {
            hosts.append(WeakHost(view: host))
        }
        WidgetPool.shared.shown(self)
        guard let current = self.host, !current.sight.isOut else {
            // Far from the screen: nothing is drawn, nor made, until it comes near; a page
            // is made ready for it meanwhile.
            if webView == nil { WidgetPool.shared.warm() }
            return
        }
        if let webView {
            place(webView, in: current)
        } else if !isMaking {
            isMaking = true
            Task { await make() }
        }
    }

    /// How near the screen a view showing it is changed. Far, its page is taken out of
    /// the window, where WebKit draws nothing and runs none of its frames, timers or
    /// animations; near again, it is put back as it was.
    func sightChanged(in host: WidgetHostView) {
        guard host === self.host else { return }
        #if DEBUG
        if host.sight == .seen { AppLog.chat.info("Visual \(self.key.block, privacy: .public) seen, presentable: \(self.isPresentable, privacy: .public), page: \(self.webView != nil, privacy: .public)") }
        #endif
        if host.sight.isOut {
            if let webView { checkAnswersOnLeaving(webView) }
            webView?.removeFromSuperview()
            WidgetPool.shared.trim()
            if host.sight == .approaching, webView == nil { WidgetPool.shared.warm() }
        } else if host.window != nil {
            show(in: host)
        }
    }

    /// Takes the page out of `host`; the view under it, if any, shows it again.
    func hide(from host: WidgetHostView) {
        let wasShowing = self.host === host
        hosts.removeAll { $0.view == nil || $0.view === host }
        guard wasShowing, let webView else { return }
        let next = self.host.flatMap { $0.window != nil && !$0.sight.isOut ? $0 : nil }
        if next == nil { checkAnswersOnLeaving(webView) }
        webView.removeFromSuperview()
        if let next { place(webView, in: next) }
    }

    /// The expanded view is closing (`WidgetExpander`): the page goes back to the row
    /// under it now, not once the sheet or panel has gone and its view is let go of, which
    /// left the row blank for over a second after a sheet slid away on an iPhone (night
    /// n6). The expanded view keeps a picture of the page while it slides or fades away.
    func closeExpanded() {
        guard let expanded = host, expanded.isExpanded else { return }
        if let webView, webView.superview === expanded { expanded.keepPicture(of: webView) }
        expanded.leave()
    }

    private func place(_ webView: WKWebView, in host: WidgetHostView) {
        if webView.superview !== host {
            // Into the expanded view: the row it leaves keeps a picture of it, which shows
            // around a panel on a Mac and under a sheet as it slides, rather than a hole.
            if host.isExpanded, let row = webView.superview as? WidgetHostView, row.window != nil {
                row.keepPicture(of: webView)
            }
            let cameFrom = pageWidth
            // Expanded wider than it was drawn, a page its own script draws is scaled up
            // rather than drawn again (`WidgetHostView.scalesFrom`); in a row it is at its
            // own size.
            host.scalesFrom = host.isExpanded && drawsWithScript ? cameFrom : nil
            if !host.isExpanded { webView.pageZoom = 1 }
            host.addSubview(webView)
            host.fitPage()
            // From a view of another width (into the expanded view and back), what the
            // page drew there is covered until it has laid itself out here.
            host.pageArrived(drawnAt: cameFrom)
            redrawIfBackWider(in: host, from: cameFrom)
        }
        updateScrolling()
        loadIfChanged(webView, traits: host.traitCollection)
        if redrawsWhenBack, !host.isExpanded, isLoaded {
            redrawsWhenBack = false
            reload()
        }
        if checksLoadWhenShown {
            checksLoadWhenShown = false
            Task { await checkLoad() }
        }
    }

    /// Back in its row from a narrower view (an iPad's sheet), a page drawn by a script of
    /// its own (Chart.js) keeps what it drew there, narrower than the row: it showed so,
    /// over the row's picture of it fading out, a double picture and then a narrower chart
    /// for good (night n8, recorded frame by frame). It is drawn again at once, under the
    /// row's picture of it as it was before it was expanded, which is held until the page
    /// has loaded again. Not a page the user did something on (`WidgetWidening.used`).
    private func redrawIfBackWider(in host: WidgetHostView, from width: CGFloat?) {
        guard !host.isExpanded, let width, isLoaded, drawsWithScript, host.bounds.width > 0,
              abs(host.bounds.width - width) > 1, widening.redraws(at: Double(host.bounds.width)),
              host.holdCover() else { return }
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) drawn again back in its row, \(Int(host.bounds.width), privacy: .public) points wide from \(Int(width), privacy: .public)")
        #endif
        reload()
        redrawsBehindPicture = true
    }

    /// Expanded, the page scrolls when it is taller than the view; in the chat, only when
    /// it is taller than it is shown, else drags scroll the chat.
    private func updateScrolling() {
        guard let webView else { return }
        if host?.isExpanded == true {
            webView.scrollView.isScrollEnabled = true
            return
        }
        let frameHeight = measured?.height ?? 0
        let contentHeight = growth.contentHeight.map { CGFloat($0) } ?? frameHeight
        webView.scrollView.isScrollEnabled = contentHeight > WidgetSizing.shown(widget.height.map { CGFloat($0) } ?? frameHeight) + 1
    }

    /// The app's look or text size changed where it is shown.
    func traitsChanged(in host: WidgetHostView) {
        guard self.host === host, let webView else { return }
        loadIfChanged(webView, traits: host.traitCollection)
    }

    /// Lets go of the page.
    func close() {
        isClosed = true
        // Shown again, its page is drawn anew: the orb stands in for it until then, not a
        // blank card. Its measured height stays, so its place does not change.
        isPresentable = false
        redraw?.cancel()
        redraw = nil
        redrawsWhenBack = false
        redrawsBehindPicture = false
        loadWatch?.cancel()
        loadWatch = nil
        checksLoadWhenShown = false
        // The page made next has been drawn nowhere yet: nothing to cover where it goes.
        pageWidth = nil
        guard let webView else { return }
        webView.stopLoading()
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
        self.webView = nil
        loadedTheme = nil
        loadedStyle = nil
    }

    /// Taken back by the pool after it let go: shown again, it makes its page again.
    func reopen() {
        isClosed = false
    }

    private func make() async {
        defer { isMaking = false }
        // Without the rules, nothing is loaded: the card stays empty. Nor when the pool let
        // go of it meanwhile: a web view now would be one the pool does not know of.
        guard let rules = await WidgetSandbox.contentRules(), webView == nil, !isClosed else { return }
        let spare = WidgetPool.shared.takeSpare(for: self)
        #if DEBUG
        madeAt = .now
        madeWarm = spare != nil
        #endif
        let view = spare ?? WidgetSandbox.webView(rules: rules, messages: WidgetMessages(self))
        view.navigationDelegate = self
        view.uiDelegate = self
        webView = view
        if let host, !host.sight.isOut { place(view, in: host) }
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) page made \(Int(Date.now.timeIntervalSince(self.madeAt ?? .now) * 1000), privacy: .public) ms after it was asked for")
        #endif
    }

    private func loadIfChanged(_ webView: WKWebView, traits: UITraitCollection) {
        let theme = WidgetSandbox.theme(traits)
        // Colours a page read in its script stay as they were read: a page drawn in one
        // look is drawn again in the other.
        guard theme != loadedTheme || traits.userInterfaceStyle != loadedStyle else { return }
        load(webView, theme: theme, style: traits.userInterfaceStyle)
    }

    private func load(_ webView: WKWebView, theme: WidgetPage.Theme, style: UIUserInterfaceStyle) {
        loadedTheme = theme
        loadedStyle = style
        growth.reset()
        isLoaded = false
        draftShown = ""
        let address = WidgetPage.address(of: key.source)
        loading = address
        // A draft's page starts empty and is filled as the widget is written, and runs no
        // script of its own until it is loaded whole.
        let page = Data(WidgetPage.document(isDraft ? "" : widget.source, theme: theme, isDraft: isDraft).utf8)
        let response = HTTPURLResponse(url: address, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": WidgetPage.contentSecurityPolicy(isDraft: isDraft),
        ])!
        isCommitted = false
        redraw?.cancel()
        redraw = nil
        redrawsWhenBack = false
        widening.reset()
        navigation = webView.loadSimulatedRequest(URLRequest(url: address), response: response, responseData: page)
        watchLoad()
    }

    // MARK: A page that takes long, or stops

    /// How long a finished page may take to load before the app looks at why.
    private static let loadPatience = Duration.seconds(10)
    /// How long a page has to answer when it is asked whether it still does.
    private static let answerPatience = Duration.seconds(3)

    /// A finished page that has not loaded `loadPatience` after it began is looked at
    /// (`checkLoad`). Its scripts run as it loads: one that never ends (a loop) keeps the
    /// orb over the visual for ever and a core of the device busy, and one waiting on a
    /// library from a slow network keeps the orb until the request gives up, a minute on.
    private func watchLoad() {
        loadWatch?.cancel()
        loadWatch = nil
        checksLoadWhenShown = false
        guard !isDraft, let navigation else { return }
        loadWatch = Task { [weak self] in
            try? await Task.sleep(for: Self.loadPatience)
            guard let self, !Task.isCancelled, self.navigation === navigation, !self.isLoaded else { return }
            self.loadWatch = nil
            await self.checkLoad()
        }
    }

    /// The page has taken long to load: if it still answers (it is waiting on the
    /// network), it is shown as far as it has drawn, the orb taken away; if it does not
    /// (a script that never ends), it is given up on (`checkAnswersOnLeaving` says what
    /// that does and does not do). Only asked in the window, with the app in use: WebKit may suspend a
    /// page out of it, which would not answer either; one out of the window then is asked
    /// when it is next shown.
    private func checkLoad() async {
        guard let webView, let navigation, !isLoaded, !isClosed, !isDraft else { return }
        guard isShown, UIApplication.shared.applicationState != .background else {
            checksLoadWhenShown = true
            return
        }
        let backgroundings = WidgetPool.shared.backgroundings
        let answered = await PageProbe(webView).answered(within: Self.answerPatience)
        // The same load, still on its way: one loaded again meanwhile (another look) is
        // not this one, and an answer it cancelled says nothing of it.
        guard self.webView === webView, self.navigation === navigation, !isLoaded, !isClosed else { return }
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) still loading after \(Self.loadPatience, privacy: .public), answers: \(answered, privacy: .public)")
        #endif
        if answered {
            isPresentable = true
            // Still loading: a script that arrives later and never ends is looked for too.
            watchLoad()
        } else if WidgetPool.shared.backgroundings != backgroundings || UIApplication.shared.applicationState == .background {
            // Suspended with the app: asked again once it is back and the page shown.
            checksLoadWhenShown = true
            resumeChecks()
        } else {
            fail(.unresponsive)
        }
    }

    /// The app is in use again: a look at a slow page that was due while it was away is
    /// taken now, if the page is shown, as `place` would when it is next shown.
    func resumeChecks() {
        guard checksLoadWhenShown, isShown, UIApplication.shared.applicationState != .background else { return }
        checksLoadWhenShown = false
        Task { await checkLoad() }
    }

    /// How long a page leaving the window has to answer (`checkAnswersOnLeaving`).
    private static let leavingPatience = Duration.seconds(5)

    /// The page is leaving the window. One whose script has run without end since it drew
    /// (it stood still, a core of the device busy) does not answer, and is given up on:
    /// WebKit keeps its process busy for as long as the app runs whatever is done, but it
    /// is not drawn again, in a new process, each time it comes back. Asked as it leaves,
    /// before it is taken out of the window, while WebKit still runs it in full. One shown
    /// while still loading (`checkLoad` found it answering) is asked too.
    private func checkAnswersOnLeaving(_ webView: WKWebView) {
        guard !isDraft, isLoaded || isPresentable, failure == nil, webView.window != nil, drawsWithScript else { return }
        let navigation = self.navigation
        let backgroundings = WidgetPool.shared.backgroundings
        let probe = PageProbe(webView)
        Task {
            let answered = await probe.answered(within: Self.leavingPatience)
            // Let go of by the pool meanwhile (its page stopped and dropped), or suspended
            // with the app, it did not answer for that reason alone.
            guard !answered, self.webView === webView, !self.isClosed, self.navigation === navigation,
                  WidgetPool.shared.backgroundings == backgroundings,
                  UIApplication.shared.applicationState != .background else { return }
            fail(.unresponsive)
        }
    }

    /// Gives up on the visual: its page is let go of, and it is shown as its source.
    func fail(_ failure: WidgetFailure) {
        guard self.failure == nil else { return }
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) given up on: \(String(describing: failure), privacy: .public)")
        #endif
        WidgetPool.shared.failed(self, failure)
        close()
        self.failure = failure
    }

    /// Drawn again after it was given up on (`WidgetPool.tryAgain`): its counts start
    /// afresh, and its page is made again when its frame is next shown, at once.
    fileprivate func tryAgain() {
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) tried again")
        #endif
        triedAgain += 1
        endings = WidgetEndings()
        isClosed = false
        // The orb has the room it has while a visual is written until the page is drawn,
        // not the little a page that never drew measured.
        keepsDraftRoom = !isPresentable
        failure = nil
    }

    /// Loads the page again, as it was first loaded.
    func reload() {
        guard let webView, let theme = loadedTheme, let style = loadedStyle else { return }
        load(webView, theme: theme, style: style)
    }

    // MARK: Drawing it as it is written

    /// More of the widget was written: the page shows it a moment later, at most a few
    /// times a second, however often words arrive.
    func draft(_ widget: MarkdownWidget) {
        guard isDraft else { return }
        self.widget = widget
        showNextDraft()
    }

    private func showNextDraft() {
        guard isDraft, isLoaded, nextDraft == nil, widget.source != draftShown else { return }
        nextDraft = Task { [weak self] in
            try? await Task.sleep(for: Self.draftPace)
            guard let self, !Task.isCancelled else { return }
            self.nextDraft = nil
            self.showDraft()
        }
    }

    private func showDraft() {
        guard isDraft, isLoaded, let webView else { return }
        draftShown = widget.source
        webView.callAsyncJavaScript(WidgetPage.showingDraft, arguments: ["html": WidgetPage.draft(widget.source)], in: nil, in: WidgetSandbox.world) { _ in }
        showNextDraft()
    }

    /// The fastest a draft is put in the page again.
    private static let draftPace = Duration.milliseconds(150)

    /// The widget is finished: the same web view loads it whole, scripts and all, under
    /// its own key, starting from the height the draft reached.
    func finish(as key: WidgetKey, widget: MarkdownWidget) {
        nextDraft?.cancel()
        nextDraft = nil
        self.key = key
        self.widget = widget
        keepsDraftRoom = !isPresentable
        isDraft = false
        reload()
    }

    // MARK: Measuring

    fileprivate func measuredPage(height: CGFloat, width: CGFloat, shows: Bool, interacted: Bool) {
        guard isCommitted, height.isFinite, width.isFinite, height >= 0, height <= 100_000, width > 0 else { return }
        pageWidth = width
        host?.pageLaidOut(atWidth: width)
        noteWidth(width)
        // A line or two is not yet enough to tell a drawing from the labels of controls
        // still on their way.
        if isDraft, shows, height >= WidgetSizing.floor, !isPresentable { isPresentable = true }
        var height = height.rounded(.up)
        if isDraft {
            // Being written, it only grows: a script cut out for now makes it no shorter
            // than it was a moment ago.
            height = max(height, measured?.height ?? 0)
        } else if !growth.record(height: Double(height), width: Double(width), interacted: interacted) {
            updateScrolling()
            return
        }
        if let measured, measured.height == height, measured.width == width { return }
        measured = (height, width)
        updateScrolling()
        if !isDraft { WidgetHeightStore.shared.record(height, for: key.source, width: width) }
    }

    /// The loaded page measured itself at `width` in its row: shown wider than it was
    /// drawn (`WidgetWidening`), it is drawn again once the width has stopped changing,
    /// if a script of its own draws it (a page of elements alone reflows by itself). Not
    /// in the expanded view, where the page goes as it is, with what was done in it.
    private func noteWidth(_ width: CGFloat) {
        guard !isDraft, isLoaded, let host, host.window != nil,
              abs(host.bounds.width - width) < WidgetHeights.widthStep else { return }
        // Narrower in the expanded view, it is drawn narrower there: back in its row it is
        // to be drawn again (`redrawIfBackWider`). Never drawn again in the expanded view.
        guard !host.isExpanded else {
            _ = widening.record(width: Double(width))
            return
        }
        // Back to a width it was drawn at before the width settled: not drawn again.
        guard widening.record(width: Double(width)), drawsWithScript else {
            redraw?.cancel()
            redraw = nil
            redrawsWhenBack = false
            return
        }
        redraw?.cancel()
        redraw = Task { [weak self] in
            try? await Task.sleep(for: Self.widthSettles)
            guard let self, !Task.isCancelled else { return }
            self.redraw = nil
            // Still where it was to be drawn again: not since moved into the expanded
            // view, out of the window, or let go of.
            guard self.isLoaded, let webView = self.webView else { return }
            guard let host = self.host, !host.isExpanded, host.window != nil, !host.sight.isOut,
                  webView.superview === host else {
                self.redrawsWhenBack = true
                return
            }
            #if DEBUG
            AppLog.chat.info("Visual \(self.key.block, privacy: .public) drawn again at \(Int(self.pageWidth ?? 0), privacy: .public) points wide")
            #endif
            self.reload()
        }
    }

    /// The user did something on the page: it is not drawn again as it is shown wider,
    /// which would lose that (`WidgetWidening.used`).
    fileprivate func pageUsed() {
        guard isCommitted else { return }
        widening.used()
        redraw?.cancel()
        redraw = nil
        redrawsWhenBack = false
    }

    /// How long the width of a page's row stays put before the page is drawn again at it.
    private static let widthSettles = Duration.milliseconds(500)

    private var drawsWithScript: Bool {
        widget.source.range(of: "<script", options: .caseInsensitive) != nil
    }
}

/// Why a visual was given up on.
enum WidgetFailure: Equatable {
    /// Its page stopped answering: a script of its own that never ends.
    case unresponsive
    /// Its page's process ended again and again while it was drawn (`WidgetEndings`).
    case keepsEnding

    /// The line over its source.
    var title: String {
        switch self {
        case .unresponsive: "Visual stopped responding"
        case .keepsEnding: "Visual could not be drawn"
        }
    }
}

/// Whether a page's process answers a script of the app's: not while a script of the
/// page's runs without end, which holds the page's only thread. Asked as it is made, so
/// that a page about to leave the window is asked while it is still in it; `answered`
/// then waits for the answer.
@MainActor
private final class PageProbe {
    private var answer: Bool?
    private var continuation: CheckedContinuation<Bool, Never>?

    init(_ webView: WKWebView) {
        // An error is an answer too: the process took the script.
        webView.callAsyncJavaScript("return 1", in: nil, in: WidgetSandbox.world) { [weak self] _ in self?.give(true) }
    }

    /// Whether it has answered, or does within `patience`.
    func answered(within patience: Duration) async -> Bool {
        if let answer { return answer }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: patience)
                self?.give(false)
            }
        }
    }

    private func give(_ answer: Bool) {
        guard self.answer == nil else { return }
        self.answer = answer
        continuation?.resume(returning: answer)
        continuation = nil
    }
}

// MARK: - Where the page may go

extension WidgetSession: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        guard let frame = action.targetFrame else {
            // For a new window.
            if action.navigationType == .linkActivated { openTapped(url) }
            return .cancel
        }
        guard frame.isMainFrame else { return .cancel }
        if url == loading {
            loading = nil
            return .allow
        }
        let page = WidgetPage.address(of: key.source)
        // A link within the page, as tabs are often made.
        if url.fragment != nil, url.withoutFragment == page, action.navigationType != .reload {
            return .allow
        }
        switch action.navigationType {
        case .reload:
            // A Mac's Reload in the page's menu: the page again, as the app loads it.
            reload()
        case .linkActivated:
            openTapped(url)
        default:
            break
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // A link meant for a new window opens in the browser, if it was tapped; a script's
        // pop-up does not open at all.
        if action.navigationType == .linkActivated, let url = action.request.url { openTapped(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if navigation === self.navigation { isCommitted = true }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === self.navigation else { return }
        isLoaded = true
        #if DEBUG
        if let madeAt { AppLog.chat.info("Visual \(self.key.block, privacy: .public) page loaded \(Int(Date.now.timeIntervalSince(madeAt) * 1000), privacy: .public) ms after it was asked for") }
        #endif
        loadWatch?.cancel()
        loadWatch = nil
        checksLoadWhenShown = false
        // The width it was drawn at, which a wider row draws it again from.
        if let pageWidth, let host, !host.isExpanded, abs(host.bounds.width - pageWidth) < WidgetHeights.widthStep {
            _ = widening.record(width: Double(pageWidth))
        }
        // A finished page has loaded once its `load` came, after its scripts ran.
        if isDraft { showDraft() } else if !isPresentable { isPresentable = true }
        if redrawsBehindPicture {
            redrawsBehindPicture = false
            host?.releaseCover()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        if navigation === self.navigation { failed(error) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        if navigation === self.navigation { failed(error) }
    }

    /// A page that could not load shows what it has, rather than the orb for ever. One
    /// cut short by the next load (the page made ready, `WidgetPool.warm`) is not one.
    private func failed(_ error: any Error) {
        guard (error as NSError).code != NSURLErrorCancelled, !isDraft else { return }
        isPresentable = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        // WebKit's process for the page ended (memory, a crash): its page is gone, and the
        // orb stands in for it until it is drawn again, now if it is shown, else when it
        // is next. One that keeps ending as it is drawn is given up on.
        #if DEBUG
        AppLog.chat.info("Visual \(self.key.block, privacy: .public) page's process ended, shown: \(self.isShown, privacy: .public)")
        #endif
        isLoaded = false
        isPresentable = false
        loadWatch?.cancel()
        loadWatch = nil
        guard isShown else {
            loadedTheme = nil
            return
        }
        if endings.ended(at: .now) { reload() } else { fail(.keepsEnding) }
    }

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo) async -> WKPermissionDecision {
        .deny
    }

    func webView(_ webView: WKWebView, contextMenuConfigurationFor elementInfo: WKContextMenuElementInfo) async -> UIContextMenuConfiguration? {
        nil
    }

    /// Opens a web address in the browser when the person just touched the widget: a
    /// link a script follows by itself goes nowhere.
    private func openTapped(_ url: URL) {
        guard url.scheme == "https" || url.scheme == "http", let host, host.wasJustTouched else { return }
        if let opened, opened.url == url, Date.now.timeIntervalSince(opened.at) < 2 { return }
        opened = (url, .now)
        UIApplication.shared.open(url)
    }
}

extension URL {
    fileprivate var withoutFragment: URL? {
        var parts = URLComponents(url: self, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.url
    }
}

private struct WeakHost {
    weak var view: WidgetHostView?
}

/// Takes the page's height to its session without holding on to it: WebKit keeps its
/// message handlers for as long as the web view lives.
private final class WidgetMessages: NSObject, WKScriptMessageHandler {
    weak var session: WidgetSession?

    init(_ session: WidgetSession?) {
        self.session = session
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.world == WidgetSandbox.world,
              let body = message.body as? [String: Any] else { return }
        if body["used"] as? Bool == true {
            session?.pageUsed()
            return
        }
        guard let height = (body["height"] as? NSNumber)?.doubleValue,
              let width = (body["width"] as? NSNumber)?.doubleValue else { return }
        session?.measuredPage(
            height: height, width: width, shows: (body["shows"] as? Bool) ?? true, interacted: (body["interacted"] as? Bool) ?? false
        )
    }
}

// MARK: - The view it is shown in

/// The view a widget's page is put in: in a row of the transcript, or expanded.
final class WidgetHostView: UIView {
    let isExpanded: Bool
    private var session: WidgetSession?
    private var touchedAt: Date?
    /// A still picture of the page where it was until a moment ago: in a row while the
    /// page is expanded, in the expanded view while it closes.
    private var picture: UIView?
    /// An expanded view that is closing: it shows no page any more, whatever it is asked.
    private var isLeaving = false
    /// The width the page that just arrived here was drawn at, until this view has a
    /// width of its own to compare it with (`pageArrived`).
    private var arrivedFrom: CGFloat?
    /// What covers the page until it has laid itself out here (`cover`), the width it was
    /// drawn at before, and when it is taken away at the latest.
    private var cover: (view: UIView, from: CGFloat)?
    private var uncovering: Task<Void, Never>?
    /// The page under the cover is being drawn again (`holdCover`): its layout at this
    /// width does not take the cover away, its load does (`releaseCover`).
    private var coverIsHeld = false
    /// When a held cover goes at the latest.
    private var heldUntil: ContinuousClock.Instant?
    /// Expanded wider than the row it came from (a Mac's panel), a page its own script
    /// draws (a chart) is shown scaled up to this view's width rather than drawn again,
    /// which would lose what was done on it (2026-10-22: "no need to redraw is it
    /// possible to just scale it?"): under a page zoom it keeps laying itself out as wide
    /// as it was drawn, `scalesFrom`. Nil, and narrower than that (a phone's sheet), it is
    /// at its own size.
    var scalesFrom: CGFloat? {
        didSet { if scalesFrom != oldValue { setNeedsLayout() } }
    }

    /// How near the screen it is in the chat (`WidgetSight`); expanded, it is seen.
    var sight: WidgetSight = .seen {
        didSet {
            if sight != oldValue { session?.sightChanged(in: self) }
        }
    }

    /// Whether the page takes touches and is read out by VoiceOver: not while it is drawn
    /// faded under the orb, not yet worth looking at (`WidgetFrame`), when nothing in it
    /// can be tapped or scrolled and a drag on it scrolls the chat. Said here as well as
    /// to SwiftUI, because UIKit then passes over the web view for certain.
    var takesTouches = true {
        didSet {
            isUserInteractionEnabled = takesTouches
            accessibilityElementsHidden = !takesTouches
        }
    }

    init(expanded: Bool) {
        isExpanded = expanded
        super.init(frame: .zero)
        // The app's look and text size, which the page is drawn in.
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitPreferredContentSizeCategory.self]) { (view: WidgetHostView, _: UITraitCollection) in
            view.session?.traitsChanged(in: view)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    func show(_ session: WidgetSession?) {
        guard session !== self.session, !isLeaving else { return }
        self.session?.hide(from: self)
        self.session = session
        // Another page's picture is not this one's; one leaving keeps its own.
        if session != nil {
            dropCover()
            dropPicture()
        }
        if window != nil { session?.show(in: self) }
        // The row is gone (the thread left, say): past the most recently seen few, the
        // pool lets go of the pages no row shows any more.
        if session == nil { WidgetPool.shared.trimSoon() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A row made ahead of the screen loads its page once it is in the window; one
        // taken out of it leaves its page to the pool's limit.
        if window != nil { session?.show(in: self) } else if session != nil { WidgetPool.shared.trimSoon() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        fitPage()
        coverIfDrawnElsewhere()
    }

    /// The page as large as this view, and at the zoom that keeps it as wide as it was
    /// drawn where it is scaled (`scalesFrom`).
    func fitPage() {
        for view in subviews where view !== picture { view.frame = bounds }
        if let page = page as? WKWebView, abs(page.pageZoom - zoom) > 0.001 { page.pageZoom = zoom }
    }

    /// How much the page is scaled up here: 1 unless it is (`scalesFrom`).
    private var zoom: CGFloat {
        guard isExpanded, let from = scalesFrom, from > 0, bounds.width > from + 1 else { return 1 }
        return bounds.width / from
    }

    // MARK: Covered until laid out

    /// The page was just put here, last drawn `width` wide: from a view of another width
    /// (into the expanded view, and back into its row), WebKit shows what it drew there,
    /// cut short or too narrow, for a few frames, until the page has laid itself out
    /// again; it is covered meanwhile (`cover`). From the same width (a row made again as
    /// the chat scrolls), nothing is.
    func pageArrived(drawnAt width: CGFloat?) {
        dropCover()
        guard let width else {
            dropPicture()
            return
        }
        arrivedFrom = width
        coverIfDrawnElsewhere()
    }

    private func coverIfDrawnElsewhere() {
        guard let from = arrivedFrom, bounds.width > 0 else { return }
        arrivedFrom = nil
        #if DEBUG
        AppLog.chat.info("Visual page arrived in a\(self.isExpanded ? "n expanded view" : " row", privacy: .public) \(Int(self.bounds.width), privacy: .public) points wide, drawn at \(Int(from), privacy: .public)")
        #endif
        guard abs(from - bounds.width / zoom) > 1 else {
            dropPicture()
            return
        }
        // The picture of the page kept here (a row the page comes back to), else the
        // page's background (the expanded view, on the chat's background).
        let view: UIView
        if let picture {
            view = picture
        } else {
            view = UIView(frame: bounds)
            view.backgroundColor = UIColor(Theme.pageBackground)
            view.isUserInteractionEnabled = false
        }
        addSubview(view)
        cover = (view, from)
        // The page is drawn on nothing (the chat shows through it), and so is a picture of
        // it: under the cover it would show through, twice over. Hidden until uncovered.
        page?.alpha = 0
        uncovering = Task { [weak self] in
            try? await Task.sleep(for: Self.coverAtMost)
            guard !Task.isCancelled else { return }
            self?.uncover()
        }
    }

    /// The page's web view, when it is here.
    private var page: UIView? { subviews.first { $0 is WKWebView } }

    /// The longest a page is covered, should it not say it has laid itself out.
    private static let coverAtMost = Duration.milliseconds(500)

    /// The page measured itself `width` wide: laid out at another width than it was
    /// drawn at before it came here, it is uncovered.
    func pageLaidOut(atWidth width: CGFloat) {
        guard let cover, !coverIsHeld, abs(cover.from - width) > 1 else { return }
        uncover()
    }

    /// The page that just arrived is drawn again under its cover: the cover stays until
    /// `releaseCover`, at most `heldAtMost`. False when nothing covers it.
    func holdCover() -> Bool {
        guard cover != nil else { return false }
        coverIsHeld = true
        let deadline = ContinuousClock.now + Self.heldAtMost
        heldUntil = deadline
        uncovering?.cancel()
        uncovering = Task { [weak self] in
            try? await Task.sleep(until: deadline)
            guard !Task.isCancelled else { return }
            self?.uncover()
        }
        return true
    }

    /// The page drawn again under the cover has loaded: the cover goes a moment later,
    /// once its script's first drawing (a chart's that grows in) has mostly run, and no
    /// later than it was held until.
    func releaseCover() {
        guard coverIsHeld else { return }
        let settled = ContinuousClock.now + Self.drawingSettles
        let deadline = heldUntil.map { min($0, settled) } ?? settled
        uncovering?.cancel()
        uncovering = Task { [weak self] in
            try? await Task.sleep(until: deadline)
            guard !Task.isCancelled else { return }
            self?.uncover()
        }
    }

    private static let heldAtMost = Duration.milliseconds(2500)
    private static let drawingSettles = Duration.milliseconds(700)

    private func uncover() {
        coverIsHeld = false
        heldUntil = nil
        uncovering?.cancel()
        uncovering = nil
        guard let view = cover?.view else { return }
        cover = nil
        if view === picture { picture = nil }
        let page = page
        UIView.animate(withDuration: 0.15, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction]) {
            view.alpha = 0
            page?.alpha = 1
        } completion: { _ in
            view.removeFromSuperview()
        }
    }

    private func dropCover() {
        arrivedFrom = nil
        coverIsHeld = false
        heldUntil = nil
        uncovering?.cancel()
        uncovering = nil
        page?.alpha = 1
        guard let view = cover?.view else { return }
        cover = nil
        if view === picture { picture = nil }
        view.removeFromSuperview()
    }

    /// Keeps a still picture of `webView` as it is now, until the page is back or the view
    /// shows another.
    func keepPicture(of webView: WKWebView) {
        dropCover()
        dropPicture()
        guard let picture = webView.snapshotView(afterScreenUpdates: false) else { return }
        picture.frame = webView.frame
        picture.isUserInteractionEnabled = false
        insertSubview(picture, at: 0)
        self.picture = picture
    }

    func dropPicture() {
        picture?.removeFromSuperview()
        picture = nil
    }

    /// The expanded view is closing: the page goes back under it, and it shows none again.
    func leave() {
        show(nil)
        isLeaving = true
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        if view != nil, event?.type == .touches { touchedAt = .now }
        return view
    }

    /// Whether the person touched the page a moment ago.
    var wasJustTouched: Bool {
        touchedAt.map { Date.now.timeIntervalSince($0) < 1.5 } ?? false
    }
}

/// How near the chat's view a visual's place is.
nonisolated enum WidgetSight: Equatable, Sendable {
    /// In view, or not in a scroll view at all.
    case seen
    /// Within `WidgetSizing.nearby` of the view: its page is made and drawn, ready to be seen.
    case near
    /// Within twice that: its page, if it has one, is kept out of the window, and one that
    /// has none (let go of, or never made) has a page made ready for it (`WidgetPool.warm`).
    case approaching
    /// Further: its page, if it has one, is kept out of the window.
    case away

    /// Whether its page is kept out of the window.
    var isOut: Bool { self == .approaching || self == .away }

    /// Where `proxy`'s view is from the nearest scroll view's visible part.
    init(_ proxy: GeometryProxy) {
        guard !DebugLaunch.keepsVisualsDrawn, let visible = proxy.bounds(of: .scrollView) else {
            self = .seen
            return
        }
        let place = CGRect(origin: .zero, size: proxy.size)
        if visible.intersects(place) {
            self = .seen
        } else if visible.insetBy(dx: 0, dy: -WidgetSizing.nearby).intersects(place) {
            self = .near
        } else if visible.insetBy(dx: 0, dy: -2 * WidgetSizing.nearby).intersects(place) {
            self = .approaching
        } else {
            self = .away
        }
    }
}

// MARK: - Heights

/// How tall a widget is shown.
enum WidgetSizing {
    /// The tallest a widget is shown: past it, its page scrolls inside its card.
    static var cap: CGFloat { Platform.isMac || UIDevice.current.userInterfaceIdiom == .pad ? 720 : 560 }
    /// The shortest.
    static let floor: CGFloat = 48
    /// Before anything is known of it.
    static let guess: CGFloat = 240
    /// The least a widget being written takes, so that it grows from there.
    static let draftFloor: CGFloat = 120
    /// The page's own space above and below what it shows (`WidgetSandbox.theme`).
    static let padding: CGFloat = 4
    /// How far from the chat's view a visual's page is drawn ahead of being seen, and kept
    /// drawn once it has been.
    nonisolated static let nearby: CGFloat = 600

    static func shown(_ height: CGFloat) -> CGFloat {
        min(max(height, floor), cap)
    }
}

/// The heights widgets were measured at (`WidgetHeights`), kept in the app's caches:
/// losing them costs a widget a jump the first time it is shown again, nothing more.
@MainActor
final class WidgetHeightStore {
    static let shared = WidgetHeightStore()

    private lazy var heights: WidgetHeights = (try? Data(contentsOf: Self.file)).flatMap { try? JSONDecoder().decode(WidgetHeights.self, from: $0) } ?? WidgetHeights()
    private let saving = CoalescedWork(after: .seconds(2))
    private var leaving: NSObjectProtocol?

    private init() {
        leaving = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { WidgetHeightStore.shared.saving.flush() }
        }
    }

    func height(for hash: UInt64, width: CGFloat) -> CGFloat? {
        heights.height(for: hash, width: Double(width)).map { CGFloat($0) }
    }

    func record(_ height: CGFloat, for hash: UInt64, width: CGFloat) {
        let before = self.height(for: hash, width: width)
        guard heights.record(Double(height), for: hash, width: Double(width)) else { return }
        AppLog.scroll.notice("visual \(String(hash, radix: 16).prefix(6), privacy: .public) height \(before.map { "\(Int($0))" } ?? "none", privacy: .public) -> \(Int(height), privacy: .public)")
        saving.ask { [weak self] in self?.save() }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(heights) else { return }
        try? FileManager.default.createDirectory(at: Self.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: Self.file, options: .atomic)
    }

    private static let file = URL.cachesDirectory.appending(path: "Portals/widget-heights.json")
}
