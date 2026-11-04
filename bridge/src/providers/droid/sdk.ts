import {
  ContextBreakdownResultSchema, createSession, ForkSessionResultSchema, listModels, PickOptionsRequestParamsSchema, PickOptionsResultSchema, resumeSession,
  ToggleMcpToolResultSchema, SubmitMcpAuthCodeResultSchema, CancelMcpAuthResultSchema, AuthenticateMcpServerResultSchema,
  type ContextBreakdownResult, type CreateSessionOptions, type PickOptionsRequestParams, type PickOptionsResult, type DroidClient, type DroidSession, type ModelInfo, type SessionCompactionOutcome,
} from "@factory/droid-sdk/node";
import { execFile, type ChildProcess } from "node:child_process";
import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DroidTransport } from "./rpc.ts";
import { mcpAuthDeadlineMs } from "../mcpAuth.ts";
import { z } from "zod";

type RpcResult<M extends "addUserMessage" | "resolveQueuedUserMessage"> =
  NonNullable<Awaited<ReturnType<DroidClient[M]>>["result"]>;

// The SDK sends this RPC but types its result as {} (0.9.1 and 0.10.0). Keep only its documented fields.
const commandListSchema = z.object({ commands: z.array(z.object({
  name: z.string(), description: z.string(), argumentHint: z.string().optional(), isExecutable: z.boolean().optional(),
})) });

// Droid's answer to `droid.kill_background_process`, an RPC the SDK does not have (CLI 1.3).
const killedSchema = z.object({ killed: z.boolean() });

/** The SDK surface used here, kept injectable without starting a real Droid in tests. */
export type DroidHandle = Pick<DroidSession, "id" | "cwd" | "settings" | "stream" | "interrupt" | "close" | "updateSettings" | "rename" | "getContextStats" | "onNotification" |
  "listSkills" | "setSkillDisabled" | "listMcpServers" | "listMcpTools" | "toggleMcpServer" | "authenticateMcpServer"> & {
  toggleMcpTool(serverName: string, toolName: string, enabled: boolean): Promise<{ success: boolean }>;
  submitMcpAuthCode(params: { serverName: string; code: string; state: string }): Promise<{ success: boolean }>;
  cancelMcpAuth(serverName: string): Promise<{ success: boolean }>;
  /**
   * Interrupts what the process is doing, also while the SDK replaces the session (a
   * compaction), when the SDK's own `interrupt` refuses.
   */
  interruptAny(): Promise<void>;
  compact(params?: Parameters<DroidSession["compact"]>[0]): Promise<SessionCompactionOutcome<DroidHandle>>;
  listCommands(): Promise<z.infer<typeof commandListSchema>>;
  getContextBreakdown(): Promise<ContextBreakdownResult>;
  addUserMessage(params: Parameters<DroidClient["addUserMessage"]>[0], requestId?: string): Promise<RpcResult<"addUserMessage">>;
  resolveQueuedUserMessage(params: Parameters<DroidClient["resolveQueuedUserMessage"]>[0]): Promise<RpcResult<"resolveQueuedUserMessage">>;
  connected(): boolean;
  onExit(listener: (error: Error) => void): () => void;
  /** What Droid said, as it loaded the session it resumed, its last call to the model took (`DroidTransport.loadedUsage`). */
  loadedUsage?(): unknown;
  /** Who answers Droid's pick lists (`droid.pick_options`) on this process (`DroidTransport.pickOptions`). */
  onPickOptions?(handler: (params: PickOptionsRequestParams) => Promise<PickOptionsResult>): void;
  /** Copies the current conversation without replacing or closing this handle. */
  fork?(title: string): Promise<string>;
  /** Who is told the commands the process runs in the background, each time they change (`DroidTransport.backgroundProcesses`). */
  onBackgroundProcesses?(listener: (session: string, processes: unknown) => void): void;
  /** Stops one command Droid runs in the background, by Droid's id for it: whether Droid stopped it. */
  killBackgroundProcess?(processId: string): Promise<boolean>;
};

