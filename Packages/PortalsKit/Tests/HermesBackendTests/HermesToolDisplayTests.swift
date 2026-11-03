import AgentCore
import Foundation
import Testing
@testable import HermesBackend

@Suite struct HermesToolDisplayTests {
    private let now = Date(timeIntervalSince1970: 1_000)

    @Test func aCommandIsItsOwnLabelAndInput() throws {
        let run = try #require(HermesToolDisplay.started([
            "tool_id": "c1", "name": "terminal", "context": "pytest -q + 1 command",
            "args": ["command": "pytest -q\necho done"],
        ], at: now))
        #expect(run == ToolRun(id: "c1", name: "terminal", label: "pytest -q", input: "pytest -q\necho done", startedAt: now))
    }

    @Test func aFileToolIsLabelledByItsFileName() throws {
        let read = try #require(HermesToolDisplay.started([
            "tool_id": "c2", "name": "read_file", "context": "hello.txt L1",
            "args": ["offset": 1, "path": "/tmp/aeriportal-cwd/src/hello.txt"],
        ], at: now))
        #expect(read.label == "hello.txt")
        #expect(read.input == nil) // the label says it all

        let write = try #require(HermesToolDisplay.started([
            "tool_id": "c3", "name": "write_file", "args": ["content": "hi\n", "path": "/tmp/aeriportal-cwd/hello.txt"],
        ], at: now))
        #expect(write.input == "hi\n")

        let patch = try #require(HermesToolDisplay.started([
            "tool_id": "c4", "name": "patch", "args": ["old_string": "hi", "new_string": "hello", "path": "/tmp/x/hello.txt"],
        ], at: now))
        #expect(patch.input == nil) // the diff shows the change
        // Each keeps its file's whole path, which the row opens; a search's folder is none.
        #expect([read.path, write.path, patch.path] == ["/tmp/aeriportal-cwd/src/hello.txt", "/tmp/aeriportal-cwd/hello.txt", "/tmp/x/hello.txt"])
        let search = try #require(HermesToolDisplay.started(["tool_id": "c5", "name": "search_files", "args": ["pattern": "x", "path": "/tmp"]], at: now))
        #expect(search.path == nil)
        let finished = try #require(HermesToolDisplay.finished(["tool_id": "c4", "name": "patch", "args": ["path": "/tmp/x/hello.txt"], "result": ["success": true]]))
        #expect(finished.path == "/tmp/x/hello.txt")
    }

    /// The backlog's "Left: … a read at an offset opens at the top": Open File opens such a
    /// read where it began, live, at its end and read back from history.
    @Test func aReadOfPartOfAFileOpensWhereItBegan() throws {
        let args: JSONValue = ["path": "/w/src/big.ts", "offset": 120, "limit": 40]
        let started = try #require(HermesToolDisplay.started(["tool_id": "r1", "name": "read_file", "args": args], at: now))
        #expect(started.fileLocation == FileLocation(path: "/w/src/big.ts", line: 120))
        let finished = try #require(HermesToolDisplay.finished(["tool_id": "r1", "name": "read_file", "args": args, "result": ["content": "x"]]))
        #expect(finished.startLine == 120)
        // From the top, and a tool that is no read, open at the top.
        #expect(try #require(HermesToolDisplay.started(["tool_id": "r2", "name": "read_file", "args": ["path": "/w/a.ts", "offset": 1]], at: now)).startLine == nil)
        #expect(try #require(HermesToolDisplay.started(["tool_id": "r3", "name": "search_files", "args": ["path": "/w", "offset": 5]], at: now)).startLine == nil)

        // A result whose start was missed, and one whose start had no offset, carry it to the row.
        var state = ThreadState()
        state.messageDelivered(state.messageSent("read it"), outcome: .started)
        state.apply(.toolFinished(finished))
        state.apply(.toolStarted(ToolRun(id: "r4", name: "read_file", path: "/w/src/big.ts")))
        state.apply(.toolFinished(ToolResult(id: "r4", name: "read_file", succeeded: true, path: "/w/src/big.ts", startLine: 300)))
        let rows = state.transcript.turns[0].items.compactMap { item -> ToolRun? in if case let .tool(run) = item.content { run } else { nil } }
        #expect(rows.map(\.fileLocation) == [FileLocation(path: "/w/src/big.ts", line: 120), FileLocation(path: "/w/src/big.ts", line: 300)])
    }

    @Test func otherToolsUseTheirQueryOrHermesContext() throws {
        let search = try #require(HermesToolDisplay.started([
            "tool_id": "c5", "name": "web_search", "args": ["query": "websocket close codes", "limit": 5],
        ], at: now))
        #expect(search.label == "websocket close codes")
        #expect(search.input?.contains("\"limit\" : 5") == true)

        let other = try #require(HermesToolDisplay.started([
            "tool_id": "c6", "name": "todo", "context": "3 items", "args": [:],
        ], at: now))
        #expect(other.label == "3 items")
        #expect(other.input == nil)

        // A context that is a shortened path is no use as a label.
        let shortened = try #require(HermesToolDisplay.started([
            "tool_id": "c7", "name": "mystery", "context": "/private/tmp/very/long/pa...", "args": ["flag": true],
        ], at: now))
        #expect(shortened.label == nil)
    }

    @Test func aPayloadWithoutAnIDIsNotATool() {
        #expect(HermesToolDisplay.started(["name": "terminal"], at: now) == nil)
        #expect(HermesToolDisplay.finished(["tool_id": "x"]) == nil)
    }

    @Test func failureIsReadFromTheResult() {
        #expect(HermesToolDisplay.failed(["exit_code": 0, "error": nil, "output": "ok"]) == false)
        #expect(HermesToolDisplay.failed(["exit_code": 1, "output": "boom"]))
        #expect(HermesToolDisplay.failed(["error": "not found"]))
        #expect(HermesToolDisplay.failed(["success": false]))
        #expect(HermesToolDisplay.failed(["status": "blocked", "exit_code": -1]))
        #expect(HermesToolDisplay.failed(["success": true, "error": ""]) == false)
        #expect(HermesToolDisplay.failed(.null) == false)
    }

    @Test func outputPrefersWhatHermesWroteForTheUser() {
        #expect(HermesToolDisplay.output([
            "output": "", "exit_code": -1, "error": "BLOCKED: Command denied by user. Do NOT retry…",
            "status": "blocked", "user_summary": "You denied this command — it did not run.",
        ], summary: nil) == "You denied this command — it did not run.")
    }

    @Test func outputFallsBackThroughTheResultsShapes() {
        #expect(HermesToolDisplay.output(["output": "14 passed", "exit_code": 0, "error": nil], summary: nil) == "14 passed")
        #expect(HermesToolDisplay.output(["content": "1|hi", "total_lines": 1], summary: nil) == "1|hi")
        #expect(HermesToolDisplay.output(["output": "partial", "error": "timed out"], summary: nil) == "partial\ntimed out")
        #expect(HermesToolDisplay.output("plain text", summary: nil) == "plain text")
        #expect(HermesToolDisplay.output(["matches": 3], summary: "3 matches") == "3 matches")
        #expect(HermesToolDisplay.output(["matches": 3], summary: nil)?.contains("\"matches\" : 3") == true)
        // An edit's result is its diff; an empty result is nothing.
        #expect(HermesToolDisplay.output(["success": true, "diff": "--- a\n+++ b"], summary: nil) == nil)
        #expect(HermesToolDisplay.output(.null, summary: nil) == nil)
        #expect(HermesToolDisplay.output([:], summary: nil) == nil)
        // A command that printed nothing: a failure shows its exit code, a success nothing.
        #expect(HermesToolDisplay.output(["output": "", "exit_code": 2], summary: nil) == "Exit code 2")
        #expect(HermesToolDisplay.output(["output": "", "exit_code": 0, "error": nil], summary: nil) == nil)
        // A command that printed nothing but was auto-approved says so.
        #expect(HermesToolDisplay.output(["output": "", "exit_code": 0, "approval": "Auto-approved by smart approval."], summary: nil)
            == "Auto-approved by smart approval.")
    }

    @Test func aFileChangeShowsItsDiffNotItsBookkeeping() throws {
        let result = try #require(HermesToolDisplay.finished([
            "tool_id": "c1", "name": "write_file", "duration_s": 0.1,
            "inline_diff": "  ┊ review diff\na/x → b/x\n@@ -0,0 +1 @@\n+hi",
            "result": ["bytes_written": 3, "dirs_created": true, "verified": true, "resolved_path": "/tmp/x"],
        ]))
        #expect(result.output == nil)
        #expect(result.diff == "--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+hi")
        #expect(result.succeeded)
    }

    @Test func longOutputIsClipped() throws {
        let long = String(repeating: "x", count: HermesToolDisplay.textLimit + 500)
        let clipped = try #require(HermesToolDisplay.output(["output": .string(long)], summary: nil))
        #expect(clipped.count < long.count)
        #expect(clipped.hasSuffix("… (500 more characters)"))
    }

    @Test func aPlainDiffInTheResultWinsOverTheColouredOne() {
        let diff = HermesToolDisplay.diff(
            result: ["diff": "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-hi\n+hello\n"],
            inline: "  ┊ review diff\n\u{1B}[38;2;218;165;32ma/x → b/x\u{1B}[0m"
        )
        #expect(diff == "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-hi\n+hello")
    }

    @Test func theColouredDiffBecomesAPlainUnifiedDiff() {
        let inline = "  ┊ review diff\n"
            + "\u{1B}[38;2;218;165;32ma//tmp/hello.txt → b//tmp/hello.txt\u{1B}[0m\n"
            + "\u{1B}[38;2;139;134;130m@@ -0,0 +1 @@\u{1B}[0m\n"
            + "\u{1B}[38;2;255;255;255;48;2;19;87;20m+hi\u{1B}[0m"
        #expect(HermesToolDisplay.diff(result: ["bytes_written": 3], inline: inline)
            == "--- a//tmp/hello.txt\n+++ b//tmp/hello.txt\n@@ -0,0 +1 @@\n+hi")
        #expect(HermesToolDisplay.diff(result: [:], inline: nil) == nil)
        #expect(HermesToolDisplay.diff(result: [:], inline: "") == nil)
    }

    @Test func escapeCodesAreStripped() {
        #expect(HermesToolDisplay.strippingEscapeCodes("\u{1B}[1;31mred\u{1B}[0m plain") == "red plain")
        #expect(HermesToolDisplay.strippingEscapeCodes("no codes") == "no codes")
    }

    @Test func aFinishedPayloadCarriesDurationAndState() throws {
        let result = try #require(HermesToolDisplay.finished([
            "tool_id": "c1", "name": "terminal", "duration_s": 2.5,
            "result": ["output": "boom", "exit_code": 2, "error": nil],
        ]))
        #expect(result == ToolResult(id: "c1", name: "terminal", succeeded: false, duration: 2.5, output: "boom"))
    }

    /// A result repeats the call it answers, for when the start was missed.
    @Test func aFinishedPayloadSaysWhatWasCalled() throws {
        let result = try #require(HermesToolDisplay.finished([
            "tool_id": "c1", "name": "terminal", "args": ["command": "swift test\necho done"], "duration_s": 1,
            "result": ["output": "ok", "exit_code": 0],
        ]))
        #expect(result.label == "swift test")
        #expect(result.input == "swift test\necho done")
        #expect(result.succeeded)
    }
    // MARK: Calls about subagents (subagent_calls)

    private let calls: Set<String> = [BridgeWire.Feature.subagentCalls]

    /// A Codex wait is one line naming who it waited for, without "Delegate wait" or its
    /// "Done.": the subagents line has what they said.
    @Test func aCodexWaitIsOneLineNamingWhoItWaitedFor() throws {
        let start: JSONValue = ["tool_id": "w1", "name": "delegate_task", "context": "wait", "args": ["agents": ["Darwin", "Euclid"]]]
        let run = try #require(HermesToolDisplay.started(start, features: calls, at: now))
        #expect(run.subagentCall == SubagentCall(.wait, agents: ["Darwin", "Euclid"]))
        #expect(run.label == nil)
        #expect(run.input == nil)
        let end: JSONValue = ["tool_id": "w1", "name": "delegate_task", "context": "wait", "args": ["agents": ["Darwin", "Euclid"]], "result": ["output": "pear"], "duration_s": 3]
        let result = try #require(HermesToolDisplay.finished(end, features: calls))
        #expect(result.subagentCall == SubagentCall(.wait, agents: ["Darwin", "Euclid"]))
        #expect(result.output == nil)
        #expect(result.input == nil)
        #expect(result.duration == 3)
        // One that failed still says why.
        let failed = try #require(HermesToolDisplay.finished(["tool_id": "w2", "name": "delegate_task", "context": "wait", "args": ["agents": []], "result": ["error": "The agent failed."]], features: calls))
        #expect(failed.subagentCall == SubagentCall(.wait))
        #expect(failed.output == "The agent failed.")
        #expect(!failed.succeeded)
    }

    @Test func aCodexMessageToASubagentShowsTheMessageAsItsInput() throws {
        let run = try #require(HermesToolDisplay.started(["tool_id": "m1", "name": "delegate_task", "context": "sendInput", "args": ["task": "Also the LICENSE.", "agents": ["Euclid"]]], features: calls, at: now))
        #expect(run.subagentCall == SubagentCall(.message, agents: ["Euclid"]))
        #expect(run.input == "Also the LICENSE.")
        let close = try #require(HermesToolDisplay.started(["tool_id": "c1", "name": "delegate_task", "context": "closeAgent", "args": ["agents": ["Darwin"]]], features: calls, at: now))
        #expect(close.subagentCall == SubagentCall(.close, agents: ["Darwin"]))
    }

    /// A spawn keeps its task; another agent's delegate row, an app talking to a bridge
    /// without the feature, and a call this app does not know stay as they were.
    @Test func otherDelegateRowsStayAsTheyWere() throws {
        let spawn = try #require(HermesToolDisplay.started(["tool_id": "s1", "name": "delegate_task", "context": "spawnAgent", "args": ["task": "Count the files", "agent": "gpt-6-luna"]], features: calls, at: now))
        #expect(spawn.subagentCall == nil)
        #expect(spawn.label == "spawnAgent")
        // Claude Code's subagent, whose description could be any word.
        let claude = try #require(HermesToolDisplay.started(["tool_id": "t1", "name": "delegate_task", "context": "wait", "args": ["task": "Wait for CI", "agent": "general-purpose"]], features: calls, at: now))
        #expect(claude.subagentCall == nil)
        let old = try #require(HermesToolDisplay.started(["tool_id": "w1", "name": "delegate_task", "context": "wait", "args": ["agents": ["Darwin"]]], at: now))
        #expect(old.subagentCall == nil)
        #expect(old.label == "wait")
        let unknown = try #require(HermesToolDisplay.started(["tool_id": "u1", "name": "delegate_task", "context": "renameAgent", "args": ["agents": ["Darwin"]]], features: calls, at: now))
        #expect(unknown.subagentCall == nil)
    }
}
