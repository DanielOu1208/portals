import { BadCursor, cursorKey, replacedResult, type SearchParams, type SearchResult, type ThreadHits } from "./search.ts";

// A search of this Mac's threads and those of the Macs it is linked to (`thread.search`
// with `linked`, feature thread_search), for clients that manage threads as a whole
// (docs/fleet-plan.md). The app asks each Mac it is connected to by itself instead.
//
// Each linked Mac is asked for its own threads only (no `linked`: two Macs linked to each
// other would ask each other for ever), with the time a look at another Mac is given; one
// that does not answer in time, or cannot search, is named in `machines` and left out. Its
// threads come back as the thread list names them, `machine/id` with `machine`. The
// cursor holds each Mac's own: a later page asks only the Macs that have more. A Mac that
// fails a later page keeps its cursor, for the next page to ask it again, up to
// `missesKept` times in a row: a Mac asleep for good does not keep the search going.
//
// The search holds its caller's claim (`ThreadSearch.claim`) until every Mac has answered:
// a newer search of the caller's stops all of it, and this one answers `replaced`.

/** How long a linked Mac is given to answer a page. */
export const linkedSearchMs = 8000;
/** How many pages in a row a Mac with more may fail before the search leaves it out. */
export const missesKept = 2;

export interface LinkedMacs {
  linked(): { name: string; url: string }[];
  /** Whether a look at the Mac would be turned away now, unasked, for failing a moment ago (`Links.call`'s rest). */
  resting?(name: string): boolean;
  askLinked(name: string, method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

export interface MachineAnswer {
  name: string;
  url: string;
  reachable: boolean;
  error?: string;
}

interface Cursors {
  /** This Mac's cursor; null when it has no more. */
  here: string | null;
  /** Each linked Mac's, by name; null when it has no more. A Mac not named is not asked again. */
  there: Record<string, string | null>;
  /** How many pages in a row each Mac named failed, where it has. */
  misses: Record<string, number>;
}

function encode(params: SearchParams, cursors: Cursors): string {
  return Buffer.from(JSON.stringify({ v: 2, k: cursorKey(params), h: cursors.here, m: cursors.there, f: cursors.misses })).toString("base64url");
}

/** A cursor is tied to its query and filters, as this Mac's own is: the Macs' own cursors are theirs to check, and a failed check there would read as a Mac out of reach. */
function decode(params: SearchParams, cursor: string): Cursors {
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  if (parsed?.v !== 2 || !(parsed.h === null || typeof parsed.h === "string") || !parsed.m || typeof parsed.m !== "object") {
    throw new BadCursor("The cursor is not one this bridge gave a search of its linked Macs.");
  }
  if (parsed.k !== cursorKey(params)) throw new BadCursor("The cursor belongs to another search.");
  return { here: parsed.h, there: parsed.m, misses: parsed.f && typeof parsed.f === "object" ? parsed.f : {} };
}

/** Throws `BadCursor` for a cursor that is not this search's: checked before the search takes its caller's place. */
export function checkLinkedCursor(params: SearchParams): void {
  if (params.cursor) decode(params, params.cursor);
}

export async function searchLinked(
  params: SearchParams,
  here: (params: SearchParams) => Promise<SearchResult>,
  macs: LinkedMacs,
  signal?: AbortSignal,
): Promise<SearchResult & { machines: MachineAnswer[] }> {
  const given = params.cursor ? decode(params, params.cursor) : null;
  const links = macs.linked();
  const asked = given ? links.filter((link) => typeof given.there[link.name] === "string") : links;
  const local = !given || given.here !== null ? here({ ...params, cursor: given?.here ?? undefined }) : Promise.resolve(null);
  const remote = asked.map(async (link): Promise<{ machine: MachineAnswer; result?: SearchResult; cursor?: string; rested?: true }> => {
    const cursor = given?.there[link.name] ?? undefined;
    // Resting after a failure a moment ago, the call would fail unasked: not a miss, and its place is kept.
    if (cursor && macs.resting?.(link.name)) {
      return { machine: { name: link.name, url: link.url, reachable: false, error: `${link.name} did not answer a moment ago: asked again in a while.` }, cursor, rested: true };
    }
    try {
      const answer = (await macs.askLinked(link.name, "thread.search", { query: params.query, limit: params.limit, hits: params.hits, agent: params.agent, folder: params.folder, ...(cursor ? { cursor } : {}) }, linkedSearchMs, signal)) as SearchResult;
      if (!Array.isArray(answer?.threads)) throw new Error("Its answer is not a search's.");
      return { machine: { name: link.name, url: link.url, reachable: true }, result: answer };
    } catch (error) {
      return { machine: { name: link.name, url: link.url, reachable: false, error: (error as Error).message }, ...(cursor ? { cursor } : {}) };
    }
  });
  const [mine, theirs] = await Promise.all([local, Promise.all(remote)]);
  // Replaced, or its caller went, while a Mac was still asked: none of it is answered.
  if (signal?.aborted || mine?.replaced) return { ...replacedResult(), machines: [] };
  const threads: ThreadHits[] = [...(mine?.threads ?? [])];
  const there: Record<string, string | null> = {};
  const misses: Record<string, number> = {};
  let scanned = mine?.scanned ?? 0;
  for (const { machine, result, cursor, rested } of theirs) {
    if (!result) {
      // Out of reach on a later page: asked again on the next, where it left off.
      const missed = (given?.misses[machine.name] ?? 0) + (rested ? 0 : 1);
      if (cursor && missed <= missesKept) {
        there[machine.name] = cursor;
        if (missed > 0) misses[machine.name] = missed;
      }
      continue;
    }
    for (const thread of result.threads) threads.push({ ...thread, id: `${machine.name}/${thread.id}`, machine: machine.name });
    scanned += result.scanned ?? 0;
    if (result.cursor) there[machine.name] = result.cursor;
  }
  threads.sort((a, b) => b.updated - a.updated);
  const cursors: Cursors = { here: mine?.cursor ?? null, there, misses };
  const more = cursors.here !== null || Object.keys(there).length > 0;
  const result: SearchResult & { machines: MachineAnswer[] } = { threads, cursor: more ? encode(params, cursors) : null, scanned, machines: theirs.map(({ machine }) => machine) };
  // Every reachable Mac's skipped threads count, with distinct reasons kept even for
  // the same agent because the Macs can have different settings and loaded threads.
  const unsearched: NonNullable<SearchResult["unsearched"]> = [];
  for (const answer of [mine, ...theirs.map(({ result }) => result)]) {
    for (const entry of answer?.unsearched ?? []) {
      const same = unsearched.find((each) => each.agent === entry.agent && each.reason === entry.reason);
      if (same) same.count += entry.count;
      else unsearched.push({ ...entry });
    }
  }
  if (unsearched.length > 0) result.unsearched = unsearched;
  return result;
}
