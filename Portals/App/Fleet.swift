import AgentCore
import Foundation
import HermesBackend
import Observation
import os
import UIKit

/// Changes a host would not make to its threads (a removal, a title), and why, in the
/// host's words.
struct Refusal: Identifiable {
    let id = UUID()
    /// What did not happen: "Not removed", "Not renamed", or "Not changed" for both.
    var heading: String
    /// A line for each: what the list calls the thread, when it is still there, and the
    /// host's sentence.
    var text: String

    init(heading: String, title: String?, reason: String) {
        self.heading = heading
        text = title.map { "\($0): \(reason)" } ?? reason
    }

    /// This one and `other`, said together.
    func adding(_ other: Refusal) -> Refusal {
        var both = self
        if other.heading != heading { both.heading = "Not changed" }
        both.text += "\n" + other.text
        return both
    }
}

/// Every host the app talks to, and the thread on screen, which can be any host's.
///
/// Each host has its own `HostModel`: its connection, agents and threads. What spans
/// hosts lives here: the thread on screen and the tabs, which Mac's space the sidebar
/// shows and which of its folders are closed, the agents' pictures for notifications,
/// and the thread a tapped notification is about.
@Observable
final class Fleet {
    /// One per host, in the order the hosts were added.
    private(set) var hosts: [HostModel] = []
    /// The thread on screen; nil until some host's agents are known.
    private(set) var chat: ThreadController? {
        didSet {
            if oldValue !== chat { keepChats(leaving: oldValue) }
            noteCurrent()
        }
    }
    /// The thread whose chat shows, the app in front or not (`MainScreen`): not listed
    /// under Finished for having ended out of sight (`ThreadRecord.inSight`). Set on every
    /// tab switch, it tells what reads the layout only when the thread it was or is now
    /// is not opened yet, the one case it changes the layout: the threads' own changes
    /// tell it anyway.
    var threadInSight: ThreadKey? {
        get { inSightKey }
        set {
            guard newValue != inSightKey else { return }
            let old = inSightKey
            inSightKey = newValue
            if isUnseen(old) || isUnseen(newValue) { inSightChanges += 1 }
        }
    }
    @ObservationIgnored private var inSightKey: ThreadKey?
    /// Counts the changes of `threadInSight` that change the layout.
    private var inSightChanges = 0

    private func isUnseen(_ key: ThreadKey?) -> Bool {
        guard let key else { return false }
        return model(for: key.host)?.listedThreads.first { $0.id == key.id }?.isUnseen ?? false
    }
    /// The threads open as tabs on this device, in their order, and the one on screen
    /// last (`OpenTabs`), kept between launches: every thread put on screen is one, and a
    /// new thread once its first message is sent, until its tab is closed (2026-10-23). The thread on screen is always a tab; the others are only their keys
    /// until one is shown again.
    private(set) var tabs = OpenTabs()
    /// Conversation history this device keeps itself, separate from the tabs kept open
    /// above the chat: of the hosts that do not keep it for every device. On those that do
    /// the threads say so themselves (`ThreadRecord.recent`), and this holds what is on its
    /// way up (`HostSync`). The sidebar retains twenty-five read, idle threads of each host,
    /// and shows as many of them as `recentChoice` says, with unread results under Finished.
    private(set) var recent = RecentThreads()
    /// How much of Recent this device shows (Settings, Appearance).
    var recentChoice = RecentChoice(from: .standard) {
        didSet { recentChoice.save(to: .standard) }
    }
    /// The tab on screen before the new thread on screen now, which is no tab yet: where
    /// closing that one goes back to.
    @ObservationIgnored private var tabBeforeNewThread: ThreadKey?
    /// A new thread left with something typed in it and not sent, kept as it was, images
    /// too: a tab of its own after the others until it is shown again or closed (2026-10-26: switching to another tab must not close a new thread they have started
    /// typing in). One at a time: another left so takes its place. Not kept between
    /// launches, where its words are, for the next new thread with its agent and folder
    /// (`ComposerDrafts`). A new thread with the same agent and folder is this one again
    /// (`HostModel.newThread`).
    private(set) var draftTab: ThreadController?
    /// A new thread closed on screen (`closeShownTab`), as the one in its place may still
    /// be being read, or made again with another agent or folder (`remakeNewThread`): it
    /// is let go of when the next shows, not kept as `draftTab`.
    @ObservationIgnored private weak var closedNewThread: ThreadController?
    /// New threads taken off screen while their first message was on its way, before the
    /// host made the thread: each is a tab once it is made, behind the one on screen
    /// (`threadSaved`). Not kept for them: one let go of was never made.
    @ObservationIgnored private var tabsOnTheirWay: [HeldWeakly] = []
    /// Show in Its Folder, from a tab's menu: the sidebar is to bring this thread's Mac and
    /// folder into view, and set it back to nil.
    var revealedThread: ThreadKey?

    /// Some host is catching up after the app came back (`HostModel.isCatchingUp`): the
    /// sidebar's groups take their new size at once.
    var isCatchingUp: Bool {
        hosts.contains(where: \.isCatchingUp)
    }
    /// The folders whose threads the sidebar does not show, closed from their row: every
    /// folder is open until it is closed (2026-10-23). Kept between launches.
    var foldedProjects: Set<SidebarProject.ID> = [] {
        didSet { saveFoldedProjects() }
    }
    /// The Mac whose space the sidebar shows below its groups, swiped to or picked from
    /// the Macs' tabs over it (`spaceOnScreen`), kept between launches; nil for the first.
    var shownSpace: HostID? {
        didSet { if !isDemo { UserDefaults.standard.set(shownSpace?.rawValue, forKey: Self.shownSpaceKey) } }
    }
    /// Settings: whether a new thread with a Hermes agent starts by choosing a folder,
    /// as a coding agent's does. Off unless turned on: such an agent is talked with,
    /// and Hermes's own gateway asks for no folder either. Its thread then starts in
    /// the host's General folder without saying so.
    var asksHermesAgentsForFolder = UserDefaults.standard.bool(forKey: Fleet.asksHermesAgentsForFolderKey) {
        didSet { UserDefaults.standard.set(asksHermesAgentsForFolder, forKey: Self.asksHermesAgentsForFolderKey) }
    }
    static let asksHermesAgentsForFolderKey = "folders.askHermesAgents"
    /// The agent of the thread started last on this device, its first message sent: a new
    /// thread starts with it (`agentForNewThread`). Kept between launches; the demo's is
    /// its own.
    @ObservationIgnored private var lastStartedAgent: Agent.ID? {
        didSet {
            guard !isDemo, lastStartedAgent != oldValue else { return }
            UserDefaults.standard.set(lastStartedAgent.flatMap { try? JSONEncoder().encode($0) }, forKey: Self.lastStartedAgentKey)
        }
    }
    private static let lastStartedAgentKey = "newThread.lastAgent"
    /// Removals or titles a host said no to, for the screen to say why; nil once read.
    private(set) var refusal: Refusal?
    /// Refusals that came while one was on screen, which an alert shown cannot take in:
    /// shown once that one is read.
    @ObservationIgnored private var laterRefusal: Refusal?

    /// This device's place in a net: every Mac of it is a host here (`Net`).
    let net: Net
    /// Where the hosts' passwords are kept, and the net's token.
    @ObservationIgnored private let credentials: any CredentialStore
    /// Changes to the list of hosts are saved: not for hosts the launch environment names.
    @ObservationIgnored private let savesHosts: Bool
    /// The demo's fleet (`Demo`), apart from the app's: its host plays the demo's script,
    /// and nothing of it is kept on this device, its tabs, sidebar and notification pictures
    /// included. Its threads are in a scratch folder, gone when the demo ends.
    let isDemo: Bool
    /// The demo's tour has been begun (`startTour`).
    @ObservationIgnored private var hasStartedTour = false
    /// Where threads, agents and looks are kept, for every host.
    @ObservationIgnored let store: ThreadStore
    /// Every host has had its first try at connecting.
    @ObservationIgnored private var hasStarted = false
    @ObservationIgnored private var didRunDebugLaunch = false
    @ObservationIgnored private var hasFoundDebugAgent = false
    @ObservationIgnored private var didMakeDebugMove = false
    /// The thread the switches open in a named folder is on screen.
    @ObservationIgnored private var hasOpenedDebugFolder = false

    init(_ starting: HostDirectory.Starting = HostDirectory.starting()) {
        credentials = starting.credentials
        savesHosts = starting.savesHosts
        store = starting.store
        isDemo = starting.isDemo
        net = Net(credentials: starting.credentials, store: starting.store, saves: starting.savesHosts)
        SidebarProbe.mark("fleet-directory", once: true)
        hosts = starting.hosts.map { [net] in Self.model(for: $0, credentials: starting.credentials, store: starting.store, net: net, isDemo: starting.isDemo) }
        SidebarProbe.mark("fleet-hosts", once: true)
        machineOrder = starting.store.loadMachineOrder()
        // The demo starts with none of the app's: its sidebar and tabs are its own.
        if !isDemo {
            foldedProjects = Self.loadFoldedProjects()
            foldersByLastUse = Set((UserDefaults.standard.stringArray(forKey: Self.foldersByLastUseKey) ?? []).map(HostID.init(rawValue:)))
            savedFirstSeen = Self.loadFoldersFirstSeen()
            shownSpace = UserDefaults.standard.string(forKey: Self.shownSpaceKey).map(HostID.init(rawValue:))
            lastStartedAgent = UserDefaults.standard.data(forKey: Self.lastStartedAgentKey).flatMap { try? JSONDecoder().decode(Agent.ID.self, from: $0) }
            tabs = Self.loadTabs()
            recent = RecentThreads.restored(from: UserDefaults.standard.data(forKey: Self.recentKey), legacyTabs: tabs)
        }
        layoutCache = SidebarLayoutCache(firstSeen: savedFirstSeen)
        hosts.forEach { $0.fleet = self }
        net.attach(to: self)
        assignLooks()
        SidebarProbe.mark("fleet-looks", once: true)
        saveNotificationAvatarsSoon()
        // Persist the one-time Recent migration even if navigation stays unchanged.
        saveTabsSoon()
        SidebarProbe.mark("fleet-avatars", once: true)
        // The thread left on screen when the app went to the background, should the
        // system have ended it there: the app comes back to it, as it was left.
        reopenThreadLeftOnScreen()
        // Or else the tab on screen when the app was last left, as the tabs were then.
        reopenLastTab()
        // The agents seen last time are enough to start on: no waiting for the hosts.
        openStartingThread()
    }

    // MARK: Hosts

    func model(for host: HostID) -> HostModel? {
        hosts.first { $0.id == host }
    }

    /// The host a thread belongs to.
    func model(of thread: ThreadController) -> HostModel? {
        model(for: thread.agent.id.host)
    }

    var recoverableDrafts: [RecoverableDraft] {
        hosts.flatMap(\.recoverableDrafts).sorted { $0.updatedAt > $1.updatedAt }
    }

