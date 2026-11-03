import { createHash } from "node:crypto";
import type { FleetDelta, ThreadSummary } from "./fleet.ts";

/** Registry insertion order is the tie-breaker of the fleet's stable updated-time sort. */
export function fleetOrder(ids: string[]): { count: number; digest: string } {
  return { count: ids.length, digest: createHash("sha256").update(JSON.stringify(ids)).digest("hex") };
}

/** Only changed rows can move; unchanged rows retain their relative registry order. */
export function mergeFleetOrder(previous: Map<string, ThreadSummary>, given: FleetDelta): Map<string, ThreadSummary> | undefined {
  if (!given.full && !given.positions) return;
  if (given.positions && given.positions.length !== given.threads.length) return;
  if (!given.full && given.threads.length === 0 && given.removed.length === 0) return given.order.count === previous.size ? previous : undefined;
  const changed = new Set(given.threads.map((row) => row.id));
  const removed = new Set(given.removed);
  if (changed.size !== given.threads.length) return;
  const kept = given.full ? [] : [...previous.values()].filter((row) => !changed.has(row.id) && !removed.has(row.id));
  if (given.order.count !== kept.length + changed.size) return;
  const placed = new Array<ThreadSummary>(given.order.count);
  for (const [index, row] of given.threads.entries()) {
    const position = given.positions ? given.positions[index] : index;
    if (!Number.isSafeInteger(position) || position < 0 || position >= given.order.count || placed[position] || removed.has(row.id)) return;
    placed[position] = row;
  }
  const rows = new Map<string, ThreadSummary>();
  let unchanged = 0;
  for (let index = 0; index < given.order.count; index++) {
    const row = placed[index] ?? kept[unchanged++];
    rows.set(row.id, row);
  }
  return rows;
}
