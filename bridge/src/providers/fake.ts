import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SearchFile } from "../search/readers.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { withoutFromLine } from "../fleet/line.ts";
import { askedRowArgs } from "../sessions/answers.ts";
import { splitFiles } from "../sessions/files.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";
import { BackgroundCommands } from "./backgroundCommands.ts";
import { playBench } from "./fakeBench.ts";
import { LiveOutput } from "./liveOutput.ts";
import { makePictures, picturesReply } from "./fakePictures.ts";
import { visualReply } from "./fakeVisuals.ts";
import { storedUserText, Transcript } from "../sessions/transcript.ts";
import type {
  AgentProfile,
  AgentRequest,
  ApprovalOption,
  ModelCatalog,
  ModelChangeResult,
  ModeOption,
  ModeState,
  Prompt,
  Provider,
  ProviderEvent,
  ProviderSession,
  SessionOptions,
  SessionSettings,
  SessionSink,
  SubagentInfo,
  StoredMessage,
  ThreadMode,
  UsageReport,
} from "./types.ts";

// A scripted agent for testing the bridge and the app without a real one. It runs
// nothing and touches no files: its tool calls, diffs and command output are made up.
//
// It replies word by word. Words in the prompt (or words starting with them: "slowly",
// "tools") add steps, in this order:
//   fail     the turn fails at once
//   think    reasoning first
//   tool     an edit with a diff, then a command and its output
//   diff     changes four files, as a turn that changes several does: edits two (one
//            of them twice), adds one and deletes one (feature turn_diff)
//   approve  asks to run a command and waits for the answer
//   ask      asks a question and waits for the answer
//   slow     a long reply, slowly, to try interrupting and reconnecting
//   bench    a minute-long reply like a real agent's, for measuring the app
//            (fakeBench.ts); with `instant`, the same reply at once; with
//            `coarse`, in half as many pieces; with `whole`, its text as one long
//            answer with no tool calls between
//   visual   a reply with a visual in it (fakeVisuals.ts says which), four times
//            as fast
//   steps    work under way as an agent does it, for the app's one line for it:
//            a thought that streams, a command, three searches at once, another
//            thought, a read, a last thought, an edit, then the reply (workUnderWay);
//            with `bursts`, its thoughts come as real agents often send them: the
//            first in bursts of about seventy characters, the second whole at once
//   todos    work with a to-do list, for the status line's headline and the list under
//            it: a to-do list written as Claude Code writes one (`content`, `status`,
//            `activeForm`) and moved on as each step ends, thoughts that open with a bold
//            title as a GPT model's do, and a summary of a run of calls as Claude Code
//            sends one (`headline`, feature status_headline), each step a few seconds long
//            (workWithTodos)
//   liveoutput  a command that prints fast, about fifty lines a second for thirty
//            seconds (with `brief`, three), its output live (`tool.progress`)
//   bgcommand  a command left running in the background as the turn ends: a row of
//            the subagents line printing a line every half second for twenty seconds
//            (with `brief`, three; with `long`, ten minutes), with Stop (feature
//            background_commands)
//   crew     what sits at the foot of a chat, started out of order: a command left
//            running, a subagent with a subagent of its own, a workflow of three
//            agents in two phases, and a subagent that soon finishes. The agents work
//            on for thirty seconds after the turn, the workflow for forty-five, the
//            command for ninety (with `brief`, three, four and a half and nine; with
//            `long`, ten, fifteen and thirty minutes), so the thread is left with the
//            command alone; each but the finished one has a Stop
//   droid-parity  a deterministic Droid activity/checklist script, only when enabled
//            by FakeOptions.droidParity; add `ask` for its two required questions
//            or `approval` / `plan` for rich requests (`limited` offers only once/no)
//
// It keeps its conversations in `state/fake/<id>.json`, the way a real agent keeps its
// own history, so they survive a restart of the bridge.

export interface FakeOptions {
  /** Where conversations are kept. */
  directory: string;
  /** The pause between words; `slow` uses eight times this. */
  delayMs: number;
  /** The agent's name, "fake" unless a bench lists it under several (`fake.agents`). */
  name?: string;
  /** Offer Droid's mode metadata and parity script, without changing the usual fake. */
  droidParity?: boolean;
  /** Say how much of a plan is used (`/usage`, `usage.read`), as Claude Code does, for trying the app's panel. */
  usage?: boolean;
}

const models = ["fake-1", "fake-2"];
const droidModes: ModeOption[] = [
  { id: "ask", label: "Off", description: "Asks before changes and commands that Droid's rules do not already allow." },
  { id: "edits", label: "Low", description: "File edits and low-risk commands can run without asking." },
  { id: "medium", label: "Medium", description: "Reversible development actions can run without asking. Droid can still ask for approval." },
  { id: "full", label: "High", description: "High-risk actions can run without asking, subject to Droid's safety rules. This is not unsafe permission bypass." },
  { id: "plan", label: "Spec", description: "Plans first and waits for your approval before implementation." },
  { id: "default", label: "Default", description: "Inherits your Droid CLI settings." },
];

export class FakeProvider implements Provider {
  readonly profile: AgentProfile;

  private readonly options: FakeOptions;

  /** The name of the `index`th scripted agent (from 1): fake, fake-2, fake-3… */
  static nameFor(index: number): string {
    return index === 1 ? "fake" : `fake-${index}`;
  }

  /** With `FakeOptions.usage` only, so the usual fake offers no `/usage`. */
  readonly usage?: (thread: string) => Promise<UsageReport>;

