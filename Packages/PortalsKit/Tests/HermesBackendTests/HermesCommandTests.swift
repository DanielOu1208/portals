import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Hermes's slash commands: which ones the app offers, and what their answers mean.
@Suite struct HermesCommandTests {
    /// A trimmed copy of what `commands.catalog` answered on Hermes 0.21.5.
    private func catalog() throws -> CommandCatalog {
        HermesCommands.catalog(from: try Fixtures.json("commands-catalog.json"))
    }

    // MARK: The catalog

    @Test func commandsForGraphicalClientsAreOfferedInHermessOrder() throws {
        let names = try catalog().commands.filter { $0.kind == .host }.map(\.name)
        #expect(names == ["new", "retry", "undo", "compress", "stop", "queue", "plan", "status", "approvals", "reasoning", "help", "usage", "version", "tools", "skills"])
    }

    @Test func commandsForOtherKindsOfClientAreLeftOutWithAReason() throws {
        let catalog = try catalog()
        // Tagged for the terminal by Hermes, or in its terminal-only categories.
        for name in ["clear", "config", "quit", "density", "mouse"] {
            #expect(catalog.unavailable[name] == "/\(name) only works in Hermes's terminal app.", "\(name)")
        }
        #expect(catalog.unavailable["approve"] == "/approve only works in a messaging app such as Discord.")
        // Tagged some other way, or done by Hermes's desktop app with a screen of its own.
        for name in ["kanban", "voice", "login", "yolo", "btw", "title"] {
            #expect(catalog.unavailable[name] == "/\(name) is not available in Portals.", "\(name)")
        }
        #expect(catalog.target(of: SlashInput(name: "exit")) == .unavailable("/quit only works in Hermes's terminal app."))
    }

    @Test func aCommandHermesHidesFromMenusStillRuns() throws {
        // "/model": graphical clients have a picker. The app's own command takes it.
        let catalog = try catalog()
        #expect(!catalog.commands.contains { $0.name == "model" })
        #expect(catalog.unavailable["model"] == nil)
        #expect(catalog.target(of: SlashInput(name: "model")) == .app(.model))
    }

    @Test func descriptionsAndWhatCanFollowAreToldApart() throws {
        let catalog = try catalog()
        let undo = try #require(catalog.commands.first { $0.name == "undo" })
        #expect(undo.summary == "Back up N user turns and re-prompt (default 1)")
        #expect(undo.usage == "[N]")
        let status = try #require(catalog.commands.first { $0.name == "status" })
        #expect(status.summary == "Show session, model, token, and context info")
        #expect(status.usage == nil)
    }

    @Test func aCommandHermesLimitsForGraphicalClientsCarriesTheLimit() throws {
        let skills = try #require(try catalog().commands.first { $0.name == "skills" })
        #expect(skills.allowedArguments == ["pending", "approve", "reject", "diff", "approval"])
        #expect(skills.usage == "pending | approve | reject | diff | approval")
    }

    @Test func skillsFollowTheCommandsMostUsedFirst() throws {
        let skills = try catalog().commands.filter { $0.kind == .skill }
        #expect(skills.map(\.name) == ["arxiv", "apple-notes", "codebase-inspection"])
        #expect(skills[0].summary == "Search arXiv papers by keyword, author, category, or ID.")
    }

    @Test func otherNamesForACommandAreKnown() throws {
        let catalog = try catalog()
        #expect(catalog.aliases["reset"] == "new")
        #expect(catalog.aliases["compact"] == "compress")
        #expect(catalog.aliases["new"] == nil)
        #expect(catalog.suggestions(for: "/compa").map(\.name) == ["compress"])
    }

    @Test func anAnswerInAnUnexpectedShapeGivesAnEmptyListNotAnError() {
        #expect(HermesCommands.catalog(from: ["categories": "soon", "commands": [1, 2]]) == CommandCatalog())
        #expect(HermesCommands.catalog(from: .null) == CommandCatalog())
    }

    // MARK: Answers

