import Foundation
import Testing
@testable import AgentCore

/// What the agent says it is working on, on the status line in place of "Thinking…"
/// (`StatusHeadline`; 2026-10-26.
@Suite struct StatusHeadlineTests {
    private func running() -> ThreadState {
        var state = ThreadState()
        state.messageSent("Check the primes")
        state.apply(.turnStarted)
        return state
    }

    private func status(_ state: ThreadState) -> RunStatus? { state.runStatus(replyIsArriving: false) }

    @Test func aTitleIsABoldLineByItself() {
        #expect(StatusHeadline.title(of: "**Validating prime numbers**") == "Validating prime numbers")
        #expect(StatusHeadline.title(of: "  **Validating prime numbers**  ") == "Validating prime numbers")
        // Bold that opens prose, two bold runs, nothing between the marks, a paragraph of bold.
        #expect(StatusHeadline.title(of: "**Note:** the cache is cold") == nil)
        #expect(StatusHeadline.title(of: "**a** and **b**") == nil)
        #expect(StatusHeadline.title(of: "** **") == nil)
        #expect(StatusHeadline.title(of: "****") == nil)
        #expect(StatusHeadline.title(of: Substring("**" + String(repeating: "word ", count: 50) + "**")) == nil)
        #expect(StatusHeadline.title(of: "Validating prime numbers") == nil)
    }

    /// Codex's summary as the bridge passes it on (bridge/test/fixtures/codex/reasoning.jsonl):
    /// the title and the start of its prose in one piece, then the prose word by word; a
    /// second part after a blank line the bridge puts between parts.
    @Test func codexsTitleIsTheHeadlineThroughItsThought() {
        var state = running()
        #expect(status(state) == .thinking)
        state.apply(.reasoningDelta("**Validating prime numbers**\n\nI"))
        #expect(status(state) == .headline("Validating prime numbers"))
        for word in [" need", " to", " compute", " 40", "."] { state.apply(.reasoningDelta(word)) }
        #expect(status(state) == .headline("Validating prime numbers"))
        state.apply(.reasoningDelta("\n\n"))
        state.apply(.reasoningDelta("**Checking n = 40**\n\nIt is 41²."))
        #expect(state.headline == "Checking n = 40")
    }

    /// A title streamed in pieces is taken once, whole: once the line break after its
    /// closing marks comes, never "Valid" or a title without its end.
    @Test func aTitleInPiecesIsTakenWhenItsLineCloses() {
        var state = running()
        state.apply(.reasoningDelta("**Valid"))
        #expect(state.headline == nil)
        state.apply(.reasoningDelta("ating prime numbers"))
        state.apply(.reasoningDelta("**"))
        #expect(state.headline == nil)
        state.apply(.reasoningDelta("\n\nI need to"))
        #expect(state.headline == "Validating prime numbers")
        // Bold opening a line of prose is no title, once its line shows it.
        state.apply(.reasoningDelta("\n**Note:** the cache is cold\n"))
        #expect(state.headline == "Validating prime numbers")
    }

    /// A thought whose last line is a title, with no line break after it, gives it as the
    /// agent moves on.
    @Test func aThoughtEndingWithATitleGivesItAsItEnds() {
        var state = running()
        state.apply(.reasoningDelta("**Reading the notifier**"))
        #expect(state.headline == nil)
        state.apply(.toolStarted(ToolRun(id: "r1", name: "read_file", label: "notifier.ts")))
        state.apply(.toolFinished(ToolResult(id: "r1", name: "read_file", succeeded: true, duration: 0.1)))
        #expect(status(state) == .headline("Reading the notifier"))
    }

    /// It outlasts the thinking and the calls that take a note down, and goes when the agent
    /// says something and at the turn's end; a call running still takes the line.
    @Test func itHoldsUntilTheAgentSaysSomething() {
        var state = running()
        state.apply(.reasoningDelta("**Validating prime numbers**\n\nFirst the small ones."))
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", label: "python primes.py")))
        guard case .tool? = status(state) else {
            Issue.record("a running call takes the line")
            return
        }
        state.apply(.toolFinished(ToolResult(id: "t1", name: "terminal", succeeded: true, duration: 0.4)))
        #expect(status(state) == .headline("Validating prime numbers"))
        // More thinking with no title of its own keeps it.
        state.apply(.reasoningDelta("All prime up to 39."))
        #expect(status(state) == .headline("Validating prime numbers"))
        // The agent says something: the work it was about is over.
        state.apply(.textDelta("40 is the first."))
        #expect(state.headline == nil)
        state.apply(.toolStarted(ToolRun(id: "t2", name: "terminal", label: "python check.py")))
        state.apply(.toolFinished(ToolResult(id: "t2", name: "terminal", succeeded: true, duration: 0.2)))
        #expect(status(state) == .thinking)
        state.apply(.reasoningDelta("**Double-checking 41²**\n\n"))
        #expect(state.headline == "Double-checking 41²")
        state.apply(.turnFinished(.completed, finalText: nil))
        #expect(state.headline == nil)
        #expect(status(state) == nil)
        // The next turn starts with none.
        state.messageSent("And 41?")
        state.apply(.turnStarted)
        #expect(state.headline == nil)
    }

