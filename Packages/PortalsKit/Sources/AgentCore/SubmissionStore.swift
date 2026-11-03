import Foundation

/// A local conversation is not a host thread until creation has returned a real ref.
public struct RecoverableDraft: Identifiable, Hashable, Sendable {
    public var id: UUID
    public var agent: Agent.ID
    public var title: String
    public var preview: String
    public var updatedAt: Date
    public var attachmentCount: Int
    public var workingDirectory: String?
}

/// The exact payload of one outgoing attempt. Its id is also the user TurnItem id
/// and the `message_id` sent to a host that understands it.
public struct SavedSubmission: Codable, Hashable, Sendable {
    public var id: UUID
    public var text: String
    public var message: UserMessage
    public var failure: TurnFailure?
    public var accepted = false
    public var queueID: String?
    /// The attempt this one sends again ("Try again"). Once this one is accepted, that
    /// one, and any it sent again in turn, is settled: its bytes need not be kept.
    public var retries: UUID?
    /// The files the message mentions beside its text (`FileMentionSending`), sent with it
    /// again on "Try again"; nil in submissions saved before mentions were sent.
    public var mentions: [String]?

    public init(id: UUID, text: String, message: UserMessage) {
        self.id = id
        self.text = text
        self.message = message
    }
}

public struct SavedConversation: Codable, Hashable, Sendable, Identifiable {
    public var id: UUID
    public var agent: Agent.ID
    public var options: ThreadOptions
    public var folder: Folder?
    public var thread: ThreadRef?
    /// An explicit mode choice, until the host confirms it, before creation or later.
    /// The original Codable key is kept so earlier journals remain readable.
    /// A failed change must not let a retry or relaunch send under the host's default.
    public var pendingInitialMode: ThreadMode?
    public var transcript = Transcript()
    public var submissions: [SavedSubmission] = []
    public var updatedAt: Date

    public init(id: UUID = UUID(), agent: Agent.ID, options: ThreadOptions = ThreadOptions(), folder: Folder? = nil, updatedAt: Date = .now) {
        self.id = id
        self.agent = agent
        self.options = options
        self.folder = folder
        self.updatedAt = updatedAt
    }

    /// Whether the conversation is offered under Unsent drafts. One bound to a thread in
    /// the list (`listed`) is that thread's, and opens with it. One with a message still
    /// on its way (`sending`) is not unsent, and must not be discarded under the host
    /// that may be running it.
    public func isRecoverableDraft(listed: Set<ThreadRef.ID>, sending: Bool) -> Bool {
        if let thread, listed.contains(thread.id) { return false }
        return !sending
    }

    public var summary: RecoverableDraft {
        let message = submissions.last?.message
        return RecoverableDraft(id: id, agent: agent, title: options.title ?? "Unsent message",
                                preview: message?.preview ?? transcript.preview ?? "Unsent message",
                                updatedAt: updatedAt,
                                attachmentCount: (message?.images.count ?? 0) + (message?.files.count ?? 0),
                                workingDirectory: options.workingDirectory ?? folder?.path)
    }

    /// The host said it took the message with `id` (`ThreadEvent.ownTurnStarted`,
    /// `.ownMessageSteered`): it is settled as its answer would have settled it, also when
    /// that answer was lost and the send failed here. Whether a submission changed.
    @discardableResult
    public mutating func hostTook(_ id: UUID) -> Bool {
        guard let index = submissions.firstIndex(where: { $0.id == id }), !submissions[index].accepted else { return false }
        submissions[index].accepted = true
        submissions[index].failure = nil
        return true
    }

    /// The journal's own transcript, recovered (`recoveredTranscript(onto:)`).
    public var recoveredTranscript: Transcript { recoveredTranscript(onto: nil) }

