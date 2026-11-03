import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { HungUp } from "../src/gateway/call.ts";
import type { TokenLink } from "../src/fleet/links.ts";
import { JoinCodes } from "../src/net/codes.ts";
import { merge, mostEntries, mostMembers, parseMember, parseMembers, publicMember, type Member } from "../src/net/members.ts";
import { hashToken, joinLink, Net, NetError, NetRefused, parseJoinLink } from "../src/net/net.ts";
import { temporaryHome } from "./helpers.ts";
import { machineWord } from "../src/platform.ts";

// The net's rules (docs/net-plan.md, src/net/): merging two copies of the list, the join
// codes, tokens, and the copying between Macs, with stand-ins for the other Macs' bridges
// (the whole of it between real bridges is in net-bridges.test.ts).

function entry(id: string, change: Partial<Member> = {}): Member {
  return { id, kind: "device", name: id, changed: 1000, by: "mac-aaaa", ...change };
}

test("of two entries the newer wins, a tie going to the greater by, and a removal outlives an older copy", () => {
  const local = [entry("phone-111"), entry("ipad-2222", { changed: 2000 })];
  const merged = merge(local, [entry("phone-111", { name: "Phone", changed: 1500 }), entry("ipad-2222", { name: "old", changed: 1500 }), entry("mac-new1", { kind: "mac" })]);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.members.map((member) => [member.id, member.name]), [["phone-111", "Phone"], ["ipad-2222", "ipad-2222"], ["mac-new1", "mac-new1"]]);

  // The same moment: the greater `by` wins, on every Mac whichever copy it had.
  const one = entry("phone-111", { name: "one", by: "mac-bbbb" });
  const other = entry("phone-111", { name: "other", by: "mac-cccc" });
  assert.equal(merge([one], [other]).members[0].name, "other");
  assert.equal(merge([other], [one]).members[0].name, "other");
  assert.equal(merge([other], [one]).changed, false);

  // Removed while a Mac slept: its older copy brings nothing back, and it learns of the removal.
  const removed = entry("phone-111", { removed: true, changed: 3000 });
  assert.deepEqual(merge([removed], [entry("phone-111", { changed: 2500 })]).members, [removed]);
  const learned = merge([entry("phone-111", { changed: 2500 })], [removed]);
  assert.deepEqual(learned.removed, [removed]);
  assert.deepEqual(learned.members, [removed]);
  // Nothing new: nothing changed.
  assert.equal(merge([removed], [removed]).changed, false);

  // A Mac's own entry under the token it was removed with never undoes the removal, whichever is newer and whichever copy comes first.
  const out = entry("mac-bbbb", { kind: "mac", token_hash: "a".repeat(64), removed: true, changed: 3000, by: "mac-aaaa" });
  const itself = entry("mac-bbbb", { kind: "mac", token_hash: "a".repeat(64), name: "renamed", changed: 9000, by: "mac-bbbb" });
  assert.deepEqual(merge([itself], [out]).members, [out]);
  assert.deepEqual(merge([out], [itself]).members, [out]);
  // Taken in again, by the Mac that takes it in or with the new token of its net of one: back.
  const joined = { ...itself, by: "mac-cccc" };
  assert.deepEqual(merge([out], [joined]).members, [joined]);
  const fresh = { ...itself, token_hash: "b".repeat(64) };
  assert.deepEqual(merge([out], [fresh]).members, [fresh]);
});

test("a member as a device is given it carries its token's tag, not its hash: one tag per token, so the device can tell a Mac's own word under the token it was removed with", () => {
  const removed = entry("mac-bbbb", { kind: "mac", token_hash: "a".repeat(64), removed: true, changed: 3000, by: "mac-aaaa" });
  const itsOwn = entry("mac-bbbb", { kind: "mac", token_hash: "a".repeat(64), changed: 9000, by: "mac-bbbb" });
  const takenInAgain = entry("mac-bbbb", { kind: "mac", token_hash: "b".repeat(64), changed: 9000, by: "mac-bbbb" });
  const [out, own, again] = [removed, itsOwn, takenInAgain].map(publicMember);
  for (const member of [out, own, again]) {
    assert.ok(!("token_hash" in member));
    assert.match(member.token_tag ?? "", /^[0-9a-f]{16}$/);
  }
  assert.equal(out.token_tag, own.token_tag);
  assert.notEqual(out.token_tag, again.token_tag);
  // Nothing of the hash: not a piece of it.
  assert.ok(!"a".repeat(64).includes(out.token_tag!) && !"b".repeat(64).includes(again.token_tag!));
  // An entry without a hash has no tag.
  assert.ok(!("token_tag" in publicMember(entry("phone-111"))));
});

test("a merge takes every entry past the 200 a net lets in and past the 1000 a join may make, as a read does, however many; entries that do not fit are dropped", () => {
  // The 200 are the joins' to keep: a merge that left some out would never agree with the other copy.
  const full = Array.from({ length: mostMembers }, (_, index) => entry(`device-${String(index).padStart(4, "0")}`));
  const merged = merge(full, [entry("one-more-1")]);
  assert.equal(merged.members.length, mostMembers + 1);
  assert.equal(merged.changed, true);

  // Past 1000 too: every removal is kept, whichever copy merges into which, so none can come back.
  const macs = [entry("mac-0000-0001", { kind: "mac", changed: 1 })];
  const live = Array.from({ length: 500 }, (_, index) => entry(`live-${String(index).padStart(4, "0")}`, { changed: 5000 + index }));
  const gone = Array.from({ length: 600 }, (_, index) => entry(`gone-${String(index).padStart(4, "0")}`, { removed: true, changed: 1000 + index }));
  const one = merge([...macs, ...live.slice(0, 250), ...gone.slice(0, 300)], [...gone.slice(300), ...live.slice(250)]);
  const other = merge([...gone.slice(300).reverse(), ...live.slice(250)], [...live.slice(0, 250), ...gone.slice(0, 300), ...macs]);
  const ids = (members: Member[]) => members.map((member) => member.id).sort();
  assert.equal(one.members.length, mostEntries + 101);
  assert.deepEqual(ids(one.members), ids(other.members));
  assert.deepEqual(ids(one.members), ids([...macs, ...live, ...gone]), "the oldest removals are kept");
  assert.deepEqual(ids(parseMembers([...gone, ...live, ...macs])), ids(one.members), "a list read past 1000 keeps every entry");
  assert.deepEqual(one.removed, []);
  // From another Mac too, every entry, however many: Macs apart may each have made 1000.
  const many = Array.from({ length: 6001 }, (_, index) => entry(`many-${String(index).padStart(5, "0")}`));
  assert.equal(parseMembers(many).length, 6001);
  assert.equal(merge([], many).members.length, 6001);

  const mac = { id: "0123456789abcdef", kind: "mac", name: "Mini", url: "https://mini.tail.ts.net:10010", key: "A".repeat(43), relay: "B".repeat(22), token_hash: "c".repeat(64), changed: 5, by: "0123456789abcdef" };
  assert.deepEqual(parseMember(mac), mac);
  for (const bad of [
    { ...mac, id: "short" },
    { ...mac, id: "has a space" },
    { ...mac, kind: "phone" },
    { ...mac, name: "x".repeat(81) },
    { ...mac, name: " " },
    { ...mac, url: "ftp://mini" },
    { ...mac, key: "too-short" },
    { ...mac, relay: "B".repeat(23) },
    { ...mac, token_hash: "C".repeat(64) },
    { ...mac, changed: 0 },
    { ...mac, by: "?" },
    { ...mac, removed: "yes" },
    { ...entry("phone-111"), platform: "android" },
    null,
    "text",
  ]) {
    assert.equal(parseMember(bad), undefined, JSON.stringify(bad));
  }
  // An id once, the first; the rest of the list kept.
  assert.deepEqual(parseMembers([entry("phone-111"), { id: 1 }, entry("phone-111", { name: "again" }), entry("ipad-2222")]).map((member) => member.name), ["phone-111", "ipad-2222"]);
  assert.deepEqual(parseMembers("no list"), []);
});

test("a join code works once, for ten minutes, in the net it was made in; twenty at most are open; ten wrong ones a minute and every code is refused", () => {
  let now = 1_000_000;
  const codes = new JoinCodes({ now: () => now });
  const { code, expiresAt } = codes.issue("aaaa0000aaaa0000");
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(expiresAt, now + 10 * 60_000);
  assert.equal(codes.check(code, "aaaa0000aaaa0000"), "valid");
  assert.equal(codes.take(code), true);
  assert.equal(codes.take(code), false);
  assert.equal(codes.check(code, "aaaa0000aaaa0000"), "wrong");

  const late = codes.issue("aaaa0000aaaa0000").code;
  now += 10 * 60_000;
  assert.equal(codes.check(late, "aaaa0000aaaa0000"), "wrong");
  assert.equal(codes.take(late), false);

  const first = codes.issue("aaaa0000aaaa0000").code;
  for (let count = 1; count < 20; count += 1) codes.issue("aaaa0000aaaa0000");
  assert.equal(codes.open, 20);
  const newest = codes.issue("aaaa0000aaaa0000").code;
  assert.equal(codes.open, 20);
  assert.equal(codes.take(first), false, "the oldest goes");
  assert.equal(codes.check(newest, "aaaa0000aaaa0000"), "valid");

  // Ten wrong codes within a minute (the expired one above, and nine more) and the limit is reached, for a valid code too.
  for (let count = 0; count < 9; count += 1) assert.equal(codes.check("guess", "aaaa0000aaaa0000"), "wrong");
  assert.equal(codes.check(newest, "aaaa0000aaaa0000"), "limited");
  assert.equal(codes.check(undefined, "aaaa0000aaaa0000"), "limited");
  now += 60_000;
  assert.equal(codes.check(newest, "aaaa0000aaaa0000"), "valid");

  // A code lets in to the net it was made in only, and none is left once the Mac moves.
  assert.equal(codes.check(newest, "bbbb0000bbbb0000"), "wrong");
  codes.clear();
  assert.equal(codes.open, 0);
  assert.equal(codes.check(newest, "aaaa0000aaaa0000"), "wrong");
});

test("a join link is read as it is written; a newer one asks for an update", () => {
  const link = joinLink({ url: "https://mini.tail.ts.net:10010", code: "abc_DEF-123", name: "Dana’s Mac mini" });
  assert.equal(link, "portals://join?v=1&url=https%3A%2F%2Fmini.tail.ts.net%3A10010&code=abc_DEF-123&name=Dana%E2%80%99s%20Mac%20mini");
  assert.deepEqual(parseJoinLink(` ${link}\n`), { url: "https://mini.tail.ts.net:10010", code: "abc_DEF-123", name: "Dana’s Mac mini" });
  assert.throws(() => parseJoinLink(link.replace("v=1", "v=2")), { message: "Update Portals to join this net." });
  for (const bad of ["mini", "portals://pair?v=1&url=x", "portals://join?v=1&code=abc", "portals://join?v=1&url=https%3A%2F%2Fmini"]) {
    assert.throws(() => parseJoinLink(bad), NetError, bad);
  }
});

