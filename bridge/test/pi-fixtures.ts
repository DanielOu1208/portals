import { readFileSync } from "node:fs";
import { historyFromSession, type PiHistory } from "../src/providers/pi/history.ts";
import { PiStream } from "../src/providers/pi/stream.ts";
import type { ProviderEvent, StoredMessage } from "../src/providers/types.ts";
import { Transcript } from "../src/sessions/transcript.ts";

// Recorded runs of the real Pi in its RPC mode (scripts/record-pi.ts, test/fixtures/pi)
// and a way to play one through the mapper with no Pi at all.
//
// `<name>.jsonl` holds every record both ways in order: `meta` (the scenario, Pi's
// release, the model), `start` (a process's arguments), `send` (what the recorder
// wrote), `receive` (what Pi printed) and `exit` (how a process ended).
// `<name>.session.jsonl` is Pi's own session file as it was at the end.

/** The folder the recordings ran in, after cleaning. */
export const fixtureCwd = "/tmp/portals-cwd";

/** Every recording, in the order they were made. */
export const recordings = ["models", "plain", "tools", "stop", "stop-tool", "steer", "resume", "image", "compact", "compact-auto", "dialog", "killed", "thinking", "error", "commands", "own"];

export interface Entry {
  kind: "meta" | "start" | "send" | "receive" | "exit";
  at?: number;
  record?: any;
  /** `exit`: whether the recorder asked the process to stop. */
  asked?: boolean;
  signal?: string | null;
  code?: number | null;
  last_words?: string | null;
  session_id?: string;
}

export function fixture(name: string): Entry[] {
  const text = readFileSync(new URL(`fixtures/pi/${name}.jsonl`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Entry);
}

/** Pi's session file for the recording, as text. */
export function sessionText(name: string): string {
  return readFileSync(new URL(`fixtures/pi/${name}.session.jsonl`, import.meta.url), "utf8");
}

/** The recording's session file read as history. */
export function recordedHistory(name: string): PiHistory {
  return historyFromSession(sessionText(name), fixtureCwd);
}

/** The data of each successful answer the recording has to `command`, in order. */
export function answers(name: string, command: string): any[] {
  return fixture(name)
    .filter((entry) => entry.kind === "receive" && entry.record?.type === "response" && entry.record.command === command && entry.record.success === true)
    .map((entry) => entry.record.data);
}

/** A message as the recorder sent it, in the words the bridge stores: the text, then one `@image:` line per image. */
function sentText(command: any): string {
  if (command.type === "compact") return "/compact";
  const images = Array.isArray(command.images) ? command.images.map((_: unknown, index: number) => `@image:image-${index + 1}.png`) : [];
  return [command.message, ...images].filter((line: string) => line !== "").join("\n");
}

interface Player {
  /** A turn the session starts, opened by `user`. */
  turn?(user: string): void;
  /** A message written into the running turn. */
  steer?(user: string): void;
  events(events: ProviderEvent[]): void;
}

/**
 * A recording through `PiStream`, fed as the session feeds it:
 *
 * - each process is a new stream;
 * - a `prompt` or a `compact` written with no turn open begins a turn (`beginTurn`); one
 *   written into an open turn, and a `follow_up`, joins it;
 * - a turn ends when Pi settles (the stream's own `turn.end`), or with `finish`: when
 *   its `prompt` is answered `handled` with no run under way (an extension's command),
 *   or refused; when `compact` answers; when the process ends;
 * - an answer to `get_session_stats` goes to `stats`, every other record that is not an
 *   answer to `map`.
 */
function play(name: string, player: Player): void {
  let stream = new PiStream({ cwd: fixtureCwd });
  /** The command that began the open turn, by its id. */
  let opener: string | null = null;
  for (const entry of fixture(name)) {
    const record = entry.record;
    switch (entry.kind) {
      case "start":
        stream = new PiStream({ cwd: fixtureCwd });
        opener = null;
        break;
      case "send":
        if (record.type !== "prompt" && record.type !== "compact" && record.type !== "follow_up") break;
        if (stream.inTurn) {
          player.steer?.(sentText(record));
        } else if (record.type !== "follow_up") {
          stream.beginTurn();
          opener = record.id;
          player.turn?.(sentText(record));
        }
        break;
      case "receive":
        if (record.type !== "response") {
          player.events(stream.map(record));
        } else if (record.command === "get_session_stats") {
          player.events(stream.stats(record.data));
        } else if (record.id === opener) {
          if (record.success === false) player.events(stream.finish("error", record.error));
          else if (record.command === "compact" || (record.data?.disposition === "handled" && !stream.inRun)) player.events(stream.finish("complete"));
        }
        break;
      case "exit":
        // With a turn open, the process's end is the turn's.
        player.events(stream.finish(entry.asked ? "interrupted" : "error", "Pi stopped unexpectedly."));
        break;
      default:
        break;
    }
  }
}

/** How many turns a recording has: the ones the recorder began. (None of them has a run Pi began by itself.) */
export function turnsBegun(name: string): number {
  let turns = 0;
  play(name, { turn: () => (turns += 1), events: () => {} });
  return turns;
}

/** The neutral events a recording maps to. */
export function replay(name: string): ProviderEvent[] {
  const all: ProviderEvent[] = [];
  play(name, { events: (events) => all.push(...events) });
  return all;
}

/**
 * The stored messages a recording leaves behind when it is played live: its events
 * through `Transcript`, with the user's messages stored as `Session` stores them (at the
 * turn's start, and a steered one when it is sent).
 */
export function liveTranscript(name: string): StoredMessage[] {
  const transcript = new Transcript();
  play(name, {
    turn: (user) => transcript.startTurn(user),
    steer: (user) => transcript.steer(user),
    events: (events) => {
      for (const event of events) {
        if (event.type === "turn.begin") transcript.startTurn(event.user, event.host);
        else transcript.apply(event);
      }
    },
  });
  return transcript.messages;
}

/** Events with each run of text or reasoning pieces joined into one, for reading and comparing. */
export function joined(events: ProviderEvent[]): unknown[] {
  const out: any[] = [];
  for (const event of events) {
    const last = out.at(-1);
    if ((event.type === "text" || event.type === "reasoning") && last?.type === event.type) {
      last.text += event.text;
      last.pieces += 1;
    } else if (event.type === "text" || event.type === "reasoning") {
      out.push({ ...event, pieces: 1 });
    } else {
      out.push(event);
    }
  }
  return out;
}

/** Stored messages without their times, which a replay cannot reproduce. */
export function timeless(messages: StoredMessage[]): unknown[] {
  return messages.map(({ timestamp: _timestamp, ...rest }) => rest);
}
