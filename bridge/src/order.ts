import { randomBytes } from "node:crypto";
import { readJSON, writeJSON } from "./store/jsonFile.ts";

// The order the user gave the bridge's agents and folders in the sidebar, the same on
// every device (feature sidebar_order), in `state/order.json`. Two lists: the agents by
// profile name, and the folders by their real path. The bridge keeps them and arranges
// nothing itself: `profiles.list` and `folders.list` answer as before, and the app puts
// the rows in this order.
//
// A list holds what the user arranged, as the device that arranged it last saw it. An
// agent or a folder that is not on it was not placed: the app says where such a one
// goes (a new agent after the others, a new folder before them). An empty list is no
// order at all, which is how the sidebar was before: the agents as the bridge lists
// them, the folders by when each was last worked in. A name stays on its list when the
// bridge no longer runs the agent or offers the folder: it has its place again when it
// is back.
//
// A third list is not about this bridge alone: the order of the user's Macs (feature
// machine_order), each named by the id its bridge gave itself (`machineID`). No one
// bridge owns it, so every bridge keeps a copy, with the moment the user arranged the
// Macs on some device (`machinesAt`, milliseconds since 1970 by that device's clock). A
// copy is replaced only by one arranged later, so whichever device tells a bridge last,
// the order arranged last is the one every bridge ends up with: a device that finds two
// of its bridges apart gives the newer order to the one behind. Two orders of the same
// moment are told apart by their ids (`isLaterMachineOrder`), the same on every bridge
// and app, so they too end the same everywhere.
//
// The file keeps an id and a revision, a whole number that goes up by one with every
// change, which `sessions.activity` carries: a device that holds another id or revision
// asks for the order again. The lists are short, so they are always given whole.

/** How many names a list may hold, and how long one may be: far above any sidebar. */
export const longestOrder = 500;
export const longestOrderName = 4096;

export interface Order {
  agents: string[];
  folders: string[];
  /** The user's Macs by their bridges' ids, first to last; empty when they were never arranged. */
  machines: string[];
  /** When the Macs were arranged, in milliseconds since 1970 by the clock of the device they were arranged on; 0 for never. */
  machinesAt: number;
}

/** What `set` takes: any of the lists, the Macs' with the moment they were arranged. */
export interface OrderChange {
  agents?: string[];
  folders?: string[];
  machines?: { ids: string[]; at: number };
}

export class SidebarOrder {
  private readonly path: string | undefined;
  private agents: string[] = [];
  private folders: string[] = [];
  private machines: string[] = [];
  private machinesAt = 0;
  /** The order's id. A device that holds another one's revision asks for this one. */
  readonly list: string;
  private current: number;
  /** Told after each change, once the file has it: a device that asked is told to poll (feature poll_now). */
  moved: () => void = () => {};

  /** `path`: `state/order.json`. Without it the order lasts until the bridge stops. */
  constructor(path?: string) {
    this.path = path;
    const stored = storedObject(path);
    this.agents = orderNames(stored.agents) ?? [];
    this.folders = orderNames(stored.folders) ?? [];
    const machines = orderNames(stored.machines);
    if (machines && isOrderMoment(stored.machinesAt)) {
      this.machines = machines;
      this.machinesAt = stored.machinesAt;
    }
    if (typeof stored.list === "string" && stored.list !== "" && Number.isSafeInteger(stored.revision) && (stored.revision as number) >= 0) {
      this.list = stored.list;
      this.current = stored.revision as number;
    } else {
      // A new order. Nothing is written until something is arranged.
      this.list = randomBytes(8).toString("hex");
      this.current = 0;
    }
  }

  /** The order's id and its revision now. */
  revision(): { id: string; revision: number } {
    return { id: this.list, revision: this.current };
  }

  /** The lists as they are now. */
  get(): Order {
    return { agents: [...this.agents], folders: [...this.folders], machines: [...this.machines], machinesAt: this.machinesAt };
  }

  /**
   * Replaces the lists given, each whole; one left out stays as it is. The Macs' order is
   * replaced only by one arranged later than the one kept. The revision goes up when
   * something changed, and only then.
   */
  set(change: OrderChange): Order {
    const agents = change.agents ?? this.agents;
    const folders = change.folders ?? this.folders;
    const newer = change.machines !== undefined && isLaterMachineOrder(change.machines, { ids: this.machines, at: this.machinesAt });
    if (!same(agents, this.agents) || !same(folders, this.folders) || newer) {
      const next = {
        agents: [...agents],
        folders: [...folders],
        machines: newer ? [...change.machines!.ids] : this.machines,
        machinesAt: newer ? change.machines!.at : this.machinesAt,
      };
      const revision = this.current + 1;
      // Publish only after the file was replaced. A failed write must leave the same
      // change worth retrying, rather than acknowledge a copy kept only in memory.
      if (this.path) writeJSON(this.path, { list: this.list, revision, ...next });
      this.agents = next.agents;
      this.folders = next.folders;
      this.machines = next.machines;
      this.machinesAt = next.machinesAt;
      this.current = revision;
      this.moved();
    }
    return this.get();
  }
}

/**
 * Whether the Macs' order `one` replaces `other`: arranged later, or, arranged at the
 * same moment on two devices, the one whose ids come later when joined. Every bridge
 * and every app decide the same way (the app's `MachineOrder.isLater`), so two such
 * orders end the same everywhere instead of each bridge keeping the one it got first.
 */
export function isLaterMachineOrder(one: { ids: string[]; at: number }, other: { ids: string[]; at: number }): boolean {
  if (one.at !== other.at) return one.at > other.at;
  const key = one.ids.join("\n");
  const otherKey = other.ids.join("\n");
  return key !== otherKey && key > otherKey;
}

/** Whether `value` is a moment an order can have been arranged at: a whole number of milliseconds above zero. */
export function isOrderMoment(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * The id this bridge gave itself, by which the order of the user's Macs names it
 * (`gateway.ready`'s `bridge.machine.id`): made once, kept in `state/machine.json`, and
 * the same from then on, whatever the Mac is called on the network it is on. Without a
 * path it lasts until the bridge stops.
 */
export function machineID(path?: string): string {
  const stored = storedObject(path);
  if (typeof stored.id === "string" && /^[0-9a-f]{16}$/.test(stored.id)) return stored.id;
  const id = randomBytes(8).toString("hex");
  if (path) writeJSON(path, { id });
  return id;
}

/** An order or machine file must hold an object; valid JSON such as null holds neither. */
function storedObject(path?: string): Record<string, unknown> {
  const value = path ? readJSON<unknown>(path, {}) : {};
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A list of names as the order keeps it: each once, the first time it is named.
 * Undefined for what is no list of names, or one too long to be a sidebar's.
 */
export function orderNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > longestOrder) return undefined;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string" || name === "" || name.length > longestOrderName) return undefined;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function same(one: string[], other: string[]): boolean {
  return one.length === other.length && one.every((name, index) => name === other[index]);
}
