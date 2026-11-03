import Foundation
import Testing
@testable import AgentCore

/// Recent threads on a host that keeps them for every device (`recent_threads`), with two
/// portals, each with its own store and what it held for itself before.
@MainActor
@Suite struct RecentThreadsSyncTests {
    private let mac = HostID(rawValue: "mac")

    /// A portal: a `Device`, and its `Fleet.recent`, as the app gives them to `HostSync`.
    @MainActor private final class Portal {
        let device: Device
        var held: Set<ThreadRef.ID>
        var returned: Set<ThreadRef.ID> = []

        init(_ host: FakeListHost, _ mac: HostID, held: Set<ThreadRef.ID> = [], store: ThreadStore? = nil, keepsStore: Bool = false) {
            device = Device(host, mac, store: store, keepsStore: keepsStore)
            self.held = held
            device.sync.heldRecent = { [unowned self] in self.held }
            device.sync.recentCarried = { [unowned self] in self.held.subtract($0) }
            device.sync.recentReturned = { [unowned self] in self.returned.formUnion($0) }
        }

        var sync: HostSync { device.sync }
        func isRecent(_ thread: ThreadRef.ID) -> Bool { device.record(thread)?.isRecent == true }
    }

    private func markCalls(_ host: FakeListHost) async -> [String] {
        await host.calls.filter { $0.hasPrefix("thread.mark") }
    }

    // MARK: The mark crosses

    @Test func openedOnOnePortalItIsRecentOnTheOtherAndDismissedThereItLeavesTheFirst() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let thread = await host.start("a")
        let phone = Portal(host, mac), ipad = Portal(host, mac)
        await phone.sync.step()
        await ipad.sync.step()
        #expect(phone.sync.keepsRecent && ipad.sync.keepsRecent)

