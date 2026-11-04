import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct MessageForkTests {
    private let features: Set<String> = ["message_fork", "turn_messages"]
    private let checkpoint: JSONValue = ["id": "provider/opaque:turn-4", "can_fork": true, "can_edit": false]

    @Test func storedCheckpointIsOptionalAndUsesExplicitPermissions() throws {
        let legacy = try JSONDecoder().decode(UserMessage.self, from: Data(#"{"text":"Older message","sentAt":0}"#.utf8))
        #expect(legacy.checkpoint == nil)
        let message: JSONValue = ["role": "user", "text": "Review this", "timestamp": 1, "checkpoint": checkpoint]
        let opening = try #require(HermesHistoryMapper.opening(message, at: .now, features: features).first)
        guard case let .user(user) = opening.content else { Issue.record("Missing user message"); return }
        #expect(user.checkpoint == MessageCheckpoint(id: "provider/opaque:turn-4", canFork: true, canEdit: false))
        let saved = try JSONEncoder().encode(user)
        #expect(try JSONDecoder().decode(UserMessage.self, from: saved).checkpoint == user.checkpoint)
        #expect(BridgeWire.messageCheckpoint(["id": "turn-4", "can_fork": true]) == nil)
        #expect(BridgeWire.messageCheckpoint(["id": "", "can_fork": true, "can_edit": true]) == nil)
    }

    @Test func aCheckpointUpdatesTheCurrentOpenerAfterOtherMessagesSteerIt() throws {
        var state = ThreadState()
        func deliver(_ type: String, _ payload: JSONValue) {
            for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: type, payload: payload), features: features) {
                state.apply(event)
            }
        }
        deliver("message.start", ["text": "Original request"])
        deliver("message.complete", ["status": "complete"])
        let own = state.messageSent("Next request")
        state.apply(.ownTurnStarted(own))
        deliver("message.steered", ["text": "Also add a test"])
        deliver("message.checkpoint", ["checkpoint": checkpoint])
        state.messageDelivered(own, outcome: .started)
        let turns = state.transcript.turns
        guard case let .user(previous) = turns[0].items[0].content,
              case let .user(opener) = turns[1].items[0].content,
              case let .user(steer) = turns[1].items[1].content else { Issue.record("Missing user messages"); return }
        #expect(previous.checkpoint == nil)
        #expect(opener.checkpoint?.id == "provider/opaque:turn-4")
        #expect(opener.checkpoint?.canFork == true)
        #expect(opener.checkpoint?.canEdit == false)
        #expect(steer.checkpoint == nil)
        #expect(turns[1].items[0].id == own)
        deliver("message.complete", ["status": "complete"])
        let ended = state.transcript
        deliver("message.checkpoint", ["checkpoint": ["id": "late", "can_fork": true, "can_edit": true]])
        #expect(state.transcript == ended)
    }

    @Test func olderHostsAndStoredSteersNeverGrantMessageActions() throws {
        let event = GatewayEvent(type: "message.checkpoint", payload: ["checkpoint": checkpoint])
        #expect(HermesEventMapper.threadEvents(for: event).isEmpty)
        let malformed = GatewayEvent(type: "message.checkpoint", payload: ["checkpoint": ["id": "turn-4", "can_fork": true]])
        #expect(HermesEventMapper.threadEvents(for: malformed, features: features).isEmpty)
        for (offered, kind) in [(Set<String>(), ""), (features, "steer")] {
            let message: JSONValue = ["role": "user", "text": "Request", "display_kind": .string(kind.isEmpty ? "skill_invocation" : kind), "checkpoint": checkpoint]
            let item = try #require(HermesHistoryMapper.opening(message, at: .now, features: offered).first)
            guard case let .user(user) = item.content else { Issue.record("Missing user message"); return }
            #expect(user.checkpoint == nil)
        }
    }

    @Test func reconnectRefreshesCheckpointPermissionsEvenWhenTheCachedReplyAgrees() throws {
        let messages: [JSONValue] = [
            ["role": "user", "text": "Request", "timestamp": 1],
            ["role": "assistant", "text": "Answer", "timestamp": 2],
        ]
        var hostMessages = messages
        hostMessages[0] = ["role": "user", "text": "Request", "timestamp": 1, "checkpoint": checkpoint]
        let cached = HermesHistoryMapper.transcript(from: messages, features: features)
        let host = HermesHistoryMapper.transcript(from: hostMessages, features: features)
        var state = ThreadState(transcript: cached)
        state.apply(.snapshot(ThreadSnapshot(transcript: host, isRunning: false)))
        guard case let .user(user) = state.transcript.turns[0].items[0].content else { Issue.record("Missing opener"); return }
        #expect(user.checkpoint?.id == "provider/opaque:turn-4")
        #expect(state.transcript.turns[0].id == cached.turns[0].id)
    }
}
