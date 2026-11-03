import { log } from "../log.ts";

// Telling the devices that ask when something they poll for has moved (feature poll_now,
// docs/gateway-protocol.md section 11): the list of threads (its revision), a thread
// starting or stopping work or coming to need an answer, or no longer (what
// `sessions.activity` lists), the agents' looks, the sidebar's order, or a later
// portals-host coming out (`latest`, feature update_notice). A device that
// asks in `client.capabilities` gets one small event with no session, `poll.now`, and
// then runs the poll it runs every few seconds while its sidebar is out
// (`sessions.activity`, then `threads.changes` when the list moved), at once, its sidebar
// out or not. The event says where the list is; the rest the poll asks.
//
// - A burst is one event: the first move starts a short wait, which later moves do not
//   start again, and what the event says is read as it goes. Every change is saved, or
//   put back, in the step that makes it, so the event says only what was saved.
// - Only a change that was saved moves anything: one threads.json could not take moves
//   nothing, and nor does one no listing shows (a thread's model or mode). Each of them
//   tells this only when its revision moved, or a thread's activity changed.
// - The event comes after whatever moved it: a turn's end is told (its
//   `message.complete`) and kept in one step, in which the wait starts.
// - Links between Macs and the `portals` command never ask, nor does an app from before
//   the feature (which drops an event without a session anyway). A connection that
//   closes is forgotten.

/** How long the moves of a burst are gathered before the devices are told: a turn's end, its title, the seen of the device looking at the thread. */
export const pollNowWaitMs = 200;

/** An event with no session (docs/gateway-protocol.md, section 3): never logged, never replayed. */
export interface ConnectionEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** A connection, as far as `poll.now` goes. */
export interface PollNowPeer {
  sendConnectionEvent(event: ConnectionEvent): void;
}

export class PollNow {
  private readonly peers = new Set<PollNowPeer>();
  /** What the event says, read as it goes. */
  private readonly payload: () => Record<string, unknown>;
  private readonly waitMs: number;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  /** `payload`: what `poll.now` says, read as it is sent. */
  constructor(payload: () => Record<string, unknown>, waitMs = pollNowWaitMs) {
    this.payload = payload;
    this.waitMs = waitMs;
  }

  /** Whether `peer` is told from now on (`client.capabilities` `poll_now`), until it says otherwise or leaves. */
  ask(peer: PollNowPeer, asks: boolean): void {
    if (asks && !this.closed) this.peers.add(peer);
    else this.peers.delete(peer);
  }

  /** The connection closed. */
  leave(peer: PollNowPeer): void {
    this.peers.delete(peer);
  }

  /** How many connections are told. */
  get asking(): number {
    return this.peers.size;
  }

  /**
   * Something a device polls for moved, and was saved. The devices that ask are told
   * once the wait is over, together with whatever else moves meanwhile; with none
   * asking, nothing is waited for.
   */
  moved(): void {
    if (this.timer || this.peers.size === 0 || this.closed) return;
    this.timer = setTimeout(() => this.tell(), this.waitMs);
  }

  /** The bridge is closing: nothing more is sent. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.peers.clear();
  }

  private tell(): void {
    this.timer = undefined;
    if (this.peers.size === 0) return;
    let event: ConnectionEvent;
    try {
      event = { type: "poll.now", payload: this.payload() };
    } catch (error) {
      log.error("could not say what moved", { error: (error as Error)?.stack ?? String(error) });
      return;
    }
    for (const peer of this.peers) {
      // One that cannot be sent it costs only itself the event; its next poll finds the rest.
      try {
        peer.sendConnectionEvent(event);
      } catch (error) {
        log.error("could not tell a device that what it polls for moved", { error: (error as Error)?.stack ?? String(error) });
      }
    }
  }
}
