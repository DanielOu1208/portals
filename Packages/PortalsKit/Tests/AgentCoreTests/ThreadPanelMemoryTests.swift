import Foundation
import Testing
@testable import AgentCore

/// What the panels keep of what hosts said (`ThreadPanelMemory`), asked of a host whose
/// answers come only when a test lets them, in whatever order it lets them.
@MainActor
@Suite struct ThreadPanelMemoryTests {
    /// Each call waits for its turn: `answer(call, with:)` lets the `call`th one, from 0, end.
    private actor Host: ThreadPanelProviding {
        var readsUsage: Bool? { true }
        var readsGitStatus: Bool? { true }
        var opensFolders: Bool? { true }

        private(set) var calls = 0
        private var waiting: [Int: CheckedContinuation<Result<Answer, Error>, Never>] = [:]

        enum Answer {
            case usage(UsageLimits?)
            case git(GitState)
            case apps([HostApp])
        }

        private func wait() async -> Result<Answer, Error> {
            let call = calls
            calls += 1
            return await withCheckedContinuation { waiting[call] = $0 }
        }

        func answer(_ call: Int, with result: Result<Answer, Error>) {
            waiting.removeValue(forKey: call)?.resume(returning: result)
        }

        func usage(of thread: ThreadRef.ID) async throws -> UsageLimits? {
            guard case let .usage(limits) = try await wait().get() else { throw ThreadPanelError.unavailable }
            return limits
        }

        func gitStatus(of thread: ThreadRef.ID) async throws -> GitState {
            guard case let .git(state) = try await wait().get() else { throw ThreadPanelError.unavailable }
            return state
        }

        func gitDiff(of thread: ThreadRef.ID) async throws -> (root: String, diff: TurnDiff, total: Int) {
            throw ThreadPanelError.unavailable
        }

        func hostApps() async throws -> [HostApp] {
            guard case let .apps(apps) = try await wait().get() else { throw ThreadPanelError.unavailable }
            return apps
        }

        func openFolder(of thread: ThreadRef.ID, in app: HostApp.ID) async throws {}
    }

    private let hostID = HostID(rawValue: "mac")
    private var agent: Agent.ID { Agent.ID(host: hostID, name: "claude") }
    private var key: ThreadKey { ThreadKey(host: hostID, id: ThreadRef.ID(rawValue: "t")) }

