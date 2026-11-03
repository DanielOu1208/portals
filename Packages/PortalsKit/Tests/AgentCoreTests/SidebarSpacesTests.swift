import Foundation
import Testing
@testable import AgentCore

/// The sidebar as redesigned on 2026-10-23: Needs you, Running and Recent on top across
/// every Mac (`SidebarGroups`), in the order their threads last ran, each thread once; and
/// below, a space per Mac (`SidebarSpace`) with its bots, its folders and what it archived.
@Suite struct SidebarSpacesTests {
    private static let mac = HostID(rawValue: "mac")
    private static let mini = HostID(rawValue: "mini")
    private static let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private static let general = "/Users/dev/.portals/general"
    private static let portals = "/Users/dev/coding_projects/Portals"
    private static let notes = "/Users/dev/notes"

    private static let hosts = [
        HostConfig(id: mac, name: "MBP16", url: URL(string: "http://127.0.0.1:9120")!, kind: .bridge, generalFolder: general),
        HostConfig(id: mini, name: "Mac mini", url: URL(string: "http://127.0.0.1:9121")!, kind: .bridge, generalFolder: general),
    ]
    private static let agents = [
        Agent(id: Agent.ID(host: mac, name: "claude"), kind: "claude"),
        Agent(id: Agent.ID(host: mac, name: "codex"), kind: "codex"),
        Agent(id: Agent.ID(host: mac, name: "hanni"), kind: "hermes"),
        Agent(id: Agent.ID(host: mac, name: "aeri-helper"), kind: "hermes"),
        Agent(id: Agent.ID(host: mini, name: "claude"), kind: "claude"),
    ]

