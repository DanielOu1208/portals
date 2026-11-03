import { cutWhole } from "../../json.ts";
import type { EndedSubagent, SubagentInfo, SubagentStatus } from "../types.ts";
import { gatewayTool } from "./tools.ts";

// The sub-agents a Codex thread spawns, as the subagents line shows them (feature
// `subagents`). Each is a thread of its own, whose parent is the thread that spawned it.
// Codex says so in two ways, by the model's multi-agent version:
//
// - v2 (gpt-6.1-sol and most others): the parent's `subAgentActivity` items, one each
//   time a sub-agent `started`, was messaged (`interacted`), was `interrupted` or
//   `completed`, naming its thread (`agentThreadId`) and its path (`/root/pear_reply`),
//   which is all that says what it is for: its thread keeps no message of what it was
//   asked. What it answered, and the turn it runs, are in its thread (`thread/read`,
//   `described`).
// - v1: the parent's `collabAgentToolCall` items say what it asked: `spawnAgent` names
//   the new thread (`receiverThreadIds`) with its prompt and model, and every call
//   (`wait`, `closeAgent`, …) carries the last known state of the agents it names
//   (`agentsStates`: `status`, and the agent's last message). The sub-agent's own thread
//   may say what it does: its turns start and complete, its items are its tools and its
//   messages, its token use grows.
//
// Each change gives the whole of what is known of the one it changed.
//
// A call about the sub-agents other than a spawn (`wait`, `closeAgent`, `sendInput`, …)
// is a row of its own, which says who it was about by the names the line gives them
// (feature `subagent_calls`, `calledAbout`). v1's calls name them (`receiverThreadIds`,
// `agentsStates`); v2's wait names none: it is about the thread's own sub-agents at work
// when it started, and those that ended since a wait last ended, whose news it takes in,
// as the thread's own items tell it, in their order (a reconnect may read a sub-agent's
// own thread, and learn of its end, before the items of the thread it missed).

type Item = Record<string, any>;

/** How much of a reply a row carries: the app shows its start. */
const resultLength = 2000;
/** A goal is the prompt's first line, at most this long. */
const goalLength = 160;

interface Known extends SubagentInfo {
  /** Its running turn, by which it is stopped. */
  turn?: string;
  /** Its last completed turn: a delayed read or duplicate start must not revive it. */
  endedTurn?: string;
  /** Its last message, which is its answer once its turn has completed. */
  said?: string;
  /** Live changes since a read began: an older snapshot must not undo newer news. */
  revision: number;
}

export class CodexAgents {
  private readonly now: () => number;
  private readonly known = new Map<string, Known>();
  /** While a stored thread is read (`remember`): when the turn being read happened. */
  private moment: number | null = null;
  /**
   * The thread's own sub-agents as the thread's own items tell of them: set to work and
   * not heard to end (`out`), and heard to end since a wait last ended (`unwaited`), which
   * the next wait is about too.
   */
  private readonly out = new Set<string>();
  private readonly unwaited = new Set<string>();
  /** The thread's own `subAgentActivity` items taken in for `out` and `unwaited`: told again, they change nothing. */
  private readonly heard = new Set<string>();
  /** Who each of the thread's own calls about its sub-agents was about, by the call's item id. */
  private readonly calls = new Map<string, string[]>();
  /** The calls whose end has been taken in: told again (a reconnect, a read), they change nothing. */
  private readonly settled = new Set<string>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private time(): number {
    return this.moment ?? this.now();
  }

  /**
   * The sub-agents a stored thread's turns tell of, as its items do live, each with the
   * turn that started it: 0 for the thread's last turn, -1 for the one before it, and so
   * on. They are known from then on: one that may still be at work can be stopped, and
   * news of it is taken in.
   */
  remember(turns: readonly Item[]): { subagent: SubagentInfo; turn: number }[] {
    const started = new Map<string, number>();
    turns.forEach((turn, index) => {
      const begun = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : null;
      const over = typeof turn.completedAt === "number" ? turn.completedAt * 1000 : begun;
      for (const item of Array.isArray(turn.items) ? (turn.items as Item[]) : []) {
        this.moment = item.type === "subAgentActivity" && (item.kind === "started" || item.kind === "interacted") ? begun : over;
        for (const subagent of this.item(item)) if (!started.has(subagent.id)) started.set(subagent.id, index - (turns.length - 1));
      }
    });
    this.moment = null;
    return [...started].map(([id, turn]) => ({ subagent: publish(this.known.get(id)!), turn }));
  }

