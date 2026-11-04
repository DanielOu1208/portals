import { basename, extname } from "node:path";
import { FileUndoRefused } from "../sessions/fileUndo.ts";
import type { Config } from "../config.ts";
import { defaultDeskLimit, type DeskSessions } from "../desk.ts";
import { checkLevel, chooseModel, defaultWaitMs, isThreadState, readOnlyText, threadStates, type Fleet, type Sender } from "../fleet/fleet.ts";
import { readFrom } from "../fleet/line.ts";
import { defaultFolderLimit, folderLimitMax, type FolderSearch } from "../folderSearch.ts";
import { FolderRefused, type Folders } from "../folders.ts";
import { highestLookIndex, isLookCondition, isLookIndex, isLookOrigin, lookConditions, lookOrigins, type Look, type Looks } from "../looks.ts";
import { NetError, thisMacOnlyRefusal, type Net, type SignedIn } from "../net/net.ts";
import { isOrderMoment, longestOrder, orderNames, type Order, type OrderChange, type SidebarOrder } from "../order.ts";
import { machineWord } from "../platform.ts";
import { adoptModes, DeskRefused, isAdoptMode, isThreadMode, threadModes, type Provider, type StoredMessage, type UsageReport } from "../providers/types.ts";
import { modeFields, providerModeOptions } from "../providers/modes.ts";
import { FileReader, ownFolder } from "../sessions/fileRead.ts";
import { gitDiffs, gitStatus, GitStatusError } from "../sessions/gitStatus.ts";
import { OpenError, Openers } from "../openers.ts";
import { defaultSearchLimit, searchLimitMax, type FileSearch } from "../sessions/fileSearch.ts";
import { checkLinkedCursor, searchLinked } from "../search/linked.ts";
import { BadCursor, checkSearch, EmptyQuery, type SearchParams, type ThreadSearch } from "../search/search.ts";
import { fileLimit, safeFileName } from "../sessions/files.ts";
import { checkMentions, largeMentions, withSizes, type MentionLimit } from "../sessions/mentions.ts";
import { UnknownThreadError, type SessionManager } from "../sessions/manager.ts";
import { GivenUp, type Peer, type Session } from "../sessions/session.ts";
import * as commands from "./commands.ts";
import { ErrorCode, invalidParams, RpcError } from "./errors.ts";
import type { PollNow, PollNowPeer } from "./pollNow.ts";
import { McpAuthSettling, type McpAuthAction } from "../providers/mcpAuth.ts";
import { SettingRefused } from "../providers/types.ts";
import { diskFields, type DiskReading } from "../disk.ts";

// Every method the app calls (docs/gateway-protocol.md, section 5), with the params the
// bridge reads. Params not listed are ignored, never rejected: Hermes rejects them, but
// the bridge is meant to stay usable by an app newer than itself. `contract.ts` turns
// this table into `bridge/contract.json`, which `scripts/check-contract.sh` checks
// against what the app sends.

/** `strings` is a list of strings; `list` a list of anything. */
export type ParamType = "string" | "boolean" | "integer" | "strings" | "list" | "object";

/** What a handler can reach. */
export interface GatewayContext {
  readonly config: Config;
  readonly sessions: SessionManager;
  /** By profile name, in the order the sidebar lists them. */
  readonly providers: Map<string, Provider>;
  /** The folders new threads may run in. */
  readonly folders: Folders;
  /** Sessions started at the desk. */
  readonly desk: DeskSessions;
  /** The threads as a whole: listed, read, sent to, waited for, started, stopped. */
  readonly fleet: Fleet;
  /** How the agents look on every device. */
  readonly looks: Looks;
  /** The order the user gave the agents and the folders in the sidebar. */
  readonly order: SidebarOrder;
  /** The id this bridge gave itself, by which the order of the user's Macs names it. */
  readonly machine: string;
  /** Tells the devices that ask when something they poll for moved (feature poll_now). */
  readonly pollNow: PollNow;
  /** Reads a file from anywhere on this Mac for a device (feature file_read). */
  readonly files: FileReader;
  /** Ranks the files of a thread's folder against a fuzzy query (feature file_search). */
  readonly fileSearch: FileSearch;
  /** Ranks the folders under the home folder for a new thread (feature folder_search). */
  readonly folderSearch: FolderSearch;
  /** The Macs and devices this one is in a net with (feature net). */
  readonly net: Net;
  /** Searches inside the threads (feature thread_search). */
  readonly search: ThreadSearch;
  /** Whether a later portals-host is out (feature update_notice); absent when the bridge does not ask (`updates.check` off). */
  readonly updates?: { readonly latest: string | undefined };
  /** The free space on the bridge's disk, once it has been read (feature disk_space). */
  readonly disk?: { readonly now: DiskReading | undefined };
  /** The apps a thread's folder opens in on this computer (feature open_on_host); this computer's own when absent. */
  readonly openers?: Openers;
}

/** The connection a call came on. */
export interface Caller extends Peer, PollNowPeer {
  takesRequests: boolean;
  keepsSubagentRequests: boolean;
  /** It keeps the card of a question asked without waiting after the turn, and answers it then (feature async_questions). */
  keepsAsyncQuestions: boolean;
  /** The id the app gave itself (feature answer_owner), which a `request.cancel` its answer settled names. */
  deviceID: string | undefined;
  sessionResync: boolean;
  messageReconciliation?: boolean;
  /** Takes compact live text/reasoning frames after the capability's reply (feature lean_deltas). */
  leanDeltas?: boolean;
  /** The replay epoch its `gateway.ready` gave: this run of the bridge. */
  readonly replayEpoch: string;
  /** How it signed in (feature net). */
  readonly signedIn: SignedIn;
}

export interface CallContext {
  readonly caller: Caller;
  readonly gateway: GatewayContext;
  /** Runs right after the reply is sent, before anything else can happen. */
  afterReply(action: () => void): void;
  /** Aborted when the connection closes: a wait for a caller who has gone ends. */
  readonly hungUp: AbortSignal;
}

/**
 * A result to build at the moment of replying, in the same step as sending it. Used
 * where an answer and a subscription must not be split by an event (`session.resume`).
 */
export class Atomic {
  readonly build: () => unknown;

  constructor(build: () => unknown) {
    this.build = build;
  }
}

export interface MethodSpec {
  summary: string;
  params: Record<string, ParamType>;
  required?: string[];
  handle(params: Record<string, unknown>, context: CallContext): unknown;
}

/** Throws -32602 for a missing required param or a known one of the wrong type. */
export function checkParams(spec: MethodSpec, params: Record<string, unknown>): void {
  for (const [key, type] of Object.entries(spec.params)) {
    const value = params[key];
    if (value === undefined || value === null) {
      if (spec.required?.includes(key)) throw invalidParams(`${key} is missing.`);
      continue;
    }
    const fits =
      type === "integer"
        ? Number.isInteger(value)
        : type === "strings"
          ? Array.isArray(value) && value.every((item) => typeof item === "string")
          : type === "list"
            ? Array.isArray(value)
            : type === "object"
              ? typeof value === "object" && !Array.isArray(value)
              : typeof value === type;
    if (!fits) throw invalidParams(`${key} must be ${type === "integer" ? "a whole number" : type === "strings" ? "a list of strings" : type === "list" ? "a list" : type === "object" ? "an object" : `a ${type}`}.`);
  }
}

// MARK: Helpers

function provider(gateway: GatewayContext, profile: unknown): Provider {
  return gateway.fleet.agent(profile);
}

/** The loaded session `id`, if this connection follows it. Otherwise 4001: the app resumes and tries again. */
function followed(context: CallContext, id: unknown): Session {
  const session = context.gateway.sessions.get(String(id));
  if (!session || !session.isFollowedBy(context.caller)) {
    throw new RpcError(ErrorCode.sessionNotLoaded, "This thread is not open on this connection. Resume it first.");
  }
  return session;
}

/** The folder of one of the bridge's threads, followed here or not. */
function threadFolder(gateway: GatewayContext, id: unknown): string {
  const record = gateway.sessions.record(String(id));
  if (!record) throw new RpcError(ErrorCode.notFound, `This thread is not on this ${machineWord()}.`);
  return record.cwd;
}

let openers: Openers | undefined;
function defaultOpeners(): Openers {
  return (openers ??= new Openers());
}

/** The service a kind of agent's plan is with, as its plans are named ("Claude Max", "Codex Pro 100"). */
const planBrands: Record<string, string> = { claude: "Claude", codex: "Codex", droid: "Factory", cursor: "Cursor" };

/** The plan as people name it: its service, then the plan with each word capitalized; the agent's name without one. */
export function usageTitle(kind: string, agentName: string, plan: string | undefined): string {
  const brand = planBrands[kind] ?? agentName;
  if (!plan) return brand;
  const named = plan.replaceAll("_", " ").split(" ").filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  return `${brand} ${named}`;
}

