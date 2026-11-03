import Foundation

/// A host's sync steps, for a host that keeps the list of threads for every device
/// (`ThreadSyncing`, docs/sync-plan.md): the changes made here are sent, the host's list
/// is fetched when it moved, merged into the threads the device holds for the host
/// (`ThreadSync`), and saved. Steps run one at a time, so an answer never crosses a change
/// on its way.
///
/// A host syncs while `sync.json` holds a list for it: from its first merge until a
/// connection finds it without the feature. Not being connected, or not yet in this
/// launch, changes nothing.
@MainActor
public final class HostSync {
    public let host: HostID
    private let store: ThreadStore
    private let remote: any ThreadSyncing
    /// What `sync.json` holds for the host; nil for a host that never kept the list.
    public private(set) var state: HostSyncState?

    /// The host's threads as the device holds them now, hidden ones too: the store's,
    /// unless the device keeps them itself and says so here.
    public var heldThreads: () -> [ThreadRecord]
    /// Takes `threads` as the host's threads and saves them, letting go of the
    /// `forgotten` ones; false when they could not be saved, and then nothing more is
    /// saved for that step. Into the store, unless the device keeps them itself.
    public var holdThreads: (_ threads: [ThreadRecord], _ forgotten: [ThreadRecord]) -> Bool
    /// The thread looked at now, if it is the host's (notifications are held back for it):
    /// whatever finishes in it is seen. Asked when a merge is made, not when a step is.
    public var lookedAt: () -> ThreadRef.ID? = { nil }
    /// The threads read here before the host's list had their turn's end
    /// (`EndedOutOfSight.readHere`): seen as the one looked at is, by the merge that
    /// brings the end.
    public var readHere: () -> [ThreadRef.ID: TurnRead] = { [:] }
    /// Told what each step asked for with `stepSoon` did, for the device to show.
    public var stepped: (SyncStep) -> Void = { _ in }
    /// How long after the list is heard to move (`listMoved`) it is fetched, and after the
    /// host says something moved (`hostMoved`) it is polled.
    public var listMoveWait: Duration = .seconds(1)
    /// The host's poll step, which `hostMoved` runs: what is at work asked of the host
    /// (`sessions.activity`), then a step with the list as it gave it. The device's, which
    /// keeps what the host says is at work, its looks and its order.
    public var poll: () -> Void = {}
    /// The threads of the host this device keeps as recent itself (`RecentThreads`).
    public var heldRecent: () -> Set<ThreadRef.ID> = { [] }
    /// These of them are on the host from now on (`carryRecent`): this device lets go of them.
    public var recentCarried: (Set<ThreadRef.ID>) -> Void = { _ in }
    /// The host no longer keeps which threads are recent, or no longer has these threads
    /// (`ThreadMerge.recentReturned`): these were, and are this device's own from now on.
    public var recentReturned: (Set<ThreadRef.ID>) -> Void = { _ in }

    /// The step under way, which the next one waits for.
    private var last: Task<Void, Never>?
    /// Threads seen here that the host has not been told of yet, each with its revision
    /// as listed when it was seen.
    private var unsentSeen: [ThreadRef.ID: SeenThread] = [:]
    /// How many times a connection found the host without the feature: an answer asked
    /// for before the last of them is not merged.
    private var withdrawals = 0
    /// How many times each key of each thread's change was recorded here in this launch:
    /// an answer to a key sent before it was recorded again does not settle it, as the
    /// newer value may have come back to the one sent and still be newer than another
    /// device's.
    private var edits: [ThreadRef.ID: [PendingThreadChange.Key: Int]] = [:]
    /// The host said no to a change in this step, which the list is fetched again for.
    private var saidNo = false
    /// Stopped for good (`stop`): nothing more is sent or saved.
    private var isStopped = false
    /// `sync.json` holds `state` as it is: false after a save of it that failed, which
    /// the next fetch then makes again, whatever it brings.
    private var stateIsSaved = true
    /// A step asked for with `stepSoon` is under way; another was asked for meanwhile,
    /// with the list as the host gave it then (nil: fetched, whatever it is).
    private var isStepping = false
    private var isAskedAgain = false
    private var listAskedAgain: ThreadListRevision?
    /// Threads whose recent mark is being taken off (`expireRecent`), each with the list
    /// that was worked out from.
    private var expiring: [ThreadRef.ID: ThreadListRevision] = [:]
    /// The fetch asked for by `listMoved`, or the poll by `hostMoved`, waiting its time.
    private var fetchingSoon: Task<Void, Never>?
    /// The list was heard to move since the last fetch began.
    private var heardMoving = false
    /// The host said something moved since the last poll it asked for began.
    private var toldToPoll = false

