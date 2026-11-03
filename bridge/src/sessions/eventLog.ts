// The replay log of one session: its most recent events, numbered.
//
// `seq` starts at 1 and goes up by one per event, the same number live on every
// connection and in `session.events.since`. The app drops any event whose seq is not
// above the last one it applied, so within one process (one replay epoch) a session's
// numbers never go back: a session let go of and loaded again in the same run (a thread
// only read and then continued, or one removed and taken up again) numbers on past where
// the last one stopped (`SessionManager` keeps that), with an empty log. Its conversation
// is read afresh from the agent, which may have gone on at the desk meanwhile, so no
// replay reaches back before it: the log starts at a base, the number after the last
// one's, which no event has and a snapshot taken before the first event holds, and a
// device that holds a number below it is told `truncated` and takes a snapshot. A session
// whose conversation changes with no event moves its base on the same way (`rebase`). A
// device that followed the session through such a change holds numbers above the new
// base all the same, with the conversation from before it: a light resume (feature
// `resume_replay`) is given only to one that sends back the base of the conversation it
// took, which says which it holds (`Session.replay`).

/** A canonical event: replay and the `params` of an ordinary `event` frame.
 * Opted-in connections may encode a live delta compactly without changing this object. */
export interface LoggedEvent {
  type: string;
  session_id: string;
  seq: number;
  payload?: Record<string, unknown>;
}

export interface Replay {
  events: LoggedEvent[];
  /** The log no longer reaches back to `lastSeen + 1`: the app should take a snapshot. */
  truncated: boolean;
  latestSeq: number;
}

export class EventLog {
  readonly capacity: number;
  private readonly sessionID: string;
  // A ring: `entries[(start + i) % capacity]` is the i-th oldest event kept.
  private readonly entries: LoggedEvent[] = [];
  private start = 0;
  private lastSeq = 0;
  private discardedThrough = 0;
  /** Progress is replaceable state, not thousands of cumulative copies in the ring. */
  private readonly progress = new Map<string, LoggedEvent>();
  /** The same for a background command's row (`subagent.progress` of kind command), kept past the turn's end. */
  private readonly commands = new Map<string, LoggedEvent>();
  /** The lowest number a replay may start from: what a device holds below it is from a session before this one, or from before a change no event told of. */
  private baseSeq: number;

  /**
   * `lastSeq`: the last number a log of this thread gave out earlier in this run, when
   * there was one. The one after it is this log's base, given to no event; the first
   * event has the next.
   */
  constructor(sessionID: string, capacity = 5000, lastSeq?: number) {
    this.sessionID = sessionID;
    this.capacity = Math.max(1, capacity);
    this.baseSeq = lastSeq === undefined ? 0 : Math.max(0, lastSeq) + 1;
    this.lastSeq = this.baseSeq;
  }

  get latestSeq(): number {
    return this.lastSeq;
  }

  /** Where the replay of the conversation as it is now begins: it moves on with every change no event tells of, never back. */
  get base(): number {
    return this.baseSeq;
  }

  /**
   * The conversation changed with no event: no replay reaches back before now. The number
   * after the last is held back as the new base, as at a base the log began with, so a
   * device that holds the last is told `truncated` and one that takes a snapshot now has
   * missed nothing.
   */
  rebase(): void {
    this.lastSeq += 1;
    this.baseSeq = this.lastSeq;
    // No replay can reach these payloads now, even before new events replace them.
    this.entries.length = 0;
    this.start = 0;
    this.discardedThrough = this.baseSeq;
    this.progress.clear();
    this.commands.clear();
  }

  append(type: string, payload?: Record<string, unknown>): LoggedEvent {
    this.lastSeq += 1;
    const event: LoggedEvent = { type, session_id: this.sessionID, seq: this.lastSeq };
    if (payload !== undefined) event.payload = payload;
    // A background command's row says all of it each time, as often as once a second for
    // hours (a dev server's output): only its latest is kept, as for a tool's progress.
    const command = type === "subagent.progress" && payload?.kind === "command" ? payload.subagent_id : undefined;
    if (typeof command === "string") {
      this.commands.set(command, event);
      return event;
    }
    if (type === "subagent.complete" && typeof payload?.subagent_id === "string") this.commands.delete(payload.subagent_id);
    const tool = payload?.tool_id;
    if (typeof tool === "string") {
      if (type === "tool.progress") {
        this.progress.set(tool, event);
        return event;
      }
      if (type === "tool.complete") this.progress.delete(tool);
    }
    if (type === "message.complete") this.progress.clear();
    if (this.entries.length < this.capacity) {
      this.entries.push(event);
    } else {
      this.discardedThrough = this.entries[this.start].seq;
      this.entries[this.start] = event;
      this.start = (this.start + 1) % this.capacity;
    }
    return event;
  }

  /** The events after `lastSeen`, oldest first. */
  since(lastSeen: number): Replay {
    const latestSeq = this.lastSeq;
    if (lastSeen > latestSeq || lastSeen < this.baseSeq) {
      // Numbers this log never gave out, or a session before it gave out: whatever the
      // app holds is from something else.
      return { events: [], truncated: true, latestSeq };
    }
    if (lastSeen < this.discardedThrough) {
      return { events: [], truncated: true, latestSeq };
    }
    const events: LoggedEvent[] = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const event = this.at(index);
      if (event.seq > lastSeen) events.push(event);
    }
    for (const event of this.progress.values()) if (event.seq > lastSeen) events.push(event);
    for (const event of this.commands.values()) if (event.seq > lastSeen) events.push(event);
    events.sort((a, b) => a.seq - b.seq);
    return { events, truncated: false, latestSeq };
  }

  private at(index: number): LoggedEvent {
    return this.entries[(this.start + index) % this.entries.length];
  }
}
