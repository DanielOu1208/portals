import { setTimeout as sleep } from "node:timers/promises";
import { clientModule } from "./client.ts";
import { majorVersion } from "./options.ts";
import type { Endpoint } from "./server.ts";

export interface OwnedStopExecution {
  sessionID: string;
  openerID?: string;
  assistantID?: string;
  terminalID?: string;
  /** The exact durable idle outcome, including completion racing with shutdown. */
  outcome?: "interrupted" | "succeeded" | "failed";
}

export interface OwnedStopResult {
  serverIdentity: string;
  /** Active sessions confirmed durably idle after interruption (or a racing completion). */
  settled: string[];
  /** Known active sessions whose durable terminal state could not be confirmed. */
  unsettled: string[];
  /** False also when the active inventory could not be read; empty arrays are not proof. */
  complete: boolean;
  /** Native message identities, not inferred from activity or timestamp proximity. */
  executions?: OwnedStopExecution[];
}

/** One deadline for ownership proof, active inventory, interrupts and durable idle reads. */
export const settleTimeoutMs = 4000;

function data<T>(value: T | { data: T }): T {
  return value && typeof value === "object" && "data" in value ? value.data : value as T;
}

/** Only called after the locator has proved the owned process's OS start identity. */
export async function settleOwned(endpoint: Endpoint, timeoutMs = settleTimeoutMs): Promise<OwnedStopResult> {
  const began = Date.now();
  const seen = new Set<string>(), settled = new Set<string>(), requested = new Set<string>();
  const executions = new Map<string, OwnedStopExecution>();
  const abort = new AbortController();
  let complete = false;
  const deadline = setTimeout(() => abort.abort(), Math.min(timeoutMs, settleTimeoutMs));
  const expired = new Promise<never>((_, reject) => {
    abort.signal.addEventListener("abort", () => reject(new Error("owned shutdown deadline")), { once: true });
  });
  const settle = async () => {
    if (!endpoint.own || !endpoint.serverIdentity || !endpoint.pid) return;
    const { OpenCode } = await clientModule();
    abort.signal.throwIfAborted();
    const native = OpenCode.make({
      baseUrl: endpoint.url, headers: endpoint.headers,
      fetch: (input, init) => fetch(input, {
        ...init, redirect: "manual",
        signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
      }),
    });
    const info = data(await native.server.info());
    if (info.pid !== endpoint.pid || majorVersion(info.version) !== 2) return;
    let quiet = 0;
    for (;;) {
      abort.signal.throwIfAborted();
      const active = new Set(Object.keys(data(await native.session.active())));
      const fresh = [...active].filter((id) => !requested.has(id));
      for (const id of active) { seen.add(id); settled.delete(id); }
      for (const id of fresh) requested.add(id);
      // The native inventory includes roots and children, not just bridge-loaded roots.
      await Promise.allSettled(fresh.map(async (sessionID) => {
        const execution: OwnedStopExecution | undefined = executions.size < 256 || executions.has(sessionID) ? { sessionID } : undefined;
        if (execution) {
          executions.set(sessionID, execution);
          const identify = async () => {
            const page = await native.message.list({ sessionID, order: "desc", limit: 200 });
            const end = page.data.findIndex((message) => message.type === "idle");
            const tail = end < 0 ? page.data : page.data.slice(0, end);
            const opener = tail.find((message) => message.type === "user" || message.type === "synthetic" || message.type === "compaction" && message.reason === "manual");
            // A truncated execution has no trustworthy opener. Identity reads
            // are best effort and may not consume the interruption deadline.
            const assistant = tail.find((message) => message.type === "assistant");
            return {
              ...(opener && (end >= 0 || !page.cursor?.next) ? { openerID: opener.id } : {}),
              ...(assistant ? { assistantID: assistant.id } : {}),
            };
          };
          try { Object.assign(execution, await Promise.race([identify(), sleep(150, undefined, { signal: abort.signal })])); }
          catch { /* Identity failure must not prevent interruption. */ }
        }
        abort.signal.throwIfAborted();
        return native.session.interrupt({ sessionID, resume: false });
      }));
      abort.signal.throwIfAborted();
      await Promise.allSettled([...seen].filter((id) => !active.has(id) && !settled.has(id)).map(async (sessionID) => {
        const page = await native.message.list({ sessionID, order: "desc", limit: 1 });
        abort.signal.throwIfAborted();
        const latest = page.data[0];
        // Both processes use this machine's clock. An idle from a previous turn
        // must not make a disappearing active entry look durably interrupted.
        if (latest?.type === "idle" && latest.time.created >= began && ["interrupted", "succeeded", "failed"].includes(latest.outcome)) {
          settled.add(sessionID);
          requested.delete(sessionID);
          const execution = executions.get(sessionID);
          if (execution) {
            execution.terminalID = latest.id;
            execution.outcome = latest.outcome;
          }
        }
      }));
      abort.signal.throwIfAborted();
      // A second inventory catches children admitted while their parent was stopped.
      quiet = active.size === 0 && [...seen].every((id) => settled.has(id)) ? quiet + 1 : 0;
      if (quiet === 2) { complete = true; return; }
      await sleep(50, undefined, { signal: abort.signal });
    }
  };
  try { await Promise.race([settle(), expired]); }
  catch { /* The locator still stops the group and reports the unconfirmed state. */ }
  finally { clearTimeout(deadline); abort.abort(); }
  return {
    serverIdentity: endpoint.serverIdentity!,
    settled: [...seen].filter((id) => settled.has(id)),
    unsettled: [...seen].filter((id) => !settled.has(id)),
    complete,
    ...(executions.size ? { executions: [...executions.values()] } : {}),
  };
}
