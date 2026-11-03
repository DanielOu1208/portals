import Foundation
import Testing
@testable import AgentCore

@Suite struct CodingAgentLogoTests {
    private let mac = HostID(rawValue: "mac")

    /// `kind` as the bridge said it of the agent; nil from a bridge that says none.
    private func logo(_ name: String, kind: String? = nil, on hostKind: HostKind?) -> CodingAgentLogo? {
        CodingAgentLogo.logo(for: Agent.ID(host: mac, name: name), kind: kind, hostKind: hostKind)
    }

    @Test func aBridgesCodingAgentsWearTheirMakersLogo() {
        #expect(logo("claude", kind: "claude", on: .bridge) == .claude)
        #expect(logo("codex", kind: "codex", on: .bridge) == .codex)
        #expect(logo("pi", kind: "pi", on: .bridge) == .pi)
        #expect(logo("cursor", kind: "cursor", on: .bridge) == .cursor)
        #expect(logo("droid", kind: "droid", on: .bridge) == .droid)
    }

    /// A Hermes profile keeps a name the bridge's own agents leave free, so one can be
    /// called pi on a bridge that runs no Pi: what the bridge says it is decides.
    @Test func theKindDecidesNotTheName() {
        #expect(logo("pi", kind: "hermes", on: .bridge) == nil)
        #expect(logo("cursor", kind: "hermes", on: .bridge) == nil)
        #expect(logo("claude", kind: "hermes", on: .bridge) == nil)
        #expect(logo("codex", kind: "hermes", on: .bridge) == nil)
        #expect(logo("droid", kind: "hermes", on: .bridge) == nil)
        // The bridge's own agent and its test agent are kinds with no logo.
        #expect(logo("portals-aeri", kind: "aeri", on: .bridge) == nil)
        #expect(logo("fake", kind: "fake", on: .bridge) == nil)
        // A kind this version does not know, under a name it does.
        #expect(logo("pi", kind: "opencode", on: .bridge) == nil)
        // Only a bridge's agents have one, whatever a Hermes host says of its own.
        #expect(logo("pi", kind: "pi", on: nil) == nil)
    }

    /// A bridge from before it said the kind names its own agents claude, codex, pi and
    /// cursor: there the name decides, as it did.
    @Test func aBridgeThatSaysNoKindGoesByTheName() {
        #expect(logo("claude", on: .bridge) == .claude)
        #expect(logo("codex", on: .bridge) == .codex)
        #expect(logo("pi", on: .bridge) == .pi)
        #expect(logo("cursor", on: .bridge) == .cursor)
    }

    /// What the bridge said an agent is, is kept with the saved agents (agents.json), so
    /// the logo is right at the next launch before the host has answered.
    @Test func anAgentsKindIsSavedWithIt() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-kinds-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ThreadStore(directory: directory)
        let agents = [
            Agent(id: Agent.ID(host: mac, name: "claude"), displayName: "Claude Code", isDefault: true, kind: "claude"),
            // A Hermes profile called pi, on a bridge that runs no Pi.
            Agent(id: Agent.ID(host: mac, name: "pi"), displayName: "Pi", kind: "hermes"),
            Agent(id: Agent.ID(host: HostID(rawValue: "mini"), name: "default"), displayName: "Karina"),
        ]
        store.saveAgents(agents)
        #expect(store.loadAgents() == agents)
        #expect(store.loadAgents().map(\.kind) == ["claude", "hermes", nil])
    }

    @Test func otherAgentsHaveNone() {
        // A Hermes host, or one not reached yet, with agents of the same names: a Hermes
        // profile can be called anything.
        #expect(logo("claude", on: nil) == nil)
        #expect(logo("codex", on: nil) == nil)
        #expect(logo("pi", on: nil) == nil)
        #expect(logo("cursor", on: nil) == nil)
        #expect(logo("droid", on: nil) == nil)
        // The bridge's test agent and its own agent, and names that only look alike.
        #expect(logo("fake", on: .bridge) == nil)
        #expect(logo("aeri", on: .bridge) == nil)
        #expect(logo("Claude", on: .bridge) == nil)
        #expect(logo("claude-code", on: .bridge) == nil)
        #expect(logo("Pi", on: .bridge) == nil)
        #expect(logo("pi-coding-agent", on: .bridge) == nil)
        #expect(logo("cursor-agent", on: .bridge) == nil)
        #expect(logo("", on: .bridge) == nil)
        // A Hermes profile called pi or cursor, as a bridge that also runs Pi and Cursor
        // names it.
        #expect(logo("hermes-pi", on: .bridge) == nil)
        #expect(logo("hermes-cursor", on: .bridge) == nil)
    }

    @Test func theEditorNamesWhoseLogoItIs() {
        #expect(CodingAgentLogo.claude.brand == "Claude")
        #expect(CodingAgentLogo.codex.brand == "OpenAI")
        #expect(CodingAgentLogo.pi.brand == "Pi")
        #expect(CodingAgentLogo.cursor.brand == "Cursor")
        #expect(CodingAgentLogo.droid.brand == "Factory")
    }
}