    func openRecoverableDraft(_ draft: RecoverableDraft, opened: @escaping () -> Void = {}) {
        model(for: draft.agent.host)?.openRecoverableDraft(draft, opened: opened)
    }

    func discardRecoverableDraft(_ draft: RecoverableDraft) {
        model(for: draft.agent.host)?.discardRecoverableDraft(draft)
    }

    func password(for host: HostID) -> String? {
        credentials.password(for: host)
    }

    /// Connects to every host at once. From then on each keeps its own connection.
    func start() async {
        await withTaskGroup(of: Void.self) { group in
            for host in hosts {
                group.addTask { await host.start() }
            }
        }
        hasStarted = true
        runDebugLaunchIfReady()
    }

    /// Saves a host as typed in its settings, with its password, and connects to it. A
    /// host that was there already starts over with what was typed; the thread on
    /// screen, when it is that host's, comes back with it.
    func saveHost(_ typed: HostConfig, password: String) {
        var config = typed
        credentials.setPassword(password, for: config.id)
        if let old = model(for: config.id)?.host, old.url == config.url {
            // What answers at an address stays known until it is changed, and a Mac of the
            // net stays the net's.
            config.kind = old.kind
            config.generalFolder = old.generalFolder
            config.machineID = old.machineID
            config.machineOS = old.machineOS
            config.netMember = old.netMember
            config.netName = old.netName
            config.netNamed = old.netNamed
            config.netNamedBy = old.netNamedBy
        }
        let model = put(config)
        saveHosts()
        openStartingThread()
        Task { await model.start() }
    }

    /// Puts a host in the list as `config` says, a new model for it: one that was there
    /// already starts over; the thread on screen, when it is that host's, comes back with
    /// it, or the thread being read to take its place, when there is one. Not saved, nor
    /// connected.
    private func put(_ config: HostConfig) -> HostModel {
        let model: HostModel
        if let index = hosts.firstIndex(where: { $0.id == config.id }) {
            let old = hosts[index]
            // Another Mac may answer at the new address, with other plans and other apps.
            if old.host.url != config.url { ThreadPanelMemory.shared.forget(host: config.id) }
            let shown = chat.flatMap { $0.agent.id.host == config.id ? $0 : nil }
            // The thread being read to be put on screen: its read stops with the old model,
            // which drops what it reads, or with the thread on screen closed here, and it is
            // asked for again once the new model is in. Else the screen kept a thread whose
            // tab was closed for it to take its place, and ⌘W did nothing.
            let asked = beingRead.flatMap { $0.host == config.id || shown != nil ? $0 : nil }
            old.shutDown()
            if let shown {
                shown.close()
                chat = nil
                navigation += 1
            }
            model = Self.model(for: config, credentials: credentials, store: store, net: net, isDemo: isDemo)
            model.fleet = self
            hosts[index] = model
            // The old model's threads, closed with it, are not kept.
            trimKeptChats()
            assignLooks()
            if let asked { askAgain(asked) }
            if chat == nil, let shown {
                if let thread = shown.thread, let record = model.threads.first(where: { $0.id == thread.id }) {
                    // At once: the screen has no thread until it is back.
                    model.open(record, readingNow: true)
                } else if model.agent(shown.agent.id) != nil {
                    model.newThread(with: shown.agent)
                }
            }
        } else {
            model = Self.model(for: config, credentials: credentials, store: store, net: net, isDemo: isDemo)
            model.fleet = self
            hosts.append(model)
            assignLooks()
        }
        return model
    }

    /// A model for `config`: a Mac of the net may be reached through the relay too, as its
    /// entry in the net's list says when each attempt to connect begins. The demo's plays
    /// the demo's script, and reaches nothing.
    private static func model(for config: HostConfig, credentials: any CredentialStore, store: ThreadStore, net: Net, isDemo: Bool) -> HostModel {
        if isDemo {
            return HostModel(host: config, credentials: credentials, store: store, backend: FakeBackend(script: .demo, host: config.id))
        }
        let routes = net.relayRoutes
        let relay: (@Sendable () async -> RelayRoute?)? = config.netMember.map { member in
            { @Sendable in routes.route(to: member) }
        }
        return HostModel(host: config, credentials: credentials, store: store, relay: relay)
    }

    /// Removes a host and everything the app kept for it: its threads with their
    /// transcripts, its agents and their looks, its password and its notification key.
    /// Its sessions stay on the host.
    ///
    /// - Parameter quietly: nothing is asked of the host (`HostModel.shutDownForRemoval`).
    func removeHost(_ id: HostID, quietly: Bool = false) {
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        let removed = hosts.remove(at: index)
        // The password may be needed to sign in once more, to stop the notifications.
        removed.shutDownForRemoval(quietly: quietly) { [credentials] in
            credentials.setPassword(nil, for: id)
            NotificationKeys.shared?.removeKey(for: id)
        }
        if let chat, chat.agent.id.host == id {
            chat.close()
            self.chat = nil
            navigation += 1
        }
        store.forgetHost(id)
        ThreadPanelMemory.shared.forget(host: id)
        foldedProjects = foldedProjects.filter { $0.host != id }
        foldersByLastUse.remove(id)
        if shownSpace == id { shownSpace = nil }
        changeTabs { tabs in tabs.remove { $0.host == id } }
        changeRecent { $0.remove { $0.host == id } }
        saveHosts()
        saveNotificationAvatarsNow()
        // A thread of its still being read to be put on screen is not put there (its model
        // is retired): that is called off, and a thread on screen whose tab was closed for
        // it gives way to the last tab of another host that can be shown, as the thread
        // on screen of its own does, if any. Another host's, whose read stopped as the
        // thread on screen was closed here, is asked for again in its place (`askAgain`).
        if let beingRead {
            if beingRead.host == id {
                callOffReading(beingRead, inPlace: tabs.keys.reversed())
            } else if chat == nil {
                askAgain(beingRead)
            }
        }
        if chat == nil { _ = showFirstTab(of: tabs.keys.reversed(), readingNow: true) }
        openStartingThread()
    }

    /// A host turned out to be another kind than was saved.
    func hostChanged(_ host: HostConfig) {
        saveHosts()
    }

    // MARK: The net

    /// The net's list as last listed: its Macs are the hosts (`NetHosts`). A host for a Mac
    /// taken out of the net goes, with its threads; one added by hand for a Mac of the net
    /// becomes the net's, signed in with the token; one for each other Mac is added.
    func netChanged(_ members: [NetMember]) {
        guard net.isInNet else { return }
        let before = hosts.map(\.host)
        let after = NetHosts.apply(members, to: before)
        guard after != before else { return }
        let kept = Set(after.map(\.id))
        for host in before where !kept.contains(host.id) {
            AppLog.chat.notice("\(host.name, privacy: .public) is not in the net any more")
            removeHost(host.id)
        }
        var started: [HostModel] = []
        for config in after {
            if let model = model(for: config.id) {
                let was = model.host
                if was.url != config.url || was.username != config.username || was.netMember != config.netMember {
                    // Signed in with the token from now on: its password is no use.
                    if config.isNetHost { credentials.setPassword(nil, for: config.id) }
                    started.append(put(config))
                } else if was != config {
                    model.renamed(config)
                }
            } else {
                started.append(put(config))
            }
        }
        arrangeHosts()
        saveHosts()
        openStartingThread()
        for model in started {
            Task { await model.start() }
        }
    }

    /// The device left its net: the net's Macs go with their threads, with no call to them.
    func netLeft() {
        for host in hosts where host.host.isNetHost {
            removeHost(host.id, quietly: true)
        }
    }

    private func saveHosts() {
        guard savesHosts else { return }
        store.saveHosts(hosts.map(\.host))
    }

    // MARK: The app in the background

    func enterBackground() {
        reconcileRecentHistory()
        saveTabsNow()
        leftScreen()
        hosts.forEach { $0.enterBackground() }
        noteThreadLeftOnScreen()
    }

    func enterForeground() {
        isOffScreen = false
        hosts.forEach { $0.enterForeground() }
        // Back in front: should it crash or be killed now, with another thread on screen
        // maybe, it is not to open with the one left on screen before.
        Self.leftOnScreen.forget()
    }

    /// The app went inactive (`MainScreen`'s scene phase): save.
    func saveAll() {
        reconcileRecentHistory()
        saveTabsNow()
        leftScreen()
        hosts.forEach { $0.saveAll() }
    }

    /// The app left the screen, where it may be suspended or ended: the notification
    /// pictures waiting are saved now, and any asked for until it is back (a host's
    /// answer already on its way) at once (`saveNotificationAvatarsSoon`).
    private func leftScreen() {
        isOffScreen = true
        notificationAvatars.flush()
    }

    /// The app is inactive or in the background (`leftScreen`), until it is active again.
    @ObservationIgnored private var isOffScreen = false

    // MARK: Agents

    /// The sidebar's list: Needs you, Running and Recent on top, from every host, then a
    /// space for each host with its bots, its folders with their threads and what it
    /// archived (`SidebarLayout.top`, `spaces`).
    var layout: SidebarLayout {
        _ = inSightChanges
        // Not sorted as `allThreads` are: the layout puts them in order itself, as that
        // sort does (both keep threads of one moment as they came), and sorting them here
        // took most of the time of each look at an unchanged layout.
        let threads = ThreadRecord.inSight(inSightKey, of: hosts.flatMap(\.listedThreads))
        var waiting = Set<ThreadKey>()
        var running = Set<ThreadKey>()
        // Only the threads that may be at work are asked: at 2000 threads asking each
        // took more than working out the layout. One that is not listed is in neither
        // group, as before.
        for host in hosts {
            for id in host.threadsMaybeAtWork {
                switch host.activity(of: id) {
                case .waiting: waiting.insert(ThreadKey(host: host.id, id: id))
                case .working: running.insert(ThreadKey(host: host.id, id: id))
                case .idle: break
                }
            }
        }
        let agents = hosts.flatMap(\.agents)
        // Worked out again only when something it is made of changed (`SidebarLayoutCache`).
        let layout = layoutCache.layout(for: SidebarLayoutCache.Inputs(
            hosts: hosts.map(\.host), agents: agents, threads: threads,
            waiting: waiting, running: running, withFolders: Set(hosts.filter(\.offersFolders).map(\.id)),
            // Only the hosts that listed their folders: one that has not yet (at launch, a
            // host saved as offering them) is no host with none, whose folders' dates are
            // forgotten (`SidebarLayout.build`).
            folders: Dictionary(uniqueKeysWithValues: hosts.compactMap { host in host.folders.map { (host.id, $0.recent) } }),
            order: Dictionary(uniqueKeysWithValues: hosts.map { ($0.id, $0.order) }),
            nesting: Set(hosts.filter { $0.host.nestsAgentThreads == true }.map(\.id)),
            recent: recent,
            foldersByLastUse: foldersByLastUse,
            recentChoice: recentChoice
        ))
        if layoutCache.firstSeen != savedFirstSeen { saveFoldersFirstSeen() }
        return layout
    }

