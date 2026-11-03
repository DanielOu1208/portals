import Foundation
import Testing
@testable import AgentCore

/// Agents the thread's agent set to work, as the thread keeps track of them.
@Suite struct SubagentTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let alpha = Subagent(id: "sa-0", goal: "Audit the simulation")
    private let beta = Subagent(id: "sa-1", goal: "Research cheap hardware")

    @Test func newsOfAnAgentIsTakenInUnderItsId() {
        var agents: [Subagent] = []
        agents.take(alpha)
        agents.take(beta)
        // What it is doing now, without saying again what it was asked.
        agents.take(Subagent(id: "sa-0", goal: "", tool: "terminal", toolDetail: "pytest -q"))
        #expect(agents == [Subagent(id: "sa-0", goal: "Audit the simulation", tool: "terminal", toolDetail: "pytest -q"), beta])

        // News with no tool in it leaves the last one showing.
        agents.take(alpha)
        #expect(agents[0].tool == "terminal")
        agents.take(Subagent(id: "sa-0", goal: "Audit the simulation", state: .finished))
        #expect(agents.map(\.state) == [.finished, .working])
        #expect(agents.filter(\.isWorking) == [beta])
    }

    @Test func aLateWordFromAnAgentThatFinishedDoesNotSetItWorkingAgain() {
        var agents = [Subagent(id: "sa-0", goal: "Audit", state: .failed)]
        agents.take(Subagent(id: "sa-0", goal: "Audit", tool: "terminal"))
        #expect(agents[0].state == .failed)
    }

    @Test func aNewBatchStartsTheListOver() {
        var agents = [Subagent(id: "sa-0", goal: "one", state: .finished), Subagent(id: "sa-1", goal: "two", state: .failed)]
        agents.take(Subagent(id: "sa-2", goal: "three"))
        #expect(agents.map(\.id) == ["sa-2"])
        // While one is still working, a newcomer joins it.
        agents.take(Subagent(id: "sa-3", goal: "four"))
        #expect(agents.map(\.id) == ["sa-2", "sa-3"])
    }

    @Test func theThreadKeepsTrackOfThemPastTheTurnThatStartedThem() {
        var state = ThreadState()
        state.messageSent("research this", at: t0)
        state.apply(.subagent(alpha), at: t0)
        state.apply(.subagent(beta), at: t0)
        state.apply(.turnFinished(.completed, finalText: "They are on it."), at: t0)
        // The turn is over; they are still at it.
        #expect(!state.isRunning)
        #expect(state.subagents.filter(\.isWorking).count == 2)

        state.apply(.subagent(Subagent(id: "sa-0", goal: "Audit the simulation", state: .finished)), at: t0)
        #expect(state.subagents.filter(\.isWorking) == [beta])
    }

    @Test func theThreadIsAtWorkUntilTheLastAgentItSetToWorkEnds() {
        var state = ThreadState()
        #expect(!state.isAtWork)
        state.messageSent("research this", at: t0)
        state.apply(.subagent(alpha), at: t0)
        state.apply(.turnFinished(.completed, finalText: "It is on it."), at: t0)
        // At work as the host says it (`sessions.activity`): the turn is over, its agent
        // is not, and the sidebar keeps the thread under Running.
        #expect(!state.isRunning)
        #expect(state.isAtWork)

        state.apply(.subagent(Subagent(id: "sa-0", goal: "Audit the simulation", state: .finished)), at: t0)
        #expect(!state.isAtWork)
    }

    @Test func theHostsListAfterAGapReplacesWhatWasKnown() {
        var state = ThreadState()
        state.apply(.subagent(alpha), at: t0)
        state.apply(.subagent(beta), at: t0)
        // One finished while the app was not listening: the host no longer lists it.
        state.apply(.subagentsListed([beta]), at: t0)
        #expect(state.subagents == [beta])
        // The host's version of the conversation alone says nothing about them.
        state.adopt(ThreadSnapshot(transcript: Transcript()))
        #expect(state.subagents == [beta])
        state.apply(.subagentsListed([]), at: t0)
        #expect(state.subagents.isEmpty)
    }

    @Test func newsFromAHostThatKeepsThemReplacesWhatWasKnownAndTheEndedOnesStay() {
        let started = Date(timeIntervalSince1970: 100)
        var agents: [Subagent] = []
        agents.take(Subagent(id: "a1", goal: "Count", turn: 1, startedAt: started, summary: "Running ls", canStop: true))
        // All it knows each time: a summary it no longer gives is gone.
        agents.take(Subagent(id: "a1", goal: "Count", state: .finished, turn: 1, startedAt: started, endedAt: started + 9, result: "0 entries."))
        // Started by the same turn after the first had ended: shown with it.
        agents.take(Subagent(id: "w1", goal: "Two agents", kind: .workflow, name: "tiny-check", turn: 1, startedAt: started + 10, canStop: true))
        #expect(agents[0].summary == nil)
        #expect(agents[0].result == "0 entries.")
        agents.take(Subagent(id: "w1", goal: "Two agents", state: .stopped, kind: .workflow, turn: 1, startedAt: started + 10, endedAt: started + 12))
        // None works now, and the thread shows them still.
        #expect(agents.map(\.state) == [.finished, .stopped])
        #expect(agents.allSatisfy { $0.isKept })
        // One a later turn starts begins a new batch, with those still at work.
        agents.take(Subagent(id: "a2", goal: "Again", turn: 2, startedAt: started + 60))
        #expect(agents.map(\.id) == ["a2"])
        agents.take(Subagent(id: "a3", goal: "Later", turn: 3, startedAt: started + 70))
        #expect(agents.map(\.id) == ["a2", "a3"])
    }

    @Test func anEarlierTurnsAgentLeavesTheLineWhenItEndsAndLateNewsDoesNotBringItBack() {
        let started = Date(timeIntervalSince1970: 100)
        var agents: [Subagent] = []
        agents.take(Subagent(id: "a", goal: "First", turn: 1, startedAt: started))
        agents.take(Subagent(id: "b", goal: "Second", turn: 2, startedAt: started + 5))
        // Still at work, an earlier turn's agent is shown with the latest; once ended, it goes.
        #expect(agents.map(\.id) == ["a", "b"])
        agents.take(Subagent(id: "a", goal: "First", state: .finished, turn: 1, startedAt: started, endedAt: started + 9))
        #expect(agents.map(\.id) == ["b"])
        // More said of it afterwards (its reply) does not put it back.
        agents.take(Subagent(id: "a", goal: "First", state: .finished, turn: 1, startedAt: started, endedAt: started + 9, result: "Done."))
        #expect(agents.map(\.id) == ["b"])
        #expect(agents == [Subagent].lastBatch(of: agents))
    }

    @Test func theLastBatchBeginsWithAnAgentStartedOnceAllBeforeItHadEnded() {
        let at = { (seconds: Double) in Date(timeIntervalSince1970: seconds) }
        let listed = [
            Subagent(id: "late", goal: "", startedAt: at(30)),
            Subagent(id: "one", goal: "", state: .finished, startedAt: at(0), endedAt: at(10)),
            Subagent(id: "two", goal: "", state: .finished, startedAt: at(20), endedAt: at(40)),
        ]
        // `two` began after `one` had ended; `late` began while `two` was still at work.
        #expect([Subagent].lastBatch(of: listed).map(\.id) == ["two", "late"])
        #expect([Subagent].lastBatch(of: []).isEmpty)
        // Numbered by turn: the latest turn's, with any of an earlier one still at work.
        let numbered = [
            Subagent(id: "one", goal: "", state: .finished, turn: 1, startedAt: at(0), endedAt: at(10)),
            Subagent(id: "busy", goal: "", turn: 1, startedAt: at(1)),
            Subagent(id: "two", goal: "", state: .finished, turn: 2, startedAt: at(20), endedAt: at(25)),
            Subagent(id: "three", goal: "", turn: 2, startedAt: at(30)),
        ]
        #expect([Subagent].lastBatch(of: numbered).map(\.id) == ["busy", "two", "three"])
    }

    @Test func aWorkflowIsInThePhaseOfItsLastAgentAtWork() {
        var workflow = Subagent(id: "w", goal: "", kind: .workflow, phases: [WorkflowPhase(index: 1, title: "Draft"), WorkflowPhase(index: 2, title: "Review")])
        #expect(workflow.currentPhase == "Review")
        workflow.agents = [WorkflowAgent(id: "1", label: "a", phase: "Draft", state: .working), WorkflowAgent(id: "2", label: "b", phase: "Review", state: .finished)]
        #expect(workflow.currentPhase == "Draft")
    }
}