    private let status = SlashInput(name: "status")

    @Test func textComesBackAsOutputCleanedOfTheTerminal() throws {
        let raw = "\n  \u{1B}[1mSession\u{1B}[0m: abc  \n    Model: glm-5.3\n\n  Turns: 4\n\n"
        #expect(try HermesCommands.answer(in: ["output": .string(raw)], to: status) == .outcome(.output("Session: abc\n  Model: glm-5.3\n\nTurns: 4")))
        #expect(HermesCommands.readable("(._.) No active agent -- send a message first.") == "No active agent -- send a message first.")
        #expect(HermesCommands.readable("  Approval mode: smart (persistent profile setting).") == "Approval mode: smart (persistent profile setting).")
        // A bracket that is not a face is left alone.
        #expect(HermesCommands.readable("[browser] is connected") == "[browser] is connected")
        #expect(HermesCommands.readable("(no output)") == "(no output)")
    }

    @Test func aWarningGoesWithTheOutput() throws {
        let result: JSONValue = ["output": "Compressed.", "warning": "⚠ live session sync failed: busy"]
        #expect(try HermesCommands.answer(in: result, to: status) == .outcome(.output("Warning: live session sync failed: busy\n\nCompressed.")))
        #expect(try HermesCommands.answer(in: ["output": ""], to: status) == .outcome(.output("No output.")))
    }

    @Test func aSkillIsAMessageShownAsWhatWasTyped() throws {
        let result: JSONValue = ["type": "skill", "name": "arxiv", "message": "[long instructions]\n\ntransformers", "display": "/arxiv transformers"]
        #expect(try HermesCommands.answer(in: result, to: SlashInput(name: "arxiv", argument: "transformers"))
            == .outcome(.message("[long instructions]\n\ntransformers", shownAs: "/arxiv transformers", note: nil)))
    }

    @Test func aCommandThatBecomesAMessageIsSentAsIs() throws {
        let queued: JSONValue = ["type": "send", "message": "hello there"]
        #expect(try HermesCommands.answer(in: queued, to: SlashInput(name: "queue", argument: "hello there")) == .outcome(.message("hello there", shownAs: nil, note: nil)))
        let bundle: JSONValue = ["type": "send", "message": "[three skills]", "display": "/research x", "notice": "⚡ Loading bundle: research (3 skills)"]
        #expect(try HermesCommands.answer(in: bundle, to: SlashInput(name: "research", argument: "x"))
            == .outcome(.message("[three skills]", shownAs: "/research x", note: "Loading bundle: research (3 skills)")))
    }

    @Test func textForTheComposerIsADraft() throws {
        let result: JSONValue = ["type": "prefill", "message": "what I said before", "notice": "Backed up 1 turn."]
        #expect(try HermesCommands.answer(in: result, to: SlashInput(name: "undo")) == .outcome(.draft("what I said before", note: "Backed up 1 turn.")))
    }

    @Test func anAnswerThatCannotBeUsedSaysSo() {
        #expect(throws: HermesBackendError.commandUnusable("Hermes had nothing to send for /arxiv.")) {
            try HermesCommands.answer(in: ["type": "skill", "name": "arxiv"], to: SlashInput(name: "arxiv"))
        }
        #expect(throws: HermesBackendError.self) {
            try HermesCommands.answer(in: ["type": "hologram"], to: SlashInput(name: "status"))
        }
    }

    @Test func anotherNameForACommandPointsAtTheCommand() throws {
        let typed = SlashInput(name: "compact", argument: "here 3")
        #expect(try HermesCommands.answer(in: ["type": "alias", "target": "/compress"], to: typed)
            == .standsFor(SlashInput(name: "compress", argument: "here 3")))
        // One that does not say which command it stands for cannot be followed.
        #expect(throws: HermesBackendError.commandUnusable("Hermes could not say what /compact here 3 stands for.")) {
            try HermesCommands.answer(in: ["type": "alias"], to: typed)
        }
    }
}