    /// Where it sits: below waiting for the user, a call running, a note and a visual being
    /// planned; only an agent's words for its state that say no more than "Thinking…" give
    /// way to it.
    @Test func itTakesOnlyThinkingsPlace() {
        var state = running()
        state.apply(.reasoningDelta("**Validating prime numbers**\n\n"))
        state.apply(.status("Claude's API did not answer; trying again (attempt 2 of 10)…"))
        #expect(status(state) == .note("Claude's API did not answer; trying again (attempt 2 of 10)…"))
        state.apply(.status(nil))
        #expect(status(state) == .headline("Validating prime numbers"))
        // Droid's working state, sent as a status line.
        state.apply(.status("Thinking"))
        #expect(status(state) == .headline("Validating prime numbers"))
        state.apply(.status("Compacting conversation"))
        #expect(status(state) == .note("Compacting conversation"))
        state.apply(.status(nil))
        state.apply(.requestOpened(PendingRequest(id: "srq-1", kind: .approval(ApprovalRequest(command: "ls", reason: nil, choices: [.once, .deny])))))
        #expect(status(state) == .waitingForUser)
        // With no headline, the state's words show as before.
        var plain = running()
        plain.apply(.status("Thinking"))
        #expect(status(plain) == .note("Thinking"))
    }

    /// Claude Code's to-do in progress, worded as it runs: taken when it changes, so a list
    /// written again with the same one in progress does not undo a newer headline.
    @Test func theToDoInProgressIsAHeadlineWhenItChanges() {
        var state = running()
        func write(_ id: String, _ current: Int) {
            let plan = TodoPlan(items: [
                TodoItem(text: "Read the notifier", status: current == 0 ? .inProgress : .completed, activeForm: "Reading the notifier"),
                TodoItem(text: "Run the tests", status: current == 1 ? .inProgress : .pending, activeForm: "Running the tests"),
            ])
            state.apply(.toolStarted(ToolRun(id: id, name: "todo", plan: plan)))
            state.apply(.toolFinished(ToolResult(id: id, name: "todo", succeeded: true, plan: plan)))
        }
        write("a", 0)
        #expect(status(state) == .headline("Reading the notifier"))
        state.apply(.headline("Read notifier.ts", toolIDs: ["a"]))
        #expect(state.headline == "Read notifier.ts")
        write("b", 0)
        #expect(state.headline == "Read notifier.ts")
        write("c", 1)
        #expect(state.headline == "Running the tests")
        // A list with nothing worded, or nothing in progress, says nothing newer.
        state.apply(.toolFinished(ToolResult(id: "d", name: "todo", succeeded: true, plan: TodoPlan(items: [TodoItem(text: "Run the tests", status: .inProgress)]))))
        #expect(state.headline == "Running the tests")
    }

    /// Claude Code's summary of a run of its calls, which it makes after the run: taken while
    /// one of the calls it sums up is in the work under way, not once the agent has said
    /// something since them.
    @Test func aSummaryIsTakenOnlyForTheWorkUnderWay() {
        var state = running()
        state.apply(.toolStarted(ToolRun(id: "toolu_1", name: "read_file", label: "a.txt")))
        state.apply(.toolFinished(ToolResult(id: "toolu_1", name: "read_file", succeeded: true, duration: 0.1)))
        state.apply(.toolStarted(ToolRun(id: "toolu_2", name: "read_file", label: "b.txt")))
        state.apply(.headline("Read a.txt", toolIDs: ["toolu_1"]))
        state.apply(.toolFinished(ToolResult(id: "toolu_2", name: "read_file", succeeded: true, duration: 0.1)))
        #expect(status(state) == .headline("Read a.txt"))
        state.apply(.textDelta("Both files read."))
        state.apply(.headline("Read b.txt", toolIDs: ["toolu_2"]))
        #expect(state.headline == nil)
        // One that names no calls is taken as it comes.
        state.apply(.toolStarted(ToolRun(id: "toolu_3", name: "terminal", label: "ls")))
        state.apply(.headline("Listed the folder", toolIDs: []))
        state.apply(.toolFinished(ToolResult(id: "toolu_3", name: "terminal", succeeded: true, duration: 0.1)))
        #expect(state.headline == "Listed the folder")
        state.apply(.headline("  ", toolIDs: []))
        #expect(state.headline == "Listed the folder")
    }