/** One short request for a thread's name (`DroidSdk.title`). */
export interface TitleRequest {
  /** The whole message Droid is given: the title prompt with the thread's first message. */
  prompt: string;
  /** Appended to Droid's system prompt. */
  instructions: string;
  model: string;
  /** The lowest the model takes; left out when not known. */
  effort?: string;
  /** The folder it runs in: one of the bridge's own, empty, where nothing of the user's is. */
  cwd: string;
  signal?: AbortSignal;
}

export interface DroidSdk {
  /** `env` is added to the process's environment: its thread's `PORTALS_THREAD`, for the `portals` command to say which thread it runs in. */
  open(options: CreateSessionOptions, id?: string, env?: Record<string, string>): Promise<DroidHandle>;
  models(cwd?: string): Promise<ModelInfo[]>;
  /**
   * Droid's answer to one message, in a one-shot `droid exec` that is gone after it
   * (`TitleRequest`): what names a thread. Left out where it cannot be asked (tests).
   */
  title?(request: TitleRequest): Promise<string>;
  /** Native fork of a throwaway snapshot; the person's source is never loaded. */
  fork?(snapshot: string, cwd: string, title: string, runtimeSettings: string): Promise<string>;
  /** Processes this SDK owns, for the check against another app holding a session. */
  ownedPids?(): ReadonlySet<number>;
}