    public init(host: HostID, store: ThreadStore, remote: any ThreadSyncing) {
        self.host = host
        self.store = store
        self.remote = remote
        state = store.loadSync(for: host)
        heldThreads = { store.loadThreads().filter { $0.ref.agent.host == host } }
        holdThreads = { threads, _ in
            store.saveThreads(store.loadThreads().filter { $0.ref.agent.host != host } + threads)
        }
    }

    /// The host keeps the list: the device shows the host's threads with the host's
    /// marks. So from the first merge on, before connecting too, until a connection finds
    /// the host without the feature.
    public var isSyncing: Bool { state?.list != nil }

    /// The host keeps which of its threads are recent, and has what this device held of
    /// them: the threads say so themselves (`ThreadRecord.recent`), before connecting too,
    /// until a connection finds the host without it.
    public var keepsRecent: Bool { isSyncing && state?.keepsRecent == true }

    /// The changes made here that the host has not taken yet, oldest first.
    public var pending: [PendingThreadChange] { state?.pending ?? [] }

    /// Threads with a removal on its way: hidden from the list until the host takes it
    /// (and they are forgotten) or refuses it (and they show again).
    public var removing: Set<ThreadRef.ID> {
        Set(pending.filter { $0.remove == true }.map(\.thread))
    }

    /// Keeps a change made here (a pin, an archive, a title, a removal) to send to the
    /// host, and saves it, before the caller changes its list. Archiving unpins, and takes
    /// the thread out of Recent on a host that keeps that. Kept for
    /// a host that keeps the list or kept it before: should it no longer, the change waits
    /// unsent until it does again. False for a host that never did: the change is then
    /// the device's own. Throws `HostSyncError.notSaved`, keeping nothing, when it could
    /// not be saved: the caller leaves its list as it was, since a change kept only in
    /// memory could be lost behind an older one that was saved.
    @discardableResult
    public func record(_ change: PendingThreadChange) throws -> Bool {
        guard !isStopped, let before = state else { return false }
        var state = before
        var change = change
        if change.archived == true {
            change.pinned = false
            if keepsRecent, change.recent == nil { change.recent = false }
        }
        if change.title != nil {
            change.titleBefore = heldThreads().first { $0.id == change.thread }?.ref.title ?? ""
        }
        if let index = state.pending.firstIndex(where: { $0.thread == change.thread }) {
            state.pending[index].take(change)
        } else {
            state.pending.append(change)
        }
        self.state = state
        guard saveState() else {
            self.state = before
            throw HostSyncError.notSaved
        }
        for key in change.keys {
            edits[change.thread, default: [:]][key, default: 0] += 1
        }
        return true
    }

    /// What a new connection to the host said about the feature. Without it, the list is
    /// let go of and the changes made here are kept, for when it comes back: the device
    /// then merges the list anew, carrying its marks over, and sends what it did meanwhile.
    public func featureOffered(_ offered: Bool) {
        guard !offered else { return }
        withdrawals += 1
        unsentSeen = [:]
        recentNotKept()
        guard state?.list != nil else { return }
        state?.list = nil
        saveState()
    }

    /// One sync step: the changes made here sent, then, when the host's list may have
    /// moved (`listNow`, as `sessions.activity` gave it, is not the list merged last, is
    /// unknown, or a change was just taken), what changed fetched, merged and saved. A
    /// change the host answered with the thread as it lists it now (a mark) needs no
    /// fetch when such answers are all that moved the list: they are merged as its answer
    /// would be (`take`). The thread looked at, when the merge finds it unseen, is marked
    /// seen here and on the host. Nothing is done for a host that has not said yet whether
    /// it keeps the list.
    @discardableResult
    public func step(listNow: ThreadListRevision? = nil) async -> SyncStep {
        await inTurn { await self.runStep(listNow: listNow) }
    }

    /// Asks for a step, without waiting for it: what it did goes to `stepped`. Asked for
    /// again while one is under way, one more follows it, however many asks came
    /// meanwhile, so a slow host does not gather a queue of them; it fetches the list when
    /// the asks did not agree on where the list is, as one of them saw it move.
    public func stepSoon(listNow: ThreadListRevision?) {
        guard !isStopped else { return }
        if isStepping {
            listAskedAgain = isAskedAgain && listAskedAgain != listNow ? nil : listNow
            isAskedAgain = true
            return
        }
        isStepping = true
        Task {
            var listNow = listNow
            while true {
                let step = await self.step(listNow: listNow)
                if !isStopped { stepped(step) }
                guard isAskedAgain, !isStopped else { break }
                isAskedAgain = false
                listNow = listAskedAgain
            }
            isStepping = false
        }
    }

