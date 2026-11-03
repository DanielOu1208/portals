#!/usr/bin/env node
import { bridgeHome, pathsFor, socketPath } from "./config.ts";
import { callLink, machineName, parsePairingLink, readLinks, whyNot, writeLinks, type Link } from "./fleet/links.ts";
import { thread } from "./portals/access.ts";
import { BridgeError, callBridge } from "./portals/client.ts";
import { guide, netUsage, usage, visualGuide } from "./portals/guide.ts";

// The `portals` command (docs/fleet-plan.md): the bridge's threads from a shell, for
// the agents the bridge runs and for the person at the Mac. Each command is one call
// to the bridge in `PORTALS_BRIDGE_HOME` over its local socket, printed as JSON.
// `portals guide` says how to use it.

/** Thrown for a command line that cannot be read: exit status 2. */
class UsageError extends Error {}

/** How long a call may take when it waits for nothing: starting a thread can be slow. */
const callMs = 150_000;
/** What a wait is given on top of its own time. */
const marginMs = 15_000;
/** The longest the bridge waits for a thread (fleet/fleet.ts), which is as long as the command waits for the bridge: a timer set for much longer fires at once. */
const longestWaitMs = 3_600_000;
/** Tool output longer than this is cut in `read`, unless --full. */
const outputLimit = 2000;
/** How many threads `threads` prints, newest first, unless --limit says. */
const threadsShown = 50;

interface Flags {
  limit?: string;
  state?: string;
  agent?: string;
  last?: string;
  full?: boolean;
  wait?: boolean;
  timeout?: string;
  folder?: string;
  title?: string;
  machine?: string;
  name?: string;
  choice?: string;
  note?: string;
  answers?: string;
  help?: boolean;
}

async function main(argv: string[]): Promise<number> {
  let flags: Flags;
  let words: string[];
  try {
    ({ flags, words } = read(argv));
  } catch (error) {
    return misused((error as Error).message);
  }
  const [command, ...rest] = words;
  if (flags.help || command === undefined || command === "help") {
    console.log(`${usage}\n\n${netUsage}`);
    return 0;
  }
  if (command === "guide") {
    // The guide, or one of its topics: how to write a visual (called a widget at first,
    // which agents told so then still ask for).
    const topic = rest[0] === "widgets" ? "visuals" : rest[0];
    if (rest.length > 1 || (topic !== undefined && topic !== "visuals")) return misused(`There is no guide to ${rest.join(" ")}.`);
    console.log(topic === "visuals" ? visualGuide : guide);
    return 0;
  }

  const socket = socketPath(bridgeHome());
  try {
    // Links are a file in the bridge's folder, which the bridge reads again when it changes.
    if (command === "link" || command === "unlink") {
      console.log(JSON.stringify(command === "link" ? await link(rest, flags) : unlink(rest), null, 2));
      return 0;
    }
    const call = command === "net" ? await netRequest(rest) : request(command, rest, flags);
    let result = await callBridge(socket, call.method, call.params, call.timeoutMs);
    if (command === "read") result = flags.full ? inOrder(result) : shortened(result);
    if (command === "threads") result = fewer(result, number(flags.limit, "--limit") ?? threadsShown);
    console.log(printed(result));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return misused(error.message);
    const failure = error instanceof BridgeError ? { code: error.code, message: error.message } : { message: sentence((error as Error).message) };
    console.error(JSON.stringify({ error: failure }));
    return 1;
  }
}

/** The flags, and whether each takes a value. */
const options: Record<string, "string" | "boolean"> = {
  limit: "string",
  state: "string",
  agent: "string",
  last: "string",
  full: "boolean",
  wait: "boolean",
  timeout: "string",
  folder: "string",
  title: "string",
  machine: "string",
  name: "string",
  choice: "string",
  note: "string",
  answers: "string",
  help: "boolean",
};

/**
 * The flags and words of a command line: `--flag`, `--flag value` or `--flag=value` for
 * the flags above, and `-h`. Anything else is words, even when it starts with "-": a
 * message may open with a list. After `--` all is words.
 */
