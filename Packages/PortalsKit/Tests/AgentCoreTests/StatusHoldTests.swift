import Foundation
import Testing
@testable import AgentCore

/// A tool call on the status line stays there a minimum time (2026-10-23), and
/// what comes meanwhile does not queue behind it.
@Suite struct StatusHoldTests {
    let start = Date(timeIntervalSinceReferenceDate: 1_000)
    let stretch = UUID()

    func at(_ seconds: TimeInterval) -> Date { start.addingTimeInterval(seconds) }
    func call(_ id: String, _ label: String = "a.swift") -> RunStatus {
        .tool(ToolRun(id: id, name: "read_file", label: label, startedAt: start), others: 0)
    }

    @Test func aFastCallStaysUntilItsTimeIsUpThenTheLineMovesOn() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(.thinking, scope: stretch, at: at(0))
        #expect(hold.shown == .thinking)
        #expect(hold.due == nil)
        hold.update(call("r1"), scope: stretch, at: at(1))
        #expect(hold.shown == call("r1"))
        // Done in 0.2 s: the line keeps it until 1.5 s after it was shown.
        hold.update(.thinking, scope: stretch, at: at(1.2))
        #expect(hold.shown == call("r1"))
        #expect(hold.due == at(2.5))
        hold.tick(at: at(2.5))
        #expect(hold.shown == .thinking)
        #expect(hold.due == nil)
    }

    /// What the agent says it is working on waits behind a held call as "Thinking…" does.
    @Test func aHeadlineWaitsBehindAHeldCall() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(.headline("Validating prime numbers"), scope: stretch, at: at(0))
        #expect(hold.shown == .headline("Validating prime numbers"))
        hold.update(call("r1"), scope: stretch, at: at(1))
        hold.update(.headline("Checking n = 40"), scope: stretch, at: at(1.2))
        #expect(hold.shown == call("r1"))
        hold.tick(at: at(2.5))
        #expect(hold.shown == .headline("Checking n = 40"))
    }

    @Test func callsFasterThanTheHoldSkipToTheNewestRatherThanQueue() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("r1"), scope: stretch, at: at(0))
        hold.update(call("r2"), scope: stretch, at: at(0.3))
        hold.update(call("r3"), scope: stretch, at: at(0.6))
        hold.update(.thinking, scope: stretch, at: at(0.8))
        hold.update(call("r4"), scope: stretch, at: at(1.0))
        #expect(hold.shown == call("r1"))
        #expect(hold.due == at(1.5))
        // Time up: the newest, r4, which is held from now; r2 and r3 are skipped.
        hold.tick(at: at(1.5))
        #expect(hold.shown == call("r4"))
        #expect(hold.due == nil)
        hold.update(.thinking, scope: stretch, at: at(1.6))
        #expect(hold.shown == call("r4"))
        #expect(hold.due == at(3.0))
    }

    @Test func aCallShownLongEnoughGivesWayAtOnce() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("c1"), scope: stretch, at: at(0))
        hold.update(.thinking, scope: stretch, at: at(4))
        #expect(hold.shown == .thinking)
        #expect(hold.due == nil)
    }

    @Test func theSameCallUpdatedInPlaceKeepsItsTime() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("c1"), scope: stretch, at: at(0))
        var run = ToolRun(id: "c1", name: "terminal", label: "npm test", startedAt: start)
        run.output = "12 passing"
        hold.update(.tool(run, others: 1), scope: stretch, at: at(1))
        #expect(hold.shown == .tool(run, others: 1))
        // Still timed from 0, not from the update.
        hold.update(.thinking, scope: stretch, at: at(1.2))
        #expect(hold.due == at(1.5))
    }

    @Test func aCallIsHeldWhileTheAgentSaysSomethingAndAfter() {
        // Words since: the work under way is another stretch (or none). The call stays.
        var said = StatusHold(minimum: 1.5)
        said.update(call("r1"), scope: stretch, at: at(0))
        said.update(.thinking, scope: nil, at: at(0.2))
        #expect(said.shown == call("r1"))
        #expect(said.due == at(1.5))
        said.tick(at: at(1.5))
        #expect(said.shown == .thinking)

        // The line would go while the words are written: it stays on the call, then goes.
        var writing = StatusHold(minimum: 1.5)
        writing.update(call("r1"), scope: stretch, at: at(0))
        writing.update(nil, scope: nil, at: at(0.2))
        #expect(writing.shown == call("r1"))
        #expect(writing.due == at(1.5))
        writing.tick(at: at(1.5))
        #expect(writing.shown == nil)
        #expect(writing.due == nil)
    }

    @Test func theSameCallInANewStretchIsANewCall() {
        // Ids are a turn's own, but a call id seen again after the agent said something is
        // still another call: held as such, with its own time.
        var hold = StatusHold(minimum: 1.5)
        let next = UUID()
        hold.update(call("r1"), scope: stretch, at: at(0))
        hold.update(call("r1"), scope: next, at: at(0.5))
        #expect(hold.due == at(1.5))
        hold.tick(at: at(1.5))
        #expect(hold.shown == call("r1"))
        hold.update(.thinking, scope: next, at: at(2))
        #expect(hold.due == at(3))
    }

    @Test func theStandardHoldIsOneAndAHalfSeconds() {
        #expect(StatusHold.standard == 1.5)
    }

    @Test func waitingForTheUserIsShownAtOnce() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("c1"), scope: stretch, at: at(0))
        hold.update(.waitingForUser, scope: stretch, at: at(0.1))
        #expect(hold.shown == .waitingForUser)
        #expect(hold.due == nil)
    }

    @Test func notesWaitTheirTurnLikeThinking() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("r1"), scope: stretch, at: at(0))
        hold.update(.note("Waiting on provider"), scope: stretch, at: at(0.5))
        #expect(hold.shown == call("r1"))
        hold.tick(at: at(1.5))
        #expect(hold.shown == .note("Waiting on provider"))
    }

    @Test func aTickBeforeTheTimeChangesNothing() {
        var hold = StatusHold(minimum: 1.5)
        hold.update(call("r1"), scope: stretch, at: at(0))
        hold.update(.thinking, scope: stretch, at: at(0.5))
        hold.tick(at: at(1.0))
        #expect(hold.shown == call("r1"))
        #expect(hold.due == at(1.5))
    }

    @Test func aHeldCallKeepsOnlyItsTitleNotWhatWasLiveAboutIt() {
        var hold = StatusHold(minimum: 1.5)
        var run = ToolRun(id: "c1", name: "terminal", label: "npm test", startedAt: start)
        run.output = "3 passing"
        hold.update(.tool(run, others: 2), scope: stretch, at: at(0))
        #expect(!hold.isHolding)
        // It ended (failing, say) and the agent moved on: the line keeps its title only,
        // with none counted beside it and, in the view, no output under it.
        hold.update(.thinking, scope: stretch, at: at(0.3))
        #expect(hold.isHolding)
        #expect(hold.shown == .tool(run, others: 0))
        hold.tick(at: at(1.5))
        #expect(!hold.isHolding)
        #expect(hold.shown == .thinking)
    }

    @Test func zeroHoldsNothing() {
        var hold = StatusHold(minimum: 0)
        hold.update(call("r1"), scope: stretch, at: at(0))
        hold.update(.thinking, scope: stretch, at: at(0.1))
        #expect(hold.shown == .thinking)
        #expect(hold.due == nil)
    }
}