/**
 * Bridges' nets wired to each other in memory: a call opens with the caller's token,
 * which the other looks up as its bridge would at a WebSocket's upgrade. A Mac `down`
 * does not answer.
 */
class Network {
  readonly nets = new Map<string, Net>();
  readonly down = new Set<string>();
  /** Calls made, and those under way. */
  calls = 0;
  private flying = 0;

  readonly call = async (link: TokenLink, method: string, params: Record<string, unknown>): Promise<unknown> => {
    this.calls += 1;
    this.flying += 1;
    try {
      await sleep(1);
      const target = this.nets.get(link.url);
      if (!target || this.down.has(link.url)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      const member = await target.authenticate(link.token);
      if (!member) throw new HungUp(4401);
      assert.equal(method, "net.sync");
      return structuredClone(target.receive(member, params.net as string, params.members));
    } finally {
      this.flying -= 1;
    }
  };

  readonly fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    const target = this.nets.get(new URL(url).origin);
    if (!target) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    try {
      return Response.json(structuredClone(target.join(JSON.parse(init.body as string))));
    } catch (error) {
      if (!(error instanceof NetRefused)) throw error;
      return Response.json({ detail: error.message }, { status: error.status });
    }
  }) as typeof fetch;

  /** Until no call has been under way for a few turns of the loop. */
  async settled(): Promise<void> {
    for (let quiet = 0; quiet < 5; quiet += this.flying === 0 ? 1 : -quiet) await sleep(2);
  }
}

interface Mac {
  net: Net;
  url: string;
  home: string;
  id: string;
  removed: string[][];
  retokened: string[][];
  /** The names it was told it goes by (`NetListener.renamed`). */
  renamed: string[];
}

function mac(
  t: TestContext,
  network: Network,
  name: string,
  options: { home?: string; now?: () => number; id?: string; url?: string; syncEveryMs?: number; call?: Network["call"]; fetch?: typeof fetch } = {},
): Mac {
  const home = options.home ?? temporaryHome();
  const id = options.id ?? `${name.toLowerCase()}00000000000`.slice(0, 16);
  const url = options.url ?? `http://${name.toLowerCase()}.test:9120`;
  const net = new Net({ path: join(home, "net.json"), ownPath: join(home, "net-own.json"), here: { id, name }, call: options.call ?? network.call, fetch: options.fetch ?? network.fetch, now: options.now, syncEveryMs: options.syncEveryMs });
  const made: Mac = { net, url, home, id, removed: [], retokened: [], renamed: [] };
  net.listener = {
    removed: (members) => made.removed.push(members.map((member) => member.id)),
    retokened: (members) => made.retokened.push(members.map((member) => member.id)),
    renamed: (name) => made.renamed.push(name),
  };
  network.nets.set(url, net);
  net.start(url);
  t.after(() => {
    net.close();
    if (!options.home) rmSync(home, { recursive: true, force: true });
  });
  return made;
}

function joinDevice(at: Mac, id = "phone-1234-5678", name = "iPhone"): { token: string; member: Member } {
  const answer = at.net.join({ code: at.net.invite().code, member: { id, kind: "device", name, platform: "ios" } }) as { token: string; member: Member };
  return answer;
}

test("a bridge with no files makes a net of one, owner only, with its key pair and relay id, and keeps them", async (t) => {
  const network = new Network();
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = mac(t, network, "Alpha", { home });
  const saved = JSON.parse(readFileSync(join(home, "net.json"), "utf8"));
  const own = JSON.parse(readFileSync(join(home, "net-own.json"), "utf8"));
  assert.equal(statSync(join(home, "net.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, "net-own.json")).mode & 0o777, 0o600);
  assert.match(saved.net, /^[0-9a-f]{16}$/);
  assert.equal(saved.revision, 1);
  assert.equal(saved.members.length, 1);
  const self = saved.members[0];
  assert.deepEqual({ ...self, changed: 0 }, { id: first.id, kind: "mac", name: "Alpha", url: first.url, key: own.key.x, relay: own.relay.id, token_hash: hashToken(own.token), changed: 0, by: first.id });
  // The key pair is X25519's, its public half the entry's key.
  const key = createPrivateKey({ key: own.key, format: "jwk" });
  assert.equal(key.asymmetricKeyType, "x25519");
  assert.equal(createPublicKey(key).export({ format: "jwk" }).x, self.key);
  assert.equal(Buffer.from(self.key, "base64url").length, 32);
  assert.equal(Buffer.from(own.relay.id, "base64url").length, 16);
  assert.equal(Buffer.from(own.relay.secret, "base64url").length, 32);
  assert.equal(Buffer.from(own.token, "base64url").length, 32);
  // The list a device is given has no token hashes.
  assert.deepEqual(first.net.list(null).members.map((member) => Object.keys(member).includes("token_hash")), [false]);
  first.net.close();

  // Started again, as it was: nothing to write.
  network.nets.clear();
  const again = mac(t, network, "Alpha", { home });
  assert.deepEqual(again.net.revision(), { id: saved.net, revision: 1 });
  assert.equal(again.net.token(), own.token);
  again.net.close();
  // Its name changed: its entry is written again, with the same key, relay id and token.
  network.nets.clear();
  const renamed = new Net({ path: join(home, "net.json"), ownPath: join(home, "net-own.json"), here: { id: first.id, name: "Alpha Two" }, call: network.call });
  renamed.start(first.url);
  t.after(() => renamed.close());
  assert.deepEqual(renamed.revision(), { id: saved.net, revision: 2 });
  assert.deepEqual(renamed.list(null).members.map((member) => [member.name, member.key, member.relay]), [["Alpha Two", self.key, self.relay]]);
});

test("a device's token is looked up by its hash; a removed device's is refused, and a token nobody knows is asked about at most every 30 seconds", async (t) => {
  let now = 10_000_000;
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { now: () => now });
  const beta = mac(t, network, "Beta", { now: () => now });
  // Beta joins Alpha's net, as `net.join_with` does.
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  assert.equal(beta.net.revision().id, alpha.net.revision().id);

  // Beta is asleep while a device joins through Alpha: it learns of the device when the device comes.
  network.down.add(beta.url);
  const device = joinDevice(alpha);
  await network.settled();
  network.down.delete(beta.url);
  assert.equal(beta.net.list(null).members.some((member) => member.id === device.member.id), false);
  const calls = network.calls;
  const [one, two] = await Promise.all([beta.net.authenticate(device.token), beta.net.authenticate(device.token)]);
  assert.deepEqual(one, { kind: "member", id: "phone-1234-5678", member: "device", removed: false });
  assert.deepEqual(two, one);
  assert.equal(network.calls - calls, 1, "the callers waited for one round of asking");
  await network.settled();

  // A token nobody knows: asked about once, then not again for 30 seconds.
  now += 30_000;
  const unknown = "x".repeat(43);
  const before = network.calls;
  assert.equal(await beta.net.authenticate(unknown), undefined);
  await network.settled();
  const asked = network.calls;
  assert.ok(asked > before);
  assert.equal(await beta.net.authenticate(unknown), undefined);
  assert.equal(network.calls, asked);
  now += 30_000;
  assert.equal(await beta.net.authenticate(unknown), undefined);
  assert.ok(network.calls > asked);
  // What is no token at all is not asked about.
  await network.settled();
  const quiet = network.calls;
  assert.equal(await beta.net.authenticate("not a token"), undefined);
  assert.equal(network.calls, quiet);

  // A removal on Beta reaches Alpha: the token is refused on both, and both are told.
  now += 1000;
  beta.net.remove(device.member.id, beta.id);
  await network.settled();
  // Known as removed: refused at once, with no Mac asked.
  now += 30_000;
  const asking = network.calls;
  assert.equal(await alpha.net.authenticate(device.token), undefined);
  assert.equal(await beta.net.authenticate(device.token), undefined);
  assert.equal(network.calls, asking);
  assert.deepEqual(alpha.removed.at(-1), [device.member.id]);
  assert.deepEqual(beta.removed.at(-1), [device.member.id]);
  // Joining again un-removes it, with a new token.
  now += 1000;
  const back = joinDevice(alpha);
  await network.settled();
  assert.notEqual(back.token, device.token);
  assert.equal((await beta.net.authenticate(back.token))?.id, device.member.id);
});

test("a Mac joins with its devices; one in a net with other Macs is refused until it leaves; a removed Mac starts a net of its own", async (t) => {
  let now = 20_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { now: clock });
  const beta = mac(t, network, "Beta", { now: clock });
  const gamma = mac(t, network, "Gamma", { now: clock });
  const delta = mac(t, network, "Delta", { now: clock });
  // Gamma has a device of its own before it joins.
  const tablet = joinDevice(gamma, "ipad-0000-1111", "iPad");
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(beta.net.invite().link);
  await network.settled();
  for (const one of [alpha, beta, gamma]) {
    assert.deepEqual(one.net.macs().map((other) => other.id).sort(), [alpha, beta, gamma].filter((other) => other !== one).map((other) => other.id).sort());
    assert.equal(one.net.revision().id, alpha.net.revision().id);
  }
  assert.equal((await alpha.net.authenticate(tablet.token))?.id, "ipad-0000-1111");

  // Delta joins Gamma, Gamma being in a net with others: refused, and the code is still good.
  const link = delta.net.invite().link;
  await assert.rejects(gamma.net.joinWith(link), { message: "This Mac is in a net with other Macs. Run `portals net leave` on it first." });
  assert.equal(gamma.net.revision().id, alpha.net.revision().id);
  // Wrong codes are refused with a sentence.
  await assert.rejects(gamma.net.joinWith(link.replace(/code=[^&]+/, "code=wrong")), { message: /^Could not join: This join code is used, expired or wrong/ });

  // Removed on Alpha, Beta learns it and starts a net of its own: a new net id and token, the same key and relay id.
  const { key, relay } = beta.net.list(null).members.find((member) => member.id === beta.id)!;
  const token = beta.net.token();
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  assert.notEqual(beta.net.revision().id, alpha.net.revision().id);
  assert.notEqual(beta.net.token(), token);
  assert.deepEqual(beta.net.list(null).members.map((member) => [member.id, member.key, member.relay]), [[beta.id, key, relay]]);
  assert.deepEqual(beta.removed.at(-1)?.sort(), [alpha.id, gamma.id, "ipad-0000-1111"].sort());
  assert.deepEqual(gamma.net.macs().map((other) => other.id), [alpha.id]);
  assert.throws(() => alpha.net.remove(alpha.id, alpha.id), { message: "A Mac cannot remove itself: run `portals net leave` on it." });

  // Gamma leaves: the others are told, and it is a net of one.
  await gamma.net.leave();
  await network.settled();
  assert.deepEqual(alpha.net.macs(), []);
  assert.equal(alpha.net.list(null).members.find((member) => member.id === gamma.id)?.removed, true);
  assert.deepEqual(gamma.net.list(null).members.map((member) => member.id), [gamma.id]);
  // Now alone, Gamma may join Delta.
  await gamma.net.joinWith(delta.net.invite().link);
  await network.settled();
  assert.deepEqual(delta.net.macs().map((other) => other.id), [gamma.id]);
});

test("/net/join refuses a body it cannot use, a Mac's own code, and an id of the other kind", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const code = () => alpha.net.invite().code;
  const refused = (body: Record<string, unknown> | undefined) => {
    try {
      alpha.net.join(body);
    } catch (error) {
      if (error instanceof NetRefused) return [error.status, error.message];
      throw error;
    }
    return [200];
  };
  assert.deepEqual(refused(undefined), [400, "The request must be a JSON object."]);
  assert.deepEqual(refused({ code: code() }), [400, "Say who is joining: member."]);
  assert.equal(refused({ code: code(), member: { id: "x", kind: "device", name: "Phone" } })[0], 400);
  assert.equal(refused({ code: code(), member: { kind: "mac", id: "macmacmacmac", name: "Mac" } })[0], 400);
  const own = JSON.parse(readFileSync(join(alpha.home, "net.json"), "utf8")).members[0];
  assert.deepEqual(refused({ code: code(), member: own, members: [own] }), [409, `This is the ${machineWord()} that made the code.`]);
  joinDevice(alpha, "same-id-0000");
  assert.deepEqual(refused({ code: code(), member: { ...own, id: "same-id-0000" }, members: [] }), [409, "That id is a device's in this net."]);
  assert.equal(refused({ code: "nope", member: { id: "phone-0000", kind: "device", name: "Phone" } })[0], 401);
});

