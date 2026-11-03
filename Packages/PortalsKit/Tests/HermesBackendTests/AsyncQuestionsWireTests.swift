import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// A bridge's `async_questions`: questions an agent asks without waiting (Codex's) are a
/// `clarify` with `async`, whose card stays open past the turn's end.
@Suite struct AsyncQuestionsWireTests {
    private static let clarify: JSONValue = [
        "session_id": "s1", "async": true,
        "questions": [["qid": "q0", "question": "Which colour should the README heading use?", "choices": ["Red", "Green", "Blue"], "multi_select": false]],
    ]

    private static let approvalRequest = """
    {"id":"approval-1","method":"approval","params":{"command":"npm test"}}
    """

    private static let asyncClarifyRequest = """
    {"id":"srq-1","method":"clarify","params":{"session_id":"s1","async":true,"questions":[{"qid":"q0","question":"Which colour should the README heading use?","choices":["Red","Green","Blue"],"multi_select":false}]}}
    """

    private static let plainClarifyRequest = """
    {"id":"srq-1","method":"clarify","params":{"session_id":"s1","questions":[{"qid":"q0","question":"Which colour should the README heading use?","choices":["Red","Green","Blue"],"multi_select":false}]}}
    """

    private static func resume(running: Bool, openRequests: String) throws -> HermesWire.SessionResumeResult {
        let json = """
        {"session_id":"s1","running":\(running),"messages":[{"role":"user","text":"Make a README","timestamp":1}],"open_requests":[\(openRequests)]}
        """
        return try JSONDecoder().decode(HermesWire.SessionResumeResult.self, from: Data(json.utf8))
    }

    @Test func aQuestionAskedWithoutWaitingOutlivesItsTurnFromABridgeThatSaysSo() throws {
        let asked = try #require(HermesEventMapper.pendingRequest(ServerRequest(id: "r1", method: "clarify", params: Self.clarify), features: [BridgeWire.Feature.asyncQuestions]))
        #expect(asked.askedAhead == true)
        #expect(asked.outlivesTurn)
        guard case let .clarify(questions) = asked.kind else { Issue.record("not a question"); return }
        #expect(questions.map(\.choices) == [["Red", "Green", "Blue"]])
        // `async` is not read without the feature.
        let before = try #require(HermesEventMapper.pendingRequest(ServerRequest(id: "r1", method: "clarify", params: Self.clarify), features: []))
        #expect(before.askedAhead == nil)
        #expect(!before.outlivesTurn)
    }

    @Test func aResumedSnapshotListsAnAskedCardOnceHoweverOftenTheHostListsIt() throws {
        let resumed = try Self.resume(
            running: true,
            openRequests: [Self.approvalRequest, Self.approvalRequest, Self.asyncClarifyRequest, Self.asyncClarifyRequest].joined(separator: ",")
        )
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: [BridgeWire.Feature.asyncQuestions])
        #expect(snapshot.openRequests.map(\.id) == ["approval-1", "srq-1"])

        var state = ThreadState()
        state.adopt(snapshot, at: Date(timeIntervalSince1970: 10))
        #expect(state.openRequests.map(\.id) == ["approval-1", "srq-1"])

