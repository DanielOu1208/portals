import type { StoredMessage } from "../providers/types.ts";

// The messages that failed without reaching the agent: one that waited on the thread's
// list while the agent's side caught up after its connection dropped fails when the agent
// cannot be reached (`Session.failUnreached`). The agent's own history never had them, so
// the bridge keeps the latest few of each thread in the thread's file of messages waiting
// (`WaitingStore`), written in the one step that takes them off the list there, and a
// thread loaded again (after a restart of the bridge too) shows them failed in their place.

/** A message that failed, as kept. */
export interface FailedMessage {
  /** As stored (`storedUserText`): its words, its files' paths, a line `@image:<name>` for each image. */
  text: string;
  /** Why it failed, as its turn said. */
  error: string;
  /** When it failed, in Unix seconds, as stored messages are timed. */
  at: number;
  /**
   * The agent's own id for its turn this one showed right after (`latestTurn`), null when
   * it showed before any: where it goes back to. Absent when the agent has no such ids.
   */
  turn?: string | null;
  /** The provider handoff whose receipt may still arrive, never matched by its words. */
  requestId?: string;
  messageID?: string;
}

/** How many a thread keeps: the latest. */
export const failedKept = 20;

/**
 * The stored conversation with each failed message in its place, as a turn of its own (its
 * message, then why it failed, `display_kind` `failed_turn`, as the turn showed while the
 * bridge ran): where it showed, right after the agent's turn it showed after (`turn`, by
 * the agent's id for it; `turnEnd` says where that turn ends in `history`), before the
 * next of the agent's own, and in the order they failed; so a device that held the thread
 * finds its turns in the order it had them, and its latest is what it was. One whose turn
 * is not in `history` (or with none named) goes by time: before the first of the agent's
 * turns begun in the second it failed or after (the agent's turns are timed in whole
 * seconds, so one begun in that second is taken for one begun after it, such as the
 * message tried again), else at the end. A turn's own messages are never split: one is
 * placed only where a turn begins. With a turn the agent still runs (`running`: the last
 * turn stored, which the session takes up again), one after its start goes before it, so
 * the running turn stays the last.
 */
export function withFailed(history: StoredMessage[], failed: readonly FailedMessage[], running = false, turnEnd?: (id: string) => number | undefined): StoredMessage[] {
  if (failed.length === 0) return history;
  const messages = [...history];
  const opens = (stored: StoredMessage) => stored.role === "user" && stored.display_kind !== "steer";
  // The agent's own turns: failed ones placed already keep the order they failed in.
  const agents = new Set(history.filter(opens));
  const runningOpener = running ? history.findLast(opens) : undefined;
  for (const message of [...failed].sort((a, b) => a.at - b.at)) {
    const turn: StoredMessage[] = [
      { role: "user", text: message.text, timestamp: message.at, ...(message.messageID ? { message_id: message.messageID } : {}) },
      { role: "assistant", text: message.error, timestamp: message.at, display_kind: "failed_turn", ...(message.requestId ? { display_metadata: { failed_request_id: message.requestId } } : {}) },
    ];
    const end = message.turn === null ? 0 : message.turn === undefined ? undefined : turnEnd?.(message.turn);
    let at: number;
    if (end !== undefined && end >= 0 && end <= history.length) {
      // Before what followed that turn in the agent's history: the start of its next turn.
      const next = history[end];
      at = next === undefined ? -1 : messages.indexOf(next);
    } else {
      const second = Math.floor(message.at);
      at = messages.findIndex((stored) => agents.has(stored) && stored.timestamp >= second);
    }
    if (runningOpener) {
      const limit = messages.indexOf(runningOpener);
      if (at === -1 || at > limit) at = limit;
    }
    if (at === -1) messages.push(...turn);
    else messages.splice(at, 0, ...turn);
  }
  return messages;
}