/** What `/net/join` answers a device joining at `at` with `code`: 200, or the status it was refused with. */
function joinStatus(at: Mac, code: string, id = "phone-late-0001"): number {
  try {
    at.net.join({ code, member: { id, kind: "device", name: "iPhone", platform: "ios" } });
    return 200;
  } catch (error) {
    if (error instanceof NetRefused) return error.status;
    throw error;
  }
}

test("a join code lets in to the net it was made in: joining another net, leaving or being removed drops every open code", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  // Made while Alpha is alone, then Alpha joins Beta's net.
  const alone = alpha.net.invite().code;
  await alpha.net.joinWith(beta.net.invite().link);
  await network.settled();
  assert.equal(alpha.net.revision().id, beta.net.revision().id);
  assert.equal(joinStatus(alpha, alone), 401);
  assert.equal(alpha.net.list(null).members.some((member) => member.id === "phone-late-0001"), false);

  const leaving = alpha.net.invite().code;
  await alpha.net.leave();
  await network.settled();
  assert.equal(joinStatus(alpha, leaving), 401);

  await alpha.net.joinWith(beta.net.invite().link);
  await network.settled();
  const removing = alpha.net.invite().code;
  beta.net.remove(alpha.id, beta.id);
  await network.settled();
  assert.notEqual(alpha.net.revision().id, beta.net.revision().id);
  assert.equal(joinStatus(alpha, removing), 401);
  // A code of the net it is in now works.
  assert.equal(joinStatus(alpha, alpha.net.invite().code), 200);
});

test("a device or a Mac removed on a Mac whose clock is ahead and joined again through one whose clock is behind stays in", async (t) => {
  let now = 30_000_000;
  const network = new Network();
  // Alpha's clock is an hour ahead of the others'.
  const alpha = mac(t, network, "Alpha", { now: () => now + 3_600_000 });
  const beta = mac(t, network, "Beta", { now: () => now });
  const gamma = mac(t, network, "Gamma", { now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(alpha.net.invite().link);
  await network.settled();

  const device = joinDevice(alpha);
  await network.settled();
  alpha.net.remove(device.member.id, alpha.id);
  alpha.net.remove(gamma.id, alpha.id);
  await network.settled();
  assert.notEqual(gamma.net.revision().id, alpha.net.revision().id, "Gamma learnt it was removed");

  now += 1000;
  const back = joinDevice(beta);
  await gamma.net.joinWith(beta.net.invite().link);
  await network.settled();
  for (const one of [alpha, beta, gamma]) {
    assert.equal((await one.net.authenticate(back.token))?.id, device.member.id);
    assert.equal(one.net.revision().id, alpha.net.revision().id);
  }
  assert.ok(alpha.net.macs().some((other) => other.id === gamma.id), "Gamma is in again on Alpha");
  assert.equal(alpha.net.list(null).members.find((member) => member.id === device.member.id)?.removed, undefined);
});

test("a Mac whose devices would take the net past 200 is refused whole, before its code is used; removed members are not counted", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const gamma = mac(t, network, "Gamma");
  // Gamma alone with 199 devices: with Alpha and Gamma that is 201.
  for (let index = 0; index < mostMembers - 1; index += 1) joinDevice(gamma, `device-${String(index).padStart(4, "0")}`);
  const link = alpha.net.invite().link;
  await assert.rejects(gamma.net.joinWith(link), { message: `This net is full: with this ${machineWord()} and its devices it would have 201 members, and it takes 200.` });
  assert.equal(alpha.net.list(null).members.length, 1, "nothing of Gamma's was taken in");
  assert.notEqual(gamma.net.revision().id, alpha.net.revision().id);

  // One of its devices removed, it fits: 200, and the removed one comes along without counting.
  gamma.net.remove("device-0000", gamma.id);
  await gamma.net.joinWith(link);
  await network.settled();
  assert.equal(gamma.net.revision().id, alpha.net.revision().id, "the same code still worked");
  const listed = alpha.net.list(null).members;
  assert.equal(listed.filter((member) => !member.removed).length, mostMembers);
  assert.ok(listed.some((member) => member.id === gamma.id && !member.removed));
  assert.equal(joinStatus(alpha, alpha.net.invite().code), 409, "full now");
});

test("two Macs that each let a device in while apart, at 199, both keep both and refuse the next", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  for (let index = 0; index < mostMembers - 3; index += 1) joinDevice(alpha, `device-${String(index).padStart(4, "0")}`);
  await network.settled();
  assert.equal(beta.net.list(null).members.length, mostMembers - 1);

  // Apart, each lets one more in: 200 on each.
  network.down.add(alpha.url);
  network.down.add(beta.url);
  const onAlpha = joinDevice(alpha, "phone-alpha-0001");
  const onBeta = joinDevice(beta, "phone-beta-00001");
  await network.settled();
  network.down.clear();
  // Each asks the other about the token it does not know, which copies the lists both ways.
  assert.equal((await alpha.net.authenticate(onBeta.token))?.id, "phone-beta-00001");
  await network.settled();
  for (const one of [alpha, beta]) {
    assert.equal(one.net.list(null).members.length, mostMembers + 1);
    assert.equal((await one.net.authenticate(onAlpha.token))?.id, "phone-alpha-0001");
    assert.equal((await one.net.authenticate(onBeta.token))?.id, "phone-beta-00001");
    assert.equal(joinStatus(one, one.net.invite().code, "phone-next-0001"), 409);
  }
});

test("removals are kept past 1000 entries, merged, saved and read again, so a Mac that slept through one never brings the token back", async (t) => {
  const network = new Network();
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const alpha = mac(t, network, "Alpha", { home });
  const beta = mac(t, network, "Beta");
  const gamma = mac(t, network, "Gamma");
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(alpha.net.invite().link);
  const device = joinDevice(alpha);
  await network.settled();
  // Beta sleeps with the device in its copy, and Alpha removes it.
  network.down.add(beta.url);
  alpha.net.remove(device.member.id, alpha.id);
  await network.settled();
  network.down.add(gamma.url);
  // Gamma's copy brings 1100 newer removals: the device's is now the oldest of 1104 entries.
  const later = Date.now() + 60_000;
  const gone = Array.from({ length: 1100 }, (_, index) => entry(`gone-${String(index).padStart(5, "0")}`, { removed: true, changed: later + index, by: gamma.id }));
  alpha.net.receive({ kind: "member", id: gamma.id, member: "mac", removed: false }, alpha.net.revision().id, gone);
  await network.settled();
  assert.equal(alpha.net.list(null).members.length, 1104, "every entry is kept");
  assert.equal(alpha.net.list(null).members.find((member) => member.id === device.member.id)?.removed, true);

  // Alpha starts again from its file, then Beta wakes and gives it its copy, the device in it.
  alpha.net.close();
  network.nets.delete(alpha.url);
  const again = mac(t, network, "Alpha", { home });
  assert.equal(again.net.list(null).members.length, 1104, "every entry is read again");
  network.down.delete(beta.url);
  await beta.net.authenticate("y".repeat(43));
  await network.settled();
  assert.equal(await again.net.authenticate(device.token), undefined, "the removed device's token stays refused");
  assert.equal(again.net.list(null).members.find((member) => member.id === device.member.id)?.removed, true);
  assert.equal(beta.net.list(null).members.find((member) => member.id === device.member.id)?.removed, true, "Beta learns it");
});

test("a join that would take the list past 1000 entries, removed ones included, is refused whole before its code is used; every entry let in is kept", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  // 997 Macs removed long ago: with Alpha and Beta, 999 entries.
  const removedMacs = Array.from({ length: mostEntries - 3 }, (_, index) => entry(`mac-gone-${String(index).padStart(5, "0")}`, { kind: "mac", removed: true, changed: 1000 + index, by: alpha.id }));
  alpha.net.receive({ kind: "member", id: beta.id, member: "mac", removed: false }, alpha.net.revision().id, removedMacs);
  await network.settled();
  assert.equal(alpha.net.list(null).members.length, mostEntries - 1);

  // One device fits, and is kept: its token works.
  const device = joinDevice(alpha);
  assert.equal(alpha.net.list(null).members.length, mostEntries);
  assert.equal((await alpha.net.authenticate(device.token))?.id, device.member.id);

  // The next is refused, its code still good, and nothing changes.
  const code = alpha.net.invite().code;
  const revision = alpha.net.revision();
  assert.throws(() => alpha.net.join({ code, member: { id: "phone-next-0001", kind: "device", name: "iPhone", platform: "ios" } }), {
    status: 409,
    message: `This net is full: its list keeps ${mostEntries} entries, removed members included.`,
  });
  assert.deepEqual(alpha.net.revision(), revision);
  assert.equal((await alpha.net.authenticate(device.token))?.id, device.member.id);
  // A device joining again replaces its entry: no entry more, so it is not refused.
  assert.equal(joinStatus(alpha, code, device.member.id), 200);

  // A Mac with a device is refused whole: neither the Mac nor its device is taken in.
  const gamma = mac(t, network, "Gamma");
  joinDevice(gamma, "phone-gamma-0001");
  await assert.rejects(gamma.net.joinWith(alpha.net.invite().link), {
    message: `This net is full: with this ${machineWord()} and its devices its list would have ${mostEntries + 2} entries, removed members included, and it keeps ${mostEntries}.`,
  });
  assert.notEqual(gamma.net.revision().id, alpha.net.revision().id);
  assert.equal(alpha.net.list(null).members.length, mostEntries);
  assert.ok(!alpha.net.list(null).members.some((member) => member.id === gamma.id || member.id === "phone-gamma-0001"));
});

