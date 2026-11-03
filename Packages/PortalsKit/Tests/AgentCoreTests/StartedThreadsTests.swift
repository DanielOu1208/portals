import Foundation
import Testing
@testable import AgentCore

/// Threads an agent started from another thread, on a host that lists them under it
/// (`StartedThreads`, a bridge's `agent_threads`): out of the sidebar but in Needs you
/// while one waits, under the thread that started them, and in the sidebar again once
/// someone shows one there (`shared`).
@Suite struct StartedThreadsTests {
    private static let mac = HostID(rawValue: "mac")
    private static let mini = HostID(rawValue: "mini")
    private static let t0 = Date(timeIntervalSince1970: 1_700_000_000)

    private static func record(
        _ id: String, host: HostID = mac, agent: String = "claude", from parent: String? = nil, starter: String = "Claude Code",
        shared: Bool = false, archived: Bool = false, unseen: Bool = false, folder: String? = nil, created: TimeInterval = 0,
        updated: TimeInterval = 0
    ) -> ThreadRecord {
        var record = ThreadRecord(
            ref: ThreadRef(
                id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: host, name: agent), createdAt: t0.addingTimeInterval(created),
                workingDirectory: folder
            ),
            updatedAt: t0.addingTimeInterval(updated), archived: archived
        )
        if let parent { record.startedBy = ThreadStarter(name: starter, thread: ThreadRef.ID(rawValue: parent)) }
        record.shared = shared ? true : nil
        record.unseen = unseen ? true : nil
        return record
    }

    private static func key(_ id: String, host: HostID = mac) -> ThreadKey {
        ThreadKey(host: host, id: ThreadRef.ID(rawValue: id))
    }

    private static let agents = [
        Agent(id: Agent.ID(host: mac, name: "claude"), isDefault: true),
        Agent(id: Agent.ID(host: mac, name: "codex")),
    ]
    private static let listedAgents = Set(agents.map(\.id))

    // MARK: Which threads are under another

    @Test func aThreadStartedFromAListedThreadIsUnderIt() {
        let threads = [
            Self.record("parent"),
            Self.record("review", agent: "codex", from: "parent"),
            // A grandchild is under its own parent, which is under the first.
            Self.record("deeper", from: "review"),
        ]
        let tucked = StartedThreads.tucked(threads, nesting: [Self.mac], listed: Self.listedAgents)
        #expect(tucked == [Self.key("review"), Self.key("deeper")])
    }

    @Test func aThreadNothingElseWouldShowStaysInTheSidebar() {
        let threads = [
            // Aeri's one conversation is not under any agent the sidebar lists.
            Self.record("aeri", agent: "aeri"),
            Self.record("fromAeri", from: "aeri", starter: "Aeri"),
            // Its starting thread is gone from the list.
            Self.record("orphan", from: "gone"),
            // Started from another Mac, or with the portals command in a terminal: no thread of the host.
            {
                var record = Self.record("farAway")
                record.startedBy = ThreadStarter(name: "Claude Code on mini")
                return record
            }(),
            // Shown in the sidebar too.
            Self.record("parent"),
            Self.record("shown", from: "parent", shared: true),
            // A thread naming itself names no other.
            Self.record("loop", from: "loop"),
        ]
        #expect(StartedThreads.tucked(threads, nesting: [Self.mac], listed: Self.listedAgents).isEmpty)
    }

    @Test func onlyAHostThatNestsThemListsThemUnderTheirThread() {
        let threads = [Self.record("parent"), Self.record("review", from: "parent")]
        #expect(StartedThreads.tucked(threads, nesting: [], listed: Self.listedAgents).isEmpty)
        #expect(StartedThreads.tucked(threads, nesting: [Self.mini], listed: Self.listedAgents).isEmpty)
        // The same ids on another host are another host's threads.
        let elsewhere = [Self.record("parent", host: Self.mini), Self.record("review", from: "parent")]
        #expect(StartedThreads.tucked(elsewhere, nesting: [Self.mac, Self.mini], listed: Self.listedAgents).isEmpty)
    }

    @Test func aThreadsStartedThreadsComeInTheOrderTheyWereStarted() {
        let threads = [
            Self.record("parent"),
            Self.record("second", from: "parent", created: 20, updated: 100),
            Self.record("first", from: "parent", created: 10, updated: 50),
            Self.record("someoneElses", from: "other", created: 5),
            Self.record("parent", host: Self.mini),
            Self.record("miniChild", host: Self.mini, from: "parent", created: 1),
        ]
        #expect(StartedThreads.started(from: Self.key("parent"), in: threads).map(\.id.rawValue) == ["first", "second"])
        #expect(StartedThreads.started(from: Self.key("parent", host: Self.mini), in: threads).map(\.id.rawValue) == ["miniChild"])
    }

    // MARK: The back button

    /// The back button over a started thread's chat opens the thread that started it,
    /// only while the app has that thread and can open it.
    @Test func aStartedThreadsParentIsTheThreadThatStartedItWhileItOpens() {
        let threads = [
            Self.record("parent"),
            Self.record("review", agent: "codex", from: "parent"),
            Self.record("plain"),
            Self.record("orphan", from: "gone"),
            Self.record("loop", from: "loop"),
            Self.record("parentOfAnAgentGone", agent: "aeri"),
            Self.record("fromAnAgentGone", from: "parentOfAnAgentGone"),
        ]
        let byKey = Dictionary(uniqueKeysWithValues: threads.map { ($0.key, $0) })
        func parent(of id: String) -> String? {
            StartedThreads.parent(of: byKey[Self.key(id)]!, find: { byKey[$0] }, opens: { Self.listedAgents.contains($0) })?.id.rawValue
        }
        #expect(parent(of: "review") == "parent")
        #expect(parent(of: "plain") == nil)
        #expect(parent(of: "orphan") == nil)
        #expect(parent(of: "loop") == nil)
        // Its agent gone from the host, which would not open it: no button that does nothing.
        #expect(parent(of: "fromAnAgentGone") == nil)
    }

    @Test func aThreadStartedFromAnotherMacsThreadGoesBackToItThere() {
        var child = Self.record("review", host: Self.mini, agent: "codex")
        child.startedBy = ThreadStarter(
            name: "Claude Code", from: MessageSender(agent: "claude", agentName: "Claude Code", thread: "parent", machine: "mbp", machineName: "MBP")
        )
        let parent = Self.record("parent")
        let found = StartedThreads.parent(
            of: child, machines: ["mbp": Self.mac], find: { $0 == parent.key ? parent : nil }, opens: { _ in true }
        )
        #expect(found?.key == parent.key)
        #expect(StartedThreads.parent(of: child, find: { $0 == parent.key ? parent : nil }, opens: { _ in true }) == nil)
    }

    // MARK: Running for the threads it started

    /// A thread that leaves the host's report has ended a turn out of sight, unless only
    /// threads it started kept it there, whose own turn had ended, and been told, before.
    @Test func aThreadKeptAtWorkOnlyByThreadsItStartedEndsNoTurnAsItLeaves() {
        let a = ThreadRef.ID(rawValue: "a"), parent = ThreadRef.ID(rawValue: "parent"), child = ThreadRef.ID(rawValue: "child")
        let earlier: [ThreadRef.ID: ThreadActivity] = [a: .running, parent: .running, child: .running]
        let now = ThreadActivityReport(threads: [:])
        #expect(Set(now.ended(since: earlier, withoutTurn: [parent])) == [a, child])
        // Still at work, it ended nothing.
        #expect(ThreadActivityReport(threads: [a: .running]).ended(since: earlier, withoutTurn: [parent]).sorted { $0.rawValue < $1.rawValue } == [child])
        // Kept at work by its own subagents after its turn, the same (2026-10-27: "yes fix that").
        #expect(now.ended(since: [a: .running], withoutTurn: [a]).isEmpty)
    }

    // MARK: The sidebar

    private static func layout(_ threads: [ThreadRecord], waiting: Set<ThreadKey> = [], running: Set<ThreadKey> = [], nesting: Set<HostID> = [mac]) -> SidebarLayout {
        SidebarLayout.build(
            hosts: [HostConfig(id: mac, name: "Mac", url: URL(string: "https://mac.example")!)], agents: agents, threads: threads,
            waiting: waiting, running: running, withFolders: [mac], nesting: nesting
        )
    }

    /// The threads on top, the ones in the spaces (under a bot or in a folder), newest
    /// first, and the archived ones.
    private static func everywhere(_ layout: SidebarLayout) -> (top: [String], spaces: [String], archived: [String]) {
        let top = (layout.top.waiting + layout.top.running + layout.top.finished + layout.top.recent).map(\.id.rawValue)
        let listed = layout.spaces.flatMap { $0.bots.flatMap(\.threads) + $0.folders.flatMap(\.threads) }
        let spaces = SidebarSections.newestFirst(Array(Dictionary(listed.map { ($0.key, $0) }, uniquingKeysWith: { one, _ in one }).values))
        return (top, spaces.map(\.id.rawValue), layout.spaces.flatMap(\.archived).map(\.id.rawValue))
    }

    @Test func aThreadUnderAnotherIsInNeedsYouWhileItWaitsAndNowhereElse() {
        let threads = [
            Self.record("parent", folder: "/Users/dev/app"),
            Self.record("waits", agent: "codex", from: "parent", folder: "/Users/dev/app"),
            Self.record("works", agent: "codex", from: "parent", folder: "/Users/dev/app"),
            Self.record("ended", agent: "codex", from: "parent", unseen: true, folder: "/Users/dev/app"),
            Self.record("putAway", agent: "codex", from: "parent", archived: true, folder: "/Users/dev/app"),
        ]
        let layout = Self.layout(threads, waiting: [Self.key("waits")], running: [Self.key("works"), Self.key("parent")])
        #expect(layout.top.waiting.map(\.id.rawValue) == ["waits"])
        #expect(layout.top.running.map(\.id.rawValue) == ["parent"])
        #expect(layout.top.finished.isEmpty)
        #expect(layout.top.recent.isEmpty)
        let shown = Self.everywhere(layout)
        #expect(shown.spaces == ["parent"])
        #expect(shown.archived.isEmpty)
    }

    @Test func aThreadShownInTheSidebarTooIsListedAsAnyOther() {
        let threads = [
            Self.record("parent", updated: 0),
            Self.record("shown", agent: "codex", from: "parent", shared: true, unseen: true, updated: 10),
        ]
        let layout = Self.layout(threads, running: [])
        #expect(layout.top.finished.map(\.id.rawValue) == ["shown"])
        #expect(Self.everywhere(layout).spaces == ["shown", "parent"])
    }

    @Test func aHostThatDoesNotNestThemListsThemAsBefore() {
        let threads = [Self.record("parent"), Self.record("review", agent: "codex", from: "parent", updated: 10)]
        let layout = Self.layout(threads, running: [Self.key("review")], nesting: [])
        #expect(layout.top.running.map(\.id.rawValue) == ["review"])
        #expect(Self.everywhere(layout).spaces == ["review", "parent"])
    }

    @Test func aFolderWithOnlyThreadsUnderOthersIsNoProject() {
        let threads = [
            Self.record("parent", folder: "/Users/dev/app", updated: 0),
            // Worked in last, in a folder nothing else in the sidebar works in.
            Self.record("review", agent: "codex", from: "parent", folder: "/Users/dev/elsewhere", updated: 50),
        ]
        let projects = Self.layout(threads).spaces.flatMap(\.folders).map(\.id.path)
        #expect(projects == ["/Users/dev/app"])
    }

    @Test func showInSidebarIsForTheThreadsUnderTheirThreadAlone() {
        let threads = [
            Self.record("parent"),
            Self.record("review", agent: "codex", from: "parent"),
            Self.record("shown", agent: "codex", from: "parent", shared: true),
            // In the sidebar whatever the mark says: nothing else would show them.
            Self.record("aeri", agent: "aeri"),
            Self.record("fromAeri", from: "aeri", starter: "Aeri"),
            Self.record("markedFromAeri", from: "aeri", starter: "Aeri", shared: true),
            Self.record("orphan", from: "gone"),
        ]
        #expect(Self.layout(threads, waiting: [Self.key("review")]).nested == [Self.key("review"), Self.key("shown")])
        #expect(Self.layout(threads, nesting: []).nested.isEmpty)
    }

    // MARK: The mark, kept for every device

    @Test func theHostsMarkIsTakenAndOneMadeHereWinsUntilSent() {
        let listed = ListedThread(
            id: ThreadRef.ID(rawValue: "review"), agent: "codex", updated: Self.t0, revision: 7,
            startedBy: ThreadStarter(name: "Claude Code", thread: ThreadRef.ID(rawValue: "parent")), shared: true
        )
        let answer = ThreadListChanges(list: ThreadListRevision(id: "list", revision: 7), threads: [listed])
        let merged = ThreadSync.merge(answer, into: [], heldWhenAsking: [], pending: [], list: nil, host: Self.mac)
        #expect(merged.threads.first?.isShared == true)
        #expect(merged.threads.first?.startedFrom == Self.key("parent"))

        let hidden = PendingThreadChange(thread: listed.id, shared: false)
        let again = ThreadSync.merge(
            answer, into: merged.threads, heldWhenAsking: [listed.id], pending: [hidden],
            list: ThreadListRevision(id: "list", revision: 6), host: Self.mac
        )
        #expect(again.threads.first?.isShared == false)
        #expect(hidden.marks == ThreadMarks(shared: false))
    }

    @Test func aChangeOfTheMarkIsSentAndSettledLikeAPin() {
        var change = PendingThreadChange(thread: ThreadRef.ID(rawValue: "review"), shared: true)
        #expect(!change.isEmpty)
        #expect(change.keys == [.shared])
        #expect(change.leavingOut(.shared).isEmpty)
        change.take(PendingThreadChange(thread: change.thread, pinned: true))
        #expect(change.shared == true && change.pinned == true)
        change.settle(PendingThreadChange(thread: change.thread, shared: true))
        #expect(change.shared == nil && change.pinned == true)
    }

    @Test func aMarkHeldHereGoesUpOnceToAListNotMergedBefore() {
        var mine = Self.record("review", from: "parent")
        mine.shared = true
        let listed = ListedThread(id: mine.id, agent: "claude", updated: Self.t0, revision: 3)
        let answer = ThreadListChanges(list: ThreadListRevision(id: "new", revision: 3), threads: [listed], isFull: true)
        let merged = ThreadSync.merge(answer, into: [mine], heldWhenAsking: [mine.id], pending: [], list: nil, host: Self.mac)
        #expect(merged.pending.first?.shared == true)
        #expect(merged.threads.first?.isShared == true)
    }

    @Test func whetherAHostNestsThemIsKeptWithIt() throws {
        let host = HostConfig(name: "Mac", url: URL(string: "https://mac.example")!, nestsAgentThreads: true)
        let decoded = try JSONDecoder().decode(HostConfig.self, from: JSONEncoder().encode(host))
        #expect(decoded.nestsAgentThreads == true)
        // Saved before: false.
        let before = #"{"id":"mac","name":"Mac","url":"https:\/\/mac.example"}"#
        #expect(try JSONDecoder().decode(HostConfig.self, from: Data(before.utf8)).nestsAgentThreads == nil)
    }

    // MARK: Answered by the agent that started it

    @Test func aRequestAnAgentAnsweredIsRecordedWithWhoAnswered() {
        var state = ThreadState()
        state.messageSent("review the diff", at: Self.t0)
        let approval = PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "swift test", choices: [.once, .session, .deny])))
        state.apply(.requestOpened(approval), at: Self.t0)
        state.apply(.requestAnswered(id: "srq-1", answer: .approval(.once), by: "Claude Code"), at: Self.t0)
        #expect(state.openRequests.isEmpty)
        let last = state.transcript.turns.last?.items.last?.content
        #expect(last == .request(RequestRecord(id: "srq-1", kind: .approval, prompt: "swift test", answer: "Allowed once", answeredBy: "Claude Code")))

        let question = PendingRequest(id: "srq-2", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which language?")]))
        state.apply(.requestOpened(question), at: Self.t0)
        state.apply(.requestAnswered(id: "srq-2", answer: .clarify(["q0": "Swift"]), by: "Claude Code"), at: Self.t0)
        #expect(state.transcript.turns.last?.items.last?.content == .request(RequestRecord(
            id: "srq-2", kind: .question, prompt: "Which language?", answer: "Swift", answeredBy: "Claude Code"
        )))
        // Answering what is not open changes nothing.
        let count = state.transcript.turns.last?.items.count
        state.apply(.requestAnswered(id: "srq-2", answer: .clarify(["q0": "Go"]), by: "Claude Code"), at: Self.t0)
        #expect(state.transcript.turns.last?.items.count == count)
    }

    @Test func aTranscriptSavedBeforeReadsWithNobodyAnsweringForYou() throws {
        let saved = #"{"id":"srq-1","kind":"approval","prompt":"ls","answer":"Allowed once"}"#
        #expect(try JSONDecoder().decode(RequestRecord.self, from: Data(saved.utf8)).answeredBy == nil)
    }

    // MARK: Started from another Mac's thread (`senders`)

    private static func farChild(_ id: String, on host: HostID, from parent: String, machine: String, created: TimeInterval = 0) -> ThreadRecord {
        var record = record(id, host: host, agent: "codex", created: created)
        record.startedBy = ThreadStarter(
            name: "Claude Code on MBP16",
            from: MessageSender(agent: "claude", agentName: "Claude Code", thread: parent, machine: machine, machineName: "MBP16")
        )
        return record
    }

    @Test func aThreadStartedFromAnotherMacsThreadIsUnderItWhenThatMacIsAHostToo() {
        let agents = Self.agents + [Agent(id: Agent.ID(host: Self.mini, name: "codex"))]
        let threads = [Self.record("parent"), Self.farChild("review", on: Self.mini, from: "parent", machine: "macid")]
        let machines = ["macid": Self.mac, "miniid": Self.mini]
        let listed = Set(agents.map(\.id))
        #expect(StartedThreads.tucked(threads, nesting: [Self.mini], listed: listed, machines: machines) == [Self.key("review", host: Self.mini)])
        #expect(StartedThreads.started(from: Self.key("parent"), in: threads, machines: machines).map(\.id.rawValue) == ["review"])
        // That Mac is not a host here, or its id is unknown: in the sidebar, as before.
        #expect(StartedThreads.tucked(threads, nesting: [Self.mini], listed: listed).isEmpty)
        #expect(StartedThreads.tucked(threads, nesting: [Self.mini], listed: listed, machines: ["other": Self.mac]).isEmpty)
        // The far host does not nest: in its sidebar.
        #expect(StartedThreads.tucked(threads, nesting: [Self.mac], listed: listed, machines: machines).isEmpty)
        // A Mac's id naming the thread's own host is no other Mac.
        let selfNamed = [Self.record("parent", host: Self.mini), Self.farChild("review", on: Self.mini, from: "parent", machine: "miniid")]
        #expect(StartedThreads.tucked(selfNamed, nesting: [Self.mini], listed: listed, machines: machines).isEmpty)
    }

    @Test func theHostsAreKnownByTheirMacsIds() {
        let a = HostConfig(id: Self.mac, name: "MBP16", url: URL(string: "http://a")!, machineID: "macid")
        let b = HostConfig(id: Self.mini, name: "mini", url: URL(string: "http://b")!, machineID: "macid")
        let c = HostConfig(id: HostID(rawValue: "c"), name: "c", url: URL(string: "http://c")!)
        #expect(StartedThreads.machines(of: [a, b, c]) == ["macid": Self.mac])
    }
}
