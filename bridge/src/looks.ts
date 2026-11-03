import { randomBytes } from "node:crypto";
import { readJSON, writeJSON } from "./store/jsonFile.ts";

// How the bridge's agents look, the same on every device (feature agent_looks), in
// `state/looks.json`. A look is three whole numbers the app reads as a body shape, a
// resting face and a colour from its own lists, and whether a coding agent shows its
// maker's logo instead: the bridge keeps them and draws nothing.
//
// A look is kept with who decided it. One the user chose by hand (`chosen`) is replaced
// only by another chosen one. One an app gave to tell agents apart (`assigned`) is what
// an agent has until somebody chooses: the first device to see a new agent gives it one,
// and every other device takes that one in place of its own.
//
// The file keeps an id and a revision, a whole number that goes up by one with every
// change, which `sessions.activity` carries: a device that holds another id or revision
// asks for the looks again. They are few and small, so they are always listed whole. A
// look stays for an agent the bridge no longer runs, which has it again when it is back.

export const lookOrigins = ["chosen", "assigned"] as const;
export type LookOrigin = (typeof lookOrigins)[number];

export function isLookOrigin(value: unknown): value is LookOrigin {
  return lookOrigins.includes(value as LookOrigin);
}

/** When `set` leaves the look the bridge has: when it has `any`, or only one that was `chosen`. */
export const lookConditions = ["any", "chosen"] as const;
export type LookCondition = (typeof lookConditions)[number];

export function isLookCondition(value: unknown): value is LookCondition {
  return lookConditions.includes(value as LookCondition);
}

/** The highest index a look may carry: far above any list an app has, and still a small number. */
export const highestLookIndex = 999;

export interface Look {
  shape: number;
  face: number;
  tint: number;
  /** Whether a coding agent shows its maker's logo in place of its avatar; absent when nobody chose, which shows it. */
  showsLogo?: boolean;
  origin: LookOrigin;
}

/** A look as the app is given it. */
export interface ListedLook {
  agent: string;
  shape: number;
  face: number;
  tint: number;
  shows_logo?: boolean;
  origin: LookOrigin;
}

export class Looks {
  private readonly path: string | undefined;
  private readonly looks = new Map<string, Look>();
  /** The list's id. A device that holds another list's revision asks for this one. */
  readonly list: string;
  private current: number;
  /** Told after each change, once the file has it: a device that asked is told to poll (feature poll_now). */
  moved: () => void = () => {};

  /** `path`: `state/looks.json`. Without it the looks last until the bridge stops. */
  constructor(path?: string) {
    this.path = path;
    const read = path ? readJSON<unknown>(path, {}) : {};
    // Valid JSON such as null holds no looks: the list starts again, as with no file.
    const stored: Record<string, unknown> = read !== null && typeof read === "object" && !Array.isArray(read) ? read as Record<string, unknown> : {};
    if (stored.looks && typeof stored.looks === "object" && !Array.isArray(stored.looks)) {
      for (const [agent, look] of Object.entries(stored.looks)) {
        if (isLook(look)) this.looks.set(agent, look);
      }
    }
    if (typeof stored.list === "string" && stored.list !== "" && Number.isSafeInteger(stored.revision) && (stored.revision as number) >= 0) {
      this.list = stored.list;
      this.current = stored.revision as number;
    } else {
      // A new list. Nothing is written until an agent is given a look.
      this.list = randomBytes(8).toString("hex");
      this.current = 0;
    }
  }

  /** The list's id and its revision now. */
  revision(): { id: string; revision: number } {
    return { id: this.list, revision: this.current };
  }

  /** Every look the bridge keeps, by agent name. */
  all(): ListedLook[] {
    return [...this.looks].map(([agent, look]) => listed(agent, look)).sort((one, other) => (one.agent < other.agent ? -1 : one.agent > other.agent ? 1 : 0));
  }

  /** An agent's look, when it has one. */
  get(agent: string): ListedLook | undefined {
    const look = this.looks.get(agent);
    return look ? listed(agent, look) : undefined;
  }

  /**
   * Gives `agent` a look, unless the bridge has one that `unless` says to leave: `any`
   * look, or one that was `chosen`. A look that was chosen is never replaced by an
   * assigned one, whatever `unless` says. Answers with the look the agent has now, and
   * whether it is the one given.
   */
  set(agent: string, look: Look, unless?: LookCondition): { look: ListedLook; taken: boolean } {
    const held = this.looks.get(agent);
    const kept = held !== undefined && (unless === "any" || (held.origin === "chosen" && (unless === "chosen" || look.origin === "assigned")));
    if (kept) return { look: listed(agent, held), taken: same(held, look) };
    if (held === undefined || !same(held, look)) {
      const next: Look = { shape: look.shape, face: look.face, tint: look.tint, origin: look.origin };
      if (look.showsLogo !== undefined) next.showsLogo = look.showsLogo;
      // Written before it is kept: a look the file did not take is not one the bridge
      // has, so the same look sent again is saved then, and not taken as kept already.
      const looks = new Map(this.looks).set(agent, next);
      this.save(looks, this.current + 1);
      this.looks.set(agent, next);
      this.current += 1;
      this.moved();
    }
    return { look: listed(agent, this.looks.get(agent)!), taken: true };
  }

  private save(looks: Map<string, Look>, revision: number): void {
    if (!this.path) return;
    writeJSON(this.path, { list: this.list, revision, looks: Object.fromEntries(looks) });
  }
}

function listed(agent: string, look: Look): ListedLook {
  const row: ListedLook = { agent, shape: look.shape, face: look.face, tint: look.tint, origin: look.origin };
  if (look.showsLogo !== undefined) row.shows_logo = look.showsLogo;
  return row;
}

function same(one: Look, other: Look): boolean {
  return one.shape === other.shape && one.face === other.face && one.tint === other.tint && one.showsLogo === other.showsLogo && one.origin === other.origin;
}

/** Whether `value` is a whole number a look may carry. */
export function isLookIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= highestLookIndex;
}

function isLook(value: unknown): value is Look {
  if (!value || typeof value !== "object") return false;
  const look = value as Record<string, unknown>;
  return isLookIndex(look.shape) && isLookIndex(look.face) && isLookIndex(look.tint) && isLookOrigin(look.origin)
    && (look.showsLogo === undefined || typeof look.showsLogo === "boolean");
}