    private func scratchFile() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "panel-memory-\(UUID().uuidString).json")
    }

    /// Until `done` is true: given a minute, so only a hang ends it, and the checks after it
    /// then fail.
    private func waitUntil(_ done: () async -> Bool) async throws {
        let until = ContinuousClock.now + .seconds(60)
        while await !done(), ContinuousClock.now < until {
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    private func status(branch: String) -> GitState {
        .status(GitStatus(branch: branch, commit: "abc", files: []))
    }

    /// As a panel opening and a turn ending do: two asks at once, the later one answered first.
    @Test func anOlderGitAnswerDoesNotOverwriteANewerOne() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let older = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 1 }
        let newer = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 2 }

        await host.answer(1, with: .success(.git(status(branch: "newer"))))
        try await newer.value
        #expect(memory.git[key] == status(branch: "newer"))

        await host.answer(0, with: .success(.git(status(branch: "older"))))
        try await older.value
        #expect(memory.git[key] == status(branch: "newer"))
    }

    /// The later ask failed: the earlier one's answer is still newer than what was known.
    @Test func anOlderGitAnswerStandsWhenTheNewerAskFailed() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let older = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 1 }
        let newer = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 2 }

        await host.answer(1, with: .failure(ThreadPanelError.refused("no")))
        await #expect(throws: ThreadPanelError.self) { try await newer.value }
        await host.answer(0, with: .success(.git(status(branch: "older"))))
        try await older.value
        #expect(memory.git[key] == status(branch: "older"))
    }

    private func limits(percent: Double = 40, resetsIn: TimeInterval = 3600, heardAt: Date? = nil) -> UsageLimits {
        UsageLimits(windows: [.init(name: "5-hour", percent: percent, resetsAt: Date.now.addingTimeInterval(resetsIn), length: 5 * 3600)], heardAt: heardAt)
    }

    /// One ask of `host`, answered with `result`, its own error swallowed as a panel's is.
    private func ask(_ memory: ThreadPanelMemory, _ host: Host, with result: Result<Host.Answer, Error>) async throws {
        let calls = await host.calls
        let asking = Task { try? await memory.askUsage(of: agent, thread: key.id, from: host) }
        try await waitUntil { await host.calls == calls + 1 }
        await host.answer(calls, with: result)
        await asking.value
    }

    /// The numbers stay on screen, the sentence beside them, until the agent next answers.
    @Test func aFailedAskKeepsItsSentenceBesideTheNumbersUntilAnAnswer() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let known = limits()
        try await ask(memory, host, with: .success(.usage(known)))
        #expect(memory.usageFailures[agent] == nil)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)

        memory.connected(to: hostID)
        try await ask(memory, host, with: .failure(ThreadPanelError.refused("Droid's sign-in has expired.")))
        #expect(memory.usage[agent] == .some(known))
        #expect(memory.usageFailures[agent] == "Droid's sign-in has expired.")
        #expect(memory.usageAsOf(of: agent, isConnected: true) != nil)

        try await ask(memory, host, with: .success(.usage(known)))
        #expect(memory.usageFailures[agent] == nil)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
    }

    @Test func numbersFromAnEarlierConnectionSayWhenTheyWereHeard() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let before = Date.now
        try await ask(memory, host, with: .success(.usage(limits())))
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
        // The connection is gone.
        let heard = try #require(memory.usageAsOf(of: agent, isConnected: false))
        #expect(heard >= before)

        // Back: as before, until it answers, and it is asked though it answered a moment ago.
        memory.connected(to: hostID)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == heard)
        try await ask(memory, host, with: .success(.usage(limits())))
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)

        // Limits the host itself says are as last heard.
        memory.connected(to: hostID)
        let said = Date.now.addingTimeInterval(-3600)
        try await ask(memory, host, with: .success(.usage(limits(heardAt: said))))
        #expect(memory.usageAsOf(of: agent, isConnected: true) == said)
    }

    /// A usage ask under way as the host's connection begins again comes back, answer or
    /// failure, after the new connection has answered: its word is the older one.
    @Test func anAnswerFromAnEarlierConnectionDoesNotOverwriteANewerOne() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let older = Task { try await memory.askUsage(of: agent, thread: key.id, from: host) }
        try await waitUntil { await host.calls == 1 }

        memory.connected(to: hostID)
        try await ask(memory, host, with: .success(.usage(limits(percent: 90))))
        #expect(memory.usage[agent]??.windows.first?.percent == 90)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)

        await host.answer(0, with: .success(.usage(limits(percent: 10))))
        try await older.value
        #expect(memory.usage[agent]??.windows.first?.percent == 90)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
    }

    @Test func aFailureFromAnEarlierConnectionSaysNothingOfTheNewOne() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        let older = Task { try await memory.askUsage(of: agent, thread: key.id, from: host) }
        try await waitUntil { await host.calls == 1 }

        memory.connected(to: hostID)
        try await ask(memory, host, with: .success(.usage(limits(percent: 90))))
        await host.answer(0, with: .failure(ThreadPanelError.refused("The connection was closed.")))
        // Not the panel's to say either.
        try await older.value
        #expect(memory.usageFailures[agent] == nil)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
    }

    /// Nothing heard yet on the new connection: an older answer is no more borne out by it,
    /// and what was known stays, of the age it was.
    @Test func anAnswerFromAnEarlierConnectionIsNotMarkedCurrent() async throws {
        let memory = ThreadPanelMemory(file: scratchFile())
        let host = Host()
        try await ask(memory, host, with: .success(.usage(limits(percent: 40))))
        memory.connected(to: hostID)
        let heard = try #require(memory.usageAsOf(of: agent, isConnected: true))
        let older = Task { try await memory.askUsage(of: agent, thread: key.id, from: host) }
        try await waitUntil { await host.calls == 2 }

        memory.connected(to: hostID)
        await host.answer(1, with: .success(.usage(limits(percent: 10))))
        try await older.value
        #expect(memory.usage[agent]??.windows.first?.percent == 40)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == heard)

        // And it does not hold back the ask the new connection makes.
        try await ask(memory, host, with: .success(.usage(limits(percent: 50))))
        #expect(memory.usage[agent]??.windows.first?.percent == 50)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
    }

    /// Until `file` has been saved with `what` in it: a save comes a moment after the change.
    private func waitForSave(of file: URL, _ what: (String) -> Bool) async throws {
        try await waitUntil { (try? String(contentsOf: file, encoding: .utf8)).map(what) ?? false }
    }

    @Test func savedNumbersComeBackOldUntilAnAnswerAndThoseOfAResetWindowDoNot() async throws {
        let file = scratchFile()
        let host = Host()
        let memory = ThreadPanelMemory(file: file)
        let before = Date.now
        try await ask(memory, host, with: .success(.usage(limits())))
        try await waitForSave(of: file) { $0.contains("5-hour") }

        let launched = ThreadPanelMemory(file: file)
        #expect(launched.usage[agent] != nil)
        let heard = try #require(launched.usageAsOf(of: agent, isConnected: true))
        #expect(heard >= before)

        let reset = Host()
        let resetFile = scratchFile()
        let shortly = ThreadPanelMemory(file: resetFile)
        try await ask(shortly, reset, with: .success(.usage(limits(resetsIn: 0.05))))
        try await waitForSave(of: resetFile) { $0.contains("5-hour") }
        try await Task.sleep(for: .milliseconds(100))
        #expect(ThreadPanelMemory(file: resetFile).usage[agent] == nil)
    }

    @Test func forgettingAHostDropsAllOfItAndWhatIsStillComing() async throws {
        let file = scratchFile()
        let memory = ThreadPanelMemory(file: file)
        let host = Host()
        let other = Agent.ID(host: HostID(rawValue: "other"), name: "claude")
        let otherKey = ThreadKey(host: other.host, id: key.id)

        try await ask(memory, host, with: .success(.usage(limits())))
        let asking = Task { await memory.askApps(on: hostID, from: host) }
        try await waitUntil { await host.calls == 2 }
        await host.answer(1, with: .success(.apps([HostApp(id: "zed", name: "Zed", kind: .editor)])))
        await asking.value
        let gitAsk = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 3 }
        await host.answer(2, with: .success(.git(status(branch: "main"))))
        try await gitAsk.value

        let otherHost = Host()
        let otherAsk = Task { try await memory.askUsage(of: other, thread: otherKey.id, from: otherHost) }
        try await waitUntil { await otherHost.calls == 1 }
        await otherHost.answer(0, with: .success(.usage(limits())))
        try await otherAsk.value

        // An ask under way when it is forgotten.
        let late = Task { try await memory.askGit(of: key, from: host) }
        try await waitUntil { await host.calls == 4 }

        memory.forget(host: hostID)
        #expect(memory.usage[agent] == nil)
        #expect(memory.apps[hostID] == nil)
        #expect(memory.git[key] == nil)
        #expect(memory.usageAsOf(of: agent, isConnected: true) == nil)
        #expect(memory.usage[other] != nil)

        await host.answer(3, with: .success(.git(status(branch: "other mac"))))
        try await late.value
        #expect(memory.git[key] == nil)

        try await waitForSave(of: file) { !$0.contains("mac") && $0.contains("other") }
        let launched = ThreadPanelMemory(file: file)
        #expect(launched.usage[agent] == nil)
        #expect(launched.usage[other] != nil)
    }

    // MARK: A window, read

    /// Worked out at the time heard, an old percent is not more in reserve as time goes by.
    @Test func paceAtTheTimeHeardDoesNotGrowWithTheTimeSince() throws {
        let heard = Date(timeIntervalSince1970: 1_000_000)
        let window = UsageLimits.Window(name: "5-hour", percent: 60, resetsAt: heard.addingTimeInterval(2 * 3600), length: 5 * 3600)
        let atHeard = try #require(window.pace(at: heard))
        #expect(abs(atHeard.reserve) < 0.001)
        let later = try #require(window.pace(at: heard.addingTimeInterval(1.5 * 3600)))
        #expect(later.reserve > 29)
    }

    @Test func aWindowPastItsResetSaysNothingOfItsOldNumbers() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let window = UsageLimits.Window(name: "5-hour", percent: 100, resetsAt: now.addingTimeInterval(-1), reached: true, length: 5 * 3600)
        #expect(window.hasReset(at: now))
        #expect(!window.hasReset(at: now.addingTimeInterval(-2)))
        #expect(window.pace(at: now) == nil)
        #expect(!UsageLimits.Window(name: "weekly", percent: 3, resetsAt: nil).hasReset(at: now))
    }

    /// Claude's last heard limits say reached only when turned away.
    @Test func aFullWindowIsUsedUpNotAboutToRunOut() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        for percent in [100.0, 120.0] {
            let window = UsageLimits.Window(name: "5-hour", percent: percent, resetsAt: now.addingTimeInterval(3600), reached: false, length: 5 * 3600)
            #expect(window.isUsedUp)
            #expect(window.left == 0)
            #expect(window.pace(at: now) == nil)
        }
        let nearly = UsageLimits.Window(name: "5-hour", percent: 99, resetsAt: now.addingTimeInterval(3600), reached: false, length: 5 * 3600)
        #expect(!nearly.isUsedUp)
        #expect(nearly.pace(at: now)?.runsOutAt != nil)
    }
}
