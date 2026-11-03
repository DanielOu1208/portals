import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct QueuePlacementWireTests {
    @Test func placementMapsInEventsAndLegacyEntriesStayUnchanged() {
        let rows: JSONValue = [
            ["id": "sdk", "text": "Keep the fix small", "placement": "steer"],
            ["id": "later", "text": "Then update docs", "placement": "queue"],
            ["id": "legacy", "text": "Legacy"], ["id": "future", "text": "Unknown", "placement": "later"],
        ]
        let messages = BridgeWire.queuedMessages(rows)
        #expect(messages.map(\.placement) == [.steer, .queue, nil, nil])
        let events = HermesEventMapper.threadEvents(
            for: GatewayEvent(type: "queue.changed", payload: ["queued": rows]),
            features: [BridgeWire.Feature.queue]
        )
        #expect(events == [.queueChanged(messages, canSteer: false, steered: nil)])
    }

    /// The id a message's device gave it, read from a host with `message_ids` only.
    @Test func aListedMessageCarriesItsDevicesIDFromAHostThatSaysSo() {
        let id = UUID()
        let rows: JSONValue = [["id": "1", "text": "mine", "message_id": .string(id.uuidString)], ["id": "2", "text": "odd", "message_id": "not-a-uuid"]]
        #expect(BridgeWire.queuedMessages(rows, features: [BridgeWire.Feature.messageIDs]).map(\.messageID) == [id, nil])
        #expect(BridgeWire.queuedMessages(rows).map(\.messageID) == [nil, nil])
    }

    @Test func placementUsesTheExactQueueIDAndOldActionsSendNoNewKey() throws {
        let moving = BridgeWire.QueueItemParams(sessionID: "s", queueID: "sdk-id", profile: "droid", placement: .steer)
        #expect(try JSONValue(encoding: moving) == [
            "session_id": "s", "queue_id": "sdk-id", "profile": "droid", "placement": "steer",
        ])
        let old = try JSONValue(encoding: BridgeWire.QueueItemParams(sessionID: "s", queueID: "sdk-id", profile: nil))
        #expect(old == ["session_id": "s", "queue_id": "sdk-id"])
    }
}
