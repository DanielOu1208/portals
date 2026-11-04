import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct FileUndoWireTests {
    @Test func fileUndoFlagRequiresItsFeatureAndDefaultsFalse() throws {
        let value: JSONValue = ["id": "native", "can_fork": true, "can_edit": true, "can_undo_files": true]
        #expect(BridgeWire.messageCheckpoint(value, features: ["message_fork"])?.canUndoFiles == false)
        #expect(BridgeWire.messageCheckpoint(value, features: ["message_fork", "turn_file_undo"])?.canUndoFiles == true)
        let absent: JSONValue = ["id": "native", "can_fork": true, "can_edit": true]
        #expect(BridgeWire.messageCheckpoint(absent, features: ["turn_file_undo"])?.canUndoFiles == false)
        let message: JSONValue = ["role": "user", "text": "Request", "checkpoint": value]
        let item = try #require(HermesHistoryMapper.opening(message, at: .now, features: ["turn_file_undo"]).first)
        guard case let .user(user) = item.content else { Issue.record("Missing opener"); return }
        #expect(user.checkpoint?.canUndoFiles == true)
        let event = GatewayEvent(type: "message.checkpoint", payload: ["checkpoint": value])
        #expect(HermesEventMapper.threadEvents(for: event, features: ["turn_file_undo"]) == [.messageCheckpoint(try #require(user.checkpoint))])
        #expect(HermesEventMapper.threadEvents(for: event).isEmpty)
    }

    @Test func previewDecodesAllPathsCountsAndUnixExpiry() throws {
        let json: JSONValue = ["preview_id": "review-1", "files": ["src/app.swift", "folder/notes file.txt"],
                               "insertions": 12, "deletions": 4, "expires_at": 2_000]
        let preview = try json.decode(BridgeWire.SessionFilesPreviewResult.self).preview()
        #expect(preview.previewID == "review-1")
        #expect(preview.files == ["src/app.swift", "folder/notes file.txt"])
        #expect(preview.insertions == 12)
        #expect(preview.deletions == 4)
        #expect(preview.expiresAt == Date(timeIntervalSince1970: 2_000))
        let optional: JSONValue = ["preview_id": "empty", "files": [], "expires_at": 2_000]
        let empty = try optional.decode(BridgeWire.SessionFilesPreviewResult.self).preview()
        #expect(empty.insertions == nil && empty.deletions == nil)
        #expect(!empty.canConfirm(at: Date(timeIntervalSince1970: 1_000)))
        let invalid: JSONValue = ["preview_id": "invalid", "files": [""], "insertions": -1, "expires_at": 2_000]
        #expect(throws: TurnFileUndoError.invalidPreview) { try invalid.decode(BridgeWire.SessionFilesPreviewResult.self).preview() }
    }

    @Test func requestsMatchTheBridgeContractAndAlwaysConfirmExplicitly() throws {
        let fixture = try Fixtures.json("contract-subset.json")
        for (method, params) in [
            (BridgeWire.Method.sessionFilesPreview, try JSONValue(encoding: BridgeWire.SessionFilesPreviewParams(sessionID: "stored", checkpointID: "native"))),
            (BridgeWire.Method.sessionFilesUndo, try JSONValue(encoding: BridgeWire.SessionFilesUndoParams(sessionID: "stored", previewID: "preview"))),
        ] {
            let spec = try #require(fixture["bridge"]?["methods"]?[method])
            #expect(spec["feature"]?.stringValue == BridgeWire.Feature.turnFileUndo)
            #expect(Set(try #require(params.objectValue).keys) == Set(try #require(spec["params"]?.arrayValue).compactMap(\.stringValue)))
        }
        let undo = try JSONValue(encoding: BridgeWire.SessionFilesUndoParams(sessionID: "stored", previewID: "preview"))
        #expect(undo == ["session_id": "stored", "preview_id": "preview", "confirmed": true])
    }
}