        state.requestAnswered("srq-1", with: .clarify(["q0": "Blue"]), at: Date(timeIntervalSince1970: 11))
        #expect(state.openRequests.map(\.id) == ["approval-1"])
        let requests = state.transcript.turns.flatMap(\.items).filter { item in
            if case .request = item.content { true } else { false }
        }
        #expect(requests.count == 1)
    }

    @Test func aFilteredOutDuplicateDoesNotHideTheOneThatOutlivesItsTurn() throws {
        let resumed = try Self.resume(
            running: false,
            openRequests: [Self.plainClarifyRequest, Self.asyncClarifyRequest].joined(separator: ",")
        )
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: [BridgeWire.Feature.asyncQuestions])
        #expect(snapshot.openRequests.map(\.id) == ["srq-1"])
        #expect(snapshot.openRequests.first?.askedAhead == true)

        var state = ThreadState()
        state.adopt(snapshot, at: Date(timeIntervalSince1970: 10))
        #expect(state.openRequests.map(\.id) == ["srq-1"])
        #expect(state.openRequests.first?.askedAhead == true)
    }

    @Test func theAppSaysItKeepsSuchCardsOnlyToABridgeThatListsTheFeature() throws {
        let told = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: [BridgeWire.Feature.asyncQuestions]))
        #expect(told["async_questions"] == true)
        let older = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: [BridgeWire.Feature.subagents]))
        #expect(older["async_questions"] == nil)
    }

    @Test func aCardAMessageAnsweredSaysSo() {
        let replied = GatewayEvent(type: "request.cancel", sessionID: "s1", payload: ["id": "srq-1", "reason": "replied"])
        #expect(HermesEventMapper.threadEvents(for: replied, features: [BridgeWire.Feature.asyncQuestions]) == [.requestClosed(id: "srq-1", reason: "Answered in your message")])
    }

    @Test func theirRowReadsBackAsAnsweredOrNotAnswered() {
        func answer(_ content: String) -> String? {
            let transcript = HermesHistoryMapper.transcript(from: [
                ["role": "user", "text": "go", "timestamp": 1],
                ["role": "tool", "name": "clarify", "tool_call_id": "call_1", "timestamp": 2,
                 "args": ["questions": [["question": "Which colour?", "choices": ["Red", "Blue"]]]], "content": .string(content)],
            ])
            guard case let .request(record)? = transcript.turns[0].items.last?.content else { return nil }
            return record.answer
        }
        #expect(answer("null") == "Answered")
        // While its card is open, the card stands for it.
        #expect(answer(#"{"responses":[],"asking":true}"#) == nil)
        #expect(answer(#"{"responses":[],"unanswered":true}"#) == "Not answered")
        #expect(answer(#"{"responses":[{"question":"Which colour?","user_response":""}]}"#) == "Skipped")
        #expect(answer(#"{"responses":[{"question":"Which colour?","user_response":"Blue"}]}"#) == "Blue")
    }
}

/// The answers given on a card go to the agent as a message the bridge marks as the
/// card's (`card_answer`): the app shows it in the questions' row, not as a bubble.
@Suite struct CardAnswerWireTests {
    private static let features: Set<String> = [BridgeWire.Feature.turnMessages, BridgeWire.Feature.queue, BridgeWire.Feature.asyncQuestions]

    @Test func aMessageMarkedAsACardsAnswerIsReadSoOnlyFromABridgeWithTheFeature() {
        let start = GatewayEvent(type: "message.start", sessionID: "s1", payload: ["opened_by": "portals", "text": "Blue", "sender": "user", "card_answer": "call_1"])
        #expect(HermesEventMapper.threadEvents(for: start, features: Self.features) == [.turnOpened(by: "Blue", cardAnswer: "call_1")])
        #expect(HermesEventMapper.threadEvents(for: start, features: [BridgeWire.Feature.turnMessages]) == [.turnOpened(by: "Blue")])
        let steered = GatewayEvent(type: "message.steered", sessionID: "s1", payload: ["text": "Blue", "sender": "user", "card_answer": "call_1"])
        #expect(HermesEventMapper.threadEvents(for: steered, features: Self.features) == [.messageSteered("Blue", cardAnswer: "call_1")])
        let queue = GatewayEvent(type: "queue.changed", sessionID: "s1", payload: ["queued": [["id": "1", "text": "Blue", "card_answer": "call_1"]], "can_steer": true])
        #expect(HermesEventMapper.threadEvents(for: queue, features: Self.features) == [.queueChanged([QueuedMessage(id: "1", text: "Blue", cardAnswer: "call_1")], canSteer: true, steered: nil)])
    }

    @Test func anotherDeviceIsToldTheAnswerItsRowShows() {
        let answered = GatewayEvent(type: "request.cancel", sessionID: "s1", payload: ["id": "srq-1", "reason": "resolved", "answer": ["answers": ["q0": "Blue"]]])
        #expect(HermesEventMapper.threadEvents(for: answered, features: Self.features) == [.requestAnswered(id: "srq-1", answer: .clarify(["q0": "Blue"]), by: nil)])
        // Dismissed there: skipped.
        let dismissed = GatewayEvent(type: "request.cancel", sessionID: "s1", payload: ["id": "srq-1", "reason": "resolved", "answer": [:]])
        #expect(HermesEventMapper.threadEvents(for: dismissed, features: Self.features) == [.requestAnswered(id: "srq-1", answer: .cancelled, by: nil)])
        // Without the feature, or without an answer: answered elsewhere, as before.
        #expect(HermesEventMapper.threadEvents(for: answered, features: [BridgeWire.Feature.turnMessages]) == [.requestClosed(id: "srq-1", reason: "Answered elsewhere")])
        let plain = GatewayEvent(type: "request.cancel", sessionID: "s1", payload: ["id": "srq-1", "reason": "resolved"])
        #expect(HermesEventMapper.threadEvents(for: plain, features: Self.features) == [.requestClosed(id: "srq-1", reason: "Answered elsewhere")])
    }

