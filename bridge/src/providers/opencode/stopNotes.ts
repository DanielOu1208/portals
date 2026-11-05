import { readFileSync, statSync } from "node:fs";
import { log } from "../../log.ts";
import { writeJSON } from "../../store/jsonFile.ts";
import type { Message } from "./protocol.ts";
import type { OwnedStopResult } from "./server.ts";
import type { OwnedStopExecution } from "./shutdown.ts";

export const stopNoteLimits = { records: 4, ids: 256, shown: 512, idBytes: 160, bytes: 256 * 1024, ageMs: 24 * 60 * 60 * 1000 };
export const ownedStopReason = "stopped because the host shut down its OpenCode server";
export const ownedStopWarning = "OpenCode's turn may resume when OpenCode next starts. The host could not confirm that its server stopped this work.";
const resumed = "OpenCode resumed this turn after the host stopped its server.";

interface StopRecord extends OwnedStopResult {
  at: number;
  shown: string[];
}

export interface StopNote { text: string; timestamp: number; afterMessageID?: string }

function validID(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= stopNoteLimits.idBytes;
}

function ids(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && value.every(validID);
}

function executionOf(value: unknown): OwnedStopExecution | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as OwnedStopExecution;
  if (!validID(entry.sessionID)) return;
  const copied: OwnedStopExecution = { sessionID: entry.sessionID };
  for (const key of ["openerID", "assistantID", "terminalID"] as const) {
    if (entry[key] === undefined) continue;
    if (!validID(entry[key])) return;
    copied[key] = entry[key];
  }
  if (entry.outcome !== undefined) {
    if (!["interrupted", "succeeded", "failed"].includes(entry.outcome) || !copied.terminalID) return;
    copied.outcome = entry.outcome;
  }
  return copied;
}

function manualOpener(message: Message): boolean {
  if (message.type === "user") return true;
  if (message.type === "compaction") return (message as Extract<Message, { type: "compaction" }>).reason === "manual";
  return message.type === "synthetic" && (message as Extract<Message, { type: "synthetic" }>).metadata?.notice !== "restart";
}

/** Native 2.2.5 restart notices reference the aborted assistant only by adjacency. */
export function restartsExecution(messages: readonly Message[], execution: OwnedStopExecution): boolean {
  if (!execution.assistantID || !execution.openerID) return false;
  const opener = messages.findIndex((message) => message.id === execution.openerID);
  const assistant = messages.findIndex((message) => message.id === execution.assistantID);
  if (opener < 0 || assistant <= opener) return false;
  const aborted = messages[assistant] as Extract<Message, { type: "assistant" }>;
  const next = messages[assistant + 1] as Message & { metadata?: { notice?: unknown } } | undefined;
  if (aborted.type !== "assistant" || aborted.error?.type !== "aborted" || next?.type !== "synthetic" || next.metadata?.notice !== "restart") return false;
  return !messages.slice(opener + 1).some((message) => message.type === "idle" || manualOpener(message));
}

interface ExecutionOutcome {
  kind: "stopped" | "completed" | "resumed" | "unknown";
  terminalID?: string;
}

function executionOutcome(execution: OwnedStopExecution | undefined, messages: readonly Message[], active: boolean): ExecutionOutcome {
  const terminal = messages.find((message) => message.id === execution?.terminalID && message.type === "idle") as Extract<Message, { type: "idle" }> | undefined;
  if (terminal) return { kind: terminal.outcome === "interrupted" ? "stopped" : "completed", terminalID: terminal.id };
  // A completion was already proven by the exact native terminal at shutdown.
  // A later bounded history read may omit it; that must not become a stop warning.
  if (execution?.terminalID && (execution.outcome === "succeeded" || execution.outcome === "failed")) return { kind: "completed", terminalID: execution.terminalID };
  if (execution && active && restartsExecution(messages, execution)) return { kind: "resumed" };
  return { kind: "unknown" };
}

function descendantSummary(outcomes: readonly ExecutionOutcome[]): string {
  const counts = { stopped: 0, resumed: 0, unknown: 0 };
  for (const outcome of outcomes) if (outcome.kind !== "completed") ++counts[outcome.kind];
  const parts: string[] = [];
  const label = (count: number) => `${count} subagent${count === 1 ? "" : "s"}`;
  if (counts.stopped) parts.push(`${label(counts.stopped)} stopped`);
  if (counts.resumed) parts.push(`${parts.length ? counts.resumed : label(counts.resumed)} ${counts.resumed === 1 ? "was" : "were"} resumed by OpenCode`);
  if (counts.unknown) parts.push(`${parts.length ? counts.unknown : label(counts.unknown)} may resume`);
  return parts.length ? parts.join("; ") + "." : "";
}

function recordOf(value: unknown): StopRecord | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as StopRecord;
  if (!validID(record.serverIdentity) || !Number.isFinite(record.at) || typeof record.complete !== "boolean" ||
    !ids(record.settled, stopNoteLimits.ids) || !ids(record.unsettled, stopNoteLimits.ids) || !ids(record.shown, stopNoteLimits.shown)) return;
  const executions = Array.isArray(record.executions) ? record.executions.slice(0, stopNoteLimits.ids).map(executionOf).filter((entry): entry is OwnedStopExecution => !!entry) : [];
  return { serverIdentity: record.serverIdentity, at: record.at, complete: record.complete, settled: record.settled, unsettled: record.unsettled, shown: record.shown, executions };
}

