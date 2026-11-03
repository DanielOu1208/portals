import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { expandHome } from "../../config.ts";
import { machineWord } from "../../platform.ts";
import type { ContentBlock } from "../acp/protocol.ts";
import type { Quirks } from "../acp/tools.ts";
import { programVersion } from "../program.ts";
import type { ThreadMode } from "../types.ts";

// What is fixed about Cursor as the bridge runs it: the release it was tested with,
// where its program is, what the bridge says of itself at hello, what is put right for
// it, its modes, and how it is told of the `portals` command.

/** The release of `cursor-agent` this provider was built and tested against. */
export const testedCursorVersion = "2026.10.22";

/** `cursor-agent --version` prints "2026.10.22-27dcf5f": the three numbers, without the build's hash. Null when it does not run. */
export function cursorVersion(path: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return programVersion(path, env);
}

/**
 * The installed `cursor-agent`: the configured one, with `~` expanded and a bare name
 * looked up on the PATH. Null when there is none.
 */
export function cursorProgram(configured: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = expandHome(configured);
  const candidates = isAbsolute(path) ? [path] : (env.PATH ?? "").split(delimiter).filter((folder) => folder !== "").map((folder) => join(folder, path));
  return candidates.find(executable) ?? null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What to call it in messages. */
export const cursorName = "Cursor";

/** How it is run: `cursor-agent acp` speaks the Agent Client Protocol on its standard input and output. */
export const cursorArgs = ["acp"];

/**
 * How it is run for threads in Full access: with `--force`, Cursor's Run Everything, which
 * its ACP reads as it makes or loads a session (and nothing else of the command line:
 * not `--auto-review`). Where a team does not allow Run Everything, Cursor asks as usual.
 */
export const cursorForceArgs = ["--force", ...cursorArgs];

/**
 * What the bridge says it can do at hello. `parameterizedModelPicker` has Cursor list
 * its models plainly (`grok-4.6`), with the current model's settings as options of
 * their own; without it every model comes once for each setting it has
 * (`grok-4.6[effort=high,fast=true]`). `subagents` has it tell of its subagents, each in
 * a session of its own (./subagents.ts); under `_meta`, since ACP's schema leaves out a
 * key of the client's capabilities that it does not know, and Cursor reads it either way.
 */
export const cursorCapabilities = { _meta: { parameterizedModelPicker: true, subagents: {} } };

/** What Cursor 2026.10.22 does that the protocol does not say, apart from its tools (./tools.ts). */
export const cursorQuirks: Quirks = {
  // A turn that ends by itself ends with this line, after the reply. It is how Cursor
  // tells of any error of its run, as text; only this one, seen after turns that worked,
  // is dropped.
  junkText: /^\s*Error: RetriableError: WritableIterable is closed\s*$/,
  // A new file's diff comes as two texts made from a unified diff.
  diffHeaderScraps: true,
};

/** The end of "Cursor is not signed in on this Mac." */
export const signInHint = "Run `cursor-agent login` in a terminal there.";
export const notSignedInText = `${cursorName} is not signed in on this ${machineWord()}. ${signInHint}`;

/** The last piece of a reply from a session whose sign-in has gone, in a turn Cursor ends as complete. */
export const signInReply = "Please sign in to continue";

/** What Cursor says, as the last piece of a turn's reply, of a turn its plan or settings stopped (with the sign-in's, `signInReply`). */
const stoppedByAccount = new Set([signInReply, "Upgrade your plan to continue", "Add a payment method to continue", "Check your settings to continue"]);

/**
 * What a piece of reply says went wrong, when it is how Cursor tells of a turn it could
 * not finish: it ends such a turn as complete (`end_turn`), its last piece of reply a
 * line of its own after a blank one, one of four sentences about the account or
 * "Error: " and the error (its ACP agent's `sendAgentMessageChunk("\n\n…")`). Null for
 * any other piece, and for the error line Cursor ends turns that worked with (`junkText`).
 */
export function turnFailure(piece: string): string | null {
  if (!piece.startsWith("\n\n") || cursorQuirks.junkText?.test(piece)) return null;
  const text = piece.slice(2).trim();
  if (stoppedByAccount.has(text)) return text;
  const error = /^Error: (.+)$/s.exec(text)?.[1]?.trim();
  return error ? error : null;
}

/** One of Cursor's own slash commands that is left out: it writes the Mac's clipboard. */
export const hiddenCommands = new Set(["copy-request-id"]);

// MARK: Modes

/**
 * Cursor's mode for each of the app's that it has one for. How much Cursor asks before
 * acting is its own setting (Allowlist, Auto-review or Run Everything), which `default`,
 * its agent mode, follows; `full` is its agent mode on a process run with `--force`
 * (`runsEverything`). `edits` has nothing to mean.
 */
const cursorModes: Partial<Record<ThreadMode, string>> = { default: "agent", full: "agent", plan: "plan", ask: "ask" };

/** Cursor's mode for a thread's, or null when it has none. */
export function cursorMode(mode: ThreadMode): string | null {
  return cursorModes[mode] ?? null;
}

/** Whether a thread in `mode` runs on a Cursor started with `--force` (`cursorForceArgs`). */
export function runsEverything(mode: ThreadMode): boolean {
  return mode === "full";
}

/** Why a mode Cursor has nothing for (`edits`) is refused. */
export const noSuchModeText =
  "Cursor has four modes here: agent (asking as your Cursor settings say), full access (Cursor's Run Everything), plan, and ask, which only reads.";

/** What `/mode` says of the modes that mean something else for Cursor, as the end of "This thread now …". */
export const cursorModeMeanings: Partial<Record<Exclude<ThreadMode, "default">, string>> = {
  ask: "is in Cursor's Ask mode, for reading and answering: Cursor is told to edit no files and run no commands",
  full: "runs with Cursor's Run Everything: it edits files, runs commands and searches the web without asking, unless your team does not allow it",
};

/**
 * Why a thinking level chosen for a thread on `default` is refused: nothing is set for
 * such a thread. (The app offers every level for a model that lists none.)
 */
export const levelLeftToCursorText = "This thread leaves the model to Cursor, and the thinking level with it. Choose a model for the thread to set a level.";

/** What the provider sends by itself, in the same turn, once a plan was accepted: Cursor ends its turn there and waits. */
export const goAheadText = "Go ahead with the plan.";

// MARK: The `portals` command

/**
 * The few lines on the `portals` command (`instructions`), as a note beside a thread's
 * first message. Cursor's ACP has no place for a client's instructions; an embedded
 * resource is what it puts under "Additional ACP context" for the model, and it leaves
 * the user's own words, the title made from them and a slash command at their start as
 * they were written. (Cursor reads such a block though it does not say so at hello.)
 */
export function portalsNote(instructions: string): ContentBlock {
  return {
    type: "resource",
    resource: { uri: "portals://guide", mimeType: "text/markdown", text: `A note from Portals, the app this conversation is shown in.\n\n${instructions}` },
  };
}