/// What the line calls an agent, and the ended ones leaving it as a message goes to the agent.
@Suite struct SubagentLineTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    @Test func aCodexSubAgentIsCalledByItsNicknameThenItsRoleAndOtherwiseByItsGoal() {
        let darwin = Subagent(id: "t1", goal: "pear reply", nickname: "Darwin", role: "worker", turn: 1, startedAt: t0)
        #expect(darwin.title == "Darwin · worker")
        // Its path stays its goal, which its detail shows.
        #expect(darwin.goal == "pear reply")
        #expect(Subagent(id: "t2", goal: "fig check", nickname: "Hopper").title == "Hopper")
        // With no nickname, as before: a role alone does not name it.
        #expect(Subagent(id: "t3", goal: "Count the files", role: "Explore").title == "Count the files")
        #expect(Subagent(id: "t4", goal: "").title == "An agent")
        // A workflow goes by its name, whatever else it carries.
        #expect(Subagent(id: "w", goal: "Two agents", kind: .workflow, name: "tiny-check", nickname: "x").title == "tiny-check")
        #expect(Subagent(id: "w2", goal: "", kind: .workflow).title == "A workflow")
    }

    @Test func aSubagentsOwnSubagentComesRightAfterTheOneThatStartedIt() {
        let outer = Subagent(id: "a", goal: "Outer")
        let sibling = Subagent(id: "b", goal: "Sibling")
        let inner = Subagent(id: "c", goal: "Inner", parentID: "a")
        let innermost = Subagent(id: "d", goal: "Innermost", parentID: "c")
        let orphan = Subagent(id: "e", goal: "Its parent left the line", parentID: "gone")
        let shown = [outer, sibling, inner, innermost, orphan].nested
        #expect(shown.map(\.agent.id) == ["a", "c", "d", "b", "e"])
        #expect(shown.map(\.depth) == [0, 1, 2, 0, 0])
        // A loop of parents, which no host sends, still shows each once.
        let loop = [Subagent(id: "x", goal: "", parentID: "y"), Subagent(id: "y", goal: "", parentID: "x")].nested
        #expect(loop.map(\.agent.id) == ["x", "y"])
    }

    @Test func theOnesNamedLeaveTheLineAndTheOthersStay() {
        var state = ThreadState()
        let ended = Subagent(id: "a", goal: "one", state: .finished, turn: 1, startedAt: t0, endedAt: t0)
        let failed = Subagent(id: "b", goal: "two", state: .failed, turn: 1, startedAt: t0, endedAt: t0)
        let working = Subagent(id: "c", goal: "three", turn: 1, startedAt: t0)
        let missed = Subagent(id: "d", goal: "four", turn: 1, startedAt: t0)
        for agent in [ended, failed, working, missed] { state.apply(.subagent(agent), at: t0) }
        // The host names only ended ones: one shown here as working had its end missed.
        state.apply(.subagentsCleared(["a", "d", "unknown"]), at: t0)
        #expect(state.subagents.map(\.id) == ["b", "c"])
        state.apply(.subagentsCleared(["b"]), at: t0)
        #expect(state.subagents.map(\.id) == ["c"])
        // One at work again comes back with its news.
        state.apply(.subagent(Subagent(id: "a", goal: "one", turn: 1, startedAt: t0)), at: t0)
        #expect(state.subagents.map(\.id) == ["c", "a"])
    }
}

