import Foundation
import Testing
@testable import AgentCore

/// A thread no one can see holds the pieces of a reply and applies them together, in
/// order, before anything else it hears, each at the time it came.
@Suite struct HeldPiecesTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func piecesAreHeldWhileHolding() {
        var held = HeldPieces()
        #expect(held.events(for: .textDelta("Hel"), at: t0, holding: true).isEmpty)
        #expect(held.events(for: .reasoningDelta("think"), at: t0 + 1, holding: true).isEmpty)
        #expect(!held.isEmpty)
        #expect(held.release() == [HeldPieces.Piece(.textDelta("Hel"), at: t0), HeldPieces.Piece(.reasoningDelta("think"), at: t0 + 1)])
        #expect(held.isEmpty)
        #expect(held.release().isEmpty)
    }

    @Test func anythingElseComesAfterThePiecesHeldBeforeIt() {
        var held = HeldPieces()
        _ = held.events(for: .textDelta("Running "), at: t0, holding: true)
        _ = held.events(for: .textDelta("the tests"), at: t0 + 1, holding: true)
        let tool = ToolRun(id: "t1", name: "terminal", startedAt: t0)
        #expect(held.events(for: .toolStarted(tool), at: t0 + 2, holding: true).map(\.event) == [.textDelta("Running "), .textDelta("the tests"), .toolStarted(tool)])
        #expect(held.isEmpty)
    }

    @Test func nothingIsHeldWhenNotHolding() {
        var held = HeldPieces()
        #expect(held.events(for: .textDelta("Hi"), at: t0, holding: false) == [HeldPieces.Piece(.textDelta("Hi"), at: t0)])
        _ = held.events(for: .textDelta("one "), at: t0 + 1, holding: true)
        // Seen again: the next piece comes after the one held.
        #expect(held.events(for: .textDelta("two"), at: t0 + 2, holding: false).map(\.event) == [.textDelta("one "), .textDelta("two")])
    }

    /// A chat no one sees holds a run's steps too, while asked to; whatever else comes
    /// (a question, the turn's end) comes after them, in order.
    @Test func stepsAreHeldOnlyWhenAsked() {
        var held = HeldPieces()
        let tool = ToolRun(id: "t1", name: "terminal", startedAt: t0)
        #expect(held.events(for: .toolStarted(tool), at: t0, holding: true).map(\.event) == [.toolStarted(tool)])
        #expect(held.events(for: .textDelta("Running"), at: t0 + 1, holding: false, holdingSteps: true).isEmpty)
        #expect(held.events(for: .toolStarted(tool), at: t0 + 2, holding: false, holdingSteps: true).isEmpty)
        #expect(held.events(for: .status("Reading"), at: t0 + 3, holding: false, holdingSteps: true).isEmpty)
        let ended = ThreadEvent.turnFinished(.completed, finalText: "Done.")
        #expect(held.events(for: ended, at: t0 + 4, holding: false, holdingSteps: true).map(\.event)
            == [.textDelta("Running"), .toolStarted(tool), .status("Reading"), ended])
        #expect(held.isEmpty)
        #expect(!ThreadEvent.turnStarted.isStepOfRun)
        #expect(!ThreadEvent.titleChanged("A title").isStepOfRun)
    }

    /// A long run out of sight: each progress of a tool is its output's tail anew, and a
    /// status line stands in place of the last, so what is held stays one of each while
    /// the run goes on, and applied it comes to what every piece applied would. Not across
    /// the tool's end, after which a tool of the same id is another.
    @Test func progressAndStatusHeldOutOfSightAreFoldedTogether() {
        var held = HeldPieces()
        let tool = ToolRun(id: "t1", name: "terminal", startedAt: t0)
        let other = ToolRun(id: "t2", name: "terminal", startedAt: t0)
        var steps: [ThreadEvent] = [.toolStarted(tool), .toolStarted(other), .status("Building")]
        for line in 0..<500 {
            steps.append(.toolProgress(ToolProgress(id: "t1", output: "line \(line)", outputTruncated: line > 100 ? true : nil)))
            steps.append(.textDelta("."))
            if line % 50 == 0 { steps.append(.toolProgress(ToolProgress(id: "t2", progress: "step \(line)"))) }
            if line % 100 == 0 { steps.append(.status("Building \(line)")) }
        }
        steps.append(.toolProgress(ToolProgress(id: "t1", progress: "almost")))
        steps.append(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true, output: "done")))
        steps.append(.toolStarted(tool))
        steps.append(.toolProgress(ToolProgress(id: "t1", output: "again")))
        for (index, step) in steps.enumerated() {
            #expect(held.events(for: step, at: t0 + Double(index), holding: false, holdingSteps: true).isEmpty)
        }
        let folded = held.release()
        // 500 text pieces, three starts, an end, three progresses, and the six statuses:
        // text came between each and the next, and took the line down.
        #expect(folded.count == 500 + 3 + 1 + 6 + 3)

        var turn = ThreadState()
        turn.apply(.turnStarted, at: t0)
        var every = turn
        turn.apply(folded)
        for (index, step) in steps.enumerated() { every.apply(step, at: t0 + Double(index)) }
        // Items have ids of their own: what they hold.
        #expect(turn.transcript.turns.map { $0.items.map(\.content) } == every.transcript.turns.map { $0.items.map(\.content) })
        #expect(turn.statusLine == every.statusLine)
        // Text came after the last one, and the agent at work again takes a line down.
        #expect(turn.statusLine == nil)
    }

    /// A status line put up after the reply's text took the one before down is the line
    /// shown once the chat is seen again: it is not folded back into the earlier line,
    /// under the text that came after that one (a chat kept out of sight showed no line
    /// where one in view showed "Compacting…").
    @Test func aStatusLineAfterTextThatTookTheOneBeforeDownIsNotFoldedBeforeThatText() {
        let tool = ToolRun(id: "t1", name: "terminal", startedAt: t0)
        for clearing: ThreadEvent in [
            .textDelta("Back."), .reasoningDelta("Hm."), .interimText("Looking.", alreadyStreamed: false), .toolStarted(tool),
        ] {
            var held = HeldPieces()
            let steps: [ThreadEvent] = [
                .status("Claude's API did not answer; trying again (attempt 6 of 10)…"), clearing,
                .status("Compacting the conversation…"), .toolProgress(ToolProgress(id: "t1", progress: "1")),
                .status("Compacting the conversation… (half)"),
            ]
            for (index, step) in steps.enumerated() {
                #expect(held.events(for: step, at: t0 + Double(index), holding: false, holdingSteps: true).isEmpty)
            }
            var turn = ThreadState()
            turn.apply(.turnStarted, at: t0)
            var every = turn
            let folded = held.release()
            // The two put up with only progress between them are one.
            #expect(folded.count == 4, "\(clearing)")
            turn.apply(folded)
            for (index, step) in steps.enumerated() { every.apply(step, at: t0 + Double(index)) }
            #expect(every.statusLine == "Compacting the conversation… (half)", "\(clearing)")
            #expect(turn.statusLine == every.statusLine, "\(clearing)")
        }
    }

    /// A tool's end whose start was missed (a reconnect) opens a turn when none is open,
    /// which takes no status line down (merge-p1): a line put up after it, folded into one
    /// from before it, comes to what applying each in turn does.
    @Test func aStatusLineAfterAToolsEndThatOpensATurnFoldsAsItApplies() {
        var held = HeldPieces()
        let steps: [ThreadEvent] = [
            .status("Claude's API did not answer; trying again (attempt 6 of 10)…"),
            .toolFinished(ToolResult(id: "t9", name: "terminal", succeeded: true, output: "done")),
            .status("Compacting the conversation…"),
        ]
        for (index, step) in steps.enumerated() {
            #expect(held.events(for: step, at: t0 + Double(index), holding: false, holdingSteps: true).isEmpty)
        }
        var folded = ThreadState()
        folded.apply(held.release())
        var every = ThreadState()
        for (index, step) in steps.enumerated() { every.apply(step, at: t0 + Double(index)) }
        #expect(every.statusLine == "Compacting the conversation…")
        #expect(folded.statusLine == every.statusLine)
    }

    /// A turn held whole and applied at its end is the turn applied piece by piece as it
    /// came, the times included: two seconds between events.
    @Test func aTurnHeldAndAppliedIsTheTurnAppliedPieceByPiece() {
        let tool = ToolRun(id: "t1", name: "terminal", label: "pytest", startedAt: t0)
        let events: [ThreadEvent] = [
            .turnStarted, .reasoningDelta("Let me "), .reasoningDelta("look."), .textDelta("Running "),
            .textDelta("the tests."), .toolStarted(tool), .textDelta("All "), .textDelta("green."),
            .turnFinished(.completed, finalText: "All green."),
        ]
        var oneByOne = ThreadState()
        for (index, event) in events.enumerated() { oneByOne.apply(event, at: t0 + Double(2 * index)) }

        var together = ThreadState()
        var held = HeldPieces()
        for (index, event) in events.enumerated() {
            together.apply(held.events(for: event, at: t0 + Double(2 * index), holding: true))
        }
        #expect(held.isEmpty)
        // Items have ids of their own: what they hold, and when the turns began and ended.
        #expect(together.transcript.turns.map { $0.items.map(\.content) } == oneByOne.transcript.turns.map { $0.items.map(\.content) })
        #expect(together.transcript.turns.map(\.startedAt) == oneByOne.transcript.turns.map(\.startedAt))
        #expect(together.transcript.turns.map(\.endedAt) == oneByOne.transcript.turns.map(\.endedAt))
        #expect(together.phase == oneByOne.phase)
    }

    /// Reasoning that came over twelve seconds while the window was covered, applied
    /// with the reply that followed it eight seconds later, still took twelve seconds:
    /// "Thought for 12s", not "Thought".
    @Test func reasoningHeldKeepsHowLongItTook() {
        var state = ThreadState()
        var held = HeldPieces()
        state.apply(held.events(for: .turnStarted, at: t0, holding: true))
        state.apply(held.events(for: .reasoningDelta("Let me "), at: t0, holding: true))
        state.apply(held.events(for: .reasoningDelta("look."), at: t0 + 6, holding: true))
        state.apply(held.events(for: .textDelta("Done."), at: t0 + 12, holding: true))
        // Seen again eight seconds later.
        state.apply(held.release())
        let reasoning = state.transcript.turns.last?.items.compactMap { item -> Reasoning? in
            if case let .reasoning(reasoning) = item.content { reasoning } else { nil }
        }.first
        #expect(reasoning?.duration == 12)
        #expect(state.transcript.turns.last?.startedAt == t0)
    }
}