    /// The sidebar's layout as last worked out, with what it was made of.
    @ObservationIgnored private var layoutCache = SidebarLayoutCache()
    /// When each folder was first seen, as last kept on this device: what the folders'
    /// places start from after a relaunch (`SidebarLayoutCache.firstSeen`), so that one
    /// added with no thread stays where it is once its host says it was used since.
    @ObservationIgnored private var savedFirstSeen: [SidebarProject.ID: Date] = [:]

    // MARK: The sidebar's order

    /// Puts a folder's row just before another of its host's, or after them all when
    /// there is no `target`. Every folder the host's space lists then is placed by it, and
    /// stays where it is whichever is worked in next; one that comes later is after them
    /// (`SidebarOrder.placedFirst`). Folders listed by last use are not any more: the
    /// user's order is theirs from now on.
    func move(_ project: SidebarProject.ID, before target: SidebarProject.ID?) {
        guard let host = model(for: project.host), target == nil || target?.host == project.host else { return }
        let rows = layout.spaces.first { $0.id == project.host }?.folders.map(\.id.path) ?? []
        let moved = SidebarOrder.moving(project.path, before: target?.path, in: rows)
        foldersByLastUse.remove(project.host)
        if moved != rows { host.arrange(.folders, moved) }
    }

    /// The order of the user's Macs as this device goes by it: the one arranged last
    /// that it knows of, here or on another device (`MachineOrder`). nil until the Macs
    /// are arranged somewhere.
    private(set) var machineOrder: MachineOrder?

    /// Puts a Mac just before another, or after them all when there is no `target`.
    /// The list of Macs is this device's own and is changed at once. For every other
    /// device, the Macs whose bridges gave an id are an order arranged now, which each
    /// such bridge is given and keeps unless it has one arranged later.
    func moveHost(_ host: HostID, before target: HostID?) {
        let rows = hosts.map(\.id.rawValue)
        let moved = SidebarOrder.moving(host.rawValue, before: target?.rawValue, in: rows)
        guard moved != rows else { return }
        let models = Dictionary(uniqueKeysWithValues: hosts.map { ($0.id.rawValue, $0) })
        hosts = moved.compactMap { models[$0] }
        saveHosts()
        // Kept with no id in it too: the moment counts once the Macs say which they are.
        let order = (machineOrder ?? MachineOrder(ids: [], at: 0))
            .rearranged(hosts.compactMap(\.host.machineID), now: Int(Date().timeIntervalSince1970 * 1000))
        machineOrder = order
        store.saveMachineOrder(order)
        hosts.forEach { $0.machineOrderChanged() }
    }

    /// A host said how its copy of the order of the user's Macs is. One arranged later
    /// than the one this device goes by is taken: the Macs are listed by it, and the
    /// other hosts are given it. A host whose copy is older is given this device's.
    func machineOrderSaid(by host: HostModel) {
        if let said = host.saidMachineOrder, said.isLater(than: machineOrder) {
            machineOrder = said
            store.saveMachineOrder(said)
            arrangeHosts()
            hosts.filter { $0 !== host }.forEach { $0.machineOrderChanged() }
        } else {
            host.machineOrderChanged()
        }
    }

    /// A host said which Mac it is: it has its place in the order now. One the order
    /// does not name yet, arranged here before it said, goes into it where this device
    /// lists it, in an order a moment later than the one it was missing from, so that
    /// an order arranged since on another device still wins.
    func machineKnown(on host: HostModel) {
        // A Mac added by hand that turns out to be one of the net's becomes the net's.
        if net.isInNet, !host.host.isNetHost, net.membership.macs.contains(where: { $0.id == host.host.machineID }) {
            netChanged(net.membership.members)
            return
        }
        saveHosts()
        if let order = machineOrder, let id = host.host.machineID, !order.ids.contains(id) {
            let filled = order.rearranged(hosts.compactMap(\.host.machineID), now: order.at)
            machineOrder = filled
            store.saveMachineOrder(filled)
            hosts.forEach { $0.machineOrderChanged() }
        } else {
            arrangeHosts()
        }
    }

    /// Lists the Macs by the order this device goes by. One that is not on it stays
    /// where it is.
    private func arrangeHosts() {
        guard let machineOrder else { return }
        let arranged = machineOrder.arranged(hosts) { $0.host.machineID }
        guard arranged.map(\.id) != hosts.map(\.id) else { return }
        hosts = arranged
        saveHosts()
    }

    /// The Macs whose folders the sidebar lists by when each was last worked in, the one
    /// worked in last on top, as the user asked from a folder's menu. Every other Mac's
    /// stay where they are as work starts and ends in them, in the user's order and then
    /// from the one first seen last (2026-10-24: `SidebarSpace.folders`). Kept on
    /// this device, between launches; the user's order, kept for every device, is left
    /// as it is, and is back once this is turned off.
    private(set) var foldersByLastUse: Set<HostID> = [] {
        didSet {
            guard foldersByLastUse != oldValue, !isDemo else { return }
            UserDefaults.standard.set(foldersByLastUse.map(\.rawValue).sorted(), forKey: Self.foldersByLastUseKey)
        }
    }

    /// Whether the host's folders are listed by when each was last worked in.
    func sortsFoldersByLastUse(on host: HostID) -> Bool {
        foldersByLastUse.contains(host)
    }

    /// Lists the host's folders by when each was last worked in, or (`on` false) where
    /// they stay again.
    func sortFoldersByLastUse(_ on: Bool, on host: HostID) {
        if on {
            foldersByLastUse.insert(host)
        } else {
            foldersByLastUse.remove(host)
        }
    }

    /// A host's agents in the order the sidebar lists them, for a menu that offers them.
    func arrangedAgents(on host: HostID) -> [Agent] {
        guard let model = model(for: host) else { return [] }
        return model.order.arranged(model.agents)
    }

    /// The agents a new thread in one of `host`'s folders can be with, in the sidebar's
    /// order.
    func agentsForFolder(on host: HostID) -> [Agent] {
        arrangedAgents(on: host)
    }

    /// Whether some host's agents work in folders, which Settings then has a say on.
    var offersProjects: Bool {
        hosts.contains(where: \.offersFolders)
    }

    /// Whether a thread in the folder is waiting for an answer, or running, right now.
    func activity(of project: SidebarProject.ID) -> HostModel.Activity {
        guard let host = model(for: project.host) else { return .idle }
        // The threads that may be at work, each looked up in the folder's: not every
        // thread of the list, each time the sidebar is drawn.
        var states: [HostModel.Activity] = []
        for id in host.threadsMaybeAtWork where !host.removing.contains(id) {
            let state = host.activity(of: id)
            guard state != .idle, let record = host.record(for: id),
                  SidebarProject.ID(of: record) == project else { continue }
            states.append(state)
        }
        if states.contains(.waiting) { return .waiting }
        return states.contains(.working) ? .working : .idle
    }

    func style(for agent: Agent.ID) -> AgentAvatarStyle {
        model(for: agent.host)?.style(for: agent) ?? .standard
    }

    func look(for agent: Agent.ID) -> AgentLook {
        model(for: agent.host)?.look(for: agent) ?? AgentLook.derived(from: agent.name, in: AgentLookCatalogue.size)
    }

    func logo(for agent: Agent.ID) -> CodingAgentLogo? {
        model(for: agent.host)?.logo(for: agent)
    }

    func setLook(_ look: AgentLook, for agent: Agent.ID) {
        model(for: agent.host)?.setLook(look, for: agent)
    }

    func activity(of agent: Agent.ID) -> HostModel.Activity {
        model(for: agent.host)?.activity(of: agent) ?? .idle
    }

    /// A host listed its agents: on connecting, and each time it reconnects.
    func agentsListed(on host: HostModel) {
        SidebarProbe.mark("host-listed", once: true)
        if SidebarProbe.expandsEverything { foldedProjects = [] }
        assignLooks()
        saveNotificationAvatarsSoon()
        replaceMissingAgent(on: host)
        pickDebugAgent(on: host)
        makeDebugMove(on: host)
        openStartingThread()
        // A thread put on screen before its host could be reached (a tapped
        // notification, a tap while reconnecting) is brought in line with it now.
        if let chat, chat.agent.id.host == host.id {
            chat.prepare()
            host.loadOfferings(for: chat.agent.id)
        }
        if isDemo { startTour() }
        runDebugLaunchIfReady()
        preloadPanels(on: host)
    }

    /// What the panel over a chat shows of this host's agents with a tab open, before any
    /// panel opens (`ThreadPanelMemory`). Not while no window can be seen, as `PanelAsking`
    /// asks nothing then: each chat asks when it is first seen.
    private func preloadPanels(on host: HostModel) {
        guard !WindowVisibility.shared.isHidden, let provider = host.panelProvider else { return }
        var threads: [Agent.ID: ThreadRef.ID] = [:]
        for key in tabs.keys where key.host == host.id {
            if let record = host.record(for: key.id) { threads[record.ref.agent] = key.id }
        }
        Task { await ThreadPanelMemory.shared.preload(from: provider, host: host.id, threads: threads, asksApps: ThreadPanel.opensInApps) }
    }

    func looksChanged() {
        saveNotificationAvatarsNow()
    }

    /// A host that keeps how its agents look for every device said how they look now:
    /// an agent whose look is only this device's must not be drawn like one of them.
    func looksTaken() {
        assignLooks()
        saveNotificationAvatarsSoon()
    }

    /// Gives looks to every host's agents together, so no two agents in the sidebar are
    /// drawn alike while another pairing of shape and colour is free. Looks chosen by
    /// hand are never changed (`AgentLookCatalogue.assign`).
    private func assignLooks() {
        let agents = hosts.flatMap { host in host.agents.map(\.id) }
        let saved = hosts.reduce(into: [Agent.ID: AgentLook]()) { looks, host in looks.merge(host.looks) { first, _ in first } }
        let origins = hosts.reduce(into: [Agent.ID: LookOrigin]()) { origins, host in origins.merge(host.settledLookOrigins) { first, _ in first } }
        let given = AgentLookCatalogue.assign(to: agents, keeping: saved, origins: origins)
        hosts.forEach { $0.lookGiven(given) }
    }

    /// A new thread on screen whose agent the host no longer has (the list saved last
    /// time was out of date) moves to the host's default agent.
    private func replaceMissingAgent(on host: HostModel) {
        guard let chat, chat.agent.id.host == host.id, chat.isUnused, host.agent(chat.agent.id) == nil else { return }
        if let replacement = host.defaultAgent {
            host.newThread(with: replacement)
        } else {
            chat.close()
            self.chat = nil
            navigation += 1
        }
    }