function read(argv: string[]): { flags: Flags; words: string[] } {
  const flags: Record<string, string | boolean> = {};
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      words.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h") {
      flags.help = true;
      continue;
    }
    const flag = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(argument);
    const type = flag && Object.hasOwn(options, flag[1]) ? options[flag[1]] : undefined;
    if (!flag || !type) {
      words.push(argument);
      continue;
    }
    if (type === "boolean") {
      if (flag[2] !== undefined) throw new UsageError(`--${flag[1]} takes no value.`);
      flags[flag[1]] = true;
      continue;
    }
    const value = flag[2] ?? argv[index + 1];
    if (value === undefined) throw new UsageError(`--${flag[1]} takes a value.`);
    if (flag[2] === undefined) index += 1;
    flags[flag[1]] = value;
  }
  return { flags: flags as Flags, words };
}

function misused(message: string): number {
  console.error(`${message}\n\n${usage}\n\n${netUsage}`);
  return 2;
}

/** The call a command stands for. */
function request(command: string, words: string[], flags: Flags): { method: string; params: Record<string, unknown>; timeoutMs: number } {
  const wait = number(flags.timeout, "--timeout");
  const waiting: Record<string, unknown> = wait === undefined ? {} : { timeout_ms: wait };
  // A call that waits is given the wait's own time, and a little more to answer in.
  const waitMs = Math.min(wait ?? 60_000, longestWaitMs) + marginMs;
  // The thread this runs in, when the bridge or the agent said: its messages then say who they are from.
  const running = thread(process.env);
  const from = running ? { from: running } : {};

  switch (command) {
    case "threads":
      takes(words, 0, command);
      return { method: "threads.list", params: { ...given("state", flags.state), ...given("profile", flags.agent) }, timeoutMs: callMs };
    case "agents":
      takes(words, 0, command);
      return { method: "profiles.list", params: {}, timeoutMs: callMs };
    case "folders":
      takes(words, 0, command);
      return { method: "folders.list", params: { ...given("profile", flags.agent), ...given("machine", flags.machine) }, timeoutMs: callMs };
    case "machines":
      takes(words, 0, command);
      return { method: "machines.list", params: {}, timeoutMs: callMs };
    case "read":
      takes(words, 1, command);
      return { method: "thread.read", params: { thread: words[0], ...given("last", number(flags.last, "--last")) }, timeoutMs: callMs };
    case "send":
      takes(words, 2, command);
      return {
        method: "thread.send",
        params: { thread: words[0], text: words[1], ...from, ...(flags.wait ? { wait: true, ...waiting } : {}) },
        timeoutMs: flags.wait ? waitMs : callMs,
      };
    case "report":
      takes(words, 1, command);
      if (!running) throw new UsageError("report is for an agent's thread that another thread started: run it in that thread.");
      return { method: "thread.report", params: { text: words[0], ...from }, timeoutMs: callMs };
    case "wait":
      takes(words, 1, command);
      return { method: "thread.wait", params: { thread: words[0], ...waiting, ...from }, timeoutMs: waitMs };
    case "start": {
      if (words.length > 1) throw new UsageError("start takes one message, in quotes.");
      if (!flags.agent) throw new UsageError("start needs --agent NAME; `portals agents` lists them.");
      const params = { profile: flags.agent, ...given("machine", flags.machine), ...given("cwd", flags.folder), ...given("title", flags.title), ...given("text", words[0]), ...from };
      // Another Mac is given as long as this one to start the thread, and the way there.
      const startMs = flags.machine ? 2 * callMs : callMs;
      return { method: "thread.start", params: flags.wait ? { ...params, wait: true, ...waiting } : params, timeoutMs: flags.wait ? startMs + waitMs : startMs };
    }
    case "stop":
      takes(words, 1, command);
      return { method: "thread.stop", params: { thread: words[0] }, timeoutMs: callMs };
    case "answer": {
      if (words.length !== 2) throw new UsageError("answer takes a thread and the id of its question, from open_requests.");
      if ((flags.choice === undefined) === (flags.answers === undefined)) throw new UsageError("answer takes --choice for an approval or --answers for a question, not both.");
      if (flags.note !== undefined && flags.choice === undefined) throw new UsageError("--note goes with --choice deny.");
      const answer = flags.choice !== undefined ? { choice: flags.choice, ...given("note", flags.note) } : { answers: answersFrom(flags.answers!) };
      return { method: "thread.answer", params: { thread: words[0], request: words[1], ...answer, ...from }, timeoutMs: callMs };
    }
    default:
      throw new UsageError(`There is no command called ${command}.`);
  }
}

