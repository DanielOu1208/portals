import Foundation

/// An agent the thread's agent set to work on part of a task, or a workflow of such
/// agents. It works by itself, also after the turn that started it is over, and reports
/// back to the thread's agent, which then starts a turn of its own.
public struct Subagent: Identifiable, Hashable, Sendable {
    public enum State: Hashable, Sendable {
        case working, finished, failed, stopped
    }

    public enum Kind: Hashable, Sendable {
        /// One agent.
        case agent
        /// A workflow: agents run in phases by a script (Claude Code's Workflow tool).
        case workflow
        /// A terminal command the agent left running in the background (a dev server, a
        /// long build): what it runs is its goal, its last line of output its summary.
        case command
    }

    /// The backend's id for it.
    public var id: String
    /// What it was asked to do.
    public var goal: String
    /// The tool it last used, by the backend's name for it ("terminal"), and what on.
    public var tool: String?
    public var toolDetail: String?
    public var state: State
    public var kind: Kind
    /// A workflow's name.
    public var name: String?
    /// What its agent calls it (a Codex sub-agent's nickname, "Darwin").
    public var nickname: String?
    /// The kind of agent it is (a Codex sub-agent's role, "worker"; a Claude subagent's
    /// type, "Explore").
    public var role: String?
    /// The one of these that started it, for a subagent's own subagent.
    public var parentID: String?
    /// The thread's turn that started it, as the host numbers them, from a host that keeps
    /// the agents after they end (a Portals bridge's `subagents`).
    public var turn: Int?
    /// When it started, from such a host; nil from one that shows only those at work.
    public var startedAt: Date?
    public var endedAt: Date?
    /// A line on what it is doing now.
    public var summary: String?
    /// What it answered, or why it failed, once it has ended.
    public var result: String?
    /// A command's output so far, its end only, and whether its start was left out.
    public var output: String?
    public var outputTruncated: Bool
    /// It can be stopped by itself now, apart from the turn.
    public var canStop: Bool
    public var model: String?
    public var tokens: Int?
    public var toolUses: Int?
    /// A workflow's phases, in order, and its agents, in the order they started.
    public var phases: [WorkflowPhase]
    public var agents: [WorkflowAgent]

    public init(
        id: String, goal: String, tool: String? = nil, toolDetail: String? = nil, state: State = .working, kind: Kind = .agent,
        name: String? = nil, nickname: String? = nil, role: String? = nil, parentID: String? = nil, turn: Int? = nil, startedAt: Date? = nil, endedAt: Date? = nil, summary: String? = nil, result: String? = nil,
        output: String? = nil, outputTruncated: Bool = false, canStop: Bool = false, model: String? = nil, tokens: Int? = nil, toolUses: Int? = nil, phases: [WorkflowPhase] = [],
        agents: [WorkflowAgent] = []
    ) {
        self.id = id
        self.goal = goal
        self.tool = tool
        self.toolDetail = toolDetail
        self.state = state
        self.kind = kind
        self.name = name
        self.nickname = nickname
        self.role = role
        self.parentID = parentID
        self.turn = turn
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.summary = summary
        self.result = result
        self.output = output
        self.outputTruncated = outputTruncated
        self.canStop = canStop
        self.model = model
        self.tokens = tokens
        self.toolUses = toolUses
        self.phases = phases
        self.agents = agents
    }

    public var isWorking: Bool { state == .working }

    /// It keeps its thread at work while it works: an agent or a workflow, and not a
    /// command left running in the background (a dev server, for hours), whose row stays
    /// live on the line while the thread itself is finished, as the bridge says it is
    /// (`hasRunningSubagents`; 2026-10-26: "if everything is finished and only a
    /// background task is running on the thread, it should be marked as finished").
    public var keepsThreadAtWork: Bool { isWorking && kind != .command }

    /// News from a host that says everything it knows each time, and keeps the agent
    /// after it has ended, which the line then shows too.
    public var isKept: Bool { startedAt != nil }

    /// What the line calls it: a workflow by its name; an agent its agent gave a nickname
    /// by that, then its role ("Darwin · worker", a Codex sub-agent, whose goal is only
    /// its path); else by what it was asked to do.
    public var title: String {
        if kind == .workflow, let name { return name }
        if kind == .agent, let nickname { return [nickname, role].compactMap(\.self).joined(separator: " · ") }
        guard goal.isEmpty else { return goal }
        switch kind {
        case .agent: return "An agent"
        case .workflow: return "A workflow"
        case .command: return "A command"
        }
    }

    /// The phase a workflow is in: that of the last agent at work, else of the last that
    /// started, else its last phase.
    public var currentPhase: String? {
        agents.last(where: { $0.state == .working })?.phase ?? agents.last?.phase ?? phases.last?.title
    }
}

/// One phase of a workflow.
public struct WorkflowPhase: Hashable, Sendable {
    public var index: Int
    public var title: String

    public init(index: Int, title: String) {
        self.index = index
        self.title = title
    }
}