    /// The agent the launch environment names, looked for on each host as it lists its
    /// agents: the list saved last time may not have it yet. With a folder named too, its
    /// new thread is in that folder, once the host has listed its folders.
    private func pickDebugAgent(on host: HostModel) {
        guard let name = DebugLaunch.agentName, !hasFoundDebugAgent,
              let agent = host.agents.first(where: { $0.id.name == name }) else { return }
        hasFoundDebugAgent = true
        guard let folderName = DebugLaunch.folderName, host.offersFolders else {
            hasOpenedDebugFolder = true
            if chat?.isUnused ?? true { host.newThread(with: agent) }
            return
        }
        Task {
            let folder = try? await host.loadFolders(for: agent.id).folder(named: folderName)
            if folder == nil { AppLog.chat.error("No folder named \(folderName, privacy: .public) on \(host.host.name, privacy: .public)") }
            if chat?.isUnused ?? true { host.newThread(with: agent, in: folder) }
            hasOpenedDebugFolder = true
            runDebugLaunchIfReady()
        }
    }

    /// The move the launch environment names (`DebugLaunch.move`), made once, on the
    /// first host that lists a row of that name, as the row's menu would make it. A
    /// folder's waits for the host to have said which folders it has.
    private func makeDebugMove(on host: HostModel) {
        guard let move = DebugLaunch.move, !didMakeDebugMove else { return }
        if move.isHost {
            // Once every Mac has said which it is, so the order made names them all.
            let ids = hosts.map(\.id)
            guard hosts.allSatisfy(\.hasListedAgents), let named = hosts.first(where: { $0.host.name == move.name }),
                  let made = move.step.step(of: named.id, among: ids) else { return }
            didMakeDebugMove = true
            moveHost(made.moved, before: made.before)
        } else if move.isFolder {
            Task {
                if let agent = host.agents.first { _ = try? await host.loadFolders(for: agent.id) }
                // No project stays last, and moves none.
                let projects = layout.spaces.first { $0.id == host.id }?.folders.filter { !$0.isGeneral } ?? []
                guard !didMakeDebugMove, let project = projects.first(where: { $0.name == move.name }),
                      let made = move.step.step(of: project.id, among: projects.map(\.id)) else { return }
                didMakeDebugMove = true
                self.move(made.moved, before: made.before)
            }
        }
    }

    /// Saves the agents' notification pictures a moment later, once for any number of
    /// asks, with the looks as they are then: at launch, and as hosts list their agents
    /// and say how they look. Drawing them takes about 90 ms of the main thread on a
    /// Mac, which the launch's first frame and the host's first answer need more; the
    /// pictures saved last time are there meanwhile. Saved at once when the app leaves
    /// the screen (`leftScreen`), where it may be suspended or ended before the moment
    /// comes, and asked for then, at once too.
    private func saveNotificationAvatarsSoon() {
        guard !isDemo else { return }
        guard !isOffScreen else { return saveNotificationAvatarsNow() }
        notificationAvatars.ask { [weak self] in self?.saveNotificationAvatars() }
    }

    /// Saves them now, for a change made here (a look chosen, a host removed): the
    /// notification extension can only show what was saved.
    private func saveNotificationAvatarsNow() {
        guard !isDemo else { return }
        notificationAvatars.cancel()
        saveNotificationAvatars()
    }

    @ObservationIgnored private let notificationAvatars = CoalescedWork(after: .seconds(2))

    /// The agents' avatars as their notifications show them, for the notification
    /// extension. Every host's in one go: a save removes the pictures it is not given.
    private func saveNotificationAvatars() {
        var styles: [Agent.ID: AgentAvatarStyle] = [:]
        for host in hosts {
            for agent in host.agents { styles[agent.id] = host.style(for: agent.id) }
        }
        NotificationAvatarArt.save(styles)
        SidebarProbe.mark("avatars-saved", once: true)
    }

    // MARK: Threads