/** How long an agent's answer to `usage.read` serves every device: Claude Code may be started only to ask. */
const usageMaxAgeMs = 60_000;
const usageAsked = new WeakMap<Provider, { at: number; report: Promise<UsageReport> }>();

/** The agent's usage as of the last minute, or that it could not say, asked once for every device that asks meanwhile. */
function recentUsage(agent: Provider, thread: string): Promise<UsageReport> {
  const kept = usageAsked.get(agent);
  if (kept && Date.now() - kept.at < usageMaxAgeMs) return kept.report;
  const report = agent.usage!(thread);
  // One that failed stands too: an expired sign-in or a 429 is not asked again sooner.
  usageAsked.set(agent, { at: Date.now(), report });
  return report;
}

export { readOnlyText };

/**
 * The thread's live session now, checked in the step that follows or uses it: the one
 * loaded, or the one that replaced it while the call was under way (a thread only read,
 * continued). 4007 when the thread was taken off the list meanwhile (`thread.delete`),
 * as for any thread the bridge does not know.
 */
function present(gateway: GatewayContext, session: Session): Session {
  try {
    return gateway.sessions.current(session);
  } catch (error) {
    if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
    throw error;
  }
}

/** The session, unless it is only read. */
function writable(session: Session): Session {
  if (session.isReadOnly) throw invalidParams(readOnlyText);
  return session;
}

/** Who a message sent with `thread.send` or `thread.start` is from: a thread of this bridge, or as another bridge put it. */
function sentBy(params: Record<string, unknown>): Sender {
  return {
    from: (params.from as string | undefined) || undefined,
    sender: (params.sender as string | undefined) || undefined,
    origin: (params.origin as string | undefined) || undefined,
    sentBy: readFrom(params.sent_by),
  };
}

/**
 * `params` with `from` as the bridge's own id for that thread (`Fleet.threadOf`): a
 * command in a Cursor thread whose conversation was started afresh says the new
 * conversation's id.
 */
function asSent(params: Record<string, unknown>, fleet: Fleet): Record<string, unknown> {
  if (typeof params.from !== "string" || params.from === "") return params;
  const thread = fleet.threadOf(params.from);
  return thread === params.from ? params : { ...params, from: thread };
}

/** How long a `thread.*` call waits: what it was told, else the usual. */
function waitTime(params: Record<string, unknown>): number {
  return typeof params.timeout_ms === "number" ? params.timeout_ms : defaultWaitMs;
}

/** How many turns `session.history` gives when not told (feature history_pages). */
const defaultPageTurns = 30;
/** At most this many turns to a page: one more takes a resume of its own. */
const maxPageTurns = 200;

/** The turns a page asks for (`limit`, feature history_pages), within bounds; undefined when it asks for none. */
function pageTurns(limit: unknown): number | undefined {
  if (typeof limit !== "number") return undefined;
  if (limit < 1) throw invalidParams("limit must be at least 1.");
  return Math.min(limit, maxPageTurns);
}

/** `"<model>[ --provider <slug>] --session"`, the way the app writes a model change. */
export function parseModelValue(value: string): { model: string; provider?: string } {
  const words = value.trim().split(/\s+/);
  let model: string | undefined;
  let providerSlug: string | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--provider") {
      providerSlug = words[++index];
    } else if (word === "--global") {
      throw invalidParams("The bridge only changes the model of one thread, not the agent's default.");
    } else if (!word.startsWith("--") && model === undefined && word !== "") {
      model = word;
    }
  }
  if (!model) throw invalidParams("Name a model to switch to.");
  return { model, provider: providerSlug };
}

/** The longest id of a device's for a message that the bridge passes on (feature turn_messages). */
const messageIDLimit = 100;

const imageTypes = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]);
const imageLimit = 20 * 1024 * 1024;

// MARK: The methods

