import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth, hashPassword, readCookie, sessionCookie, verifyPassword } from "../src/http/auth.ts";

test("a password hash verifies the password and nothing else", async () => {
  const hash = await hashPassword("open sesame");
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("open sesame", hash), true);
  assert.equal(await verifyPassword("open sesame ", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the same password hashes differently each time", async () => {
  const first = await hashPassword("same");
  const second = await hashPassword("same");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("same", second), true);
});

test("a malformed hash matches nothing", async () => {
  for (const stored of ["", "plain", "scrypt$1$2$3", "bcrypt$16384$8$1$c2FsdA==$a2V5", "scrypt$x$8$1$c2FsdA==$a2V5", "scrypt$16384$8$1$$"]) {
    assert.equal(await verifyPassword("anything", stored), false, stored);
  }
});

function makeAuth(clock: { now: number }, overrides: Partial<ConstructorParameters<typeof Auth>[0]> = {}) {
  return hashPassword("pw").then(
    (passwordHash) => new Auth({ credentials: () => ({ username: "dana", passwordHash }), now: () => clock.now, ...overrides }),
  );
}

test("signing in gives a session that mints tickets", async () => {
  const clock = { now: 1_000_000 };
  const auth = await makeAuth(clock);
  assert.deepEqual(await auth.signIn("dana", "wrong"), { kind: "wrong" });
  assert.deepEqual(await auth.signIn("someone", "pw"), { kind: "wrong" });

  const outcome = await auth.signIn("dana", "pw");
  assert.equal(outcome.kind, "signedIn");
  const cookie = `other=1; ${sessionCookie}=${outcome.kind === "signedIn" ? outcome.session : ""}`;
  assert.equal(auth.hasSession(cookie), true);
  assert.equal(auth.hasSession(`${sessionCookie}=forged`), false);
  assert.equal(auth.hasSession(undefined), false);

  // Sessions run out.
  clock.now += auth.sessionLifetimeMs;
  assert.equal(auth.hasSession(cookie), false);
});

test("a ticket works once, and only for its lifetime", async () => {
  const clock = { now: 0 };
  const auth = await makeAuth(clock);
  const ticket = auth.mintTicket();
  assert.equal(auth.takeTicket(ticket), true);
  assert.equal(auth.takeTicket(ticket), false);
  assert.equal(auth.takeTicket("made-up"), false);
  assert.equal(auth.takeTicket(null), false);

  const late = auth.mintTicket();
  clock.now += 30_000;
  assert.equal(auth.takeTicket(late), false);

  const inTime = auth.mintTicket();
  clock.now += 29_999;
  assert.equal(auth.takeTicket(inTime), true);
});

test("without a password set up, sign-in is unavailable", async () => {
  const auth = new Auth({ credentials: () => null });
  assert.equal(auth.isConfigured, false);
  assert.deepEqual(await auth.signIn("dana", "pw"), { kind: "unavailable" });
});

test("too many wrong passwords in a minute are refused without checking", async () => {
  const clock = { now: 0 };
  const auth = await makeAuth(clock, { maxFailures: 3 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await auth.signIn("dana", "nope"), { kind: "wrong" });
  }
  // Even the right password waits until the window has passed.
  assert.deepEqual(await auth.signIn("dana", "pw"), { kind: "limited" });
  clock.now += 60_000;
  assert.equal((await auth.signIn("dana", "pw")).kind, "signedIn");
});

test("cookies are read by name", () => {
  assert.equal(readCookie("a=1; b=two; c=3", "b"), "two");
  assert.equal(readCookie("ab=1", "a"), undefined);
  assert.equal(readCookie(undefined, "a"), undefined);
});

test("password checks still under way count against the failure limit, so a burst cannot bypass it", async () => {
  const clock = { now: 0 };
  const auth = await makeAuth(clock, { maxFailures: 3 });
  const attempts = Array.from({ length: 8 }, () => auth.signIn("dana", "nope"));
  const outcomes = await Promise.all(attempts);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["wrong", "wrong", "wrong", "limited", "limited", "limited", "limited", "limited"]);
  assert.deepEqual(await auth.signIn("dana", "pw"), { kind: "limited" });
  clock.now += 60_000;
  assert.equal((await auth.signIn("dana", "pw")).kind, "signedIn");
});

test("several devices may sign in together and successful checks never use up the failure allowance", async () => {
  const auth = await makeAuth({ now: 0 });
  for (let batch = 0; batch < 3; batch += 1) {
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => auth.signIn("dana", "pw")));
    assert.ok(outcomes.every((outcome) => outcome.kind === "signedIn"));
  }
});
