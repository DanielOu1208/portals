import type { SessionSink, SubagentInfo, SubagentStatus } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import { OpenCodeForms } from "./forms.ts";
import type { Json, Message, OpenCodeEvent, PermissionRequest, SessionInfo } from "./protocol.ts";
import { gatewayTool, type ToolOutcome } from "./tools.ts";
import type { FormInfo } from "@opencode/client";
import { log } from "../../log.ts";
import { NativeRevisions } from "./revisions.ts";

const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Native child sessions, not parent reply fragments. A child keeps running when its background tool returns. */
export class OpenCodeSubagents {
  private readonly rows = new Map<string, SubagentInfo>();
  private readonly calls = new Map<string, string>();
  private readonly forms = new Map<string, OpenCodeForms>();
  private readonly past: { subagent: SubagentInfo; turn: number }[] = [];
  private emitting = false;
  private closed = false;
  private readonly parent: string;
  private readonly api: () => Promise<OpenCodeApi>;
  private readonly sink: SessionSink;
  private readonly permission: (request: PermissionRequest) => void;
  private readonly prepare: ((id: string) => Promise<void>) | undefined;
  private readonly prepared = new Set<string>();
  private readonly nativeStatus = new Map<string, SubagentStatus>();
  private readonly revisions = new NativeRevisions();

  constructor(
    parent: string,
    api: () => Promise<OpenCodeApi>,
    sink: SessionSink,
    permission: (request: PermissionRequest) => void,
    messages: Message[],
    children: SessionInfo[],
    active: ReadonlySet<string>,
    prepare?: (id: string) => Promise<void>,
  ) {
    this.parent = parent;
    this.api = api;
    this.sink = sink;
    this.permission = permission;
    this.prepare = prepare;
    for (const info of children) this.session(info, active.has(info.id));
    let turn = 0;
    const turns = new Map<string, number>();
    for (const message of messages) {
      if (message.type === "idle") turn += 1;
      if (message.type !== "assistant") continue;
      for (const part of (message as Extract<Message, { type: "assistant" }>).content) {
        if (part.type !== "tool" || part.state.status === "streaming") continue;
        const state = part.state;
        let outcome: ToolOutcome | undefined;
        if (state.status === "completed") outcome = { ok: true, content: state.content, metadata: state.metadata };
        else if (state.status === "error") outcome = { ok: false, error: state.error, content: state.content, metadata: state.metadata };
        this.tool(part.id, part.name, state.input, state.metadata, outcome, message.time.created);
        const id = this.calls.get(part.id);
        if (id) turns.set(id, turn);
      }
    }
    // Native current activity wins over an old completed/backgrounded tool in history.
    for (const info of children) this.session(info, active.has(info.id));
    for (const row of this.rows.values()) if (row.status !== "running") this.past.push({ subagent: structuredClone(row), turn: (turns.get(row.id) ?? Math.max(0, turn - 1)) - Math.max(0, turn - 1) });
    this.emitting = true;
  }

  owns(id: string): boolean {
    return this.rows.has(id);
  }

  runningIDs(): string[] {
    return [...this.rows.values()].filter((row) => row.status === "running").map((row) => row.id);
  }

  hasRunning(): boolean {
    return [...this.rows.values()].some((row) => row.status === "running");
  }

  history(): { subagent: SubagentInfo; turn: number }[] {
    return structuredClone(this.past);
  }

  attached(): void {
    for (const row of this.rows.values()) if (row.status === "running") this.tell(row);
  }

  tool(call: string, name: string, input: Json, metadata: Json | undefined, outcome?: ToolOutcome, at = Date.now()): void {
    if (name !== "subagent" && name !== "task") return;
    const id = text(metadata?.sessionID) || this.calls.get(call) || text(input.sessionID);
    if (!id || id === this.parent) return;
    this.calls.set(call, id);
    const before = this.rows.get(id);
    const row: SubagentInfo = {
      ...before,
      id, kind: "agent", goal: text(input.description) || before?.goal || text(input.prompt) || "OpenCode subagent",
      role: text(input.agent) || text(input.subagent_type) || before?.role,
      startedAt: before?.startedAt ?? at, status: "running", background: input.background === true || metadata?.status === "backgrounded" || before?.background === true, stoppable: true,
    };
    if (outcome?.ok === true && !row.background) {
      row.status = "completed";
      row.result = outcome.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").slice(0, 10_000);
    } else if (outcome?.ok === false) {
      row.status = outcome.error.type === "aborted" ? "stopped" : "failed";
      row.result = outcome.error.message;
    } else if (outcome?.ok === "stopped" && !row.background) row.status = "stopped";
    else if (!outcome || metadata?.status === "backgrounded") row.status = "running";
    // A parent's scheduling result is not the background child's outcome.
    // Once native child activity is known it also wins over delayed parent tools.
    const nativeStatus = this.nativeStatus.get(id);
    row.status = nativeStatus ?? row.status;
    if (row.status !== "running") {
      row.endedAt = nativeStatus ? before?.endedAt ?? at : at;
      row.stoppable = false;
    } else delete row.endedAt;
    this.update(row);
  }

