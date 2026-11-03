import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { callLink, Links, writeLinks, type Link } from "../src/fleet/links.ts";
import { password, startTestBridge, username } from "./helpers.ts";

// A link made by hand signs in to the other bridge (src/fleet/links.ts): each sign-in it
// tries counts against that bridge's limit, which the person's phone shares.

/** A bridge's sign-in route that refuses every password, once `release` is called, counting the tries. */
async function refusingBridge(t: TestContext): Promise<{ url: string; tries: () => number; release: () => void }> {
  let tries = 0;
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    // A session from before it restarted is not known.
    if (request.url === "/api/auth/ws-ticket") {
      response.writeHead(401).end();
      return;
    }
    if (request.url !== "/auth/password-login") {
      response.writeHead(404).end();
      return;
    }
    tries += 1;
    void released.then(() => response.writeHead(401, { "content-type": "application/json" }).end('{"detail":"no"}'));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tries: () => tries, release };
}

function linksFile(t: TestContext): string {
  const folder = mkdtempSync(join(tmpdir(), "portals-links-signin-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, "links.json");
}

test("calls made at once to a link that has no session sign in once, not once each", async (t) => {
  const other = await refusingBridge(t);
  const path = linksFile(t);
  writeLinks(path, [{ name: "mini", url: other.url, user: username, password: "an old one" }]);
  const links = new Links(path);
  // Twelve listings at once, as several agents and the app may ask together.
  const calls = Array.from({ length: 12 }, () => links.call("mini", "threads.list", {}, 5000, { glance: true }).then(() => "answered", (error: Error) => error.message));
  await sleep(100);
  other.release();
  const said = await Promise.all(calls);
  assert.ok(said.every((message) => /did not take the user name and password/.test(message)), said.join("\n"));
  assert.equal(other.tries(), 1, "one sign-in tried, so the other bridge's limit is not used up");
});

test("a call to a link as it was does not keep the link as it is now from being asked", async (t) => {
  const other = await refusingBridge(t);
  const there = await startTestBridge();
  t.after(() => there.dispose());
  const path = linksFile(t);
  writeLinks(path, [{ name: "mini", url: other.url, user: username, password: "an old one" }]);
  const links = new Links(path);
  // A call under the old password waits for its refusal while the link is made again, right.
  const stale = links.call("mini", "threads.list", {}, 5000).catch((error: Error) => error.message);
  await sleep(50);
  writeLinks(path, [{ name: "mini", url: there.url, user: username, password }]);
  await links.call("mini", "threads.list", {});
  other.release();
  assert.match(String(await stale), /did not take the user name and password/);
  // The refusal of the old one does not rest the new one for ten minutes.
  assert.ok(Array.isArray(((await links.call("mini", "threads.list", {})) as { threads: unknown[] }).threads));
});

test("a call waiting for another to sign in stops when its caller stops waiting", async (t) => {
  const other = await refusingBridge(t);
  const path = linksFile(t);
  writeLinks(path, [{ name: "mini", url: other.url, user: username, password: "an old one" }]);
  const links = new Links(path);
  const first = links.call("mini", "threads.list", {}, 5000).catch(() => undefined);
  const caller = new AbortController();
  const second = links.call("mini", "threads.list", {}, 5000, { signal: caller.signal }).then(() => "answered", (error: Error) => error.message);
  await sleep(20);
  caller.abort(new Error("The caller stopped waiting."));
  assert.equal(await Promise.race([second, sleep(500).then(() => "still waiting")]), "The caller stopped waiting.");
  other.release();
  await first;
});

test("calls made at once with a session the other bridge no longer knows sign in again once, not once each", async (t) => {
  const other = await refusingBridge(t);
  const link: Link = { name: "mini", url: other.url, user: username, password: "an old one" };
  // A session from before the other bridge restarted, with its password changed.
  const sessions = new Map([["mini", "portals_session=old"]]);
  const signIns = new WeakMap<Link, Promise<string>>();
  const calls = Array.from({ length: 12 }, () => callLink(link, "threads.list", {}, 5000, sessions, undefined, undefined, undefined, undefined, signIns).then(() => "answered", (error: Error) => error.message));
  await sleep(100);
  other.release();
  const said = await Promise.all(calls);
  assert.ok(said.every((message) => /did not take the user name and password/.test(message)), said.join("\n"));
  assert.equal(other.tries(), 1);
});

test("a call that would take another's sign-in keeps its own time, and one called off before it starts does not wait", async (t) => {
  const other = await refusingBridge(t);
  const link: Link = { name: "mini", url: other.url, user: username, password: "an old one" };
  const signIns = new WeakMap<Link, Promise<string>>();
  const first = callLink(link, "threads.list", {}, 5000, new Map(), undefined, undefined, undefined, undefined, signIns).catch(() => undefined);
  await sleep(20);
  const began = Date.now();
  await assert.rejects(callLink(link, "threads.list", {}, 100, new Map(), undefined, undefined, undefined, undefined, signIns), { name: "TimeoutError" });
  assert.ok(Date.now() - began < 1000, "within its own 100 ms, not the first call's 5 s");
  const off = new AbortController();
  off.abort(new Error("Called off."));
  await assert.rejects(callLink(link, "threads.list", {}, 5000, new Map(), off.signal, undefined, undefined, undefined, signIns), { message: "Called off." });
  other.release();
  await first;
  assert.equal(other.tries(), 1);
});

test("a call called off while others take its sign-in does not call theirs off", async (t) => {
  const other = await refusingBridge(t);
  const link: Link = { name: "mini", url: other.url, user: username, password: "an old one" };
  const signIns = new WeakMap<Link, Promise<string>>();
  const off = new AbortController();
  const first = callLink(link, "threads.list", {}, 5000, new Map(), off.signal, undefined, undefined, undefined, signIns).then(() => "answered", (error: Error) => error.message);
  await sleep(20);
  const second = callLink(link, "threads.list", {}, 5000, new Map(), undefined, undefined, undefined, undefined, signIns).then(() => "answered", (error: Error) => error.message);
  await sleep(20);
  off.abort(new Error("Called off."));
  assert.equal(await first, "Called off.");
  other.release();
  assert.match(await second, /did not take the user name and password/);
  assert.equal(other.tries(), 1);
});

test("a sign-in others take outlasts a first caller that had less time", async (t) => {
  const other = await refusingBridge(t);
  const link: Link = { name: "mini", url: other.url, user: username, password: "an old one" };
  const signIns = new WeakMap<Link, Promise<string>>();
  const first = callLink(link, "threads.list", {}, 100, new Map(), undefined, undefined, undefined, undefined, signIns).then(() => "answered", (error: Error) => error.name);
  await sleep(20);
  const second = callLink(link, "threads.list", {}, 5000, new Map(), undefined, undefined, undefined, undefined, signIns).then(() => "answered", (error: Error) => error.message);
  assert.equal(await first, "TimeoutError");
  await sleep(100);
  other.release();
  assert.match(await second, /did not take the user name and password/);
  assert.equal(other.tries(), 1);
});
