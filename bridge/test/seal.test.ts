import "./environment.ts";
import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Sender, SendResult } from "../src/push/apns.ts";
import { compose, Notifier, type Payload } from "../src/push/notifier.ts";
import { payloadLimit, placeholder, seal, sealed } from "../src/push/seal.ts";
import { PushStore, type DeviceEntry } from "../src/push/store.ts";

// Sealed notifications (docs/pairing-and-relay.md): the words sealed to the device's key,
// the placeholder in the open.

const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const NONCE = Buffer.from(Array.from({ length: 12 }, (_, index) => 0xa0 + index));
const THREAD_ID = "20261005_000000_root01";
const THREAD = { agent: "karina", agent_name: "Karina", title: "Fix the build" };

/** Opens a seal as the app does: nonce, ciphertext, tag. */
function open(value: string, key = KEY): unknown {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8"));
}

test("a seal is CryptoKit's combined box, and the same as the app's test opens", () => {
  const value = seal({ title: "Karina", subtitle: "Fix the build", body: "Wants to run: rm -rf build — ok?" }, KEY, NONCE);
  // The same string is in Packages/PortalsKit/Tests/AgentCoreTests/SealedNotificationTests.swift.
  assert.equal(
    value,
    "oKGio6SlpqeoqaqrnToIRDGnZ51YR8yydROuv1KAe2Pn1TYF6GJDpEWJM2iqVjOXygIxSDbwYOolWOGWI2JkckCHexA1LSsqy1D3xdqGpR1dhcmSksKdbeaiqJoviz+EqqqmWJPdbpQ9NtLgQHrNgz9YWfok",
  );
  assert.deepEqual(Buffer.from(value, "base64").subarray(0, 12), NONCE);
  assert.deepEqual(open(value), { title: "Karina", subtitle: "Fix the build", body: "Wants to run: rm -rf build — ok?" });
  // Random nonces otherwise: the same words never seal the same way twice.
  assert.notEqual(seal({ title: "a", body: "b" }, KEY), seal({ title: "a", body: "b" }, KEY));
});

test("a sealed payload shows only the placeholder, and keeps what carries no words", () => {
  const payload = { ...compose("approval", THREAD_ID, THREAD, "rm -rf build")! };
  payload.aeriportal = { ...payload.aeriportal, host: "mbp16" };
  const result = sealed(payload, KEY.toString("base64"));
  assert.deepEqual(result.aps, { alert: { ...placeholder }, sound: "default", "thread-id": THREAD_ID, "mutable-content": 1 });
  const { sealed: words, ...rest } = result.aeriportal;
  assert.deepEqual(rest, { thread: THREAD_ID, kind: "approval", agent: "karina", host: "mbp16" });
  assert.deepEqual(open(words!), { title: "Karina", subtitle: "Fix the build", body: "Wants to run: rm -rf build" });
  // Nothing of the words is left in the open.
  assert.ok(!JSON.stringify(result).includes("rm -rf") && !JSON.stringify(result).includes("Fix the build"));
});

test("a sealed payload is cut to fit Apple's 4 KB, the body first", () => {
  const long: Payload = {
    aps: { alert: { title: "名".repeat(400), subtitle: "題".repeat(300), body: "語".repeat(2000) }, sound: "default", "thread-id": THREAD_ID, "mutable-content": 1 },
    aeriportal: { thread: THREAD_ID, kind: "finished", agent: "karina" },
  };
  const result = sealed(long, KEY.toString("base64"));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= payloadLimit);
  const words = open(result.aeriportal.sealed!) as { title: string; subtitle?: string; body: string };
  assert.equal(words.title, "名".repeat(400), "the title is kept while the body can give way");
  assert.ok(words.body.endsWith("…") && words.body.length < 2000);

  // A title too long on its own is cut too, once the body and subtitle are gone.
  const huge: Payload = { ...long, aps: { ...long.aps, alert: { title: "名".repeat(3000), body: "x" } } };
  const cut = sealed(huge, KEY.toString("base64"));
  assert.ok(Buffer.byteLength(JSON.stringify(cut)) <= payloadLimit);
  assert.ok((open(cut.aeriportal.sealed!) as { title: string }).title.endsWith("…"));
});

test("a device whose key is not one gets the placeholder alone, never the words", () => {
  const payload = compose("finished", THREAD_ID, THREAD, "secret plans")!;
  for (const key of ["", "c2hvcnQ=", randomBytes(16).toString("base64")]) {
    const result = sealed(payload, key);
    assert.deepEqual(result.aps.alert, { ...placeholder });
    assert.equal(result.aeriportal.sealed, undefined);
    assert.ok(!JSON.stringify(result).includes("secret plans"));
  }
});

class FakeSender implements Sender {
  readonly sent: { token: string; payload: any }[] = [];
  async send(token: string, _device: DeviceEntry, payload: object): Promise<SendResult> {
    this.sent.push({ token, payload });
    return "sent";
  }
  close(): void {}
}

test("each device gets its own seal; a device without a key gets the words as before", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-seal-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new PushStore(join(directory, "push.json"));
  const sender = new FakeSender();
  const notifier = new Notifier({ store, sender });
  const otherKey = randomBytes(32);
  const device = { environment: "sandbox", bundle_id: "com.danielou.portals" };
  store.register({ device: { ...device, token: "aa".repeat(32), key: KEY.toString("base64") }, threads: [{ id: THREAD_ID, ...THREAD }], host: "mbp16" });
  store.register({ device: { ...device, token: "bb".repeat(32), key: otherKey.toString("base64") }, threads: [{ id: THREAD_ID, ...THREAD }] });
  store.register({ device: { ...device, token: "cc".repeat(32) }, threads: [{ id: THREAD_ID, ...THREAD }] });

  assert.deepEqual(await notifier.handle({ kind: "finished", thread: THREAD_ID, text: "All green" }), ["sent", "sent", "sent"]);
  const [first, second, third] = sender.sent;
  assert.deepEqual(first.payload.aps.alert, { ...placeholder });
  assert.equal(first.payload.aeriportal.host, "mbp16");
  assert.deepEqual(open(first.payload.aeriportal.sealed), { title: "Karina", body: "All green", subtitle: "Fix the build" });
  assert.deepEqual(open(second.payload.aeriportal.sealed, otherKey), { title: "Karina", body: "All green", subtitle: "Fix the build" });
  assert.throws(() => open(second.payload.aeriportal.sealed), "one device's key does not open another's");
  assert.equal(third.payload.aps.alert.body, "All green");
  assert.equal(third.payload.aeriportal.sealed, undefined);
});

test("a title that holds half of an emoji is sealed as words the app can read, the half as U+FFFD", () => {
  // A thread titled by a bridge that cut its title in the middle of an emoji (kept so in
  // the registry), or by an agent's name cut so: JSON.stringify writes the half as an
  // escape of its own, which Swift's JSONDecoder refuses the whole seal for, so the
  // notification extension showed "Portals: New activity" for every notification of it.
  const half = "Fix the build \u{1F680}".slice(0, -1);
  const payload = compose("finished", THREAD_ID, { ...THREAD, title: half }, "All green")!;
  const words = sealed(payload, KEY.toString("base64")).aeriportal.sealed!;
  const bytes = Buffer.from(words, "base64");
  const decipher = createDecipheriv("aes-256-gcm", KEY, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const text = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
  assert.ok(!/\\ud[89a-f]/.test(text), `no half of a pair in ${text}`);
  assert.equal((JSON.parse(text) as { subtitle: string }).subtitle, "Fix the build �");
});
