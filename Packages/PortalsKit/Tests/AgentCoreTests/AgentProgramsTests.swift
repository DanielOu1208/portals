import Foundation
import Testing
@testable import AgentCore

/// What Settings > Agents makes of what hosts say of their programs (`AgentProgram`,
/// `AgentSettingsRowItem`, `AgentProgramsMemory`).
@MainActor
@Suite struct AgentProgramsTests {
    private let hostID = HostID(rawValue: "mac")

    private func agent(_ name: String, kind: String? = nil) -> Agent {
        Agent(id: Agent.ID(host: hostID, name: name), kind: kind)
    }

    // MARK: How one stands

    @Test func whatARowSaysGoesFromWhatMattersMost() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var program = AgentProgram(id: "pi", name: "Pi", version: "0.9.0", standing: .tooOld, minimum: "1.1.0", canUpdate: true, latest: "1.5.0", updateAvailable: true)
        #expect(program.state == .tooOld(needs: "1.1.0"))
        program.update = .init(state: .failed, startedAt: start, tail: "npm ERR!")
        #expect(program.state == .updateFailed)
        program.update = .init(state: .running, startedAt: start)
        #expect(program.state == .updating)
        program.update = nil
        program.standing = .tested
        #expect(program.state == .updateAvailable("1.5.0"))
        program.updateAvailable = false
        #expect(program.state == .upToDate)
        // Nothing said rather than a guess.
        program.updateAvailable = nil
        #expect(program.state == .unknown)
        program.isInstalled = false
        #expect(program.state == .notFound)
    }

    /// Without a later release known, the button stays: the updater itself looks. Known to be
    /// on the latest, or updating already, or an installation the host cannot update: none.
    @Test func updatingIsOfferedOnlyWhereItCanDoAnything() {
        var program = AgentProgram(id: "codex", name: "Codex", canUpdate: true)
        #expect(program.offersUpdate)
        program.updateAvailable = true
        #expect(program.offersUpdate)
        program.updateAvailable = false
        #expect(!program.offersUpdate)
        program.updateAvailable = true
        program.update = .init(state: .running, startedAt: .now)
        #expect(!program.offersUpdate)
        program.update = nil
        program.canUpdate = false
        #expect(!program.offersUpdate)
    }

    // MARK: Rows

    @Test func aHermesHostsBotsAreOneRowAndEachProgramComesWhereItsFirstAgentDoes() {
        let agents = [agent("atlas", kind: "hermes"), agent("claude", kind: "claude"), agent("juno", kind: "hermes"), agent("fake", kind: "fake"), agent("codex", kind: "codex")]
        let programs = [
            AgentProgram(id: "claude", name: "Claude Code", agents: ["claude"]),
            AgentProgram(id: "codex", name: "Codex", agents: ["codex"]),
            // Installed, with no agent here: after them.
            AgentProgram(id: "pi", name: "Pi"),
            AgentProgram(id: "hermes", name: "Hermes", agents: ["atlas", "juno"]),
        ]
        let rows = AgentSettingsRowItem.rows(agents: agents, programs: programs, hostLists: true)
        #expect(rows.map(\.id) == ["program-hermes", "program-claude", "agent-fake", "program-codex", "program-pi"])
        #expect(rows[0].agents.map(\.id.name) == ["atlas", "juno"])
        #expect(rows[4].agents.isEmpty)
    }

    /// An older host says no kind of program, and its rows are the agents as they always were.
    @Test func aHostThatDoesNotListProgramsKeepsItsAgentsRows() {
        let agents = [agent("atlas", kind: "hermes"), agent("juno", kind: "hermes"), agent("claude", kind: "claude"), agent("plain")]
        let rows = AgentSettingsRowItem.rows(agents: agents, programs: nil, hostLists: false)
        #expect(rows.map(\.id) == ["agent-atlas", "agent-juno", "agent-claude", "agent-plain"])
    }

    /// While a host that lists them has yet to answer: the same rows as it will have, in their
    /// places, so that nothing jumps as it does.
    @Test func aHostYetToAnswerHasTheRowsItWillHave() {
        let agents = [agent("atlas", kind: "hermes"), agent("juno", kind: "hermes"), agent("claude", kind: "claude"), agent("plain")]
        let rows = AgentSettingsRowItem.rows(agents: agents, programs: nil, hostLists: true)
        #expect(rows.map(\.id) == ["program-hermes", "program-claude", "agent-plain"])
        #expect(rows[0].kind == .program("hermes", nil))
    }

    // MARK: Memory

    /// Each call waits for its turn: `answer(call, with:)` lets the `call`th one, from 0, end.
    private actor Host: AgentProgramsProviding {
        var listsPrograms: Bool? { true }
        private(set) var calls = 0
        private(set) var usageAsked: [String] = []
        private var waiting: [Int: CheckedContinuation<Result<[AgentProgram], Error>, Never>] = [:]

        private func wait() async -> Result<[AgentProgram], Error> {
            let call = calls
            calls += 1
            return await withCheckedContinuation { waiting[call] = $0 }
        }

        func answer(_ call: Int, with result: Result<[AgentProgram], Error>) {
            waiting.removeValue(forKey: call)?.resume(returning: result)
        }

        func agentPrograms() async throws -> [AgentProgram] {
            try await wait().get()
        }

        func updateProgram(_ id: AgentProgram.ID) async throws -> AgentProgram {
            let list = try await wait().get()
            return try #require(list.first { $0.id == id })
        }

        func usage(ofAgent name: String) async throws -> UsageLimits? {
            usageAsked.append(name)
            return UsageLimits(windows: [.init(name: "5-hour", percent: 42, resetsAt: nil)])
        }
    }

    private func waitUntil(_ done: () async -> Bool) async throws {
        let until = ContinuousClock.now + .seconds(60)
        while await !done(), ContinuousClock.now < until {
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    @Test func oneThatCannotBeAskedKeepsWhatItHadAndSaysWhy() async throws {
        let memory = AgentProgramsMemory()
        let host = Host()
        let known = AgentProgram(id: "claude", name: "Claude Code", version: "2.1.318")
        let first = Task { await memory.ask(on: hostID, from: host) }
        try await waitUntil { await host.calls == 1 }
        await host.answer(0, with: .success([known]))
        await first.value
        #expect(memory.programs[hostID] == [known])

        let second = Task { await memory.ask(on: hostID, from: host) }
        try await waitUntil { await host.calls == 2 }
        await host.answer(1, with: .failure(ThreadPanelError.refused("Not now.")))
        await second.value
        #expect(memory.programs[hostID] == [known])
        #expect(memory.failures[hostID] == "Not now.")

        let third = Task { await memory.ask(on: hostID, from: host) }
        try await waitUntil { await host.calls == 3 }
        await host.answer(2, with: .success([known]))
        await third.value
        #expect(memory.failures[hostID] == nil)
    }

    /// A list asked for before an update began, answering after it did, does not say it has not.
    @Test func anOlderAnswerDoesNotUndoAnUpdateBegun() async throws {
        let memory = AgentProgramsMemory()
        let host = Host()
        let idle = AgentProgram(id: "claude", name: "Claude Code", version: "2.1.300")
        var running = idle
        running.update = .init(state: .running, startedAt: .now)

        let listing = Task { await memory.ask(on: hostID, from: host) }
        try await waitUntil { await host.calls == 1 }
        let updating = Task { try await memory.update("claude", on: hostID, from: host) }
        try await waitUntil { await host.calls == 2 }
        await host.answer(1, with: .success([running]))
        try await updating.value
        #expect(memory.isUpdating(on: hostID))
        await host.answer(0, with: .success([idle]))
        await listing.value
        #expect(memory.isUpdating(on: hostID))
        #expect(memory.program("claude", on: hostID) == running)
    }

    @Test func anUpdateRefusedThrowsTheHostsSentenceAndChangesNothing() async throws {
        let memory = AgentProgramsMemory()
        let host = Host()
        let updating = Task { try await memory.update("claude", on: hostID, from: host) }
        try await waitUntil { await host.calls == 1 }
        await host.answer(0, with: .failure(ThreadPanelError.refused("To update it, run claude update on this host.")))
        await #expect(throws: ThreadPanelError.refused("To update it, run claude update on this host.")) { try await updating.value }
        #expect(memory.programs[hostID] == nil)
    }

    @Test func whatAForgottenHostAnswersIsNotKept() async throws {
        let memory = AgentProgramsMemory()
        let host = Host()
        let listing = Task { await memory.ask(on: hostID, from: host) }
        try await waitUntil { await host.calls == 1 }
        memory.forget(host: hostID)
        await host.answer(0, with: .success([AgentProgram(id: "claude", name: "Claude Code")]))
        await listing.value
        #expect(memory.programs[hostID] == nil)
    }

    /// With no thread to ask through, what an agent says goes apart from what a thread's panel
    /// goes by: a Hermes bot's default provider is not that of a thread on another.
    @Test func usageAskedByAgentIsNotAThreadsWord() async throws {
        let memory = ThreadPanelMemory(file: FileManager.default.temporaryDirectory.appending(path: "programs-\(UUID().uuidString).json"))
        let host = Host()
        let claude = Agent.ID(host: hostID, name: "claude")
        try await memory.askUsage(of: claude, from: host)
        #expect(await host.usageAsked == ["claude"])
        #expect(memory.usage[claude] == nil)
        #expect(memory.pageUsage(of: claude)?.windows.first?.percent == 42)
        // Not again meanwhile, as with a thread's.
        try await memory.askUsage(of: claude, from: host)
        #expect(await host.usageAsked == ["claude"])

        // A thread's own says nothing of the bot's, and goes on saying what it said.
        let panel = ThreadHost(percent: 90)
        try await memory.askUsage(of: claude, thread: ThreadRef.ID(rawValue: "t"), from: panel)
        #expect((memory.usage[claude] ?? nil)?.windows.first?.percent == 90)
        #expect(memory.pageUsage(of: claude)?.windows.first?.percent == 42)
    }

    /// A host that cannot be asked with no thread: the page goes by what its chats have heard.
    @Test func thePageGoesByWhatChatsHeardUntilItsOwnAnswerComes() async throws {
        let memory = ThreadPanelMemory(file: FileManager.default.temporaryDirectory.appending(path: "programs-\(UUID().uuidString).json"))
        let claude = Agent.ID(host: hostID, name: "claude")
        #expect(memory.pageUsage(of: claude) == nil)
        try await memory.askUsage(of: claude, thread: ThreadRef.ID(rawValue: "t"), from: ThreadHost(percent: 90))
        #expect(memory.pageUsage(of: claude)?.windows.first?.percent == 90)
        try await memory.askUsage(of: claude, from: Host())
        #expect(memory.pageUsage(of: claude)?.windows.first?.percent == 42)
        memory.forget(host: hostID)
        #expect(memory.pageUsage(of: claude) == nil)
    }

    private struct ThreadHost: ThreadPanelProviding {
        let percent: Double
        var readsUsage: Bool? { true }
        var readsGitStatus: Bool? { false }
        var opensFolders: Bool? { false }
        func usage(of thread: ThreadRef.ID) async throws -> UsageLimits? {
            UsageLimits(windows: [.init(name: "5-hour", percent: percent, resetsAt: nil)])
        }
        func gitStatus(of thread: ThreadRef.ID) async throws -> GitState { .noRepository }
        func gitDiff(of thread: ThreadRef.ID) async throws -> (root: String, diff: TurnDiff, total: Int) { throw ThreadPanelError.unavailable }
        func hostApps() async throws -> [HostApp] { [] }
        func openFolder(of thread: ThreadRef.ID, in app: HostApp.ID) async throws {}
    }

    // MARK: Its line

    @Test func aLaterReleaseIsAnArrowOnItsOneLineAndWordsToVoiceOver() {
        var program = AgentProgram(id: "codex", name: "Codex", version: "0.166.0", latest: "0.170.2", updateAvailable: true)
        #expect(program.stateLine == "0.166.0 → 0.170.2")
        #expect(program.spokenStateLine == "0.166.0, update available: 0.170.2")
        program.updateAvailable = false
        #expect(program.stateLine == "0.166.0 · Up to date")
        #expect(program.spokenStateLine == "0.166.0, Up to date")
        program.updateAvailable = nil
        #expect(program.stateLine == "0.166.0")
        program.update = .init(state: .running, startedAt: .now)
        #expect(program.stateLine == "0.166.0 · Updating…")
        program.update = nil
        program.isInstalled = false
        program.version = nil
        #expect(program.stateLine == "Not found on this host")
    }

    /// A later release known with no version to set beside it says so in words.
    @Test func aLaterReleaseWithNoKnownVersionIsWords() {
        let program = AgentProgram(id: "hermes", name: "Hermes", latest: "0.22.7", updateAvailable: true)
        #expect(program.stateLine == "Update available: 0.22.7")
    }
}