    /// The host's list moved, as this device heard (a thread it follows ended a turn, or
    /// has a new title), which a poll would show only at its next step, and only while the
    /// sidebar is out: a step that fetches it, `listMoveWait` from now. What is heard
    /// meanwhile goes with it, and a fetch begun meanwhile leaves it nothing to fetch. The
    /// wait leaves a device looking at the thread the time to tell the host it saw it, so
    /// this device's list does not show the thread unseen in the meantime
    /// (docs/sync-plan.md, "How changes reach the other devices").
    public func listMoved() {
        guard !isStopped, isSyncing else { return }
        heardMoving = true
        stepAfterTheWait()
    }

    /// The host said something its poll reads moved (a Portals bridge's `poll.now`,
    /// feature `poll_now`): its list, a thread starting or stopping work or needing an
    /// answer, its looks or its order. `poll`, `listMoveWait` from now, its sidebar out or
    /// not, which fetches the list only when the host's answer says it moved from the one
    /// merged here: a change this device made and merged from its answer (a mark, a seen)
    /// fetches nothing more. What is heard meanwhile goes with it, a turn's end in a thread
    /// followed here (`listMoved`) too, and the wait leaves a device looking at a thread
    /// the time to tell the host it saw it, as for `listMoved`.
    public func hostMoved() {
        guard !isStopped else { return }
        toldToPoll = true
        stepAfterTheWait()
    }

    /// `listMoveWait` from the first of `listMoved` and `hostMoved` heard since the last
    /// such wait: the poll when the host said something moved, which asks where the list
    /// is; else a fetch, unless one began meanwhile.
    private func stepAfterTheWait() {
        guard fetchingSoon == nil else { return }
        fetchingSoon = Task {
            try? await Task.sleep(for: listMoveWait)
            fetchingSoon = nil
            guard !isStopped else { return }
            if toldToPoll {
                toldToPoll = false
                // The host's answer says where the list is: whatever was heard of it goes with that.
                heardMoving = false
                poll()
            } else if heardMoving {
                stepSoon(listNow: nil)
            }
        }
    }

    /// Stops for good, for a device that let go of the host (it was edited, or removed
    /// from the app): from now on nothing is sent, and nothing is saved, also by a step
    /// under way, which would otherwise write over what another took over or erased.
    public func stop() {
        isStopped = true
        unsentSeen = [:]
        fetchingSoon?.cancel()
        fetchingSoon = nil
    }

    /// The thread is looked at: whatever finished in it has been seen. Cleared here at
    /// once, and on the host as soon as it can be told: a seen that does not reach it (the
    /// host not connected yet in this launch, or not reachable) is sent again at each step
    /// until it does, looked at still or not, for as long as the app runs. It goes with
    /// the thread's revision as listed here, so the host leaves a turn that ended after
    /// it, which this device never showed. It is never saved.
    public func seen(_ thread: ThreadRef.ID) async {
        guard !isStopped, isSyncing else { return }
        var threads = heldThreads()
        guard let index = threads.firstIndex(where: { $0.id == thread }), threads[index].isUnseen else { return }
        threads[index].unseen = nil
        let record = threads[index]
        _ = holdThreads(threads, [])
        if let index = state?.pending.firstIndex(where: { $0.thread == thread }), state?.pending[index].unseen != nil {
            settle(PendingThreadChange(thread: thread, unseen: state?.pending[index].unseen))
        }
        guard let revision = record.revision, let list = state?.list?.id, !record.isLocalOnly else { return }
        // With the revision as listed now, of the list merged last: a turn a step under way
        // brings, which ended after it, stays unseen, unless the thread is still looked at
        // when that step merges it (which then has a seen of its own, with the newer
        // revision); and a list that replaced that one ignores it.
        keepSeen(SeenThread(thread: thread, revision: revision, list: list))
        await inTurn {
            // A merge of its answer shows in the threads it saves; it refuses and forgets nothing.
            var step = SyncStep()
            await self.sendSeen(&step)
        }
    }

