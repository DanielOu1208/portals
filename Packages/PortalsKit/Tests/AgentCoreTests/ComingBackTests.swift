import Foundation
import Testing
@testable import AgentCore

@Suite struct ComingBackTests {
    private let start = Date(timeIntervalSinceReferenceDate: 1000)

    /// Away and back, the connection the app let go of itself shows as it was left: no
    /// "Not connected", no "Connecting…", until the host answers again.
    @Test func theConnectionLetGoOfForBeingAwayShowsAsItWasLeft() {
        var back = ComingBack()
        back.left(connected: true)
        back.connection(.disconnected(reason: nil), at: start)
        #expect(back.isAway)
        #expect(back.shown(.disconnected(reason: nil)) == .connected)
        _ = back.back(at: start.addingTimeInterval(60))
        back.connection(.connecting, at: start.addingTimeInterval(60))
        #expect(back.shown(.connecting) == .connected)
        back.connection(.connected, at: start.addingTimeInterval(60.3))
        #expect(!back.isAway)
        #expect(back.shown(.connected) == .connected)
    }

    /// A connection that was not up when the app left shows as it is: that is news.
    @Test func aConnectionThatWasDownShowsAsItIs() {
        var back = ComingBack()
        back.left(connected: false)
        #expect(!back.isAway)
        #expect(back.back(at: start) == nil)
        #expect(back.shown(.connecting) == .connecting)
    }

    /// The reconnect failing, or taking longer than the grace, shows.
    @Test func aFailedOrSlowReconnectShows() {
        var failed = ComingBack()
        failed.left(connected: true)
        _ = failed.back(at: start)
        failed.connection(.disconnected(reason: "The host did not answer."), at: start)
        #expect(!failed.isAway)
        #expect(failed.shown(.disconnected(reason: "x")) == .disconnected(reason: "x"))

        var stopped = ComingBack()
        stopped.left(connected: true)
        stopped.connection(.stopped(reason: "Wrong password"), at: start)
        #expect(!stopped.isAway)

        var slow = ComingBack()
        slow.left(connected: true)
        let grace = slow.back(at: start)
        #expect(grace != nil)
        slow.graceEnded(grace!)
        #expect(!slow.isAway)
        #expect(slow.shown(.connecting) == .connecting)
    }

    /// The grace of a return the app left again before its end does not end the next
    /// one's.
    @Test func anOldGraceEndsNothing() {
        var back = ComingBack()
        back.left(connected: true)
        let first = back.back(at: start)!
        back.left(connected: true)
        back.graceEnded(first)
        #expect(back.isAway)
        let second = back.back(at: start.addingTimeInterval(10))!
        back.graceEnded(second)
        #expect(!back.isAway)
    }

    /// The catch-up is quiet for a while from the return, and from the reconnect after
    /// it, and not otherwise.
    @Test func theCatchUpIsQuiet() {
        var back = ComingBack()
        #expect(!back.isQuiet(at: start))
        // A reconnect with no return before it (the network came back) is not.
        back.connection(.connected, at: start)
        #expect(!back.isQuiet(at: start.addingTimeInterval(0.1)))
        back.left(connected: true)
        _ = back.back(at: start.addingTimeInterval(100))
        #expect(back.isQuiet(at: start.addingTimeInterval(101)))
        // A slow reconnect: quiet from it on, too.
        back.connection(.connected, at: start.addingTimeInterval(103))
        #expect(back.isQuiet(at: start.addingTimeInterval(106)))
        #expect(!back.isQuiet(at: start.addingTimeInterval(107.5)))
    }

    /// The thread in sight is never under Recent for having finished out of sight; the
    /// others are as they were marked.
    @Test func theThreadInSightIsNotFinished() {
        let host = HostID(rawValue: "mac")
        let agent = Agent.ID(host: host, name: "claude")
        var open = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "open"), agent: agent), updatedAt: start)
        open.unseen = true
        var other = ThreadRecord(ref: ThreadRef(id: ThreadRef.ID(rawValue: "other"), agent: agent), updatedAt: start)
        other.unseen = true
        let shown = ThreadRecord.inSight(open.key, of: [open, other])
        #expect(!shown[0].isUnseen)
        #expect(shown[1].isUnseen)
        let layout = SidebarLayout.build(
            hosts: [HostConfig(id: host, name: "Mac", url: URL(string: "http://mac")!)],
            agents: [Agent(id: agent, displayName: "Claude")], threads: shown, waiting: [], running: []
        )
        #expect(layout.top.finished.map(\.id) == [other.id])
        #expect(ThreadRecord.inSight(nil, of: [open, other]) == [open, other])
    }

    /// A catch-up's events are given back all at once with its end, and applied that way
    /// show the turn that ended while away ended, never running; nothing is held outside one.
    @Test func aCatchUpIsTakenInAllAtOnce() {
        var hold = CatchUpHold()
        #expect(hold.take(.textDelta("live")) == [.textDelta("live")])
        hold.begin()
        #expect(hold.take(.turnStarted).isEmpty)
        #expect(hold.take(.textDelta("Done")).isEmpty)
        #expect(hold.take(.turnFinished(.completed, finalText: nil)).isEmpty)
        let end = ThreadEvent.caughtUp(ThreadInfo())
        let given = hold.take(end)
        #expect(given == [.turnStarted, .textDelta("Done"), .turnFinished(.completed, finalText: nil), end])
        #expect(!hold.isHolding)
        // Applied in one go, the state goes from at rest to at rest: nothing shows it running.
        var state = ThreadState()
        var runningSeen = false
        for event in given { state.apply(event) }
        runningSeen = state.isRunning
        #expect(!runningSeen)
        #expect(state.transcript.turns.count == 1)
        // A catch-up that fails gives back what it held, once.
        hold.begin()
        _ = hold.take(.turnStarted)
        #expect(hold.end() == [.turnStarted])
        #expect(hold.end().isEmpty)
        #expect(hold.take(.turnStarted) == [.turnStarted])
    }

    /// A catch-up the backend makes by itself on reconnecting (a thread that was running
    /// when the connection went) is said on the stream, and held from there in the same way.
    @Test func aCatchUpSaidOnTheStreamIsHeldToo() {
        var hold = CatchUpHold()
        #expect(hold.take(.catchUpBegan).isEmpty)
        #expect(hold.isHolding)
        #expect(hold.take(.textDelta(" there")).isEmpty)
        #expect(hold.take(.turnFinished(.completed, finalText: nil)).isEmpty)
        #expect(hold.take(.turnStarted).isEmpty)
        let end = ThreadEvent.caughtUp(ThreadInfo())
        #expect(hold.take(end) == [.textDelta(" there"), .turnFinished(.completed, finalText: nil), .turnStarted, end])
        #expect(!hold.isHolding)
        // Within one the thread asked for, it changes nothing.
        hold.begin()
        #expect(hold.take(.catchUpBegan).isEmpty)
        #expect(hold.take(.turnStarted).isEmpty)
        #expect(hold.take(end) == [.turnStarted, end])
    }
}
