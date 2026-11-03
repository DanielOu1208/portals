import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct TodoPlanWireTests {
    @Test func todoInputIsParsedOnceForLiveAndStoredTools() throws {
        let todos = "1. [completed] Read\n2. [in_progress] Implement"
        let args: JSONValue = ["todos": .string(todos)]
        let payload: JSONValue = ["tool_id": "t", "name": "todo", "args": args, "result": ["success": true]]
        let started = try #require(HermesToolDisplay.started(payload, at: .now))
        let finished = try #require(HermesToolDisplay.finished(payload))
        #expect(started.plan == TodoPlan.parse(todos))
        #expect(finished.plan == started.plan)
        let transcript = HermesHistoryMapper.transcript(from: [
            ["role": "user", "text": "Implement"],
            ["role": "tool", "name": "todo", "tool_call_id": "t", "args": args, "content": "{\"success\":true}"],
            ["role": "assistant", "text": "Done"],
        ])
        #expect(transcript.currentPlan == started.plan)
        var state = ThreadState()
        state.apply(.toolStarted(started))
        state.apply(.toolFinished(ToolResult(id: "t", name: "todo", succeeded: true)))
        #expect(state.currentPlan == started.plan)
    }

    @Test func structuredItemsAndEmptyPlansAreSupported() {
        let items: JSONValue = [["text": "Read", "status": "completed"], ["text": "Test", "status": "pending"]]
        let expected = TodoPlan(items: [TodoItem(text: "Read", status: .completed), TodoItem(text: "Test", status: .pending)])
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["items": items]) == expected)
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["todos": items]) == expected)
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["todos": ""])?.items == [])
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["items": []])?.items == [])
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["todos": "Malformed"]) == nil)
        // A status the app does not know is an item still to do, not a list thrown away.
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["items": [["text": "Read", "status": "unknown"]]])?.items == [TodoItem(text: "Read", status: .pending)])
        #expect(HermesToolDisplay.todoPlan(name: "terminal", args: ["items": items]) == nil)
    }

    /// Every agent's list as its bridge sends it (bridge/src/providers): before 2026-10-26
    /// only `text` was read, and Claude Code's, Codex's and Cursor's lists had no checklist.
    @Test func everyAgentsListIsRead() throws {
        // Claude Code's TodoWrite, passed on as it is (claude/tools.ts), and its task tools
        // as the bridge maps them (claude/todos.ts): `content`, `status`, `activeForm`.
        let claude: JSONValue = ["todos": [
            ["content": "Read the notifier", "status": "completed", "activeForm": "Reading the notifier"],
            ["content": "Run the tests", "status": "in_progress", "activeForm": "Running the tests"],
            ["content": "Write the fix", "status": "pending", "activeForm": "Writing the fix"],
        ]]
        let plan = try #require(HermesToolDisplay.todoPlan(name: "todo", args: claude))
        #expect(plan.items.map(\.text) == ["Read the notifier", "Run the tests", "Write the fix"])
        #expect(plan.items.map(\.status) == [.completed, .inProgress, .pending])
        #expect(plan.current?.activeForm == "Running the tests")
        #expect(plan.summary == "Step 2 of 3 · Run the tests")
        // Codex's `turn/plan/updated` (codex/stream.ts): `content` and the statuses mapped
        // to Claude's; a row with Codex's own `inProgress` reads the same.
        let codex: JSONValue = ["todos": [["content": "Inspect", "status": "completed"], ["content": "Patch", "status": "in_progress"]]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: codex)?.summary == "Step 2 of 2 · Patch")
        let raw: JSONValue = ["todos": [["content": "Patch", "status": "inProgress"]]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: raw)?.items.first?.status == .inProgress)
        // Cursor's merged `update_todos` (acp/tools.ts `planTool`): `content` and `status`.
        let cursor: JSONValue = ["todos": [["content": "Plan", "status": "pending"]]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: cursor)?.items == [TodoItem(text: "Plan", status: .pending)])
        // Droid's TodoWrite (droid/tools.ts): its numbered lines and the `items` read from them.
        let droid: JSONValue = ["todos": "1. [completed] Inspect bridge\n2. [in_progress] Implement progress", "items": [
            ["text": "Inspect bridge", "status": "completed"], ["text": "Implement progress", "status": "in_progress"],
        ]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: droid)?.summary == "Step 2 of 2 · Implement progress")
        // An item with neither key, or with a blank `activeForm`, as before: no plan, no wording.
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: ["todos": [["status": "pending"]]]) == nil)
        let blank: JSONValue = ["todos": [["content": "Plan", "status": "pending", "activeForm": " "]]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: blank)?.items.first?.activeForm == nil)
    }

    /// Bug hunt round 4, KIT2: one item the app cannot read cost the whole list (no
    /// checklist, no "Step N of M"). Cursor's list keeps a `cancelled` item, and its status
    /// as Cursor writes it (`TODO_STATUS_*`) or one the app does not know yet, and an item
    /// whose content the bridge had to leave empty; the rest of the list still reads.
    @Test func aCursorListWithACancelledItemStillReads() throws {
        let cursor: JSONValue = ["todos": [
            ["content": "Read the notifier", "status": "completed"],
            ["content": "Try the old fix", "status": "cancelled"],
            ["content": "", "status": "pending"],
            ["content": "Run the tests", "status": "in_progress"],
            ["content": "Write the fix", "status": "TODO_STATUS_PENDING"],
            ["content": "Ship it", "status": "blocked"],
        ]]
        let plan = try #require(HermesToolDisplay.todoPlan(name: "todo", args: cursor))
        #expect(plan.items.map(\.text) == ["Read the notifier", "Try the old fix", "Run the tests", "Write the fix", "Ship it"])
        #expect(plan.items.map(\.status) == [.completed, .cancelled, .inProgress, .pending, .pending])
        #expect(plan.summary == "Step 3 of 5 · Run the tests")
        let raw: JSONValue = ["todos": [
            ["content": "Plan", "status": "TODO_STATUS_COMPLETED"], ["content": "Build", "status": "TODO_STATUS_IN_PROGRESS"],
            ["content": "Old idea", "status": "TODO_STATUS_CANCELLED"],
        ]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: raw)?.items.map(\.status) == [.completed, .inProgress, .cancelled])
        // A cancelled item is no step still to take: a list of done and cancelled ones is complete.
        let done: JSONValue = ["todos": [["content": "Plan", "status": "completed"], ["content": "Old idea", "status": "cancelled"]]]
        #expect(HermesToolDisplay.todoPlan(name: "todo", args: done)?.summary == "Plan complete · 2 of 2")
    }

    /// A plan saved with a status this app does not know (a later app's) still reads: the
    /// item as still to do, the rest as saved. `cancelled` is kept as it was saved.
    @Test func storedItemsWithAnUnknownStatusStillDecode() throws {
        let stored = Data(#"{"items":[{"text":"Read","status":"completed"},{"text":"Skip","status":"cancelled"},{"text":"Wait","status":"blocked"}]}"#.utf8)
        let plan = try JSONDecoder().decode(TodoPlan.self, from: stored)
        #expect(plan.items.map(\.status) == [.completed, .cancelled, .pending])
        let again = try JSONDecoder().decode(TodoPlan.self, from: JSONEncoder().encode(plan))
        #expect(again == plan)
    }

    /// `TodoItem` as builds before `cancelled` have it: three statuses, and a decoder that
    /// throws on any other, which cost the whole saved transcript.
    private struct OldTodoItem: Codable, Equatable {
        enum Status: String, Codable { case pending, inProgress = "in_progress", completed }
        var text: String
        var status: Status
        var activeForm: String?
    }

    private struct OldTodoPlan: Codable, Equatable {
        var items: [OldTodoItem]
    }

    /// Codex's review of the round 4 app fixes: a plan saved with a cancelled item still
    /// reads in an older build (one gone back to from TestFlight), as a done one; this build
    /// reads it back as cancelled.
    @Test func aSavedCancelledItemReadsInAnOlderBuild() throws {
        let plan = TodoPlan(items: [
            TodoItem(text: "Read", status: .completed), TodoItem(text: "Skip", status: .cancelled),
            TodoItem(text: "Test", status: .inProgress, activeForm: "Testing"),
        ])
        let saved = try JSONEncoder().encode(plan)
        let old = try JSONDecoder().decode(OldTodoPlan.self, from: saved)
        #expect(old.items.map(\.status) == [.completed, .completed, .inProgress])
        #expect(old.items.map(\.text) == ["Read", "Skip", "Test"])
        #expect(try JSONDecoder().decode(TodoPlan.self, from: saved) == plan)
        // What an older build saved reads as it did.
        let older = try JSONEncoder().encode(OldTodoPlan(items: [OldTodoItem(text: "Read", status: .completed)]))
        #expect(try JSONDecoder().decode(TodoPlan.self, from: older) == TodoPlan(items: [TodoItem(text: "Read", status: .completed)]))
    }

    /// A plan stored before `activeForm` was kept reads as it did.
    @Test func storedItemsWithoutActiveFormStillDecode() throws {
        let stored = Data(#"{"items":[{"text":"Read","status":"completed"}]}"#.utf8)
        let plan = try JSONDecoder().decode(TodoPlan.self, from: stored)
        #expect(plan.items == [TodoItem(text: "Read", status: .completed)])
    }
}
