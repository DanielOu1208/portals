import Foundation
import Testing
@testable import AgentCore

/// `ThreadSync.merge` keeps the threads it works on in the order they were held in,
/// where it used to keep them in a table and sort them all afterwards. What it gives
/// must be what it gave: held against the merge as it was, kept here word for word.
@Suite struct ThreadSyncMergeAsBeforeTests {
    private static let mac = HostID(rawValue: "mac")

    private static func mergeAsBefore(
        _ answer: ThreadListChanges,
        into held: [ThreadRecord],
        heldWhenAsking: Set<ThreadRef.ID>,
        pending: [PendingThreadChange],
        list: ThreadListRevision?,
        host: HostID,
        lookedAt: ThreadRef.ID? = nil
    ) -> ThreadMerge {
        var records: [ThreadRef.ID: ThreadRecord] = [:]
        for record in held { records[record.id] = record }
        var pending = pending
        let listed = Set(answer.threads.map(\.id)).union(answer.unreadable)
        let removed = Set(answer.removed)

        // 1. A list this device has not merged before: the marks it holds are sent up
        // once, and threads the host never had stay here only.
        var seen: [SeenThread] = []
        if answer.isFull, answer.list.id != list?.id {
            for thread in answer.threads {
                guard let mine = records[thread.id] else { continue }
                var change = pending.first { $0.thread == thread.id } ?? PendingThreadChange(thread: thread.id)
                // Marks and a preview older than the thread's last turn are stale:
                // something new in a thread brings it back and is worth seeing, and its
                // preview is newer than this device's.
                let current = thread.updated <= mine.updatedAt
                if mine.isPinned, !thread.pinned, change.pinned == nil { change.pinned = true }
                if current, mine.isArchived, !thread.archived, change.archived == nil { change.archived = true }
                if current, mine.isUnseen, !thread.unseen, change.unseen == nil { change.unseen = true }
                // Seen here since its last turn, which the host marked unseen while this
                // device could not say so (an app from before the list): seen everywhere.
                if current, !mine.isUnseen, thread.unseen, change.unseen == nil {
                    seen.append(SeenThread(thread: thread.id, revision: thread.revision, list: answer.list.id))
                }
                if current, thread.preview == nil, change.preview == nil, let preview = mine.preview,
                   !preview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    change.preview = preview
                }
                guard !change.isEmpty else { continue }
                if let index = pending.firstIndex(where: { $0.thread == thread.id }) {
                    pending[index] = change
                } else {
                    pending.append(change)
                }
            }
            for id in heldWhenAsking where !listed.contains(id) && !removed.contains(id) {
                records[id]?.localOnly = true
            }
        }

        // 2. Threads taken off the list are forgotten, and in a full answer every one it
        // does not list that is not kept here only.
        var forgotten: [ThreadRecord] = []
        for id in heldWhenAsking {
            guard let record = records[id] else { continue }
            let gone = removed.contains(id) || (answer.isFull && !listed.contains(id) && record.localOnly != true)
            guard gone else { continue }
            forgotten.append(record)
            records[id] = nil
        }
        let forgottenIDs = Set(forgotten.map(\.id))
        pending.removeAll { forgottenIDs.contains($0.thread) }

        // 3. Each listed thread as the host has it, except what is pending here, and a
        // seen carried over, which stays.
        let carriedSeen = Set(seen.map(\.thread))
        for thread in answer.threads {
            let change = pending.first { $0.thread == thread.id }
            let isNew = records[thread.id] == nil
            var record = records[thread.id] ?? ThreadRecord(
                ref: ThreadRef(id: thread.id, agent: Agent.ID(host: host, name: thread.agent)),
                updatedAt: thread.updated
            )
            record.ref.agent = Agent.ID(host: host, name: thread.agent)
            // A title is never cleared.
            record.ref.title = change?.title ?? thread.title ?? record.ref.title
            if let folder = thread.folder, !folder.isEmpty { record.ref.workingDirectory = folder }
            record.ref.readOnly = thread.readOnly ? true : nil
            if let created = thread.created { record.ref.createdAt = created }
            // The host's time, so every device orders the list by one clock.
            record.updatedAt = thread.updated
            record.revision = thread.revision
            record.preview = thread.preview ?? record.preview
            record.pinned = (change?.pinned ?? thread.pinned) ? true : nil
            record.archived = (change?.archived ?? thread.archived) ? true : nil
            record.unseen = !carriedSeen.contains(thread.id) && (change?.unseen ?? thread.unseen) ? true : nil
            record.startedBy = thread.startedBy
            record.branch = thread.branch
            record.repo = thread.repo
            record.localOnly = nil
            if isNew { record.fromHost = true }
            records[thread.id] = record
        }

        // 4. The thread looked at has been seen, whatever finished in it.
        if let id = lookedAt, var record = records[id], record.isUnseen {
            record.unseen = nil
            records[id] = record
            if let index = pending.firstIndex(where: { $0.thread == id }) {
                pending[index].unseen = nil
                if pending[index].isEmpty { pending.remove(at: index) }
            }
            if let revision = record.revision, record.localOnly != true {
                seen.append(SeenThread(thread: id, revision: revision, list: answer.list.id))
            }
        }

