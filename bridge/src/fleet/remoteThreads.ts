import { z } from "zod";
import { counters, type FleetRejection } from "../counters.ts";
import { HungUp, type CallRequest } from "../gateway/call.ts";
import { ErrorCode, RpcError } from "../gateway/errors.ts";
import { log } from "../log.ts";
import type { FleetDelta, ThreadSummary } from "./fleet.ts";
import { LinkTimeout, type Link, type Links, type NetLink } from "./links.ts";
import { fleetOrder, mergeFleetOrder } from "./order.ts";
import { fleetBytes, fleetCacheBytes, fleetIdleMs, fleetPageBytes, fleetRowLimit, type FleetPage } from "./pages.ts";

const state = z.enum(["idle", "working", "blocked", "error"]);
const kind = z.enum(["permission", "question"]);
const thread = z.object({
  id: z.string(), agent: z.string(), agent_name: z.string(), folder: z.string(), state,
  updated: z.number(), title: z.string().optional(), kind: kind.optional(), read_only: z.literal(true).optional(), ongoing: z.literal(true).optional(),
});
const delta = z.object({
  epoch: z.string().min(1),
  list: z.object({ id: z.string().min(1), revision: z.number().int().nonnegative().safe() }),
  threads: z.array(thread), positions: z.array(z.number().int().nonnegative().safe()).optional(), removed: z.array(z.string()),
  active: z.array(z.object({ id: z.string(), state, kind: kind.optional() })),
  order: z.object({ count: z.number().int().nonnegative().safe(), digest: z.string() }),
  full: z.literal(true).optional(),
});
const page = delta.omit({ active: true }).extend({
  positions: z.array(z.number().int().nonnegative().safe()),
  snapshot: z.string().min(1), offset: z.number().int().nonnegative().safe(),
  next: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe(),
});
type Cursor = { epoch: string; list: string; since: number };
interface Verified {
  rows: Map<string, ThreadSummary>;
  cursor: Cursor;
}
interface Snapshot {
  rows: Map<string, ThreadSummary>;
  cursor?: Cursor;
  legacyUntil: number;
  checkedAt: number;
  paging: boolean;
  needsPages: boolean;
  phase?: FleetPage;
  touchedAt: number;
  verified?: Verified;
  replacing: boolean;
  discard?: (keepPaging?: boolean) => void;
  progress?: () => void;
}
interface Cached extends Snapshot {
  link: Link | NetLink;
  sequence: number;
  committed: number;
  generation: number;
  /** Each in-flight paging/safety call, and whether it is replacing a verified list. */
  controllers: Map<AbortController, boolean>;
  background?: Promise<void>;
  expiry?: ReturnType<typeof setTimeout>;
}

const fullMs = 120_000;
const refreshMs = 8000;

/** One unfiltered copy per linked Mac, with full safety replacements built privately. */
export class RemoteThreads {
  private readonly links: Links;
  private readonly cached = new Map<string, Cached>();

  constructor(links: Links) {
    this.links = links;
  }

  retain(links: (Link | NetLink)[]): void {
    const names = new Set(links.map((link) => link.name));
    for (const [name, entry] of this.cached) {
      if (!names.has(name)) {
        this.discard(entry);
        this.cached.delete(name);
      }
    }
  }

  async list(link: Link | NetLink): Promise<ThreadSummary[]> {
    let entry = this.cached.get(link.name);
    if (!entry || entry.link !== link) {
      if (entry) this.discard(entry);
      entry = {
        link, rows: new Map(), legacyUntil: 0, checkedAt: Date.now(), sequence: 0, committed: 0,
        paging: false, needsPages: false, touchedAt: Date.now(), replacing: false, generation: 0, controllers: new Map(),
      };
      this.cached.set(link.name, entry);
    }
    const resting = entry.paging ? this.links.listingBackoff(link.name) : undefined;
    if (resting) {
      if (!entry.background) {
        const known = entry;
        if (counters.on) counters.fleetPaging("background");
        const background = this.exchange(known, false).then(() => undefined, () => undefined);
        known.background = background;
        void background.then(() => { if (known.background === background) known.background = undefined; });
      }
      if (entry.replacing && entry.verified) return this.listed(entry.verified.rows);
      throw resting;
    }
    return this.exchange(entry, true);
  }

