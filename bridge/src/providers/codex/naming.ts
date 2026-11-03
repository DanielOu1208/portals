// A name for a Codex thread the bridge started, made the way Codex's own terminal app
// makes one (tui/src/app/thread_title.rs in codex-cli 0.162.1): a title-generation
// thread, ephemeral and on a small model, is given the first message with Codex's title
// prompt and answers with JSON; the name goes onto the thread with `thread/name/set`.
// Codex's daemon names no thread by itself: every app names the threads it starts.

import { cutWhole } from "../../json.ts";

/** The longest name asked for. */
const nameLength = 40;
/** The longest message passed on: a title needs its start, not all of a long brief. */
const messageLength = 4000;

/** What the title-generation thread is told to be: in place of Codex's instructions for coding work. */
export const titleInstructions = "You write short titles for coding tasks. Reply with the title alone.";

/**
 * What the title-generation thread runs with in place of the user's settings (its
 * thread/start `config`): nothing it could act with or on. No plugins, apps or MCP servers,
 * whose tools reach past Codex's sandbox (a server that drives the Mac's screen, one that
 * runs JavaScript) and ask nothing with no approvals; no shell; no hooks of the user's,
 * which would take it for a session of theirs; no memories. `mcpServers` are the names of
 * the servers the user's config.toml sets up (`config/read`).
 */
export function titleConfig(mcpServers: string[]): Record<string, unknown> {
  return {
    features: { plugins: false, apps: false, hooks: false, memories: false, shell_tool: false },
    mcp_servers: Object.fromEntries(mcpServers.map((name) => [name, { enabled: false }])),
  };
}

/** The answer's shape (`outputSchema`), as Codex's terminal app asks for it. */
export const titleSchema = {
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: nameLength } },
  required: ["title"],
  additionalProperties: false,
};

/** Codex's title prompt (from codex-cli 0.162.1) for a thread whose first message is `message`. */
export function titlePrompt(message: string): string {
  const said = message.length > messageLength ? `${cutWhole(message, messageLength)}…` : message;
  return [
    `Generate a concise, single-line task title of at most ${nameLength} characters and under five words where possible. Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.`,
    "Prioritize the current task and latest substantive user request.",
    "Recent conversation messages:",
    "<conversation>",
    `User: ${said}`,
    "</conversation>",
  ].join("\n");
}

/** Quotes a title may come wrapped in. */
const quotePairs: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
];

/** The name in the title-generation thread's answer; null when it gives none. */
export function nameFrom(answer: string): string | null {
  let title: unknown;
  try {
    title = (JSON.parse(answer) as { title?: unknown }).title;
  } catch {
    return null;
  }
  if (typeof title !== "string") return null;
  return tidied(title);
}

/**
 * The name in an answer given as plain text (Pi's naming, which has no answer shape to
 * ask for): its first line that says something, tidied as `nameFrom` tidies one.
 */
export function nameFromText(answer: string): string | null {
  const line = answer.split("\n").find((part) => part.trim() !== "");
  return line === undefined ? null : tidied(line.trim().replace(/^title:\s*/i, ""));
}

function tidied(title: string): string | null {
  // One line, without the full stop it was told to leave out, nor quotes around the
  // whole of it (but a quoted or code term at either end keeps its own).
  let name = title.split("\n")[0]!.trim();
  for (const [open, close] of quotePairs) {
    if (name.length > open.length + close.length && name.startsWith(open) && name.endsWith(close)) {
      const inner = name.slice(open.length, -close.length);
      if (!inner.includes(open) && !inner.includes(close)) name = inner.trim();
      break;
    }
  }
  name = name.replace(/[.。]+$/, "").trim();
  if (name === "") return null;
  return name.length > nameLength * 2 ? `${cutWhole(name, nameLength * 2 - 1).trimEnd()}…` : name;
}
