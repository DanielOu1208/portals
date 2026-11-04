import { counters } from "../../counters.ts";
import { log } from "../../log.ts";
import { JsonChild, type ChildExit } from "../child.ts";
import { isDialog } from "./dialogs.ts";
import type { PiCommand, PiEvent, PiRecord, PiResponse, PiUiRequest, PiUiResponse } from "./protocol.ts";

// One Pi process in its RPC mode (`pi --mode rpc`): commands go in as JSON lines, and
// answers, events and dialogs come out as JSON lines (Pi's docs/rpc.md). This file
// numbers the commands, hands each answer to whoever asked, and passes on everything
// else. It knows nothing of threads or turns: `session.ts` and `provider.ts` do.
//
// Pi's own packaged client is not used: it cannot answer dialogs and gives every command
// 30 seconds, where `prompt`, `abort` and `compact` are answered only when Pi is done.
//
// What Pi printed reaches its takers in the order Pi printed it. An answer goes to a
// promise and an event to the listener, and a promise's taker runs a moment later than a
// listener does; so after an answer the records behind it are held until that moment has
// passed, and whoever asked has acted on the answer before the next event arrives.

/** Pi answered a command with `success: false`. The message is Pi's own sentence. */
export class PiRefused extends Error {}

/** The process ended, or was never there, before it answered. The message says how it ended. */
export class PiGone extends Error {}

/** Pi did not answer in the time a command has. */
export class PiSilent extends Error {}

export interface PiListener {
  /** A record that is neither an answer nor a dialog: a session event, or something an extension shows. */
  event(record: PiEvent): void;
  /** An extension asks something and waits: `answer` settles it. */
  dialog(request: PiUiRequest): void;
  /** The process has ended, or could not be started. Called once, after its last record. */
  exited(exit: ChildExit): void;
}

export interface PiClientOptions {
  /** The installed `pi`. */
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The folder the process runs in. */
  cwd: string;
  listener: PiListener;
  /** How long a command has to be answered; 30 seconds unless a test says otherwise. */
  timeoutMs?: number;
}

/** Commands Pi answers only when it is done with what they ask: there is no time limit on them. */
const untimed = new Set(["prompt", "abort", "compact"]);

interface Waiting {
  command: string;
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

type Arrival = { record: PiRecord } | { exit: ChildExit };

export class PiClient {
  private readonly child: JsonChild;
  private readonly listener: PiListener;
  private readonly timeoutMs: number;
  private nextId = 1;
  private readonly waiting = new Map<string, Waiting>();
  /** What Pi printed that has not been passed on yet. */
  private readonly arrivals: Arrival[] = [];
  /** An answer was just handed over: the rest waits for its taker. */
  private holding = false;
  private exit: ChildExit | null = null;
  private readonly told = Promise.withResolvers<void>();

  /** Starts the process. A failure to start is told to the listener like any other end. */
  constructor(options: PiClientOptions) {
    this.listener = options.listener;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (counters.on) counters.spawned("pi");
    this.child = new JsonChild({
      name: "Pi",
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      listener: {
        message: (value) => this.arrived({ record: value as PiRecord }),
        exited: (exit) => this.arrived({ exit }),
      },
    });
  }

  /** The process's id; undefined when it could not be started. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The process is there and was not asked to stop. */
  get running(): boolean {
    return this.child.running;
  }

  /**
   * Writes a command and resolves with the `data` of Pi's answer. Rejects with
   * `PiRefused` when Pi says no, `PiGone` when the process ends first, and `PiSilent`
   * when no answer comes in `timeoutMs` (null: however long Pi takes). `signal` gives up
   * on the answer, rejecting with its reason; one that comes later is let go of.
   */
  call<T = any>(command: PiCommand, timeoutMs: number | null = untimed.has(command.type) ? null : this.timeoutMs, signal?: AbortSignal): Promise<T> {
    const id = `b${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      if (this.exit || !this.child.send({ id, ...command })) {
        reject(new PiGone(this.exit?.reason ?? "Pi is not running."));
        return;
      }
      const givenUp = () => {
        if (this.waiting.get(id) !== waiting) return;
        this.waiting.delete(id);
        if (waiting.timer) clearTimeout(waiting.timer);
        reject(signal!.reason);
      };
      const waiting: Waiting = {
        command: command.type,
        resolve: (data) => {
          signal?.removeEventListener("abort", givenUp);
          resolve(data);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", givenUp);
          reject(error);
        },
        timer: null,
      };
      if (timeoutMs !== null) {
        waiting.timer = setTimeout(() => {
          this.waiting.delete(id);
          waiting.reject(new PiSilent(`Pi did not answer ${command.type} in ${Math.round(timeoutMs / 100) / 10} seconds.`));
        }, timeoutMs);
        waiting.timer.unref();
      }
      this.waiting.set(id, waiting);
      signal?.addEventListener("abort", givenUp, { once: true });
    });
  }

  /** Settles a dialog. Not a command: Pi sends no answer to it. */
  answer(response: PiUiResponse): void {
    this.child.send(response);
  }

  /** Ends the process and whatever it started. Resolves once it is gone and the listener was told. */
  async stop(): Promise<void> {
    await this.child.stop();
    await this.told.promise;
  }

  private arrived(arrival: Arrival): void {
    this.arrivals.push(arrival);
    if (!this.holding) this.pass();
  }

  /** Passes on what has arrived, in order, up to and with the next answer. */
  private pass(): void {
    while (this.arrivals.length > 0) {
      const arrival = this.arrivals.shift()!;
      let answered = false;
      try {
        answered = "exit" in arrival ? this.ended(arrival.exit) : this.received(arrival.record);
      } catch (error) {
        log.error("a record from Pi could not be handled", { error: (error as Error).message });
      }
      if (answered) {
        // Whoever asked acts on the answer before anything Pi printed after it.
        this.holding = true;
        setImmediate(() => {
          this.holding = false;
          this.pass();
        });
        return;
      }
    }
  }

  /** True when the record was an answer somebody waited for. */
  private received(record: PiRecord): boolean {
    if (!record || typeof record !== "object") return false;
    if (record.type !== "response") {
      const request = record as PiUiRequest;
      if (request.type === "extension_ui_request" && isDialog(request)) this.listener.dialog(request);
      else this.listener.event(record as PiEvent);
      return false;
    }
    const response = record as PiResponse;
    if (typeof response.id !== "string") {
      // Pi's answer to a line it could not read: the bridge wrote something Pi does not take.
      log.warn("Pi could not read a line the bridge wrote", { command: response.command, error: response.error });
      return false;
    }
    const waiting = this.waiting.get(response.id);
    if (!waiting) {
      log.debug("Pi answered a command nobody waits for any more", { command: response.command });
      return false;
    }
    this.waiting.delete(response.id);
    if (waiting.timer) clearTimeout(waiting.timer);
    if (response.success === false) {
      waiting.reject(new PiRefused(typeof response.error === "string" && response.error !== "" ? response.error : `Pi refused ${waiting.command}.`));
    } else {
      waiting.resolve(response.data);
    }
    return true;
  }

  /** The process is gone: the listener hears it once, and whatever still waits fails with it. */
  private ended(exit: ChildExit): boolean {
    this.exit = exit;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    try {
      this.listener.exited(exit);
    } finally {
      for (const entry of waiting) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new PiGone(exit.reason));
      }
      this.told.resolve();
    }
    return false;
  }
}