  private async exchange(known: Cached, glance: boolean): Promise<ThreadSummary[]> {
    const name = known.link.name;
    const replacing = known.replacing || (known.verified !== undefined && Date.now() - known.checkedAt >= fullMs);
    const controller = known.paging || replacing ? new AbortController() : undefined;
    if (controller) known.controllers.set(controller, replacing);
    let generation = known.generation;
    const verified = known.verified;
    const valid = () => this.cached.get(name) === known && generation === known.generation
      && (!replacing || known.verified === verified);
    const sequence = ++known.sequence;
    // Maps are replaced, never mutated: an overlapping request keeps its own base.
    const snapshot: Snapshot = {
      rows: known.rows, cursor: known.cursor, legacyUntil: known.legacyUntil, checkedAt: known.checkedAt,
      paging: known.paging, needsPages: known.needsPages, phase: known.phase, touchedAt: known.touchedAt,
      verified: known.verified, replacing,
      discard: (keepPaging) => {
        if (valid()) {
          this.discard(known, controller, keepPaging, replacing);
          generation = known.generation;
        }
      },
      progress: () => { if (valid()) { known.touchedAt = Date.now(); this.expire(known, fleetIdleMs); } },
    };
    let succeeded = false;
    try {
      const rows = await this.refresh(name, snapshot, glance, controller?.signal, valid);
      succeeded = true;
      snapshot.verified = snapshot.cursor ? { rows: snapshot.rows, cursor: snapshot.cursor } : undefined;
      snapshot.replacing = false;
      return rows;
    } catch (error) {
      // A failed replacement says nothing new about the last complete, sealed list.
      // Link removal/replacement still invalidates this exchange and its fallback.
      if (snapshot.replacing && this.cached.get(name) === known && known.verified) return this.listed(known.verified.rows);
      throw error;
    } finally {
      if (controller) known.controllers.delete(controller);
      if (valid() && sequence >= known.committed && (succeeded || known.verified === snapshot.verified)) {
        const { discard: _discard, progress: _progress, ...saved } = snapshot;
        Object.assign(known, saved);
        known.committed = sequence;
        if (succeeded) {
          clearTimeout(known.expiry);
          known.expiry = undefined;
          // A complete result supersedes other private replacements. Abort their calls
          // too, so a late timeout cannot put this newly verified link into backoff.
          for (const [pending, replacing] of known.controllers) if (replacing) pending.abort(new HungUp(1006));
        } else if (!known.expiry) this.expire(known, known.paging ? Math.max(1, known.touchedAt + fleetIdleMs - Date.now()) : fleetIdleMs);
      }
    }
  }

  close(): void {
    for (const entry of this.cached.values()) this.discard(entry);
    this.cached.clear();
  }

  private async refresh(name: string, entry: Snapshot, glance: boolean, signal: AbortSignal | undefined, valid: () => boolean): Promise<ThreadSummary[]> {
    const paging = entry.paging;
    const legacy = entry.legacyUntil > Date.now();
    let cursor = !paging && Date.now() - entry.checkedAt >= fullMs ? undefined : entry.cursor;
    let supported = false;
    const request = paging && entry.needsPages ? this.pageRequest(entry)
      : { method: legacy ? "threads.list" : "threads.delta", params: legacy ? { local: true } : cursor ?? {} };
    try {
      return await this.links.call(name, request.method, request.params, refreshMs, {
        glance, signal,
        ...(!legacy ? { fallback: { feature: paging ? "fleet_pages" : "fleet_delta_positions", method: "threads.list", params: { local: true } } } : {}),
        ready: (features) => {
          supported = features.includes("fleet_pages") && features.includes("fleet_delta_positions");
          if (paging && !supported) {
            entry.rows = new Map(); entry.cursor = undefined; entry.phase = undefined;
            entry.paging = false; entry.needsPages = false;
            entry.discard?.();
          }
        },
        receive: (answer, method) => {
          if ((paging || entry.replacing) && !valid()) throw new HungUp(1006);
          if (method === "threads.list") return { result: this.acceptFull(entry, answer) };
          if (method === "threads.page") {
            if (!supported) return this.reject(entry, "page");
            if (answer && typeof answer === "object" && "reset" in answer && answer.reset === true) {
              entry.rows = new Map(); entry.cursor = undefined; entry.phase = undefined;
              entry.discard?.(true);
              entry.needsPages = true;
              if (counters.on) counters.fleetPaging("resets");
            } else this.acceptPage(entry, answer);
            if (entry.needsPages) return { call: this.pageRequest(entry) };
            cursor = entry.cursor;
            if (counters.on) counters.fleetPaging("seals");
            return { call: { method: "threads.delta", params: cursor ?? {} } };
          }
          const result = this.acceptDelta(entry, answer, cursor);
          if (entry.paging && counters.on) counters.fleetPaging("completed");
          entry.paging = false; entry.needsPages = false; entry.phase = undefined;
          return { result };
        },
      }) as ThreadSummary[];
    } catch (error) {
      if (error instanceof LinkTimeout && supported && !legacy && (!cursor || paging)) {
        if (!paging) {
          entry.rows = new Map(); entry.cursor = undefined; entry.phase = undefined;
          entry.paging = true; entry.touchedAt = Date.now();
          if (counters.on) counters.fleetPaging("started");
        }
        entry.needsPages = true;
      }
      throw error;
    }
  }

