import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cutWhole } from "../../json.ts";
import { log } from "../../log.ts";
import type { ChildExit } from "../child.ts";
import { imageType, skippedImagesText } from "../images.ts";
import type { Warmable, WarmPool } from "../pool.ts";
import { notSignedIn } from "../signIn.ts";
import { titleFrom } from "../titles.ts";
import { SettingRefused, type ModeState, type ModelChangeResult, type Prompt, type ProviderEvent, type ProviderSession, type SessionOptions, type SessionSettings, type SessionSink, type StoredMessage, type ThreadMode } from "../types.ts";
import { PiClient, PiGone, PiRefused } from "./client.ts";
import { realFolder, terminalMayHaveIt } from "./desk.ts";
import { cancelled, dialogAnswer, dialogCard } from "./dialogs.ts";
import { agentFolder, movedSessions, sessionFileId, type PiHistory } from "./history.ts";
import { appLevel, isForkId, modelLevels, piLevel, threadArguments } from "./options.ts";
import type { PiCommand, PiEvent, PiImage, PiModel, PiSessionStats, PiState, PiUiRequest } from "./protocol.ts";
import { PiStream } from "./stream.ts";
import { permissionCommand, permissionModes } from "./permission-extension.ts";

// One Pi thread. It has a process only while it is in use: the first message starts
// `pi --mode rpc --session-id <thread id>` in the thread's folder, later messages go to
// the same process, and the pool cools it after a while idle. Pi keeps the conversation
// in its own session file, so a process started again goes on where the last one
// stopped. Everything Pi prints goes through a `PiStream` and on to the bridge as neutral
// events.
//
// A turn the app starts is one `prompt`, and ends once: when Pi's run settles
// (`agent_settled`), when the `prompt` is answered `handled` with no run under way (an
// extension's command took it), when Pi refuses it, or when the process ends.
//
// Three of Pi's ways shape what follows:
//
// - Pi decides whether it is busy before a run has begun, so a second `prompt` written
//   before the first one's `agent_start` is taken for a new one too and lost. From a
//   turn's `prompt` until its run has begun the thread takes no message (`steerable`),
//   and no `prompt` is written while Pi has not said what became of the one before
//   (a message handed to a turn as it ended may be beginning a run of its own).
// - Pi refuses a bare `prompt` while a run is under way, and ignores `streamingBehavior`
//   when idle. So every `prompt` carries it; one answered `queued` found a run under way
//   and has joined it.
// - Stop is `clear_queue` then `abort`, as Esc is in Pi's terminal. An `abort` that comes
//   before a run has begun is answered and forgotten, and a `prompt` Pi has not answered
//   yet may begin a run once the stopped one has settled. So Stop is for every message
//   handed over before it: one not written yet is not written, and a run Pi begins for
//   one that was is stopped as it begins, also when the turn it was handed to is over
//   by the time Stop comes. And Pi neither settles nor answers `abort` while an
//   extension waits on a dialog, so Stop cancels the dialogs first and never waits for
//   `abort`'s answer.
//
// A thread's session can be opened at the desk too (`pi --session`, `pi --continue`), and
// two Pis that write one session file make branches in it. Two things are looked at
// before anything is written through a process at rest (`beforeWriting`):
//
// - Whether the session file is the size this process left it. It is read when the
//   process is done writing (it started, a run settled, a setting was made), and Pi says
//   what it writes at rest (`entry_appended`), so any other size is somebody else's
//   doing: a Pi at the desk. The process no longer has the conversation as it is, and is
//   let go of; the next one reads the file again.
// - For a session that was started at the desk and continued here (`session.adopt`):
//   whether a Pi runs in a terminal in the thread's folder now. Pi does not say which
//   session a terminal has, so that Pi may have this one: the turn ends with a sentence
//   and nothing is written. A copy the bridge had Pi make (mode `fork`) is the bridge's
//   own and is not asked about, nor is a thread started here.
//
// A turn that ends before it has written anything (refused at that look, or stopped
// while the Mac was asked) writes nothing at its end either: a title, a model or a level
// given meanwhile waits for the next turn, and the file's size is not read again.
//
// A thread taken up only to be read never has a process.

/** What a session needs from its provider. */
export interface PiHost {
  /** The installed `pi`. */
  readonly piPath: string;
  /** Lines for the end of Pi's system prompt (the `portals` command); null for none. */
  readonly instructions: string | null;
  /** What a process starts with in its environment; for a thread's own, which thread it is. */
  environment(thread: string | null): NodeJS.ProcessEnv;
  /** Why no turn can run on the installed Pi (it is too old), as a sentence; null when one can. */
  refusal(): Promise<string | null>;
  readonly pool: WarmPool;
  /** How long a turn may take to end after Stop before its process is stopped. */
  readonly interruptGraceMs: number;
  /** How long Pi has to answer a command. */
  readonly callTimeoutMs: number;
  /** A thread's process named its session file: history reads that one. */
  sessionFile(thread: string, path: string): void;
  /**
   * Whether Pi, come back on the model `now` for a session the thread has on
   * `provider`/`model`, has fallen back from that one for want of a sign-in: it is not
   * on Pi's list, and `now` is the model Pi falls back to. False when Pi gave no list.
   */
  fellBack(provider: string, model: string, now: PiModel): Promise<boolean>;
  /** The thread's conversation as Pi's session file has it now. With `open`, a Pi may be in the middle of a turn on it: a call with no result yet gets no row. */
  history(thread: string, cwd: string, open?: boolean): Promise<PiHistory>;
  /** Whether a Pi runs in a terminal in this folder now. Rejects with a sentence when the Mac cannot be asked. */
  inTerminal(cwd: string): Promise<boolean>;
  forget(session: PiSession): void;
  /** A short name for a thread whose first message is `message`, made off the turn's path; null for none. */
  name(message: string, settings: SessionSettings): Promise<string | null>;
}

interface Dialog {
  request: PiUiRequest;
  /** Withdraws the card. */
  controller: AbortController;
  /** Pi's own time limit for it, mirrored. */
  timer: NodeJS.Timeout | null;
}

/** One process, and what the bridge knows of it. */
interface Live {
  client: PiClient;
  stream: PiStream;
  /** It has answered `get_state`: it is up, and what follows is known of it. */
  ready: boolean;
  mode: ThreadMode | null;
  modeError: string | null;
  /** What Pi runs on now, as it last said. */
  model: PiModel | null;
  /** Its thinking level, in Pi's word. */
  level: string;
  /** Its name for the session. */
  name: string;
  /** Its session file, once it has named it. */
  file: string | null;
  /**
   * The size the session file has if nobody but this process has written it: read when
   * the process was last done writing (it started, a run settled, a setting was made),
   * plus what it has said it wrote at rest since. Null until it is first read.
   */
  size: number | null;
  /** The level last asked for: asked once, whatever Pi made of it. */
  levelAsked: string;
  /** The dialogs that have a card open, by Pi's id. */
  dialogs: Map<string, Dialog>;
  /** The commands (`bash`) running now, by tool call. */
  commands: Set<string>;
  /** The last change of settings, so they go one at a time. */
  settling: Promise<void>;
  /**
   * The last `prompt` written, until Pi has said what became of it and, when that was a
   * run, until the run has begun. The next one is written after it.
   */
  prompting: Promise<void>;
  /** How many messages are on their way: handed over, and Pi has not yet said what became of each, or has not yet begun the run it took one for. */
  onTheWay: number;
  /**
   * Something that writes to the session file (a prompt, `/compact`, a model, a level, a
   * name) was given to this process since the file's size was last read: what the file
   * gained meanwhile may be its own (`exited`).
   */
  unsized: boolean;
  /** Settings given to it that it has not answered yet (`applySettings`): it is not cooled meanwhile. */
  settingsOnTheWay: number;
  /** Whoever waits for the next run to begin. */
  beginWaiters: (() => void)[];
}

