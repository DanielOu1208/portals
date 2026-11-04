import AgentCore
import Foundation

extension BridgeWire {
    public struct SessionFilesPreviewParams: Encodable, Sendable {
        public let sessionID: String
        public let checkpointID: String

        public init(sessionID: String, checkpointID: String) {
            self.sessionID = sessionID
            self.checkpointID = checkpointID
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case checkpointID = "checkpoint_id"
        }
    }

    public struct SessionFilesUndoParams: Encodable, Sendable {
        public let sessionID: String
        public let previewID: String
        public let confirmed = true

        public init(sessionID: String, previewID: String) {
            self.sessionID = sessionID
            self.previewID = previewID
        }

        enum CodingKeys: String, CodingKey {
            case sessionID = "session_id"
            case previewID = "preview_id"
            case confirmed
        }
    }

    struct SessionFilesPreviewResult: Decodable, Sendable {
        let previewID: String
        let files: [String]
        let insertions: Int?
        let deletions: Int?
        let expiresAt: Double

        enum CodingKeys: String, CodingKey {
            case previewID = "preview_id"
            case files, insertions, deletions
            case expiresAt = "expires_at"
        }

        func preview() throws -> TurnFileUndoPreview {
            guard !previewID.isEmpty, files.allSatisfy({ !$0.isEmpty }), expiresAt.isFinite,
                  insertions.map({ $0 >= 0 }) ?? true, deletions.map({ $0 >= 0 }) ?? true else { throw TurnFileUndoError.invalidPreview }
            return TurnFileUndoPreview(previewID: previewID, files: files, insertions: insertions, deletions: deletions,
                                       expiresAt: Date(timeIntervalSince1970: expiresAt))
        }
    }

    struct SessionFilesUndoResult: Decodable, Sendable {
        let restored: Bool
        let skippedLinks: Int

        enum CodingKeys: String, CodingKey {
            case restored
            case skippedLinks = "skipped_links"
        }

        func result() throws -> TurnFileUndoResult {
            guard skippedLinks >= 0 else { throw TurnFileUndoError.invalidPreview }
            return TurnFileUndoResult(restored: restored, skippedLinks: skippedLinks)
        }
    }
}