  private acceptDelta(entry: Snapshot, answer: unknown, cursor: Cursor | undefined): ThreadSummary[] {
    const parsed = delta.safeParse(answer);
    if (!parsed.success) return this.reject(entry, "schema");
    const given = parsed.data;
    const rows = this.merge(entry, given, cursor);
    const active = new Map(given.active.map((row) => [row.id, row]));
    if (active.size !== given.active.length || given.active.some((row) => !rows.has(row.id))) return this.reject(entry, "schema");
    const visible = new Map([...rows].map(([id, row]): [string, ThreadSummary] => {
      const live = active.get(row.id);
      // Match summary()'s field order too, not only its values.
      return [id, {
        id: row.id, agent: row.agent, agent_name: row.agent_name, folder: row.folder,
        state: live?.state ?? "idle", ...(live?.kind ? { kind: live.kind } : {}),
        updated: row.updated, ...(row.title ? { title: row.title } : {}), ...(row.read_only ? { read_only: true } : {}), ...(row.ongoing ? { ongoing: true } : {}),
      }];
    }));
    this.remember(entry, visible, { epoch: given.epoch, list: given.list.id, since: given.list.revision });
    if (given.full) entry.checkedAt = Date.now();
    return this.listed(visible);
  }

  private listed(rows: Map<string, ThreadSummary>): ThreadSummary[] {
    return [...rows.values()].sort((a, b) => b.updated - a.updated);
  }

  private reject(entry: Snapshot, reason: FleetRejection): never {
    entry.rows = new Map();
    entry.cursor = undefined;
    entry.paging = false; entry.needsPages = false; entry.phase = undefined;
    entry.discard?.();
    if (counters.on) counters.fleetRejected(reason);
    log.warn("Discarded an invalid linked-Mac list.", { reason });
    throw new HungUp(1006);
  }

  private acceptFull(entry: Snapshot, answer: unknown): ThreadSummary[] {
    const rows = (answer as { threads: ThreadSummary[] }).threads;
    // A sorted full result cannot be the next registry-order base. Do not retain
    // an unused map, especially for an older peer which always returns full.
    entry.rows = new Map();
    entry.cursor = undefined;
    entry.paging = false; entry.needsPages = false; entry.phase = undefined;
    entry.checkedAt = Date.now();
    return rows;
  }

  private remember(entry: Snapshot, rows: Map<string, ThreadSummary>, cursor: Cursor): void {
    if (rows === entry.rows) { entry.cursor = cursor; return; }
    if (rows.size > fleetRowLimit || fleetBytes(rows.values(), [], [cursor.epoch, cursor.list]) > fleetCacheBytes) {
      entry.rows = new Map();
      entry.cursor = undefined;
      entry.legacyUntil = Date.now() + 30_000;
      return;
    }
    entry.rows = rows;
    entry.cursor = cursor;
  }

  private merge(entry: Snapshot, given: FleetDelta, cursor: Cursor | undefined): Map<string, ThreadSummary> {
    if (!given.full && (!cursor || given.epoch !== cursor.epoch || given.list.id !== cursor.list || given.list.revision < cursor.since)) return this.reject(entry, "schema");
    const rows = mergeFleetOrder(entry.rows, given);
    if (!rows) return this.reject(entry, "position");
    if (fleetOrder([...rows.keys()]).digest !== given.order.digest) return this.reject(entry, "digest");
    return rows;
  }

