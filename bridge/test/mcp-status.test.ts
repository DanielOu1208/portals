import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpStatusText } from "../src/providers/mcpStatus.ts";

test("/mcp's text: a line a server by name, a tool count where it says something, an agent's own word for a state it has no match for, and one line for an error however long", () => {
  assert.deepEqual(mcpStatusText("Dana's agent", [
    { name: "zeta", state: "connected", tools: 0 },
    { name: "alpha", state: "unknown", detail: "warming\nup" },
    { name: "beta", state: "failed", detail: `line one\n${"x".repeat(400)}` },
    { name: "gamma", state: "off", tools: 4 },
    { name: "delta", state: "notStarted", tools: 0 },
  ], { note: "As set up.", signIn: "Sign in on the host." }).split("\n").map((line) => line.length > 80 ? `${line.slice(0, 30)}…(${line.length})` : line), [
    "Dana's agent MCP servers:",
    "As set up.",
    "alpha: warming up",
    // The error, cut at 300 characters.
    "beta: failed (line one xxxxxxx…(315)",
    "delta: not started",
    "gamma: off",
    "zeta: connected, 0 tools",
  ]);
  // Nothing to note or sign in to.
  assert.equal(mcpStatusText("Dana's agent", [], { note: "As set up.", signIn: "Sign in on the host." }), "Dana's agent MCP servers:\nNone set up.");
});
