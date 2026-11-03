import Foundation
import Testing
@testable import AgentCore

/// A store in a fresh temporary folder, removed when the test ends.
private final class Scratch {
    let store: ThreadStore

    init() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("portals-folders-\(UUID().uuidString)")
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
}

private let mac = HostID(rawValue: "mac")
private let mini = HostID(rawValue: "mini")
private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

@Suite struct FolderTests {
    /// Aeri, the agent an older bridge may still run, is told apart, and listed nowhere. A
    /// Hermes profile of that name is not Aeri: what the bridge says the agent is decides.
    @Test func onlyAnOlderBridgesAeriIsAeri() {
        func agent(_ name: String, kind: String? = nil) -> Agent {
            Agent(id: Agent.ID(host: HostID(rawValue: "mac"), name: name), kind: kind)
        }
        #expect(agent("portals-aeri", kind: "aeri").isAeri)
        #expect(!agent("aeri", kind: "hermes").isAeri)
        #expect(!agent("claude", kind: "claude").isAeri)
        // An agent whose kind is not said is never taken for Aeri, whatever it is called.
        #expect(!agent("portals-aeri").isAeri)
        #expect(!agent("aeri").isAeri)
    }

    /// A Hermes profile is talked with: its new thread need not start by choosing a
    /// folder. What the bridge says the agent is decides.
    @Test func aHermesAgentNeedsNoFolder() {
        func agent(_ name: String, kind: String? = nil) -> Agent {
            Agent(id: Agent.ID(host: HostID(rawValue: "mac"), name: name), kind: kind)
        }
        #expect(agent("hermes", kind: "hermes").needsNoFolder(on: .bridge))
        // A Hermes profile can have a coding agent's name; a coding agent cannot be told otherwise.
        #expect(agent("pi", kind: "hermes").needsNoFolder(on: .bridge))
        for kind in ["claude", "codex", "pi", "cursor", "fake", "opencode"] {
            #expect(!agent("anything", kind: kind).needsNoFolder(on: .bridge))
        }
        // A bridge from before it said the kind: its coding agents by their names, the rest Hermes's.
        #expect(!agent("claude").needsNoFolder(on: .bridge))
        #expect(!agent("codex").needsNoFolder(on: .bridge))
        #expect(agent("hermes").needsNoFolder(on: .bridge))
        #expect(agent("wonyoung").needsNoFolder(on: .bridge))
        // On a Hermes host no agent chooses a folder at all: there is nothing to leave out.
        #expect(!agent("hanni").needsNoFolder(on: nil))
    }

    private let general = "/Users/dana/coding_projects"

    @Test func aFolderIsCalledByItsLastComponentOrNoProject() {
        #expect(Folder.name(of: "/Users/dana/coding_projects/aerirc", general: general) == "aerirc")
        #expect(Folder.name(of: general, general: general) == "No project")
        #expect(Folder.name(of: general, general: nil) == "coding_projects")
        #expect(Folder.name(of: "/Users/dana/My Project/", general: general) == "My Project")
        #expect(Folder.name(of: "/", general: general) == "/")
        #expect(Folder(path: "/Users/dana/coding_projects/aerirc").name == "aerirc")
        #expect(Folder(path: "/x/y", name: "  ").name == "y")
    }

    @Test func aHomeFolderReadsAsATilde() {
        #expect(Folder.tidyPath("/Users/dana/coding_projects") == "~/coding_projects")
        #expect(Folder.tidyPath("/Users/dana") == "~")
        #expect(Folder.tidyPath("/private/tmp/x") == "/private/tmp/x")
        // A Linux computer's home folder too.
        #expect(Folder.tidyPath("/home/dana/coding_projects") == "~/coding_projects")
        #expect(Folder.tidyPath("/home/dana") == "~")
        #expect(Folder.tidyPath("/home") == "/home")
        #expect(Folder.tidyPath("/Users") == "/Users")
    }