    /// Every host's threads, most recently active first: not those on their way off a
    /// host's list.
    var allThreads: [ThreadRecord] {
        hosts.flatMap(\.listedThreads).sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Whether a thread is running or waiting for an answer right now.
    func activity(of thread: ThreadKey) -> HostModel.Activity {
        model(for: thread.host)?.activity(of: thread.id) ?? .idle
    }

    /// Opens an empty thread with `agent`, or with the agent on screen, in `folder` on a
    /// host whose agents work in folders (General when none is given). A thread with
    /// nothing in it yet is reused.
    func newThread(with agent: Agent? = nil, in folder: Folder? = nil) {
        guard let agent = agent ?? chat?.agent else { return }
        model(for: agent.id.host)?.newThread(with: agent, in: folder)
    }

    /// Whether a new thread with `agent` starts by choosing a folder: its host's agents
    /// work in folders the host offers (a Portals bridge), and it is a coding agent,
    /// or a Hermes agent where Settings says those are asked too. Never any agent of a
    /// Hermes host.
    func choosesFolder(for agent: Agent.ID) -> Bool {
        guard let host = model(for: agent.host), host.offersFolders else { return false }
        guard let known = host.agent(agent) else { return true }
        return asksHermesAgentsForFolder || !known.needsNoFolder(on: host.host.kind)
    }

    /// Whether `agent`'s host offers folders at all, so that a thread with an agent that
    /// is not asked can still be started in one on purpose.
    func offersFolders(for agent: Agent.ID) -> Bool {
        model(for: agent.host)?.offersFolders ?? false
    }

    /// Whether `agent`'s host lists the sessions started on it, in a terminal, for the
    /// app to take up (a Portals bridge). Hermes does not.
    func offersDeskSessions(for agent: Agent.ID) -> Bool {
        model(for: agent.host)?.offersDeskSessions ?? false
    }

    /// Puts a thread on screen, then calls `shown`: at once for one in memory, once its
    /// saved copy is read for another (`HostModel.open`).
    func open(_ record: ThreadRecord, then shown: (() -> Void)? = nil) {
        guard let model = model(for: record.key.host) else {
            shown?()
            return
        }
        model.open(record) { [weak self] in
            self?.rememberRecentIfShown(record.key)
            shown?()
        }
    }

    /// Goes up with every request to put something on screen and everything put there: a
    /// thread whose saved copy is being read (`HostModel.open`) is shown only if it is still
    /// the last, so a thread asked for after it, the one on screen asked for again, or a new
    /// thread, takes its place, whatever it is.
    @ObservationIgnored private(set) var navigation = 0
    /// The thread whose saved copy is being read to put it on screen, for the last request
    /// (`HostModel.open`): closing its tab meanwhile calls that off (`closeTab`), and its
    /// host put in again, with another model, asks for it again of that one (`askAgain`).
    @ObservationIgnored var beingRead: ThreadKey?

    /// A request to put something on screen: its number (`navigation`).
    func navigated() -> Int {
        navigation += 1
        beingRead = nil
        return navigation
    }

    /// Opens the thread a tapped notification is about, on whichever host has it. False
    /// when no host has it (it was removed since).
    @discardableResult
    func open(_ route: PushRoute) -> Bool {
        guard let record = route.resolve(in: allThreads), model(for: record.key.host) != nil else { return false }
        open(record)
        return true
    }

    func delete(_ record: ThreadRecord) {
        model(for: record.key.host)?.delete(record)
    }

    /// Whether Remove is offered for a thread: not while it is at work, where removing it
    /// would take it off every device.
    func offersRemoval(_ record: ThreadRecord) -> Bool {
        model(for: record.key.host)?.offersRemoval(record) ?? false
    }

    /// A host said no to removing a thread, or to its new title: the thread shows again,
    /// or has its title from before, and the screen says why, after the refusal on screen
    /// if there is one.
    func refused(_ refusal: Refusal) {
        guard self.refusal != nil else {
            self.refusal = refusal
            return
        }
        laterRefusal = laterRefusal.map { $0.adding(refusal) } ?? refusal
    }

    /// The refusal on screen was read: the next one shows, once its alert has gone.
    func refusalRead() {
        refusal = nil
        guard let next = laterRefusal else { return }
        laterRefusal = nil
        Task {
            try? await Task.sleep(for: .milliseconds(600))
            refused(next)
        }
    }

    /// The thread looked at changed (`PushCoordinator.visibleThread`): whatever finished in
    /// it has been seen.
    func threadLookedAt(_ route: PushRoute?) {
        guard let route, let host = route.host.flatMap(model(for:)) else { return }
        host.threadLookedAt(route.thread)
    }

    func rename(_ record: ThreadRecord, to title: String) {
        model(for: record.key.host)?.rename(record, to: title)
    }

    func offersFork(_ record: ThreadRecord) -> Bool {
        model(for: record.key.host)?.offersFork(record.ref) == true
    }

    func canFork(_ record: ThreadRecord) -> Bool {
        model(for: record.key.host)?.canFork(record.ref) == true
    }

    func fork(_ record: ThreadRecord) {
        guard let host = model(for: record.key.host), host.canFork(record.ref) else { return }
        Task {
            do { try await host.fork(record.ref) }
            catch { refused(Refusal(heading: "Not forked", title: record.displayTitle, reason: error.localizedDescription)) }
        }
    }

    func setPinned(_ pinned: Bool, for record: ThreadRecord) {
        model(for: record.key.host)?.setPinned(pinned, for: record)
    }

    /// Archiving takes the thread out of Recent, on every device on a host that keeps it
    /// for them (`HostSync.record`, and the host itself), and otherwise on this one.
    func setArchived(_ archived: Bool, for record: ThreadRecord) {
        model(for: record.key.host)?.setArchived(archived, for: record)
        if archived { changeRecent { $0.dismiss(record.key) } }
    }

    /// Shows a thread an agent started in the sidebar too, or puts it back under the
    /// thread that started it.
    func setShared(_ shared: Bool, for record: ThreadRecord) {
        model(for: record.key.host)?.setShared(shared, for: record)
    }

    /// Whether `record` is one an agent started from a thread the sidebar lists, on a host
    /// that lists it under that one (`SidebarLayout.nested`): Take over thread or Hide from
    /// sidebar is offered for it (`TakeOver`). Not for one started from a thread gone, which is in the sidebar
    /// whatever its mark says. As the sidebar last worked it out, which it
    /// does before it draws a row: read without following it, so that no row is drawn
    /// again each time the layout is.
    func nestsUnderItsStarter(_ record: ThreadRecord) -> Bool {
        record.startedBy != nil && layoutCache.layout.nested.contains(record.key)
    }

    /// Whether `record` is under the thread that started it and not taken over, so in no
    /// folder of the sidebar (`StartedThreads.tucked`): Show in Its Folder has nowhere to go
    /// for it, and Take over thread is offered in its place. As `nestsUnderItsStarter`.
    func isTucked(_ record: ThreadRecord) -> Bool {
        !record.isShared && nestsUnderItsStarter(record)
    }

    /// The app's own name for the Mac with the stable id `machine` (`HostConfig.machineID`),
    /// when it has that Mac as a host: "Mac mini" rather than the Mac's name for itself.
    func macName(forMachine machine: String) -> String? {
        hosts.first { $0.host.machineID == machine }?.host.name
    }

    /// The app's own names for the Macs it has as hosts, by their stable ids: the first
    /// host of a Mac added twice. For who a message came from (`RelayedMessageRow`).
    /// The same dictionary as long as the names are the same: `MainScreen` hands it down
    /// to every chat as it is worked out (each tab switch), and a new one, equal or not,
    /// counted as a change to every view reading it.
    var macNames: [String: String] {
        var names: [String: String] = [:]
        for host in hosts {
            if let id = host.host.machineID, names[id] == nil { names[id] = host.host.name }
        }
        if names != lastMacNames { lastMacNames = names }
        return lastMacNames
    }
    @ObservationIgnored private var lastMacNames: [String: String] = [:]

    /// The threads agents started from `thread`, in the order they were started, for the
    /// line at the foot of its chat: on a host that lists them there (`AgentThreadNesting`).
    func startedThreads(from thread: ThreadKey) -> [StartedThread] {
        guard let host = model(for: thread.host) else { return [] }
        // Its own host's, and those another Mac's host started from it there (`senders`):
        // each lists them under it only when it nests started threads.
        let nesting = hosts.filter { $0.host.nestsAgentThreads == true }
        guard !nesting.isEmpty else { return [] }
        let machines = StartedThreads.machines(of: hosts.map(\.host))
        let started = nesting.flatMap { other in
            other.id == host.id
                ? StartedThreads.started(from: thread, in: other.listedThreads)
                : StartedThreads.started(from: thread, in: other.listedThreads, machines: machines)
        }
        guard !started.isEmpty else { return [] }
        // The sidebar's rule (`StartedThreads.nested`): a thread of an agent it lists.
        let starter = host.listedThreads.first { $0.key == thread }?.ref.agent
        let nests = starter.map { agent in host.agents.contains { $0.id == agent } } ?? false
        return started
            .sorted { ($0.ref.createdAt, $0.id.rawValue) < ($1.ref.createdAt, $1.id.rawValue) }
            .map { record in
                let owner = model(for: record.key.host) ?? host
                let agentName = owner.agent(record.ref.agent)?.displayName ?? record.ref.agent.name
                return StartedThread(
                    // One on another Mac says which: two Macs' "Review" would read the same.
                    record: record, agentName: owner.id == host.id ? agentName : "\(agentName) on \(owner.host.name)",
                    activity: owner.activity(of: record.id), nests: nests, style: style(for: record.ref.agent)
                )
            }
    }

    /// The thread an agent started `thread` from, on its Mac or another the app has as a
    /// host, for the back button over its chat (`ParentThreadButton`, `StartedThreads.parent`):
    /// only for a tab opened from the foot of that one's chat (`openStarted`), and not once
    /// Take over thread put it in the sidebar (2026-10-28: "if we added the thread to
    /// the sidebar it shouldnt show this anymore"). nil for a thread no agent started from
    /// another, once that one is gone from the app's list or on its way off it, and while its
    /// host has not its agent, which it would not open (`HostModel.open`).
    func parent(of thread: ThreadKey) -> ThreadRecord? {
        guard tabs.wasOpenedFromStarter(thread),
              let record = model(for: thread.host)?.record(for: thread.id), !record.isShared else { return nil }
        return StartedThreads.parent(of: record, machines: StartedThreads.machines(of: hosts.map(\.host))) { key in
            guard let host = model(for: key.host), !host.removing.contains(key.id) else { return nil }
            return host.record(for: key.id)
        } opens: { agent in
            model(for: agent.host)?.agent(agent) != nil
        }
    }

    /// Opens a thread an agent started, from the foot of the chat of the thread that started
    /// it: its tab is marked so, for the back button over it (`parent(of:)`).
    func openStarted(_ record: ThreadRecord) {
        open(record) { [weak self] in
            guard let self, self.chat?.thread?.key == record.key else { return }
            self.changeTabs { $0.markOpenedFromStarter(record.key) }
        }
    }

    /// The back button over `thread`'s chat: puts the thread that started it on screen,
    /// then closes `thread`'s tab, which was opened from that one's foot to look in on it.
    func back(to parent: ThreadRecord, from thread: ThreadKey) {
        open(parent) { [weak self] in
            // Not shown after all (its agent gone): the thread stays, and its tab.
            guard let self, self.chat?.thread?.key == parent.key else { return }
            self.closeTab(thread)
        }
    }

    /// Asks every host which of its threads are running or waiting now, and brings the
    /// list of each that keeps it for every device in step: each on its own, so a slow
    /// host holds up no other.
    func refreshActivity() {
        hosts.forEach { $0.refreshActivity() }
    }

    /// Whether renaming `record` reaches its host too (a bridge), not only the app.
    func renamesOnHost(_ record: ThreadRecord) -> Bool {
        model(for: record.key.host)?.renamesThreads ?? false
    }

    /// Puts a thread on screen.
    func show(_ controller: ThreadController) {
        // Whatever was being read to be shown gives way to this.
        navigation += 1
        beingRead = nil
        if draftTab === controller { draftTab = nil }
        // A thread nothing was done with leaves nothing behind, but for what was typed in
        // it (`draftTab`). One whose first message is still on its way is left to finish,
        // and saves itself: a tab then.
        if let previous = chat, previous !== controller {
            if previous.isUnused, previous.hasDraft, previous.savedConversation == nil, previous !== closedNewThread {
                if let draftTab, draftTab !== previous { draftTab.close() }
                draftTab = previous
            } else if previous.isUnused {
                previous.close()
            } else if isOnItsWay(previous), !tabsOnTheirWay.contains(where: { $0.controller === previous }) {
                tabsOnTheirWay.append(HeldWeakly(controller: previous))
            }
        }
        closedNewThread = nil
        chat = controller
        // A thread shown is a tab, where it was not one already. A new one is no tab
        // until its first message is sent (`threadSaved`), and nothing is on screen to
        // come back to after a relaunch meanwhile.
        if let key = controller.thread?.key {
            tabBeforeNewThread = nil
            changeTabs { $0.open(key) }
        } else {
            if let shown = tabs.lastSelected { tabBeforeNewThread = shown }
            changeTabs { $0.lastSelected = nil }
        }
        ReturnProbe.shared?.note("shown", controller.thread?.id.rawValue ?? "new")
        controller.prepare()
        SidebarProbe.mark("chat-shown", detail: "\(controller.state.transcript.turns.count)")
        SidebarProbe.markNextFrame("chat-drawn")
        model(of: controller)?.loadOfferings(for: controller.agent.id)
        if let id = controller.thread?.id { model(of: controller)?.markSeen(id) }
    }

    /// A thread was saved for the first time: its folder opens in the sidebar, where it
    /// is listed.
    func threadAdded(_ record: ThreadRecord) {
        if let project = SidebarProject.ID(of: record) { foldedProjects.remove(project) }
    }

    /// A folder was added on a host: it opens in the sidebar, where the next thing is a
    /// thread in it.
    func folderAdded(_ folder: Folder, on host: HostID) {
        guard folder.isAdded else { return }
        foldedProjects.remove(SidebarProject.ID(host: host, path: folder.path))
    }

    /// Takes a project that is in the sidebar only for having been added off it: its
    /// folder off its host's list.
    func removeProject(_ project: SidebarProject.ID) {
        foldedProjects.remove(project)
        guard let host = model(for: project.host) else { return }
        Task { try? await host.removeFolder(at: project.path) }
    }

    /// A new thread with the first host's default agent, when nothing is on screen yet.
    /// The thread on screen stays whatever another host does.
    private func openStartingThread() {
        guard chat == nil else { return }
        let named = DebugLaunch.agentName.flatMap { name in hosts.lazy.flatMap(\.agents).first { $0.id.name == name } }
        guard let agent = named ?? hosts.lazy.compactMap(\.defaultAgent).first else { return }
        model(for: agent.id.host)?.newThread(with: agent)
    }

    // MARK: The thread on screen, in the sidebar

    /// The flags the sidebar's rows mark the thread on screen by (`ThreadRow`): a switch
    /// draws again the two rows whose flag it changes, and not the sidebar's lists, which
    /// read the thread on screen for every row before (about 7 ms of a switch's frame at
    /// 600 threads).
    @ObservationIgnored let currentRows = CurrentRows()
    /// Counts the changes of the thread on screen that change what a folder lists: one is
    /// listed under its folder past the recent ones while it is on screen
    /// (`SidebarSections.recent`). The folders' lists follow this, not the thread on
    /// screen, which they read without following it (`listedCurrent`).
    private(set) var listedCurrentChanges = 0

    /// The thread on screen, for what the folders list (`SidebarSections.recent`): read
    /// without following it; `listedCurrentChanges` changes when that changes a list.
    var listedCurrent: ThreadKey? {
        currentRows.key
    }

    /// The rows marking the thread on screen, and the folders' lists, follow it: as it
    /// changes, and as a new thread on screen is saved (`ChatWatch` too).
    func noteCurrent() {
        let key = chat?.thread?.key
        let old = currentRows.key
        guard key != old else { return }
        currentRows.show(key)
        if isListedOnlyOnScreen(old) || isListedOnlyOnScreen(key) { listedCurrentChanges += 1 }
    }

    /// Whether the thread `key` is listed under its folder only for being on screen: past
    /// the recent ones, as the sidebar last worked the folders out.
    private func isListedOnlyOnScreen(_ key: ThreadKey?) -> Bool {
        guard let key, let space = layoutCache.layout.spaces.first(where: { $0.id == key.host }) else { return false }
        guard let folder = space.folders.first(where: { $0.threads.contains { $0.key == key } }) else { return false }
        return !SidebarSections.recent(folder.threads, count: AgentSidebar.recentThreads, keeping: nil).contains { $0.key == key }
    }

    // MARK: Chats kept built

    /// The chats kept built while another is on screen, with the one on screen: going back
    /// to one shows it at once, as it was left (scrolled where it was), where building it
    /// again took about a tenth of a second of the main thread (`MainScreen`). In the
    /// order they were first kept, which is the order they are drawn in. At most
    /// `chatsKeptBehind` besides the one on screen, the most recently shown, each an open
    /// tab; a reply's pieces are held for those off screen
    /// (`ThreadController.isKeptOffScreen`).
    private(set) var keptChats: [ThreadController] = []
    /// The kept chats by when they were last on screen, the most recent last.
    @ObservationIgnored private var keptOrder: [ObjectIdentifier] = []
    /// How many chats are kept built besides the one on screen: `MainScreen` says, none
    /// where no tabs show (an iPhone; an iPad in a narrow window), where the chat is built
    /// anew each time as before.
    @ObservationIgnored var chatsKeptBehind = 0 {
        didSet {
            if chatsKeptBehind != oldValue { trimKeptChats() }
        }
    }
    /// The kept chats with a panel open over them (`PanelOpenKey`), as `MainScreen` hears
    /// it: one leaving the screen with a panel, a sheet, a popover or an alert open is not
    /// kept, and what was open goes with it, as before.
    @ObservationIgnored var chatsWithPanels: Set<ObjectIdentifier> = []

    /// The chat on screen changed from `previous`: kept, it is hidden; the one on screen
    /// now is kept too, the least recently shown let go past `chatsKeptBehind`.
    private func keepChats(leaving previous: ThreadController?) {
        if let previous, keptChats.contains(where: { $0 === previous }),
           chatsWithPanels.contains(ObjectIdentifier(previous)) || Self.presentsOverWindow {
            keptOrder.removeAll { $0 == ObjectIdentifier(previous) }
        }
        if let shown = chat {
            keptOrder.removeAll { $0 == ObjectIdentifier(shown) }
            keptOrder.append(ObjectIdentifier(shown))
            if !keptChats.contains(where: { $0 === shown }) { keptChats.append(shown) }
        }
        trimKeptChats()
    }

    /// Lets go of the kept chats past `chatsKeptBehind`, the least recently shown first, and
    /// of those closed (their thread let go of, `HostModel`) or no longer a tab; tells each
    /// kept whether it is off screen.
    private func trimKeptChats() {
        let shown = chat
        let ranked = Set(keptOrder)
        var keeping = keptChats.filter { kept in
            kept === shown || (ranked.contains(ObjectIdentifier(kept)) && !kept.isClosed
                && kept.thread.map { tabs.contains($0.key) } == true)
        }
        let excess = keeping.count { $0 !== shown } - max(chatsKeptBehind, 0)
        if excess > 0 {
            let leaving = Set(keptOrder.filter { id in
                id != shown.map(ObjectIdentifier.init) && keeping.contains { ObjectIdentifier($0) == id }
            }.prefix(excess))
            keeping.removeAll { leaving.contains(ObjectIdentifier($0)) }
        }
        for kept in keptChats where !keeping.contains(where: { $0 === kept }) {
            kept.isKeptOffScreen = false
            chatsWithPanels.remove(ObjectIdentifier(kept))
        }
        for kept in keeping { kept.isKeptOffScreen = kept !== shown }
        keptOrder.removeAll { id in !keeping.contains { ObjectIdentifier($0) == id } }
        if keeping.map(ObjectIdentifier.init) != keptChats.map(ObjectIdentifier.init) { keptChats = keeping }
    }

    /// Threads were let go of, or closed (`HostModel`): their chats are not kept.
    func chatsClosed() {
        trimKeptChats()
    }

    /// The system is short of memory: every chat kept out of sight is let go of, the one on
    /// screen kept. Those shown from now on are kept again, up to `chatsKeptBehind`.
    func letGoOfKeptChats() {
        let shown = chat.map(ObjectIdentifier.init)
        keptOrder.removeAll { $0 != shown }
        trimKeptChats()
        AppLog.chat.notice("Memory warning: let go of the chats kept out of sight")
    }

    /// Whether a sheet, a popover or an alert is open in any of the app's windows.
    private static var presentsOverWindow: Bool {
        UIApplication.shared.connectedScenes.contains { scene in
            (scene as? UIWindowScene)?.windows.contains { $0.rootViewController?.presentedViewController != nil } == true
        }
    }

    // MARK: Tabs

    /// Changes the tabs, and saves them when that changed them: a change that changes
    /// nothing (the tab on screen shown again) tells nothing that shows them.
    @discardableResult
    private func changeTabs<Result>(_ change: (inout OpenTabs) -> Result) -> Result {
        var changed = tabs
        let result = change(&changed)
        if changed != tabs {
            tabs = changed
            saveTabsSoon()
            trimKeptChats()
        }
        return result
    }

    /// Puts a tab's thread on screen (`HostModel.open`), then calls `shown`. False for no
    /// tab, for one whose thread is no longer listed, which is closed, and for one the host
    /// cannot open (its agent gone), which stays.
    @discardableResult
    func showTab(_ key: ThreadKey?, readingNow: Bool = false, remember: Bool = true, then shown: (() -> Void)? = nil) -> Bool {
        guard let key else { return false }
        guard let host = model(for: key.host), !host.removing.contains(key.id), let record = host.record(for: key.id) else {
            changeTabs { $0.close(key) }
            return false
        }
        return host.open(record, readingNow: readingNow) { [weak self] in
            if remember { self?.rememberRecentIfShown(key) }
            shown?()
        }
    }

    /// Shows the first available fallback tab without restoring dismissed history.
    /// False when none can be shown.
    private func showFirstTab(of keys: [ThreadKey], readingNow: Bool = false) -> Bool {
        for key in keys {
            if showTab(key, readingNow: readingNow, remember: false) { return true }
        }
        return false
    }

    /// Puts on screen in place of `shown`, whose tab was closed, the first of `candidates`
    /// that can be shown; with none, a new thread with its agent, in its folder.
    private func giveWay(_ shown: ThreadController, to candidates: [ThreadKey]) {
        guard !showFirstTab(of: candidates) else { return }
        newThread(with: shown.agent, in: shown.thread.flatMap { folder(of: $0.key) })
    }

    /// `key`'s tab was closed, or its thread is gone, or could not be shown: were its
    /// saved copy being read to put it on screen, that is called off. Where it was to take
    /// the place of a tab closed on screen, that thread is still there, and no tab: the
    /// next of `inPlace` that can be shown takes its place, or else a new thread.
    private func callOffReading(_ key: ThreadKey, inPlace: [ThreadKey]) {
        guard beingRead == key else { return }
        _ = navigated()
        giveWayIfNoTab(for: key, to: inPlace)
    }

    /// The thread on screen, where it is no tab (its tab closed for `key`'s thread to take
    /// its place, which is not shown after all), gives way to the next of `inPlace` that
    /// can be shown, or else a new thread.
    private func giveWayIfNoTab(for key: ThreadKey, to inPlace: [ThreadKey]) {
        guard let chat, let thread = chat.thread, thread.key != key, !tabs.contains(thread.key) else { return }
        giveWay(chat, to: inPlace)
    }

    /// `key`'s thread was being read to put it on screen when that read stopped: the model
    /// reading it was retired as its host was put in again (`put`), or the thread on
    /// screen was closed as its host's, which stops whatever is being read. It is asked
    /// for again, of the model its host has now, at once when nothing is on screen. One
    /// that cannot be shown any more (no longer listed, or its agent gone) is called off,
    /// as when it is not shown once read (`notShown`).
    private func askAgain(_ key: ThreadKey) {
        let inPlace = tabs.inPlace(of: key)
        guard !showTab(key, readingNow: chat == nil) else { return }
        _ = navigated()
        giveWayIfNoTab(for: key, to: inPlace)
    }

    /// A thread asked for was not put on screen after its saved copy was read: its agent,
    /// or the thread, gone meanwhile (`HostModel.open`).
    func notShown(_ key: ThreadKey) {
        callOffReading(key, inPlace: tabs.inPlace(of: key))
    }

    /// ⌘1 to ⌘9: the tab at `index`, counting from 0, the ninth being the last.
    func showTab(at index: Int) {
        showTab(tabs.key(at: index))
    }

    /// ⌃Tab and ⌃⇧Tab: the tab `step` tabs on from the one on screen, round from one end
    /// to the other; from the first while a new thread is on screen.
    func cycleTabs(by step: Int) {
        showTab(tabs.cycled(from: chat?.thread?.key, by: step))
    }

    /// Closes a thread's tab: its agent goes on with whatever it was doing, and its
    /// thread is let go of once at rest, as any other (`HostModel.letGoOfThreadsAtRest`).
    /// On screen, it gives way to the tab after it, or else the one before it, past any
    /// the host cannot open (`OpenTabs.inPlace`); closing the last shows a new thread with
    /// its agent, in its folder. One whose saved copy is still being read to put it on
    /// screen is not put there after all.
    func closeTab(_ key: ThreadKey) {
        let shown = chat?.thread?.key == key ? chat : nil
        let inPlace = tabs.inPlace(of: key)
        changeTabs { $0.close(key) }
        if let shown {
            giveWay(shown, to: inPlace)
        } else {
            callOffReading(key, inPlace: inPlace)
        }
    }

    /// ⌘W: closes the tab on screen. A new thread on screen is no tab yet: closing it
    /// goes back to the tab that was on screen before it, or else to the last, past any
    /// the host cannot open.
    func closeShownTab() {
        guard let chat else { return }
        if let key = chat.thread?.key {
            if tabs.contains(key) { closeTab(key) }
            return
        }
        closedNewThread = chat
        let before = tabBeforeNewThread.flatMap { tabs.contains($0) ? $0 : nil }
        if !showFirstTab(of: (before.map { [$0] } ?? []) + tabs.keys.reversed().filter { $0 != before }) {
            closedNewThread = nil
        }
    }

    /// A tab dragged along the tab strip to its place: just before `target`'s, or after
    /// every tab with no `target`.
    func moveTab(_ key: ThreadKey, before target: ThreadKey?) {
        changeTabs { $0.move(key, before: target) }
    }

    /// Close Other Tabs, from a tab's menu: every tab but `key`'s is closed, their agents
    /// going on, and `key`'s thread is put on screen where it was not. Another thread
    /// still being read to be put on screen (a tab chosen just before, whose tab this
    /// closes) is not put there after all, as when its tab is closed (`closeTab`): `key`'s
    /// stays.
    func closeOtherTabs(than key: ThreadKey) {
        if chat?.thread?.key != key, !showTab(key) { return }
        // Selected now, so that the thread on screen until `key`'s is read is not made a
        // tab again as it is saved (`threadSaved`).
        changeTabs { tabs in
            tabs.remove { $0 != key }
            tabs.lastSelected = key
        }
        if let beingRead, beingRead != key { callOffReading(beingRead, inPlace: tabs.keys) }
    }

    /// The Mac whose folders a new tab is offered in (the tab strip's +, ⌘T): the one
    /// whose space the sidebar shows (`spaceOnScreen`).
    var hostOnScreen: HostModel? {
        spaceOnScreen.flatMap(model(for:)) ?? hosts.first
    }

    /// Whether `agent` is talked with rather than set to work in a folder (a Hermes
    /// profile, any agent of a host that offers no folders): one of a space's bots, as
    /// `SidebarLayout` has them, whose look a tab's menu changes.
    func isBot(_ agent: Agent.ID) -> Bool {
        guard let host = model(for: agent.host) else { return false }
        guard host.offersFolders else { return true }
        return host.agent(agent)?.needsNoFolder(on: host.host.kind) ?? false
    }

    /// ⌘T and the tab bar's +, the sidebar's New thread, ⌘N and /new, at once and with no
    /// menu, as a browser's new tab (`NewTabStart`): a new thread in the folder the thread
    /// on screen works in (General when it works in none), or with nothing on screen, in
    /// the first folder the space the sidebar shows lists. It is with the agent the last
    /// thread was started with (a beta tester, 2026-10-31: "auto select the last agent used
    /// to create a chat"; "it should just bring us to the new thread page as well
    /// with the last agent used"), in the same folder where that agent's Mac lists it; or,
    /// before any or while that agent's Mac is not connected or lists it no more, as before:
    /// with the agent of the thread on screen, else the default agent of the Mac whose space
    /// the sidebar shows. One with an agent that is not asked for a folder is with it alone.
    /// Its composer has the cursor; its agent and folder are changed on its own screen
    /// (`NewThreadPickers`), and it is a tab once its first message is sent. From the
    /// sidebar's New thread on a phone the composer is left to a tap (`focusesComposer`):
    /// its keyboard would come up over the chips as they are shown to be chosen from.
    func newTab(focusesComposer: Bool = true) {
        var start: NewTabStart?
        var agent: Agent?
        if let chat {
            let folder = if let thread = chat.thread { folder(of: thread.key) } else { chat.folder }
            start = NewTabStart.like(shown: (chat.agent.id, folder), otherwise: nil)
            agent = chat.agent
        } else {
            let host = hostOnScreen
            agent = host?.defaultAgent ?? host?.agents.first
            let first = host.flatMap { host in layout.spaces.first { $0.id == host.id }?.folders.first }
            start = NewTabStart.like(shown: nil, otherwise: agent?.id, firstFolder: first)
        }
        if let last = lastStartedAgentHere, let shown = start, last.id != shown.agent {
            // On another Mac, in the same folder where it lists the path, else in General.
            let folders = layout.spaces.first { $0.id == last.id.host }?.folders ?? []
            start = last.id.host == shown.agent.host ? NewTabStart(agent: last.id, folder: shown.folder)
                : NewTabStart.moved(last, in: shown.folder, toAgents: [last], defaultAgent: last.id, folders: folders)
            agent = last
        }
        guard let start, let agent else { return }
        newThread(with: agent, in: choosesFolder(for: agent.id) ? start.folder : nil)
        if focusesComposer {
            chat?.screenRequest = .focusComposer
        } else if chat?.screenRequest == .focusComposer {
            // A kept draft brought back asks for the cursor itself (`showDraftTab`).
            chat?.screenRequest = nil
        }
    }

    /// The agent the last thread was started with, while its Mac is connected and lists it.
    private var lastStartedAgentHere: Agent? {
        guard let id = lastStartedAgent, let host = model(for: id.host), host.connection == .connected else { return nil }
        return host.agent(id)
    }

    /// The agent a new thread in one of `host`'s folders starts with, from the folder's own
    /// New thread or as the folder is added: the one the last thread was started with, or
    /// that Mac's agent of its name, else that Mac's default agent (`newTab`). nil for a
    /// Mac with no agent a thread in a folder can be with.
    func agentForNewThread(in host: HostID) -> Agent? {
        let agents = agentsForFolder(on: host)
        if let last = lastStartedAgent, let same = agents.first(where: { $0.id == last }) ?? agents.first(where: { $0.id.name == last.name }) {
            return same
        }
        let preferred = model(for: host)?.defaultAgent
        return agents.first { $0.id == preferred?.id } ?? agents.first
    }

    /// A new thread's first message was sent: the next new thread starts with its agent.
    func newThreadSent(_ controller: ThreadController) {
        lastStartedAgent = controller.agent.id
    }

    /// The new thread on screen, not sent yet, with another agent or in another folder,
    /// chosen on its own screen (`NewThreadPickers`): a new one in its place, which takes
    /// what was typed in it, the composer's cursor too. A folder is kept only for an agent
    /// that is asked for one.
    func remakeNewThread(with agent: Agent, in folder: Folder?) {
        guard let shown = chat, shown.thread == nil, shown.isEmpty else { return }
        let typed = shown.composer
        closedNewThread = shown
        newThread(with: agent, in: choosesFolder(for: agent.id) ? folder : nil)
        closedNewThread = nil
        guard let made = chat, made !== shown else { return }
        // Moved, not copied: the words are not kept for the next new thread with the
        // agent and folder left. Where some were kept for the new one, both stay.
        if !typed.isEmpty, made.composer.isEmpty {
            shown.composer = ComposerDraft()
            made.composer = typed
        }
        made.screenRequest = .focusComposer
    }

    /// The Macs a new thread can be started on, which the Mac chip under its question
    /// offers (`NewThreadPickers`): every Mac with an agent, in the Macs' order, by the
    /// names their tabs over the sidebar's space show (`MacTabs`).
    var macsForNewThread: [HostModel] {
        hosts.filter { !$0.agents.isEmpty }
    }

    /// The new thread on screen, not sent yet, taken to another Mac, chosen with the Mac
    /// chip on its own screen (`NewThreadPickers`; 2026-10-24: "tabs mac but add a
    /// dropdown to pic device"): with that Mac's agent of the same name, or else its
    /// default agent, in the same folder where its space lists that path, or else in its
    /// General folder (`NewTabStart.moved`). What was typed goes along, as to another agent
    /// or folder (`remakeNewThread(with:in:)`).
    func remakeNewThread(on host: HostID) {
        guard let shown = chat, shown.thread == nil, shown.isEmpty, shown.agent.id.host != host,
              let target = model(for: host) else { return }
        let folders = layout.spaces.first { $0.id == host }?.folders ?? []
        guard let start = NewTabStart.moved(
            shown.agent, in: shown.folder, toAgents: agentsForFolder(on: host), defaultAgent: target.defaultAgent?.id,
            folders: folders
        ), let agent = target.agent(start.agent) else { return }
        remakeNewThread(with: agent, in: start.folder)
    }

    /// The folder a thread works in, for a new thread to start there too: nil for one
    /// with no folder, or in its host's General folder, where a new thread starts anyway.
    private func folder(of key: ThreadKey) -> Folder? {
        guard let host = model(for: key.host), host.offersFolders, let record = host.record(for: key.id) else { return nil }
        return Folder.workedIn(by: record, general: host.host.generalFolder)
    }

    /// A row's × under Finished or Recent, or its swipe: dismissed on every device, on a host that keeps
    /// the recent threads for them, and otherwise on this one, with an unread result
    /// acknowledged as before. Its open tab and conversation stay in place.
    func closeOrDismiss(_ record: ThreadRecord) {
        model(for: record.key.host)?.setRecent(false, for: record.id)
        changeRecent { $0.dismiss(record.key) }
        if record.isUnseen { model(for: record.key.host)?.dismiss(record.id) }
    }

    /// Only looked at, an archived thread stays out of Recent. Written in, it is used
    /// (`threadUsed`), and something new brings it out of the archive. Nor does one older
    /// than all its host keeps get a mark that would only be taken off again, on every portal
    /// (`RecentThreads.pastKept`): it would not show at any number. A use moves it up.
    private func rememberRecentIfShown(_ key: ThreadKey) {
        guard chat?.thread?.key == key else { return }
        if let host = model(for: key.host), let record = host.record(for: key.id) {
            guard !record.isArchived else { return }
            let wouldPass = host.recentIsCurrent && layout.top.markWouldPassKept(record) { host.record(for: $0.id)?.updatedAt }
            guard !wouldPass else { return }
        }
        rememberRecent(key)
    }

    /// The thread was used: under Recent on every device, on a host that keeps them for
    /// them (one under the thread that started it stays out, as `SidebarGroups.build`
    /// leaves it out), and otherwise on this one, which sends it up once the host
    /// lists it (a new thread's first message, whose thread is not in the list yet).
    private func rememberRecent(_ key: ThreadKey) {
        if let host = model(for: key.host), let record = host.record(for: key.id), host.keepsRecent(of: record) {
            if !isTucked(record) { host.setRecent(true, for: record.id) }
            return
        }
        changeRecent { $0.open(key) }
    }

    /// What this device holds as recent of a host's threads (`RecentThreads`).
    func heldRecent(on host: HostID) -> Set<ThreadRef.ID> {
        Set(recent.keys.lazy.filter { $0.host == host }.map(\.id))
    }

    /// The host has these as recent from now on (`HostSync.recentCarried`).
    func recentCarried(_ threads: Set<ThreadRef.ID>, on host: HostID) {
        changeRecent { $0.remove { $0.host == host && threads.contains($0.id) } }
    }

    /// The host no longer keeps these for every device (`HostSync.recentReturned`).
    func recentReturned(_ threads: Set<ThreadRef.ID>, on host: HostID) {
        changeRecent { recent in
            for thread in threads { recent.open(ThreadKey(host: host, id: thread)) }
        }
    }

    /// Takes the recent mark off threads past what every device keeps of this host, whose
    /// step just found its list as it stands (`RecentThreads.pastKept`). After a step that
    /// merged a list, the only way a host's marks or times change here: nothing is worked out
    /// as the sidebar is drawn or scrolled. Only this host: what is held of another may have
    /// moved since its last step, and that host's next step sees to it.
    func expireRecentMarks(on host: HostModel) {
        let past = RecentThreads.pastKept(layout.top.marked, of: host.id)
        if !past.isEmpty { host.expireRecent(past.map(\.id)) }
    }

    /// A local message or explicitly adopted conversation remembers its thread, even
    /// if delivery was deferred and another tab has since been selected. Passive saves
    /// and restoring an open tab do not restore a dismissed entry.
    func threadUsed(_ controller: ThreadController) {
        guard let key = controller.thread?.key else { return }
        rememberRecent(key)
    }

    private func changeRecent(_ change: (inout RecentThreads) -> Void) {
        // Remove expired entries before the next action, even if the sidebar has not
        // rendered since the last one. Dismissing a row must not uncover a key past the
        // twenty-five kept of its host. It does bring on the next of those kept, on a device
        // showing fewer, or of another host's: that one was only not shown here. So can a
        // host's mark past them, as long as it is not taken off yet (`RecentThreads.pastKept`).
        var changed = layout.top.history
        change(&changed)
        guard changed != recent else { return }
        recent = changed
        saveTabsSoon()
    }

    /// Called after a sidebar layout changes, and before saving in the background.
    /// Compute from the latest list so an older render never overwrites a new opening.
    func reconcileRecentHistory() {
        let kept = layout.top.history
        changeRecent { $0 = kept }
    }

    /// The new thread kept with what was typed in it (`draftTab`), its tab chosen: on
    /// screen again, as it was left.
    func showDraftTab() {
        guard let draftTab else { return }
        guard !draftTab.isClosed else {
            self.draftTab = nil
            return
        }
        show(draftTab)
        draftTab.screenRequest = .focusComposer
    }

    /// The new thread kept with what was typed in it, its tab closed: let go of. Its words
    /// stay for the next new thread with its agent and folder, as a new thread's closed on
    /// screen do (`ComposerDrafts`).
    func closeDraftTab() {
        draftTab?.close()
        draftTab = nil
    }

    /// Whether `controller` is a new thread whose first message was sent (it is not
    /// unused), which its host has not made yet, or made and not listed yet: it is a tab
    /// once it is saved.
    private func isOnItsWay(_ controller: ThreadController) -> Bool {
        guard let thread = controller.thread else { return true }
        return controller.startedHere && model(of: controller)?.record(for: thread.id) == nil
    }

    /// A thread was saved (`HostModel.persist`). On screen, a new thread saved for the
    /// first time, its first message sent, is a tab from now on: the one on screen while
    /// no tab is (`show`). Not a tab closed and still on screen while the one beside it is
    /// read, which is the one on screen then. Off screen, a new thread taken off it while
    /// its first message was on its way is a tab once it is made, behind the one on screen.
    func threadSaved(_ key: ThreadKey, by controller: ThreadController) {
        let wasOnItsWay = tabsOnTheirWay.contains { $0.controller === controller }
        tabsOnTheirWay.removeAll { $0.controller == nil || $0.controller === controller }
        if chat === controller {
            // A new thread on screen has a row from now on.
            noteCurrent()
            guard tabs.lastSelected == nil, chat?.thread?.key == key else { return }
            rememberRecent(key)
            tabBeforeNewThread = nil
            changeTabs { $0.open(key) }
        } else if wasOnItsWay {
            rememberRecent(key)
            changeTabs { $0.open(key, selecting: false) }
        }
    }

    /// The thread on screen was asked for again (`HostModel.open`): it is the tab on
    /// screen, also when its tab was closed while the one to show in its place was being
    /// read, which asking for it again called off.
    func shownAgain(_ key: ThreadKey) {
        guard chat?.thread?.key == key else { return }
        tabBeforeNewThread = nil
        changeTabs { $0.open(key) }
    }

    /// A thread gone from its host's list, or on its way off it (removed here or on
    /// another device), is no tab any more. On screen, it gives way to the tab beside it
    /// that can be shown, at once: true when there is none, for the host to show a new
    /// thread instead. Off screen, it is not put there after all.
    func threadGone(_ key: ThreadKey) -> Bool {
        changeRecent { $0.dismiss(key) }
        let isShown = chat?.thread?.key == key
        let inPlace = tabs.inPlace(of: key)
        changeTabs { $0.close(key) }
        guard isShown else {
            callOffReading(key, inPlace: inPlace)
            return false
        }
        return !showFirstTab(of: inPlace, readingNow: true)
    }

    /// Opens the tab that was on screen when the app was last left, at once, if its
    /// thread is still listed: the app comes back to it after a relaunch, with the other
    /// tabs as they were, which are only keys until one is shown. Tabs whose thread is
    /// gone meanwhile are closed. Not for a launch with development switches that act on
    /// the screen, which mean a new thread (`DebugLaunch.opensWithNewThread`).
    private func reopenLastTab() {
        let listed = Set(allThreads.map(\.key))
        changeTabs { tabs in tabs.remove { !listed.contains($0) } }
        guard chat == nil, !DebugLaunch.opensWithNewThread else { return }
        showTab(tabs.lastSelected, readingNow: true, remember: false)
    }

    private static let tabsKey = "tabs.open"
    private static let recentKey = "sidebar.recent"

    private static func loadTabs() -> OpenTabs {
        // A scratch copy of the app keeps no settings between launches (its scratch home's
        // are not written): the tabs bench gives a file to keep them in instead.
        let kept = DebugLaunch.tabsFile.flatMap { FileManager.default.contents(atPath: $0) }
        guard let data = kept ?? UserDefaults.standard.data(forKey: tabsKey),
              let tabs = try? JSONDecoder().decode(OpenTabs.self, from: data) else { return OpenTabs() }
        return tabs
    }

    /// The tabs are saved a moment after they change, once for changes close together: a
    /// switch puts its chat on screen first (the save took a millisecond of it). At once as
    /// the app goes inactive or to the background (`saveAll`, `enterBackground`) and as it
    /// is quit; a crash within that moment brings back the tab before.
    @ObservationIgnored private var tabsSave: Task<Void, Never>?
    /// The fleet whose tabs are saved as the app is quit (`quitting`).
    private static weak var savingTabs: Fleet?

    private func saveTabsSoon() {
        guard !isDemo else { return }
        tabsSave?.cancel()
        Self.savingTabs = self
        tabsSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            self?.saveTabs()
        }
    }