    /// Codex review: a list written that did not take says nothing of what is under way; the
    /// same wording comes back once the work it was about ended or the agent said something.
    @Test func onlyAListThatTookGivesItsWording() {
        var state = running()
        let reading = TodoPlan(items: [TodoItem(text: "Read A", status: .inProgress, activeForm: "Reading A")])
        state.apply(.toolStarted(ToolRun(id: "a", name: "todo", plan: reading)))
        state.apply(.toolFinished(ToolResult(id: "a", name: "todo", succeeded: false, plan: reading)))
        #expect(state.headline == nil)
        state.apply(.toolStarted(ToolRun(id: "b", name: "todo", plan: reading)))
        state.apply(.toolFinished(ToolResult(id: "b", name: "todo", succeeded: true, plan: reading)))
        #expect(state.headline == "Reading A")
        // Done, the agent says so, then the same item is in progress again: it is the headline again.
        let done = TodoPlan(items: [TodoItem(text: "Read A", status: .completed, activeForm: "Reading A")])
        state.apply(.toolFinished(ToolResult(id: "c", name: "todo", succeeded: true, plan: done)))
        state.apply(.textDelta("A is read."))
        #expect(state.headline == nil)
        state.apply(.toolFinished(ToolResult(id: "d", name: "todo", succeeded: true, plan: reading)))
        #expect(state.headline == "Reading A")
        // Unchanged in a new stretch with nothing said yet in it: taken there too.
        state.apply(.textDelta("Again."))
        state.apply(.toolFinished(ToolResult(id: "e", name: "todo", succeeded: true, plan: reading)))
        #expect(state.headline == "Reading A")
    }

    /// Codex review: a snapshot with a newer title in the same stretch gives the newer one; a
    /// thought still streaming gives none from its unclosed last line.
    @Test func aSnapshotsNewerTitleWinsAndAnOpenLineIsNoTitle() {
        var state = running()
        state.apply(.reasoningDelta("**Reading A**\n\nFirst A."))
        #expect(state.headline == "Reading A")
        var host = state
        host.apply(.reasoningDelta("\n\n**Reading B**\n\nThen B."))
        state.adopt(ThreadSnapshot(transcript: host.transcript, isRunning: true))
        #expect(state.headline == "Reading B")
        // A summary taken after the last title stays through a snapshot with nothing newer.
        state.apply(.toolStarted(ToolRun(id: "t1", name: "read_file", label: "b.txt")))
        state.apply(.headline("Read b.txt", toolIDs: ["t1"]))
        state.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(state.headline == "Read b.txt")
        // Opened while a thought ends in what may yet be a title.
        var open = running()
        open.apply(.reasoningDelta("Thinking first.\n**Maybe a title**"))
        var opened = ThreadState()
        opened.adopt(ThreadSnapshot(transcript: open.transcript, isRunning: true))
        #expect(opened.headline == nil)
    }

    /// Codex's re-check: a copy from the host makes its rows anew, with ids of their own, and
    /// a title can come in the thought a summary came during.
    @Test func aSummaryOutlastsRowsMadeAnewButNotANewerTitle() {
        var state = running()
        state.apply(.toolStarted(ToolRun(id: "toolu_1", name: "read_file", label: "a.txt")))
        state.apply(.toolFinished(ToolResult(id: "toolu_1", name: "read_file", succeeded: true, duration: 0.1)))
        state.apply(.headline("Read a.txt", toolIDs: ["toolu_1"]))
        // The same turn, its tool row made anew as a host's history gives it.
        var copy = state.transcript
        let last = copy.turns.count - 1
        copy.turns[last].items = copy.turns[last].items.map { item in
            if case .tool = item.content { TurnItem(item.content) } else { item }
        }
        state.adopt(ThreadSnapshot(transcript: copy, isRunning: true))
        #expect(state.headline == "Read a.txt")
        // A summary that came while a thought streamed, then a title later in that thought.
        var thinking = running()
        thinking.apply(.toolStarted(ToolRun(id: "toolu_2", name: "read_file", label: "b.txt")))
        thinking.apply(.toolFinished(ToolResult(id: "toolu_2", name: "read_file", succeeded: true, duration: 0.1)))
        thinking.apply(.reasoningDelta("Both read."))
        thinking.apply(.headline("Read b.txt", toolIDs: ["toolu_2"]))
        var host = thinking
        host.apply(.reasoningDelta("\n\n**Comparing the halves**\n\nThe owl first."))
        thinking.adopt(ThreadSnapshot(transcript: host.transcript, isRunning: true))
        #expect(thinking.headline == "Comparing the halves")
        // And with nothing newer in that thought, the summary stays.
        var calm = running()
        calm.apply(.reasoningDelta("**Reading**\n\nFirst."))
        calm.apply(.headline("Read c.txt", toolIDs: []))
        calm.adopt(ThreadSnapshot(transcript: calm.transcript, isRunning: true))
        #expect(calm.headline == "Read c.txt")
    }

    /// A thread opened again while it runs (the host's copy): the newest headline of the work
    /// under way, read from it whole; one of this device's for the same work stays.
    @Test func aSnapshotGivesTheHeadlineOfTheWorkUnderWay() {
        var state = running()
        state.apply(.reasoningDelta("**Validating prime numbers**\n\nFirst."))
        state.apply(.toolStarted(ToolRun(id: "t1", name: "terminal", label: "python primes.py")))
        var opened = ThreadState()
        opened.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(opened.headline == "Validating prime numbers")
        state.apply(.headline("Ran primes.py", toolIDs: ["t1"]))
        state.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(state.headline == "Ran primes.py")
        // At rest: none.
        opened.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: false))
        #expect(opened.headline == nil)
    }
}