/** Child-only settings: never changes the user's login, settings file, or installed CLI. */
export function droidEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries({ ...env, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function localSdk(command: string, env: Record<string, string>): DroidSdk {
  const owned = new Set<number>();
  async function connect(cwd?: string, extra?: Record<string, string>, extraArgs?: string[]): Promise<DroidTransport> {
    const transport = new DroidTransport({ droidExecPath: command, env: extra ? { ...env, ...extra } : env, cwd, droidExecExtraArgs: extraArgs });
    try {
      await transport.connect();
      const child = transport.getManagedProcess()?.childProcess;
      if (child?.pid) {
        const pid = child.pid;
        owned.add(pid);
        child.once("exit", () => owned.delete(pid));
      }
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  return {
    async open(options, id, extra) {
      // The convenience launcher insists on an API key. The SDK's own exported
      // transport leaves authentication to the CLI, including its existing login.
      const transport = await connect(options.cwd, extra);
      try {
        const session = id
          ? await resumeSession(id, {
              transport, abortSignal: options.abortSignal,
              permissionHandler: options.permissionHandler, askUserHandler: options.askUserHandler,
            })
          : await createSession({ ...options, transport });
        const wrap = (session: DroidSession): DroidHandle => ({
          get id() { return session.id; },
          get cwd() { return session.cwd; },
          get settings() { return session.settings; },
          stream: ((...params: Parameters<DroidSession["stream"]>) => transport.stream(session, ...params)) as DroidSession["stream"],
          interrupt: () => session.interrupt(),
          interruptAny: async () => { await transport.request("droid.interrupt_session", {}); },
          updateSettings: (settings) => session.updateSettings(settings),
          rename: (params) => session.rename(params),
          getContextStats: () => session.getContextStats(),
          listSkills: () => session.listSkills(),
          setSkillDisabled: (params) => session.setSkillDisabled(params),
          listMcpServers: () => session.listMcpServers(),
          listMcpTools: () => session.listMcpTools(),
          toggleMcpServer: (params) => session.toggleMcpServer(params),
          // The SDK's convenience method has a fixed five-minute timeout. Our own
          // ten-minute deadline cancels first; leave time for that cancellation reply.
          authenticateMcpServer: async (params) => AuthenticateMcpServerResultSchema.parse(
            await transport.request("droid.authenticate_mcp_server", params, undefined, mcpAuthDeadlineMs + 30_000)),
          submitMcpAuthCode: async (params) => SubmitMcpAuthCodeResultSchema.parse(await transport.request("droid.submit_mcp_auth_code", params)),
          cancelMcpAuth: async (serverName) => CancelMcpAuthResultSchema.parse(await transport.request("droid.cancel_mcp_auth", { serverName })),
          toggleMcpTool: async (serverName, toolName, enabled) =>
            ToggleMcpToolResultSchema.parse(await transport.request("droid.toggle_mcp_tool", { serverName, toolName, enabled })),
          fork: async (title) => ForkSessionResultSchema.parse(await transport.request("droid.fork_session", { title })).newSessionId,
          onNotification: (callback, filter) => session.onNotification((raw) => {
            const params = raw.params as { notification?: unknown } | undefined;
            if (!transport.refusedEnd(params?.notification)) callback(raw);
          }, filter),
          listCommands: async () => commandListSchema.parse(await transport.request("droid.list_commands")),
          getContextBreakdown: async () => ContextBreakdownResultSchema.parse(await transport.request("droid.get_context_breakdown")),
          addUserMessage: (params, requestId) => transport.request("droid.add_user_message", { ...params, userMessageSource: "sdk" }, requestId),
          resolveQueuedUserMessage: (params) => transport.request("droid.resolve_queued_user_message", params),
          async compact(params) {
            const result = await session.compact(params);
            return { ...result, session: wrap(result.session) };
          },
          close: () => session.close(),
          connected: () => transport.isConnected,
          loadedUsage: () => transport.loadedUsage,
          onPickOptions(handler) {
            transport.pickOptions = async (params) => PickOptionsResultSchema.parse(await handler(PickOptionsRequestParamsSchema.parse(params)));
          },
          onBackgroundProcesses(listener) { transport.backgroundProcesses = listener; },
          killBackgroundProcess: async (processId) => killedSchema.parse(await transport.request("droid.kill_background_process", { processId })).killed,
          onExit(listener) {
            const child = transport.getManagedProcess()?.childProcess;
            return onDroidExit(child, listener);
          },
        });
        return wrap(session);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw error;
      }
    },
    ownedPids: () => owned,
    async fork(snapshot, cwd, title, runtimeSettings) {
      const transport = await connect(cwd, undefined, ["--settings", runtimeSettings]);
      transport.onMessage(() => {});
      transport.onError(() => {});
      try {
        await transport.request("droid.load_session", { sessionId: snapshot, autoRejectPermissionRequests: true });
        return ForkSessionResultSchema.parse(await transport.request("droid.fork_session", { title })).newSessionId;
      } finally { await transport.close(); }
    },
    async title(request) {
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = execFile(command, titleArguments(request), { cwd: request.cwd, env: withoutThread(env), timeout: titleMs, maxBuffer: 256 * 1024, signal: request.signal },
            (error, out, stderr) => {
              // Its session is removed also when it failed, if it says which it was.
              const session = titleAnswer(out ?? "").session;
              if (session) forgetSession(env.HOME, request.cwd, session);
              if (error) reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
              else resolve(out);
            });
          child.stdin?.end();
          // The bridge's own, as its sessions' processes are: never taken for a Droid run elsewhere (`openedDroids`).
          const pid = child.pid;
          if (pid) {
            owned.add(pid);
            child.once("exit", () => owned.delete(pid));
          }
        });
        const answer = titleAnswer(stdout);
        if (answer.error !== undefined) throw new Error(answer.error);
        return answer.text;
      } catch (error) {
        // One stopped (timed out, or the bridge closing) said no session: what it left is
        // removed once old enough not to be another's being made now (and at the next start).
        setTimeout(() => forgetStale(env.HOME, request.cwd, Date.now() - staleMs), staleMs + 1000).unref();
        throw error;
      } finally {
        forgetStale(env.HOME, request.cwd, Date.now() - staleMs);
      }
    },
    async models(cwd) {
      const transport = await connect(cwd);
      try {
        return await listModels({ transport });
      } finally {
        await transport.close().catch(() => undefined);
      }
    },
  };
}

/** Wait for stdout to drain, as the SDK does; an inherited open pipe gets at most two seconds. */
export function onDroidExit(child: ChildProcess | undefined, listener: (error: Error) => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    child?.off("exit", exited);
    child?.off("close", closed);
  };
  const closed = () => {
    if (done) return;
    stop();
    listener(new Error("The Droid process stopped. Send another message to resume this conversation."));
  };
  const exited = () => { timer = setTimeout(closed, 2000); timer.unref(); };
  child?.once("exit", exited);
  child?.once("close", closed);
  return stop;
}

/** How long a thread's name may take to come. */
const titleMs = 60_000;
/** A naming session file this old is no other's being made now. */
export const staleMs = titleMs * 5;

