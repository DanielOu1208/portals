import { createHash, createPrivateKey, diffieHellman, generateKeyPairSync, randomBytes, type JsonWebKey, type KeyObject } from "node:crypto";
import { callLink, whyNot, type TokenLink } from "../fleet/links.ts";
import { GatewayError } from "../gateway/call.ts";
import { cutWhole } from "../json.ts";
import { log } from "../log.ts";
import { machineWord } from "../platform.ts";
import { readStateFile, writeJSON } from "../store/jsonFile.ts";
import { JoinCodes } from "./codes.ts";
import { ErrorCode, RpcError } from "../gateway/errors.ts";
import { isAddress, isNamedLater, liveMembers, longestMemberName, memberIDPattern, merge, mostEntries, mostMembers, parseMember, parseMembers, platforms, publicMember, type Member, type MemberKind, type PublicMember } from "./members.ts";

// The net (docs/net-plan.md): the Macs and devices that reach each other after pairing
// once. There is no home Mac: every bridge keeps a copy of the member list in
// `state/net.json` and any of them may change it, telling the others (`net.sync`), so
// no Mac has to be awake for the others to work. What never leaves this Mac (its token,
// its X25519 private key, its relay id and secret) is in `state/net-own.json`. Both
// files are owner only.
//
// A bridge with neither file makes a net of one as it starts: nothing changes for a
// bridge nobody joins. Both are saved with a `.bak` of the one before, which is taken
// when a file cannot be used (a power cut can leave it empty), and a file that cannot be
// used is kept aside, never written over (`readStateFile`). A member signs in with its
// token (`Authorization: Bearer`), which the list knows by its hash; a device gets one
// when it joins with a code a member made (`POST /net/join`), and a Mac brings its own.
//
// A Mac is named in its entry by its own name (`fleet.name`, else its Computer Name) until
// a device renames it (`net.rename`), on any Mac of the net: the call need not reach the
// Mac renamed, which may be asleep, or reached only through the relay. The new name is
// stamped past every name of that Mac the renaming Mac has seen (`stampAfter`, as the
// entries' own changes are), so a rename made after another wins whatever the Macs'
// clocks say, and two made apart are told by the clocks, then by the Macs' ids. The Mac
// renamed takes the name as its own when the list reaches it, and keeps it, in its entry
// in `state/net.json`, over `fleet.name` and the Computer Name until it is renamed again.
// A device is renamed the same way (feature `net_rename_devices`, 2026-10-28): its entry
// takes the name and its stamp, and the device reads it from the list. One that joins
// again replaces its entry, as before, its name stamped as a rename made then.

/** Why nothing else can join a Mac set up for itself alone (`Net.thisMacOnly`): what to do about it. */
export const thisMacOnlyRefusal = "This Mac is set up to use Portals on this Mac only, so nothing else can reach it. To add your iPhone, iPad or another computer, install Tailscale and run npx portals-host setup again.";

/** Why a Mac can't join one set up for itself alone: said to that other Mac, so "that". */
export const thisMacOnlyJoinRefusal = "That Mac is set up to use Portals on itself only, so it can't share a net. To change that, install Tailscale and run npx portals-host setup again on it.";

/** How long a call to another Mac about the list may take. */
const syncCallMs = 10_000;
/** A day: how far past this Mac's clock a device's stamp of a name may be (`rename`). */
const dayMs = 86_400_000;
/** How often every other Mac is asked, besides after each change. */
const syncEveryMs = 10 * 60_000;
/** How long after asking every other Mac for a token it did not know it asks again. */
const pullEveryMs = 30_000;

/** 32 bytes in base64url: a token, or a relay secret. */
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
/** 16 bytes in base64url: a relay id. */
const relayIDPattern = /^[A-Za-z0-9_-]{22}$/;

/** A connection signed in with a member's token: which member, of which kind, and whether it was removed (a Mac then may only ask for the list). */
export interface MemberSignIn {
  kind: "member";
  id: string;
  member: MemberKind;
  removed: boolean;
}

/** How a connection signed in: with the password, as a member of the net, or on the `portals` command's socket. */
export type SignedIn = { kind: "password" } | { kind: "local" } | MemberSignIn;

/** What never leaves this Mac. */
interface Own {
  /** This Mac's token, which the other Macs know it by. */
  token: string;
  /** The X25519 private key, as a JWK. */
  key: JsonWebKey;
  /** What the relay knows this Mac by: its id, and the secret it opens its tunnel with. */
  relay: { id: string; secret: string };
}

/**
 * The net this Mac left last (`net.leave`), kept so that a Mac of it that was off or
 * asleep then learns it as it comes back: when it asks, it is answered in that net's
 * terms, with this Mac's entry removed. Kept until this Mac leaves another.
 */
interface Left {
  net: string;
  /** This Mac's entry as it left, removed. */
  entry: Member;
  /** The Macs it left behind, by their tokens' hashes. */
  macs: { id: string; token_hash: string }[];
}

/** A join refused, with the HTTP status `/net/join` answers and a sentence for the user. */
export class NetRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Told of what the net does. */
export interface NetListener {
  /** The list changed, and was saved. */
  moved?(): void;
  /** This Mac's name for itself is now `name`: set from the app, here or on another Mac (`net.rename`). */
  renamed?(name: string): void;
  /** These members are out of the net here: their connections close, their notifications go. */
  removed?(members: Member[]): void;
  /**
   * These members are in under another token than before (a device that joined again, here
   * or in a net this Mac joined): what the old token opened closes, as it would be refused now.
   */
  retokened?(members: Member[]): void;
}