  /**
   * The sub-agents a sub-agent's thread, just read (`thread/read` with its turns), tells
   * of in its items and that are not known yet: its own, spawned while the bridge did not
   * hear its items (before a restart, or while the connection was down), each set in
   * under it. Items about those already known are left alone: an older item must not undo
   * newer news of them.
   */
  nestedIn(parent: string, read: Item): SubagentInfo[] {
    const before = new Set(this.known.keys());
    const unknown = (id: unknown) => typeof id === "string" && id !== parent && !before.has(id);
    const found = new Set<string>();
    for (const turn of Array.isArray(read.turns) ? (read.turns as Item[]) : []) {
      const begun = typeof turn.startedAt === "number" ? turn.startedAt * 1000 : null;
      const over = typeof turn.completedAt === "number" ? turn.completedAt * 1000 : begun;
      for (const item of Array.isArray(turn.items) ? (turn.items as Item[]) : []) {
        let about: Item | null = null;
        if (item.type === "subAgentActivity" && unknown(item.agentThreadId)) about = item;
        else if (item.type === "collabAgentToolCall") {
          // Only what it says of the ones not known yet.
          const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(unknown) : [];
          const states = Object.fromEntries(Object.entries(item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {}).filter(([id]) => unknown(id)));
          if (receivers.length > 0 || Object.keys(states).length > 0) about = { ...item, receiverThreadIds: receivers, agentsStates: states };
        }
        if (!about) continue;
        this.moment = item.type === "subAgentActivity" && (item.kind === "started" || item.kind === "interacted") ? begun : over;
        for (const subagent of this.item(about, parent)) found.add(subagent.id);
      }
    }
    this.moment = null;
    return [...found].map((id) => publish(this.known.get(id)!));
  }

  /** Whether `thread` is one of these sub-agents. */
  has(thread: string): boolean {
    return this.known.has(thread);
  }

  /** Whether what Codex calls `thread` is known already (from its thread's start, or a read of it). */
  hasNickname(thread: string): boolean {
    return Boolean(this.known.get(thread)?.nickname);
  }

  /** What `described` takes as `since`, before asking Codex for the thread. */
  revision(thread: string): number | undefined {
    return this.known.get(thread)?.revision;
  }

  /** The turn a sub-agent runs now, to stop it; undefined when it runs none. */
  runningTurn(thread: string): string | undefined {
    const known = this.known.get(thread);
    return known?.status === "running" ? known.turn : undefined;
  }

  /** The sub-agents that have ended, as known now, each with the run it ended in. */
  ended(): EndedSubagent[] {
    return [...this.known.values()]
      .filter((known) => known.status !== "running")
      .map((known) => {
        // The run as the line has it (`publish`).
        const run = known.turn ?? known.endedTurn;
        return run !== undefined ? { id: known.id, run } : { id: known.id };
      });
  }

  /** Whether any sub-agent is still at work. */
  get isRunning(): boolean {
    return [...this.known.values()].some((known) => known.status === "running");
  }

  /**
   * The threads to read again once the connection to Codex is back (or the thread is
   * opened): those thought to be at work, and those that ended in the last `withinMs`,
   * which may have been given more to do meanwhile. One that ended before that is left
   * as it is: reading every one a thread ever spawned, each time, costs a read apiece and
   * sends rows nothing changed in.
   */
  toSettle(withinMs: number): string[] {
    const since = this.now() - withinMs;
    return [...this.known.values()].filter((known) => known.status === "running" || (known.endedAt ?? 0) >= since).map((known) => known.id);
  }

  /**
   * The turn a sub-agent's thread, just read, says it runs: for Stop, which acts on the
   * read it asked for even when newer news keeps that read out of the row. Undefined
   * when it runs none, or only the turn already known to have ended.
   */
  turnIn(thread: string, read: Item | null): string | undefined {
    const last = Array.isArray(read?.turns) ? read.turns.at(-1) : undefined;
    if (read?.status?.type !== "active" || last?.status !== "inProgress" || typeof last.id !== "string") return undefined;
    return last.id === this.known.get(thread)?.endedTurn ? undefined : last.id;
  }

