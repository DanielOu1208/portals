import { cutWhole } from "../json.ts";

// Who a message sent through the fleet is from, and who started a thread through it
// (docs/gateway-protocol.md, feature `senders`; docs/fleet-plan.md): a few facts, made
// here, and the line such a message opens with, made from them and read back into them
// here too, so that nothing else in the bridge knows how that line is written.
//
// The line is for the agent that gets the message, and for apps from before the facts:
// neither should take the message for the user's words. It reads
// `[Portals: from Claude Code · "Fix the login" (thread 6d3c…)]` for a thread of the same
// Mac, `[Portals: from Codex · "Review" (thread 7d2a41c09be36f58/019a…) on mini]` for one
// of another Mac (its stable id, a slash and the thread's id there, then its name), and
// `[Portals: from the command line]` (`… (machine 7d2a41c09be36f58) on mini`) for a person or a
// script in a terminal. The message follows on the next line. Apps read the facts (`from`), and
// read the line only from a bridge that gives none; a later bridge may write the line
// another way as long as it gives the facts.

/**
 * Who sent a message through the fleet, or started a thread through it. Every key may
 * be left out: none of `agent_name` and `thread` is the command line.
 */
export interface From {
  /** The sending thread's agent, by its profile name on its Mac (`threads.list`'s `agent`, `claude`), when known. */
  agent?: string;
  /** That agent as the person knows it: "Claude Code". */
  agent_name?: string;
  /** The sending thread's id on its own Mac. */
  thread?: string;
  /** Its title when it sent the message, when it had one other than its agent's name. */
  title?: string;
  /** The stable id of the Mac it came from (`gateway.ready`'s `machine.id`), when that is another Mac than the thread's. */
  machine?: string;
  /** That Mac's name for itself (its Computer Name, or `fleet.name`). */
  machine_name?: string;
}

/** This bridge's Mac: its stable id and its name for itself. */
export interface Here {
  id: string;
  name: string;
}

const keys = ["agent", "agent_name", "thread", "title", "machine", "machine_name"] as const;
/** The longest a fact may be: a title, or another bridge's name for itself. */
const longest = 300;
/** The longest an id or an agent's name may be (`agent`, `agent_name`, `thread`, `machine`): ids are 16 to 44 characters. */
const longestName = 100;

/**
 * The longest words a line may name who by and still be read into facts: more than any
 * line this bridge writes (a title and a Mac's name of at most `longest` characters, the
rest of at most `longestName`: about 920 characters in all). Its patterns take
 * time that grows with the square of what they read, so a longer line (someone typed
 * one, or another host wrote it) is not read: 1,200 characters at worst take a
 * millisecond here, and about 25 ms in the app, which reads it the same way.
 */
export const longestWords = 1200;

const opening = "[Portals: from ";
const pattern = /^\[Portals: from [^\n]*\]$/;
/** A thread's words: its agent, its title in quotes, its id (another Mac's id before it, with a slash), and the Mac. */
const threadWords = /^(.+?)(?: · "(.*)")? \(thread ([^()\s]+)\)(?: on (.+))?$/;
const commandLine = "the command line";
/** A terminal's words: another Mac's id in brackets (from this bridge on), and its name. */
const commandLineWords = /^the command line(?: \(machine ([^()\s]+)\))?(?: on (.+))?$/;

/** One line of at most `most` characters: what a fact may hold. */
function fact(value: unknown, most: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  return line === "" ? undefined : cutWhole(line, most);
}

/** The facts `value` holds, as another bridge passed them on (`sent_by`), each a line; undefined for none. */
export function readFrom(value: unknown): From | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const from: From = {};
  for (const key of keys) {
    const given = fact((value as Record<string, unknown>)[key], key === "title" || key === "machine_name" ? longest : longestName);
    if (given !== undefined) from[key] = given;
  }
  return Object.keys(from).length > 0 ? from : undefined;
}

/** The facts as seen from another Mac: what was this bridge's own now says which Mac it is on. */
export function fromHere(from: From, here: Here): From {
  return from.machine !== undefined ? from : { ...from, machine: here.id, machine_name: here.name };
}

/** Who the line names, in words, for the bridge that stores the message: `here` is its Mac's id, whose threads need no Mac. */
export function words(from: From, here?: string): string {
  // Another Mac's thread is named by that Mac's id and its own; one named only by an older bridge's name for its Mac has none.
  const named = from.machine !== undefined && from.machine !== here;
  const elsewhere = named || (from.machine === undefined && from.machine_name !== undefined);
  const on = elsewhere ? ` on ${from.machine_name ?? from.machine}` : "";
  // Another Mac's command line is named by that Mac's id too, as its threads are.
  if (from.thread === undefined) return `${from.agent_name ?? commandLine}${named ? ` (machine ${from.machine})` : ""}${on}`;
  const agent = from.agent_name ?? from.agent ?? "an agent";
  // A title that only repeats the agent's name says nothing more.
  const title = from.title !== undefined && from.title !== agent ? ` · "${from.title}"` : "";
  return `${agent}${title} (thread ${named ? `${from.machine}/` : ""}${from.thread})${on}`;
}

/** A message from `from`, as it goes into a thread on the Mac `here`. */
export function fromLine(from: From, text: string, here?: string): string {
  return `${opening}${words(from, here)}]\n${text}`;
}

/** A message passed on by an older bridge, which says who in its own words. */
export function fromWords(sender: string, text: string): string {
  return `${opening}${cutWhole(sender.replace(/\s+/g, " ").trim(), longest)}]\n${text}`;
}

/** Whether `line` is such a first line. */
export function isFromLine(line: string): boolean {
  return pattern.test(line.trim());
}

/** The message without its first line, when it has one. */
export function withoutFromLine(text: string): string {
  const [first, ...rest] = text.split("\n");
  return isFromLine(first) ? rest.join("\n") : text;
}

/**
 * Who a message as stored (`text`) is from, read from its first line; undefined for one
 * with none, and for one whose line says who in words this bridge did not write (an
 * older bridge passing a message on said who as it liked). A thread of another Mac
 * that an older bridge named has `machine_name` and no `machine`.
 */
export function senderOf(text: string): From | undefined {
  if (!text.startsWith(opening)) return undefined;
  const end = text.indexOf("\n");
  const first = (end === -1 ? text : text.slice(0, end)).trim();
  if (!isFromLine(first)) return undefined;
  const who = first.slice(opening.length, -1);
  if (who.length > longestWords) return undefined;
  const terminal = commandLineWords.exec(who);
  if (terminal) {
    const [, machine, mac] = terminal;
    return { ...(machine !== undefined ? { machine } : {}), ...(mac !== undefined ? { machine_name: mac } : {}) };
  }
  const matched = threadWords.exec(who);
  if (!matched) return undefined;
  const [, agent, title, ref, mac] = matched;
  const slash = ref.indexOf("/");
  const from: From = { agent_name: agent };
  if (title !== undefined) from.title = title;
  from.thread = slash > 0 ? ref.slice(slash + 1) : ref;
  if (slash > 0) from.machine = ref.slice(0, slash);
  if (mac !== undefined) from.machine_name = mac;
  return from;
}
