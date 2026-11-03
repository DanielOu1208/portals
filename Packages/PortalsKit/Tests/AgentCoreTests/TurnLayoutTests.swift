import Foundation
import Testing
@testable import AgentCore

@Suite struct TurnLayoutTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func turn(_ contents: [TurnItem.Content], finishedAfter seconds: TimeInterval? = 38) -> Turn {
        Turn(
            startedAt: t0,
            endedAt: seconds.map { t0.addingTimeInterval($0) },
            outcome: seconds == nil ? nil : .completed,
            items: contents.map { TurnItem($0) }
        )
    }

    private func tool(_ id: String, _ state: ToolRun.State = .succeeded) -> TurnItem.Content {
        .tool(ToolRun(id: id, name: "terminal", state: state, startedAt: t0))
    }

    private let user = TurnItem.Content.user(UserMessage(text: "fix it", sentAt: Date(timeIntervalSince1970: 1_000)))
    private let reasoning = TurnItem.Content.reasoning(Reasoning(text: "hmm", startedAt: Date(timeIntervalSince1970: 1_000)))

    /// "item" for a plain piece, or the fold's summary and how many items it holds.
    private func shape(_ pieces: [TurnLayout.Piece]) -> [String] {
        pieces.map { piece in
            switch piece {
            case .item: "item"
            case let .steps(steps): "\(steps.summary) [\(steps.items.count)]"
            }
        }
    }

    // MARK: While the turn runs

    @Test func theWorkUnderWayIsOneLineAndOnlyWhatIsFinishedIsFoldedIntoIt() throws {
        let thought = TurnItem.Content.reasoning(Reasoning(text: "hmm", startedAt: t0, endedAt: t0.addingTimeInterval(4)))
        let thinking = TurnItem.Content.reasoning(Reasoning(text: "and now", startedAt: t0))
        let running = turn([user, thought, tool("t1"), tool("t2", .running), thinking], finishedAfter: nil)
        let layout = TurnLayout.layout(for: running)
        // Nothing of the work is listed: it is the line's.
        #expect(shape(layout.pieces) == ["item"])
        let underWay = try #require(layout.underWay)
        // The tool still running is the status line's; the reasoning still streaming
        // shows live in it; what is done folds into the line.
        #expect(underWay.done.map(\.content) == [thought, tool("t1")])
        #expect(underWay.items.map(\.content) == [thought, tool("t1"), tool("t2", .running)])
        #expect(underWay.thought?.text == "and now")
        #expect(underWay.thoughtID == running.items[4].id)
        #expect(underWay.summary == "1 step")
        #expect(underWay.id == running.items[1].id)
    }

    @Test func aFinishedTurnHasNoWorkUnderWay() {
        #expect(TurnLayout.layout(for: turn([user, tool("t1"), .text("Done")])).underWay == nil)
        // Nor a running one with no work since the agent last said something.
        #expect(TurnLayout.layout(for: turn([user, tool("t1"), .text("Looking")], finishedAfter: nil)).underWay == nil)
        #expect(TurnLayout.layout(for: turn([user], finishedAfter: nil)).underWay == nil)
    }

    @Test func theFirstStepRunningHasNothingFoldedYet() throws {
        let underWay = try #require(TurnLayout.layout(for: turn([user, tool("t1", .running)], finishedAfter: nil)).underWay)
        #expect(underWay.done.isEmpty)
        #expect(underWay.summary == nil)
        #expect(underWay.thought == nil)
        #expect(underWay.thoughtID == nil)
        #expect(underWay.items.map(\.content) == [tool("t1", .running)])
    }

    @Test func liveToolOutputStaysReachableAndKeepsItsRowWhenTheToolFinishes() throws {
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.toolStarted(ToolRun(id: "e", name: "terminal")))
        state.apply(.toolProgress(ToolProgress(id: "e", output: "first\nsecond")))
        let live = try #require(TurnLayout.layout(for: state.transcript.turns[0]).underWay)
        #expect(live.done.isEmpty)
        let row = try #require(live.items.first)
        guard case let .tool(run) = row.content else { Issue.record("Expected running tool row"); return }
        #expect(run.state == .running && run.output == "first\nsecond")
        state.apply(.toolFinished(ToolResult(id: "e", name: "terminal", succeeded: true, output: "final")))
        let ended = try #require(TurnLayout.layout(for: state.transcript.turns[0]).underWay)
        #expect(ended.items.count == 1)
        #expect(ended.items.first?.id == row.id)
        #expect(ended.done == ended.items)
    }

    @Test func aThoughtShowsLiveOnlyWhileItStreamsAsTheLatestThing() throws {
        let streaming = TurnItem.Content.reasoning(Reasoning(text: "Let me read the file", startedAt: t0))
        #expect(TurnLayout.layout(for: turn([user, streaming], finishedAfter: nil)).underWay?.thought?.text == "Let me read the file")
        // Once it ends (the agent moved on), it folds with the rest.
        let ended = TurnItem.Content.reasoning(Reasoning(text: "Let me read the file", startedAt: t0, endedAt: t0.addingTimeInterval(12)))
        let moved = try #require(TurnLayout.layout(for: turn([user, ended, tool("t1", .running)], finishedAfter: nil)).underWay)
        #expect(moved.thought == nil)
        #expect(moved.done.map(\.content) == [ended])
        #expect(moved.summary == "Thought for 12s")
        // Reasoning with no words yet is plain thinking.
        let blank = TurnItem.Content.reasoning(Reasoning(text: " \n", startedAt: t0))
        #expect(TurnLayout.layout(for: turn([user, blank], finishedAfter: nil)).underWay?.thought == nil)
    }

    @Test func theRoomForThoughtsStaysThroughToolCallsUntilTheAgentSaysSomething() throws {
        let ended = TurnItem.Content.reasoning(Reasoning(text: "Let me read the file", startedAt: t0, endedAt: t0.addingTimeInterval(3)))
        // No thought yet: no room.
        #expect(TurnLayout.layout(for: turn([user, tool("t1", .running)], finishedAfter: nil)).underWay?.hasThought == false)
        // A thought streaming, then a tool call after it: the room stays, with no thought in it.
        let streaming = TurnItem.Content.reasoning(Reasoning(text: "Let me read the file", startedAt: t0))
        #expect(TurnLayout.layout(for: turn([user, streaming], finishedAfter: nil)).underWay?.hasThought == true)
        let between = try #require(TurnLayout.layout(for: turn([user, ended, tool("t1", .running)], finishedAfter: nil)).underWay)
        #expect(between.hasThought)
        #expect(between.thought == nil)
        // Once the agent says something, the work after it starts with no room.
        let after = TurnLayout.layout(for: turn([user, ended, tool("t1"), .text("Found it."), tool("t2", .running)], finishedAfter: nil)).underWay
        #expect(after?.hasThought == false)
        // Reasoning with no words is no thought.
        let blank = TurnItem.Content.reasoning(Reasoning(text: " \n", startedAt: t0, endedAt: t0.addingTimeInterval(1)))
        #expect(TurnLayout.layout(for: turn([user, blank, tool("t1", .running)], finishedAfter: nil)).underWay?.hasThought == false)
    }

    @Test func noticesUnderWayStayListedAboveTheLine() {
        let notice = TurnItem.Content.notice(Notice(.warning, "slow"))
        let layout = TurnLayout.layout(for: turn([user, tool("t1"), notice, tool("t2")], finishedAfter: nil))
        #expect(shape(layout.pieces) == ["item", "item"])
        guard case let .item(listed) = layout.pieces[1] else {
            Issue.record("expected the notice")
            return
        }
        #expect(listed.content == notice)
        #expect(layout.underWay?.summary == "2 steps")
    }

    @Test func theStatusFollowsTheRun() {
        var state = ThreadState()
        #expect(state.runStatus(replyIsArriving: false) == nil)

        let sent = state.messageSent("go", at: t0)
        state.messageDelivered(sent, outcome: .started)
        #expect(state.runStatus(replyIsArriving: false) == .thinking)

        state.apply(.reasoningDelta("let me see"), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .thinking)

        let first = ToolRun(id: "t1", name: "terminal", label: "swift test", startedAt: t0)
        let second = ToolRun(id: "t2", name: "read_file", label: "Package.swift", startedAt: t0)
        state.apply(.toolStarted(first), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .tool(first, others: 0))
        state.apply(.toolStarted(second), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .tool(second, others: 1))

        state.apply(.toolFinished(ToolResult(id: "t2", name: "read_file", succeeded: true)), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true)), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .thinking)

        // While the reply is being written there is nothing to add to it.
        state.apply(.textDelta("All tests"), at: t0)
        #expect(state.runStatus(replyIsArriving: true) == nil)
        // If the text stops coming, the line is back.
        #expect(state.runStatus(replyIsArriving: false) == .thinking)

        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == nil)
    }

    @Test func whatTheHostSaysAboutTheRunIsShownAndWaitingOnTheUserComesFirst() {
        var state = ThreadState()
        let sent = state.messageSent("go", at: t0)
        state.messageDelivered(sent, outcome: .started)
        state.apply(.textDelta("Partial"), at: t0)
        state.apply(.status("Waiting on provider — retrying in 2s"), at: t0)
        // A delay is worth saying even under text that was arriving a moment ago.
        #expect(state.runStatus(replyIsArriving: true) == .note("Waiting on provider — retrying in 2s"))
        state.apply(.status(nil), at: t0)

        let run = ToolRun(id: "t1", name: "terminal", label: "rm -rf build", startedAt: t0)
        state.apply(.toolStarted(run), at: t0)
        let request = PendingRequest(id: "r1", kind: .approval(ApprovalRequest(command: "rm -rf build", reason: nil, choices: [.once, .deny])))
        state.apply(.requestOpened(request), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .waitingForUser)
        state.requestAnswered("r1", with: .approval(.once), at: t0)
        #expect(state.runStatus(replyIsArriving: false) == .tool(run, others: 0))
    }

    @Test func aRunningTurnFoldsTheWorkAboveWhatTheAgentSaysAndPutsTheRestInTheLine() {
        let thought = TurnItem.Content.reasoning(Reasoning(text: "hmm", startedAt: t0, endedAt: t0.addingTimeInterval(4)))
        let timed = TurnItem.Content.tool(ToolRun(id: "t1", name: "terminal", state: .succeeded, startedAt: t0.addingTimeInterval(5), duration: 3))
        let running = turn([user, thought, timed, .text("Found it. Fixing."), tool("t2"), tool("t3", .running)], finishedAfter: nil)
        // Folded the moment the text came, timed by its steps; the work since is the
        // line's, all but the tool still running folded into it.
        let layout = TurnLayout.layout(for: running)
        #expect(shape(layout.pieces) == ["item", "1 step · 8s [2]", "item"])
        #expect(layout.underWay?.done.map(\.content) == [tool("t2")])
        #expect(layout.underWay?.summary == "1 step")
        // With nothing said yet, nothing is folded above the line.
        #expect(shape(TurnLayout.pieces(for: turn([user, thought, tool("t1")], finishedAfter: nil))) == ["item"])
    }

    @Test func aRunOfToolCallsFoldsIntoTheLineAndKeepsItsFoldOnceSomethingIsSaid() throws {
        func timed(_ id: String, from start: TimeInterval, for seconds: TimeInterval, _ state: ToolRun.State = .succeeded) -> TurnItem.Content {
            .tool(ToolRun(id: id, name: "terminal", state: state, startedAt: t0.addingTimeInterval(start), duration: seconds))
        }
        let thought = TurnItem.Content.reasoning(Reasoning(text: "hmm", startedAt: t0, endedAt: t0.addingTimeInterval(1)))
        let running = turn(
            [user, timed("t1", from: 0, for: 2), thought, timed("t2", from: 3, for: 1, .failed), timed("t3", from: 5, for: 2), thought, tool("t4", .running)],
            finishedAfter: nil
        )
        let layout = TurnLayout.layout(for: running)
        // However many steps, one line: the message above it, nothing else.
        #expect(shape(layout.pieces) == ["item"])
        let underWay = try #require(layout.underWay)
        #expect(underWay.summary == "3 steps")
        #expect(underWay.done.count == 5)

        // Once the agent says something, the same work folds as before, under the same
        // id: a line left open stays open as the fold.
        let said = turn([user, timed("t1", from: 0, for: 2), thought, timed("t2", from: 3, for: 1, .failed), timed("t3", from: 5, for: 2), .text("Done.")])
        guard case let .steps(done) = TurnLayout.pieces(for: said)[1] else {
            Issue.record("expected the fold after the message")
            return
        }
        #expect(done.id == said.items[1].id)
        #expect(underWay.id == running.items[1].id)
        #expect(done.failedCount == 1)
    }

    @Test func aLineOpenedStaysOpenAsTheFoldWhenItsStretchOpensWithANotice() throws {
        // A notice (or a command's output, a compaction) before the first step: the fold
        // the stretch becomes starts with it, so the line must have its id too.
        let items = [TurnItem(user), TurnItem(.notice(Notice(.warning, "Retrying"))), TurnItem(tool("t1")), TurnItem(tool("t2", .running))]
        let running = Turn(startedAt: t0, items: items)
        let underWay = try #require(TurnLayout.layout(for: running).underWay)
        let said = Turn(startedAt: t0, endedAt: t0.addingTimeInterval(9), outcome: .completed, items: items + [TurnItem(.text("Done."))])
        guard case let .steps(fold) = TurnLayout.pieces(for: said)[1] else {
            Issue.record("expected the fold after the message")
            return
        }
        #expect(underWay.id == fold.id)
    }

    @Test func anAnsweredRequestIsAStepOfTheLine() {
        let record = TurnItem.Content.request(RequestRecord(id: "r", kind: .approval, prompt: "rm -rf build", answer: "Denied"))
        #expect(TurnLayout.layout(for: turn([user, tool("t1"), record], finishedAfter: nil)).underWay?.summary == "2 steps")
    }

    @Test func aFinishedTurnFoldsItsWorkAboveTheAnswer() {
        let finished = turn([user, reasoning, tool("t1"), tool("t2", .failed), tool("t3"), .text("Fixed.")])
        let pieces = TurnLayout.pieces(for: finished)
        #expect(shape(pieces) == ["item", "3 steps · 38s [4]", "item"])

        guard case let .steps(steps) = pieces[1] else {
            Issue.record("expected the fold in the middle")
            return
        }
        #expect(steps.toolCount == 3)
        #expect(steps.failedCount == 1)
        #expect(steps.id == finished.items[1].id) // stable across redraws
        // The message stays above the fold and the answer below it.
        #expect(pieces.first == .item(finished.items[0]))
        #expect(pieces.last == .item(finished.items[5]))
    }

    @Test func whatTheAgentSaidOnTheWayStaysInViewBetweenFolds() {
        func timed(_ id: String, from start: TimeInterval, for seconds: TimeInterval) -> TurnItem.Content {
            .tool(ToolRun(id: id, name: "terminal", state: .succeeded, startedAt: t0.addingTimeInterval(start), duration: seconds))
        }
        let finished = turn([
            user, .text("Running the tests first."), timed("t1", from: 2, for: 3), timed("t2", from: 6, for: 6),
            .text("Found it. Fixing."), timed("t3", from: 15, for: 1), .notice(Notice(.warning, "slow")), .text("Fixed."),
        ])
        // Each fold is timed by its own steps: first start to last end.
        #expect(shape(TurnLayout.pieces(for: finished)) == ["item", "item", "2 steps · 10s [2]", "item", "1 step · 1s [1]", "item", "item"])
    }

    @Test func aMessageSentDuringTheTurnIsNotFoldedAway() {
        let steered = TurnItem.Content.user(UserMessage(text: "also the docs", sentAt: t0, delivery: .steered))
        let finished = turn([user, tool("t1"), steered, tool("t2"), .text("Done.")])
        // Steps read back from the host's history have no times: several folds go without.
        #expect(shape(TurnLayout.pieces(for: finished)) == ["item", "1 step [1]", "item", "1 step [1]", "item"])
    }

    @Test func aTurnWithNoWorkIsNotFolded() {
        #expect(shape(TurnLayout.pieces(for: turn([user, .text("Hello!")]))) == ["item", "item"])
        #expect(shape(TurnLayout.pieces(for: turn([user, .notice(Notice(.warning, "w")), .text("Hi")]))) == ["item", "item", "item"])
    }

    @Test func reasoningAloneFoldsAsThought() {
        let pieces = TurnLayout.pieces(for: turn([user, reasoning, .text("42")], finishedAfter: 12))
        #expect(shape(pieces) == ["item", "Thought for 12s [1]", "item"])
        // Thinking that came at once, just before the words, is not "for 0s".
        let quick = TurnItem.Content.reasoning(Reasoning(text: "hmm", startedAt: t0, endedAt: t0.addingTimeInterval(0.3)))
        #expect(shape(TurnLayout.pieces(for: turn([user, quick, .text("42")]))) == ["item", "Thought [1]", "item"])
    }

    @Test func oneToolIsOneStep() {
        #expect(shape(TurnLayout.pieces(for: turn([user, tool("t1"), .text("Done")], finishedAfter: 3))) == ["item", "1 step · 3s [1]", "item"])
    }

    @Test func aTurnThatEndedWithoutAnAnswerStillFolds() {
        let stopped = turn([user, tool("t1"), tool("t2")])
        #expect(shape(TurnLayout.pieces(for: stopped)) == ["item", "2 steps · 38s [2]"])
    }

    @Test func aTurnTheAgentStartedItselfFoldsFromItsFirstItem() {
        #expect(shape(TurnLayout.pieces(for: turn([tool("t1"), .text("A job finished.")], finishedAfter: 5))) == ["1 step · 5s [1]", "item"])
    }

    @Test func anAnsweredRequestIsPartOfTheWork() {
        let record = TurnItem.Content.request(RequestRecord(id: "r", kind: .approval, prompt: "rm -rf build", answer: "Denied"))
        #expect(shape(TurnLayout.pieces(for: turn([user, tool("t1"), record, .text("Left it alone.")]))) == ["item", "1 step · 38s [2]", "item"])
    }

    @Test func durations() {
        #expect(TurnLayout.shortDuration(0.4) == "0s")
        #expect(TurnLayout.shortDuration(38.4) == "38s")
        #expect(TurnLayout.shortDuration(60) == "1m")
        #expect(TurnLayout.shortDuration(125) == "2m 5s")
        #expect(TurnLayout.shortDuration(3_600) == "1h")
        #expect(TurnLayout.shortDuration(3_840) == "1h 4m")
        #expect(TurnLayout.toolDuration(0.01) == "0s")
        #expect(TurnLayout.toolDuration(2.14) == "2.1s")
        #expect(TurnLayout.toolDuration(12.4) == "12s")
        #expect(TurnLayout.toolDuration(75) == "1m 15s")
    }
}

