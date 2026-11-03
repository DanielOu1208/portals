import "./environment.ts";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { test } from "node:test";
import { DroidOAuthCallback } from "../src/providers/droid/oauthCallback.ts";

test("OAuth callback binds only loopback, matches one live state on the exact GET path, and never echoes secrets", async (t) => {
  const submissions: unknown[] = [];
  const callback = new DroidOAuthCallback(async (...params) => { submissions.push(params); return { success: true }; });
  t.after(() => callback.close());
  const uri = await callback.uri();
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  callback.remember("server", "SDK-state", "SECRET-state");
  for (const [path, method] of [
    ["/other?code=SECRET-code&state=SECRET-state", "GET"],
    ["/callback?code=SECRET-code&state=wrong", "GET"],
    ["/callback?code=SECRET-code&state=SECRET-state&state=SECRET-state", "GET"],
    ["/callback?code=SECRET-code&code=second&state=SECRET-state", "GET"],
    ["/callback?code=SECRET-code&state=SECRET-state", "POST"],
  ]) {
    const response = await fetch(new URL(path, uri), { method });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not found.");
  }
  assert.deepEqual(submissions, []);
  const complete = `${uri}?code=SECRET-code&state=SECRET-state`;
  const success = await fetch(complete);
  assert.equal(success.status, 200);
  assert.equal(await success.text(), "Signed in. You can close this tab.");
  assert.deepEqual(submissions, [["server", "SECRET-code", "SDK-state"]]);
  assert.equal((await fetch(complete)).status, 404, "a callback cannot be replayed");
  callback.remember("server", "SDK-state", "cancelled");
  callback.forget("server");
  assert.equal((await fetch(`${uri}?code=code&state=cancelled`)).status, 404);
});

test("expired callback state and SDK failures return only a plain 404", async (t) => {
  const callback = new DroidOAuthCallback(async () => { throw new Error("SECRET-code SECRET-state"); });
  t.after(() => callback.close());
  const uri = await callback.uri();
  callback.remember("server", "SDK-state", "expired");
  const now = Date.now;
  Date.now = () => now() + 11 * 60_000;
  try { assert.equal((await fetch(`${uri}?code=code&state=expired`)).status, 404); }
  finally { Date.now = now; }
  callback.remember("server", "SDK-state", "SECRET-state");
  const response = await fetch(`${uri}?code=SECRET-code&state=SECRET-state`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found.");
});

test("a server error after the callback listens is logged, not thrown at the bridge (PR #19 review B6)", async (t) => {
  const callback = new DroidOAuthCallback(async () => ({ success: true }));
  t.after(() => callback.close());
  await callback.uri();
  const server = (callback as unknown as { server: Server }).server;
  assert.doesNotThrow(() => server.emit("error", Object.assign(new Error("accept EMFILE"), { code: "EMFILE" })));
});

test("a callback closed while it is still starting to listen does not listen on afterwards (PR #19 review B6)", async (t) => {
  const callback = new DroidOAuthCallback(async () => ({ success: true }));
  const opening = callback.uri();
  const server = (callback as unknown as { server: Server }).server;
  await callback.close();
  await opening.catch(() => undefined);
  t.after(() => { if (server.listening) server.close(); });
  assert.equal(server.listening, false);
});

test("a provider's redirect saying the person refused ends the sign-in at once, with a plain page (PR #19 review B6)", async (t) => {
  const submissions: unknown[] = [], cancellations: string[] = [];
  const callback = new DroidOAuthCallback(async (...params) => { submissions.push(params); return { success: true }; },
    async (server) => { cancellations.push(server); return { success: true }; });
  t.after(() => callback.close());
  const uri = await callback.uri();
  callback.remember("server", "SDK-state", "SECRET-state");
  assert.equal((await fetch(`${uri}?error=access_denied&state=wrong`)).status, 404);
  const refused = await fetch(`${uri}?error=access_denied&error_description=SECRET-detail&state=SECRET-state`);
  assert.equal(refused.status, 200);
  const page = await refused.text();
  assert.equal(page, "Sign-in was cancelled. You can close this tab.");
  assert.deepEqual(cancellations, ["server"]);
  assert.deepEqual(submissions, []);
  assert.equal((await fetch(`${uri}?code=code&state=SECRET-state`)).status, 404, "the attempt's state is forgotten");
});
