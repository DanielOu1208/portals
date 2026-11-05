import type { FormInfo } from "@opencode/client";
import type { AgentRequest, SessionSink } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import { NativeRevisions } from "./revisions.ts";

type Field = FormInfo["fields"][number];
type Answer = Record<string, string | number | boolean | string[]>;
type Card = Extract<AgentRequest, { kind: "clarify" }>;

const nativeUI = "This form needs OpenCode's own UI. Open this session in OpenCode to answer it.";

/** Existing clarify cards cannot show hidden, conditional or external fields faithfully. */
export function formCard(form: FormInfo): Card {
  if (form.fields.some((field) => field.type === "external" || field.hidden || field.when?.length)) throw new Error(nativeUI);
  for (const field of form.fields) {
    if (!("options" in field) || !field.options) continue;
    const options = field.options;
    if (new Set(options.map((option) => option.label)).size !== options.length) throw new Error(nativeUI);
    if (field.type === "multiselect" && options.some((option) => choices(option.label, options.filter((other) => other !== option)) !== null)) throw new Error(nativeUI);
  }
  return {
    kind: "clarify",
    requiresAllAnswers: form.fields.every((field) => field.type !== "external" && field.required === true),
    questions: form.fields.map((field) => ({
      qid: field.key,
      question: [field.title || field.key, field.description].filter(Boolean).join("\n"),
      header: form.title,
      choices: field.type === "boolean" ? ["Yes", "No"] : "options" in field ? (field.options ?? []).map((option) => option.label) : [],
      multiSelect: field.type === "multiselect",
      ...("options" in field && field.options ? { descriptions: Object.fromEntries(field.options.map((option) => [option.label, option.description ?? ""])) } : {}),
    })),
  };
}

/** Reads whole labels, longest first, so an option containing a comma stays one value. */
function choices(words: string, options: { label: string; value: string }[]): string[] | null {
  for (const option of [...options].filter((option) => option.label).sort((a, b) => b.label.length - a.label.length)) {
    if (words === option.label) return [option.value];
    if (!words.startsWith(`${option.label}, `)) continue;
    const rest = choices(words.slice(option.label.length + 2), options);
    if (rest) return [option.value, ...rest];
  }
  return null;
}

function valueOf(field: Field, words: string): string | number | boolean | string[] {
  switch (field.type) {
    case "external": throw new Error(nativeUI);
    case "boolean":
      if (words === "Yes") return true;
      if (words === "No") return false;
      throw new Error(`${field.title || field.key}: choose Yes or No.`);
    case "integer":
    case "number": {
      const number = Number(words);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) throw new Error(`${field.key}: enter a finite ${field.type}.`);
      if (field.minimum !== undefined && number < Number(field.minimum)) throw new Error(`${field.key}: enter at least ${field.minimum}.`);
      if (field.maximum !== undefined && number > Number(field.maximum)) throw new Error(`${field.key}: enter at most ${field.maximum}.`);
      return number;
    }
    case "multiselect": {
      const selected = choices(words, field.options);
      if (!selected) {
        if (field.custom) return [words];
        throw new Error(`${field.key}: choose the listed options.`);
      }
      const unique = [...new Set(selected)];
      if (field.minItems !== undefined && unique.length < field.minItems) throw new Error(`${field.key}: choose at least ${field.minItems} options.`);
      if (field.maxItems !== undefined && unique.length > field.maxItems) throw new Error(`${field.key}: choose at most ${field.maxItems} options.`);
      return unique;
    }
    case "string": {
      if (field.options?.length) {
        const selected = field.options.find((option) => option.label === words);
        if (selected) return selected.value;
        if (!field.custom) throw new Error(`${field.key}: choose one listed option.`);
      }
      if (field.minLength !== undefined && words.length < field.minLength) throw new Error(`${field.key}: enter at least ${field.minLength} characters.`);
      if (field.maxLength !== undefined && words.length > field.maxLength) throw new Error(`${field.key}: enter at most ${field.maxLength} characters.`);
      return words;
    }
  }
}

