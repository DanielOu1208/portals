import Foundation
import Testing
@testable import AgentCore

/// A host's sync steps (`HostSync`) against a host that keeps the list as a bridge does,
/// with two devices, each with its own store.
@MainActor
@Suite struct HostSyncTests {
    private let mac = HostID(rawValue: "mac")

    // MARK: Changes cross between devices

    @Test func aPinOrArchiveMadeOnOneDeviceShowsOnTheOther() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Fix the login")
        let b = await host.start("b")
        let phone = Device(host, mac), mac2 = Device(host, mac)
        await phone.sync.step()
        await mac2.sync.step()
        #expect(phone.listed.map(\.id) == [b, a])
        #expect(phone.record(a)?.isFromHost == true)
        #expect(phone.sync.isSyncing)

        phone.change(PendingThreadChange(thread: a, pinned: true))
        phone.change(PendingThreadChange(thread: b, archived: true))
        #expect(phone.record(a)?.isPinned == true)
        await phone.sync.step()
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(a)?.pinned == true)
        #expect(await host.thread(b)?.archived == true)

        // The other device asks at its next poll, when the list moved.
        let now = await host.list
        await mac2.sync.step(listNow: now)
        #expect(mac2.record(a)?.isPinned == true)
        #expect(mac2.record(b)?.isArchived == true)
        // Nothing is asked while nothing changed.
        let calls = await host.calls.count
        await mac2.sync.step(listNow: now)
        #expect(await host.calls.count == calls)

        // Something new in the archived thread brings it back on both.
        await host.endTurn(b)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.record(b)?.isArchived == false)
        #expect(phone.record(b)?.isUnseen == true)
    }

    @Test func aPinToggledAgainWhileTheFirstIsOnItsWayEndsOnTheNewerValue() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()

        let arrived = await host.hold(.mark)
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let first = Task { await phone.sync.step() }
        for await _ in arrived { break }
        // Unpinned again while the pin is on its way.
        phone.change(PendingThreadChange(thread: a, pinned: false))
        let second = Task { await phone.sync.step() }
        await host.release(.mark)
        _ = await first.value
        _ = await second.value

        #expect(await host.thread(a)?.pinned == false)
        #expect(phone.record(a)?.isPinned == false)
        #expect(phone.sync.pending.isEmpty)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.isPinned == false)
    }

    @Test func aPinAnsweredLateDoesNotSettleANewerOneOfTheSameValue() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()

        // The host takes the phone's pin, and its answer is slow to come back.
        let answered = await host.hold(.markAnswer)
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let pinning = Task { await phone.sync.step() }
        for await _ in answered { break }
        // Meanwhile the iPad unpins it, and on the phone it is unpinned and pinned again.
        ipad.change(PendingThreadChange(thread: a, pinned: false))
        await ipad.sync.step()
        phone.change(PendingThreadChange(thread: a, pinned: false))
        phone.change(PendingThreadChange(thread: a, pinned: true))
        await host.release(.markAnswer)
        _ = await pinning.value

        // The phone's last word is the newest.
        #expect(await host.thread(a)?.pinned == true)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.sync.pending.isEmpty)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.isPinned == true)
    }

    @Test func aPinAnsweredLateIsSettledWhenOnlyTheTitleWasChangedMeanwhile() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Old")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()

        let answered = await host.hold(.markAnswer)
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let pinning = Task { await phone.sync.step() }
        for await _ in answered { break }
        ipad.change(PendingThreadChange(thread: a, pinned: false))
        await ipad.sync.step()
        // Only renamed on the phone meanwhile: its pin was taken, and is not sent again.
        phone.change(PendingThreadChange(thread: a, title: "New"))
        await host.release(.markAnswer)
        _ = await pinning.value

        #expect(await host.thread(a)?.pinned == false)
        #expect(await host.thread(a)?.title == "New")
        #expect(phone.record(a)?.isPinned == false)
        #expect(phone.record(a)?.ref.title == "New")
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.calls.filter { $0.hasPrefix("thread.mark") }.count == 2)
    }

    @Test func aTitleRefusedForAThreadFromBeforeTheListGivesWayToTheHostsOwn() async throws {
        let host = FakeListHost()
        let old = await host.keepFromBefore("old", title: "Old")
        await host.makeReadOnly(old)
        let phone = Device(host, mac)
        await phone.sync.step()
        #expect(phone.record(old)?.revision == 0)

        phone.change(PendingThreadChange(thread: old, title: "New"))
        let step = await phone.sync.step()
        #expect(step.error == nil)
        #expect(phone.record(old)?.ref.title == "Old")
        #expect(phone.sync.pending.isEmpty)
        // Every thread was asked for again, of the same list, carrying nothing over.
        #expect(await host.calls.last == "threads.changes")
        #expect(phone.sync.state?.list == (await host.list))
        let calls = await host.calls.count
        await phone.sync.step(listNow: await host.list)
        #expect(await host.calls.count == calls)
    }

    @Test func aTitleRefusedForAThreadTheHostHasNoTitleForGivesWayToTheOneBefore() async throws {
        let host = FakeListHost()
        let untitled = await host.start("untitled"), named = await host.start("named")
        await host.makeReadOnly(untitled)
        await host.makeReadOnly(named)
        let phone = Device(host, mac)
        await phone.sync.step()
        // This device had a title of its own for one of them.
        var threads = phone.threads
        threads[threads.firstIndex { $0.id == named }!].ref.title = "Mine"
        phone.keep(threads)

        phone.change(PendingThreadChange(thread: untitled, title: "Rejected"))
        phone.change(PendingThreadChange(thread: named, title: "Rejected too"))
        // Renamed again before either goes: the title from before the first stays the one
        // to go back to.
        phone.change(PendingThreadChange(thread: named, title: "Rejected again"))
        await phone.sync.step()
        #expect(phone.record(untitled)?.ref.title == nil)
        #expect(phone.record(named)?.ref.title == "Mine")
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(named)?.title == nil)
    }

    @Test func aTitleGivenBackIsSavedBeforeThePendingTitleGoes() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        await host.makeReadOnly(a)
        let store = Device.scratchStore()
        let phone = Device(host, mac, store: store)
        await phone.sync.step()
        var threads = phone.threads
        threads[0].ref.title = "Mine"
        phone.keep(threads)

        phone.change(PendingThreadChange(thread: a, title: "Rejected"))
        phone.failSaves = true
        let failed = await phone.sync.step()
        #expect(failed.error as? HostSyncError == .notSaved)
        // Nothing lost: the title to go back to is still kept, also for after a restart.
        #expect(phone.record(a)?.ref.title == "Rejected")
        #expect(phone.store.loadSync(for: mac)?.pending.first?.titleBefore == "Mine")

        let again = Device(host, mac, store: store)
        await again.sync.step()
        #expect(again.record(a)?.ref.title == "Mine")
        #expect(again.sync.pending.isEmpty)
    }

    @Test func aTitleTheHostTookIsTheOneANewerRefusedTitleGivesWayTo() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        var threads = phone.threads
        threads[0].ref.title = "Mine"
        phone.keep(threads)

        // The host takes "Accepted", and its answer is slow to come back; meanwhile the
        // thread becomes one only read, and is renamed again here.
        let answered = await host.hold(.renameAnswer)
        phone.change(PendingThreadChange(thread: a, title: "Accepted"))
        let renaming = Task { await phone.sync.step() }
        for await _ in answered { break }
        await host.makeReadOnly(a)
        await host.goAwayAfterRefusing()
        phone.change(PendingThreadChange(thread: a, title: "Rejected"))
        await host.release(.renameAnswer)
        let step = await renaming.value

        // The fetch that would have put the host's title back could not be made: the
        // device shows the title the host took, not the one before it.
        #expect(step.error != nil)
        #expect(await host.thread(a)?.title == "Accepted")
        #expect(phone.record(a)?.ref.title == "Accepted")
        #expect(phone.sync.pending.isEmpty)
    }

    @Test func aTitleRecordedWhileTheMarksAreOnTheirWayIsTheOneSent() async throws {
        for refusing in [false, true] {
            let host = FakeListHost()
            let a = await host.start("a")
            let phone = Device(host, mac)
            await phone.sync.step()
            var threads = phone.threads
            threads[0].ref.title = "Mine"
            phone.keep(threads)
            if refusing {
                await host.makeReadOnly(a)
                await host.goAwayAfterRefusing()
            }

            phone.change(PendingThreadChange(thread: a, pinned: true, title: "First"))
            let answered = await host.hold(.markAnswer)
            let sending = Task { await phone.sync.step() }
            for await _ in answered { break }
            phone.change(PendingThreadChange(thread: a, title: "Second"))
            await host.release(.markAnswer)
            _ = await sending.value

            let renames = await host.calls.filter { $0.hasPrefix("session.rename") }
            #expect(renames == ["session.rename a Second"])
            #expect(phone.sync.pending.isEmpty)
            #expect(await host.thread(a)?.pinned == true)
            #expect(await host.thread(a)?.title == (refusing ? nil : "Second"))
            #expect(phone.record(a)?.ref.title == (refusing ? "Mine" : "Second"))
        }
    }

    @Test func aTitleTheHostRefusesGivesWayToTheHostsOwn() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Old"), b = await host.start("b", title: "Other")
        await host.makeReadOnly(a)
        await host.makeReadOnly(b)
        let phone = Device(host, mac)
        await phone.sync.step()

        phone.change(PendingThreadChange(thread: a, title: "New"))
        #expect(phone.record(a)?.ref.title == "New")
        let step = await phone.sync.step()
        #expect(step.error == nil)
        #expect(phone.record(a)?.ref.title == "Old")
        // With the host's sentence, for the device to say why.
        #expect(step.refusedTitles == [RefusedChange(thread: a, reason: "This thread is only for reading.")])
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.sync.state?.list == (await host.list))

        // Renamed while the list is on its way, so sent after it is merged.
        let arrived = await host.hold(.changes)
        await host.pin(a)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        phone.change(PendingThreadChange(thread: b, title: "Renamed"))
        await host.release(.changes)
        _ = await polling.value
        #expect(phone.record(b)?.ref.title == "Other")
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.sync.state?.list == (await host.list))
    }

    // MARK: Answers that stand for a fetch

    @Test func aPinTheHostAnswersWithTheThreadAsListedIsNotFetchedAgain() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        let calls = await host.calls.count

        phone.change(PendingThreadChange(thread: a, pinned: true))
        phone.change(PendingThreadChange(thread: b, archived: true))
        let step = await phone.sync.step(listNow: phone.sync.state?.list)
        #expect(step.merged && step.error == nil)
        // The two answers are all that moved the list: no fetch.
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a", "thread.mark b"])
        #expect(phone.sync.state?.list == (await host.list))
        #expect(phone.store.loadSync(for: mac)?.list == (await host.list))
        #expect(phone.record(a)?.revision == (await host.thread(a))?.revision)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.record(b)?.isArchived == true)
        #expect(phone.sync.pending.isEmpty)

        // And the next poll finds the list where this device has it.
        let after = await host.calls.count
        await phone.sync.step(listNow: await host.list)
        #expect(await host.calls.count == after)
    }

    @Test func aPinAnsweredAfterAnotherChangeOnTheHostIsFetchedAgain() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        let calls = await host.calls.count

        // Pinned on another device just before: the answer is two revisions on.
        await host.pin(b)
        phone.change(PendingThreadChange(thread: a, pinned: true))
        await phone.sync.step(listNow: phone.sync.state?.list)
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a", "threads.changes since 102"])
        #expect(phone.record(b)?.isPinned == true)
        #expect(phone.sync.state?.list == (await host.list))
    }

    @Test func aPinWithATitleOrARemovalIsFetchedAgainForTheyAreAnsweredWithNothing() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        let calls = await host.calls.count

        phone.change(PendingThreadChange(thread: a, pinned: true))
        phone.change(PendingThreadChange(thread: a, title: "Fix the login"))
        await phone.sync.step(listNow: phone.sync.state?.list)
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a", "session.rename a Fix the login", "threads.changes since 102"])

        let removing = await host.calls.count
        phone.change(PendingThreadChange(thread: b, pinned: true))
        phone.change(PendingThreadChange(thread: a, remove: true))
        await phone.sync.step(listNow: phone.sync.state?.list)
        #expect(Array(await host.calls.dropFirst(removing)) == ["thread.mark b", "thread.delete a", "threads.changes since 104"])
        #expect(phone.sync.state?.list == (await host.list))
    }

    // MARK: Removing

    @Test func aRemovalTheHostTakesLeavesEveryDeviceWithItsTranscriptAndImages() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()
        let image = phone.keepTranscriptWithAnImage(for: a)
        let ipadImage = ipad.keepTranscriptWithAnImage(for: a)

        phone.change(PendingThreadChange(thread: a, remove: true))
        // Hidden at once, and kept until the host says.
        #expect(phone.sync.removing == [a])
        #expect(phone.listed.isEmpty)
        #expect(phone.record(a) != nil)
        let step = await phone.sync.step()
        #expect(step.forgotten.map(\.id) == [a])
        #expect(await host.thread(a) == nil)
        #expect(phone.record(a) == nil)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.store.loadTranscript(for: phone.key(a)) == nil)
        #expect(phone.store.loadImage(image) == nil)

        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a) == nil)
        #expect(ipad.store.loadTranscript(for: ipad.key(a)) == nil)
        #expect(ipad.store.loadImage(ipadImage) == nil)
    }

    /// A thread whose send once failed keeps a journal of it. Removed, here or on another
    /// device, the thread must not come back as an unsent draft.
    @Test func aRemovalTheHostTakesErasesTheThreadsUnsentMessagesOnEveryDevice() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()
        let phoneJournal = SubmissionStore(threads: phone.store), ipadJournal = SubmissionStore(threads: ipad.store)
        let agent = Agent.ID(host: mac, name: "agent")
        func failedOnce(in thread: ThreadRef.ID?) -> SavedConversation {
            var conversation = SavedConversation(agent: agent)
            conversation.thread = thread.map { ThreadRef(id: $0, agent: agent) }
            var submission = SavedSubmission(id: UUID(), text: "lost", message: UserMessage(text: "lost"))
            submission.failure = TurnFailure(message: "The connection was lost.")
            conversation.submissions = [submission]
            return conversation
        }
        let phoneBound = failedOnce(in: a), unbound = failedOnce(in: nil)
        try phoneJournal.save(phoneBound)
        try phoneJournal.save(unbound)
        try ipadJournal.save(failedOnce(in: a))

        phone.change(PendingThreadChange(thread: a, remove: true))
        // Kept while the host has not said.
        #expect(phoneJournal.load().count == 2)
        await phone.sync.step()
        #expect(phone.record(a) == nil)
        // A draft never sent to any thread is not this removal's.
        #expect(phoneJournal.load() == [unbound])

        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a) == nil)
        #expect(ipadJournal.load().isEmpty)
    }

    @Test func aRefusedRemovalBringsTheThreadBackWithItsTranscriptAndImages() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Busy"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        let image = phone.keepTranscriptWithAnImage(for: a)
        await host.makeBusy(a)

        phone.change(PendingThreadChange(thread: a, remove: true))
        phone.change(PendingThreadChange(thread: b, pinned: true))
        #expect(phone.listed.map(\.id) == [b])
        let step = await phone.sync.step()
        // The refusal does not hold up what was asked after it.
        #expect(await host.thread(b)?.pinned == true)
        #expect(step.refused == [RefusedChange(thread: a, reason: "Claude Code is still working in this thread. Stop it, then remove it.")])
        #expect(step.forgotten.isEmpty)
        #expect(phone.sync.removing.isEmpty)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.listed.map(\.id) == [b, a])
        #expect(phone.record(a)?.ref.title == "Busy")
        #expect(phone.store.loadTranscript(for: phone.key(a)) != nil)
        #expect(phone.store.loadImage(image) != nil)
        #expect(await host.thread(a) != nil)
    }

    // MARK: Without a connection

    @Test func anOfflineRenameSurvivesAMergeAndReachesTheHostLater() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Old title")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()

        // A fetch is on its way when the connection goes, and the thread is renamed.
        let arrived = await host.hold(.changes)
        await host.pin(a)
        let fetching = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        await host.setReachable(false)
        phone.change(PendingThreadChange(thread: a, title: "New title"))
        await host.release(.changes)
        let merged = await fetching.value
        #expect(merged.merged)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.record(a)?.ref.title == "New title")

        let offline = await phone.sync.step()
        #expect(offline.error != nil)
        var renamed = PendingThreadChange(thread: a, title: "New title")
        renamed.titleBefore = "Old title"
        #expect(phone.sync.pending == [renamed])
        #expect(phone.record(a)?.ref.title == "New title")

        await host.setReachable(true)
        await phone.sync.step()
        #expect(await host.thread(a)?.title == "New title")
        #expect(phone.sync.pending.isEmpty)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.ref.title == "New title")
    }

    @Test func aFailedSaveOfTheRecordsLeavesTheRevisionWhereItWas() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        let before = try #require(phone.sync.state?.list)

        await host.pin(a)
        phone.failSaves = true
        let failed = await phone.sync.step(listNow: await host.list)
        #expect(failed.error as? HostSyncError == .notSaved)
        #expect(!failed.merged)
        #expect(phone.sync.state?.list == before)
        #expect(phone.store.loadSync(for: mac)?.list == before)
        #expect(phone.record(a)?.isPinned == false)

        // The next fetch starts again from there.
        phone.failSaves = false
        let retried = await phone.sync.step(listNow: await host.list)
        #expect(retried.merged)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.store.loadSync(for: mac)?.list == (await host.list))
        #expect(await host.calls.suffix(1) == ["threads.changes since \(before.revision)"])
    }

    @Test func aFailedSaveOfTheListsRevisionIsMergedAgainFromTheRevisionBefore() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        let before = try #require(phone.sync.state?.list)

        // The threads are saved, and then nothing more can be.
        await host.pin(a)
        phone.locksStoreAfterSaving = true
        let step = await phone.sync.step(listNow: await host.list)
        phone.lockStore(false)
        #expect(step.merged)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.sync.state?.list == before)
        #expect(phone.store.loadSync(for: mac)?.list == before)

        // Merging what was merged already changes nothing.
        let again = await phone.sync.step(listNow: await host.list)
        #expect(again.merged)
        #expect(await host.calls.suffix(1) == ["threads.changes since \(before.revision)"])
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.store.loadSync(for: mac)?.list == (await host.list))
    }

    @Test func aChangeSettledWhileNothingCouldBeSavedLeavesSyncJSONAtTheNextFetchWhateverItBrings() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.makeBusy(a)
        phone.change(PendingThreadChange(thread: a, remove: true))
        #expect(phone.store.loadSync(for: mac)?.pending == [PendingThreadChange(thread: a, remove: true)])

        // The host says no while the device can save nothing: the removal is done with
        // here, and sync.json still holds it.
        phone.lockStore(true)
        let refused = await phone.sync.step()
        phone.lockStore(false)
        #expect(refused.refused.map(\.thread) == [a])
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.store.loadSync(for: mac)?.pending == [PendingThreadChange(thread: a, remove: true)])

        // The next fetch brings nothing new, and saves what the last one could not: the
        // removal would otherwise be asked for again when the app next starts.
        let step = await phone.sync.step()
        #expect(step.merged && step.error == nil)
        #expect(phone.store.loadSync(for: mac)?.pending == [])
        #expect(phone.store.loadSync(for: mac) == phone.sync.state)
        #expect(await host.calls.filter { $0 == "thread.delete a" }.count == 1)
    }

    @Test func twoMacsOnOneDeviceKeepEachOthersThreadsInTheFileThroughEverySave() async throws {
        let mini = HostID(rawValue: "mini")
        let macHost = FakeListHost(), miniHost = FakeListHost()
        let a = await macHost.start("a"), b = await macHost.start("b")
        let x = await miniHost.start("x"), y = await miniHost.start("y")
        // One store for both, as the app's is: each Mac's threads are saved with the
        // other's, which the store gives from the list it kept.
        let store = Device.scratchStore()
        let onMac = Device(macHost, mac, store: store, keepsStore: true), onMini = Device(miniHost, mini, store: store)
        // What the file holds, as a store that never read it finds it, must be what the
        // store in use says it holds, and each Mac's threads the ones expected.
        func inFile(_ ofMac: Set<ThreadRef.ID>, _ ofMini: Set<ThreadRef.ID>, _ comment: Comment) {
            let read = ThreadStore(directory: store.directory).loadThreads()
            #expect(read == store.loadThreads(), comment)
            #expect(Set(read.filter { $0.ref.agent.host == mac }.map(\.id)) == ofMac, comment)
            #expect(Set(read.filter { $0.ref.agent.host == mini }.map(\.id)) == ofMini, comment)
            #expect(read.count == ofMac.count + ofMini.count, comment)
        }

        await onMac.sync.step()
        inFile([a, b], [], "the first Mac's list")
        await onMini.sync.step()
        inFile([a, b], [x, y], "the second Mac's list")

        await macHost.endTurn(a)
        await onMac.sync.step(listNow: await macHost.list)
        inFile([a, b], [x, y], "a turn on the first")
        #expect(onMac.record(a)?.isUnseen == true)

        onMini.change(PendingThreadChange(thread: x, pinned: true))
        inFile([a, b], [x, y], "a pin made here on the second")
        await onMini.sync.step()
        inFile([a, b], [x, y], "the pin sent")
        #expect(onMini.record(x)?.isPinned == true)
        #expect(onMac.record(a)?.isUnseen == true)

        onMac.change(PendingThreadChange(thread: b, remove: true))
        await onMac.sync.step()
        inFile([a], [x, y], "a removal on the first")

        // Steps that bring nothing write nothing, and the file is still right.
        await onMac.sync.step()
        await onMini.sync.step()
        inFile([a], [x, y], "nothing new on either")

        // Something else writes the file (y gone from it): the next save of the first
        // Mac's threads carries over what the file has now, not what the store kept.
        let other = ThreadStore(directory: store.directory)
        #expect(other.saveThreads(other.loadThreads().filter { $0.id != y }))
        await macHost.endTurn(a)
        await onMac.sync.step(listNow: await macHost.list)
        inFile([a], [x], "after the file was written by something else")

        // And the second Mac's list brings its thread back at the next full look.
        let c = await miniHost.start("c")
        await onMini.sync.step(listNow: await miniHost.list)
        inFile([a], [x, c], "a new thread on the second")
        #expect(onMini.record(x)?.isPinned == true)
    }

    @Test func aChangeThatCannotBeSavedIsNotKept() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.setReachable(false)
        phone.change(PendingThreadChange(thread: a, pinned: true))

        // Unpinned again, but the device can no longer save: the pin it saved stands, as
        // it would after the app starts again, and the caller leaves its list as it was.
        phone.lockStore(true)
        #expect(throws: HostSyncError.notSaved) { try phone.sync.record(PendingThreadChange(thread: a, pinned: false)) }
        phone.lockStore(false)
        #expect(phone.sync.pending == [PendingThreadChange(thread: a, pinned: true)])
        #expect(phone.store.loadSync(for: mac)?.pending == [PendingThreadChange(thread: a, pinned: true)])
        #expect(phone.record(a)?.isPinned == true)
    }

    @Test func aRemovalTakenWhoseSaveFailedIsForgottenAtTheNextStep() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        let image = phone.keepTranscriptWithAnImage(for: a)

        phone.change(PendingThreadChange(thread: a, remove: true))
        phone.failSaves = true
        let failed = await phone.sync.step()
        #expect(failed.error as? HostSyncError == .notSaved)
        #expect(await host.thread(a) == nil)
        // Still hidden, and kept until the device can let go of it.
        #expect(phone.record(a) != nil)
        #expect(phone.listed.isEmpty)
        #expect(phone.store.loadImage(image) != nil)

        phone.failSaves = false
        let step = await phone.sync.step()
        #expect(step.forgotten.map(\.id) == [a])
        #expect(phone.record(a) == nil)
        #expect(phone.sync.pending.isEmpty)
        #expect(phone.store.loadImage(image) == nil)
    }

    // MARK: The feature

    @Test func theFeatureGoingAwayAndComingBackKeepsWhatWasDoneMeanwhile() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b", title: "Before"), c = await host.start("c")
        let phone = Device(host, mac)
        await phone.sync.step()

        // An older bridge answers now.
        await host.setOffers(false)
        await phone.sync.step()
        #expect(!phone.sync.isSyncing)
        #expect(phone.store.loadSync(for: mac) == HostSyncState())
        let calls = await host.calls

        phone.change(PendingThreadChange(thread: a, pinned: true))
        phone.change(PendingThreadChange(thread: b, title: "Meanwhile"))
        phone.change(PendingThreadChange(thread: c, remove: true))
        #expect(phone.record(c) == nil)
        await phone.sync.step()
        #expect(await host.calls == calls)
        #expect(phone.sync.pending.count == 3)

        // The feature is back: what was done meanwhile reaches the host, the newest of it.
        await host.setOffers(true)
        await phone.sync.step()
        #expect(phone.sync.isSyncing)
        #expect(phone.sync.pending.isEmpty)
        #expect(await host.thread(a)?.pinned == true)
        #expect(await host.thread(b)?.title == "Meanwhile")
        #expect(await host.thread(c) == nil)
        #expect(phone.listed.map(\.id) == [b, a])
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.record(b)?.ref.title == "Meanwhile")
    }

    @Test func anAnswerAskedForBeforeTheFeatureWentIsNotMerged() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        phone.keep([phone.local(a, updated: .now, pinned: true)])

        // The first list is on its way when a connection finds the host without the feature.
        let arrived = await host.hold(.changes)
        let fetching = Task { await phone.sync.step() }
        for await _ in arrived { break }
        phone.sync.featureOffered(false)
        await host.release(.changes)
        let step = await fetching.value
        #expect(!step.merged)
        #expect(!phone.sync.isSyncing)
        #expect(phone.sync.state == nil)
        #expect(phone.record(a)?.isFromHost == false)
        #expect(phone.store.loadSync(for: mac) == nil)
    }

    @Test func aHostCountsAsSyncingBeforeItsGatewayReady() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let store = Device.scratchStore()
        let first = Device(host, mac, store: store)
        await first.sync.step()

        // The app starts again, before the host has said anything.
        await host.setOffers(nil)
        let again = Device(host, mac, store: store, keepsStore: true)
        #expect(again.sync.isSyncing)
        again.change(PendingThreadChange(thread: a, pinned: true))
        let calls = await host.calls
        let step = await again.sync.step()
        #expect(step.error == nil && !step.merged)
        #expect(again.sync.isSyncing)
        #expect(await host.calls == calls)
        #expect(again.sync.pending == [PendingThreadChange(thread: a, pinned: true)])

        await host.setOffers(true)
        await again.sync.step()
        #expect(await host.thread(a)?.pinned == true)
    }

    @Test func aStoppedSyncSendsAndSavesNothingMoreAlsoInAStepUnderWay() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        let saved = phone.store.loadSync(for: mac)

        // The device lets go of the host (edited, or removed from the app) while a step
        // is fetching the list.
        await host.endTurn(a)
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let arrived = await host.hold(.changes)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        phone.sync.stop()
        phone.store.saveSync(nil, for: mac)
        await host.release(.changes)
        _ = await polling.value
        #expect(phone.store.loadSync(for: mac) == nil)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(saved?.list != nil)

        // From then on nothing is sent, kept or saved.
        let calls = await host.calls.count
        #expect(try phone.sync.record(PendingThreadChange(thread: a, archived: true)) == false)
        await phone.sync.step()
        phone.lookingAt = a
        await phone.sync.seen(a)
        #expect(await host.calls.count == calls)
        #expect(phone.store.loadSync(for: mac) == nil)
    }

    @Test func aSyncStoppedWhileAChangeIsOnItsWaySendsNothingAfterIt() async throws {
        let host = FakeListHost()
        let a = await host.start("a", title: "Before")
        let b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        let calls = await host.calls.count

        // A pin, a title and a removal wait to go; the device lets go of the host while
        // the pin's answer is on its way back.
        phone.change(PendingThreadChange(thread: a, pinned: true))
        phone.change(PendingThreadChange(thread: a, title: "After stop"))
        phone.change(PendingThreadChange(thread: b, remove: true))
        let kept = phone.store.loadSync(for: mac)
        let answered = await host.hold(.markAnswer)
        let stepping = Task { await phone.sync.step() }
        for await _ in answered { break }
        phone.sync.stop()
        await host.release(.markAnswer)
        let step = await stepping.value

        // The pin had gone; the title, the removal and a fetch did not follow it.
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a"])
        #expect(await host.thread(a)?.title == "Before")
        #expect(await host.thread(b) != nil)
        #expect(step.error == nil)
        #expect(phone.store.loadSync(for: mac) == kept)
    }

    @Test func aSyncStoppedWhileAChangeGoesUnansweredSendsNothingAfterIt() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        let calls = await host.calls.count

        // The device lets go of the host while a pin is on its way, which is never answered.
        await host.neverAnswerMarks(of: [a])
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let arrived = await host.hold(.mark)
        let stepping = Task { await phone.sync.step() }
        for await _ in arrived { break }
        phone.sync.stop()
        await host.release(.mark)
        _ = await stepping.value
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a"])
    }

    @Test func stepsAskedForWhileOneRunsAreOneMoreThatFetchesWhenTheAsksDisagree() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b"), c = await host.start("c"), d = await host.start("d")
        let phone = Device(host, mac)
        await phone.sync.step()
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }

        // A step sends a pin and fetches; an archive made while the list is on its way
        // goes up after the merge, and its answer is slow.
        phone.change(PendingThreadChange(thread: a, pinned: true))
        let fetching = await host.hold(.changes)
        phone.sync.stepSoon(listNow: nil)
        for await _ in fetching { break }
        phone.change(PendingThreadChange(thread: c, archived: true))
        let marking = await host.hold(.markAnswer)
        await host.release(.changes)
        for await _ in marking { break }

        // Meanwhile a poll sees the list move (b pinned on another device), and a pin
        // here asks for a step with the list this device merged last.
        await host.pin(b)
        phone.sync.stepSoon(listNow: await host.list)
        phone.change(PendingThreadChange(thread: d, pinned: true))
        phone.sync.stepSoon(listNow: phone.sync.state?.list)
        await host.release(.markAnswer)
        for _ in 0..<200 where steps.count < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }

        // One step more, which fetched: the asks did not agree on where the list was.
        #expect(steps.count == 2)
        #expect(phone.record(b)?.isPinned == true)
        #expect(phone.record(d)?.isPinned == true)
        #expect(await host.thread(c)?.archived == true)
        #expect(phone.sync.pending.isEmpty)
        // Nothing more is asked for.
        try await Task.sleep(for: .milliseconds(50))
        #expect(steps.count == 2)
    }

    @Test func aChangeTheHostDoesNotAnswerHoldsUpNothingElse() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b"), c = await host.start("c")
        let phone = Device(host, mac)
        await phone.sync.step()

        // Removing a takes the host longer than the device waits, every time.
        await host.neverAnswerRemovals(true)
        phone.change(PendingThreadChange(thread: a, remove: true))
        phone.change(PendingThreadChange(thread: b, pinned: true))
        // Meanwhile c is pinned on another device, and a turn ends in it while it is looked at.
        await host.pin(c)
        await host.endTurn(c)
        phone.lookingAt = c
        let step = await phone.sync.step(listNow: await host.list)
        #expect(step.error != nil)
        #expect(await host.thread(b)?.pinned == true)
        #expect(phone.record(c)?.isPinned == true)
        #expect(await host.thread(c)?.unseen == false)
        // The removal waits for the next step, still hidden here, and is sent once.
        #expect(phone.sync.removing == [a])
        #expect(phone.sync.pending == [PendingThreadChange(thread: a, remove: true)])
        #expect(await host.calls.filter { $0 == "thread.delete a" }.count == 1)

        await host.neverAnswerRemovals(false)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a) == nil)
        #expect(phone.record(a) == nil)
        #expect(phone.sync.pending.isEmpty)
    }

    @Test func aThreadTakenUpHereWhileTheListIsOnItsWayAndRemovedElsewhereLeavesAtTheNextStep() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()

        // While the phone's fetch is on its way, it takes up t from the desk, and another
        // device removes t before the host answers.
        let arrived = await host.hold(.changes)
        await host.pin(a)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        let t = await host.start("t")
        phone.keep(phone.threads + [phone.local(t, updated: .now)])
        try await host.removeThread(t)
        await host.release(.changes)
        _ = await polling.value
        // Kept, as it may be newer than the answer; the list is asked for again.
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.record(t) != nil)

        await phone.sync.step(listNow: await host.list)
        #expect(phone.record(t) == nil)
        #expect(phone.sync.state?.list == (await host.list))
    }

    @Test func anArchiveAndAPinMadeAfterItOfflineEndArchivedAndPinned() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()

        await host.setReachable(false)
        phone.change(PendingThreadChange(thread: a, archived: true))
        // Pinned in Archived, which the sidebar offers.
        phone.change(PendingThreadChange(thread: a, pinned: true))
        await host.setReachable(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.archived == true)
        #expect(await host.thread(a)?.pinned == true)
        #expect(phone.record(a)?.isArchived == true)
        #expect(phone.record(a)?.isPinned == true)
        #expect(phone.sync.pending.isEmpty)
    }

    @Test func nothingIsSentToAHostThatNeverKeptTheList() async throws {
        let host = FakeListHost()
        await host.setOffers(false)
        let phone = Device(host, mac)
        let mine = ThreadRef.ID(rawValue: "mine")
        #expect(try !phone.sync.record(PendingThreadChange(thread: mine, pinned: true)))
        await phone.sync.step()
        await phone.sync.seen(mine)
        #expect(!phone.sync.isSyncing)
        #expect(phone.sync.state == nil)
        #expect(await host.calls.isEmpty)
        #expect(phone.store.loadSync(for: mac) == nil)
    }

    // MARK: Carrying marks over

    @Test func twoDevicesCarryTheirMarksOverAndNeitherClearsTheOthers() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b"), old = await host.start("old")
        await host.endTurn(a)
        // Each device's own list from before the host kept one.
        let phone = Device(host, mac), ipad = Device(host, mac)
        let now = await host.thread(a)?.updated ?? .now
        phone.keep([phone.local(a, updated: now, pinned: true), phone.local(b, updated: now), phone.local("never-on-the-host", updated: now)])
        ipad.keep([ipad.local(a, updated: now), ipad.local(b, updated: now, pinned: true), ipad.local(old, updated: now, archived: true)])

        await phone.sync.step()
        await ipad.sync.step()
        await phone.sync.step(listNow: await host.list)
        for device in [phone, ipad] {
            #expect(device.record(a)?.isPinned == true)
            #expect(device.record(b)?.isPinned == true)
            #expect(device.record(old)?.isArchived == true)
        }
        #expect(await host.thread(a)?.pinned == true)
        #expect(await host.thread(b)?.pinned == true)
        // A thread the host never had stays on the device that has it, and only there.
        #expect(phone.record(ThreadRef.ID(rawValue: "never-on-the-host"))?.isLocalOnly == true)
        #expect(ipad.record(ThreadRef.ID(rawValue: "never-on-the-host")) == nil)
    }

    // MARK: A list heard to move

    @Test func aListHeardToMoveIsFetchedALittleLaterOnceForAllThatWasHeardMeanwhile() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        // Long enough that a busy Mac does not reach the end of it before the test looks.
        phone.sync.listMoveWait = .milliseconds(500)
        await phone.sync.step()
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }
        let calls = await host.calls.count

        // Two threads the phone follows end their turns, and one is given a title.
        await host.endTurn(a)
        phone.sync.listMoved()
        await host.endTurn(b)
        phone.sync.listMoved()
        await host.retitle(a, "Fix the login")
        phone.sync.listMoved()
        // Not at once: a device looking at one of them has the time to say it saw it.
        #expect(await host.calls.count == calls)

        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(steps.count == 1)
        #expect(Array(await host.calls.dropFirst(calls)) == ["threads.changes since 102"])
        #expect(phone.record(a)?.isUnseen == true)
        #expect(phone.record(b)?.isUnseen == true)
        #expect(phone.record(a)?.ref.title == "Fix the login")
        // Nothing more is asked for.
        try await Task.sleep(for: .milliseconds(700))
        #expect(steps.count == 1)
        #expect(await host.calls.count == calls + 1)
    }

    @Test func aThreadSeenElsewhereMeanwhileIsSeenWhenTheListIsFetchedHere() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), mac2 = Device(host, mac)
        phone.sync.listMoveWait = .milliseconds(500)
        await phone.sync.step()
        await mac2.sync.step()
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }

        // The phone follows the thread; the Mac has it on screen, fetches at once and
        // says it saw it.
        await host.endTurn(a)
        phone.sync.listMoved()
        mac2.lookingAt = a
        await mac2.sync.step(listNow: nil)
        #expect(await host.thread(a)?.unseen == false)

        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(steps.count == 1)
        #expect(phone.record(a)?.revision == (await host.thread(a))?.revision)
        #expect(phone.record(a)?.isUnseen == false)
    }

    @Test func aFetchBegunAfterTheListWasHeardToMoveLeavesNoneToMake() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        phone.sync.listMoveWait = .milliseconds(500)
        await phone.sync.step()
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }

        await host.endTurn(a)
        phone.sync.listMoved()
        // The poll comes first, and fetches.
        await phone.sync.step(listNow: await host.list)
        #expect(phone.record(a)?.isUnseen == true)
        let calls = await host.calls.count

        try await Task.sleep(for: .milliseconds(800))
        #expect(await host.calls.count == calls)
        #expect(steps.isEmpty)
    }

    @Test func aListHeardToMoveFetchesNothingFromAHostThatDoesNotKeepItOrASyncStopped() async throws {
        let host = FakeListHost()
        await host.start("a")
        let never = Device(host, mac)
        never.sync.listMoveWait = .milliseconds(50)
        never.sync.listMoved()

        let stopped = Device(host, mac)
        stopped.sync.listMoveWait = .milliseconds(50)
        await stopped.sync.step()
        let calls = await host.calls.count
        await host.endTurn(ThreadRef.ID(rawValue: "a"))
        stopped.sync.listMoved()
        stopped.sync.stop()

        try await Task.sleep(for: .milliseconds(250))
        #expect(await host.calls.count == calls)
    }

    // MARK: The host saying something moved

    /// The poll the app runs when told (`HostModel.pollNow`): where the host's list is, as
    /// `sessions.activity` says, then a step with it. Counted.
    private func polls(_ device: Device, on host: FakeListHost) -> () -> Int {
        var polls = 0
        device.sync.poll = { [weak device] in
            polls += 1
            Task { @MainActor in device?.sync.stepSoon(listNow: await host.list) }
        }
        return { polls }
    }

    @Test func aHostSayingSomethingMovedIsPolledALittleLaterOnceForAllThatWasHeardMeanwhile() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        phone.sync.listMoveWait = .milliseconds(500)
        await phone.sync.step()
        let polled = polls(phone, on: host)
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }
        let calls = await host.calls.count

        // A turn ends in a thread the phone follows, another in one it does not, and the
        // host says so twice.
        await host.endTurn(a)
        phone.sync.listMoved()
        phone.sync.hostMoved()
        await host.endTurn(b)
        phone.sync.hostMoved()
        // Not at once: a device looking at one of them has the time to say it saw it.
        #expect(polled() == 0)
        #expect(await host.calls.count == calls)

        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        // One poll, which fetched once: the list had moved.
        #expect(polled() == 1)
        #expect(steps.count == 1)
        #expect(Array(await host.calls.dropFirst(calls)) == ["threads.changes since 102"])
        #expect(phone.record(a)?.isUnseen == true)
        #expect(phone.record(b)?.isUnseen == true)
        try await Task.sleep(for: .milliseconds(700))
        #expect(polled() == 1)
        #expect(await host.calls.count == calls + 1)

        // Heard again later: polled again, after the wait.
        phone.sync.hostMoved()
        for _ in 0..<300 where polled() < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(polled() == 2)
    }

    @Test func aChangeThisDeviceMadeAndTookFromItsAnswerFetchesNothingMoreWhenTheHostSaysTheListMoved() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        phone.sync.listMoveWait = .milliseconds(50)
        await phone.sync.step()
        let polled = polls(phone, on: host)
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }
        let calls = await host.calls.count

        phone.change(PendingThreadChange(thread: a, pinned: true))
        await phone.sync.step(listNow: phone.sync.state?.list)
        // The host says its list moved: by the pin, which the phone merged from its answer.
        phone.sync.hostMoved()
        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(polled() == 1)
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a"])
        #expect(phone.sync.state?.list == (await host.list))
    }

    @Test func aHostSayingSomethingMovedIsPolledBeforeTheListIsKeptAndNotOnceTheSyncIsStopped() async throws {
        let host = FakeListHost()
        await host.start("a")
        // Before the first merge: what is at work is still worth asking.
        let fresh = Device(host, mac)
        fresh.sync.listMoveWait = .milliseconds(50)
        let freshPolls = polls(fresh, on: host)
        fresh.sync.hostMoved()
        for _ in 0..<300 where freshPolls() == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(freshPolls() == 1)

        let stopped = Device(host, mac)
        stopped.sync.listMoveWait = .milliseconds(50)
        await stopped.sync.step()
        let stoppedPolls = polls(stopped, on: host)
        stopped.sync.hostMoved()
        stopped.sync.stop()
        try await Task.sleep(for: .milliseconds(250))
        #expect(stoppedPolls() == 0)
    }

    @Test func theSeenOfTheDeviceLookingAtAThreadIsTakenFromItsAnswerSoThePollItCausesFetchesNothing() async throws {
        let host = FakeListHost()
        await host.reportMoves(true)
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        phone.sync.listMoveWait = .milliseconds(50)
        await phone.sync.step()
        let polled = polls(phone, on: host)
        var steps: [SyncStep] = []
        phone.sync.stepped = { steps.append($0) }

        // A turn ends in a on the phone's screen: the list is fetched at once, and the merge
        // sends a's seen (HostModel's onTurnFinished). The seen moves the list, and the host
        // says so: the poll finds the list where the phone took it from the seen's answer.
        await host.endTurn(a)
        phone.lookingAt = a
        var calls = await host.calls.count
        await phone.sync.step(listNow: nil)
        phone.sync.hostMoved()
        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(polled() == 1)
        #expect(Array(await host.calls.dropFirst(calls)) == ["threads.changes since 102", "thread.mark a"])
        #expect(await host.thread(a)?.unseen == false)
        #expect(phone.sync.state?.list == (await host.list))
        #expect(phone.record(a)?.revision == (await host.thread(a))?.revision)
        #expect(phone.record(a)?.isUnseen == false)

        // b, whose turn ended out of sight, is opened from Finished: the same.
        phone.lookingAt = nil
        await host.endTurn(b)
        await phone.sync.step(listNow: await host.list)
        #expect(phone.record(b)?.isUnseen == true)
        calls = await host.calls.count
        steps = []
        phone.lookingAt = b
        await phone.sync.seen(b)
        phone.sync.hostMoved()
        for _ in 0..<300 where steps.isEmpty {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(polled() == 2)
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark b"])
        #expect(await host.thread(b)?.unseen == false)
        #expect(phone.sync.state?.list == (await host.list))
        #expect(phone.record(b)?.isUnseen == false)
    }

    @Test func theSeenOfTheDeviceLookingAtAThreadIsNotTakenFromItsAnswerFromAHostThatDoesNotSayWhenItsListMoved() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()

        // A turn ends in a on the phone's screen, as above: its seen's answer is not merged,
        // and the phone's next poll fetches the list it moved.
        await host.endTurn(a)
        phone.lookingAt = a
        var calls = await host.calls.count
        await phone.sync.step(listNow: nil)
        #expect(phone.sync.state?.list.map(\.revision) == 103)
        await phone.sync.step(listNow: await host.list)
        #expect(Array(await host.calls.dropFirst(calls)) == ["threads.changes since 102", "thread.mark a", "threads.changes since 103"])
        #expect(phone.record(a)?.isUnseen == false)

        // And b opened from Finished.
        phone.lookingAt = nil
        await host.endTurn(b)
        await phone.sync.step(listNow: await host.list)
        calls = await host.calls.count
        phone.lookingAt = b
        await phone.sync.seen(b)
        #expect(phone.sync.state?.list.map(\.revision) == 105)
        await phone.sync.step(listNow: await host.list)
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark b", "threads.changes since 105"])
        #expect(phone.sync.state?.list == (await host.list))
        #expect(phone.record(b)?.isUnseen == false)
    }

    @Test func aSeenTakenFromItsAnswerLeavesALaterTurnUnseenUnlessTheThreadIsStillLookedAt() async throws {
        let host = FakeListHost()
        await host.reportMoves(true)
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)

        // Another turn ends in a, which the phone has not fetched; a is opened from
        // Finished, and left before the seen's answer comes back.
        await host.endTurn(a)
        var calls = await host.calls.count
        var answered = await host.hold(.markAnswer)
        phone.lookingAt = a
        var opening = Task { await phone.sync.seen(a) }
        for await _ in answered { break }
        phone.lookingAt = nil
        await host.release(.markAnswer)
        await opening.value
        // The host left the later turn's mark, and the answer brings it here, with nothing
        // fetched: under Finished on every device.
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a"])
        #expect(await host.thread(a)?.unseen == true)
        #expect(phone.sync.state?.list == (await host.list))
        // Required: a seen only goes for a thread unseen here, and below waits for it.
        try #require(phone.record(a)?.isUnseen == true)

        // The same with a still on screen when the answer comes: the later turn is seen
        // too, and the host told at once with its revision.
        await host.endTurn(a)
        calls = await host.calls.count
        answered = await host.hold(.markAnswer)
        phone.lookingAt = a
        opening = Task { await phone.sync.seen(a) }
        for await _ in answered { break }
        await host.release(.markAnswer)
        await opening.value
        #expect(Array(await host.calls.dropFirst(calls)) == ["thread.mark a", "thread.mark a"])
        #expect(await host.thread(a)?.unseen == false)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(phone.sync.state?.list == (await host.list))
    }

    // MARK: Seen

    @Test func aThreadLookedAtWhenItsTurnEndsIsSeenOnEveryDevice() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await phone.sync.step()
        await ipad.sync.step()

        await host.endTurn(a)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.isUnseen == true)
        // On the phone's screen when it ended.
        phone.lookingAt = a
        await phone.sync.step(listNow: await host.list)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(await host.thread(a)?.unseen == false)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.isUnseen == false)
    }

    @Test func aThreadLookedAtWhileTheListIsOnItsWayIsSeenWhenItArrives() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)

        let arrived = await host.hold(.changes)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        phone.lookingAt = a
        await host.release(.changes)
        _ = await polling.value
        #expect(phone.record(a)?.isUnseen == false)
        #expect(await host.thread(a)?.unseen == false)
    }

    @Test func openingAThreadClearsItsUnseenMarkButNotOneFromALaterTurn() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)

        phone.lookingAt = a
        await phone.sync.seen(a)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(await host.thread(a)?.unseen == false)

        // A seen sent with the revision listed before another turn ended leaves that
        // turn's mark.
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)
        await host.endTurn(a)
        await phone.sync.seen(a)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(await host.thread(a)?.unseen == true)
    }

    @Test func aSeenAskedForBeforeAMergeGoesWithTheRevisionTheMergeGave() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)

        // Another turn ends while the list is on its way, and the thread is opened then;
        // the connection goes before either seen reaches the host.
        await host.endTurn(a)
        let arrived = await host.hold(.changes)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        phone.lookingAt = a
        let opening = Task { await phone.sync.seen(a) }
        await host.setReachable(false)
        await host.release(.changes)
        _ = await polling.value
        await opening.value
        #expect(phone.record(a)?.isUnseen == false)
        #expect(await host.thread(a)?.unseen == true)

        // Back: the seen that goes is the newer turn's, which clears it.
        await host.setReachable(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.unseen == false)
    }

    @Test func aSeenThatDidNotReachTheHostIsSentOnceItCanBeLookedAtStillOrNot() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b"), c = await host.start("c")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await host.endTurn(b)
        await host.endTurn(c)
        await phone.sync.step(listNow: await host.list)

        await host.setReachable(false)
        phone.lookingAt = a
        await phone.sync.seen(a)
        phone.lookingAt = b
        await phone.sync.seen(b)
        // Cleared here at once, and never saved to send later.
        #expect(phone.record(a)?.isUnseen == false)
        #expect(phone.sync.pending.isEmpty)
        // Dana moves on, and another turn ends in b, which this device has not shown.
        phone.lookingAt = nil
        await host.endTurn(b)
        await host.setReachable(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.unseen == false)
        #expect(await host.thread(b)?.unseen == true)
        #expect(await host.thread(c)?.unseen == true)
        #expect(phone.record(b)?.isUnseen == true)
    }

    @Test func aSeenLeavesATurnThatAStepUnderWayBringsOnceTheThreadIsNoLongerLookedAt() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)

        // a is opened while a fetch is on its way that brings the end of another turn,
        // and Dana has moved on by the time it arrives.
        await host.endTurn(a)
        let arrived = await host.hold(.changes)
        let polling = Task { await phone.sync.step(listNow: await host.list) }
        for await _ in arrived { break }
        phone.lookingAt = a
        let opening = Task { await phone.sync.seen(a) }
        for _ in 0..<200 where phone.record(a)?.isUnseen == true {
            try await Task.sleep(for: .milliseconds(5))
        }
        phone.lookingAt = nil
        await host.release(.changes)
        _ = await polling.value
        await opening.value
        // The turn they saw is seen; the one they did not is still under Finished everywhere.
        #expect(phone.record(a)?.isUnseen == true)
        #expect(await host.thread(a)?.unseen == true)
    }

    @Test func aSeenThatCouldNotBeSavedHereStillReachesTheHostAndComesBackWithItsList() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac), ipad = Device(host, mac)
        await host.endTurn(a)
        await phone.sync.step()
        await ipad.sync.step()
        #expect(phone.record(a)?.isUnseen == true)

        // The thread is looked at while the device cannot save: its own copy still has
        // the thread unseen, and the host is told all the same, since it was seen.
        phone.failSaves = true
        await phone.sync.seen(a)
        #expect(phone.record(a)?.isUnseen == true)
        #expect(await host.thread(a)?.unseen == false)

        // Which is what puts the device right: the host's list moved, so the next step
        // fetches it, and the thread is seen here as on every other device.
        phone.failSaves = false
        let step = await phone.sync.step(listNow: await host.list)
        #expect(step.merged && step.error == nil)
        #expect(phone.record(a)?.isUnseen == false)
        await ipad.sync.step(listNow: await host.list)
        #expect(ipad.record(a)?.isUnseen == false)
    }

    @Test func aSeenTheHostDoesNotAnswerHoldsUpNoOther() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await host.endTurn(b)
        await phone.sync.step(listNow: await host.list)

        // a's seen is never answered in time; b's, sent after it, goes all the same.
        await host.neverAnswerMarks(of: [a])
        phone.lookingAt = a
        await phone.sync.seen(a)
        phone.lookingAt = b
        await phone.sync.seen(b)
        #expect(await host.thread(a)?.unseen == true)
        #expect(await host.thread(b)?.unseen == false)

        await host.neverAnswerMarks(of: [])
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.unseen == false)
    }

    @Test func aSeenKeptUnderAnotherListIsNotSentToTheListThatReplacedIt() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await phone.sync.step(listNow: await host.list)

        // Seen while the Mac cannot be reached, then left.
        await host.setReachable(false)
        phone.lookingAt = a
        await phone.sync.seen(a)
        phone.lookingAt = nil
        // Meanwhile its bridge starts over in a new home, whose revisions start lower; a
        // turn this device never showed ends in a there, and the list goes on past the
        // revision the kept seen carries.
        await host.replaceList(revision: 1)
        await host.endTurn(a)
        await host.advance(by: 500)
        await host.setReachable(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.unseen == true)
        #expect(phone.record(a)?.isUnseen == true)
    }

    @Test func aSeenKeptUnderAnotherListIsIgnoredByTheListThatReplacedItAlsoBeforeAFetch() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        let phone = Device(host, mac)
        await phone.sync.step()
        await host.endTurn(a)
        await host.endTurn(b)
        await phone.sync.step(listNow: await host.list)

        // a is seen while the Mac cannot be reached, then left; the bridge starts over in
        // a new home, a turn this device never showed ends in a there, and the new list
        // goes on past the revision the kept seen carries.
        await host.setReachable(false)
        phone.lookingAt = a
        await phone.sync.seen(a)
        phone.lookingAt = nil
        await host.replaceList(revision: 1)
        await host.endTurn(a)
        await host.advance(by: 500)
        await host.setReachable(true)
        // b is opened before any step has fetched the new list: both seens go, and the
        // host takes neither, as they are the old list's.
        phone.lookingAt = b
        await phone.sync.seen(b)
        #expect(await host.calls.suffix(2) == ["thread.mark a", "thread.mark b"])
        #expect(await host.thread(a)?.unseen == true)
    }

    @Test func aSeenBeforeTheFirstConnectionOfALaunchReachesTheHostOnceConnected() async throws {
        let host = FakeListHost()
        let a = await host.start("a")
        let before = Device(host, mac, keepsStore: true)
        await before.sync.step()
        await host.endTurn(a)
        await before.sync.step(listNow: await host.list)

        // The app is launched again, and a is opened from Finished before the connection
        // is up; then Dana moves on.
        await host.setOffers(nil)
        let phone = Device(host, mac, store: before.store)
        phone.lookingAt = a
        await phone.sync.seen(a)
        #expect(phone.record(a)?.isUnseen == false)
        phone.lookingAt = nil
        #expect(await host.thread(a)?.unseen == true)

        // Connected, with the list where it was: nothing to fetch, and the seen goes.
        await host.setOffers(true)
        await phone.sync.step(listNow: await host.list)
        #expect(await host.thread(a)?.unseen == false)
        #expect(await host.calls.last == "thread.mark a")
    }

    @Test func aDeviceFromBeforeTheListTellsTheHostOfWhatItHadSeenOnItsFirstSync() async throws {
        let host = FakeListHost()
        let a = await host.start("a"), b = await host.start("b")
        // The host marked both unseen while this device's app could not say it had seen them.
        await host.endTurn(a)
        let seenAt = await host.thread(a)?.updated ?? .now
        await host.endTurn(b)
        let phone = Device(host, mac)
        // It saw a's last turn; b's ended after what it last saw of b.
        phone.keep([phone.local(a, updated: seenAt), phone.local(b, updated: seenAt)])
        await phone.sync.step()
        #expect(await host.thread(a)?.unseen == false)
        #expect(await host.thread(b)?.unseen == true)
        #expect(phone.record(a)?.isUnseen == false)
        #expect(phone.record(b)?.isUnseen == true)
        #expect(phone.sync.pending.isEmpty)
    }
}

