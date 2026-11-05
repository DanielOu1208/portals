import Foundation
import Observation

// What Settings > Agents shows of each host: the program behind its agents, its version and
// how to update it. A Portals bridge's `agent_programs`; any other host has none of it, and
// keeps the rows it always had, one for each of its agents.

/// The program of a coding agent, or Hermes, on a host, as the host says it.
public struct AgentProgram: Hashable, Sendable, Identifiable {
    /// Where its version stands against what Portals was tested with.
    public enum Standing: String, Hashable, Sendable {
        case tested, newer, untested, tooOld = "too old", missing
    }

    /// How it was installed.
    public enum InstallMethod: String, Hashable, Sendable {
        case own, npm, homebrew, app, other
    }

    /// When threads at work move to a release it was updated to.
    public enum TakesEffect: String, Hashable, Sendable {
        /// As each thread's process next starts.
        case nextStart = "next_start"
        /// As a service that stays up restarts, which nothing here does: Codex's, OpenCode's.
        case serviceRestart = "service_restart"
        /// As its own update restarts what runs on it: Hermes and its bots.
        case botsRestart = "gateway_restart"
    }

    /// The last update since the host started.
    public struct Update: Hashable, Sendable {
        public enum State: String, Hashable, Sendable {
            case running, done, failed
        }

        public var state: State
        public var startedAt: Date
        public var endedAt: Date?
        public var from: String?
        public var to: String?
        public var timedOut: Bool
        /// While it runs, the last thing it printed.
        public var line: String?
        /// Of a failed one, the end of what it printed.
        public var tail: String?
        /// Running with nothing to hold it to its time, what looked after it on the host having gone.
        public var isUnattended: Bool

        public init(state: State, startedAt: Date, endedAt: Date? = nil, from: String? = nil, to: String? = nil, timedOut: Bool = false, line: String? = nil, tail: String? = nil, isUnattended: Bool = false) {
            self.state = state
            self.startedAt = startedAt
            self.endedAt = endedAt
            self.from = from
            self.to = to
            self.timedOut = timedOut
            self.line = line
            self.tail = tail
            self.isUnattended = isUnattended
        }
    }

    /// What is worth saying of it on its row, at a glance.
    public enum State: Hashable, Sendable {
        case notFound
        case updating
        case updateFailed
        /// Older than Portals runs, which needs this release or newer.
        case tooOld(needs: String?)
        case updateAvailable(String)
        case upToDate
        /// Nothing known beyond its version: a later release could not be found.
        case unknown
    }

    /// `claude`, `codex`, `hermes`: an agent's `kind`.
    public var id: String
    public var name: String
    public var isInstalled: Bool
    public var version: String?
    /// nil for a word this app does not know.
    public var standing: Standing?
    public var tested: [String]
    public var minimum: String?
    public var how: InstallMethod?
    /// The host can update it itself.
    public var canUpdate: Bool
    /// What updates it, or what to run on the host where the host cannot.
    public var command: String?
    /// The latest release, where it could be found.
    public var latest: String?
    /// Whether `latest` is later than `version`; nil where that cannot be said.
    public var updateAvailable: Bool?
    /// The names of the host's agents it runs.
    public var agents: [String]
    public var takesEffect: TakesEffect
    /// What a service that stays up runs, where that is not `version`.
    public var runningVersion: String?
    public var update: Update?

    public init(
        id: String, name: String, isInstalled: Bool = true, version: String? = nil, standing: Standing? = nil, tested: [String] = [], minimum: String? = nil,
        how: InstallMethod? = nil, canUpdate: Bool = false, command: String? = nil, latest: String? = nil, updateAvailable: Bool? = nil,
        agents: [String] = [], takesEffect: TakesEffect = .nextStart, runningVersion: String? = nil, update: Update? = nil
    ) {
        self.id = id
        self.name = name
        self.isInstalled = isInstalled
        self.version = version
        self.standing = standing
        self.tested = tested
        self.minimum = minimum
        self.how = how
        self.canUpdate = canUpdate
        self.command = command
        self.latest = latest
        self.updateAvailable = updateAvailable
        self.agents = agents
        self.takesEffect = takesEffect
        self.runningVersion = runningVersion
        self.update = update
    }

    public var isUpdating: Bool { update?.state == .running }

    public var state: State {
        if !isInstalled { return .notFound }
        if isUpdating { return .updating }
        if update?.state == .failed { return .updateFailed }
        if standing == .tooOld { return .tooOld(needs: minimum) }
        if updateAvailable == true, let latest { return .updateAvailable(latest) }
        return updateAvailable == false ? .upToDate : .unknown
    }

    /// How it stands in words, on its row and its page; nil where there is nothing to add to its
    /// version. A later release is the row's own arrow (`stateLine`).
    public var stateWords: String? {
        switch state {
        case .notFound: "Not found on this host"
        case .updating: update?.isUnattended == true ? "Still running on the host" : "Updating…"
        case .updateFailed: "Update failed"
        case let .tooOld(needs): needs.map { "Older than Portals needs (\($0))" } ?? "Older than Portals needs"
        case let .updateAvailable(latest): "Update available: \(latest)"
        case .upToDate: "Up to date"
        case .unknown: nil
        }
    }

    /// Its version and how it stands, on a line of its row: "2.1.318 · Up to date",
    /// "0.166.0 → 0.170.2". nil where neither is known.
    public var stateLine: String? {
        if case let .updateAvailable(latest) = state, let version { return "\(version) → \(latest)" }
        return [isInstalled ? version : nil, stateWords].compactMap(\.self).joined(separator: " · ").nilIfEmpty
    }

