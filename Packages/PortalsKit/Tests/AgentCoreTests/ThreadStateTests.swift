import Foundation
import Testing
@testable import AgentCore

@Suite struct ThreadStateTests {
    /// The contents of every item, turn by turn, without ids and dates.
    private func contents(_ state: ThreadState) -> [[TurnItem.Content]] {
        state.transcript.turns.map { $0.items.map(\.content) }
    }

    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func aSentMessageOpensATurnAndStreamsIntoIt() {
        var state = ThreadState()
        let item = state.messageSent("hi", at: t0)
        #expect(state.isRunning)
        state.messageDelivered(item, outcome: .started)

        state.apply(.turnStarted, at: t0)
        state.apply(.textDelta("Hel"), at: t0)
        state.apply(.textDelta("lo"), at: t0)
        #expect(contents(state) == [[
            .user(UserMessage(text: "hi", sentAt: t0, delivery: .started)),
            .text("Hello"),
        ]])
        #expect(state.transcript.turns[0].isRunning)

        state.apply(.turnFinished(.completed, finalText: "Hello"), at: t0.addingTimeInterval(4))
        #expect(state.phase == .idle)
        #expect(state.transcript.turns[0].outcome == .completed)
        #expect(state.transcript.turns[0].endedAt == t0.addingTimeInterval(4))
        // The final text does not duplicate what was streamed.
        #expect(contents(state)[0].count == 2)
    }

    @Test func aReplyThatWasNotStreamedComesFromTheFinalText() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.turnFinished(.completed, finalText: "All at once"), at: t0)
        #expect(contents(state)[0].last == .text("All at once"))
    }

    @Test func textBetweenToolCallsIsKeptPieceByPiece() {
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        let tool = ToolRun(id: "t1", name: "terminal", label: "pytest", startedAt: t0)

        // Streamed, then closed by the host with its own copy, which wins.
        state.apply(.textDelta("Running the tests first"), at: t0)
        state.apply(.interimText("Running the tests first.", alreadyStreamed: true), at: t0)
        // Text that streams after a closed piece is a new piece, even with no tool between.
        state.apply(.textDelta("Then I'll read the file."), at: t0)
        state.apply(.toolStarted(tool), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true)), at: t0)
        // A Codex model's commentary comes only closed, never streamed. Sent twice, it
        // shows once.
        state.apply(.interimText("Found it: the token loads too late.\n", alreadyStreamed: false), at: t0)
        state.apply(.interimText("Found it: the token loads too late.", alreadyStreamed: false), at: t0)
        // A closing copy of text shown before the tool started adds nothing.
        state.apply(.interimText("Then I'll read the file.", alreadyStreamed: true), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Fixed it."), at: t0)

        let texts = contents(state)[0].compactMap { content -> String? in
            if case let .text(text) = content { text } else { nil }
        }
        // The final text was not streamed, and the commentary is not the answer: it is added.
        #expect(texts == ["Running the tests first.", "Then I'll read the file.", "Found it: the token loads too late.", "Fixed it."])
    }

    @Test func aFinalTextAlreadyShownIsNotAddedAgain() {
        var state = ThreadState()
        state.messageSent("go", at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", startedAt: t0)), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true)), at: t0)
        state.apply(.interimText("All done.", alreadyStreamed: false), at: t0)
        state.apply(.turnFinished(.completed, finalText: "All done."), at: t0)
        #expect(contents(state)[0].filter { $0 == .text("All done.") }.count == 1)
    }

    @Test func eachMessageAfterAFinishedTurnOpensANewTurn() {
        var state = ThreadState()
        state.messageSent("one", at: t0)
        state.apply(.turnFinished(.completed, finalText: "1"), at: t0)
        state.messageSent("two", at: t0)
        state.apply(.textDelta("2"), at: t0)
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].isRunning)
    }

    @Test func aMessageSteeredIntoARunJoinsThatTurnWhenTheBackendSaysSo() {
        var state = ThreadState()
        state.messageSent("start", at: t0)
        state.apply(.textDelta("working"), at: t0)

        let steer = state.messageSent("use the other file", at: t0)
        // Until the backend answers it is not part of the transcript.
        #expect(state.pending.map(\.message.text) == ["use the other file"])
        #expect(contents(state)[0].count == 2)

        state.messageDelivered(steer, outcome: .steered, at: t0)
        state.apply(.textDelta(" more"), at: t0)
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.count == 1)
        #expect(contents(state)[0] == [
            .user(UserMessage(text: "start", sentAt: t0)),
            .text("working"),
            .user(UserMessage(text: "use the other file", sentAt: t0, delivery: .steered)),
            .text("more"),
        ])
    }

    @Test func aQueuedMessageWaitsAndThenOpensTheNextTurn() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        state.apply(.textDelta("one"), at: t0)
        let queued = state.messageSent("second", at: t0)
        state.messageDelivered(queued, outcome: .queued, at: t0)

        // Still waiting, and the reply to "first" is not split around it.
        #expect(state.pending.map(\.message.delivery) == [.queued])
        state.apply(.textDelta(" two"), at: t0)
        #expect(contents(state) == [[.user(UserMessage(text: "first", sentAt: t0)), .text("one two")]])

        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.pending.count == 1)
        #expect(state.phase == .idle)

        state.apply(.turnStarted, at: t0.addingTimeInterval(1))
        state.apply(.textDelta("three"), at: t0.addingTimeInterval(1))
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.count == 2)
        #expect(contents(state)[1] == [
            .user(UserMessage(text: "second", sentAt: t0, delivery: .queued)),
            .text("three"),
        ])
        #expect(state.transcript.turns[1].items[0].id == queued)
    }

    @Test func queuedMessagesRunInTheOrderTheyWereSent() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let a = state.messageSent("a", at: t0)
        let b = state.messageSent("b", at: t0)
        state.messageDelivered(a, outcome: .queued, at: t0)
        state.messageDelivered(b, outcome: .queued, at: t0)
        state.apply(.turnFinished(.completed, finalText: "1"), at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.turnFinished(.completed, finalText: "2"), at: t0)
        state.apply(.turnStarted, at: t0)

        #expect(state.transcript.turns.count == 3)
        #expect(contents(state)[1].first == .user(UserMessage(text: "a", sentAt: t0, delivery: .queued)))
        #expect(contents(state)[2].first == .user(UserMessage(text: "b", sentAt: t0, delivery: .queued)))
        #expect(state.pending.isEmpty)
    }

    @Test func aQueuedAnswerThatArrivesAfterItsTurnBeganStillJoinsThatTurn() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let late = state.messageSent("second", at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "1"), at: t0.addingTimeInterval(2))
        // The next turn's first event overtakes the answer to the send.
        state.apply(.turnStarted, at: t0.addingTimeInterval(3))
        state.apply(.textDelta("2"), at: t0.addingTimeInterval(3))
        #expect(state.pending.count == 1)

        state.messageDelivered(late, outcome: .queued, at: t0.addingTimeInterval(4))
        #expect(state.pending.isEmpty)
        #expect(contents(state)[1] == [
            .user(UserMessage(text: "second", sentAt: t0.addingTimeInterval(1), delivery: .queued)),
            .text("2"),
        ])
    }

    @Test func aMessageSentAsARunEndedStartsItsOwnTurn() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let next = state.messageSent("second", at: t0)
        state.apply(.turnFinished(.completed, finalText: "1"), at: t0)
        // The backend was already idle when the message arrived.
        state.messageDelivered(next, outcome: .started, at: t0)

        #expect(state.pending.isEmpty)
        #expect(state.isRunning)
        #expect(contents(state)[1] == [.user(UserMessage(text: "second", sentAt: t0, delivery: .started))])
    }

    @Test func aPendingMessageThatCouldNotBeSentKeepsItsRetryableTurn() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let lost = state.messageSent("second", at: t0)
        state.messageFailed(lost, TurnFailure(message: "Not connected"), at: t0)

        #expect(state.pending.isEmpty)
        #expect(state.isRunning) // the run that was going on is untouched
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns.first?.outcome == .failed(TurnFailure(message: "Not connected")))
        #expect(state.transcript.turns.first?.items.first?.id == lost)
        #expect(state.transcript.turns.last?.isRunning == true)
    }

    @Test func aTurnAnotherAgentsMessageOpenedDoesNotTakeAQueuedMessage() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        state.apply(.turnStarted, at: t0)
        let mine = state.messageSent("mine", at: t0)
        state.messageDelivered(mine, outcome: .queued, at: t0)
        state.apply(.turnFinished(.completed, finalText: "one"), at: t0)

        // Aeri's message, queued before the user's, runs first.
        state.apply(.turnOpened(by: "[Portals: from Aeri (thread aeri)]\nCheck the build"), at: t0.addingTimeInterval(1))
        state.apply(.textDelta("Built."), at: t0.addingTimeInterval(1))
        #expect(contents(state)[1] == [
            .user(UserMessage(text: "[Portals: from Aeri (thread aeri)]\nCheck the build", sentAt: t0.addingTimeInterval(1), delivery: .started)),
            .text("Built."),
        ])
        #expect(state.pending.map(\.id) == [mine])

        // The user's own message opens the turn after.
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(2))
        state.apply(.turnStarted, at: t0.addingTimeInterval(3))
        #expect(contents(state)[2].first == .user(UserMessage(text: "mine", sentAt: t0, delivery: .queued)))
        #expect(state.pending.isEmpty)
    }

    @Test func theAgentCanStartATurnItself() {
        var state = ThreadState()
        state.apply(.turnStarted, at: t0)
        state.apply(.textDelta("A background job finished."), at: t0)
        #expect(state.isRunning)
        #expect(contents(state) == [[.text("A background job finished.")]])
    }

    @Test func statusIsTransientAndClearsWhenTheTurnEnds() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.status("waiting on provider"), at: t0)
        #expect(state.statusLine == "waiting on provider")
        state.apply(.status(""), at: t0)
        #expect(state.statusLine == nil)
        state.apply(.status("  retrying  "), at: t0)
        #expect(state.statusLine == "retrying")
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.statusLine == nil)
        // Status never lands in the transcript.
        #expect(contents(state)[0].count == 1)
    }

    @Test func aRetryLineClearsOnceTheAgentIsAtWorkAgain() {
        // Claude Code says when its API is tried again, and nothing once it answers.
        for event: ThreadEvent in [
            .textDelta("Back."), .reasoningDelta("Hm."), .interimText("Looking.", alreadyStreamed: false),
            .toolStarted(ToolRun(id: "t1", name: "read_file", startedAt: t0)),
        ] {
            var state = ThreadState()
            state.messageSent("hi", at: t0)
            state.apply(.status("Claude's API did not answer; trying again (attempt 6 of 10)…"), at: t0)
            state.apply(event, at: t0)
            #expect(state.statusLine == nil, "\(event)")
        }
    }

    /// A status line the host put up between runs (Claude Code's heartbeat while a
    /// background agent waits out a usage limit, `api_retry`, after the turn's end) is not
    /// the next run's: that run begins thinking, however it begins, and not under the
    /// line until something takes it down.
    /// The host's run of another's message began (a start with no message of this device's)
    /// while this device's own, sent at rest, had opened a turn here, and the answer then
    /// says the host queued it: that turn is the host's run, which goes on, so a tool's end
    /// whose start was missed lands in it and leaves the line the host holds for that run
    /// (Codex's second look at the merge, merge-p1).
    @Test func aRunTheHostBeganUnderAMessageItThenQueuedStaysOpenAndKeepsItsLine() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnStarted, at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        #expect(state.isRunning)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.first?.isRunning == true)
        #expect(state.pending.map(\.id) == [mine])
        state.apply(.status("Reconnecting… 1/5"), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t9", name: "terminal", succeeded: true, output: "done")), at: t0)
        #expect(state.statusLine == "Reconnecting… 1/5")
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.first?.isRunning == true)
    }

    /// The same, when the host's list names the message by its id (`message_ids`) before the
    /// answer: the host's run stays open, and the message waits under its place (Codex's
    /// review of the follow-up).
    @Test func aRunTheHostBeganUnderAMessageItThenListsStaysOpen() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "mine", messageID: mine)], canSteer: false, steered: nil), at: t0)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.first?.isRunning == true)
        #expect(state.pending.map(\.id) == [mine])
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.first?.isRunning == true)
        #expect(state.pending.map(\.id) == [mine])
    }

    /// The same, with the host's run already saying something before the answer came: the
    /// message leaves that run, which goes on with what it said, and opens its own run
    /// once, when the host begins it (Codex's review of the follow-up).
    @Test func aRunTheHostBeganUnderAMessageThatSaidSomethingGivesTheQueuedMessageBack() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.textDelta("Working on the desk's ask."), at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        #expect(state.transcript.turns.count == 1)
        #expect(contents(state)[0] == [.text("Working on the desk's ask.")])
        #expect(state.pending.map(\.id) == [mine])
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("1"), at: t0)
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id == mine)
        #expect(state.transcript.turns.flatMap(\.items).filter(\.isUserMessage).count == 1)
    }

    /// A tool's end whose start was missed opens a turn when none is open, but is no run's
    /// start: the host keeps its line over it, and so does the app, so a device that opens
    /// the thread whole shows the line every device following it shows (merge-p1).
    @Test func aToolsEndThatOpensATurnKeepsTheStatusLine() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        // Queued behind a run whose start is still to come: running, with no turn open.
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        #expect(state.isRunning)
        state.apply(.status("Reconnecting… 1/5"), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t9", name: "terminal", succeeded: true, output: "done")), at: t0)
        #expect(state.statusLine == "Reconnecting… 1/5")
        #expect(state.transcript.turns.last?.isRunning == true)
        // The host's start of a run takes it down, as the host does.
        state.apply(.turnStarted, at: t0)
        #expect(state.statusLine == nil)
    }

    @Test func aStatusLineFromBetweenRunsIsNotTheNextRunsLine() {
        let line = "Claude's API did not answer; trying again (attempt 6 of 10)…"
        func atRest() -> ThreadState {
            var state = ThreadState()
            state.apply(.turnStarted, at: t0)
            state.apply(.turnFinished(.completed, finalText: "Done."), at: t0)
            state.apply(.status(line), at: t0.addingTimeInterval(1))
            return state
        }

        var started = atRest()
        started.apply(.turnStarted, at: t0.addingTimeInterval(2))
        #expect(started.runStatus(replyIsArriving: false) == .thinking)

        var sent = atRest()
        sent.messageSent("go on", at: t0.addingTimeInterval(2))
        #expect(sent.runStatus(replyIsArriving: false) == .thinking)

        var opened = atRest()
        opened.apply(.turnOpened(by: "from the desk"), at: t0.addingTimeInterval(2))
        #expect(opened.runStatus(replyIsArriving: false) == .thinking)

        var own = atRest()
        let id = UUID()
        own.apply(.ownTurnStarted(id), at: t0.addingTimeInterval(2))
        #expect(own.runStatus(replyIsArriving: false) == .thinking)

        // One put up in the run itself stays until taken down.
        started.apply(.status(line), at: t0.addingTimeInterval(3))
        #expect(started.runStatus(replyIsArriving: false) == .note(line))
    }

    /// A line that comes between a message sent here (its turn opened at once) and the
    /// host saying its run begins is from before that run: the run's start takes it down,
    /// as the host takes down the line it tells a device that opens the thread whole.
    @Test func aStatusLineBeforeTheHostSaysTheRunOfAMessageSentHereBeginsIsNotTheRunsLine() {
        let line = "Claude's API did not answer; trying again (attempt 6 of 10)…"
        var own = ThreadState()
        let id = own.messageSent("go on", at: t0)
        own.apply(.status(line), at: t0)
        own.apply(.ownTurnStarted(id), at: t0)
        #expect(own.statusLine == nil)

        var other = ThreadState()
        other.messageSent("go on", at: t0)
        other.apply(.status(line), at: t0)
        other.apply(.turnOpened(by: "from the desk"), at: t0)
        #expect(other.statusLine == nil)

        var started = ThreadState()
        started.messageSent("go on", at: t0)
        started.apply(.status(line), at: t0)
        started.apply(.turnStarted, at: t0)
        #expect(started.statusLine == nil)

        // One put up after the run began stays.
        own.apply(.status(line), at: t0)
        #expect(own.statusLine == line)
    }

    @Test func aFailureEndsTheTurnAndReplacesItsErrorLines() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.notice(Notice(.warning, "Title generation failed")), at: t0)
        state.apply(.notice(Notice(.error, "No provider")), at: t0)
        state.apply(.notice(Notice(.error, "No provider")), at: t0)
        #expect(contents(state)[0].count == 3) // the repeated line is dropped

        let failure = TurnFailure(message: "The request failed.", detail: "No provider", retryable: true)
        state.apply(.turnFinished(.failed(failure), finalText: nil), at: t0)
        #expect(state.phase == .idle)
        #expect(state.transcript.turns[0].outcome == .failed(failure))
        #expect(contents(state)[0] == [
            .user(UserMessage(text: "hi", sentAt: t0)),
            .notice(Notice(.warning, "Title generation failed")),
        ])
    }

    @Test func aMessageThatCouldNotBeSentFailsItsTurn() {
        var state = ThreadState()
        let item = state.messageSent("hi", at: t0)
        let failure = TurnFailure(message: "Not connected", retryable: true)
        state.messageFailed(item, failure, at: t0)
        #expect(state.phase == .idle)
        #expect(state.transcript.turns[0].outcome == .failed(failure))
    }

    @Test func interruptedTurnKeepsWhatWasStreamed() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.textDelta("Partial"), at: t0)
        state.apply(.turnFinished(.interrupted, finalText: nil), at: t0)
        #expect(state.transcript.turns[0].outcome == .interrupted)
        #expect(contents(state)[0].last == .text("Partial"))
    }

    // MARK: Reasoning, tools and requests

    @Test func replyTextNeverOpensWithBlankLines() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.textDelta("\n\n"), at: t0)
        #expect(contents(state)[0].count == 1) // blank lines alone are not a reply
        state.apply(.textDelta("\n\nDone."), at: t0)
        state.apply(.textDelta("\n\nNext paragraph."), at: t0)
        #expect(contents(state)[0].last == .text("Done.\n\nNext paragraph."))
    }

    @Test func reasoningIsOneStretchUntilSomethingElseHappens() {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.reasoningDelta("Let me "), at: t0)
        state.apply(.reasoningDelta("think."), at: t0.addingTimeInterval(1))
        #expect(contents(state)[0].last == .reasoning(Reasoning(text: "Let me think.", startedAt: t0)))

        // Text ends the stretch and dates it.
        state.apply(.textDelta("Answer"), at: t0.addingTimeInterval(3))
        #expect(contents(state)[0] == [
            .user(UserMessage(text: "hi", sentAt: t0)),
            .reasoning(Reasoning(text: "Let me think.", startedAt: t0, endedAt: t0.addingTimeInterval(3))),
            .text("Answer"),
        ])

        // More reasoning later is a new stretch.
        state.apply(.reasoningDelta("Hmm."), at: t0.addingTimeInterval(4))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(6))
        guard case let .reasoning(second) = contents(state)[0].last else {
            Issue.record("expected a second stretch of reasoning")
            return
        }
        #expect(second.duration == 2) // the end of the turn ends it
    }

    @Test func aToolRunStartsRunningAndTakesItsResult() {
        var state = ThreadState()
        state.messageSent("fix it", at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", label: "pytest -q", input: "pytest -q", startedAt: t0)), at: t0)
        #expect(contents(state)[0].last == .tool(ToolRun(id: "t1", name: "terminal", label: "pytest -q", input: "pytest -q", startedAt: t0)))

        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: false, duration: 2.1, output: "1 failed")), at: t0)
        #expect(contents(state)[0].last == .tool(ToolRun(
            id: "t1", name: "terminal", label: "pytest -q", input: "pytest -q", output: "1 failed",
            state: .failed, startedAt: t0, duration: 2.1
        )))
        #expect(contents(state)[0].count == 2) // the result updates the row; it does not add one
    }

    @Test func aResultWithoutADurationIsTimedFromItsStart() {
        var state = ThreadState()
        state.messageSent("go", at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "patch", startedAt: t0)), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "patch", succeeded: true, diff: "+x")), at: t0.addingTimeInterval(4))
        guard case let .tool(run) = contents(state)[0].last else {
            Issue.record("expected a tool run")
            return
        }
        #expect(run.duration == 4)
        #expect(run.diff == "+x")
        #expect(run.state == .succeeded)
    }

    @Test func aResultWhoseStartWasMissedStillShows() {
        var state = ThreadState()
        state.messageSent("go", at: t0)
        state.apply(.toolFinished(ToolResult(id: "t9", name: "read_file", succeeded: true, duration: 0.1, output: "contents")), at: t0)
        #expect(contents(state)[0].last == .tool(ToolRun(
            id: "t9", name: "read_file", output: "contents", state: .succeeded, startedAt: t0, duration: 0.1
        )))
    }

    @Test func toolsLeftRunningEndWithTheTurn() {
        var stopped = ThreadState()
        stopped.messageSent("go", at: t0)
        stopped.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", startedAt: t0)), at: t0)
        stopped.apply(.turnFinished(.interrupted, finalText: nil), at: t0.addingTimeInterval(5))
        guard case let .tool(run) = contents(stopped)[0].last else {
            Issue.record("expected a tool run")
            return
        }
        #expect(run.state == .failed)
        #expect(run.duration == 5)
    }

    private var approval: PendingRequest {
        PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "rm -rf build", reason: "recursive delete")))
    }

    @Test func anOpenRequestMakesTheThreadWaitUntilItIsAnswered() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.apply(.requestOpened(approval), at: t0) // a replay does not duplicate it
        #expect(state.openRequests == [approval])
        #expect(state.isWaitingOnUser)
        #expect(state.isRunning)

        state.requestAnswered("srq-1", with: .approval(.once), at: t0)
        #expect(state.openRequests.isEmpty)
        #expect(!state.isWaitingOnUser)
        #expect(contents(state)[0].last == .request(RequestRecord(
            id: "srq-1", kind: .approval, prompt: "rm -rf build", answer: "Allowed once"
        )))
    }

    @Test func aRequestAnsweredElsewhereIsRecordedWithTheReason() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.apply(.requestClosed(id: "srq-1", reason: "Answered elsewhere"), at: t0)
        #expect(state.openRequests.isEmpty)
        #expect(contents(state)[0].last == .request(RequestRecord(
            id: "srq-1", kind: .approval, prompt: "rm -rf build", answer: "Answered elsewhere"
        )))
        // Closing something that is not open changes nothing.
        state.apply(.requestClosed(id: "srq-1", reason: "Withdrawn"), at: t0)
        #expect(contents(state)[0].count == 2)
    }

    /// An answer given here that never took: the connection went with it (sent into a socket
    /// that was closing), and the host, caught up with on reconnecting, still asks. The
    /// card is open again, and the answer shown for it goes: one request, one card, and
    /// once answered again one record, not an answer over a card still asking.
    @Test func aRequestTheHostStillAsksAfterAnAnswerHereIsOpenWithoutThatAnswer() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(2))
        state.apply(.requestOpened(approval), at: t0.addingTimeInterval(2))
        #expect(state.openRequests == [approval])
        #expect(!contents(state)[0].contains { if case .request = $0 { true } else { false } })
        state.requestAnswered("srq-1", with: .approval(.deny), at: t0.addingTimeInterval(3))
        let records = contents(state)[0].compactMap { if case let .request(record) = $0 { record } else { nil } }
        #expect(records.count == 1)
        #expect(records.first?.answer == "Denied")
    }

    /// The same, for a device that reconnects to the thread whole: the snapshot lists the
    /// request as open, and the answer given here that never took is not shown over it.
    @Test func aRequestASnapshotListsAsOpenAfterAnAnswerHereIsOpenWithoutThatAnswer() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        let host = state.transcript
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, openRequests: [approval]), at: t0.addingTimeInterval(2))
        #expect(state.openRequests == [approval])
        #expect(!state.transcript.turns.flatMap(\.items).contains { if case .request = $0.content { true } else { false } })
    }

    /// An answer that could not be sent (the connection was down) did not answer: the card
    /// is open again, and what the host says on reconnecting is what the transcript records
    /// (here, answered on another device meanwhile), not the answer that never left.
    @Test func anAnswerThatCouldNotBeSentLeavesTheRequestOpenForWhatTheHostSays() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        state.answerNotSent(approval, at: t0.addingTimeInterval(1))
        #expect(state.openRequests == [approval])
        #expect(!contents(state)[0].contains { if case .request = $0 { true } else { false } })
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(2))
        state.apply(.requestClosed(id: "srq-1", reason: "Answered on another device"), at: t0.addingTimeInterval(2))
        let records = contents(state)[0].compactMap { if case let .request(record) = $0 { record } else { nil } }
        #expect(records.map(\.answer) == ["Answered on another device"])
        #expect(state.openRequests.isEmpty)

        // The run ended meanwhile, as this device heard: nothing is asked any more, and the
        // answer stays as given.
        var ended = ThreadState()
        ended.messageSent("clean up", at: t0)
        ended.apply(.requestOpened(approval), at: t0)
        ended.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        ended.apply(.turnFinished(.interrupted, finalText: nil), at: t0.addingTimeInterval(2))
        ended.answerNotSent(approval, at: t0.addingTimeInterval(3))
        #expect(ended.openRequests.isEmpty)
    }

    /// A question that outlives its turn, answered here into a socket that was closing; the
    /// thread is opened again whole, the host listing the question as open. The card is
    /// open, without the answer that never took (the merge keeps the turn as it was here).
    @Test func aQuestionASnapshotListsAsOpenAfterItsTurnIsOpenWithoutTheAnswerThatNeverTook() {
        let asked = PendingRequest(id: "srq-8", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(1))
        let host = state.transcript
        state.requestAnswered("srq-8", with: .clarify(["q0": "Blue"]), at: t0.addingTimeInterval(2))
        state.adopt(ThreadSnapshot(transcript: host, isRunning: false, openRequests: [asked]), at: t0.addingTimeInterval(3))
        #expect(state.openRequests == [asked])
        #expect(!state.transcript.turns.flatMap(\.items).contains { if case .request = $0.content { true } else { false } })
    }

    /// An answer whose send failed after the host had said the request was settled (taken
    /// back, or answered elsewhere, while the answer was on its way): no card comes back
    /// that nobody can answer.
    @Test func anAnswerNotSentDoesNotReopenARequestTheHostSettledMeanwhile() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        state.apply(.requestClosed(id: "srq-1", reason: "Answered on another device"), at: t0.addingTimeInterval(2))
        state.answerNotSent(approval, at: t0.addingTimeInterval(3))
        #expect(state.openRequests.isEmpty)
        // Asked again by the host after all: it is open.
        state.apply(.requestOpened(approval), at: t0.addingTimeInterval(4))
        #expect(state.openRequests == [approval])
    }

    @Test func anAnswerNotSentDoesNotReopenARequestTheHostShowedAgainThenSettled() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        // The catch-up the answer waited for shows the card again; another device then
        // answers it, before this device's send fails.
        state.apply(.requestOpened(approval), at: t0.addingTimeInterval(2))
        state.apply(.requestClosed(id: "srq-1", reason: "Answered on another device"), at: t0.addingTimeInterval(3))
        state.answerNotSent(approval, at: t0.addingTimeInterval(4))
        #expect(state.openRequests.isEmpty)
        // The host's settling stays recorded.
        let records = state.transcript.turns.flatMap(\.items).compactMap { item -> RequestRecord? in
            if case let .request(record) = item.content, record.id == "srq-1" { record } else { nil }
        }
        #expect(records.map(\.answer) == ["Answered on another device"])
    }

    @Test func anAnswerTheHostHadNotTakenGivesWayToTheOneThatWonOnAnotherDevice() {
        let asked = PendingRequest(id: "srq-9", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(2))
        // Answered here; before the host takes it, another device's answer settles it
        // (a bridge's `answer_owner` says so), then this device's send fails.
        state.requestAnswered("srq-9", with: .clarify(["q0": "Red"]), at: t0.addingTimeInterval(5))
        state.apply(.requestSettledElsewhere(id: "srq-9"), at: t0.addingTimeInterval(6))
        state.apply(.requestAnswered(id: "srq-9", answer: .clarify(["q0": "Blue"]), by: nil), at: t0.addingTimeInterval(6))
        state.answerNotSent(asked, at: t0.addingTimeInterval(7))
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 1)
        let records = state.transcript.turns.flatMap(\.items).compactMap { item -> RequestRecord? in
            if case let .request(record) = item.content, record.id == "srq-9" { record } else { nil }
        }
        #expect(records == [RequestRecord(id: "srq-9", kind: .question, prompt: "Which colour?", answer: "Blue", askedAhead: true)])
        #expect(contents(state)[0].last == .request(records[0]))
    }

    @Test func anApprovalAnsweredHereGivesWayToTheHostsSettlingOnlyWhenItSaysAnotherAnswerWon() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0.addingTimeInterval(1))
        let answered = state.transcript.turns.flatMap(\.items).compactMap { item -> String? in
            if case let .request(record) = item.content, record.id == "srq-1" { record.answer } else { nil }
        }
        // Its own answer's closing, replayed after a reconnect, changes nothing.
        state.apply(.requestClosed(id: "srq-1", reason: "Answered elsewhere"), at: t0.addingTimeInterval(2))
        // Nor does word of another device's answer for a request not answered here.
        state.apply(.requestSettledElsewhere(id: "srq-other"), at: t0.addingTimeInterval(2))
        func records() -> [String] {
            state.transcript.turns.flatMap(\.items).compactMap { item -> String? in
                if case let .request(record) = item.content, record.id == "srq-1" { record.answer } else { nil }
            }
        }
        #expect(records() == answered)
        #expect(state.openRequests.isEmpty)
        // Another device's answer won: its closing takes the place of this one's.
        state.apply(.requestSettledElsewhere(id: "srq-1"), at: t0.addingTimeInterval(3))
        state.apply(.requestClosed(id: "srq-1", reason: "Answered elsewhere"), at: t0.addingTimeInterval(3))
        #expect(records() == ["Answered elsewhere"])
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 1)
    }

    /// The same with a bridge from before `answer_owner` (recent-20): its `request.cancel`
    /// names no device, but for a question asked without waiting it gives the answer that
    /// won, and an answer given for the user by the agent that started the thread names
    /// that agent. Either takes the place of this device's answer the host had not taken;
    /// its own answer told back changes nothing.
    @Test func anAnswerTheHostHadNotTakenGivesWayToTheAnswerAnOlderBridgeSaysWon() {
        let asked = PendingRequest(id: "srq-9", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        func records(_ state: ThreadState) -> [RequestRecord] {
            state.transcript.turns.flatMap(\.items).compactMap { item -> RequestRecord? in
                if case let .request(record) = item.content, record.id == "srq-9" { record } else { nil }
            }
        }
        func answeredHere() -> ThreadState {
            var state = ThreadState()
            state.messageSent("make a readme", at: t0)
            state.apply(.requestOpened(asked), at: t0)
            state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(2))
            state.requestAnswered("srq-9", with: .clarify(["q0": "Red"]), at: t0.addingTimeInterval(5))
            return state
        }
        // Its own answer told back (a replay): as it was.
        var own = answeredHere()
        let mine = records(own)
        own.apply(.requestAnswered(id: "srq-9", answer: .clarify(["q0": "Red"]), by: nil), at: t0.addingTimeInterval(6))
        #expect(records(own) == mine)
        #expect(mine.map(\.answer) == ["Red"])

        // Another device's answer won, then this device's send fails.
        var lost = answeredHere()
        lost.apply(.requestAnswered(id: "srq-9", answer: .clarify(["q0": "Blue"]), by: nil), at: t0.addingTimeInterval(6))
        lost.answerNotSent(asked, at: t0.addingTimeInterval(7))
        #expect(lost.openRequests.isEmpty)
        #expect(lost.transcript.turns.count == 1)
        #expect(records(lost) == [RequestRecord(id: "srq-9", kind: .question, prompt: "Which colour?", answer: "Blue", askedAhead: true)])
        #expect(contents(lost)[0].last == .request(records(lost)[0]))

        // The agent that started the thread answered it for the user.
        var byAgent = answeredHere()
        byAgent.apply(.requestAnswered(id: "srq-9", answer: .clarify(["q0": "Red"]), by: "Planner"), at: t0.addingTimeInterval(6))
        #expect(records(byAgent).map(\.answeredBy) == ["Planner"])
        #expect(records(byAgent).count == 1)
    }

    /// A question asked without waiting, its turn over, is answered on another device
    /// while this one is away; the thread is then opened again whole (recent-20). The
    /// host's row of it, with the answer, is in the turn that asked it, though the turn
    /// is otherwise as this device saw it.
    @Test func aFullResumeKeepsTheHostsRowOfAQuestionAnsweredElsewhereAfterItsTurn() {
        let asked = PendingRequest(id: "srq-9", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        func askedFirst() -> ThreadState {
            var state = ThreadState()
            state.messageSent("make a readme", at: t0)
            state.apply(.turnStarted, at: t0)
            state.apply(.requestOpened(asked), at: t0.addingTimeInterval(1))
            state.apply(.textDelta("Going on meanwhile"), at: t0.addingTimeInterval(1))
            state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(2))
            return state
        }
        var state = askedFirst()
        #expect(state.openRequests == [asked])
        // The host: its row where the question was asked (its own id, the tool call's),
        // and the turn the answer opened.
        var asking = state.transcript.turns[0]
        asking.id = UUID()
        asking.items = asking.items.map { TurnItem($0.content) }
        let row = TurnItem(.request(RequestRecord(id: "call-ask-1", kind: .question, prompt: "Which colour?", answer: "Blue", askedAhead: true)))
        asking.items.insert(row, at: 1)
        let answered = Turn(startedAt: t0.addingTimeInterval(10), endedAt: t0.addingTimeInterval(12), outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: "Blue", sentAt: t0.addingTimeInterval(10), delivery: .started, cardAnswer: "call-ask-1"))),
            TurnItem(.text("Blue it is.")),
        ])
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [asking, answered]), isRunning: false), at: t0.addingTimeInterval(20))
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 2)
        let rows = state.transcript.turns[0].items.compactMap { item -> RequestRecord? in
            if case let .request(record) = item.content { record } else { nil }
        }
        #expect(rows.map(\.answer) == ["Blue"])
        #expect(contents(state)[0].map { if case .request = $0 { "row" } else if case .text = $0 { "text" } else { "other" } } == ["other", "row", "text"])

        // Answered here and seen live, the row is not shown twice.
        var live = askedFirst()
        live.apply(.requestAnswered(id: "srq-9", answer: .clarify(["q0": "Blue"]), by: nil), at: t0.addingTimeInterval(10))
        live.adopt(ThreadSnapshot(transcript: Transcript(turns: [asking, answered]), isRunning: false), at: t0.addingTimeInterval(20))
        let liveRows = live.transcript.turns[0].items.filter { if case .request = $0.content { true } else { false } }
        #expect(liveRows.count == 1)

        // Nor when this device first saw its card after a later turn, and recorded the
        // answer given here in that turn (Codex's review).
        let later = Turn(startedAt: t0.addingTimeInterval(5), endedAt: t0.addingTimeInterval(6), outcome: .completed, items: [TurnItem(.text("Checked by itself."))])
        var seenLate = ThreadState()
        let askingHere = askedFirst().transcript.turns[0]
        seenLate.adopt(ThreadSnapshot(transcript: Transcript(turns: [askingHere, later]), isRunning: false, openRequests: [asked]), at: t0.addingTimeInterval(7))
        seenLate.requestAnswered("srq-9", with: .clarify(["q0": "Blue"]), at: t0.addingTimeInterval(8))
        #expect(seenLate.transcript.turns.count == 2)
        seenLate.adopt(ThreadSnapshot(transcript: Transcript(turns: [asking, later]), isRunning: false), at: t0.addingTimeInterval(20))
        let everyRow = seenLate.transcript.turns.flatMap(\.items).filter { if case .request = $0.content { true } else { false } }
        #expect(everyRow.count == 1)

        // And when that later turn was still running as it was recorded there, and has ended
        // since (the host's copy of it then takes its place, without the record): the host's
        // row is the record (Codex's re-check).
        var running = ThreadState()
        let laterRunning = Turn(startedAt: t0.addingTimeInterval(5), items: [TurnItem(.text("Checking by itself"))])
        running.adopt(ThreadSnapshot(transcript: Transcript(turns: [askingHere, laterRunning]), isRunning: true, openRequests: [asked]), at: t0.addingTimeInterval(7))
        running.requestAnswered("srq-9", with: .clarify(["q0": "Blue"]), at: t0.addingTimeInterval(8))
        let laterDone = Turn(startedAt: t0.addingTimeInterval(5), endedAt: t0.addingTimeInterval(9), outcome: .completed, items: [TurnItem(.text("Checked by itself, and more."))])
        running.adopt(ThreadSnapshot(transcript: Transcript(turns: [asking, laterDone]), isRunning: false), at: t0.addingTimeInterval(20))
        let rowsLeft = running.transcript.turns.flatMap(\.items).compactMap { item -> RequestRecord? in
            if case let .request(record) = item.content { record } else { nil }
        }
        #expect(rowsLeft.map(\.answer) == ["Blue"])

        // A later turn the host has, which asked the same words again, has its own row; it
        // does not stand for the earlier one (Codex's second re-check).
        var again = askedFirst()
        let askedAgain = Turn(startedAt: t0.addingTimeInterval(13), endedAt: t0.addingTimeInterval(14), outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: "once more", sentAt: t0.addingTimeInterval(13), delivery: .started))),
            TurnItem(.request(RequestRecord(id: "call-ask-2", kind: .question, prompt: "Which colour?", answer: "Red", askedAhead: true))),
            TurnItem(.text("Red this time.")),
        ])
        again.adopt(ThreadSnapshot(transcript: Transcript(turns: [asking, answered, askedAgain]), isRunning: false), at: t0.addingTimeInterval(20))
        let bothRows = again.transcript.turns.flatMap(\.items).compactMap { item -> RequestRecord? in
            if case let .request(record) = item.content { record } else { nil }
        }
        #expect(bothRows.map(\.answer) == ["Blue", "Red"])
    }

    /// Two questions of identical wording asked without waiting in two turns: the first
    /// answered on another device while this one was away, the second answered here. A
    /// full resume shows each once, with its own answer, where it was asked: this device's
    /// record stands for the row of the second (its turn, its answer), not for the first
    /// row of those words (recent-20 (a), identical wording).
    @Test func twoQuestionsOfIdenticalWordingAreToldApartOnAFullResume() {
        let words = [ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]
        let first = PendingRequest(id: "srq-1", kind: .clarify(words), askedAhead: true)
        let second = PendingRequest(id: "srq-2", kind: .clarify(words), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.requestOpened(first), at: t0.addingTimeInterval(1))
        state.apply(.textDelta("Going on meanwhile"), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(2))
        state.messageSent("and the docs", at: t0.addingTimeInterval(3))
        state.apply(.turnStarted, at: t0.addingTimeInterval(3))
        state.apply(.requestOpened(second), at: t0.addingTimeInterval(4))
        state.apply(.textDelta("Docs meanwhile"), at: t0.addingTimeInterval(4))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(5))
        state.apply(.requestAnswered(id: "srq-2", answer: .clarify(["q0": "Red"]), by: nil), at: t0.addingTimeInterval(6))
        func records(_ turns: [Turn]) -> [RequestRecord] {
            turns.flatMap(\.items).compactMap { item -> RequestRecord? in
                if case let .request(record) = item.content { record } else { nil }
            }
        }
        #expect(state.transcript.turns.count == 2)
        #expect(records(state.transcript.turns).map(\.answer) == ["Red"])
        // The host: each turn as this device has it, with its row of the question it asked
        // (the first answered elsewhere, Blue), under the tool calls' ids.
        let host = state.transcript.turns.enumerated().map { index, turn -> Turn in
            var copy = turn
            copy.id = UUID()
            copy.items = turn.items.filter { if case .request = $0.content { false } else { true } }.map { TurnItem($0.content) }
            let answer = index == 0 ? "Blue" : "Red"
            copy.items.insert(TurnItem(.request(RequestRecord(id: "call-ask-\(index + 1)", kind: .question, prompt: "Which colour?", answer: answer, askedAhead: true))), at: 1)
            return copy
        }
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: host), isRunning: false), at: t0.addingTimeInterval(20))
        #expect(state.transcript.turns.count == 2)
        #expect(records([state.transcript.turns[0]]).map(\.answer) == ["Blue"])
        #expect(records([state.transcript.turns[1]]).map(\.answer) == ["Red"])
    }

    /// A model that numbers its calls afresh in each answer uses an id again within one
    /// turn (recent-20): the later call is a row of its own, and the earlier, finished,
    /// keeps its row. The same call told again (a replay) is still its row.
    @Test func aCallThatReusesAFinishedCallsIdInTheSameTurnIsARowOfItsOwn() {
        var state = ThreadState()
        state.messageSent("look around", at: t0)
        state.apply(.turnStarted, at: t0)
        let first = ToolRun(id: "Execute:0", name: "Execute", input: "ls", startedAt: t0)
        state.apply(.toolStarted(first), at: t0)
        state.apply(.toolFinished(ToolResult(id: "Execute:0", name: "Execute", succeeded: true, duration: 0.1, output: "a.txt\n")), at: t0.addingTimeInterval(1))
        // Told again: still one row.
        state.apply(.toolStarted(first), at: t0.addingTimeInterval(1))
        state.apply(.toolFinished(ToolResult(id: "Execute:0", name: "Execute", succeeded: true, duration: 0.1, output: "a.txt\n")), at: t0.addingTimeInterval(1))
        func rows() -> [ToolRun] {
            state.transcript.turns.flatMap(\.items).compactMap { item -> ToolRun? in
                if case let .tool(run) = item.content { run } else { nil }
            }
        }
        #expect(rows().count == 1)
        // The next answer's first call.
        state.apply(.toolStarted(ToolRun(id: "Execute:0", name: "Execute", input: "pwd", startedAt: t0.addingTimeInterval(2))), at: t0.addingTimeInterval(2))
        state.apply(.toolFinished(ToolResult(id: "Execute:0", name: "Execute", succeeded: true, duration: 0.1, output: "/tmp\n")), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(rows().map(\.input) == ["ls", "pwd"])
        #expect(rows().map(\.output) == ["a.txt\n", "/tmp\n"])
        #expect(rows().allSatisfy { $0.state == .succeeded })
    }

    @Test func theEndOfATurnDropsWhatWasStillBeingAsked() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.apply(.turnFinished(.interrupted, finalText: nil), at: t0)
        #expect(state.openRequests.isEmpty)
        #expect(!state.isWaitingOnUser)
    }

    /// What a subagent asks (a bridge with `subagents` says which), which may run on after the turn.
    private var subagentApproval: PendingRequest {
        PendingRequest(id: "srq-2", kind: .approval(ApprovalRequest(command: "ls -la", reason: nil)), subagent: "a17")
    }

    @Test func aSubagentsQuestionOutlivesTheTurnItWasAskedIn() {
        var state = ThreadState()
        state.messageSent("look around", at: t0)
        state.apply(.requestOpened(approval), at: t0)
        state.apply(.requestOpened(subagentApproval), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Started it"), at: t0.addingTimeInterval(2))
        // The turn's own question went with it; the subagent still waits on its answer.
        #expect(state.openRequests == [subagentApproval])
        #expect(state.isWaitingOnUser)
        #expect(state.phase == .idle)

        // Answered later, it is recorded in the turn that asked it, not in a turn of its own.
        state.requestAnswered("srq-2", with: .approval(.once), at: t0.addingTimeInterval(5))
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 1)
        #expect(contents(state)[0].last == .request(RequestRecord(id: "srq-2", kind: .approval, prompt: "ls -la", answer: "Allowed once")))
    }

    @Test func aQuestionAskedWithoutWaitingOutlivesTheTurnItWasAskedIn() {
        let asked = PendingRequest(id: "srq-4", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(2))
        #expect(state.openRequests == [asked])
        #expect(state.isWaitingOnUser)
        #expect(state.phase == .idle)
        state.requestAnswered("srq-4", with: .clarify(["q0": "Blue"]), at: t0.addingTimeInterval(5))
        #expect(state.openRequests.isEmpty)
        #expect(contents(state)[0].last == .request(RequestRecord(id: "srq-4", kind: .question, prompt: "Which colour?", answer: "Blue", askedAhead: true)))
    }

    @Test func aQuestionAskedWithoutWaitingAndAnsweredInAMessageIsRecordedWhereItWasAsked() {
        let asked = PendingRequest(id: "srq-5", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(2))
        // The person answers by typing: their message opens a turn here before the host takes the card back.
        state.messageSent("Blue", at: t0.addingTimeInterval(5))
        state.apply(.requestClosed(id: "srq-5", reason: "Answered in your message"), at: t0.addingTimeInterval(6))
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 2)
        #expect(contents(state)[0].last == .request(RequestRecord(id: "srq-5", kind: .question, prompt: "Which colour?", answer: "Answered in your message", askedAhead: true)))
        #expect(!contents(state)[1].contains { if case .request = $0 { true } else { false } })
    }

    @Test func theAnswerGivenOnTheCardIsItsRowsAndItsMessageHasNoBubble() throws {
        let asked = PendingRequest(id: "srq-6", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.textDelta("Let me ask."), at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", startedAt: t0)), at: t0)
        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true)), at: t0.addingTimeInterval(1))
        state.apply(.textDelta("Going on meanwhile."), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(2))
        state.requestAnswered("srq-6", with: .clarify(["q0": "Blue"]), at: t0.addingTimeInterval(5))
        // The bridge opens the answer's turn with it, marked as the card's.
        state.apply(.turnOpened(by: "Blue", cardAnswer: "call_1"), at: t0.addingTimeInterval(5))
        state.apply(.textDelta("Blue it is."), at: t0.addingTimeInterval(6))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(7))
        let turns = state.transcript.turns
        #expect(turns.count == 2)
        // Its row stays in view in the turn that asked, where the work folds.
        let asking = TurnLayout.pieces(for: turns[0])
        let record = try #require(asking.compactMap { piece -> RequestRecord? in
            if case let .item(item) = piece, case let .request(record) = item.content { record } else { nil }
        }.first)
        #expect(record.answer == "Blue")
        #expect(asking.contains { if case .steps = $0 { true } else { false } })
        // The message is kept (the host has it too) but not shown: the reply alone.
        let hidden = turns[1].items.contains { $0.isCardAnswer }
        #expect(hidden)
        let shown = TurnLayout.pieces(for: turns[1]).map { $0.id }
        #expect(shown == [turns[1].items[1].id])
        // A message typed by the person is shown as ever.
        state.messageSent("thanks", at: t0.addingTimeInterval(8))
        #expect(TurnLayout.pieces(for: state.transcript.turns[2]).count == 1)
    }

    @Test func aCardAnsweredOnAnotherDeviceShowsItsAnswerInItsRow() {
        let asked = PendingRequest(id: "srq-7", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which colour?", choices: ["Red", "Blue"])]), askedAhead: true)
        var state = ThreadState()
        state.messageSent("make a readme", at: t0)
        state.apply(.requestOpened(asked), at: t0)
        state.apply(.turnFinished(.completed, finalText: "Going on meanwhile"), at: t0.addingTimeInterval(2))
        state.apply(.requestAnswered(id: "srq-7", answer: .clarify(["q0": "Red"]), by: nil), at: t0.addingTimeInterval(5))
        #expect(contents(state)[0].last == .request(RequestRecord(id: "srq-7", kind: .question, prompt: "Which colour?", answer: "Red", askedAhead: true)))
    }

    @Test func aSubagentsQuestionBetweenTurnsStartsNoTurn() {
        var state = ThreadState()
        state.messageSent("start a helper", at: t0)
        state.apply(.turnFinished(.completed, finalText: "Started it"), at: t0)
        // A subagent in the background asks after the turn is over: nothing runs but it.
        state.apply(.requestOpened(subagentApproval), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(state.phase == .idle)
        #expect(state.isWaitingOnUser)
        // Another turn begins and ends meanwhile (the agent's own): the question stays.
        state.apply(.turnStarted, at: t0.addingTimeInterval(4))
        state.apply(.turnFinished(.completed, finalText: "Another finished"), at: t0.addingTimeInterval(5))
        #expect(state.openRequests == [subagentApproval])
        // Withdrawn by the host (the subagent was stopped): recorded in the last turn.
        state.apply(.requestClosed(id: "srq-2", reason: "Withdrawn"), at: t0.addingTimeInterval(6))
        #expect(state.openRequests.isEmpty)
        #expect(state.transcript.turns.count == 2)
        #expect(contents(state)[1].last == .request(RequestRecord(id: "srq-2", kind: .approval, prompt: "ls -la", answer: "Withdrawn")))
    }

    /// While the agent only waits for an answer the thread's wash holds still; it moves
    /// again once the agent is back at work.
    @Test func aRunPausedOnAnApprovalAQuestionOrAPlanWaitsOnlyOnTheUser() {
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.turnStarted, at: t0)
        #expect(state.isRunning && !state.waitsOnlyOnUser)
        state.apply(.requestOpened(approval), at: t0)
        #expect(state.isRunning && state.waitsOnlyOnUser)
        state.requestAnswered("srq-1", with: .approval(.once), at: t0)
        #expect(state.isRunning && !state.waitsOnlyOnUser)

        let question = PendingRequest(id: "q", kind: .clarify([ClarifyQuestion(id: "q0", text: "Which folder?")]))
        state.apply(.requestOpened(question), at: t0)
        #expect(state.waitsOnlyOnUser)
        state.requestAnswered("q", with: .clarify(["q0": "src"]), at: t0)

        let plan = ApprovalRequest(command: "Make a plan", reason: nil, plan: PlanApproval())
        state.apply(.requestOpened(PendingRequest(id: "p", kind: .approval(plan))), at: t0)
        #expect(state.waitsOnlyOnUser)
        state.apply(.turnFinished(.completed, finalText: "Planned"), at: t0)
        #expect(!state.waitsOnlyOnUser)
    }

    @Test func aSubagentStillAtWorkIsMoreThanWaitingOnTheUser() {
        var state = ThreadState()
        state.messageSent("look around", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.subagent(Subagent(id: "a9", goal: "Count the files")), at: t0)
        state.apply(.requestOpened(approval), at: t0)
        #expect(state.isWaitingOnUser && !state.waitsOnlyOnUser)
        state.apply(.subagent(Subagent(id: "a9", goal: "Count the files", state: .finished)), at: t0)
        #expect(state.waitsOnlyOnUser)
    }

    @Test func aSubagentWaitingOnItsOwnQuestionOnlyWaits() {
        var state = ThreadState()
        state.messageSent("look around", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.subagent(Subagent(id: "a17", goal: "List the files")), at: t0)
        state.apply(.requestOpened(subagentApproval), at: t0)
        #expect(state.waitsOnlyOnUser)
        // Another at work beside it.
        state.apply(.subagent(Subagent(id: "a18", goal: "Read the docs")), at: t0)
        #expect(!state.waitsOnlyOnUser)
    }

    /// Which of a workflow's agents asked is not known: the others may run on.
    @Test func aWorkflowAtWorkIsMoreThanWaitingOnTheUser() {
        var state = ThreadState()
        state.messageSent("run the review", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.subagent(Subagent(id: "w1", goal: "Review", kind: .workflow, name: "review")), at: t0)
        let asked = PendingRequest(id: "srq-3", kind: .approval(ApprovalRequest(command: "make", reason: nil)), subagent: "a8a61ae82f6b90c55")
        state.apply(.requestOpened(asked), at: t0)
        #expect(!state.waitsOnlyOnUser)
    }

    @Test func answersAreSummarisedInWords() {
        let question = PendingRequest(id: "q", kind: .clarify([
            ClarifyQuestion(id: "q0", text: "Language?", choices: ["Python", "Swift"]),
            ClarifyQuestion(id: "q1", text: "Name?"),
        ]))
        #expect(question.prompt == "Language?\nName?")
        #expect(RequestAnswer.clarify(["q0": "Swift", "q1": "tool.swift"]).summary(for: question) == "Swift\ntool.swift")
        #expect(RequestAnswer.clarify(["q1": "tool.swift"]).summary(for: question) == "tool.swift")
        #expect(RequestAnswer.clarify([:]).summary(for: question) == "Skipped")
        #expect(RequestAnswer.cancelled.summary(for: question) == "Skipped")

        #expect(RequestAnswer.approval(.session).summary(for: approval) == "Allowed for this thread")
        #expect(RequestAnswer.approval(.always).summary(for: approval) == "Always allowed")
        #expect(RequestAnswer.approval(.deny).summary(for: approval) == "Denied")
        #expect(RequestAnswer.cancelled.summary(for: approval) == "Denied")
    }

    @Test func approvalChoicesFallBackToOnceAndDeny() {
        #expect(ApprovalRequest(command: "x", choices: []).choices == [.once, .deny])
        #expect(ApprovalRequest(command: "x", reason: "").reason == nil)
    }

    @Test func titleIgnoresBlankValues() {
        var state = ThreadState()
        state.apply(.titleChanged("Greeting"), at: t0)
        state.apply(.titleChanged("   "), at: t0)
        #expect(state.title == "Greeting")
    }

    @Test func aNoticeOutsideAnyTurnIsKept() {
        var state = ThreadState()
        state.apply(.notice(Notice(.info, "Session restored")), at: t0)
        #expect(state.phase == .idle)
        #expect(contents(state) == [[.notice(Notice(.info, "Session restored"))]])
        #expect(state.transcript.turns[0].isRunning == false)
    }

    // MARK: Preview

    @Test func thePreviewIsTheFirstLineOfTheLastMessageSent() {
        var state = ThreadState()
        state.messageSent("Plan the trip\nwith the dates", at: t0)
        state.apply(.turnFinished(.completed, finalText: "Sure."), at: t0)
        state.messageSent("Make it shorter\nand cheaper", at: t0)
        #expect(state.transcript.preview == "Make it shorter")
        #expect(ThreadState().transcript.preview == nil)
        // At most 140 characters, an emoji never cut in two.
        var long = ThreadState()
        long.messageSent(String(repeating: "👍", count: 150), at: t0)
        #expect(long.transcript.preview == String(repeating: "👍", count: 140))
    }

    @Test func thePreviewLeavesOutTheLineAMessageFromTheFleetOpensWith() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "[Portals: from Aeri (thread aeri)]\nCheck the build"), at: t0)
        #expect(state.transcript.preview == "Check the build")
        // Only as the first line: said further down, it is part of the message.
        var quoted = ThreadState()
        quoted.messageSent("Look at this\n[Portals: from Aeri (thread aeri)]", at: t0)
        #expect(quoted.transcript.preview == "Look at this")
        var alone = ThreadState()
        alone.messageSent("[Portals: from the portals command]", at: t0)
        #expect(alone.transcript.preview == nil)
    }

    @Test func thePreviewPassesOverLinesOfNothingButSpaces() {
        var state = ThreadState()
        state.messageSent("   \n\t\n  Fix the login  \nplease", at: t0)
        #expect(state.transcript.preview == "  Fix the login  ")
        // A message with nothing to show gives way to the one before it.
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.messageSent("   ", at: t0)
        #expect(state.transcript.preview == "  Fix the login  ")
    }

    @Test func thePreviewOfImagesAloneSaysSo() {
        var state = ThreadState()
        state.messageSent(" ", images: [AttachedImage(filename: "a.jpg")], at: t0)
        #expect(state.transcript.preview == "Image")
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.messageSent("[Portals: from Aeri (thread aeri)]", images: [AttachedImage(filename: "a.jpg"), AttachedImage(filename: "b.jpg")], at: t0)
        #expect(state.transcript.preview == "2 images")
    }

    @Test func transcriptRoundTripsThroughJSON() throws {
        var state = ThreadState()
        state.messageSent("hi", at: t0)
        state.apply(.textDelta("Hello"), at: t0)
        state.apply(.turnFinished(.failed(TurnFailure(message: "x", detail: "y", retryable: false)), finalText: nil), at: t0)
        let data = try JSONEncoder().encode(state.transcript)
        #expect(try JSONDecoder().decode(Transcript.self, from: data) == state.transcript)
    }
}

@Suite struct AgentTests {
    @Test func displayNameFallsBackToTheName() {
        let id = Agent.ID(host: HostID(rawValue: "h"), name: "aeri")
        #expect(Agent(id: id, displayName: "").displayName == "aeri")
        #expect(Agent(id: id, displayName: "  ").displayName == "aeri")
        #expect(Agent(id: id, displayName: nil).displayName == "aeri")
        #expect(Agent(id: id, displayName: "Aeri").displayName == "Aeri")
        #expect(Agent(id: id, summary: "").summary == nil)
    }
}