export interface NetOptions {
  /** `state/net.json` */
  path: string;
  /** `state/net-own.json` */
  ownPath: string;
  /** This Mac: its machine id (`state/machine.json`) and its name. */
  here: { id: string; name: string };
  now?: () => number;
  codes?: JoinCodes;
  /** Makes a call to another Mac; tests put a stand-in here. */
  call?: (link: TokenLink, method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;
  /** Asks another Mac to join its net (`POST /net/join`); tests put a stand-in here. */
  fetch?: typeof fetch;
  pullEveryMs?: number;
  syncEveryMs?: number;
}

export class Net {
  readonly codes: JoinCodes;
  listener: NetListener = {};
  private readonly path: string;
  private readonly ownPath: string;
  /** This Mac: its id, and the name it goes by, its own (`fleet.name`, its Computer Name) or the one set from the app. */
  private readonly here: { id: string; name: string };
  /** When this Mac's name was set from the app, and by which Mac; undefined while it goes by its own. */
  private nameStamp: { at: number; by: string } | undefined;
  private readonly now: () => number;
  private readonly call: NonNullable<NetOptions["call"]>;
  private readonly fetch: typeof fetch;
  private readonly pullEveryMs: number;
  private readonly syncEveryMs: number;
  private own: Own;
  private netID: string;
  private current: number;
  private members: Member[];
  private left: Left | undefined;
  /** By token hash: the member it is. */
  private byHash = new Map<string, Member>();
  /** This Mac's address, once listening. */
  private url = "";
  /**
   * Setup gave this Mac no address but its own, 127.0.0.1 (no Tailscale): only Portals on
   * this Mac can reach it. A code or an entry carrying that address would have whoever got
   * it dial themselves, so it hands out neither (docs/net-plan.md).
   */
  thisMacOnly = false;
  private timer: NodeJS.Timeout | undefined;
  /** Aborted when the bridge closes, so no call to another Mac outlives it. */
  private readonly closing = new AbortController();
  private pulling: Promise<void> | undefined;
  private pulledAt = -Infinity;
  /**
   * This Mac's own join to a net is under way (`joinWith`): another is refused, and so is a
   * Mac joining this one, and so is leaving, until it is answered. What changes here meanwhile is taken along
   * into the net joined, which is only right for this Mac's own devices and removals.
   */
  private joining = false;
  /** This Mac is leaving its net (`leave`), telling the other Macs: a join of its own, and a device or Mac joining it, are refused until it has. */
  private leaving = false;

  constructor(options: NetOptions) {
    this.path = options.path;
    this.ownPath = options.ownPath;
    this.here = { id: options.here.id, name: fitName(options.here.name) };
    this.now = options.now ?? Date.now;
    this.codes = options.codes ?? new JoinCodes();
    this.call = options.call ?? ((link, method, params, timeoutMs, signal) => callLink(link, method, params, timeoutMs, undefined, signal));
    this.fetch = options.fetch ?? fetch;
    this.pullEveryMs = options.pullEveryMs ?? pullEveryMs;
    this.syncEveryMs = options.syncEveryMs ?? syncEveryMs;
    this.own = readOwn(this.ownPath);
    const read = readStateFile(this.path);
    const file = read.found;
    if (typeof file.net === "string" && /^[0-9a-f]{16}$/.test(file.net)) {
      this.netID = file.net;
      this.current = Number.isSafeInteger(file.revision) && (file.revision as number) >= 0 ? (file.revision as number) : 0;
      this.members = parseMembers(file.members);
    } else {
      // A net of one, saved once this Mac's entry is made (`start`).
      this.netID = newNetID();
      this.current = 0;
      this.members = [];
    }
    this.left = parseLeft(file.left, this.here.id);
    // A name set from the app wins over this Mac's own until it is set again.
    const own = this.members.find((member) => member.id === this.here.id);
    if (own?.named !== undefined && own.named_by !== undefined) {
      this.here.name = own.name;
      this.nameStamp = { at: own.named, by: own.named_by };
    }
    this.index();
    if (read.fromBackup) {
      // The `.bak` is one save behind: the save it lost had the next revision, which a
      // device may hold, so this one is saved past it at once.
      this.current += 1;
      this.commit(this.netID, this.members, read.aside);
    }
  }