    /// Keeps a seen to send; a merge may have kept one for the thread with a newer revision.
    private func keepSeen(_ seen: SeenThread) {
        if let kept = unsentSeen[seen.thread], kept.list == seen.list, kept.revision > seen.revision { return }
        unsentSeen[seen.thread] = seen
    }

    // MARK: Steps

    /// Runs `work` after every step asked for before it.
    private func inTurn<Value: Sendable>(_ work: @escaping @Sendable @MainActor () async -> Value) async -> Value {
        let previous = last
        let task = Task { @MainActor in
            await previous?.value
            return await work()
        }
        last = Task { @MainActor in _ = await task.value }
        return await task.value
    }

    private func runStep(listNow: ThreadListRevision?) async -> SyncStep {
        var step = SyncStep()
        guard !isStopped, let offered = await remote.syncsThreads, !isStopped else { return step }
        featureOffered(offered)
        guard offered else { return step }
        let offersRecent = await (remote as? any RecentThreadKeeping)?.keepsRecentThreads == true
        guard !isStopped else { return step }
        if !offersRecent { recentNotKept() }
        do {
            saidNo = false
            let merged = state?.list
            let sent = try await sendPending(&step)
            if sent.tried || listNow == nil || listNow != merged {
                // Where the poll found the list as merged here, only what was just sent
                // moved it, and the host's answers to that may say where it is now.
                let moved = listNow == nil || listNow != merged
                if try moved || !take(sent, &step) {
                    try await fetch(&step)
                }
                if offersRecent { try carryRecent() }
                // What a carry-over added, or what changed again while on its way, goes
                // up at once; the next step fetches the list it moved, unless the host
                // said no to some of it, which is put right now.
                saidNo = false
                _ = try await sendPending(&step)
                if saidNo { try await fetch(&step) }
            } else if offersRecent, try carryRecent() {
                _ = try await sendPending(&step)
            }
            await sendSeen(&step)
            step.listIsCurrent = step.error == nil
        } catch is Stopped {
            // Let go of meanwhile: nothing more is sent or saved.
        } catch {
            step.error = error
        }
        return step
    }

    /// The sync was stopped while a call was on its way: the step goes no further.
    private struct Stopped: Error {}

    private func goOn() throws {
        if isStopped { throw Stopped() }
    }

    /// What sending the changes made here did: whether any was tried, so the host's list
    /// may have moved, and the threads as the host listed them in its answers to marks, in
    /// the order it answered. `unsaid`: something was tried whose answer does not say where
    /// the list is now (a title, a removal, a change the host said no to or did not answer,
    /// an answer that could not be read), which only a fetch can say.
    private struct Sent {
        var tried = false
        var unsaid = false
        var listed: [ListedThread] = []
        /// `HostSync.withdrawals` when they were sent.
        var withdrawals = 0
    }

    /// Sends the changes made here, oldest first, one at a time. A change the host
    /// refuses, or whose thread it does not know, is dropped: the fetch that follows shows
    /// what the host has. One the host did not answer (the connection went, or the host
    /// took too long) waits for the next step, and so does whatever else was changed in
    /// its thread; the other threads' changes, the fetch and the seen go on, so one change
    /// that keeps timing out holds up nothing else. Throws only when the device cannot
    /// save, or was stopped.
    private func sendPending(_ step: inout SyncStep) async throws -> Sent {
        var tried: Set<ThreadRef.ID> = []
        var sent = Sent(withdrawals: withdrawals)
        while !isStopped, let change = state?.pending.first(where: { !tried.contains($0.thread) && !step.unanswered.contains($0.thread) }) {
            tried.insert(change.thread)
            sent.tried = true
            do {
                if change.remove == true {
                    sent.unsaid = true
                    try await sendRemoval(of: change.thread, &step)
                    continue
                }
                if let marks = change.marks {
                    let listed = try await send(change.markPart, &step) { try await self.remote.markThread(change.thread, marks) }
                    if let listed { sent.listed.append(listed) } else { sent.unsaid = true }
                }
                // The title as it is now: it may have been changed again while the marks
                // were on their way.
                if let title = state?.pending.first(where: { $0.thread == change.thread })?.title {
                    sent.unsaid = true
                    let renamed = PendingThreadChange(thread: change.thread, title: title)
                    if let ref = heldThreads().first(where: { $0.id == change.thread })?.ref {
                        try await send(renamed, &step) {
                            try await self.remote.renameThread(ref, to: title)
                            return nil
                        }
                    } else {
                        // Not a thread held here: there is nothing to rename.
                        settle(renamed)
                    }
                }
            } catch let error where !(error is Stopped || error is HostSyncError) {
                try goOn()
                sent.unsaid = true
                step.unanswered.insert(change.thread)
                step.error = step.error ?? error
            }
        }
        return sent
    }