  private pageRequest(entry: Snapshot): CallRequest {
    return { method: "threads.page", params: entry.phase ? { snapshot: entry.phase.snapshot, offset: entry.phase.next } : entry.cursor ?? {} };
  }

  private acceptPage(entry: Snapshot, answer: unknown): void {
    const parsed = page.safeParse(answer);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(answer)) > fleetPageBytes) return this.reject(entry, "page");
    const given = parsed.data, previous = entry.phase;
    if (given.offset !== (previous?.next ?? 0) || given.next !== given.offset + given.threads.length + given.removed.length
      || given.next > given.total || (given.next === given.offset && given.next < given.total)
      || given.positions.length !== given.threads.length) return this.reject(entry, "page");
    if (previous && (given.snapshot !== previous.snapshot || given.epoch !== previous.epoch || given.list.id !== previous.list.id
      || given.list.revision !== previous.list.revision || given.order.count !== previous.order.count
      || given.order.digest !== previous.order.digest || given.full !== previous.full || given.total !== previous.total)) return this.reject(entry, "page");
    if (!given.full && (!entry.cursor || given.epoch !== entry.cursor.epoch || given.list.id !== entry.cursor.list || given.list.revision < entry.cursor.since)) return this.reject(entry, "page");
    const phase: FleetPage = {
      ...given, offset: 0, threads: [...(previous?.threads ?? []), ...given.threads],
      positions: [...(previous?.positions ?? []), ...given.positions], removed: [...(previous?.removed ?? []), ...given.removed],
    };
    const ids = new Set(phase.threads.map((row) => row.id)), removed = new Set(phase.removed);
    if (ids.size !== phase.threads.length || removed.size !== phase.removed.length || phase.removed.some((id) => ids.has(id))
      || new Set(phase.positions).size !== phase.positions.length || phase.positions.some((position) => position >= phase.order.count)) return this.reject(entry, "page");
    if (!previous && given.full) {
      if (entry.rows.size || entry.cursor) entry.discard?.(true);
      entry.rows = new Map(); entry.cursor = undefined;
    }
    const verified = entry.replacing && entry.verified?.rows !== entry.rows ? entry.verified : undefined;
    const bytes = fleetBytes(entry.rows.values(), [], entry.cursor ? [entry.cursor.epoch, entry.cursor.list] : [])
      + (verified ? fleetBytes(verified.rows.values(), [], [verified.cursor.epoch, verified.cursor.list]) : 0)
      + fleetBytes(phase.threads, phase.removed, [phase.epoch, phase.list.id, phase.snapshot, phase.order.digest]);
    if (entry.rows.size + (verified?.rows.size ?? 0) + phase.threads.length + phase.removed.length > fleetRowLimit || bytes > fleetCacheBytes) return this.reject(entry, "page");
    entry.phase = phase;
    entry.touchedAt = Date.now();
    entry.progress?.();
    if (counters.on) { counters.fleetPaging("pages"); counters.fleetPaging("rows", given.threads.length); }
    if (given.next === given.total) {
      const rows = this.merge(entry, { ...phase, active: [] }, entry.cursor);
      this.remember(entry, rows, { epoch: phase.epoch, list: phase.list.id, since: phase.list.revision });
      if (phase.full) entry.checkedAt = Date.now();
      entry.phase = undefined;
      entry.needsPages = false;
    }
  }

  private expire(known: Cached, ms: number): void {
    clearTimeout(known.expiry);
    known.expiry = setTimeout(() => {
      if (known.paging && counters.on) counters.fleetPaging("expired");
      // Idle private progress expires without erasing the verified list it replaces.
      this.discard(known, undefined, false, known.replacing);
    }, ms).unref();
  }

  private discard(known: Cached, except?: AbortController, keepPaging = false, keepVerified = false): void {
    known.generation++;
    known.rows = new Map(); known.cursor = undefined; known.phase = undefined;
    known.paging = keepPaging; known.needsPages = keepPaging;
    if (!keepVerified) known.verified = undefined;
    known.replacing = keepVerified && known.verified !== undefined;
    if (!keepPaging) { clearTimeout(known.expiry); known.expiry = undefined; }
    const error = new RpcError(ErrorCode.internal, `Could not reach ${known.link.name}: it hung up before answering.`);
    for (const controller of known.controllers.keys()) if (controller !== except) controller.abort(error);
  }
}