  /**
   * Once listening at `url`: this Mac's entry is written again when its name, address,
   * key or relay id changed (or it has none: a new net), every other Mac is asked for
   * its copy, and asked again every ten minutes.
   */
  start(url: string, options: { thisMacOnly?: boolean } = {}): void {
    this.url = url;
    this.thisMacOnly = options.thisMacOnly ?? false;
    const entry = this.members.find((member) => member.id === this.here.id);
    if (entry?.removed) {
      // Removed while it was off, or as it stopped: a net of its own.
      this.startAlone("it was removed from its net");
    } else if (!entry || !sameFacts(entry, this.ownEntry())) {
      this.commit(this.netID, this.withOwnEntry(this.members));
    }
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), this.syncEveryMs);
    this.timer.unref();
  }

  /** Stops asking the other Macs, and lets go of the calls under way. */
  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.closing.abort(new Error("The bridge is shutting down."));
  }

  // MARK: Reading

  /** The name this Mac goes by: set from the app (`net.rename`), else its own. */
  name(): string {
    return this.here.name;
  }

  /** The net's id and the list's revision, which goes up with every change saved. */
  revision(): { id: string; revision: number } {
    return { id: this.netID, revision: this.current };
  }

  /** What `net.list` answers, for the member `you` (null for a password or the command). */
  list(you: string | null): { net: string; here: string; you: string | null; revision: number; members: PublicMember[] } {
    return { net: this.netID, here: this.here.id, you, revision: this.current, members: this.members.map(publicMember) };
  }

  /** The other Macs in the net, not removed and with an address. */
  macs(): { id: string; name: string; url: string }[] {
    return this.otherMacs().map((mac) => ({ id: mac.id, name: mac.name, url: mac.url! }));
  }

  /** This Mac's own token. */
  token(): string {
    return this.own.token;
  }

  /** This Mac's X25519 public key, raw, in base64url. */
  publicKey(): string {
    return this.own.key.x!;
  }

  /** This Mac's relay id and secret. */
  relay(): { id: string; secret: string } {
    return { ...this.own.relay };
  }

  /** X25519 between this Mac's private key and `publicKey` (the relay's tunnel), so the key never leaves this class. */
  agree(publicKey: KeyObject): Buffer {
    return diffieHellman({ privateKey: createPrivateKey({ key: this.own.key, format: "jwk" }), publicKey });
  }

  // MARK: Tokens

  /**
   * The member `token` is, when the list knows it: a device not removed, or any Mac (a
   * removed one may still ask for the list, to learn it is removed). A token the list
   * does not know makes it ask every other Mac first, at most once every 30 seconds,
   * those who come meanwhile waiting for the same answers; then it looks again.
   */
  async authenticate(token: string): Promise<MemberSignIn | undefined> {
    if (!secretPattern.test(token)) return undefined;
    const hash = hashToken(token);
    // Known, removed or not: nothing to ask the others about.
    if (this.byHash.has(hash)) return this.lookup(hash);
    // A Mac of the net this one left: it may only ask for the list, to learn it.
    const behind = this.left?.macs.find((mac) => mac.token_hash === hash);
    if (behind) return { kind: "member", id: behind.id, member: "mac", removed: true };
    await this.pull();
    return this.lookup(hash);
  }

  /**
   * The member `token` is by the list as it is now, asking no other Mac: for a check made
   * again right before something is changed for a member that signed in a while ago.
   */
  known(token: string): MemberSignIn | undefined {
    return secretPattern.test(token) ? this.lookup(hashToken(token)) : undefined;
  }

  /** Whether `id` is another member of the net, not removed. */
  isMember(id: string): boolean {
    return id !== this.here.id && this.members.some((member) => member.id === id && !member.removed);
  }

  private lookup(hash: string): MemberSignIn | undefined {
    const member = this.byHash.get(hash);
    if (!member || member.id === this.here.id || (member.removed && member.kind === "device")) return undefined;
    return { kind: "member", id: member.id, member: member.kind, removed: member.removed === true };
  }

  private pull(): Promise<void> {
    if (this.pulling) return this.pulling;
    if (this.now() - this.pulledAt < this.pullEveryMs) return Promise.resolve();
    this.pulledAt = this.now();
    this.pulling = this.syncAll().finally(() => {
      this.pulling = undefined;
    });
    return this.pulling;
  }

  // MARK: Joining

  /** A join code, and the link that carries it: `portals://join?v=1&url=…&code=…&name=…`. */
  invite(): { link: string; code: string; url: string; expires_at: number } {
    const { code, expiresAt } = this.codes.issue(this.netID);
    return { link: joinLink({ url: this.url, code, name: this.here.name }), code, url: this.url, expires_at: expiresAt };
  }

  /**
   * `POST /net/join`: a device or a Mac joins with a code. A device is given a token; a
   * Mac brings its token's hash and its whole list, whose devices come along. Throws
   * `NetRefused` with the status and a sentence.
   */
  join(body: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!body) throw new NetRefused(400, "The request must be a JSON object.");
    // The net of its own it starts as the leave ends would drop whoever joined meanwhile. The code is kept.
    if (this.leaving) throw new NetRefused(409, "This Mac is leaving its net. Try again in a moment.");
    const check = this.codes.check(body.code, this.netID);
    if (check === "limited") throw new NetRefused(429, "Too many wrong join codes. Try again in a minute.");
    if (check === "wrong") throw new NetRefused(401, "This join code is used, expired or wrong. Make a new one on a device in the net.");
    const given = typeof body.member === "object" && body.member !== null && !Array.isArray(body.member) ? (body.member as Record<string, unknown>) : undefined;
    if (!given) throw new NetRefused(400, "Say who is joining: member.");
    return given.kind === "mac" ? this.joinMac(body.code as string, given, body.members, body.net) : this.joinDevice(body.code as string, given);
  }

  private joinDevice(code: string, given: Record<string, unknown>): Record<string, unknown> {
    const before = this.members.find((member) => member.id === given.id);
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    // Joining again, the name it joins with is its name from now on, stamped as a rename:
    // past a name it was given before, and past one given on another Mac that this one has
    // not heard of when the clocks say it came first, either of which the merge would
    // otherwise keep over it on every Mac (`isNamedLater`). Stamped at the entry's own
    // change, which every rename of a device comes after (`rename`): the device tells the
    // name it joined with from one it was given (`NetMembership.givenName`).
    const stamp = before ? Math.max(stampAfter(before, now), (before.named ?? 0) + 1) : undefined;
    // Past a stamp at the very end (a copy made wrong) there is none: joined unstamped, as before.
    const rejoined = stamp !== undefined && Number.isSafeInteger(stamp) ? stamp : undefined;
    const entry = parseMember({
      id: given.id,
      kind: given.kind,
      name: typeof given.name === "string" ? fitName(given.name) : given.name,
      ...(given.platform === undefined || given.platform === null ? {} : { platform: given.platform }),
      token_hash: hashToken(token),
      // After the entry it replaces, a removal stamped by a Mac whose clock is ahead included.
      changed: rejoined ?? (before ? stampAfter(before, now) : now),
      by: this.here.id,
      ...(rejoined === undefined ? {} : { named: rejoined, named_by: this.here.id }),
    });
    if (!entry || entry.kind !== "device") {
      throw new NetRefused(400, `A device joins with an id (8 to 64 letters, digits or dashes), a name of at most ${longestMemberName} characters and a platform: ${platforms.join(", ")}.`);
    }
    this.checkJoiner(entry);
    // One that was here before, removed or not, is replaced: the device starts again.
    const members = before ? this.members.map((member) => (member.id === entry.id ? entry : member)) : [...this.members, entry];
    const full = this.full(members, "device");
    if (full) throw new NetRefused(409, full);
    this.codes.take(code);
    this.commit(this.netID, members);
    void this.syncAll();
    log.info("a device joined the net", { member: entry.id });
    return { net: this.netID, member: publicMember(entry), token, members: this.members.map(publicMember) };
  }

  private joinMac(code: string, given: Record<string, unknown>, list: unknown, from: unknown): Record<string, unknown> {
    // The answer would hand that Mac this one's 127.0.0.1, for it and its devices to dial
    // themselves at. A code gets this far by a password sign-in, or a tunnel to this Mac. It is kept.
    if (this.thisMacOnly) throw new NetRefused(409, thisMacOnlyJoinRefusal);
    // Its devices would come along into the net this Mac is joining, their tokens with them.
    if (this.joining) throw new NetRefused(409, "This Mac is joining another net. Try again in a moment.");
    // Made by this Mac, as a device's is: a Mac's own word does not undo its removal
    // (`isNewer`). After the entry it replaces, as for a device.
    const before = this.members.find((member) => member.id === given.id);
    const changed = before ? stampAfter(before, this.now()) : this.now();
    const entry = parseMember({ ...given, name: typeof given.name === "string" ? fitName(given.name) : given.name, removed: undefined, changed, by: this.here.id });
    if (!entry || !entry.url || !entry.token_hash) {
      throw new NetRefused(400, "A Mac joins with its id, name, address and token_hash, and its key and relay id.");
    }
    if (entry.id === this.here.id) throw new NetRefused(409, `This is the ${machineWord()} that made the code.`);
    this.checkJoiner(entry);
    // From another net (the request says which it is in, `net`), a removal of a member this
    // net has in under another token is of its way into the joining Mac's net (a device that
    // went from there to here, say), not of its way here. A Mac of this net joining it again
    // brings its removals as they are: the net's own. So does a bridge that does not say
    // (from before 2026-10-26): leaving one out could let a revoked token in again.
    const otherNet = typeof from === "string" && from !== this.netID;
    const kept = new Map(this.members.map((member) => [member.id, member]));
    const theirs = parseMembers(list).filter((member) => member.id !== entry.id && member.id !== this.here.id && !(otherNet && removesAnother(member, kept.get(member.id))));
    // A Mac in a net with others would leave them behind: its devices come along, its Macs cannot.
    const ours = new Set(this.otherMacs().map((mac) => mac.id));
    if (theirs.some((member) => member.kind === "mac" && !member.removed && !ours.has(member.id))) {
      throw new NetRefused(409, "This Mac is in a net with other Macs. Run `portals net leave` on it first.");
    }
    // The whole of what joins is counted, the Mac with its devices, before anything is
    // taken in; what is then taken in is that list, every entry of it.
    const full = this.full(merge(this.members, [...theirs, entry]).members, "mac");
    if (full) throw new NetRefused(409, full);
    this.codes.take(code);
    if (!this.apply([...theirs, entry], entry.id)) throw new NetRefused(500, `The net's list could not be saved on this ${machineWord()}.`);
    log.info("a Mac joined the net", { member: entry.id });
    return { net: this.netID, members: this.members };
  }

  /** Refuses a joiner whose id the list has for the other kind. */
  private checkJoiner(entry: Member): void {
    const before = this.members.find((member) => member.id === entry.id);
    if (before && before.kind !== entry.kind) throw new NetRefused(409, `That id is a ${before.kind === "mac" ? "Mac's" : "device's"} in this net.`);
  }

  /**
   * Why a join that makes the list `members` is refused, or undefined when it is not: it
   * lets in more members not removed than the net takes, or leaves the list with more
   * entries, removed ones included, than a join may. A join that adds none of either is
   * not refused for it, though two Macs that each let one in while apart left the net
   * over its most. Nothing is cut afterwards: what a join takes in is kept.
   */
  private full(members: Member[], joining: MemberKind): string | undefined {
    const live = liveMembers(members);
    if (live > mostMembers && live > liveMembers(this.members)) {
      return joining === "mac" ? `This net is full: with this ${machineWord()} and its devices it would have ${live} members, and it takes ${mostMembers}.` : `This net is full: it has ${mostMembers} members.`;
    }
    if (members.length > mostEntries && members.length > this.members.length) {
      return joining === "mac"
        ? `This net is full: with this ${machineWord()} and its devices its list would have ${members.length} entries, removed members included, and it keeps ${mostEntries}.`
        : `This net is full: its list keeps ${mostEntries} entries, removed members included.`;
    }
    return undefined;
  }

  /**
   * This Mac joins the net of a `portals://join` link: it hands the issuing Mac its own
   * entry and its whole list, takes the answer as its list and net id, and tells every
   * Mac. Refused while this Mac is in a net with other Macs.
   */
  async joinWith(text: string): Promise<ReturnType<Net["list"]>> {
    const link = parseJoinLink(text);
    if (this.thisMacOnly) throw new NetError(thisMacOnlyRefusal);
    if (this.joining) throw new NetError("This Mac is already joining a net. Try again once that is done.");
    // The net of its own it starts as the leave ends would leave the net joined holding a token it no longer has.
    if (this.leaving) throw new NetError("This Mac is leaving its net. Join once that is done.");
    this.joining = true;
    try {
      return await this.joinWithLink(link);
    } finally {
      this.joining = false;
    }
  }

  private async joinWithLink(link: { url: string; code: string }): Promise<ReturnType<Net["list"]>> {
    // The list as handed over: what changes on it before the answer comes is taken along (below).
    const sent = this.members;
    const sentFrom = this.netID;
    let response: Response;
    try {
      response = await this.fetch(`${link.url.replace(/\/+$/, "")}/net/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ code: link.code, member: this.ownEntry(), members: sent, net: sentFrom }),
        signal: AbortSignal.any([AbortSignal.timeout(syncCallMs), this.closing.signal]),
      });
    } catch (error) {
      throw new NetError(`Could not join: ${whyNot(error)}`, ErrorCode.internal);
    }
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status !== 200) {
      const detail = typeof answer.detail === "string" ? answer.detail : `the other Mac answered ${response.status}.`;
      if (response.status === 409) throw new NetError(detail);
      throw new NetError(response.status === 404 ? "The other Mac's bridge is too old to take a Mac into its net. Update it." : `Could not join: ${detail}`, ErrorCode.internal);
    }
    const members = parseMembers(answer.members);
    if (typeof answer.net !== "string" || !/^[0-9a-f]{16}$/.test(answer.net) || !members.some((member) => member.id === this.here.id)) {
      throw new NetError("Could not join: the other Mac's answer is not a net's list.", ErrorCode.internal);
    }
    // Taken out of its net meanwhile, this Mac started a net of its own, with a new token: the
    // answer, of before, would put it back where it was taken out, under a token it no longer has.
    if (this.netID !== sentFrom) {
      throw new NetError("This Mac was taken out of its net while it joined, and is in a net of its own now: nothing was joined. Try again with a new code.");
    }
    const before = this.members.filter((member) => member.id !== this.here.id && !member.removed);
    // A device that joined here or a member removed here while the answer was on its way is
    // not in it: taken along, as the list handed over was, else the device would be left out
    // and the member back in. A Mac that joined meanwhile is not: the net it joins was not asked.
    // Nor, from another net, a removal of a member the net has under another token: that is
    // of its way into this Mac's net. Of its own net, its removals are the net's.
    const ownNet = answer.net === sentFrom;
    const answered = new Map(members.map((member) => [member.id, member]));
    const meanwhile = this.members.filter(
      (member) => member.id !== this.here.id && !sent.includes(member) && (member.kind === "device" || member.removed) && (ownNet || !removesAnother(member, answered.get(member.id))),
    );
    // So is a later name of a member this one holds, set here meanwhile or before (a bridge
    // from before the feature answers without the names' stamps, and one from before
    // 2026-10-28 without a device's): its name alone, on the answer's entry for it. The rest
    // of the entry is the net's to say, and a member the net has not is not taken along.
    for (const member of this.members) {
      const theirs = answered.get(member.id);
      if (member.id === this.here.id || !theirs || !isNamedLater(member, theirs)) continue;
      meanwhile.push({ ...theirs, name: member.name, named: member.named, named_by: member.named_by });
    }
    // Renamed in that net while it was away from it: the later name is this Mac's now.
    const named = this.laterName(members);
    const joined = answer.net;
    const save = () => this.commit(joined, this.withOwnEntry(merge(members, meanwhile).members));
    if (named) {
      this.goBy(named.name, { at: named.named!, by: named.named_by! }, save);
      this.listener.renamed?.(named.name);
    } else {
      save();
    }
    // Those this Mac knew that the net's answer has not: none from a bridge that keeps every entry.
    const gone = before.filter((member) => !this.members.some((kept) => kept.id === member.id && !kept.removed));
    if (gone.length > 0) this.listener.removed?.(gone);
    void this.syncAll();
    log.info("this Mac joined a net", { net: this.netID });
    return this.list(null);
  }

  // MARK: Changes

  /**
   * Names the member `id` (this Mac, another, or a device of the net) `name` for the whole
   * net, as a device renamed it (`net.rename`), and tells every Mac. `after`: the stamp of
   * the name the device held for it, which the new one comes after too: the device may have
   * heard of a rename this Mac has not yet. Throws `NetError` for a member the net has not,
   * or has removed, and for a name that cannot be one. The same name again changes nothing
   * when the device says no stamp, or one older than this Mac holds: what it asks for is the latest
   * already. With the stamp this Mac holds or a later one it is a rename all the same: the
   * device may have seen another name win since (one at the same stamp by a greater id, or
   * a later one this Mac has not heard of), and asks for this one back. With `net`, the net
   * the caller means: refused once this Mac is in another, as `remove` is, so a device that
   * switched nets meanwhile does not rename a member of the net this one has moved into.
   */
  rename(id: string, name: string, after?: number, net?: string): void {
    if (net !== undefined && net !== this.netID) throw new NetError("This Mac is not in that net any more: nothing was renamed.");
    const member = this.members.find((entry) => entry.id === id);
    if (!member || member.removed) throw new NetError(`There is no member ${id} in this net.`);
    const given = checkedName(name, member.kind);
    const held = member.named ?? 0;
    // The device's stamp, when it is one a Mac could have made: not past a day beyond this
    // Mac's clock and its own stamp, so one sent wrong cannot put the name past every
    // rename to come (a Mac's clock ahead by an hour is taken).
    const seen = Number.isSafeInteger(after) && after! > 0 && after! <= Math.max(this.now(), held) + dayMs ? after! : 0;
    if (given === member.name && (after === undefined || after === null || seen < held)) return;
    // After every name of that member seen here or by the device, whatever this Mac's clock
    // says; a device's after its entry's own change too, where a name it joined with again is
    // stamped (`joinDevice`), so the device tells a name it was given from that one.
    const at = Math.max(this.now(), held + 1, seen + 1, member.kind === "device" ? member.changed + 1 : 0);
    // A stamp at the very end (from a copy made wrong) cannot be moved past: one at the same
    // stamp from the same Mac would not be told apart from it, and the Macs would disagree.
    if (!Number.isSafeInteger(at)) throw new NetError(`${member.kind === "mac" ? "This Mac's" : "This device's"} name has a stamp that cannot be moved past, so it cannot be renamed.`);
    if (id === this.here.id) {
      this.goBy(given, { at, by: this.here.id }, () => this.commit(this.netID, this.withOwnEntry(this.members)));
      this.listener.renamed?.(given);
    } else {
      // The entry's own `changed` stays: a rename is merged apart from it (`merge`), so it
      // cannot undo a removal made meanwhile on a Mac this one has not heard from.
      const renamed: Member = { ...member, name: given, named: at, named_by: this.here.id };
      this.commit(this.netID, this.members.map((entry) => (entry.id === id ? renamed : entry)));
    }
    void this.syncAll();
    log.info(member.kind === "mac" ? "renamed a Mac of the net" : "renamed a device of the net", { member: id });
  }

  /** This Mac goes by `name`, set from the app as `stamp` says, once `save` saved it; as before when it could not. */
  private goBy(name: string, stamp: { at: number; by: string }, save: () => void): void {
    const was = { name: this.here.name, stamp: this.nameStamp };
    this.here.name = name;
    this.nameStamp = stamp;
    try {
      save();
    } catch (error) {
      this.here.name = was.name;
      this.nameStamp = was.stamp;
      throw error;
    }
  }

  /**
   * Marks a member removed and tells every Mac (and the Mac removed, so it knows). With
   * `net`, the net the caller means: refused once this Mac is in another, so a device that
   * left a net and asks one of its Macs to take it out (a switch of nets) does not take
   * itself out of the net that Mac has moved into since, the one the device joined maybe.
   */
  remove(id: string, by: string, net?: string): void {
    if (net !== undefined && net !== this.netID) throw new NetError("This Mac is not in that net any more: nothing was removed.");
    if (id === this.here.id) throw new NetError("A Mac cannot remove itself: run `portals net leave` on it.");
    const member = this.members.find((entry) => entry.id === id);
    if (!member || member.removed) throw new NetError(`There is no member ${id} in this net.`);
    const removed: Member = { ...member, removed: true, changed: stampAfter(member, this.now()), by };
    this.commit(this.netID, this.members.map((entry) => (entry.id === id ? removed : entry)));
    this.listener.removed?.([removed]);
    void this.syncAll();
    if (removed.kind === "mac" && removed.url) void this.syncWith(removed);
    log.info("removed a member from the net", { member: id });
  }

  /**
   * This Mac leaves: the others are told it is removed, then it is a net of one. A Mac
   * that does not answer then learns it when it next asks, from what is kept of the net
   * left (`Left`).
   */
  async leave(): Promise<ReturnType<Net["list"]>> {
    // The join's answer, taken after, would put this Mac back into a net, under the token it is leaving with.
    if (this.joining) throw new NetError("This Mac is joining a net. Leave it once that is done.");
    if (this.leaving) throw new NetError("This Mac is leaving its net already.");
    this.leaving = true;
    try {
      return await this.leaveNow();
    } finally {
      this.leaving = false;
    }
  }

  private async leaveNow(): Promise<ReturnType<Net["list"]>> {
    const own = this.members.find((member) => member.id === this.here.id) ?? this.ownEntry();
    const entry: Member = { ...own, removed: true, changed: stampAfter(own, this.now()), by: this.here.id };
    const parting = this.members.map((member) => (member.id === this.here.id ? entry : member));
    const macs = this.otherMacs();
    // Alone already, it keeps what it kept of the net it left before.
    if (macs.length > 0) this.left = { net: this.netID, entry, macs: macs.flatMap((mac) => (mac.token_hash ? [{ id: mac.id, token_hash: mac.token_hash }] : [])) };
    // Told and not asked: their answers would remove this Mac from the net it is starting.
    await Promise.all(
      macs.map((mac) =>
        this.call({ name: mac.id, url: mac.url!, token: this.own.token }, "net.sync", { net: this.netID, members: parting }, syncCallMs, this.closing.signal).catch((error: unknown) =>
          log.debug("could not tell a Mac this one left the net", { member: mac.id, error: whyNot(error) }),
        ),
      ),
    );
    this.startAlone("it left its net");
    return this.list(null);
  }

  /**
   * `net.sync` from another Mac: its copy merged into this one, which is the answer. One
   * that was removed is not heard, and is answered with its own entry alone, which is all
   * it needs to learn it is out; one of the net this Mac left, with this Mac's entry in
   * that net, removed. Every entry of the copy is taken in, however many: a removal must
   * reach every Mac, and only a join is held to a limit (`full`).
   */
  receive(from: MemberSignIn, net: string, members: unknown): { net: string; members: Member[] } {
    if (from.removed) {
      if (this.left && net === this.left.net && this.left.macs.some((mac) => mac.id === from.id)) return { net: this.left.net, members: [this.left.entry] };
      return { net: this.netID, members: this.members.filter((member) => member.id === from.id) };
    }
    if (net !== this.netID) throw new NetError("This Mac is in another net.");
    this.apply(parseMembers(members), from.id);
    return { net: this.netID, members: this.members };
  }

  // MARK: Copying

  /** Asks every other Mac for its copy, giving this one, all at once. */
  private async syncAll(except?: string): Promise<void> {
    await Promise.all(this.otherMacs().filter((mac) => mac.id !== except).map((mac) => this.syncWith(mac)));
  }

  private async syncWith(mac: Member): Promise<void> {
    const net = this.netID;
    try {
      const answer = (await this.call({ name: mac.id, url: mac.url!, token: this.own.token }, "net.sync", { net, members: this.members }, syncCallMs, this.closing.signal)) as Record<string, unknown>;
      // A net started meanwhile, here or there, takes nothing from the other.
      if (answer?.net !== this.netID || net !== this.netID) return;
      // A removed Mac is still told it is out, but is no longer heard. Nor is an
      // answer from before its token changed: that membership no longer speaks for it.
      const current = this.members.find((member) => member.id === mac.id);
      if (!current || current.removed || current.token_hash !== mac.token_hash) return;
      this.apply(parseMembers(answer.members), mac.id);
    } catch (error) {
      if (this.closing.signal.aborted) return;
      log.debug("could not copy the net's list to a Mac", { member: mac.id, error: error instanceof GatewayError ? error.message : whyNot(error) });
    }
  }

  /**
   * Merges a copy from `from` into this one. Something new is saved and copied on to the
   * other Macs, not back to `from`. A copy that removes this Mac makes it a net of one.
   * False when the list could not be saved.
   */
  private apply(incoming: Member[], from: string): boolean {
    // Of this Mac's own entry only its removal is taken from another, and a name set for it
    // from the app later than its own: the rest is this Mac's to say.
    const taken = incoming.filter((member) => member.id !== this.here.id || (member.removed && member.kind === "mac"));
    const merged = merge(this.members, taken);
    const named = this.laterName(incoming);
    if (!merged.changed && !named) return true;
    const was = this.here.name;
    try {
      if (named) {
        this.goBy(named.name, { at: named.named!, by: named.named_by! }, () => this.commit(this.netID, this.withOwnEntry(merged.members)));
      } else {
        this.commit(this.netID, merged.members);
      }
    } catch (error) {
      log.warn("could not save the net's list", { error: (error as Error).message });
      return false;
    }
    if (named && named.name !== was) {
      this.listener.renamed?.(named.name);
      log.info("this Mac was renamed from another device", { by: named.named_by });
    }
    if (this.members.find((member) => member.id === this.here.id)?.removed) {
      // Those the same copy removed are let go of too: they are no longer among the others.
      this.startAlone("it was removed from its net", merged.removed.filter((member) => member.id !== this.here.id));
      return true;
    }
    if (merged.removed.length > 0) this.listener.removed?.(merged.removed);
    // Its own entry written anew goes back to `from` too, for a bridge that reads only whole entries.
    void this.syncAll(named ? undefined : from);
    return true;
  }

  /** This Mac's entry in `incoming` when it has a name set from the app later than the one this Mac goes by. */
  private laterName(incoming: Member[]): Member | undefined {
    const own = incoming.find((member) => member.id === this.here.id && member.kind === "mac" && !member.removed);
    if (!own || own.named === undefined || own.named_by === undefined) return undefined;
    return isNamedLater(own, this.ownEntry()) ? own : undefined;
  }

  /** A new net with this Mac alone, and a new token; its key and relay id stay. `alsoRemoved`: members removed by the change that made it alone, let go of with the others. */
  private startAlone(why: string, alsoRemoved: Member[] = []): void {
    const others = [...alsoRemoved, ...this.members.filter((member) => member.id !== this.here.id && !member.removed)];
    this.own = { ...this.own, token: randomBytes(32).toString("base64url") };
    writeJSON(this.ownPath, this.own, { backup: true });
    this.commit(newNetID(), [this.ownEntry()]);
    log.info(`this Mac is in a net of its own now: ${why}`, { net: this.netID });
    if (others.length > 0) this.listener.removed?.(others);
  }

  /** Saves the list as the net `net`'s, one revision on, then uses it. `aside`: where a file that could not be used is kept (`readStateFile`). */
  private commit(net: string, members: Member[], aside?: string): void {
    const before = new Map(this.members.map((member) => [member.id, member]));
    const retokened = members.filter((member) => {
      const was = before.get(member.id);
      return member.id !== this.here.id && !member.removed && was !== undefined && !was.removed && was.token_hash !== member.token_hash;
    });
    const revision = this.current + 1;
    writeJSON(this.path, { net, revision, members, ...(this.left ? { left: this.left } : {}) }, { backup: true, aside });
    // A code lets in to the net it was made in: none made before outlives a move to another.
    if (net !== this.netID) this.codes.clear();
    this.netID = net;
    this.current = revision;
    this.members = members;
    this.index();
    this.listener.moved?.();
    if (retokened.length > 0) this.listener.retokened?.(retokened);
  }

  private index(): void {
    this.byHash = new Map(this.members.flatMap((member) => (member.token_hash ? [[member.token_hash, member] as const] : [])));
  }

  private otherMacs(): Member[] {
    return this.members.filter((member) => member.kind === "mac" && member.id !== this.here.id && !member.removed && member.url);
  }

  /** This Mac's entry as it is now. */
  private ownEntry(): Member {
    return {
      id: this.here.id,
      kind: "mac",
      name: this.here.name,
      url: this.url,
      key: this.own.key.x!,
      relay: this.own.relay.id,
      token_hash: hashToken(this.own.token),
      changed: this.now(),
      by: this.here.id,
      ...(this.nameStamp ? { named: this.nameStamp.at, named_by: this.nameStamp.by } : {}),
    };
  }

  /**
   * `members` with this Mac's entry as it is now, kept as it was when nothing of it
   * changed. A new one is stamped after the one it replaces, which a Mac whose clock is
   * ahead may have made (taking this Mac in): else the others keep that one, its old
   * address with it, as newer.
   */
  private withOwnEntry(members: Member[]): Member[] {
    const before = members.find((member) => member.id === this.here.id);
    const fresh = this.ownEntry();
    if (before && !before.removed && sameFacts(before, fresh)) return members;
    if (before) fresh.changed = stampAfter(before, fresh.changed);
    return before ? members.map((member) => (member.id === this.here.id ? fresh : member)) : [...members, fresh];
  }
}

/** A net call refused, with a sentence for the user: -32602 unless said. */
export class NetError extends RpcError {
  constructor(message: string, code: number = ErrorCode.invalidParams) {
    super(code, message);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether two entries of the same Mac say the same: name and when it was set, address, key, relay id and token. */
function sameFacts(one: Member, other: Member): boolean {
  return (
    one.name === other.name &&
    one.named === other.named &&
    one.named_by === other.named_by &&
    one.url === other.url &&
    one.key === other.key &&
    one.relay === other.relay &&
    one.token_hash === other.token_hash
  );
}

/** When a change to `member` is stamped: now, or just after the entry it replaces when this Mac's clock is behind the one that made it. */
/**
 * Whether `removal` removes another way in than `kept`'s: `kept` is in, under another
 * token. Taken from another net's list (a Mac joining), such a removal is of the member's
 * way into that net, and the time it was made says nothing of this one.
 */
function removesAnother(removal: Member, kept: Member | undefined): boolean {
  return removal.removed === true && kept !== undefined && !kept.removed && kept.token_hash !== undefined && removal.token_hash !== kept.token_hash;
}

function stampAfter(member: Member, now: number): number {
  return Math.max(now, member.changed + 1);
}

/** What is kept of the net this Mac left, or undefined when there is none or it does not fit. */
function parseLeft(value: unknown, here: string): Left | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry = parseMember(raw.entry);
  if (typeof raw.net !== "string" || !/^[0-9a-f]{16}$/.test(raw.net) || !entry || entry.id !== here || !entry.removed || !Array.isArray(raw.macs)) return undefined;
  const macs = raw.macs.flatMap((mac: unknown) => {
    const { id, token_hash } = (typeof mac === "object" && mac !== null ? mac : {}) as Record<string, unknown>;
    return typeof id === "string" && memberIDPattern.test(id) && typeof token_hash === "string" && /^[0-9a-f]{64}$/.test(token_hash) ? [{ id, token_hash }] : [];
  });
  return { net: raw.net, entry, macs: macs.slice(0, mostMembers) };
}

function newNetID(): string {
  return randomBytes(8).toString("hex");
}

/**
 * A member's name as `net.rename` takes it: trimmed, one line, at most 80 characters as the
 * entries count them (UTF-16 units: one longer is dropped by every Mac's `parseMember`).
 * Throws `NetError` with a sentence, in the words of the member's kind, otherwise.
 */
export function checkedName(name: string, kind: MemberKind): string {
  const whose = kind === "mac" ? "A Mac's" : "A device's";
  const trimmed = name.trim();
  if (trimmed === "") throw new NetError(`${whose} name cannot be empty.`);
  if (/[\n\r]/.test(trimmed)) throw new NetError(`${whose} name is one line.`);
  if (trimmed.length > longestMemberName) throw new NetError(`${whose} name is at most ${longestMemberName} characters.`);
  return trimmed;
}

function fitName(name: string): string {
  const trimmed = name.trim();
  // Not in the middle of an emoji: the app's own cut counts characters, which may be longer.
  return trimmed.length > longestMemberName ? cutWhole(trimmed, longestMemberName).trimEnd() : trimmed;
}

/** What `state/net-own.json` holds (or its `.bak`, when it cannot be used); what is missing or does not fit is made anew and saved. */
function readOwn(path: string): Own {
  const read = readStateFile(path);
  const file = read.found;
  let changed = read.fromBackup;
  let token = file.token;
  if (typeof token !== "string" || !secretPattern.test(token)) {
    token = randomBytes(32).toString("base64url");
    changed = true;
  }
  let key = file.key as JsonWebKey | undefined;
  if (!isPrivateKey(key)) {
    key = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
    changed = true;
  }
  const relay = file.relay as { id?: unknown; secret?: unknown } | undefined;
  let kept = relay && typeof relay.id === "string" && relayIDPattern.test(relay.id) && typeof relay.secret === "string" && secretPattern.test(relay.secret) ? { id: relay.id, secret: relay.secret } : undefined;
  if (!kept) {
    kept = { id: randomBytes(16).toString("base64url"), secret: randomBytes(32).toString("base64url") };
    changed = true;
  }
  const own: Own = { token: token as string, key: key!, relay: kept };
  if (changed) writeJSON(path, own, { backup: true, aside: read.aside });
  return own;
}

function isPrivateKey(key: JsonWebKey | undefined): key is JsonWebKey {
  return typeof key === "object" && key !== null && key.kty === "OKP" && key.crv === "X25519" && typeof key.d === "string" && secretPattern.test(key.d) && typeof key.x === "string" && secretPattern.test(key.x);
}

/** A join link: `portals://join?v=1&url=<address>&code=<code>&name=<Mac name>`. */
export function joinLink(join: { url: string; code: string; name?: string }): string {
  const parts = [["v", "1"], ["url", join.url], ["code", join.code]];
  if (join.name) parts.push(["name", join.name]);
  return "portals://join?" + parts.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/** What a join link says. Throws `NetError` with a sentence for one that is not. */
export function parseJoinLink(text: string): { url: string; code: string; name?: string } {
  let link: URL;
  try {
    link = new URL(text.trim());
  } catch {
    throw new NetError("That is not a join link. `portals net invite` on a Mac in the net shows one; it starts with portals://join.");
  }
  if (link.protocol !== "portals:" || link.hostname !== "join") {
    throw new NetError("That is not a join link. `portals net invite` on a Mac in the net shows one; it starts with portals://join.");
  }
  if (Number(link.searchParams.get("v") ?? "1") > 1) throw new NetError("Update Portals to join this net.");
  const url = link.searchParams.get("url") ?? "";
  const code = link.searchParams.get("code") ?? "";
  if (!isAddress(url) || code === "") throw new NetError("That join link is missing the Mac's address or the code.");
  const name = link.searchParams.get("name") ?? undefined;
  return name ? { url, code, name } : { url, code };
}