/** The server validates remaining constraints (patterns and formats), keeping its form open on failure. */
export function formAnswer(form: FormInfo, answers: Record<string, string | null>): Answer {
  const values: Answer = {};
  for (const field of form.fields) {
    if (field.type === "external") throw new Error(nativeUI);
    const words = answers[field.key];
    if (words == null || words.trim() === "") {
      if (field.default !== undefined) values[field.key] = field.default;
      else if (field.required) throw new Error(`${field.title || field.key} is required.`);
      continue;
    }
    values[field.key] = valueOf(field, words);
  }
  return values;
}

/** Pending native forms, including cards answered elsewhere or recovered after reconnect. */
export class OpenCodeForms {
  private readonly pending = new Map<string, AbortController>();
  private readonly unsupported = new Set<string>();
  private readonly sessionID: string;
  private readonly api: () => Promise<OpenCodeApi>;
  private readonly sink: SessionSink;
  private closed = false;
  private generation = 0;
  private readonly revisions = new NativeRevisions();
  private completeRevision = 0;

  constructor(sessionID: string, api: () => Promise<OpenCodeApi>, sink: SessionSink) {
    this.sessionID = sessionID;
    this.api = api;
    this.sink = sink;
  }

  async reconcile(): Promise<void> {
    const generation = this.generation;
    const revision = this.revisions.start();
    try {
      const forms = await (await this.api()).forms(this.sessionID);
      if (this.closed || generation !== this.generation || revision < this.completeRevision) return;
      // An empty successful list also supersedes every older list, including
      // IDs which neither a live event nor a prior snapshot has introduced.
      this.completeRevision = revision;
      const ids = new Set(forms.map((form) => form.id));
      for (const id of this.pending.keys()) if (!ids.has(id) && this.revisions.apply(id, revision)) this.resolved(id);
      for (const form of forms) if (this.revisions.apply(form.id, revision)) void this.present(form);
    } finally { this.revisions.finish(revision); }
  }

  resolved(id: string): void {
    this.revisions.changed(id);
    this.pending.get(id)?.abort("resolved");
    this.pending.delete(id);
    this.unsupported.delete(id);
  }

  close(): void {
    this.closed = true;
    this.withdraw();
  }

  withdraw(): void {
    ++this.generation;
    for (const id of this.pending.keys()) this.resolved(id);
  }

  async ask(form: FormInfo): Promise<void> {
    this.revisions.changed(form.id);
    return this.present(form);
  }

  private async present(form: FormInfo): Promise<void> {
    if (this.closed || this.pending.has(form.id) || this.unsupported.has(form.id)) return;
    let card: Card;
    try { card = formCard(form); }
    catch (error) {
      this.unsupported.add(form.id);
      this.sink.emit({ type: "notice", level: "warn", text: (error as Error).message });
      return;
    }
    const controller = new AbortController();
    this.pending.set(form.id, controller);
    try {
      while (!controller.signal.aborted) {
        const answer = await this.sink.ask(card, controller.signal);
        if (controller.signal.aborted || answer.kind === "withdrawn") return;
        if (answer.kind !== "clarify") return;
        try {
          const api = await this.api();
          if (controller.signal.aborted) return;
          if (answer.answers === null) await api.cancelForm(this.sessionID, form.id);
          else await api.replyForm(this.sessionID, form.id, formAnswer(form, answer.answers));
          this.resolved(form.id);
          return;
        } catch (error) {
          if (!controller.signal.aborted) this.sink.emit({ type: "notice", level: "warn", text: `OpenCode did not take the answer: ${(error as Error).message}` });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.sink.emit({ type: "notice", level: "warn", text: `OpenCode's form could not be shown: ${(error as Error).message}` });
    } finally {
      if (this.pending.get(form.id) === controller) this.pending.delete(form.id);
    }
  }
}