/// A command the agent left running in the background: a row of the line that stays live,
/// in a thread that is finished (2026-10-26).
@Suite struct BackgroundCommandTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func command(_ id: String = "bg-1", state: Subagent.State = .working, output: String? = nil) -> Subagent {
        Subagent(id: id, goal: "npm run dev", state: state, kind: .command, turn: 1, startedAt: t0, output: output, canStop: state == .working)
    }

    @Test func aThreadWhoseOnlyWorkLeftIsABackgroundCommandIsFinished() {
        var state = ThreadState()
        state.messageSent("start the dev server", at: t0)
        state.apply(.subagent(command()), at: t0)
        // The turn is what keeps it at work while it runs.
        #expect(state.isAtWork)
        state.apply(.turnFinished(.completed, finalText: "It is running."), at: t0)
        // Finished, as the bridge says it is (`hasRunningSubagents`): out of Running, its
        // tab and its agent at rest, and free to be let go of off screen.
        #expect(!state.isRunning)
        #expect(!state.isAtWork)
        // Its row works on: its output comes in, and it can still be stopped.
        state.apply(.subagent(command(output: "GET /page/1 200")), at: t0)
        #expect(state.subagents.map(\.isWorking) == [true])
        #expect(state.subagents.first?.output == "GET /page/1 200")
        #expect(state.subagents.first?.canStop == true)
        #expect(!state.isAtWork)
        #expect(!command().keepsThreadAtWork)
        #expect(!command(state: .finished).keepsThreadAtWork)
    }

    @Test func anAgentOrAWorkflowBesideItKeepsTheThreadAtWorkUntilItEnds() {
        for kind in [Subagent.Kind.agent, .workflow] {
            var state = ThreadState()
            state.messageSent("research this", at: t0)
            state.apply(.subagent(command()), at: t0)
            state.apply(.subagent(Subagent(id: "a1", goal: "Audit", kind: kind, turn: 1, startedAt: t0)), at: t0)
            state.apply(.turnFinished(.completed, finalText: "They are on it."), at: t0)
            #expect(state.isAtWork, "\(kind)")
            state.apply(.subagent(Subagent(id: "a1", goal: "Audit", state: .finished, kind: kind, turn: 1, startedAt: t0, endedAt: t0)), at: t0)
            // The command still runs; the thread is finished.
            #expect(!state.isAtWork, "\(kind)")
            #expect(state.subagents.filter(\.isWorking).map(\.id) == ["bg-1"], "\(kind)")
        }
    }

    @Test func aCommandRunningInTheBackgroundIsNoMoreThanWaitingOnTheUser() {
        // The wash holds still while the agent waits on an approval, a command running or not.
        let approval = PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "rm -rf build", reason: nil)))
        var state = ThreadState()
        state.messageSent("clean up", at: t0)
        state.apply(.turnStarted, at: t0)
        state.apply(.subagent(command()), at: t0)
        state.apply(.requestOpened(approval), at: t0)
        #expect(state.waitsOnlyOnUser)
        // An agent at work beside it is more.
        state.apply(.subagent(Subagent(id: "a1", goal: "Count the files", turn: 1, startedAt: t0)), at: t0)
        #expect(!state.waitsOnlyOnUser)
    }
}