        return ThreadMerge(
            threads: records.values.sorted { ($0.updatedAt, $0.id.rawValue) > ($1.updatedAt, $1.id.rawValue) },
            forgotten: forgotten,
            pending: pending,
            list: answer.list,
            seen: seen
        )
    }

    /// Numbers made up from a seed, the same every run.
    private struct Seeded {
        var state: UInt64

        mutating func next(_ below: Int) -> Int {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((state >> 33) % UInt64(max(below, 1)))
        }

        mutating func chance(_ outOf: Int) -> Bool { next(outOf) == 0 }

        mutating func some<Element>(of all: [Element], atMost count: Int) -> [Element] {
            var left = all
            var taken: [Element] = []
            for _ in 0..<min(next(count + 1), all.count) {
                taken.append(left.remove(at: next(left.count)))
            }
            return taken
        }
    }

    /// One merge's worth of made-up input: what a device holds, in one order or another,
    /// what it has still to send, and an answer of what changed or of every thread.
    private struct Case {
        var answer: ThreadListChanges
        var held: [ThreadRecord]
        var asking: Set<ThreadRef.ID>
        var pending: [PendingThreadChange]
        var list: ThreadListRevision?
        var lookedAt: ThreadRef.ID?

        init(seed: UInt64, threads count: Int = 30) {
            var random = Seeded(state: seed &* 0x9E37_79B9_7F4A_7C15 &+ 1)
            let t0 = Date(timeIntervalSince1970: 1_791_320_000)
            let ids = (0..<count * 2).map { ThreadRef.ID(rawValue: "t\($0)") }
            let texts: [String?] = [nil, "", " ", "Fix the login", "café 修正", "e\u{301}t\u{e9}"]
            // Few times, so that many threads share one and their ids decide.
            func time(_ random: inout Seeded) -> Date { t0.addingTimeInterval(Double(random.next(12)) * 60) }

            held = random.some(of: ids, atMost: count).map { id in
                var record = ThreadRecord(
                    ref: ThreadRef(id: id, agent: Agent.ID(host: ThreadSyncMergeAsBeforeTests.mac, name: random.chance(2) ? "claude" : "codex"), title: texts[random.next(texts.count)]),
                    updatedAt: time(&random), preview: texts[random.next(texts.count)], pinned: random.chance(4), archived: random.chance(5)
                )
                record.unseen = random.chance(3) ? true : nil
                record.revision = random.chance(4) ? nil : random.next(40)
                record.localOnly = random.chance(8) ? true : nil
                record.fromHost = random.chance(2) ? true : nil
                return record
            }
            switch random.next(4) {
            case 0: held.sort { ($0.updatedAt, $0.id.rawValue) > ($1.updatedAt, $1.id.rawValue) }
            case 1: held.sort { $0.updatedAt > $1.updatedAt }
            case 2: held.sort { $0.id.rawValue < $1.id.rawValue }
            default: break
            }
            // Now and then the same thread twice, as no device should hold it.
            if random.chance(6), let again = held.first {
                var other = again
                other.updatedAt = time(&random)
                other.pinned = true
                held.insert(other, at: random.next(held.count + 1))
            }

            asking = Set(held.map(\.id))
            // In an order of its own: a set's changes from one run of the tests to the
            // next, and a seed would then make another case each time.
            for id in random.some(of: asking.sorted { $0.rawValue < $1.rawValue }, atMost: 3) { asking.remove(id) }
            for id in random.some(of: ids, atMost: 3) { asking.insert(id) }

            pending = random.some(of: ids, atMost: 5).map { id in
                PendingThreadChange(
                    thread: id, pinned: random.chance(2) ? random.chance(2) : nil, archived: random.chance(3) ? random.chance(2) : nil,
                    unseen: random.chance(3) ? random.chance(2) : nil, title: random.chance(3) ? "Mine" : nil,
                    preview: random.chance(4) ? "said here" : nil, remove: random.chance(5) ? true : nil
                )
            }

            let lists = ["3f9a1c0e7b2d4a65", "a-new-home"]
            list = random.chance(5) ? nil : ThreadListRevision(id: lists[random.chance(6) ? 1 : 0], revision: random.next(40))
            let isFull = random.chance(4)
            let listed = random.some(of: ids, atMost: isFull ? count * 2 : 6).map { id in
                ListedThread(
                    id: id, agent: random.chance(2) ? "claude" : "codex", title: texts[random.next(texts.count)],
                    folder: random.chance(3) ? nil : "/Users/dev/app", readOnly: random.chance(8), created: random.chance(2) ? t0 : nil,
                    updated: time(&random), revision: random.next(60), preview: texts[random.next(texts.count)],
                    pinned: random.chance(3), archived: random.chance(4), unseen: random.chance(2),
                    startedBy: random.chance(6) ? ThreadStarter(name: "Aeri", thread: ids[0]) : nil
                )
            }
            answer = ThreadListChanges(
                list: ThreadListRevision(id: lists[random.chance(6) ? 1 : 0], revision: 40 + random.next(20)),
                threads: listed, removed: random.chance(2) ? [] : random.some(of: ids, atMost: 4), isFull: isFull,
                unreadable: random.chance(4) ? random.some(of: ids, atMost: 2) : []
            )
            lookedAt = random.chance(3) ? ids[random.next(ids.count)] : nil
        }
    }

    @Test func everyMadeUpMergeGivesWhatItGaveBefore() {
        var forgot = 0, carried = 0, full = 0, doubled = 0
        for seed in 0..<3000 {
            let made = Case(seed: UInt64(seed), threads: seed % 3 == 0 ? 6 : 30)
            let merged = ThreadSync.merge(
                made.answer, into: made.held, heldWhenAsking: made.asking, pending: made.pending, list: made.list,
                host: Self.mac, lookedAt: made.lookedAt
            )
            let mergedBefore = Self.mergeAsBefore(
                made.answer, into: made.held, heldWhenAsking: made.asking, pending: made.pending, list: made.list,
                host: Self.mac, lookedAt: made.lookedAt
            )
            // A thread listed for the first time, or taken off the list and listed again
            // in one answer, with no time of its making, is made now, at each merge's
            // own moment: that one time is left out of the comparison.
            let again = Set(mergedBefore.forgotten.map(\.id))
            let madeNow = Set(made.answer.threads.filter { $0.created == nil }.map(\.id))
                .filter { id in again.contains(id) || !made.held.contains { $0.id == id } }
            func settled(_ merge: ThreadMerge) -> ThreadMerge {
                var merge = merge
                for index in merge.threads.indices where madeNow.contains(merge.threads[index].id) {
                    merge.threads[index].ref.createdAt = .distantPast
                }
                return merge
            }
            let now = settled(merged), before = settled(mergedBefore)
            #expect(now == before, "seed \(seed)")
            // The same threads in the same order, also where == would not tell two apart.
            #expect(now.threads.map { "\($0.id.rawValue) \($0.updatedAt.timeIntervalSince1970) \(Array(($0.ref.title ?? "-").utf8))" }
                == before.threads.map { "\($0.id.rawValue) \($0.updatedAt.timeIntervalSince1970) \(Array(($0.ref.title ?? "-").utf8))" }, "seed \(seed)")
            if !now.forgotten.isEmpty { forgot += 1 }
            if now.pending.count > made.pending.count || !now.seen.isEmpty { carried += 1 }
            if made.answer.isFull { full += 1 }
            if Set(made.held.map(\.id)).count < made.held.count { doubled += 1 }
        }
        // The cases are of every kind.
        #expect(forgot > 300 && carried > 300 && full > 300 && doubled > 100)
    }

    /// The reason for it. One thread changed in a list of 2000: the merge as it is
    /// against the merge as it was, the best of several rounds of each, taken one beside
    /// the other.
    @Test func aChangeOfOneThreadIsMergedSoonerThanBefore() throws {
        let t0 = Date(timeIntervalSince1970: 1_791_320_000)
        let list = ThreadListRevision(id: "3f9a1c0e7b2d4a65", revision: 2000)
        let held = (0..<2000).map { index -> ThreadRecord in
            var record = ThreadRecord(
                ref: ThreadRef(id: ThreadRef.ID(rawValue: "thread-\(index)"), agent: Agent.ID(host: Self.mac, name: "claude"), title: "Title \(index)"),
                updatedAt: t0.addingTimeInterval(Double(2000 - index) * 60), preview: "said last in \(index)"
            )
            record.revision = 2000 - index
            return record
        }
        let asking = Set(held.map(\.id))
        let changed = ListedThread(id: held[700].id, agent: "claude", title: "Title 700", updated: t0.addingTimeInterval(2001 * 60), revision: 2001, unseen: true)
        let answer = ThreadListChanges(list: ThreadListRevision(id: list.id, revision: 2001), threads: [changed])
        let clock = ContinuousClock()
        var now: [Duration] = [], before: [Duration] = []
        for _ in 0..<12 {
            var start = clock.now
            let quick = ThreadSync.merge(answer, into: held, heldWhenAsking: asking, pending: [], list: list, host: Self.mac)
            now.append(clock.now - start)
            start = clock.now
            let slow = Self.mergeAsBefore(answer, into: held, heldWhenAsking: asking, pending: [], list: list, host: Self.mac)
            before.append(clock.now - start)
            #expect(quick == slow)
            #expect(quick.threads.first?.id == changed.id && quick.threads.count == 2000)
        }
        let best = (now: try #require(now.min()), before: try #require(before.min()))
        #expect(best.now * 10 < best.before * 7, "now \(best.now), before \(best.before)")
    }
}