@Suite struct DiffTextTests {
    @Test func aUnifiedDiffIsReadLineByLine() {
        let diff = DiffText(FakeBackend.sampleDiff)
        #expect(diff.fileName == "plugin.py")
        #expect(diff.added == 2)
        #expect(diff.removed == 2)
        #expect(diff.stats == "+2 \u{2212}2")
        #expect(diff.lines.map(\.kind) == [.hunk, .context, .removed, .removed, .added, .added])
        #expect(diff.lines[1].text == "def register(ctx):")
        #expect(diff.lines[2].text == "    ctx.register_hook(\"on_session_end\", notify)")
    }

    @Test func aNewFileHasOnlyAdditions() {
        let diff = DiffText("--- a//tmp/aeriportal-cwd/hello.txt\n+++ b//tmp/aeriportal-cwd/hello.txt\n@@ -0,0 +1 @@\n+hi")
        #expect(diff.fileName == "hello.txt")
        #expect(diff.stats == "+1")
        #expect(diff.lines.map(\.kind) == [.hunk, .added])
    }

    @Test func deletedFilesAndNoNewlineMarkers() {
        let diff = DiffText("--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n\\ No newline at end of file\n")
        #expect(diff.fileName == "old.txt")
        #expect(diff.stats == "+0 \u{2212}1")
        #expect(diff.lines.map(\.kind) == [.hunk, .removed])
    }

    @Test func textThatIsNotADiffHasNoStats() {
        let diff = DiffText("just some text")
        #expect(diff.stats == nil)
        #expect(diff.fileName == nil)
        #expect(diff.lines.map(\.text) == ["just some text"])
    }
}