    /// Sends one part of a change, which then leaves the pending changes, except a key
    /// recorded again here while it was on its way: that one is sent again. A title the
    /// host refuses goes into `step` with the host's sentence. Gives what the host
    /// answered with (`call`'s thread as it lists it), nil when it said no.
    @discardableResult
    private func send(
        _ part: PendingThreadChange, _ step: inout SyncStep, by call: () async throws -> ListedThread?
    ) async throws -> ListedThread? {
        let before = edits[part.thread] ?? [:]
        var refused = false
        var reason: String?
        var listed: ListedThread?
        do {
            listed = try await call()
        } catch let error as ThreadSyncError where error != .unavailable {
            try goOn()
            // Dropped, and the list fetched again from before the thread's last listing,
            // so what it shows here gives way to what the host has.
            fetchAgain(part.thread)
            refused = true
            if case let .refused(sentence) = error { reason = sentence }
        }
        try goOn()
        let after = edits[part.thread] ?? [:]
        let settled = part.keys.reduce(part) { taken, key in after[key] == before[key] ? taken : taken.leavingOut(key) }
        if refused, let title = settled.title, let entry = state?.pending.first(where: { $0.thread == part.thread }),
           entry.title == title, let titleBefore = entry.titleBefore {
            // A title the host said no to gives way to the one from before it, which the
            // fetch that follows keeps where the host lists the thread with none. Saved
            // before the pending title goes, which is what it would be restored from.
            var threads = heldThreads()
            if let index = threads.firstIndex(where: { $0.id == part.thread }) {
                threads[index].ref.title = titleBefore.isEmpty ? nil : titleBefore
                guard holdThreads(threads, []) else { throw HostSyncError.notSaved }
            }
            if let reason { step.refusedTitles.append(RefusedChange(thread: part.thread, reason: reason)) }
        }
        settle(settled)
        if !refused, let title = part.title, let index = state?.pending.firstIndex(where: { $0.thread == part.thread }),
           state?.pending[index].title != nil {
            // The host took this title while a newer one waits: should it say no to the
            // newer one, this is the title to go back to.
            state?.pending[index].titleBefore = title
            saveState()
        }
        return refused ? nil : listed
    }

    /// Moves the list merged last back to before `thread` was last listed, so the next
    /// fetch lists it again as the host has it: a change the host said no to shows here
    /// until then, and merging again what was merged already changes nothing. A thread
    /// listed at revision 0 (one from before the list) is in no answer of what changed,
    /// so then every thread is asked for again.
    private func fetchAgain(_ thread: ThreadRef.ID) {
        saidNo = true
        guard let list = state?.list else { return }
        let listed = heldThreads().first { $0.id == thread }?.revision ?? 0
        let since = listed > 0 ? min(list.revision, listed - 1) : -1
        guard since < list.revision else { return }
        state?.list?.revision = since
        saveState()
    }

    /// Asks the host to take a thread off its list. Once it has, the thread is forgotten
    /// here too; a refusal brings it back, with the host's sentence for the device to show.
    private func sendRemoval(of thread: ThreadRef.ID, _ step: inout SyncStep) async throws {
        let sent = PendingThreadChange(thread: thread, remove: true)
        do {
            try await remote.removeThread(thread)
        } catch let ThreadSyncError.refused(reason) {
            try goOn()
            settle(sent)
            step.refused.append(RefusedChange(thread: thread, reason: reason))
            return
        } catch ThreadSyncError.unknownThread {
            try goOn()
            // Removed already, or never there: the fetch that follows says which.
            settle(sent)
            return
        }
        try goOn()
        var threads = heldThreads()
        if let index = threads.firstIndex(where: { $0.id == thread }) {
            let record = threads.remove(at: index)
            guard holdThreads(threads, [record]) else { throw HostSyncError.notSaved }
            store.deleteTranscript(for: record.key)
            SubmissionStore(threads: store).removeConversations(boundTo: [record.key])
            step.forgotten.append(record)
        }
        state?.pending.removeAll { $0.thread == thread }
        saveState()
    }

