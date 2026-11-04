import type { HostNote, Prompt, ProviderEvent, StoredMessage, TurnUsage } from "../providers/types.ts";

// A conversation in the stored-message format `session.resume` returns, kept up to date
// from a session's neutral events, plus the turn in progress (`inflight`).
//
// The bridge keeps one of these per live session, because an agent's own history lags
// behind a running turn. The rules it follows come from how the app rebuilds a thread
// (HermesHistoryMapper.swift): the user's message is stored the moment its turn starts,
// text is stored when a tool call or the turn's end closes it, and `inflight.assistant`
// is only the text since the last stored message.

/** A prompt as stored: the text, then one `@image:<name>` line per image. */
export function storedUserText(prompt: Prompt): string {
  const lines = prompt.images.map((image) => `@image:${image.filename}`);
  return [prompt.text, ...lines].filter((line) => line !== "").join("\n");
}

export interface Inflight {
  user: string;
  assistant: string;
  reasoning?: string;
  /** The id the device gave the message that opened it (feature `message_ids`). */
  message_id?: string;
  /** For one opened by the answers given on a card, their row's id (feature async_questions, as a stored message says). */
  card_answer?: string;
  /** For a turn the agent began by itself: what the opener is, as a stored message says. */
  display_kind?: string;
  display_metadata?: Record<string, unknown>;
  turn_usage?: TurnUsage;
  tools?: InflightTool[];
}

interface InflightTool {
  tool_id: string;
  name: string;
  args: Record<string, unknown>;
  context?: string;
  output?: string;
  progress?: string;
  output_truncated?: boolean;
}

function now(): number {
  return Date.now() / 1000;
}

export class Transcript {
  readonly messages: StoredMessage[];
  /** What opened the running turn, exactly as stored; null between turns. */
  private opener: string | null = null;
  /** Why, when the agent opened it by itself. */
  private openerNote: HostNote | null = null;
  /** Why for the turn's first message, which a message steered in since stands in for as `opener`. */
  private fromNote: HostNote | null = null;
  /** Where the running turn's messages start (its opener's index); null between turns (feature `turn_diff`). */
  private from: number | null = null;
  /** The id the device gave the message that opened it, when one did (feature `message_ids`). */
  private openerID: string | undefined;
  /** For one that is a card's answers, their row's id (`card_answer`). */
  private openerAnswers: string | undefined;
  /** Streamed since the last stored message. */
  private text = "";
  private reasoning = "";
  private liveUsage: TurnUsage | undefined;
  private readonly liveTools = new Map<string, InflightTool>();

  constructor(messages: StoredMessage[] = []) {
    this.messages = messages;
  }

  get isInTurn(): boolean {
    return this.opener !== null;
  }

  /** Where the running turn's messages start in `messages`; null between turns. A message steered into it does not move it. */
  get turnStart(): number | null {
    return this.from;
  }

