import { createHash } from "node:crypto";

// The net's member list (docs/net-plan.md): what an entry holds, which ones are kept,
// and how two copies of the list become one. Every bridge in a net keeps a copy, and
// any of them may change it, so there is no copy to defer to: each entry carries when
// it last changed and who changed it, and of two entries with the same id the newer
// one wins everywhere, but for a removal, which the member itself cannot undo (`isNewer`).
// Entries are never deleted, by a merge, a read or a sync, so a removal outlives a Mac
// that slept through it, however long the list grows. A member's name set from the app
// (`net.rename`: a Mac's, or since 2026-10-28 a device's) has a stamp of its own and is
// merged apart from the rest of its entry (`isNamedLater`): the newest name wins whichever
// copy of the entry does.

/** A member's id: a Mac's machine id (`state/machine.json`), or the one a device made for itself. */
export const memberIDPattern = /^[A-Za-z0-9-]{8,64}$/;
/**
 * The most members a net takes in: an admission limit, counted on the members not
 * removed when a device or a Mac joins (net.ts), never by a merge. Two Macs that each let
 * one in while they could not reach each other end up over it, and both keep both.
 */
export const mostMembers = 200;
/**
 * The most entries a join may leave the list with, removed ones included: an admission
 * limit too (net.ts), never by a merge, which keeps every entry: a removal dropped would
 * let a Mac that slept through it bring the member back.
 */
export const mostEntries = 1000;
/** The longest name a member may have. */
export const longestMemberName = 80;
/** 32 bytes in base64url: an X25519 public key. */
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
/** 16 bytes in base64url: a relay id. */
const relayPattern = /^[A-Za-z0-9_-]{22}$/;
/** SHA-256 in hex: a token's hash. */
const hashPattern = /^[0-9a-f]{64}$/;

export type MemberKind = "mac" | "device";
export const platforms = ["ios", "ipados", "macos"] as const;
export type Platform = (typeof platforms)[number];

export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  /** A Mac's address, with scheme and port. */
  url?: string;
  /** A Mac's X25519 public key, raw 32 bytes in base64url. */
  key?: string;
  /** A Mac's relay id, 16 random bytes in base64url. */
  relay?: string;
  /** A device's platform. */
  platform?: Platform;
  /** SHA-256 of the member's token, in hex. Never in what a device is given. */
  token_hash?: string;
  /** Once removed; the entry is kept. */
  removed?: true;
  /** When it last changed, in milliseconds since 1970. */
  changed: number;
  /** The member that made the change. */
  by: string;
  /**
   * The member's name was set from the app (`net.rename`): when, a stamp in milliseconds
   * since 1970 past every name of that member the Mac that set it had seen. Absent while a
   * Mac goes by its own name (`fleet.name`, else its Computer Name), and a device by the
   * one it joined with (feature `net_rename_devices` for a device's).
   */
  named?: number;
  /** The Mac that set the name: of two set at the same moment, the greater id's wins. */
  named_by?: string;
}

/**
 * A member as a device is given it: without its token's hash, with its token's tag in its
 * place (`tokenTag`) when the entry has a hash.
 */
export type PublicMember = Omit<Member, "token_hash"> & { token_tag?: string };

/** The entry as a member, or undefined when it does not fit (an incoming entry that does not is dropped). */
export function parseMember(value: unknown): Member | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !memberIDPattern.test(raw.id)) return undefined;
  if (raw.kind !== "mac" && raw.kind !== "device") return undefined;
  if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > longestMemberName) return undefined;
  if (!Number.isSafeInteger(raw.changed) || (raw.changed as number) <= 0) return undefined;
  if (typeof raw.by !== "string" || !memberIDPattern.test(raw.by)) return undefined;
  // In the order the table in docs/net-plan.md gives, whatever order it came in.
  const member = { id: raw.id, kind: raw.kind, name: raw.name } as Member;
  if (raw.kind === "mac") {
    if (raw.url !== undefined) {
      if (!isAddress(raw.url)) return undefined;
      member.url = raw.url;
    }
    if (raw.key !== undefined) {
      if (typeof raw.key !== "string" || !keyPattern.test(raw.key)) return undefined;
      member.key = raw.key;
    }
    if (raw.relay !== undefined) {
      if (typeof raw.relay !== "string" || !relayPattern.test(raw.relay)) return undefined;
      member.relay = raw.relay;
    }
  } else if (raw.platform !== undefined) {
    if (!platforms.includes(raw.platform as Platform)) return undefined;
    member.platform = raw.platform as Platform;
  }
  if (raw.token_hash !== undefined) {
    if (typeof raw.token_hash !== "string" || !hashPattern.test(raw.token_hash)) return undefined;
    member.token_hash = raw.token_hash;
  }
  if (raw.removed !== undefined && raw.removed !== false) {
    if (raw.removed !== true) return undefined;
    member.removed = true;
  }
  member.changed = raw.changed as number;
  member.by = raw.by;
  // A name set from the app, its stamp and the Mac that set it, both or neither: a Mac's,
  // or a device's (a bridge from before 2026-10-28 does not read a device's stamp).
  if (raw.named !== undefined || raw.named_by !== undefined) {
    if (!Number.isSafeInteger(raw.named) || (raw.named as number) <= 0 || typeof raw.named_by !== "string" || !memberIDPattern.test(raw.named_by)) return undefined;
    member.named = raw.named as number;
    member.named_by = raw.named_by;
  }
  return member;
}