/// One agent of a workflow.
public struct WorkflowAgent: Identifiable, Hashable, Sendable {
    public var id: String
    public var label: String
    /// The title of the phase it runs in.
    public var phase: String?
    public var model: String?
    public var state: Subagent.State
    public var tokens: Int?
    public var toolUses: Int?
    /// How long it worked, once it has said.
    public var duration: TimeInterval?
    /// The start of what it answered.
    public var result: String?

    public init(
        id: String, label: String, phase: String? = nil, model: String? = nil, state: Subagent.State = .working, tokens: Int? = nil,
        toolUses: Int? = nil, duration: TimeInterval? = nil, result: String? = nil
    ) {
        self.id = id
        self.label = label
        self.phase = phase
        self.model = model
        self.state = state
        self.tokens = tokens
        self.toolUses = toolUses
        self.duration = duration
        self.result = result
    }

    public var isWorking: Bool { state == .working }
}

/// A host that can stop one subagent or workflow by itself, leaving the turn and the
/// others running (a Portals bridge's `subagents`).
public protocol SubagentStopping: Sendable {
    /// Whether the host can, as of the last connection; nil before the first.
    var stopsSubagents: Bool? { get async }
    /// False when it was no longer one that could be stopped (it had ended).
    func stopSubagent(_ id: String, in thread: ThreadRef.ID) async throws -> Bool
}

extension [Subagent] {
    /// Takes in news of one agent. The agents shown are one batch: news of a new agent
    /// when none of the earlier ones is still working starts the list over. From a host
    /// that keeps them, the batch is the agents the latest turn started, with those of
    /// earlier turns still at work.
    public mutating func take(_ news: Subagent) {
        if let index = firstIndex(where: { $0.id == news.id }) {
            // A host that keeps them says everything each time.
            if news.isKept {
                self[index] = news
                keepLatestBatch()
                return
            }
            var known = self[index]
            // News does not always repeat what was said before.
            if !news.goal.isEmpty { known.goal = news.goal }
            if let tool = news.tool {
                known.tool = tool
                known.toolDetail = news.toolDetail
            }
            // A late word from an agent that has finished does not set it working again.
            if known.isWorking { known.state = news.state }
            self[index] = known
        } else if news.turn != nil {
            append(news)
            keepLatestBatch()
        } else {
            if !contains(where: \.isWorking) { removeAll() }
            append(news)
        }
    }

    /// The agents in the order the line shows them, each with how deep it is: one a
    /// subagent of the list started comes right after the one that started it (and that
    /// one's earlier ones), the rest keep their order. One whose parent is not listed is
    /// at the top.
    public var nested: [(agent: Subagent, depth: Int)] {
        let listed = Set(map(\.id))
        var children: [Subagent.ID: [Subagent]] = [:]
        var roots: [Subagent] = []
        for agent in self {
            if let parent = agent.parentID, parent != agent.id, listed.contains(parent) {
                children[parent, default: []].append(agent)
            } else {
                roots.append(agent)
            }
        }
        var ordered: [(agent: Subagent, depth: Int)] = []
        var placed: Set<Subagent.ID> = []
        func place(_ agent: Subagent, depth: Int) {
            guard placed.insert(agent.id).inserted else { return }
            ordered.append((agent, depth))
            for child in children[agent.id] ?? [] { place(child, depth: depth + 1) }
        }
        for root in roots { place(root, depth: 0) }
        // Ones caught in a loop of parents, which no host should send: shown all the same.
        for agent in self where !placed.contains(agent.id) { place(agent, depth: 0) }
        return ordered
    }

    /// Takes off those of `ids`: they had ended when a message went to the agent, and
    /// left the line. The host names only ended ones, so one shown here as working had its
    /// end missed; one at work again comes back with its next news.
    public mutating func clear(_ ids: [Subagent.ID]) {
        let cleared = Set(ids)
        removeAll { cleared.contains($0.id) }
    }

    /// From a host that numbers turns, the batch `lastBatch` keeps: the agents of the
    /// latest turn that started any, with those of earlier turns still at work. One of an
    /// earlier turn leaves once it has ended, and more said of it then does not bring it back.
    private mutating func keepLatestBatch() {
        guard let latest = compactMap(\.turn).max() else { return }
        removeAll { !$0.isWorking && ($0.turn ?? 0) < latest }
    }

    /// Of every agent a host lists, oldest first, the batch the line shows, by the rule
    /// `take` goes by: those the latest turn started, with any still at work; from a host
    /// that does not number turns, the latest run of agents begun once all before them
    /// had ended.
    public static func lastBatch(of listed: [Subagent]) -> [Subagent] {
        let turns = listed.compactMap(\.turn)
        if turns.count == listed.count, let latest = turns.max() {
            return listed.filter { $0.turn == latest || $0.isWorking }
                .sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        }
        var batch: [Subagent] = []
        for agent in listed.sorted(by: { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }) {
            let allEnded = batch.allSatisfy { earlier in
                guard let ended = earlier.endedAt, let started = agent.startedAt else { return false }
                return ended <= started
            }
            if !batch.isEmpty, allEnded { batch.removeAll() }
            batch.append(agent)
        }
        return batch
    }
}
