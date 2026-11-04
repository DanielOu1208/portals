import AgentCore
import Foundation
import HermesBackend
import Observation
import os
import SwiftUI

/// One host as the app sees it: the connection, its agents and their looks, and the
/// threads started there. `Fleet` holds one per host, and the thread on screen, which
/// may be another host's.
@Observable
final class HostModel: Identifiable {
    /// What an agent is up to across all its threads, for its row in the sidebar.
    enum Activity {
        case idle, working, waiting
    }

    /// How the connection is doing, for the dot by the host's name.
    enum Status {
        case connected, connecting, problem
    }

    private(set) var connection: ConnectionState = .disconnected(reason: nil)
    /// Whether the connection goes to the host's address or, for a Mac of the net that
    /// did not answer there, through the relay (`HermesBackend`), as of the last connection.
    private(set) var route = ConnectionRoute.direct
    /// The connection was let go of for the app leaving the screen, connected as it was,
    /// and the app is away, or back and connecting again: the screens show it as it was
    /// left (`shownConnection`, `ComingBack`), not "Not connected" and "Connecting…" in
    /// turn with a Retry button, on every return.
    private(set) var isAway = false
    /// The app is catching up with the host after coming back (`ComingBack.isQuiet`): what
    /// changed while it was away takes its place without the sidebar's animations, those
    /// that follow a layout as well (the groups on top growing or shrinking).
    private(set) var isCatchingUp = false
    @ObservationIgnored private var catchingUp: Task<Void, Never>?
    /// Where the app is in leaving and coming back, for `isAway` and for showing what the
    /// host says quietly while it catches up (`quietly`).
    @ObservationIgnored private var comingBack = ComingBack()
    /// Why the last attempt to connect failed; nil once connected.
    private(set) var connectionProblem: String?
    /// The app has stopped trying to connect: the sign-in or the address needs fixing.
    var connectionIsStopped: Bool {
        if case .stopped = connection { true } else { false }
    }
    /// The connection as the screens show it: connected while the app is away, or just
    /// back, from a connection it let go of itself (`isAway`).
    var shownConnection: ConnectionState {
        isAway ? .connected : connection
    }

    private(set) var agents: [Agent] = []
    /// Every thread this app started on the host, most recently active first. For a host
    /// that keeps the list of threads for every device (`syncsThreads`), every thread on
    /// it, with the ones on their way off it (`removing`), which the list does not show.
    private(set) var threads: [ThreadRecord] = [] {
        // A thread the host's list now has again is the host's to say about.
        // (Asked first: changing an observed value in place tells whoever shows it, even
        // when nothing in it changes.)
        didSet {
            threadPlaces = nil
            if !endedOutOfSight.isEmpty { endedOutOfSight.listed(threads) }
        }
    }
    /// Each thread's place in `threads`, by its id (`record(for:)`): made again the first
    /// time it is asked for after the list changed.
    @ObservationIgnored private var threadPlaces: [ThreadRef.ID: Int]?
    /// Threads whose turn ended here out of sight, on a host that keeps the list: unseen
    /// in the sidebar at once (`listedThreads`), until the host's list says so too.
    private var endedOutOfSight = EndedOutOfSight()
    /// Each thread the host last reported at work, with its revision in the list here
    /// then: one reported at rest since, whose revision is still that, ended out of
    /// sight of the list here too.
    @ObservationIgnored private var revisionAtWork: [ThreadRef.ID: Int?] = [:]
    /// Where the host's list was as it last said what is at work (`sessions.activity`).
    @ObservationIgnored private var heardList: ThreadListRevision?
    /// Threads whose turn ended here out of sight since: the turn at work then was that
    /// one, ended, so a turn begun by `heardList` had ended by a read now.
    @ObservationIgnored private var endedSinceHeard: Set<ThreadRef.ID> = []
    /// The host keeps the list of its threads for every device (a Portals bridge's
    /// `thread_sync`), and this device shows it: from the first time it was merged here
    /// until a connection finds the host without it.
    private(set) var syncsThreads = false
    /// The threads held here are the host's list as it stands, as this connection's last
    /// sync step found (`SyncStep.listIsCurrent`).
    @ObservationIgnored private var listIsCurrent = false
    /// Threads whose removal is on its way to the host: hidden until the host takes them
    /// off its list (and they are forgotten here) or says no (and they show again).
    private(set) var removing: Set<ThreadRef.ID> = []
    private(set) var looks: [Agent.ID: AgentLook] = [:]
    /// Who decided each look; a look saved before this was kept has none.
    private(set) var lookOrigins: [Agent.ID: LookOrigin] = [:]
    /// The host keeps how its agents look for every device (a Portals bridge's
    /// `agent_looks`), as of the last connection; before the first one of this launch,
    /// whether it did when a look was last saved.
    private(set) var keepsLooks = false
    /// Where each look stands with such a host: the host has it, or it was chosen here
    /// and the host has not taken it yet. A look that was never the host's has none.
    @ObservationIgnored private var lookStates: [Agent.ID: LookSyncState] = [:]
    /// The looks the host keeps, as it last listed them or answered.
    @ObservationIgnored private var hostLooks: HostLooks?
    @ObservationIgnored private var isAskingLooks = false
    @ObservationIgnored private var isSendingLooks = false
    /// The host has said on this launch's connection whether it keeps looks (`keepsLooks`).
    @ObservationIgnored private var hasSaidWhetherItKeepsLooks = false
    /// Counts the looks chosen here and the host's answers to them: a list of looks asked
    /// for before one of them is older than what this device holds, and is not taken.
    @ObservationIgnored private var lookChanges = 0
    /// The order the user gave the host's agents and folders in the sidebar. On a host
    /// that keeps it for every device (a Portals bridge's `sidebar_order`) it is the
    /// host's, but for a list arranged here that the host has not taken yet; elsewhere
    /// it is this device's own.
    private(set) var order = SidebarOrder()
    /// The order with where it stands with the host (`HeldSidebarOrder`).
    @ObservationIgnored private var heldOrder = HeldSidebarOrder()
    @ObservationIgnored private var isSyncingOrder = false
    /// Asked for while a sync of the order was running: the host's order is to be
    /// taken once more when that one ends.
    @ObservationIgnored private var asksOrderAgain = false
    /// The folders the host offers for new threads, as it last listed them; nil until
    /// asked, and for a host that offers none.
    private(set) var folders: FolderList?
    /// Why the folders could not be listed the last time they were asked for.
    private(set) var foldersProblem: String?
    /// Folders chosen in git worktrees, each with its repository's folder that was added in
    /// its place (`addFolder`): a new thread started in one is listed under that folder at
    /// once, before the host's list says so.
    @ObservationIgnored private var worktreeRepos: [String: String] = [:]
    /// Whether the host offers folders, as it said on the last connection; nil before.
    private var saysItOffersFolders: Bool?
    /// Whether a new thread's folder can be chosen in the Mac's own folder dialog: the
    /// host is on the Mac the app is on, and takes a folder chosen there (a bridge's
    /// `machine` and `folders_add`), as of the last connection.
    private(set) var choosesFoldersOnThisMac = false
    /// Whether the host is on the Mac the app is on (its bridge's `machine`), as of the last
    /// connection: what a Mac app joining a net is named after (`Net.device`).
    private(set) var isOnThisMac = false
    /// Whether the host keeps folders the user adds (`folders_add`), as of the last
    /// connection: one added there is a project in the sidebar from then on.
    private(set) var addsFolders = false
    /// Whether the host searches the folders under its home folder for the folder picker
    /// (a bridge's `folder_search`), as of the last connection: any of them can be found
    /// and added, where its folder dialog cannot be opened (a phone, another Mac).
    private(set) var searchesFolders = false
    /// The host keeps the titles the user gives threads (a bridge's `rename`), as of the
    /// last connection.
    private(set) var renamesThreads = false
    /// The version of the host's bridge, as it said on the last connection (Settings'
    /// About); nil before, from Hermes, and from a bridge from before it said.
    private(set) var bridgeVersion: String?
    /// Whether the host sends none of the kinds of notification turned off in Settings
    /// (a bridge's `push_muting`), as of the last connection.
    private(set) var mutesNotifications = false
    /// What keeps devices from reaching the host through the relay that the person can
    /// mend, as its bridge said on the last connection (`relay_problem`), for Settings.
    private(set) var relayProblem: HermesWire.GatewayReady.RelayProblem?
    /// The line Settings shows with the host for `relayProblem`.
    var relayWarning: String? { relayProblem?.message }
    /// A later version of the host's bridge that is out, as it said on connecting and in
    /// each poll since (`update_notice`), for Settings and the sidebar's footer; nil when
    /// there is none, and from a host that does not say.
    private(set) var update: HostUpdate?
    /// Whether the host's bridge says when a later version is out (`update_notice`), as of
    /// the last connection: its polls' word on it is taken, none included.
    @ObservationIgnored private var saysUpdates = false
    /// The registration for notifications last asked for, which the next waits for.
    @ObservationIgnored private var pushRegistration: Task<Void, Never>?
    /// Whether what answered at the host's address is Hermes on its own (`hermes serve`),
    /// not a Portals bridge, as it said on the last connection; false before it has said,
    /// and for a development switch's scripted host.
    private(set) var runsHermesAlone = false
    /// What the host last said its threads are doing (a bridge's `activity`), for the
    /// list: a turn started at the desk, or an approval waiting, in a thread not open here.
    private(set) var reportedActivity: [ThreadRef.ID: ThreadActivity] = [:]
    /// Of `reportedActivity`, the threads running only for the threads started from them
    /// at work (`ThreadActivityReport.inherited`): their own chat here does not say so.
    private var reportedInherited: Set<ThreadRef.ID> = []
    /// Of `reportedActivity`, the threads running with no turn of their own
    /// (`ThreadActivityReport.withoutTurn`): their leaving the report ends no turn.
    private var reportedWithoutTurn: Set<ThreadRef.ID> = []
    /// Whether the host offers the sessions started on it, in a terminal (a Portals
    /// bridge), as it said on the last connection; false until it has said.
    private(set) var offersDeskSessions = false
    /// Each agent's sessions from the desk, as the host last listed them; nil for an
    /// agent not asked about yet.
    private(set) var deskSessions: [Agent.ID: [DeskSession]] = [:]
    /// Why an agent's desk sessions could not be listed the last time they were asked for.
    private(set) var deskSessionsProblem: [Agent.ID: String] = [:]
    /// Why the app could not get as far as the host's agents.
    private(set) var problem: String?
    /// The host answered, and offers no agents: none of the ones it runs is set up on it.
    private(set) var offersNoAgents = false
    /// The host has listed its agents since launch.
    @ObservationIgnored private(set) var hasListedAgents = false

    /// Threads opened since launch, kept so a run going on in one keeps being followed
    /// while another is on screen; those at rest and looked at longest ago are let go
    /// (`letGoOfThreadsAtRest`).
    private var controllers: [ThreadRef.ID: ThreadController] = [:]
    private var draftControllers: [UUID: ThreadController] = [:]
    private var savedConversations: [UUID: SavedConversation] = [:]

    /// Conversations whose messages the host never confirmed, and that no thread in the
    /// list shows (`SavedConversation.isRecoverableDraft`): not one whose message is
    /// still on its way.
    var recoverableDrafts: [RecoverableDraft] {
        guard !savedConversations.isEmpty else { return [] }
        let listed = Set(threads.map(\.id))
        return savedConversations.values.filter { conversation in
            conversation.isRecoverableDraft(listed: listed, sending: draftControllers[conversation.id]?.isSending ?? false)
        }.map(\.summary).sorted { $0.updatedAt > $1.updatedAt }
    }
    /// The order threads were last put on screen in, the most recent last.
    @ObservationIgnored private var shownOrder: [ThreadRef.ID] = []
    /// What each agent offers its threads (models, slash commands), asked of the host
    /// the first time one of its threads is shown while connected.
    @ObservationIgnored private var offerings: [Agent.ID: AgentOfferings] = [:]
    @ObservationIgnored private var offeringsLoading: Set<Agent.ID> = []