type TurnEnd = Extract<ProviderEvent, { type: "turn.end" }>;

/** What Pi answers a `prompt` with: `started`, `queued` or `handled`. */
type PromptAnswer = { disposition?: string } | undefined;

/** A `prompt` that was not written: Stop was asked for after its message was handed over. */
class Unsent extends Error {}

/** A `prompt` Pi never answered, and is not at work on: it never had the message (`promptAnswer`). */
class Unanswered extends Error {}

/** Why a message Pi never answered did not reach it. */
const unansweredText = "Pi never answered this message and is not working on it. Send it again.";

/** Why a thread taken up only to be read starts no process. The bridge refuses its messages before they come this far. */
const onlyRead = "This thread is only for reading, so Pi is not started for it.";

/**
 * A file's size now; 0 for one that is not there (Pi writes a session's at its first
 * message). Read at once and not in a while: it is compared with what one process wrote.
 */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** What every new session's process prints as it starts; not why it stopped. */
const newSessionWarning = /^Warning: No project session found with id /;

/** `/compact`, with whatever follows it as instructions for the summary. */
const compactLine = /^\/compact(?:\s+([\s\S]*))?$/;

/**
 * The instructions of a message that is `/compact` ("" for none); null for any other
 * message. One with images or files is words, as for the session (`isCommand`).
 */
function compactRequest(prompt: Prompt): string | null {
  if (prompt.images.length > 0 || (prompt.files?.length ?? 0) > 0) return null;
  const match = compactLine.exec(prompt.text.trim());
  return match ? (match[1] ?? "").trim() : null;
}

function promptCommand(message: string, images: PiImage[]): PiCommand {
  // Ignored by an idle Pi, and required by one that is in a run.
  return images.length > 0 ? { type: "prompt", message, images, streamingBehavior: "steer" } : { type: "prompt", message, streamingBehavior: "steer" };
}

/** A message Stop cleared, short enough for a notice. */
function quoted(message: string): string {
  const line = message.trim().split("\n")[0] ?? "";
  return `"${line.length > 80 ? `${cutWhole(line, 79).trimEnd()}…` : line}"`;
}

/** What the thread is told of messages that were sent while Pi worked and that a Stop kept from it: the app has no editor to put a message back into. */
function unsentText(messages: string[]): string {
  const one = messages.length === 1;
  return `${one ? "A message was" : `${messages.length} messages were`} not sent, because Pi was stopped before it read ${one ? "it" : "them"}: ${messages.map(quoted).join(", ")}`;
}

/**
 * Why Pi would not run a message, as the thread says it. For a model provider it has no
 * sign-in or key for, what to run on the host, in place of Pi's own words: they name its
 * /login as if typed here and the paths of its docs on the host (Pi 1.5.0, "No API key
 * found for openai." and "Authentication failed for "openai". … Run '/login openai'").
 */
export function refusalText(message: string): string {
  const provider = /^No API key found for (.+?)\.(?:\s|$)/.exec(message)?.[1] ?? /^Authentication failed for "([^"]+)"/.exec(message)?.[1];
  if (provider === undefined) return message;
  return notSignedIn("pi", provider === "the selected model" ? {} : { to: provider });
}

export class PiSession implements ProviderSession, Warmable {
  readonly id: string;
  readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly host: PiHost;
  private readonly stored: StoredMessage[];
  /** Started at the desk and continued here: no turn is written to it while a Pi runs in a terminal in its folder. */
  private readonly fromDesk: boolean;
  /** Taken up only to be read: no process ever starts for it. */
  private readonly readOnly: boolean;
  /** Taken up from the desk, as it was or as a copy: its model and level are the ones Pi has for the session (`comeBack`). */
  private readonly takenUp: boolean;
  /**
   * The model, and the level, were chosen for the thread on the phone since the bridge
   * loaded it. (One chosen before that and never given to Pi is not known as chosen:
   * the thread's record does not say who set what it holds.)
   */
  private modelChosen = false;
  private levelChosen = false;
  /** What the thread is to run on, as the app chose it. */
  private current: SessionSettings;
  private threadMode: ThreadMode;
  /** The level Pi said it runs at, as the app names it; "" until one has said. */
  private reported = "";
  private title: string | null;
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  /** The last process let go of, until it is gone: the next one starts after it. */
  private leaving: Promise<void> = Promise.resolve();
  /** A turn is open, as the bridge sees it. */
  private turnOpen = false;
  /** How many turns have opened, so what was meant for one never acts on the next. */
  private turns = 0;
  /** The open turn's own `prompt` or `compact` is written (a turn Pi began by itself has none to write). */
  private written = false;
  /** That `prompt` is written and Pi has neither begun a run for it nor said what else became of it. */
  private asked = false;
  /** Stop was asked for in the open turn. */
  private stopped = false;
  /** How many times Stop was asked for, so a message handed over before one is neither written nor left to run after it. */
  private stops = 0;
  /** The open turn is a `/compact`, which Pi takes no message during. */
  private compacting = false;
  private stopTimer: NodeJS.Timeout | null = null;
  /** Whoever waits for the run under way to settle. */
  private settleWaiters: (() => void)[] = [];
  /** Pi has a conversation for this thread, as far as the bridge knows. */
  private conversed: boolean;
  /**
   * The session file as the thread's conversation here has it: its size when it was read
   * for the history, or when this thread's own Pi was last done writing it. Another size
   * is somebody else's doing (a Pi at the desk), which the thread does not show yet.
   */
  private known: { file: string; size: number } | null;
  /** A process started for a turn found the file written elsewhere: the conversation here lacks what was written there. */
  private behind = false;
  private warnedOfFile = false;
  /** The thread was removed or the bridge is stopping: no process is started any more. */
  private closed = false;

  constructor(options: SessionOptions, sink: SessionSink, host: PiHost, history: StoredMessage[] = [], read?: { file: string; size: number }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sink = sink;
    this.host = host;
    this.stored = history;
    this.fromDesk = options.desk === true && !isForkId(options.id);
    this.readOnly = options.readOnly === true;
    this.takenUp = options.desk === true;
    this.current = { ...options.settings };
    this.threadMode = options.mode ?? "default";
    this.title = options.title ?? null;
    this.conversed = history.length > 0;
    this.known = read ?? null;
  }

  /** A turn is running, a card is open, a setting is on its way or the process is starting: not to be cooled. */
  get busy(): boolean {
    return this.turnOpen || this.starting !== null || (this.live?.dialogs.size ?? 0) > 0 || (this.live?.settingsOnTheWay ?? 0) > 0;
  }

  async history(): Promise<StoredMessage[]> {
    return structuredClone(this.stored);
  }

  /**
   * Whether a Pi other than the thread's own wrote the session file since the thread's
   * conversation was read, so it does not show what was said there: the thread is then
   * loaded again as it is opened (`SessionManager.refresh`). Only at rest, as anything
   * in hand would be lost; a session file that is gone says nothing.
   */
  async changedElsewhere(): Promise<boolean> {
    if (this.readOnly || this.busy || this.atWork(this.live)) return false;
    if (this.live) await this.live.settling;
    if (this.behind) return true;
    const known = this.known;
    return known !== null && existsSync(known.file) && sizeOf(known.file) !== known.size;
  }