// MARK: - A device

/// One device: its own store, and its sync steps with the host. The benchmarks
/// (SyncBenchmarks.swift) build theirs on it.
@MainActor
final class Device {
    let store: ThreadStore
    let sync: HostSync
    let host: HostID
    private let keepsStore: Bool
    /// The device cannot save its threads.
    var failSaves = false
    /// The thread on the device's screen.
    var lookingAt: ThreadRef.ID?
    /// Once the threads are saved, nothing more can be.
    var locksStoreAfterSaving = false

    init(_ fake: any ThreadSyncing, _ host: HostID, store: ThreadStore? = nil, keepsStore: Bool = false) {
        self.host = host
        self.store = store ?? Self.scratchStore()
        self.keepsStore = keepsStore
        sync = HostSync(host: host, store: self.store, remote: fake)
        sync.lookedAt = { [weak self] in self?.lookingAt }
        let save = sync.holdThreads
        sync.holdThreads = { [weak self] threads, forgotten in
            guard self?.failSaves != true else { return false }
            let saved = save(threads, forgotten)
            if self?.locksStoreAfterSaving == true { self?.lockStore(true) }
            return saved
        }
    }

    /// No file can be written in the store, or can again; those there still read.
    func lockStore(_ locked: Bool) {
        try? FileManager.default.setAttributes([.posixPermissions: locked ? 0o555 : 0o755], ofItemAtPath: store.directory.path)
        if !locked { locksStoreAfterSaving = false }
    }