test("a list merged past 5000 entries, as six Macs apart may make, is still copied whole both ways, so a removal on it reaches every Mac", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  const device = joinDevice(alpha, "phone-past-5000", "Phone");
  await network.settled();
  assert.equal((await beta.net.authenticate(device.token))?.id, "phone-past-5000");

  // A history from Macs that were apart, every entry of it valid: 6000 removed devices.
  const history = Array.from({ length: 6000 }, (_, index) => entry(`gone-${String(index).padStart(5, "0")}`, { removed: true, changed: 2000 }));
  const fromBeta = (await alpha.net.authenticate(beta.net.token()))!;
  alpha.net.receive(fromBeta, alpha.net.list(null).net, history);
  await network.settled();
  assert.ok(alpha.net.list(null).members.length > 6000);

  // A removal on it is copied, the whole list with it, as any other.
  alpha.net.remove(device.member.id, alpha.id);
  await network.settled();
  assert.ok(beta.net.list(null).members.length > 6000, "the copy reached the other Mac whole");
  assert.equal(await alpha.net.authenticate(device.token), undefined);
  assert.equal(await beta.net.authenticate(device.token), undefined);
});

test("a Mac removed while it was off learns it from the others as it starts, and is answered without being heard", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beta = mac(t, network, "Beta", { home });
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  beta.net.close();
  network.down.add(beta.url);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  const listed = alpha.net.list(null);

  // Beta starts again, still taking itself to be in the net, and asks Alpha.
  network.down.delete(beta.url);
  network.nets.delete(beta.url);
  const again = mac(t, network, "Beta", { home });
  assert.equal(again.net.revision().id, listed.net);
  await network.settled();
  assert.notEqual(again.net.revision().id, listed.net);
  assert.deepEqual(again.net.macs(), []);
  // Alpha took nothing from it.
  assert.deepEqual(alpha.net.list(null), listed);
});

test("a Mac removed while it was off, which comes back with a new name and address, learns it is out, and a Mac that missed the removal does not bring it back", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const gamma = mac(t, network, "Gamma");
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beta = mac(t, network, "Beta", { home });
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(alpha.net.invite().link);
  await network.settled();
  // Beta stops, Gamma sleeps through Beta's removal on Alpha.
  beta.net.close();
  network.down.add(beta.url);
  network.down.add(gamma.url);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  const listed = alpha.net.list(null);

  // Beta starts again as "Beta Two" at another address, writing its entry anew, with Gamma awake.
  network.down.delete(gamma.url);
  network.nets.delete(beta.url);
  const again = mac(t, network, "Beta Two", { home, id: beta.id, url: "http://beta-two.test:9200" });
  await network.settled();
  assert.notEqual(again.net.revision().id, listed.net);
  assert.deepEqual(again.net.macs(), []);
  assert.deepEqual(again.removed.at(-1)?.sort(), [alpha.id, gamma.id].sort());
  // Alpha took nothing from it; Gamma, whatever it took from Beta, has it removed after asking Alpha, and keeps it so.
  assert.deepEqual(alpha.net.list(null), listed);
  await gamma.net.authenticate("y".repeat(43));
  await network.settled();
  assert.equal(gamma.net.list(null).members.find((member) => member.id === beta.id)?.removed, true);
  assert.deepEqual(gamma.net.macs().map((other) => other.id), [alpha.id]);
  assert.equal(alpha.net.list(null).members.find((member) => member.id === beta.id)?.removed, true);
});

test("a removed Mac's token is answered with its own entry alone", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  joinDevice(alpha);
  await network.settled();
  const token = beta.net.token();
  network.down.add(beta.url);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  const signedIn = await alpha.net.authenticate(token);
  assert.deepEqual(signedIn, { kind: "member", id: beta.id, member: "mac", removed: true });
  const answer = alpha.net.receive(signedIn!, alpha.net.revision().id, []);
  assert.deepEqual(answer.members.map((member) => [member.id, member.removed]), [[beta.id, true]]);
});

test("a Mac asleep while another leaves learns it when it wakes, also after the one that left started again", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { syncEveryMs: 20 });
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beta = mac(t, network, "Beta", { home });
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  const old = alpha.net.revision().id;

  network.down.add(alpha.url);
  await beta.net.leave();
  await network.settled();
  assert.notEqual(beta.net.revision().id, old);
  // Leaving again, alone, keeps what it kept of the net it left.
  await beta.net.leave();
  beta.net.close();
  network.nets.delete(beta.url);
  const again = mac(t, network, "Beta", { home });
  await network.settled();

  // Alpha wakes and asks Beta, as it does every so often: Beta is out of its net.
  network.down.delete(alpha.url);
  for (let tries = 0; tries < 100 && alpha.net.macs().length > 0; tries += 1) await sleep(5);
  assert.deepEqual(alpha.net.macs(), []);
  assert.equal(alpha.net.list(null).members.find((member) => member.id === beta.id)?.removed, true);
  assert.deepEqual(alpha.removed.at(-1), [beta.id]);
  // Beta took nothing from it.
  assert.deepEqual(again.net.list(null).members.map((member) => member.id), [beta.id]);
});

test("a net.json or net-own.json that cannot be used is taken from its .bak, past the revision it lost; with neither, both are kept aside", async (t) => {
  const network = new Network();
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const alpha = mac(t, network, "Alpha", { home });
  const device = joinDevice(alpha);
  // The .bak is a save behind: what the last save added is lost with it.
  joinDevice(alpha, "ipad-0000-1111", "iPad");
  const { id, revision } = alpha.net.revision();
  const token = alpha.net.token();
  alpha.net.close();

  // A power cut left both files empty (net-own.json, written at a net's start, as if it had a .bak too).
  copyFileSync(join(home, "net-own.json"), join(home, "net-own.json.bak"));
  writeFileSync(join(home, "net.json"), "");
  writeFileSync(join(home, "net-own.json"), "");
  network.nets.clear();
  const again = mac(t, network, "Alpha", { home });
  assert.equal(again.net.revision().id, id);
  assert.ok(again.net.revision().revision > revision);
  assert.equal(again.net.token(), token);
  assert.equal((await again.net.authenticate(device.token))?.id, device.member.id);
  assert.deepEqual(readdirSync(home).filter((name) => name.includes(".corrupt-")).map((name) => name.split(".corrupt-")[0]).sort(), ["net-own.json", "net.json"]);
  again.net.close();

  // Neither the file nor its .bak can be used: both are kept aside, not written over, and the Mac is in a net of its own.
  writeFileSync(join(home, "net.json"), "{");
  writeFileSync(join(home, "net.json.bak"), "");
  network.nets.clear();
  const alone = mac(t, network, "Alpha", { home });
  assert.notEqual(alone.net.revision().id, id);
  assert.equal(readdirSync(home).filter((name) => name.startsWith("net.json") && name.includes(".corrupt-")).length, 3);
});

test("a Mac told at once that a device and it are removed lets go of the device too, its connections and notifications", async (t) => {
  const network = new Network();
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  const phone = joinDevice(beta);
  await network.settled();
  assert.equal((await alpha.net.authenticate(phone.token))?.id, phone.member.id);

  // Beta does not answer while the phone is removed on Alpha; it does by the time it is removed itself.
  network.down.add(beta.url);
  alpha.net.remove(phone.member.id, alpha.id);
  await network.settled();
  network.down.delete(beta.url);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();

  // Beta is a net of its own now, and has let go of the phone with Alpha.
  assert.deepEqual(beta.net.macs(), []);
  assert.deepEqual(beta.removed.flat().sort(), [alpha.id, phone.member.id].sort());
});

test("a device that joins or is removed on a Mac while that Mac's own join to another net is under way is so in that net", async (t) => {
  const network = new Network();
  // Beta's join waits on Alpha's answer while a phone joins Beta.
  let joining: (() => void) | undefined;
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      const answer = await answered(url, init);
      joining?.();
      return answer;
    }) as typeof fetch,
  });
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  const tablet = joinDevice(beta, "ipad-0000-1111", "iPad");
  let phone: { token: string; member: Member } | undefined;
  joining = () => {
    phone = joinDevice(beta);
    beta.net.remove(tablet.member.id, beta.id);
  };
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();

  // The phone joined Beta before Beta took Alpha's answer: it is in the net Beta is in now, on both Macs.
  assert.equal(beta.net.revision().id, alpha.net.revision().id);
  assert.equal((await beta.net.authenticate(phone!.token))?.id, phone!.member.id);
  assert.equal((await alpha.net.authenticate(phone!.token))?.id, phone!.member.id);
  // The iPad removed meanwhile stays removed: Alpha's answer, from before, does not bring it back.
  assert.equal(await beta.net.authenticate(tablet.token), undefined);
  assert.equal(await alpha.net.authenticate(tablet.token), undefined);
  assert.deepEqual(beta.removed, [[tablet.member.id]]);
});

test("a Mac whose own join is under way refuses another, and a Mac joining it, so no other net's devices come along with it", async (t) => {
  const network = new Network();
  // Delta's answer waits until the rest was tried.
  let release: (() => void) | undefined;
  const held = new Promise<void>((done) => (release = done));
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      if (new URL(url).hostname === "delta.test") await held;
      return answered(url, init);
    }) as typeof fetch,
  });
  const alpha = mac(t, network, "Alpha");
  const delta = mac(t, network, "Delta");
  const beta = mac(t, network, "Beta");
  const phone = joinDevice(alpha);
  const toDelta = beta.net.joinWith(delta.net.invite().link);
  // A second join of Beta's own, which would bring Alpha's phone along into Delta's net.
  await assert.rejects(beta.net.joinWith(alpha.net.invite().link), { message: "This Mac is already joining a net. Try again once that is done." });
  // Alpha joining Beta, which would do the same; its code is still good after.
  const code = beta.net.invite().link;
  await assert.rejects(alpha.net.joinWith(code), { message: "This Mac is joining another net. Try again in a moment." });
  release!();
  await toDelta;
  await network.settled();

  assert.equal(beta.net.revision().id, delta.net.revision().id);
  assert.equal(await delta.net.authenticate(phone.token), undefined);
  assert.equal(await beta.net.authenticate(phone.token), undefined);
  assert.equal(delta.net.list(null).members.some((member) => member.id === phone.member.id), false);
});