/** The call a `portals net` command stands for (docs/net-plan.md). */
async function netRequest(words: string[]): Promise<{ method: string; params: Record<string, unknown>; timeoutMs: number }> {
  const [what, ...rest] = words;
  const none = (name: string) => {
    if (rest.length > 0) throw new UsageError(`net ${name} takes nothing after it.`);
  };
  switch (what) {
    case undefined:
      return { method: "net.list", params: {}, timeoutMs: callMs };
    case "invite":
      none(what);
      return { method: "net.invite", params: {}, timeoutMs: callMs };
    case "join": {
      if (rest.length > 1) throw new UsageError("net join takes the join link `portals net invite` shows on a Mac in the net, in quotes, or reads it from its input.");
      // Read from the input when not given, so the link (it lets whoever has it in) is in no shell history.
      const link = rest[0] ?? (await input("Paste the join link from `portals net invite` on a Mac in the net, then press Return: "));
      return { method: "net.join_with", params: { link: link.trim() }, timeoutMs: callMs };
    }
    case "remove":
      if (rest.length !== 1) throw new UsageError("net remove takes the id of a member; `portals net` lists them.");
      return { method: "net.remove", params: { member: rest[0] }, timeoutMs: callMs };
    case "rename":
      if (rest.length < 1 || rest.length > 2) throw new UsageError("net rename takes the new name, in quotes, and before it the id of another member of the net (a Mac or a device) to rename that one; `portals net` lists them.");
      return { method: "net.rename", params: rest.length === 2 ? { member: rest[0], name: rest[1] } : { name: rest[0] }, timeoutMs: callMs };
    case "leave":
      none(what);
      return { method: "net.leave", params: {}, timeoutMs: callMs };
    default:
      throw new UsageError(`There is no command called net ${what}.`);
  }
}

/** Links another Mac: checks its bridge takes the sign-in, then keeps it in this bridge's folder. */
async function link(words: string[], flags: Flags): Promise<unknown> {
  if (words.length > 1) throw new UsageError("link takes the pairing link `npx portals-host pair` shows on the other Mac, in quotes, or reads it from its input.");
  // Read from the input when not given, so the link (it holds a password) is in no shell history.
  const pairing = words[0] ?? (await input("Paste the pairing link from `npx portals-host pair` on the other Mac, then press Return: "));
  let found: ReturnType<typeof parsePairingLink>;
  try {
    found = parsePairingLink(pairing.trim());
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const name = machineName(flags.name ?? found.name ?? new URL(found.url).hostname.split(".")[0]);
  if (name === "") throw new UsageError("Give the other Mac a name with --name: letters, digits and dashes.");
  const added: Link = { name, url: found.url, user: found.user, password: found.password };
  const path = pathsFor(bridgeHome()).links;
  // The same name for the same Mac is the link made again (a new password, say); for
  // another Mac it would take the first one's place and its threads' names.
  const taken = readLinks(path).find((other) => other.name === name && other.url !== added.url);
  if (taken) throw new Error(`There is already a linked Mac called ${name}, at ${taken.url}. Link this one with --name and another name, or unlink ${name} first.`);
  let listed: { threads: unknown[] };
  try {
    listed = (await callLink(added, "threads.list", { local: true }, 20_000)) as { threads: unknown[] };
  } catch (error) {
    if (error instanceof BridgeError) throw new Error(error.code === -32601 ? `The bridge on ${name} is too old to be linked. Update it.` : `Could not link ${name}: ${error.message}`);
    throw new Error(`Could not link ${name}: ${whyNot(error)}`);
  }
  writeLinks(path, [...readLinks(path).filter((other) => other.name !== name), added]);
  return { linked: { name, url: added.url }, threads: listed.threads.length };
}

function unlink(words: string[]): unknown {
  if (words.length !== 1) throw new UsageError("unlink takes the name of a linked Mac; `portals machines` lists them.");
  const path = pathsFor(bridgeHome()).links;
  const links = readLinks(path);
  if (!links.some((other) => other.name === words[0])) throw new Error(`There is no linked Mac called ${words[0]}.`);
  writeLinks(path, links.filter((other) => other.name !== words[0]));
  return { unlinked: words[0] };
}

/** What was piped in, or typed and ended with Return after `prompt`. */
async function input(prompt: string): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write(prompt);
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (process.stdin.isTTY && text.includes("\n")) break;
  }
  return text.split("\n")[0] ?? "";
}