  event(event: OpenCodeEvent): boolean {
    if (this.closed) return false;
    const data = event.data;
    const id = text(data.sessionID) || text((data.form as Json | undefined)?.sessionID);
    const parent = text(data.parentID);
    if (event.type === "session.created" && id && (parent === this.parent || this.owns(parent))) {
      this.session({ id, parentID: parent, title: text(data.title), agent: text(data.agent), model: data.model as SessionInfo["model"], time: { created: event.created ?? Date.now(), updated: event.created ?? Date.now() } }, true);
      return true;
    }
    const row = this.rows.get(id);
    if (!row) return false;
    const change = { ...row };
    if (event.type === "session.execution.started") {
      change.status = "running";
      change.stoppable = true;
      change.startedAt = event.created ?? Date.now();
      delete change.endedAt;
      delete change.result;
      delete change.summary;
    }
    else if (event.type === "session.execution.succeeded") change.status = "completed";
    else if (event.type === "session.execution.interrupted") change.status = "stopped";
    else if (event.type === "session.execution.failed") { change.status = "failed"; change.result = text((data.error as Json | undefined)?.message); }
    else if (event.type === "session.text.delta") {
      change.result = ((change.result ?? "") + text(data.delta)).slice(-10_000);
      change.summary = change.result.slice(-200);
    } else if (event.type === "session.tool.input.started") change.tool = gatewayTool(text(data.name), {}).name;
    else if (event.type === "permission.asked") this.permission(data as unknown as PermissionRequest);
    else if (event.type === "form.created") void this.form(id).ask(data.form as unknown as FormInfo);
    else if (event.type === "form.replied" || event.type === "form.cancelled") this.form(id).resolved(text(data.id));
    else return false;
    this.revisions.changed(id);
    if (event.type.startsWith("session.execution.")) this.nativeStatus.set(id, change.status);
    if (change.status !== "running") {
      change.endedAt = event.created ?? Date.now();
      change.stoppable = false;
    }
    this.update(change);
    return true;
  }

  async stop(id: string): Promise<boolean> {
    if (this.rows.get(id)?.status !== "running") return false;
    const api = await this.api();
    const info = await api.session(id);
    if (info.parentID !== this.parent && !this.owns(info.parentID ?? "")) return false;
    return api.interrupt(id);
  }

  async reconcile(): Promise<void> {
    const revision = this.revisions.start();
    try {
      await this.readChildren(revision);
    } finally { this.revisions.finish(revision); }
  }

  private async readChildren(revision: number): Promise<void> {
    const api = await this.api();
    const [children, active] = await Promise.all([api.sessions(1000, this.parent), api.active()]);
    if (this.closed) return;
    const seen = new Set<string>();
    const pending = [...children];
    // A user may permit nested agents. Follow native parentage, with a bound even for a broken server.
    for (let at = 0; at < pending.length && at < 1000; at += 1) {
      const info = pending[at];
      if (seen.has(info.id) || info.id === this.parent) continue;
      seen.add(info.id);
      this.session(info, active.has(info.id), revision);
      pending.push(...await api.sessions(1000 - seen.size, info.id));
      if (this.closed) return;
    }
    for (const row of this.rows.values()) {
      if (row.status !== "running") continue;
      await this.form(row.id).reconcile();
    }
  }

  close(): void {
    this.closed = true;
    for (const form of this.forms.values()) form.close();
  }

  /** Native parent deletion also removes its children; no interrupt is needed. */
  deleted(): void {
    for (const row of this.rows.values()) {
      if (row.status === "running") this.update({ ...row, status: "stopped", stoppable: false, endedAt: Date.now() });
    }
    this.close();
  }

  private session(info: SessionInfo, running: boolean, revision?: number): void {
    if (revision === undefined) this.revisions.changed(info.id);
    else if (!this.revisions.apply(info.id, revision)) return;
    if (!this.prepared.has(info.id)) {
      this.prepared.add(info.id);
      // Native children act on their bridge-owned root thread, not a fictitious
      // Portals thread named after their private native session.
      void this.prepare?.(info.id).catch((error: Error) => log.warn("could not prepare an OpenCode child's portals command", { error: error.message }));
    }
    const before = this.rows.get(info.id);
    let status: SubagentStatus = "stopped";
    if (running) status = "running";
    else if (info.outcome === "succeeded") status = "completed";
    else if (info.outcome === "failed") status = "failed";
    this.nativeStatus.set(info.id, status);
    this.update({
      ...before, id: info.id, kind: "agent", goal: info.title || before?.goal || "OpenCode subagent",
      ...(info.parentID && info.parentID !== this.parent ? { parent: info.parentID } : {}),
      role: info.agent || before?.role, model: info.model?.id || before?.model,
      startedAt: before?.startedAt ?? info.time.busy ?? info.time.created,
      status, background: before?.background ?? true, stoppable: running,
      ...(!running ? { endedAt: info.time.idle ?? info.time.updated } : { endedAt: undefined }),
    });
  }

  private form(id: string): OpenCodeForms {
    let form = this.forms.get(id);
    if (!form) {
      form = new OpenCodeForms(id, this.api, { emit: (event) => this.sink.emit(event), ask: (request, signal) => this.sink.ask({ ...request, subagent: id }, signal) });
      this.forms.set(id, form);
    }
    return form;
  }

  private update(row: SubagentInfo): void {
    if (this.closed) return;
    const before = this.rows.get(row.id);
    this.rows.set(row.id, row);
    if (row.status !== "running") this.forms.get(row.id)?.withdraw();
    if (JSON.stringify(before) !== JSON.stringify(row)) this.tell(row);
  }

  private tell(row: SubagentInfo): void {
    if (this.emitting && !this.closed) this.sink.emit({ type: "subagent", subagent: structuredClone(row) });
  }
}