test("a Mac taken in by one whose clock is ahead, which starts again at another address, is listed at its new address", async (t) => {
  let now = 30_000_000;
  const network = new Network();
  // Alpha's clock is ten minutes ahead of Beta's: Beta's entry, made by Alpha, is stamped in Beta's future.
  const alpha = mac(t, network, "Alpha", { now: () => now + 600_000 });
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beta = mac(t, network, "Beta", { home, now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();

  // A minute later Beta starts again at another address, and writes its entry anew.
  now += 60_000;
  beta.net.close();
  network.nets.delete(beta.url);
  const again = mac(t, network, "Beta", { home, id: beta.id, url: "http://beta-moved.test:9200", now: () => now });
  await network.settled();
  assert.equal(again.net.revision().id, alpha.net.revision().id);
  assert.deepEqual(alpha.net.macs().map((other) => other.url), ["http://beta-moved.test:9200"], "Alpha lists Beta where it is now");
});

test("a Mac whose own join is under way does not leave its net until it is answered, which would undo the leave", async (t) => {
  const network = new Network();
  let release: (() => void) | undefined;
  const held = new Promise<void>((done) => (release = done));
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      const answer = await answered(url, init);
      await held;
      return answer;
    }) as typeof fetch,
  });
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  // Alpha has taken Beta in; its answer is held while Beta is asked to leave.
  const joining = beta.net.joinWith(alpha.net.invite().link);
  await sleep(5);
  await assert.rejects(beta.net.leave(), { message: "This Mac is joining a net. Leave it once that is done." });
  release!();
  await joining;
  await network.settled();
  // In Alpha's net, with the token Alpha took in.
  assert.equal(beta.net.revision().id, alpha.net.revision().id);
  assert.deepEqual(alpha.net.macs().map((other) => other.id), [beta.id]);
  assert.deepEqual(beta.net.macs().map((other) => other.id), [alpha.id]);
});

test("a Mac joining a net brings no removal of one of its members that the net has in again with another token", async (t) => {
  let now = 40_000_000;
  const network = new Network();
  const beta = mac(t, network, "Beta", { now: () => now });
  const delta = mac(t, network, "Delta", { now: () => now });
  // The phone was in Beta's net, and went into Delta's with no word to Beta (as the app switches nets).
  joinDevice(beta);
  now += 1000;
  const phone = joinDevice(delta);
  // Beta still lists it, and it is removed there, later.
  now += 1000;
  beta.net.remove(phone.member.id, beta.id);
  // Beta joins Delta's net: its removal is of the phone's way into Beta's net, not of the one into Delta's.
  now += 1000;
  await beta.net.joinWith(delta.net.invite().link);
  await network.settled();
  assert.equal(beta.net.revision().id, delta.net.revision().id);
  assert.equal((await delta.net.authenticate(phone.token))?.id, phone.member.id, "Delta still takes the phone's token");
  assert.equal((await beta.net.authenticate(phone.token))?.id, phone.member.id);
  assert.deepEqual(delta.removed, []);
});

test("nor does a removal made on the joining Mac while the net's answer is on its way", async (t) => {
  let now = 40_000_000;
  const network = new Network();
  let joining: (() => void) | undefined;
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      const answer = await answered(url, init);
      joining?.();
      return answer;
    }) as typeof fetch,
  });
  const beta = mac(t, network, "Beta", { now: () => now });
  const delta = mac(t, network, "Delta", { now: () => now });
  joinDevice(beta);
  now += 1000;
  const phone = joinDevice(delta);
  now += 1000;
  // The phone's old entry is removed on Beta as Delta's answer comes.
  joining = () => beta.net.remove(phone.member.id, beta.id);
  await beta.net.joinWith(delta.net.invite().link);
  await network.settled();
  assert.equal(beta.net.revision().id, delta.net.revision().id);
  assert.equal((await delta.net.authenticate(phone.token))?.id, phone.member.id, "Delta still takes the phone's token");
  assert.equal((await beta.net.authenticate(phone.token))?.id, phone.member.id);
});

test("a Mac joining the net it is in already brings its removals as they are, whatever token the net has for the member", async (t) => {
  let now = 50_000_000;
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { now: () => now });
  const beta = mac(t, network, "Beta", { now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  const first = joinDevice(alpha);
  await network.settled();
  // While Alpha cannot be reached, the phone joins again through Beta, and is removed there.
  network.down.add(alpha.url);
  now += 1000;
  const second = joinDevice(beta);
  now += 1000;
  beta.net.remove(second.member.id, beta.id);
  await network.settled();
  network.down.delete(alpha.url);
  // Beta joins its own net again, through Alpha: its removal is of the phone, both ways in.
  now += 1000;
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  for (const one of [alpha, beta]) {
    assert.equal(await one.net.authenticate(first.token), undefined, "the first token stays refused");
    assert.equal(await one.net.authenticate(second.token), undefined, "the second token stays refused");
  }
});

test("nor a removal made on it while the answer is on its way, when the answer is of its own net", async (t) => {
  let now = 50_000_000;
  const network = new Network();
  let joining: (() => void) | undefined;
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      const answer = await answered(url, init);
      joining?.();
      return answer;
    }) as typeof fetch,
  });
  const alpha = mac(t, network, "Alpha", { now: () => now });
  const beta = mac(t, network, "Beta", { now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  const first = joinDevice(alpha);
  await network.settled();
  // Alpha's answer still has the phone's first token; the phone joins again through Beta and is removed there meanwhile.
  let second: { token: string; member: Member } | undefined;
  joining = () => {
    // Alpha does not hear of these from Beta's own copying meanwhile.
    network.down.add(alpha.url);
    now += 1000;
    second = joinDevice(beta);
    now += 1000;
    beta.net.remove(second.member.id, beta.id);
  };
  now += 1000;
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  network.down.delete(alpha.url);
  await alpha.net.authenticate("z".repeat(43));
  await network.settled();
  for (const one of [alpha, beta]) {
    assert.equal(await one.net.authenticate(first.token), undefined, "the first token stays refused");
    assert.equal(await one.net.authenticate(second!.token), undefined, "the second token stays refused");
  }
});

test("a Mac leaving its net does not join a net until it has left, which would leave that net a token it no longer has", async (t) => {
  const network = new Network();
  let holding = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((done) => (release = done));
  const called = network.call;
  Object.assign(network, {
    call: async (link: TokenLink, method: string, params: Record<string, unknown>) => {
      const answer = await called(link, method, params);
      if (holding) await held;
      return answer;
    },
  });
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  // Alpha has taken in that Beta leaves; its answer is held while Beta is asked to join Alpha's net again.
  const gamma = mac(t, network, "Gamma");
  const code = beta.net.invite().code;
  const link = beta.net.invite().link;
  holding = true;
  const leaving = beta.net.leave();
  await sleep(10);
  await assert.rejects(beta.net.joinWith(alpha.net.invite().link), { message: "This Mac is leaving its net. Join once that is done." });
  // Nor does it take in a device or a Mac with a code it made before: the net of its own would drop them.
  assert.equal(joinStatus(beta, code), 409);
  await assert.rejects(gamma.net.joinWith(link), { message: "This Mac is leaving its net. Try again in a moment." });
  release!();
  await leaving;
  holding = false;
  await network.settled();
  assert.deepEqual(alpha.net.macs(), [], "Alpha does not list Beta, under a token Beta no longer has");
});

