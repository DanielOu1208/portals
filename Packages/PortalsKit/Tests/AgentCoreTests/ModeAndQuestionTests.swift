import Foundation
import Testing
@testable import AgentCore

@Suite struct ModeAndQuestionTests {
    @Test func providerModesKeepTheirOrderAndMeanings() throws {
        let options = [
            ModeOption(id: .ask, label: "Off", description: "Droid's rules apply."),
            ModeOption(id: .medium, label: "Medium", description: "Reversible development actions can run without asking."),
            ModeOption(id: .settings, label: "Default", description: "Inherits your Droid CLI settings."),
        ]
        let mode = ModeState(mode: .settings, defaultsTo: .medium, options: options)
        #expect(mode.effective == .medium)
        #expect(mode.offeredModes == [.ask, .medium, .settings])
        #expect(mode.title(for: .settings) == "Default")
        #expect(mode.meaning(for: .medium) == options[1].description)
        #expect(mode.offeredModes.map { mode.pickerTitle(for: $0) } == ["Off", "Medium", "Default (Medium)"])
        #expect(mode.offeredModes.map { mode.pickerDescription(for: $0) } == options.map(\.description))
        #expect(try JSONDecoder().decode(ModeState.self, from: JSONEncoder().encode(mode)) == mode)
    }

    @Test func pickingAModeKeepsTheProvidersChoices() {
        let options = [
            ModeOption(id: .ask, label: "Off", description: "Droid's rules apply."),
            ModeOption(id: .medium, label: "Medium", description: "Reversible development actions can run without asking."),
            ModeOption(id: .plan, label: "Spec", description: "Plans first."),
            ModeOption(id: .settings, label: "Default", description: "Inherits your Droid CLI settings."),
        ]
        let opened = ModeState(mode: .settings, defaultsTo: .medium, options: options)
        let picked = opened.picking(.plan)
        #expect(picked.mode == .plan)
        #expect(picked.defaultsTo == .medium)
        #expect(picked.offeredModes == [.ask, .medium, .plan, .settings])
        #expect(picked.title(for: .plan) == "Spec")
        #expect(ModeState(mode: .full).picking(.ask) == ModeState(mode: .ask))
    }

    @Test func oldModesKeepTheirFiveChoices() throws {
        let mode = try JSONDecoder().decode(ModeState.self, from: Data(#"{"mode":"default","defaultsTo":"edits"}"#.utf8))
        #expect(mode.options == nil)
        #expect(mode.offeredModes == [.full, .edits, .ask, .plan, .settings])
        #expect(!mode.offeredModes.contains(.medium))
        #expect(mode.title(for: .edits) == "Accept edits")
        #expect(mode.meaning(for: .edits) == ThreadMode.edits.meaning)
        // Exact pre-Droid picker order and standalone wording, not provider sentence endings.
        #expect(mode.offeredModes.map { mode.pickerTitle(for: $0) } == [
            "Full access", "Accept edits", "Ask first", "Plan", "Your settings (Accept edits)",
        ])
        #expect(mode.offeredModes.map { mode.pickerDescription(for: $0) } == [
            "Edits files and runs commands without asking",
            "Edits files without asking, and asks before running commands",
            "Asks before editing files or running commands",
            "Plans first, and asks before carrying the plan out",
            "As the agent's own settings at the desk say",
        ])
        #expect(ModeState(mode: .settings).pickerTitle(for: .settings) == "Your settings")
        #expect(ModeState(mode: .settings, defaultsTo: .settings).defaultsTo == nil)
    }

    @Test func requiredQuestionnairesRejectPartialAndBlankAnswers() throws {
        let questions = [ClarifyQuestion(id: "1", text: "First?"), ClarifyQuestion(id: "2", text: "Second?")]
        let required = PendingRequest(id: "q", kind: .clarify(questions), requiresAllAnswers: true)
        #expect(!required.acceptsClarification([:]))
        #expect(!required.acceptsClarification(["1": "Yes"]))
        #expect(!required.acceptsClarification(["1": "Yes", "2": " \n "]))
        #expect(required.acceptsClarification(["1": "Yes", "2": "A, B"]))
        #expect(try JSONDecoder().decode(PendingRequest.self, from: JSONEncoder().encode(required)) == required)
        let optional = PendingRequest(id: "q", kind: .clarify(questions))
        #expect(optional.acceptsClarification(["1": "Yes"]))
        #expect(!optional.acceptsClarification(["1": " "]))
    }
}