  constructor(options: FakeOptions) {
    this.options = options;
    if (options.usage) {
      this.usage = async () => {
        const now = Math.floor(Date.now() / 1000);
        return {
          plan: "max",
          limits: [
            { name: "5-hour", percent: 42, resetsAt: now + 2 * 3600 + 17 * 60, windowSeconds: 5 * 3600 },
            { name: "weekly", percent: 18, resetsAt: now + 4 * 86400, windowSeconds: 7 * 86400 },
            { name: "weekly Opus", percent: 70, resetsAt: now + 4 * 86400, windowSeconds: 7 * 86400 },
          ],
        };
      };
    }
    const name = options.name ?? "fake";
    this.profile = {
      name,
      kind: "fake",
      displayName: name === "fake" ? "Fake agent" : `Fake agent ${name.slice("fake-".length)}`,
      description: "A scripted agent for testing the bridge. It runs nothing and changes no files.",
      model: "fake-1",
      provider: "fake",
    };
  }

  async models(): Promise<ModelCatalog> {
    return {
      providers: [{ slug: "fake", name: "Fake", models }],
      model: this.profile.model,
      provider: this.profile.provider,
      reasoning: "medium",
    };
  }

  async startSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const session = new FakeSession(options, sink, this.options, { messages: [], titled: false });
    session.save();
    return session;
  }

  async resumeSession(options: SessionOptions, sink: SessionSink): Promise<ProviderSession> {
    const stored = readJSON<StoredConversation>(fileFor(this.options.directory, options.id), { messages: [], titled: false });
    return new FakeSession(options, sink, this.options, stored);
  }

  /** Its own record of the thread's conversation (feature thread_search). */
  async searchFile(thread: { id: string; cwd: string }): Promise<SearchFile | null> {
    const path = fileFor(this.options.directory, thread.id);
    return existsSync(path) ? { path, format: "stored" } : null;
  }
}

/** A separate fixture so existing fake subclasses and mode tests keep their contract. */
export class DroidParityFakeProvider extends FakeProvider {
  readonly supportsModes = true;
  readonly modeOptions = droidModes;

  constructor(options: FakeOptions) {
    super({ ...options, droidParity: true });
  }

  defaultMode(): "medium" {
    return "medium";
  }

  override async models(): Promise<ModelCatalog> {
    const catalog = await super.models();
    return { ...catalog, providers: [{ slug: "fake", name: "Fake", models: ["default", ...models] }] };
  }
}

interface StoredConversation {
  messages: StoredMessage[];
  titled: boolean;
}

/** The stored row of questions asked without waiting, as Codex's history has it before a message answers them. */
const unansweredResult = { responses: [], unanswered: true };

function fileFor(directory: string, id: string): string {
  return join(directory, `${id}.json`);
}

/** Stops a step when the turn is interrupted. */
class Interrupted extends Error {}

class FakeSession implements ProviderSession {
  readonly mode?: () => ModeState;
  readonly setMode?: (mode: ThreadMode) => Promise<void>;
  private readonly id: string;
  private readonly cwd: string;
  private readonly sink: SessionSink;
  private readonly options: FakeOptions;
  private readonly transcript: Transcript;
  private current: SessionSettings;
  private currentMode: ThreadMode;
  private titled: boolean;
  private turn: AbortController | null = null;
  private nextTool = 1;
  private readonly live: LiveOutput;
  private readonly commands: BackgroundCommands;
  private readonly commandTimers = new Map<string, NodeJS.Timeout>();
  /** What each of the crew's agents did, by its id (`subagentMessages`). */
  private readonly crewMessages = new Map<string, StoredMessage[]>();
  /** The crew's agents and workflow still at work (`startCrew`): the timer that ends each, and Stop, which ends it stopped. */
  private readonly crew = new Map<string, { timer: NodeJS.Timeout; stop: () => void }>();

