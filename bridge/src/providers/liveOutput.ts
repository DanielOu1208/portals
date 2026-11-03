import type { ProviderEvent } from "./types.ts";

// A running command's output as it comes, for any agent that tells it (docs/gateway-protocol.md,
// `tool.progress`): only its end is kept, and it goes out at most four times a second per
// call, the newest each time. Each `tool.progress` carries the whole tail, which replaces
// the one before, so nothing piles up anywhere: the session's replay log keeps only a
// call's latest and the thread's history keeps none (only the call's final result).

/** How much of a command's output is kept and sent: its last lines, at most this many bytes. */
const tailBytes = 8192;
const tailLines = 200;
/** The least time between two updates of one call. */
const intervalMs = 250;

/**
 * The end of a command's output: its last `tailLines` lines, at most `tailBytes` bytes of
 * UTF-8, and whether anything before it was left out.
 */
export function outputTail(text: string): { output: string; truncated: boolean } {
  // Only the end is kept, so only the end is read: some agents send a command's whole
  // output with every update (megabytes for a long build). Each UTF-16 unit is at least
  // one byte of UTF-8, so the last 8192 units hold the last 8192 bytes.
  const end = text.length > tailBytes ? text.slice(-tailBytes) : text;
  const lines = end.split("\n");
  const bytes = Buffer.from(lines.slice(-tailLines).join("\n"));
  let start = Math.max(0, bytes.length - tailBytes);
  // Never decode the middle of a UTF-8 character as a replacement character.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { output: bytes.subarray(start).toString(), truncated: end !== text || lines.length > tailLines || start > 0 };
}

/**
 * Output as a terminal would show it: a line a carriage return went back over (a progress
 * bar redrawn in place) shows only what was written last, and `\r\n` is a plain end of line.
 */
export function asShown(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r+\n/g, "\n").split("\n").map((line) => {
    const back = line.lastIndexOf("\r", line.length - 2);
    return (back === -1 ? line : line.slice(back + 1)).replace(/\r$/, "");
  }).join("\n");
}

interface Call {
  /** What came so far, its end only (twice the tail, so a tail is always whole). */
  text: string;
  /** Some of the start was let go of. */
  dropped: boolean;
  progress?: string;
  /** What went out last, to send nothing when nothing changed. */
  sent?: string;
  sentProgress?: string;
  sentAt?: number;
  timer?: NodeJS.Timeout;
}

export interface LiveOutputOptions {
  now?: () => number;
  /** Milliseconds between two updates of one call; 250 unless a test says otherwise. */
  intervalMs?: number;
}

/** The live output of the calls running in one thread. */
export class LiveOutput {
  private readonly calls = new Map<string, Call>();
  private readonly emit: (event: ProviderEvent) => void;
  private readonly now: () => number;
  private readonly interval: number;

  constructor(emit: (event: ProviderEvent) => void, options: LiveOutputOptions = {}) {
    this.emit = emit;
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? intervalMs;
  }

  /** More output of call `id`, following what came before. */
  append(id: string, chunk: string): void {
    if (chunk === "") return;
    const call = this.call(id);
    call.text += chunk;
    if (call.text.length > tailBytes * 2) {
      call.text = call.text.slice(-tailBytes * 2);
      call.dropped = true;
    }
    this.publish(id, call);
  }

  /** The whole output of call `id` so far, in place of what came before. */
  replace(id: string, whole: string): void {
    const call = this.call(id);
    const end = whole.length > tailBytes * 2 ? whole.slice(-tailBytes * 2) : whole;
    if (end === call.text && call.dropped === (end !== whole)) return;
    call.text = end;
    call.dropped = end !== whole;
    this.publish(id, call);
  }

  /** A line on how call `id` is getting on ("Running for 12 s"). */
  status(id: string, text: string): void {
    const call = this.call(id);
    if (call.progress === text) return;
    call.progress = text;
    this.publish(id, call);
  }

  /** The output kept of call `id`, as it would go out now; undefined for one with none. */
  tail(id: string): { output: string; truncated: boolean } | undefined {
    const call = this.calls.get(id);
    if (!call || call.text === "") return undefined;
    const tail = outputTail(asShown(call.text));
    return { output: tail.output, truncated: tail.truncated || call.dropped };
  }

  /** Call `id` ended: its final result follows, so what is waiting is let go. */
  end(id: string): void {
    const call = this.calls.get(id);
    if (call?.timer) clearTimeout(call.timer);
    this.calls.delete(id);
  }

  /** Every call ended (the turn is over). */
  clear(): void {
    for (const call of this.calls.values()) if (call.timer) clearTimeout(call.timer);
    this.calls.clear();
  }

  private call(id: string): Call {
    let call = this.calls.get(id);
    if (!call) {
      call = { text: "", dropped: false };
      this.calls.set(id, call);
    }
    return call;
  }

  private publish(id: string, call: Call): void {
    if (call.timer) return;
    const wait = call.sentAt === undefined ? 0 : call.sentAt + this.interval - this.now();
    if (wait <= 0) {
      this.flush(id, call);
      return;
    }
    call.timer = setTimeout(() => {
      call.timer = undefined;
      if (this.calls.get(id) === call) this.flush(id, call);
    }, wait);
    call.timer.unref();
  }

  private flush(id: string, call: Call): void {
    const tail = this.tail(id);
    const output = tail?.output;
    if (output === call.sent && call.progress === call.sentProgress) return;
    call.sent = output;
    call.sentProgress = call.progress;
    call.sentAt = this.now();
    this.emit({
      type: "tool.progress",
      id,
      ...(tail ? { output: tail.output, outputTruncated: tail.truncated } : {}),
      ...(call.progress !== undefined ? { progress: call.progress } : {}),
    });
  }
}