  /**
   * A thread Codex started with this one as its parent (or with one of its sub-agents as
   * its parent): a sub-agent, which the spawn's item names and describes, maybe only
   * after the thread's own first news. `started`: the thread as `thread/started` gives
   * it, with the nickname, role and path Codex gave the sub-agent.
   */
  adopt(thread: string, started?: Item): SubagentInfo | null {
    const already = this.known.get(thread);
    // Known from the spawn's item, which Codex sends first: the thread names it.
    if (already) {
      const before = JSON.stringify(publish(already));
      if (started) named(already, started);
      const after = publish(already);
      return JSON.stringify(after) === before ? null : after;
    }
    const known: Known = { id: thread, kind: "agent", goal: "", status: "running", startedAt: this.time(), background: true, stoppable: false, revision: 0 };
    if (started) named(known, started);
    // Spawned by one of this thread's sub-agents.
    const parent = started?.parentThreadId;
    if (typeof parent === "string" && parent !== thread && this.known.has(parent)) known.parent = parent;
    this.known.set(thread, known);
    return publish(known);
  }

  /**
   * A `subAgentActivity` or `collabAgentToolCall` item of the parent's: the sub-agents it
   * spawned or names, as they are now. `parent`: the sub-agent whose item it is, for the
   * sub-agents of one of these (Codex tells a thread's follower of its sub-agents' items,
   * not of their own sub-agents' threads).
   */
  item(item: Item, parent?: string): SubagentInfo[] {
    if (item.type === "subAgentActivity") return this.activity(item, parent);
    if (item.type !== "collabAgentToolCall") return [];
    // One of the thread's own told again once its end was taken in (a reconnect, a read
    // that overlaps what came live): its states are old news, and nothing changes.
    if (!parent && typeof item.id === "string" && this.settled.has(item.id)) return [];
    const changed: SubagentInfo[] = [];
    const states: Record<string, Item> = item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {};
    const receivers: string[] = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id: unknown) => typeof id === "string") : [];
    const named = new Set([...receivers, ...Object.keys(states)]);
    for (const thread of named) {
      let known = this.known.get(thread);
      if (!known) {
        // Only a spawn makes one: other calls may name agents of another thread's.
        if (item.tool !== "spawnAgent") continue;
        known = { id: thread, kind: "agent", goal: goalOf(item.prompt), status: "running", startedAt: this.time(), background: true, stoppable: false, revision: 0 };
        if (typeof item.model === "string" && item.model !== "") known.model = item.model;
        if (parent && parent !== thread) known.parent = parent;
        this.known.set(thread, known);
      } else if (item.tool === "spawnAgent" && known.goal === "") {
        // Adopted from its own thread's start, before the spawn said what it is for.
        known.goal = goalOf(item.prompt);
        if (typeof item.model === "string" && item.model !== "") known.model = item.model;
      }
      const state = states[thread];
      if (state) this.state(known, state);
      changed.push(publish(known));
    }
    if (!parent) {
      // One of the thread's own: who it set to work or heard end, then who it was about.
      for (const thread of named) {
        if (!this.known.has(thread)) continue;
        const status = states[thread]?.status;
        // Set to work by a spawn that went through, or at work by its state; a message or
        // more to do only by its state, since the call can fail.
        if ((item.tool === "spawnAgent" && item.status !== "failed") || status === "running" || status === "pendingInit") this.out.add(thread);
        else if (typeof status === "string" && this.out.delete(thread)) this.unwaited.add(thread);
      }
      this.call(item, [...named]);
    }
    return changed;
  }

  /**
   * The names the row of a call about the sub-agents gives them (`args.agents`, feature
   * `subagent_calls`), as the line calls them: by nickname, else by what each was asked
   * to do (its path, for v2). Undefined for an item that is no such call: a spawn's row
   * carries its task instead. `nicknames`: those read from their own threads, for a
   * stored thread read back, whose items do not say them.
   */
  calledAbout(item: Item, nicknames?: ReadonlyMap<string, string>): string[] | undefined {
    if (item.type !== "collabAgentToolCall" || item.tool === "spawnAgent" || typeof item.id !== "string") return undefined;
    return (this.calls.get(item.id) ?? []).map((id) => nameFor(this.known.get(id), nicknames?.get(id))).filter((name) => name !== "");
  }

  /**
   * Notes who a call of the thread's own was about: those it names (only the thread's
   * own among them), or, for a wait that names none (v2), those it waits on (`awaited`),
   * as it starts and again as it ends, with the ones that ended meanwhile. Once a wait or
   * a close has ended, those it was about are no longer waited on for having ended. Its
   * end is taken in once: told again later, it must not take in a sub-agent that ended
   * since, which the next wait is about.
   */
  private call(item: Item, named: readonly string[]): void {
    if (typeof item.id !== "string" || this.settled.has(item.id)) return;
    const about = new Set(this.calls.get(item.id) ?? []);
    if (item.tool !== "spawnAgent") {
      const inferred = named.length === 0 && item.tool === "wait";
      for (const id of inferred ? this.awaited() : named.filter((id) => this.known.has(id))) about.add(id);
      const order = [...this.known.keys()];
      this.calls.set(item.id, [...about].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
    if (item.status === "inProgress") return;
    this.settled.add(item.id);
    if (item.tool === "wait" || item.tool === "closeAgent") for (const id of about) this.unwaited.delete(id);
    if (item.tool === "closeAgent") for (const id of about) this.out.delete(id);
  }

  /**
   * The thread's own sub-agents a wait is about: those at work, as the thread's items or
   * their own threads say, and those the thread heard end since a wait last ended.
   */
  private awaited(): string[] {
    return [...this.known.values()]
      .filter((known) => !known.parent && (this.out.has(known.id) || known.status === "running" || this.unwaited.has(known.id)))
      .map((known) => known.id);
  }

  /** What a `subAgentActivity` item says of one sub-agent (v2). */
  private activity(item: Item, parent?: string): SubagentInfo[] {
    const thread = item.agentThreadId;
    if (typeof thread !== "string" || thread === "" || thread === parent) return [];
    let known = this.known.get(thread);
    if (!known) {
      // A sub-agent's item makes a row only for one it started: one it messages may be
      // the thread it works for, or another above it (`send_message` says interacted).
      if (parent && item.kind !== "started") return [];
      known = { id: thread, kind: "agent", goal: nameOf(item.agentPath), status: "running", startedAt: this.time(), background: true, stoppable: false, revision: 0 };
      if (parent) known.parent = parent;
      this.known.set(thread, known);
    }
    if (known.goal === "") known.goal = nameOf(item.agentPath);
    if (typeof item.model === "string" && item.model !== "") known.model = item.model;
    if (!parent && !(typeof item.id === "string" && this.heard.has(item.id))) {
      // As the thread's own items tell it, for its waits: set to work, or heard to end;
      // each item once, as a reconnect may tell it again.
      if (typeof item.id === "string") this.heard.add(item.id);
      if (item.kind === "started") this.out.add(thread);
      if (item.kind === "completed" || item.kind === "interrupted") {
        this.out.delete(thread);
        this.unwaited.add(thread);
      }
    }
    switch (item.kind) {
      case "started":
      case "interacted":
        // `send_message` also says interacted, without starting a turn. Only the
        // child's own turn or a current thread read can reopen a finished row.
        if (this.moment === null) known.revision += 1;
        break;
      case "interrupted":
        if (known.status === "running") this.end(known, "stopped");
        break;
      case "completed":
        if (known.status === "running") this.end(known, "completed", known.said);
        break;
    }
    return [publish(known)];
  }

  /**
   * What a sub-agent's thread holds (`thread/read` with its turns): what it answered,
   * its last message, and the turn it runs now; and what it was asked, its first
   * message, where it has one (v2's have none). Null when that changes nothing shown.
   * `since`: its revision when the read was asked for; live news received meanwhile
   * takes precedence over the read's state and answer. `final`: whether this is the last
   * look at a thread caught between two states (`betweenStates`); before it, one at rest
   * whose last turn is still in progress is left as it is, its end not written yet.
   */
  described(thread: string, read: Item, since?: number, final = true): SubagentInfo | null {
    const known = this.known.get(thread);
    if (!known) return null;
    const turns: Item[] = Array.isArray(read.turns) ? read.turns : [];
    const items: Item[] = turns.flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []));
    const asked = items.find((item) => item.type === "userMessage");
    const prompt = asked ? goalOf(inputText(asked.content)) : "";
    const last = turns.at(-1);
    const answer = (last?.items ?? []).findLast((item: Item) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim() !== "");
    const before = JSON.stringify(publish(known));
    named(known, read);
    // Read for one thought to be at work: its own last turn says whether it still is. A
    // turn left in progress in a thread Codex no longer runs was cut off (Codex restarted).
    const cutOff = last?.status === "inProgress" && read.status?.type !== undefined && read.status.type !== "active";
    if (prompt !== "") known.goal = prompt;
    const current = since === undefined || since === known.revision;
    const alreadyEnded = last?.status === "inProgress" && last.id === known.endedTurn;
    const pendingTurn = read.status?.type === "active" && last?.status !== "inProgress";
    // At rest with its turn still in progress: just finished, the turn's end not yet in
    // its thread, or cut off with the thread still loaded. A later look tells which.
    const pendingEnd = !final && read.status?.type === "idle" && last?.status === "inProgress";
    if (current && !alreadyEnded && !pendingTurn && !pendingEnd) {
      if (last?.status === "inProgress" && !cutOff) {
        if (known.status !== "running" || (known.turn && known.turn !== last.id)) this.begin(known);
        known.turn = last.id;
      } else if (last && read.status?.type !== "active") {
        let status: SubagentStatus = "failed";
        if (last.status === "completed") status = "completed";
        else if (read.status?.type !== "systemError" && (cutOff || last.status === "interrupted")) status = "stopped";
        if (known.endedTurn !== last.id || known.status !== status) {
          const said = last.id === known.turn || last.id === known.endedTurn ? known.said : undefined;
          if (last.id !== known.turn && last.id !== known.endedTurn) this.begin(known);
          known.turn = last.id;
          const error = typeof last.error?.message === "string" ? last.error.message : undefined;
          this.end(known, status, error || answer?.text || said);
          if (typeof last.completedAt === "number") known.endedAt = last.completedAt * 1000;
        }
      }
      if (answer) known.said = answer.text;
      if (last?.status === "inProgress" && known.status === "running" && !cutOff) known.turn = last.id;
      if (known.status === "completed" && answer) known.result = clipped(answer.text);
    }
    const after = publish(known);
    return JSON.stringify(after) === before ? null : after;
  }

  /** A notification of a sub-agent's own thread; null when it changes nothing shown. */
  child(thread: string, method: string, params: Item): SubagentInfo | null {
    const known = this.known.get(thread);
    if (!known) return null;
    switch (method) {
      case "turn/started": {
        const id = params.turn?.id;
        if (typeof id !== "string" || id === known.turn || id === known.endedTurn) return null;
        // Given more to do (`sendInput`, `followupTask`): at work again.
        this.begin(known);
        known.turn = id;
        return publish(known);
      }
      case "thread/status/changed":
        known.revision += 1;
        // Its thread read distinguishes a real new turn from a transient active
        // thread, and completion from failure or interruption.
        return null;
      case "item/started": {
        const tool = gatewayTool(params.item ?? {});
        if (!tool || known.status !== "running") return null;
        known.tool = tool.name;
        return publish(known);
      }
      case "item/completed": {
        const item = params.item ?? {};
        if (item.type !== "agentMessage" || typeof item.text !== "string" || item.text.trim() === "") return null;
        if (typeof params.turnId === "string") {
          if (known.turn && params.turnId !== known.turn) return null;
          if (!known.turn && known.status === "running") {
            if (params.turnId === known.endedTurn) return null;
            known.turn = params.turnId;
          } else if (!known.turn && params.turnId !== known.endedTurn) return null;
        }
        known.revision += 1;
        known.said = item.text;
        // Said while at work: what it is doing, in its own words.
        if (known.status === "running") known.summary = oneLine(item.text);
        else if (known.status === "completed") known.result = clipped(item.text);
        return publish(known);
      }
      case "thread/tokenUsage/updated": {
        const total = params.tokenUsage?.total?.totalTokens;
        if (typeof total !== "number") return null;
        known.tokens = total;
        return publish(known);
      }
      case "turn/completed": {
        const turn = params.turn ?? {};
        if (typeof turn.id !== "string") return null;
        // Even an unfamiliar turn's end makes an earlier read obsolete. The
        // session reads its thread to distinguish a missed run from a late event.
        known.revision += 1;
        if (known.turn !== undefined && turn.id !== known.turn) return null;
        if (!known.turn && known.endedTurn !== undefined) return null;
        const status: SubagentStatus = turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "stopped" : "failed";
        const error = typeof turn.error?.message === "string" ? turn.error.message : "";
        known.turn = turn.id;
        this.end(known, status, status === "failed" && error ? error : known.said);
        return publish(known);
      }
      default:
        return null;
    }
  }

  private state(known: Known, state: Item): void {
    const message = typeof state.message === "string" && state.message.trim() !== "" ? state.message : undefined;
    known.revision += 1;
    switch (state.status) {
      case "pendingInit":
      case "running":
        if (known.status !== "running") this.reopen(known);
        return;
      case "completed":
        if (known.status === "running") this.end(known, "completed", message ?? known.said);
        else if (message) known.result = clipped(message);
        return;
      case "errored":
      case "notFound":
        if (known.status === "running") this.end(known, "failed", message);
        return;
      case "interrupted":
      case "shutdown":
        if (known.status === "running") this.end(known, "stopped", message);
        return;
    }
  }

  private end(known: Known, status: SubagentStatus, result?: string): void {
    known.revision += 1;
    known.status = status;
    known.endedAt = this.time();
    delete known.summary;
    delete known.result;
    if (known.turn) known.endedTurn = known.turn;
    delete known.turn;
    if (result && result.trim() !== "") known.result = clipped(result);
  }

  /**
   * At work again by what its parent last heard (v1's states), with no turn of its own
   * yet to say so: what it said stays, so that a "completed" with no message after it
   * still ends with its answer. A new turn of its own (`begin`) clears it.
   */
  private reopen(known: Known): void {
    known.revision += 1;
    known.status = "running";
    if (known.result && !known.said) known.said = known.result;
    delete known.endedAt;
    delete known.result;
    delete known.summary;
  }

  private begin(known: Known): void {
    known.revision += 1;
    known.status = "running";
    delete known.turn;
    delete known.endedAt;
    delete known.result;
    delete known.said;
    delete known.summary;
    delete known.tool;
  }
}

