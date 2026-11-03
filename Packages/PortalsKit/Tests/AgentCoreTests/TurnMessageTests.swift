import Foundation
import Testing
@testable import AgentCore

/// Every message said in a thread shows on every device that follows it (a bridge's
/// `turn_messages`): a turn another device started opens with that device's message, a
/// message another device handed to the running turn joins it, and this device's own
/// show once.
@Suite struct TurnMessageTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func contents(_ state: ThreadState) -> [[TurnItem.Content]] {
        state.transcript.turns.map { $0.items.map(\.content) }
    }

    @Test func aTurnAnotherDeviceStartedOpensWithItsMessageImagesAndFiles() {
        var state = ThreadState()
        let stored = "Look at these\n\n\(SentText.filesHeading)\n- /w/.portals/files/t/notes.txt\n@image:photo.png"
        state.apply(.turnOpened(by: stored), at: t0)
        state.apply(.textDelta("Seen."), at: t0)
        guard case let .user(message)? = contents(state).first?.first else {
            Issue.record("The turn opens with no message")
            return
        }
        #expect(message.text == "Look at these")
        #expect(message.delivery == .started)
        #expect(message.images.map(\.filename) == ["photo.png"])
        #expect(message.files.map(\.path) == ["/w/.portals/files/t/notes.txt"])
        #expect(contents(state)[0].last == .text("Seen."))
        #expect(state.isRunning)
    }

    @Test func aMessageAnotherDeviceHandedToTheRunningTurnJoinsIt() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "Fix the login"), at: t0)
        state.apply(.textDelta("Working"), at: t0)
        state.apply(.messageSteered("and use tabs"), at: t0)
        #expect(contents(state) == [[
            .user(UserMessage(text: "Fix the login", sentAt: t0, delivery: .started)),
            .text("Working"),
            .user(UserMessage(text: "and use tabs", sentAt: t0, delivery: .steered)),
        ]])
    }

    @Test func aMessageSteeredInMidReplySplitsTheReplyWhereItCame() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "Write about lighthouses"), at: t0)
        state.apply(.textDelta("Lighthouses have"), at: t0)
        state.apply(.messageSteered("End with banana."), at: t0)
        state.apply(.textDelta(" guided sailors"), at: t0)
        #expect(contents(state) == [[
            .user(UserMessage(text: "Write about lighthouses", sentAt: t0, delivery: .started)),
            .text("Lighthouses have"),
            .user(UserMessage(text: "End with banana.", sentAt: t0, delivery: .steered)),
            .text("guided sailors"),
        ]])
    }

    @Test func aPieceAMessageSplitAsItStreamedIsNotSaidAgainWholeWhenTheHostClosesIt() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "Write about lighthouses"), at: t0)
        state.apply(.textDelta("Lighthouses have"), at: t0)
        state.apply(.messageSteered("End with banana."), at: t0)
        state.apply(.textDelta(" guided sailors."), at: t0)
        // Claude Code's closing copy of the piece, as one: what streamed on both sides of the message.
        state.apply(.interimText("Lighthouses have guided sailors.", alreadyStreamed: true), at: t0)
        state.apply(.textDelta("Lighthouses have guided sailors. Banana."), at: t0)
        #expect(contents(state) == [[
            .user(UserMessage(text: "Write about lighthouses", sentAt: t0, delivery: .started)),
            .text("Lighthouses have"),
            .user(UserMessage(text: "End with banana.", sentAt: t0, delivery: .steered)),
            .text("guided sailors."),
            .text("Lighthouses have guided sailors. Banana."),
        ]])

        // A copy that is not what streamed (the agent wrote it again) stands for the second part, as before.
        var rewritten = ThreadState()
        rewritten.apply(.turnOpened(by: "Write about rivers"), at: t0)
        rewritten.apply(.textDelta("Rivers carry"), at: t0)
        rewritten.apply(.messageSteered("End with apple."), at: t0)
        rewritten.apply(.textDelta("Rivers carry water"), at: t0)
        rewritten.apply(.interimText("Rivers carry water", alreadyStreamed: true), at: t0)
        #expect(contents(rewritten)[0].last == .text("Rivers carry water"))
        #expect(contents(rewritten)[0][1] == .text("Rivers carry"))
    }

    @Test func aPieceTwoMessagesSplitIsNotSaidAgainWholeEither() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "Write about owls"), at: t0)
        state.apply(.textDelta("Owls hunt"), at: t0)
        state.apply(.messageSteered("Shorter."), at: t0)
        state.apply(.textDelta(" at night"), at: t0)
        state.apply(.messageSteered("End with pear."), at: t0)
        state.apply(.textDelta(" and rest by day."), at: t0)
        state.apply(.interimText("Owls hunt at night and rest by day.", alreadyStreamed: true), at: t0)
        #expect(contents(state)[0].compactMap { if case let .text(text) = $0 { text } else { nil } } == ["Owls hunt", "at night", "and rest by day."])
    }

    private func userTexts(_ turn: [TurnItem.Content]) -> [String] {
        turn.compactMap { if case let .user(message) = $0 { message.text } else { nil } }
    }

    /// The connection went after the host handed a message of this device's to the running
    /// turn and said so, before its answer came: the send fails here, but the host has it.
    /// The run goes on, with the message in it, not ended as failed by the lost answer.
    @Test func aSteeredMessageWhoseAnswerTheConnectionLostLeavesTheRunGoing() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.apply(.ownMessageSteered(mine), at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        #expect(state.isRunning)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].isRunning)
        #expect(userTexts(contents(state)[0]) == ["theirs", "mine"])
        // What the run says next, caught up on reconnecting, goes on in the same turn.
        state.apply(.textDelta("On it."), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(contents(state)[0].last == .text("On it."))
    }

    /// A message that opened a turn here, at rest, whose send failed as the connection went
    /// with the host's answer and its word that it began the run for it: the run, caught up
    /// on reconnecting, is the message's, which opens it again; not a failed message with
    /// a reply under no message after it.
    @Test func aMessageWhoseRunTheHostBeganAsTheConnectionWentOpensItOnceCaughtUp() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(1))
        #expect(!state.isRunning)
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(2))
        state.apply(.ownTurnStarted(mine), at: t0.addingTimeInterval(2))
        state.apply(.textDelta("Hi."), at: t0.addingTimeInterval(2))
        #expect(state.isRunning)
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.first?.id == mine)
        #expect(contents(state)[0].last == .text("Hi."))
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })

        // As it comes when nothing failed: the run is the one the message opened here.
        var plain = ThreadState()
        let sent = plain.messageSent("mine", at: t0)
        plain.apply(.ownTurnStarted(sent), at: t0.addingTimeInterval(1))
        plain.apply(.textDelta("Hi."), at: t0.addingTimeInterval(1))
        #expect(plain.transcript.turns.count == 1)
        #expect(plain.transcript.turns[0].items.first?.id == sent)
        #expect(plain.isRunning)

        // The host's word that it began the run came, and the answer was lost: the send's
        // failure leaves the run going.
        var told = ThreadState()
        let begun = told.messageSent("mine", at: t0)
        told.apply(.ownTurnStarted(begun), at: t0.addingTimeInterval(1))
        told.apply(.textDelta("Hi"), at: t0.addingTimeInterval(1))
        told.messageFailed(begun, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        told.apply(.textDelta(" there."), at: t0.addingTimeInterval(3))
        #expect(told.isRunning)
        #expect(told.transcript.turns.count == 1)
        #expect(told.transcript.turns[0].isRunning)
        #expect(told.transcript.turns[0].items.first?.id == begun)
        #expect(contents(told)[0].last == .text("Hi there."))
    }

    /// A message sent as a run of another's was ending: it waits here for its answer, the
    /// host, at rest by then, begins its run and says so, and the answer is lost as the
    /// connection goes. The run is the message's, which opens it; not a reply under no
    /// message after the message shown as failed, to be sent again.
    @Test func aWaitingMessageWhoseRunTheHostBeganAsTheConnectionWentOpensIt() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        state.apply(.ownTurnStarted(mine), at: t0.addingTimeInterval(3))
        state.apply(.textDelta("Hi"), at: t0.addingTimeInterval(3))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(4))
        state.apply(.textDelta(" there."), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id == mine)
        #expect(userTexts(contents(state)[1]) == ["mine"])
        #expect(contents(state)[1].last == .text("Hi there."))
        #expect(state.isRunning)
        #expect(state.pending.isEmpty)
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })

        // Its answer comes after all: the message stays where it is, started.
        var answered = ThreadState()
        answered.apply(.turnOpened(by: "theirs"), at: t0)
        let sent = answered.messageSent("mine", at: t0.addingTimeInterval(1))
        answered.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        answered.apply(.ownTurnStarted(sent), at: t0.addingTimeInterval(3))
        answered.messageDelivered(sent, outcome: .started, at: t0.addingTimeInterval(3))
        answered.apply(.textDelta("Hi."), at: t0.addingTimeInterval(3))
        #expect(answered.transcript.turns.count == 2)
        #expect(answered.transcript.turns[1].items.first?.id == sent)
        #expect(userTexts(contents(answered)[1]) == ["mine"])
        #expect(answered.pending.isEmpty)
    }

    /// A message the host put on its list while the connection went with its answer: the
    /// list says, by the id this device gave it (`message_ids`), that it waits there. It
    /// waits as this device's own, not shown failed (with Try again, which sends it twice)
    /// beside its listed copy, and opens its turn as its own when that begins.
    @Test func aQueuedMessageWhoseAnswerWasLostWaitsAsThisDevicesOwnOnceTheListSaysSo() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(3))
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine", messageID: mine)], canSteer: false, steered: nil), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
        #expect(state.pending.map(\.id) == [mine])
        #expect(state.pending.first?.queueID == "q1")
        #expect(state.pending.first?.message.delivery == .queued)
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(4))
        state.apply(.ownTurnStarted(mine, queueID: "q1"), at: t0.addingTimeInterval(5))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id == mine)
        #expect(state.pending.isEmpty)

        // The list's word came before the answer was lost: the message waits on.
        var early = ThreadState()
        early.apply(.turnOpened(by: "theirs"), at: t0)
        let sent = early.messageSent("mine", at: t0.addingTimeInterval(1))
        early.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine", messageID: sent)], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        early.messageFailed(sent, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        #expect(early.transcript.turns.count == 1)
        #expect(early.pending.map(\.id) == [sent])
        #expect(early.pending.first?.queueID == "q1")

        // Opened again whole, the host listing it as waiting.
        var whole = ThreadState()
        whole.apply(.turnOpened(by: "theirs"), at: t0)
        let lost = whole.messageSent("mine", at: t0.addingTimeInterval(1))
        whole.messageFailed(lost, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        whole.adopt(ThreadSnapshot(transcript: whole.transcript, isRunning: true, queued: [QueuedMessage(id: "q1", text: "mine", messageID: lost)]), at: t0.addingTimeInterval(3))
        #expect(!whole.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
        #expect(whole.pending.map(\.id) == [lost])
        #expect(whole.pending.first?.queueID == "q1")
    }

    /// A message sent at rest as the host was about to begin the run of one of this
    /// device's that waited on its list: the host begins that one's run, which opens with
    /// it; the other waits for its answer, which says where it went. Neither is lost.
    @Test func aRunOfOneOfThisDevicesQueuedMessagesBeginsOverOneSentAsItWasAboutTo() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let queued = state.messageSent("queued", at: t0.addingTimeInterval(1))
        state.messageDelivered(queued, outcome: .queued, queueID: "q1", at: t0.addingTimeInterval(1))
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "queued")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        let later = state.messageSent("later", at: t0.addingTimeInterval(3))
        state.apply(.ownTurnStarted(queued, queueID: "q1"), at: t0.addingTimeInterval(3))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(3))
        state.apply(.textDelta("On it."), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].items.first?.id == queued)
        #expect(userTexts(contents(state)[1]) == ["queued"])
        #expect(state.pending.map(\.id) == [later])
        state.messageDelivered(later, outcome: .queued, queueID: "q2", at: t0.addingTimeInterval(4))
        #expect(state.pending.first?.queueID == "q2")
    }

    /// One the host's list said waited there (its answer not come), whose run then began,
    /// and whose send then failed: the run goes on, with it.
    @Test func aClaimedQueuedMessageWhoseRunBeganIsNotFailedByItsSend() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine", messageID: mine)], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        state.apply(.ownTurnStarted(mine, queueID: "q1"), at: t0.addingTimeInterval(3))
        state.apply(.textDelta("Hi"), at: t0.addingTimeInterval(3))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(4))
        state.apply(.textDelta(" there."), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns[1].isRunning)
        #expect(state.transcript.turns[1].items.first?.id == mine)
        #expect(contents(state)[1].last == .text("Hi there."))
    }

    /// A message sent at rest opened a turn here, and the host, at work on its side (an
    /// agent catching up), listed it as waiting before its answer came; the answer was then
    /// lost. It waits as one the host queued, not failed beside its listed copy.
    @Test func aMessageThatOpenedATurnHereAndTheListSaysWaitsWaitsThereThoughItsAnswerIsLost() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine", messageID: mine)], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        #expect(state.transcript.turns.isEmpty)
        #expect(state.pending.map(\.id) == [mine])
        #expect(state.pending.first?.queueID == "q1")
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        #expect(state.transcript.turns.isEmpty)
        #expect(state.pending.map(\.id) == [mine])
        state.apply(.ownTurnStarted(mine, queueID: "q1"), at: t0.addingTimeInterval(3))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.first?.id == mine)
        #expect(state.pending.isEmpty)
    }

    /// A send that failed in a turn that holds a command's answer besides (a slash command
    /// run while it was on its way): the host's word that it runs the message still takes it
    /// back; the command's answer stays.
    @Test func aFailedSendBesideACommandsAnswerOpensItsRunOnceCaughtUp() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.commandFailed("/nope", reason: "Unknown command.", at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(3))
        state.apply(.ownTurnStarted(mine), at: t0.addingTimeInterval(3))
        state.apply(.textDelta("Hi."), at: t0.addingTimeInterval(3))
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
        #expect(state.transcript.turns.last?.items.first?.id == mine)
        #expect(state.transcript.turns.last?.isRunning == true)
        #expect(state.transcript.turns.flatMap(\.items).contains { if case .command = $0.content { true } else { false } })
    }

    /// Codex's second look, its second: however the host says the run of one of this
    /// device's queued messages begins (by the message's id, by its place on the list, or
    /// as another's message from a host that does not say whose), a turn opened here for a
    /// message sent as it began is set aside, and the queued one opens its run.
    @Test func everyWayAQueuedMessagesRunBeginsSetsAsideOneSentAsItBegan() {
        func ready() -> (ThreadState, UUID, UUID) {
            var state = ThreadState()
            state.apply(.turnOpened(by: "theirs"), at: t0)
            let queued = state.messageSent("queued", at: t0.addingTimeInterval(1))
            state.messageDelivered(queued, outcome: .queued, queueID: "q1", at: t0.addingTimeInterval(1))
            state.apply(.queueChanged([QueuedMessage(id: "q1", text: "queued")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
            state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
            let later = state.messageSent("later", at: t0.addingTimeInterval(3))
            return (state, queued, later)
        }
        for start in [ThreadEvent.queuedTurnStarted("q1"), .turnOpened(by: "queued", queueID: "q1")] {
            var (state, queued, later) = ready()
            state.apply(start, at: t0.addingTimeInterval(3))
            state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(3))
            #expect(state.transcript.turns.count == 2)
            #expect(state.transcript.turns[1].items.first?.id == queued)
            #expect(state.pending.map(\.id) == [later])
        }
    }

    /// Codex's second look, its third: the host at rest lists a message of this device's as
    /// waiting (an agent catching up), and the thread is opened again whole: the message
    /// still waits as this device's own, not dropped as if nothing waited any more.
    @Test func aWholeSnapshotAtRestKeepsThisDevicesMessagesItListsAsWaiting() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "q1", at: t0.addingTimeInterval(1))
        #expect(state.pending.map(\.id) == [mine])
        state.adopt(ThreadSnapshot(transcript: Transcript(), isRunning: false, queued: [QueuedMessage(id: "q1", text: "mine", messageID: mine)]), at: t0.addingTimeInterval(2))
        #expect(state.pending.map(\.id) == [mine])
        #expect(state.pending.first?.queueID == "q1")
    }

    /// Codex's second look, its fourth: a failed send whose turn holds a notice besides (a
    /// Try again refused while it was on its way) is taken back as well.
    @Test func aFailedSendBesideANoticeOpensItsRunOnceCaughtUp() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.notice(Notice(.info, "The agent is still working.")), at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        state.apply(.ownTurnStarted(mine), at: t0.addingTimeInterval(3))
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
        #expect(state.transcript.turns.last?.items.first?.id == mine)
        #expect(state.transcript.turns.last?.isRunning == true)
    }

    /// Codex's third look: a message that opened its turn here, listed by a bridge whose
    /// list does not carry ids, whose run then begins by its id: its own turn is its run;
    /// it is not set aside for a copy of itself, and a late failure of its send leaves it.
    @Test func aMessagesOwnTurnIsItsRunWhenItBeginsFromTheList() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.ownTurnStarted(mine, queueID: "q1"), at: t0.addingTimeInterval(2))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(2))
        state.apply(.textDelta("Hi."), at: t0.addingTimeInterval(2))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].items.first?.id == mine)
        #expect(userTexts(contents(state)[0]) == ["mine"])
        #expect(state.transcript.turns[0].isRunning)
        #expect(state.pending.isEmpty)

        // The same by its place on the list alone, from a bridge that does not say whose.
        var placed = ThreadState()
        let sent = placed.messageSent("mine", at: t0)
        placed.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        placed.apply(.queuedTurnStarted("q1"), at: t0.addingTimeInterval(2))
        #expect(placed.transcript.turns.count == 1)
        #expect(placed.transcript.turns[0].items.first?.id == sent)
    }

    /// A bridge with neither `turn_messages` nor `message_ids` (connect-18): a message that
    /// opened its turn here, listed with no id, whose run the host begins by its place on
    /// the list alone, and whose answer is then lost as the connection goes. The host runs
    /// it: the run goes on with it, not ended as failed for its reply to land under no
    /// message. An answer that comes instead, with another place, still sets it aside.
    @Test func aRunBegunByItsPlaceAloneIsNotFailedByALateSendFailure() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.queuedTurnStarted("q1"), at: t0.addingTimeInterval(2))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(2))
        state.apply(.textDelta("Hi"), at: t0.addingTimeInterval(2))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(3))
        state.apply(.textDelta(" there."), at: t0.addingTimeInterval(4))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].isRunning)
        #expect(state.transcript.turns[0].items.first?.id == mine)
        #expect(contents(state)[0].last == .text("Hi there."))
        guard case let .user(message)? = contents(state).first?.first else {
            Issue.record("The run opens with no message")
            return
        }
        #expect(message.delivery == .started)
        #expect(state.pending.isEmpty)

        // The run another's, by the answer that came: this one waits for its own place.
        var other = ThreadState()
        let sent = other.messageSent("mine", at: t0)
        other.apply(.queueChanged([QueuedMessage(id: "q1", text: "theirs")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        other.apply(.queuedTurnStarted("q1"), at: t0.addingTimeInterval(2))
        other.messageDelivered(sent, outcome: .queued, queueID: "q2", at: t0.addingTimeInterval(3))
        #expect(other.pending.map(\.id) == [sent])
        #expect(other.pending.first?.queueID == "q2")
    }

    /// The same for a message with an image and a file, which the host lists as it stores
    /// it: its words, then its files' paths and an `@image:` line (Codex's re-check).
    @Test func aRunBegunByPlaceOfAMessageWithAttachmentsIsNotFailedByALateSendFailure() {
        var state = ThreadState()
        let mine = state.messageSent("mine", images: [AttachedImage(filename: "photo.jpg")], files: [AttachedFile(filename: "notes.txt")], at: t0)
        let stored = "mine\n\n\(SentText.filesHeading)\n- /w/.portals/files/t/notes.txt\n@image:/w/.portals/images/photo.jpg"
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: stored)], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.queuedTurnStarted("q1"), at: t0.addingTimeInterval(2))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(2))
        state.apply(.textDelta("Hi"), at: t0.addingTimeInterval(2))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(3))
        state.apply(.textDelta(" there."), at: t0.addingTimeInterval(4))
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns[0].isRunning)
        #expect(state.transcript.turns[0].items.first?.id == mine)
        #expect(contents(state)[0].last == .text("Hi there."))
    }

    /// connect-18 is for the run of this device's own message only: a run of another's,
    /// begun by its place on a list that names it with other words, does not make this
    /// message's own failure (an attachment that could not be sent) a run begun (Codex's
    /// review of the follow-up).
    @Test func anotherMessagesRunBegunByPlaceLeavesThisMessagesFailureAFailure() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "theirs")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.queuedTurnStarted("q1"), at: t0.addingTimeInterval(2))
        let failure = TurnFailure(message: "The attachment could not be sent.")
        state.messageFailed(mine, failure, at: t0.addingTimeInterval(3))
        let holding = state.transcript.turns.first { turn in turn.items.contains { $0.id == mine } }
        #expect(holding?.outcome == .failed(failure))
        guard case let .user(message)? = holding?.items.first(where: { $0.id == mine })?.content else {
            Issue.record("The message is gone")
            return
        }
        #expect(message.delivery == nil)
    }

    /// Codex's second look, its first: the turn opened here for a message sent as a queued
    /// one's run began holds a command's answer besides (a slash command run meanwhile). It
    /// is set aside all the same: the queued message opens its run, the other waits for its
    /// answer, and the command's answer stays, in a turn that is over.
    @Test func aTurnOpenedHereWithACommandsAnswerIsSetAsideForAQueuedMessagesRun() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let queued = state.messageSent("queued", at: t0.addingTimeInterval(1))
        state.messageDelivered(queued, outcome: .queued, queueID: "q1", at: t0.addingTimeInterval(1))
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "queued")], canSteer: false, steered: nil), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        let later = state.messageSent("later", at: t0.addingTimeInterval(3))
        state.commandFailed("/nope", reason: "Unknown command.", at: t0.addingTimeInterval(3))
        state.apply(.ownTurnStarted(queued, queueID: "q1"), at: t0.addingTimeInterval(4))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(4))
        state.apply(.textDelta("On it."), at: t0.addingTimeInterval(4))
        #expect(state.transcript.turns.last?.items.first?.id == queued)
        #expect(state.transcript.turns.last?.isRunning == true)
        #expect(state.pending.map(\.id) == [later])
        #expect(state.transcript.turns.flatMap(\.items).contains { if case .command = $0.content { true } else { false } })
        #expect(state.transcript.turns.filter(\.isRunning).count == 1)

        // The same with a notice of this device's in it (a Try again refused meanwhile).
        var noticed = ThreadState()
        noticed.apply(.turnOpened(by: "theirs"), at: t0)
        let waiting = noticed.messageSent("queued", at: t0.addingTimeInterval(1))
        noticed.messageDelivered(waiting, outcome: .queued, queueID: "q1", at: t0.addingTimeInterval(1))
        noticed.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        let after = noticed.messageSent("later", at: t0.addingTimeInterval(3))
        noticed.apply(.notice(Notice(.info, "The agent is still working.")), at: t0.addingTimeInterval(3))
        noticed.apply(.ownTurnStarted(waiting, queueID: "q1"), at: t0.addingTimeInterval(4))
        #expect(noticed.transcript.turns.last?.items.first?.id == waiting)
        #expect(noticed.pending.map(\.id) == [after])
    }

    /// The same for a message the host put on its list to wait for the run going on: the
    /// device never heard its place on the list, which shows it as if from elsewhere until
    /// its turn begins; it begins as this device's own message, once.
    @Test func aQueuedMessageWhoseAnswerTheConnectionLostOpensItsTurnAsThisDevicesOwn() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(3))
        state.apply(.queueChanged([QueuedMessage(id: "q1", text: "mine")], canSteer: false, steered: nil), at: t0.addingTimeInterval(3))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(4))
        state.apply(.ownTurnStarted(mine, queueID: "q1"), at: t0.addingTimeInterval(5))
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0.addingTimeInterval(5))
        state.apply(.textDelta("Hi."), at: t0.addingTimeInterval(5))
        #expect(state.transcript.turns.count == 2)
        #expect(userTexts(contents(state)[0]) == ["theirs"])
        #expect(state.transcript.turns[1].items.first?.id == mine)
        #expect(userTexts(contents(state)[1]) == ["mine"])
        #expect(state.isRunning)
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
    }

    /// The connection went before the host's word that it handed the message to the running
    /// turn reached this device: the send failed here, and the word comes with what the
    /// device catches up on. The message joins the run; it is not left failed, to be sent
    /// again by hand into a run that already has it.
    @Test func aSteeredMessageTheHostTookAsTheConnectionWentJoinsTheRunOnceCaughtUp() {
        var state = ThreadState()
        state.apply(.turnOpened(by: "theirs"), at: t0)
        let mine = state.messageSent("mine", at: t0.addingTimeInterval(1))
        state.messageFailed(mine, TurnFailure(message: "The connection closed."), at: t0.addingTimeInterval(2))
        #expect(state.transcript.turns.count == 2)
        state.apply(.catchUpBegan, at: t0.addingTimeInterval(3))
        state.apply(.ownMessageSteered(mine), at: t0.addingTimeInterval(3))
        state.apply(.textDelta("On it."), at: t0.addingTimeInterval(3))
        #expect(state.transcript.turns.count == 1)
        #expect(state.isRunning)
        #expect(userTexts(contents(state)[0]) == ["theirs", "mine"])
        #expect(state.transcript.turns[0].items.first(where: { $0.id == mine }) != nil)
        #expect(!state.transcript.turns.contains { if case .failed = $0.outcome { true } else { false } })
    }

    @Test func aMessageOfThisDevicesJoinsTheRunTheHostHandedItToWhateverComesBeforeTheAnswer() {
        // Sent here as the thread looked at rest; another device's turn had begun, the host
        // handed this one to it (and said so among its events), and that turn's end came
        // before the answer.
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(1))
        state.apply(.ownMessageSteered(mine), at: t0.addingTimeInterval(2))
        state.apply(.textDelta("Done."), at: t0.addingTimeInterval(2))
        state.apply(.turnFinished(.completed, finalText: nil), at: t0.addingTimeInterval(3))
        state.messageDelivered(mine, outcome: .steered, at: t0.addingTimeInterval(4))
        #expect(!state.isRunning)
        #expect(state.transcript.turns.count == 1)
        #expect(userTexts(contents(state)[0]) == ["theirs", "mine"])
        #expect(state.pending.isEmpty)

        // One sent during a run, whose end and the next run's start came before the answer.
        var during = ThreadState()
        during.apply(.turnOpened(by: "theirs"), at: t0)
        let sent = during.messageSent("also mine", at: t0.addingTimeInterval(1))
        during.apply(.ownMessageSteered(sent), at: t0.addingTimeInterval(1))
        during.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        during.apply(.turnOpened(by: "next"), at: t0.addingTimeInterval(3))
        during.messageDelivered(sent, outcome: .steered, at: t0.addingTimeInterval(4))
        #expect(during.transcript.turns.count == 2)
        #expect(userTexts(contents(during)[0]) == ["theirs", "also mine"])
        #expect(userTexts(contents(during)[1]) == ["next"])
        #expect(during.isRunning)
        #expect(during.pending.isEmpty)

        // Sent during a run that ended before the host had it: the host handed it to the next
        // run, which another device's message opened; it joins that one, not the one it was sent in.
        var later = ThreadState()
        later.apply(.turnOpened(by: "first"), at: t0)
        let delayed = later.messageSent("mine, late", at: t0.addingTimeInterval(1))
        later.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        later.apply(.turnOpened(by: "second"), at: t0.addingTimeInterval(3))
        later.apply(.ownMessageSteered(delayed), at: t0.addingTimeInterval(4))
        later.messageDelivered(delayed, outcome: .steered, at: t0.addingTimeInterval(5))
        #expect(userTexts(contents(later)[0]) == ["first"])
        #expect(userTexts(contents(later)[1]) == ["second", "mine, late"])
        #expect(later.pending.isEmpty)

        // Held until the thread was in step with the host, which was at work: handed to that
        // run, whose end came before the answer.
        var held = ThreadState()
        let waiting = held.messageSent("held one", held: true, at: t0)
        let host = Transcript(turns: [Turn(startedAt: t0, items: [TurnItem(.user(UserMessage(text: "running", sentAt: t0, delivery: .started)))])])
        held.adopt(ThreadSnapshot(transcript: host, isRunning: true), at: t0.addingTimeInterval(1))
        held.apply(.ownMessageSteered(waiting), at: t0.addingTimeInterval(2))
        held.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(3))
        held.messageDelivered(waiting, outcome: .steered, at: t0.addingTimeInterval(4))
        #expect(!held.isRunning)
        #expect(held.transcript.turns.count == 1)
        #expect(userTexts(contents(held)[0]) == ["running", "held one"])
        #expect(held.pending.isEmpty)
    }

    @Test func theHostsWordThatItHandedOverAMessageOfThisDevicesIsForThatMessageAlone() {
        // Two alike in words, with different images: the first opened a turn here that another
        // device's start then took (so it waits again, behind the second on the list).
        var state = ThreadState()
        let first = state.messageSent("look", images: [AttachedImage(filename: "first.png")], at: t0)
        let second = state.messageSent("look", images: [AttachedImage(filename: "second.png")], at: t0.addingTimeInterval(1))
        state.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(2))
        state.apply(.ownMessageSteered(first), at: t0.addingTimeInterval(3))
        state.messageDelivered(first, outcome: .steered, at: t0.addingTimeInterval(3))
        state.apply(.ownMessageSteered(second), at: t0.addingTimeInterval(4))
        state.messageDelivered(second, outcome: .steered, at: t0.addingTimeInterval(4))
        let images = contents(state)[0].compactMap { if case let .user(message) = $0 { message.images.first?.filename } else { nil } }
        #expect(images == ["first.png", "second.png"])
        #expect(state.pending.isEmpty)

        // The answer first: the word that comes after it is for a message placed already, and
        // leaves the next one alike, still on its way, where it is.
        var answerFirst = ThreadState()
        answerFirst.apply(.turnOpened(by: "running"), at: t0)
        let one = answerFirst.messageSent("look", images: [AttachedImage(filename: "first.png")], at: t0.addingTimeInterval(1))
        let two = answerFirst.messageSent("look", images: [AttachedImage(filename: "second.png")], at: t0.addingTimeInterval(2))
        answerFirst.messageDelivered(one, outcome: .steered, at: t0.addingTimeInterval(3))
        answerFirst.apply(.ownMessageSteered(one), at: t0.addingTimeInterval(3))
        #expect(answerFirst.pending.map(\.id) == [two])
        answerFirst.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(4))
        answerFirst.messageDelivered(two, outcome: .started, at: t0.addingTimeInterval(5))
        let turns = contents(answerFirst).map { $0.compactMap { if case let .user(message) = $0 { message.images.first?.filename } else { nil } } }
        #expect(turns == [["first.png"], ["second.png"]])
    }

    @Test func aMessageOfThisDevicesThatTheThreadWasOpenedAgainWithIsShownOnceAndOpensNoTurn() {
        // Sent before the thread was in step; the host handed it to its run, and the thread was
        // opened again with the host's copy of it before the answer came.
        var state = ThreadState()
        let waiting = state.messageSent("held one", held: true, at: t0)
        let host = Transcript(turns: [Turn(startedAt: t0, items: [
            TurnItem(.user(UserMessage(text: "running", sentAt: t0, delivery: .started))),
            TurnItem(.user(UserMessage(text: "held one", sentAt: t0, delivery: .steered))),
        ])])
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true), at: t0.addingTimeInterval(1))
        state.apply(.ownMessageSteered(waiting, shownAlready: true), at: t0.addingTimeInterval(1))
        state.apply(.turnFinished(.completed, finalText: "Done."), at: t0.addingTimeInterval(2))
        state.messageDelivered(waiting, outcome: .steered, at: t0.addingTimeInterval(3))
        #expect(!state.isRunning)
        #expect(state.transcript.turns.count == 1)
        #expect(userTexts(contents(state)[0]) == ["running", "held one"])
        #expect(state.pending.isEmpty)
    }

    @Test func aSplitPieceKeepsTheHostsSpacingWhereTheStreamedPartsLostIt() {
        // Code split by a message as it streamed: the part after it streamed without its
        // indentation (a piece of text never opens with spacing), which the host's closing copy has.
        var state = ThreadState()
        state.apply(.turnOpened(by: "Write f"), at: t0)
        state.apply(.textDelta("```python\ndef f():\n"), at: t0)
        state.apply(.messageSteered("Return one."), at: t0)
        state.apply(.textDelta("    return 1\n```"), at: t0)
        state.apply(.interimText("```python\ndef f():\n    return 1\n```", alreadyStreamed: true), at: t0)
        let texts = contents(state)[0].compactMap { if case let .text(text) = $0 { text } else { nil } }
        #expect(texts == ["```python\ndef f():", "    return 1\n```"])
        #expect(texts.joined(separator: "\n") == "```python\ndef f():\n    return 1\n```")
    }

    @Test func anAnswerThatComesBeforeTheStartOfAnotherDevicesTurnLeavesThatTurnItsOpener() {
        // Sent here as the thread looked at rest; the host handed it to another device's turn,
        // and that answer was taken in before the turn's start.
        var steered = ThreadState()
        let mine = steered.messageSent("mine", at: t0)
        steered.messageDelivered(mine, outcome: .steered, at: t0)
        steered.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(1))
        #expect(contents(steered) == [[
            .user(UserMessage(text: "theirs", sentAt: t0.addingTimeInterval(1), delivery: .started)),
            .user(UserMessage(text: "mine", sentAt: t0, delivery: .steered)),
        ]])
        #expect(steered.pending.isEmpty)

        // Or put it on the list behind that turn: it waits for a turn of its own.
        var queued = ThreadState()
        let waiting = queued.messageSent("mine", at: t0)
        queued.messageDelivered(waiting, outcome: .queued, queueID: "2", at: t0)
        queued.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(1))
        #expect(contents(queued) == [[.user(UserMessage(text: "theirs", sentAt: t0.addingTimeInterval(1), delivery: .started))]])
        #expect(queued.pending.map(\.queueID) == ["2"])
        queued.apply(.turnFinished(.completed, finalText: nil), at: t0)
        queued.apply(.queuedTurnStarted("2"), at: t0)
        #expect(contents(queued)[1] == [.user(UserMessage(text: "mine", sentAt: t0, delivery: .queued))])
        #expect(queued.transcript.turns[1].items[0].id == waiting)

        // Sent before the thread was in step with the host, and handed to a run this app had
        // not seen begin: that run's start, coming after, still opens it with its message.
        var held = ThreadState()
        let early = held.messageSent("mine", held: true, at: t0)
        held.adopt(ThreadSnapshot(transcript: Transcript(), isRunning: false), at: t0)
        held.messageDelivered(early, outcome: .steered, at: t0.addingTimeInterval(1))
        held.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(2))
        #expect(contents(held) == [[
            .user(UserMessage(text: "theirs", sentAt: t0.addingTimeInterval(2), delivery: .started)),
            .user(UserMessage(text: "mine", sentAt: t0, delivery: .steered)),
        ]])
    }

    @Test func aMessageOfThisDevicesThatWaitedOnTheListOpensItsTurnOnce() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let mine = state.messageSent("mine", at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "3", at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        // From a host that could not tell it was this device's (its id was not kept).
        state.apply(.turnOpened(by: "mine", queueID: "3"), at: t0)
        #expect(contents(state)[1] == [.user(UserMessage(text: "mine", sentAt: t0, delivery: .queued))])
        #expect(state.transcript.turns[1].items[0].id == mine)
        #expect(state.pending.isEmpty)
    }

    @Test func aMessageAnotherDeviceQueuedOpensItsTurnOnceAndLeavesTheList() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "4", text: "theirs")], canSteer: false, steered: nil), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.turnOpened(by: "theirs", queueID: "4"), at: t0)
        state.apply(.queueChanged([], canSteer: false, steered: nil), at: t0)
        #expect(contents(state)[1] == [.user(UserMessage(text: "theirs", sentAt: t0, delivery: .started))])
        #expect(state.queued.isEmpty)
    }

    @Test func aMessageSentAsAnotherDevicesOpenedTheTurnWaitsForItsAnswerAndJoinsThatTurn() {
        var state = ThreadState()
        // Sent here while the thread was at rest, as another device's message started a turn.
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnOpened(by: "theirs"), at: t0.addingTimeInterval(1))
        #expect(contents(state) == [[.user(UserMessage(text: "theirs", sentAt: t0.addingTimeInterval(1), delivery: .started))]])
        #expect(state.pending.map(\.id) == [mine])
        // The host handed it to that turn.
        state.messageDelivered(mine, outcome: .steered, at: t0.addingTimeInterval(1))
        #expect(state.pending.isEmpty)
        #expect(contents(state) == [[
            .user(UserMessage(text: "theirs", sentAt: t0.addingTimeInterval(1), delivery: .started)),
            .user(UserMessage(text: "mine", sentAt: t0, delivery: .steered)),
        ]])
        #expect(state.transcript.turns[0].items[1].id == mine)
    }

    @Test func aMessageSentAsAnotherDevicesOpenedTheTurnAndQueuedOpensTheTurnAfter() {
        var state = ThreadState()
        let mine = state.messageSent("mine", at: t0)
        state.apply(.turnOpened(by: "theirs"), at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("1"), at: t0)
        #expect(contents(state) == [
            [.user(UserMessage(text: "theirs", sentAt: t0, delivery: .started))],
            [.user(UserMessage(text: "mine", sentAt: t0, delivery: .queued))],
        ])
    }
}
