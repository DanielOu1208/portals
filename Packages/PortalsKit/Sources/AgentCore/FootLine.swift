import Foundation

/// What sits at the foot of a chat, above the composer, as one line (2026-10-26:
/// "I think it should stay in. We can try making it stay in one line first"): the agents
/// the thread's agent set to work, its workflows, the threads it started from this one
/// (managed threads) and the commands it left running in the background, under one
/// title. Opened in place, each row is as it was on the two lines before it, the
/// subagents line and the started threads' line ("Subagents and stuff should just show
/// as they do right now").
public enum FootLine {
    /// The line's parts, in the order (2026-10-26: "Subagents, Workflows, Managed
    /// threads, Background tasks").
    public enum Part: Int, CaseIterable, Hashable, Sendable {
        case subagents, workflows, threads, commands

        /// The part a row of this kind starts.
        public init(_ kind: Subagent.Kind) {
            switch kind {
            case .agent: self = .subagents
            case .workflow: self = .workflows
            case .command: self = .commands
            }
        }

        /// Its heading, in the words asked for.
        public var title: String {
            switch self {
            case .subagents: "Subagents"
            case .workflows: "Workflows"
            case .threads: "Managed threads"
            case .commands: "Background tasks"
            }
        }
    }

    /// The rows as the opened line shows them: the agents by part, and the parts that have
    /// rows, in order.
    public struct Rows {
        /// Each part's agents in the order they started, each with how deep it is.
        public var agents: [Part: [(agent: Subagent, depth: Int)]]
        public var parts: [Part]

        /// Each part has a heading when more than one part has rows: with one, the title
        /// says what they are already, and a heading would only say it again; with more,
        /// agents, workflows, threads and commands one after the other were told apart only
        /// by their small symbols.
        public var headed: Bool { parts.count > 1 }
    }

    /// The rows of `subagents` and of `threads` threads started here. In each part they
    /// keep the order they started in, a subagent's own subagent right after the one that
    /// started it (`nested`). A child goes in the part of the one at the top of its line of
    /// parents, whatever its own kind: a command a subagent left running is under that
    /// subagent, a subagent a workflow started under that workflow, rather than torn from
    /// it into a part of its own, where nothing on the line would say who started it.
    public static func rows(of subagents: [Subagent], threads: Int) -> Rows {
        var agents: [Part: [(agent: Subagent, depth: Int)]] = [:]
        var part = Part.subagents
        for entry in subagents.nested {
            if entry.depth == 0 { part = Part(entry.agent.kind) }
            agents[part, default: []].append(entry)
        }
        let parts = Part.allCases.filter { $0 == .threads ? threads > 0 : agents[$0]?.isEmpty == false }
        return Rows(agents: agents, parts: parts)
    }

    /// How long a background command that ended stays on the line, as done, failed or
    /// stopped, before it leaves by itself, the turn still running or not (2026-10-27: "completed background tasks just clear by themselves even before the turn
    /// ends"; of one that failed or was stopped, "yes they should clear").
    public static let finishedCommandStays: TimeInterval = 4

    /// Of `subagents`, what the line shows at `now`: every one but a background command
    /// that ended more than `finishedCommandStays` ago, finished, failed or stopped, which
    /// leaves the rows, the title and the icons, and the line with them once nothing else
    /// is on it. One that failed reads so meanwhile (`Mark.failed`). The subagents and
    /// workflows that ended stay until the next message to the agent clears them
    /// (`subagents_clear`; 2026-10-27: "no they should show"), and so does a
    /// command whose host says not when it ended.
    public static func shown(_ subagents: [Subagent], at now: Date, showsCommands: Bool = true) -> [Subagent] {
        subagents.filter { (showsCommands || $0.kind != .command) && (leaves($0).map { $0 > now } ?? true) }
    }

    /// Whether the commands an agent left running show on the line, kept per device (Settings,
    /// Chat; 2026-11-02: "a setting option to hide or show background tasks in the
    /// chat"). They go on running either way.
    public static let showsCommandsKey = "chat.showsBackgroundTasks"

    /// When the line next changes by itself: the moment the next command that ended leaves
    /// it, after `now`; nil when none is still to leave.
    public static func nextClearing(of subagents: [Subagent], after now: Date) -> Date? {
        subagents.lazy.compactMap(leaves).filter { $0 > now }.min()
    }

    /// When `agent` leaves the line by itself: a background command that ended, a moment
    /// after it did.
    private static func leaves(_ agent: Subagent) -> Date? {
        guard agent.kind == .command, agent.state != .working, let ended = agent.endedAt else { return nil }
        return ended.addingTimeInterval(finishedCommandStays)
    }

