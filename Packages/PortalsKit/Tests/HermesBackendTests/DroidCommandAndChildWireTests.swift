import AgentCore
import Foundation
import Testing
@testable import HermesBackend

/// Droid uses the existing catalog, command outcome and kept-subagent shapes.
@Suite struct DroidCommandAndChildWireTests {
    @Test func exactSlashKeyCatalogMetadataDoesNotDuplicateOrTurnCommandsIntoSkills() {
        let pairs: JSONValue = [
            ["/status", "Show this thread"], ["/mode", "Show or change Droid autonomy"],
            ["/context", "Show context breakdown"], ["/compact", "Summarize context (usage: /compact [instructions])"],
            ["/review", "Review changes (usage: /review [arguments])"],
        ]
        let catalog = HermesCommands.catalog(from: [
            "categories": [
                ["name": "Bridge", "pairs": [["/status", "Show this thread"], ["/mode", "Show or change Droid autonomy"]]],
                ["name": "Droid", "pairs": [
                    ["/context", "Show context breakdown"], ["/compact", "Summarize context (usage: /compact [instructions])"],
                    ["/review", "Review changes (usage: /review [arguments])"],
                ]],
            ],
            "pairs": pairs, "commands": ["/review": ["source": "project", "custom": true]], "skills": [:], "canon": [:],
        ])
        let names = catalog.offered.map(\.name)
        #expect(names.count == Set(names).count)
        #expect(names.filter { $0 == "review" }.count == 1)
        #expect(catalog.commands.first { $0.name == "review" }?.kind == .host)
        #expect(catalog.target(of: SlashInput(name: "review", argument: "careful")) == .host)
        #expect(catalog.commands.first { $0.name == "review" }?.usage == "[arguments]")
    }

    @Test func droidCommandsMergeWithTheAppsPickersWithoutDuplicates() {
        let catalog = HermesCommands.catalog(from: [
            "categories": [
                ["name": "Bridge", "pairs": [["/status", "Show thread status"]]],
                ["name": "Droid", "pairs": [
                    ["/model", "Choose a model"],
                    ["/compact", "Summarize the conversation (usage: /compact [instructions])"],
                    ["/context", "Show context use"], ["/cost", "Show cost"],
                    ["/rename", "Rename the thread (usage: /rename <title>)"],
                    ["/new", "Start a new conversation"],
                    ["/review", "Review the current changes"],
                ]],
            ],
            "canon": [:],
        ])
        let names = catalog.offered.map(\.name)
        #expect(names.count == Set(names).count)
        #expect(names.filter { $0 == "model" }.count == 1)
        #expect(catalog.target(of: SlashInput(name: "model")) == .app(.model))
        #expect(catalog.target(of: SlashInput(name: "new")) == .app(.new))
        for name in ["compact", "context", "cost", "rename", "review"] {
            #expect(catalog.target(of: SlashInput(name: name)) == .host)
            #expect(catalog.suggestions(for: "/\(name)").map(\.name) == [name])
        }
        #expect(catalog.commands.first { $0.name == "compact" }?.usage == "[instructions]")
        #expect(catalog.commands.first { $0.name == "rename" }?.usage == "<title>")
    }

    @Test func dispatchedCommandsKeepArgumentsAndExpandedMessagesExactly() throws {
        let instructions = "Preserve the API decisions\nand the migration checklist."
        let compact = SlashInput(name: "compact", argument: instructions)
        #expect(try HermesCommands.answer(in: ["type": "send", "message": .string(compact.text)], to: compact)
            == .outcome(.message(compact.text, shownAs: nil, note: nil)))
        let expanded = "Review only the authentication module.\n\nFocus on: token expiry"
        #expect(try HermesCommands.answer(in: [
            "type": "send", "message": .string(expanded), "display": "/review token expiry",
        ], to: SlashInput(name: "review", argument: "token expiry"))
            == .outcome(.message(expanded, shownAs: "/review token expiry", note: nil)))
    }

    @Test func childProgressKeepsItsParentAndTheThreadBusyUntilEveryChildEnds() {
        var state = ThreadState()
        state.apply(.turnStarted)
        let parent: JSONValue = [
            "subagent_id": "task-session", "goal": "Inspect the tests", "status": "running",
            "started_at": 100, "turn": 1, "can_stop": false,
        ]
        let child: JSONValue = [
            "subagent_id": "nested-session", "parent_id": "task-session", "goal": "Check fixtures",
            "status": "running", "started_at": 101, "turn": 1, "can_stop": false,
            "tool_name": "terminal", "tool_preview": "swift test", "summary": "Checking fixtures",
        ]
        for (type, payload) in [("subagent.start", parent), ("subagent.progress", child)] {
            for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: type, payload: payload)) { state.apply(event) }
        }
        #expect(state.subagents.map(\.id) == ["task-session", "nested-session"])
        #expect(state.subagents.nested.map(\.depth) == [0, 1])
        #expect(state.subagents.allSatisfy { !$0.canStop })
        #expect(state.subagents.last?.summary == "Checking fixtures")
        state.apply(.turnFinished(.completed, finalText: nil))
        #expect(state.isAtWork)
        for id in ["task-session", "nested-session"] {
            let ended: JSONValue = [
                "subagent_id": .string(id), "goal": "Inspect the tests", "status": "completed",
                "started_at": 100, "ended_at": 105, "turn": 1, "can_stop": false, "result": "All checks pass",
                "parent_id": id == "nested-session" ? "task-session" : .null,
            ]
            for event in HermesEventMapper.threadEvents(for: GatewayEvent(type: "subagent.complete", payload: ended)) { state.apply(event) }
            if id == "task-session" { #expect(state.isAtWork) }
        }
        #expect(!state.isAtWork)
        #expect(state.subagents.count == 2)
        #expect(state.subagents.allSatisfy { $0.state == .finished && $0.result == "All checks pass" && !$0.canStop })
    }

    @Test func reconnectReadsTheSameChildIdentityAndFinalFailure() throws {
        let listed: JSONValue = [
            "subagent_id": "child-session", "parent_id": "parent-session", "goal": "Inspect tests",
            "status": "failed", "started_at": 100, "ended_at": 105, "turn": 1, "can_stop": false,
            "result": "The build failed", "model": "model-id", "tokens": 42, "tool_uses": 2,
        ]
        let child = try #require(HermesEventMapper.subagent(listed))
        #expect(child.id == "child-session")
        #expect(child.parentID == "parent-session")
        #expect(child.state == .failed)
        #expect(child.isKept && !child.canStop)
        #expect(child.result == "The build failed")
        #expect(child.model == "model-id" && child.tokens == 42 && child.toolUses == 2)
    }
}