  /**
   * The conversation as Pi's file has it now: a thread only read may go on in a terminal.
   * While a Pi runs in a terminal in the thread's folder it may be in the middle of a
   * turn, and so it may when the Mac cannot be asked: a call that has no result yet is
   * then left out, where in a file at rest it reads as stopped.
   */
  async reload(): Promise<StoredMessage[]> {
    const open = await this.host.inTerminal(this.cwd).catch(() => true);
    return (await this.host.history(this.id, this.cwd, open)).messages;
  }

  /** The model as the thread has it, and the level Pi says it runs at once it has said. */
  settings(): SessionSettings {
    return { ...this.current, reasoningEffort: this.reported || this.current.reasoningEffort };
  }

  // MARK: Turns

  startTurn(prompt: Prompt): void {
    // A turn Pi began by itself may be open (a message handed to the last turn began a
    // run as that turn ended): this one joins it.
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.turns += 1;
      this.stopped = false;
    }
    this.written = false;
    const instructions = compactRequest(prompt);
    this.compacting = instructions !== null;
    void (instructions !== null ? this.compact(instructions) : this.send(prompt));
  }

  /** True once this turn's message was written and Pi is in a run, with neither Stop nor `/compact` under way. */
  steerable(): boolean {
    return this.turnOpen && this.written && !this.stopped && !this.compacting && this.live?.stream.inRun === true;
  }

  /**
   * A message for the running turn. Pi delivers it after the tool calls of the answer it
   * is writing, and settles only once it is answered too. Sent a moment too late it
   * begins a run of its own, which shows as a turn Pi began: this resolves once that
   * turn has begun. False when Pi did not take it: the bridge then answers it in a turn
   * of its own (`refused` when Pi surely never had it: it never went to Pi, or Pi
   * answered it with an error). True also for one a Stop kept from Pi, which is not to be
   * sent again.
   */
  async steer(prompt: Prompt): Promise<boolean | "refused"> {
    const live = this.live;
    if (!live || !this.steerable()) return "refused";
    const { message, images, notices } = this.input(prompt, live);
    const sent = this.prompt(live, message, images);
    try {
      await sent.answer;
    } catch (error) {
      // Pi's error answer to a `prompt` is thrown before it queues the message or begins a
      // run, and an error after it has answered is never answered (Pi 1.1.0's rpc-mode.js
      // and agent-session.js `prompt`, read 2026-10-26): Pi surely never had it. A lost
      // answer (Pi gone) stays uncertain. One never answered, with Pi at rest since, it never had either.
      if (error instanceof PiRefused || error instanceof Unanswered) return "refused";
      if (!(error instanceof Unsent)) return false;
      // Stop came before it was written. It is not sent afterwards either, in a turn of its own: the thread is told.
      this.sink.emit({ type: "notice", level: "warn", text: unsentText([message]) });
      return true;
    }
    for (const text of notices) this.sink.emit({ type: "notice", level: "warn", text });
    this.host.pool.touch(this);
    // Answered `started`, the thread would look at rest until that run begins.
    await sent.begun;
    return true;
  }

  /**
   * Writes a `prompt` once Pi has said what became of the one before: two written before
   * a run has begun would both count as new in Pi. `answer` is Pi's answer. `begun`
   * resolves once nothing more comes of the message unseen: with the answer, or, when
   * that is `started`, when the run has begun (Pi is busy only from then on).
   *
   * A Stop asked for since the message was handed over holds for it too. Still waiting
   * here, it is not written (`Unsent`). Written and not answered, Pi may yet answer it
   * `started` once the stopped run has settled (it reached Pi as the run ended, or an
   * extension held it up): the run Pi begins for it is stopped as it begins.
   */
  private prompt(live: Live, message: string, images: PiImage[]): { answer: Promise<PromptAnswer>; begun: Promise<void> } {
    const stops = this.stops;
    const answer = live.prompting.then(() => {
      if (this.stops !== stops) throw new Unsent("Stop was asked for before the message was written.");
      live.unsized = true;
      return this.promptAnswer(live, message, images);
    });
    live.onTheWay += 1;
    const begun = answer
      .then(
        async (given) => {
          if (given?.disposition !== "started" || this.live !== live) return;
          await this.runBegun(live);
          if (this.stops !== stops && this.live === live && live.stream.inRun) await this.stopBegun(live);
        },
        () => undefined,
      )
      .finally(() => {
        live.onTheWay -= 1;
      });
    live.prompting = begun;
    return { answer, begun };
  }

  /**
   * Writes a `prompt` and resolves with Pi's answer. Pi answers one at once, but for one
   * that reaches it as a run settles: that one waits for the run's `agent_settled`
   * handlers (an extension compacting there), and if it fails then, Pi tells nobody (its
   * issue 10388). Unanswered, it would hold up every message after it (`prompting`). So
   * while it is, Pi is asked how it is each time the time a command has passes: found at
   * rest twice in a row (no run, no compaction, nothing waiting, no card open), it never
   * had the message, and this fails with `Unanswered`. Not for a command (`/name`), which
   * an extension may take its time over.
   */
  private promptAnswer(live: Live, message: string, images: PiImage[]): Promise<PromptAnswer> {
    const lost = new AbortController();
    const answer = live.client.call<PromptAnswer>(promptCommand(message, images), null, lost.signal);
    if (message.trimStart().startsWith("/")) return answer;
    let answered = false;
    let timer: NodeJS.Timeout | null = null;
    let atRest = 0;
    const look = () => {
      timer = setTimeout(async () => {
        timer = null;
        let state: PiState | undefined;
        try {
          state = await live.client.call<PiState>({ type: "get_state" });
        } catch {
          // Gone (which answers the prompt too), or slow to say: looked at again.
        }
        if (answered) return;
        const idle = state !== undefined && state.isStreaming !== true && state.isCompacting !== true && (state.pendingMessageCount ?? 0) === 0 && live.dialogs.size === 0;
        atRest = idle ? atRest + 1 : 0;
        if (atRest < 2) {
          look();
          return;
        }
        log.warn("Pi never answered a message and is at rest: it is taken as not sent", { session: this.id });
        lost.abort(new Unanswered(unansweredText));
      }, this.host.callTimeoutMs);
      timer.unref();
    };
    look();
    return answer.finally(() => {
      answered = true;
      if (timer) clearTimeout(timer);
    });
  }

  private async send(prompt: Prompt): Promise<void> {
    const turn = this.turns;
    if (this.title === null) {
      const title = titleFrom(prompt.text);
      if (title) {
        this.title = title;
        this.sink.emit({ type: "title", title });
        this.nameAfter(title, prompt.text);
      }
    }
    const live = await this.writable(turn);
    if (!live) return;
    const { message, images, notices } = this.input(prompt, live);
    for (const text of notices) this.sink.emit({ type: "notice", level: "warn", text });
    live.stream.beginTurn();
    this.written = true;
    // With a run under way already, this message joins it.
    this.asked = !live.stream.inRun;
    const sent = this.prompt(live, message, images);
    let answer: PromptAnswer;
    try {
      answer = await sent.answer;
    } catch (error) {
      if (!this.mine(turn)) return;
      this.asked = false;
      if (error instanceof Unsent) {
        // Stop came while it waited for the message before it. A run that Stop is ending ends the turn when it settles.
        if (!live.stream.inRun) this.finish(live, "interrupted");
        return;
      }
      // No model, no key, a sign-in that ran out. A process that ended has ended the turn itself.
      if (!(error instanceof PiGone)) this.finish(live, "error", refusalText((error as Error).message));
      return;
    }
    if (!this.mine(turn)) return;
    this.host.pool.touch(this);
    if (answer?.disposition !== "started") {
      this.asked = false;
      // An extension's command, or an input handler, took the message: no run comes of it.
      if (answer?.disposition === "handled" && !live.stream.inRun) this.finish(live, this.stopped ? "interrupted" : "complete");
      return;
    }
    // `started`: the run's `agent_start` is still to come. Pi says nothing when a run
    // fails before it begins, and a turn must end.
    await sent.begun;
    if (this.mine(turn) && this.asked && this.live === live) this.finish(live, this.stopped ? "interrupted" : "error", "Pi took the message and then did not begin to answer it. Send it again.");
  }

  /** Resolves when Pi's next run begins; also when the process ends, or no run has begun in the time a command has. */
  private runBegun(live: Live): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.host.callTimeoutMs);
      timer.unref();
      live.beginWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** `/compact`: Pi summarises the conversation and answers when the summary is written. */
  private async compact(instructions: string): Promise<void> {
    const turn = this.turns;
    // `compact` would abort a run that is under way or beginning (one Pi began by itself,
    // or for a message handed to the last turn as it ended): it is let finish first.
    const live = await this.writable(turn);
    if (!live) return;
    if (live.stream.inRun) await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
    if (!this.mine(turn) || this.live !== live) return;
    live.stream.beginTurn();
    this.written = true;
    live.unsized = true;
    try {
      await live.client.call(instructions === "" ? { type: "compact" } : { type: "compact", customInstructions: instructions });
    } catch (error) {
      if (!this.mine(turn)) return;
      // "Nothing to compact (session too small)", "Already compacted"; cancelled by Stop.
      if (!(error instanceof PiGone)) this.finish(live, this.stopped ? "interrupted" : "error", (error as Error).message);
      return;
    }
    if (this.mine(turn)) this.finish(live, this.stopped ? "interrupted" : "complete");
  }

  /**
   * The process for turn `turn` to write its own message to, once Pi has said what
   * became of the message before it: one handed to the last turn may still be on its way
   * to a run of its own. A process stopped meanwhile under such a run, because the run
   * would not stop (`stopBegun`), is replaced, and the turn writes to the new one. Null
   * as for `ready`.
   */
  private async writable(turn: number): Promise<Live | null> {
    for (;;) {
      // A process whose stop has begun takes nothing more, though its end is not told
      // yet: a message written to it now would go nowhere and count as written. The
      // run it was stopped under may still settle in that moment, which is what lets
      // this turn through to here. Its end is waited for; the turn, unwritten, then
      // writes to a new one.
      const leaving = this.live;
      if (leaving?.ready && !leaving.client.running) {
        await leaving.client.stop();
        if (!this.mine(turn)) return null;
        continue;
      }
      const live = await this.ready(turn);
      if (!live) return null;
      await live.prompting;
      if (!this.mine(turn)) return null;
      if (this.live === live && live.client.running) return live;
    }
  }

  /**
   * The process, started and on the thread's settings, for turn `turn` to write to.
   * Null when there is nothing to write any more: the turn was stopped meanwhile, or it
   * has failed here because Pi could not start or refused the thread's model.
   */
  private async ready(turn: number): Promise<Live | null> {
    try {
      // One too old would never end the turn. A process already up is of a Pi that was checked.
      const refusal = this.live ? null : await this.host.refusal();
      if (refusal !== null) throw new Error(refusal);
      if (!this.mine(turn)) return null;
      await this.beforeWriting(turn);
      if (!this.mine(turn)) return null;
      const live = await this.warm();
      if (!this.mine(turn)) return null;
      await this.applySettings(live);
      await this.applyMode(live, turn);
      // A stopped stray run may have ended this process while mode setup waited for
      // it. writable checks the process and loops to its replacement.
      return this.mine(turn) ? live : null;
    } catch (error) {
      // A process that ended has ended the turn itself (`exited`).
      if (this.mine(turn) && !(error instanceof PiGone)) this.finish(this.live, "error", (error as Error).message);
      return null;
    }
  }

  /**
   * Before anything is written through the thread's process while it is at rest (a
   * turn's message, a setting): the process must still have the conversation as it is,
   * and no Pi at the desk may have the session open.
   *
   * A process whose session file somebody else has written since is let go of: with it
   * Pi would write a branch beside what was written, and the next one reads the file
   * again. For a session continued from the desk, a Pi in a terminal in the thread's
   * folder may have the session open: the process is let go of too (it would not see
   * what that Pi writes), and this fails with the sentence, so nothing is written.
   *
   * Nothing is looked at while Pi is at work for the thread (a run under way, or a
   * message on its way to one): what is written then joins that work, as a message sent
   * while Pi works does. When the Mac cannot be asked about its terminals, this fails
   * with a sentence saying so, and nothing is written.
   *
   * `turn` is the turn this is for; without one it is for a setting made between turns.
   * A look that takes a moment may come back when things have moved on (a turn has
   * begun, or ended): it then lets go of nothing, since the process is that turn's.
   */
  private async beforeWriting(turn?: number): Promise<void> {
    if (this.atWork(this.live)) return;
    const taken = this.fromDesk && (await this.host.inTerminal(this.cwd));
    const live = this.live;
    const stale = live !== null && (taken || (await this.writtenElsewhere(live)));
    const still = turn === undefined ? !this.turnOpen : this.mine(turn);
    if (stale && still && this.live === live && !this.atWork(live)) {
      if (!taken) log.info("a Pi session's file was written by another Pi, so its process starts again", { session: this.id });
      // The next process reads what was written there; the conversation here does not have it.
      if (!taken) this.behind = true;
      await this.letGo(live);
    }
    if (taken) throw new Error(terminalMayHaveIt);
  }

  /** Pi is at work for the thread: a run is under way, or a message is on its way to one. */
  private atWork(live: Live | null): boolean {
    return live !== null && (live.stream.inRun || live.onTheWay > 0);
  }

  /**
   * Whether somebody else has written the session file: it is not the size this process
   * left it. A setting on its way is waited for first, since what it writes is this
   * process's own. (A write of Pi's own that it did not say counts as somebody else's,
   * and costs a new process.)
   */
  private async writtenElsewhere(live: Live): Promise<boolean> {
    await live.settling;
    return live.file !== null && live.size !== null && sizeOf(live.file) !== live.size;
  }

  /** Reads the session file's size as this process leaves it, now that it is done writing. */
  private sized(live: Live): void {
    if (live.file !== null) live.size = sizeOf(live.file);
    live.unsized = false;
    this.knowSize(live);
  }

  /** The file's size as this thread's own Pi left it is the one the conversation here has. */
  private knowSize(live: Live): void {
    if (live.file !== null && live.size !== null && this.live === live) this.known = { file: live.file, size: live.size };
  }

  /**
   * Pi wrote an entry outside a run and said so (an extension's, a cache warming): the
   * file grew by that line. Not while there is no file: Pi keeps a session's entries
   * to itself until its first message, and writes them all then.
   */
  private grew(live: Live, entry: unknown): void {
    if (entry === undefined || live.file === null || live.size === null || live.size === 0) return;
    // Only when the file is that much larger: a reading made since the write has the line in it already.
    const grown = live.size + Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (sizeOf(live.file) === grown) live.size = grown;
    this.knowSize(live);
  }

  /**
   * The process to give a setting to now. Null when there is none, when the one there
   * was has just been let go of (`beforeWriting`), and when nothing may be written now
   * (a Pi at the desk, a Mac that cannot be asked): the setting is then kept, and Pi
   * gets it at the next turn or the next start. During a turn it is the turn's, once
   * the turn has written to it or Pi is at work: a turn still on its way there has not
   * looked yet and may be refused, so until then there is none.
   */
  private async settable(): Promise<Live | null> {
    if (!this.live) return null;
    if (this.turnOpen) return this.written || this.atWork(this.live) ? this.live : null;
    try {
      await this.beforeWriting();
    } catch {
      // A Pi at the desk may have the session, or the Mac could not be asked: nothing is written now.
      return null;
    }
    return this.live;
  }

  /** The turn that `turn` counted is still the open one. */
  private mine(turn: number): boolean {
    return this.turnOpen && this.turns === turn;
  }

  /** The message as Pi takes it: its text, and each image as base64 with its type. */
  private input(prompt: Prompt, live: Live): { message: string; images: PiImage[]; notices: string[] } {
    let images: PiImage[] = [];
    const notices: string[] = [];
    let skipped = 0;
    for (const image of prompt.images) {
      const type = imageType(image.data);
      if (type) images.push({ type: "image", data: image.data.toString("base64"), mimeType: type });
      else skipped += 1;
    }
    if (skipped > 0) notices.push(skippedImagesText(skipped, "Pi"));
    const takes = live.model?.input;
    if (images.length > 0 && Array.isArray(takes) && !takes.includes("image")) {
      notices.push(`${images.length === 1 ? "An image was" : `${images.length} images were`} left out: ${live.model?.name ?? live.model?.id ?? "this model"} takes no images.`);
      images = [];
    }
    return { message: prompt.text, images, notices };
  }

  // MARK: Stop

  async interrupt(): Promise<boolean> {
    if (!this.turnOpen) {
      // A message handed to the last turn may be on its way to a run of its own, and the
      // thread is at work until that run has begun. Pi cannot be told yet (an `abort`
      // before the run is forgotten): the Stop is counted, and holds for that message
      // as for any handed over before one.
      if (!this.live || this.live.onTheWay === 0) return false;
      this.stops += 1;
      return true;
    }
    const live = this.live;
    this.stopped = true;
    this.stops += 1;
    // First, and by the session itself: Pi neither settles nor answers `abort` while an
    // extension waits on a dialog, and the bridge withdraws its cards only after this returns.
    if (live) this.closeDialogs(live, "interrupted");
    if (!live || !(this.written || live.stream.inRun)) {
      // Nothing of this turn has reached Pi (its process is starting): nothing is written
      // for it, now or when the process is up.
      this.stopped = false;
      this.finish(live, "interrupted");
      return true;
    }
    this.halt(live);
    return true;
  }

  /** Stop as Pi takes it, for the open turn: `clear_queue`, then `abort`, and the process stopped if the turn has not ended in time. */
  private halt(live: Live): void {
    this.clearQueue(live);
    // Answered only once Pi has settled, so not waited for.
    this.abort(live);
    const turn = this.turns;
    // A turn Pi does not end is ended by stopping the process, whose end closes it.
    this.stopTimer ??= setTimeout(() => {
      this.stopTimer = null;
      if (!this.mine(turn) || this.live !== live) return;
      log.warn("Pi did not stop in time, so its process is stopped", { session: this.id });
      void live.client.stop();
    }, this.host.interruptGraceMs);
    this.stopTimer.unref();
  }

  /**
   * Stops the run Pi has just begun for a message that was handed over before a Stop
   * (an `abort` written before the run began was answered and forgotten), and resolves
   * once it has settled. The turn that run belongs to ends as stopped: the stopped turn
   * itself, or one Pi began for the run. A turn of the app's that still waits to write
   * its own message was begun after the Stop: it is not stopped, and goes on with that
   * message once the run is out of the way. A run that has not settled in the time a
   * stopped turn has is ended with its process either way; the waiting turn then writes
   * its message to a new one (`exited`, `writable`).
   */
  private stopBegun(live: Live): Promise<void> {
    const settled = new Promise<void>((resolve) => this.settleWaiters.push(resolve));
    if (this.turnOpen && this.written) {
      this.stopped = true;
      this.halt(live);
      return settled;
    }
    this.clearQueue(live);
    this.abort(live);
    // The run is no turn's own, so no turn's end clears this timer: the run's settle does.
    const timer = setTimeout(() => {
      if (this.live !== live) return;
      log.warn("Pi did not stop a run it began for a message from before a Stop, so its process is stopped", { session: this.id });
      void live.client.stop();
    }, this.host.interruptGraceMs);
    timer.unref();
    return settled.then(() => clearTimeout(timer));
  }

  private abort(live: Live): void {
    void live.client.call({ type: "abort" }).catch(() => undefined);
  }

  /**
   * Takes back the messages Pi has queued and not read. What comes back was sent while
   * Pi worked and never reached it: the thread is told, since the app has no editor to
   * put a message back into.
   */
  private clearQueue(live: Live): void {
    void live.client.call<{ steering?: unknown; followUp?: unknown }>({ type: "clear_queue" }).then(
      (queued) => {
        const lost = [queued?.steering, queued?.followUp].flatMap((list) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []));
        if (lost.length > 0 && this.live === live) this.sink.emit({ type: "notice", level: "warn", text: unsentText(lost) });
      },
      () => undefined,
    );
  }

  // MARK: Settings

  mode(): ModeState {
    return { mode: this.threadMode, defaultsTo: "full" };
  }

  async setMode(mode: ThreadMode): Promise<void> {
    if (!(permissionModes as readonly string[]).includes(mode)) throw new SettingRefused("Pi does not offer that mode.");
    this.threadMode = mode;
  }

  /** A mode is given only before the next turn, never while a question card is open. */
  private applyMode(live: Live, turn: number): Promise<void> {
    const stops = this.stops;
    const current = () => this.live === live && this.mine(turn) && this.stops === stops;
    // A stopped initialization still owns its place until Pi answers. The next turn's
    // initialization and every user prompt wait behind it.
    const next = live.prompting.then(async () => {
      try {
        while (current() && live.client.running && live.mode !== this.threadMode) {
          // A late steered message may have begun the previous run. A turn with a
          // different mode waits for it; only a matching mode may join that run.
          if (live.stream.inRun) {
            await new Promise<void>((resolve) => this.settleWaiters.push(resolve));
            continue;
          }
          const listed = await live.client.call<{ commands?: { name?: string; source?: string }[] }>({ type: "get_commands" });
          if (!current() || !live.client.running) return;
          if (live.stream.inRun) continue;
          if (!listed?.commands?.some((command) => command.name === permissionCommand && command.source === "extension")) throw new Error("Pi did not load the permission extension.");
          const mode = this.threadMode;
          live.modeError = null;
          const reply = await live.client.call<PromptAnswer>({ type: "prompt", message: `/${permissionCommand} ${mode}` }, this.host.callTimeoutMs);
          if (live.modeError) throw new Error(live.modeError);
          if (reply?.disposition !== "handled") throw new Error("Pi did not confirm the permission mode.");
          live.mode = mode;
        }
      } catch (error) {
        live.mode = null;
        // A cancelled turn must neither stop nor reconfigure a newer turn.
        if (!current() || !live.client.running) return;
        await this.letGo(live);
        throw new Error(`Pi could not set its permission mode, so no message was sent: ${(error as Error).message}`);
      }
    });
    live.prompting = next.catch(() => undefined);
    return next;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    const before = { current: this.current, chosen: this.modelChosen };
    this.current = { ...this.current, model, provider };
    this.modelChosen = true;
    // Pi could switch between two steps of a run; the change waits for the turn's end.
    if (this.live && this.turnOpen) return { deferred: true };
    const live = await this.settable();
    if (!live) {
      // Kept for the next start; what Pi said of the level was for the model before.
      // (With a process still up and nothing written to it now, Pi's word on the level stands.)
      if (!this.live) this.reported = "";
      return { deferred: false };
    }
    try {
      await this.applySettings(live);
    } catch (error) {
      // Pi refused it: the thread is on what it was on, by whoever's choice that was.
      this.current = before.current;
      this.modelChosen = before.chosen;
      throw error;
    }
    return { deferred: false };
  }

  async setReasoning(level: string): Promise<void> {
    this.current = { ...this.current, reasoningEffort: level };
    this.levelChosen = true;
    const live = await this.settable();
    if (!live) {
      if (!this.live) this.reported = "";
      return;
    }
    if (!this.turnOpen) await this.applySettings(live);
  }

  /**
   * Names the thread, titled `first` from its first message `text`, with a short name Pi
   * makes (`PiHost.name`), once it comes. A thread renamed meanwhile (in the app, at the
   * desk) keeps its name, as does one closed.
   */
  private nameAfter(first: string, text: string): void {
    void this.host
      .name(text, { ...this.current })
      .then(async (name) => {
        if (!name || name === first || this.closed || this.title !== first) return;
        await this.rename(name);
        this.sink.emit({ type: "title", title: name });
      })
      .catch((error: Error) => log.warn("could not name a Pi thread", { thread: this.id, error: error.message }));
  }

  /** Pi is given the new name at once when its process runs, else when it next starts. */
  async rename(title: string): Promise<void> {
    this.title = title;
    const live = await this.settable();
    // The model and the level wait for a running turn to end; the name need not.
    if (live?.ready) await this.applySettings(live, this.turnOpen);
  }

  /**
   * Makes Pi's model, level and session name the thread's, where they differ; with
   * `nameOnly`, the name alone. One change at a time.
   */
  private applySettings(live: Live, nameOnly = false): Promise<void> {
    const sent = { any: false };
    // Not cooled under it: cooling would cut the setting off and lose what Pi wrote for it
    // as this process's own (Codex's re-check of 88e7bce6).
    live.settingsOnTheWay += 1;
    // What Pi wrote for it is this process's own writing. With nothing given to Pi the
    // file is not measured: a size read again for nothing would pass what another Pi
    // wrote meanwhile for this process's own.
    const next = live.settling
      .then(() => this.apply(live, nameOnly, sent))
      .finally(() => {
        live.settingsOnTheWay -= 1;
        if (sent.any) this.sized(live);
      });
    live.settling = next.catch(() => undefined);
    return next;
  }

  /** `sent.any` is set once anything is given to Pi, whatever Pi answers. */
  private async apply(live: Live, nameOnly: boolean, sent: { any: boolean }): Promise<void> {
    if (!nameOnly) {
      const { model, provider } = this.current;
      // Provider and id: Pi may list one id under two providers.
      const moved = model !== "" && (live.model?.id !== model || live.model?.provider !== provider);
      if (moved) {
        sent.any = true;
        live.unsized = true;
        // Refused with Pi's sentence: "Model not found: …", "No API key for …".
        live.model = await live.client.call<PiModel>({ type: "set_model", provider, modelId: model });
        // Another model, another window: the ring is said again against it.
        this.askStats(live);
      }
      // Pi may move the level when the model changes, so the thread's is given again.
      const level = piLevel(this.current.reasoningEffort, modelLevels(live.model ?? {}));
      if (level !== null && (moved || (level !== live.level && level !== live.levelAsked))) {
        live.levelAsked = level;
        sent.any = true;
        live.unsized = true;
        await live.client.call({ type: "set_thinking_level", level });
      }
    }
    if (this.title && this.title !== live.name) {
      const name = this.title;
      sent.any = true;
      live.unsized = true;
      try {
        await live.client.call({ type: "set_session_name", name });
        live.name = name;
      } catch (error) {
        if (error instanceof PiGone) throw error;
        // Asked again at the next change; a thread works without its name.
        log.warn("Pi did not take the thread's title as the session's name", { session: this.id, error: (error as Error).message });
      }
    }
  }

  // MARK: The process

  private warm(): Promise<Live> {
    // While it starts, everything waits for it.
    if (this.starting) return this.starting;
    if (this.live) return Promise.resolve(this.live);
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Live> {
    if (this.readOnly) throw new Error(onlyRead);
    if (this.fromDesk) {
      // As when it was taken up (`PiProvider.adopt`): Pi finds a session by the real path
      // it runs in, and started where a link leads it would begin an empty one under this id.
      const folder = await realFolder(this.cwd);
      if (folder !== this.cwd) throw new Error(`This session's folder, ${this.cwd}, now leads to ${folder}, where Pi would not find the session, so nothing was sent to it.`);
    }
    // Never two processes of the bridge's on one session file.
    await this.leaving;
    if (this.closed) throw new PiGone("The thread was closed before Pi started.");
    let live: Live;
    const client = new PiClient({
      command: this.host.piPath,
      args: threadArguments(this.id, this.host.instructions, agentFolder(this.host.environment(null))),
      env: { ...this.host.environment(this.id), PORTALS_PI_PERMISSION_MODE: "default" },
      cwd: this.cwd,
      timeoutMs: this.host.callTimeoutMs,
      listener: {
        event: (record) => this.event(live, record),
        dialog: (request) => this.dialog(live, request),
        exited: (exit) => this.exited(live, exit),
      },
    });
    live = {
      client,
      stream: new PiStream({
        cwd: this.cwd,
        unknown: (type) => log.info("Pi printed a record the bridge does not know", { session: this.id, type }),
        progress: (event) => this.sink.emit(event),
      }),
      ready: false,
      mode: "default",
      modeError: null,
      model: null,
      level: "",
      name: "",
      file: null,
      size: null,
      levelAsked: "",
      dialogs: new Map(),
      commands: new Set(),
      settling: Promise.resolve(),
      prompting: Promise.resolve(),
      onTheWay: 0,
      unsized: false,
      settingsOnTheWay: 0,
      beginWaiters: [],
    };
    this.live = live;
    this.host.pool.warmed(this);

    let state: PiState;
    try {
      // Its answer says Pi is up, and what it runs on.
      state = (await client.call<PiState>({ type: "get_state" })) ?? {};
    } catch (error) {
      if (error instanceof PiGone) throw error;
      await this.letGo(live);
      throw new Error(`Pi started but did not say what it runs on, so it was stopped: ${(error as Error).message}`);
    }
    // Closed or cooled while it started.
    if (this.live !== live) throw new PiGone("Pi was stopped while it started.");
    if (state.sessionId !== this.id) {
      await this.letGo(live);
      throw new Error(`Pi opened another session than this thread's (${String(state.sessionId)}), so it was stopped.`);
    }
    live.model = state.model ?? null;
    live.level = state.thinkingLevel ?? "";
    live.name = state.sessionName ?? "";
    this.reported = appLevel(live.level) || this.reported;
    if (typeof state.sessionFile === "string" && state.sessionFile !== "") {
      live.file = state.sessionFile;
      // A file another Pi wrote since the conversation here was read: this process has
      // what was written there, and the conversation here does not.
      const known = this.known;
      if (known !== null && known.file === live.file && sizeOf(live.file) !== known.size) this.behind = true;
      // At once: Pi has read the file by now, and what is written to it from here on by another is not in this process.
      this.sized(live);
      this.noteFile(state.sessionFile);
    }
    if (this.takenUp) {
      // Before the process counts as up: a turn that ends meanwhile gives Pi nothing of the thread's yet.
      await this.comeBack(live);
      if (this.live !== live) throw new PiGone("Pi was stopped while it started.");
    }
    live.ready = true;
    const messages = state.messageCount ?? 0;
    if (messages === 0 && this.conversed) {
      this.sink.emit({ type: "notice", level: "warn", text: "Pi no longer has this thread's earlier conversation (its session file is gone), so it starts again from here." });
    }
    this.conversed = messages > 0;
    // A thread taken up again shows how full its context is before its first reply.
    this.askStats(live);
    log.info("Pi session started", { session: this.id, model: `${live.model?.provider ?? "?"}/${live.model?.id ?? "?"}`, resumed: messages > 0 });
    return live;
  }

  /**
   * A session taken up from the desk comes back on the model and the level Pi has for
   * it, and those are the thread's. What the thread was given when it was taken up was
   * read from the session file by a simpler rule than Pi's own (Pi goes by the branch
   * the session was left on, and keeps a router it was put on over the model that
   * answered last), so it is not held against Pi.
   *
   * Not when one was chosen for the thread on the phone: that is given to Pi as for any
   * thread. And not when Pi has fallen back from the thread's model for want of a
   * sign-in (a key the bridge's environment lacks; Pi does not say so in this mode, so
   * it is told by the model being off Pi's list and Pi being on its default): the
   * thread's is kept, so that Pi refuses it by name and the turn fails saying so,
   * rather than going on with a model nobody chose.
   */
  private async comeBack(live: Live): Promise<void> {
    const model = live.model;
    const differs = typeof model?.id === "string" && typeof model.provider === "string" && (model.id !== this.current.model || model.provider !== this.current.provider);
    if (differs && !this.modelChosen) {
      const kept = this.current.model !== "" && (await this.host.fellBack(this.current.provider, this.current.model, model!));
      // Chosen while Pi was asked: that one stands.
      if (!kept && !this.modelChosen) this.current = { ...this.current, model: model!.id!, provider: model!.provider! };
    }
    if (!this.levelChosen && appLevel(live.level) !== "") this.current = { ...this.current, reasoningEffort: appLevel(live.level) };
  }

  /** Remembers where Pi keeps the session, and says so once when it is not where history would look. */
  private noteFile(path: string): void {
    this.host.sessionFile(this.id, path);
    const env = this.host.environment(null);
    // Under Pi's own folder, by working folder; or all in the one folder the environment names.
    const where = dirname(dirname(path)) === join(agentFolder(env), "sessions") || dirname(path) === movedSessions(env, this.cwd);
    const usual = where && sessionFileId(basename(path)) === this.id;
    if (usual || this.warnedOfFile) return;
    this.warnedOfFile = true;
    log.warn("Pi keeps this thread's session where the bridge does not look after a restart, so its history will be missing then", { session: this.id, file: path });
  }

  /** How full the context is, asked and not waited for. */
  private askStats(live: Live): void {
    void live.client.call<PiSessionStats>({ type: "get_session_stats" }).then(
      (stats) => {
        if (this.live === live) this.report(live, live.stream.stats(stats));
      },
      () => undefined,
    );
  }

  // MARK: From Pi

  private event(live: Live, record: PiEvent): void {
    if (this.live !== live) return;
    // Pi answers an extension command as handled even when its handler threw.
    if (record.type === "extension_error" && record.extensionPath === `command:${permissionCommand}`) live.modeError = record.error ?? "The permission command failed.";
    const events = live.stream.map(record);
    const settled = record.type === "agent_settled";
    for (const event of events) {
      // A run Pi began by itself settled while this turn's own message was still to be
      // written: the turn goes on with that message.
      if (event.type === "turn.end" && settled && this.turnOpen && !this.written && !this.stopped) continue;
      this.reportOne(live, event);
    }
    switch (record.type) {
      case "agent_start":
        this.asked = false;
        this.conversed = true;
        this.host.pool.touch(this);
        for (const wake of live.beginWaiters.splice(0)) wake();
        break;
      case "agent_settled":
        live.commands.clear();
        for (const wake of this.settleWaiters.splice(0)) wake();
        // The run's entries are written: the file is as this process leaves it.
        this.sized(live);
        break;
      case "entry_appended":
        // During a run it is read once the run has settled.
        if (!live.stream.inRun) this.grew(live, record.entry);
        break;
      case "turn_end":
        // One answer and its tool calls are done: the context has grown.
        this.askStats(live);
        break;
      case "thinking_level_changed":
        if (typeof record.level === "string") {
          live.level = record.level;
          this.reported = appLevel(record.level) || this.reported;
        }
        break;
      case "tool_execution_start":
        if (record.toolName === "bash" && typeof record.toolCallId === "string") live.commands.add(record.toolCallId);
        break;
      case "tool_execution_end":
        if (typeof record.toolCallId === "string") live.commands.delete(record.toolCallId);
        break;
      default:
        break;
    }
  }

  private report(live: Live, events: ProviderEvent[]): void {
    for (const event of events) this.reportOne(live, event);
  }

  private reportOne(live: Live, event: ProviderEvent): void {
    switch (event.type) {
      case "turn.begin":
        // While a turn of the app's is open, a run Pi begins is part of it.
        if (this.turnOpen) return;
        this.turnOpen = true;
        this.turns += 1;
        this.stopped = false;
        this.written = true;
        this.sink.emit(event);
        this.host.pool.touch(this);
        return;
      case "turn.end":
        this.endTurn(event);
        return;
      case "title":
        // The name the bridge gave Pi comes back as Pi's own news.
        live.name = event.title;
        if (event.title === this.title) return;
        this.title = event.title;
        this.sink.emit(event);
        return;
      default:
        this.sink.emit(event);
    }
  }

  /**
   * Ends the open turn, with the tools still open closed as stopped; `last` is said
   * after them and before the end. Nothing when no turn is open.
   */
  private finish(live: Live | null, status: TurnEnd["status"], error?: string, last?: ProviderEvent): void {
    if (!this.turnOpen) return;
    // Before anything of the turn was written, the stream has no turn to end.
    const usage = live?.stream.usage ? { usage: live.stream.usage } : {};
    const bare: TurnEnd = status === "error" ? { type: "turn.end", status, error: error ?? "Pi stopped with an error.", retryable: true, ...usage } : { type: "turn.end", status, ...usage };
    const events = live?.stream.inTurn ? live.stream.finish(status, error) : [bare];
    if (last) events.splice(-1, 0, last);
    for (const event of events) {
      if (event.type === "turn.end") this.endTurn(event);
      else this.sink.emit(event);
    }
  }

  private endTurn(event: TurnEnd): void {
    if (!this.turnOpen) return;
    const stopped = this.stopped;
    const wrote = this.written;
    this.turnOpen = false;
    this.written = false;
    this.asked = false;
    this.stopped = false;
    this.compacting = false;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    const live = this.live;
    // A card still open can no longer be answered: the bridge withdraws it with the turn.
    if (live) this.closeDialogs(live, "ended");
    // Cancelling a permission card can let Pi settle before it reads abort.
    this.sink.emit(stopped && event.status === "complete" ? { ...event, status: "interrupted" } : event);
    this.host.pool.touch(this);
    // One still starting takes the thread's settings when the next turn writes to it.
    if (!live?.ready) return;
    // A message Pi queued behind the stop would sit in an idle Pi and come out of order inside the next turn.
    if (stopped) this.clearQueue(live);
    // A turn that ended before it wrote anything (refused at the look, or stopped during
    // it) writes nothing now either: what was changed meanwhile waits for the next turn,
    // which looks first, and the file's size stays as this process left it.
    if (!wrote) return;
    // The file is as this process leaves it (a `/compact`, an extension's command).
    this.sized(live);
    // What was changed while the turn ran is made now. A model Pi refuses fails the turn that would start on it.
    this.applySettings(live).catch((error: Error) => {
      if (!(error instanceof PiGone)) log.warn("could not change a Pi thread's model, level or name after its turn", { session: this.id, error: error.message });
    });
  }

  // MARK: Dialogs

  /** What an extension asks is a card on the phone, and the card's answer goes back to Pi. */
  private dialog(live: Live, request: PiUiRequest): void {
    const id = request.id!;
    const card = dialogCard(request);
    // After Stop nothing more is asked: a run that waits on a dialog does not stop.
    if (this.live !== live || !card || (this.turnOpen && this.stopped)) {
      live.client.answer(cancelled(id));
      return;
    }
    const entry: Dialog = { request, controller: new AbortController(), timer: null };
    live.dialogs.set(id, entry);
    if (typeof request.timeout === "number" && request.timeout > 0) {
      // Pi settles it itself when the time is up, and says nothing: the card goes with it.
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (live.dialogs.get(id) !== entry) return;
        live.dialogs.delete(id);
        entry.controller.abort("timeout");
        this.host.pool.touch(this);
      }, request.timeout);
      entry.timer.unref();
    }
    this.host.pool.touch(this);
    void this.sink.ask(card, entry.controller.signal).then(
      (answer) => {
        // Settled already: its time ran out, Stop cancelled it, or the process ended.
        if (live.dialogs.get(id) !== entry) return;
        live.dialogs.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        // A card dismissed, or closed by its turn's end, cancels the dialog.
        live.client.answer(dialogAnswer(request, answer));
        this.host.pool.touch(this);
      },
      () => undefined,
    );
  }

  /**
   * Withdraws every open card: for Stop (`interrupted`), at a turn's end (`ended`), or
   * because the process is gone (`gone`). Pi is told each dialog is cancelled, unless it
   * is gone. One with a time limit that is still open when its turn ends has run out in
   * Pi, a moment before it would have here: Pi has settled that one itself.
   */
  private closeDialogs(live: Live, why: "interrupted" | "ended" | "gone"): void {
    for (const [id, entry] of [...live.dialogs]) {
      live.dialogs.delete(id);
      const ranOut = why === "ended" && entry.timer !== null;
      if (entry.timer) clearTimeout(entry.timer);
      if (why !== "gone" && !ranOut) live.client.answer(cancelled(id));
      entry.controller.abort(why === "interrupted" ? "interrupted" : ranOut ? "timeout" : "withdrawn");
    }
  }

  // MARK: The process's end, cooling and closing

  private exited(live: Live, exit: ChildExit): void {
    this.closeDialogs(live, "gone");
    for (const wake of live.beginWaiters.splice(0)) wake();
    // One the session let go of itself (cooled, closed, no use): whoever did says what follows.
    if (this.live !== live) return;
    // Ended with something given it to write since the file was last measured (a prompt,
    // a setting), or at work: what it wrote before it ended is its own, not a desk's, and
    // the conversation here tells of it (a turn it died in, as failed), so it is not loaded
    // again for it (Codex's review of a6e4bd2c). Ended with nothing given it since (at
    // rest, or a turn still waiting to write), it had written all it said it did: a larger
    // file then is somebody else's (Codex's re-checks of 112091df, 989e97d8 and 47d8c47e).
    // The turn's own prompt or `/compact` given to it counts however much was measured
    // since (a setting's end in between measures the file too: Codex's re-check of 88e7bce6).
    if (live.unsized || this.atWork(live) || (this.turnOpen && this.written)) this.sized(live);
    this.live = null;
    this.host.pool.cooled(this);
    const waiters = this.settleWaiters.splice(0);
    if (!this.turnOpen) {
      // An extension may ask Pi to shut down. The next message starts it again.
      log.info("a Pi session's process ended between turns", { session: this.id, reason: exit.reason });
    } else if (exit.asked && !this.written && !this.stopped) {
      // Stopped under a run that would not stop, one Pi began for a message from before
      // a Stop (`stopBegun`), while this turn waits to write its own message. The rows
      // that run left open close as stopped, and the turn goes on: `writable` starts
      // a process for it.
      for (const event of live.stream.finish("interrupted")) {
        if (event.type !== "turn.end") this.sink.emit(event);
      }
    } else if (this.stopped || exit.asked) {
      // Stopped for a Stop that Pi did not obey in time, or gone on its own after one.
      this.finish(live, "interrupted");
    } else if (exit.error !== null) {
      // A folder that is gone fails the start the same way a missing program does.
      const why = existsSync(this.cwd) ? `Check pi.path in config.json.` : `The thread's folder, ${this.cwd}, is no longer there.`;
      this.finish(live, "error", `Pi could not be started at ${this.host.piPath} (${exit.error}). ${why}`);
    } else {
      let message = `Pi stopped unexpectedly (${exit.signal ?? `exit code ${exit.code}`})`;
      // Its last words say why, as far as anything does.
      if (exit.lastWords && !newSessionWarning.test(exit.lastWords)) message += `: ${exit.lastWords}`;
      if (!/[.!?]$/.test(message)) message += ".";
      // Pi ends a command only in its own orderly exit.
      if (live.commands.size > 0) message += " A command it was running may still be running.";
      log.warn("a Pi session's process ended during a turn", { session: this.id, reason: exit.reason });
      this.finish(live, "error", message, { type: "error", message });
    }
    for (const wake of waiters) wake();
  }

  async cool(): Promise<void> {
    const live = this.live;
    if (!live || this.busy) return;
    log.info("Pi session went cold", { session: this.id });
    await this.letGo(live);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    // A run still going (the bridge is stopping) is stopped first, as Stop stops one, its
    // dialogs answered as cancelled so that Pi can settle: killed under it, Pi stored only
    // the message, and after the restart nothing showed the turn had been cut; stopped,
    // it stores the reply it was writing as stopped (history.ts reads it so). Its settling
    // is waited for a second at most, within the six seconds closing gives the sessions.
    const live = this.live;
    if (live && this.turnOpen && live.stream.inRun) {
      const settled = new Promise<void>((resolve) => this.settleWaiters.push(resolve));
      this.closeDialogs(live, "interrupted");
      this.abort(live);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1000)))]);
      clearTimeout(timer);
    }
    if (this.live) await this.letGo(this.live);
    // One that was being stopped already (cooled a moment ago) is gone too.
    await this.leaving;
    this.host.forget(this);
  }

  /** Stops a process the session has no more use for. The session stays, cold, and starts one again when needed. */
  private letGo(live: Live): Promise<void> {
    if (this.live === live) this.live = null;
    this.host.pool.cooled(this);
    this.closeDialogs(live, "gone");
    this.leaving = live.client.stop();
    return this.leaving;
  }
}