test("a Mac that missed its own removal, joining the net the Mac that removed it is in now, brings no removal of that net's members", async (t) => {
  let now = 60_000_000;
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { now: () => now });
  const beta = mac(t, network, "Beta", { now: () => now });
  const delta = mac(t, network, "Delta", { now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  const first = joinDevice(alpha);
  await network.settled();
  // Beta misses being removed by Alpha, which joins Delta's net, its token as it was.
  network.down.add(beta.url);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  now += 1000;
  await alpha.net.joinWith(delta.net.invite().link);
  await network.settled();
  // The phone goes into that net too, with a new token; Beta, still apart, removes its old entry.
  now += 1000;
  const second = joinDevice(delta);
  await network.settled();
  network.down.add(alpha.url);
  network.down.add(delta.url);
  now += 1000;
  beta.net.remove(first.member.id, beta.id);
  await network.settled();
  network.down.clear();
  // Beta joins through Alpha, whose token its list still has: its removal is of the phone's way into the net it was in.
  now += 1000;
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  assert.equal(beta.net.revision().id, delta.net.revision().id);
  for (const one of [alpha, beta, delta]) assert.equal((await one.net.authenticate(second.token))?.id, second.member.id, "the phone's token in Delta's net stays good");
});

test("a join answered after this Mac was taken out of its net and started its own is not taken: the answer is of before", async (t) => {
  const network = new Network();
  let release: (() => void) | undefined;
  let holding = false;
  const held = new Promise<void>((done) => (release = done));
  const answered = network.fetch;
  Object.assign(network, {
    fetch: (async (url: string, init: RequestInit) => {
      const answer = await answered(url, init);
      if (holding) await held;
      return answer;
    }) as typeof fetch,
  });
  const alpha = mac(t, network, "Alpha");
  const beta = mac(t, network, "Beta");
  await beta.net.joinWith(alpha.net.invite().link);
  await network.settled();
  // Beta joins again; Alpha takes it in, then Beta is removed there, and learns it, before the answer comes.
  holding = true;
  const joining = beta.net.joinWith(alpha.net.invite().link).then(() => "joined", (error: Error) => error.message);
  await sleep(10);
  alpha.net.remove(beta.id, alpha.id);
  await network.settled();
  const alone = beta.net.revision().id;
  assert.notEqual(alone, alpha.net.revision().id, "Beta started a net of its own");
  release!();
  assert.notEqual(await joining, "joined");
  await network.settled();
  assert.equal(beta.net.revision().id, alone, "Beta stays in its own net");
  assert.deepEqual(alpha.net.macs(), []);
});

test("a member in under a new token has its connections under the old one closed, on every Mac that had it", async (t) => {
  let now = 70_000_000;
  const network = new Network();
  const alpha = mac(t, network, "Alpha", { now: () => now });
  const beta = mac(t, network, "Beta", { now: () => now });
  const delta = mac(t, network, "Delta", { now: () => now });
  await beta.net.joinWith(alpha.net.invite().link);
  joinDevice(alpha);
  await network.settled();
  // The phone joins again through Alpha (a new token): Alpha and Beta let go of what the old one opened.
  now += 1000;
  const again = joinDevice(alpha);
  await network.settled();
  assert.deepEqual(alpha.retokened, [[again.member.id]]);
  assert.deepEqual(beta.retokened, [[again.member.id]]);
});

test("a Mac joining a net that has one of its devices under another token lets go of what the old token opened", async (t) => {
  let now = 70_000_000;
  const network = new Network();
  const beta = mac(t, network, "Beta", { now: () => now });
  const delta = mac(t, network, "Delta", { now: () => now });
  // The phone was Beta's, and went into Delta's net with a new token, with no word to Beta.
  joinDevice(beta);
  now += 1000;
  const moved = joinDevice(delta);
  now += 1000;
  await beta.net.joinWith(delta.net.invite().link);
  await network.settled();
  assert.equal((await beta.net.authenticate(moved.token))?.id, moved.member.id);
  assert.deepEqual(beta.retokened, [[moved.member.id]], "Beta closes what the phone's old token opened");
  assert.deepEqual(beta.removed, []);
});

// MARK: Names set from the app (feature net_rename)

/** `at`'s entry for the member `id`. */
function entryOf(at: Mac, id: string): Member {
  const found = at.net.list(null).members.find((member) => member.id === id);
  assert.ok(found, `${id} is in the list`);
  return found as Member;
}

/** Three Macs in one net: Beta joined Alpha's, Gamma through Beta. */
async function threeMacs(t: TestContext, network: Network, clocks: { alpha?: () => number; beta?: () => number; gamma?: () => number } = {}, gammaHome?: string): Promise<[Mac, Mac, Mac]> {
  const alpha = mac(t, network, "Alpha", { now: clocks.alpha });
  const beta = mac(t, network, "Beta", { now: clocks.beta });
  const gamma = mac(t, network, "Gamma", { now: clocks.gamma, home: gammaHome });
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(beta.net.invite().link);
  await network.settled();
  return [alpha, beta, gamma];
}

/** Has `at` ask every other Mac for its copy now, as it does every ten minutes: a token nobody knows (once every 30 s by its clock). */
async function meet(network: Network, at: Mac): Promise<void> {
  await at.net.authenticate("u".repeat(43));
  await network.settled();
}

test("a Mac's name set from the app is merged apart from the rest of its entry: the later stamp wins whichever entry does, and a rename never undoes a removal", () => {
  const macEntry = (change: Partial<Member> = {}) => entry("mac-bbbb", { kind: "mac", token_hash: "a".repeat(64), ...change });
  // Renamed on Alpha while the Mac itself wrote its entry anew (a new address), not knowing:
  // the newer entry, under the name set from the app, whichever copy merges into which.
  const renamed = macEntry({ name: "Studio", named: 2000, named_by: "mac-aaaa" });
  const rewritten = macEntry({ name: "mini", url: "http://new.test:1", changed: 5000, by: "mac-bbbb" });
  for (const merged of [merge([renamed], [rewritten]), merge([rewritten], [renamed])]) {
    assert.deepEqual(merged.members, [{ ...rewritten, name: "Studio", named: 2000, named_by: "mac-aaaa" }]);
    assert.equal(merged.changed, true);
  }
  assert.equal(merge([{ ...rewritten, name: "Studio", named: 2000, named_by: "mac-aaaa" }], [renamed]).changed, false);
  // Of two names the later stamp, though its entry is older; at the same stamp the greater Mac's.
  const one = macEntry({ name: "One", named: 3000, named_by: "mac-cccc" });
  const two = macEntry({ name: "Two", named: 4000, named_by: "mac-aaaa", changed: 900 });
  assert.equal(merge([one], [two]).members[0].name, "Two");
  assert.equal(merge([two], [one]).members[0].name, "Two");
  const tie = macEntry({ name: "Tie", named: 3000, named_by: "mac-dddd" });
  assert.equal(merge([one], [tie]).members[0].name, "Tie");
  assert.equal(merge([tie], [one]).members[0].name, "Tie");
  assert.equal(merge([tie], [one]).changed, false);
  // A name never set from the app gives way to one that was, however new its entry.
  assert.equal(merge([renamed], [macEntry({ name: "Computer Name", changed: 9000 })]).members[0].name, "Studio");
  // Removed on one Mac while another renamed it, neither knowing: removed everywhere, under the later name.
  const removed = macEntry({ removed: true, changed: 6000, by: "mac-aaaa" });
  const late = macEntry({ name: "Late", named: 7000, named_by: "mac-cccc" });
  for (const merged of [merge([removed], [late]), merge([late], [removed])]) {
    assert.equal(merged.members[0].removed, true);
    assert.equal(merged.members[0].name, "Late");
  }
  assert.deepEqual(merge([late], [removed]).removed.map((member) => member.id), ["mac-bbbb"]);
  // Read with both its stamp and who set it, or neither; a device's too, since 2026-10-28 (feature net_rename_devices).
  assert.deepEqual(parseMember(renamed), renamed);
  for (const bad of [{ ...renamed, named_by: undefined }, { ...renamed, named: undefined }, { ...renamed, named: 0 }, { ...renamed, named: 1.5 }, { ...renamed, named_by: "?" }]) {
    assert.equal(parseMember(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parseMember(entry("phone-111", { named: 5, named_by: "mac-aaaa" })), entry("phone-111", { named: 5, named_by: "mac-aaaa" }));
  assert.equal(parseMember(entry("phone-111", { named: 5 })), undefined);
  // A device's name is merged as a Mac's: the later stamp, whichever entry wins.
  const phone = entry("phone-111", { name: "Dana's iPhone", named: 2000, named_by: "mac-aaaa" });
  const removedPhone = entry("phone-111", { removed: true, changed: 5000, by: "mac-cccc" });
  for (const merged of [merge([phone], [removedPhone]), merge([removedPhone], [phone])]) {
    assert.deepEqual(merged.members, [{ ...removedPhone, name: "Dana's iPhone", named: 2000, named_by: "mac-aaaa" }]);
  }
});

test("a Mac renamed from the app goes by the name at once and after a restart, over its own name, until renamed again; a name that cannot be one is refused", async (t) => {
  const network = new Network();
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const alpha = mac(t, network, "Alpha", { home });
  const device = joinDevice(alpha);
  for (const [name, message] of [
    ["", "A Mac's name cannot be empty."],
    ["   ", "A Mac's name cannot be empty."],
    ["Mac\nmini", "A Mac's name is one line."],
    ["x".repeat(81), "A Mac's name is at most 80 characters."],
    // 41 of them are 82 UTF-16 units, which is how every Mac counts a name.
    ["🖥".repeat(41), "A Mac's name is at most 80 characters."],
  ]) {
    assert.throws(() => alpha.net.rename(alpha.id, name), { message }, JSON.stringify(name));
  }
  assert.throws(() => alpha.net.rename("nobody-0000", "Studio"), { message: "There is no member nobody-0000 in this net." });
  // Its name as it is: nothing changes.
  const { revision } = alpha.net.revision();
  alpha.net.rename(alpha.id, " Alpha ");
  assert.equal(alpha.net.revision().revision, revision);
  assert.deepEqual(alpha.renamed, []);

  // One meant for another net (a device that switched nets as it asked) renames nothing.
  assert.throws(() => alpha.net.rename(alpha.id, "Studio", undefined, "0123456789abcdef"), { message: "This Mac is not in that net any more: nothing was renamed." });
  assert.equal(alpha.net.revision().revision, revision);
  assert.deepEqual(alpha.renamed, []);

  alpha.net.rename(alpha.id, "  Studio  ", undefined, alpha.net.revision().id);
  assert.equal(alpha.net.name(), "Studio");
  assert.deepEqual(alpha.renamed, ["Studio"]);
  const own = entryOf(alpha, alpha.id);
  assert.equal(own.name, "Studio");
  assert.equal(own.named_by, alpha.id);
  assert.ok(own.named! > 0);
  // A device is given the name with its stamp; the link a code is in names it too.
  assert.deepEqual(alpha.net.list(device.member.id).members.find((member) => member.id === alpha.id)?.named, own.named);
  assert.match(alpha.net.invite().link, /&name=Studio$/);
  // 40 of them are 80 units: taken.
  alpha.net.rename(alpha.id, "🖥".repeat(40));
  alpha.net.rename(alpha.id, "Studio");
  alpha.net.close();

  // Started again with another name of its own (a fleet.name, a new Computer Name): the one set from the app wins, and nothing is written.
  network.nets.clear();
  const saved = alpha.net.revision();
  const again = mac(t, network, "Alpha Again", { home, id: alpha.id, url: alpha.url });
  assert.equal(again.net.name(), "Studio");
  assert.deepEqual(again.net.revision(), saved);
  // Until it is renamed again: the newest.
  again.net.rename(again.id, "Studio Two");
  assert.equal(again.net.name(), "Studio Two");
  assert.ok(entryOf(again, again.id).named! > own.named!);
});

test("a Mac renamed on another Mac of the net is renamed on every Mac, and takes the name as its own, writing its entry anew", async (t) => {
  let now = 30_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: clock, beta: clock, gamma: clock });
  const before = entryOf(gamma, beta.id);
  alpha.net.rename(beta.id, "Studio");
  // Alpha says so at once, the others once the list reached them. The entry's own `changed`
  // and `by` stay: the stamp is the name's alone, so a rename cannot undo a removal.
  const renamed = entryOf(alpha, beta.id);
  assert.deepEqual([renamed.name, renamed.named_by, renamed.changed, renamed.by], ["Studio", alpha.id, before.changed, before.by]);
  await network.settled();
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, beta.id).name, "Studio", one.id);
  assert.equal(beta.net.name(), "Studio");
  assert.deepEqual(beta.renamed, ["Studio"]);
  assert.equal(alpha.net.name(), "Alpha");
  // Its own entry was written anew by itself, after the one before, so a bridge that takes only whole entries takes it too.
  const after = entryOf(gamma, beta.id);
  assert.equal(after.by, beta.id);
  assert.ok(after.changed > before.changed);
  assert.equal(after.named_by, alpha.id);
  assert.deepEqual(entryOf(alpha, beta.id), after);
});

test("the latest rename wins on every Mac: one made after another whatever the clocks say, two made apart by the clocks, then by the Macs' ids", async (t) => {
  let now = 40_000_000;
  let ahead = 3_600_000;
  const network = new Network();
  // Alpha's clock is an hour ahead of the others'.
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now + ahead, beta: () => now, gamma: () => now });
  const named = (one: Mac) => entryOf(one, gamma.id).name;

  // Alpha renames Gamma; a minute later Beta, having heard of it, renames it again: Beta's
  // is the later rename and wins everywhere, though its clock says an hour before Alpha's.
  alpha.net.rename(gamma.id, "One");
  await network.settled();
  now += 60_000;
  beta.net.rename(gamma.id, "Two");
  await network.settled();
  for (const one of [alpha, beta, gamma]) assert.equal(named(one), "Two", one.id);
  assert.equal(gamma.net.name(), "Two");

  // Apart (no Mac reaches another), Beta then Alpha rename Gamma: when they meet, the later
  // stamp wins on every Mac, whichever way they meet. Alpha's clock still says an hour on.
  for (const one of [alpha, beta, gamma]) network.down.add(one.url);
  now += 60_000;
  beta.net.rename(gamma.id, "Beta's");
  alpha.net.rename(gamma.id, "Alpha's");
  await network.settled();
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  for (const one of [alpha, beta, gamma]) assert.equal(named(one), "Alpha's", one.id);

  // Apart again, both a step past that hour-ahead stamp, with their clocks agreeing now: the
  // same stamp from both, and the greater Mac's id wins (Beta's over Alpha's), on every Mac.
  ahead = 0;
  for (const one of [alpha, beta, gamma]) network.down.add(one.url);
  alpha.net.rename(gamma.id, "Alpha again");
  beta.net.rename(gamma.id, "Beta again");
  assert.equal(entryOf(alpha, gamma.id).named, entryOf(beta, gamma.id).named);
  await network.settled();
  network.down.clear();
  now += 30_000;
  await meet(network, alpha);
  for (const one of [alpha, beta, gamma]) assert.equal(named(one), "Beta again", one.id);
  assert.equal(gamma.net.name(), "Beta again");
  assert.ok(beta.id > alpha.id);
});

