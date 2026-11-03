import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct DroidParityWireTests {
    private let features: Set<String> = [BridgeWire.Feature.modes]

    @Test func oldBridgeProfilesAdvertiseNoAdoptionModes() throws {
        let old = try JSONValue.object(["name": "droid", "kind": "droid"]).decode(HermesWire.ProfileRow.self)
        #expect(old.adoptModes == nil)
        let current = try JSONValue.object(["name": "droid", "adopt_modes": ["continue", "fork", "read", "future"]]).decode(HermesWire.ProfileRow.self)
        #expect(current.adoptModes?.arrayValue?.compactMap { $0.stringValue.flatMap(AdoptMode.init(rawValue:)) } == [.continue, .fork, .read])
    }

    @Test func modeMetadataSurvivesEverySessionPayload() throws {
        let fixture = try Fixtures.json("droid-parity-phase1.json")
        let options = try #require(BridgeWire.modeOptions(fixture["mode_options"]))
        let expected = ModeState(mode: .settings, defaultsTo: .medium, options: options)
        let result = try fixture.decode(BridgeWire.SessionSetModeResult.self)
        #expect(BridgeWire.modeState(mode: result.mode, default: result.modeDefault, options: result.modeOptions) == expected)
        let resumed = try JSONValue.object(["session_id": "s", "info": fixture]).decode(HermesWire.SessionResumeResult.self)
        #expect(HermesHistoryMapper.info(from: resumed, features: features).mode == expected)
        let event = GatewayEvent(type: "session.mode", sessionID: "s", payload: fixture)
        #expect(HermesEventMapper.threadEvents(for: event, features: features) == [.modeChanged(expected)])
        #expect(HermesEventMapper.threadEvents(for: event).isEmpty)
        let catalog = try JSONValue.object(["modes": ["default": "medium"], "mode_options": try #require(fixture["mode_options"])]).decode(HermesWire.ModelOptionsResult.self)
        #expect(BridgeWire.modeOptions(catalog.modeOptions) == options)
        let profile = try JSONValue.object(["name": "droid", "mode_options": try #require(fixture["mode_options"])]).decode(HermesWire.ProfileRow.self)
        #expect(BridgeWire.modeOptions(profile.modeOptions) == options)
    }

    @Test func unknownOrMalformedOptionsDoNotLoseTheSession() throws {
        let options: JSONValue = [
            ["id": "medium", "label": "Medium", "description": "Reversible actions."],
            ["id": "future", "label": "Future", "description": "Unknown."],
            ["id": "full", "label": " ", "description": "Blank label."],
            ["id": "ask", "label": "Off"],
            ["id": "medium", "label": "Duplicate", "description": "Ignored."],
            42,
        ]
        let state = try #require(BridgeWire.modeState(mode: "medium", default: nil, options: options))
        #expect(state.offeredModes == [.medium])
        #expect(state.title(for: .medium) == "Medium")
        #expect(BridgeWire.modeState(mode: "full", default: nil, options: [])?.offeredModes == [.full, .edits, .ask, .plan, .settings])
    }

    @Test(arguments: ["codex", "cursor"])
    func profilesWithoutModeOptionsKeepLegacyModesOnEverySessionPath(profileName: String) throws {
        let profile = try JSONValue.object(["name": .string(profileName)]).decode(HermesWire.ProfileRow.self)
        #expect(BridgeWire.modeOptions(profile.modeOptions) == nil)
        let catalog = try JSONValue.object(["modes": ["default": "edits"]]).decode(HermesWire.ModelOptionsResult.self)
        #expect(BridgeWire.modeOptions(catalog.modeOptions) == nil)

        let payload: JSONValue = ["mode": "default", "mode_default": "edits"]
        let expected = ModeState(mode: .settings, defaultsTo: .edits)
        let result = try payload.decode(BridgeWire.SessionSetModeResult.self)
        #expect(BridgeWire.modeState(mode: result.mode, default: result.modeDefault, options: result.modeOptions) == expected)
        let resumed = try JSONValue.object(["session_id": "s", "info": payload]).decode(HermesWire.SessionResumeResult.self)
        #expect(HermesHistoryMapper.info(from: resumed, features: features).mode == expected)
        let event = GatewayEvent(type: "session.mode", sessionID: "s", payload: payload)
        #expect(HermesEventMapper.threadEvents(for: event, features: features) == [.modeChanged(expected)])
        #expect(expected.offeredModes == [.full, .edits, .ask, .plan, .settings])
    }

    @Test func droidQuestionnairesRequireAllAnswersButCanBeDismissed() throws {
        let fixture = try Fixtures.json("droid-parity-phase1.json")
        let request = try #require(HermesEventMapper.pendingRequest(ServerRequest(id: "q", method: "clarify", params: fixture)))
        #expect(request.requiresAllAnswers == true)
        #expect(!request.acceptsClarification(["0": "Unit, UI"]))
        #expect(!request.acceptsClarification(["0": "Unit", "1": "\n"]))
        let answers = ["0": "Unit, UI", "1": "Mac"]
        #expect(request.acceptsClarification(answers))
        #expect(HermesEventMapper.result(for: .clarify(answers), to: request) == ["answers": ["0": "Unit, UI", "1": "Mac"]])
        #expect(HermesEventMapper.result(for: .cancelled, to: request) == [:])
        let questions = try #require(fixture["questions"])
        let legacy = try #require(HermesEventMapper.pendingRequest(ServerRequest(id: "q", method: "clarify", params: [
            "questions": questions,
        ])))
        #expect(legacy.requiresAllAnswers == nil)
        #expect(legacy.acceptsClarification(["0": "Unit"]))
    }

    @Test func droidCustomAnswersKeepEveryLineOnTheWireAndInTheTranscript() throws {
        let fixture = try Fixtures.json("droid-parity-phase1.json")
        let request = try #require(HermesEventMapper.pendingRequest(ServerRequest(id: "q", method: "clarify", params: fixture)))
        let text = "First line\nSecond line\n\nFourth line"
        let answers = ["0": text, "1": "Mac"]
        #expect(request.acceptsClarification(answers))
        let result = HermesEventMapper.result(for: .clarify(answers), to: request)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(result))
        #expect(decoded["answers"]?["0"]?.stringValue == text)
        #expect(RequestAnswer.clarify(answers).summary(for: request).contains(text))
    }
}
