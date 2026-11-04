import { CodexError } from "./client.ts";
import { reviewOwnStillOlder } from "./history.ts";
import type { CodexCalls } from "./session.ts";
import type { Thread, Turn } from "./types/index.ts";

interface TurnsPage {
  data: Turn[];
  nextCursor: string | null;
}

export interface ReadOptions {
  /** Read back through these turns, including any older background commands still running. */
  through?: readonly string[];
  /** Only the newest turn's state, for checking whether a plan was overtaken. */
  latest?: boolean;
}

/**
 * Codex refused to list a thread's turns as it has none yet, while it has the thread
 * loaded (0.166): `thread/turns/list` says the thread is not materialized; `thread/read`
 * with its turns and `thread/resume` say `list_turns` is not supported, and once that has
 * been asked `thread/turns/list` says so too.
 */
export function noTurnsYet(error: unknown): boolean {
  if (!(error instanceof CodexError)) return false;
  return (error.code === -32601 && /^list_turns is not supported( yet)?$/.test(error.message))
    || (error.code === -32600 && /^thread \S+ is not materialized yet; thread\/turns\/list is unavailable before first user message$/.test(error.message));
}

/**
 * Persisted turns, oldest first, without full-history hydration. Catch-up stops once
 * every turn it needs has been found, with the own turn of a review among them; opening
 * a thread still reads all of its history.
 * Older app-servers and legacy stores may not support paging.
 */
export async function readThread(client: Pick<CodexCalls, "call">, threadId: string, options: ReadOptions = {}): Promise<Thread> {
  const turns: Turn[] = [];
  const wanted = new Set(options.through);
  const cursors = new Set<string>();
  const pageAt = (cursor: string | null): Promise<TurnsPage> => client.call("thread/turns/list", {
    threadId,
    cursor,
    limit: options.latest ? 1 : 50,
    sortDirection: "desc",
    itemsView: options.latest ? "notLoaded" : "full",
  });
  try {
    let page = await pageAt(null);
    let { thread } = await client.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: false });
    // Keep runtime state with the newest page, before reading older history. If a turn
    // ended between these calls, refresh it before idle can make it look interrupted.
    for (let attempt = 0; page.data[0]?.status === "inProgress" && thread.status?.type !== "active"; attempt += 1) {
      if (attempt === 3) throw new Error("Codex history kept changing while it was read.");
      const fresh = await pageAt(null);
      const before = page.data[0];
      const after = fresh.data[0];
      page = fresh;
      if (before?.id === after?.id && before?.status === after?.status) break;
      ({ thread } = await client.call("thread/read", { threadId, includeTurns: false }));
    }
    for (;;) {
      turns.push(...page.data);
      for (const turn of page.data) wanted.delete(turn.id);
      if (options.latest || (options.through?.length && wanted.size === 0 && !reviewOwnStillOlder(turns)) || page.nextCursor === null) break;
      if (cursors.has(page.nextCursor)) throw new Error("Codex repeated a history cursor.");
      cursors.add(page.nextCursor);
      page = await pageAt(page.nextCursor);
    }
    return { ...thread, turns: turns.reverse() };
  } catch (error) {
    // Only an unsupported call or store: connection and read failures must stay visible.
    const unsupported = error instanceof CodexError && (error.code === -32601
      || (error.code === -32600 && /unknown variant [`'"]thread\/turns\/list[`'"]/.test(error.message)));
    if (!unsupported) {
      // A thread with no turn yet that Codex still has loaded has none to list (0.166):
      // read without them, it is empty. Pages already read say otherwise.
      if (turns.length === 0 && noTurnsYet(error)) return empty(client, threadId);
      throw error;
    }
    try {
      return (await client.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: true })).thread;
    } catch (fallback) {
      if (!noTurnsYet(fallback)) throw fallback;
      return empty(client, threadId);
    }
  }
}

async function empty(client: Pick<CodexCalls, "call">, threadId: string): Promise<Thread> {
  return { ...(await client.call<{ thread: Thread }>("thread/read", { threadId, includeTurns: false })).thread, turns: [] };
}