    deinit {
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: store.directory.path)
        if !keepsStore { try? FileManager.default.removeItem(at: store.directory) }
    }

    static func scratchStore() -> ThreadStore {
        ThreadStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("portals-sync-\(UUID().uuidString)"))
    }

    var threads: [ThreadRecord] { store.loadThreads().filter { $0.ref.agent.host == host } }
    /// What the list shows: not a thread with a removal on its way.
    var listed: [ThreadRecord] { threads.filter { !sync.removing.contains($0.id) } }

    func record(_ id: ThreadRef.ID) -> ThreadRecord? { threads.first { $0.id == id } }
    func key(_ id: ThreadRef.ID) -> ThreadKey { ThreadKey(host: host, id: id) }

    /// A change the user made, as the app makes it: kept to send, then shown at once. A
    /// thread removed while the host does not keep the list goes at once, as today.
    func change(_ change: PendingThreadChange) {
        let kept = (try? sync.record(change)) ?? false
        var threads = threads
        guard let index = threads.firstIndex(where: { $0.id == change.thread }) else { return }
        if let pinned = change.pinned { threads[index].pinned = pinned ? true : nil }
        if let recent = change.recent { threads[index].recent = recent ? true : nil }
        if let archived = change.archived {
            threads[index].archived = archived ? true : nil
            if archived {
                threads[index].pinned = nil
                threads[index].recent = nil
            }
        }
        if let title = change.title { threads[index].ref.title = title }
        if change.remove == true, !(kept && sync.isSyncing) {
            store.deleteTranscript(for: key(change.thread))
            threads.remove(at: index)
        }
        keep(threads)
    }

    func keep(_ threads: [ThreadRecord]) {
        store.saveThreads(store.loadThreads().filter { $0.ref.agent.host != host } + threads)
    }

    func local(_ id: ThreadRef.ID, updated: Date, pinned: Bool = false, archived: Bool = false) -> ThreadRecord {
        ThreadRecord(ref: ThreadRef(id: id, agent: Agent.ID(host: host, name: "claude")), updatedAt: updated, pinned: pinned, archived: archived)
    }

    func local(_ id: String, updated: Date) -> ThreadRecord {
        local(ThreadRef.ID(rawValue: id), updated: updated)
    }

    /// A transcript with a message that sent an image, as the app keeps one.
    func keepTranscriptWithAnImage(for thread: ThreadRef.ID) -> AttachedImage.ID {
        let image = AttachedImage(filename: "photo.jpg")
        store.saveImage(Data([1, 2, 3]), id: image.id)
        var state = ThreadState()
        _ = state.messageSent("look", images: [image])
        store.saveTranscript(state.transcript, for: key(thread))
        return image.id
    }
}

