import { addedDiff, diffPath, replacementDiff } from "../claude/tools.ts";

export interface DroidTool {
  name: string;
  args: Record<string, unknown>;
  context?: string;
}

export function gatewayTool(name: string, input: Record<string, unknown>): DroidTool {
  switch (name) {
    case "Execute": {
      const args: Record<string, unknown> = { command: input.command };
      for (const key of ["summary", "riskLevel", "fireAndForget", "timeout"]) {
        if (input[key] !== undefined) args[key] = input[key];
      }
      return { name: "terminal", args };
    }
    case "Read": return { name: "read_file", args: { path: input.file_path, offset: input.offset, limit: input.limit } };
    case "Create": return { name: "write_file", args: { path: input.file_path, content: input.content } };
    case "Edit": return { name: "patch", args: { path: input.file_path, old_string: input.old_str, new_string: input.new_str } };
    case "ApplyPatch": return { name: "patch", args: { patch: input.patch ?? input.input } };
    case "Grep": return { name: "search_files", args: { pattern: input.pattern, in: input.path, glob: input.glob_pattern } };
    case "Glob": return { name: "search_files", args: { pattern: input.patterns, in: input.folder } };
    case "LS": return { name: "list_directory", args: { path: input.directory_path } };
    case "WebSearch": return { name: "web_search", args: { query: input.query } };
    case "FetchUrl": return { name: "web_extract", args: { url: input.url } };
    case "AskUser": return { name: "clarify", args: {} };
    case "ExitSpecMode": return { name: "plan", args: { content: input.plan } };
    case "TodoWrite": return { name: "todo", args: { todos: input.todos, items: todoItems(input.todos) } };
    case "Task": return { name: "delegate_task", args: { task: input.prompt, agent: input.subagent_type }, context: typeof input.description === "string" ? input.description : undefined };
    default: return { name, args: input };
  }
}

function todoItems(todos: unknown): { text: string; status: "pending" | "in_progress" | "completed" }[] {
  if (typeof todos !== "string" || !todos.trim()) return [];
  const items = [];
  for (const line of todos.split("\n").filter((line) => line.trim())) {
    const match = /^\s*\d+\.\s+\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    items.push({ text: match[2], status: match[1] as "pending" | "in_progress" | "completed" });
  }
  return items;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === "object" && item?.type === "text" ? item.text : "").filter(Boolean).join("\n");
  return JSON.stringify(content) ?? "";
}

/**
 * A tool's result in the shape the app reads. `cwd` is the thread's folder: the diffs name
 * a file in it by its path there, and one outside whole, as the other agents' diffs do.
 */
export function gatewayResult(tool: DroidTool, content: unknown, isError: boolean, cwd: string): unknown {
  const text = contentText(content);
  if (tool.name === "terminal") {
    const code = /(?:exit(?:ed with)?(?: code)?|exitCode)[:\s]+(\d+)/i.exec(text)?.[1];
    return { output: text, exit_code: code ? Number(code) : Number(isError) };
  }
  if (isError) return { success: false, error: text };
  if (tool.name === "read_file") return { content: text };
  if (tool.name === "patch" && typeof tool.args.patch === "string") {
    // ApplyPatch: its patch, read as unified diffs of each file (feature turn_diff).
    const diff = applyPatchDiff(tool.args.patch, cwd);
    return { success: true, output: text, ...(diff ? { diff } : {}) };
  }
  if (tool.name === "patch" || tool.name === "write_file") {
    const path = typeof tool.args.path === "string" ? tool.args.path : "";
    if (!path) return { success: true, output: text };
    // As Claude's: an Edit's old and new text without line numbers, so the lines they share
    // (quoted to make the old text unique) count as unchanged in the turn's diff; a Create
    // is a new file, all added.
    const diff = tool.name === "write_file"
      ? addedDiff(path, typeof tool.args.content === "string" ? tool.args.content : "", cwd, true)
      : replacementDiff(path, typeof tool.args.old_string === "string" ? tool.args.old_string : "",
        typeof tool.args.new_string === "string" ? tool.args.new_string : "", cwd);
    return { success: true, output: text, diff };
  }
  return { output: text };
}

/**
 * A patch in the apply_patch form (`*** Begin Patch`, then `*** Add File:`, `*** Update
 * File:` with `@@` chunks of ` `, `-` and `+` lines, `*** Move to:`, `*** Delete File:`)
 * as a unified diff of each file: a file added from /dev/null, one deleted to it (its lines
 * are not in the patch). The chunks have no line numbers. "" for anything else. A file is
 * named by its path in `cwd` when it is in it, else whole.
 */
export function applyPatchDiff(patch: string, cwd: string): string {
  const out: string[] = [];
  // Every file's header is followed by a hunk's header, so a changed line that reads like
  // a file's header (`--- old`, `+++ new`) in a chunk without numbers is not taken for one
  // (`piecesOf`): an added file's with its numbers, the others' as the patch has them.
  let how: "Add" | "Update" | "Delete" | undefined;
  let added: string[] = [];
  /** An updated file's header was the last line out: its first chunk needs a hunk's header. */
  let headed = false;
  const close = () => {
    if (how === "Add") {
      out.push(`@@ -0,0 +1,${added.length} @@`);
      // One by one: a spread of a long new file's lines passes the engine's limit on arguments.
      for (const line of added) out.push(line);
    }
    if (how === "Delete") out.push("@@");
    how = undefined;
    added = [];
  };
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      close();
      const [, kind, named] = header;
      const path = diffPath(named, cwd);
      how = kind as "Add" | "Update" | "Delete";
      // git's line first: it marks where a file starts, so a changed line that reads like a
      // file's header in a chunk without numbers is not taken for one (`piecesOf`).
      out.push(`diff --git a/${path} b/${path}`, how === "Add" ? "--- /dev/null" : `--- a/${path}`, how === "Delete" ? "+++ /dev/null" : `+++ b/${path}`);
      headed = how === "Update";
      continue;
    }
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved && how === "Update") {
      out[out.length - 1] = `+++ b/${diffPath(moved[1], cwd)}`;
      continue;
    }
    if (line.startsWith("*** ")) {
      close();
      continue;
    }
    if (how === "Add") {
      if (line.startsWith("+")) added.push(line);
    } else if (how === "Update") {
      if (!(line.startsWith("@@") || line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) continue;
      if (headed && !line.startsWith("@@")) out.push("@@");
      headed = false;
      out.push(line);
    }
  }
  close();
  return out.length > 0 ? out.join("\n") + "\n" : "";
}