/// The pieces of a reply on screen change the transcript at most once an interval: the
/// first after a pause at once, the ones that follow it together, an interval after.
@Suite struct PiecePacerTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func theFirstPieceIsAppliedAtOnce() {
        let pacer = PiecePacer(interval: 0.1)
        #expect(!pacer.holds(at: t0))
        #expect(pacer.due(after: t0) == 0)
    }

    @Test func piecesSoonAfterAChangeWaitForTheInterval() {
        var pacer = PiecePacer(interval: 0.1)
        pacer.applied(at: t0)
        #expect(pacer.holds(at: t0 + 0.03))
        #expect(abs(pacer.due(after: t0 + 0.03) - 0.07) < 1e-6)
        #expect(pacer.holds(at: t0 + 0.099))
        // An interval on, a piece makes the next change itself.
        #expect(!pacer.holds(at: t0 + 0.11))
        #expect(pacer.due(after: t0 + 0.25) == 0)
    }

    /// Pieces coming every 40 ms for a second change the transcript ten times, where
    /// they changed it 25 times; the text is the same in the end.
    @Test func aSecondOfPiecesMakesTenChanges() {
        var pacer = PiecePacer(interval: 0.1)
        var held = HeldPieces()
        var state = ThreadState()
        var unpaced = ThreadState()
        state.apply(.turnStarted, at: t0)
        unpaced.apply(.turnStarted, at: t0)
        var changes = 0
        var flushAt: Date?
        for index in 0..<25 {
            let now = t0 + Double(index) * 0.04
            unpaced.apply(.textDelta("w\(index) "), at: now)
            if let due = flushAt, now >= due {
                state.apply(held.release())
                pacer.applied(at: due)
                changes += 1
                flushAt = nil
            }
            let events = held.events(for: .textDelta("w\(index) "), at: now, holding: pacer.holds(at: now))
            if events.isEmpty {
                if flushAt == nil { flushAt = now + pacer.due(after: now) }
            } else {
                state.apply(events)
                pacer.applied(at: now)
                changes += 1
            }
        }
        state.apply(held.release())
        changes += 1
        #expect(changes <= 11)
        // Items have ids of their own: what they hold is the same.
        #expect(state.transcript.turns.map { $0.items.map(\.content) } == unpaced.transcript.turns.map { $0.items.map(\.content) })
        #expect(!unpaced.transcript.turns.isEmpty)
    }
}