    /// The conversation as it was left, to show again once the app let go of it or was
    /// ended: `saved`, the thread's own saved copy, for a conversation bound to a host
    /// thread (whose journal keeps no transcript), else the journal's transcript.
    ///
    /// An interrupted RPC is never sent automatically: each message the host never
    /// confirmed is a failed turn, tried again only by hand. One the saved copy has stays
    /// where it is; the others follow everything saved, as they were sent after it, and
    /// come before a run still going on there, which stays last. A message the host
    /// accepted is the host's: it is never offered again (one waiting on the host's list
    /// waits here too, `queuedOnHost`).
    public func recoveredTranscript(onto saved: Transcript?) -> Transcript {
        var result: Transcript
        if let saved, !saved.isEmpty {
            result = saved
        } else {
            result = transcript
            for index in result.turns.indices where result.turns[index].isRunning {
                result.turns[index].outcome = .interrupted
                result.turns[index].endedAt = result.turns[index].startedAt
            }
        }
        let unconfirmed = TurnFailure(message: "Delivery was not confirmed. Check the thread before trying again.")
        let unresolved = submissions.filter { !$0.accepted }
        // A submission saved before the send completed may already be in the
        // saved transcript. It must still be retryable after a process exit.
        for index in result.turns.indices {
            let turn = result.turns[index]
            guard turn.items.allSatisfy(\.isUserMessage),
                  let submission = unresolved.first(where: { submission in turn.items.contains { $0.id == submission.id } })
            else { continue }
            result.turns[index].outcome = .failed(submission.failure ?? unconfirmed)
            result.turns[index].endedAt = turn.endedAt ?? turn.startedAt
        }
        let shown = Set(result.turns.flatMap(\.items).map(\.id))
        let missing = unresolved.filter { !shown.contains($0.id) }.map { submission in
            var message = submission.message
            message.delivery = nil
            return Turn(startedAt: message.sentAt, endedAt: updatedAt, outcome: .failed(submission.failure ?? unconfirmed),
                        items: [TurnItem(id: submission.id, .user(message))])
        }
        let end = result.turns.last?.isRunning == true ? result.turns.count - 1 : result.turns.count
        result.turns.insert(contentsOf: missing, at: end)
        return result
    }

    /// The messages the host accepted onto its list of messages waiting (`queueID`) that
    /// `transcript` does not show yet. They wait as this device's own again: the host's
    /// list says what became of them when the thread is reopened (`ThreadState.adopt`),
    /// and the turn one opens shows it as sent from here.
    public func queuedOnHost(besides transcript: Transcript) -> [PendingMessage] {
        let shown = Set(transcript.turns.flatMap(\.items).map(\.id))
        return submissions.compactMap { submission in
            guard submission.accepted, let queueID = submission.queueID, !shown.contains(submission.id) else { return nil }
            var message = submission.message
            message.delivery = .queued
            return PendingMessage(id: submission.id, message: message, queueID: queueID)
        }
    }

    /// The submissions still worth keeping once the thread's own copy is saved, as it
    /// `shows` them with the messages it has `waiting` (on their way, or on the host's
    /// list):
    /// - one the host accepted, only while it waits on the host's list: once it joined a
    ///   turn, was taken off the list, or the host's copy shows it ran, it is the host's;
    /// - one the host never confirmed, while the thread still shows it to try again or
    ///   has it on its way, and until an attempt sending it again is accepted (`retries`);
    /// - any whose bytes are still being written (`staging`).
    public func unsettled(shows transcript: Transcript, waiting: [PendingMessage], staging: Set<UUID> = []) -> [SavedSubmission] {
        let shown = Set(transcript.turns.flatMap(\.items).map(\.id))
        let waits = Set(waiting.map(\.id))
        // Sent again and taken by the host: every attempt before it is settled.
        let earlier = Dictionary(submissions.map { ($0.id, $0.retries) }, uniquingKeysWith: { first, _ in first })
        var settled = Set<UUID>()
        var next = submissions.filter(\.accepted).compactMap(\.retries)
        while let id = next.popLast() {
            guard settled.insert(id).inserted else { continue }
            if let before = earlier[id] ?? nil { next.append(before) }
        }
        return submissions.filter { submission in
            if staging.contains(submission.id) { return true }
            if settled.contains(submission.id) { return false }
            if submission.accepted { return waits.contains(submission.id) }
            return shown.contains(submission.id) || waits.contains(submission.id)
        }
    }
}

/// Small atomic journals plus separate attachment bytes. Metadata is written
/// before leaving the screen; every byte is on disk before any network submission.
/// Callers serialize mutations of a conversation; this store owns no mutable cache.
public struct SubmissionStore: Sendable {
    public var directory: URL

    public init(directory: URL) { self.directory = directory }
    public init(threads: ThreadStore) { directory = threads.directory.appendingPathComponent("submissions", isDirectory: true) }