    @Test func aProjectNamedNoProjectIsNotTheHostsGeneralFolder() {
        let project = Folder(path: "/Users/dana/No project")
        let list = FolderList(general: Folder(path: general, name: Folder.generalName), recent: [project])
        #expect(list.general.isGeneral)
        #expect(!project.isGeneral && !list.recent[0].isGeneral)
        #expect(list.general.name == project.name)
    }

    @Test func aFolderIsFoundByNameOrPath() {
        let list = FolderList(
            general: Folder(path: general, name: Folder.generalName),
            recent: [Folder(path: "/Users/dana/coding_projects/aerirc", lastUsed: t0), Folder(path: "/Users/dana/notes")]
        )
        #expect(list.all.map(\.name) == ["No project", "aerirc", "notes"])
        #expect(list.folder(named: "no project")?.path == general)
        #expect(list.folder(named: "AERIRC")?.path == "/Users/dana/coding_projects/aerirc")
        #expect(list.folder(named: "/Users/dana/notes")?.name == "notes")
        #expect(list.folder(named: "elsewhere") == nil)
    }

    @Test func aThreadNamesItsFolder() {
        var ref = ThreadRef(id: ThreadRef.ID(rawValue: "t"), agent: Agent.ID(host: mac, name: "claude"))
        #expect(ref.folderName(general: general) == nil)
        ref.workingDirectory = general
        #expect(ref.folderName(general: general) == "No project")
        ref.workingDirectory = "/Users/dana/coding_projects/aerirc"
        #expect(ref.folderName(general: general) == "aerirc")
        ref.workingDirectory = ""
        #expect(ref.folderName(general: general) == nil)
    }

    @Test func aThreadKeepsItsFolderInTheStore() {
        let scratch = Scratch()
        let ref = ThreadRef(
            id: ThreadRef.ID(rawValue: "t"), agent: Agent.ID(host: mac, name: "claude"), title: "Fix", createdAt: t0,
            workingDirectory: "/Users/dana/coding_projects/aerirc"
        )
        scratch.store.saveThreads([ThreadRecord(ref: ref, updatedAt: t0)])
        #expect(scratch.store.loadThreads().first?.ref == ref)
    }

    /// Saved by the app before threads kept their folder (M13): every thread still loads.
    @Test func threadsSavedWithoutAFolderLoadInFull() throws {
        let scratch = Scratch()
        try scratch.write(Self.legacyThreads, to: "threads.json")
        let threads = scratch.store.loadThreads()
        #expect(threads.map(\.id.rawValue) == ["d79e5f20-1c34-42d6-af39-5d38504e8bab", "a3368c03-66f6-4675-94be-f1392512a4db"])
        #expect(threads.allSatisfy { $0.ref.workingDirectory == nil })
        #expect(threads[0].ref.title == "hello.txt line edit")
    }