export const methods: Record<string, MethodSpec> = {
  "client.capabilities": {
    summary:
      "Says whether the client answers approval and clarify requests, keeps subagent requests after the turn (subagent_requests), keeps questions asked without waiting after the turn (async_questions), receives poll hints (poll_now), rebuilds invalidated sessions without reconnecting (session_resync), reconciles exact failed requests (message_reconciliation), takes compact live text/reasoning frames (lean_deltas), and the id it gave itself, which request.cancel names as answered_by (device, feature answer_owner).",
    params: { server_requests: "boolean", subagent_requests: "boolean", async_questions: "boolean", poll_now: "boolean", session_resync: "boolean", message_reconciliation: "boolean", lean_deltas: "boolean", device: "string" },
    handle(params, { caller, gateway, afterReply }) {
      caller.takesRequests = params.server_requests === true;
      caller.sessionResync = params.session_resync === true;
      caller.messageReconciliation = params.message_reconciliation === true;
      // A thread it follows keeps a subagent's question open after the turn (Session.follow).
      caller.keepsSubagentRequests = caller.takesRequests && params.subagent_requests === true;
      // A thread it follows puts an agent's questions asked without waiting to it as a card (Session.follow).
      caller.keepsAsyncQuestions = caller.takesRequests && params.async_questions === true;
      // Named as who answered in the request.cancel its answer settles (feature answer_owner).
      caller.deviceID = typeof params.device === "string" && params.device !== "" && params.device.length <= 128 ? params.device : undefined;
      // Told from now on, until it says otherwise or closes (pollNow.ts).
      gateway.pollNow.ask(caller, params.poll_now === true);
      // The answer is the boundary: no compact frame comes before the opt-in is acknowledged.
      afterReply(() => { caller.leanDeltas = params.lean_deltas === true; });
      return { server_requests: ["approval", "clarify"], ...(params.lean_deltas === true ? { lean_deltas: true } : {}) };
    },
  },

  "gateway.ping": {
    summary: "Heartbeat; answered at once.",
    params: {},
    handle: () => ({ ok: true }),
  },

  "profiles.list": {
    summary: "The agents this bridge runs.",
    params: {},
    handle(_params, { gateway }) {
      const profiles = [...gateway.providers.values()].map((agent, index) => ({
        name: agent.profile.name,
        kind: agent.profile.kind,
        display_name: agent.profile.displayName,
        description: agent.profile.description,
        model: agent.profile.model,
        provider: agent.profile.provider,
        is_default: index === 0,
        ...(agent.adopt ? { adopt_modes: adoptModes } : {}),
        ...(providerModeOptions(agent) ? { mode_options: providerModeOptions(agent) } : {}),
      }));
      return { profiles };
    },
  },

  "session.create": {
    summary:
      "Starts a thread and follows it on this connection; for an agent that keeps one ongoing conversation (feature bot_chat), follows that one, ongoing: true, which may hold what was said before (a resume gives it).",
    params: {
      profile: "string",
      source: "string",
      title: "string",
      cwd: "string",
      model: "string",
      provider: "string",
      reasoning_effort: "string",
    },
    async handle(params, { caller, gateway }) {
      const session = await gateway.fleet.start(params);
      return new Atomic(() => {
        const now = present(gateway, session);
        now.follow(caller);
        return { session_id: now.id, stored_session_id: now.id, info: now.info(), ...(now.record.ongoing ? { ongoing: true } : {}) };
      });
    },
  },

  "session.resume": {
    summary:
      "Follows a thread by its stored id and returns it as it is now; for a device that holds it up to event since of this run (replay_epoch), taken where its replay began at replay_base, with the events after it in place of the conversation where the log has them (replayed, feature resume_replay), and to one that names this run, where the replay of what it now holds begins (replay_base).",
    params: { session_id: "string", profile: "string", inline_images: "boolean", since: "integer", replay_epoch: "string", replay_base: "integer", limit: "integer" },
    required: ["session_id"],
    async handle(params, { caller, gateway }) {
      let session: Session;
      do {
        try {
          session = await gateway.sessions.load(params.session_id as string);
        } catch (error) {
          if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
          throw error;
        }
        // A thread only read shows what the terminal has done meanwhile; continued
        // elsewhere while it was read, it is opened again as continued; continued here and
        // gone on elsewhere since (a Pi at the desk), it is loaded again to show it.
        await gateway.sessions.refresh(session);
      } while (session.isRetired);
      // The snapshot, the subscription and the reply in one step: every earlier event
      // is in the snapshot and every later one goes out live, after the reply. Feature
      // resume_replay: for a device that holds the thread up to an event of this run, the
      // events after it in place of the conversation, when the log has them and the
      // conversation it took is the one they follow on from, in the same step.
      const replays = params.replay_epoch === caller.replayEpoch;
      const since = replays ? (params.since as number | undefined) : undefined;
      const base = replays ? (params.replay_base as number | undefined) : undefined;
      const turns = pageTurns(params.limit);
      return new Atomic(() => {
        const now = present(gateway, session);
        // Feature async_questions: questions found open as the thread was loaded are put
        // again to a device that keeps their card, in this answer.
        now.askAgain(caller);
        const answer = (since !== undefined && base !== undefined ? now.replay(since, base) : undefined) ?? now.snapshot(turns);
        // What it sends back with the next since: its numbers alone cannot tell the
        // conversation it holds from one before a change no event told of.
        if (replays) answer.replay_base = now.replayBase;
        now.follow(caller);
        return answer;
      });
    },
  },

  "session.history": {
    summary:
      "The limit turns (30 when not said) of a followed thread's conversation before message before, for a device that took it from there by session.resume with limit in this run (replay_epoch), where its replay began at replay_base (feature history_pages): messages, start (where they begin) and has_earlier; moved: true when that is not the conversation now, which the device then takes again.",
    params: { session_id: "string", before: "integer", limit: "integer", replay_epoch: "string", replay_base: "integer", profile: "string" },
    required: ["session_id", "before", "replay_epoch", "replay_base"],
    handle(params, { caller, gateway }) {
      const session = gateway.sessions.get(params.session_id as string);
      const before = params.before as number;
      if (before < 0) throw invalidParams("before cannot be below 0.");
      if (!session || params.replay_epoch !== caller.replayEpoch) return { moved: true };
      const turns = pageTurns(params.limit) ?? defaultPageTurns;
      return new Atomic(() => session.history(before, turns, params.replay_base as number) ?? { moved: true });
    },
  },

  "session.leave": {
    summary:
      "Stops following a thread on this connection (feature session_leave): none of its events or questions come here any more. The thread runs on; a resume follows it again. {} also for a thread not followed or not loaded.",
    params: { session_id: "string", profile: "string" },
    required: ["session_id"],
    handle(params, { caller, gateway }) {
      gateway.sessions.get(params.session_id as string)?.unfollow(caller);
      return {};
    },
  },

  "session.events.since": {
    summary: "The events after last_seen, and the open requests.",
    params: { session_id: "string", last_seen: "integer", profile: "string" },
    required: ["session_id", "last_seen"],
    handle(params, { gateway }) {
      const session = gateway.sessions.get(params.session_id as string);
      // Not a failure: the app takes a snapshot instead.
      if (!session) return { events: [], truncated: true, latest_seq: 0, open_requests: [] };
      return new Atomic(() => session.eventsSince(params.last_seen as number));
    },
  },

  "prompt.submit": {
    summary: "Sends the user's message; the turn arrives as events.",
    params: { session_id: "string", text: "string", profile: "string", when_busy: "string", message_id: "string", mentions: "strings" },
    required: ["session_id", "text"],
    handle(params, context) {
      const session = writable(followed(context, params.session_id));
      const text = params.text as string;
      // Feature file_mentions: the files and folders it mentions, those in the thread's
      // folder kept. Checked here, in the step the message is taken in: a message sent
      // after this one never overtakes it.
      const record = context.gateway.sessions.record(params.session_id as string);
      const mentions = Array.isArray(params.mentions) && params.mentions.length > 0 ? checkMentions(record?.cwd, params.mentions as string[]) : [];
      // The files among them the thread's agent may not read in, for the note an app shows.
      const limit = record && mentions.length > 0 ? context.gateway.providers.get(record.agent)?.mentionLimit?.(record.cwd) : undefined;
      const large = limit && record ? largeMentions(record.cwd, mentions, limit) : [];
      if (text.trim() === "" && mentions.length === 0 && !session.hasAttachments(context.caller)) throw invalidParams("The message is empty.");
      if (params.when_busy !== undefined && params.when_busy !== "steer" && params.when_busy !== "queue") {
        throw invalidParams("when_busy must be steer or queue.");
      }
      // Feature turn_messages: the device's own id for the message, which the event telling of
      // it names. Every follower is sent it, so only a short one is: a longer one is left out.
      const id = params.message_id as string | undefined;
      const messageID = id !== undefined && id !== "" && id.length <= messageIDLimit ? id : undefined;
      const outcome = session.submit(text, { queue: params.when_busy === "queue", by: context.caller, messageID, mentions });
      if (outcome.begin) context.afterReply(outcome.begin);
      return {
        status: outcome.status,
        ...(outcome.queueID === undefined ? {} : { queue_id: outcome.queueID }),
        ...(large.length > 0 ? { large_mentions: large } : {}),
      };
    },
  },

  "prompt.queue.remove": {
    summary: "Takes a message waiting for the running turn to end off the thread's list: it is never sent (feature queue).",
    params: { session_id: "string", queue_id: "string", profile: "string" },
    required: ["session_id", "queue_id"],
    async handle(params, context) {
      const session = writable(followed(context, params.session_id));
      return { removed: await session.removeQueued(params.queue_id as string) };
    },
  },

  "prompt.queue.steer": {
    summary: "Hands a message waiting for the running turn to end to that turn now (feature queue).",
    params: { session_id: "string", queue_id: "string", profile: "string" },
    required: ["session_id", "queue_id"],
    async handle(params, context) {
      const session = writable(followed(context, params.session_id));
      return { status: await session.steerQueued(params.queue_id as string) };
    },
  },

  "prompt.queue.place": {
    summary: "Moves a pending message between steering and the bridge's durable queue (feature queue).",
    params: { session_id: "string", queue_id: "string", placement: "string", profile: "string" },
    required: ["session_id", "queue_id", "placement"],
    async handle(params, context) {
      if (params.placement !== "steer" && params.placement !== "queue") throw invalidParams("placement must be steer or queue.");
      const session = writable(followed(context, params.session_id));
      return { status: await session.placeQueued(params.queue_id as string, params.placement) };
    },
  },

  "file.attach_bytes": {
    summary: "Saves a file of any kind in the thread's folder for this connection's next message, which names its path (feature files).",
    params: { session_id: "string", content_base64: "string", filename: "string", id: "string", profile: "string" },
    required: ["session_id", "content_base64"],
    async handle(params, context) {
      const session = writable(followed(context, params.session_id));
      const name = safeFileName((params.filename as string | undefined) ?? "file");
      const data = Buffer.from(params.content_base64 as string, "base64");
      // A file turned down fails its message: nothing attached for it is kept.
      if (data.length > fileLimit) {
        session.dropAttachments(context.caller);
        return { attached: false, message: `${name} is larger than ${fileLimit / 1024 / 1024} MB.` };
      }
      const id = (params.id as string | undefined) ?? undefined;
      const current = present(context.gateway, session);
      try {
        const path = await current.attachFile(name, data, { by: context.caller, id });
        return { attached: true, name: basename(path), path };
      } catch (error) {
        // Its message was given up already: what the connection attached since is another's.
        if (!(error instanceof GivenUp)) current.dropAttachments(context.caller);
        return { attached: false, message: `${name} could not be saved on the ${machineWord()}: ${(error as Error).message}` };
      }
    },
  },

  "file.read": {
    summary:
      "A file anywhere on this Mac for a device to show (feature file_read): an image a reply names (purpose image), or a file to read (purpose text, the default); answered with its bytes (data, base64) or text, unchanged when it is the one the device holds (unless), or refused with why. The thread need not be followed.",
    params: { session_id: "string", path: "string", purpose: "string", unless: "string", profile: "string" },
    required: ["session_id", "path"],
    async handle(params, { gateway }) {
      const record = gateway.sessions.record(params.session_id as string);
      if (!record) throw new RpcError(ErrorCode.notFound, `This thread is not on this ${machineWord()}.`);
      const purpose = params.purpose ?? "text";
      if (purpose !== "image" && purpose !== "text") throw invalidParams("purpose must be image or text.");
      return gateway.files.read({ cwd: record.cwd, path: params.path as string, purpose, unless: params.unless as string | undefined });
    },
  },

  // The panel beside the chat (2026-10-31): what the thread's repository holds
  // uncommitted, how much of the plan its agent has used, and its folder opened on this
  // computer. None needs the connection to follow the thread.

  "git.status": {
    summary:
      "What is not committed in the repository the thread's folder is in (feature git_status): repo false outside one; with no git that runs without asking to install anything, git false and the branch alone; else the repository's top (root), branch, commit, the branch it follows (upstream) and how far ahead and behind, and each file that differs from HEAD, staged or not or untracked, with the lines it adds and removes (null for a binary one), at most 300 of total, and the lines in all.",
    params: { session_id: "string", profile: "string" },
    required: ["session_id"],
    async handle(params, { gateway }) {
      try {
        return await gitStatus(threadFolder(gateway, params.session_id));
      } catch (error) {
        if (error instanceof GitStatusError) throw invalidParams(error.message);
        throw error;
      }
    },
  },

  "git.diff": {
    summary:
      "Everything not committed in the repository the thread's folder is in, against HEAD, as one diff (feature git_status): root, total (how many files differ in all, more than files holds when it was cut short), and files, each as git.status lists it (path, status, added, removed) with its unified diff, staged and not together, a file git does not track yet as all added; a file's diff that does not fit in 512 KB of diffs in all, or that git could not give, is left out (cut true, diff empty), and those after it that fit still come.",
    params: { session_id: "string", profile: "string" },
    required: ["session_id"],
    async handle(params, { gateway }) {
      try {
        return await gitDiffs(threadFolder(gateway, params.session_id));
      } catch (error) {
        if (error instanceof GitStatusError) throw invalidParams(error.message);
        throw new RpcError(ErrorCode.internal, `git could not show the changes: ${(error as Error).message}`);
      }
    },
  },

  "usage.read": {
    summary:
      "How much of the user's plan the thread's agent has used, as the agent tells it (feature usage_read), what /usage says: available false for an agent that cannot say; else its plan, the plan as people name it (title: \"Claude Max\", \"Codex Pro 100\"), each window (name, percent used, resets_at in Unix seconds, reached, window_seconds, how long it is, where known, and heard_at, in milliseconds since 1970, for a window kept from an earlier answer because this one did not say it, or that a turn has reported since this answer), heard_at for limits not asked of it just now, as last heard, and a note. An agent is asked at most once a minute, whoever asks, and an answer it could not give stands for that minute as a good one does. Claude Code with none running is started to ask at most every ten minutes while it reads the limits (its last answer stands between, with heard_at, and what a turn has reported since is over it); after an answer without them, a minute later, then after 2, 4, 8 and 10.",
    params: { session_id: "string", profile: "string" },
    required: ["session_id"],
    async handle(params, { gateway }) {
      const record = gateway.sessions.record(params.session_id as string);
      if (!record) throw new RpcError(ErrorCode.notFound, `This thread is not on this ${machineWord()}.`);
      const agent = gateway.providers.get(record.agent);
      if (!agent?.usage) return { available: false };
      try {
        const report = await recentUsage(agent, record.id);
        return {
          available: true,
          ...(report.plan ? { plan: report.plan } : {}),
          title: usageTitle(agent.profile.kind, agent.profile.displayName, report.plan),
          limits: report.limits.map((limit) => ({
            name: limit.name,
            percent: limit.percent,
            resets_at: limit.resetsAt,
            ...(limit.reached ? { reached: true } : {}),
            ...(limit.windowSeconds ? { window_seconds: limit.windowSeconds } : {}),
            ...(limit.heardAt !== undefined ? { heard_at: limit.heardAt } : {}),
          })),
          ...(report.heardAt !== undefined ? { heard_at: report.heardAt } : {}),
          ...(report.note ? { note: report.note } : {}),
        };
      } catch (error) {
        throw new RpcError(ErrorCode.internal, `${agent.profile.displayName} did not say how much is used: ${(error as Error).message}`);
      }
    },
  },

  "host.apps": {
    summary: "The apps on this computer a thread's folder opens in (feature open_on_host): the Finder, the editors and terminals installed, each an id, a name, its kind (files, editor, terminal) and its icon, a 64-pixel PNG in base64, where one could be drawn.",
    params: {},
    async handle(_params, { gateway }) {
      return { apps: await (gateway.openers ?? defaultOpeners()).apps() };
    },
  },

  "folder.open": {
    summary: "Opens the thread's folder on this computer's own screen, in one of host.apps (feature open_on_host); refused with why when it cannot be.",
    params: { session_id: "string", app: "string", profile: "string" },
    required: ["session_id", "app"],
    async handle(params, { gateway }) {
      try {
        await (gateway.openers ?? defaultOpeners()).open(String(params.app), threadFolder(gateway, params.session_id));
      } catch (error) {
        if (error instanceof OpenError) throw invalidParams(error.message);
        throw error;
      }
      return { ok: true };
    },
  },

  "thread.search": {
    summary:
      "Finds words in the user's messages and the agent's replies of every thread the bridge lists, every agent's, without loading them: the threads with hits, newest first, each with its newest hits as snippets with the matches marked, and a cursor for more (feature thread_search). Case and accents are ignored, a word matches where a word of the text begins, a quoted phrase is matched as it stands, and a message must hold every word; a hit from before a compaction the thread no longer shows is marked. With linked, the Macs this one is linked to are searched too (feature fleet).",
    params: { query: "string", limit: "integer", hits: "integer", cursor: "string", agent: "string", folder: "string", linked: "boolean" },
    required: ["query"],
    async handle(params, { gateway, caller, hungUp }) {
      const given: SearchParams = {
        query: params.query as string,
        limit: params.limit as number | undefined,
        hits: params.hits as number | undefined,
        cursor: (params.cursor as string | undefined) || undefined,
        agent: (params.agent as string | undefined) || undefined,
        folder: (params.folder as string | undefined) || undefined,
      };
      try {
        if (params.linked !== true) return await gateway.search.search(given, caller, hungUp);
        // The linked Macs' answers are waited for under the claim: a newer search stops them too.
        checkSearch({ query: given.query });
        checkLinkedCursor(given);
        const claim = gateway.search.claim(caller, hungUp);
        try {
          return await searchLinked(given, (page) => gateway.search.searchUnder(page, claim.signal), gateway.fleet, claim.signal);
        } finally {
          claim.done();
        }
      } catch (error) {
        if (error instanceof EmptyQuery || error instanceof BadCursor) throw invalidParams(error.message);
        throw error;
      }
    },
  },

  "files.search": {
    summary:
      "The files and folders of a thread's folder (session_id; the thread need not be followed) or of a folder new threads may start in (folder: General, one on the list, or a git worktree of one), ranked against a fuzzy query as an editor's quick-open does, for an @-mention (feature file_search): git's files where the folder is in a repository (tracked, and untracked ones not ignored), else a walk that skips node_modules, .git, DerivedData and the like. Each hit: path (relative, with /), name, kind (file or folder), score and the ranges of path the query matched ([start, end) in UTF-16 code units). An empty query lists the shallowest entries. At most limit hits (50; 200 at most). A file hit has its size in bytes; mention_limit, for an agent that reads a mentioned file in itself (Claude Code: the thread's, or with folder the profile's), says how large a file it reads in.",
    params: { session_id: "string", folder: "string", query: "string", limit: "integer", profile: "string" },
    async handle(params, { gateway }) {
      const limit = Math.max(1, Math.min(searchLimitMax, (params.limit as number | undefined) ?? defaultSearchLimit));
      const query = ((params.query as string | undefined) ?? "").slice(0, 200);
      let folder: string | undefined;
      // How large a mentioned file the agent reads in, for one that reads mentions itself
      // (Claude Code): the thread's agent, or the one a new thread will run (`profile`).
      let mentionLimit: MentionLimit | undefined;
      if (typeof params.session_id === "string" && params.session_id !== "") {
        const record = gateway.sessions.record(params.session_id);
        if (!record) throw new RpcError(ErrorCode.notFound, `This thread is not on this ${machineWord()}.`);
        mentionLimit = gateway.providers.get(record.agent)?.mentionLimit?.(record.cwd);
        folder = await ownFolder(record.cwd);
        if (folder === undefined) throw invalidParams("This thread has no folder of its own to search.");
      } else if (typeof params.folder === "string" && params.folder !== "") {
        const asked = params.folder;
        try {
          folder = await gateway.fileSearch.checkedFolder(asked, async () => {
            // Its real path: the search keeps nothing listed where that is not the folder any more.
            const real = await ownFolder(await gateway.folders.resolve(asked));
            if (real === undefined) throw new FolderRefused("The home folder is not searched for files.");
            return real;
          });
        } catch (error) {
          if (error instanceof FolderRefused) throw invalidParams(error.message);
          throw error;
        }
        // The new thread will run in that folder, with its settings.
        if (typeof params.profile === "string") mentionLimit = gateway.providers.get(params.profile)?.mentionLimit?.(folder);
      } else {
        throw invalidParams("Name a thread (session_id) or a folder.");
      }
      const answer = await withSizes(await gateway.fileSearch.search(folder, query, limit));
      return mentionLimit ? { ...answer, mention_limit: mentionLimit } : answer;
    },
  },

  "image.attach_bytes": {
    summary: "Queues an image for the next message.",
    params: { session_id: "string", content_base64: "string", filename: "string", profile: "string" },
    required: ["session_id", "content_base64"],
    handle(params, context) {
      const session = writable(followed(context, params.session_id));
      // Only a name to show: no path from the phone is ever used as one.
      const filename = basename((params.filename as string | undefined) ?? "image.jpg").replace(/[^A-Za-z0-9._-]/g, "_");
      if (!imageTypes.has(extname(filename).toLowerCase())) {
        return { attached: false, message: "Only JPEG, PNG, GIF, WebP and HEIC images can be attached." };
      }
      const data = Buffer.from(params.content_base64 as string, "base64");
      if (data.length === 0) return { attached: false, message: "The image was empty." };
      if (data.length > imageLimit) return { attached: false, message: "The image is larger than 20 MB." };
      session.attachImage({ filename, data }, context.caller);
      return { attached: true, name: filename };
    },
  },

  "session.interrupt": {
    summary:
      "Stops the running turn, and the subagents and workflows running in the background unless keep_background (feature subagents: the app stops each by itself).",
    params: { session_id: "string", profile: "string", keep_background: "boolean" },
    required: ["session_id"],
    async handle(params, context) {
      const session = followed(context, params.session_id);
      return { status: (await session.interrupt(params.keep_background === true)) ? "interrupted" : "not_interrupted" };
    },
  },

  "session.set_mode": {
    summary: "Changes how much a thread asks before acting, as /mode does (feature modes).",
    params: { session_id: "string", mode: "string", profile: "string" },
    required: ["session_id", "mode"],
    async handle(params, context) {
      const session = writable(followed(context, params.session_id));
      if (!isThreadMode(params.mode)) throw invalidParams(`mode must be one of: ${threadModes.join(", ")}.`);
      if (!session.mode()) throw invalidParams("This agent has no modes.");
      await session.setMode(params.mode);
      const state = session.mode();
      return modeFields(state);
    },
  },

  "sessions.activity": {
    summary: "The bridge's threads that are running or waiting on an answer now, followed here or not (feature activity), the id and revision of its list of threads (feature thread_sync), of its agents' looks (feature agent_looks) and of the sidebar's order (feature sidebar_order), `latest`, a later portals-host that is out, only when there is one (feature update_notice), and `disk`, the free space on the bridge's disk (feature disk_space).",
    params: {},
    handle(_params, { gateway }) {
      // `thread_list`, `looks`, `order`, `latest` and `disk` go to every client: an app without the feature never reads them.
      const latest = gateway.updates?.latest;
      return { sessions: gateway.sessions.activity(), thread_list: gateway.sessions.list(), looks: gateway.looks.revision(), order: gateway.order.revision(), ...(latest ? { latest } : {}), ...diskFields(gateway.disk?.now) };
    },
  },

  "session.rename": {
    summary: "Gives a thread a title of the user's, which the agent keeps as its own name for it (feature rename).",
    params: { session_id: "string", title: "string", profile: "string" },
    required: ["session_id", "title"],
    async handle(params, { gateway }) {
      // Any of the bridge's threads, followed here or not: the app renames from its list.
      const record = gateway.sessions.record(params.session_id as string);
      if (record?.ongoing) throw invalidParams(`${record.title ?? record.agent}'s conversation keeps its name.`);
      let session: Session;
      try {
        session = writable(present(gateway, await gateway.sessions.load(params.session_id as string)));
      } catch (error) {
        if (error instanceof UnknownThreadError) throw new RpcError(ErrorCode.notFound, error.message);
        throw error;
      }
      const title = (params.title as string).trim().replace(/\s+/g, " ");
      if (title === "") throw invalidParams("A title cannot be empty.");
      if (title.length > 200) throw invalidParams("A title can be at most 200 characters.");
      await session.rename(title);
      return {};
    },
  },

  "model.options": {
    summary: "The models an agent can use, its default, the thinking levels each model takes (model_levels) and what to call each (model_names).",
    params: { profile: "string" },
    async handle(params, { gateway }) {
      const catalog = await provider(gateway, params.profile).models();
      const result: Record<string, unknown> = {
        providers: catalog.providers.map((entry) => ({ slug: entry.slug, name: entry.name, models: entry.models, authenticated: true })),
        model: catalog.model,
        provider: catalog.provider,
      };
      // Features `model_levels` and `model_names`. Hermes sends no such keys; the app reads them only from a host that lists the feature.
      if (catalog.levels) result.model_levels = catalog.levels;
      if (catalog.names) result.model_names = catalog.names;
      if (catalog.defaultLevels) result.model_default_levels = catalog.defaultLevels;
      // Feature modes: the agent's threads take a mode, and what its own settings come to.
      const agent = provider(gateway, params.profile);
      if (agent.supportsModes) {
        const fallback = agent.defaultMode?.() ?? null;
        result.modes = fallback ? { default: fallback } : {};
        if (providerModeOptions(agent)) result.mode_options = providerModeOptions(agent);
      }
      return result;
    },
  },

  "folders.list": {
    summary: "The folders a new thread can run in: General, then the ones the agents worked in lately (feature folders).",
    params: { profile: "string", machine: "string" },
    async handle(params, { gateway }) {
      // Feature fleet: the folders of a linked Mac, as it lists them.
      if (typeof params.machine === "string" && params.machine !== "") return gateway.fleet.foldersOn(params.machine, params.profile);
      // The same for every agent: a folder one of them worked in suits the others too.
      provider(gateway, params.profile);
      return gateway.folders.list();
    },
  },

  "folders.search": {
    summary:
      "Every folder under the home folder a new thread could start in (once folders.add takes it), ranked against a fuzzy query, git repositories and the folders folders.list lists first; or, for a query with a / or starting with ~, a path completed a level at a time as in a terminal, each part fuzzy, a trailing / listing what the folder holds (feature folder_search). Each hit: path (real), name, relative (under home), the ranges of relative the query matched, score, and git, last_used, added, repo where they apply. With machine, the folders of a linked Mac (feature fleet). At most limit hits (30; 100 at most).",
    params: { query: "string", limit: "integer", machine: "string", profile: "string" },
    async handle(params, { gateway, caller }) {
      const limit = Math.max(1, Math.min(folderLimitMax, (params.limit as number | undefined) ?? defaultFolderLimit));
      const query = ((params.query as string | undefined) ?? "").slice(0, 200);
      // Feature fleet: a linked Mac's folders, as it ranks them.
      if (typeof params.machine === "string" && params.machine !== "") return gateway.fleet.searchFoldersOn(params.machine, { query, limit, profile: params.profile });
      if (typeof params.profile === "string" && params.profile !== "") provider(gateway, params.profile);
      return gateway.folderSearch.search(query, limit, caller);
    },
  },

  "folders.add": {
    summary: "Puts a folder the user chose on this Mac on the list for new threads, and answers with it as listed (feature folders_add).",
    params: { path: "string" },
    required: ["path"],
    handle(params, { gateway }) {
      try {
        return gateway.folders.add(String(params.path));
      } catch (error) {
        if (error instanceof FolderRefused) throw invalidParams(error.message);
        throw error;
      }
    },
  },

  "folders.remove": {
    summary: "Takes a folder the user added off the list again; one that was never added is left as it is (feature folders_add).",
    params: { path: "string" },
    required: ["path"],
    handle(params, { gateway }) {
      gateway.folders.remove(String(params.path));
      return {};
    },
  },

  "desk.list": {
    summary: "Sessions started in a terminal at the desk that are not threads here yet, and the agent's threads taken off the list (feature thread_sync), newest first (feature desk_sessions).",
    params: { profile: "string", limit: "integer" },
    async handle(params, { gateway }) {
      const agent = provider(gateway, params.profile);
      const limit = (params.limit as number | undefined) ?? defaultDeskLimit;
      if (limit < 1) throw invalidParams("limit must be at least 1.");
      try {
        return { sessions: await gateway.desk.list(agent, limit) };
      } catch (error) {
        throw new RpcError(ErrorCode.internal, (error as Error).message);
      }
    },
  },

  "session.files.preview": {
    summary: "Previews native tracked files restored to before the latest completed turn, with a single-use confirmation lasting one minute (feature turn_file_undo). Conversation is retained.",
    params: { session_id: "string", checkpoint_id: "string" },
    required: ["session_id", "checkpoint_id"],
    async handle(params, context) {
      const source = writable(followed(context, params.session_id));
      try {
        return await context.gateway.sessions.previewFileUndo(source, context.caller, params.checkpoint_id as string);
      } catch (error) {
        if (error instanceof DeskRefused || error instanceof FileUndoRefused) throw invalidParams(error.message);
        throw error;
      }
    },
  },

  "session.files.undo": {
    summary: "Restores the reviewed native file checkpoint only with confirmed:true and its same-connection unexpired preview. Rechecks files and the native preview before changing anything; reports incomplete restoration honestly (feature turn_file_undo).",
    params: { session_id: "string", preview_id: "string", confirmed: "boolean" },
    required: ["session_id", "preview_id", "confirmed"],
    async handle(params, context) {
      const source = writable(followed(context, params.session_id));
      if (params.confirmed !== true) throw invalidParams("Confirm the listed file changes before restoring them.");
      try {
        return await context.gateway.sessions.undoFiles(source, context.caller, params.preview_id as string, context.afterReply);
      } catch (error) {
        if (error instanceof FileUndoRefused && error.reason === "files_changed") throw new RpcError(ErrorCode.invalidParams, error.message, { reason: error.reason });
        if (error instanceof DeskRefused || error instanceof FileUndoRefused) throw invalidParams(error.message);
        throw error;
      }
    },
  },

  "session.fork": {
    summary: "Creates and follows a new thread through a completed turn, or before it for editing (feature message_fork). Uses the same folder and current files; leaves the source conversation unchanged.",
    params: { session_id: "string", checkpoint_id: "string", before: "boolean" },
    required: ["session_id", "checkpoint_id", "before"],
    async handle(params, context) {
      const source = writable(followed(context, params.session_id));
      let session: Session;
      try {
        session = await context.gateway.sessions.fork(source, params.checkpoint_id as string, params.before as boolean);
      } catch (error) {
        if (error instanceof DeskRefused) throw invalidParams(error.message);
        throw error;
      }
      return new Atomic(() => {
        const now = present(context.gateway, session);
        now.follow(context.caller);
        return { session_id: now.id, stored_session_id: now.id, info: now.info() };
      });
    },
  },

  "session.adopt": {
    summary: "Makes a session from desk.list a thread and follows it on this connection: continued, forked or only read (feature desk_sessions); a thread taken off the list goes back on it.",
    params: { profile: "string", session_id: "string", mode: "string" },
    required: ["session_id", "mode"],
    async handle(params, { caller, gateway }) {
      const agent = provider(gateway, params.profile);
      if (!isAdoptMode(params.mode)) throw invalidParams(`mode must be one of: ${adoptModes.join(", ")}.`);
      let session: Session;
      try {
        session = await gateway.sessions.adopt({ agent: agent.profile.name, id: params.session_id as string, mode: params.mode, allows: (path) => gateway.desk.allows(path) });
      } catch (error) {
        if (error instanceof DeskRefused) throw invalidParams(error.message);
        throw error;
      }
      return new Atomic(() => {
        const now = present(gateway, session);
        now.follow(caller);
        return { session_id: now.id, stored_session_id: now.id, info: now.info() };
      });
    },
  },

  "config.get": {
    summary: "An agent's default thinking level (key reasoning).",
    params: { key: "string", profile: "string" },
    required: ["key"],
    async handle(params, { gateway }) {
      if (params.key !== "reasoning") throw invalidParams(`The bridge has no setting called ${String(params.key)}.`);
      return { value: (await provider(gateway, params.profile).models()).reasoning };
    },
  },

  "config.set": {
    summary: "Changes one thread's model or thinking level.",
    params: { key: "string", value: "string", session_id: "string", profile: "string", confirm_expensive_model: "boolean" },
    required: ["key", "value", "session_id"],
    async handle(params, context) {
      const session = writable(followed(context, params.session_id));
      const value = params.value as string;
      switch (params.key) {
        case "model": {
          // A setting from here, the agent's models read first too: the thread is not loaded
          // again meanwhile, which would answer it as made and lose it (Codex's re-check of 112091df).
          const result = await session.setting(async () => {
            const agent = provider(context.gateway, session.record.agent);
            const wanted = parseModelValue(value);
            const chosen = chooseModel(agent, await agent.models(), wanted.model, wanted.provider);
            return session.setModel(chosen.model, chosen.provider);
          });
          return result.deferred ? { deferred: true } : {};
        }
        case "reasoning":
          checkLevel(value);
          await session.setReasoning(value);
          return {};
        default:
          throw invalidParams(`The bridge has no setting called ${String(params.key)}.`);
      }
    },
  },

  "session.set_spec_model": {
    summary: "Kept for older apps, which offered a Spec model while session info had spec_model (no longer sent): changes nothing, since Droid's Spec mode plans with the thread's own model and thinking level. Answers that it follows them.",
    params: { session_id: "string", model: "string", provider: "string", reasoning_effort: "string" },
    required: ["session_id", "model"],
    handle(params, context) {
      writable(followed(context, params.session_id));
      return { spec_model: "default", spec_reasoning_effort: "", deferred: false };
    },
  },

  "commands.catalog": {
    summary: "The slash commands offered: the bridge's own and the agent's. Optional session_id scopes project commands to a followed thread; without it, Droid lists personal commands only.",
    params: { profile: "string", session_id: "string" },
    handle(params, context) {
      const session = typeof params.session_id === "string" ? followed(context, params.session_id) : undefined;
      if (session && typeof params.profile === "string" && params.profile !== session.record.agent) throw invalidParams("This thread belongs to a different agent profile.");
      return commands.catalog(provider(context.gateway, session?.record.agent ?? params.profile), session);
    },
  },

  "slash.exec": {
    summary: "Runs one of the bridge's own commands (/status, /mode); 4018 for anything else.",
    params: { session_id: "string", command: "string", profile: "string" },
    required: ["session_id", "command"],
    handle(params, context) {
      const session = followed(context, params.session_id);
      return commands.exec(session, provider(context.gateway, session.record.agent), params.command as string);
    },
  },

  "command.dispatch": {
    summary: "What a command that slash.exec does not run stands for: an agent's own command is sent as a message.",
    params: { name: "string", arg: "string", session_id: "string", profile: "string" },
    required: ["name", "session_id"],
    handle(params, context) {
      const session = followed(context, params.session_id);
      return commands.dispatch(session, provider(context.gateway, session.record.agent), params.name as string, (params.arg as string | undefined) ?? "");
    },
  },

  "mcp.auth": {
    summary: "Lists live MCP sign-in cards, starts sign-in, submits a code or cancels it. Authentication data is never conversation history.",
    params: { session_id: "string", profile: "string", action: "string", server_name: "string", auth_id: "string", code: "string" },
    required: ["session_id", "action"],
    async handle(params, context) {
      const session = followed(context, params.session_id);
      const action = params.action;
      if (action !== "list" && action !== "start" && action !== "submit" && action !== "cancel") throw invalidParams("Choose a valid MCP sign-in action.");
      if (action !== "list") {
        writable(session);
        if (typeof params.server_name !== "string" || !params.server_name) throw invalidParams("Choose an MCP server.");
      }
      if ((action === "submit" || action === "cancel") && (typeof params.auth_id !== "string" || !params.auth_id)) throw invalidParams("Choose a current sign-in attempt.");
      if (action === "submit" && typeof params.code !== "string") throw invalidParams("Paste a sign-in code or redirect URL.");
      try {
        return await session.mcpAuth({ action, server_name: params.server_name, auth_id: params.auth_id, code: params.code } as McpAuthAction);
      } catch (error) {
        if (error instanceof McpAuthSettling) throw new RpcError(ErrorCode.invalidParams, error.message, { reason: "settling" });
        if (error instanceof SettingRefused) throw invalidParams(error.message);
        // Raw SDK errors can contain OAuth URLs, codes or state. Do not log or send them.
        throw new RpcError(ErrorCode.internal, "MCP sign-in did not finish. Refresh the card and try again.");
      }
    },
  },

  "subagent.list": {
    summary: "The subagents and workflows a thread's agent started, running or ended, oldest first (the bridge's keys with feature subagents).",
    params: { session_id: "string", profile: "string" },
    handle(params, context) {
      const session = typeof params.session_id === "string" ? context.gateway.sessions.get(params.session_id) : undefined;
      return { subagents: session?.subagentList() ?? [] };
    },
  },

  "subagent.stop": {
    summary: "Stops one subagent or workflow, leaving the turn and the others running; status stopped, or not_running (feature subagents).",
    params: { session_id: "string", subagent_id: "string", profile: "string" },
    required: ["session_id", "subagent_id"],
    async handle(params, context) {
      const session = followed(context, params.session_id);
      return { status: (await session.stopSubagent(params.subagent_id as string)) ? "stopped" : "not_running" };
    },
  },

  "subagent.read": {
    summary:
      "What one subagent did, read only (feature subagent_read): available false for one that cannot be read (a workflow, a command, an agent that keeps none, a thread not loaded); else its own messages, oldest first, in the shape of session.resume's, so far for one still at work.",
    params: { session_id: "string", subagent_id: "string", profile: "string" },
    required: ["session_id", "subagent_id"],
    async handle(params, context) {
      const session = context.gateway.sessions.get(params.session_id as string);
      let messages: StoredMessage[] | null;
      try {
        messages = (await session?.subagentMessages(params.subagent_id as string)) ?? null;
      } catch (error) {
        throw new RpcError(ErrorCode.internal, `What this agent did could not be read: ${(error as Error).message}`);
      }
      return messages ? { available: true, messages } : { available: false };
    },
  },

  // Feature fleet: the threads as a whole. None of these needs the connection to
  // follow the thread, and none makes it follow one.

  "threads.list": {
    summary: "Every thread the bridge knows and what it is doing now, newest first, with those of the Macs it is linked to unless local (feature fleet).",
    params: { state: "string", profile: "string", local: "boolean" },
    handle(params, { gateway }) {
      const state = params.state ?? undefined;
      if (state !== undefined && !isThreadState(state)) throw invalidParams(`state must be one of: ${threadStates.join(", ")}.`);
      const only = { state, agent: (params.profile as string | undefined) || undefined };
      return params.local === true ? { threads: gateway.fleet.threads(only) } : gateway.fleet.everyThread(only);
    },
  },

  "threads.delta": {
    summary: "Opt-in local-only bridge-to-bridge fleet changes with absolute registry positions, removals, complete live-state overlay and order digest since an epoch/list/revision cursor; full after a restart or invalid cursor, with positions implied by array order (features fleet_delta, fleet_delta_positions).",
    params: { epoch: "string", list: "string", since: "integer" },
    handle(params, { gateway }) {
      return gateway.fleet.delta((params.epoch ?? undefined) as string | undefined, (params.list ?? undefined) as string | undefined, (params.since ?? undefined) as number | undefined);
    },
  },

  "threads.page": {
    summary: "Opt-in local-only frozen fleet snapshot page, bounded to 32 KiB, with absolute positions and no historical active overlay; a fresh delta must seal the complete base (feature fleet_pages).",
    params: { snapshot: "string", offset: "integer", epoch: "string", list: "string", since: "integer" },
    handle(params, { gateway }) {
      return gateway.fleet.page({
        snapshot: (params.snapshot ?? undefined) as string | undefined, offset: (params.offset ?? undefined) as number | undefined,
        epoch: (params.epoch ?? undefined) as string | undefined, list: (params.list ?? undefined) as string | undefined, since: (params.since ?? undefined) as number | undefined,
      });
    },
  },

  "machines.list": {
    summary: "The Macs this bridge is linked to, and the agents of those that answer (feature fleet).",
    params: {},
    async handle(_params, { gateway }) {
      return { machines: await gateway.fleet.machines() };
    },
  },

  "thread.read": {
    summary: "A thread's last turns, the reply in progress and its open questions (feature fleet).",
    params: { thread: "string", last: "integer" },
    required: ["thread"],
    handle(params, { gateway }) {
      const last = (params.last as number | undefined) ?? 1;
      if (last < 1) throw invalidParams("last must be at least 1.");
      return gateway.fleet.read(params.thread as string, last);
    },
  },

  "thread.send": {
    summary: "Sends a message into a thread, marked as not the user's; with wait, answers once the thread is at rest or blocked (feature fleet).",
    params: { thread: "string", text: "string", from: "string", sender: "string", origin: "string", sent_by: "object", wait: "boolean", timeout_ms: "integer", notice: "string" },
    required: ["thread", "text"],
    async handle(given, { gateway, hungUp }) {
      const params = asSent(given, gateway.fleet);
      if (params.wait === true) return gateway.fleet.sendAndWait(params.thread as string, params.text as string, waitTime(params), hungUp, sentBy(params));
      // A starter's notice from another Mac's bridge, by its id: taken once however often it comes.
      const notice = typeof params.notice === "string" && params.notice !== "" && params.notice.length <= 100 ? params.notice : undefined;
      return gateway.fleet.send(params.thread as string, params.text as string, sentBy(params), notice);
    },
  },

  "thread.report": {
    summary: "Tells the thread that started the thread from as that one's report of the work it is doing; no notice of that rest follows (feature fleet).",
    params: { text: "string", from: "string" },
    required: ["text", "from"],
    async handle(given, { gateway }) {
      const params = asSent(given, gateway.fleet);
      return gateway.fleet.report(params.text as string, sentBy(params));
    },
  },

  "thread.wait": {
    summary: "Answers once a thread is at rest or blocked, with its last reply, or when the time is up; from is the thread waiting, when one is (feature fleet).",
    params: { thread: "string", timeout_ms: "integer", from: "string", sender: "string", origin: "string", sent_by: "object" },
    required: ["thread"],
    handle(given, { gateway, hungUp }) {
      const params = asSent(given, gateway.fleet);
      return gateway.fleet.wait(params.thread as string, waitTime(params), hungUp, sentBy(params));
    },
  },

  "thread.start": {
    summary: "Starts a thread, with a first message when given one; with wait, answers once it is at rest or blocked (feature fleet).",
    params: {
      profile: "string",
      cwd: "string",
      title: "string",
      model: "string",
      provider: "string",
      reasoning_effort: "string",
      text: "string",
      from: "string",
      sender: "string",
      origin: "string",
      sent_by: "object",
      machine: "string",
      wait: "boolean",
      timeout_ms: "integer",
    },
    async handle(given, { gateway, hungUp }) {
      const params = asSent(given, gateway.fleet);
      if (typeof params.machine === "string" && params.machine !== "") return gateway.fleet.startOn(params.machine, params, hungUp);
      const session = await gateway.fleet.start(params, sentBy(params));
      // Whether the thread that starts it will be told of its rests and questions (feature tell_starters).
      const tells = { tells_starter: gateway.fleet.tellsStarterOf(session.record) };
      const text = (params.text as string | undefined) ?? "";
      if (text.trim() === "") return { thread: gateway.fleet.summary(session.record), ...tells };
      // With wait, as `thread.send` with wait: the wait is there before the message goes.
      const sent = params.wait === true
        ? await gateway.fleet.sendAndWait(session.id, text, waitTime(params), hungUp, sentBy(params))
        : await gateway.fleet.send(session.id, text, sentBy(params));
      return { thread: gateway.fleet.summary(session.record), ...tells, ...sent };
    },
  },

  "thread.stop": {
    summary: "Stops a thread's running turn (feature fleet).",
    params: { thread: "string" },
    required: ["thread"],
    async handle(params, { gateway }) {
      return { stopped: await gateway.fleet.stop(params.thread as string) };
    },
  },

  // Feature agent_threads: a thread started through the fleet is answered by the thread
  // that started it, as a device answers (docs/gateway-protocol.md, section 11).

  "thread.answer": {
    summary: "Answers a question or an approval open in a thread, for the thread that started it: an approval once, for the session or no, never always, and an allow only from a thread that has the access it gives (feature agent_threads).",
    params: {
      thread: "string",
      request: "string",
      choice: "string",
      note: "string",
      answers: "object",
      from: "string",
      sender: "string",
      origin: "string",
      sent_by: "object",
      caller_mode: "string",
    },
    required: ["thread", "request"],
    async handle(given, { gateway }) {
      const params = asSent(given, gateway.fleet);
      const value = <T>(key: string) => (params[key] ?? undefined) as T | undefined;
      const answer = { choice: value<string>("choice"), note: value<string>("note"), answers: value<Record<string, unknown>>("answers") };
      return gateway.fleet.answer(params.thread as string, params.request as string, answer, { ...sentBy(params), callerMode: value<string>("caller_mode") });
    },
  },

  // Feature thread_sync: the bridge's own threads as the list every device shows, with
  // their pins, archive and unseen marks (docs/sync-plan.md). A `machine/thread` id is
  // a thread they do not know.

  "threads.changes": {
    summary: "The bridge's own threads changed since a revision of its list, with their marks, or every one when the list or revision is not one it can answer from (feature thread_sync).",
    params: { list: "string", since: "integer" },
    handle(params, { gateway }) {
      return gateway.fleet.changes((params.list ?? undefined) as string | undefined, (params.since ?? undefined) as number | undefined);
    },
  },

  "thread.mark": {
    summary: "Pins, archives, marks one of the bridge's threads unseen or seen, puts it in Recent or takes it out, or shares a thread an agent started, for every device, or gives it a preview it has none of; answers with the thread as listed (feature thread_sync; shared, agent_threads; recent, recent_threads).",
    params: { thread: "string", pinned: "boolean", archived: "boolean", unseen: "boolean", shared: "boolean", recent: "boolean", revision: "integer", list: "string", turn: "integer", preview: "string" },
    required: ["thread"],
    handle(params, { gateway }) {
      // A key sent as null is not given, as checkParams reads it.
      const value = <T>(key: string) => (params[key] ?? undefined) as T | undefined;
      const marks = {
        pinned: value<boolean>("pinned"),
        archived: value<boolean>("archived"),
        unseen: value<boolean>("unseen"),
        shared: value<boolean>("shared"),
        recent: value<boolean>("recent"),
        revision: value<number>("revision"),
        list: value<string>("list"),
        turn: value<number>("turn"),
        preview: value<string>("preview"),
      };
      if (marks.pinned === undefined && marks.archived === undefined && marks.unseen === undefined && marks.shared === undefined && marks.recent === undefined && marks.preview === undefined) {
        throw invalidParams("Say what to mark: pinned, archived, unseen, shared, recent or preview.");
      }
      return { thread: gateway.fleet.mark(params.thread as string, marks) };
    },
  },

  "thread.delete": {
    summary: "Takes one of the bridge's threads off the list every device shows, keeping the agent's session to take up again from the desk; refused for a thread at work (feature thread_sync).",
    params: { thread: "string" },
    required: ["thread"],
    async handle(params, { gateway }) {
      await gateway.fleet.remove(params.thread as string);
      return {};
    },
  },

  // Feature agent_looks: how each of the bridge's agents looks, kept here so that every
  // device draws it the same (src/looks.ts).

  "looks.list": {
    summary: "How the bridge's agents look on every device, those that were given a look, with the id and revision of that list (feature agent_looks).",
    params: {},
    handle(_params, { gateway }) {
      return { list: gateway.looks.revision(), looks: gateway.looks.all() };
    },
  },

  "look.set": {
    summary: "Gives one of the bridge's agents a look for every device, unless it has one the call says to leave; answers with the look the agent has now (feature agent_looks).",
    params: { profile: "string", shape: "integer", face: "integer", tint: "integer", shows_logo: "boolean", origin: "string", unless: "string" },
    required: ["profile", "shape", "face", "tint"],
    handle(params, { gateway }) {
      const agent = provider(gateway, params.profile).profile.name;
      for (const key of ["shape", "face", "tint"]) {
        if (!isLookIndex(params[key])) throw invalidParams(`${key} must be a whole number from 0 to ${highestLookIndex}.`);
      }
      // A key sent as null is not given, as checkParams reads it.
      const origin = params.origin ?? "chosen";
      if (!isLookOrigin(origin)) throw invalidParams(`origin must be one of: ${lookOrigins.join(", ")}.`);
      const unless = params.unless ?? undefined;
      if (unless !== undefined && !isLookCondition(unless)) throw invalidParams(`unless must be one of: ${lookConditions.join(", ")}.`);
      const look: Look = { shape: params.shape as number, face: params.face as number, tint: params.tint as number, origin };
      if (typeof params.shows_logo === "boolean") look.showsLogo = params.shows_logo;
      const now = gateway.looks.set(agent, look, unless);
      // The revision after the change: a device that holds it need not ask again.
      return { list: gateway.looks.revision(), look: now.look, taken: now.taken };
    },
  },

  // Feature sidebar_order: the order the user gave the bridge's agents and folders in
  // the sidebar, kept here so that every device lists them the same (src/order.ts).

  "order.list": {
    summary: "The order the user gave the bridge's agents and folders in the sidebar, and their Macs (feature machine_order), with its id and revision (feature sidebar_order).",
    params: {},
    handle(_params, { gateway }) {
      return { list: gateway.order.revision(), ...listedOrder(gateway.order.get()) };
    },
  },

  "order.set": {
    summary: "Puts the bridge's agents or its folders in an order for every device, each list whole, or the user's Macs with the moment they were arranged (feature machine_order), kept unless the bridge has an order arranged later; answers with the lists as they are now (feature sidebar_order).",
    params: { agents: "strings", folders: "strings", machines: "strings", machines_at: "integer" },
    handle(params, { gateway }) {
      const change: OrderChange = {};
      const names = (key: string): string[] | undefined => {
        // A key sent as null is not given, as checkParams reads it.
        if (params[key] === undefined || params[key] === null) return undefined;
        const list = orderNames(params[key]);
        if (!list) throw invalidParams(`${key} must be a list of at most ${longestOrder} names, none of them empty.`);
        return list;
      };
      change.agents = names("agents");
      change.folders = names("folders");
      const machines = names("machines");
      if (machines) {
        if (!isOrderMoment(params.machines_at)) throw invalidParams("machines_at must say when the Macs were arranged, in milliseconds since 1970.");
        change.machines = { ids: machines, at: params.machines_at };
      }
      if (!change.agents && !change.folders && !change.machines) throw invalidParams("Say what to put in order: agents, folders or machines.");
      const now = gateway.order.set(change);
      // The revision after the change: a device that holds it need not ask again.
      return { list: gateway.order.revision(), ...listedOrder(now) };
    },
  },

  // Feature net: the Macs and devices that reach each other after pairing once
  // (src/net/net.ts, docs/net-plan.md). Who may call each depends on how the connection
  // signed in: with the password, with a member's token, or on the `portals` command's socket.

  "net.list": {
    summary: "The net this Mac is in: its id, this Mac's id, the caller's member id, the list's revision and every member, without their tokens' hashes (feature net).",
    params: {},
    handle(_params, { caller, gateway }) {
      return gateway.net.list(caller.signedIn.kind === "member" ? caller.signedIn.id : null);
    },
  },

  "net.invite": {
    summary: "A join code for another device or Mac, one use, ten minutes, and the portals://join link that carries it (feature net).",
    params: {},
    handle(_params, { caller, gateway }) {
      // Portals on this Mac joins with its password and a code, the way in that still works.
      // Anyone else would be handed a code with this Mac's own address, which leads them nowhere.
      if (gateway.net.thisMacOnly && caller.signedIn.kind !== "password") throw new NetError(thisMacOnlyRefusal);
      return gateway.net.invite();
    },
  },

  "net.remove": {
    summary: "Takes a member out of the net, on every Mac, closing its connections; not this Mac itself (net.leave). With `net`, only while this Mac is in that net (feature net).",
    params: { member: "string", net: "string" },
    required: ["member"],
    handle(params, { caller, gateway }) {
      signedInAs(caller, ["password", "local", "device"], "Only the person, from a device or this Mac, can remove a member from the net.");
      gateway.net.remove(params.member as string, caller.signedIn.kind === "member" ? caller.signedIn.id : gateway.machine, (params.net ?? undefined) as string | undefined);
      return gateway.net.list(caller.signedIn.kind === "member" ? caller.signedIn.id : null);
    },
  },

  "net.rename": {
    summary: "Names a member of the net for every Mac and device, the latest rename winning: member its id (this Mac when not given; a device's too with feature net_rename_devices), name at most 80 characters, after the stamp of the name the caller holds for it; with `net`, only while this Mac is in that net (feature net_rename).",
    params: { member: "string", name: "string", after: "integer", net: "string" },
    required: ["name"],
    handle(params, { caller, gateway }) {
      signedInAs(caller, ["password", "local", "device"], "Only the person, from a device or this Mac, can rename a member of the net.");
      const member = typeof params.member === "string" && params.member !== "" ? params.member : gateway.machine;
      gateway.net.rename(member, params.name as string, (params.after ?? undefined) as number | undefined, (params.net ?? undefined) as string | undefined);
      return gateway.net.list(caller.signedIn.kind === "member" ? caller.signedIn.id : null);
    },
  },

  "net.join_with": {
    summary: "This Mac joins the net of a portals://join link, bringing its devices; refused while it is in a net with other Macs (feature net).",
    params: { link: "string" },
    required: ["link"],
    async handle(params, { caller, gateway }) {
      signedInAs(caller, ["password", "local"], "Only the person can move this Mac into another net.");
      return gateway.net.joinWith(params.link as string);
    },
  },

  "net.leave": {
    summary: "This Mac leaves its net and is a net of its own (feature net).",
    params: {},
    async handle(_params, { caller, gateway }) {
      signedInAs(caller, ["local"], "Only the person at this Mac can take it out of its net: run `portals net leave` there.");
      return gateway.net.leave();
    },
  },

  "threads.held": {
    summary: "Another Mac of the net says which of this bridge's threads its threads keep at work now, the whole set each time, holding a few minutes unless said again (feature held_elsewhere).",
    params: { threads: "list" },
    required: ["threads"],
    handle(params, { caller, gateway }) {
      const signedIn = caller.signedIn;
      if (signedIn.kind !== "member" || signedIn.member !== "mac" || signedIn.removed) {
        throw new RpcError(ErrorCode.notAllowed, "Only the net's Macs say which threads theirs keep at work.");
      }
      const threads = params.threads as unknown[];
      if (threads.length > 10_000 || !threads.every((thread) => typeof thread === "string" && thread.length > 0 && thread.length <= 200)) {
        throw invalidParams("threads must be a list of thread ids.");
      }
      gateway.sessions.holdElsewhere(signedIn.id, threads as string[]);
      return {};
    },
  },

  "net.sync": {
    summary: "Another Mac of the net gives its copy of the list and is answered with this one's, merged (feature net).",
    params: { net: "string", members: "list" },
    required: ["net", "members"],
    handle(params, { caller, gateway }) {
      const signedIn = caller.signedIn;
      if (signedIn.kind !== "member" || signedIn.member !== "mac") throw new RpcError(ErrorCode.notAllowed, "Only the net's Macs copy its list.");
      return gateway.net.receive(signedIn, params.net as string, params.members);
    },
  },
};

/** Refuses a call from a connection that did not sign in one of the ways `allowed` names: `device` and `mac` are members of the net. */
function signedInAs(caller: Caller, allowed: ("password" | "local" | "device" | "mac")[], what: string): void {
  const signedIn = caller.signedIn;
  const way = signedIn.kind === "member" ? signedIn.member : signedIn.kind;
  if (!allowed.includes(way)) throw new RpcError(ErrorCode.notAllowed, what);
}

/** The order as the app is given it. */
function listedOrder(order: Order): { agents: string[]; folders: string[]; machines: string[]; machines_at: number } {
  return { agents: order.agents, folders: order.folders, machines: order.machines, machines_at: order.machinesAt };
}
