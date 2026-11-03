import Foundation
import Testing
@testable import AgentCore

@Suite struct RecentThreadsTests {
    private let mac = HostID(rawValue: "mac")

    private func record(_ number: Int, host: HostID? = nil, unseen: Bool = false) -> ThreadRecord {
        var value = ThreadRecord(
            ref: ThreadRef(id: ThreadRef.ID(rawValue: "t\(number)"), agent: Agent.ID(host: host ?? mac, name: "codex")),
            updatedAt: Date(timeIntervalSince1970: Double(number))
        )
        value.unseen = unseen ? true : nil
        return value
    }

    private func groups(
        _ records: [ThreadRecord], history: RecentThreads = RecentThreads(), waiting: Set<ThreadKey> = [], running: Set<ThreadKey> = [],
        tucked: Set<ThreadKey> = [], choice: RecentChoice = RecentChoice()
    ) -> SidebarGroups {
        SidebarGroups.build(threads: records, recent: history, waiting: waiting, running: running, tucked: tucked, choice: choice)
    }

    private func marked(_ number: Int, host: HostID? = nil, unseen: Bool = false) -> ThreadRecord {
        var value = record(number, host: host, unseen: unseen)
        value.recent = true
        return value
    }

    /// 2026-11-03: "pinned should be above recent" and "finished should be separate
    /// from recent too".
    @Test func aPinnedThreadAtRestIsUnderPinnedAboveRecentInAPlaceThatKeeps() {
        func pinned(_ number: Int, created: Double, unseen: Bool = false) -> ThreadRecord {
            var value = marked(number, unseen: unseen)
            value.pinned = true
            value.ref.createdAt = Date(timeIntervalSince1970: created)
            return value
        }
        let old = pinned(9, created: 1)
        let new = pinned(1, created: 2)
        let works = pinned(10, created: 3)
        let asks = pinned(11, created: 4)
        let unread = pinned(12, created: 5, unseen: true)
        let other = marked(5)
        let top = groups([old, new, works, asks, unread, other], waiting: [asks.key], running: [works.key])
        // Each in one group: its status first, then its dot, then its pin.
        #expect(top.waiting.map(\.key) == [asks.key])
        #expect(top.running.map(\.key) == [works.key])
        #expect(top.finished.map(\.key) == [unread.key])
        #expect(top.recent.map(\.key) == [other.key])
        // The one created last first, whichever last ran.
        #expect(top.pinned.map(\.key) == [new.key, old.key])
        #expect(top.lines.compactMap { line -> SidebarGroups.Group? in
            if case let .title(group, _) = line { group } else { nil }
        } == [.waiting, .running, .finished, .pinned, .recent])
        #expect(top.count == 6)
        // Recent off leaves the pins; a thread archived is in neither.
        var archived = pinned(2, created: 6)
        archived.archived = true
        let off = groups([old, other, archived], choice: RecentChoice(shows: false))
        #expect(off.pinned.map(\.key) == [old.key])
        #expect(off.recent.isEmpty)
        // Only a pin at rest: no other title, and the sidebar's top half is not empty.
        #expect(!groups([old]).isEmpty)
    }

    @Test func twentyFiveReadEntriesAreKeptByActivityAndFifteenShowWithoutCountingUnreadOrActiveWork() {
        let read = (0..<30).map { record($0) }
        let unread = record(30, unseen: true)
        let works = record(31)
        let asks = record(32)
        let all = read + [unread, works, asks]
        let top = groups(all, history: RecentThreads(keys: Set(all.map(\.key))), waiting: [asks.key], running: [works.key])
        #expect(top.finished.map(\.key) == [unread.key])
        #expect(top.recent.map(\.key) == read.suffix(15).reversed().map(\.key))
        #expect(top.running.map(\.key) == [works.key])
        #expect(top.waiting.map(\.key) == [asks.key])
        #expect(top.history.keys == Set(read.suffix(25).map(\.key) + [unread.key, works.key, asks.key]))
        // An active thread later ends read: it joins the same allowance.
        let ended = groups(all, history: top.history)
        #expect(ended.recent.count == 15)
        #expect(ended.history.keys.contains(works.key))
        #expect(!ended.history.keys.contains(read[5].key))
    }

    @Test func nothingADeviceCanAskForIsMoreThanIsKept() {
        #expect(RecentChoice.counts == [5, 10, 15, 25])
        #expect(RecentChoice.counts.max() == RecentThreads.readLimit)
        #expect(RecentChoice().shows && RecentChoice().count == 15)
    }

    /// Each number limits only what shows: what is kept is the same at each.
    @Test func eachNumberLimitsOnlyWhatShows() {
        let read = (0..<30).map { record($0) }
        let unread = (30..<37).map { record($0, unseen: true) }
        let all = read + unread
        let history = RecentThreads(keys: Set(all.map(\.key)))
        let kept = groups(all, history: history).history
        for count in RecentChoice.counts {
            let top = groups(all, history: history, choice: RecentChoice(count: count))
            #expect(top.recent.map(\.key) == read.suffix(count).reversed().map(\.key))
            // Unread results are not counted, and all show.
            #expect(top.finished.map(\.key) == unread.reversed().map(\.key))
            #expect(top.history == kept)
        }
    }

    /// Off (2026-11-02): what finished unread still shows, under Finished, and leaves
    /// once read; what was read does not show, and there is no Recent title. What is kept
    /// stays, so that turning it on again shows the right list.
    @Test func offShowsOnlyWhatIsUnreadAndKeepsTheRest() {
        let read = (0..<20).map { marked($0) }
        let local = record(50)
        let unread = record(51, unseen: true)
        let opened = marked(52, unseen: true)
        var all = read + [local, unread, opened]
        let history = RecentThreads(keys: [local.key])
        let off = RecentChoice(shows: false)

        let top = groups(all, history: history, choice: off)
        #expect(top.finished.map(\.key) == [opened.key, unread.key])
        #expect(top.recent.isEmpty)
        #expect(top.lines.first == .title(.finished, place: 0))
        #expect(top.history == history)
        #expect(top.marked == read.reversed().map(\.key))

        // Read: gone, and with nothing unread no Recent title at all.
        all = all.map { record in
            var read = record
            read.unseen = nil
            return read
        }
        let none = groups(all, history: history, choice: off)
        #expect(none.recent.isEmpty)
        #expect(none.lines.isEmpty)
        #expect(none.isEmpty)
        #expect(none.marked.count == 21)
        // A thread at work is still in its group, on or off.
        let works = groups(all, history: history, running: [read[3].key], choice: off)
        #expect(works.running.map(\.key) == [read[3].key])
        #expect(works.recent.isEmpty)
        #expect(works.lines.map(\.id).first == "title|0")

        // On again: the list as it would have been.
        #expect(groups(all, history: history).recent.prefix(2).map(\.key) == [opened.key, local.key])
    }

    @Test func aThreadAHostKeepsAsRecentIsListedWithoutAnythingHere() {
        let host = HostID(rawValue: "other")
        let here = record(1)
        let there = marked(2, host: host)
        let top = groups([here, there])
        #expect(top.recent.map(\.key) == [there.key])
        #expect(top.marked == [there.key])
        #expect(top.history.keys.isEmpty)
    }

    /// Not at work, not under the thread that started it, and not counted while unread.
    @Test func onlyAReadIdleMarkCounts() {
        let idle = marked(1)
        let works = marked(2)
        let asks = marked(3)
        let tucked = marked(4)
        let unread = marked(5, unseen: true)
        let top = groups([idle, works, asks, tucked, unread], waiting: [asks.key], running: [works.key], tucked: [tucked.key])
        #expect(top.marked == [idle.key])
        #expect(top.finished.map(\.key) == [unread.key])
        #expect(top.recent.map(\.key) == [idle.key])
        #expect(top.running.map(\.key) == [works.key])
        #expect(top.waiting.map(\.key) == [asks.key])
    }

    /// A key here counts with the marks of its own host: past twenty-five of them it goes,
    /// while a mark stays until a device takes it off. Another host's are not counted, though
    /// what shows is what last ran of them all.
    @Test func eachHostHasItsOwnTwentyFive() {
        let host = HostID(rawValue: "other")
        let old = (0..<10).map { record($0) }
        let newer = (10..<40).map { marked($0, host: host) }
        let top = groups(old + newer, history: RecentThreads(keys: Set(old.map(\.key))), choice: RecentChoice(count: 25))
        #expect(top.recent.map(\.key) == newer.suffix(25).reversed().map(\.key))
        #expect(top.history.keys == Set(old.map(\.key)))
        #expect(top.marked == newer.reversed().map(\.key))
        #expect(RecentThreads.pastKept(top.marked, of: host) == newer.prefix(5).reversed().map(\.key))

        // Of one host, keys here and its marks count together.
        let here = (0..<10).map { record($0) }
        let marks = (10..<30).map { marked($0) }
        let same = groups(here + marks, history: RecentThreads(keys: Set(here.map(\.key))))
        #expect(same.history.keys == Set(here.suffix(5).map(\.key)))
        // Past them, a mark is not taken off for a key here that ran earlier, nor is one here
        // counted to take a mark off: those are this device's alone.
        #expect(RecentThreads.pastKept(same.marked, of: mac).isEmpty)
    }

    /// What every device takes off is past twenty-five, whichever number it shows.
    @Test func whatIsTakenOffThatIsPastTheKeptOnesDependsOnNoDevicesNumber() {
        let records = (0..<30).map { marked($0) }
        let past = Set(records.prefix(5).map(\.key))
        for count in RecentChoice.counts {
            let top = groups(records, choice: RecentChoice(count: count))
            #expect(Set(RecentThreads.pastKept(top.marked, of: mac)) == past)
        }
        let off = groups(records, choice: RecentChoice(shows: false))
        #expect(Set(RecentThreads.pastKept(off.marked, of: mac)) == past)
        // Nothing while nothing is past them.
        #expect(RecentThreads.pastKept(groups(Array(records.suffix(25))).marked, of: mac).isEmpty)
    }

    /// One host's step takes nothing off another, however many that one's list holds: what
    /// is held of it may have moved since its own last step.
    @Test func onlyTheHostAskedAboutIsTakenFrom() {
        let away = HostID(rawValue: "away")
        let stale = (100..<140).map { marked($0, host: away) }
        let here = (0..<40).map { marked($0) }
        let marks = groups(stale + here).marked
        #expect(RecentThreads.pastKept(marks, of: mac) == here.prefix(15).reversed().map(\.key))
        #expect(RecentThreads.pastKept(marks, of: away) == stale.prefix(15).reversed().map(\.key))
    }

    /// A thread only opened: a mark on it comes straight off exactly when it is older than
    /// all its host keeps, and the same holds for another host's marks, at any number.
    @Test func aMarkWouldPassWhatIsKeptOnlyPastAllAHostKeeps() {
        let other = HostID(rawValue: "other")
        let old = record(5), newer = record(50)
        let kept = (10..<35).map { marked($0) }
        let times = Dictionary(uniqueKeysWithValues: kept.map { ($0.key, $0.updatedAt) })
        func wouldPass(_ top: SidebarGroups, _ opened: ThreadRecord) -> Bool {
            top.markWouldPassKept(opened) { times[$0] }
        }
        for choice in [RecentChoice(count: 5), RecentChoice(shows: false)] {
            let top = groups(kept, choice: choice)
            #expect(wouldPass(top, old))
            #expect(!wouldPass(top, newer))
            // What marking it would do says the same.
            var opened = old
            opened.recent = true
            #expect(RecentThreads.pastKept(groups(kept + [opened], choice: choice).marked, of: mac) == [old.key])
        }
        #expect(!wouldPass(groups(Array(kept.dropFirst())), old))
        #expect(!wouldPass(groups(kept), record(5, host: other)))
        // One at work is not counted among the marks, so nothing would take its off.
        #expect(!wouldPass(groups(kept + [old], running: [old.key]), old))
        #expect(!wouldPass(groups(kept + [old], waiting: [old.key]), old))
    }

    /// A portal with two hosts and a portal with one of them: what is newer on the other host
    /// takes nothing off the one they share, so the second portal still shows all of it, at
    /// any number, and a thread opened there stays. What each shows at each number is what
    /// last ran of what it has.
    @Test func portalsWithDifferentHostsTakeNothingTheOtherCanShow() {
        let other = HostID(rawValue: "other")
        let shared = (0..<25).map { marked($0) }
        let newer = (100..<125).map { marked($0, host: other) }
        let wide = shared + newer
        for count in RecentChoice.counts {
            let choice = RecentChoice(count: count)
            let two = groups(wide, choice: choice)
            #expect(two.recent.map(\.key) == newer.suffix(count).reversed().map(\.key))
            #expect(RecentThreads.pastKept(two.marked, of: mac).isEmpty)
            let one = groups(shared, choice: choice)
            #expect(one.recent.map(\.key) == shared.suffix(count).reversed().map(\.key))
        }
    }

    /// Showing five of twenty-five: dismissing one brings on the next of those kept. At
    /// twenty-five what is past them stays gone, and only another host's come on.
    @Test func dismissingBringsOnOnlyWhatIsKept() {
        let records = (0..<30).map { marked($0) }
        let five = RecentChoice(count: 5)
        var after = records
        after[29].recent = nil
        #expect(groups(records, choice: five).recent.map(\.key) == records.suffix(5).reversed().map(\.key))
        #expect(groups(after, choice: five).recent.map(\.key) == [28, 27, 26, 25, 24].map { records[$0].key })
        // Taken off the host, those past twenty-five come back at no number.
        var kept = records
        for number in 0..<5 { kept[number].recent = nil }
        kept[29].recent = nil
        #expect(groups(kept, choice: RecentChoice(count: 25)).recent.count == 24)
        // With another host's older ones kept as well, the next of those comes on.
        let other = HostID(rawValue: "other")
        let older = marked(-1, host: other)
        #expect(groups(kept + [older], choice: RecentChoice(count: 25)).recent.last?.key == older.key)
    }

    /// Archived, a thread is out of Recent (2026-11-02), whether a key here or a mark
    /// says otherwise, and is not counted: the next one stays. Unread it still shows, as
    /// something new in it does, and out of the archive it is back where it is kept.
    @Test func anArchivedThreadIsOutOfRecentUnlessUnread() {
        var here = record(1), kept = marked(2)
        here.archived = true
        kept.archived = true
        let other = marked(3)
        let history = RecentThreads(keys: [here.key])
        let top = groups([here, kept, other], history: history)
        #expect(top.recent.map(\.key) == [other.key])
        #expect(top.marked == [other.key])
        #expect(top.history == history)

        var unread = kept
        unread.unseen = true
        #expect(groups([here, unread, other], history: history).finished.map(\.key) == [unread.key])
        #expect(groups([here, unread, other], history: history).recent.map(\.key) == [other.key])

        var out = kept
        out.archived = nil
        #expect(groups([here, out, other], history: history).recent.map(\.key) == [other.key, out.key])

        // Not counted among what is kept.
        let many = (10..<35).map { marked($0) }
        #expect(groups(many + [kept]).marked.count == 25)
        #expect(RecentThreads.pastKept(groups(many + [kept]).marked, of: mac).isEmpty)
    }

    @Test func theChoiceIsKeptOnTheDevice() throws {
        let suite = "recent-choice-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        #expect(RecentChoice(from: defaults) == RecentChoice())
        RecentChoice(shows: false, count: 25).save(to: defaults)
        #expect(RecentChoice(from: defaults) == RecentChoice(shows: false, count: 25))
        // A number no longer offered is today's.
        defaults.set(7, forKey: RecentChoice.countKey)
        #expect(RecentChoice(from: defaults).count == 15)
        var choice = RecentChoice()
        choice.count = 7
        #expect(choice.count == 15)
    }

    @Test func unreadResultsStayUntilAcknowledgedEvenWhenNeverOpenedHere() {
        let read = (0..<15).map { record($0) }
        let unseen = (20..<40).map { record($0, unseen: true) }
        let history = RecentThreads(keys: Set(read.map(\.key)))
        let top = groups(read + unseen, history: history)
        #expect(top.finished.count == 20)
        #expect(top.recent.count == 15)
        var acknowledged = unseen
        acknowledged[0].unseen = nil
        let after = groups(read + acknowledged, history: top.history)
        #expect(!after.finished.contains { $0.key == unseen[0].key })
        #expect(after.finished.count == 19)
    }

    @Test func closingATabAndDismissingHistoryAreIndependentAcrossRelaunch() throws {
        let thread = record(1)
        var tabs = OpenTabs(keys: [thread.key], lastSelected: thread.key)
        var history = RecentThreads(keys: [thread.key])
        tabs.close(thread.key)
        #expect(groups([thread], history: history).recent.map(\.key) == [thread.key])
        tabs.open(thread.key)
        history.dismiss(thread.key)
        #expect(tabs.contains(thread.key))
        #expect(groups([thread], history: history).recent.isEmpty)
        let saved = try JSONEncoder().encode(history)
        // A saved empty history is not migrated from the still-open tab again.
        #expect(RecentThreads.restored(from: saved, legacyTabs: tabs).keys.isEmpty)
    }

    @Test func oldLocalTabsMigrateOnceAndPruningSurvivesRelaunch() throws {
        let records = (0..<30).map { record($0) }
        let old = OpenTabs(keys: records.map(\.key))
        let migrated = RecentThreads.restored(from: nil, legacyTabs: old)
        let kept = groups(records, history: migrated).history
        #expect(kept.keys == Set(records.suffix(25).map(\.key)))
        #expect(old.count == 30)
        let restored = RecentThreads.restored(from: try JSONEncoder().encode(kept), legacyTabs: old)
        #expect(restored == kept)
        // Dismissing an entry does not uncover a previously expired one. At a number
        // below what is kept, the next of those kept comes on.
        var dismissed = restored
        dismissed.dismiss(records[29].key)
        #expect(groups(records, history: dismissed, choice: RecentChoice(count: 25)).recent.count == 24)
        #expect(groups(records, history: dismissed).recent.first?.key == records[28].key)
        #expect(groups(records, history: dismissed).recent.count == 15)
    }

    @Test func partialListsPreserveUnknownKeysAndExplicitRemovalClearsThem() {
        let local = record(1)
        let remote = record(1, host: HostID(rawValue: "other"))
        var history = RecentThreads(keys: [local.key, remote.key])
        history = groups([local], history: history).history
        #expect(history.keys == [local.key, remote.key])
        history.remove { $0.host == remote.key.host }
        #expect(history.keys == [local.key])
    }

    @Test func twoDevicesHaveIndependentHistoryAndShareOnlyTheirUnreadInput() {
        let a = record(1)
        let b = record(2)
        let unread = record(3, unseen: true)
        let all = [a, b, unread]
        #expect(groups(all, history: RecentThreads(keys: [a.key])).finished.map(\.key) == [unread.key])
        #expect(groups(all, history: RecentThreads(keys: [a.key])).recent.map(\.key) == [a.key])
        #expect(groups(all, history: RecentThreads(keys: [b.key])).finished.map(\.key) == [unread.key])
        #expect(groups(all, history: RecentThreads(keys: [b.key])).recent.map(\.key) == [b.key])
    }

    @Test func openingAnExpiredEntryMakesItEligibleAgainWithoutChangingActivityOrder() {
        let records = (0..<30).map { record($0) }
        var history = groups(records, history: RecentThreads(keys: Set(records.map(\.key)))).history
        history.dismiss(records[29].key)
        history.open(records[0].key)
        let top = groups(records, history: history, choice: RecentChoice(count: 25))
        #expect(top.recent.last?.key == records[0].key)
        #expect(top.recent.count == 25)
    }

    @Test func openingAnOlderEntryAtCapacityIsPrunedEvenWhenTheDisplayedHistoryStaysTheSame() throws {
        let records = (0..<30).map { record($0) }
        let before = groups(records, history: RecentThreads(keys: Set(records.map(\.key)))).history
        var opened = before
        opened.open(records[0].key)
        #expect(opened != before)
        let reconciled = groups(records, history: opened).history
        #expect(reconciled == before)
        var saved = RecentThreads.restored(from: try JSONEncoder().encode(reconciled), legacyTabs: OpenTabs())
        saved.dismiss(records[29].key)
        let after = groups(records, history: saved, choice: RecentChoice(count: 25))
        #expect(after.recent.count == 24)
        #expect(!after.history.keys.contains(records[0].key))
    }
}
