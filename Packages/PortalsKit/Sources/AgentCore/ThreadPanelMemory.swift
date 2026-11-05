import Foundation
import Observation

/// What the panels have heard that is not any one chat's: how much of its plan an agent has
/// used and the apps on a host, the same whichever thread asks. So a chat's panel has them
/// at once, asking again behind them, rather than a spinner for each tab; and they are
/// asked before any panel opens, for each agent with a tab as its host connects, and for
/// the chat on screen (2026-11-01: "i think theres no preloading"). Cheap: an answer
/// of a few hundred bytes (the apps, some 40 KB, seldom), from a host that asks an agent at
/// most once a minute for all its devices (`usage.read`). Measured on a 16-inch MacBook Pro on
/// 2026-11-01: 0.4 to 0.6 s for an agent's first answer, a millisecond or two after it.
/// Kept from one launch to the next, so that a panel open at launch has them before the host
/// is reached (2026-11-01: "it does take less than second but still shows loading"),
/// but for a window that has reset since, with when they were heard, which the panel says of
/// numbers no answer on this connection has borne out. What a thread's repository holds is
/// for this launch.
@MainActor
@Observable
public final class ThreadPanelMemory {
    public static let shared = ThreadPanelMemory(
        // In a folder of the app's own: outside a sandbox, the caches folder is the user's.
        file: URL.cachesDirectory.appending(path: Bundle.main.bundleIdentifier ?? "Portals").appending(path: "thread-panel.json")
    )

    /// How long an answer stands before it is asked again: an open panel asks each minute.
    private static let usageStands: TimeInterval = 30
    /// An app installed meanwhile shows after this.
    private static let appsStand: TimeInterval = 600

    /// By agent; nil for one that does not say.
    public private(set) var usage: [Agent.ID: UsageLimits?] = [:]
    public private(set) var apps: [HostID: [HostApp]] = [:]
    /// What each thread's repository held when last asked, by thread.
    public private(set) var git: [ThreadKey: GitState] = [:]
    /// Why an agent could not be asked last time, until it next answers: its numbers stay,
    /// and this goes beside them (a sign-in that has expired, a service that has changed).
    public private(set) var usageFailures: [Agent.ID: String] = [:]
    /// By agent, what it says with no thread to ask through (Settings > Agents), for this launch.
    /// Apart from `usage`, which a thread's agent decides: a Hermes thread can run on another
    /// model provider than its bot's default, and its panel must not go by the bot's.
    public private(set) var agentUsage: [Agent.ID: UsageLimits?] = [:]
    public private(set) var agentUsageFailures: [Agent.ID: String] = [:]
    @ObservationIgnored private var agentUsageHeard: [Agent.ID: Date] = [:]
    @ObservationIgnored private var agentUsageAnswered: [Agent.ID: Date] = [:]
    /// The agents whose numbers were heard on their host's present connection.
    private var usageCurrent: Set<Agent.ID> = []
    /// When each agent's numbers were heard, kept with them.
    @ObservationIgnored private var usageHeard: [Agent.ID: Date] = [:]
    /// When each agent last answered on this connection: not asked again for a moment.
    @ObservationIgnored private var usageAnswered: [Agent.ID: Date] = [:]
    @ObservationIgnored private var appsHeard: [HostID: Date] = [:]
    /// How many asks of a thread's repository have been made, and which of them is the
    /// latest to have been answered: an older one answering after it says nothing new.
    @ObservationIgnored private var gitAsked: [ThreadKey: Int] = [:]
    @ObservationIgnored private var gitAnswered: [ThreadKey: Int] = [:]
    /// How many times each host has been forgotten: what was asked of it before then is
    /// not kept when it comes.
    @ObservationIgnored private var forgotten: [HostID: Int] = [:]
    /// How many connections each host has begun: what was asked on an earlier one is not its
    /// agents' word now.
    @ObservationIgnored private var connections: [HostID: Int] = [:]
    @ObservationIgnored private var saving: Task<Void, Never>?
    /// Where they are kept from one launch to the next.
    @ObservationIgnored private let file: URL