/** The entries of a list that fit, each id once (the first), however many. */
export function parseMembers(value: unknown): Member[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const members: Member[] = [];
  for (const entry of value) {
    const member = parseMember(entry);
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
  }
  return members;
}

/** How many of `members` are not removed: what the admission limit counts. */
export function liveMembers(members: Member[]): number {
  return members.reduce((count, member) => count + (member.removed ? 0 : 1), 0);
}

/** Whether `value` is an address a Mac answers at: http or https, with a host. */
export function isAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Whether `value` is an address only the computer using it can reach: itself. */
export function isLoopbackAddress(value: string): boolean {
  try {
    const name = new URL(value).hostname.toLowerCase();
    return name === "localhost" || name === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(name);
  } catch {
    return false;
  }
}

/**
 * Whether `one` replaces `other`, an entry with the same id: changed later, or at the
 * same moment by a greater member id. A member's own word under the token it was
 * removed with never undoes the removal, whatever the clocks say: a Mac removed while it
 * was off, which rewrote its entry as it started again, stays removed everywhere and
 * learns it. A join brings a member back: the Mac that takes it in makes the entry, and a
 * Mac comes with the new token its net of one gave it.
 */
export function isNewer(one: Member, other: Member): boolean {
  if (one.removed !== other.removed && one.token_hash === other.token_hash) {
    if (!one.removed && one.by === one.id) return false;
    if (!other.removed && other.by === other.id) return true;
  }
  if (one.changed !== other.changed) return one.changed > other.changed;
  return one.by > other.by;
}

/**
 * Whether `one`'s name was set after `other`'s, two entries of the same member: the later
 * stamp, at the same stamp the greater Mac that set it. A name never set from the app
 * comes before every one that was.
 */
export function isNamedLater(one: Member, other: Member): boolean {
  const at = one.named ?? 0;
  const otherAt = other.named ?? 0;
  if (at !== otherAt) return at > otherAt;
  return (one.named_by ?? "") > (other.named_by ?? "");
}

/** `entry` with the name of `from`, the same member's, and its stamp. */
function withNameOf(entry: Member, from: Member): Member {
  const { named: _named, named_by: _by, ...rest } = entry;
  return from.named === undefined ? { ...rest, name: from.name } : { ...rest, name: from.name, named: from.named, named_by: from.named_by };
}

export interface Merged {
  members: Member[];
  /** Whether the list is not what it was. */
  changed: boolean;
  /** The members the merge removed: in `local` and not removed there, removed in `incoming`. */
  removed: Member[];
}

/**
 * Two copies of the list as one: per id, the newer entry, with the name set last of the
 * two (`isNamedLater`): a rename does not move the entry's own `changed`, so that it
 * can never undo a removal it did not know of, and an entry made after it by a Mac that
 * had not heard of it (the Mac itself, writing its address anew as it starts) keeps it.
 * The local list keeps its order, and members only `incoming` has come after, whatever
 * their number: the admission limits are the joins' to keep, and a merge that left some
 * out would never agree with the other copy, or would let a removal go.
 */
export function merge(local: Member[], incoming: Member[]): Merged {
  const members = [...local];
  const place = new Map(local.map((member, index) => [member.id, index]));
  const removed: Member[] = [];
  let changed = false;
  for (const member of incoming) {
    const index = place.get(member.id);
    if (index === undefined) {
      place.set(member.id, members.length);
      members.push(member);
      changed = true;
      continue;
    }
    const before = members[index];
    const newer = isNewer(member, before) ? member : before;
    const older = newer === member ? before : member;
    const kept = isNamedLater(older, newer) ? withNameOf(newer, older) : newer;
    if (kept === before) continue;
    members[index] = kept;
    if (kept.removed && !before.removed) removed.push(kept);
    changed = true;
  }
  return { members, changed, removed };
}

/** The member as a device is given it. */
export function publicMember(member: Member): PublicMember {
  const { token_hash: hash, ...rest } = member;
  return hash === undefined ? rest : { ...rest, token_tag: tokenTag(hash) };
}

/**
 * Which token an entry is under, for a device: 16 hex digits of SHA-256 over the token's
 * hash, under a label of its own. Two entries of a member under one token have the same
 * tag, so a device applies `isNewer`'s same-token rule as the Macs do (a Mac's own word
 * under the token it was removed with never undoes the removal); it tells nothing of the
 * token, nor of the hash the Macs know it by. Made as the entry is given, never kept.
 */
export function tokenTag(tokenHash: string): string {
  return createHash("sha256").update(`portals token tag\n${tokenHash}`).digest("hex").slice(0, 16);
}
