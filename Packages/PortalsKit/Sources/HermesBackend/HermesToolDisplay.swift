import AgentCore
import Foundation

/// Turns Hermes's `tool.start` / `tool.complete` payloads into what a transcript shows:
/// a one-line label, the input and output as text, and a plain unified diff.
///
/// Payload shapes, from captures of Hermes 0.21.5:
/// - `tool.start`: `tool_id`, `name`, `context` (a short label, or a shortened path),
///   `args` (the tool's own arguments).
/// - `tool.complete`: the same plus `duration_s`, `result` (tool-specific) and, for file
///   edits, `inline_diff`: a diff coloured with terminal escape codes under a
///   "review diff" heading.
enum HermesToolDisplay {
    /// The most text kept for one input or output. A tool can return megabytes.
    static let textLimit = 20_000

    /// - Parameter features: the bridge extensions the host offers (`BridgeWire.Feature`).
    static func started(_ payload: JSONValue, features: Set<String> = [], at now: Date) -> ToolRun? {
        guard let id = payload["tool_id"]?.stringValue, let name = payload["name"]?.stringValue else { return nil }
        let args = payload["args"] ?? .null
        let context = payload["context"]?.stringValue
        let call = subagentCall(name: name, args: args, context: context, features: features)
        return ToolRun(
            id: id,
            name: name,
            label: call == nil ? label(name: name, args: args, context: context) : nil,
            input: call == nil ? input(name: name, args: args) : callInput(args),
            output: payload["output"]?.stringValue,
            startedAt: now,
            subagentCall: call,
            path: filePath(name: name, args: args),
            startLine: startLine(name: name, args: args),
            plan: todoPlan(name: name, args: args),
            progress: payload["progress"]?.stringValue,
            outputTruncated: payload["output_truncated"]?.boolValue == true ? true : nil,
            execution: execution(name: name, args: args)
        )
    }

    /// - Parameter features: the bridge extensions the host offers (`BridgeWire.Feature`).
    static func finished(_ payload: JSONValue, features: Set<String> = []) -> ToolResult? {
        guard let id = payload["tool_id"]?.stringValue, let name = payload["name"]?.stringValue else { return nil }
        let args = payload["args"] ?? .null
        let result = payload["result"] ?? .null
        let context = payload["context"]?.stringValue
        let call = subagentCall(name: name, args: args, context: context, features: features)
        let diff = diff(result: result, inline: payload["inline_diff"]?.stringValue)
        return ToolResult(
            id: id,
            name: name,
            label: call == nil ? label(name: name, args: args, context: context) : nil,
            input: call == nil ? input(name: name, args: args) : callInput(args),
            succeeded: !failed(result),
            duration: payload["duration_s"]?.doubleValue,
            output: call == nil || failed(result) ? output(result, summary: payload["summary"]?.stringValue, hasDiff: diff != nil) : nil,
            diff: diff,
            subagentCall: call,
            path: filePath(name: name, args: args),
            startLine: startLine(name: name, args: args),
            plan: todoPlan(name: name, args: args),
            execution: execution(name: name, args: args)
        )
    }

    /// The tools whose `path` is the one file they read, write or change: Hermes's own, and
    /// what a Portals bridge makes of every agent's (Claude Code's Read, Write and Edit,
    /// Codex's file changes, Pi's, Droid's and Cursor's).
    static let fileTools: Set<String> = ["read_file", "write_file", "patch"]

