import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { version } from "../bridge.ts";
import { bridgeFeatures } from "./features.ts";
import { methods } from "./methods.ts";

// The bridge's side of the gateway contract, in the OpenRPC shape of Hermes's
// `gateway-contract.openrpc.json`, so `scripts/check-contract.sh bridge/contract.json`
// can check that the bridge reads every key the app sends. Kept in `bridge/contract.json`
// and rebuilt with `npm run contract`; a test fails when the two differ.

/** Events the bridge sends (docs/gateway-protocol.md, section 6). */
const events: [string, string][] = [
  ["gateway.ready", "First frame on every connection: replay_epoch, heartbeat, bridge {protocol, features, machine, net {id, revision} (feature net), relay_problem: in_use, only while another bridge holds this Mac's relay id, latest: a later portals-host that is out, only while there is one (feature update_notice)}."],
  ["message.start", "A turn started; queue_id: the waiting message that opened it (feature queue); text, sender, message_id: that message (feature turn_messages)."],
  ["message.checkpoint", "The current turn's opening user message has a native checkpoint for forking or editing (feature message_fork). Sent before message.complete."],
  ["message.steered", "A message was handed to the running turn: text, sender, message_id (feature turn_messages)."],
  ["message.taken", "Remove only the failed turn named by request_id, before its message.steered arrives; replay_base: new replay base; removed_start, removed_count: deleted stored-message range in the previous history, for paging cursors (feature message_reconciliation)."],
  ["message.delta", "A piece of the reply."],
  ["message.usage", "Live turn usage: turn_usage {tokens}, cumulative within the turn."],
  ["message.interim", "A closed piece of text written beside tool calls."],
  ["message.complete", "The turn ended: complete, interrupted or error; turn: which turn it was, as threads list it."],
  ["reasoning.delta", "A piece of the model's reasoning."],
  ["thinking.delta", "A passing status line; empty clears it."],
  ["status.headline", "What the agent says it is working on: text, tool_ids (the calls it sums up), until a newer one or the agent says something (feature status_headline)."],
  ["status.update", "A warning or error worth keeping in the thread; kind process: why the agent began a turn by itself."],
  ["tool.start", "A tool call started."],
  ["tool.progress", "A tool's cumulative live output or status: tool_id, output, progress, output_truncated. Replaces prior output rather than appending."],
  ["tool.complete", "A tool call finished, with its result and diff."],
  ["session.title", "The thread's title changed."],
  ["session.usage", "How full the context window is: usage {context_used, context_max, context_estimated?}. Absent context_estimated means exact."],
  ["session.compacted", "The conversation was summarised to free the context: trigger, tokens_before (feature compaction)."],
  ["session.mode", "How much the thread asks before acting changed: mode, mode_default, optional mode_options [{id, label, description}] (feature modes)."],
  ["session.invalidated", "Take a full session.resume snapshot: replay_base changed after authoritative correction (feature session_resync)."],
  ["queue.changed", "The pending messages changed: queued [{id, text, fleet?, placement?, message_id?}], can_steer, steered: the one consumed by the running turn (feature queue)."],
  ["subagent.start", "A subagent or workflow the agent started: subagent_id, kind, goal, name, status, started_at, background, can_stop (feature subagents)."],
  ["subagent.progress", "What a subagent or workflow is doing now: summary, tool_name, tokens, tool_uses, a workflow's phases and agents (feature subagents)."],
  ["subagent.complete", "A subagent or workflow ended: status completed, failed or stopped, ended_at, result (feature subagents)."],
  ["subagent.cleared", "Ended subagents and workflows left the line as a message went to the agent: subagent_ids (feature subagents_clear)."],
  ["request.cancel", "A question was answered elsewhere, withdrawn or interrupted."],
  ["mcp.auth", "Live MCP sign-in cards changed (feature mcp_auth). Empty payload only; fetch current cards with mcp.auth list. Never carries authentication data."],
  ["error", "The agent failed apart from any one turn (its process stopped)."],
  ["poll.now", "No session: something the client's poll reads moved, saved; thread_list {id, revision}, net {id, revision} (feature net). Sent only to a connection that asked with client.capabilities poll_now (feature poll_now)."],
];

/** Events the app reads that this bridge has no use for yet. Listed so the check sees the app's whole list. */
const unsentEvents = ["subagent.tool", "subagent.thinking"];

const serverRequests: [string, string][] = [
  ["approval", "May the agent do this? Optional options, plan_content and safe details. Answered with {choice,note?} or {option,edited_plan?,note?}, never both choice and option."],
  ["clarify", "The agent's questions, optionally requires_all_answers. Answered with {answers}, or {} to cancel."],
];

export function buildContract(): Record<string, unknown> {
  return {
    openrpc: "1.3.2",
    info: {
      title: "portals-bridge gateway",
      version,
      description: "The part of the Hermes gateway protocol Portals uses, as portals-bridge serves it. Params not listed are ignored.",
    },
    methods: Object.entries(methods).map(([name, spec]) => ({
      name,
      summary: spec.summary,
      params: [
        {
          name: "params",
          schema: {
            type: "object",
            properties: Object.fromEntries(Object.entries(spec.params).map(([key, type]) => [key, type === "strings" ? { type: "array", items: { type: "string" } } : type === "list" ? { type: "array" } : { type }])),
            required: spec.required ?? [],
          },
        },
      ],
    })),
    "x-notifications": [
      ...events.map(([name, summary]) => ({ name, summary })),
      ...unsentEvents.map((name) => ({ name, summary: "Read by the app; not sent by this bridge yet.", "x-sent": false })),
    ],
    "x-server-requests": serverRequests.map(([name, summary]) => ({ name, summary })),
    // The extensions of docs/gateway-protocol.md section 11 this bridge offers, as
    // `gateway.ready` lists them. Hermes's contract has no such list.
    "x-bridge-features": [...bridgeFeatures],
    "x-lean-deltas": {
      capability: "lean_deltas",
      frames: { d: "message.delta", t: "reasoning.delta" },
      tuple: ["session_id", "seq", "text"],
      description: "Only after client.capabilities acknowledges lean_deltas:true. Separate non-JSON-RPC live frames, each with exactly one key d or t. Replay result events remain canonical. Other events and payloads with extra fields keep their JSON-RPC envelope.",
    },
    components: { schemas: {} },
  };
}

export const contractPath = fileURLToPath(new URL("../../contract.json", import.meta.url));

export function contractText(): string {
  return JSON.stringify(buildContract(), null, 2) + "\n";
}

// node src/gateway/contract.ts [--write]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--write")) {
    writeFileSync(contractPath, contractText());
    console.log(`wrote ${contractPath}`);
  } else {
    process.stdout.write(contractText());
  }
}