test("a rename comes after the name the device held, which the Mac it asks may not have heard of yet", async (t) => {
  let now = 50_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now + 3_600_000, beta: () => now, gamma: () => now });
  // Beta is out of reach while Alpha, an hour ahead, renames Gamma, and a phone listing Alpha sees it.
  network.down.add(beta.url);
  alpha.net.rename(gamma.id, "Seen");
  await network.settled();
  const seen = entryOf(alpha, gamma.id).named!;
  // Then the phone reaches Beta only, and renames Gamma again, saying what it held.
  network.down.clear();
  network.down.add(alpha.url);
  network.down.add(gamma.url);
  now += 60_000;
  beta.net.rename(gamma.id, "After", seen);
  assert.ok(entryOf(beta, gamma.id).named! > seen);
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "After", one.id);
  // What a device sends that no Mac could take is not taken: a stamp every Mac reads.
  beta.net.rename(gamma.id, "Odd", Number.MAX_SAFE_INTEGER + 10);
  beta.net.rename(gamma.id, "Odder", -5);
  await network.settled();
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "Odder", one.id);
});

test("a Mac renamed while it was off keeps the name when it comes back at a new address, and takes it as its own", async (t) => {
  let now = 60_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: clock, beta: clock, gamma: clock }, home);
  gamma.net.close();
  network.nets.delete(gamma.url);
  alpha.net.rename(gamma.id, "Renamed");
  await network.settled();
  // Back on another address: it writes its entry anew under the name it knew, newer than the
  // rename's; the others keep the rename on it, and Gamma takes it from their answer.
  now += 1000;
  const back = mac(t, network, "Gamma", { home, id: gamma.id, url: "http://gamma-new.test:9120", now: clock });
  await network.settled();
  for (const one of [alpha, beta, back]) {
    const entry = entryOf(one, gamma.id);
    assert.deepEqual([entry.name, entry.url], ["Renamed", "http://gamma-new.test:9120"], one.id);
  }
  assert.equal(back.net.name(), "Renamed");
  assert.deepEqual(back.renamed, ["Renamed"]);
});

test("beside a bridge from before renames, the net keeps working: it takes a renamed Mac's own entry whole, and its own copies undo no rename", async (t) => {
  let now = 70_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  // Old stands in for a bridge from before the feature: what it sends and is sent goes without the names' stamps.
  const strip = (members: unknown) => (Array.isArray(members) ? members.map(({ named: _at, named_by: _by, ...rest }) => rest) : members);
  const oldURLs = ["http://old.test:9120", "http://old-new.test:9120"];
  const call: Network["call"] = async (link, method, params) => {
    const answer = (await network.call(link, method, { ...params, members: strip(params.members) })) as Record<string, unknown>;
    return { ...answer, members: strip(answer.members) };
  };
  const passing = network.call;
  const intoOld: Network["call"] = (link, method, params) => passing(link, method, oldURLs.includes(link.url) ? { ...params, members: strip(params.members) } : params);
  (network as { call: Network["call"] }).call = intoOld;
  const alpha = mac(t, network, "Alpha", { now: clock, call: intoOld });
  const beta = mac(t, network, "Beta", { now: clock, call: intoOld });
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = mac(t, network, "Old", { now: clock, call, url: oldURLs[0], home });
  await beta.net.joinWith(alpha.net.invite().link);
  await old.net.joinWith(beta.net.invite().link);
  await network.settled();

  // Beta renamed on Alpha: Old takes it once Beta wrote its own entry anew.
  alpha.net.rename(beta.id, "Studio");
  await network.settled();
  assert.equal(entryOf(old, beta.id).name, "Studio");
  assert.equal(entryOf(old, beta.id).named, undefined);
  // Old's copies, without the stamp, take it from no one.
  now += 30_000;
  await meet(network, old);
  for (const one of [alpha, beta]) assert.equal(entryOf(one, beta.id).named_by, alpha.id);

  // Old itself renamed on Alpha: the new bridges keep the name, though Old goes by its own and
  // writes its entry anew, newer, as it starts again at another address.
  alpha.net.rename(old.id, "Old Studio");
  await network.settled();
  assert.equal(old.net.name(), "Old");
  for (const one of [alpha, beta]) assert.equal(entryOf(one, old.id).name, "Old Studio", one.id);
  const was = entryOf(alpha, old.id);
  old.net.close();
  network.nets.delete(old.url);
  now += 1000;
  const again = mac(t, network, "Old", { now: clock, call, url: oldURLs[1], home, id: old.id });
  await network.settled();
  for (const one of [alpha, beta]) {
    const entry = entryOf(one, old.id);
    assert.deepEqual([entry.name, entry.url], ["Old Studio", oldURLs[1]], one.id);
    assert.ok(entry.changed > was.changed);
  }
  assert.equal(again.net.name(), "Old");
  assert.deepEqual([...old.removed, ...again.removed], []);
});

test("a rename back to the name a Mac that has not heard of the rename between still holds is a rename all the same (review 2026-10-26, 1)", async (t) => {
  let now = 80_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  // Beta is out of reach as Alpha renames Gamma, which a phone listing Alpha sees.
  network.down.add(beta.url);
  alpha.net.rename(gamma.id, "Studio");
  await network.settled();
  const seen = entryOf(alpha, gamma.id).named!;
  // The phone reaches Beta alone and names Gamma back "Gamma", which Beta still holds.
  network.down.clear();
  network.down.add(alpha.url);
  network.down.add(gamma.url);
  now += 60_000;
  beta.net.rename(gamma.id, "Gamma", seen);
  assert.ok(entryOf(beta, gamma.id).named! > seen);
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "Gamma", one.id);
  // With no stamp, or an older one than Beta holds, the same name is still nothing new.
  const { revision } = beta.net.revision();
  beta.net.rename(gamma.id, "Gamma", seen);
  beta.net.rename(gamma.id, "Gamma");
  assert.equal(beta.net.revision().revision, revision);
});

test("a rename made while this Mac's join is answered is kept, as its devices and removals are (review 2026-10-26, 2)", async (t) => {
  let now = 90_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  // Beta's joins are answered when the test says: the answer made at once, given later.
  let release = () => {};
  let holding = false;
  const held: typeof fetch = (async (url: string, init: RequestInit) => {
    const answer = await network.fetch(url, init);
    if (holding) await new Promise<void>((resolve) => (release = resolve));
    return answer;
  }) as typeof fetch;
  const alpha = mac(t, network, "Alpha", { now: clock });
  const beta = mac(t, network, "Beta", { now: clock, fetch: held });
  const gamma = mac(t, network, "Gamma", { now: clock });
  await beta.net.joinWith(alpha.net.invite().link);
  await gamma.net.joinWith(beta.net.invite().link);
  await network.settled();

  // Beta joins its own net again through Alpha; while the answer is on its way, a phone
  // renames Gamma on Beta, and no other Mac can be told.
  holding = true;
  const joining = beta.net.joinWith(alpha.net.invite().link);
  await sleep(5);
  for (const one of [alpha, gamma]) network.down.add(one.url);
  beta.net.rename(gamma.id, "Studio");
  await network.settled();
  release();
  await joining;
  assert.equal(entryOf(beta, gamma.id).name, "Studio");
  // Nothing else of Gamma's entry came from Beta's list: the answer's address and token stay.
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "Studio", one.id);
  assert.equal(gamma.net.name(), "Studio");
});

test("a stamp no Mac would make, from a device, sets no name past every later rename; one that cannot be moved past refuses with a sentence (review 2026-10-26, 4)", async (t) => {
  let now = 100_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  const named = (one: Mac) => entryOf(one, gamma.id);
  // The largest whole number, and two days past this Mac's clock: not taken, the rename stamped by the clock.
  beta.net.rename(gamma.id, "One", Number.MAX_SAFE_INTEGER);
  assert.equal(named(beta).named, now);
  now += 1;
  beta.net.rename(gamma.id, "Two", now + 2 * 86_400_000);
  assert.equal(named(beta).named, now);
  // An hour past it, as a Mac's clock ahead makes: taken.
  now += 1;
  beta.net.rename(gamma.id, "Three", now + 3_600_000);
  assert.equal(named(beta).named, now + 3_600_001);
  // So later renames each come after: through the same Mac, and through another once it heard; every Mac ends with the last.
  now += 1;
  beta.net.rename(gamma.id, "Four");
  assert.equal(named(beta).named, now + 3_600_001);
  await network.settled();
  alpha.net.rename(gamma.id, "Five");
  await network.settled();
  for (const one of [alpha, beta, gamma]) assert.equal(named(one).name, "Five", one.id);
  // A copy from a Mac with a stamp at the very end cannot be renamed past: said so, nothing changed.
  const ending = { ...named(alpha), name: "Stuck", named: Number.MAX_SAFE_INTEGER, named_by: alpha.id, token_hash: undefined };
  beta.net.receive({ kind: "member", id: alpha.id, member: "mac", removed: false }, beta.net.revision().id, [ending]);
  const { revision } = beta.net.revision();
  assert.throws(() => beta.net.rename(gamma.id, "Six"), { message: "This Mac's name has a stamp that cannot be moved past, so it cannot be renamed." });
  assert.equal(beta.net.revision().revision, revision);
});

test("a rename back through a Mac whose name lost a tie at the same stamp is a rename all the same (review 2026-10-26, re-check 1)", async (t) => {
  const now = 110_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  // Apart, Alpha and Beta rename Gamma at the same stamp: Beta's, of the greater id, wins.
  for (const one of [alpha, beta, gamma]) network.down.add(one.url);
  alpha.net.rename(gamma.id, "Original");
  beta.net.rename(gamma.id, "Studio");
  const studio = entryOf(beta, gamma.id).named!;
  assert.equal(entryOf(alpha, gamma.id).named, studio);
  // A phone that saw Studio reaches Alpha alone, which still holds Original, and names Gamma Original.
  alpha.net.rename(gamma.id, "Original", studio);
  assert.ok(entryOf(alpha, gamma.id).named! > studio);
  await network.settled();
  network.down.clear();
  await meet(network, alpha);
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "Original", one.id);
  // With no stamp, or an older one than this Mac holds, the same name is still nothing new.
  const { revision } = alpha.net.revision();
  alpha.net.rename(gamma.id, "Original");
  alpha.net.rename(gamma.id, "Original", studio);
  assert.equal(alpha.net.revision().revision, revision);
});