/// The one line at the foot of a chat: its parts, its title and its mark (2026-10-26).
@Suite struct FootLineTests {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func agent(_ id: String, _ kind: Subagent.Kind = .agent, state: Subagent.State = .working, parent: String? = nil) -> Subagent {
        Subagent(id: id, goal: id, state: state, kind: kind, parentID: parent, turn: 1, startedAt: t0)
    }

    @Test func theRowsComeInHisOrderOfPartsEachInTheOrderTheyStarted() {
        // Started mixed, as the line showed them before.
        let started = [agent("dev", .command), agent("a1"), agent("w1", .workflow), agent("a2"), agent("test", .command)]
        let rows = FootLine.rows(of: started, threads: 2)
        #expect(rows.parts == [.subagents, .workflows, .threads, .commands])
        #expect(rows.agents[.subagents]?.map(\.agent.id) == ["a1", "a2"])
        #expect(rows.agents[.workflows]?.map(\.agent.id) == ["w1"])
        #expect(rows.agents[.commands]?.map(\.agent.id) == ["dev", "test"])
        #expect(rows.agents[.threads] == nil)
        #expect(rows.headed)
        #expect(FootLine.Part.allCases.map(\.title) == ["Subagents", "Workflows", "Managed threads", "Background tasks"])
    }

    @Test func aChildStaysUnderItsParentInItsParentsPart() {
        let started = [
            agent("a1"),
            agent("w1", .workflow),
            // A subagent's own subagent, and a command it left running.
            agent("a1-inner", parent: "a1"),
            agent("a1-dev", .command, parent: "a1-inner"),
            // A subagent a workflow started.
            agent("w1-agent", parent: "w1"),
            // Its parent has left the line: a row of its own part.
            agent("orphan", .command, parent: "gone"),
        ]
        let rows = FootLine.rows(of: started, threads: 0)
        #expect(rows.agents[.subagents]?.map(\.agent.id) == ["a1", "a1-inner", "a1-dev"])
        #expect(rows.agents[.subagents]?.map(\.depth) == [0, 1, 2])
        #expect(rows.agents[.workflows]?.map(\.agent.id) == ["w1", "w1-agent"])
        #expect(rows.agents[.workflows]?.map(\.depth) == [0, 1])
        #expect(rows.agents[.commands]?.map(\.agent.id) == ["orphan"])
        #expect(rows.parts == [.subagents, .workflows, .commands])
    }