  /** A failed handoff is its user row and the failure directly after it, named exactly. */
  removeFailed(requestId: string): { start: number; count: number; messageID?: string } | undefined {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const ending = this.messages[index];
      if (ending.role !== "assistant" || ending.display_kind !== "failed_turn" || ending.display_metadata?.failed_request_id !== requestId) continue;
      const start = this.messages[index - 1]?.role === "user" ? index - 1 : index;
      const count = index - start + 1;
      const opener = this.messages[start];
      const messageID = opener.role === "user" ? opener.message_id : undefined;
      this.messages.splice(start, count);
      if (this.from !== null && start < this.from) this.from -= Math.min(count, this.from - start);
      return { start, count, messageID };
    }
  }

  /**
   * A turn opened by `userText`, or by the agent itself for the reason in `host`.
   * `messageID`: the id the device that sent it gave it, which the stored message keeps
   * (feature `message_ids`). `cardAnswer`: for the answers given on a card, their row's
   * id (`card_answer`).
   */
  startTurn(userText: string, host?: HostNote, messageID?: string, cardAnswer?: string): void {
    this.liveUsage = undefined;
    this.liveTools.clear();
    this.flush();
    this.from = this.messages.length;
    const message: StoredMessage = host ? { role: "user", text: userText, timestamp: now(), ...display(host) } : { role: "user", text: userText, timestamp: now() };
    if (messageID !== undefined && message.role === "user") message.message_id = messageID;
    if (cardAnswer !== undefined && message.role === "user") message.card_answer = cardAnswer;
    this.messages.push(message);
    this.opener = userText;
    this.openerNote = host ?? null;
    this.fromNote = this.openerNote;
    this.openerID = messageID;
    this.openerAnswers = cardAnswer;
  }

  /**
   * A turn already under way when the conversation was loaded, opened by `userText`,
   * the last user message stored. Nothing is added: the app reopens that turn.
   */
  resumeTurn(userText: string): void {
    this.flush();
    const opened = this.messages.findLastIndex((message) => message.role === "user");
    this.from = opened >= 0 ? opened : this.messages.length;
    this.opener = userText;
    this.openerNote = null;
    this.fromNote = null;
    this.openerID = undefined;
    const stored = this.messages[opened];
    this.openerAnswers = stored?.role === "user" && stored.text === userText ? stored.card_answer : undefined;
  }

  /**
   * The running turn was opened by `userText`, not by what it was taken for when it was
   * loaded: the stored message that opened it says so from now on.
   */
  reopen(userText: string): void {
    if (this.opener === null) return;
    const opened = this.messages.findLast((message) => message.role === "user" && message.text === this.opener);
    if (opened?.role === "user") opened.text = userText;
    this.opener = userText;
  }

  /**
   * A message that joined the running turn. The app shows a stored message like this
   * as opening a turn of its own, so from here on it is what `inflight.user` names.
   * Between turns, a late receipt records acceptance without opening another turn.
   */
  steer(userText: string, messageID?: string, cardAnswer?: string): void {
    this.flush();
    const message: StoredMessage = { role: "user", text: userText, timestamp: now(), display_kind: "steer" };
    if (messageID !== undefined) message.message_id = messageID;
    if (cardAnswer !== undefined) message.card_answer = cardAnswer;
    this.messages.push(message);
    if (this.opener === null) return;
    this.opener = userText;
    this.openerNote = null;
    this.openerID = messageID;
    this.openerAnswers = cardAnswer;
  }

  /**
   * Takes out a message steered in that the agent never read (a Stop took it back): the
   * conversation is as if it had not been sent, and the turn's last message before it is
   * what `inflight.user` names again. False when it is not there.
   */
  withdraw(userText: string, messageID?: string): boolean {
    const index = this.messages.findLastIndex((message) => message.role === "user" && message.display_kind === "steer" && message.text === userText &&
      (messageID === undefined || message.message_id === messageID));
    if (index === -1) return false;
    this.messages.splice(index, 1);
    const from = this.from;
    if (from === null) return true;
    if (index < from) {
      this.from = from - 1;
      return true;
    }
    const last = this.messages.findLastIndex((message, at) => at >= from && message.role === "user");
    const said = this.messages[last];
    if (said?.role !== "user") return true;
    this.opener = said.text;
    this.openerNote = last === from ? this.fromNote : null;
    this.openerID = said.message_id;
    this.openerAnswers = said.card_answer;
    return true;
  }

  apply(event: ProviderEvent): void {
    switch (event.type) {
      case "text":
        this.text += event.text;
        break;
      case "reasoning":
        this.reasoning += event.text;
        break;
      case "assistant.replace":
        this.text = event.text;
        this.reasoning = event.reasoning;
        break;
      case "commentary":
        if (!event.alreadyStreamed) this.text += event.text;
        this.flush();
        break;
      case "tool.start":
        this.flush();
        this.liveTools.set(event.id, { tool_id: event.id, name: event.name, args: event.args, ...(event.context ? { context: event.context } : {}) });
        break;
      case "tool.progress": {
        const tool = this.liveTools.get(event.id);
        if (tool) {
          if (event.output !== undefined) tool.output = event.output;
          if (event.progress !== undefined) tool.progress = event.progress;
          if (event.outputTruncated !== undefined) tool.output_truncated = event.outputTruncated;
        }
        break;
      }
      case "turn.usage":
        this.liveUsage = { ...event.usage };
        break;
      case "tool.end": {
        // A call begun in this turn gets a row of its own, even when its agent gives it an
        // id an earlier call had (a fake agent counting again after a restart, a model
        // numbering its calls per reply).
        const begunNow = this.liveTools.delete(event.id);
        const content = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? null);
        const existing = begunNow ? undefined : this.messages.findLast((message) => message.role === "tool" && message.tool_call_id === event.id);
        if (existing?.role === "tool") {
          // Background launch and terminal outcomes update one row in its original place.
          existing.content = content;
          if (!existing.context && event.context) existing.context = event.context;
          if (event.inlineDiff) existing.display_metadata = {
            ...existing.display_metadata,
            tool_result_metadata: { ...existing.display_metadata?.tool_result_metadata, inline_diff: event.inlineDiff },
          };
          break;
        }
        this.flush();
        const message: StoredMessage = {
          role: "tool",
          name: event.name,
          args: event.args,
          content,
          tool_call_id: event.id,
          timestamp: now(),
        };
        if (event.context) message.context = event.context;
        if (event.inlineDiff) message.display_metadata = { tool_result_metadata: { inline_diff: event.inlineDiff } };
        this.messages.push(message);
        break;
      }
      case "compacted": {
        this.flush();
        const message: StoredMessage = { role: "compaction", trigger: event.trigger, timestamp: now() };
        if (event.tokensBefore !== undefined) message.tokens_before = event.tokensBefore;
        this.messages.push(message);
        break;
      }
      case "turn.end":
        this.liveTools.clear();
        this.liveUsage = undefined;
        if (event.status === "error") {
          this.flush();
          this.messages.push({
            role: "assistant",
            text: event.error ?? "The turn failed.",
            timestamp: now(),
            display_kind: "failed_turn",
          });
        } else {
          // An interrupted turn is marked even when nothing was said.
          this.flush(event.status === "interrupted");
        }
        // What it spent goes with its last message, the opener's at least (feature turn_usage).
        if (event.spent && this.opener !== null) {
          const last = this.messages.at(-1);
          if (last) last.turn_usage = { ...event.spent };
        }
        this.opener = null;
        this.openerNote = null;
        this.from = null;
        this.openerID = undefined;
        this.openerAnswers = undefined;
        break;
      default:
        break;
    }
  }

  /** The turn in progress, for `session.resume`; null between turns. */
  inflight(): Inflight | null {
    if (this.opener === null) return null;
    const inflight: Inflight = { user: this.opener, assistant: this.text };
    if (this.liveUsage) inflight.turn_usage = { ...this.liveUsage };
    if (this.liveTools.size) inflight.tools = [...this.liveTools.values()].map((tool) => ({ ...tool }));
    if (this.reasoning !== "") inflight.reasoning = this.reasoning;
    if (this.openerID !== undefined) inflight.message_id = this.openerID;
    if (this.openerAnswers !== undefined) inflight.card_answer = this.openerAnswers;
    return this.openerNote ? { ...inflight, ...display(this.openerNote) } : inflight;
  }

  /** Stores the text and reasoning streamed so far as one assistant message. */
  private flush(interrupted = false): void {
    if (this.text.trim() === "" && this.reasoning.trim() === "" && !interrupted) {
      this.text = "";
      this.reasoning = "";
      return;
    }
    const message: StoredMessage = { role: "assistant", text: this.text, timestamp: now() };
    if (this.reasoning.trim() !== "") message.reasoning = this.reasoning;
    if (interrupted) message.display_metadata = { interrupted: true };
    this.messages.push(message);
    this.text = "";
    this.reasoning = "";
  }
}

/** How a stored message in the user's place says the agent began a turn by itself. */
function display(host: HostNote): { display_kind: string; display_metadata?: Record<string, unknown> } {
  return host.kind === "hidden" ? { display_kind: "hidden" } : { display_kind: host.kind, display_metadata: { display_text: host.text } };
}