/** `text` ending as a sentence does. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function takes(words: string[], count: number, command: string): void {
  if (words.length === count) return;
  const what = ["nothing after it", "a thread", "a thread and one message, in quotes"][count];
  throw new UsageError(`${command} takes ${what}.`);
}

/** The answers `--answers` gives: JSON, each question's qid and what to say (null skips it). */
function answersFrom(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`--answers takes JSON, such as '{"q0":"Swift"}'.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new UsageError(`--answers takes a JSON object, such as '{"q0":"Swift"}'.`);
  return parsed as Record<string, unknown>;
}

function given(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function number(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`${flag} takes a whole number.`);
  return Number(text);
}

/**
 * A `thread.read` answer with what matters most first: the thread, the questions it
 * waits on and the turn in progress, then the messages. A long output can be cut by
 * whoever shows it, and the end of the messages is still the last thing printed.
 */
function inOrder(result: unknown): unknown {
  const { thread, open_requests, inflight, messages, ...rest } = result as Record<string, unknown>;
  return { thread, open_requests, ...(inflight === undefined ? {} : { inflight }), ...rest, messages };
}

/** A `thread.read` answer in order, with long tool output, arguments and diffs cut short. */
function shortened(result: unknown): unknown {
  const reading = inOrder(result) as { messages?: { role?: string; content?: unknown; args?: Record<string, unknown>; display_metadata?: unknown }[] };
  if (!Array.isArray(reading?.messages)) return reading;
  const messages = reading.messages.map((message) => {
    if (message.role !== "tool") return message;
    const { display_metadata: _diff, ...kept } = message;
    const args = Object.fromEntries(Object.entries(message.args ?? {}).map(([key, value]) => [key, typeof value === "string" ? short(value) : value]));
    return { ...kept, args, ...(typeof message.content === "string" ? { content: short(message.content) } : {}) };
  });
  return { ...reading, messages };
}

function short(text: string): string {
  if (text.length <= outputLimit) return text;
  return `${text.slice(0, outputLimit)}… (${text.length - outputLimit} more characters; --full shows them)`;
}

/**
 * JSON as the command prints an answer: each of its keys on a line, and a list's entries
 * a line each, each entry on its one line. Every agent that runs the command reads all of
 * it: indenting every level, as `JSON.stringify(…, null, 2)` does, cost a fifth more
 * characters on `portals threads` for nothing an agent needs.
 */
export function printed(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return JSON.stringify(value);
  const lines = Object.entries(value)
    .filter(([, held]) => held !== undefined)
    .map(([key, held]) => {
      const head = `  ${JSON.stringify(key)}: `;
      if (Array.isArray(held) && held.length > 0) return `${head}[\n${held.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]`;
      return head + JSON.stringify(held);
    });
  return lines.length === 0 ? "{}" : `{\n${lines.join(",\n")}\n}`;
}

/** A `threads.list` answer with the newest `limit` threads, and how many more there are. */
function fewer(result: unknown, limit: number): unknown {
  const listed = result as { threads?: unknown[] };
  if (!Array.isArray(listed?.threads) || listed.threads.length <= limit) return result;
  return { ...listed, threads: listed.threads.slice(0, limit), more: listed.threads.length - limit };
}

process.exitCode = await main(process.argv.slice(2));
