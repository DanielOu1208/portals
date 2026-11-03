import Foundation
import Testing
@testable import AgentCore

/// Messages waiting on a host that lists them (a Portals bridge's `queue`), seen the
/// same on every device, and the files a message carries.
@Suite struct QueueTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func contents(_ state: ThreadState) -> [[TurnItem.Content]] {
        state.transcript.turns.map { $0.items.map(\.content) }
    }

    private func listed(_ entries: (String, String)...) -> [QueuedMessage] {
        entries.map { QueuedMessage(id: $0.0, text: $0.1) }
    }

    @Test func aQueuedMessageIsListedAndOpensTheTurnThatNamesIt() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        state.apply(.textDelta("one"), at: t0)
        let a = state.messageSent("a", at: t0)
        let b = state.messageSent("b", at: t0)
        // The host lists each before its answer reaches the app.
        state.apply(.queueChanged(listed(("1", "a")), canSteer: true, steered: nil), at: t0)
        state.messageDelivered(a, outcome: .queued, queueID: "1", at: t0)
        state.apply(.queueChanged(listed(("1", "a"), ("2", "b")), canSteer: true, steered: nil), at: t0)
        state.messageDelivered(b, outcome: .queued, queueID: "2", at: t0)
        #expect(state.queued.map(\.id) == ["1", "2"])
        #expect(state.canSteerQueued)
        #expect(state.pending.map(\.queueID) == ["1", "2"])

        // "a" is taken off the list, here or on another device: it is never sent.
        state.apply(.queueChanged(listed(("2", "b")), canSteer: true, steered: nil), at: t0)
        #expect(state.pending.map(\.message.text) == ["b"])

        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("2"), at: t0)
        state.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        #expect(state.pending.isEmpty)
        #expect(state.queued.isEmpty)
        #expect(contents(state)[1] == [.user(UserMessage(text: "b", sentAt: t0, delivery: .queued))])
        #expect(state.transcript.turns[1].items[0].id == b)
    }

    @Test func aTurnWithNoQueueIDIsNotOpenedByAMessageThatWaitsOnTheList() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let a = state.messageSent("a", at: t0)
        state.messageDelivered(a, outcome: .queued, queueID: "1", at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        // A turn the host began by itself, or at the desk.
        state.apply(.turnStarted, at: t0)
        #expect(contents(state)[1] == [])
        #expect(state.pending.map(\.queueID) == ["1"])
    }

    @Test func aMessageAnotherDeviceQueuedOpensItsTurnAsTheHostListedIt() {
        var state = ThreadState()
        state.messageSent("first", at: t0)
        let stored = "Summarise\n\n\(SentText.filesHeading)\n- /w/.portals/files/t/report.pdf\n@image:photo.jpg"
        state.apply(.queueChanged([QueuedMessage(id: "4", text: stored)], canSteer: false, steered: nil), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("4"), at: t0)
        guard case let .user(message)? = contents(state)[1].first else {
            Issue.record("The turn opens with no message")
            return
        }
        #expect(message.text == "Summarise")
        #expect(message.files.map(\.filename) == ["report.pdf"])
        #expect(message.files.first?.path == "/w/.portals/files/t/report.pdf")
        #expect(message.images.map(\.filename) == ["photo.jpg"])
    }

    @Test func aMessageSteeredInFromTheListJoinsTheRunningTurnOnEveryDevice() {
        var state = ThreadState()
        state.messageSent("start", at: t0)
        state.apply(.textDelta("working"), at: t0)
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged(listed(("1", "mine"), ("2", "theirs")), canSteer: true, steered: nil), at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        // This device's own, then another device's: both join the turn running now.
        state.apply(.queueChanged(listed(("2", "theirs")), canSteer: true, steered: "1"), at: t0)
        state.apply(.queueChanged([], canSteer: true, steered: "2"), at: t0)
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.count == 1)
        #expect(contents(state)[0] == [
            .user(UserMessage(text: "start", sentAt: t0)),
            .text("working"),
            .user(UserMessage(text: "mine", sentAt: t0, delivery: .steered)),
            .user(UserMessage(text: "theirs", sentAt: t0, delivery: .steered)),
        ])
        #expect(state.transcript.turns[0].items[2].id == mine)
    }

    @Test func aSnapshotTakesTheListAndDropsThisDevicesMessagesNoLongerOnIt() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("start", at: t0), outcome: .started, at: t0)
        let a = state.messageSent("a", at: t0)
        state.messageDelivered(a, outcome: .queued, queueID: "1", at: t0)
        var host = state.transcript
        host.turns[0].items = [state.transcript.turns[0].items[0]]
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: listed(("2", "b")), canSteerQueued: true))
        #expect(state.pending.isEmpty)
        #expect(state.queued.map(\.id) == ["2"])
        #expect(state.canSteerQueued)

        // A host that does not list its queue leaves this device's waiting messages be.
        var older = ThreadState()
        older.messageDelivered(older.messageSent("start", at: t0), outcome: .started, at: t0)
        let b = older.messageSent("b", at: t0)
        older.messageDelivered(b, outcome: .queued, at: t0)
        older.adopt(ThreadSnapshot(transcript: older.transcript, isRunning: true))
        #expect(older.pending.map(\.message.text) == ["b"])
    }

    @Test func aMessageThatLeftTheListBeforeItsAnswerCameIsNotLeftWaitingUnseen() {
        // Taken off the list, on this device or another, before the answer to sending it.
        var removed = ThreadState()
        removed.messageDelivered(removed.messageSent("first", at: t0), outcome: .started, at: t0)
        let gone = removed.messageSent("remove me", at: t0)
        removed.apply(.queueChanged(listed(("1", "remove me")), canSteer: true, steered: nil), at: t0)
        removed.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        removed.messageDelivered(gone, outcome: .queued, queueID: "1", at: t0)
        #expect(removed.pending.isEmpty)
        #expect(contents(removed)[0] == [.user(UserMessage(text: "first", sentAt: t0, delivery: .started))])

        // Its turn began first: the turn opens with this device's own copy, files and all.
        var started = ThreadState()
        started.messageDelivered(started.messageSent("first", at: t0), outcome: .started, at: t0)
        let file = AttachedFile(filename: "report.pdf", size: 8)
        let next = started.messageSent("next", files: [file], at: t0)
        started.apply(.queueChanged([QueuedMessage(id: "1", text: "next\n\n\(SentText.filesHeading)\n- /w/report.pdf")], canSteer: true, steered: nil), at: t0)
        started.apply(.turnFinished(.completed, finalText: nil), at: t0)
        started.apply(.queuedTurnStarted("1"), at: t0)
        started.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        started.messageDelivered(next, outcome: .queued, queueID: "1", at: t0)
        #expect(started.pending.isEmpty)
        #expect(started.transcript.turns[1].items.map(\.id) == [next])
        #expect(contents(started)[1] == [.user(UserMessage(text: "next", sentAt: t0, delivery: .queued, files: [file]))])

        // Steered into the running turn first: the same there.
        var steered = ThreadState()
        steered.messageDelivered(steered.messageSent("first", at: t0), outcome: .started, at: t0)
        let steer = steered.messageSent("steer me", at: t0)
        steered.apply(.queueChanged(listed(("1", "steer me")), canSteer: true, steered: nil), at: t0)
        steered.apply(.queueChanged([], canSteer: true, steered: "1"), at: t0)
        steered.messageDelivered(steer, outcome: .queued, queueID: "1", at: t0)
        #expect(steered.pending.isEmpty)
        #expect(steered.transcript.turns[0].items.map(\.id).last == steer)
        #expect(contents(steered)[0].last == .user(UserMessage(text: "steer me", sentAt: t0, delivery: .steered)))
    }

    @Test func theFilesOfTheLastMessageAreKeptWholeAndOlderOnesWhileThereIsRoom() {
        var sent = SentFileBytes()
        let big = Data(count: SentFileBytes.limit / 2 + 1)
        let first = FileAttachment(data: big, filename: "a.bin")
        let second = FileAttachment(data: big, filename: "b.bin")
        sent.keep([first])
        sent.keep([second])
        // Both together are over the limit: the older one is let go.
        #expect(sent.data(for: first.id) == nil)
        #expect(sent.data(for: second.id) == big)
        // A message larger than the limit by itself is still kept whole, as the last one.
        let huge = [FileAttachment(data: big, filename: "c.bin"), FileAttachment(data: big, filename: "d.bin")]
        sent.keep(huge)
        #expect(sent.data(for: second.id) == nil)
        #expect(huge.allSatisfy { sent.data(for: $0.id) != nil })
        // Sent again under the same ids, they are kept once, as the newest.
        let small = FileAttachment(data: Data("x".utf8), filename: "e.txt")
        sent.keep([small])
        sent.keep([small])
        #expect(sent.data(for: small.id) == Data("x".utf8))
    }

    @Test func anIdListedAgainIsAMessageWaitingWhateverAnIdLikeItDidBefore() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        let a = state.messageSent("a", at: t0)
        state.apply(.queueChanged(listed(("1", "a")), canSteer: true, steered: nil), at: t0)
        state.messageDelivered(a, outcome: .queued, queueID: "1", at: t0)
        state.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        #expect(state.pending.isEmpty)
        // The host gives "1" again (a session of the thread's own, or a host started again).
        let b = state.messageSent("b", at: t0)
        state.apply(.queueChanged(listed(("1", "b")), canSteer: true, steered: nil), at: t0)
        state.messageDelivered(b, outcome: .queued, queueID: "1", at: t0)
        #expect(state.pending.map(\.message.text) == ["b"])
        #expect(state.pending.map(\.queueID) == ["1"])
    }

    @Test func aMessageThatLeftTheListWhileThisDeviceWasAwayIsNotLeftWaitingUnseen() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("start", at: t0), outcome: .started, at: t0)
        let away = state.messageSent("taken off elsewhere", at: t0)
        state.apply(.queueChanged(listed(("3", "taken off elsewhere")), canSteer: true, steered: nil), at: t0)
        // Back after a while: the host has nothing waiting, and then the answer comes.
        state.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true, queued: [], canSteerQueued: true))
        state.messageDelivered(away, outcome: .queued, queueID: "3", at: t0)
        #expect(state.pending.isEmpty)
        #expect(state.queued.isEmpty)
    }

    @Test func aDepartureFromBeforeAMessageWasSentIsNotItsOwnHoweverLateItsAnswer() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        state.apply(.queueChanged(listed(("1", "theirs")), canSteer: true, steered: nil), at: t0)
        state.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        // A host started since gives "1" again, and its answer comes before its list.
        let later = t0.addingTimeInterval(10)
        let mine = state.messageSent("mine", at: later)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: later)
        #expect(state.pending.map(\.queueID) == ["1"])
    }

    @Test func aLateAnswerFindsItsMessageAfterASnapshotMadeTheTurnAfresh() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        let file = AttachedFile(filename: "report.pdf", size: 8)
        let next = state.messageSent("next", files: [file], at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "next\n\n\(SentText.filesHeading)\n- /w/report.pdf")], canSteer: true, steered: nil), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("1"), at: t0)
        // A reconnect: the host's history, with items of its own.
        var host = Transcript()
        host.turns = state.transcript.turns.map { turn in
            var copy = turn
            copy.items = turn.items.map { TurnItem($0.content) }
            return copy
        }
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: [], canSteerQueued: true), at: t0)
        state.messageDelivered(next, outcome: .queued, queueID: "1", at: t0)
        #expect(state.pending.isEmpty)
        let opener = state.transcript.turns.last?.items.first
        #expect(opener?.id == next)
        if case let .user(message)? = opener?.content { #expect(message.files.first?.id == file.id) }
    }

    @Test func aLateAnswerAfterASnapshotPutsItsFilesOnNoOtherMessageOfTheSameWords() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        let a = AttachedFile(filename: "a.pdf", size: 1)
        let mine = state.messageSent("", files: [a], at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "\(SentText.filesHeading)\n- /w/a.pdf"), QueuedMessage(id: "2", text: "\(SentText.filesHeading)\n- /w/b.pdf")], canSteer: true, steered: nil), at: t0)
        state.apply(.turnFinished(.completed, finalText: nil), at: t0)
        state.apply(.queuedTurnStarted("1"), at: t0)
        // Another device's message of no words steers into that turn.
        state.apply(.queueChanged([], canSteer: true, steered: "2"), at: t0)
        var host = Transcript()
        host.turns = state.transcript.turns.map { turn in
            var copy = turn
            copy.items = turn.items.map { TurnItem($0.content) }
            return copy
        }
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: [], canSteerQueued: true), at: t0)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        let users = state.transcript.turns.last?.items.compactMap { item -> UserMessage? in
            if case let .user(message) = item.content { message } else { nil }
        } ?? []
        // Two messages of files alone: which is its own cannot be told, and neither changes.
        #expect(state.pending.isEmpty)
        #expect(users.map { $0.files.map(\.filename) } == [["a.pdf"], ["b.pdf"]])
        #expect(state.transcript.turns.last?.items.contains { $0.id == mine } == false)
        #expect(users.allSatisfy { $0.files.first?.id != a.id })
    }

    @Test func aTurnFirstSeenInASnapshotKeepsTheHostsCopyWhenTheLateAnswerComes() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        let file = AttachedFile(filename: "report.pdf", size: 8)
        let next = state.messageSent("next", files: [file], at: t0)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "next\n\n\(SentText.filesHeading)\n- /w/report.pdf")], canSteer: true, steered: nil), at: t0)
        // Away: the first turn ended and the message's own began, as the host now has it.
        var host = state.transcript
        host.turns[0].outcome = .completed
        host.turns[0].endedAt = t0
        host.turns.append(Turn(startedAt: t0, items: [TurnItem(.user(UserMessage(text: "next", sentAt: t0, delivery: .started, files: [AttachedFile(filename: "report.pdf", path: "/w/report.pdf")])))]))
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: [], canSteerQueued: true), at: t0)
        let shown = state.transcript.turns.last?.items.first?.id
        state.messageDelivered(next, outcome: .queued, queueID: "1", at: t0)
        // Taken off the list or begun while away cannot be told apart: dropped, and nothing else.
        #expect(state.pending.isEmpty)
        #expect(state.transcript.turns.last?.items.first?.id == shown)
    }

    /// An earlier turn of the same words and file, then one running, while which this
    /// device queues those words with the file again.
    private func lookalikeHistory(_ old: AttachedFile) -> ThreadState {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("summarize", files: [old], at: t0), outcome: .started, at: t0)
        state.apply(.turnFinished(.interrupted, finalText: nil), at: t0)
        let later = t0.addingTimeInterval(60)
        state.messageDelivered(state.messageSent("busy", at: later), outcome: .started, at: later)
        return state
    }

    @Test func aLateAnswerAfterASnapshotLeavesAnOlderTurnOfTheSameWordsAlone() {
        let old = AttachedFile(filename: "report.pdf", size: 3)
        var state = lookalikeHistory(old)
        let sent = t0.addingTimeInterval(70)
        let new = AttachedFile(filename: "report.pdf", size: 7)
        let mine = state.messageSent("summarize", files: [new], at: sent)
        // The bridge had a report.pdf already: it saved this one as report 2.pdf.
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "summarize\n\n\(SentText.filesHeading)\n- /w/report 2.pdf")], canSteer: true, steered: nil), at: sent)
        let started = t0.addingTimeInterval(80)
        state.apply(.turnFinished(.completed, finalText: nil), at: started)
        state.apply(.queuedTurnStarted("1"), at: started)
        var host = Transcript()
        host.turns = state.transcript.turns.map { turn in
            var copy = turn
            copy.items = turn.items.map { TurnItem($0.content) }
            return copy
        }
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: [], canSteerQueued: true), at: started)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: started)
        guard case let .user(first)? = state.transcript.turns[0].items.first?.content else {
            Issue.record("The first turn has no message")
            return
        }
        #expect(first.files.first?.id == old.id)
        #expect(state.transcript.turns.last?.items.first?.id == mine)
    }

    @Test func aLateAnswerAfterASnapshotLeavesATurnOfTheSameWordsAndFileSentJustBeforeAlone() {
        let old = AttachedFile(filename: "report.pdf", size: 3)
        var state = ThreadState()
        // The same words and file, its turn begun two seconds before this one was sent.
        let before = t0.addingTimeInterval(68)
        state.messageDelivered(state.messageSent("summarize", files: [old], at: before), outcome: .started, at: before)
        let sent = t0.addingTimeInterval(70)
        let new = AttachedFile(filename: "report.pdf", size: 7)
        let mine = state.messageSent("summarize", files: [new], at: sent)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "summarize\n\n\(SentText.filesHeading)\n- /w/report 2.pdf")], canSteer: true, steered: nil), at: sent)
        let started = t0.addingTimeInterval(80)
        state.apply(.turnFinished(.completed, finalText: nil), at: started)
        state.apply(.queuedTurnStarted("1"), at: started)
        var host = Transcript()
        host.turns = state.transcript.turns.map { turn in
            var copy = turn
            copy.items = turn.items.map { TurnItem($0.content) }
            return copy
        }
        state.adopt(ThreadSnapshot(transcript: host, isRunning: true, queued: [], canSteerQueued: true), at: started)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: started)
        guard case let .user(first)? = state.transcript.turns[0].items.first?.content else {
            Issue.record("The first turn has no message")
            return
        }
        #expect(first.files.first?.id == old.id)
        // Two alike so close together: which is its own cannot be told, and neither changes.
        #expect(state.transcript.turns.last?.items.first?.id != mine)
    }

    @Test func aMessageTakenOffTheListLeavesAnOlderTurnOfTheSameWordsAlone() {
        let old = AttachedFile(filename: "report.pdf", size: 3)
        var state = lookalikeHistory(old)
        let sent = t0.addingTimeInterval(70)
        let mine = state.messageSent("summarize", files: [AttachedFile(filename: "report.pdf", size: 7)], at: sent)
        state.apply(.queueChanged([QueuedMessage(id: "1", text: "summarize\n\n\(SentText.filesHeading)\n- /w/report 2.pdf")], canSteer: true, steered: nil), at: sent)
        state.apply(.queueChanged([], canSteer: true, steered: nil), at: sent)
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: sent)
        #expect(state.pending.isEmpty)
        guard case let .user(first)? = state.transcript.turns[0].items.first?.content else {
            Issue.record("The first turn has no message")
            return
        }
        #expect(first.files.first?.id == old.id)
        #expect(state.transcript.turns[0].items.first?.id != mine)
    }

    @Test func aLateAnswerIsSettledHoweverManyOtherMessagesLeftTheListMeanwhile() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("first", at: t0), outcome: .started, at: t0)
        let mine = state.messageSent("mine", at: t0)
        state.apply(.queueChanged(listed(("1", "mine")), canSteer: true, steered: nil), at: t0)
        state.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        for other in 2..<60 {
            state.apply(.queueChanged(listed(("\(other)", "other")), canSteer: true, steered: nil), at: t0)
            state.apply(.queueChanged([], canSteer: true, steered: nil), at: t0)
        }
        state.messageDelivered(mine, outcome: .queued, queueID: "1", at: t0)
        #expect(state.pending.isEmpty)
    }

    @Test func queueIsChosenOnlyOnAHostThatListsWhatWaits() {
        #expect(WhenBusy.queue.on(hostListingQueue: true) == .queue)
        #expect(WhenBusy.queue.on(hostListingQueue: false) == .steer)
        #expect(WhenBusy.queue.on(hostListingQueue: nil) == .steer)
        #expect(WhenBusy.steer.on(hostListingQueue: true) == .steer)
    }

    @Test func aStoredMessageSplitsIntoItsWordsImagesAndFiles() {
        let stored = "look\n\n\(SentText.filesHeading)\n- /w/a.pdf\n- /w/b c.txt\n@image:photo.jpg"
        let parsed = SentText.parse(stored)
        #expect(parsed.text == "look")
        #expect(parsed.files == ["/w/a.pdf", "/w/b c.txt"])
        #expect(parsed.images == ["photo.jpg"])
        #expect(SentText.name(ofPath: "/w/b c.txt") == "b c.txt")
        // The line only counts with a list of paths after it to the end.
        let quoted = "The bridge writes\n\(SentText.filesHeading)\nbefore the paths."
        #expect(SentText.parse(quoted).text == quoted)
        #expect(SentText.parse(quoted).files.isEmpty)
        #expect(SentText.parse("\(SentText.filesHeading)\n- /w/a.pdf") == ("", [], ["/w/a.pdf"]))
    }

    @Test func aMessageOfAttachmentsAloneIsPreviewedByWhatItCarries() {
        let report = AttachedFile(filename: "report.pdf")
        #expect(UserMessage(text: "", files: [report]).preview == "report.pdf")
        #expect(UserMessage(text: "", files: [report, report]).preview == "2 files")
        #expect(UserMessage(text: "", images: [AttachedImage(filename: "a.jpg")], files: [report]).preview == "2 attachments")
        #expect(UserMessage(text: "Summarise this", files: [report]).preview == "Summarise this")
    }

    @Test func aTranscriptSavedBeforeFilesCouldBeSentStillReads() throws {
        let old = #"{"text":"hi","sentAt":0,"images":[]}"#
        let message = try JSONDecoder().decode(UserMessage.self, from: Data(old.utf8))
        #expect(message.files.isEmpty)
        let again = try JSONDecoder().decode(UserMessage.self, from: JSONEncoder().encode(UserMessage(text: "x", files: [AttachedFile(filename: "a.txt", size: 3)])))
        #expect(again.files.map(\.filename) == ["a.txt"])
    }
}