    @Test func headingsShowOnlyWhenMoreThanOnePartHasRows() {
        #expect(!FootLine.rows(of: [agent("a1"), agent("a2")], threads: 0).headed)
        #expect(!FootLine.rows(of: [], threads: 3).headed)
        #expect(FootLine.rows(of: [], threads: 3).parts == [.threads])
        // A command a subagent started is in the subagent's part: still one part.
        #expect(!FootLine.rows(of: [agent("a1"), agent("dev", .command, parent: "a1")], threads: 0).headed)
        #expect(FootLine.rows(of: [agent("dev", .command)], threads: 1).headed)
    }

    @Test func ofOneKindTheTitleSaysWhatEachLineSaidBefore() {
        // The subagents line's.
        #expect(FootLine.title(of: [agent("a1"), agent("a2", state: .finished)], threads: []) == "1 of 2 agents still working")
        #expect(FootLine.title(of: [agent("w1", .workflow)], threads: []) == "1 workflow working")
        #expect(FootLine.title(of: [agent("c1", .command), agent("c2", .command)], threads: []) == "2 commands working")
        #expect(FootLine.title(of: [agent("a1"), agent("c1", .command)], threads: []) == "2 working")
        #expect(FootLine.title(of: [agent("a1", state: .finished), agent("a2", state: .finished)], threads: []) == "2 agents done")
        #expect(FootLine.title(of: [agent("a1", state: .finished), agent("a2", state: .stopped)], threads: []) == "2 agents ended")
        // The started threads' line's.
        #expect(FootLine.title(of: [], threads: [.running, nil]) == "1 of 2 threads still working")
        #expect(FootLine.title(of: [], threads: [.running, .running]) == "2 threads working")
        #expect(FootLine.title(of: [], threads: [nil, nil, nil]) == "Started 3 threads")
        #expect(FootLine.title(of: [], threads: [.waiting]) == "1 thread needs you")
        #expect(FootLine.title(of: [], threads: [.waiting, .waiting, nil]) == "2 threads need you")
        #expect(FootLine.title(of: [], threads: [.waiting, .running, .running]) == "1 needs you · 2 working")
    }

    /// Of several kinds, the title only counts them (2026-10-27: "just say like 6
    /// working instead of 6 tasks working").
    @Test func acrossKindsTheTitleSaysWhoNeedsYouFirstThenHowManyWork() {
        let crew = [agent("a1"), agent("w1", .workflow, state: .finished), agent("dev", .command)]
        #expect(FootLine.title(of: crew, threads: [.waiting]) == "1 needs you · 2 working")
        #expect(FootLine.title(of: crew, threads: [.running, nil]) == "3 of 5 still working")
        #expect(FootLine.title(of: [agent("a1")], threads: [.running]) == "2 working")
        #expect(FootLine.title(of: [agent("a1", state: .finished)], threads: [.waiting]) == "1 thread needs you")
        #expect(FootLine.title(of: [agent("a1", state: .finished)], threads: [nil]) == "2 done")
        #expect(FootLine.title(of: [agent("a1", state: .stopped)], threads: [nil, nil]) == "3 ended")
        #expect(FootLine.title(of: [agent("a1", state: .finished), agent("dev", .command, state: .finished)], threads: []) == "2 done")
        #expect(FootLine.title(of: [agent("a1"), agent("dev", .command, state: .finished)], threads: []) == "1 of 2 still working")
        // Agents and workflows, which said "2 agents working".
        #expect(FootLine.title(of: [agent("a1"), agent("w1", .workflow)], threads: []) == "2 working")
        #expect(FootLine.title(of: [agent("a1", state: .finished), agent("w1", .workflow)], threads: []) == "1 of 2 still working")
        #expect(FootLine.title(of: [agent("a1", state: .finished), agent("w1", .workflow, state: .finished)], threads: []) == "2 done")
        // A subagent a workflow started is one of several kinds with it.
        #expect(FootLine.title(of: [agent("w1", .workflow), agent("w1-agent", parent: "w1")], threads: []) == "2 working")
        // Six at work, as asked.
        let six = [agent("a1"), agent("a2"), agent("w1", .workflow), agent("dev", .command)]
        #expect(FootLine.title(of: six, threads: [.running, .running]) == "6 working")
        // Short enough for a phone's width with the line's mark, icons and chevron.
        let longest = FootLine.title(of: Array(repeating: agent("a"), count: 12), threads: Array(repeating: ThreadActivity?.some(.running), count: 12) + [nil])
        #expect(longest == "24 of 25 still working")
    }