test("a Mac joining its own net again through a bridge from before keeps the names it held stamped (review 2026-10-26, re-check 2)", async (t) => {
  let now = 120_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  // Old stands in for a bridge from before the feature, as above, joins included.
  const strip = (members: unknown) => (Array.isArray(members) ? members.map(({ named: _at, named_by: _by, ...rest }) => rest) : members);
  const oldURL = "http://old.test:9120";
  const call: Network["call"] = async (link, method, params) => {
    const answer = (await network.call(link, method, { ...params, members: strip(params.members) })) as Record<string, unknown>;
    return { ...answer, members: strip(answer.members) };
  };
  const passing = network.call;
  const intoOld: Network["call"] = (link, method, params) => passing(link, method, link.url === oldURL ? { ...params, members: strip(params.members) } : params);
  (network as { call: Network["call"] }).call = intoOld;
  const joinOld: typeof fetch = (async (url: string, init: RequestInit) => {
    if (new URL(url).origin !== oldURL) return network.fetch(url, init);
    const body = JSON.parse(init.body as string);
    const answer = (await (await network.fetch(url, { ...init, body: JSON.stringify({ ...body, members: strip(body.members) }) })).json()) as Record<string, unknown>;
    return Response.json({ ...answer, members: strip(answer.members) });
  }) as typeof fetch;
  const old = mac(t, network, "Old", { now: clock, call, url: oldURL });
  const beta = mac(t, network, "Beta", { now: clock, call: intoOld, fetch: joinOld });
  const gamma = mac(t, network, "Gamma", { now: clock, call: intoOld, fetch: joinOld });
  await beta.net.joinWith(old.net.invite().link);
  await gamma.net.joinWith(beta.net.invite().link);
  await network.settled();
  // Gamma is off as Beta renames it: Old keeps its own name for it, the entry unchanged.
  network.down.add(gamma.url);
  beta.net.rename(gamma.id, "Studio");
  await network.settled();
  assert.equal(entryOf(old, gamma.id).name, "Gamma");
  // Beta joins its net again through Old, whose answer has Gamma unstamped.
  await beta.net.joinWith(old.net.invite().link);
  const kept = entryOf(beta, gamma.id);
  assert.deepEqual([kept.name, kept.named_by], ["Studio", beta.id]);
  // Gamma back: it takes the name, and Old with it once Gamma wrote its entry anew.
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  assert.equal(gamma.net.name(), "Studio");
  await meet(network, gamma);
  for (const one of [old, beta, gamma]) assert.equal(entryOf(one, gamma.id).name, "Studio", one.id);
});

// MARK: Devices renamed from the app (feature net_rename_devices)

test("a device of the net renamed from the app is renamed on every Mac, the latest rename winning, and a rename never undoes its removal", async (t) => {
  let now = 130_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  const phone = joinDevice(gamma).member.id;
  await network.settled();
  const before = entryOf(alpha, phone);
  // A name that cannot be one is refused in a device's words.
  for (const [name, message] of [
    ["", "A device's name cannot be empty."],
    ["two\nlines", "A device's name is one line."],
    ["x".repeat(81), "A device's name is at most 80 characters."],
  ]) {
    assert.throws(() => alpha.net.rename(phone, name), { message }, JSON.stringify(name));
  }
  // Renamed on Alpha, which the phone did not join through: on every Mac, the entry's own
  // `changed` and `by` as they were, and given to the device with its stamp.
  now += 1;
  alpha.net.rename(phone, "  Dana's iPhone  ");
  await network.settled();
  const renamed = entryOf(alpha, phone);
  for (const one of [alpha, beta, gamma]) {
    const entry = entryOf(one, phone);
    assert.deepEqual([entry.name, entry.named, entry.named_by, entry.changed, entry.by], ["Dana's iPhone", renamed.named, alpha.id, before.changed, before.by], one.id);
  }
  assert.equal(gamma.net.list(phone).members.find((member) => member.id === phone)?.named, renamed.named);
  // Its name as it is: nothing changes.
  const { revision } = beta.net.revision();
  beta.net.rename(phone, "Dana's iPhone");
  assert.equal(beta.net.revision().revision, revision);
  // A later rename, on another Mac, wins on every Mac.
  now += 60_000;
  beta.net.rename(phone, "Phone");
  await network.settled();
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, phone).name, "Phone", one.id);
  // Apart, Alpha removes it as Gamma renames it: once they meet, removed on every Mac, under the later name.
  for (const one of [alpha, beta, gamma]) network.down.add(one.url);
  now += 1;
  alpha.net.remove(phone, alpha.id);
  now += 1;
  gamma.net.rename(phone, "Late");
  await network.settled();
  network.down.clear();
  now += 30_000;
  await meet(network, gamma);
  for (const one of [alpha, beta, gamma]) {
    const entry = entryOf(one, phone);
    assert.deepEqual([entry.removed, entry.name], [true, "Late"], one.id);
  }
  // Removed, it is no member to rename.
  assert.throws(() => beta.net.rename(phone, "Again"), { message: `There is no member ${phone} in this net.` });
});

test("a device that joins again goes by the name it joins with on every Mac, past the one it was given; one joining for the first time has no stamp", async (t) => {
  let now = 140_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  const phone = joinDevice(alpha).member.id;
  await network.settled();
  now += 1;
  beta.net.rename(phone, "Given");
  await network.settled();
  const given = entryOf(alpha, phone).named!;
  now += 1;
  alpha.net.remove(phone, alpha.id);
  await network.settled();
  // Added again through Gamma, with another name: that one on every Mac, not the one given before.
  now += 1;
  joinDevice(gamma, phone, "Joined Again");
  await network.settled();
  for (const one of [alpha, beta, gamma]) {
    const entry = entryOf(one, phone);
    assert.deepEqual([entry.name, entry.removed, entry.named_by], ["Joined Again", undefined, gamma.id], one.id);
  }
  assert.ok(entryOf(alpha, phone).named! > given);
  // A device joining for the first time has no stamp; joining again, it has one.
  const tablet = joinDevice(beta, "ipad-0000-1111", "iPad").member.id;
  assert.equal(entryOf(beta, tablet).named, undefined);
  now += 1;
  joinDevice(beta, tablet, "iPad");
  // Stamped at the entry's own change: the name it joined with, which the device tells from a
  // rename, always stamped past it (review 2026-10-29, re-check 1).
  const again = entryOf(beta, tablet);
  assert.deepEqual([again.named, again.named_by, again.changed], [now, beta.id, now]);
});

test("a device's rename is stamped past its entry's own change, whatever the clocks say, so the device tells a name it was given from the one it joined with (review 2026-10-29, re-check 1)", async (t) => {
  let now = 147_000_000;
  const network = new Network();
  // Alpha's clock is an hour ahead: the phone's entry, made there, is stamped an hour on.
  const [alpha, beta] = await threeMacs(t, network, { alpha: () => now + 3_600_000, beta: () => now, gamma: () => now });
  const phone = joinDevice(alpha).member.id;
  await network.settled();
  beta.net.rename(phone, "Pocket");
  const renamed = entryOf(beta, phone);
  assert.ok(renamed.named! > renamed.changed, `${renamed.named} > ${renamed.changed}`);
  // Joined again through Alpha: at its own change, once more.
  now += 60_000;
  joinDevice(alpha, phone, "iPhone");
  const again = entryOf(alpha, phone);
  assert.equal(again.named, again.changed);
  assert.ok(again.named! > renamed.named!);
});

test("a device joining again through a Mac that missed its rename goes by the name it joins with on every Mac (review 2026-10-29, 1)", async (t) => {
  let now = 145_000_000;
  const network = new Network();
  const [alpha, beta, gamma] = await threeMacs(t, network, { alpha: () => now, beta: () => now, gamma: () => now });
  const phone = joinDevice(alpha).member.id;
  await network.settled();
  // Beta is out of reach as Alpha renames the phone: Beta holds it unstamped.
  network.down.add(beta.url);
  now += 1;
  alpha.net.rename(phone, "Renamed on Alpha");
  await network.settled();
  assert.equal(entryOf(beta, phone).named, undefined);
  // The phone joins again through Beta, under another name, before Beta hears of the rename.
  now += 60_000;
  joinDevice(beta, phone, "Joined Again");
  network.down.clear();
  now += 30_000;
  await meet(network, beta);
  for (const one of [alpha, beta, gamma]) assert.equal(entryOf(one, phone).name, "Joined Again", one.id);
});

test("beside a bridge from before 2026-10-28, which reads no device's stamp, a renamed device keeps its name on the new bridges, through its copies and through a join it answers", async (t) => {
  let now = 150_000_000;
  const clock = () => (now += 1);
  const network = new Network();
  // Old stands in for a bridge that renames Macs but not devices: a device's stamp goes from what it sends and is sent.
  const strip = (members: unknown) =>
    Array.isArray(members) ? (members as Member[]).map((member) => (member.kind === "device" ? (({ named: _at, named_by: _by, ...rest }) => rest)(member) : member)) : members;
  const oldURL = "http://old.test:9120";
  const call: Network["call"] = async (link, method, params) => {
    const answer = (await network.call(link, method, { ...params, members: strip(params.members) })) as Record<string, unknown>;
    return { ...answer, members: strip(answer.members) };
  };
  const passing = network.call;
  const intoOld: Network["call"] = (link, method, params) => passing(link, method, link.url === oldURL ? { ...params, members: strip(params.members) } : params);
  (network as { call: Network["call"] }).call = intoOld;
  const joinOld: typeof fetch = (async (url: string, init: RequestInit) => {
    if (new URL(url).origin !== oldURL) return network.fetch(url, init);
    const body = JSON.parse(init.body as string);
    const answer = (await (await network.fetch(url, { ...init, body: JSON.stringify({ ...body, members: strip(body.members) }) })).json()) as Record<string, unknown>;
    return Response.json({ ...answer, members: strip(answer.members) });
  }) as typeof fetch;
  const old = mac(t, network, "Old", { now: clock, call, url: oldURL });
  const beta = mac(t, network, "Beta", { now: clock, call: intoOld, fetch: joinOld });
  const gamma = mac(t, network, "Gamma", { now: clock, call: intoOld, fetch: joinOld });
  await beta.net.joinWith(old.net.invite().link);
  await gamma.net.joinWith(beta.net.invite().link);
  const phone = joinDevice(gamma).member.id;
  await network.settled();

  beta.net.rename(phone, "Dana's iPhone");
  await network.settled();
  // Old keeps the name it held, its copies unstamped; they undo the rename on no new bridge.
  assert.equal(entryOf(old, phone).name, "iPhone");
  now += 30_000;
  await meet(network, old);
  for (const one of [beta, gamma]) assert.deepEqual([entryOf(one, phone).name, entryOf(one, phone).named_by], ["Dana's iPhone", beta.id], one.id);
  // Beta joins its net again through Old, whose answer has the phone under the old name: the later name is taken along.
  await beta.net.joinWith(old.net.invite().link);
  assert.deepEqual([entryOf(beta, phone).name, entryOf(beta, phone).named_by], ["Dana's iPhone", beta.id]);
  now += 30_000;
  await meet(network, beta);
  for (const one of [beta, gamma]) assert.equal(entryOf(one, phone).name, "Dana's iPhone", one.id);
});