    /// What the line's mark shows: a spinner while any of it works, the orange dot of
    /// waiting for you when a thread does and nothing works, else that one did not finish
    /// (`failed`, so that a command that failed reads so for its moment, not as done), or
    /// that all of it ended (`started` for threads alone, which have not ended, only
    /// stopped for now).
    public enum Mark: Hashable, Sendable {
        case working, waiting, failed, ended, started
    }

    /// `threads`: what each thread started here is doing, nil at rest.
    public static func mark(of subagents: [Subagent], threads: [ThreadActivity?]) -> Mark {
        if subagents.contains(where: \.isWorking) || threads.contains(.running) { return .working }
        if threads.contains(.waiting) { return .waiting }
        if subagents.contains(where: { $0.state == .failed }) { return .failed }
        return subagents.isEmpty ? .started : .ended
    }

    /// The line's title: what is going on across all of it, on one line a phone's width
    /// holds. Needs you first, as the started threads' line said it; then how many work, of
    /// how many; else how they ended. Of one kind, it says what each line said before
    /// ("2 of 3 agents still working", "1 command working", "Started 2 threads"); of
    /// several, only how many (2026-10-27: "just say like 6 working instead of 6
    /// tasks working"): "3 of 5 still working", "2 done".
    public static func title(of subagents: [Subagent], threads: [ThreadActivity?]) -> String {
        let waiting = threads.count { $0 == .waiting }
        let working = subagents.count(where: \.isWorking) + threads.count { $0 == .running }
        let count = subagents.count + threads.count
        if waiting > 0, working > 0 { return "\(waiting) \(waiting == 1 ? "needs" : "need") you · \(working) working" }
        if waiting > 0 { return waiting == 1 ? "1 thread needs you" : "\(waiting) threads need you" }
        let noun = noun(of: subagents, threads: !threads.isEmpty)
        // How many, with what they are where they are of one kind.
        func counted(_ number: Int) -> String {
            guard let noun else { return "\(number)" }
            return "\(number) \(number == 1 ? noun.one : noun.many)"
        }
        if working == 0 {
            if subagents.isEmpty { return count == 1 ? "Started 1 thread" : "Started \(count) threads" }
            // Done when all finished; one stopped or failed has ended, not finished.
            let word = subagents.allSatisfy { $0.state == .finished } ? "done" : "ended"
            return "\(counted(count)) \(word)"
        }
        if working < count { return "\(working) of \(counted(count)) still working" }
        return "\(counted(working)) working"
    }

    /// What the title calls them when they are of one kind: "agents", "workflows",
    /// "commands" or "threads". None for several kinds, which the title only counts:
    /// agents with workflows too (2026-10-27: "2 working", not "2 agents working").
    public static func noun(of subagents: [Subagent], threads: Bool) -> (one: String, many: String)? {
        if subagents.isEmpty { return ("thread", "threads") }
        if threads { return nil }
        if subagents.allSatisfy({ $0.kind == .agent }) { return ("agent", "agents") }
        if subagents.allSatisfy({ $0.kind == .workflow }) { return ("workflow", "workflows") }
        if subagents.allSatisfy({ $0.kind == .command }) { return ("command", "commands") }
        return nil
    }

    /// What a tap on the line does, for VoiceOver, while it is open and while it is closed:
    /// in the title's words, or of no kind in particular where the title names none.
    public static func hints(of subagents: [Subagent], threads: Bool) -> (open: String, closed: String) {
        guard let noun = noun(of: subagents, threads: threads) else { return ("Hides the list", "Shows what each one is doing") }
        return ("Hides the \(noun.many)", "Shows what each \(noun.one) is doing")
    }

    /// The parts the closed line has a small icon for after its title, in its order of
    /// parts: the subagents and the workflows, one icon for each kind however many there
    /// are, while one of that kind works, as the threads' icons are there while they work
    /// or wait for you (2026-10-27: "show subagents and workflows the same way we
    /// show managed threads but dont duplicate them just have like a small icon for each").
    public static func icons(of subagents: [Subagent]) -> [Part] {
        [Part.subagents, .workflows].filter { part in subagents.contains { $0.isWorking && Part($0.kind) == part } }
    }

    /// How many icons the closed line has after its title at most, those of the parts
    /// first (`icons`), then the threads', and after them how many more threads: as many as
    /// the threads alone had, so the line is no wider for them.
    public static let mostIcons = 4
}