        phone.device.change(PendingThreadChange(thread: thread, recent: true))
        #expect(phone.isRecent(thread))
        await phone.sync.step(listNow: await host.list)
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(thread)?.recent == true)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.isRecent(thread))

        ipad.device.change(PendingThreadChange(thread: thread, recent: false))
        #expect(!ipad.isRecent(thread))
        await ipad.sync.step(listNow: await host.list)
        #expect(await host.thread(thread)?.recent == false)
        await phone.sync.step(listNow: await host.list)
        #expect(!phone.isRecent(thread))
    }

    @Test func aMarkMadeWhileTheHostCannotBeReachedSurvivesAMergeAndGoesUpLater() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let thread = await host.start("a")
        let phone = Portal(host, mac)
        await phone.sync.step()

        await host.setReachable(false)
        phone.device.change(PendingThreadChange(thread: thread, recent: true))
        let away = await phone.sync.step()
        #expect(away.error != nil && !away.listIsCurrent)
        #expect(phone.sync.pending.first?.recent == true)
        #expect(phone.device.store.loadSync(for: mac)?.pending.first?.recent == true)

        await host.setReachable(true)
        await host.retitle(thread, "Named elsewhere meanwhile")
        await phone.sync.step(listNow: await host.list)
        #expect(phone.isRecent(thread))
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(thread)?.recent == true)
    }

    @Test func aPendingMarkWinsOverWhatAnAnswerSaysAndTheHostsMarkShowsOtherwise() {
        let thread = ThreadRef.ID(rawValue: "a")
        let held = [ThreadRecord(ref: ThreadRef(id: thread, agent: Agent.ID(host: mac, name: "claude")), updatedAt: Date(timeIntervalSince1970: 10))]
        let listed = ListedThread(id: thread, agent: "claude", updated: Date(timeIntervalSince1970: 10), revision: 5, recent: true)
        let answer = ThreadListChanges(list: ThreadListRevision(id: "l", revision: 5), threads: [listed])
        let list = ThreadListRevision(id: "l", revision: 4)
        let plain = ThreadSync.merge(answer, into: held, heldWhenAsking: [thread], pending: [], list: list, host: mac)
        #expect(plain.threads.first?.isRecent == true)
        let dismissed = ThreadSync.merge(answer, into: held, heldWhenAsking: [thread], pending: [PendingThreadChange(thread: thread, recent: false)], list: list, host: mac)
        #expect(dismissed.threads.first?.isRecent == false)
    }

    @Test func savingAnOpenThreadLeavesTheMark() {
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "a"), agent: Agent.ID(host: mac, name: "claude"))
        var held = ThreadRecord(ref: ref, updatedAt: Date(timeIntervalSince1970: 10))
        held.recent = true
        let open = ThreadRecord(ref: ref, updatedAt: Date(timeIntervalSince1970: 20))
        #expect(held.saving(open, hostKeepsList: true, isOnScreen: true).isRecent)
        #expect(held.saving(open, hostKeepsList: false, isOnScreen: true).isRecent)
    }

    // MARK: Carry-over

    @Test func whatAPortalHeldGoesUpOnceAndStaysThereWithNothingLost() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b"), other = await host.start("c")
        let gone = ThreadRef.ID(rawValue: "never-listed")
        let onlyHere = ThreadRef.ID(rawValue: "only-here")
        let phone = Portal(host, mac, held: [a, b, gone, onlyHere])
        phone.device.keep([phone.device.local(onlyHere, updated: Date(timeIntervalSince1970: 5))])

        await phone.sync.step()
        #expect(phone.sync.keepsRecent)
        #expect(await host.thread(a)?.recent == true)
        #expect(await host.thread(b)?.recent == true)
        #expect(await host.thread(other)?.recent == false)
        #expect(phone.isRecent(a) && phone.isRecent(b) && !phone.isRecent(other))
        #expect(phone.sync.pending.isEmpty)
        // A thread kept here only, and a key of a thread nobody has, stay this device's own.
        #expect(phone.device.record(onlyHere)?.isLocalOnly == true)
        #expect(phone.held == [gone, onlyHere])
        #expect(await host.thread(onlyHere) == nil)

        // Only once: the next steps send nothing, whatever is held.
        let sent = await markCalls(host).count
        #expect(sent == 2)
        await phone.sync.step(listNow: await host.list)
        await phone.sync.step(listNow: await host.list)
        #expect(await markCalls(host).count == sent)
        #expect(phone.held == [gone, onlyHere])
    }

    @Test func aCarryOverSavedAndInterruptedIsDoneAgainWithoutHarm() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let store = Device.scratchStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        var first: Portal? = Portal(host, mac, held: [a], store: store, keepsStore: true)
        await first?.sync.step()
        #expect(await host.thread(a)?.recent == true)
        // The app stopped before it had saved that it let go of the key.
        first = nil
        let again = Portal(host, mac, held: [a], store: store, keepsStore: true)
        #expect(again.sync.keepsRecent)
        let sent = await markCalls(host).count
        await again.sync.step(listNow: await host.list)
        #expect(again.held.isEmpty)
        #expect(await markCalls(host).count == sent)
        #expect(again.isRecent(a))
    }

    /// Stopped between the two saves, either way round, the mark still gets to the host: a
    /// key is let go of only once the mark is pending, on disk.
    @Test func aCarryOverStoppedBetweenItsSavesLosesNoMark() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b")
        let phone = Portal(host, mac)
        await phone.sync.step()
        #expect(phone.sync.keepsRecent)

        // The first save goes through, and then nothing more can be saved.
        phone.held = [a]
        phone.device.locksStoreAfterSaving = true
        await phone.sync.step(listNow: await host.list)
        phone.device.lockStore(false)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.recent == true)
        #expect(phone.held.isEmpty)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.isRecent(a))

        // The threads cannot be saved: the key stays, with the mark pending.
        phone.held = [b]
        phone.device.failSaves = true
        let stopped = await phone.sync.step(listNow: await host.list)
        phone.device.failSaves = false
        #expect(stopped.error != nil)
        #expect(phone.held == [b])
        #expect(phone.device.store.loadSync(for: mac)?.pending.first?.recent == true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(b)?.recent == true)
        #expect(phone.held.isEmpty)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.isRecent(b))
    }

    @Test func aCarryOverMadeWhileTheHostGoesAwayIsKeptUntilItIsBack() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        // The list comes, and the host goes before the mark does.
        await host.neverAnswerMarks(of: [a])
        let step = await phone.sync.step()
        #expect(step.merged)
        #expect(step.error != nil)
        #expect(phone.held.isEmpty)
        #expect(phone.isRecent(a))
        #expect(phone.sync.pending == [PendingThreadChange(thread: a, recent: true)])
        #expect(phone.device.store.loadSync(for: mac)?.keepsRecent == true)

        await host.neverAnswerMarks(of: [])
        await phone.sync.step(listNow: await host.list)
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(a)?.recent == true)
    }

    /// Only true goes up, so two carrying over around the same time add up, and what one
    /// has that the other does not stays. Each with its answer racing the other's.
    @Test func twoPortalsCarryingOverAtOnceEndWithBothAndClearNothing() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b"), c = await host.start("c")
        let phone = Portal(host, mac, held: [a, b]), ipad = Portal(host, mac, held: [b, c])
        async let one = phone.sync.step()
        async let two = ipad.sync.step()
        _ = await (one, two)
        await phone.sync.step(listNow: await host.list)
        await ipad.sync.step(listNow: await host.list)

        for thread in [a, b, c] {
            #expect(await host.thread(thread)?.recent == true)
            #expect(phone.isRecent(thread))
            #expect(ipad.isRecent(thread))
        }
        #expect(phone.held.isEmpty && ipad.held.isEmpty)
        #expect(phone.sync.pending.isEmpty && ipad.sync.pending.isEmpty)
    }

    @Test func aPortalComingLaterAddsToWhatIsThereAndDismissingAfterwardsCounts() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        let ipad = Portal(host, mac, held: [b])
        await ipad.sync.step()
        await phone.sync.step(listNow: await host.list)
        #expect(phone.isRecent(a) && phone.isRecent(b))
        #expect(ipad.isRecent(a) && ipad.isRecent(b))
        // Carried over once: dismissed afterwards, it stays dismissed.
        phone.device.change(PendingThreadChange(thread: b, recent: false))
        await phone.sync.step(listNow: await host.list)
        await ipad.sync.step(listNow: await host.list)
        await ipad.sync.step(listNow: await host.list)
        #expect(await host.thread(b)?.recent == false)
        #expect(!ipad.isRecent(b))
    }

    @Test func aPortalAlreadySyncingCarriesOverOnceItsHostOffersTheFeatureWithoutAFullList() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        #expect(phone.sync.isSyncing && !phone.sync.keepsRecent)
        #expect(phone.held == [a])

        // The bridge was updated: same list, and it now says it keeps them.
        await host.offerRecent(true)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.sync.keepsRecent)
        #expect(phone.held.isEmpty)
        #expect(await host.thread(a)?.recent == true)
        #expect(await host.calls.filter { $0 == "threads.changes" }.count == 1)
    }

    /// A new home on the host loses its marks: they go up again, as a pin does.
    @Test func aListThatReplacedTheOneWithTheMarksGetsThemFromWhoHeldThem() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        await host.replaceList(revision: 3)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.isRecent(a))
        #expect(await host.thread(a)?.recent == true)
    }

    /// Kept here only from now on, it is this device's own as any such thread is, which its
    /// row's dismissal can clear, and comes off what a host's marks count.
    @Test func aMarkedThreadANewListLeavesOutGoesBackToThisDevice() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b")
        let phone = Portal(host, mac, held: [a, b])
        await phone.sync.step()
        #expect(phone.isRecent(a) && phone.isRecent(b))

        await host.replaceList(revision: 3, without: [a])
        await phone.sync.step(listNow: await host.list)
        #expect(phone.device.record(a)?.isLocalOnly == true)
        #expect(!phone.isRecent(a))
        #expect(phone.returned == [a])
        #expect(phone.isRecent(b))

        phone.held.formUnion(phone.returned)
        let top = SidebarGroups.build(
            threads: phone.device.threads, recent: RecentThreads(keys: [ThreadKey(host: mac, id: a)]), waiting: [], running: []
        )
        #expect(Set(top.recent.map(\.id)) == [a, b])
        #expect(top.marked.map(\.id) == [b])
        // Nothing of it goes up, on this step or the next.
        await phone.sync.step(listNow: await host.list)
        #expect(phone.held == [a])
        #expect(await host.thread(a) == nil)
    }

    // MARK: A host without the feature

    @Test func aHostWithoutTheFeatureIsSentNothingAndWhatIsHeldStaysHere() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        await phone.sync.step(listNow: await host.list)
        #expect(!phone.sync.keepsRecent)
        #expect(phone.held == [a])
        #expect(!phone.isRecent(a))
        #expect(await markCalls(host).isEmpty)
        await phone.sync.expireRecent([a])
        #expect(await markCalls(host).isEmpty)
    }

    @Test func aHostThatStopsOfferingItGivesBackWhatItKeptAndGetsItAgainIfItComesBack() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a"), b = await host.start("b")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        #expect(phone.isRecent(a))
        // Dismissed, and not sent yet, when the bridge goes back to an older one.
        phone.device.change(PendingThreadChange(thread: a, recent: true))
        phone.device.change(PendingThreadChange(thread: b, recent: false))
        await host.offerRecent(false)
        let calls = await markCalls(host).count
        await phone.sync.step(listNow: await host.list)
        #expect(!phone.sync.keepsRecent)
        #expect(phone.returned == [a])
        #expect(!phone.isRecent(a))
        #expect(phone.sync.pending.isEmpty)
        #expect(await markCalls(host).count == calls)

        // The app's own, as it was given back.
        phone.held = phone.returned
        await host.offerRecent(true)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.sync.keepsRecent)
        #expect(phone.held.isEmpty)
        #expect(phone.isRecent(a))
    }

    @Test func aHostThatStopsKeepingTheListGivesThemBackToo() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        await host.setOffers(false)
        await phone.sync.step()
        #expect(!phone.sync.isSyncing && !phone.sync.keepsRecent)
        #expect(phone.returned == [a])
        #expect(!phone.isRecent(a))
    }

    // MARK: Archiving

    /// 2026-11-02: archived on one portal, it leaves Recent on the other. Something
    /// new brings it out of the archive unread, unmarked, and only using it marks it.
    @Test func archivedOnOnePortalItLeavesRecentOnTheOther() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a]), ipad = Portal(host, mac)
        await phone.sync.step()
        await ipad.sync.step()
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.isRecent(a))

        phone.device.change(PendingThreadChange(thread: a, archived: true))
        #expect(!phone.isRecent(a))
        #expect(phone.sync.pending.first?.recent == false)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.recent == false)
        await ipad.sync.step(listNow: await host.list)
        #expect(!ipad.isRecent(a) && ipad.device.record(a)?.isArchived == true)

        await host.endTurn(a)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.device.record(a)?.isArchived == false)
        #expect(ipad.device.record(a)?.isUnseen == true)
        #expect(!ipad.isRecent(a))
        ipad.device.change(PendingThreadChange(thread: a, recent: true))
        await ipad.sync.step(listNow: await host.list)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.isRecent(a))
    }

    /// Archived while the host cannot be reached, then used: the archive and the mark go up
    /// together, the newer word standing.
    @Test func anArchiveAndAUseAfterItWhileAwayEndOnTheUse() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        await host.setReachable(false)
        phone.device.change(PendingThreadChange(thread: a, archived: true))
        phone.device.change(PendingThreadChange(thread: a, recent: true))
        await host.setReachable(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.archived == true)
        #expect(await host.thread(a)?.recent == true)
    }

    /// A host without the feature hears nothing of it when a thread is archived, and a key
    /// held for an archived thread is let go of, not sent up, on one that has it.
    @Test func anArchiveSaysNothingOfRecentToAHostWithoutItAndAnArchivedKeyIsNotCarried() async throws {
        let older = FakeListHost()
        let a = await older.start("a")
        let phone = Portal(older, mac, held: [a])
        await phone.sync.step()
        phone.device.change(PendingThreadChange(thread: a, archived: true))
        #expect(phone.sync.pending.first?.recent == nil)
        await phone.sync.step(listNow: await older.list)
        #expect(phone.sync.pending.isEmpty)

        await older.offerRecent(true)
        await phone.sync.step(listNow: await older.list)
        #expect(phone.sync.keepsRecent)
        #expect(phone.held.isEmpty)
        #expect(await older.thread(a)?.recent == false)
        #expect(phone.sync.pending.isEmpty)
    }

    // MARK: Portals with different hosts

    /// A portal with two hosts, whose other host's threads all ran later, and a portal with
    /// only the one they share: the first takes nothing off that one, whichever number
    /// either shows, and a thread opened on the second stays.
    @Test func aPortalWithMoreHostsTakesNothingOffWhatAnotherShows() async throws {
        let shared = FakeListHost(), other = FakeListHost()
        await shared.offerRecent(true)
        await other.offerRecent(true)
        let elsewhere = HostID(rawValue: "elsewhere")
        var ours: [ThreadRef.ID] = []
        for number in 0..<25 { ours.append(await shared.start("shared-\(number)")) }
        var theirs: [ThreadRef.ID] = []
        for number in 0..<25 { theirs.append(await other.start("other-\(number)")) }
        // All of the other host's later than any of the one they share.
        for thread in theirs { await other.endTurn(thread) }

        let wide = Portal(shared, mac, held: Set(ours))
        let wideOther = Portal(other, elsewhere, held: Set(theirs))
        await wide.sync.step()
        await wideOther.sync.step()
        let narrow = Portal(shared, mac)
        await narrow.sync.step()

        func wideExpires() async {
            let all = wide.device.threads + wideOther.device.threads.map { record in
                var read = record
                read.unseen = nil
                return read
            }
            let top = SidebarGroups.build(threads: all, recent: RecentThreads(), waiting: [], running: [], choice: RecentChoice(count: 5))
            #expect(top.recent.allSatisfy { $0.key.host == elsewhere })
            await wide.sync.expireRecent(RecentThreads.pastKept(top.marked, of: mac).map(\.id))
            await wideOther.sync.expireRecent(RecentThreads.pastKept(top.marked, of: elsewhere).map(\.id))
        }
        await wideExpires()
        await narrow.sync.step(listNow: await shared.list)
        #expect(ours.allSatisfy { narrow.isRecent($0) })
        let narrowTop = SidebarGroups.build(threads: narrow.device.threads, recent: RecentThreads(), waiting: [], running: [], choice: RecentChoice(count: 25))
        #expect(narrowTop.recent.count == 25)

        // A thread opened on the narrow one stays, with the wide one looking on.
        narrow.device.change(PendingThreadChange(thread: ours[0], recent: false))
        await narrow.sync.step(listNow: await shared.list)
        narrow.device.change(PendingThreadChange(thread: ours[0], recent: true))
        await narrow.sync.step(listNow: await shared.list)
        await wide.sync.step(listNow: await shared.list)
        await wideExpires()
        #expect(await shared.thread(ours[0])?.recent == true)
    }

    // MARK: Past what is kept

    @Test func aMarkPastWhatIsKeptIsTakenOffAndAnotherPortalSeesIt() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let old = await host.start("old"), new = await host.start("new")
        let phone = Portal(host, mac, held: [old, new]), ipad = Portal(host, mac)
        await phone.sync.step()
        await ipad.sync.step()
        await phone.sync.expireRecent([old])
        #expect(!phone.isRecent(old))
        #expect(phone.isRecent(new))
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(old)?.recent == false)
        await ipad.sync.step(listNow: await host.list)
        #expect(!ipad.isRecent(old))
        #expect(ipad.isRecent(new))
    }

    /// Worked out from what it held then, it is not kept to send: by the time the host is
    /// back another portal may have used that thread, which a late word would undo.
    @Test func aMarkPastWhatIsKeptIsNotKeptForLater() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        await host.setReachable(false)
        await phone.sync.expireRecent([a])
        #expect(phone.isRecent(a))
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.device.store.loadSync(for: mac)?.pending.isEmpty == true)

        // Back, and the thread was used elsewhere meanwhile: nothing undoes that.
        await host.setReachable(true)
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.recent == true)
        #expect(phone.isRecent(a))
    }

    @Test func aThreadUsedHereAgainWhileItsMarkIsBeingTakenOffStaysMarked() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()

        let arrived = await host.hold(.mark)
        let expiring = Task { await phone.sync.expireRecent([a]) }
        for await _ in arrived { break }
        // Used, as the app has it (`HostModel.setRecent`): still marked here, it is news.
        let record = try #require(phone.device.record(a))
        #expect(record.isRecent)
        #expect(phone.sync.changesRecent(true, of: record))
        phone.device.change(PendingThreadChange(thread: a, recent: true))
        await host.release(.mark)
        await expiring.value
        #expect(phone.isRecent(a))
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.recent == true)
        #expect(phone.isRecent(a))
        // Done with, a thread marked is no news again.
        #expect(!phone.sync.changesRecent(true, of: try #require(phone.device.record(a))))
    }

    /// Worked out from the list as it stood: a step queued ahead of it merged the thread's
    /// new turn, so that step's own `stepped` decides again, and this one sends nothing.
    @Test func aMarkPastWhatIsKeptIsLeftWhenAStepAheadOfItMovedTheList() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        let a = await host.start("a")
        let phone = Portal(host, mac, held: [a])
        await phone.sync.step()
        #expect(await host.thread(a)?.recent == true)

        let arrived = await host.hold(.changes)
        let step = Task { await phone.sync.step() }
        for await _ in arrived { break }
        await host.endTurn(a)
        let expiring = Task { await phone.sync.expireRecent([a]) }
        await Task.yield()
        await host.release(.changes)
        _ = await step.value
        await expiring.value
        #expect(await host.thread(a)?.recent == true)
        #expect(phone.isRecent(a))

        // Decided again from the list now, it is sent, the one before it not standing in its way.
        await phone.sync.expireRecent([a])
        #expect(await host.thread(a)?.recent == false)
        #expect(!phone.isRecent(a))
    }

    @Test func aStepSaysWhetherTheListIsKnownToBeCurrent() async throws {
        let host = FakeListHost()
        await host.offerRecent(true)
        _ = await host.start("a")
        let phone = Portal(host, mac)
        #expect(await phone.sync.step().listIsCurrent)
        #expect(await phone.sync.step(listNow: await host.list).listIsCurrent)
        await host.setReachable(false)
        #expect(await phone.sync.step().listIsCurrent == false)
        await host.setReachable(true)
        #expect(await phone.sync.step().listIsCurrent)
    }
}
