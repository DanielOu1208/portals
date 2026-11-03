import Foundation
import Testing
@testable import AgentCore

/// Bringing the app's copy of a thread in line with what the host has.
@Suite struct SnapshotTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    // MARK: Building turns

    /// A turn as the app saw it live: with a tool run the host's history would not time.
    private func watched(_ asked: String, _ reply: String, outcome: TurnOutcome = .completed) -> Turn {
        Turn(startedAt: t0, endedAt: t0.addingTimeInterval(5), outcome: outcome, items: [
            TurnItem(.user(UserMessage(text: asked, sentAt: t0, delivery: .started))),
            TurnItem(.tool(ToolRun(id: "t-\(asked)", name: "terminal", state: .succeeded, startedAt: t0, duration: 2.5))),
            TurnItem(.text(reply)),
        ])
    }

    /// A turn as the host's history gives it.
    private func stored(_ asked: String, _ reply: String?) -> Turn {
        var items = [TurnItem(.user(UserMessage(text: asked, sentAt: t0, delivery: .started)))]
        if let reply { items.append(TurnItem(.text(reply))) }
        return Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: items)
    }

    /// A turn the host is still on.
    private func inProgress(_ asked: String, _ replySoFar: String? = nil) -> Turn {
        var turn = stored(asked, replySoFar)
        turn.outcome = nil
        turn.endedAt = nil
        return turn
    }

    /// A message that could not be sent.
    private func unsent(_ asked: String) -> Turn {
        Turn(startedAt: t0, endedAt: t0, outcome: .failed(TurnFailure(message: "Not connected to the host.")), items: [
            TurnItem(.user(UserMessage(text: asked, sentAt: t0))),
        ])
    }

    /// Merged with a host's version as `stored` builds it: each message with an id of the
    /// host's own, as Hermes and a bridge without `message_ids` give it.
    private func merge(_ mine: [Turn], _ host: [Turn]) -> [Turn] {
        Transcript(turns: mine).merged(withHost: Transcript(turns: host), hostKeepsMessageIDs: false).turns
    }

    /// Merged with the version of a host that keeps the ids this app sent its messages
    /// with (a bridge with `message_ids`).
    private func mergeKeepingIDs(_ mine: [Turn], _ host: [Turn]) -> [Turn] {
        Transcript(turns: mine).merged(withHost: Transcript(turns: host), hostKeepsMessageIDs: true).turns
    }

    /// `turn` as the host has it under the ids `mine` gave its messages.
    private func echoing(_ turn: Turn, idsOf mine: Turn) -> Turn {
        var turn = turn
        let ids = mine.items.filter(\.isUserMessage).map(\.id)
        var next = 0
        for index in turn.items.indices where turn.items[index].isUserMessage && next < ids.count {
            turn.items[index].id = ids[next]
            next += 1
        }
        return turn
    }

    // MARK: Merging transcripts

    @Test func anAgreeingOldCacheTakesTheHostsFailedRequestIdentity() {
        let mine = watched("same", "Not delivered.", outcome: .failed(TurnFailure(message: "Not delivered.")))
        var host = mine
        host.failedRequestID = "accepted-late"
        let merged = Transcript(turns: [mine]).merged(withHost: Transcript(turns: [host]), hostKeepsMessageIDs: true)
        #expect(merged.turns.first?.id == mine.id)
        #expect(merged.turns.first?.items == mine.items)
        #expect(merged.turns.first?.failedRequestID == "accepted-late")
        var state = ThreadState(transcript: merged)
        state.apply(.failedRequestTaken("accepted-late"))
        #expect(state.transcript.turns.isEmpty)
    }

    @Test func anotherDevicesNewTurnDoesNotReplaceAnUnsentMessage() {
        let failed = unsent("phone message")
        let remote = stored("Mac message", "answer")
        let merged = merge([watched("shared", "history"), failed], [stored("shared", "history"), remote])
        #expect(merged.contains { $0.id == failed.id })
        #expect(merged.contains { $0.userTexts == ["Mac message"] })
    }

    @Test func fromAHostThatKeepsMessageIDsIdenticalWordsDoNotProveAnUnsentMessageWasDelivered() {
        // That host would have the message under its own id: the same words under another
        // are someone else's message.
        let failed = unsent("same")
        let merged = mergeKeepingIDs([failed], [stored("same", "someone else's answer")])
        #expect(merged.contains { $0.id == failed.id && $0.isUnsent })
        #expect(merged.contains { $0.lastText == "someone else's answer" })
    }

    @Test func aHostThatKeepsMessageIDsConfirmsAnUnsentMessageByItsID() {
        // The connection dropped as it was sent: it failed here, and the host has it under its id.
        let failedHere = unsent("two")
        let merged = mergeKeepingIDs([watched("one", "1"), failedHere], [stored("one", "1"), echoing(stored("two", "2"), idsOf: failedHere)])
        #expect(merged.count == 2)
        #expect(merged[1].id == failedHere.id)
        #expect(merged[1].outcome == .completed)
        #expect(merged[1].items.map(\.content).last == .text("2"))
        #expect(merged[1].items.first?.id == failedHere.items.first?.id)
    }

    @Test func aCanonicalSnapshotRemovesObsoleteToolsEvenWhenTheFinalReplyMatches() {
        let mine = watched("one", "same final reply")
        let failed = unsent("keep my draft")
        let host = stored("one", "same final reply")
        let merged = Transcript(turns: [mine, failed]).merged(withHost: Transcript(turns: [host]), authoritative: true)
        #expect(merged.turns.first?.id == mine.id)
        #expect(merged.turns.first?.items.contains { if case .tool = $0.content { true } else { false } } == false)
        #expect(merged.turns.last?.id == failed.id)
    }

    @Test func aCanonicalSnapshotKeepsTheTurnIdentityWhenItsOwnRequestGainsASteeringMessage() {
        let mine = inProgress("first", "working")
        var host = echoing(inProgress("first", "working"), idsOf: mine)
        host.items.append(TurnItem(.user(UserMessage(text: "late steer", sentAt: t0, delivery: .steered))))
        let merged = Transcript(turns: [mine]).merged(withHost: Transcript(turns: [host]), authoritative: true)
        #expect(merged.turns.count == 1)
        #expect(merged.turns.first?.id == mine.id)
        #expect(merged.turns.first?.userTexts == ["first", "late steer"])
        #expect(merged.turns.first?.isRunning == true)
    }

    @Test func aCanonicalSnapshotKeepsAnUnconfirmedMessageWithoutItsObsoleteStream() {
        let item = TurnItem(.user(UserMessage(text: "unconfirmed")))
        let partial = Turn(outcome: .failed(TurnFailure(message: "disconnected")), items: [
            item, TurnItem(.text("obsolete")), TurnItem(.reasoning(Reasoning(text: "obsolete", startedAt: t0))),
        ])
        let merged = Transcript(turns: [partial]).merged(withHost: Transcript(turns: [stored("remote", "success")]), authoritative: true)
        #expect(merged.turns.contains { $0.items.contains { $0.id == item.id } && $0.isUnsent })
        #expect(merged.turns.contains { $0.lastText == "success" })
        #expect(!merged.turns.flatMap(\.items).contains { $0.content == .text("obsolete") })
    }

    /// A turn as the app saw it live, with what only the app records: an approval given
    /// here before its tool ran, and a notice after it.
    private func approvedLive(_ asked: String, _ reply: String) -> Turn {
        Turn(startedAt: t0, endedAt: t0.addingTimeInterval(5), outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: asked, sentAt: t0, delivery: .started))),
            TurnItem(.request(RequestRecord(id: "srq-1", kind: .approval, prompt: "rm -rf build", answer: "Allowed once"))),
            TurnItem(.tool(ToolRun(id: "t-\(asked)", name: "terminal", state: .succeeded, startedAt: t0, duration: 2.5))),
            TurnItem(.notice(Notice(.warning, "The connection came back."))),
            TurnItem(.text(reply)),
        ])
    }

    /// That turn as the host's history gives it: the message, the tool and `reply`.
    private func storedWithTool(_ asked: String, _ reply: String) -> Turn {
        Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: asked, sentAt: t0, delivery: .started))),
            TurnItem(.tool(ToolRun(id: "t-\(asked)", name: "terminal", state: .succeeded, startedAt: t0))),
            TurnItem(.text(reply)),
        ])
    }

    @Test func anOrdinaryOpenKeepsTheApprovalsAndNoticesSeenLive() {
        // Opened again (let go of at rest, or after a relaunch): the snapshot is not a repair.
        let live = approvedLive("one", "done")
        var state = ThreadState(transcript: Transcript(turns: [live]))
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [storedWithTool("one", "done")])))
        #expect(state.transcript.turns == [live])
    }

    @Test func aRepairReplacesWhatTheHostStreamedButKeepsWhatOnlyThisAppRecorded() {
        // The host took back a reply it had streamed, and the thread was taken whole again.
        let live = approvedLive("one", "done")
        var state = ThreadState(transcript: Transcript(turns: [live]))
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [storedWithTool("one", "repaired")]), authoritative: true))
        let turn = try? #require(state.transcript.turns.first)
        #expect(state.transcript.turns.count == 1)
        #expect(turn?.id == live.id)
        let kinds = turn?.items.map { item -> String in
            switch item.content {
            case .user: "user"
            case let .request(record): "request \(record.answer)"
            case let .tool(run): "tool \(run.id)"
            case let .notice(notice): "notice \(notice.text)"
            case let .text(text): "text \(text)"
            default: "other"
            }
        }
        // The approval before the tool it let run; the notice, whose place went with the
        // reply taken back, at the end.
        #expect(kinds == ["user", "request Allowed once", "tool t-one", "text repaired", "notice The connection came back."])
    }

    @Test func turnsBothAgreeOnKeepTheDetailSeenLive() {
        let mine = [watched("one", "1"), watched("two", "2")]
        #expect(merge(mine, [stored("one", "1"), stored("two", "2")]) == mine)
    }

    @Test func aCompletedTurnKeepsItsLiveDetailWhenHistoryOnlyTrimsItsReply() {
        let mine = watched("one", "The reply.\n\n")
        #expect(merge([mine], [stored("one", "The reply.")]) == [mine])
    }

    @Test func turnsTheHostHasAndTheAppDoesNotAreAdded() {
        let mine = [watched("one", "1")]
        let host = [stored("one", "1"), stored("two", "2"), inProgress("three")]
        #expect(merge(mine, host) == [mine[0], host[1], host[2]])
        // With no copy at all, the result is the host's.
        #expect(merge([], host) == host)
    }

    @Test func aTurnThatEndedWhileTheAppWasAwayComesFromTheHostAndStaysTheSameTurn() {
        // Still running in the app's copy; finished on the host.
        var running = watched("two", "partial")
        running.outcome = nil
        running.endedAt = nil
        let mine = [watched("one", "1"), running]
        let merged = merge(mine, [stored("one", "1"), stored("two", "the whole reply")])

        #expect(merged[0] == mine[0])
        #expect(merged[1].id == running.id)
        #expect(merged[1].startedAt == running.startedAt)
        #expect(merged[1].outcome == .completed)
        #expect(merged[1].items.map(\.content).last == .text("the whole reply"))
    }

    @Test func aTurnCutShortHereIsReplacedOnlyWhenTheHostHasMore() {
        // Loaded from disk as interrupted, because the app quit while it ran.
        let cut = watched("one", "partial", outcome: .interrupted)
        #expect(merge([cut], [stored("one", "the whole reply")])[0].outcome == .completed)
        // Stopped by the user: the host has nothing more, so the app's copy stands.
        #expect(merge([cut], [stored("one", nil)]) == [cut])
        #expect(merge([cut], [stored("one", "partial")]) == [cut])
    }

    @Test func aCachedDuplicateIsRemovedWithoutKeepingOnlyTheReplyBeforeReconnect() throws {
        let image = AttachedImage(filename: "pasted.jpg")
        var original = watched("Check this", "Checking.")
        original.items[0].content = .user(UserMessage(text: "Check this", sentAt: t0, delivery: .started, images: [image]))
        // The old snapshot mapper split one run into two completed turns, each
        // with the same user message, around a reconnect.
        let duplicate = stored("Check this", "The final reply.")
        let merged = merge([original, duplicate], [stored("Check this", "The final reply.")])
        #expect(merged.count == 1)
        let restored = try #require(merged.first)
        #expect(restored.id == original.id)
        #expect(restored.items.last?.content == .text("The final reply."))
        guard case let .user(message)? = restored.items.first?.content else {
            Issue.record("expected the original user message")
            return
        }
        #expect(message.images == [image])
    }

    @Test func aTurnThatFailedOnTheHostKeepsItsFailure() {
        let failed = Turn(startedAt: t0, endedAt: t0, outcome: .failed(TurnFailure(message: "The provider did not answer.")), items: [
            TurnItem(.user(UserMessage(text: "two", sentAt: t0, delivery: .started))),
        ])
        let mine = [watched("one", "1"), failed]
        // The host stored the message and no reply.
        #expect(merge(mine, [stored("one", "1"), stored("two", nil)]) == mine)
    }

    @Test func aMessageThatNeverReachedTheHostIsKept() {
        let mine = [watched("one", "1"), unsent("two")]
        #expect(merge(mine, [stored("one", "1")]) == mine)
        // Also when it was sent again and went through: the failed attempt stays where
        // it was, and the turn after it keeps its detail.
        let retried = [watched("one", "1"), unsent("two"), watched("two", "2")]
        #expect(merge(retried, [stored("one", "1"), stored("two", "2")]) == retried)
    }

    @Test func aMessageThoughtUnsentThatTheHostAnsweredTakesTheHostsTurn() {
        // The connection dropped as it was sent: it failed here, yet the host ran it. A host
        // that keeps no ids is matched by the words, as before ids were kept: shown once,
        // with no Try again to run it twice.
        let failedHere = unsent("two")
        let merged = merge([watched("one", "1"), failedHere], [stored("one", "1"), stored("two", "2")])
        #expect(merged.count == 2)
        #expect(merged[1].id == failedHere.id)
        #expect(merged[1].outcome == .completed)
        #expect(merged[1].items.map(\.content).last == .text("2"))
    }

    @Test func theRunningTurnStaysLast() {
        // Cut off here, still going on the host; then a message that was never sent.
        let cut = watched("one", "partial", outcome: .interrupted)
        let merged = merge([cut, unsent("two")], [inProgress("one", "partial and more")])
        #expect(merged.map(\.isRunning) == [false, true])
        #expect(merged[0].isUnsent)
        #expect(merged[1].id == cut.id)
    }

    @Test func aTurnTakenFromTheHostKeepsTheImagesSentFromHere() {
        // Sent with a picture, still running when the app last saw it.
        let picture = AttachedImage(filename: "photo.jpg")
        let mine = Turn(startedAt: t0, items: [
            TurnItem(.user(UserMessage(text: "what is this?", sentAt: t0, delivery: .started, images: [picture]))),
        ])
        // The host names the image; only this copy can show it.
        let theirs = Turn(startedAt: t0, endedAt: t0, outcome: .completed, items: [
            TurnItem(.user(UserMessage(text: "what is this?", sentAt: t0, delivery: .started, images: [AttachedImage(filename: "upload_1.jpg")]))),
            TurnItem(.text("A chart.")),
        ])
        let merged = merge([mine], [theirs])
        guard case let .user(message)? = merged[0].items.first?.content else {
            Issue.record("expected the message")
            return
        }
        #expect(message.images == [picture])
        #expect(merged[0].items.map(\.content).last == .text("A chart."))
    }

    @Test func turnsTheHostDoesNotHaveAreDropped() {
        let mine = [watched("one", "1"), watched("two", "2")]
        #expect(merge(mine, [stored("one", "1")]) == [mine[0]])
    }

    // MARK: Adopting a snapshot

    // MARK: A message on its way while the host's version arrives

    @Test func aMessageStillOnItsWayOutlastsAHostVersionWithoutIt() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let id = state.messageSent("two", at: t0)
        // The host's version was made before the message reached it.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1")])))

        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.map(\.id) == [id])
        #expect(state.transcript.turns[1].isRunning)
        #expect(state.isRunning)
        // Its answer and the run then land in that turn.
        state.messageDelivered(id, outcome: .started, at: t0)
        state.apply(.textDelta("2"), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.map(\.content).last == .text("2"))
    }

    @Test func aMessageTheHostHasAlreadyStartedOnIsOneTurnNotTwo() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let id = state.messageSent("two", at: t0)
        // From a host that keeps no ids: its running turn with the same words is this one.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), inProgress("two", "so far")]), isRunning: true))

        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id != nil)
        #expect(state.transcript.turns[1].items.map(\.content).last == .text("so far"))
        #expect(state.pending.isEmpty)
        #expect(state.isRunning)
        _ = id
    }

    @Test func aHostThatKeepsMessageIDsHasStartedOnAMessageOnItsWayOnlyUnderItsID() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let id = state.messageSent("two", at: t0)
        var mine = inProgress("two", "so far")
        mine.items[0].id = id
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), mine]), isRunning: true, hostKeepsMessageIDs: true))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id == id)
        #expect(state.transcript.turns[1].items.map(\.content).last == .text("so far"))
        #expect(state.pending.isEmpty)

        // The same words under another id: another device's message, which this one waits behind.
        var other = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let waiting = other.messageSent("two", at: t0)
        other.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), inProgress("two", "theirs")]), isRunning: true, hostKeepsMessageIDs: true))
        #expect(other.transcript.turns.count == 2)
        #expect(other.pending.map(\.id) == [waiting])
    }

    @Test func aMessageOnItsWayWhenTheHostIsBusyWithAnotherRunWaitsItsTurn() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let id = state.messageSent("two", at: t0)
        // A run this copy did not know about is going on there.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), inProgress("from elsewhere")]), isRunning: true))

        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns.last?.isRunning == true)
        #expect(state.pending.map(\.id) == [id])
        state.messageDelivered(id, outcome: .queued, at: t0)
        #expect(state.pending.first?.message.delivery == .queued)
    }

    @Test func aMessageHeldUntilTheThreadIsInStepWaitsWhereItCanBeSeen() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let id = state.messageSent("two", held: true, at: t0)
        #expect(state.transcript.turns.count == 1)
        #expect(state.pending.map(\.id) == [id])
        #expect(!state.isRunning)

        // The host's version arrives; the message is still there, and then starts its turn.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), stored("elsewhere", "x")])))
        #expect(state.pending.map(\.id) == [id])
        state.messageDelivered(id, outcome: .started, at: t0.addingTimeInterval(1))
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.count == 3)
        #expect(state.transcript.turns[2].items.map(\.id) == [id])
        #expect(state.isRunning)
    }

    @Test func aSnapshotOfARunInProgressPutsTheThreadBackInIt() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]), title: "Old")
        let request = PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "ls", reason: nil, choices: [.once, .deny])))
        let snapshot = ThreadSnapshot(
            transcript: Transcript(turns: [stored("one", "1"), inProgress("two", "so far")]),
            isRunning: true, title: "New", openRequests: [request]
        )
        state.apply(.snapshot(snapshot))

        #expect(state.isRunning)
        #expect(state.isWaitingOnUser)
        #expect(state.openRequests == [request])
        #expect(state.title == "New")
        #expect(state.transcript.turns.count == 2)

        // The run carries on in the turn the snapshot left open.
        state.apply(.textDelta(" and more"), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.map(\.content).last == .text("so far and more"))
        #expect(state.phase == .idle)
    }

    @Test func aSnapshotWithNothingRunningEndsWhatTheAppThoughtWasRunning() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let sent = state.messageSent("two", at: t0)
        state.messageDelivered(sent, outcome: .started)
        state.apply(.status("Thinking"), at: t0)
        let request = PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "ls", reason: nil, choices: [.once, .deny])))
        state.apply(.requestOpened(request), at: t0)
        let turnID = state.transcript.turns[1].id

        // The host finished the turn while the app was away.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), stored("two", "2")])))
        #expect(state.phase == .idle)
        #expect(state.openRequests.isEmpty)
        #expect(state.statusLine == nil)
        #expect(state.transcript.turns[1].id == turnID)
        #expect(state.transcript.turns[1].outcome == .completed)
    }

    @Test func aSnapshotWithNothingRunningKeepsWhatASubagentAsks() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]))
        let asked = PendingRequest(id: "srq-2", kind: .approval(ApprovalRequest(command: "ls", reason: nil, choices: [.once, .deny])), subagent: "a17")
        let turnsOwn = PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "rm x", reason: nil, choices: [.once, .deny])))
        // A subagent in the background still waits on its answer, with no turn running.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1")]), openRequests: [turnsOwn, asked]))
        #expect(state.phase == .idle)
        #expect(state.openRequests == [asked])
    }

    @Test func aRunTheHostLostIsShownAsCutOff() {
        var state = ThreadState()
        let sent = state.messageSent("one", at: t0)
        state.messageDelivered(sent, outcome: .started)

        // The host restarted mid-run: it has the message and nothing after it.
        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", nil)])))
        #expect(state.phase == .idle)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].outcome == .interrupted)
        #expect(state.transcript.turns[0].endedAt != nil)
    }

    @Test func aSnapshotWithNothingRunningDropsWhatWasQueued() {
        var state = ThreadState()
        let first = state.messageSent("one", at: t0)
        state.messageDelivered(first, outcome: .started)
        let queued = state.messageSent("two", at: t0)
        state.messageDelivered(queued, outcome: .queued)
        let onItsWay = state.messageSent("three", at: t0)
        #expect(state.pending.count == 2)

        state.adopt(ThreadSnapshot(transcript: Transcript(turns: [stored("one", "1"), stored("two", "2")])))
        // The queued one ran; the one the backend has not answered yet is still coming.
        #expect(state.pending.map(\.id) == [onItsWay])
    }

    @Test func aBlankTitleInASnapshotKeepsTheTitle() {
        var state = ThreadState(title: "Kept")
        state.adopt(ThreadSnapshot(title: "  "))
        #expect(state.title == "Kept")
    }

    @Test func beingDetachedChangesNothing() {
        var state = ThreadState(transcript: Transcript(turns: [watched("one", "1")]), title: "T")
        let before = state
        state.apply(.detached)
        #expect(state == before)
    }

    @Test func aToolResultWhoseStartWasMissedSaysWhatWasCalled() {
        var state = ThreadState()
        state.apply(.toolFinished(ToolResult(
            id: "t1", name: "terminal", label: "swift test", input: "swift test", succeeded: true, duration: 3, output: "ok"
        )), at: t0)
        guard case let .tool(run)? = state.transcript.turns.first?.items.first?.content else {
            Issue.record("expected a tool run")
            return
        }
        #expect(run.label == "swift test")
        #expect(run.input == "swift test")
        #expect(run.state == .succeeded)
    }

    // MARK: Models

    @Test func howFullTheContextIsFollowsTheHostAndOutlastsASilentSnapshot() {
        var state = ThreadState()
        #expect(state.context == nil)
        state.apply(.contextChanged(ContextUsage(used: 48_000, limit: 400_000)), at: t0)
        #expect(state.context?.fraction == 0.12)

        // A host that has just loaded the session again does not know; what was known stays.
        state.adopt(ThreadSnapshot(transcript: Transcript()))
        #expect(state.context == ContextUsage(used: 48_000, limit: 400_000))
        state.adopt(ThreadSnapshot(transcript: Transcript(), context: ContextUsage(used: 9_000, limit: 400_000)))
        #expect(state.context?.used == 9_000)
    }

    @Test func contextUsageReadsAsShortNumbers() {
        #expect(ContextUsage(used: 950, limit: 8_000).summary == "950 of 8k")
        #expect(ContextUsage(used: 48_300, limit: 400_000).summary == "48k of 400k")
        #expect(ContextUsage(used: 12_425, limit: 1_048_576).summary == "12k of 1M")
        #expect(ContextUsage(used: 1_250_000, limit: 2_000_000).summary == "1.2M of 2M")
        // Never past full, and nothing to divide by is empty.
        #expect(ContextUsage(used: 500_000, limit: 400_000).fraction == 1)
        #expect(ContextUsage(used: 10, limit: 0).fraction == 0)
    }

    @Test func aThreadSavedBeforeContextWasKeptStillLoads() throws {
        let ref = ThreadRef(id: ThreadRef.ID(rawValue: "stored-1"), agent: Agent.ID(host: HostID(rawValue: "h"), name: "aeri"))
        let saved = try JSONEncoder().encode(ThreadRecord(ref: ref, context: ContextUsage(used: 1, limit: 2)))
        #expect(try JSONDecoder().decode(ThreadRecord.self, from: saved).context == ContextUsage(used: 1, limit: 2))

        // The same record as an earlier version of the app wrote it: with no context.
        var older = try #require(try JSONSerialization.jsonObject(with: saved) as? [String: Any])
        older["context"] = nil
        let reread = try JSONDecoder().decode(ThreadRecord.self, from: try JSONSerialization.data(withJSONObject: older))
        #expect(reread.context == nil)
        #expect(reread.ref == ref)
    }

    private var catalog: ModelCatalog {
        ModelCatalog(
            providers: [
                ModelProvider(id: "openai-codex", name: "Codex", models: ["gpt-6.1-sol", "gpt-6-astra"]),
                ModelProvider(id: "openrouter", name: "OpenRouter", models: ["anthropic/claude-fable-5.1", "openai/gpt-6.1-sol"]),
                ModelProvider(id: "zai", name: "Z.AI", models: ["glm-5.3"]),
            ],
            agentDefault: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .high)
        )
    }

    @Test func whatAThreadRunsOnIsTheChoiceFilledInFromTheAgentsOwn() {
        #expect(catalog.setting(for: nil) == catalog.agentDefault)
        // A choice that leaves the level out thinks as hard as the agent does.
        #expect(catalog.setting(for: ModelSetting(model: "glm-5.3", provider: "zai"))
            == ModelSetting(model: "glm-5.3", provider: "zai", level: .high))
        // The agent's model with no provider named is the agent's; another model's is not guessed.
        #expect(catalog.setting(for: ModelSetting(model: "gpt-6.1-sol", level: .low))
            == ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .low))
        #expect(catalog.setting(for: ModelSetting(model: "glm-5.3")).provider == nil)
    }

    @Test func theAgentsOwnModelIsKnownWithOrWithoutItsProvider() {
        #expect(catalog.isAgentModel(ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .low)))
        #expect(catalog.isAgentModel(ModelSetting(model: "gpt-6.1-sol")))
        // The same model from somewhere else is another choice.
        #expect(!catalog.isAgentModel(ModelSetting(model: "gpt-6.1-sol", provider: "openrouter")))
        #expect(!catalog.isAgentModel(ModelSetting(model: "glm-5.3", provider: "zai")))

        #expect(ModelSetting(model: "glm-5.3", provider: "zai").isModel("glm-5.3", at: "zai"))
        #expect(ModelSetting(model: "glm-5.3").isModel("glm-5.3", at: "zai"))
        #expect(!ModelSetting(model: "glm-5.3", provider: "zai").isModel("glm-5.3", at: "openrouter"))
    }

    @Test func aTypedNameStandsForOneModelOrNone() {
        #expect(catalog.model(named: "GLM-5.3", preferring: nil)?.provider == "zai")
        // By its full name or its short one.
        #expect(catalog.model(named: "anthropic/claude-fable-5.1", preferring: nil)?.model == "anthropic/claude-fable-5.1")
        #expect(catalog.model(named: " claude-fable-5.1 ", preferring: nil)?.provider == "openrouter")
        // Offered in two places: the one in use, or it is not clear which.
        #expect(catalog.model(named: "gpt-6.1-sol", preferring: "openai-codex")?.model == "gpt-6.1-sol")
        #expect(catalog.model(named: "gpt-6.1-sol", preferring: "openrouter")?.model == "openai/gpt-6.1-sol")
        #expect(catalog.model(named: "gpt-6.1-sol", preferring: nil) == nil)
        #expect(catalog.model(named: "gpt-7", preferring: nil) == nil)
        #expect(catalog.model(named: "", preferring: "zai") == nil)
    }

    @Test func aTypedWordStandsForAThinkingLevel() {
        #expect(ThinkingLevel(named: "xhigh") == .extraHigh)
        #expect(ThinkingLevel(named: "Extra High") == .extraHigh)
        #expect(ThinkingLevel(named: "off") == .off)
        #expect(ThinkingLevel(named: "none") == .off)
        #expect(ThinkingLevel(named: " max ") == .max)
        #expect(ThinkingLevel(named: "") == nil)
        #expect(ThinkingLevel(named: "loud") == nil)
    }

    @Test func whatAThreadRunsOnFollowsTheHostKeepingALevelItLeavesOut() {
        var state = ThreadState()
        state.model = ModelSetting(model: "glm-5.3", provider: "zai", level: .low)
        // Nothing said about the model leaves the choice as it was.
        state.adopt(ThreadSnapshot(transcript: Transcript()))
        #expect(state.model == ModelSetting(model: "glm-5.3", provider: "zai", level: .low))

        state.adopt(ThreadSnapshot(transcript: Transcript(), model: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex")))
        #expect(state.model == ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .low))
        state.adopt(ThreadSnapshot(transcript: Transcript(), model: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .max)))
        #expect(state.model?.level == .max)
    }

    /// A thread caught up with the events it missed takes what the host says of it besides,
    /// as from a snapshot, and keeps its conversation: a model chosen elsewhere tells no event.
    @Test func whatAHostSaysOfAThreadCaughtUpIsTakenAsASnapshotsIs() {
        let turn = Turn(endedAt: .now, outcome: .completed, items: [TurnItem(.user(UserMessage(text: "hi"))), TurnItem(.text("Hello"))])
        var state = ThreadState(transcript: Transcript(turns: [turn]), title: "Greeting", context: ContextUsage(used: 10, limit: 100))
        state.model = ModelSetting(model: "glm-5.3", provider: "zai", level: .low)
        state.mode = ModeState(mode: .ask)

        state.apply(.caughtUp(ThreadInfo(model: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex"), context: ContextUsage(used: 50, limit: 100))))
        #expect(state.model == ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .low))
        #expect(state.context == ContextUsage(used: 50, limit: 100))
        // What it leaves out stays as it was, and so does the conversation.
        #expect(state.title == "Greeting")
        #expect(state.mode == ModeState(mode: .ask))
        #expect(state.transcript.turns == [turn])
        #expect(state.phase == .idle)

        state.apply(.caughtUp(ThreadInfo(title: "  Renamed ", model: ModelSetting(model: "gpt-6.1-sol", provider: "openai-codex", level: .max), mode: ModeState(mode: .plan))))
        #expect(state.title == "Renamed")
        #expect(state.model?.level == .max)
        #expect(state.mode == ModeState(mode: .plan))
    }

    @Test func thinkingLevelsCarryHermessNames() {
        #expect(ThinkingLevel.allCases.map(\.rawValue) == ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        #expect(ThinkingLevel(rawValue: "xhigh")?.title == "Extra high")
        #expect(ModelSetting(model: "anthropic/claude-fable-5.1").shortName == "claude-fable-5.1")
        #expect(ModelSetting(model: "gpt-6.1-sol").shortName == "gpt-6.1-sol")
    }

    @Test func theModelListPutsTheProviderInUseFirstAndNarrowsBySearch() {
        let catalog = ModelCatalog(
            providers: [
                ModelProvider(id: "openrouter", name: "OpenRouter", models: ["anthropic/claude-fable-5.1", "z-ai/glm-5.3"]),
                ModelProvider(id: "zai", name: "Z.AI / GLM", models: ["glm-5.3", "glm-5.3-flash"]),
                ModelProvider(id: "empty", name: "Nothing", models: []),
            ],
            agentDefault: ModelSetting(model: "glm-5.3", provider: "zai", level: .high)
        )
        #expect(catalog.providers(matching: "", current: catalog.agentDefault).map(\.id) == ["zai", "openrouter"])
        let flash = catalog.providers(matching: " FLASH ", current: catalog.agentDefault)
        #expect(flash.map(\.id) == ["zai"])
        #expect(flash[0].models == ["glm-5.3-flash"])
        // A provider's name finds its models too, and every word must match.
        #expect(catalog.providers(matching: "openrouter glm", current: nil).flatMap(\.models) == ["z-ai/glm-5.3"])
        #expect(catalog.providers(matching: "nothing here", current: nil).isEmpty)
    }
}
