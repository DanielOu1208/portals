import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A message steered into a turn that a Stop took back before the agent read it (a
/// bridge's `steer_withdrawn`): it leaves the turn, and the device that sent it has it back.
@Suite struct SteerWithdrawnWireTests {
    private let features: Set<String> = ["turn_messages", "steer_withdrawn"]
    private let notice = "Stop took back a message before the agent read it, so it was not sent: “Then say banana.”"

    private func withdrawn(_ id: UUID?) -> GatewayEvent {
        let taken: JSONValue = id.map { ["text": "Then say banana.", "message_id": .string($0.uuidString)] } ?? ["text": "Then say banana."]
        return GatewayEvent(type: "status.update", payload: ["kind": "warn", "text": .string(notice), "withdrawn": taken])
    }

    @Test func thisDevicesOwnGoesBackToItsComposerAndAnothersLeavesWithTheNotice() {
        let id = UUID()
        #expect(HermesEventMapper.threadEvents(for: withdrawn(id), features: features, isOwn: { $0 == id.uuidString })
            == [.ownMessageWithdrawn(id, text: "Then say banana.")])
        #expect(HermesEventMapper.threadEvents(for: withdrawn(id), features: features)
            == [.messageWithdrawn("Then say banana.", messageID: id), .notice(Notice(.warning, notice))])
        #expect(HermesEventMapper.threadEvents(for: withdrawn(nil), features: features)
            == [.messageWithdrawn("Then say banana."), .notice(Notice(.warning, notice))])
    }

    @Test func fromAHostWithoutTheFeatureItIsTheNoticeAlone() {
        #expect(HermesEventMapper.threadEvents(for: withdrawn(UUID()), features: ["turn_messages"], isOwn: { _ in true })
            == [.notice(Notice(.warning, notice))])
    }

    @Test func anothersMessageLeavesTheTurnItWasSteeredIn() {
        var state = ThreadState()
        func deliver(_ event: GatewayEvent) {
            for mapped in HermesEventMapper.threadEvents(for: event, features: features) { state.apply(mapped) }
        }
        let id = UUID()
        deliver(GatewayEvent(type: "message.start", payload: ["text": "Count to 25."]))
        deliver(GatewayEvent(type: "message.steered", payload: ["text": "Then say banana."]))
        deliver(GatewayEvent(type: "message.steered", payload: ["text": "Then say banana.", "message_id": .string(id.uuidString)]))
        deliver(withdrawn(id))
        deliver(withdrawn(nil))
        let words = state.transcript.turns.last?.items.compactMap { item -> String? in
            guard case let .user(message) = item.content else { return nil }
            return message.text
        }
        #expect(words == ["Count to 25."])
        #expect(state.isRunning)
    }

    @Test func thisDevicesOwnLeavesTheTurnByItsID() {
        var state = ThreadState()
        state.messageDelivered(state.messageSent("Count to 25."), outcome: .started)
        let steered = state.messageSent("Then say banana.")
        state.messageDelivered(steered, outcome: .steered)
        #expect(state.transcript.turns.last?.items.contains { $0.id == steered } == true)
        state.apply(.ownMessageWithdrawn(steered, text: "Then say banana."))
        #expect(state.transcript.turns.last?.items.contains { $0.id == steered } == false)
        #expect(state.transcript.turns.count == 1)
    }

    @Test func oneShownAsATurnOfItsOwnAfterAResumeGoesWithThatTurnWhenNothingElseIsInIt() {
        var state = ThreadState()
        let messages: [JSONValue] = [
            ["role": "user", "text": "Count to 25.", "timestamp": 1],
            ["role": "assistant", "text": "1, 2, 3", "timestamp": 2],
            ["role": "user", "text": "Then say banana.", "timestamp": 3, "display_kind": "steer"],
            ["role": "user", "text": "And then stop.", "timestamp": 4],
        ]
        state.apply(.snapshot(ThreadSnapshot(transcript: HermesHistoryMapper.transcript(from: messages, features: features), isRunning: false)))
        #expect(state.transcript.turns.count == 3)
        state.apply(.messageWithdrawn("Then say banana."))
        #expect(state.transcript.turns.count == 2)
        #expect(state.turnOrigin == 1)
    }
}
