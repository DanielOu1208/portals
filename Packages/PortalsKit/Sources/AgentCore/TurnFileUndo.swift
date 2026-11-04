import Foundation

/// An actual host preview, valid only for the connection that fetched it and one undo.
public struct TurnFileUndoPreview: Hashable, Sendable {
    public let id: UUID
    public let previewID: String
    public let files: [String]
    public let insertions: Int?
    public let deletions: Int?
    public let expiresAt: Date

    public init(id: UUID = UUID(), previewID: String, files: [String], insertions: Int? = nil, deletions: Int? = nil, expiresAt: Date) {
        self.id = id
        self.previewID = previewID
        self.files = files
        self.insertions = insertions
        self.deletions = deletions
        self.expiresAt = expiresAt
    }

    public func canConfirm(at now: Date = .now) -> Bool { !files.isEmpty && expiresAt > now }
}

public struct TurnFileUndoResult: Hashable, Sendable {
    public let restored: Bool
    public let skippedLinks: Int

    public init(restored: Bool, skippedLinks: Int) {
        self.restored = restored
        self.skippedLinks = skippedLinks
    }

    public var isComplete: Bool { restored && skippedLinks == 0 }

    public var message: String {
        if skippedLinks > 0 {
            return "The restore was incomplete: the host skipped \(skippedLinks) linked file(s). Review the folder before continuing."
        }
        if !restored { return "The restore could not be confirmed complete. Some files may have changed. Review the folder before continuing." }
        return "Restored the latest turn’s file changes. The conversation is unchanged."
    }
}

public protocol TurnFileUndoing: Sendable {
    var offersTurnFileUndo: Bool? { get async }
    func previewFileUndo(_ thread: ThreadRef, checkpoint: MessageCheckpoint) async throws -> TurnFileUndoPreview
    /// The caller must show the actual preview and receive explicit destructive confirmation.
    func undoFiles(_ thread: ThreadRef, preview: TurnFileUndoPreview) async throws -> TurnFileUndoResult
}

public enum TurnFileUndoError: LocalizedError, Hashable, Sendable {
    case unavailable, busy, stalePreview, invalidPreview

    public var errorDescription: String? {
        switch self {
        case .unavailable: "File undo is unavailable for this turn."
        case .busy: "Wait until this thread and other tools in its folder are idle and connected."
        case .stalePreview: "This preview is no longer valid. Refresh it and review the files again."
        case .invalidPreview: "The host returned an invalid file preview. Refresh it before continuing."
        }
    }
}

extension Turn {
    public var fileUndoCheckpoint: MessageCheckpoint? {
        guard outcome == .completed, let opener = items.first(where: \.isUserMessage),
              case let .user(message) = opener.content, message.delivery != .steered,
              let checkpoint = message.checkpoint, checkpoint.canUndoFiles else { return nil }
        return checkpoint
    }
}

extension Transcript {
    /// A newer running, stopped, or failed turn rules out undoing any older turn.
    public var latestFileUndoTurn: Turn? {
        guard let latest = turns.last(where: { !$0.isLocal }), latest.fileUndoCheckpoint != nil else { return nil }
        return latest
    }
}