    /// Fetches what changed since the list merged last, and merges it (`merge`).
    private func fetch(_ step: inout SyncStep) async throws {
        try goOn()
        // What was heard of the list until now, this answer brings.
        heardMoving = false
        let since = state?.list, withdrawals = withdrawals
        let asking = Set(heldThreads().map(\.id))
        // Every thread again, of the same list, when a revision below 0 asks for it.
        let answer = try await remote.threadListChanges(since: since.flatMap { $0.revision >= 0 ? $0 : nil })
        try goOn()
        // A connection found the host without the feature meanwhile: this is from before.
        guard self.withdrawals == withdrawals else { return }
        try merge(answer, since: since, asking: asking, &step)
    }

    /// Takes the threads the host answered marks with as the answer to a fetch, when they
    /// are all that moved the list since it was merged here: each one revision on from the
    /// one before, the first from the list merged last, so another device's change would
    /// show as a revision missing. False when something else was sent that only a fetch
    /// can say the outcome of, or the list moved otherwise. (A list the host replaced is
    /// one it started on, which the app reconnects to and asks where the list is.)
    private func take(_ sent: Sent, _ step: inout SyncStep) throws -> Bool {
        guard !sent.unsaid, !sent.listed.isEmpty, sent.withdrawals == withdrawals,
              let since = state?.list, since.revision >= 0 else { return false }
        for (offset, thread) in sent.listed.enumerated() where thread.revision != since.revision + offset + 1 {
            return false
        }
        try goOn()
        let answer = ThreadListChanges(
            list: ThreadListRevision(id: since.id, revision: since.revision + sent.listed.count), threads: sent.listed
        )
        try merge(answer, since: since, asking: Set(heldThreads().map(\.id)), &step)
        return true
    }

    /// Merges what the host said changed since `since` (`asking`: the threads held when it
    /// was asked) and saves it: the threads first, and only once they are saved, the
    /// list's revision. When either save fails, the next fetch starts again from the
    /// revision held before, and merging what was merged already changes nothing.
    private func merge(_ answer: ThreadListChanges, since: ThreadListRevision?, asking: Set<ThreadRef.ID>, _ step: inout SyncStep) throws {
        let before = heldThreads()
        let merge = ThreadSync.merge(
            answer, into: before, heldWhenAsking: asking, pending: state?.pending ?? [], list: since,
            host: host, lookedAt: lookedAt(), readHere: readHere()
        )
        // Threads the merge left as the device holds them are not saved again.
        if merge.threads != before || !merge.forgotten.isEmpty {
            guard holdThreads(merge.threads, merge.forgotten) else { throw HostSyncError.notSaved }
        }
        if !merge.recentReturned.isEmpty { recentReturned(merge.recentReturned) }
        // A thread taken up or started here while the answer was on its way, which the
        // answer says was removed (by another device, meanwhile): it was kept, as it may
        // be newer than the answer, so this list is asked for again, from where it was,
        // and the next answer says whether it is still removed.
        let held = Set(merge.threads.map(\.id))
        let unsure = answer.removed.contains { !asking.contains($0) && held.contains($0) }
        var list = merge.list
        if unsure { list.revision = since?.id == list.id ? min(since?.revision ?? -1, list.revision) : -1 }
        // Nor is a list and pending changes that are as sync.json has them.
        let merged = HostSyncState(list: list, pending: merge.pending, keepsRecent: state?.keepsRecent)
        if merged != state || !stateIsSaved {
            state = merged
            if !saveState() { state?.list = since }
        }
        for record in merge.forgotten {
            store.deleteTranscript(for: record.key)
        }
        SubmissionStore(threads: store).removeConversations(boundTo: Set(merge.forgotten.map(\.key)))
        step.merged = true
        step.forgotten += merge.forgotten
        // Seens kept from another list (a new bridge home) say nothing of this one: their
        // revisions are not this list's.
        if merge.list.id != since?.id { unsentSeen = [:] }
        for seen in merge.seen {
            keepSeen(seen)
        }
    }