    /// The file a file tool is about, as the agent named it.
    static func filePath(name: String, args: JSONValue) -> String? {
        guard fileTools.contains(name), let path = args["path"]?.stringValue ?? args["file_path"]?.stringValue else { return nil }
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The line a read of part of a file began at: its `offset`, a line number counted from 1
    /// (Claude Code's Read, Pi's read; the bridge passes it as the agent gave it). None for a
    /// read from the top, which opens there anyway.
    static func startLine(name: String, args: JSONValue) -> Int? {
        guard name == "read_file", let offset = args["offset"]?.doubleValue, offset > 1, offset < Double(Int32.max) else { return nil }
        return Int(offset)
    }

    // MARK: Calls about subagents

    /// A Codex call about its sub-agents other than a spawn, from a bridge that names who
    /// it was about (`subagent_calls`): a `delegate_task` row whose `context` is the call
    /// and whose `args.agents` are their names. nil for any other row; a spawn's carries
    /// its task.
    static func subagentCall(name: String, args: JSONValue, context: String?, features: Set<String>) -> SubagentCall? {
        guard features.contains(BridgeWire.Feature.subagentCalls), name == "delegate_task",
              let names = args["agents"]?.arrayValue, let context, let action = callActions[context] else { return nil }
        return SubagentCall(action, agents: names.compactMap(\.stringValue).filter { !$0.isEmpty })
    }

    /// Codex's calls about its sub-agents, by the name the row's `context` gives them.
    private static let callActions: [String: SubagentCall.Action] = [
        "wait": .wait, "closeAgent": .close, "sendInput": .message, "sendMessage": .message,
        "followupTask": .followUp, "resumeAgent": .resume, "interruptAgent": .interrupt, "listAgents": .list,
    ]

    /// What such a call gave them to read: a message, or more to do. What came back is
    /// on the subagents line.
    private static func callInput(_ args: JSONValue) -> String? {
        guard let task = args["task"]?.stringValue, !task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return clipped(task)
    }

    // MARK: Label and input

    /// A `todo` row's list, the whole of it as each update gives it: items with `text`
    /// (Hermes's own, Droid's `items`), or with `content` (Claude Code's TodoWrite and its
    /// task tools as the bridge maps them, Codex's plan, Cursor's), each with its status
    /// and, from Claude Code, `activeForm`, the item worded as it runs ("Running the
    /// tests"); or Droid's numbered lines. Before 2026-10-26 only `text` was read, so Claude
    /// Code's, Codex's and Cursor's lists had no checklist and no "Step 2 of 5".
    static func todoPlan(name: String, args: JSONValue) -> TodoPlan? {
        guard name == "todo" else { return nil }
        if let items = args["items"]?.arrayValue ?? args["todos"]?.arrayValue {
            if items.isEmpty, let raw = args["todos"]?.stringValue { return TodoPlan.parse(raw) }
            // An item with no words (the bridge writes "" for a Cursor item without content)
            // is left out, not the list with it: one odd item cost the whole checklist and
            // its "Step 2 of 5" (bug hunt round 4, KIT2). A list of nothing but such items
            // is none, as before.
            let parsed = items.compactMap { item -> TodoItem? in
                guard let text = (item["text"]?.stringValue ?? item["content"]?.stringValue)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !text.isEmpty else { return nil }
                let active = item["activeForm"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
                return TodoItem(text: text, status: todoStatus(item["status"]?.stringValue), activeForm: active?.isEmpty == false ? active : nil)
            }
            return parsed.isEmpty && !items.isEmpty ? nil : TodoPlan(items: parsed)
        }
        return args["todos"]?.stringValue.flatMap(TodoPlan.parse)
    }

    /// A to-do's status as the agents write it: `in_progress`, or Codex's own `inProgress`
    /// (the bridge sends the first; a row passed on as Codex wrote it has the second);
    /// Cursor's as it names them itself (`TODO_STATUS_IN_PROGRESS`), should the bridge pass
    /// one on so; `canceled` as `cancelled`. One the app does not know, or none, is an item
    /// still to do: the rest of the list is still worth showing.
    private static func todoStatus(_ raw: String?) -> TodoItem.Status {
        guard var raw = raw?.lowercased() else { return .pending }
        if raw.hasPrefix("todo_status_") { raw.removeFirst("todo_status_".count) }
        switch raw {
        case "inprogress": return .inProgress
        case "canceled": return .cancelled
        default: return TodoItem.Status(rawValue: raw) ?? .pending
        }
    }

    static func execution(name: String, args: JSONValue) -> ToolExecution? {
        guard name == "terminal" else { return nil }
        let details = ToolExecution(
            summary: args["summary"]?.stringValue,
            riskLevel: args["riskLevel"]?.stringValue,
            background: args["fireAndForget"]?.boolValue,
            timeout: args["timeout"]?.doubleValue
        )
        return details == ToolExecution() ? nil : details
    }

    static func label(name: String, args: JSONValue, context: String?) -> String? {
        if let command = args["command"]?.stringValue {
            return firstLine(command)
        }
        if let path = args["path"]?.stringValue ?? args["file_path"]?.stringValue {
            return (path as NSString).lastPathComponent
        }
        for key in ["query", "pattern", "url", "prompt", "name", "question"] {
            if let value = args[key]?.stringValue, !value.isEmpty {
                return firstLine(value)
            }
        }
        // Hermes's own label, unless it is a path it cut short.
        if let context, !context.isEmpty, !context.hasPrefix("/") {
            return firstLine(context)
        }
        return nil
    }

    static func input(name: String, args: JSONValue) -> String? {
        if let command = args["command"]?.stringValue {
            return clipped(command)
        }
        if let content = args["content"]?.stringValue {
            return clipped(content)
        }
        guard case let .object(members) = args, !members.isEmpty else { return nil }
        // An edit is shown by its diff; a read by its label.
        if members.keys.allSatisfy({ ["path", "file_path", "offset", "limit", "old_string", "new_string"].contains($0) }) {
            return nil
        }
        return clipped(pretty(args))
    }

    // MARK: Result

    static func failed(_ result: JSONValue) -> Bool {
        if let error = result["error"], !error.isNull, error.stringValue?.isEmpty != true { return true }
        if result["success"]?.boolValue == false { return true }
        if let code = result["exit_code"]?.intValue, code != 0 { return true }
        if let status = result["status"]?.stringValue, ["blocked", "error", "failed"].contains(status) { return true }
        return false
    }

    static func output(_ result: JSONValue, summary: String?, hasDiff: Bool = false) -> String? {
        // What Hermes wrote for the user comes first ("You denied this command…").
        if let text = result["user_summary"]?.stringValue, !text.isEmpty { return text }
        if let text = result.stringValue { return clipped(text) }

        var parts: [String] = []
        for key in ["output", "content", "stdout", "text"] {
            if let text = result[key]?.stringValue, !text.isEmpty {
                parts.append(text)
                break
            }
        }
        if let error = result["error"]?.stringValue, !error.isEmpty { parts.append(error) }
        if let text = result["approval"]?.stringValue, !text.isEmpty { parts.append(text) }
        if !parts.isEmpty { return clipped(parts.joined(separator: "\n")) }
        // A command that printed nothing: its exit code is the whole story.
        if let code = result["exit_code"]?.intValue {
            return code == 0 ? nil : "Exit code \(code)"
        }

        if let summary, !summary.isEmpty { return clipped(summary) }
        // A change is shown by its diff, not by the bookkeeping around it; anything
        // else falls back to the raw result.
        if hasDiff || result["diff"] != nil || result.isNull { return nil }
        if case let .object(members) = result, members.isEmpty { return nil }
        return clipped(pretty(result))
    }

    static func diff(result: JSONValue, inline: String?) -> String? {
        if let plain = result["diff"]?.stringValue, !plain.isEmpty {
            return clipped(plain.trimmingCharacters(in: .newlines))
        }
        guard let inline, !inline.isEmpty else { return nil }
        return clipped(unified(fromInline: inline))
    }

    /// `inline_diff` as a plain unified diff: escape codes removed, the heading dropped,
    /// and the `a/x → b/x` line turned into `---` / `+++` lines.
    static func unified(fromInline inline: String) -> String {
        var lines: [String] = []
        for line in strippingEscapeCodes(inline).split(separator: "\n", omittingEmptySubsequences: false) {
            if line.contains("review diff"), !line.hasPrefix("+"), !line.hasPrefix("-") { continue }
            if let arrow = line.range(of: " → "), line.hasPrefix("a/") {
                lines.append("--- " + line[..<arrow.lowerBound])
                lines.append("+++ " + line[arrow.upperBound...])
            } else {
                lines.append(String(line))
            }
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .newlines)
    }

    static func strippingEscapeCodes(_ text: String) -> String {
        // Most text has none, and a regex over every tool's output of a long history
        // costs more than the rest of reading it.
        guard text.utf8.contains(0x1B) else { return text }
        return text.replacing(/\u{1B}\[[0-9;]*[A-Za-z]/, with: "")
    }

    // MARK: Text helpers

    private static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.count > 120 ? String(trimmed.prefix(120)) + "…" : trimmed
    }

    private static func clipped(_ text: String) -> String {
        // No more bytes than the limit is no more characters either, and counting the
        // characters of every tool's output in a long history is not free.
        guard text.utf8.count > textLimit else { return text }
        return text.count > textLimit ? String(text.prefix(textLimit)) + "\n… (\(text.count - textLimit) more characters)" : text
    }

    private static func pretty(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}