    public init(file: URL) {
        self.file = file
        guard let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return }
        let now = Date.now
        for entry in saved.usage where !(entry.limits?.windows.contains { $0.hasReset(at: now) } ?? false) {
            usage.updateValue(entry.limits, forKey: entry.agent)
            usageHeard[entry.agent] = entry.heard
        }
        for entry in saved.apps { apps[entry.host] = entry.apps }
    }

    public func askUsage(of agent: Agent.ID, thread: ThreadRef.ID, from provider: any ThreadPanelProviding) async throws {
        if let answered = usageAnswered[agent], Date.now.timeIntervalSince(answered) < Self.usageStands { return }
        let times = forgotten[agent.host]
        let connection = connections[agent.host]
        // From before the host was forgotten or its connection began again, it says nothing,
        // whichever way it went: one on the new connection is asked, or has answered, by then.
        var isOver: Bool { forgotten[agent.host] != times || connections[agent.host] != connection }
        let answer: UsageLimits?
        do {
            answer = try await provider.usage(of: thread)
        } catch {
            if isOver { return }
            usageFailures[agent] = error.localizedDescription
            throw error
        }
        if isOver { return }
        usageAnswered[agent] = .now
        usageHeard[agent] = .now
        if usageFailures[agent] != nil { usageFailures[agent] = nil }
        if !usageCurrent.contains(agent) { usageCurrent.insert(agent) }
        if usage[agent] != .some(answer) { usage.updateValue(answer, forKey: agent) }
        saveSoon()
    }

    /// With no thread to ask through, for a page of agents (Settings > Agents): kept apart from
    /// what a thread says, as `agentUsage` says.
    public func askUsage(of agent: Agent.ID, from provider: any AgentProgramsProviding) async throws {
        if let answered = agentUsageAnswered[agent], Date.now.timeIntervalSince(answered) < Self.usageStands { return }
        let times = forgotten[agent.host]
        let connection = connections[agent.host]
        var isOver: Bool { forgotten[agent.host] != times || connections[agent.host] != connection }
        let answer: UsageLimits?
        do {
            answer = try await provider.usage(ofAgent: agent.name)
        } catch {
            if isOver { return }
            agentUsageFailures[agent] = error.localizedDescription
            throw error
        }
        if isOver { return }
        agentUsageAnswered[agent] = .now
        agentUsageHeard[agent] = .now
        if agentUsageFailures[agent] != nil { agentUsageFailures[agent] = nil }
        if agentUsage[agent] != .some(answer) { agentUsage.updateValue(answer, forKey: agent) }
    }

    /// What a page of agents says of one: its own word, else what its chats have heard, from a
    /// host that cannot be asked with no thread, or until it has answered.
    public func pageUsage(of agent: Agent.ID) -> UsageLimits? {
        if let said = agentUsage[agent] { return said }
        return usage[agent] ?? nil
    }

    public func pageUsageFailure(of agent: Agent.ID) -> String? {
        agentUsageFailures[agent] ?? usageFailures[agent]
    }

    /// `usageAsOf`, of what `pageUsage` says.
    public func pageUsageAsOf(of agent: Agent.ID, isConnected: Bool) -> Date? {
        guard let said = agentUsage[agent] else { return usageAsOf(of: agent, isConnected: isConnected) }
        guard let limits = said else { return nil }
        if let heard = limits.heardAt { return heard }
        return isConnected && agentUsageFailures[agent] == nil ? nil : agentUsageHeard[agent]
    }

    /// When the numbers known of an agent were true, where that is not just now: as its
    /// host last heard them, or as heard here if no answer on this connection has followed
    /// them or the last ask failed. nil for numbers as good as new.
    public func usageAsOf(of agent: Agent.ID, isConnected: Bool) -> Date? {
        guard let known = usage[agent], let limits = known else { return nil }
        if let said = limits.heardAt { return said }
        return isConnected && usageCurrent.contains(agent) && usageFailures[agent] == nil ? nil : usageHeard[agent]
    }

    /// A host's connection began: what is known of its agents is from an earlier one until
    /// each answers again, and each is asked again at the next chance. To be told before
    /// anything can ask on the new one, whose answers would go for the old one's.
    public func connected(to host: HostID) {
        connections[host, default: 0] += 1
        usageCurrent = usageCurrent.filter { $0.host != host }
        usageFailures = usageFailures.filter { $0.key.host != host }
        usageAnswered = usageAnswered.filter { $0.key.host != host }
        agentUsageFailures = agentUsageFailures.filter { $0.key.host != host }
        agentUsageAnswered = agentUsageAnswered.filter { $0.key.host != host }
    }

    /// One it could not ask keeps what it had.
    public func askApps(on host: HostID, from provider: any ThreadPanelProviding) async {
        if let heard = appsHeard[host], Date.now.timeIntervalSince(heard) < Self.appsStand { return }
        let times = forgotten[host]
        guard let answer = try? await provider.hostApps(), forgotten[host] == times else { return }
        appsHeard[host] = .now
        guard apps[host] != answer else { return }
        apps[host] = answer
        saveSoon()
    }

    /// What the thread's repository holds, asked again. One it could not ask keeps what it
    /// had, and says why by throwing. A panel opening and a turn ending ask at once, and the
    /// answers can come in either order: the one asked for last stands.
    public func askGit(of key: ThreadKey, from provider: any ThreadPanelProviding) async throws {
        let ask = gitAsked[key, default: 0] + 1
        gitAsked[key] = ask
        let times = forgotten[key.host]
        let answer = try await provider.gitStatus(of: key.id)
        guard forgotten[key.host] == times, ask > gitAnswered[key, default: 0] else { return }
        gitAnswered[key] = ask
        git[key] = answer
    }

    public func forgetUsage(of agent: Agent.ID) {
        usageHeard[agent] = nil
        usageAnswered[agent] = nil
        usageFailures[agent] = nil
        usageCurrent.remove(agent)
        agentUsage.removeValue(forKey: agent)
        agentUsageFailures[agent] = nil
        agentUsageHeard[agent] = nil
        agentUsageAnswered[agent] = nil
        guard usage.removeValue(forKey: agent) != nil else { return }
        saveSoon()
    }

    public func forgetApps(on host: HostID) {
        appsHeard[host] = nil
        guard apps.removeValue(forKey: host) != nil else { return }
        saveSoon()
    }

    public func forgetGit(of key: ThreadKey) {
        git[key] = nil
    }

    /// Everything known of a host: it was removed, or its address now leads to another Mac.
    public func forget(host: HostID) {
        forgotten[host, default: 0] += 1
        usage = usage.filter { $0.key.host != host }
        usageHeard = usageHeard.filter { $0.key.host != host }
        usageAnswered = usageAnswered.filter { $0.key.host != host }
        usageFailures = usageFailures.filter { $0.key.host != host }
        usageCurrent = usageCurrent.filter { $0.host != host }
        agentUsage = agentUsage.filter { $0.key.host != host }
        agentUsageFailures = agentUsageFailures.filter { $0.key.host != host }
        agentUsageHeard = agentUsageHeard.filter { $0.key.host != host }
        agentUsageAnswered = agentUsageAnswered.filter { $0.key.host != host }
        apps[host] = nil
        appsHeard[host] = nil
        git = git.filter { $0.key.host != host }
        gitAsked = gitAsked.filter { $0.key.host != host }
        gitAnswered = gitAnswered.filter { $0.key.host != host }
        saveSoon()
    }

    // MARK: From one launch to the next

    private struct Saved: Codable, Sendable {
        struct Usage: Codable, Sendable {
            let agent: Agent.ID
            let limits: UsageLimits?
            let heard: Date
        }

        struct Apps: Codable, Sendable {
            let host: HostID
            let apps: [HostApp]
        }

        let usage: [Usage]
        let apps: [Apps]
    }

    private func saveSoon() {
        let saved = Saved(
            usage: usage.compactMap { entry in usageHeard[entry.key].map { Saved.Usage(agent: entry.key, limits: entry.value, heard: $0) } },
            apps: apps.map { Saved.Apps(host: $0.key, apps: $0.value) }
        )
        saving?.cancel()
        saving = Task.detached(priority: .utility) { [file] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let data = try? JSONEncoder().encode(saved) else { return }
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
    }

    /// Asked ahead of a panel's opening, each on its own: kept whatever comes on screen meanwhile.
    public func preload(from provider: any ThreadPanelProviding, host: HostID, threads: [Agent.ID: ThreadRef.ID], asksApps: Bool) async {
        let readsUsage = await provider.readsUsage ?? false
        let opens = asksApps ? await provider.opensFolders ?? false : false
        if opens { Task { await askApps(on: host, from: provider) } }
        guard readsUsage else { return }
        for (agent, thread) in threads {
            Task { try? await askUsage(of: agent, thread: thread, from: provider) }
        }
    }
}
