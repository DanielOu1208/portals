import Foundation
import Testing
@testable import AgentCore

/// How an answer from a host that keeps the list of threads is merged into what a device
/// holds for it (`ThreadSync`, docs/sync-plan.md "How the app merges"), rule by rule.
@Suite struct ThreadSyncTests {
    private let mac = HostID(rawValue: "mac")
    private let t0 = Date(timeIntervalSince1970: 1_791_320_000)
    private let merged = ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 10)

    private func id(_ raw: String) -> ThreadRef.ID { ThreadRef.ID(rawValue: raw) }

    private func held(
        _ raw: String, updated: TimeInterval = 0, title: String? = nil, preview: String? = nil,
        pinned: Bool = false, archived: Bool = false, unseen: Bool = false, localOnly: Bool = false
    ) -> ThreadRecord {
        var record = ThreadRecord(
            ref: ThreadRef(id: id(raw), agent: Agent.ID(host: mac, name: "claude"), title: title, createdAt: t0),
            updatedAt: t0.addingTimeInterval(updated), preview: preview, pinned: pinned, archived: archived
        )
        record.unseen = unseen ? true : nil
        record.localOnly = localOnly ? true : nil
        return record
    }

    private func listed(
        _ raw: String, updated: TimeInterval = 0, revision: Int = 11, title: String? = nil, preview: String? = nil,
        pinned: Bool = false, archived: Bool = false, unseen: Bool = false, turn: Int? = nil
    ) -> ListedThread {
        ListedThread(
            id: id(raw), agent: "claude", title: title, folder: "/Users/dev/app", created: t0,
            updated: t0.addingTimeInterval(updated), revision: revision, preview: preview,
            pinned: pinned, archived: archived, unseen: unseen, turn: turn
        )
    }

    private func delta(_ threads: [ListedThread], removed: [String] = [], revision: Int = 12) -> ThreadListChanges {
        ThreadListChanges(list: ThreadListRevision(id: merged.id, revision: revision), threads: threads, removed: removed.map(id))
    }

    private func full(_ threads: [ListedThread], removed: [String] = [], list: String = "3f9a1c0e7b2d4a65") -> ThreadListChanges {
        ThreadListChanges(list: ThreadListRevision(id: list, revision: 12), threads: threads, removed: removed.map(id), isFull: true)
    }

    private func merge(
        _ answer: ThreadListChanges, holding records: [ThreadRecord], pending: [PendingThreadChange] = [],
        list: ThreadListRevision?, asking: Set<ThreadRef.ID>? = nil, lookedAt: ThreadRef.ID? = nil,
        readHere: [ThreadRef.ID: TurnRead] = [:]
    ) -> ThreadMerge {
        ThreadSync.merge(
            answer, into: records, heldWhenAsking: asking ?? Set(records.map(\.id)), pending: pending, list: list,
            host: mac, lookedAt: lookedAt, readHere: readHere
        )
    }

    private func thread(_ raw: String, in merge: ThreadMerge) -> ThreadRecord? {
        merge.threads.first { $0.id == id(raw) }
    }

    // MARK: Listed threads

    @Test func aDeltaChangesTheThreadsItListsAndKeepsTheRest() throws {
        var mine = held("a", title: "Old", preview: "hi")
        mine.context = ContextUsage(used: 1000, limit: 200_000)
        let other = held("b", updated: -60, title: "Other")
        let result = merge(delta([listed("a", updated: 30, revision: 12, title: "Fix the login", pinned: true)]), holding: [mine, other], list: merged)

        let a = try #require(thread("a", in: result))
        #expect(a.ref.title == "Fix the login")
        #expect(a.isPinned)
        #expect(a.revision == 12)
        #expect(a.ref.workingDirectory == "/Users/dev/app")
        // What the host does not say stays as held: the context, a preview it has none of.
        #expect(a.context == ContextUsage(used: 1000, limit: 200_000))
        #expect(a.preview == "hi")
        #expect(thread("b", in: result) == other)
        #expect(result.list == ThreadListRevision(id: merged.id, revision: 12))
        #expect(result.forgotten.isEmpty)
        #expect(result.pending.isEmpty)
    }

    @Test func theHostsTimeWinsSoEveryDeviceOrdersByOneClock() {
        // This device's clock ran ahead: the host's times order the list.
        let result = merge(
            delta([listed("a", updated: 10), listed("b", updated: 20)]),
            holding: [held("a", updated: 500), held("b", updated: 5)], list: merged
        )
        #expect(result.threads.map(\.id.rawValue) == ["b", "a"])
        #expect(result.threads.map(\.updatedAt) == [t0.addingTimeInterval(20), t0.addingTimeInterval(10)])
    }

    @Test func pendingChangesWinOverWhatTheHostSays() throws {
        let pending = [PendingThreadChange(thread: id("a"), pinned: false, archived: true, unseen: true, title: "Mine")]
        let result = merge(
            delta([listed("a", title: "The host's", pinned: true), listed("b", title: "Theirs", pinned: true)]),
            holding: [held("a", title: "Mine"), held("b")], pending: pending, list: merged
        )
        let a = try #require(thread("a", in: result))
        #expect(a.ref.title == "Mine")
        #expect(!a.isPinned)
        #expect(a.isArchived)
        #expect(a.isUnseen)
        #expect(result.pending == pending)
        // Elsewhere the host's word stands.
        #expect(thread("b", in: result)?.isPinned == true)
        #expect(thread("b", in: result)?.ref.title == "Theirs")
    }

    @Test func aTitleIsNeverClearedAndAPreviewIsTheHostsElseTheOneHeld() throws {
        let result = merge(
            delta([listed("a"), listed("b", preview: "Make the login keep its session")]),
            holding: [held("a", title: "Kept", preview: "Mine"), held("b", preview: "Older")], list: merged
        )
        #expect(thread("a", in: result)?.ref.title == "Kept")
        #expect(thread("a", in: result)?.preview == "Mine")
        #expect(thread("b", in: result)?.preview == "Make the login keep its session")
    }

    @Test func theRepositoryOfAThreadsWorktreeIsTheHostsAndSavedWithTheThread() throws {
        var inWorktree = listed("a", revision: 12)
        inWorktree.folder = "/Users/dev/coding_projects/portals-night"
        inWorktree.repo = "/Users/dev/coding_projects/Portals"
        let first = merge(delta([inWorktree]), holding: [held("a")], list: merged)
        let record = try #require(thread("a", in: first))
        #expect(record.repo == "/Users/dev/coding_projects/Portals")
        #expect(record.ref.workingDirectory == "/Users/dev/coding_projects/portals-night")
        #expect(try JSONDecoder().decode(ThreadRecord.self, from: JSONEncoder().encode(record)).repo == "/Users/dev/coding_projects/Portals")
        // Saved while the thread was on screen: the host's word stays.
        let open = ThreadRecord(ref: record.ref, updatedAt: record.updatedAt.addingTimeInterval(5))
        #expect(record.saving(open, hostKeepsList: true, isOnScreen: true).repo == "/Users/dev/coding_projects/Portals")
        // A host that no longer says one (the folder is in no worktree now).
        let second = merge(delta([listed("a", revision: 13)], revision: 13), holding: first.threads, list: first.list)
        #expect(try #require(thread("a", in: second)).repo == nil)
    }

    @Test func theBranchIsTheHostsAsOfTheThreadsLastTurnAndGoesWhenTheHostNoLongerSaysOne() throws {
        var onMain = listed("a", revision: 12)
        onMain.branch = "main"
        let first = merge(delta([onMain]), holding: [held("a")], list: merged)
        #expect(try #require(thread("a", in: first)).branch == "main")
        // Its last turn ran outside a repository, or on a detached HEAD.
        let second = merge(delta([listed("a", revision: 13)], revision: 13), holding: first.threads, list: first.list)
        #expect(try #require(thread("a", in: second)).branch == nil)
        // Saved with the thread, and read from threads saved before it as none.
        var record = held("a")
        record.branch = "fix-login"
        #expect(try JSONDecoder().decode(ThreadRecord.self, from: JSONEncoder().encode(record)).branch == "fix-login")
        #expect(try JSONDecoder().decode(ThreadRecord.self, from: JSONEncoder().encode(held("a"))).branch == nil)
    }

    @Test func aThreadListedForTheFirstTimeIsTheHostsWithWhoStartedIt() throws {
        var aeri = listed("x", updated: 40, revision: 15, title: "Check the build", preview: "Run the tests")
        aeri.startedBy = ThreadStarter(name: "Aeri", thread: id("aeri"))
        aeri.readOnly = true
        var hermes = ListedThread(id: id("aeri"), agent: "aeri", updated: t0, revision: 3)
        hermes.folder = ""
        let result = merge(delta([aeri, hermes]), holding: [], list: merged)

        let x = try #require(thread("x", in: result))
        #expect(x.ref.agent == Agent.ID(host: mac, name: "claude"))
        #expect(x.ref.createdAt == t0)
        #expect(x.ref.isReadOnly)
        #expect(x.startedBy == ThreadStarter(name: "Aeri", thread: id("aeri")))
        #expect(x.isFromHost)
        #expect(x.preview == "Run the tests")
        let a = try #require(thread("aeri", in: result))
        #expect(a.ref.agent.name == "aeri")
        #expect(a.ref.workingDirectory == nil)
        // A thread held already is not from the host, whatever lists it.
        #expect(merge(delta([listed("a")]), holding: [held("a")], list: merged).threads.first?.isFromHost == false)
    }

    @Test func aListedLocalOnlyThreadIsNoLongerOnlyHere() {
        let result = merge(delta([listed("a")]), holding: [held("a", localOnly: true)], list: merged)
        #expect(result.threads.first?.isLocalOnly == false)
    }

    @Test func aThreadWithARemovalOnItsWayIsKeptAndStaysHidden() {
        let removing = [PendingThreadChange(thread: id("a"), remove: true)]
        let result = merge(delta([listed("a", title: "Busy")]), holding: [held("a")], pending: removing, list: merged)
        #expect(thread("a", in: result)?.ref.title == "Busy")
        #expect(result.pending == removing)
    }

    @Test func anEntryThatCouldNotBeReadIsNeitherChangedNorForgotten() {
        let mine = held("a", title: "Mine")
        var answer = full([])
        answer.unreadable = [id("a")]
        let result = merge(answer, holding: [mine], list: merged)
        #expect(result.threads == [mine])
        #expect(result.forgotten.isEmpty)
    }

    // MARK: Removals

    @Test func aDeltasRemovedThreadsAreForgottenWithWhatWasPendingForThem() {
        let pending = [PendingThreadChange(thread: id("b"), pinned: true), PendingThreadChange(thread: id("c"), title: "Kept")]
        let result = merge(delta([], removed: ["b", "gone-long-ago"]), holding: [held("a"), held("b"), held("c")], pending: pending, list: merged)
        #expect(result.threads.map(\.id.rawValue).sorted() == ["a", "c"])
        #expect(result.forgotten.map(\.id) == [id("b")])
        #expect(result.pending == [PendingThreadChange(thread: id("c"), title: "Kept")])
    }

    @Test func aFullAnswerForgetsWhatItDoesNotListExceptWhatIsKeptHereOnly() {
        let result = merge(full([listed("a")]), holding: [held("a"), held("b", localOnly: true), held("c")], list: merged)
        #expect(result.threads.map(\.id.rawValue).sorted() == ["a", "b"])
        #expect(result.forgotten.map(\.id) == [id("c")])
        // A thread kept here only goes when the host names it as removed.
        let removed = merge(full([listed("a")], removed: ["b"]), holding: [held("a"), held("b", localOnly: true)], list: merged)
        #expect(removed.forgotten.map(\.id) == [id("b")])
    }

    @Test func aThreadStartedWhileTheAnswerWasOnItsWayIsNotForgottenByIt() {
        let result = merge(full([listed("a")]), holding: [held("a"), held("new", updated: 90)], list: merged, asking: [id("a")])
        #expect(result.threads.map(\.id.rawValue) == ["new", "a"])
        #expect(result.forgotten.isEmpty)
        #expect(thread("new", in: result)?.isLocalOnly == false)
    }

    // MARK: Carrying marks over

    @Test func aListNotMergedBeforeCarriesTheMarksThisDeviceSetOverOnce() throws {
        let records = [
            held("pinned", updated: 0, pinned: true),
            held("archived", updated: 10, archived: true),
            held("unseen", updated: 10, unseen: true),
            held("untold", preview: "What did the build say?"),
            held("blank", preview: "   "),
        ]
        let answer = full([
            listed("pinned", updated: 300), listed("archived", updated: 10), listed("unseen", updated: 5),
            listed("untold"), listed("blank"),
        ])
        for list in [nil, ThreadListRevision(id: "an-older-list", revision: 900)] {
            let result = merge(answer, holding: records, list: list)
            #expect(result.pending == [
                PendingThreadChange(thread: id("pinned"), pinned: true),
                PendingThreadChange(thread: id("archived"), archived: true),
                PendingThreadChange(thread: id("unseen"), unseen: true),
                PendingThreadChange(thread: id("untold"), preview: "What did the build say?"),
            ])
            // The list shows them at once, as they are on their way.
            #expect(thread("pinned", in: result)?.isPinned == true)
            #expect(thread("archived", in: result)?.isArchived == true)
            #expect(thread("unseen", in: result)?.isUnseen == true)
            #expect(result.list.id == "3f9a1c0e7b2d4a65")
        }
    }

    @Test func anArchiveOrUnseenMarkOrAPreviewOlderThanTheThreadsLastTurnIsNotCarried() {
        // Something new happened in each since this device last saw it: it brings them
        // back, as it would have here, and the host's preview of it is newer than this
        // device's.
        let result = merge(
            full([listed("archived", updated: 60), listed("unseen", updated: 60), listed("preview", updated: 60)]),
            holding: [
                held("archived", updated: 0, archived: true), held("unseen", updated: 0, unseen: true),
                held("preview", updated: 0, preview: "Fix the login"),
            ],
            list: nil
        )
        #expect(result.pending.isEmpty)
        #expect(result.threads.allSatisfy { !$0.isArchived && !$0.isUnseen })
    }

    @Test func aCarryOverSendsOnlyMarksThatAreSetSoASecondDeviceClearsNoPinOrArchive() {
        // The first device pinned and archived; this one never did, nor saw b's last turn.
        let result = merge(
            full([listed("a", pinned: true), listed("b", updated: 60, archived: true, unseen: true)]),
            holding: [held("a"), held("b")], list: nil
        )
        #expect(result.pending.isEmpty)
        #expect(result.seen.isEmpty)
        #expect(result.threads.first { $0.id == id("a") }?.isPinned == true)
        #expect(result.threads.first { $0.id == id("b") }?.isArchived == true)
        #expect(result.threads.first { $0.id == id("b") }?.isUnseen == true)
    }

    @Test func aCarryOverTellsTheHostOfThreadsSeenHereSinceTheirLastTurn() throws {
        // The host marked all three unseen while this device could not say it had seen
        // them (an app from before the list): it saw a's last turn, not b's, and c's last
        // turn ended out of its sight.
        let result = merge(
            full([
                listed("a", updated: 10, revision: 15, unseen: true), listed("b", updated: 60, revision: 16, unseen: true),
                listed("c", updated: 10, revision: 17, unseen: true),
            ]),
            holding: [held("a", updated: 10), held("b", updated: 10), held("c", updated: 10, unseen: true)], list: nil
        )
        #expect(result.seen == [SeenThread(thread: id("a"), revision: 15, list: merged.id)])
        #expect(thread("a", in: result)?.isUnseen == false)
        #expect(thread("b", in: result)?.isUnseen == true)
        #expect(thread("c", in: result)?.isUnseen == true)
        #expect(result.pending.isEmpty)
        // A list merged before carries nothing over.
        #expect(merge(full([listed("a", updated: 10, unseen: true)]), holding: [held("a", updated: 10)], list: merged).seen.isEmpty)
    }

    @Test func aCarryOverLeavesWhatIsPendingAlready() {
        // Unpinned here while the host did not keep the list: that is newer than the pin.
        let pending = [PendingThreadChange(thread: id("a"), pinned: false)]
        let result = merge(full([listed("a")]), holding: [held("a", pinned: true)], pending: pending, list: nil)
        #expect(result.pending == pending)
        #expect(result.threads.first?.isPinned == false)
    }

    @Test func aCarryOverForgetsRemovedThreadsAndKeepsOnesTheHostNeverHad() throws {
        let result = merge(
            full([listed("a")], removed: ["removed"]),
            holding: [held("a"), held("removed", pinned: true), held("unknown", title: "From before")], list: nil
        )
        #expect(result.forgotten.map(\.id) == [id("removed")])
        let unknown = try #require(thread("unknown", in: result))
        #expect(unknown.isLocalOnly)
        #expect(unknown.ref.title == "From before")
        #expect(result.pending.isEmpty)
    }

    @Test func aFullAnswerFromTheListMergedLastCarriesNothingOver() {
        let result = merge(full([listed("a")]), holding: [held("a", pinned: true)], list: merged)
        #expect(result.pending.isEmpty)
        #expect(result.threads.first?.isPinned == false)
    }

    // MARK: The thread looked at

    @Test func theThreadLookedAtIsMarkedSeenWithItsRevision() throws {
        let result = merge(
            delta([listed("a", revision: 15, unseen: true), listed("b", revision: 16, unseen: true)]),
            holding: [held("a"), held("b")], list: merged, lookedAt: id("a")
        )
        #expect(thread("a", in: result)?.isUnseen == false)
        #expect(result.seen == [SeenThread(thread: id("a"), revision: 15, list: merged.id)])
        #expect(thread("b", in: result)?.isUnseen == true)
        // Nothing to say when it is seen already.
        let seen = merge(delta([listed("a", revision: 15)]), holding: [held("a")], list: merged, lookedAt: id("a"))
        #expect(seen.seen.isEmpty)
    }

    /// A thread read here before the list had its turn's end (`EndedOutOfSight`) is seen
    /// by the merge that brings the end, looked at still or not.
    @Test func aThreadReadBeforeItsEndWasListedIsSeenWhenItIs() {
        let result = merge(
            delta([listed("a", revision: 15, unseen: true), listed("b", revision: 16, unseen: true)]),
            holding: [held("a"), held("b")], list: merged, lookedAt: id("b"), readHere: [id("a"): TurnRead()]
        )
        #expect(thread("a", in: result)?.isUnseen == false)
        #expect(thread("b", in: result)?.isUnseen == false)
        #expect(Set(result.seen) == [
            SeenThread(thread: id("a"), revision: 15, list: merged.id), SeenThread(thread: id("b"), revision: 16, list: merged.id),
        ])
    }

    /// net-20: the turn read here is named, so a merge that brings a later turn from
    /// another device with the end of the one read leaves that later turn unseen, and sends
    /// no seen for it; the merge that brings only the turn read sees it, naming that turn
    /// for the host to check.
    @Test func aTurnReadBeforeItsEndWasListedDoesNotClearALaterTurn() {
        var a = held("a")
        a.turn = 13
        // A later turn began at 14 and ended on another device before this list came.
        let later = merge(delta([listed("a", revision: 16, unseen: true, turn: 14)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 13)])
        #expect(thread("a", in: later)?.isUnseen == true)
        #expect(later.seen.isEmpty)
        // The list brings only the end of the turn read: seen, naming it.
        let same = merge(delta([listed("a", revision: 15, unseen: true, turn: 13)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 13)])
        #expect(thread("a", in: same)?.isUnseen == false)
        #expect(same.seen == [SeenThread(thread: id("a"), revision: 15, list: merged.id, turn: 13)])
        // Looked at now, everything in it is seen, the later turn too, with no turn named.
        let looked = merge(delta([listed("a", revision: 16, unseen: true, turn: 14)]), holding: [a], list: merged, lookedAt: id("a"), readHere: [id("a"): TurnRead(turn: 13)])
        #expect(looked.seen == [SeenThread(thread: id("a"), revision: 16, list: merged.id)])
        // A list from an older bridge says no turn: as before.
        let older = merge(delta([listed("a", revision: 16, unseen: true)]), holding: [held("a")], list: merged, readHere: [id("a"): TurnRead()])
        #expect(older.seen == [SeenThread(thread: id("a"), revision: 16, list: merged.id)])
    }

    /// A turn quicker than the list here (its start never merged, Codex's review): the list
    /// here had the turn before as the latest. The host, last heard at 14 before the read
    /// with the thread not at work, says the latest began at 13: begun and ended by the read,
    /// so it is the one read. One begun at 16, after, is not; nor with no list heard, nor one
    /// heard of another list. A thread whose list here had no turn is told apart the same way.
    @Test func aQuickTurnReadBeforeTheListHadItsStartIsToldFromALaterOne() {
        var a = held("a")
        a.turn = 9
        let heard = ThreadListRevision(id: merged.id, revision: 14)
        let quick = merge(delta([listed("a", revision: 15, unseen: true, turn: 13)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 9, heard: heard)])
        #expect(thread("a", in: quick)?.isUnseen == false)
        #expect(quick.seen == [SeenThread(thread: id("a"), revision: 15, list: merged.id, turn: 13)])
        let later = merge(delta([listed("a", revision: 17, unseen: true, turn: 16)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 9, heard: heard)])
        #expect(thread("a", in: later)?.isUnseen == true && later.seen.isEmpty)
        let unheard = merge(delta([listed("a", revision: 15, unseen: true, turn: 13)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 9)])
        #expect(unheard.seen.isEmpty)
        let elsewhere = ThreadListRevision(id: "another-list", revision: 99)
        let other = merge(delta([listed("a", revision: 15, unseen: true, turn: 13)]), holding: [a], list: merged, readHere: [id("a"): TurnRead(turn: 9, heard: elsewhere)])
        #expect(other.seen.isEmpty)
        let none = merge(delta([listed("a", revision: 17, unseen: true, turn: 16)]), holding: [held("a")], list: merged, readHere: [id("a"): TurnRead(heard: heard)])
        #expect(none.seen.isEmpty)
    }

    @Test func aCarriedUnseenMarkOnTheThreadLookedAtIsDropped() {
        let result = merge(full([listed("a", revision: 15)]), holding: [held("a", unseen: true)], list: nil, lookedAt: id("a"))
        #expect(result.pending.isEmpty)
        #expect(result.threads.first?.isUnseen == false)
    }

    // MARK: What a device does with its own copy

    @Test func anOpenThreadSavesOnlyItsTimeAndContextOverAThreadTheHostLists() {
        var old = held("a", updated: 100, title: "Fix the login", preview: "Keep the session", pinned: true, unseen: true)
        old.archived = true
        old.revision = 812
        old.fromHost = true
        old.startedBy = ThreadStarter(name: "Aeri", thread: id("aeri"))
        // An open thread that fell behind: an old title and preview, no marks, and a
        // message sent here since.
        let open = ThreadRecord(
            ref: ThreadRef(id: id("a"), agent: Agent.ID(host: mac, name: "claude"), title: "Old title"),
            updatedAt: t0.addingTimeInterval(160), preview: "Something older", context: ContextUsage(used: 50, limit: 200)
        )
        let saved = old.saving(open, hostKeepsList: true, isOnScreen: true)
        #expect(saved.updatedAt == t0.addingTimeInterval(160))
        #expect(saved.context == ContextUsage(used: 50, limit: 200))
        var expected = old
        expected.updatedAt = saved.updatedAt
        expected.context = saved.context
        #expect(saved == expected)

        // A time from before the host's, or no context, takes nothing.
        var behind = open
        behind.updatedAt = t0.addingTimeInterval(40)
        behind.context = nil
        #expect(old.saving(behind, hostKeepsList: true, isOnScreen: false) == old)
    }

    @Test func anOpenThreadSavesWhatItHasOverAThreadOfAnotherHostAsBefore() {
        let old = held("a", updated: 100, title: "Fix the login", preview: "Keep the session", pinned: true, archived: true, unseen: true)
        let open = ThreadRecord(
            ref: ThreadRef(id: id("a"), agent: Agent.ID(host: mac, name: "claude"), title: "Fixed login"),
            updatedAt: t0.addingTimeInterval(160), preview: "Now the logout", context: ContextUsage(used: 50, limit: 200)
        )
        let saved = old.saving(open, hostKeepsList: false, isOnScreen: false)
        #expect(saved.ref.title == "Fixed login")
        #expect(saved.preview == "Now the logout")
        #expect(saved.updatedAt == t0.addingTimeInterval(160))
        #expect(saved.isPinned)
        // Something new brings it out of the archive; off screen, it stays unseen.
        #expect(!saved.isArchived)
        #expect(saved.isUnseen)
        // On screen it is seen; nothing new leaves it archived.
        var still = open
        still.updatedAt = old.updatedAt
        let onScreen = old.saving(still, hostKeepsList: false, isOnScreen: true)
        #expect(!onScreen.isUnseen)
        #expect(onScreen.isArchived)
    }

    @Test func removeIsOfferedOnAHostThatKeepsTheListOnlyForAThreadAtRest() {
        #expect(held("a").offersRemoval(hostKeepsList: true, atWork: false))
        #expect(!held("a").offersRemoval(hostKeepsList: true, atWork: true))
        // Kept on this device only, or on another host: it leaves only this device.
        #expect(held("mine", localOnly: true).offersRemoval(hostKeepsList: true, atWork: true))
        #expect(held("a").offersRemoval(hostKeepsList: false, atWork: true))
    }

    @Test func aThreadAeriOrAnAgentStartedSaysWhoStartedIt() {
        #expect(ThreadStarter(name: "Aeri", thread: id("aeri")).caption == "Started by Aeri")
        #expect(ThreadStarter(name: "the portals command").caption == "Started by the portals command")
    }
}