/// Showing the logo is part of an agent's look, kept in looks.json.
@Suite struct LookLogoTests {
    /// A store in a fresh temporary folder, removed when the test ends.
    private final class Scratch {
        let store: ThreadStore

        init() {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-logos-\(UUID().uuidString)")
            store = ThreadStore(directory: directory)
        }

        deinit {
            try? FileManager.default.removeItem(at: store.directory)
        }

        func write(_ text: String, to file: String) throws {
            let url = store.directory.appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }

        func read(_ file: String) throws -> String {
            try String(decoding: Data(contentsOf: store.directory.appendingPathComponent(file)), as: UTF8.self)
        }
    }

    private let claude = Agent.ID(host: HostID(rawValue: "mac"), name: "claude")
    private let codex = Agent.ID(host: HostID(rawValue: "mac"), name: "codex")
    private let karina = Agent.ID(host: HostID(rawValue: "mini"), name: "default")

    /// Saved by the app before it kept the logo setting: every look loads with no choice
    /// made, which for an agent that has a logo now means the logo.
    @Test func oldLooksLoadWithNoChoiceOfLogo() throws {
        let scratch = Scratch()
        try scratch.write(LegacyFileTests.looksJSON, to: "looks.json")
        let looks = scratch.store.loadLooks()
        #expect(looks.count == 3)
        #expect(looks.values.allSatisfy { $0.showsLogo == nil })
        #expect(looks.values.allSatisfy { $0.shows(.claude) && !$0.shows(nil) })
        #expect(looks[Agent.ID(host: HostID(rawValue: "local"), name: "claude")] == AgentLook(shape: 7, face: 3, tint: 11))
    }

    @Test func aLookDecodesWithOrWithoutTheSetting() throws {
        let decoder = JSONDecoder()
        #expect(try decoder.decode(AgentLook.self, from: Data(#"{"face":2,"shape":1,"tint":3}"#.utf8)) == AgentLook(shape: 1, face: 2, tint: 3))
        #expect(try decoder.decode(AgentLook.self, from: Data(#"{"face":2,"shape":1,"tint":3,"showsLogo":true}"#.utf8)).showsLogo == true)
        #expect(try decoder.decode(AgentLook.self, from: Data(#"{"face":2,"shape":1,"tint":3,"showsLogo":false}"#.utf8)).showsLogo == false)
        // A value this version cannot read counts as no choice; the look itself is kept.
        let odd = try decoder.decode(AgentLook.self, from: Data(#"{"face":2,"shape":1,"tint":3,"showsLogo":"yes"}"#.utf8))
        #expect(odd == AgentLook(shape: 1, face: 2, tint: 3))
    }

    /// An agent that has a maker's logo wears it unless the logo was turned off by hand;
    /// one with no logo is drawn as its avatar whatever its look says.
    @Test func anAgentWithALogoWearsItUnlessItWasTurnedOff() {
        let unchosen = AgentLook(shape: 1, face: 2, tint: 3)
        for logo in CodingAgentLogo.allCases {
            #expect(unchosen.shows(logo))
            // On from before the logo was the default, and turned off.
            #expect(AgentLook(shape: 1, face: 2, tint: 3, showsLogo: true).shows(logo))
            #expect(!AgentLook(shape: 1, face: 2, tint: 3, showsLogo: false).shows(logo))
        }
        #expect(!unchosen.shows(nil))
        #expect(!AgentLook(shape: 1, face: 2, tint: 3, showsLogo: true).shows(nil))
    }

    @Test func theSettingIsSavedWithTheLooks() throws {
        let scratch = Scratch()
        let looks = [
            // On, as saved before the logo was the default; and turned off by hand.
            claude: AgentLook(shape: 1, face: 2, tint: 3, showsLogo: true),
            codex: AgentLook(shape: 4, face: 0, tint: 5, showsLogo: false),
            karina: AgentLook(shape: 0, face: 1, tint: 6),
        ]
        scratch.store.saveLooks(looks, origins: [claude: .chosen, codex: .chosen])
        #expect(scratch.store.loadLooks() == looks)
        #expect(scratch.store.loadLookOrigins() == [claude: .chosen, codex: .chosen])
        // No choice is left out, so the file reads as before for every look without one.
        let text = try scratch.read("looks.json")
        #expect(text.components(separatedBy: "showsLogo").count == 3)
    }

    /// A look with the logo shown is chosen by hand, so the app never gives it another.
    @Test func aChosenLookKeepsItsLogo() {
        let catalogue = AgentLook.Catalogue(shapes: 8, faces: 6, tints: 12)
        let shown = AgentLook(shape: 2, face: 1, tint: 4, showsLogo: true)
        // Karina, earlier in the sidebar, is drawn the same.
        let saved = [karina: AgentLook(shape: 2, face: 0, tint: 4), claude: shown]
        let looks = AgentLook.assign(to: [karina, claude, codex], keeping: saved, origins: [karina: .chosen, claude: .chosen],
                                     in: catalogue, firstTint: 1)
        #expect(looks[claude] == shown)
        #expect(looks[codex]?.showsLogo == nil)
    }
}