    @Test func aHostRemembersItsGeneralFolderAndOldHostsHaveNone() throws {
        let scratch = Scratch()
        try scratch.write(#"[{"id":"mac","name":"MacBook","url":"http:\/\/127.0.0.1:9120","username":"dana","kind":"bridge"}]"#, to: "hosts.json")
        var hosts = scratch.store.loadHosts()
        #expect(hosts.first?.generalFolder == nil)
        #expect(hosts.first?.kind == .bridge)
        hosts[0].generalFolder = general
        scratch.store.saveHosts(hosts)
        #expect(scratch.store.loadHosts().first?.generalFolder == general)
    }

    static let legacyThreads = #"[{"context":{"limit":1000000,"used":26670},"preview":"In hello.txt change the line hi to hello.","ref":{"agent":{"host":"local","name":"claude"},"createdAt":"2026-10-07T02:14:51Z","id":"d79e5f20-1c34-42d6-af39-5d38504e8bab","title":"hello.txt line edit"},"updatedAt":"2026-10-07T02:15:11Z"},{"preview":"Please think.","ref":{"agent":{"host":"local","name":"fake"},"createdAt":"2026-10-06T23:22:04Z","id":"a3368c03-66f6-4675-94be-f1392512a4db"},"updatedAt":"2026-10-06T23:22:04Z"}]"#
}

@Suite struct ModelLevelTests {
    private let catalog = ModelCatalog(
        providers: [ModelProvider(id: "openai", name: "OpenAI", models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-mini"])],
        agentDefault: ModelSetting(model: "gpt-6.1-sol", provider: "openai", level: .high),
        levelsByModel: ["gpt-6-luna": [.low, .medium, .high, .extraHigh], "gpt-mini": [.high, .low], "gpt-odd": []]
    )

    @Test func aModelOffersTheLevelsTheHostListsWeakestFirst() {
        #expect(catalog.levels(for: "gpt-6-luna") == [.low, .medium, .high, .extraHigh])
        #expect(catalog.levels(for: "gpt-mini") == [.low, .high])
    }

    @Test func aModelTheHostSaysNothingAboutOffersEveryLevel() {
        #expect(catalog.levels(for: "gpt-6.1-sol") == ThinkingLevel.allCases)
        let hermes = ModelCatalog(providers: catalog.providers, agentDefault: catalog.agentDefault)
        #expect(hermes.levelsByModel == nil)
        #expect(hermes.levels(for: "gpt-6-luna") == ThinkingLevel.allCases)
    }

    /// The wire keeps an empty list only from a bridge with `model_levels_none`.
    @Test func aModelListedWithNoLevelsOffersNone() {
        #expect(catalog.levels(for: "gpt-odd").isEmpty)
        #expect(!catalog.takesLevels("gpt-odd"))
        #expect(catalog.takesLevels("gpt-6.1-sol"))
    }
}

/// Looks for every host's agents at once (`AgentLook.assign(to:keeping:origins:in:firstTint:)`).
@Suite struct FleetLookTests {
    /// The app's catalogue: 8 shapes, 6 faces, 12 colours of which the first (ink) is never given.
    private let catalogue = AgentLook.Catalogue(shapes: 8, faces: 6, tints: 12)

    private func agents(_ host: HostID, _ names: [String]) -> [Agent.ID] {
        names.map { Agent.ID(host: host, name: $0) }
    }

    private func pairs(_ looks: [Agent.ID: AgentLook]) -> [String] {
        looks.values.map { "\($0.shape)-\($0.tint)" }
    }

    /// The looks the app gave a host's agents when looks were assigned one host at a time.
    private func perHost(_ host: HostID, _ names: [String]) -> [Agent.ID: AgentLook] {
        let colours = AgentLook.Catalogue(shapes: 8, faces: 6, tints: 11)
        return Dictionary(uniqueKeysWithValues: AgentLook.assign(to: names, keeping: [:], in: colours).map {
            (Agent.ID(host: host, name: $0.key), AgentLook(shape: $0.value.shape, face: $0.value.face, tint: $0.value.tint + 1))
        })
    }

    @Test func oneHostGetsWhatItGotBefore() {
        let names = ["default", "aeri", "hanni", "wonyoung"]
        let looks = AgentLook.assign(to: agents(mini, names), keeping: [:], origins: [:], in: catalogue, firstTint: 1)
        #expect(looks == perHost(mini, names))
        #expect(looks.values.allSatisfy { $0.tint >= 1 })
    }

    @Test func agentsOnTwoHostsNeverShareAShapeAndColour() {
        // Every pairing of names that would have clashed host by host must come apart.
        let everyone = agents(mini, ["default", "aeri", "hanni", "wonyoung"]) + agents(mac, ["claude", "codex", "fake", "default"])
        let looks = AgentLook.assign(to: everyone, keeping: [:], origins: [:], in: catalogue, firstTint: 1)
        #expect(looks.count == 8)
        #expect(Set(pairs(looks)).count == 8)
        // On each host, as before, no shape or colour twice.
        for host in [mini, mac] {
            let own = looks.filter { $0.key.host == host }.values
            #expect(Set(own.map(\.shape)).count == own.count)
            #expect(Set(own.map(\.tint)).count == own.count)
        }
        // The order a host lists its agents in does not matter.
        let reordered = agents(mini, ["wonyoung", "hanni", "aeri", "default"]) + agents(mac, ["default", "fake", "codex", "claude"])
        #expect(AgentLook.assign(to: reordered, keeping: [:], origins: [:], in: catalogue, firstTint: 1) == looks)
    }

    @Test func theSameNameOnTwoHostsGetsTwoLooks() {
        let looks = AgentLook.assign(to: agents(mini, ["default"]) + agents(mac, ["default"]), keeping: [:], origins: [:], in: catalogue, firstTint: 1)
        #expect(looks[Agent.ID(host: mini, name: "default")] != looks[Agent.ID(host: mac, name: "default")])
        #expect(Set(pairs(looks)).count == 2)
    }

    @Test func aLookChosenByHandIsNeverChanged() {
        let karina = Agent.ID(host: mini, name: "default"), claude = Agent.ID(host: mac, name: "claude")
        let drop = AgentLook(shape: 7, face: 3, tint: 11)
        // Both chosen, the same: left as they are.
        let both = AgentLook.assign(
            to: [karina, claude], keeping: [karina: drop, claude: drop], origins: [karina: .chosen, claude: .chosen], in: catalogue, firstTint: 1
        )
        #expect(both == [karina: drop, claude: drop])
        // An ink look can be chosen, though the app never gives one.
        let ink = AgentLook(shape: 0, face: 0, tint: 0)
        #expect(AgentLook.assign(to: [claude], keeping: [claude: ink], origins: [claude: .chosen], in: catalogue, firstTint: 1)[claude] == ink)
    }

    @Test func aGivenLookThatClashesWithAnEarlierAgentMoves() {
        let karina = Agent.ID(host: mini, name: "default"), claude = Agent.ID(host: mac, name: "claude")
        let drop = AgentLook(shape: 7, face: 3, tint: 11)
        let looks = AgentLook.assign(
            to: [karina, claude], keeping: [karina: drop, claude: drop], origins: [karina: .assigned, claude: .assigned], in: catalogue, firstTint: 1
        )
        // The first host keeps its look; the later one moves.
        #expect(looks[karina] == drop)
        #expect(looks[claude] != drop)
        #expect(Set(pairs(looks)).count == 2)
        // A chosen look wins over an earlier given one.
        let chosen = AgentLook.assign(
            to: [karina, claude], keeping: [karina: drop, claude: drop], origins: [karina: .assigned, claude: .chosen], in: catalogue, firstTint: 1
        )
        #expect(chosen[claude] == drop)
        #expect(chosen[karina] != drop)
    }

    /// Looks saved by the app before it kept who chose them (M13): the one host's looks
    /// given host by host clashed with another's. Only a look that is exactly what the
    /// app gave counts as the app's.
    @Test func anOldGivenLookIsToldFromAChosenOne() {
        var saved = perHost(mini, ["default", "aeri"]).merging(perHost(mac, ["claude", "codex"])) { first, _ in first }
        let karina = Agent.ID(host: mini, name: "default"), claude = Agent.ID(host: mac, name: "claude")
        let everyone = agents(mini, ["default", "aeri"]) + agents(mac, ["claude", "codex"])

        // Untouched when nothing clashes.
        let hermes = perHost(mini, ["default", "aeri"])
        #expect(AgentLook.assign(to: agents(mini, ["default", "aeri"]), keeping: hermes, origins: [:], in: catalogue, firstTint: 1) == hermes)

        // The clash seen in M13 (the bridge's Claude Code drawn like Hermes's default),
        // here with Karina's look set to Claude's.
        saved[karina] = saved[claude]
        // Claude's is what the app gives it: the app's, so it moves. Karina's is not what
        // the app gives her: it may have been chosen, so it stays.
        let looks = AgentLook.assign(to: everyone, keeping: saved, origins: [:], in: catalogue, firstTint: 1)
        #expect(looks[karina] == saved[karina])
        #expect(looks[claude] != saved[claude])
        #expect(Set(pairs(looks)).count == 4)
    }

    /// The M13 case: each host's looks given host by host, both the app's, one agent on
    /// each drawn the same. The later host's agent moves.
    @Test func whenTwoOldGivenLooksClashTheLaterHostsAgentMoves() throws {
        let karina = Agent.ID(host: mini, name: "default")
        let given = try #require(perHost(mini, ["default"])[karina])
        // An agent name the app gives the same look on a host of its own.
        let twin = try #require((0..<5000).lazy.map { "agent\($0)" }.first { perHost(mac, [$0])[Agent.ID(host: mac, name: $0)] == given })
        let other = Agent.ID(host: mac, name: twin)
        let looks = AgentLook.assign(to: [karina, other], keeping: [karina: given, other: given], origins: [:], in: catalogue, firstTint: 1)
        #expect(looks[karina] == given)
        #expect(looks[other] != given)
        #expect(looks[other].map { $0.shape != given.shape || $0.tint != given.tint } == true)
    }

    @Test func newAgentsAvoidEveryOtherHost() {
        let hermes = perHost(mini, ["default", "aeri", "hanni", "wonyoung"])
        let everyone = agents(mini, ["default", "aeri", "hanni", "wonyoung"]) + agents(mac, ["claude", "codex"])
        let looks = AgentLook.assign(to: everyone, keeping: hermes, origins: [:], in: catalogue, firstTint: 1)
        #expect(looks.filter { $0.key.host == mini } == hermes)
        #expect(Set(pairs(looks)).count == 6)
        // And prefer a colour no agent has yet.
        let hermesTints = Set(hermes.values.map(\.tint))
        #expect(looks.filter { $0.key.host == mac }.values.allSatisfy { !hermesTints.contains($0.tint) })
    }

    @Test func moreAgentsThanPairingsStillGetLooks() {
        let small = AgentLook.Catalogue(shapes: 2, faces: 1, tints: 2)
        let looks = AgentLook.assign(to: agents(mini, ["a", "b", "c"]) + agents(mac, ["d", "e"]), keeping: [:], origins: [:], in: small)
        #expect(looks.count == 5)
        #expect(Set(pairs(looks)).count == 4)
    }

    @Test func originsAreSavedWithTheLooksAndOldFilesHaveNone() throws {
        let scratch = Scratch()
        try scratch.write(#"[{"agent":{"host":"local","name":"claude"},"look":{"face":3,"shape":7,"tint":11}}]"#, to: "looks.json")
        let claude = Agent.ID(host: HostID(rawValue: "local"), name: "claude")
        #expect(scratch.store.loadLooks() == [claude: AgentLook(shape: 7, face: 3, tint: 11)])
        #expect(scratch.store.loadLookOrigins().isEmpty)

        let codex = Agent.ID(host: HostID(rawValue: "local"), name: "codex")
        let looks = [claude: AgentLook(shape: 1, face: 2, tint: 3), codex: AgentLook(shape: 4, face: 0, tint: 5)]
        scratch.store.saveLooks(looks, origins: [claude: .chosen])
        #expect(scratch.store.loadLooks() == looks)
        #expect(scratch.store.loadLookOrigins() == [claude: .chosen])
        // Forgetting a host keeps the others' origins.
        scratch.store.saveLooks(looks.merging([Agent.ID(host: mini, name: "aeri"): AgentLook(shape: 0, face: 0, tint: 1)]) { a, _ in a },
                                origins: [claude: .chosen, Agent.ID(host: mini, name: "aeri"): .assigned])
        scratch.store.forgetHost(mini)
        #expect(scratch.store.loadLooks() == looks)
        #expect(scratch.store.loadLookOrigins() == [claude: .chosen])
    }

}
