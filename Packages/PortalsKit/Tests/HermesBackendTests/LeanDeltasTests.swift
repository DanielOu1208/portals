import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct LeanDeltasTests {
    @Test func compactTextAndReasoningBecomeTheSameGatewayEvents() throws {
        let session = "cdf72f54-890b-4ae2-a96d-30682d59c667"
        for (key, type) in [("d", "message.delta"), ("t", "reasoning.delta")] {
            for text in ["", "Hello ", "修正 🚀\n{\"text\":\"not a frame\"}"] {
                let value = JSONValue.object([key: [.string(session), 42, .string(text)]])
                let parsed = try InboundFrame.parse(value.serialized())
                let event = GatewayEvent(type: type, sessionID: session, seq: 42, payload: ["text": .string(text)])
                #expect(parsed == .event(event))
                if key == "t" {
                    #expect(HermesEventMapper.threadEvents(for: event) == (text.isEmpty ? [] : [.reasoningDelta(text)]))
                }
            }
        }
    }

    @Test func malformedKnownCompactFramesAreNotSilentlyDropped() throws {
        let tuples: [JSONValue] = [
            .null, "text", [:], [], ["s"], ["s", 1], ["s", 1, "x", "extra"],
            ["", 1, "x"], [true, 1, "x"], [.null, 1, "x"],
            ["s", 0, "x"], ["s", -1, "x"], ["s", 1.5, "x"], ["s", "1", "x"],
            ["s", true, "x"], ["s", .null, "x"], ["s", 9.0e15, "x"], ["s", 1e100, "x"],
            ["s", 1, .null], ["s", 1, false], ["s", 1, ["text": "x"]],
        ]
        for key in ["d", "t"] {
            for tuple in tuples {
                let text = try JSONValue.object([key: tuple]).serialized()
                #expect(throws: (any Error).self) { try InboundFrame.parse(text) }
            }
        }
        for text in [
            #"{"d":["s",1,"x"],"t":["s",1,"x"]}"#,
            #"{"d":["s",1,"x"],"extra":true}"#,
            #"{"d":["s",1,"x"],"id":"r1"}"#,
            #"{"t":["s",1,"x"],"method":"event","params":null}"#,
        ] {
            #expect(throws: (any Error).self) { try InboundFrame.parse(text) }
        }
    }

    @Test func unknownCompactShapesRemainUnrecognizedAndCanonicalFramesKeepPrecedence() throws {
        #expect(try InboundFrame.parse(#"{"future_delta":["s",1,"x"]}"#) == .unrecognized)
        #expect(try InboundFrame.parse(#"{"jsonrpc":"2.0","id":"r1","result":{},"d":false}"#)
            == .response(id: "r1", outcome: .success([:])))
        #expect(try InboundFrame.parse(#"{"jsonrpc":"2.0","method":"event","params":{"type":"thinking.delta","payload":{"text":"waiting"}},"t":false}"#)
            == .event(GatewayEvent(type: "thinking.delta", payload: ["text": "waiting"])))
    }

    @Test func onlyAnAdvertisedFeatureAddsTheCapability() throws {
        let offered = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: ["lean_deltas"]))
        #expect(offered == ["server_requests": true, "lean_deltas": true])
        for features: Set<String> in [[], ["unknown_feature"]] {
            #expect(try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: features)).serialized()
                == #"{"server_requests":true}"#)
        }
        #expect(try JSONValue(encoding: HermesWire.ClientCapabilitiesParams(serverRequests: true)).serialized()
            == #"{"server_requests":true}"#)
        let older = try JSONValue(encoding: BridgeWire.ClientCapabilitiesParams(features: [
            "subagents", "async_questions", "poll_now", "session_resync",
        ]))
        #expect(try older.serialized()
            == #"{"async_questions":true,"poll_now":true,"server_requests":true,"session_resync":true,"subagent_requests":true}"#)
    }

    @Test func recordedTurnsHaveIdenticalEventsAndTranscriptContents() throws {
        let now = Date(timeIntervalSince1970: 1234)
        for capture in ["bridge-chat-tools.jsonl", "bridge-claude-chat-tools.jsonl", "bridge-codex-chat-tools.jsonl"] {
            let frames = try Fixtures.frames(capture, direction: "in").filter { $0["method"] == "event" }
            let canonical = try frames.map(event)
            let lean = try frames.map { try event(compact($0)) }
            #expect(lean == canonical, "\(capture)")
            #expect(frames.map(compact).contains { $0["d"] != nil }, "\(capture)")
            let canonicalEvents = canonical.flatMap { HermesEventMapper.threadEvents(for: $0, at: now) }
            let leanEvents = lean.flatMap { HermesEventMapper.threadEvents(for: $0, at: now) }
            #expect(leanEvents == canonicalEvents, "\(capture)")
            var expected = ThreadState()
            var actual = ThreadState()
            canonicalEvents.forEach { expected.apply($0, at: now) }
            leanEvents.forEach { actual.apply($0, at: now) }
            #expect(actual.transcript.turns.flatMap(\.items).map(\.content)
                == expected.transcript.turns.flatMap(\.items).map(\.content), "\(capture)")
            #expect(actual.phase == expected.phase)
        }
    }

    private func event(_ frame: JSONValue) throws -> GatewayEvent {
        let parsed = try InboundFrame.parse(frame.serialized())
        let value: GatewayEvent? = if case let .event(event) = parsed { event } else { nil }
        return try #require(value)
    }

    private func compact(_ frame: JSONValue) -> JSONValue {
        guard let params = frame["params"], let type = params["type"]?.stringValue,
              type == "message.delta" || type == "reasoning.delta",
              let session = params["session_id"], let seq = params["seq"],
              let payload = params["payload"], payload.objectValue?.count == 1,
              let text = payload["text"], text.stringValue != nil else { return frame }
        return .object([type == "message.delta" ? "d" : "t": [session, seq, text]])
    }
}