// MARK: - A host that keeps the list

/// What the device's connection says when the host does not answer in time.
private struct TimedOut: Error {}

/// A host that keeps the list of threads as a Portals bridge does (thread_sync):
/// revisions, marks with archiving unpinning and the seen guard, removals it may refuse.
/// It says when its list moved (poll_now) only when told to; the tests say themselves when
/// it did (`HostSync.hostMoved`).
actor FakeListHost: ThreadSyncing, HostMoveReporting, RecentThreadKeeping {
    enum Call: Hashable {
        /// `changes` and `mark` wait on their way there; `markAnswer` once the mark is
        /// taken, on the answer's way back.
        case changes, mark, markAnswer, renameAnswer
    }

    private var listID = "3f9a1c0e7b2d4a65"
    private var revision = 100
    private var threads: [ThreadRef.ID: ListedThread] = [:]
    private var turnRevisions: [ThreadRef.ID: Int] = [:]
    private var removedAt: [ThreadRef.ID: Int] = [:]
    private var busy: Set<ThreadRef.ID> = []
    private var readOnly: Set<ThreadRef.ID> = []
    /// The connection goes right after a rename is refused.
    private var goesAwayAfterRefusing = false
    /// A removal takes longer than the device waits for an answer.
    private var removalsTimeOut = false
    /// So do marks of these threads.
    private var marksTimingOut: Set<ThreadRef.ID> = []
    private var clock = Date(timeIntervalSince1970: 1_791_320_000)
    private var offers: Bool? = true
    private var movesReported = false
    private var recentOffered = false
    private var reachable = true
    /// What went out to the host, in order.
    private(set) var calls: [String] = []
    private var holding: [Call: AsyncStream<Void>.Continuation] = [:]
    private var held: [Call: CheckedContinuation<Void, Never>] = [:]

    var list: ThreadListRevision { ThreadListRevision(id: listID, revision: revision) }

    func thread(_ id: ThreadRef.ID) -> ListedThread? { threads[id] }

    // MARK: What happens on the host

    @discardableResult
    func start(_ id: String, title: String? = nil) -> ThreadRef.ID {
        clock += 60
        revision += 1
        let thread = ThreadRef.ID(rawValue: id)
        threads[thread] = ListedThread(
            id: thread, agent: "claude", title: title, folder: "/Users/dev/app", created: clock, updated: clock, revision: revision
        )
        return thread
    }

    /// Starts many threads at once, as given but for their times and revisions, which
    /// are the host's: a list of any size, for the benchmarks.
    func start(_ listed: [ListedThread]) {
        for var thread in listed {
            clock += 60
            revision += 1
            thread.created = clock
            thread.updated = clock
            thread.revision = revision
            threads[thread.id] = thread
        }
    }

    /// A thread from before the list: stamped 0, so in no answer of what changed.
    @discardableResult
    func keepFromBefore(_ id: String, title: String) -> ThreadRef.ID {
        let thread = ThreadRef.ID(rawValue: id)
        threads[thread] = ListedThread(id: thread, agent: "claude", title: title, folder: "/Users/dev/app", created: clock, updated: clock, revision: 0)
        return thread
    }

    /// A turn ends: the thread moves up, is unseen and leaves the archive.
    func endTurn(_ id: ThreadRef.ID) {
        clock += 60
        revision += 1
        threads[id]?.updated = clock
        threads[id]?.unseen = true
        threads[id]?.archived = false
        threads[id]?.revision = revision
        turnRevisions[id] = revision
    }

    /// Pinned from somewhere else.
    func pin(_ id: ThreadRef.ID) {
        change(id) { $0.pinned = true }
    }

    /// Given a title by its agent, or on another device.
    func retitle(_ id: ThreadRef.ID, _ title: String) {
        change(id) { $0.title = title }
    }

    func makeBusy(_ id: ThreadRef.ID) { busy.insert(id) }
    func makeReadOnly(_ id: ThreadRef.ID) { readOnly.insert(id) }
    func goAwayAfterRefusing() { goesAwayAfterRefusing = true }
    func neverAnswerRemovals(_ late: Bool) { removalsTimeOut = late }
    func neverAnswerMarks(of threads: Set<ThreadRef.ID>) { marksTimingOut = threads }

    /// The list is replaced by another, as when the bridge starts over in a new home: its
    /// revisions start at `revision`, below the old ones. `without` are not on the new one.
    func replaceList(revision: Int, without: Set<ThreadRef.ID> = []) {
        listID = "a-new-home"
        self.revision = revision
        for id in without { threads[id] = nil }
        for id in threads.keys { threads[id]?.revision = revision }
        turnRevisions = [:]
        removedAt = [:]
    }

    /// Changes elsewhere move the list on.
    func advance(by changes: Int) { revision += changes }
    func setOffers(_ offers: Bool?) { self.offers = offers }
    func reportMoves(_ reports: Bool) { movesReported = reports }
    func offerRecent(_ offered: Bool) { recentOffered = offered }
    func setReachable(_ reachable: Bool) { self.reachable = reachable }

    /// The next such call waits on its way until `release`; the stream says it is there.
    func hold(_ call: Call) -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self)
        holding[call] = continuation
        return stream
    }

    func release(_ call: Call) {
        held.removeValue(forKey: call)?.resume()
    }

    // MARK: ThreadSyncing

    var syncsThreads: Bool? { offers }

    func threadListChanges(since: ThreadListRevision?) async throws -> ThreadListChanges {
        try send(since.map { "threads.changes since \($0.revision)" } ?? "threads.changes")
        await wait(.changes)
        if let since, since.id == listID, since.revision <= revision {
            return ThreadListChanges(
                list: list,
                threads: threads.values.filter { $0.revision > since.revision }.map(asListed).sorted { $0.updated > $1.updated },
                removed: removedAt.filter { $0.value > since.revision }.map(\.key)
            )
        }
        return ThreadListChanges(list: list, threads: threads.values.map(asListed).sorted { $0.updated > $1.updated }, removed: Array(removedAt.keys), isFull: true)
    }

    /// Answered, as the bridge does, with the thread as it was listed right after the marks.
    func markThread(_ id: ThreadRef.ID, _ marks: ThreadMarks) async throws -> ListedThread? {
        try send("thread.mark \(id.rawValue)")
        await wait(.mark)
        guard !marksTimingOut.contains(id) else { throw TimedOut() }
        guard threads[id] != nil else { throw ThreadSyncError.unknownThread }
        let turn = turnRevisions[id] ?? 0, now = revision
        change(id) { thread in
            if let archived = marks.archived { thread.archived = archived }
            if marks.archived == true {
                thread.pinned = false
                thread.recent = false
            }
            if let pinned = marks.pinned { thread.pinned = pinned }
            if let recent = marks.recent { thread.recent = recent }
            if marks.unseen == true { thread.unseen = true }
            let another = marks.list.map { $0 != listID } ?? false
            if marks.unseen == false, !another, !(marks.revision.map { turn > $0 || $0 > now } ?? false) { thread.unseen = false }
            if thread.preview == nil, let preview = marks.preview { thread.preview = preview }
        }
        let listed = threads[id].map(asListed)
        await wait(.markAnswer)
        return listed
    }

    func renameThread(_ thread: ThreadRef, to title: String) async throws {
        try send("session.rename \(thread.id.rawValue) \(title)")
        guard threads[thread.id] != nil else { throw ThreadSyncError.unknownThread }
        guard !readOnly.contains(thread.id) else {
            if goesAwayAfterRefusing { reachable = false }
            throw ThreadSyncError.refused("This thread is only for reading.")
        }
        change(thread.id) { $0.title = title }
        await wait(.renameAnswer)
    }

    func removeThread(_ id: ThreadRef.ID) throws {
        try send("thread.delete \(id.rawValue)")
        guard !removalsTimeOut else { throw TimedOut() }
        guard threads[id] != nil else { throw ThreadSyncError.unknownThread }
        guard !busy.contains(id) else { throw ThreadSyncError.refused("Claude Code is still working in this thread. Stop it, then remove it.") }
        threads[id] = nil
        revision += 1
        removedAt[id] = revision
    }

    /// A bridge from before `recent_threads` does not list the mark, though its file keeps it.
    private func asListed(_ thread: ListedThread) -> ListedThread {
        var thread = thread
        if !recentOffered { thread.recent = false }
        return thread
    }

    // MARK: RecentThreadKeeping

    var keepsRecentThreads: Bool? { offers.map { $0 && recentOffered } }

    // MARK: HostMoveReporting

    var reportsMoves: Bool? { offers.map { _ in movesReported } }

    nonisolated let hostMoves = AsyncStream<Void> { $0.finish() }

    // MARK: Helpers

    /// A call goes out, to a host that keeps the list and can be reached.
    private func send(_ call: String) throws {
        guard offers == true else { throw ThreadSyncError.unavailable }
        guard reachable else { throw AgentBackendError.notConnected }
        calls.append(call)
    }

    private func wait(_ call: Call) async {
        guard let arrived = holding.removeValue(forKey: call) else { return }
        await withCheckedContinuation { continuation in
            held[call] = continuation
            arrived.yield()
            arrived.finish()
        }
    }

    /// Changes a thread; the list's revision moves only when what it lists changed.
    private func change(_ id: ThreadRef.ID, _ edit: (inout ListedThread) -> Void) {
        guard var thread = threads[id] else { return }
        let before = thread
        edit(&thread)
        guard thread != before else { return }
        revision += 1
        thread.revision = revision
        threads[id] = thread
    }
}
