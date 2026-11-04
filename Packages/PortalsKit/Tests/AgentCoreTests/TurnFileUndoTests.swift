import Foundation
import Testing
@testable import AgentCore

@Suite struct TurnFileUndoTests {
    private let checkpoint = MessageCheckpoint(id: "native-turn", canFork: true, canEdit: true, canUndoFiles: true)

    private func completed(_ checkpoint: MessageCheckpoint?) -> Turn {
        Turn(outcome: .completed, items: [TurnItem(.user(UserMessage(text: "Change the files", delivery: .started, checkpoint: checkpoint)))])
    }

    @Test func olderSavedCheckpointsDefaultToNoFileUndo() throws {
        let old = try JSONDecoder().decode(MessageCheckpoint.self, from: Data(#"{"id":"native","can_fork":true,"can_edit":true}"#.utf8))
        #expect(!old.canUndoFiles)
        let current = try JSONDecoder().decode(MessageCheckpoint.self, from: JSONEncoder().encode(checkpoint))
        #expect(current.canUndoFiles)
    }

    @Test func onlyTheLatestCompletedProviderTurnCanOfferUndo() {
        let first = completed(checkpoint)
        let second = completed(MessageCheckpoint(id: "newer", canFork: true, canEdit: true, canUndoFiles: true))
        #expect(Transcript(turns: [first]).latestFileUndoTurn?.id == first.id)
        #expect(Transcript(turns: [first, second]).latestFileUndoTurn?.id == second.id)
        #expect(Transcript(turns: [first, completed(nil)]).latestFileUndoTurn == nil)
        for outcome in [TurnOutcome.interrupted, .failed(TurnFailure(message: "Stopped"))] {
            var newer = second
            newer.outcome = outcome
            #expect(Transcript(turns: [first, newer]).latestFileUndoTurn == nil)
        }
        let running = Turn(items: [TurnItem(.user(UserMessage(text: "Running", checkpoint: checkpoint)))])
        #expect(Transcript(turns: [first, running]).latestFileUndoTurn == nil)
        let local = Turn(outcome: .completed, items: [TurnItem(.notice(Notice(.info, "Local note")))])
        #expect(Transcript(turns: [first, local]).latestFileUndoTurn?.id == first.id)
    }

    @Test func aSteerCannotBecomeTheFileUndoOpener() {
        let steer = Turn(outcome: .completed, items: [TurnItem(.user(UserMessage(text: "Also change this", delivery: .steered, checkpoint: checkpoint)))])
        #expect(steer.fileUndoCheckpoint == nil)
        var state = ThreadState()
        state.apply(.turnOpened(by: "Original request"))
        state.apply(.messageSteered("Also change this"))
        state.apply(.messageCheckpoint(checkpoint))
        state.apply(.turnFinished(.completed, finalText: "Done"))
        #expect(state.transcript.latestFileUndoTurn?.fileUndoCheckpoint == checkpoint)
        guard case let .user(steered) = state.transcript.turns[0].items[1].content else { Issue.record("Missing steer"); return }
        #expect(steered.checkpoint == nil)
    }

    @Test func emptyAndExpiredPreviewsCannotBeConfirmed() {
        let now = Date(timeIntervalSince1970: 1_000)
        let empty = TurnFileUndoPreview(previewID: "empty", files: [], expiresAt: now.addingTimeInterval(30))
        let expired = TurnFileUndoPreview(previewID: "expired", files: ["src/app.swift"], expiresAt: now)
        let current = TurnFileUndoPreview(previewID: "current", files: ["src/app.swift"], expiresAt: now.addingTimeInterval(30))
        #expect(!empty.canConfirm(at: now))
        #expect(!expired.canConfirm(at: now))
        #expect(current.canConfirm(at: now))
    }

    @Test func partialOrFailedRestoresNeverReportSuccess() {
        let partial = TurnFileUndoResult(restored: true, skippedLinks: 2)
        #expect(!partial.isComplete)
        #expect(partial.message.contains("incomplete"))
        #expect(partial.message.contains("2"))
        let failed = TurnFileUndoResult(restored: false, skippedLinks: 0)
        #expect(!failed.isComplete)
        #expect(failed.message.contains("could not be confirmed complete"))
        #expect(failed.message.contains("Some files may have changed"))
        #expect(TurnFileUndoResult(restored: true, skippedLinks: 0).isComplete)
    }
}