    /// Saves the tabs now, should a save be waiting.
    private func saveTabsNow() {
        guard tabsSave != nil else { return }
        saveTabs()
    }

    private func saveTabs() {
        tabsSave?.cancel()
        tabsSave = nil
        let kept = layout.top.history
        if recent != kept { recent = kept }
        guard let data = try? JSONEncoder().encode(tabs) else { return }
        UserDefaults.standard.set(data, forKey: Self.tabsKey)
        if let history = try? JSONEncoder().encode(recent) {
            UserDefaults.standard.set(history, forKey: Self.recentKey)
        }
        if let path = DebugLaunch.tabsFile { try? data.write(to: URL(fileURLWithPath: path), options: .atomic) }
    }

    // MARK: Notifications

    /// Tells every connected host where to send notifications, for when the device's
    /// address arrives or changes.
    func registerForPush() {
        hosts.forEach { $0.registerForPush() }
    }

    // MARK: The demo

    /// The demo's tour begins once its host has listed its agents (`Demo`): its message is
    /// sent in the tour's thread, on screen, and the thread under it for Codex's reviews is
    /// followed off screen, so that the review the tour asks for shows at work at the foot
    /// of the chat.
    private func startTour() {
        guard !hasStartedTour, let chat, chat.thread?.id == FakeBackend.demoTourID, let host = model(of: chat) else { return }
        hasStartedTour = true
        chat.send(FakeBackend.demoTourPrompt)
        if let review = host.record(for: FakeBackend.demoReviewID) { host.follow(review) }
    }