    private static func record(
        _ id: String, host: HostID = mac, agent: String = "claude", in folder: String? = portals, created: TimeInterval = 0,
        ran: TimeInterval = 0, pinned: Bool = false, archived: Bool = false, unseen: Bool = false, from parent: String? = nil,
        shared: Bool = false
    ) -> ThreadRecord {
        var record = ThreadRecord(
            ref: ThreadRef(
                id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: host, name: agent), createdAt: t0.addingTimeInterval(created),
                workingDirectory: folder
            ),
            updatedAt: t0.addingTimeInterval(ran), pinned: pinned, archived: archived
        )
        record.unseen = unseen ? true : nil
        if let parent { record.startedBy = ThreadStarter(name: "Claude Code", thread: ThreadRef.ID(rawValue: parent)) }
        record.shared = shared ? true : nil
        return record
    }

    private static func key(_ id: String, host: HostID = mac) -> ThreadKey {
        ThreadKey(host: host, id: ThreadRef.ID(rawValue: id))
    }

    private static func ids(_ threads: [ThreadRecord]) -> [String] {
        threads.map(\.id.rawValue)
    }

    private static func layout(
        _ threads: [ThreadRecord], waiting: Set<ThreadKey> = [], running: Set<ThreadKey> = [], recent: Set<ThreadKey> = [],
        folders: [HostID: [Folder]] = [:], order: [HostID: SidebarOrder] = [:],
        nesting: Set<HostID> = []
    ) -> SidebarLayout {
        SidebarLayout.build(
            hosts: hosts, agents: agents, threads: threads, waiting: waiting, running: running, withFolders: [mac, mini],
            folders: folders, order: order, nesting: nesting, recent: RecentThreads(keys: recent)
        )
    }

    // MARK: The groups on top

    @Test func eachGroupIsInTheOrderItsThreadsLastRanAndEachThreadIsInOne() {
        let threads = [
            Self.record("old-wait", ran: 10),
            Self.record("new-wait", host: Self.mini, ran: 90),
            Self.record("run-a", ran: 50),
            Self.record("run-b", host: Self.mini, ran: 70),
            // Waiting and running at once (a question in a turn): in Needs you alone.
            Self.record("both", ran: 60),
            // A visited thread that is running: in Running, not in Recent too.
            Self.record("tab-running", ran: 40),
            Self.record("tab-old", ran: 5),
            Self.record("tab-new", ran: 80),
            Self.record("idle", ran: 100),
        ]
        let groups = Self.layout(
            threads,
            waiting: [Self.key("old-wait"), Self.key("new-wait", host: Self.mini), Self.key("both")],
            running: [Self.key("run-a"), Self.key("run-b", host: Self.mini), Self.key("both"), Self.key("tab-running")],
            recent: [Self.key("tab-running"), Self.key("tab-old"), Self.key("tab-new")]
        ).top
        #expect(Self.ids(groups.waiting) == ["new-wait", "both", "old-wait"])
        #expect(Self.ids(groups.running) == ["run-b", "run-a", "tab-running"])
        // Visited threads in the order they last ran, not the order they were opened.
        #expect(Self.ids(groups.recent) == ["tab-new", "tab-old"])
        #expect(groups.count == 8)
        // A thread at rest that is no tab and was seen is not on top.
        let all = groups.waiting + groups.running + groups.finished + groups.recent
        #expect(!all.contains { $0.id.rawValue == "idle" })
        #expect(Set(all.map(\.key)).count == all.count)
    }

    /// Going through the tabs, or opening a thread, moves nothing: only a turn does.
    @Test func whichTabIsOnScreenChangesNothing() {
        var threads = [Self.record("a", ran: 10), Self.record("b", ran: 20), Self.record("c", ran: 30)]
        let keys: Set<ThreadKey> = [Self.key("a"), Self.key("b"), Self.key("c")]
        #expect(Self.ids(Self.layout(threads, recent: keys).top.recent) == ["c", "b", "a"])
        // A turn starts in a: up it goes, to Running; and when it ends, on top of Recent.
        threads[0].updatedAt = Self.t0.addingTimeInterval(40)
        #expect(Self.ids(Self.layout(threads, running: [Self.key("a")], recent: keys).top.recent) == ["c", "b"])
        #expect(Self.ids(Self.layout(threads, recent: keys).top.recent) == ["a", "c", "b"])
    }

    /// Threads that ended out of sight are under Finished with their dot until opened or
    /// dismissed, apart from read history; a visited thread that ended out of sight is with them.
    @Test func whatEndedOutOfSightIsUnderFinished() {
        let threads = [
            Self.record("tab-seen", ran: 90),
            Self.record("tab-unseen", ran: 20, unseen: true),
            Self.record("ended-old", host: Self.mini, ran: 10, unseen: true),
            Self.record("ended-new", ran: 50, unseen: true),
            // Archived, then a turn ended in it out of sight: there as well.
            Self.record("ended-archived", ran: 30, archived: true, unseen: true),
        ]
        let keys: Set<ThreadKey> = [Self.key("tab-seen"), Self.key("tab-unseen")]
        let top = Self.layout(threads, recent: keys).top
        #expect(Self.ids(top.finished) == ["ended-new", "ended-archived", "tab-unseen", "ended-old"])
        #expect(Self.ids(top.recent) == ["tab-seen"])

        // Without local history, every unread result is still listed.
        let apart = Self.layout(threads).top
        #expect(Self.ids(apart.finished) == ["ended-new", "ended-archived", "tab-unseen", "ended-old"])
        #expect(Self.ids(apart.recent).isEmpty)
    }

    /// A thread an agent started that is under the thread that started it is on top
    /// only while it waits on you, open as a tab here or not: opened from the foot of its
    /// starter's chat, it is a tab, and stays out of Running and Recent (2026-10-27: "if we click on a managed thread but not on open in sidebar it shouldnt
    /// stay in the running view on the sidebar").
    @Test func aThreadUnderItsStarterIsOnTopOnlyWhenItWaits() {
        let threads = [
            Self.record("parent", ran: 10),
            Self.record("asks", ran: 20, from: "parent"),
            Self.record("works", ran: 30, from: "parent"),
            Self.record("ended", ran: 40, unseen: true, from: "parent"),
            Self.record("opened", ran: 50, from: "parent"),
            Self.record("openedWorks", ran: 60, from: "parent"),
            Self.record("openedEnded", ran: 70, unseen: true, from: "parent"),
            Self.record("openedAsks", ran: 80, from: "parent"),
        ]
        let keys: Set<ThreadKey> = [Self.key("opened"), Self.key("openedWorks"), Self.key("openedEnded"), Self.key("openedAsks")]
        let layout = Self.layout(
            threads, waiting: [Self.key("asks"), Self.key("openedAsks")], running: [Self.key("works"), Self.key("openedWorks")],
            recent: keys, nesting: [Self.mac]
        )
        #expect(Self.ids(layout.top.waiting) == ["openedAsks", "asks"])
        #expect(layout.top.running.isEmpty)
        #expect(layout.top.finished.isEmpty)
        #expect(layout.top.recent.isEmpty)
        // And in no folder below.
        #expect(Self.ids(layout.spaces[0].folders.flatMap(\.threads)) == ["parent"])
        // An opened nested thread remains tucked.
        let apart = Self.layout(threads, running: [Self.key("openedWorks")], recent: keys, nesting: [Self.mac])
        #expect(apart.top.isEmpty)
    }

    /// Show in sidebar puts one in Running and Recent as any thread, a tab or not.
    @Test func aThreadUnderItsStarterShownInTheSidebarIsOnTopAsAnyOther() {
        let threads = [
            Self.record("parent", ran: 10),
            Self.record("works", ran: 20, from: "parent", shared: true),
            Self.record("opened", ran: 30, from: "parent", shared: true),
        ]
        let layout = Self.layout(threads, running: [Self.key("works")], recent: [Self.key("opened")], nesting: [Self.mac])
        #expect(Self.ids(layout.top.running) == ["works"])
        #expect(Self.ids(layout.top.recent) == ["opened"])
    }

    @Test func theGroupsAloneAreWorkedOutTheSameWay() {
        let threads = [Self.record("a", ran: 10, unseen: true), Self.record("b", ran: 20), Self.record("c", ran: 30)]
        let groups = SidebarGroups.build(threads: threads, recent: RecentThreads(keys: [Self.key("b")]), waiting: [Self.key("c")], running: [])
        #expect(Self.ids(groups.waiting) == ["c"])
        #expect(Self.ids(groups.finished) == ["a"])
        #expect(Self.ids(groups.recent) == ["b"])
        #expect(groups == Self.layout(threads, waiting: [Self.key("c")], recent: [Self.key("b")]).top)
        #expect(SidebarGroups.build(threads: [], recent: RecentThreads(), waiting: [], running: []).isEmpty)
    }

    /// The groups are one list of lines, each with an identity no other line has: a
    /// recent thread keeps its row as Running comes in above it and leaves again, the
    /// title in each place keeps its own, and a thread going to another group is a new
    /// row there (seen on 2026-10-24: with a list per group, a recent row that went from
    /// the first place to the second was never drawn again).
    @Test func eachLineOfTheGroupsHasAnIdentityOfItsOwn() {
        let threads = [Self.record("ended", ran: 10), Self.record("tab", ran: 20)]
        let keys: Set<ThreadKey> = [Self.key("ended"), Self.key("tab")]
        func lines(running: Set<ThreadKey> = []) -> [SidebarGroups.Line] {
            Self.layout(threads, running: running, recent: keys).top.lines
        }
        let before = lines()
        let after = lines(running: [Self.key("tab")])
        #expect(before.map(\.id) == ["title|0", "recent|mac|tab", "recent|mac|ended"])
        #expect(after.map(\.id) == ["title|0", "running|mac|tab", "title|1", "recent|mac|ended"])
        #expect(after[0] == .title(.running, place: 0))
        #expect(after[2] == .title(.recent, place: 1))
        for list in [before, after] {
            #expect(Set(list.map(\.id)).count == list.count)
        }
        #expect(lines(running: [Self.key("tab"), Self.key("ended")]).map(\.id) == ["title|0", "running|mac|tab", "running|mac|ended"])
        #expect(SidebarGroups().lines.isEmpty)
    }

    // MARK: The spaces

    @Test func aSpacePerMacInTheirOrder() {
        let layout = Self.layout([Self.record("a"), Self.record("b", host: Self.mini)])
        #expect(layout.spaces.map(\.id) == [Self.mac, Self.mini])
        #expect(Self.ids(layout.spaces[1].folders.flatMap(\.threads)) == ["b"])
        #expect(layout.spaces[1].bots.isEmpty)
    }

    /// A folder lists its pinned threads first, then the one created last first: a turn
    /// that starts or ends in one moves nothing there.
    @Test func aFolderListsPinsFirstThenTheNewestCreated() {
        let threads = [
            Self.record("old-busy", created: 10, ran: 100),
            Self.record("newest", created: 50, ran: 20),
            Self.record("pinned-old", created: 5, ran: 1, pinned: true),
            Self.record("middle", created: 30, ran: 60),
            Self.record("put-away", created: 60, ran: 70, archived: true),
        ]
        let space = Self.layout(threads, running: [Self.key("old-busy")]).spaces[0]
        #expect(space.folders.map(\.name) == ["Portals"])
        #expect(Self.ids(space.folders[0].threads) == ["pinned-old", "newest", "middle", "old-busy"])
        #expect(Self.ids(space.archived) == ["put-away"])
    }

    /// The bots (Hermes profiles) in the order the user gave them, each with its threads,
    /// the one that last ran first; a bot's thread in the General folder is the bot's
    /// alone, a coding agent's is in No project, last of the folders.
    @Test func botsApartAndNoProjectLast() {
        let threads = [
            Self.record("hanni-old", agent: "hanni", in: Self.general, created: 50, ran: 10),
            Self.record("hanni-new", agent: "hanni", in: Self.general, created: 10, ran: 40),
            // A bot's thread started in a folder on purpose: in it as well.
            Self.record("hanni-notes", agent: "hanni", in: Self.notes, created: 20, ran: 30),
            Self.record("claude-general", in: Self.general, created: 30, ran: 90),
            // One saved before folders were kept: in No project too.
            Self.record("codex-nowhere", agent: "codex", in: nil, created: 40, ran: 5),
            Self.record("claude-portals", created: 1, ran: 20),
        ]
        let order = [Self.mac: SidebarOrder(agents: ["aeri-helper", "hanni"])]
        let space = Self.layout(threads, order: order).spaces[0]
        #expect(space.bots.map(\.agent.id.name) == ["aeri-helper", "hanni"])
        #expect(space.bots[0].threads.isEmpty)
        #expect(Self.ids(space.bots[1].threads) == ["hanni-new", "hanni-notes", "hanni-old"])
        #expect(space.folders.map(\.name) == ["notes", "Portals", Folder.generalName])
        #expect(space.folders.last?.isGeneral == true)
        #expect(Self.ids(space.folders[0].threads) == ["hanni-notes"])
        #expect(Self.ids(space.folders[2].threads) == ["codex-nowhere", "claude-general"])
    }

    /// A folder the user added is there with no thread in it yet, and the order the user
    /// gave the folders is kept.
    @Test func addedFoldersAndTheUsersOrder() {
        let threads = [Self.record("a", ran: 10)]
        let folders = [Self.mac: [Folder(path: Self.notes, lastUsed: Self.t0.addingTimeInterval(50), isAdded: true)]]
        let space = Self.layout(threads, folders: folders).spaces[0]
        #expect(space.folders.map(\.name) == ["notes", "Portals"])
        #expect(space.folders[0].isOnlyAdded)
        let arranged = Self.layout(threads, folders: folders, order: [Self.mac: SidebarOrder(folders: [Self.portals, Self.notes])]).spaces[0]
        #expect(arranged.folders.map(\.name) == ["Portals", "notes"])
    }

    /// A folder stays where it is as work starts and ends in it, and as threads are
    /// started there: the ones the user placed first, in that order, then the others from
    /// the one first seen last; by last use only where the user asked for it.
    @Test func foldersStayPutAsWorkStartsInThem() {
        let site = "/Users/dev/site"
        var threads = [
            Self.record("portals", in: Self.portals, created: 10, ran: 10),
            Self.record("notes", in: Self.notes, created: 20, ran: 20),
            Self.record("site", in: site, created: 30, ran: 30),
            Self.record("general", in: Self.general, created: 40, ran: 40),
        ]
        func names(order: SidebarOrder? = nil, byLastUse: Bool = false) -> [String] {
            SidebarLayout.build(
                hosts: Self.hosts, agents: Self.agents, threads: threads, waiting: [], running: [], withFolders: [Self.mac],
                order: order.map { [Self.mac: $0] } ?? [:], foldersByLastUse: byLastUse ? [Self.mac] : []
            ).spaces[0].folders.map(\.name)
        }
        let kept = ["site", "notes", "Portals", Folder.generalName]
        #expect(names() == kept)
        // A turn in Portals, then a new thread there: nothing moves.
        threads[0].updatedAt = Self.t0.addingTimeInterval(100)
        threads.append(Self.record("portals-new", in: Self.portals, created: 200, ran: 200))
        #expect(names() == kept)
        // A thread of notes that began before Portals' first, from another device: notes
        // was first seen before Portals.
        threads.append(Self.record("notes-old", in: Self.notes, created: 5, ran: 150))
        #expect(names() == ["site", "Portals", "notes", Folder.generalName])
        threads.removeLast()
        // Archived, its first thread still says when the folder was first seen.
        threads[1].archived = true
        threads.append(Self.record("notes-later", in: Self.notes, created: 300, ran: 300))
        #expect(names() == kept)
        // The user's order first, a folder not in it after them.
        #expect(names(order: SidebarOrder(folders: [Self.portals, Self.notes])) == ["Portals", "notes", "site", Folder.generalName])
        // By last use, where the user asked for it, whatever their order.
        #expect(names(order: SidebarOrder(folders: [Self.notes, site]), byLastUse: true) == ["notes", "Portals", "site", Folder.generalName])
    }

    /// A folder added with no thread keeps its place as its first thread starts, later
    /// than the folder was added, and also once its host says it was used since: a host
    /// says when a folder was last used, not when it was added, so the date first seen is
    /// kept, between launches too (`SidebarLayoutCache.firstSeen`).
    @Test func anAddedFolderKeepsItsPlaceAsItsFirstThreadStarts() {
        let site = "/Users/dev/site"
        func added(_ path: String, at seconds: TimeInterval) -> Folder {
            Folder(path: path, lastUsed: Self.t0.addingTimeInterval(seconds), isAdded: true)
        }
        func names(_ layout: SidebarLayout) -> [String] {
            layout.spaces[0].folders.map(\.name)
        }
        let inputs = Self.inputs
        let asAdded = [added(Self.notes, at: 10), added(site, at: 20)]
        var cache = SidebarLayoutCache()
        #expect(names(cache.layout(for: inputs([], asAdded))) == ["site", "notes"])
        // notes' first thread starts: notes stays below site.
        let first = [Self.record("first", in: Self.notes, created: 30, ran: 30)]
        #expect(names(cache.layout(for: inputs(first, asAdded))) == ["site", "notes"])
        // Its host says now that notes was used at 40: notes stays where it is.
        let used = [added(Self.notes, at: 40), added(site, at: 20)]
        #expect(names(cache.layout(for: inputs(first, used))) == ["site", "notes"])
        // After a relaunch with the dates kept, before the host's folders are listed and
        // after, too.
        var relaunched = SidebarLayoutCache(firstSeen: cache.firstSeen)
        #expect(names(relaunched.layout(for: inputs(first, nil))) == ["notes"])
        #expect(names(relaunched.layout(for: inputs(first, used))) == ["site", "notes"])
        // With nothing kept, the host's later date would have put notes on top.
        var forgetful = SidebarLayoutCache()
        #expect(names(forgetful.layout(for: inputs(first, used))) == ["notes", "site"])
    }

    /// After a relaunch, a host saved as one that offers folders does so before it has
    /// listed them: the dates kept of its folders with no thread here are kept until it
    /// has, and not forgotten as if it listed none, so that a later date the host gives
    /// then moves no folder. A folder left out of a list the host gave is forgotten.
    @Test func theDatesKeptWaitForTheHostToListItsFolders() {
        let site = "/Users/dev/site"
        let notesID = SidebarProject.ID(host: Self.mac, path: Self.notes)
        let siteID = SidebarProject.ID(host: Self.mac, path: site)
        func added(_ path: String, at seconds: TimeInterval) -> Folder {
            Folder(path: path, lastUsed: Self.t0.addingTimeInterval(seconds), isAdded: true)
        }
        func names(_ layout: SidebarLayout) -> [String] {
            layout.spaces[0].folders.map(\.name)
        }
        var cache = SidebarLayoutCache()
        #expect(names(cache.layout(for: Self.inputs([], [added(Self.notes, at: 10), added(site, at: 20)]))) == ["site", "notes"])
        let saved = cache.firstSeen
        #expect(saved == [notesID: Self.t0.addingTimeInterval(10), siteID: Self.t0.addingTimeInterval(20)])
        // Relaunched with the dates saved: the host offers folders, not listed yet.
        var relaunched = SidebarLayoutCache(firstSeen: saved)
        #expect(names(relaunched.layout(for: Self.inputs([], nil))).isEmpty)
        #expect(relaunched.firstSeen == saved)
        // The list comes, notes used since site was added: nothing moves.
        let used = [added(Self.notes, at: 40), added(site, at: 20)]
        #expect(names(relaunched.layout(for: Self.inputs([], used))) == ["site", "notes"])
        #expect(relaunched.firstSeen == saved)
        // A list without notes, taken off the host's: its date is forgotten.
        #expect(names(relaunched.layout(for: Self.inputs([], [added(site, at: 20)]))) == ["site"])
        #expect(relaunched.firstSeen == [siteID: Self.t0.addingTimeInterval(20)])
    }

    /// What the cache is given for the MBP16's space alone, as a host that offers folders:
    /// `folders` is its list, nil before it has listed them.
    private static func inputs(_ threads: [ThreadRecord], _ folders: [Folder]?) -> SidebarLayoutCache.Inputs {
        SidebarLayoutCache.Inputs(hosts: hosts, agents: agents, threads: threads, waiting: [], running: [],
                                  withFolders: [mac], folders: folders.map { [mac: $0] } ?? [:])
    }

    /// A Mac whose agents work in no folders it offers (Hermes): its agents are all bots.
    @Test func aHostWithNoFoldersHasOnlyBots() {
        let hermes = HostID(rawValue: "hermes")
        let host = HostConfig(id: hermes, name: "Hermes", url: URL(string: "http://127.0.0.1:8642")!)
        let agents = [Agent(id: Agent.ID(host: hermes, name: "hanni")), Agent(id: Agent.ID(host: hermes, name: "dex"))]
        let threads = [Self.record("h1", host: hermes, agent: "hanni", in: nil, ran: 5), Self.record("h2", host: hermes, agent: "hanni", in: "/srv", ran: 9)]
        let layout = SidebarLayout.build(hosts: [host], agents: agents, threads: threads, waiting: [], running: [])
        #expect(layout.spaces[0].folders.isEmpty)
        #expect(layout.spaces[0].bots.map(\.agent.id.name) == ["hanni", "dex"])
        #expect(Self.ids(layout.spaces[0].bots[0].threads) == ["h2", "h1"])
    }

    // MARK: Worked out again

    @Test func theTabsAreAnInputOfTheCache() {
        let threads = [Self.record("a", ran: 10), Self.record("b", ran: 20)]
        func inputs(recent: Set<ThreadKey>) -> SidebarLayoutCache.Inputs {
            SidebarLayoutCache.Inputs(hosts: Self.hosts, agents: Self.agents, threads: threads, waiting: [], running: [],
                                      withFolders: [Self.mac, Self.mini], recent: RecentThreads(keys: recent))
        }
        var cache = SidebarLayoutCache()
        #expect(cache.layout(for: inputs(recent: [])).top.recent.isEmpty)
        #expect(Self.ids(cache.layout(for: inputs(recent: [Self.key("a")])).top.recent) == ["a"])
        #expect(cache.builds == 2)
        #expect(Self.ids(cache.layout(for: inputs(recent: [Self.key("a")])).top.recent) == ["a"])
        #expect(cache.builds == 2)
    }
}
