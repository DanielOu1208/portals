import { randomBytes } from "node:crypto";
import type { FleetDelta, ThreadSummary } from "./fleet.ts";

export const fleetPageBytes = 32 * 1024;
export const fleetCacheBytes = 16 * 1024 * 1024;
export const fleetRowLimit = 20_000;
export const fleetIdleMs = 60_000;
export type FleetCursor = { epoch: string; list: string; since: number };
export interface FleetPage extends Omit<FleetDelta, "active"> {
  positions: number[];
  snapshot: string;
  offset: number;
  next: number;
  total: number;
}
export type FleetPageReply = FleetPage | { reset: true } | { unavailable: true };
export interface FleetPageParams {
  snapshot?: string;
  offset?: number;
  epoch?: string;
  list?: string;
  since?: number;
}
interface Frozen {
  key: string;
  data: Omit<FleetPage, "offset" | "next">;
  bytes: number;
  weights: number[];
  expiry?: ReturnType<typeof setTimeout>;
}

/** Conservative retained objects/map slots plus UTF-16 strings, not an RSS estimate. */
export function fleetBytes(rows: Iterable<ThreadSummary>, removed: Iterable<string> = [], metadata: Iterable<string> = []): number {
  let bytes = 512;
  for (const row of rows) bytes += 512 + 2 * (row.id.length + row.agent.length + row.agent_name.length + row.folder.length + (row.title?.length ?? 0));
  for (const id of removed) bytes += 128 + 2 * id.length;
  for (const value of metadata) bytes += 2 * value.length;
  return bytes;
}

/** One lazily populated, globally bounded snapshot store for every requesting Mac. */
export class FleetPages {
  private readonly current: () => Pick<FleetDelta, "epoch" | "list">;
  private readonly capture: (cursor?: FleetCursor) => FleetDelta;
  private readonly snapshots = new Map<string, Frozen>();
  private bytes = 0;

  constructor(current: () => Pick<FleetDelta, "epoch" | "list">, capture: (cursor?: FleetCursor) => FleetDelta) {
    this.current = current;
    this.capture = capture;
  }

  page(params: FleetPageParams): FleetPageReply {
    const now = this.current();
    for (const [token, old] of this.snapshots) {
      if (old.data.epoch !== now.epoch || old.data.list.id !== now.list.id) this.drop(token);
    }
    const offset = params.offset ?? 0;
    let frozen = params.snapshot ? this.snapshots.get(params.snapshot) : undefined;
    if (params.snapshot && !frozen) return { reset: true };
    if (!Number.isSafeInteger(offset) || offset < 0 || (!params.snapshot && offset !== 0) || (frozen && offset > frozen.data.total)) {
      if (params.snapshot) this.drop(params.snapshot);
      return { reset: true };
    }
    if (!frozen) {
      const cursor = params.epoch === now.epoch && params.list === now.list.id && params.since !== undefined
        && Number.isSafeInteger(params.since) && params.since >= 0 && params.since <= now.list.revision
        ? { epoch: now.epoch, list: now.list.id, since: params.since } : undefined;
      const key = JSON.stringify([now.epoch, now.list.id, now.list.revision, cursor]);
      frozen = [...this.snapshots.values()].find((old) => old.key === key);
      if (!frozen) {
        const given = this.capture(cursor);
        const snapshot = randomBytes(16).toString("hex");
        const bytes = fleetBytes(given.threads, given.removed, [key, given.epoch, given.list.id, given.order.digest, snapshot]);
        if (bytes > fleetCacheBytes || given.threads.length + given.removed.length > fleetRowLimit) return { unavailable: true };
        while (this.snapshots.size >= 4 || this.bytes + bytes > fleetCacheBytes) this.drop(this.snapshots.keys().next().value!);
        const threads = given.threads.map((row) => Object.freeze({ ...row }));
        const positions = given.positions ? [...given.positions] : threads.map((_, index) => index);
        const removed = [...given.removed];
        frozen = {
          key, bytes,
          data: {
            epoch: given.epoch, list: Object.freeze({ ...given.list }), threads, positions, removed, order: Object.freeze({ ...given.order }),
            ...(given.full ? { full: true } : {}),
            snapshot, total: threads.length + removed.length,
          },
          weights: [
            ...threads.map((row, index) => Buffer.byteLength(JSON.stringify(row)) + String(positions[index]).length + 2),
            ...removed.map((id) => Buffer.byteLength(JSON.stringify(id)) + 1),
          ],
        };
        this.bytes += bytes;
        this.snapshots.set(frozen.data.snapshot, frozen);
      }
    }
    const { data } = frozen;
    let next = offset;
    let bytes = Buffer.byteLength(JSON.stringify({ ...data, threads: [], positions: [], removed: [], offset, next: data.total }));
    while (next < data.total && bytes + frozen.weights[next] <= fleetPageBytes) bytes += frozen.weights[next++];
    if (bytes > fleetPageBytes || (next === offset && next < data.total)) {
      this.drop(data.snapshot);
      return { unavailable: true };
    }
    this.touch(frozen);
    return {
      ...data, offset, next,
      threads: data.threads.slice(offset, Math.min(next, data.threads.length)),
      positions: data.positions.slice(offset, Math.min(next, data.threads.length)),
      removed: data.removed.slice(Math.max(0, offset - data.threads.length), Math.max(0, next - data.threads.length)),
    };
  }

  close(): void {
    for (const token of this.snapshots.keys()) this.drop(token);
  }

  private touch(frozen: Frozen): void {
    const token = frozen.data.snapshot;
    clearTimeout(frozen.expiry);
    frozen.expiry = setTimeout(() => this.drop(token), fleetIdleMs).unref();
    this.snapshots.delete(token);
    this.snapshots.set(token, frozen);
  }

  private drop(token: string): void {
    const frozen = this.snapshots.get(token);
    if (!frozen) return;
    clearTimeout(frozen.expiry);
    this.bytes -= frozen.bytes;
    this.snapshots.delete(token);
  }
}