    /// The host this model talks to. Another address or sign-in means another model.
    private(set) var host: HostConfig
    var id: HostID { host.id }
    /// Holds the thread on screen and is told what changes here.
    @ObservationIgnored weak var fleet: Fleet?

    @ObservationIgnored private let backend: any AgentBackend
    @ObservationIgnored private let store: ThreadStore
    /// The host's list of threads, kept in step with this device's: nil for a host that
    /// cannot keep one (the scripted backend). Whether it does is the host's to say.
    @ObservationIgnored private let sync: HostSync?
    /// The host is being asked what is at work, for the sidebar's poll.
    @ObservationIgnored private var isAskingActivity = false
    /// The host said something moved while it was being asked: it is asked once more.
    @ObservationIgnored private var asksActivityAgain = false
    @ObservationIgnored private var isWatchingConnection = false
    /// `start` is connecting and loading the agents itself.
    @ObservationIgnored private var isStarting = false
    @ObservationIgnored private var hasStarted = false
    /// The host was edited or removed and another model, or none, took over: nothing
    /// more is saved or reported from this one.
    @ObservationIgnored private var isRetired = false

    /// - Parameter relay: the way through the relay to the host, for a Mac of the device's
    ///   net (`RelayRoutes`); nil for one reached at its address alone.
    init(
        host: HostConfig,
        credentials: any CredentialStore,
        store: ThreadStore,
        relay: (@Sendable () async -> RelayRoute?)? = nil,
        backend: (any AgentBackend)? = nil
    ) {
        self.host = host
        let backend = backend ?? Self.makeBackend(for: host, credentials: credentials, relay: relay)
        self.backend = backend
        self.store = store
        sync = (backend as? any ThreadSyncing).map { HostSync(host: host.id, store: store, remote: $0) }
        agents = store.loadAgents().filter { $0.id.host == host.id && !$0.isAeri }
        threads = store.loadThreads().filter { $0.ref.agent.host == host.id }
        savedConversations = Dictionary(uniqueKeysWithValues: SubmissionStore(threads: store).load()
            .filter { $0.agent.host == host.id }.map { ($0.id, $0) })
        // Looks are given by the fleet, which sees every host's agents at once.
        looks = store.loadLooks().filter { $0.key.host == host.id }
        lookOrigins = store.loadLookOrigins().filter { $0.key.host == host.id }
        lookStates = store.loadLookStates().filter { $0.key.host == host.id }
        keepsLooks = !lookStates.isEmpty
        heldOrder = store.loadOrders()[host.id] ?? HeldSidebarOrder()
        order = heldOrder.order
        if let sync {
            // The threads are this model's, which the sync steps read and change.
            sync.heldThreads = { [weak self] in self?.threads ?? [] }
            sync.holdThreads = { [weak self] threads, forgotten in
                self?.hold(threads, forgetting: forgotten) ?? false
            }
            sync.lookedAt = { [weak self] in self?.lookedAtThread }
            sync.readHere = { [weak self] in self?.endedOutOfSight.readHere ?? [:] }
            sync.stepped = { [weak self] step in self?.stepped(step) }
            sync.poll = { [weak self] in self?.pollNow() }
            sync.heldRecent = { [weak self, id = host.id] in self?.fleet?.heldRecent(on: id) ?? [] }
            sync.recentCarried = { [weak self, id = host.id] threads in self?.fleet?.recentCarried(threads, on: id) }
            sync.recentReturned = { [weak self, id = host.id] threads in self?.fleet?.recentReturned(threads, on: id) }
            syncChanged()
        }
    }

    private static func makeBackend(
        for host: HostConfig, credentials: any CredentialStore, relay: (@Sendable () async -> RelayRoute?)?
    ) -> any AgentBackend {
        if let script = DebugLaunch.fakeScript {
            return FakeBackend(script: script, host: host.id, pace: DebugLaunch.fakePace)
        }
        // The network watched, so a change of it reconnects at once (`HermesBackend.networkChanged`).
        return HermesBackend(
            host: host.id,
            authenticator: HostDirectory.authenticator(for: host, credentials: credentials),
            network: SystemNetworkPaths(),
            relay: relay
        )
    }

    // MARK: Connecting

    /// Connects and refreshes the agents. Safe to call again after a failure. From then
    /// on the backend keeps the connection: it reconnects by itself, and the agents are
    /// refreshed each time it does.
    func start() async {
        guard !isRetired else { return }
        hasStarted = true
        watchConnection()
        isStarting = true
        defer { isStarting = false }
        do {
            problem = nil
            try await backend.connect()
            try await loadAgents()
        } catch {
            AppLog.chat.error("Could not reach \(self.host.name, privacy: .public): \(String(describing: error), privacy: .public)")
            problem = error.localizedDescription
        }
    }

    /// The host was edited, and a new model takes over: save, stop following threads,
    /// disconnect.
    func shutDown() {
        saveAll()
        retire()
        Task { [backend] in await backend.disconnect() }
    }

    /// The host is being removed from the app: stop following its threads, ask the host
    /// to stop sending notifications about them, disconnect, then `afterwards`. Nothing
    /// is saved: the fleet erases what was kept for the host.
    ///
    /// - Parameter quietly: nothing is asked of the host: the device left the net the host
    ///   is in, which takes care of that, or is not to be called.
    func shutDownForRemoval(quietly: Bool = false, afterwards: @escaping () -> Void) {
        // The threads this device is notified about: not the ones only listed by the host.
        let watched = connection == .connected && !quietly ? threads.filter { !$0.isFromHost }.map(\.id) : []
        // The address the hosts were given, also before this launch has one.
        let token = PushCoordinator.shared.lastDeviceToken
        retire()
        Task { [backend] in
            if let host = backend as? any PushRegistering, let token {
                for thread in watched { try? await host.unwatch(thread, deviceToken: token) }
            }
            await backend.disconnect()
            afterwards()
        }
    }

    private func retire() {
        isRetired = true
        fleet = nil
        // A step under way saves nothing more over what the next model, or the removal,
        // does with the host's files.
        sync?.stop()
        controllers.values.forEach { $0.close() }
        draftControllers.values.forEach { $0.close() }
    }

    /// The app left the screen: save, and let go of the connection. Runs carry on, on
    /// the host.
    func enterBackground() {
        saveAll()
        guard hasStarted, !isRetired else { return }
        stepComingBack { $0.left(connected: connection == .connected) }
        Task { await backend.suspend() }
    }

    /// The app is back: reconnect. The backend brings running threads up to date, and
    /// says which others to reopen (`threadDetached`).
    func enterForeground() {
        guard hasStarted, !isRetired else { return }
        var grace: Int?
        stepComingBack { grace = $0.back(at: .now) }
        if let grace {
            Task { [weak self] in
                try? await Task.sleep(for: ComingBack.grace)
                self?.stepComingBack { $0.graceEnded(grace) }
            }
        }
        Task { await backend.resume() }
    }

    private func stepComingBack(_ step: (inout ComingBack) -> Void) {
        step(&comingBack)
        if isAway != comingBack.isAway { isAway = comingBack.isAway }
        guard comingBack.isQuiet(at: .now), catchingUp == nil else { return }
        isCatchingUp = true
        catchingUp = Task { [weak self] in
            // Until the quiet is over, however far a reconnect moves its end.
            while let self, comingBack.isQuiet(at: .now) {
                try? await Task.sleep(for: .seconds(max(comingBack.quietUntil.timeIntervalSinceNow, 0.05)))
            }
            self?.isCatchingUp = false
            self?.catchingUp = nil
        }
    }

    private func watchConnection() {
        guard !isWatchingConnection else { return }
        isWatchingConnection = true
        if let net = backend as? any NetReporting {
            // Where the net's list is, and whether the host took the device's token (`Net`).
            let news = net.netNews
            Task { [weak self] in
                for await said in news {
                    guard let self, !isRetired else { return }
                    fleet?.net.said(said, by: self)
                }
            }
        }
        if let ways = backend as? any RouteReporting {
            // Through the relay or not, for the host's status ("via relay").
            let routes = ways.connectionRoutes
            Task { [weak self] in
                for await route in routes {
                    guard let self, !isRetired else { return }
                    self.route = route
                    AppLog.chat.notice("\(self.host.name, privacy: .public) is reached \(route == .relay ? "through the relay" : "at its address", privacy: .public)")
                }
            }
        }
        if let host = backend as? any HostMoveReporting {
            // A host that says when something moved (a bridge's `poll_now`) is polled a
            // moment later, its sidebar out or not (`HostSync.hostMoved`).
            let moves = host.hostMoves
            Task { [weak self] in
                for await _ in moves {
                    guard let self, !isRetired else { return }
                    sync?.hostMoved()
                }
            }
        }
        let states = backend.connectionStates
        Task { [weak self] in
            for await state in states {
                guard let self, !isRetired else { return }
                // Before a chat can see it: what the panel asks from here is the new connection's.
                if case .connected = state { ThreadPanelMemory.shared.connected(to: host.id) }
                connection = state
                ReturnProbe.shared?.note("connection", "\(state)")
                AppLog.chat.notice("Connection to \(self.host.name, privacy: .public): \(String(describing: state), privacy: .public)")
                // Whether the host keeps looks is the next connection's to say: the bridge
                // may have been updated meanwhile.
                if case .connected = state {} else {
                    hasSaidWhetherItKeepsLooks = false
                    listIsCurrent = false
                }
                // Back from being let go of, or failed to be: the connection shows as it is.
                stepComingBack { $0.connection(state, at: .now) }
                switch state {
                case .connected:
                    connectionProblem = nil
                    // Reconnected, or online at last after a start that failed.
                    if !isStarting {
                        // Back from the background, or from a drop: what is at work and
                        // the list first, at once, which the sidebar shows, rather than
                        // after the agents, their looks and the folders have been asked
                        // for one after another. What the greeting says of a later
                        // version goes before the poll, which has newer word of it.
                        await learnUpdate()
                        pollNow()
                        do {
                            try await loadAgents(polled: true)
                        } catch {
                            AppLog.chat.error("Could not list agents: \(String(describing: error), privacy: .public)")
                        }
                    }
                case let .disconnected(reason):
                    connectionProblem = reason ?? connectionProblem
                case let .stopped(reason):
                    connectionProblem = reason
                case .connecting:
                    break
                }
            }
        }
    }

    var isConnected: Bool { connection == .connected }

    /// The host's side of the net, for a bridge that offers it (`Net`).
    var netHost: (any NetReporting)? {
        backend as? any NetReporting
    }

    /// The net's list renamed the Mac, or the host learned which Mac it is: the same
    /// address and sign-in, so the connection stays.
    func renamed(_ config: HostConfig) {
        guard config.id == host.id, config.url == host.url, config.username == host.username, config.netMember == host.netMember else { return }
        host = config
    }

    /// How the connection is doing. Trying again after a failure counts as a problem,
    /// so the dot does not flicker while the backend retries.
    var status: Status {
        switch shownConnection {
        case .connected: .connected
        case .stopped: .problem
        case .connecting, .disconnected: connectionProblem == nil ? .connecting : .problem
        }
    }

    /// Connected through the relay: the status says so, in small text.
    var isViaRelay: Bool {
        status == .connected && route == .relay
    }

