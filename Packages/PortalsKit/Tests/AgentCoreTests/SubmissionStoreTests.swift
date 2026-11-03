import Foundation
import Testing
@testable import AgentCore

@Suite struct SubmissionStoreTests {
    @Test func anInitialModeIsOptionalInOlderJournals() throws {
        let original = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        let oldData = try JSONEncoder().encode(original)
        let oldObject = try #require(JSONSerialization.jsonObject(with: oldData) as? [String: Any])
        #expect(oldObject["pendingInitialMode"] == nil)
        let old = try JSONDecoder().decode(SavedConversation.self, from: oldData)
        #expect(old.pendingInitialMode == nil)
        var waiting = original
        waiting.pendingInitialMode = .ask
        let saved = try JSONEncoder().encode(waiting)
        #expect(try JSONDecoder().decode(SavedConversation.self, from: saved).pendingInitialMode == .ask)
        // An older Codable reader ignores the additional key.
        struct OldReader: Decodable { var id: UUID; var agent: Agent.ID; var options: ThreadOptions }
        #expect(try JSONDecoder().decode(OldReader.self, from: saved).id == original.id)
    }

    @Test func forgettingAHostRemovesOnlyItsUnsentPayloads() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let threads = ThreadStore(directory: directory)
        let store = SubmissionStore(threads: threads)
        let one = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "one"), name: "agent"))
        let two = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "two"), name: "agent"))
        try store.save(one)
        try store.save(two)
        threads.forgetHost(one.agent.host)
        #expect(store.load() == [two])
    }

    @Test func payloadCleanupKeepsBytesSharedWithAnUnresolvedRetry() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let shared = FileAttachment(data: Data([1]), filename: "keep.txt")
        let accepted = FileAttachment(data: Data([2]), filename: "remove.txt")
        var draft = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        draft.submissions = [SavedSubmission(id: UUID(), text: "retry", message: UserMessage(text: "retry", files: [shared.reference]))]
        try store.save(draft)
        try store.savePayloads(images: [], files: [shared, accepted], in: draft.id)
        try store.removeUnusedPayloads(in: draft)
        #expect(store.file(shared.reference, in: draft.id)?.data == shared.data)
        #expect(store.file(accepted.reference, in: draft.id) == nil)
    }
    @Test func anUnboundSubmissionSurvivesWithItsIdentityAndAttachments() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let image = ImageAttachment(data: Data([1, 2]), filename: "photo.jpg")
        let file = FileAttachment(data: Data([3, 4]), filename: "notes.txt")
        let item = UUID()
        var draft = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "phone"), name: "agent"))
        draft.submissions = [SavedSubmission(id: item, text: "keep this", message: UserMessage(text: "keep this", images: [image.reference], files: [file.reference]))]
        try store.save(draft)
        try store.savePayloads(images: [image], files: [file], in: draft.id)
        let loaded = try #require(store.load().first)
        #expect(loaded.thread == nil)
        #expect(loaded.submissions.first?.id == item)
        #expect(loaded.recoveredTranscript.turns.first?.items.first?.id == item)
        #expect(store.image(image.reference, in: draft.id)?.data == image.data)
        #expect(store.file(file.reference, in: draft.id)?.data == file.data)
    }

    private static func finished(_ text: String) -> Turn {
        Turn(outcome: .completed, items: [TurnItem(.user(UserMessage(text: text, delivery: .started))), TurnItem(.text("answer"))])
    }

    private static func texts(_ transcript: Transcript) -> [String] {
        transcript.turns.flatMap(\.items).compactMap { if case let .user(message) = $0.content { message.text } else { nil } }
    }

    private static func submission(_ text: String, accepted: Bool = false, queueID: String? = nil) -> SavedSubmission {
        var submission = SavedSubmission(id: UUID(), text: text, message: UserMessage(text: text))
        submission.accepted = accepted
        submission.queueID = queueID
        return submission
    }

    /// The journal of a thread on the host keeps no transcript. What it never sent goes
    /// after the thread's saved copy, where it was sent, never above every saved turn.
    @Test func unconfirmedMessagesAreRecoveredAfterTheSavedThread() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        var journal = SavedConversation(agent: agent)
        journal.thread = ThreadRef(id: .init(rawValue: "t"), agent: agent)
        let held = Self.submission("held while reopening"), steering = Self.submission("waiting to steer")
        journal.submissions = [held, steering]
        let recovered = journal.recoveredTranscript(onto: Transcript(turns: [Self.finished("one"), Self.finished("two")]))
        #expect(Self.texts(recovered) == ["one", "two", "held while reopening", "waiting to steer"])
        #expect(recovered.turns.suffix(2).allSatisfy { if case .failed = $0.outcome { true } else { false } })
        #expect(recovered.turns.suffix(2).map { $0.items.first?.id } == [held.id, steering.id])
    }

    @Test func anUnconfirmedMessageIsRecoveredBeforeARunStillGoingOn() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        var journal = SavedConversation(agent: agent)
        journal.thread = ThreadRef(id: .init(rawValue: "t"), agent: agent)
        journal.submissions = [Self.submission("sent during the run")]
        let running = Turn(items: [TurnItem(.user(UserMessage(text: "the run", delivery: .started))), TurnItem(.text("working"))])
        let recovered = journal.recoveredTranscript(onto: Transcript(turns: [Self.finished("one"), running]))
        #expect(Self.texts(recovered) == ["one", "sent during the run", "the run"])
        #expect(recovered.turns.last?.isRunning == true)
    }

    /// A message the host took (queued, say) is the host's: it is not relabelled as not
    /// confirmed, to be sent twice. One waiting on the host's list waits here again.
    @Test func anAcceptedMessageIsNeverRecoveredAsAFailedTurn() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        var journal = SavedConversation(agent: agent)
        journal.thread = ThreadRef(id: .init(rawValue: "t"), agent: agent)
        let queued = Self.submission("do X next", accepted: true, queueID: "q1")
        let steered = Self.submission("also this", accepted: true)
        journal.submissions = [queued, steered]
        let recovered = journal.recoveredTranscript(onto: Transcript(turns: [Self.finished("one")]))
        #expect(Self.texts(recovered) == ["one"])
        let waiting = journal.queuedOnHost(besides: recovered)
        #expect(waiting.map(\.id) == [queued.id])
        #expect(waiting.first?.queueID == "q1")
        #expect(waiting.first?.message.delivery == .queued)
    }

    /// The host's word that it took a message of this device's (it began the message's
    /// run, or handed it to the run going on) settles it, as its answer would have, also
    /// when that answer was lost and the send failed here: its payload is not kept, and the
    /// app, ended before the run said anything, does not recover it as a failed turn to be
    /// sent again.
    @Test func aMessageTheHostSaidItTookIsSettledThoughItsAnswerWasLost() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        var journal = SavedConversation(agent: agent)
        journal.thread = ThreadRef(id: .init(rawValue: "t"), agent: agent)
        var lost = Self.submission("mine")
        lost.failure = TurnFailure(message: "The connection closed.")
        journal.submissions = [lost]
        // Its run, as the thread shows it: begun, nothing said yet.
        let shows = Transcript(turns: [Self.finished("one"), Turn(items: [TurnItem(id: lost.id, .user(lost.message))])])
        let took = journal.hostTook(lost.id)
        #expect(took)
        #expect(journal.unsettled(shows: shows, waiting: []).isEmpty)
        #expect(!journal.recoveredTranscript(onto: shows).turns.contains { if case .failed = $0.outcome { true } else { false } })
        // Once is enough.
        let again = journal.hostTook(lost.id), unknown = journal.hostTook(UUID())
        #expect(!again && !unknown)
    }

    @Test func anAcceptedMessageIsKeptOnlyWhileItWaitsOnTheHostsList() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        var journal = SavedConversation(agent: agent)
        let queued = Self.submission("do X next", accepted: true, queueID: "q1")
        let failed = Self.submission("never confirmed")
        journal.submissions = [queued, failed]
        let failedTurn = Turn(outcome: .failed(TurnFailure(message: "offline")), items: [TurnItem(id: failed.id, .user(failed.message))])
        let shows = Transcript(turns: [Self.finished("one"), failedTurn])
        let waiting = journal.queuedOnHost(besides: shows)
        #expect(journal.unsettled(shows: shows, waiting: waiting).map(\.id) == [queued.id, failed.id])
        // Taken off the host's list, or run there under the host's own id.
        #expect(journal.unsettled(shows: shows, waiting: []).map(\.id) == [failed.id])
        // Gone from the thread altogether: nothing is left to try again.
        #expect(journal.unsettled(shows: Transcript(turns: [Self.finished("one")]), waiting: []).isEmpty)
        // Unless its bytes are still being written.
        #expect(journal.unsettled(shows: Transcript(), waiting: [], staging: [failed.id]).map(\.id) == [failed.id])
    }

    /// Try again failed, then succeeded: the failed attempts (and their attachment bytes)
    /// are settled once the one sending them again is accepted, not kept for as long as
    /// the thread lasts.
    @Test func failedAttemptsAreSettledOnceAnAttemptSendingThemAgainIsAccepted() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        let file = AttachedFile(filename: "big.bin")
        func attempt(retrying earlier: SavedSubmission?) -> SavedSubmission {
            var submission = SavedSubmission(id: UUID(), text: "with a file", message: UserMessage(text: "with a file", files: [file]))
            submission.failure = TurnFailure(message: "offline")
            submission.retries = earlier?.id
            return submission
        }
        let first = attempt(retrying: nil), second = attempt(retrying: first)
        var third = attempt(retrying: second)
        third.failure = nil
        var journal = SavedConversation(agent: agent)
        journal.submissions = [first, second, third]
        let shows = Transcript(turns: [first, second, third].map { submission in
            Turn(outcome: .failed(TurnFailure(message: "offline")), items: [TurnItem(id: submission.id, .user(submission.message))])
        })
        // Still on its way: every attempt is kept.
        #expect(journal.unsettled(shows: shows, waiting: []).count == 3)
        journal.submissions[2].accepted = true
        #expect(journal.unsettled(shows: shows, waiting: []).isEmpty)
        // Its retry failed too: nothing is settled.
        journal.submissions[2].accepted = false
        journal.submissions[2].failure = TurnFailure(message: "offline")
        #expect(journal.unsettled(shows: shows, waiting: []).count == 3)
    }

    @Test func aRetryLinkSurvivesTheJournalAndAnOldJournalStillLoads() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        var journal = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        var retry = Self.submission("again")
        retry.retries = UUID()
        journal.submissions = [Self.submission("first"), retry]
        try store.save(journal)
        #expect(store.load() == [journal])
        // Written before attempts named what they retried.
        let old = #"{"id":"5A1E5B5C-0D0B-4C61-9E39-1F6C0B5A6E11","text":"t","message":{"text":"t","sentAt":0,"images":[],"files":[]},"accepted":false}"#
        let decoded = try JSONDecoder().decode(SavedSubmission.self, from: Data(old.utf8))
        #expect(decoded.retries == nil)
    }

    @Test func attachmentsForARetryAreReadFromTheCopiesThenTheJournal() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let threads = ThreadStore(directory: directory)
        let store = SubmissionStore(threads: threads)
        let copied = ImageAttachment(data: Data([1]), filename: "copied.jpg"), journalled = ImageAttachment(data: Data([2]), filename: "kept.jpg")
        let file = FileAttachment(data: Data([3]), filename: "notes.txt"), gone = AttachedFile(filename: "gone.txt")
        let draft = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        try store.save(draft)
        threads.saveImage(copied.data, id: copied.id)
        try store.savePayloads(images: [journalled], files: [file], in: draft.id)
        let read = await store.attachmentsInBackground(
            images: [copied.reference, journalled.reference], files: [file.reference, gone], in: draft.id, copies: threads
        )
        #expect(read.images == [copied, journalled])
        #expect(read.files == [file])
    }

    @Test func aConversationIsAnUnsentDraftOnlyOffTheListAndNotWhileItsMessageIsOnItsWay() {
        let agent = Agent.ID(host: HostID(rawValue: "host"), name: "agent")
        let unbound = SavedConversation(agent: agent)
        #expect(unbound.isRecoverableDraft(listed: [], sending: false))
        // Its first message is being created on the host: not unsent, not to discard.
        #expect(!unbound.isRecoverableDraft(listed: [], sending: true))
        var bound = SavedConversation(agent: agent)
        bound.thread = ThreadRef(id: .init(rawValue: "t"), agent: agent)
        #expect(!bound.isRecoverableDraft(listed: [.init(rawValue: "t")], sending: false))
        // Created on the host, but the list never got to keep it (the app was ended).
        #expect(bound.isRecoverableDraft(listed: [], sending: false))
    }

    @Test func journalsBoundToRemovedThreadsGoWithTheirBytes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let mac = Agent.ID(host: HostID(rawValue: "mac"), name: "agent"), mini = Agent.ID(host: HostID(rawValue: "mini"), name: "agent")
        var gone = SavedConversation(agent: mac), sameIDElsewhere = SavedConversation(agent: mini)
        gone.thread = ThreadRef(id: .init(rawValue: "t"), agent: mac)
        sameIDElsewhere.thread = ThreadRef(id: .init(rawValue: "t"), agent: mini)
        let unbound = SavedConversation(agent: mac)
        let file = FileAttachment(data: Data([9]), filename: "big.bin")
        for conversation in [gone, sameIDElsewhere, unbound] { try store.save(conversation) }
        try store.savePayloads(images: [], files: [file], in: gone.id)
        store.removeConversations(boundTo: [ThreadKey(host: mac.host, id: .init(rawValue: "t"))])
        #expect(Set(store.load().map(\.id)) == [sameIDElsewhere.id, unbound.id])
        #expect(store.file(file.reference, in: gone.id) == nil)
    }

    @Test func stagingThatFinishesAfterRemovalDoesNotRecreateTheFolder() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let file = FileAttachment(data: Data([7]), filename: "late.bin")
        let draft = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        try store.save(draft)
        // Discarded (or its thread deleted, or its host removed) while the bytes were on their way.
        try store.remove(draft.id)
        #expect(throws: (any Error).self) {
            try store.savePayloads(images: [], files: [file], in: draft.id)
        }
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent(draft.id.uuidString).path))
    }

    @Test func loadErasesBytesLeftWithoutAJournal() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let kept = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        try store.save(kept)
        let orphan = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: orphan, withIntermediateDirectories: true)
        try Data(repeating: 1, count: 64).write(to: orphan.appendingPathComponent(UUID().uuidString))
        #expect(store.load() == [kept])
        #expect(!FileManager.default.fileExists(atPath: orphan.path))
    }

    @Test func aFailedWriteDoesNotEraseThePreviousJournal() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SubmissionStore(directory: directory)
        let draft = SavedConversation(agent: Agent.ID(host: HostID(rawValue: "host"), name: "agent"))
        try store.save(draft)
        let blocked = directory.appendingPathComponent("blocked")
        try Data([0]).write(to: blocked)
        #expect(throws: (any Error).self) {
            try SubmissionStore(directory: blocked).save(draft)
        }
        #expect(store.load() == [draft])
    }
}
