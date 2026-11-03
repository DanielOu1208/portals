import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { AutonomyLevel, DroidInteractionMode, filterMessagesForUI } from "@factory/droid-sdk/node";
import { titleFrom } from "../titles.ts";
import { DeskRefused, type StoredMessage } from "../types.ts";
import { appEffort } from "./models.ts";
import type { DroidThread } from "./store.ts";
import { runsInBackground } from "./stream.ts";
import { gatewayResult, gatewayTool } from "./tools.ts";

export const droidSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const snapshotField = "portalsForkSnapshot";

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function parsed(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)); } catch { return undefined; }
}
function displayedMessage(value: unknown): Record<string, unknown> | undefined {
  const message = object(value);
  if (!message || message.hookEventName) return undefined;
  let content: Record<string, unknown>[] = [];
  if (typeof message.content === "string") content = [{ type: "text", text: message.content }];
  else if (Array.isArray(message.content)) {
    content = message.content.map(object).filter((block): block is Record<string, unknown> =>
      block !== undefined && (block.type !== "text" || typeof block.text === "string"));
  }
  // Persisted tool blocks differ from SDK memory blocks; its pure display filter only inspects text.
  const normalized = filterMessagesForUI([{ ...message, content } as unknown as Parameters<typeof filterMessagesForUI>[0][number]]);
  return object(normalized[0]);
}

export interface StoredDroidSession {
  id: string;
  cwd: string;
  title: string;
  path: string;
  updated: number;
}

/** Droid's own files. Discovery never loads a session or starts a process. */
export class DroidSessionFiles {
  readonly root: string;
  private readonly names: string;
  private readonly cache = new Map<string, { size: number; changed: number; session: StoredDroidSession | null }>();

  constructor(home: string, names: string) {
    this.root = join(home, ".factory", "sessions");
    this.names = resolve(names);
  }

  async newest(wanted: number): Promise<StoredDroidSession[]> {
    const files = await this.files();
    const result: StoredDroidSession[] = [];
    for (const file of files.sort((a, b) => b.updated - a.updated)) {
      const known = this.cache.get(file.path);
      let session = known?.size === file.size && known.changed === file.updated ? known.session : undefined;
      if (session === undefined) {
        const text = await readFile(file.path, "utf8").catch(() => null);
        if (text === null) continue;
        session = this.summary(text, file.path, file.updated);
        this.cache.set(file.path, { size: file.size, changed: file.updated, session });
      }
      if (session) result.push(session);
      if (result.length >= wanted) break;
    }
    const there = new Set(files.map((file) => file.path));
    for (const path of this.cache.keys()) if (!there.has(path)) this.cache.delete(path);
    return result;
  }

  async find(id: string): Promise<StoredDroidSession | null> {
    if (!droidSessionId.test(id)) return null;
    for (const file of (await this.files(id)).sort((a, b) => b.updated - a.updated)) {
      const text = await readFile(file.path, "utf8").catch(() => null);
      if (text !== null) {
        const session = this.summary(text, file.path, file.updated);
        if (session) return session;
      }
    }
    return null;
  }

