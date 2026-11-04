import "./environment.ts";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { cleaner, cleanStreamedPaths } from "../scripts/record-claude-clean.ts";

// What the Claude recorder takes out of a recording before it is written
// (scripts/record-claude-clean.ts): paths Claude Code streamed in pieces too.

const cwd = "/private/tmp/record-scratch/plan";

function delta(type: string, field: string, text: string, parent: string | null = null) {
  return { kind: "message", message: { type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type, [field]: text } } } };
}

function start(id: string, parent: string | null = null) {
  return { kind: "message", message: { type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { id } } } };
}

test("a path streamed in pieces is replaced, what stands in for it in the piece it began in, and the pieces add up to the cleaned whole", () => {
  const home = homedir();
  const plan = `{"file_path": "${home}/.claude/plans/a.md", "dir": "${cwd}/x"}`;
  // Cut where a path is half sent, as Claude Code's pieces fall: one piece lies wholly inside the home folder's.
  const homeAt = plan.indexOf(home);
  const cuts = [0, homeAt + 3, homeAt + home.length - 2, plan.indexOf(cwd) + 6, plan.length];
  const lines: unknown[] = [start("m1"), ...cuts.slice(1).map((end, at) => delta("input_json_delta", "partial_json", plan.slice(cuts[at], end)))];
  // A subagent's stream, on at the same time, is a text of its own.
  lines.splice(2, 0, start("m2", "toolu_1"), delta("text_delta", "text", `in ${cwd.replace(/^\/private/, "")}`, "toolu_1"));
  cleanStreamedPaths(lines, cwd);
  const pieces = (stream: string | null) =>
    lines.flatMap((line) => {
      const message = (line as { message: { parent_tool_use_id: string | null; event: { type: string; delta?: Record<string, string> } } }).message;
      if (message.parent_tool_use_id !== stream || message.event.type !== "content_block_delta") return [];
      return [message.event.delta!.partial_json ?? message.event.delta!.text];
    });
  const main = pieces(null);
  assert.equal(main.join(""), '{"file_path": "/Users/dev/.claude/plans/a.md", "dir": "/tmp/aeriportal-cwd/x"}');
  assert.deepEqual(main, ['{"file_path": "/Users/dev', "", '/.claude/plans/a.md", "dir": "/tmp/aeriportal-cwd', '/x"}']);
  assert.deepEqual(pieces("toolu_1"), ["in /tmp/aeriportal-cwd"]);
  // The whole message, cleaned on its own, says the same.
  assert.equal(cleaner(cwd)(plan), main.join(""));
});

test("a recording keeps no sign-in date, email or organization of the user's", () => {
  const clean = cleaner(cwd);
  assert.deepEqual(clean({ type: "result", credential_expires_at: "2026-05-01T10:00:00.000Z", email: "dana@example.com", organization: "Dana's", result: "ok" }), {
    type: "result",
    credential_expires_at: "2030-01-01T00:00:00.000Z",
    email: "redacted",
    organization: "redacted",
    result: "ok",
  });
});