/** Private bridge-only annotations. Nothing here is written to native history. */
export class OpenCodeStopNotes {
  private records: StopRecord[] = [];
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      if (statSync(path).size > stopNoteLimits.bytes) return;
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved?.format !== 1 || !Array.isArray(saved.records) || saved.records.length > stopNoteLimits.records) return;
      this.records = saved.records.map(recordOf).filter((record: StopRecord | undefined): record is StopRecord => !!record);
      this.prune();
    } catch {
      // Missing, unreadable and corrupt state never prevents opening a thread.
    }
  }

  remember(result: OwnedStopResult): void {
    const settled = [...new Set(result.settled)].filter(validID).slice(0, stopNoteLimits.ids);
    const unsettled = [...new Set(result.unsettled)].filter(validID).slice(0, stopNoteLimits.ids);
    if (!validID(result.serverIdentity)) return;
    this.records.push({
      serverIdentity: result.serverIdentity, at: Date.now(), settled, unsettled, shown: [],
      complete: result.complete && settled.length === result.settled.length && unsettled.length === result.unsettled.length,
      executions: (result.executions ?? []).slice(0, stopNoteLimits.ids).map(executionOf).filter((entry): entry is OwnedStopExecution => !!entry),
    });
    this.save();
  }

  get pending(): boolean { this.prune(); return this.records.length > 0; }

  executionSessions(nativeIDs: ReadonlySet<string>): string[] {
    this.prune();
    return [...new Set(this.records.flatMap((record) => (record.executions ?? []).map((entry) => entry.sessionID)))].filter((id) => nativeIDs.has(id)).slice(0, stopNoteLimits.ids);
  }

  /** Fresh native reads decide what really happened, rather than repeating a prediction. */
  take(id: string, nativeIDs: readonly string[], messages: readonly Message[], active: ReadonlySet<string>, created = 0, inventoryComplete = true, histories: ReadonlyMap<string, readonly Message[]> = new Map([[id, messages]])): StopNote | undefined {
    this.prune();
    const own = new Set([id, ...nativeIDs]);
    const record = this.records.findLast((record) => {
      const unknown = (!record.complete || !inventoryComplete) && created <= record.at;
      const affected = [...record.settled, ...record.unsettled].some((native) => own.has(native));
      return !record.shown.includes(id) && (unknown || affected);
    });
    if (!record) return;
    const executions = new Map(record.executions?.map((entry) => [entry.sessionID, entry]));
    const targets = new Set([...record.settled, ...record.unsettled].filter((native) => own.has(native)));
    const outcomes = new Map([...targets].map((native) => [native, executionOutcome(executions.get(native), native === id ? messages : histories.get(native) ?? [], active.has(native))]));
    const root = outcomes.get(id);
    const execution = executions.get(id);
    const opener = messages.findIndex((message) => message.id === execution?.openerID);
    const laterOpener = opener >= 0 ? messages.slice(opener + 1).some(manualOpener) :
      messages.some((message) => manualOpener(message) && message.time.created > record.at);
    const statements: string[] = [];
    const afterMessageID = root?.terminalID ?? execution?.assistantID ?? execution?.openerID;
    if (root?.terminalID || !laterOpener) {
      if (root?.kind === "stopped") statements.push(`This turn ${ownedStopReason}.`);
      if (root?.kind === "resumed") statements.push(resumed);
      if (root?.kind === "unknown") statements.push(ownedStopWarning);
      const descendants = descendantSummary([...outcomes].filter(([native]) => native !== id).map(([, outcome]) => outcome));
      if (descendants) statements.push(descendants);
      if (!targets.size) statements.push(ownedStopWarning);
      else if (!inventoryComplete) statements.push("Other work may resume; inventory incomplete.");
    }
    this.shown(id, nativeIDs);
    return statements.length ? { text: `Portals: ${statements.join("\n")}`, timestamp: record.at / 1000, afterMessageID } : undefined;
  }

  /** Also used after a live delivery, or when a native session no longer exists. */
  shown(id: string, nativeIDs: readonly string[] = []): void {
    this.consume(id, nativeIDs);
    this.save();
  }

  /** One durable write for all threads which received this callback live. */
  delivered(ids: readonly string[]): void {
    for (const id of ids) this.consume(id, []);
    if (ids.length) this.save();
  }

  private consume(id: string, nativeIDs: readonly string[]): void {
    const own = new Set([id, ...nativeIDs]);
    for (const record of this.records) {
      if (record.complete && ![...record.settled, ...record.unsettled].some((native) => own.has(native))) continue;
      if (!record.shown.includes(id)) record.shown.push(id);
      record.settled = record.settled.filter((native) => !own.has(native));
      record.unsettled = record.unsettled.filter((native) => !own.has(native));
      record.executions = record.executions?.filter((entry) => !own.has(entry.sessionID));
    }
  }

  private prune(): void {
    const now = Date.now();
    this.records = this.records.filter((record) => record.at <= now && now - record.at < stopNoteLimits.ageMs &&
      record.shown.length < stopNoteLimits.shown && (!record.complete || record.settled.length + record.unsettled.length > 0)).slice(-stopNoteLimits.records);
  }

  private save(): void {
    this.prune();
    const saved = { format: 1, records: this.records };
    while (Buffer.byteLength(JSON.stringify(saved, null, 1) + "\n") > stopNoteLimits.bytes && this.records.length) this.records.shift();
    try { writeJSON(this.path, saved); }
    catch (error) { log.warn("could not keep OpenCode's shutdown notes", { error: (error as NodeJS.ErrnoException).code ?? "write failed" }); }
  }
}
