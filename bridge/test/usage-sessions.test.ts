import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import { Registry, type ThreadRecord } from "../src/sessions/registry.ts";
import { PortalsSessions, usageAgent, type SessionAlias } from "../src/usage/sessions.ts";

// The record of the sessions Portals ran (src/usage/sessions.ts): seeded once from the
// threads on the list and those taken off it, a desk session counting from when it was
// taken up, a session only read never counting, a deleted thread staying, and a Droid
// thread's own sessions counting from the thread's start.

setLogLevel("silent");

function folder(): string {
  return mkdtempSync(join(tmpdir(), "portals-usage-sessions-"));
}

const seconds = (iso: string) => Date.parse(iso) / 1000;

function record(id: string, agent: string, createdAt: string, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  const at = seconds(createdAt);
  return { id, agent, cwd: "/Users/dana/code/app", title: null, model: "default", provider: "anthropic", reasoningEffort: "", createdAt: at, updatedAt: at, origin: "phone", ...extra };
}

test("only the agents whose usage can be read are usage agents", () => {
  assert.equal(usageAgent("claude"), "claude");
  assert.equal(usageAgent("droid"), "droid");
  assert.equal(usageAgent("fake"), undefined);
  assert.equal(usageAgent(undefined), undefined);
});

test("seeded once from threads.json and removed.json: each session from its createdAt, a desk one from when it was taken up, one only read not at all", () => {
  const state = folder();
  const registry = new Registry(join(state, "threads.json"));
  registry.add(record("claude-phone", "claude", "2026-11-01T10:00:00Z"));
  registry.add(record("codex-desk", "codex", "2026-11-03T12:00:00Z", { origin: "desk" }));
  registry.add(record("pi-read", "pi", "2026-11-02T08:00:00Z", { origin: "desk", readOnly: true }));
  registry.add(record("claude-gone", "claude", "2026-10-20T09:00:00Z"));
  registry.remove("claude-gone");

  const reread = new Registry(join(state, "threads.json"));
  const usage = join(state, "usage");
  const sessions = new PortalsSessions({ folder: usage });
  const seeds = [...reread.all(), ...reread.allRemoved()].map((thread) => ({ id: thread.id, agent: usageAgent(thread.agent)!, createdAt: thread.createdAt, readOnly: thread.readOnly }));
  assert.equal(sessions.seed(seeds), true);
  assert.equal(sessions.size, 3);
  assert.equal(sessions.sinceOf("claude", "claude-phone"), Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(sessions.sinceOf("codex", "codex-desk"), Date.parse("2026-11-03T12:00:00Z"));
  assert.equal(sessions.sinceOf("pi", "pi-read"), undefined);
  // Deleted, it went through Portals all the same.
  assert.equal(sessions.sinceOf("claude", "claude-gone"), Date.parse("2026-10-20T09:00:00Z"));

  // What was said at the desk before it was taken up stays the desk's.
  assert.equal(sessions.via("codex", "codex-desk", Date.parse("2026-11-03T11:59:59Z")), "elsewhere");
  assert.equal(sessions.via("codex", "codex-desk", Date.parse("2026-11-03T12:00:00Z")), "portals");
  assert.equal(sessions.via("pi", "pi-read", Date.parse("2026-11-04T00:00:00Z")), "elsewhere");
  assert.equal(sessions.via("claude", "someone-else", Date.parse("2026-11-04T00:00:00Z")), "elsewhere");
  // Another agent's session of the same id is not this one.
  assert.equal(sessions.via("pi", "claude-phone", Date.parse("2026-11-04T00:00:00Z")), "elsewhere");

  // Saved, and never seeded again: a thread on the list later that was not noted stays out.
  const saved = JSON.parse(readFileSync(join(usage, "sessions.json"), "utf8"));
  assert.equal(saved.v, 1);
  assert.equal(saved.sessions["claude:claude-phone"], Date.parse("2026-11-01T10:00:00Z"));
  const again = new PortalsSessions({ folder: usage });
  assert.equal(again.seed([{ id: "late", agent: "claude", createdAt: seconds("2026-11-05T00:00:00Z") }]), false);
  assert.equal(again.sinceOf("claude", "late"), undefined);
  assert.equal(again.sinceOf("claude", "claude-gone"), Date.parse("2026-10-20T09:00:00Z"));
});

test("a thread added later counts from its start; an earlier since stays; a session only read counts from its first turn", () => {
  const usage = join(folder(), "usage");
  let now = Date.parse("2026-11-05T15:00:00Z");
  const sessions = new PortalsSessions({ folder: usage, clock: () => now });
  sessions.seed([]);
  sessions.thread({ id: "s1", agent: "claude", createdAt: seconds("2026-11-05T09:00:00Z") });
  assert.equal(sessions.sinceOf("claude", "s1"), Date.parse("2026-11-05T09:00:00Z"));
  // Taken up again later (a thread removed and taken up from the desk): the first time stays.
  sessions.thread({ id: "s1", agent: "claude", createdAt: seconds("2026-11-05T12:00:00Z") });
  assert.equal(sessions.sinceOf("claude", "s1"), Date.parse("2026-11-05T09:00:00Z"));
  // A turn in it changes nothing either.
  sessions.turn("claude", "s1");
  assert.equal(sessions.sinceOf("claude", "s1"), Date.parse("2026-11-05T09:00:00Z"));

  // Taken up only to be read: nothing counts until a turn runs in it.
  sessions.thread({ id: "s2", agent: "pi", createdAt: seconds("2026-11-05T10:00:00Z"), readOnly: true });
  assert.equal(sessions.sinceOf("pi", "s2"), undefined);
  now = Date.parse("2026-11-05T16:30:00Z");
  sessions.turn("pi", "s2");
  assert.equal(sessions.sinceOf("pi", "s2"), now);
  assert.equal(sessions.via("pi", "s2", now - 1), "elsewhere");
  assert.equal(sessions.via("pi", "s2", now), "portals");

  // Every change is saved at once.
  const reread = new PortalsSessions({ folder: usage });
  assert.equal(reread.sinceOf("pi", "s2"), now);
  assert.equal(reread.sinceOf("claude", "s1"), Date.parse("2026-11-05T09:00:00Z"));
});

test("a Droid thread's own sessions count from the thread's since, once it is noted", () => {
  const usage = join(folder(), "usage");
  let aliases: SessionAlias[] = [{ agent: "droid", thread: "thread-1", sessions: ["native-a", "native-b"] }, { agent: "droid", thread: "not-ours", sessions: ["native-x"] }];
  const sessions = new PortalsSessions({ folder: usage, aliases: () => aliases });
  sessions.seed([{ id: "thread-1", agent: "droid", createdAt: seconds("2026-11-04T08:00:00Z") }]);
  sessions.refresh();
  assert.equal(sessions.sinceOf("droid", "native-a"), Date.parse("2026-11-04T08:00:00Z"));
  assert.equal(sessions.sinceOf("droid", "native-b"), Date.parse("2026-11-04T08:00:00Z"));
  assert.equal(sessions.sinceOf("droid", "native-x"), undefined);
  // After a /compact the thread goes on in another session; the old ones stay.
  aliases = [{ agent: "droid", thread: "thread-1", sessions: ["native-c"] }];
  sessions.refresh();
  assert.equal(sessions.sinceOf("droid", "native-c"), Date.parse("2026-11-04T08:00:00Z"));
  assert.equal(sessions.sinceOf("droid", "native-a"), Date.parse("2026-11-04T08:00:00Z"));
  // A source that fails costs nothing.
  const failing = new PortalsSessions({ folder: join(folder(), "usage"), aliases: () => { throw new Error("unreadable"); } });
  failing.refresh();
  assert.equal(failing.size, 0);
});

test("a sessions.json that cannot be used is taken from its .bak; with neither, the threads seed it again", () => {
  const usage = join(folder(), "usage");
  const first = new PortalsSessions({ folder: usage });
  first.seed([{ id: "s1", agent: "claude", createdAt: 100 }]);
  first.thread({ id: "s2", agent: "claude", createdAt: 200 });
  const path = join(usage, "sessions.json");
  assert.ok(existsSync(`${path}.bak`));
  writeFileSync(path, "{ not json");
  const fromBackup = new PortalsSessions({ folder: usage });
  assert.equal(fromBackup.sinceOf("claude", "s1"), 100_000);
  assert.equal(fromBackup.seed([{ id: "s3", agent: "claude", createdAt: 300 }]), false);

  const lost = join(folder(), "usage");
  new PortalsSessions({ folder: lost }).seed([]);
  writeFileSync(join(lost, "sessions.json"), "[]");
  const reseeded = new PortalsSessions({ folder: lost });
  assert.equal(reseeded.seed([{ id: "s4", agent: "codex", createdAt: 400 }]), true);
  assert.equal(reseeded.sinceOf("codex", "s4"), 400_000);
});