    /// Tells the host of the threads seen here, once a connection has said it keeps the
    /// list. One it takes, or says no to (a thread it no longer has), is done with; one
    /// that could not be sent waits for the next step, and the others go on.
    ///
    /// From a host that says when something moved (`HostMoveReporting`, a Portals
    /// bridge's `poll_now`) the answer is merged as a mark's is (`take`): the seen moves
    /// the list, the host tells this device so too, and its poll would otherwise fetch at
    /// every seen what the answer says. A seen from before a later turn brings that turn,
    /// unseen unless the thread is still looked at, which then sends a seen of its own,
    /// with the newer revision, at once. From any other host the answer is not merged: no
    /// fetch follows a seen, and the list it moved comes with the next one, with whatever
    /// else moved it by then, in one save of the threads.
    private func sendSeen(_ step: inout SyncStep) async {
        let withdrawals = withdrawals
        guard !isStopped, !unsentSeen.isEmpty, await remote.syncsThreads == true else { return }
        let takesAnswers = await (remote as? any HostMoveReporting)?.reportsMoves == true
        var tried: Set<SeenThread> = []
        while let seen = unsentSeen.values.sorted(by: { $0.thread.rawValue < $1.thread.rawValue }).first(where: { !tried.contains($0) }) {
            tried.insert(seen)
            guard !isStopped, self.withdrawals == withdrawals else { return }
            let listed: ListedThread?
            do {
                listed = try await remote.markThread(seen.thread, ThreadMarks(unseen: false, revision: seen.revision, list: seen.list, turn: seen.turn))
            } catch ThreadSyncError.refused(_), ThreadSyncError.unknownThread {
                // Nothing the host would take: dropped.
                listed = nil
            } catch {
                // Not sent: again at the next step.
                continue
            }
            if unsentSeen[seen.thread] == seen { unsentSeen[seen.thread] = nil }
            guard takesAnswers, let listed else { continue }
            do {
                // Where something else moved the list too, the poll fetches it.
                _ = try take(Sent(listed: [listed], withdrawals: withdrawals), &step)
            } catch is Stopped {
                return
            } catch {
                // Not saved here: the list stays where it was, and the poll fetches it.
                step.error = step.error ?? error
            }
        }
    }

    // MARK: Recent threads

    /// One-time carry-over of what this device holds as recent, at the first step that has
    /// a list from a host keeping them, or later for a key that has since come to name a
    /// thread the host lists: each key that names a thread on the host's list goes up as a
    /// pending mark, and this device lets go of it, or only lets go of it for a thread
    /// archived, which is out of Recent. A thread kept here only, or one this device holds
    /// nothing of, stays the device's own. Only `true` goes up, which adds to
    /// whatever another device carried and clears nothing, and marking twice changes
    /// nothing on the host. True when something new is waiting to be sent.
    @discardableResult
    private func carryRecent() throws -> Bool {
        try goOn()
        guard var state, state.list != nil else { return false }
        let held = heldRecent()
        guard state.keepsRecent != true || !held.isEmpty else { return false }
        let wasKept = state.keepsRecent == true
        var threads = heldThreads()
        var carried: Set<ThreadRef.ID> = []
        var newlyMarked = false
        for index in threads.indices where held.contains(threads[index].id) && !threads[index].isLocalOnly {
            let thread = threads[index].id
            carried.insert(thread)
            // Archived, it is out of Recent: the host need hear nothing of it.
            guard !threads[index].isRecent, !threads[index].isArchived else { continue }
            threads[index].recent = true
            newlyMarked = true
            if let change = state.pending.firstIndex(where: { $0.thread == thread }) {
                if state.pending[change].recent == nil { state.pending[change].recent = true }
            } else {
                state.pending.append(PendingThreadChange(thread: thread, recent: true))
            }
        }
        // The pending marks first: stopped here, they go up all the same, and the keys are
        // still held. A thread saved as marked with nothing pending would look carried at the
        // next step, its key let go of and the mark never sent.
        if newlyMarked || !wasKept {
            state.keepsRecent = true
            let before = self.state
            self.state = state
            guard saveState() else {
                self.state = before
                throw HostSyncError.notSaved
            }
        }
        if newlyMarked, !holdThreads(threads, []) { throw HostSyncError.notSaved }
        if !carried.isEmpty { recentCarried(carried) }
        return newlyMarked
    }

    /// A connection found the host not keeping which threads are recent, having kept them:
    /// what it marked is this device's own again, and nothing of it is sent to it. Should
    /// it keep them again, this device's go up again (`carryRecent`).
    private func recentNotKept() {
        guard var state, state.keepsRecent == true else { return }
        var threads = heldThreads()
        let marked = Set(threads.filter(\.isRecent).map(\.id))
        for index in threads.indices where threads[index].isRecent {
            threads[index].recent = nil
        }
        state.keepsRecent = nil
        state.pending = state.pending.compactMap { change in
            let left = change.leavingOut(.recent)
            return left.isEmpty ? nil : left
        }
        self.state = state
        saveState()
        if !marked.isEmpty {
            _ = holdThreads(threads, [])
            recentReturned(marked)
        }
    }

