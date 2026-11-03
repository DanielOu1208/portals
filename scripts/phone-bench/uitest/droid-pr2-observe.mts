import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { tokenTotal } from "../../../bridge/src/providers/droid/activity.ts";
import { droidEnvironment, localSdk, type DroidHandle, type DroidSdk } from "../../../bridge/src/providers/droid/sdk.ts";

export const approvedModel = "claude-haiku-5-5";
export type Metric = Record<string, unknown> & { at: number; event: string };
type StreamEvent = ReturnType<DroidHandle["stream"]> extends AsyncIterable<infer Event> ? Event : never;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Observes already-parsed SDK fields. No prompt, stdout, request body or auth is logged. */
export class SdkObservation {
  readonly rows: Metric[] = [];
  readonly sdk: DroidSdk;
  opens = 0;
  closes = 0;
  modelLists = 0;
  private readonly file: string;

  constructor(command: string, file: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = file;
    const native = localSdk(command, droidEnvironment(env));
    this.sdk = {
      open: async (options, id) => {
        this.opens += 1;
        this.record("sdk.open", { resume: id !== undefined, session: id });
        return this.wrap(await native.open(options, id));
      },
      models: async (cwd) => {
        this.modelLists += 1;
        this.record("sdk.models");
        return native.models(cwd);
      },
    };
  }

  record(event: string, fields: Record<string, unknown> = {}): void {
    const row = { at: Date.now(), event, ...fields };
    this.rows.push(row);
    appendFileSync(this.file, JSON.stringify(row) + "\n", { mode: 0o600 });
  }

  private event(event: StreamEvent, session: string): void {
    if (event.type === "token_usage_update") {
      this.record("sdk.tokens", { session, total: tokenTotal(event) });
    } else if (event.type === "tool_call") {
      this.record("sdk.tool.start", { session, id: event.toolUseId, name: event.name });
    } else if (event.type === "tool_progress") {
      const output = object(event.update)?.fullOutput;
      this.record("sdk.progress", { session, id: event.toolUseId,
        bytes: typeof output === "string" ? Buffer.byteLength(output) : undefined });
    } else if (event.type === "result") {
      this.record("sdk.result", { session, subtype: event.subtype });
    }
  }

  private wrap(handle: DroidHandle): DroidHandle {
    const observer = this;
    let closed = false;
    function inferenceModel(): string {
      const model = handle.settings.interactionMode === "spec"
        ? handle.settings.specModeModelId ?? handle.settings.modelId : handle.settings.modelId;
      if (model !== approvedModel) {
        throw new Error(`Refusing inference with unapproved model ${model}`);
      }
      return model;
    }
    const stream = ((...args: Parameters<DroidHandle["stream"]>) => {
      const model = inferenceModel();
      observer.record("sdk.stream", { session: handle.id, model });
      const source = handle.stream(...args);
      return (async function* () {
        for await (const event of source) {
          observer.event(event, handle.id);
          yield event;
        }
      })();
    }) as DroidHandle["stream"];
    return new Proxy(handle, {
      get(target, key) {
        if (key === "stream") return stream;
        if (key === "close") return async () => {
          await target.close();
          if (!closed) {
            closed = true;
            observer.closes += 1;
            observer.record("sdk.closed", { session: target.id });
          }
        };
        if (key === "compact") return async (...args: Parameters<DroidHandle["compact"]>) => {
          observer.record("sdk.compact", { session: target.id, model: inferenceModel() });
          const outcome = await target.compact(...args);
          return { ...outcome, session: observer.wrap(outcome.session) };
        };
        if (key === "onNotification") return (callback: Parameters<DroidHandle["onNotification"]>[0],
          filter?: Parameters<DroidHandle["onNotification"]>[1]) => target.onNotification((raw) => {
          const params = object(raw.params);
          const notification = object(params?.notification);
          if (notification?.type === "create_message") {
            const message = object(notification.message);
            if (message?.role === "user" && message.parentId === "root" && message.visibility !== "llm_only") {
              observer.record("sdk.root", { session: params?.sessionId });
            }
          }
          if (notification?.type === "droid_working_state_changed") {
            observer.record("sdk.state", { session: params?.sessionId, state: notification.newState });
          } else if (notification?.type === "agent_turn_completed") {
            observer.record("sdk.completed", { session: params?.sessionId,
              cumulative: tokenTotal(notification.cumulativeTokenUsage), reason: notification.reason });
          }
          callback(raw);
        }, filter);
        return Reflect.get(target, key, target);
      },
    });
  }
}

export interface HistoryEntry { nameHash: string; kind: "file" | "directory"; bytes: number; mtime: number }

/** Names are compared, then pseudonymized in evidence; symlinks and file bodies are never read. */
export function historyMetadata(): HistoryEntry[] {
  const root = join(homedir(), ".factory", "sessions");
  const entries: HistoryEntry[] = [];
  if (!existsSync(root)) return entries;
  if (lstatSync(root).isSymbolicLink()) throw new Error("Refusing symlinked history root");
  function walk(directory: string, relative = ""): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entries.length >= 100_000) throw new Error("History metadata exceeds bounded snapshot");
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue;
      entries.push({ nameHash: createHash("sha256").update(name).digest("hex"),
        kind: stat.isDirectory() ? "directory" : "file", bytes: stat.size, mtime: stat.mtimeMs });
      if (stat.isDirectory()) walk(path, name);
    }
  }
  walk(root);
  return entries.sort((a, b) => a.nameHash.localeCompare(b.nameHash));
}

/** A one-off owned-descendant census. Arguments are deliberately excluded. */
export async function childProcesses(): Promise<{ pid: number; parent: number; executable: string }[]> {
  const result = await promisify(execFile)("/bin/ps", ["-axo", "pid=,ppid=,comm="]);
  const rows = result.stdout.trim().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), executable: basename(match[3]!) }] : [];
  });
  const owned = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  return rows.filter((row) => row.pid !== process.pid && owned.has(row.pid) && row.executable !== "ps");
}