/**
 * Whether a read of a sub-agent's thread caught it between two states, which a later
 * look settles: at work with the turn it was given not listed yet, or at rest with its
 * last turn still in progress.
 */
export function betweenStates(read: Item): boolean {
  const last = Array.isArray(read.turns) ? read.turns.at(-1) : undefined;
  const status = read.status?.type;
  return (status === "active" && last?.status !== "inProgress") || (status === "idle" && last?.status === "inProgress");
}

/**
 * What the line is given of one: nothing said in passing, and its turn only as which run
 * of it this is (`run`). A running one can be stopped by itself.
 */
function publish(known: Known): SubagentInfo {
  const { turn, endedTurn, said: _said, revision: _revision, run: _run, ...info } = known;
  const run = turn ?? endedTurn;
  return structuredClone({ ...info, stoppable: info.status === "running", ...(run !== undefined ? { run } : {}) });
}

/**
 * What Codex calls a sub-agent, from its thread (`thread/started`, `thread/read`): its
 * nickname ("Darwin") and role ("worker"), and its path as its goal while it has none.
 * The role Codex gives one spawned with none, `default`, says nothing, and is left out
 * (seen live on 0.162.1: "Euclid", "default").
 */
function named(known: Known, thread: Item): void {
  const spawn = thread.source?.subAgent?.thread_spawn ?? {};
  const nickname = nicknameOf(thread);
  const role = words(thread.agentRole) || words(spawn.agent_role);
  if (nickname) known.nickname = nickname;
  if (role && role !== "default") known.role = role;
  if (known.goal === "") known.goal = nameOf(spawn.agent_path);
}

