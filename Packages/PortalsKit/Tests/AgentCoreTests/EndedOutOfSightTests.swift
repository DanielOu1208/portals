import Foundation
import Testing
@testable import AgentCore

/// A turn that ends here out of sight, on a host that keeps the list: unseen at once,
/// until the host's list has the thread again (2026-10-15: a row gone
/// for a second between Running and Finished).
@Suite struct EndedOutOfSightTests {
    private let host = HostID(rawValue: "mbp16")
    private let start = Date(timeIntervalSince1970: 1_000_000)

    private func record(_ id: String, revision: Int? = nil, unseen: Bool = false) -> ThreadRecord {
        var record = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: id), agent: Agent.ID(host: host, name: "claude")))
        record.revision = revision
        record.unseen = unseen ? true : nil
        return record
    }

    @Test func aThreadThatEndedOutOfSightIsUnseenAtOnce() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        let shown = ended.applied(to: [record("a", revision: 4), record("b", revision: 2)], now: start)
        #expect(shown.map(\.isUnseen) == [true, false])
    }

    /// Nothing is written into the list: the mark is only in what the sidebar shows.
    @Test func theListItselfIsLeftAlone() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        let list = [record("a", revision: 4)]
        _ = ended.applied(to: list, now: start)
        #expect(list[0].isUnseen == false)
    }

    /// Once the host's list has the thread changed since the turn ended, the host says:
    /// unseen, or seen (another device looked at it).
    @Test func theHostsListTakesOver() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.listed([record("a", revision: 4)])
        #expect(ended.applied(to: [record("a", revision: 4)], now: start)[0].isUnseen)
        ended.listed([record("a", revision: 7)])
        #expect(!ended.applied(to: [record("a", revision: 7)], now: start)[0].isUnseen)
        #expect(ended.isEmpty)
    }

    /// A thread new here, not on the host's list yet, waits for its first listing.
    @Test func aThreadNotListedYetWaitsForItsFirstListing() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a"), at: start)
        ended.listed([record("a")])
        #expect(!ended.isEmpty)
        ended.listed([record("a", revision: 1)])
        #expect(ended.isEmpty)
    }

    @Test func openingTheThreadSeesIt() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.seen(ThreadRef.ID(rawValue: "a"))
        #expect(!ended.applied(to: [record("a", revision: 4)], now: start)[0].isUnseen)
    }

    /// Opened while it is unseen only by its mark, it is read here until the host's list
    /// has its turn's end, which the merge that brings it then takes as seen.
    @Test func openedBeforeTheListHasTheEndItIsReadUntilItDoes() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.seen(ThreadRef.ID(rawValue: "a"))
        #expect(ended.readHere == [ThreadRef.ID(rawValue: "a"): TurnRead()])
        ended.listed([record("a", revision: 4)])
        #expect(ended.readHere == [ThreadRef.ID(rawValue: "a"): TurnRead()])
        ended.listed([record("a", revision: 5, unseen: true)])
        #expect(ended.readHere.isEmpty)
        #expect(ended.isEmpty)
    }

    /// The turn read is the one the list here had as the thread's latest when it ended
    /// (net-20).
    @Test func whatIsReadKnowsTheTurnItIsOf() {
        var ended = EndedOutOfSight()
        var a = record("a", revision: 4)
        a.turn = 3
        ended.turnEnded(a, at: start)
        let heard = ThreadListRevision(id: "l", revision: 7)
        ended.seen(ThreadRef.ID(rawValue: "a"), heard: heard)
        #expect(ended.readHere == [ThreadRef.ID(rawValue: "a"): TurnRead(turn: 3, heard: heard)])
    }

    /// A turn the host named with its end is the one read, though the list here had an
    /// earlier one as the latest: a quick turn no list or report here had (net-20).
    @Test func theTurnTheHostNamedWithItsEndIsTheOneRead() {
        var ended = EndedOutOfSight()
        var a = record("a", revision: 4)
        a.turn = 3
        ended.turnEnded(a, turn: 9, at: start)
        ended.seen(ThreadRef.ID(rawValue: "a"))
        let read = ended.readHere[ThreadRef.ID(rawValue: "a")]
        #expect(read == TurnRead(turn: 9))
        // The merge that brings that turn's end sees it; a later turn it does not.
        #expect(read?.covers(9, in: "l") == true)
        #expect(read?.covers(12, in: "l") == false)
    }

    /// Only the turn that was read: one that ends after it is not.
    @Test func aTurnEndingAfterItWasReadIsNotRead() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.seen(ThreadRef.ID(rawValue: "a"))
        ended.turnEnded(record("a", revision: 4), at: start.addingTimeInterval(5))
        #expect(ended.readHere.isEmpty)
        #expect(ended.applied(to: [record("a", revision: 4)], now: start.addingTimeInterval(5))[0].isUnseen)
    }

    /// Opening a thread with no mark reads nothing here: its seen goes the usual way.
    @Test func openingAThreadWithNoMarkReadsNothing() {
        var ended = EndedOutOfSight()
        ended.seen(ThreadRef.ID(rawValue: "a"))
        #expect(ended.readHere.isEmpty)
    }

    @Test func whatWasReadGoesAfterAWhileToo() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.seen(ThreadRef.ID(rawValue: "a"))
        ended.expire(now: start.addingTimeInterval(31))
        #expect(ended.isEmpty)
    }

    /// When the host's list does not come (a host out of reach), the mark goes after a
    /// while rather than stay: the host decides when it is back.
    @Test func theMarkGoesAfterAWhile() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        #expect(ended.applied(to: [record("a", revision: 4)], now: start.addingTimeInterval(29))[0].isUnseen)
        #expect(!ended.applied(to: [record("a", revision: 4)], now: start.addingTimeInterval(31))[0].isUnseen)
        ended.expire(now: start.addingTimeInterval(31))
        #expect(ended.isEmpty)
    }

    /// A turn ending again counts from then.
    @Test func aLaterEndStartsAgain() {
        var ended = EndedOutOfSight()
        ended.turnEnded(record("a", revision: 4), at: start)
        ended.turnEnded(record("a", revision: 6), at: start.addingTimeInterval(20))
        ended.listed([record("a", revision: 6)])
        #expect(ended.applied(to: [record("a", revision: 6)], now: start.addingTimeInterval(40))[0].isUnseen)
    }
}