  private async files(id?: string): Promise<{ path: string; size: number; updated: number }[]> {
    const folders = await readdir(this.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const result: { path: string; size: number; updated: number }[] = [];
    for (const folder of folders) {
      // "btw" holds Droid's hidden side chats and our temporary fork sources.
      if (!folder.isDirectory() || !folder.name.startsWith("-")) continue;
      const directory = join(this.root, folder.name);
      const entries = id ? [`${id}.jsonl`] : await readdir(directory).catch(() => []);
      for (const name of entries) {
        if (!name.endsWith(".jsonl") || !droidSessionId.test(name.slice(0, -6))) continue;
        const path = join(directory, name);
        const info = await lstat(path).catch(() => null);
        if (info?.isFile()) result.push({ path, size: info.size, updated: info.mtimeMs });
      }
    }
    return result;
  }

  private summary(text: string, path: string, updated: number): StoredDroidSession | null {
    const [first, ...lines] = text.split("\n");
    const header = parsed(first);
    const id = basename(path, ".jsonl");
    const cwd = header?.lastCwd ?? header?.cwd;
    if (header?.type !== "session_start" || (header.id ?? header.sessionId) !== id || typeof cwd !== "string" || !isAbsolute(cwd)) return null;
    if (header[snapshotField] !== undefined || header.callingSessionId || header.decompSessionType || resolve(cwd) === this.names) return null;
    let prompt: string | undefined;
    for (const line of lines) {
      const entry = parsed(line);
      const message = displayedMessage(entry?.message);
      if (entry?.type !== "message" || message?.role !== "user") continue;
      const text = displayText(message.content);
      if (text) { prompt = text; break; }
    }
    if (prompt === undefined) return null;
    return { id, cwd, path, updated, title: typeof header.title === "string" && header.title.trim() ? header.title.trim() : titleFrom(prompt) ?? "" };
  }

  /**
   * Droid's saved settings of a session (none when it has no settings file). A Mission
   * session (any mode but Auto or Spec) is refused: Portals cannot run one, so it is
   * neither read nor forked, before Droid is asked to make anything of it.
   */
  async settings(session: StoredDroidSession): Promise<Record<string, unknown>> {
    let settings: Record<string, unknown> = {};
    try { settings = parsed(await readFile(session.path.replace(/\.jsonl$/, ".settings.json"), "utf8")) ?? {}; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (settings.interactionMode && !["spec", "auto"].includes(String(settings.interactionMode))) {
      throw new DeskRefused("This is a Droid Mission session, which Portals cannot read, continue or fork. Open it in Droid.");
    }
    return settings;
  }

  async thread(session: StoredDroidSession, id = session.id): Promise<DroidThread> {
    const history = droidTranscript(await readFile(session.path, "utf8"), session.cwd);
    const settings = await this.settings(session);
    const model = typeof settings.model === "string" && settings.model ? settings.model : "";
    const effort = typeof settings.reasoningEffort === "string" ? settings.reasoningEffort : "";
    const autonomy = Object.values(AutonomyLevel).includes(settings.autonomyLevel as AutonomyLevel) ? settings.autonomyLevel as AutonomyLevel : AutonomyLevel.Off;
    const interaction = settings.interactionMode === "spec" ? DroidInteractionMode.Spec : DroidInteractionMode.Auto;
    return {
      version: 1, id, session: session.id, cwd: session.cwd, defaults: { autonomyLevel: autonomy, interactionMode: interaction },
      defaultModel: model, defaultEffort: effort, settings: { model: model || "default", provider: "droid", reasoningEffort: appEffort(effort) },
      mode: "default", beforePlan: "default", open: false, ...history, deskSource: true, deskReadOnly: true,
    };
  }
}

function displayText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((value) => {
    const block = object(value);
    return block?.type === "text" && typeof block.text === "string" ? block.text : block?.type === "image" ? "[Image]" : "";
  }).filter(Boolean).join("\n");
}

/** Displayed messages, not model-only context, hook records or embedded authentication fields. */
export function droidHistory(text: string, cwd: string): StoredMessage[] {
  return droidTranscript(text, cwd).messages;
}

function droidTranscript(text: string, cwd: string): Pick<DroidThread, "messages" | "nativeToolIds"> {
  const result: StoredMessage[] = [];
  const unfinished = "Tool not finished: This call had no completed result in the saved source. Portals did not run it.";
  const nativeToolIds: Record<string, string> = {};
  let background = 0;
  const tools = new Map<string, Extract<StoredMessage, { role: "tool" }>>();
  for (const line of text.split("\n").slice(1)) {
    const entry = parsed(line);
    if (!entry) continue;
    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.timestamp ?? ""));
    const at = Number.isFinite(timestamp) ? timestamp : 0;
    if (entry.type === "compaction_state" || entry.type === "compaction") { result.push({ role: "compaction", trigger: "auto", timestamp: at }); continue; }
    const message = displayedMessage(entry.message);
    if (entry.type !== "message" || !message) continue;
    const blocks = Array.isArray(message.content) ? message.content.map(object).filter((block) => block !== undefined) : [];
    let said = typeof message.content === "string" ? message.content : "";
    let thinking = "";
    const flush = () => {
      if (message.role === "user" && said) result.push({ role: "user", text: said, timestamp: at });
      if (message.role === "assistant" && (said || thinking)) result.push({ role: "assistant", text: said, timestamp: at, ...(thinking ? { reasoning: thinking } : {}) });
      said = ""; thinking = "";
    };
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") said += block.text;
      else if (block.type === "image" && message.role === "user") said += "\n[Image]";
      else if (block.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
      else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        flush();
        const input = object(block.input) ?? {};
        const tool = gatewayTool(block.name, input);
        // Stable on reload, distinct for every saved background invocation, even when native ids repeat.
        const id = runsInBackground(block.name, input) ? `${block.id}#bg-${(++background).toString(16).padStart(8, "0")}` : block.id;
        if (id !== block.id) nativeToolIds[id] = block.id;
        const row = { role: "tool" as const, ...tool, tool_call_id: id, timestamp: at,
          content: JSON.stringify(gatewayResult(tool, unfinished, true, cwd)) };
        tools.set(block.id, row);
        result.push(row);
      } else if (block.type === "tool_result") {
        const id = block.toolUseId ?? block.tool_use_id;
        const row = typeof id === "string" ? tools.get(id) : undefined;
        const pending = block.content === "__TOOL_RESULT_PENDING__" || block.content == null;
        if (row) row.content = JSON.stringify(gatewayResult(row, pending ? unfinished : block.content,
          pending || block.isError === true || block.is_error === true, cwd));
      }
    }
    flush();
  }
  return { messages: result, nativeToolIds };
}
