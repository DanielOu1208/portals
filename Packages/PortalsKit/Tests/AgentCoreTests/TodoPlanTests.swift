import Foundation
import Testing
@testable import AgentCore

@Suite struct TodoPlanTests {
    @Test func numberedStatusLinesBecomeAChecklist() throws {
        let plan = try #require(TodoPlan.parse("1. [completed] Read the code\n2. [in_progress] Add parity\n3. [pending] Test"))
        #expect(plan.items.map(\.status) == [.completed, .inProgress, .pending])
        #expect(plan.completedCount == 1)
        #expect(plan.current?.text == "Add parity")
        #expect(try JSONDecoder().decode(TodoPlan.self, from: JSONEncoder().encode(plan)) == plan)
    }

    @Test func malformedInputIsNotMisrepresentedAsAPlan() {
        for text in ["Do things", "1. [unknown] Wrong", "1. [pending]", ". [pending] Missing number", "1. [pending] Good\nUnstructured continuation"] {
            #expect(TodoPlan.parse(text) == nil)
        }
        #expect(TodoPlan.parse(" \n")?.items == [])
        #expect(TodoPlan.parse("1. [pending] First")?.current?.text == "First")
    }

    @Test func onlySuccessfulPlansReplaceTheCurrentPlan() throws {
        var state = ThreadState()
        let first = try #require(TodoPlan.parse("1. [pending] First"))
        let second = try #require(TodoPlan.parse("1. [completed] First"))
        state.apply(.toolStarted(ToolRun(id: "1", name: "todo", plan: first)))
        #expect(state.currentPlan == nil)
        state.apply(.toolFinished(ToolResult(id: "1", name: "todo", succeeded: true, plan: first)))
        #expect(state.currentPlan == first)
        state.apply(.toolStarted(ToolRun(id: "2", name: "todo", plan: second)))
        state.apply(.toolFinished(ToolResult(id: "2", name: "todo", succeeded: false, plan: second)))
        #expect(state.currentPlan == first)
        var restored = ThreadState()
        restored.adopt(ThreadSnapshot(transcript: state.transcript))
        #expect(restored.currentPlan == first)
        state.apply(.toolFinished(ToolResult(id: "3", name: "todo", succeeded: true, plan: second)))
        #expect(state.currentPlan?.current == nil)
        state.apply(.toolFinished(ToolResult(id: "4", name: "todo", succeeded: true, plan: TodoPlan(items: []))))
        #expect(state.currentPlan?.items == [])
    }

    @Test func progressNamesTheCurrentStepsPositionRatherThanTheCompletedCount() {
        let plan = TodoPlan(items: [
            TodoItem(text: "Waiting on a dependency", status: .pending),
            TodoItem(text: "Already done", status: .completed),
            TodoItem(text: "Run the checks", status: .inProgress),
        ])
        #expect(plan.summary == "Step 3 of 3 · Run the checks")
        #expect(TodoPlan(items: [
            TodoItem(text: "Done", status: .completed),
            TodoItem(text: "Next", status: .pending),
        ]).summary == "Step 2 of 2 · Next")
        #expect(TodoPlan(items: [TodoItem(text: "Done", status: .completed)]).summary == "Plan complete · 1 of 1")
        #expect(TodoPlan(items: []).summary == nil)
    }

    @Test func tasksAndLiveToolActivityRemainIndependentWhileRunning() throws {
        var state = ThreadState()
        let plan = try #require(TodoPlan.parse("1. [completed] Read\n2. [in_progress] Build"))
        state.apply(.turnStarted)
        state.apply(.toolFinished(ToolResult(id: "plan", name: "todo", succeeded: true, plan: plan)))
        state.apply(.toolStarted(ToolRun(id: "build", name: "terminal", label: "swift test")))
        state.apply(.toolProgress(ToolProgress(id: "build", output: "Compiling\nTests are running")))

        guard case let .tool(run, others) = state.runStatus(replyIsArriving: false) else {
            Issue.record("A plan must not replace the running tool status")
            return
        }
        #expect(run.id == "build")
        #expect(run.output == "Compiling\nTests are running")
        #expect(others == 0)
        #expect(state.runningPlan?.summary == "Step 2 of 2 · Build")

        let complete = TodoPlan(items: plan.items.map { TodoItem(text: $0.text, status: .completed) })
        state.apply(.toolFinished(ToolResult(id: "plan-done", name: "todo", succeeded: true, plan: complete)))
        #expect(state.runningPlan?.summary == "Plan complete · 2 of 2")
        #expect(state.runStatus(replyIsArriving: false) == .tool(run, others: 0))
        state.apply(.turnFinished(.completed, finalText: nil))
        #expect(state.runningPlan == nil)
        #expect(state.runStatus(replyIsArriving: false) == nil)
    }

    @Test func theRunningPlanRestoresOnlyWhileATurnRunsAndClearsWhenItEnds() throws {
        let plan = try #require(TodoPlan.parse("1. [completed] Read\n2. [in_progress] Build\n3. [pending] Test"))
        var state = ThreadState()
        #expect(state.runningPlan == nil)
        state.apply(.turnStarted)
        state.apply(.toolFinished(ToolResult(id: "plan", name: "todo", succeeded: true, plan: plan)))
        #expect(state.runningPlan == plan)

        // The cached transcript alone is not evidence that the host still runs.
        var reopened = ThreadState(transcript: state.transcript)
        #expect(reopened.currentPlan == plan)
        #expect(reopened.runningPlan == nil)
        reopened.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(reopened.runningPlan == plan)
        reopened.apply(.turnFinished(.completed, finalText: nil))
        #expect(reopened.currentPlan == plan)
        #expect(reopened.runningPlan == nil)
        #expect(reopened.runStatus(replyIsArriving: false) == nil)

        var idle = ThreadState()
        idle.adopt(ThreadSnapshot(transcript: reopened.transcript))
        #expect(idle.currentPlan == plan)
        #expect(idle.runningPlan == nil)
        // A later turn can continue the saved plan, but an explicitly empty update clears it.
        idle.apply(.turnStarted)
        #expect(idle.runningPlan == plan)
        idle.apply(.toolFinished(ToolResult(id: "clear", name: "todo", succeeded: true, plan: TodoPlan(items: []))))
        #expect(idle.runningPlan == nil)
    }

    @Test func aCompletedPlanDoesNotReturnInAnotherTurnUntilANewTodoWrite() throws {
        let complete = try #require(TodoPlan.parse("1. [completed] Read\n2. [completed] Build\n3. [completed] Test"))
        var state = ThreadState()
        state.apply(.turnStarted)
        state.apply(.toolFinished(ToolResult(id: "first-plan", name: "todo", succeeded: true, plan: complete)))
        #expect(state.runningPlan?.summary == "Plan complete · 3 of 3")
        state.apply(.turnFinished(.completed, finalText: nil))
        state.apply(.turnStarted)
        #expect(state.currentPlan == complete)
        #expect(state.runningPlan == nil)

        var restored = ThreadState()
        restored.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(restored.runningPlan == nil)
        state.apply(.toolFinished(ToolResult(id: "new-plan", name: "todo", succeeded: true, plan: complete)))
        #expect(state.runningPlan == complete)
        restored.adopt(ThreadSnapshot(transcript: state.transcript, isRunning: true))
        #expect(restored.runningPlan == complete)
    }
}