    /// For a Mac reached over Tailscale that does not answer: Tailscale on this device may
    /// be stuck (on iOS 27 it can look connected while nothing gets through after a move
    /// between Wi-Fi and cellular), which turning it off and on mends. Not for a sign-in the
    /// Mac refused: that is the Mac's answer, which came through.
    var tailscaleHint: String? {
        guard status == .problem, !connectionIsStopped, Self.isOnTailnet(host.url) else { return nil }
        return "If Tailscale is on, it may be stuck: turn it off and on in the Tailscale app."
    }

    /// Whether `url` is a Tailscale address: a MagicDNS name or one of its 100.64.0.0/10 IPs.
    static func isOnTailnet(_ url: URL) -> Bool {
        guard let name = url.host()?.lowercased() else { return false }
        if name.hasSuffix(".ts.net") { return true }
        let parts = name.split(separator: ".").compactMap { UInt8($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }

    /// The status in words.
    var statusText: String {
        switch status {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .problem: connectionProblem ?? "Not connected"
        }
    }

    /// - Parameter polled: what is at work and the list are being asked for already
    ///   (`pollNow`), and are not asked for again here.
    private func loadAgents(polled: Bool = false) async throws {
        // Aeri, which a bridge from before 2026-10-21 may still run, is listed nowhere.
        let listed = try await backend.listAgents().filter { !$0.isAeri }
        guard !isRetired else { return }
        quietly { agents = listed }
        // The looks the host keeps, before the fleet gives any to agents that have none.
        await takeLooks()
        await learnKind(polled: polled)
        await learnMachine()
        guard !isRetired else { return }
        saveAgents()
        problem = nil
        offersNoAgents = agents.isEmpty
        // Threads opened before the host answered carry the names saved last time.
        for controller in Array(controllers.values) + [threadOnScreen].compactMap({ $0 }) {
            if let current = agent(controller.agent.id) { controller.agentChanged(current) }
        }
        hasListedAgents = true
        ReturnProbe.shared?.note("agents-listed", host.name)
        fleet?.agentsListed(on: self)
        syncLooks()
        syncOrder(asking: true)
        registerForPush()
    }

    /// Records the id the host's bridge gave itself, by which the order of the user's
    /// Macs names this one: kept with the host, so the Mac has its place while it cannot
    /// be reached.
    private func learnMachine() async {
        guard let remote = backend as? any SidebarOrderSyncing, let id = await remote.machineID, !isRetired, host.machineID != id else { return }
        host.machineID = id
        fleet?.machineKnown(on: self)
    }

    /// Records what answered at the host's address, as it said when the app connected,
    /// and whether it offers folders, whose list is then asked for ahead of need.
    private func learnKind(polled: Bool) async {
        if let provider = backend as? any FolderProviding, let offers = await provider.offersFolders, !isRetired {
            saysItOffersFolders = offers
            let adds = await provider.addsFolders ?? false
            let searches = await provider.searchesFolders ?? false
            let machine = await provider.machine
            if !isRetired {
                addsFolders = offers && adds
                searchesFolders = offers && adds && searches
                isOnThisMac = machine.map(Platform.isThisMac) ?? false
                choosesFoldersOnThisMac = addsFolders && isOnThisMac
                // Kept with the host, for its icon and its word while it cannot be reached;
                // a Mac's is kept as none, as from a bridge from before Linux.
                if let machine, host.machineOS != (machine.os == "linux" ? "linux" : nil) {
                    host.machineOS = machine.os == "linux" ? "linux" : nil
                    fleet?.hostChanged(host)
                }
            }
            if offers, let agent = defaultAgent {
                Task { try? await loadFolders(for: agent.id) }
            } else if !offers {
                folders = nil
            }
        }
        if let host = backend as? any ThreadRenaming, let renames = await host.renamesThreads, !isRetired {
            renamesThreads = renames
        }
        if let nesting = backend as? any AgentThreadNesting, let nests = await nesting.nestsAgentThreads, !isRetired,
           (host.nestsAgentThreads == true) != nests {
            host.nestsAgentThreads = nests ? true : nil
            fleet?.hostChanged(host)
        }
        // On connecting, the host's list too: any change made here while away goes up.
        if !polled {
            await learnUpdate()
            await askWhatIsAtWork()
        }
        if let provider = backend as? any DeskSessionProviding, let offers = await provider.offersDeskSessions, !isRetired {
            offersDeskSessions = offers
            if !offers { deskSessions = [:] }
        }
        guard let gateway = backend as? HermesBackend, let ready = await gateway.gatewayReady, !isRetired else { return }
        bridgeVersion = ready.bridge?.version
        runsHermesAlone = ready.bridge == nil
        mutesNotifications = ready.bridge?.features.contains(BridgeWire.Feature.pushMuting) == true
        relayProblem = ready.bridge?.relayProblem
        guard ready.hostKind != host.kind else { return }
        host.kind = ready.hostKind
        fleet?.hostChanged(host)
    }

    /// What the host's greeting says of a later version (`update_notice`): once a
    /// connection, before its first poll, so that it never puts back an older word over
    /// what a poll said since (Codex's review, 2026-10-29).
    private func learnUpdate() async {
        guard let gateway = backend as? HermesBackend, let ready = await gateway.gatewayReady, !isRetired else { return }
        bridgeVersion = ready.bridge?.version
        saysUpdates = ready.bridge?.features.contains(BridgeWire.Feature.updateNotice) == true
        updateIs(ready.bridge?.latest)
    }

    /// The later version the host said is out, or none: set only when that changed, as a
    /// poll says it every few seconds.
    private func updateIs(_ latest: String?) {
        let said = HostUpdate(latest: latest, running: bridgeVersion)
        if said != update { update = said }
    }

    /// The thread on screen, when it is this host's.
    private var threadOnScreen: ThreadController? {
        fleet?.chat.flatMap { $0.agent.id.host == host.id ? $0 : nil }
    }

    // MARK: Notifications

    /// Tells the host where to send notifications and which threads they are about.
    /// Called whenever either may have changed: on connecting, when the device gets
    /// its address, when a thread is added or renamed.
    ///
    /// The threads are the ones this device started or took up: not the others a host
    /// that keeps the list for every device lists, so each device is notified about the
    /// threads it is about, as before.
    func registerForPush(only changed: [ThreadRecord]? = nil) {
        let threads = (changed ?? threads).filter { !$0.isFromHost }
        guard !isRetired, let host = backend as? any PushRegistering, connection == .connected,
              PushCoordinator.shared.deviceToken != nil, changed == nil || !threads.isEmpty else { return }
        let watched = threads.map { record in
            WatchedThread(
                id: record.id, agent: record.ref.agent.name,
                agentName: agent(record.ref.agent)?.displayName ?? record.ref.agent.name,
                title: record.ref.title
            )
        }
        // One after another, each with the choices as they are as it goes: one sent earlier
        // and answered later cannot leave the host with older ones (Settings, Notifications).
        let previous = pushRegistration
        pushRegistration = Task { [weak self] in
            await previous?.value
            guard let self, !self.isRetired, let token = PushCoordinator.shared.deviceToken else { return }
            // The relay token and this host's key go only to a bridge that takes them.
            let device = PushDevice(
                token: token, environment: PushCoordinator.environment, bundleID: Bundle.main.bundleIdentifier ?? "",
                relayToken: PushCoordinator.shared.relayToken, key: NotificationKeys.shared?.makeKey(for: self.host.id),
                muted: NotificationChoices.muted
            )
            do {
                try await host.register(device, watching: watched)
            } catch {
                // The host may not have the plugin: the app works without notifications.
                AppLog.push.error("Could not register with the host: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: Folders

    /// Whether the host's agents work in folders it offers (a Portals bridge): a new
    /// thread with one starts by choosing a folder. Before the host has said, a host
    /// that was a bridge last time is taken to be one.
    var offersFolders: Bool {
        saysItOffersFolders ?? (host.kind == .bridge)
    }

    /// Asks the host for the folders a new thread with `agent` can start in, and keeps
    /// the answer. The host's General folder is remembered, to name it in thread rows.
    @discardableResult
    func loadFolders(for agent: Agent.ID) async throws -> FolderList {
        guard let provider = backend as? any FolderProviding else { throw FolderError.unavailable }
        do {
            let list = try await provider.folders(for: agent)
            guard !isRetired else { return list }
            folders = list
            foldersProblem = nil
            threadOnScreen?.generalFolderKnown(list.general)
            if host.generalFolder != list.general.path {
                host.generalFolder = list.general.path
                fleet?.hostChanged(host)
            }
            return list
        } catch {
            if !isRetired { foldersProblem = error.localizedDescription }
            throw error
        }
    }

    /// Puts a folder the user chose (in the Mac's folder dialog, or from the host's list)
    /// on the host's list as one they added, so that a new thread can start there and the
    /// sidebar has it as a project, and gives it as the host lists it. Throws the host's
    /// reason for a folder it does not take.
    func addFolder(at path: String) async throws -> Folder {
        guard let provider = backend as? any FolderProviding else { throw FolderError.unavailable }
        let folder = try await provider.addFolder(at: path)
        // One chosen in a git worktree added its repository's: a thread started in the
        // worktree is listed under that one from the start, before the host lists it so.
        if let worktree = folder.worktree { worktreeRepos[worktree] = folder.path }
        // The list has it from now on, at the top: here at once, for the sidebar, and
        // then as the host gives it.
        if !isRetired, var list = folders, folder.path != list.general.path {
            var listed = folder
            listed.worktree = nil
            list.recent.removeAll { $0.path == folder.path }
            list.recent.insert(listed, at: 0)
            folders = list
        }
        if !isRetired { fleet?.folderAdded(folder, on: id) }
        reloadFolders()
        return folder
    }

    /// The folders under the host's home folder for what the person typed in the folder
    /// picker: fuzzy, or a path completed a level at a time (`FolderProviding.searchFolders`).
    /// Picking one goes through `addFolder`.
    func searchFolders(_ query: String, limit: Int = 30) async throws -> FolderSearchResults {
        guard let provider = backend as? any FolderProviding else { throw FolderError.unavailable }
        return try await provider.searchFolders(query, limit: limit)
    }

    /// Takes a folder the user added off the host's list again: a project with no
    /// thread leaves the sidebar.
    func removeFolder(at path: String) async throws {
        guard let provider = backend as? any FolderProviding else { throw FolderError.unavailable }
        try await provider.removeFolder(at: path)
        if !isRetired, let index = folders?.recent.firstIndex(where: { $0.path == path }) {
            folders?.recent[index].isAdded = false
        }
        reloadFolders()
    }

    private func reloadFolders() {
        guard let agent = defaultAgent else { return }
        Task { try? await loadFolders(for: agent.id) }
    }

    /// What to call the folder a thread works in, for its row; nil for a thread with no
    /// folder, and on a host whose agents do not work in folders.
    func folderName(of record: ThreadRecord) -> String? {
        guard offersFolders else { return nil }
        // One working in a git worktree is in its repository's project.
        if let repo = record.repo, !repo.isEmpty { return Folder.name(of: repo, general: host.generalFolder) }
        return record.ref.folderName(general: host.generalFolder)
    }

    /// The General folder as a folder, when the host has said where it is.
    private var generalFolder: Folder? {
        if let general = folders?.general { return general }
        return host.generalFolder.map { Folder(path: $0, name: Folder.generalName, isGeneral: true) }
    }

    // MARK: Sessions from the desk

    /// Asks the host for the sessions `agent` has that were started there, in a terminal,
    /// and keeps the answer.
    @discardableResult
    func loadDeskSessions(for agent: Agent.ID) async throws -> [DeskSession] {
        guard let provider = backend as? any DeskSessionProviding else { throw DeskSessionError.unavailable }
        do {
            let sessions = try await provider.deskSessions(for: agent)
            guard !isRetired else { return sessions }
            deskSessions[agent] = sessions
            deskSessionsProblem[agent] = nil
            return sessions
        } catch {
            if !isRetired { deskSessionsProblem[agent] = error.localizedDescription }
            throw error
        }
    }

    /// Takes up a session from the desk as a thread of the app's (continued, forked or
    /// only read), lists it under its agent and puts it on screen, with its history.
    func adopt(_ session: DeskSession, as mode: AdoptMode) async throws {
        guard let provider = backend as? any DeskSessionProviding else { throw DeskSessionError.unavailable }
        let ref = try await provider.adopt(session, as: mode)
        guard !isRetired else { return }
        deskSessions[session.agent]?.removeAll { $0.id == session.id }
        showAdopted(ref)
    }

    /// Registers a newly adopted or forked thread and opens its own composer.
    @discardableResult
    private func showAdopted(_ ref: ThreadRef) -> ThreadController? {
        // A thread taken up before (only read, say) is followed anew.
        controllers[ref.id]?.close()
        controllers[ref.id] = nil
        fleet?.chatsClosed()
        let record: ThreadRecord
        if let index = threads.firstIndex(where: { $0.id == ref.id }) {
            let old = threads[index]
            threads[index].ref = ref
            // Taking it up names it nothing: it keeps the title it had.
            threads[index].ref.title = ref.title ?? old.ref.title
            threads[index].updatedAt = .now
            // Taken up here, also when the host's list had it first: this device is
            // notified about it from now on.
            threads[index].fromHost = nil
            record = threads[index]
            if old.isFromHost { threadIsNew(record) }
        } else {
            record = ThreadRecord(ref: ref, updatedAt: .now)
            threads.append(record)
            threadIsNew(record)
        }
        threads.sort { $0.updatedAt > $1.updatedAt }
        saveThreads()
        guard let agent = agent(ref.agent) else { return nil }
        let controller = makeController(agent: agent, record: record)
        controllers[ref.id] = controller
        fleet?.show(controller)
        fleet?.threadUsed(controller)
        wasShown(ref.id)
        return controller
    }

    private(set) var forkingThreads: Set<ThreadRef.ID> = []

    func offersFork(_ thread: ThreadRef) -> Bool {
        offersDeskSessions && agent(thread.agent)?.forks(thread) == true
    }

    func canFork(_ thread: ThreadRef) -> Bool {
        offersFork(thread) && connection == .connected && activity(of: thread.id) == .idle && !forkingThreads.contains(thread.id)
    }

    /// A new thread with this one's history, put on screen without changing the source.
    func fork(_ thread: ThreadRef) async throws {
        guard canFork(thread) else { throw DeskSessionError.unavailable }
        forkingThreads.insert(thread.id)
        defer { forkingThreads.remove(thread.id) }
        try await adopt(DeskSession(thread: thread), as: .fork)
    }

    func canForkMessage(in controller: ThreadController) -> Bool {
        guard let thread = controller.thread else { return false }
        return controller.offersMessageFork && controller.canForkMessage && connection == .connected
            && activity(of: thread.id) == .idle && !forkingThreads.contains(thread.id)
    }

    /// Keeps the source and its draft, opening a separate thread at the selected turn.
    func forkMessage(in controller: ThreadController, checkpoint: MessageCheckpoint, before: Bool, draft: ComposerDraft?) async throws {
        guard let thread = controller.thread, let provider = backend as? any MessageForking,
              controller.offersMessageFork else { throw MessageForkError.unavailable }
        guard canForkMessage(in: controller) else { throw MessageForkError.busy }
        if draft != nil { try controller.beginMessageEditSend(at: checkpoint) }
        var sent = false
        defer { if draft != nil { controller.finishMessageEditSend(sent: sent) } }
        forkingThreads.insert(thread.id)
        defer { forkingThreads.remove(thread.id) }
        let ref = try await provider.fork(thread, at: checkpoint, before: before)
        guard !isRetired, !controller.isClosed, controllers[thread.id] === controller,
              let opened = showAdopted(ref) else { throw CancellationError() }
        if let draft {
            let mentions = FileMentionDraft.mentions(picked: draft.mentions, in: draft.text, hostTakesThem: true)
            opened.send(draft.text, images: draft.images, files: draft.files, mentions: mentions)
            sent = true
        }
    }

    private var undoingFiles: Set<ThreadRef.ID> = []

    func canUndoFiles(in controller: ThreadController) -> Bool {
        guard let source = controller.thread, controller.fileUndoTurn != nil,
              controller.canForkMessage, !controller.hasFileWork, connection == .connected,
              activity(of: source.id) == .idle, !forkingThreads.contains(source.id), !undoingFiles.contains(source.id),
              let folder = controller.fileUndoFolder, !folder.isEmpty else { return false }
        let normalized = (folder as NSString).standardizingPath
        let sameFolder: (String?) -> Bool = { path in
            path.map { ($0 as NSString).standardizingPath == normalized } ?? false
        }
        if threads.contains(where: { $0.id != source.id && sameFolder($0.ref.workingDirectory)
            && (activity(of: $0.id) != .idle || undoingFiles.contains($0.id) || forkingThreads.contains($0.id)) }) { return false }
        let known = Array(controllers.values) + Array(draftControllers.values) + [threadOnScreen].compactMap { $0 }
        return !known.contains { $0 !== controller && sameFolder($0.fileUndoFolder) && $0.hasFileWork }
    }

    func previewFileUndo(in controller: ThreadController, checkpoint: MessageCheckpoint) async throws -> TurnFileUndoPreview {
        guard canUndoFiles(in: controller), controller.fileUndoTurn?.fileUndoCheckpoint == checkpoint,
              let thread = controller.thread, let provider = backend as? any TurnFileUndoing else { throw TurnFileUndoError.busy }
        let preview = try await provider.previewFileUndo(thread, checkpoint: checkpoint)
        guard canUndoFiles(in: controller), controller.fileUndoTurn?.fileUndoCheckpoint == checkpoint else { throw TurnFileUndoError.stalePreview }
        return preview
    }

    func undoFiles(in controller: ThreadController, checkpoint: MessageCheckpoint, preview: TurnFileUndoPreview) async throws -> TurnFileUndoResult {
        guard canUndoFiles(in: controller), controller.fileUndoTurn?.fileUndoCheckpoint == checkpoint,
              let thread = controller.thread, let provider = backend as? any TurnFileUndoing else { throw TurnFileUndoError.busy }
        undoingFiles.insert(thread.id)
        defer { undoingFiles.remove(thread.id) }
        let result = try await provider.undoFiles(thread, preview: preview)
        guard !isRetired else { throw TurnFileUndoError.stalePreview }
        controller.fileUndoFinished(result)
        return result
    }

    func forkViewOnly(_ controller: ThreadController) async throws {
        guard let thread = controller.thread else { return }
        try await fork(thread)
    }

    // MARK: Agents

    func agent(_ id: Agent.ID) -> Agent? {
        agents.first { $0.id == id }
    }

    /// The agent a new thread on this host starts with.
    var defaultAgent: Agent? {
        agents.first(where: \.isDefault) ?? agents.first
    }

    func style(for agent: Agent.ID) -> AgentAvatarStyle {
        let logo = logo(for: agent)
        guard looks[agent] != nil else {
            // No look given yet (an agent just listed, or one only a saved thread names):
            // the logo all the same, as a look with no choice would show it.
            let look = self.look(for: agent)
            var style = AgentAvatarStyle.standard
            style.logo = logo
            style.showsLogo = look.shows(logo)
            if style.showsLogo {
                style.tint = AgentLookCatalogue.tints[look.tint].color
            }
            return style
        }
        return AgentLookCatalogue.style(for: look(for: agent), logo: logo)
    }

    /// The maker's logo of a coding agent this host runs: only a bridge's have one, and
    /// the bridge says which of its agents is whose (`Agent.kind`).
    func logo(for agent: Agent.ID) -> CodingAgentLogo? {
        CodingAgentLogo.logo(for: agent, kind: self.agent(agent)?.kind, hostKind: host.kind)
    }

    func look(for agent: Agent.ID) -> AgentLook {
        var look = looks[agent] ?? AgentLook.derived(from: agent.name, in: AgentLookCatalogue.size)
        // `showsLogo == true` is from before the logo was the default (when turning the
        // logo on disabled the colour picker and saved whatever random tint the agent had).
        if looks[agent] == nil || lookOrigins[agent] == .assigned || look.showsLogo == true,
           let logo = logo(for: agent), look.shows(logo) {
            look.tint = AgentLookCatalogue.defaultTint(for: logo)
        }
        return look
    }

    /// A look chosen by hand: the app never changes it. On a host that keeps looks it is
    /// every device's, once the host has taken it.
    func setLook(_ look: AgentLook, for agent: Agent.ID) {
        looks[agent] = look
        lookOrigins[agent] = .chosen
        lookStates[agent] = LookSyncState.chosen(hostKeepsLooks: hostKeepsLooks)
        lookChanges += 1
        saveLooks()
        fleet?.looksChanged()
        syncLooks()
    }

    /// Looks the fleet gave this host's agents, considering every host's (`Fleet.assignLooks`).
    func lookGiven(_ given: [Agent.ID: AgentLook]) {
        var changed = false
        for (agent, look) in given where agent.host == host.id && looks[agent] != look {
            looks[agent] = look
            lookOrigins[agent] = .assigned
            lookStates[agent] = nil
            changed = true
        }
        guard changed else { return }
        saveLooks()
        syncLooks()
    }

    // MARK: Looks every device shares

    /// Whether the host keeps looks, as it said on this launch's connection; nil before it
    /// has, for a host that may.
    private var hostKeepsLooks: Bool? {
        guard backend is any LookSyncing else { return false }
        return hasSaidWhetherItKeepsLooks ? keepsLooks : nil
    }

    /// Who decided each look, as the fleet reads it when it gives looks: one that is, or
    /// is about to be, the host's for every device is not this device's to change,
    /// whoever decided it.
    var settledLookOrigins: [Agent.ID: LookOrigin] {
        guard keepsLooks else { return lookOrigins }
        return lookOrigins.merging(lookStates.mapValues { _ in LookOrigin.chosen }) { _, settled in settled }
    }

    /// Asks a host that keeps how its agents look (`LookSyncing`) for the looks, and
    /// draws each agent as the host has it. On connecting, and when the host says a look
    /// changed.
    private func takeLooks() async {
        guard let remote = backend as? any LookSyncing, !isAskingLooks else { return }
        isAskingLooks = true
        defer { isAskingLooks = false }
        guard let keeps = await remote.syncsLooks, !isRetired else { return }
        keepsLooks = keeps
        hasSaidWhetherItKeepsLooks = true
        guard keeps else {
            hostLooks = nil
            // A choice made before the host said is the device's own after all.
            if lookStates.values.contains(.pending) {
                lookStates = lookStates.filter { $0.value != .pending }
                saveLooks()
            }
            return
        }
        do {
            // A look chosen or answered while the list was on its way is newer than it:
            // the list is asked for again.
            var asked = lookChanges
            var listed = try await remote.hostLooks()
            for _ in 0..<3 where lookChanges != asked {
                asked = lookChanges
                listed = try await remote.hostLooks()
            }
            guard !isRetired, lookChanges == asked else { return }
            hostLooks = listed
            stepLooks()
        } catch {
            AppLog.chat.error("Could not ask how the agents look: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The host said where its looks are: when that is not where this device took them
    /// last, it asks for them again.
    private func looksAre(at list: LookListRevision?) {
        guard let list, list != hostLooks?.list, !isAskingLooks else { return }
        Task {
            await takeLooks()
            syncLooks()
        }
    }

    /// One pass over the host's agents with the looks it last listed (`LookStep`): a
    /// look the host has is taken, and what is this device's to send is returned.
    @discardableResult
    private func stepLooks() -> [(agent: Agent.ID, look: HostLook, unless: LookCondition?)] {
        guard keepsLooks, let listed = hostLooks?.looks else { return [] }
        var sends: [(agent: Agent.ID, look: HostLook, unless: LookCondition?)] = []
        holdingLooks {
            for agent in agents.map(\.id) {
                let held = looks[agent].map { HeldLook($0, origin: lookOrigins[agent], state: lookStates[agent]) }
                switch LookStep.step(held: held, host: listed[agent.name]) {
                case let .take(look)?: hold(look, for: agent)
                case let .send(look, unless)?: sends.append((agent, look, unless))
                case nil: break
                }
            }
        }
        return sends
    }

    /// Sends the host what is this device's to send: a look chosen here, and the look of
    /// an agent the host has none for. One at a time; each answer is the look the agent
    /// has on the host now, which is the one drawn from then on. A send that fails is
    /// made again on the next connection, or when the host next says a look changed.
    private func syncLooks() {
        guard case .connected = connection, !isSendingLooks, !isRetired, let remote = backend as? any LookSyncing else { return }
        let sends = stepLooks()
        // Taking the host's looks may have had the fleet give this host's other agents
        // new ones, which started sending already, with these among them.
        guard !sends.isEmpty, !isSendingLooks else { return }
        isSendingLooks = true
        Task {
            var failed = false
            for send in sends {
                do {
                    let kept = try await remote.setLook(send.look, for: send.agent, unless: send.unless)
                    guard !isRetired else { break }
                    took(kept, for: send.agent, sent: send.look, unless: send.unless)
                } catch {
                    AppLog.chat.error("The host did not take \(send.agent.name, privacy: .public)'s look: \(error.localizedDescription, privacy: .public)")
                    failed = true
                    break
                }
            }
            isSendingLooks = false
            // A look chosen while these were on their way goes next.
            if !failed, !isRetired { syncLooks() }
        }
    }

    /// The host answered a look sent to it with the one the agent has there now.
    private func took(_ kept: HostLook, for agent: Agent.ID, sent: HostLook, unless: LookCondition?) {
        lookChanges += 1
        hostLooks?.looks[agent.name] = kept
        // Chosen here while that one was on its way: the choice is sent next.
        let held = looks[agent].map { HeldLook($0, origin: lookOrigins[agent], state: lookStates[agent]) }
        guard LookStep.answerSettles(held, sent: sent, unless: unless) else { return }
        holdingLooks { hold(kept, for: agent) }
    }

    /// An agent's look as the host has it.
    private func hold(_ kept: HostLook, for agent: Agent.ID) {
        looks[agent] = kept.look
        lookOrigins[agent] = kept.origin
        lookStates[agent] = .kept
    }

    /// Runs `change`, which takes looks from the host, then saves what it changed and,
    /// when an agent is drawn differently for it, tells the fleet.
    private func holdingLooks(_ change: () -> Void) {
        let before = (looks: looks, origins: lookOrigins, states: lookStates)
        quietly(change)
        guard looks != before.looks || lookOrigins != before.origins || lookStates != before.states else { return }
        saveLooks()
        if looks != before.looks { fleet?.looksTaken() }
    }

    // MARK: The sidebar's order

    /// The user put the host's agents or its folders in an order: `names` is every row
    /// of that kind as the sidebar lists them now, an empty list no order at all. Shown
    /// at once, kept on the device, and sent to a host that keeps the order.
    func arrange(_ kind: SidebarOrder.Kind, _ names: [String]) {
        guard order[kind] != names else { return }
        heldOrder.arrange(kind, names)
        order = heldOrder.order
        store.saveOrder(heldOrder, for: host.id)
        syncOrder(asking: false)
    }

    /// The host said where its order is: when that is not where this device took it
    /// last, it asks for it again.
    private func orderIs(at list: SidebarOrderRevision?) {
        guard let list, list != heldOrder.list else { return }
        syncOrder(asking: true)
    }

    /// The host's copy of the order of the user's Macs, as it last said.
    var saidMachineOrder: MachineOrder? {
        heldOrder.machines
    }

    /// The order of the user's Macs this device goes by changed, or may be newer than
    /// the host's copy: the host is given it if so.
    func machineOrderChanged() {
        syncOrder(asking: false)
    }

    /// Brings the order in step with a host that keeps it for every device
    /// (`SidebarOrderSyncing`): what was arranged here is sent first, each list whole,
    /// then the order of the user's Macs when the host's copy is behind the one this
    /// device goes by, and with `asking` the host's order is then taken. One pass at a
    /// time. A send that fails stays this device's and is made again on the next
    /// connection.
    private func syncOrder(asking: Bool) {
        guard case .connected = connection, !isRetired, let remote = backend as? any SidebarOrderSyncing else { return }
        guard !isSyncingOrder else {
            asksOrderAgain = asksOrderAgain || asking
            return
        }
        isSyncingOrder = true
        Task {
            var asks = asking
            var failed = false
            do {
                if await remote.syncsSidebarOrder == true {
                    let keepsMachines = await remote.syncsMachineOrder == true
                    // Each copy goes once a pass; an arrangement made during a send goes next.
                    var gaveMachines: MachineOrder?
                    repeat {
                        var answered = false
                        while let sending = heldOrder.toSend {
                            let answer = try await remote.setSidebarOrder(agents: sending.agents, folders: sending.folders)
                            guard !isRetired else { break }
                            holdOrder { $0.sent(sending, answered: answer) }
                            answered = true
                        }
                        if keepsMachines, let machines = heldOrder.machinesToSend(fleet?.machineOrder, after: gaveMachines), !isRetired {
                            gaveMachines = machines
                            // Its answer is its copy now: the one given, or one arranged later.
                            let answer = try await remote.setMachineOrder(machines)
                            guard !isRetired else { break }
                            holdOrder { $0.take(answer) }
                            answered = true
                        }
                        // An answer to a send is the host's order as it is now.
                        if (asks || asksOrderAgain), !answered, !isRetired {
                            let listed = try await remote.sidebarOrder()
                            guard !isRetired else { break }
                            holdOrder { $0.take(listed) }
                        }
                        asks = false
                        asksOrderAgain = false
                        // A row moved while the host was answering goes next.
                    } while (heldOrder.toSend != nil || (keepsMachines && heldOrder.machinesToSend(fleet?.machineOrder, after: gaveMachines) != nil)) && !isRetired
                }
            } catch {
                AppLog.chat.error("Could not bring the sidebar's order in step: \(error.localizedDescription, privacy: .public)")
                failed = true
            }
            isSyncingOrder = false
            let again = asksOrderAgain
            asksOrderAgain = false
            if again, !failed, !isRetired { syncOrder(asking: true) }
        }
    }

    /// Runs `change` on the order this device holds, then shows and saves what it
    /// changed.
    private func holdOrder(_ change: (inout HeldSidebarOrder) -> Void) {
        let before = heldOrder
        change(&heldOrder)
        guard heldOrder != before else { return }
        if order != heldOrder.order { quietly { order = heldOrder.order } }
        store.saveOrder(heldOrder, for: host.id)
        if heldOrder.machines != before.machines { fleet?.machineOrderSaid(by: self) }
    }

    /// Makes a change to what the screens show from what the host said, without their
    /// animations while the app is catching up after coming back (`quietUntil`).
    private func quietly(_ change: () -> Void) {
        guard comingBack.isQuiet(at: .now) else { return change() }
        withTransaction(\.disablesAnimations, true, change)
    }

    /// Working while any of the agent's threads runs; waiting when one needs an answer.
    func activity(of agent: Agent.ID) -> Activity {
        let own = controllers.values.filter { $0.agent.id == agent && $0.followsHost }
        // The few threads the host reported at work, each found by its id
        // (`record(for:)`): not every thread of the list for each of them, nor for each
        // bot's avatar, each time the sidebar is drawn.
        let reported = reportedActivity.compactMap { id, state in
            record(for: id)?.ref.agent == agent ? state : nil
        }
        if own.contains(where: { $0.pendingRequest != nil }) || reported.contains(.waiting) { return .waiting }
        if own.contains(where: \.isAtWork) || reported.contains(.running) { return .working }
        return .idle
    }

    /// The host's side of the panel over a chat (`ThreadPanelProviding`): nil from a host
    /// without it.
    var panelProvider: (any ThreadPanelProviding)? {
        backend as? any ThreadPanelProviding
    }

    /// The thread with this id in `threads`, found by its place (`threadPlaces`) rather
    /// than by going through the list: the sidebar asks for each thread that may be at
    /// work, for each agent's and each folder's row, each time it is drawn.
    func record(for id: ThreadRef.ID) -> ThreadRecord? {
        // Read whether or not the thread is there: whoever asks is told when the list changes.
        let list = threads
        let places = threadPlaces ?? Dictionary(list.indices.map { (list[$0].id, $0) }, uniquingKeysWith: { first, _ in first })
        if threadPlaces == nil { threadPlaces = places }
        return places[id].map { list[$0] }
    }

    /// The threads that may be running or waiting for an answer: the ones the host
    /// reported at work and the ones open here. Any other is at rest (`activity(of:)`),
    /// so the sidebar asks only these, not every thread of the list.
    var threadsMaybeAtWork: Set<ThreadRef.ID> {
        Set(reportedActivity.keys).union(controllers.keys)
    }

    // MARK: Threads

    /// Whether a thread is running or waiting for an answer right now, as its open
    /// thread here knows while it follows the host, or as the host last said. Running is
    /// what the host means by it: a turn, or an agent the thread set to work still at it,
    /// not a command it left running in the background (`Subagent.keepsThreadAtWork`).
    /// The open thread's word on that alone (its turn) took it out of Running each time
    /// the host's was let go (`persist`) while such an agent worked on past the turn, and
    /// the next poll put it back.
    func activity(of thread: ThreadRef.ID) -> Activity {
        let controller = controllers[thread].flatMap { $0.followsHost ? $0 : nil }
        if controller?.pendingRequest != nil || reportedActivity[thread] == .waiting { return .waiting }
        if controller?.isAtWork == true || reportedActivity[thread] == .running { return .working }
        return .idle
    }

    /// Asks the host which threads are running or waiting now, when it says (a bridge),
    /// and brings the list in step with a host that keeps it for every device. Every few
    /// seconds while the sidebar is out, in a task of its own: a host slow to answer
    /// skips its own polls until it does, and holds up no other host's.
    func refreshActivity() {
        // A thread can come to rest without a turn ending (its last subagent stopped,
        // a message failed on its way): it is let go at the next poll.
        letGoOfThreadsAtRest()
        guard case .connected = connection, !isAskingActivity else { return }
        askActivity()
    }

    /// The same poll, asked for by the host (`HostSync.poll`, after it said something
    /// moved), whether or not the sidebar is out. One asked for while a poll is on its way
    /// is not skipped: that one may have been asked before what moved, and the host is
    /// asked once more after it.
    private func pollNow() {
        guard !isRetired else { return }
        letGoOfThreadsAtRest()
        guard case .connected = connection else { return }
        if isAskingActivity {
            asksActivityAgain = true
        } else {
            askActivity()
        }
    }

    private func askActivity() {
        isAskingActivity = true
        Task {
            repeat {
                asksActivityAgain = false
                await askWhatIsAtWork()
            } while asksActivityAgain && !isRetired
            isAskingActivity = false
        }
    }

    /// Asks the host which threads are running or waiting now, when it says, then runs a
    /// sync step with the list as it gave it. One it said was at work and no longer is,
    /// with no thread here following it to say so itself, finished out of sight: unless
    /// the host keeps the list, which says so itself.
    private func askWhatIsAtWork() async {
        var list: ThreadListRevision?
        if let host = backend as? any ThreadActivityReporting, await host.reportsActivity == true {
            do {
                let report = try await host.threadActivity()
                guard !isRetired else { return }
                // Not one only its subagents or threads it started kept at work: its turn's
                // end was told before.
                let ended = report.ended(since: reportedActivity, withoutTurn: reportedWithoutTurn).filter { id in
                    controllers[id]?.followsHost != true && fleet?.chat?.thread?.id != id
                }
                quietly { reportedActivity = report.threads }
                reportedInherited = report.inherited
                reportedWithoutTurn = report.withoutTurn
                heardList = report.list
                endedSinceHeard = []
                if !ended.isEmpty {
                    if keepsList {
                        // Unseen here at once, until the list fetched below says so too:
                        // one the list here has not changed since it was last reported at
                        // work. Changed since, the list already says how its turn ended,
                        // unseen or seen on another device meanwhile.
                        for record in threads where ended.contains(record.id) {
                            guard let atWork = revisionAtWork[record.id], record.revision == atWork else { continue }
                            noteEndedOutOfSight(record)
                        }
                    } else {
                        markUnseen(ended, touched: true)
                    }
                }
                revisionAtWork = Dictionary(
                    threads.filter { report.threads[$0.id] != nil }.map { ($0.id, $0.revision) },
                    uniquingKeysWith: { first, _ in first }
                )
                if !endedOutOfSight.isEmpty { endedOutOfSight.expire() }
                list = report.list
                looksAre(at: report.looks)
                orderIs(at: report.order)
                if saysUpdates { updateIs(report.update) }
            } catch {
                AppLog.chat.error("Could not ask which threads are at work: \(error.localizedDescription, privacy: .public)")
            }
        }
        syncThreads(listNow: list)
    }

    /// Opens an empty thread with `agent`, in `folder` when the host offers folders
    /// (General when none is given). A thread with nothing in it yet, in the same folder,
    /// is reused.
    func newThread(with agent: Agent, in folder: Folder? = nil) {
        // An agent that keeps one ongoing conversation has no other: every new thread with
        // it is that one. Not on the list yet, it is found or made as the first message goes.
        if let ongoing = threads.first(where: { $0.ref.agent == agent.id && $0.ref.isOngoing }), !removing.contains(ongoing.id) {
            fleet?.open(ongoing)
            return
        }
        // General, when no folder is chosen, is left to the host; it is only named here,
        // and not for an agent that was not asked where to work.
        let asked = fleet?.choosesFolder(for: agent.id) ?? offersFolders
        let shown = offersFolders ? folder ?? (asked ? generalFolder : nil) : nil
        // Asked for after a thread being read from its saved copy, it takes its place, also
        // when the empty thread on screen is kept.
        _ = fleet?.navigated()
        if let chat = fleet?.chat, chat.isEmpty, chat.thread == nil, chat.agent.id == agent.id, chat.folder?.path == shown?.path { return }
        // The new thread kept with what was typed in it, with this agent and folder, is
        // this one again.
        if let kept = fleet?.draftTab, !kept.isClosed, kept.agent.id == agent.id, kept.folder?.path == shown?.path {
            fleet?.showDraftTab()
            return
        }
        fleet?.show(makeController(agent: agent, record: nil, folder: shown, workingDirectory: offersFolders ? folder?.path : nil))
    }

    func openRecoverableDraft(_ draft: RecoverableDraft, opened: @escaping () -> Void) {
        guard let fleet, !isRetired, let saved = savedConversations[draft.id], saved.agent.host == host.id else { return }
        let controller = draftControllers[draft.id] ?? saved.thread.flatMap { controllers[$0.id] }
            ?? makeController(agent: agent(saved.agent) ?? Agent(id: saved.agent), record: nil, recovery: saved)
        draftControllers[draft.id] = controller
        fleet.show(controller)
        fleet.threadUsed(controller)
        opened()
    }

    func discardRecoverableDraft(_ draft: RecoverableDraft) {
        // Not while its message is on its way: the host may be running it.
        guard let saved = savedConversations[draft.id], draftControllers[draft.id]?.isSending != true else { return }
        do {
            try SubmissionStore(threads: store).remove(draft.id)
            // Removal and close cannot be interleaved by a main-actor RPC completion.
            // If removal fails, the still-open controller remains usable.
            let controller = draftControllers.removeValue(forKey: draft.id)
            controller?.close()
            savedConversations[draft.id] = nil
            if let controller, fleet?.chat === controller {
                fleet?.show(makeController(agent: agent(saved.agent) ?? Agent(id: saved.agent), record: nil))
            }
        } catch {
            // Keep the recovery row if its bytes could not be removed.
        }
    }

    /// Puts a thread on screen, then calls `shown`. One in memory shows at once; one let go
    /// of, or not opened since launch, once its saved copy has been read, which is done off
    /// the main thread (`readingNow` reads it there, for the few callers that cannot wait:
    /// the thread left on screen as the app starts again). Meanwhile what was on screen
    /// stays; asked for something else before it is read, or its tab closed, it is not
    /// shown. False when it cannot be opened, its agent gone, and nothing changes on screen.
    @discardableResult
    func open(_ record: ThreadRecord, readingNow: Bool = false, then shown: (() -> Void)? = nil) -> Bool {
        // Whatever was asked for before, and is still being read, gives way to this, also
        // when this is the thread on screen already.
        let request = fleet?.navigated()
        if fleet?.chat?.thread?.key == record.key {
            // Its tab closed a moment ago, while the one beside it was still being read:
            // it stays, and is a tab again.
            fleet?.shownAgain(record.key)
            shown?()
            return true
        }
        if let live = controllers[record.id] {
            // Its chat kept built out of sight (`Fleet.keptChats`), or made anew.
            OpenProbe.requested(record.id.rawValue, how: fleet?.keptChats.contains { $0 === live } == true ? "kept" : "warm")
            fleet?.show(live)
            wasShown(record.id)
            shown?()
            return true
        }
        guard let agent = agent(record.ref.agent) else {
            shown?()
            return false
        }
        OpenProbe.requested(record.id.rawValue, how: "load")
        let reading = ContinuousClock.now
        guard !readingNow else {
            show(makeController(agent: agent, record: record, cached: store.loadTranscript(for: record.key)), for: record, readIn: .now - reading)
            shown?()
            return true
        }
        // The saved copy of a long thread is most of a megabyte of JSON, which the main
        // thread read and decoded at the tap, the sidebar and chat stuck meanwhile.
        let store = store
        fleet?.beingRead = record.key
        Task {
            let cached = await store.loadTranscriptInBackground(for: record.key)
            // Something else was put on screen, or asked for, or its tab closed, meanwhile.
            guard let fleet, fleet.navigation == request, !isRetired else { return }
            // Taken off the list meanwhile (removed here, or on another device), or on its way
            // off it (removed here, the host not yet told): not shown again. As the list has
            // it now, else.
            guard !removing.contains(record.id), let current = threads.first(where: { $0.id == record.id }) else {
                fleet.notShown(record.key)
                return
            }
            if let live = controllers[current.id] {
                fleet.show(live)
                wasShown(current.id)
            } else if let agent = self.agent(current.ref.agent) {
                show(makeController(agent: agent, record: current, cached: cached), for: current, readIn: .now - reading)
            } else {
                fleet.notShown(record.key)
            }
            shown?()
        }
        return true
    }

    /// Follows a listed thread off screen, as one left at work there is: the demo's thread
    /// for Codex's reviews (`Fleet.startTour`), whose review shows at work at the foot of
    /// the tour's chat. Shown later, it is this one.
    func follow(_ record: ThreadRecord) {
        guard !isRetired, controllers[record.id] == nil, let agent = agent(record.ref.agent) else { return }
        let controller = makeController(agent: agent, record: record)
        controllers[record.id] = controller
        controller.prepare()
    }

    /// A thread opened from its saved copy, put on screen.
    private func show(_ controller: ThreadController, for record: ThreadRecord, readIn duration: Duration) {
        OpenProbe.step(record.id.rawValue, controller.isEmpty ? "cold" : "saved", took: duration)
        SidebarProbe.mark("thread-read", detail: String(format: "%.1f", Double(duration.components.attoseconds) / 1e15 + Double(duration.components.seconds) * 1000))
        controllers[record.id] = controller
        fleet?.show(controller)
        wasShown(record.id)
    }

    /// A thread was put on screen: the threads at rest looked at longest ago are let go.
    private func wasShown(_ id: ThreadRef.ID) {
        shownOrder.removeAll { $0 == id }
        shownOrder.append(id)
        letGoOfThreadsAtRest()
    }

    /// Closes the threads opened earlier that are at rest and off screen, past the few
    /// looked at last (`OpenThreads`), this device's open tabs kept before the others,
    /// saving each first. Opened again, one shows its saved copy and is brought in line
    /// with the host, as after a launch.
    private func letGoOfThreadsAtRest() {
        let onScreen = fleet?.chat?.thread?.id
        let atRest = Set(controllers.filter { $0.value.isAtRest && $0.value.editingMessage == nil }.keys)
        let tabs = Set(fleet?.tabs.keys.filter { $0.host == host.id }.map(\.id) ?? [])
        // As many at rest as the chats kept built where the tabs are, should those be more
        // (`Fleet.chatsKeptBehind`): a chat kept built is one held open.
        let kept = max(OpenThreads.keptAtRest, (fleet?.chatsKeptBehind ?? 0) + 1)
        let leaving = OpenThreads.toLetGo(
            open: Set(controllers.keys), shown: shownOrder, atRest: atRest, onScreen: onScreen, keeping: kept, preferring: tabs
        )
        for id in leaving {
            // Kept while its copy cannot be saved: it may hold what the host has not
            // (a message that failed on its way); and while images, files or files picked
            // from the `@` menu wait in its composer, which only it holds.
            guard let controller = controllers[id], controller !== fleet?.chat,
                  !controller.keepsDraftInMemory,
                  persist(controller) else { continue }
            controller.close()
            controllers[id] = nil
        }
        shownOrder.removeAll { controllers[$0] == nil }
        fleet?.chatsClosed()
    }

    /// Gives a thread a title of the user's. A host that keeps titles (a bridge) is told,
    /// so its agent calls the session that too; elsewhere it stays in the app. A host that
    /// keeps the list for every device gets it as one of the changes made here, which is
    /// not lost while the host cannot be reached.
    func rename(_ record: ThreadRecord, to title: String) {
        guard let title = ThreadRecord.tidyTitle(title), let index = threads.firstIndex(where: { $0.id == record.id }),
              let forHost = keepForHost(PendingThreadChange(thread: record.id, title: title), of: threads[index]) else { return }
        threads[index].ref.title = title
        let renamed = threads[index]
        controllers[record.id]?.rename(to: title)
        saveThreads()
        registerForPush(only: [renamed])
        if forHost, keepsList {
            sendChanges()
        } else if let host = backend as? any ThreadRenaming {
            let ref = renamed.ref
            Task {
                do {
                    try await host.rename(ref, to: title)
                } catch {
                    AppLog.chat.error("The host did not take the new title: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    /// Threads whose turn finished out of sight: under Finished until opened or dismissed
    /// (`dismiss`). `touched`:
    /// the app saw none of it, so their place in the list moves up too. Not on a host that
    /// keeps the list, which marks them itself: a mark made here late, after another
    /// device saw the thread, would stay.
    func markUnseen(_ ids: [ThreadRef.ID], touched: Bool = false) {
        guard !keepsList else { return }
        var changed = false
        for id in ids {
            guard let index = threads.firstIndex(where: { $0.id == id }) else { continue }
            threads[index].unseen = true
            if touched { threads[index].updatedAt = .now }
            changed = true
        }
        guard changed else { return }
        threads.sort { $0.updatedAt > $1.updatedAt }
        saveThreads()
    }

    /// The thread is on screen: whatever finished in it has been seen. On a host that
    /// keeps the list, once it is looked at (`threadLookedAt`).
    func markSeen(_ id: ThreadRef.ID) {
        guard !keepsList, let index = threads.firstIndex(where: { $0.id == id }), threads[index].isUnseen else { return }
        threads[index].unseen = nil
        saveThreads()
    }

    /// A thread that ended out of sight, taken off Recent without being opened (its ×, or
    /// a swipe): seen, as one looked at is, here at once and on every device once a host
    /// that keeps the list is told.
    func dismiss(_ id: ThreadRef.ID) {
        threadLookedAt(id)
        markSeen(id)
    }

    /// Marks the end of the thread's turn as unseen here (`EndedOutOfSight`), and lets go
    /// of the mark once its lifetime is over, whether a list comes or not: the sidebar,
    /// which shows it by `listedThreads`, is drawn again then.
    private func noteEndedOutOfSight(_ record: ThreadRecord, turn: Int? = nil) {
        endedOutOfSight.turnEnded(record, turn: turn)
        endedSinceHeard.insert(record.id)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(EndedOutOfSight.lifetime))
            self?.endedOutOfSight.expire()
        }
    }

    /// The thread is looked at (`PushCoordinator.visibleThread`): on a host that keeps the
    /// list, whatever finished in it is seen here at once, and on every device once the
    /// host is told, which is tried again at each step while it is still looked at.
    func threadLookedAt(_ id: ThreadRef.ID) {
        // Where the host's list was when it last said what is at work, if this thread was
        // not: a turn begun by then is one read now (`TurnRead`).
        if !endedOutOfSight.isEmpty {
            let atWork = reportedActivity[id] != nil && !endedSinceHeard.contains(id)
            endedOutOfSight.seen(id, heard: atWork ? nil : heardList)
        }
        guard let sync, keepsList else { return }
        Task { await sync.seen(id) }
    }

    /// Keeps a thread at the top of the list, or lets it go back to its place.
    func setPinned(_ pinned: Bool, for record: ThreadRecord) {
        guard let index = threads.firstIndex(where: { $0.id == record.id }),
              let forHost = keepForHost(PendingThreadChange(thread: record.id, pinned: pinned), of: threads[index]) else { return }
        threads[index].pinned = pinned ? true : nil
        saveThreads()
        if forHost { sendChanges() }
    }

    /// Shows a thread an agent started from another in the sidebar too, on every device,
    /// or puts it back under the thread that started it, out of the list.
    func setShared(_ shared: Bool, for record: ThreadRecord) {
        guard host.nestsAgentThreads == true, let index = threads.firstIndex(where: { $0.id == record.id }),
              let forHost = keepForHost(PendingThreadChange(thread: record.id, shared: shared), of: threads[index]) else { return }
        threads[index].shared = shared ? true : nil
        saveThreads()
        if forHost { sendChanges() }
    }

    /// Whether the host keeps it for every device that this thread is recent: a host that
    /// offers `recent_threads`, unless it is kept on this device only. Elsewhere that is
    /// the device's own (`Fleet.recent`).
    func keepsRecent(of record: ThreadRecord) -> Bool {
        (sync?.keepsRecent ?? false) && !record.isLocalOnly
    }

    /// Puts a thread under Recent on every device, or takes it out, on a host that keeps
    /// that for them. A mark made while the host cannot be reached goes up later, as a
    /// pin does.
    func setRecent(_ recent: Bool, for id: ThreadRef.ID) {
        guard let index = threads.firstIndex(where: { $0.id == id }), keepsRecent(of: threads[index]),
              sync?.changesRecent(recent, of: threads[index]) == true,
              let forHost = keepForHost(PendingThreadChange(thread: id, recent: recent), of: threads[index]) else { return }
        threads[index].recent = recent ? true : nil
        saveThreads()
        if forHost { sendChanges() }
    }

    /// Whether the marks of this host's threads may be counted to take some off
    /// (`RecentThreads.pastKept`): it keeps them, and they are known to be as they stand.
    var recentIsCurrent: Bool {
        listIsCurrent && connection == .connected && (sync?.keepsRecent ?? false)
    }

    /// Takes the recent mark off threads past what every device keeps (`HostSync.expireRecent`).
    func expireRecent(_ threads: [ThreadRef.ID]) {
        guard let sync, !isRetired else { return }
        Task { await sync.expireRecent(threads) }
    }

    /// Puts a thread away, out of the list, or takes it back out. The session stays on
    /// the host, and something new in the thread brings it back by itself.
    func setArchived(_ archived: Bool, for record: ThreadRecord) {
        guard let index = threads.firstIndex(where: { $0.id == record.id }),
              let forHost = keepForHost(PendingThreadChange(thread: record.id, archived: archived), of: threads[index]) else { return }
        threads[index].archived = archived ? true : nil
        if archived {
            threads[index].pinned = nil
            threads[index].recent = nil
        }
        saveThreads()
        if forHost { sendChanges() }
    }

    /// Whether Remove is offered for the thread: on a host that keeps the list, where it
    /// leaves every device, not while it is running or waiting for an answer.
    func offersRemoval(_ record: ThreadRecord) -> Bool {
        record.offersRemoval(hostKeepsList: syncsThreads, atWork: activity(of: record.id) != .idle)
    }

    /// Removes a thread from the app and erases its saved copy. The session stays on
    /// the host. On a host that keeps the list, the thread leaves the host's list, and so
    /// every device: it is hidden here until the host has taken it off, and then
    /// forgotten; should the host say no, it shows again, with the host's reason.
    func delete(_ record: ThreadRecord) {
        let current = threads.first { $0.id == record.id } ?? record
        guard let forHost = keepForHost(PendingThreadChange(thread: record.id, remove: true), of: current) else { return }
        if forHost, keepsList {
            syncChanged()
            leaveScreen(record)
            sendChanges()
            return
        }
        threads.removeAll { $0.id == record.id }
        saveThreads()
        store.deleteTranscript(for: record.key)
        // The address the host was given, also before this launch has one.
        if let host = backend as? any PushRegistering, let token = PushCoordinator.shared.lastDeviceToken {
            Task { try? await host.unwatch(record.id, deviceToken: token) }
        }
        controllers[record.id]?.close()
        controllers[record.id] = nil
        fleet?.chatsClosed()
        forgetJournals(of: [record.id])
        leaveScreen(record)
    }

    /// Erases what was kept of the messages sent in threads gone from the list (deleted
    /// here, or on another device): they would come back as unsent drafts, and opening
    /// one would take the thread up again on the host and put it back in the list.
    private func forgetJournals(of gone: Set<ThreadRef.ID>) {
        guard !gone.isEmpty, !savedConversations.isEmpty else { return }
        let journal = SubmissionStore(threads: store)
        for conversation in savedConversations.values {
            guard let thread = conversation.thread, gone.contains(thread.id) else { continue }
            draftControllers.removeValue(forKey: conversation.id)?.close()
            try? journal.remove(conversation.id)
            savedConversations[conversation.id] = nil
        }
    }

    /// A thread on its way off the list, or gone from it, is no tab any more, and gives
    /// way on screen to the tab beside it (`Fleet.threadGone`), or with none to a new
    /// thread with the same agent.
    private func leaveScreen(_ record: ThreadRecord) {
        guard let fleet, fleet.threadGone(record.key), let agent = agent(record.ref.agent) else { return }
        fleet.show(makeController(agent: agent, record: nil))
    }

    /// Saves every thread that is open, for when the app goes to the background.
    func saveAll() {
        for controller in controllers.values { persist(controller) }
        for controller in Array(draftControllers.values) { persist(controller) }
        letGoOfThreadsAtRest()
    }

    /// What an agent offers, shared by every thread with it.
    private func offerings(for agent: Agent.ID) -> AgentOfferings {
        if let known = offerings[agent] { return known }
        let new = AgentOfferings()
        offerings[agent] = new
        return new
    }

    /// Asks the host for whatever is still missing of what an agent offers. Its
    /// threads see the answers arrive.
    func loadOfferings(for agent: Agent.ID) {
        let offered = offerings(for: agent)
        guard connection == .connected, !offeringsLoading.contains(agent) else { return }
        let models = offered.models == nil ? backend as? any ModelSelecting : nil
        // A host with no commands at all is asked again, which costs nothing.
        let commands = offered.commands.commands.isEmpty ? backend as? any CommandRunning : nil
        guard models != nil || commands != nil else { return }
        offeringsLoading.insert(agent)
        Task {
            // The two do not depend on each other, and neither is needed for the rest.
            async let fetchedModels = Self.fetch("model list", for: agent) { try await models?.modelCatalog(for: agent) }
            async let fetchedCommands = Self.fetch("command list", for: agent) { try await commands?.commandCatalog(for: agent) }
            // A host with no models signed in, or no model of its own, gets no picker.
            if let catalog = await fetchedModels, !catalog.providers.isEmpty, !catalog.agentDefault.model.isEmpty {
                offered.models = catalog
            }
            if let catalog = await fetchedCommands { offered.commands = catalog }
            offeringsLoading.remove(agent)
        }
    }

    /// One of the things an agent offers, or nil when the host could not say: the app
    /// works without it.
    private nonisolated static func fetch<Offered: Sendable>(
        _ what: String, for agent: Agent.ID, _ ask: @Sendable () async throws -> Offered?
    ) async -> Offered? {
        do {
            return try await ask()
        } catch {
            AppLog.chat.error("No \(what, privacy: .public) for \(agent.name, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// - Parameters:
    ///   - folder: where a new thread works, for its intro to say.
    ///   - workingDirectory: the folder chosen for a new thread, sent with its creation;
    ///     without one the host decides (`PORTALS_DEV_CWD` in development).
    /// `cached`: the thread's saved copy, read already; read here when not given.
    private func makeController(
        agent: Agent, record: ThreadRecord?, cached: Transcript?? = nil, folder: Folder? = nil, workingDirectory: String? = nil,
        recovery: SavedConversation? = nil
    ) -> ThreadController {
        let recovery = recovery ?? record.flatMap { record in
            savedConversations.values.first { $0.thread?.id == record.id }
        }
        // A journal bound to a thread is recovered onto that thread's saved copy, even
        // opened from Unsent drafts: what it never sent goes after what was said before.
        let saved = cached ?? (record?.key ?? recovery?.thread?.key).flatMap { store.loadTranscript(for: $0) }
        let controller = ThreadController(
            agent: agent,
            backend: backend,
            options: recovery?.options ?? ThreadOptions(workingDirectory: workingDirectory ?? DebugLaunch.workingDirectory, model: DebugLaunch.modelOverride),
            folder: folder ?? recovery?.folder,
            imageStore: store,
            offerings: offerings(for: agent.id),
            existing: record?.ref,
            cached: saved,
            context: record?.context,
            lastActivity: record?.updatedAt ?? recovery?.updatedAt ?? .now,
            recovery: recovery
        )
        controller.autoAnswer = DebugLaunch.autoAnswer
        controller.onPersist = { [weak self] controller in
            self?.persist(controller)
        }
        controller.onSend = { [weak self] controller in
            // Its first message, the thread not made yet: the next new thread is with its agent.
            if controller.thread == nil { self?.fleet?.newThreadSent(controller) }
            self?.fleet?.threadUsed(controller)
        }
        controller.onTurnFinished = { [weak self] controller in
            guard let self, let id = controller.thread?.id else { return }
            // A thread that ran off screen may be at rest now: the ones looked at
            // longest ago are let go, once this event has been dealt with.
            Task { [weak self] in self?.letGoOfThreadsAtRest() }
            if self.keepsList {
                // The host marked it unseen for every device. The thread looked at is
                // seen: the list is fetched at once, and the merge says so. Another one
                // followed here moves the list a moment later (`HostSync.listMoved`), and
                // is unseen here meanwhile, rather than under no group of the sidebar
                // until the list comes.
                if self.lookedAtThread == id {
                    self.syncThreads(listNow: nil)
                } else {
                    if let record = self.threads.first(where: { $0.id == id }) {
                        // The turn the host named with its end, which a quick turn the
                        // list here never had is known by (net-20).
                        self.noteEndedOutOfSight(record, turn: controller.endedTurn)
                    }
                    if !self.isRetired { self.sync?.listMoved() }
                }
                return
            }
            // Off screen, it waits under Finished until it is opened or dismissed.
            guard self.fleet?.chat !== controller else { return }
            self.markUnseen([id])
        }
        controller.onTitleChanged = { [weak self] _ in
            // A host that keeps the list has the title there too, for the sidebar.
            guard let self, self.keepsList, !self.isRetired else { return }
            self.sync?.listMoved()
        }
        controller.onDetached = { [weak self] controller in
            // The thread on screen is reopened at once; the others when they are shown.
            if self?.fleet?.chat === controller { controller.prepare() }
        }
        return controller
    }

    /// Writes a thread's transcript and its entry in the list. On a host that keeps the
    /// list, the entry takes only the thread's time and context from here
    /// (`ThreadRecord.saving`): its title, preview and marks are the host's.
    @discardableResult
    private func persist(_ controller: ThreadController) -> Bool {
        guard !isRetired else { return false }
        let recoverySaved = controller.persistRecovery()
        if let saved = controller.savedConversation { savedConversations[saved.id] = saved }
        guard var ref = controller.thread else {
            if controller.savedConversation != nil { draftControllers[controller.localID] = controller }
            return recoverySaved
        }
        draftControllers[controller.localID] = nil
        // What it heard while no window could be seen is saved too.
        controller.applyHeldPieces()
        // A new thread that became an agent's one ongoing conversation, open here already
        // (it came on the list while this one was written): this one is it from now on.
        if ref.isOngoing, let other = controllers[ref.id], other !== controller {
            other.close()
            fleet?.chatsClosed()
        }
        controllers[ref.id] = controller
        // A thread created on screen, or taken up, counts as looked at now, and is a tab
        // from its first message on, also one taken off screen before it was made.
        if fleet?.chat === controller, shownOrder.last != ref.id {
            shownOrder.removeAll { $0 == ref.id }
            shownOrder.append(ref.id)
        }
        fleet?.threadSaved(ref.key, by: controller)
        // A thread that follows the host says for itself from here; what the host said
        // earlier may be old. One that does not (not reopened since launch, detached)
        // has only the host's word, which is kept: saved as it is let go, a thread the
        // host said was running would otherwise never be seen to end. Nor one running only
        // for the threads it started, which its own chat knows nothing of (Codex's review
        // of n14/foot: its marks and tab went idle until the next poll).
        if controller.followsHost, reportedActivity[ref.id] != nil, !reportedInherited.contains(ref.id) { reportedActivity[ref.id] = nil }
        ref.title = controller.title ?? ref.title
        let open = ThreadRecord(ref: ref, updatedAt: controller.lastActivity, preview: controller.preview, context: controller.context)
        // Changed apart and put back whole: the list saved as it was (each open thread as
        // the app leaves the screen, say) tells nothing that shows it, which a change made
        // in place would, sorting included, and the sidebar is not worked out again.
        var list = threads
        let place = list.firstIndex { $0.id == ref.id }
        let isNew = place == nil
        if let index = place {
            let old = list[index]
            // Seen if it is the thread on screen; otherwise as it was (a turn ending off
            // screen marks it once it is saved).
            var record = old.saving(open, hostKeepsList: keepsList, isOnScreen: fleet?.chat === controller)
            // Started here, though the host's list had it first: this device is notified
            // about it from now on.
            let startedHere = controller.startedHere && old.isFromHost
            if startedHere { record.fromHost = nil }
            list[index] = record
            if startedHere {
                threadIsNew(record)
            } else if old.ref.title != record.ref.title {
                registerForPush(only: [record])
            }
        } else {
            var open = open
            if let folder = ref.workingDirectory, let repo = worktreeRepos[folder] { open.repo = repo }
            list.append(open)
            threadIsNew(open)
        }
        list.sort { $0.updatedAt > $1.updatedAt }
        if list != threads { threads = list }
        // Remembered as recent before it was listed here, for the host to have at once, with
        // the list it moved, so that the step also knows the list as it stands.
        if isNew, sync?.keepsRecent == true, fleet?.heldRecent(on: host.id).contains(ref.id) == true { syncThreads(listNow: nil) }
        let listSaved = saveThreads()
        let transcriptSaved = store.saveTranscript(controller.persistableTranscript, for: ref.key)
        if transcriptSaved, listSaved, recoverySaved {
            controller.finishRecoveryAfterSaving()
            savedConversations[controller.localID] = controller.savedConversation
        }
        return transcriptSaved && listSaved && recoverySaved
    }

    /// A thread this device started or took up is in the list: its agent opens in the
    /// sidebar, and since something to be notified about now exists, notifications are
    /// asked for, the first time, when the host is one that can send them.
    private func threadIsNew(_ record: ThreadRecord) {
        fleet?.threadAdded(record)
        guard backend is any PushRegistering else { return }
        Task {
            await PushCoordinator.shared.enable()
            registerForPush(only: [record])
        }
    }

    // MARK: The list every device shows

    /// Whether the host keeps the list for every device now (`HostSync.isSyncing`).
    private var keepsList: Bool {
        sync?.isSyncing ?? false
    }

    /// The threads the list shows: not the ones on their way off the host's list.
    var listedThreads: [ThreadRecord] {
        let listed = removing.isEmpty ? threads : threads.filter { !removing.contains($0.id) }
        return endedOutOfSight.applied(to: listed)
    }

    /// The thread looked at, when it is this host's: on screen, with the app in front and
    /// the chat not slid aside, the one notifications are held back for.
    private var lookedAtThread: ThreadRef.ID? {
        guard let route = PushCoordinator.shared.visibleThread, route.host == host.id else { return nil }
        return route.thread
    }

    /// Keeps a change made here to a thread for the host's list, before the list here
    /// changes (`HostSync.record`): true when the host keeps the list, or kept it before
    /// and may again, false when the change is only this device's (a host that never
    /// kept it, a thread kept here only). nil when it could not be saved, and then
    /// nothing is changed.
    private func keepForHost(_ change: PendingThreadChange, of record: ThreadRecord) -> Bool? {
        guard let sync, !record.isLocalOnly else { return false }
        do {
            return try sync.record(change)
        } catch {
            AppLog.chat.error("Could not keep a change to \(record.id.rawValue, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /// Sends the changes made here at once: a step, which merges the list they moved,
    /// from the host's answers to marks or else fetched.
    private func sendChanges() {
        syncThreads(listNow: sync?.state?.list)
    }

    /// Runs a sync step (`HostSync.stepSoon`): the changes made here are sent, and the
    /// host's list is fetched and merged when it moved (`listNow`, as the host last gave
    /// it, is not the list merged last; nil fetches it whatever it is). In a task of its
    /// own, so a slow host holds up no other, and one at a time.
    private func syncThreads(listNow: ThreadListRevision?) {
        guard !isRetired else { return }
        sync?.stepSoon(listNow: listNow)
    }

    /// What a sync step did, shown: whether the host keeps the list, which threads are
    /// hidden, and why a removal or a title was refused, in the host's words.
    private func stepped(_ step: SyncStep) {
        guard !isRetired else { return }
        if step.merged { SidebarProbe.mark("list-merged", once: true) }
        syncChanged()
        let wasCurrent = listIsCurrent
        listIsCurrent = step.listIsCurrent && connection == .connected
        if recentIsCurrent, step.merged || !wasCurrent { fleet?.expireRecentMarks(on: self) }
        // One alert for the step's refusals, a line each.
        let refusals = step.refused.map { ("Not removed", $0) } + step.refusedTitles.map { ("Not renamed", $0) }
        let said = refusals.map { heading, refusal in
            Refusal(heading: heading, title: threads.first { $0.id == refusal.thread }?.displayTitle, reason: refusal.reason)
        }
        if let first = said.first {
            fleet?.refused(said.dropFirst().reduce(first) { $0.adding($1) })
        }
        if let error = step.error {
            AppLog.chat.error("Could not bring the list of threads in step with \(self.host.name, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Takes in what the sidebar shows of the host's list: whether it keeps it, and which
    /// threads are on their way off it.
    private func syncChanged() {
        guard let sync else { return }
        if syncsThreads != sync.isSyncing { syncsThreads = sync.isSyncing }
        let removing = sync.removing
        if self.removing != removing { self.removing = removing }
    }

    /// Takes the host's threads as a sync step merged or changed them, and saves them,
    /// letting go of the `forgotten` ones (their transcripts are the step's to erase).
    /// False when they could not be saved, and then nothing changes here.
    private func hold(_ held: [ThreadRecord], forgetting forgotten: [ThreadRecord]) -> Bool {
        guard !isRetired else { return false }
        let before = threads
        ReturnProbe.shared?.note("list-held", held == before ? "same" : "changed")
        quietly { threads = held }
        guard saveThreads() else {
            threads = before
            return false
        }
        for record in forgotten {
            reportedActivity[record.id] = nil
            let shown = fleet?.chat?.thread?.key == record.key ? fleet?.chat : nil
            controllers[record.id]?.close()
            controllers[record.id] = nil
            shown?.close()
            leaveScreen(record)
        }
        if !forgotten.isEmpty { fleet?.chatsClosed() }
        // Closed first: nothing of theirs writes a journal back.
        forgetJournals(of: Set(forgotten.map(\.id)))
        // A title given on another device, or one here the host said no to: an open
        // thread shows the list's, and notifications about the thread say it too.
        let titles = Dictionary(before.map { ($0.id, $0.ref.title) }, uniquingKeysWith: { first, _ in first })
        let renamed = threads.filter { record in titles[record.id].map { $0 != record.ref.title } ?? false }
        for record in renamed {
            controllers[record.id]?.titleListed(record.ref.title)
        }
        if !renamed.isEmpty { registerForPush(only: renamed) }
        syncChanged()
        return true
    }

    // MARK: Saving

    // The files hold every host's agents, looks and threads; this model has only its
    // own host's, so what belongs to the others is carried over on each save.

    private func saveAgents() {
        store.saveAgents(store.loadAgents().filter { $0.id.host != host.id } + agents)
    }

    private func saveLooks() {
        store.saveLooks(
            store.loadLooks().filter { $0.key.host != host.id }.merging(looks) { _, mine in mine },
            origins: store.loadLookOrigins().filter { $0.key.host != host.id }.merging(lookOrigins) { _, mine in mine },
            states: store.loadLookStates().filter { $0.key.host != host.id }.merging(lookStates) { _, mine in mine }
        )
    }

    /// False when the file could not be written.
    @discardableResult
    private func saveThreads() -> Bool {
        store.saveThreads(store.loadThreads().filter { $0.ref.agent.host != host.id } + threads)
    }
}