/**
 * What the one-shot Droid that names a thread starts with: Droid's read-only exec, its
 * answer as JSON, on the model at its lowest effort, with one tool that reaches nothing
 * (TodoWrite: Droid takes no empty list), the title instructions after Droid's own.
 */
export function titleArguments(request: TitleRequest): string[] {
  return [
    "exec", "--output-format", "json", "--model", request.model,
    ...(request.effort ? ["--reasoning-effort", request.effort] : []),
    "--only-tools", "TodoWrite", "--append-system-prompt", request.instructions,
    "--cwd", request.cwd, "--", request.prompt,
  ];
}

/** The answer in `droid exec --output-format json`'s one line, the session it made, or why there is none. */
export function titleAnswer(stdout: string): { text: string; session?: string; error?: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    return { text: "", error: "Droid gave no answer it could read." };
  }
  const session = typeof parsed.session_id === "string" && /^[0-9a-f-]{8,64}$/i.test(parsed.session_id) ? parsed.session_id : undefined;
  const text = typeof parsed.result === "string" ? parsed.result : "";
  if (parsed.is_error === true || parsed.subtype !== "success") return { text, session, error: text || "Droid could not answer." };
  return { text, session };
}

/** The environment without the variables that say which thread a command runs in: it speaks for none. */
function withoutThread(env: Record<string, string>): Record<string, string> {
  const clean = { ...env };
  delete clean.PORTALS_THREAD;
  delete clean.CODEX_THREAD_ID;
  delete clean.CURSOR_CONVERSATION_ID;
  return clean;
}

/**
 * The one-shot's session files are removed: Droid keeps every exec's conversation under
 * ~/.factory/sessions/<its folder, slashes as dashes>, and a name's is no conversation of
 * the user's. Only the files of that session, in the bridge's own folder's place.
 */
export function forgetSession(home: string | undefined, cwd: string, session: string): void {
  if (!home) return;
  const folder = join(home, ".factory", "sessions", cwd.replaceAll("/", "-"));
  for (const suffix of [".jsonl", ".settings.json", ".settings.json.bak"]) {
    try { rmSync(join(folder, `${session}${suffix}`), { force: true }); } catch { /* Left for Droid: nothing depends on it. */ }
  }
  // The folder too, once nothing else is in it (another name being made keeps it).
  try { rmdirSync(folder); } catch { /* Not empty, or gone. */ }
}

/**
 * The sessions in the names folder's place last written before `before`: left by a
 * one-shot stopped before it said its session. Only a session whose own record says it
 * was started in the names folder: Droid's folder name (slashes as dashes) is not one
 * path's alone (`/a/state/droid/names` and `/a/state-droid-names` share it), so a project
 * whose path meets the names folder's there keeps its conversations. A session's files
 * without that record (no .jsonl) are left, as is a folder that is a link.
 */
export function forgetStale(home: string | undefined, cwd: string, before: number): void {
  if (!home) return;
  const folder = join(home, ".factory", "sessions", cwd.replaceAll("/", "-"));
  let names: string[];
  try {
    if (!lstatSync(folder).isDirectory()) return;
    names = readdirSync(folder);
  } catch { return; }
  for (const name of names) {
    const session = /^([0-9a-f-]{8,64})\.jsonl$/i.exec(name)?.[1];
    if (!session || !startedIn(join(folder, name), cwd)) continue;
    for (const suffix of [".jsonl", ".settings.json", ".settings.json.bak"]) {
      try {
        const path = join(folder, `${session}${suffix}`);
        const stat = lstatSync(path);
        if (stat.isFile() && stat.mtimeMs < before) rmSync(path, { force: true });
      } catch { /* Gone meanwhile, or never there. */ }
    }
  }
  try { rmdirSync(folder); } catch { /* Not empty, or gone. */ }
}

/** Whether the Droid session file at `path` (a plain file) begins with its `session_start` record in `cwd`. */
function startedIn(path: string, cwd: string): boolean {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return false;
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const record = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0]) as Record<string, unknown>;
    if (record.type !== "session_start" || typeof record.cwd !== "string") return false;
    if (record.cwd === cwd) return true;
    try { return realpathSync(record.cwd) === realpathSync(cwd); } catch { return false; }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