    @Test func aCancelThatNamesAnotherDeviceSaysAnotherAnswerWon() throws {
        let features: Set<String> = [BridgeWire.Feature.asyncQuestions, BridgeWire.Feature.answerOwner]
        func cancel(_ extra: [String: JSONValue]) -> GatewayEvent {
            var payload: [String: JSONValue] = ["id": "srq-1", "reason": "resolved", "answer": ["answers": ["q0": "Blue"]]]
            payload.merge(extra) { $1 }
            return GatewayEvent(type: "request.cancel", sessionID: "s1", payload: .object(payload))
        }
        #expect(HermesEventMapper.threadEvents(for: cancel(["answered_by": "other"]), features: features, device: "me") == [
            .requestSettledElsewhere(id: "srq-1"), .requestAnswered(id: "srq-1", answer: .clarify(["q0": "Blue"]), by: nil),
        ])
        // By no device that said its id: not this one either.
        #expect(HermesEventMapper.threadEvents(for: cancel([:]), features: features, device: "me").first == .requestSettledElsewhere(id: "srq-1"))
        // This app's own answer, replayed after a reconnect.
        #expect(HermesEventMapper.threadEvents(for: cancel(["answered_by": "me"]), features: features, device: "me") == [
            .requestAnswered(id: "srq-1", answer: .clarify(["q0": "Blue"]), by: nil),
        ])
        // Taken back: no answer of this app's was taken.
        let withdrawn = GatewayEvent(type: "request.cancel", sessionID: "s1", payload: ["id": "srq-1", "reason": "interrupted"])
        #expect(HermesEventMapper.threadEvents(for: withdrawn, features: features, device: "me").first == .requestSettledElsewhere(id: "srq-1"))
        // From a bridge without the feature, nothing is known of who answered.
        #expect(HermesEventMapper.threadEvents(for: cancel(["answered_by": "other"]), features: [BridgeWire.Feature.asyncQuestions], device: "me") == [
            .requestAnswered(id: "srq-1", answer: .clarify(["q0": "Blue"]), by: nil),
        ])
        // The app says its id only to a bridge that lists the feature.
        let told = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: features))
        #expect(told["device"]?.stringValue == BridgeWire.thisDevice)
        let older = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: [BridgeWire.Feature.asyncQuestions]))
        #expect(older["device"] == nil)
    }

    @Test func readBackTheRowStaysInViewAndTheCardsMessageHasNoBubble() throws {
        let stored: [JSONValue] = [
            ["role": "user", "text": "make a readme", "timestamp": 1],
            ["role": "tool", "name": "clarify", "tool_call_id": "call_1", "timestamp": 2,
             "args": ["questions": [["question": "Which colour?", "choices": ["Red", "Blue"]]], "async": true],
             "content": .string(#"{"responses":[{"question":"Which colour?","user_response":"Blue"}]}"#)],
            ["role": "assistant", "text": "Going on meanwhile.", "timestamp": 3],
            ["role": "user", "text": "Blue", "timestamp": 4, "card_answer": "call_1"],
            ["role": "assistant", "text": "Blue it is.", "timestamp": 5],
        ]
        let transcript = HermesHistoryMapper.transcript(from: stored, features: Self.features)
        guard case let .request(record)? = transcript.turns[0].items.first(where: { if case .request = $0.content { true } else { false } })?.content else {
            Issue.record("no row"); return
        }
        #expect(record.answer == "Blue")
        #expect(record.askedAhead == true)
        guard case let .user(message)? = transcript.turns[1].items.first?.content else { Issue.record("no message"); return }
        #expect(message.cardAnswer == "call_1")
        #expect(TurnLayout.pieces(for: transcript.turns[1]).count == 1)
        // A bridge without the feature: a row and a message as any.
        let older = HermesHistoryMapper.transcript(from: stored, features: [BridgeWire.Feature.turnMessages])
        guard case let .user(plain)? = older.turns[1].items.first?.content else { Issue.record("no message"); return }
        #expect(plain.cardAnswer == nil)
    }

    @Test func aRunningTurnTheCardsAnswerOpenedIsReadSo() throws {
        var resumed = HermesWire.SessionResumeResult(sessionID: "s1", running: true, messages: [["role": "user", "text": "make a readme", "timestamp": 1]])
        // Not stored yet: the turn under way opens with what `inflight` says.
        resumed.inflight = ["user": "Blue", "assistant": "", "card_answer": "call_1"]
        let snapshot = HermesHistoryMapper.snapshot(from: resumed, features: Self.features)
        guard case let .user(message)? = snapshot.transcript.turns.last?.items.first?.content else { Issue.record("no message"); return }
        #expect(message.cardAnswer == "call_1")
    }
}