    /// The demo ended: its host stops, with its threads. What it saved is in its scratch
    /// folder, which `Demo.end` removes.
    func endDemo() {
        guard isDemo else { return }
        draftTab?.close()
        draftTab = nil
        chat?.close()
        chat = nil
        hosts.forEach { $0.shutDown() }
        hosts = []
    }

    // MARK: Development

    /// What the development switches ask for, once: when every host has had its first
    /// try at connecting, the host of the thread on screen has listed its agents, and
    /// the agent the switches name has been found (or every host has listed).
    private func runDebugLaunchIfReady() {
        guard !didRunDebugLaunch, hasStarted, let chat, model(of: chat)?.hasListedAgents == true,
              DebugLaunch.agentName == nil || hasFoundDebugAgent || hosts.allSatisfy(\.hasListedAgents),
              DebugLaunch.folderName == nil || hasOpenedDebugFolder || !hasFoundDebugAgent else { return }
        didRunDebugLaunch = true
        runDebugScript()
    }

    // MARK: The thread left on screen

    /// Kept while the app is away only (`LeftOnScreenNote`).
    private static let leftOnScreen = LeftOnScreenNote()
    /// What the launch found there, read once for the whole run of the app (which has one
    /// fleet, `RootView.fleetForTheRun`).
    private static let leftAtLaunch = leftOnScreen.takeAtLaunch()