    private func folder(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString, isDirectory: true) }

    public func save(_ conversation: SavedConversation) throws {
        let destination = folder(conversation.id)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try JSONEncoder().encode(conversation).write(to: destination.appendingPathComponent("conversation.json"), options: .atomic)
    }

    /// Every journal kept. A folder without one holds bytes nothing can load or remove
    /// any more (staging that lost a race with a removal): it is erased here. Journals
    /// are written on the caller's actor before any of their bytes, so a conversation
    /// being sent always has its journal already.
    public func load() -> [SavedConversation] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return folders.compactMap { url in
            guard UUID(uuidString: url.lastPathComponent) != nil else { return nil }
            let journal = url.appendingPathComponent("conversation.json")
            guard FileManager.default.fileExists(atPath: journal.path) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            guard let data = try? Data(contentsOf: journal) else { return nil }
            return try? JSONDecoder().decode(SavedConversation.self, from: data)
        }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Writes a message's attachment bytes beside its journal, never without it: a
    /// conversation discarded, deleted or forgotten while its bytes were being written
    /// does not get its folder back, with bytes nothing would ever load or remove.
    public func savePayloads(images: [ImageAttachment], files: [FileAttachment], in conversation: UUID) throws {
        let destination = folder(conversation)
        guard FileManager.default.fileExists(atPath: destination.appendingPathComponent("conversation.json").path) else {
            throw CocoaError(.fileNoSuchFile)
        }
        // No folder is created: one removed meanwhile makes the next write fail.
        for image in images { try image.data.write(to: destination.appendingPathComponent(image.id.uuidString), options: .atomic) }
        for file in files { try file.data.write(to: destination.appendingPathComponent(file.id.uuidString), options: .atomic) }
    }

    @concurrent public func savePayloadsInBackground(images: [ImageAttachment], files: [FileAttachment], in conversation: UUID) async throws {
        try savePayloads(images: images, files: files, in: conversation)
    }

    public func image(_ image: AttachedImage, in conversation: UUID) -> ImageAttachment? {
        guard let data = try? Data(contentsOf: folder(conversation).appendingPathComponent(image.id.uuidString)) else { return nil }
        return ImageAttachment(id: image.id, data: data, filename: image.filename)
    }

    public func file(_ file: AttachedFile, in conversation: UUID) -> FileAttachment? {
        guard let data = try? Data(contentsOf: folder(conversation).appendingPathComponent(file.id.uuidString)) else { return nil }
        return FileAttachment(id: file.id, data: data, filename: file.filename)
    }

    /// The bytes of a message's attachments, read off the caller's actor: a message can
    /// carry hundreds of megabytes. Each image from the app's own copy (`copies`), else
    /// from this journal; each file from this journal. What is in neither is left out.
    @concurrent public func attachmentsInBackground(
        images: [AttachedImage], files: [AttachedFile], in conversation: UUID, copies: ThreadStore
    ) async -> (images: [ImageAttachment], files: [FileAttachment]) {
        let images = images.compactMap { image in
            copies.loadImage(image.id).map { ImageAttachment(id: image.id, data: $0, filename: image.filename) }
                ?? self.image(image, in: conversation)
        }
        return (images, files.compactMap { self.file($0, in: conversation) })
    }

    public func remove(_ conversation: UUID) throws {
        let destination = folder(conversation)
        if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
    }

    /// Erases the journals bound to threads that left the list (removed here or on another
    /// device): a deleted thread's messages are not unsent drafts. Each journal goes
    /// with its attachment bytes.
    public func removeConversations(boundTo threads: Set<ThreadKey>) {
        guard !threads.isEmpty else { return }
        for conversation in load() {
            guard let thread = conversation.thread, threads.contains(thread.key) else { continue }
            try? remove(conversation.id)
        }
    }

    /// Called only after the smaller metadata record was committed. A file shared
    /// with an unresolved retry remains referenced and is never removed early.
    public func removeUnusedPayloads(in conversation: SavedConversation) throws {
        let referenced = Set(conversation.submissions.flatMap {
            $0.message.images.map(\.id) + $0.message.files.map(\.id)
        })
        let files = try FileManager.default.contentsOfDirectory(at: folder(conversation.id), includingPropertiesForKeys: nil)
        for file in files {
            if let id = UUID(uuidString: file.lastPathComponent), !referenced.contains(id) {
                try FileManager.default.removeItem(at: file)
            }
        }
    }
}
