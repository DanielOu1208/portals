import AgentCore
import Foundation

struct FileUndoPermit: Sendable {
    let thread: ThreadRef.ID
    let preview: TurnFileUndoPreview
    let peer: JSONRPCPeer
}

extension HermesBackend: TurnFileUndoing {
    public var offersTurnFileUndo: Bool? {
        gatewayReady.map { _ in offers(BridgeWire.Feature.turnFileUndo) }
    }

    public func previewFileUndo(_ thread: ThreadRef, checkpoint: MessageCheckpoint) async throws -> TurnFileUndoPreview {
        guard offers(BridgeWire.Feature.turnFileUndo), !thread.isReadOnly, checkpoint.canUndoFiles,
              !checkpoint.id.isEmpty else { throw TurnFileUndoError.unavailable }
        let original = try peer()
        let answer: BridgeWire.SessionFilesPreviewResult = try await original.call(
            BridgeWire.Method.sessionFilesPreview,
            BridgeWire.SessionFilesPreviewParams(sessionID: thread.id.rawValue, checkpointID: checkpoint.id), timeout: .seconds(30)
        )
        guard (try? peer()) === original else { throw TurnFileUndoError.stalePreview }
        let preview = try answer.preview()
        guard preview.expiresAt > .now else { throw TurnFileUndoError.stalePreview }
        fileUndoPreviews = fileUndoPreviews.filter { $0.value.preview.expiresAt > .now && $0.value.peer === original }
        // A refresh replaces this thread's previous permit. Preview state is bounded even
        // if several screens are reviewed without confirming any of them.
        fileUndoPreviews = fileUndoPreviews.filter { $0.value.thread != thread.id }
        if fileUndoPreviews.count >= 16 { fileUndoPreviews.removeAll() }
        fileUndoPreviews[preview.id] = FileUndoPermit(thread: thread.id, preview: preview, peer: original)
        return preview
    }

    public func undoFiles(_ thread: ThreadRef, preview: TurnFileUndoPreview) async throws -> TurnFileUndoResult {
        guard offers(BridgeWire.Feature.turnFileUndo), !thread.isReadOnly else { throw TurnFileUndoError.unavailable }
        // Consume before the asynchronous call: an error, reconnect, or second click can
        // only lead to a fresh preview and fresh confirmation, never a repeated restore.
        guard let permit = fileUndoPreviews.removeValue(forKey: preview.id), permit.thread == thread.id,
              permit.preview == preview, preview.canConfirm(), (try? peer()) === permit.peer else { throw TurnFileUndoError.stalePreview }
        let answer: BridgeWire.SessionFilesUndoResult
        do {
            answer = try await permit.peer.call(
                BridgeWire.Method.sessionFilesUndo,
                BridgeWire.SessionFilesUndoParams(sessionID: thread.id.rawValue, previewID: preview.previewID), timeout: .seconds(120)
            )
        } catch let error as JSONRPCError where error.code == JSONRPCError.invalidParamsCode && error.data?["reason"]?.stringValue == "files_changed" {
            // Only this host refusal proves that the native restore never began.
            throw TurnFileUndoError.filesChangedBeforeRestore
        }
        guard (try? peer()) === permit.peer else { throw TurnFileUndoError.stalePreview }
        return try answer.result()
    }
}