    @Test func theTitleNamesOneKindAndNoneForSeveral() {
        #expect(FootLine.noun(of: [agent("a1"), agent("a2")], threads: false)?.many == "agents")
        // Agents with workflows are of several kinds too (2026-10-27).
        #expect(FootLine.noun(of: [agent("a1"), agent("w1", .workflow)], threads: false) == nil)
        #expect(FootLine.noun(of: [agent("w1", .workflow)], threads: false)?.many == "workflows")
        #expect(FootLine.noun(of: [agent("c1", .command)], threads: false)?.many == "commands")
        #expect(FootLine.noun(of: [], threads: true)?.many == "threads")
        #expect(FootLine.noun(of: [agent("a1"), agent("c1", .command)], threads: false) == nil)
        #expect(FootLine.noun(of: [agent("a1")], threads: true) == nil)
    }

    /// VoiceOver's hints say what the title says they are, and nothing of the kind for
    /// several kinds, where it said "tasks".
    @Test func theHintsSayWhatTheTitleCallsThem() {
        #expect(FootLine.hints(of: [agent("a1")], threads: false) == (open: "Hides the agents", closed: "Shows what each agent is doing"))
        #expect(FootLine.hints(of: [], threads: true) == (open: "Hides the threads", closed: "Shows what each thread is doing"))
        #expect(FootLine.hints(of: [agent("a1"), agent("c1", .command)], threads: false) == (open: "Hides the list", closed: "Shows what each one is doing"))
        #expect(FootLine.hints(of: [agent("w1", .workflow)], threads: true) == (open: "Hides the list", closed: "Shows what each one is doing"))
    }

    /// One small icon for the subagents and one for the workflows, each while one of its
    /// kind works, never one for each (2026-10-27: "dont duplicate them just have
    /// like a small icon for each").
    @Test func theClosedLineHasAnIconForEachKindAtWork() {
        #expect(FootLine.icons(of: []).isEmpty)
        #expect(FootLine.icons(of: [agent("a1"), agent("a2"), agent("a3")]) == [.subagents])
        #expect(FootLine.icons(of: [agent("w1", .workflow), agent("w2", .workflow)]) == [.workflows])
        // In the line's order, whatever order they started in.
        #expect(FootLine.icons(of: [agent("w1", .workflow), agent("a1")]) == [.subagents, .workflows])
        // Gone once none of its kind works.
        #expect(FootLine.icons(of: [agent("a1", state: .finished), agent("w1", .workflow)]) == [.workflows])
        #expect(FootLine.icons(of: [agent("a1", state: .stopped), agent("w1", .workflow, state: .failed)]).isEmpty)
        // A command has none: Background tasks were not asked for.
        #expect(FootLine.icons(of: [agent("dev", .command)]).isEmpty)
        // A subagent a workflow started is a subagent at work.
        #expect(FootLine.icons(of: [agent("w1", .workflow), agent("w1-agent", parent: "w1")]) == [.subagents, .workflows])
    }

    /// With background tasks turned off in Settings, the commands leave the line and nothing
    /// else does (2026-11-02).
    @Test func backgroundTasksTurnedOffLeaveTheLine() {
        let crew = [agent("a1"), agent("w1", .workflow), agent("dev", .command)]
        let line = FootLine.shown(crew, at: t0, showsCommands: false)
        #expect(line.map(\.id) == ["a1", "w1"])
        #expect(FootLine.rows(of: line, threads: 0).parts == [.subagents, .workflows])
        // Alone, no line at all.
        #expect(FootLine.shown([agent("dev", .command)], at: t0, showsCommands: false).isEmpty)
        // Turned on, as they always were.
        #expect(FootLine.shown(crew, at: t0).map(\.id) == ["a1", "w1", "dev"])
    }