/** How long a name drawn from what a sub-agent was asked to do may be in a call's row. */
const nameLength = 40;

/** A sub-agent as a call's row names it: its nickname, else what it was asked to do, kept short. */
function nameFor(known: Known | undefined, nickname?: string): string {
  if (!known) return "";
  if (known.nickname || nickname) return (known.nickname || nickname)!;
  const goal = known.goal.replace(/…$/, "").trim();
  return goal.length > nameLength ? `${cutWhole(goal, nameLength).trimEnd()}…` : goal;
}

/** What Codex calls a sub-agent, from its thread (`thread/started`, `thread/read`); "" when it says nothing. */
export function nicknameOf(thread: Item | null | undefined): string {
  return words(thread?.agentNickname) || words(thread?.source?.subAgent?.thread_spawn?.agent_nickname);
}

function words(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A sub-agent's path as words: `/root/pear_reply` is "pear reply". */
function nameOf(path: unknown): string {
  if (typeof path !== "string") return "";
  return (path.split("/").filter((part) => part !== "").at(-1) ?? "").replace(/[_-]+/g, " ").trim();
}

/** The text of a `userMessage`'s content. */
function inputText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((entry: Item) => (entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""))
    .join("\n")
    .trim();
}

function goalOf(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > goalLength ? `${cutWhole(line, goalLength)}…` : line;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipped(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > resultLength ? `${cutWhole(trimmed, resultLength)}…` : trimmed;
}