    /// Takes the recent mark off threads past what every device keeps
    /// (`RecentThreads.pastKept`). Not a change kept to send, as a person's dismissal is: it
    /// is worked out from the list as merged now, and says nothing of the list a later
    /// connection finds, where another device may have used the thread since. So one the
    /// host does not take stays as it is, and is worked out again from the list then. Nor
    /// does it outlive that list: a step ahead of it that moved the list may have overturned
    /// it (the thread's new turn, from another device), and what that step merged is worked
    /// out afresh.
    public func expireRecent(_ threads: [ThreadRef.ID]) async {
        guard !isStopped, keepsRecent, let list = state?.list else { return }
        let asked = threads.filter { expiring[$0] != list }
        guard !asked.isEmpty else { return }
        for thread in asked { expiring[thread] = list }
        defer { for thread in asked where expiring[thread] == list { expiring[thread] = nil } }
        await inTurn { await self.sendExpired(asked, from: list) }
    }

    /// Whether marking a thread, or taking its mark off, is news: a thread used while its
    /// mark is on its way off says so, or it would lose the mark as it is used.
    public func changesRecent(_ recent: Bool, of record: ThreadRecord) -> Bool {
        record.isRecent != recent || (recent && expiring[record.id] != nil)
    }

    private func sendExpired(_ threads: [ThreadRef.ID], from list: ThreadListRevision) async {
        guard state?.list == list else { return }
        var taken: Set<ThreadRef.ID> = []
        for thread in threads {
            guard !isStopped, keepsRecent, heldThreads().contains(where: { $0.id == thread && $0.isRecent }),
                  !pending.contains(where: { $0.thread == thread && $0.recent != nil }) else { continue }
            do {
                _ = try await remote.markThread(thread, ThreadMarks(recent: false))
                taken.insert(thread)
            } catch ThreadSyncError.refused(_), ThreadSyncError.unknownThread {
                // Nothing the host would take: the next fetch says what it has.
                continue
            } catch {
                // Not sent: worked out again once the list is known to be current.
                break
            }
        }
        guard !isStopped, !taken.isEmpty else { return }
        // Not one used here again while on its way, which went up as a change of its own.
        taken.subtract(pending.lazy.filter { $0.recent != nil }.map(\.thread))
        var held = heldThreads()
        for index in held.indices where taken.contains(held[index].id) {
            held[index].recent = nil
        }
        _ = holdThreads(held, [])
    }

    /// Leaves out of the pending changes what the host took (`sent`), where it is still
    /// what was sent.
    private func settle(_ sent: PendingThreadChange) {
        guard var state, let index = state.pending.firstIndex(where: { $0.thread == sent.thread }) else { return }
        state.pending[index].settle(sent)
        if state.pending[index].isEmpty { state.pending.remove(at: index) }
        self.state = state
        saveState()
    }

    @discardableResult
    private func saveState() -> Bool {
        guard !isStopped else { return false }
        stateIsSaved = store.saveSync(state, for: host)
        return stateIsSaved
    }
}

/// What one sync step did, for the device to show.
public struct SyncStep: Sendable {
    /// The host's list was fetched and merged.
    public var merged = false
    /// Threads the host took off its list, forgotten here with their transcripts and
    /// images.
    public var forgotten: [ThreadRecord] = []
    /// Removals the host refused, with its sentence: the thread shows again.
    public var refused: [RefusedChange] = []
    /// Titles the host refused, with its sentence: the thread has its title from before
    /// again.
    public var refusedTitles: [RefusedChange] = []
    /// Why the step stopped short, or left a change for the next one: the host could not
    /// be reached or did not answer, or the device could not save. What was not done
    /// waits for the next step.
    public var error: (any Error)?
    /// The threads held here are the host's list as it stands: it was fetched in this step,
    /// or the host's word was that it had not moved, and nothing failed.
    public var listIsCurrent = false
    /// Threads whose change the host did not answer: nothing more of theirs is sent in
    /// this step.
    var unanswered: Set<ThreadRef.ID> = []

    public init() {}
}

/// A change the host refused (a removal, a title), and why, in its words.
public struct RefusedChange: Hashable, Sendable {
    public var thread: ThreadRef.ID
    public var reason: String

    public init(thread: ThreadRef.ID, reason: String) {
        self.thread = thread
        self.reason = reason
    }
}

public enum HostSyncError: LocalizedError, Hashable, Sendable {
    /// The threads could not be saved on this device.
    case notSaved

    public var errorDescription: String? {
        switch self {
        case .notSaved: "The list of threads could not be saved on this device."
        }
    }
}