    /// The thread on screen as the app goes to the background: the one it opens with
    /// should the system end it there (`reopenThreadLeftOnScreen`). None for a new thread.
    private func noteThreadLeftOnScreen() {
        guard !isDemo else { return }
        Self.leftOnScreen.wentAway(with: chat?.thread.map { LeftOnScreen(host: $0.agent.host, thread: $0.id) })
    }

    /// The app was quit, on a Mac or from the front: it opens as it always did, with a
    /// new thread.
    static func quitting() {
        savingTabs?.saveTabsNow()
        leftOnScreen.forget()
    }

    /// Opens the thread that was on screen when the app last went to the background, if
    /// it was ended there (not back in front or quit since) and the thread is still
    /// listed: the app ended by the system while away comes back to what was left.
    private func reopenThreadLeftOnScreen() {
        guard !isDemo, let left = Self.leftAtLaunch, chat == nil,
              let record = left.record(in: allThreads) else { return }
        // At once: the thread the app starts with is chosen right after this.
        model(for: record.key.host)?.open(record, readingNow: true)
    }

    // MARK: Sidebar state

    /// The Mac whose space shows: the one chosen last while it is still a host here, else
    /// the first.
    var spaceOnScreen: HostID? {
        if let shownSpace, hosts.contains(where: { $0.id == shownSpace }) { return shownSpace }
        return hosts.first?.id
    }

    /// Shows a Mac's space in the sidebar: from its tab, ⌘⌥← and →, or Show in Its Folder.
    func showSpace(_ host: HostID) {
        guard spaceOnScreen != host else { return }
        shownSpace = host
    }

    /// ⌘⌥→ and ⌘⌥←: the next Mac's space (1), or the one before (-1); none past either
    /// end.
    func stepSpace(by step: Int) {
        guard let shown = spaceOnScreen, let index = hosts.firstIndex(where: { $0.id == shown }),
              hosts.indices.contains(index + step) else { return }
        shownSpace = hosts[index + step].id
    }

    private static let shownSpaceKey = "sidebar.space"
    private static let foldedProjectsKey = "sidebar.foldedFolders"
    private static let foldersByLastUseKey = "sidebar.foldersByLastUse"
    private static let foldersFirstSeenKey = "sidebar.foldersFirstSeen"

    private static func loadFoldedProjects() -> Set<SidebarProject.ID> {
        guard let data = UserDefaults.standard.data(forKey: foldedProjectsKey),
              let ids = try? JSONDecoder().decode([SidebarProject.ID].self, from: data) else { return [] }
        return Set(ids)
    }

    private func saveFoldedProjects() {
        guard !isDemo, let data = try? JSONEncoder().encode(Array(foldedProjects)) else { return }
        UserDefaults.standard.set(data, forKey: Self.foldedProjectsKey)
    }

    private static func loadFoldersFirstSeen() -> [SidebarProject.ID: Date] {
        guard let data = UserDefaults.standard.data(forKey: foldersFirstSeenKey),
              let seen = try? JSONDecoder().decode([SidebarProject.ID: Date].self, from: data) else { return [:] }
        return seen
    }

    private func saveFoldersFirstSeen() {
        savedFirstSeen = layoutCache.firstSeen
        guard !isDemo, let data = try? JSONEncoder().encode(savedFirstSeen) else { return }
        UserDefaults.standard.set(data, forKey: Self.foldersFirstSeenKey)
    }
}

/// A thread held without keeping it (`Fleet.tabsOnTheirWay`).
private struct HeldWeakly {
    weak var controller: ThreadController?
}

/// Which thread the sidebar's rows mark as on screen (`Fleet.currentRows`): a flag for each
/// thread a row was drawn for, which its rows read, so that a switch changes two flags and
/// draws again the rows reading them alone.
final class CurrentRows {
    /// Whether a thread is the one on screen, as its rows read it.
    @Observable final class Flag {
        fileprivate(set) var isCurrent = false
    }

    /// The thread on screen.
    private(set) var key: ThreadKey?
    /// One flag a thread, kept for as long as the app runs: a few bytes each.
    private var flags: [ThreadKey: Flag] = [:]

    /// The flag of `key`'s rows.
    func flag(for key: ThreadKey) -> Flag {
        if let flag = flags[key] { return flag }
        let flag = Flag()
        flag.isCurrent = key == self.key
        flags[key] = flag
        return flag
    }

    /// `key` is on screen now.
    func show(_ key: ThreadKey?) {
        guard key != self.key else { return }
        if let old = self.key { flags[old]?.isCurrent = false }
        self.key = key
        if let key { flags[key]?.isCurrent = true }
    }
}