  constructor(options: SessionOptions, sink: SessionSink, fakeOptions: FakeOptions, stored: StoredConversation) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.sink = sink;
    this.options = fakeOptions;
    this.current = { ...options.settings };
    this.currentMode = options.mode ?? "default";
    if (fakeOptions.droidParity) {
      this.mode = () => ({ mode: this.currentMode, options: droidModes, defaultsTo: "medium" });
      this.setMode = async (mode) => { this.currentMode = mode; };
    }
    this.transcript = new Transcript(stored.messages);
    this.titled = stored.titled;
    this.live = new LiveOutput((event) => this.emit(event));
    this.commands = new BackgroundCommands((event) => this.sink.emit(event));
  }

  async history(): Promise<StoredMessage[]> {
    // A copy: the bridge keeps its own from here on. Questions asked without waiting read
    // back as Codex's do (./codex/history.ts): unanswered, or answered once a message of
    // the person's came after them.
    const messages = structuredClone(this.transcript.messages);
    let asked: StoredMessage | undefined;
    for (const message of messages) {
      if (message.role === "tool" && message.name === "clarify" && message.content === JSON.stringify(unansweredResult)) asked = message;
      else if (message.role === "user") {
        if (asked?.role === "tool") asked.content = "null";
        asked = undefined;
      }
    }
    return messages;
  }

  settings(): SessionSettings {
    return { ...this.current };
  }

  startTurn(prompt: Prompt): void {
    if (this.turn) throw new Error("The fake agent is already running a turn.");
    const turn = new AbortController();
    this.turn = turn;
    this.transcript.startTurn(storedUserText(prompt));
    void this.run(prompt, turn.signal).finally(() => {
      this.turn = null;
      this.save();
    });
  }

  async interrupt(): Promise<boolean> {
    if (!this.turn) return false;
    this.turn.abort("interrupted");
    return true;
  }

  async setModel(model: string, provider: string): Promise<ModelChangeResult> {
    this.current = { ...this.current, model, provider };
    return { deferred: this.turn !== null };
  }

  async setReasoning(level: string): Promise<void> {
    this.current = { ...this.current, reasoningEffort: level };
  }

  async close(): Promise<void> {
    this.turn?.abort("interrupted");
    for (const timer of this.commandTimers.values()) clearInterval(timer);
    this.commandTimers.clear();
    for (const { timer } of this.crew.values()) clearTimeout(timer);
    this.crew.clear();
    this.commands.close();
    this.live.clear();
  }

  async stopSubagent(id: string): Promise<boolean> {
    const member = this.crew.get(id);
    if (member) {
      member.stop();
      return true;
    }
    const timer = this.commandTimers.get(id);
    if (!timer || !this.commands.running(id)) return false;
    clearInterval(timer);
    this.commandTimers.delete(id);
    this.commands.end(id, "stopped");
    return true;
  }

  async subagentMessages(id: string): Promise<StoredMessage[]> {
    return structuredClone(this.crewMessages.get(id) ?? []);
  }

  hasBackgroundWork(): boolean {
    return this.commandTimers.size > 0;
  }

  save(): void {
    const stored: StoredConversation = { messages: this.transcript.messages, titled: this.titled };
    writeJSON(fileFor(this.options.directory, this.id), stored);
  }

  // MARK: The script

  private emit(event: ProviderEvent): void {
    if (event.type === "questions") {
      // Kept as Codex keeps them: their row, read back from its history (`history`).
      const args = askedRowArgs(event.questions);
      this.transcript.apply({ type: "tool.start", id: event.id, name: "clarify", args });
      this.transcript.apply({ type: "tool.end", id: event.id, name: "clarify", args, result: unansweredResult });
    } else {
      this.transcript.apply(event);
    }
    this.sink.emit(event);
  }

  private async run(prompt: Prompt, signal: AbortSignal): Promise<void> {
    // The message's own words, not those of the line saying who sent it: a thread started
    // from "Fake: crew long" set a crew of its own to work.
    const asked = withoutFromLine(prompt.text);
    const wants = (word: string) => new RegExp(`\\b${word}`, "i").test(asked);
    try {
      if (this.options.droidParity && /\bdroid-parity\b/i.test(asked)) {
        if (wants("approval") || wants("plan")) {
          await this.droidApproval(signal, wants("plan"), wants("limited"));
          return;
        }
        if (wants("ask")) await this.askDroidQuestions(signal);
        await this.droidActivity(signal, wants("subagents"));
        return;
      }
      // Thinking first, when asked, so a turn that fails after it has taken some time.
      if (wants("think")) {
        await this.stream("reasoning", "The user wants me to think first. I will keep the answer short.", signal);
      }
      if (wants("fail")) {
        this.emit({ type: "turn.end", status: "error", error: "The fake agent failed on purpose.", retryable: true });
        return;
      }
      if (wants("tool")) await this.editAndRun(signal);
      if (wants("diff")) await this.changeFiles(signal);
      if (wants("approve")) await this.askToRun(signal);
      if (wants("ask")) await this.askQuestion(signal);
      if (wants("meanwhile")) await this.askMeanwhile(signal);
      if (wants("steps")) await this.workUnderWay(signal, wants("burst"));
      if (wants("todos")) await this.workWithTodos(signal);
      if (wants("liveoutput")) await this.printFast(signal, wants("brief") ? 3 : 30);
      if (wants("bgcommand")) await this.leaveRunning(signal, wants("brief") ? 3 : wants("long") ? 600 : 20);
      if (wants("crew")) await this.startCrew(signal, wants("brief") ? 9 : wants("long") ? 1800 : 90);
      if (wants("bench")) {
        await playBench(
          { emit: (event) => this.emit(event), wait: (ms) => this.wait(ms, signal), toolID: () => this.toolID() },
          this.transcript.messages.length,
          wants("instant"),
          wants("coarse"),
          wants("whole"),
        );
        this.emit({ type: "turn.end", status: "complete", usage: this.usage(), spent: this.spent() });
        return;
      }

      if (wants("imagetest")) {
        await this.showPictures(signal);
        this.emit({ type: "turn.end", status: "complete", usage: this.usage(), spent: this.spent() });
        return;
      }

      const slow = wants("slow");
      const visual = visualReply(asked);
      if (visual !== null) await this.stream("text", visual, signal, 0.25);
      else await this.stream("text", slow ? longReply : reply(prompt), signal, slow ? 8 : 1);
      if (!this.titled) {
        this.titled = true;
        this.emit({ type: "title", title: titleFor(prompt.text) });
      }
      this.emit({ type: "turn.end", status: "complete", usage: this.usage(), spent: this.spent() });
    } catch (error) {
      if (error instanceof Interrupted || signal.aborted) {
        this.emit({ type: "turn.end", status: "interrupted", spent: this.spent() });
      } else {
        this.emit({ type: "turn.end", status: "error", error: `The fake agent broke: ${(error as Error).message}` });
      }
    }
  }

  /** Streams `text` a word at a time. */
  private async stream(kind: "text" | "reasoning", text: string, signal: AbortSignal, slowness = 1): Promise<void> {
    for (const word of text.match(/\S+\s*/g) ?? []) {
      this.check(signal);
      this.emit({ type: kind, text: word });
      await this.pause(signal, slowness);
    }
  }

  private async pause(signal: AbortSignal, slowness = 1): Promise<void> {
    try {
      await sleep(this.options.delayMs * slowness, undefined, { signal });
    } catch {
      throw new Interrupted();
    }
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    try {
      await sleep(ms, undefined, { signal });
    } catch {
      throw new Interrupted();
    }
  }

  private check(signal: AbortSignal): void {
    if (signal.aborted) throw new Interrupted();
  }

  private toolID(): string {
    return `fake-tool-${this.nextTool++}`;
  }

  /** A command printing about fifty lines a second for `seconds`, its output live. */
  private async printFast(signal: AbortSignal, seconds: number): Promise<void> {
    const args = { command: "npm run build -- --verbose" };
    const id = this.toolID();
    this.emit({ type: "tool.start", id, name: "terminal", args });
    let output = "";
    const started = Date.now();
    try {
      for (let line = 1; Date.now() - started < seconds * 1000; line += 1) {
        const piece = `[${String(line).padStart(5, "0")}] compiled module ${line % 97} of 97 in ${(line * 7) % 120} ms\n`;
        output += piece;
        this.live.append(id, piece);
        await this.wait(20, signal);
      }
    } finally {
      this.live.end(id);
    }
    this.emit({ type: "tool.end", id, name: "terminal", args, result: { output: output.slice(-20_000), exit_code: 0 }, durationSeconds: (Date.now() - started) / 1000 });
  }

  /** A command that goes on in the background after the turn, a line every half second for `seconds`. */
  private async leaveRunning(signal: AbortSignal, seconds: number): Promise<void> {
    const args = { command: "npm run dev" };
    const id = this.toolID();
    this.emit({ type: "tool.start", id, name: "terminal", args });
    await this.pause(signal);
    this.emit({ type: "tool.end", id, name: "terminal", args, result: { output: "Command running in the background." } });
    const task = `bg-${this.id.slice(0, 8)}-${id}`;
    this.commands.start(task, { goal: "npm run dev", stoppable: true, output: "> dev\nlistening on http://localhost:5173\n" });
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      if (tick > seconds * 2) {
        clearInterval(timer);
        this.commandTimers.delete(task);
        this.commands.end(task, "completed");
        return;
      }
      this.commands.append(task, `GET /page/${tick} 200 in ${(tick * 13) % 90} ms\n`);
    }, 500);
    timer.unref();
    this.commandTimers.set(task, timer);
  }

  /**
   * Sets a crew to work for the line at the foot of the chat, started in an order the line
   * does not keep: a command left running, a subagent with one of its own, a workflow, and
   * a subagent that finishes at once. `seconds`: how long the command runs; the agents end
   * after a third of it, the workflow after half.
   */
  private async startCrew(signal: AbortSignal, seconds: number): Promise<void> {
    await this.stream("text", "I'll set a few agents to work and leave the dev server running. ", signal);
    const tag = `${this.id.slice(0, 8)}-${this.toolID()}`;
    const started = Date.now();
    const send = (subagent: SubagentInfo) => this.sink.emit({ type: "subagent", subagent });
    const dev = `crew-dev-${tag}`;
    this.commands.start(dev, { goal: "npm run dev", stoppable: true, output: "> dev\nlistening on http://localhost:5173\n" });
    const explore: SubagentInfo = {
      id: `crew-explore-${tag}`, kind: "agent", goal: "Find where the tests start a bridge", role: "Explore", status: "running",
      startedAt: started + 1, background: true, stoppable: true, summary: "Reading test/helpers.ts", tool: "read_file",
    };
    const inner: SubagentInfo = {
      id: `crew-inner-${tag}`, kind: "agent", goal: "Count the fixtures", parent: explore.id, status: "running",
      startedAt: started + 2, background: true, stoppable: true, summary: "Listing test/fixtures",
    };
    const phases = [{ index: 1, title: "Draft" }, { index: 2, title: "Review" }];
    const review: SubagentInfo = {
      id: `crew-review-${tag}`, kind: "workflow", goal: "Draft the change, then review it twice", name: "review-pass", status: "running",
      startedAt: started + 3, background: true, stoppable: true, phases,
      agents: [
        { id: "draft", label: "Draft", phase: "Draft", status: "completed", model: "fake-1", tokens: 4210, durationMs: 9000, result: "A first draft of the change." },
        { id: "review-1", label: "Review A", phase: "Review", status: "running", model: "fake-2" },
        { id: "review-2", label: "Review B", phase: "Review", status: "running", model: "fake-2" },
      ],
    };
    const docs: SubagentInfo = {
      id: `crew-docs-${tag}`, kind: "agent", goal: "Read the protocol's subagent section", status: "running",
      startedAt: started + 4, background: true, stoppable: false,
    };
    // Each at work ends by itself after its time, or stopped by Stop before it, and is
    // set to end before it is shown, with nothing awaited between: a turn stopped in
    // between left them all running for good.
    const end = (subagent: SubagentInfo, after: number, result: Partial<SubagentInfo>) => {
      const finish = (status: SubagentInfo["status"], more: Partial<SubagentInfo>) => {
        clearTimeout(timer);
        this.crew.delete(subagent.id);
        send({ ...subagent, status, endedAt: Date.now(), summary: undefined, ...more });
      };
      const timer = setTimeout(() => finish("completed", result), after * 1000);
      timer.unref();
      this.crew.set(subagent.id, { timer, stop: () => finish("stopped", {}) });
    };
    // What each agent did, as its own messages: what it was asked, a call, its answer.
    const did = (subagent: SubagentInfo, path: string, found: string, answer: string) => {
      const at = subagent.startedAt / 1000;
      const args = { path: join(this.cwd, path) };
      this.crewMessages.set(subagent.id, [
        { role: "user", text: subagent.goal, timestamp: at },
        { role: "tool", name: "read_file", args, content: JSON.stringify({ content: found }), tool_call_id: `${subagent.id}-read`, timestamp: at + 1 },
        { role: "assistant", text: answer, timestamp: at + 2 },
      ]);
    };
    did(explore, "test/helpers.ts", "export async function startTestBridge(", "test/helpers.ts starts one with `startTestBridge`, on a free port.");
    did(inner, "test/fixtures", "41 files", "41 fixtures.");
    did(docs, "docs/gateway-protocol.md", "**Subagents and workflows**", "subagent.list lists the ended ones too.");
    end(explore, seconds / 3, { result: "test/helpers.ts starts one with startTestBridge." });
    end(inner, seconds / 3, { result: "41 fixtures." });
    end(review, seconds / 2, { agents: review.agents?.map((agent) => ({ ...agent, status: "completed" as const })) });
    end(docs, 0.05, { result: "subagent.list lists the ended ones too.\nMore below." });
    for (const subagent of [explore, inner, review, docs]) send(subagent);
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      if (tick > seconds * 2) {
        clearInterval(timer);
        this.commandTimers.delete(dev);
        this.commands.end(dev, "completed");
        return;
      }
      this.commands.append(dev, `GET /page/${tick} 200 in ${(tick * 13) % 90} ms\n`);
    }, 500);
    timer.unref();
    this.commandTimers.set(dev, timer);
  }

  private async editAndRun(signal: AbortSignal): Promise<void> {
    await this.stream("text", "I'll change hi to hello in hello.txt. ", signal);

    const path = join(this.cwd, "hello.txt");
    const edit = { path, old_string: "hi", new_string: "hello" };
    const editID = this.toolID();
    this.emit({ type: "tool.start", id: editID, name: "patch", args: edit });
    await this.pause(signal);
    this.emit({
      type: "tool.end",
      id: editID,
      name: "patch",
      args: edit,
      result: { success: true, diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" },
      durationSeconds: 0.12,
    });

    const command = { command: "cat hello.txt" };
    const runID = this.toolID();
    this.emit({ type: "tool.start", id: runID, name: "terminal", args: command });
    await this.pause(signal);
    this.emit({ type: "tool.end", id: runID, name: "terminal", args: command, result: { output: "hello\n", exit_code: 0 }, durationSeconds: 0.05 });
  }

  /**
   * A run of work with thoughts between, slow enough to watch: each step a moment long.
   * With `bursts`, the first thought comes in bursts and the second whole at once.
   */
  private async workUnderWay(signal: AbortSignal, bursts = false): Promise<void> {
    let thoughts = 0;
    const think = async (text: string) => {
      thoughts += 1;
      if (!bursts || thoughts > 2) return this.stream("reasoning", text, signal, 2);
      const pieces = thoughts === 1 ? (text.match(/.{1,70}(\s+|$)/gs) ?? [text]) : [text];
      for (const piece of pieces) {
        this.check(signal);
        this.emit({ type: "reasoning", text: piece });
        await this.pause(signal, 8);
      }
    };
    const step = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>, slowness: number) => {
      const id = this.toolID();
      this.emit({ type: "tool.start", id, name, args });
      await this.pause(signal, slowness);
      this.emit({ type: "tool.end", id, name, args, result, durationSeconds: (slowness * this.options.delayMs) / 1000 });
    };
    await think(
      "**Finding the slow test**\n\nThe suite takes four minutes where it took one. Something waits for real time. " +
        "I should run the tests with their timings first, then look for sleeps and retries in the test folder, " +
        "all three patterns at once since they are independent.",
    );
    await step("terminal", { command: "npm test -- --reporter=dot" }, { output: "312 passing (3m 58s)", exit_code: 0 }, 30);
    // Three searches at once, finishing in another order than they started.
    const searches = ["setTimeout", "retry", "sleep("].map((pattern) => ({ id: this.toolID(), args: { pattern } }));
    for (const search of searches) {
      this.emit({ type: "tool.start", id: search.id, name: "search_files", args: search.args });
      await this.pause(signal, 4);
    }
    for (const search of [searches[1], searches[0], searches[2]]) {
      await this.pause(signal, 15);
      this.emit({ type: "tool.end", id: search.id, name: "search_files", args: search.args, result: { output: "2 matches" }, durationSeconds: 0.3 });
    }
    await think(
      "Two of the three hits are in the retry tests, which wait for real seconds between attempts. " +
        "A fake clock would make them instant. Let me read the helper before changing anything.",
    );
    await step("read_file", { path: join(this.cwd, "test/helpers.ts") }, { content: "export function retrying(clock = realClock) {" }, 15);
    await think("The helper already takes a clock. Only the tests need to pass one.");
    const path = join(this.cwd, "test/retry.test.ts");
    await step(
      "patch",
      { path, old_string: "retrying()", new_string: "retrying(fakeClock)" },
      { success: true, diff: "--- a/test/retry.test.ts\n+++ b/test/retry.test.ts\n@@ -3 +3 @@\n-const run = retrying();\n+const run = retrying(fakeClock);\n" },
      10,
    );
  }

  /**
   * Work along a to-do list, slow enough to look at each state: the list as Claude Code
   * writes it, each item worded as it runs, moved on as each step ends; thoughts that open
   * with a bold title, as a GPT model's do; a summary of a run of calls, as Claude Code
   * sends one after the run, naming the calls.
   */
  private async workWithTodos(signal: AbortSignal): Promise<void> {
    const items = [
      { content: "Read the notifier", activeForm: "Reading the notifier" },
      { content: "Read the APNs sender", activeForm: "Reading the APNs sender" },
      { content: "Write the retry with backoff", activeForm: "Writing the retry with backoff" },
      { content: "Run the tests", activeForm: "Running the tests" },
    ];
    const write = (current: number) => {
      const todos = items.map((item, index) => ({ ...item, status: index < current ? "completed" : index === current ? "in_progress" : "pending" }));
      const id = this.toolID();
      const done = todos.filter((todo) => todo.status === "completed").length;
      const args = { todos };
      this.emit({ type: "tool.start", id, name: "todo", args, context: `${done} of ${todos.length} done` });
      this.emit({ type: "tool.end", id, name: "todo", args, context: `${done} of ${todos.length} done`, result: { output: todos.map((todo) => todo.content).join("\n") } });
    };
    const step = async (name: string, args: Record<string, unknown>, result: Record<string, unknown>, slowness: number) => {
      const id = this.toolID();
      this.emit({ type: "tool.start", id, name, args });
      await this.pause(signal, slowness);
      this.emit({ type: "tool.end", id, name, args, result, durationSeconds: (slowness * this.options.delayMs) / 1000 });
      return id;
    };
    await this.stream("reasoning", "**Planning the retry**\n\nPushes that fail are dropped today. I will read the notifier and the sender first, then write the retry and run the tests.", signal, 2);
    write(0);
    await this.pause(signal, 60);
    const read = await step("read_file", { path: join(this.cwd, "src/notifier.ts") }, { content: "export class Notifier {" }, 20);
    await this.pause(signal, 10);
    this.emit({ type: "headline", text: "Read notifier.ts", toolIds: [read] });
    await this.pause(signal, 60);
    write(1);
    await this.stream("reasoning", "**Checking how Apple answers**\n\nA 410 means the device is gone and should not be tried again; anything else can be retried after a while.", signal, 2);
    await this.pause(signal, 60);
    await step("read_file", { path: join(this.cwd, "src/apns.ts") }, { content: "export async function send(" }, 20);
    write(2);
    await this.pause(signal, 60);
    await this.stream("reasoning", "**Writing the backoff**\n\nOne, two, then four seconds, three tries at most.", signal, 2);
    await step(
      "patch",
      { path: join(this.cwd, "src/apns.ts"), old_string: "return send(token, body);", new_string: "return withBackoff(() => send(token, body));" },
      { success: true, diff: "--- a/src/apns.ts\n+++ b/src/apns.ts\n@@ -9 +9 @@\n-  return send(token, body);\n+  return withBackoff(() => send(token, body));\n" },
      20,
    );
    write(3);
    await this.pause(signal, 60);
    await step("terminal", { command: "npm test" }, { output: "312 passing (4s)", exit_code: 0 }, 60);
    write(4);
    await this.pause(signal, 40);
  }

  /** Four files changed, as an agent's edits say it: their diffs are made up, nothing is written. */
  private async changeFiles(signal: AbortSignal): Promise<void> {
    await this.stream("text", "I'll tidy the project up. ", signal);
    const edits: { name: string; args: Record<string, unknown>; diff: string }[] = [
      {
        name: "patch",
        args: { path: join(this.cwd, "src/app.ts"), old_string: "const port = 80;", new_string: "const port = Number(process.env.PORT ?? 8080);" },
        diff: [
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,6 +1,7 @@",
          ' import { serve } from "./server.ts";',
          "-const port = 80;",
          "+// The port comes from the environment, 8080 when it says none.",
          "+const port = Number(process.env.PORT ?? 8080);",
          " ",
          " serve({ port });",
          ' console.log("listening");',
          " ",
          "",
        ].join("\n"),
      },
      {
        name: "patch",
        args: { path: join(this.cwd, "README.md"), old_string: "Runs on port 80.", new_string: "Runs on port 8080, or $PORT." },
        diff: ["--- a/README.md", "+++ b/README.md", "@@ -3,3 +3,3 @@", " ## Running", " ", "-Runs on port 80.", "+Runs on port 8080, or $PORT.", ""].join("\n"),
      },
      {
        name: "write_file",
        args: { path: join(this.cwd, "notes/todo.md"), content: "# To do\n\n- Check the port on the server\n- Tell the team\n" },
        diff: ["--- /dev/null", "+++ b/notes/todo.md", "@@ -0,0 +1,4 @@", "+# To do", "+", "+- Check the port on the server", "+- Tell the team", ""].join("\n"),
      },
      {
        name: "patch",
        args: { path: join(this.cwd, "old-server.ts") },
        diff: ["--- a/old-server.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@", '-import { serve } from "./server.ts";', "-", "-serve({ port: 80 });", ""].join("\n"),
      },
      {
        name: "patch",
        args: { path: join(this.cwd, "src/app.ts"), old_string: 'console.log("listening");', new_string: "console.log(`listening on ${port}`);" },
        diff: ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -5,3 +5,3 @@", " serve({ port });", '-console.log("listening");', "+console.log(`listening on ${port}`);", " ", ""].join("\n"),
      },
    ];
    for (const edit of edits) {
      const id = this.toolID();
      this.emit({ type: "tool.start", id, name: edit.name, args: edit.args });
      await this.pause(signal);
      this.emit({ type: "tool.end", id, name: edit.name, args: edit.args, result: { success: true, diff: edit.diff }, durationSeconds: 0.02 });
    }
    await this.stream("text", "Changed four files: the port comes from the environment now. ", signal);
  }

  /** Makes images and a file, edits and reads it, and shows the images (feature file_read). */
  private async showPictures(signal: AbortSignal): Promise<void> {
    await this.stream("text", "Making a chart and editing the notes. ", signal);
    const files = await makePictures(this.cwd, this.id);
    const edit = { path: files.notes, old_string: "Line 42: a line of the notes", new_string: "Line 42: the edited line, now with more words" };
    const editID = this.toolID();
    this.emit({ type: "tool.start", id: editID, name: "patch", args: edit });
    await this.pause(signal);
    this.emit({
      type: "tool.end",
      id: editID,
      name: "patch",
      args: edit,
      result: { success: true, diff: "--- a/fake-pictures/notes.md\n+++ b/fake-pictures/notes.md\n@@ -44,1 +44,1 @@\n-Line 42: a line of the notes\n+Line 42: the edited line, now with more words\n" },
      durationSeconds: 0.08,
    });
    const read = { path: files.chart };
    const readID = this.toolID();
    this.emit({ type: "tool.start", id: readID, name: "read_file", args: read });
    await this.pause(signal);
    this.emit({ type: "tool.end", id: readID, name: "read_file", args: read, result: { content: "(a PNG image)" }, durationSeconds: 0.02 });
    await this.stream("text", `\n\n${picturesReply(files)}`, signal, 0.5);
  }

  private async askToRun(signal: AbortSignal): Promise<void> {
    const command = "rm -rf ./fake-build";
    const id = this.toolID();
    this.emit({ type: "tool.start", id, name: "terminal", args: { command } });
    const answer = await this.sink.ask(
      { kind: "approval", command, description: "delete a folder (the fake agent only pretends)", choices: ["once", "session", "always", "deny"] },
      signal,
    );
    this.check(signal);
    if (answer.kind === "approval" && answer.choice !== "deny") {
      this.emit({ type: "tool.end", id, name: "terminal", args: { command }, result: { output: "Pretended to delete ./fake-build.", exit_code: 0 }, durationSeconds: 0.01 });
      await this.stream("text", "The command ran. ", signal);
    } else {
      this.emit({
        type: "tool.end",
        id,
        name: "terminal",
        args: { command },
        result: { status: "blocked", error: "Denied by the user.", user_summary: "You denied this command — it did not run." },
      });
      await this.stream("text", "You said no, so nothing ran. ", signal);
    }
  }

  private async askQuestion(signal: AbortSignal): Promise<void> {
    const question = "Which language should I use?";
    const choices = ["Python", "Swift"];
    const args = { questions: [{ question, choices }] };
    const id = this.toolID();
    // The app shows the question itself, not this tool row.
    this.emit({ type: "tool.start", id, name: "clarify", args });
    const answer = await this.sink.ask({ kind: "clarify", questions: [{ qid: "q0", question, choices, multiSelect: false }] }, signal);
    this.check(signal);
    const picked = answer.kind === "clarify" ? (answer.answers?.q0 ?? null) : null;
    this.emit({ type: "tool.end", id, name: "clarify", args, result: { responses: [{ question, user_response: picked ?? "" }] } });
    await this.stream("text", picked ? `You chose ${picked}. ` : "You skipped the question, so I'll pick Swift. ", signal);
  }

  /**
   * Questions asked without waiting, as Codex asks them (`questions`): the turn goes on
   * at once, and the person's next message is the answer.
   */
  private async askMeanwhile(signal: AbortSignal): Promise<void> {
    await this.stream("text", "Let me check one thing with you. ", signal);
    const id = this.toolID();
    const questions = [{ qid: "q0", question: "Which colour should the README heading use?", choices: ["Red", "Green", "Blue"], multiSelect: false }];
    this.emit({ type: "questions", id, questions, text: "Which colour should the README heading use?\n- Red\n- Green\n- Blue" });
    await this.stream("text", "I'll go on with the rest meanwhile. ", signal);
  }

  /** Offered grants are only echoed. No setting, permission or successor session changes. */
  private async droidApproval(signal: AbortSignal, plan: boolean, limited: boolean): Promise<void> {
    const id = this.toolID();
    const markdown = "# Parity plan\n\n1. Inspect the scratch sample.\n2. Add one test.\n";
    const command = plan ? markdown : "printf 'parity-approved\\n'";
    const options: ApprovalOption[] = [
      { id: "proceed_once", label: "Allow once", description: "Approve this scripted request only.", effects: [{ scope: "once", text: "This request only." }] },
      { id: "cancel", label: "Deny", description: "Do not approve this scripted request.", effects: [] },
    ];
    if (!limited) {
      options.push(
        { id: "proceed_auto_run_medium", label: "Use Medium", description: "Raise autonomy for this session only.", effects: [{ scope: "session", text: "This session: Medium autonomy." }], requiresConfirmation: true },
        ...(plan ? [
          { id: "proceed_edit", label: "Edit plan", description: "Return edited Markdown without starting implementation.", effects: [], requiresConfirmation: true },
          { id: "proceed_new_session_high", label: "New session with High", description: "Start a replacement session at High autonomy.", effects: [{ scope: "new_session" as const, text: "New SDK session; same visible thread. High autonomy." }], requiresConfirmation: true },
        ] : [
          { id: "proceed_always_file", label: "Always allow this file", description: "Save a rule for the exact scratch file, not its directory.", effects: [{ scope: "settings" as const, text: "Saved across sessions: hello.txt only." }], requiresConfirmation: true },
          { id: "proceed_always_tools", label: "Always allow this MCP tool", description: "Save permission for parity-server.lookup only.", effects: [{ scope: "settings" as const, text: "Saved across sessions: parity-server.lookup." }], requiresConfirmation: true },
          { id: "proceed_always_server", label: "Always allow this MCP server", description: "Save permission for every tool on parity-server.", effects: [{ scope: "settings" as const, text: "Saved across sessions: all tools on parity-server." }], requiresConfirmation: true },
          { id: "proceed_report_false_positive", label: "Allow and report", description: "Allow once and send a false-positive report externally.", effects: [{ scope: "once" as const, text: "This request only." }, { scope: "external" as const, text: "Sends a report outside this session." }], requiresConfirmation: true },
        ]),
      );
    }
    const request: AgentRequest = {
      kind: "approval", command, choices: ["once", "deny"], options, takesNote: true,
      description: "Scripted approval only. No command runs and no permission rule is saved.",
    };
    if (plan) {
      request.plan = { startsIn: "ask" };
      request.planContent = markdown;
    } else {
      request.details = [
        { toolId: `${id}-edit`, name: "Edit scratch sample", type: "apply_patch", path: join(this.cwd, "hello.txt"), diff: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n" },
        { toolId: id, name: "Execute", type: "exec", command },
        { toolId: `${id}-mcp`, name: "MCP lookup", type: "mcp_tool", server: "parity-server", tool: "lookup", impact: "Read one scripted record." },
        { toolId: `${id}-sandbox`, name: "Sandbox path request", type: "sandbox_violation", violationType: "filesystem", operation: "read", target: "/scripted/external.txt", reason: "The scripted path is outside the scratch workspace." },
        { toolId: `${id}-shield`, name: "Shield finding", type: "droid_shield_violation", findings: [{ title: "Scripted finding", message: "Illustrative warning; no external action occurs.", severity: "medium" }] },
      ];
    }
    const name = plan ? "spec" : "terminal";
    const args = { command };
    this.emit({ type: "tool.start", id, name, args });
    const answer = await this.sink.ask(request, signal);
    this.check(signal);
    this.emit({ type: "tool.end", id, name, args, result: { answer, executed: false } });
    let text = "Scripted request not approved. Nothing executed.";
    if (answer.kind === "approval.option") {
      text = `Scripted option: ${answer.option}. Nothing executed.`;
      if (answer.editedPlan) text += ` Edited plan:\n${answer.editedPlan}`;
    }
    this.emit({ type: "text", text });
    this.emit({ type: "turn.end", status: "complete", usage: this.usage(), spent: this.spent() });
  }

  private async askDroidQuestions(signal: AbortSignal): Promise<void> {
    const questions = [
      { qid: "language", header: "Language", question: "Which language should the parity sample use?", choices: ["Swift", "Python"], multiSelect: false },
      { qid: "checks", header: "Checks", question: "Which checks should the parity sample include?", choices: ["Unit tests", "UI tests"], multiSelect: false },
    ];
    const id = this.toolID();
    const args = { questions };
    this.emit({ type: "tool.start", id, name: "clarify", args });
    const answer = await this.sink.ask({ kind: "clarify", questions, requiresAllAnswers: true }, signal);
    this.check(signal);
    const answers = answer.kind === "clarify" ? answer.answers : null;
    this.emit({ type: "tool.end", id, name: "clarify", args, result: { answers } });
    this.emit({ type: "text", text: answers ? `Answers received: ${answers.language}; ${answers.checks}. ` : "Questions cancelled. " });
  }

  /** No commands run: snapshots deliberately repeat earlier output, as Execute does. */
  private async droidActivity(signal: AbortSignal, withSubagent = false): Promise<void> {
    const items = [
      { text: "Inspect bridge", status: "completed" },
      { text: "Implement progress", status: "in_progress" },
      { text: "Run tests", status: "pending" },
    ];
    const updatePlan = () => {
      const id = this.toolID();
      const args = { todos: items.map((item, index) => `${index + 1}. [${item.status}] ${item.text}`).join("\n"), items: structuredClone(items) };
      this.emit({ type: "tool.start", id, name: "todo", args });
      this.emit({ type: "tool.end", id, name: "todo", args, result: "TODO List Updated" });
    };
    this.emit({ type: "working", state: "thinking", text: "Thinking" });
    this.emit({ type: "notice", level: "info", text: "Parity hook completed (scripted, no hook ran)." });
    updatePlan();
    const child = withSubagent ? {
      id: `parity-child-${this.toolID()}`, kind: "agent" as const, goal: "Inspect scratch fixture",
      name: "parity-ui-helper", startedAt: Date.now(), background: true, stoppable: false,
    } : undefined;
    if (child) this.emit({ type: "subagent", subagent: { ...child, status: "running", summary: "Scripted read-only inspection" } });
    this.emit({ type: "turn.usage", usage: { tokens: 120 } });
    const id = this.toolID();
    const args = { command: "printf 'parity-first\\n'; printf 'parity-second\\n'", summary: "Show cumulative parity output", riskLevel: "low", fireAndForget: false, timeout: 30 };
    this.emit({ type: "working", state: "executing_tool", text: "Running command" });
    this.emit({ type: "tool.start", id, name: "terminal", args });
    this.emit({ type: "tool.progress", id, output: "parity-first\n", progress: "First line ready", outputTruncated: false });
    await this.pause(signal, 100);
    const output = "parity-first\nparity-second\n";
    this.emit({ type: "tool.progress", id, output, progress: "Second line ready", outputTruncated: false });
    this.emit({ type: "turn.usage", usage: { tokens: 240 } });
    await this.pause(signal, 200);
    this.emit({ type: "tool.end", id, name: "terminal", args, result: { output, exit_code: 0 }, durationSeconds: this.options.delayMs * 0.3 });
    for (const item of items) item.status = "completed";
    updatePlan();
    if (child) this.emit({ type: "subagent", subagent: { ...child, status: "completed", endedAt: Date.now(), result: "Scripted fixture inspection complete; no child or tools ran." } });
    this.emit({ type: "working", state: "idle", text: "" });
    this.emit({ type: "text", text: "Droid parity sample complete." });
    this.emit({ type: "turn.end", status: "complete", usage: this.usage(), spent: { tokens: 300 } });
  }

  /** A made-up count that grows with the conversation. */
  /** What a turn spent, made up as an agent would say it (feature turn_usage): the context read again, and a little more. */
  private spent(): { tokens: number } {
    return { tokens: Math.round(this.usage().used * 1.6) };
  }

  private usage(): { used: number; max: number } {
    const characters = JSON.stringify(this.transcript.messages).length;
    return { used: 1000 + Math.round(characters / 4), max: 200_000 };
  }
}

function reply(prompt: Prompt): string {
  const said = splitFiles(prompt.text).text.trim().split(/\s+/).slice(0, 12).join(" ").replace(/[.!?]+$/, "");
  const images = prompt.images.length === 0 ? "" : ` I got ${prompt.images.length === 1 ? "one image" : `${prompt.images.length} images`}.`;
  const count = prompt.files?.length ?? 0;
  const files = count === 0 ? "" : ` I got ${count === 1 ? "one file" : `${count} files`}.`;
  return `Hello from the fake agent. You said: ${said || "nothing"}.${images}${files}`;
}

function titleFor(text: string): string {
  const words = splitFiles(withoutFromLine(text)).text.trim().split(/\s+/).filter((word) => word !== "").slice(0, 6).join(" ");
  return words ? `Fake: ${words}` : "Fake conversation";
}

const longReply =
  "This is a long reply from the fake agent, sent slowly so there is time to interrupt it, " +
  "to close the app, or to drop the connection and come back. Every word arrives as its own " +
  "event with its own sequence number. When the app reconnects it asks for the events it " +
  "missed and continues from there, or takes a snapshot when the bridge has restarted. " +
  "Nothing here runs anything or touches any file. That is the end of the long reply.";