    /// `stateLine` as VoiceOver says it, the arrow in words.
    public var spokenStateLine: String? {
        if case let .updateAvailable(latest) = state, let version { return "\(version), update available: \(latest)" }
        return [isInstalled ? version : nil, stateWords].compactMap(\.self).joined(separator: ", ").nilIfEmpty
    }

    /// Whether updating it is on offer: the host can, and no later release is known to be missing.
    public var offersUpdate: Bool {
        canUpdate && !isUpdating && updateAvailable != false
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A row of Settings > Agents: a program, however many of the host's agents it runs (a
/// Hermes's bots are all one), or an agent on its own, as every agent is on a host that does
/// not list programs.
public struct AgentSettingsRowItem: Identifiable, Hashable, Sendable {
    public enum Kind: Hashable, Sendable {
        /// A program, by its id; what the host said of it, nil until it has.
        case program(String, AgentProgram?)
        case agent
    }

    public var kind: Kind
    public var agents: [Agent]

    public var id: String {
        switch kind {
        case let .program(id, _): "program-\(id)"
        case .agent: "agent-\(agents.first?.id.name ?? "")"
        }
    }

    /// In the order the agents are arranged in: a program where its first agent comes, then
    /// the programs installed with no agent here, each row once. Where the host lists programs
    /// (`hostLists`), what it has not said yet goes by its agents' kinds, so that the rows do
    /// not change shape as its answer comes.
    public static func rows(agents: [Agent], programs: [AgentProgram]?, hostLists: Bool) -> [AgentSettingsRowItem] {
        guard hostLists else { return agents.map { AgentSettingsRowItem(kind: .agent, agents: [$0]) } }
        var rows: [AgentSettingsRowItem] = []
        var placed = Set<String>()
        for agent in agents {
            let program = programs?.first { $0.id == agent.kind }
            let known = programs == nil && agent.kind.map(programKinds.contains) == true
            guard let kind = agent.kind, program != nil || known else {
                rows.append(AgentSettingsRowItem(kind: .agent, agents: [agent]))
                continue
            }
            guard placed.insert(kind).inserted else { continue }
            rows.append(AgentSettingsRowItem(kind: .program(kind, program), agents: agents.filter { $0.kind == kind }))
        }
        for program in programs ?? [] where !placed.contains(program.id) {
            rows.append(AgentSettingsRowItem(kind: .program(program.id, program), agents: []))
        }
        return rows
    }

    /// The kinds of agent a program stands behind, for a host yet to say.
    static let programKinds: Set<String> = ["claude", "codex", "cursor", "droid", "pi", "opencode", "hermes"]
}

/// A host that lists its agents' programs and updates them.
public protocol AgentProgramsProviding: Sendable {
    /// Whether the host does; nil before the first connection.
    var listsPrograms: Bool? { get async }

    func agentPrograms() async throws -> [AgentProgram]
    /// Starts updating it, and answers at once with how it stands.
    func updateProgram(_ id: AgentProgram.ID) async throws -> AgentProgram
    /// The plan's limits as the agent tells them, with no thread to ask through; nil for one that cannot say.
    func usage(ofAgent name: String) async throws -> UsageLimits?
}

/// What each host last said of its programs, for Settings > Agents. Asked only while that
/// page is on screen; kept for this launch, so it draws at once when opened again.
@MainActor
@Observable
public final class AgentProgramsMemory {
    public static let shared = AgentProgramsMemory()

    public private(set) var programs: [HostID: [AgentProgram]] = [:]
    /// Why a host could not be asked last time, until it next answers.
    public private(set) var failures: [HostID: String] = [:]
    /// How many asks of each host have been made, and which is the latest answered: an older
    /// one answering after it says nothing new, least of all that an update has not started.
    @ObservationIgnored private var asked: [HostID: Int] = [:]
    @ObservationIgnored private var answered: [HostID: Int] = [:]
    /// How many times each host has been forgotten: what was asked of it before then is not kept when it comes.
    @ObservationIgnored private var forgotten: [HostID: Int] = [:]

    public init() {}

    public func program(_ id: AgentProgram.ID, on host: HostID) -> AgentProgram? {
        programs[host]?.first { $0.id == id }
    }

    public func isUpdating(on host: HostID) -> Bool {
        programs[host]?.contains(where: \.isUpdating) ?? false
    }

    /// One it could not ask keeps what it had, and says why.
    public func ask(on host: HostID, from provider: any AgentProgramsProviding) async {
        let ask = asked[host, default: 0] + 1
        asked[host] = ask
        let times = forgotten[host]
        do {
            let answer = try await provider.agentPrograms()
            guard forgotten[host] == times, ask > answered[host, default: 0] else { return }
            answered[host] = ask
            if failures[host] != nil { failures[host] = nil }
            if programs[host] != answer { programs[host] = answer }
        } catch {
            guard forgotten[host] == times, ask > answered[host, default: 0], !(error is CancellationError) else { return }
            failures[host] = error.localizedDescription
        }
    }

    /// Asks the host to update it, and takes in how it stands. Throws with the host's sentence when it will not.
    public func update(_ id: AgentProgram.ID, on host: HostID, from provider: any AgentProgramsProviding) async throws {
        let times = forgotten[host]
        let answer = try await provider.updateProgram(id)
        guard forgotten[host] == times else { return }
        // Any ask still out was made before this began.
        let ask = asked[host, default: 0] + 1
        asked[host] = ask
        answered[host] = ask
        var list = programs[host] ?? []
        if let at = list.firstIndex(where: { $0.id == answer.id }) { list[at] = answer } else { list.append(answer) }
        programs[host] = list
    }

    /// Everything known of a host: it was removed, or its address now leads to another Mac.
    public func forget(host: HostID) {
        forgotten[host, default: 0] += 1
        programs[host] = nil
        failures[host] = nil
    }
}