    /// A background command that finished leaves the line by itself a moment after, the
    /// turn still running or not, with no message to the agent (2026-10-27:
    /// "completed background tasks just clear by themselves even before the turn ends").
    @Test func aFinishedCommandLeavesTheLineAMomentAfter() {
        let ended = t0.addingTimeInterval(60)
        var dev = agent("dev", .command, state: .finished)
        dev.endedAt = ended
        let crew = [agent("a1"), dev]
        // Done for a moment: on the line, counted.
        let during = FootLine.shown(crew, at: ended.addingTimeInterval(1))
        #expect(during.map(\.id) == ["a1", "dev"])
        #expect(FootLine.title(of: during, threads: []) == "1 of 2 still working")
        // Then gone: from the rows and the title.
        let after = FootLine.shown(crew, at: ended.addingTimeInterval(FootLine.finishedCommandStays))
        #expect(after.map(\.id) == ["a1"])
        #expect(FootLine.rows(of: after, threads: 0).parts == [.subagents])
        #expect(FootLine.title(of: after, threads: []) == "1 agent working")
        // Alone, it leaves nothing: the line goes.
        #expect(FootLine.shown([dev], at: ended.addingTimeInterval(30)).isEmpty)
        // The line changes by itself when it leaves, and not after.
        #expect(FootLine.nextClearing(of: crew, after: ended) == ended.addingTimeInterval(FootLine.finishedCommandStays))
        #expect(FootLine.nextClearing(of: crew, after: ended.addingTimeInterval(30)) == nil)
    }

    /// One that failed or was stopped leaves the same way, after its moment, and reads as
    /// failed meanwhile, not as done (2026-10-27: "yes they should clear"); the
    /// subagents and workflows that ended stay ("no they should show").
    @Test func aFailedOrStoppedCommandLeavesTooAndEndedAgentsStay() {
        let ended = t0.addingTimeInterval(60)
        func ending(_ id: String, _ kind: Subagent.Kind, _ state: Subagent.State) -> Subagent {
            var row = agent(id, kind, state: state)
            row.endedAt = ended
            return row
        }
        let failed = ending("failed", .command, .failed)
        let rows = [failed, ending("stopped", .command, .stopped), ending("a1", .agent, .finished), ending("w1", .workflow, .finished)]
        // Its moment: on the line, failed.
        let during = FootLine.shown([failed], at: ended.addingTimeInterval(1))
        #expect(during.map(\.id) == ["failed"])
        #expect(FootLine.mark(of: during, threads: []) == .failed)
        #expect(FootLine.title(of: during, threads: []) == "1 command ended")
        #expect(FootLine.nextClearing(of: rows, after: ended) == ended.addingTimeInterval(FootLine.finishedCommandStays))
        // After it: the commands gone, the agents and the workflow there.
        let later = ended.addingTimeInterval(3600)
        #expect(FootLine.shown(rows, at: later).map(\.id) == ["a1", "w1"])
        #expect(FootLine.shown([failed], at: later).isEmpty)
        // A command whose host says not when it ended stays, as before.
        #expect(FootLine.shown([agent("dev", .command, state: .failed)], at: later).count == 1)
    }

    /// The line's mark says one did not finish once nothing works or waits, a subagent too.
    @Test func theMarkSaysOneFailedOnceNothingWorks() {
        #expect(FootLine.mark(of: [agent("a1", state: .failed), agent("a2", state: .finished)], threads: []) == .failed)
        #expect(FootLine.mark(of: [agent("a1", state: .failed), agent("a2")], threads: []) == .working)
        #expect(FootLine.mark(of: [agent("a1", state: .failed)], threads: [.waiting]) == .waiting)
        #expect(FootLine.mark(of: [agent("a1", state: .stopped)], threads: []) == .ended)
    }

    @Test func theMarkSpinsWhileAnyOfItWorks() {
        #expect(FootLine.mark(of: [agent("dev", .command)], threads: []) == .working)
        #expect(FootLine.mark(of: [agent("a1", state: .finished)], threads: [.running]) == .working)
        #expect(FootLine.mark(of: [agent("a1", state: .finished)], threads: [.waiting, nil]) == .waiting)
        #expect(FootLine.mark(of: [agent("a1", state: .finished)], threads: [nil]) == .ended)
        #expect(FootLine.mark(of: [], threads: [nil, nil]) == .started)
    }
}
