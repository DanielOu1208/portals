import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct MessageReconciliationTests {
    private let features: Set<String> = ["message_reconciliation", "turn_messages"]

    @Test func aLateReceiptRemovesOnlyItsFailedRequestWithoutReplacingTheRunningTurn() {
        var state = ThreadState()
        func deliver(_ type: String, _ payload: JSONValue) {
            for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: type, payload: payload), features: features) {
                state.apply(event)
            }
        }
        for id in ["one", "two"] {
            deliver("message.start", ["text": "same words"])
            deliver("message.complete", ["status": "error", "error": "No receipt.", "failed_request_id": .string(id)])
        }
        deliver("message.start", [:])
        deliver("message.delta", ["text": "Already answering background work."])
        let runningID = state.transcript.turns.last?.id
        let runningItems = state.transcript.turns.last?.items
        deliver("message.taken", ["request_id": "one"])
        #expect(state.transcript.turns.count == 2)
        #expect(state.transcript.turns.last?.id == runningID)
        #expect(state.transcript.turns.last?.items == runningItems)
        #expect(state.isRunning)
        deliver("message.taken", ["request_id": "unknown"])
        #expect(state.transcript.turns.count == 2)
        let messageID = UUID()
        deliver("message.steered", ["text": "same words", "message_id": .string(messageID.uuidString), "reconciled": true])
        #expect(state.transcript.turns.last?.id == runningID)
        #expect(state.transcript.turns.last?.items.last?.id == messageID)
        deliver("message.taken", ["request_id": "two"])
        #expect(state.transcript.turns.count == 1)
        #expect(state.transcript.turns.first?.id == runningID)
    }

    @Test(arguments: [0, TranscriptBlocks.size / 2])
    func removingAFailedTurnKeepsTheRunningTurnsBlockIdentity(failedIndex: Int) {
        var state = ThreadState()
        func deliver(_ type: String, _ payload: JSONValue) {
            for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: type, payload: payload), features: features) {
                state.apply(event)
            }
        }
        let historyCount = TranscriptBlocks.size * 2
        for index in 0..<historyCount {
            deliver("message.start", ["text": .string("Question \(index)")])
            if index == failedIndex {
                deliver("message.complete", ["status": "error", "error": "No receipt.", "failed_request_id": "one"])
            } else {
                deliver("message.complete", ["status": "complete"])
            }
        }
        deliver("message.start", [:])
        deliver("message.delta", ["text": "Still answering."])
        let runningID = state.transcript.turns.last?.id
        let runningItems = state.transcript.turns.last?.items
        let before = TranscriptBlocks.ranges(count: state.transcript.turns.count, origin: state.turnOrigin).last?.index

        deliver("message.taken", ["request_id": "one"])

        #expect(state.turnOrigin == 1)
        let blocks = TranscriptBlocks.ranges(count: state.transcript.turns.count, origin: state.turnOrigin)
        #expect(blocks.last?.index == before)
        #expect(state.transcript.turns.last?.id == runningID)
        #expect(state.transcript.turns.last?.items == runningItems)
        #expect(state.isRunning)
        let rendered = blocks.flatMap { Array(state.transcript.turns[$0.turns]) }
        #expect(rendered.map(\.id) == state.transcript.turns.map(\.id))
        let earlier = rendered.dropLast().flatMap(\.items).compactMap { item -> String? in
            guard case let .user(message) = item.content else { return nil }
            return message.text
        }
        #expect(earlier == (0..<historyCount).filter { $0 != failedIndex }.map { "Question \($0)" })
    }

    @Test func oldBridgesDoNotEnableReconciliationAndUnknownEventsStayHarmless() throws {
        #expect(HermesEventMapper.threadEvents(for: GatewayEvent(type: "message.taken", payload: ["request_id": "one"])).isEmpty)
        let old = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: []))
        #expect(old["message_reconciliation"] == nil)
        let current = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: features))
        #expect(current["message_reconciliation"]?.boolValue == true)
    }

    @Test func storedFailuresKeepOnlyTheirExactRequestWhenTheHostOffersReconciliation() {
        let messages: [JSONValue] = [
            ["role": "user", "text": "same words", "timestamp": 1],
            ["role": "assistant", "text": "No receipt.", "timestamp": 1, "display_kind": "failed_turn",
             "display_metadata": ["failed_request_id": "one"]],
        ]
        let current = HermesHistoryMapper.transcript(from: messages, features: features)
        #expect(current.turns.first?.failedRequestID == "one")
        #expect(HermesHistoryMapper.transcript(from: messages).turns.first?.failedRequestID == nil)
        var state = ThreadState()
        state.apply(.snapshot(ThreadSnapshot(transcript: current, isRunning: false)))
        for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: "message.taken", payload: ["request_id": "one"]), features: features) {
            state.apply(event)
        }
        #expect(state.transcript.turns.isEmpty)
    }
}
