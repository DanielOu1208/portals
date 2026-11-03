import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathsFor } from "../src/config.ts";
import { parsePairingLink } from "../src/fleet/links.ts";
import { joinLink, parseJoinLink } from "../src/net/net.ts";
import { Apns, type Sender, type SendResult } from "../src/push/apns.ts";
import { compose, imagesNamed, Notifier, preview, previewLimit, redacted, repeatWindow, visualsNamed } from "../src/push/notifier.ts";
import { PushStore, type DeviceEntry, type PushState } from "../src/push/store.ts";
import { pairingLink } from "../src/setup/pairing.ts";
import { createThread, sessionCookie, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// What the bridge notifies about and in what words: the Hermes plugin's (hermes-plugin/
// aeriportal-push/core.py, tests in hermes-plugin/tests/test_plugin.py) plus
// `aeriportal.host` (docs/gateway-protocol.md, sections 10 and 11).

const THREAD = { agent: "karina", agent_name: "Karina", title: "Fix the build" };
const THREAD_ID = "20261005_000000_root01";
const DEVICE = { token: "ab".repeat(32), environment: "sandbox", bundle_id: "com.danielou.aeriportal" };

// MARK: The plugin's words

interface ParityCase {
  name: string;
  kind: string;
  thread_id: string;
  thread: Record<string, string>;
  text: string;
  payload: string | null;
}

test("compose gives exactly the plugin's JSON for the same inputs", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/push/plugin-payloads.json", import.meta.url), "utf8")) as { cases: ParityCase[] };
  assert.ok(fixture.cases.length >= 30);
  for (const item of fixture.cases) {
    const payload = compose(item.kind, item.thread_id, item.thread, item.text);
    assert.equal(payload === null ? null : JSON.stringify(payload), item.payload, item.name);
  }
});

test("a preview is the first line with something on it", () => {
  assert.equal(preview("\n\n  Done.   All  good.\nMore"), "Done. All good.");
  assert.equal(preview(null), "");
  const long = preview("x".repeat(300));
  assert.equal(Array.from(long).length, previewLimit);
  assert.ok(long.endsWith("…"));
});

test("each kind of event has its words", () => {
  const body = (kind: string, text: string) => compose(kind, "t1", THREAD, text)!.aps.alert.body;
  assert.equal(body("approval", "rm -rf build\n# cleanup"), "Wants to run: rm -rf build");
  assert.equal(body("approval", ""), "Needs your approval");
  assert.equal(body("question", "Which language?"), "Which language?");
  assert.equal(body("finished", "All 14 tests pass.\nDetails follow"), "All 14 tests pass.");
  assert.equal(body("finished", ""), "Finished");
  assert.equal(body("failed", "provider did not answer"), "Stopped with an error: provider did not answer");
  assert.equal(compose("something else", "t1", THREAD, "x"), null);
});

test("a visual in a reply is named by its title, so a reply that opens with one is not previewed as its fence", () => {
  const body = (text: string) => compose("finished", "t1", THREAD, text)!.aps.alert.body;
  assert.equal(body('```portals-visual title="Build time"\n<div>x</div>\n```\nAfter it.'), "[Visual: Build time]");
  assert.equal(body("```portals-visual\n<b>x</b>\n```"), "[Visual]");
  assert.equal(body("Here it is:\n\n```portals-visual title=Chart\n<b>x</b>\n```"), "Here it is:");
  assert.equal(visualsNamed("Before.\n\n````portals-visual title='A b' height=3\n```inner```\n````\nAfter."), "Before.\n\n[Visual: A b]\nAfter.");
  // Under the name visuals had at first too.
  assert.equal(body('```portals-widget title="Old"\n<div>x</div>\n```'), "[Visual: Old]");
  // One the reply cut short runs to the end; a tilde fence closes with tildes, as long or longer.
  assert.equal(visualsNamed("```portals-visual title=\"Cut\"\n<div>half"), "[Visual: Cut]");
  // All of its HTML, over many lines, closed or not.
  assert.equal(visualsNamed('Before.\n\n```portals-visual title="Chart"\n<div>a</div>\n\n<div>b</div>\n<script>x()</script>\n```\n\nAfter.'), "Before.\n\n[Visual: Chart]\n\nAfter.");
  assert.equal(visualsNamed("```portals-visual\n<div>a</div>\n<div>b</div>\n\n<p>half"), "[Visual]");
  assert.equal(visualsNamed('~~~portals-visual title="T"\nx\n~~~~\ntail'), "[Visual: T]\ntail");
  // Other code is left as it is.
  for (const text of ["```portals-visuals\nnot one\n```", "```js\nconsole.log(1)\n```", "say `portals-visual` here"]) assert.equal(visualsNamed(text), text);
});

test("a notification names the agent, the thread and where to go, and goes through the app's extension", () => {
  const payload = compose("finished", "t1", THREAD, "Done")!;
  assert.deepEqual(payload.aps.alert, { title: "Karina", subtitle: "Fix the build", body: "Done" });
  assert.equal(payload.aps["thread-id"], "t1");
  assert.equal(payload.aps.sound, "default");
  assert.equal(payload.aps["mutable-content"], 1);
  assert.deepEqual(payload.aeriportal, { thread: "t1", kind: "finished", agent: "karina" });
  assert.deepEqual(compose("finished", "t1", { agent: "aeri" }, "Done")!.aps.alert, { title: "aeri", body: "Done" });
  // A thread registered without its agent still notifies, with no avatar.
  assert.equal("agent" in compose("approval", "t1", { agent_name: "Karina" }, "swift test")!.aeriportal, false);
});

// MARK: Redaction

test("a secret in what happened is masked before it leaves, as Hermes masks it", () => {
  const key = "sk-ant-api03-" + "A1b2C3d4".repeat(6);
  const payload = compose("finished", "t1", THREAD, `The key is ${key} as you asked`)!;
  assert.equal(payload.aps.alert.body, "The key is sk-ant...C3d4 as you asked");
  const titled = compose("finished", "t1", { ...THREAD, title: `Rotate ${key}` }, "Done")!;
  assert.equal(titled.aps.alert.subtitle, "Rotate sk-ant...C3d4");
});

test("the usual shapes of secrets are masked, and ordinary text is left alone", () => {
  const cases: [string, string][] = [
    ["export OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz", "export OPENAI_API_KEY=abcdef...wxyz"],
    ['DB_PASSWORD="hunter2"', 'DB_PASSWORD="***"'],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'", "curl -H 'Authorization: Bearer abcdef...0123'"],
    ["x-api-key: 0123456789abcdef0123", "x-api-key: 012345...0123"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", "token ghp_ab...6789 here"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAAB...MNOP"],
    ["postgres://app:s3cret@db.local/app", "postgres://app:***@db.local/app"],
    ["git remote set-url origin https://ghtoken123456@github.com/x/y", "git remote set-url origin https://***@github.com/x/y"],
    ["eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJ0ZWFtIn0.c2lnbmF0dXJl", "eyJhbG...dXJl"],
    ["-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----", "[REDACTED PRIVATE KEY]"],
    // Not secrets.
    ["KEYBOARD=us MAX_TOKENS=100 HOME_PATH=/Users/dev TOKEN=$TOKEN", "KEYBOARD=us MAX_TOKENS=100 HOME_PATH=/Users/dev TOKEN=$TOKEN"],
    ["Ran swift test: 14 passed, see https://example.com/docs?page=2", "Ran swift test: 14 passed, see https://example.com/docs?page=2"],
    ["task-12345 and sk-short", "task-12345 and sk-short"],
  ];
  for (const [text, expected] of cases) assert.equal(redacted(text), expected, text);
});

test("Portals pairing and join links have their credentials masked in notification bodies and titles", () => {
  const links = [
    [pairingLink({ url: "https://mac.test", user: "me", password: "fake-pair-value", name: "Mac" }), "password"],
    [joinLink({ url: "https://mac.test", code: "fake-join-value", name: "Mac" }), "code"],
    [pairingLink({ url: "https://mac.test", user: "me", password: "fake ?&=# value", name: "Mac" }), "password"],
    [pairingLink({ url: "https://mac.test", user: "o'connor", password: "fake-pair-value", name: "Mac" }), "password"],
    [pairingLink({ url: "https://mac.test", user: "me", password: "'fake-pair-value", name: "Mac" }), "password"],
    [pairingLink({ url: "https://mac.test", user: "me", password: "fake'pair'value", name: "Mac" }), "password"],
    [joinLink({ url: "https://mac.test", code: "'fake-join-value", name: "Mac" }), "code"],
  ];
  for (const [link, credential] of links) {
    const before = new URL(link);
    const masked = new URL(redacted(link));
    assert.equal(masked.searchParams.get(credential), "***");
    assert.equal(masked.searchParams.get("name"), "Mac");
    assert.equal(masked.searchParams.get("url"), before.searchParams.get("url"));
    const payload = compose("finished", "t1", { ...THREAD, title: link }, link)!;
    assert.ok(payload.aps.alert.body.includes(`${credential}=***`));
    assert.ok(payload.aps.alert.subtitle?.includes(`${credential}=***`));
  }
  const ordinary = "https://example.com/docs?code=example&page=2";
  assert.equal(redacted(ordinary), ordinary);
});

// MARK: When, and to whom

test("adjacent Markdown Portals links mask every credential", () => {
  for (const kind of ["join", "pair"]) {
    const key = kind === "join" ? "code" : "password";
    const links = `[A](portals://${kind}?${key}=FIRSTSECRET&url=https://m)[B](portals://${kind}?${key}=SECONDSECRET&url=https://m)`;
    assert.equal(redacted(links).includes("FIRSTSECRET"), false);
    assert.equal(redacted(links).includes("SECONDSECRET"), false);
    const payload = compose("finished", "t1", { ...THREAD, title: links }, links)!;
    assert.equal(JSON.stringify(payload).includes("SECONDSECRET"), false);
  }
});

test("literal schemes in query values do not hide later pairing credentials", () => {
  for (const name of ["portals://foo", "portals://pair"]) {
    const link = `portals://pair?url=https://m&user=u&name=${name}&%70assword=RAWSECRET`;
    assert.equal(parsePairingLink(link).password, "RAWSECRET");
    assert.equal(redacted(link).includes("RAWSECRET"), false);
  }
  const adjacent = "[A](portals://other)[B](portals://join?code=SECONDSECRET&url=https://m)";
  assert.equal(redacted(adjacent).includes("SECONDSECRET"), false);
});

test("many unrelated Portals schemes do not repeatedly parse the remaining text", () => {
  const text = "portals://other/path?name=".repeat(1000);
  const NativeURL = globalThis.URL;
  let parsed = 0;
  globalThis.URL = class extends NativeURL {
    constructor(value: string | URL, base?: string | URL) {
      parsed += String(value).length;
      super(value, base);
    }
  };
  try {
    assert.equal(redacted(text), text);
  } finally {
    globalThis.URL = NativeURL;
  }
  assert.ok(parsed <= text.length, `parsed ${parsed} characters from ${text.length}`);
});

test("equivalent Portals links are parsed and masked before previewing", () => {
  const pair = pairingLink({ url: "https://mac.example", user: "owner", password: "synthetic-credential", name: "Mac" });
  const join = joinLink({ url: "https://mac.example", code: "synthetic-credential", name: "Mac" });
  for (const [name, link] of [
    ["password", pair.replace("password=", "%70ass%77ord=")],
    ["code", join.replace("code=", "%63ode=")],
    ["password", pair.replace("pair?", "pair/?")],
    ["code", join.replace("join?", "join/enter?")],
  ]) {
    const parsed = name === "password" ? parsePairingLink(link) : parseJoinLink(link);
    assert.ok(Object.values(parsed).includes("synthetic-credential"));
    assert.equal(new URL(redacted(link)).searchParams.get(name), "***");
    const payload = compose("finished", "t1", { ...THREAD, title: link }, link)!;
    assert.ok(!JSON.stringify(payload).includes("synthetic-credential"));
    assert.equal(new URL(redacted(link)).searchParams.get("name"), "Mac");
  }
});

class FakeSender implements Sender {
  result: SendResult = "sent";
  readonly sent: { token: string; payload: any; collapseID: string }[] = [];
  closed = false;

  async send(token: string, _device: DeviceEntry, payload: object, collapseID = ""): Promise<SendResult> {
    this.sent.push({ token, payload, collapseID });
    return this.result;
  }

  close(): void {
    this.closed = true;
  }
}

function setUp(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "portals-notifier-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "push.json");
  const store = new PushStore(path);
  const sender = new FakeSender();
  const clock = { now: 1_000_000 };
  const notifier = new Notifier({ store, sender, now: () => clock.now });
  const registered = (host?: string) => store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }], host });
  const event = (kind: "approval" | "question" | "finished" | "failed", text = "", thread = THREAD_ID) => notifier.handle({ kind, thread, text });
  return { store, path, sender, clock, notifier, registered, event };
}

test("removing a watcher leaves other devices and legacy broadcasts alone", async (t) => {
  const { store, sender, registered, event } = setUp(t);
  registered();
  const other = { ...DEVICE, token: "cd".repeat(32) };
  store.register({ device: other, threads: [{ id: THREAD_ID, ...THREAD }] });
  store.register({ device: DEVICE, threads: [{ id: "other-thread", ...THREAD }] });
  store.register({ threads: [{ id: "legacy", ...THREAD }] });

  store.removeWatcher(THREAD_ID, DEVICE.token);
  assert.deepEqual(await event("question", "?"), ["sent"]);
  assert.deepEqual(sender.sent.map((entry) => entry.token), [other.token]);
  assert.deepEqual(store.state().threads["other-thread"].devices, [DEVICE.token]);
  assert.deepEqual(Object.keys(store.state().devices), [DEVICE.token, other.token]);
  store.removeWatcher(THREAD_ID, DEVICE.token);
  store.removeWatcher("unknown", DEVICE.token);
  store.removeWatcher("legacy", DEVICE.token);
  assert.deepEqual(store.state().threads.legacy.devices, []);
  assert.deepEqual(await event("approval", "ls", "legacy"), ["sent", "sent"]);
  store.removeWatcher(THREAD_ID, other.token);
  assert.equal(store.state().threads[THREAD_ID], undefined);
  assert.deepEqual(await event("approval", "ls"), []);
});

test("a thread the app did not register is ignored", async (t) => {
  const { sender, registered, event } = setUp(t);
  registered();
  assert.deepEqual(await event("approval", "ls", "someone-elses-thread"), []);
  assert.deepEqual(await event("finished", "Done", "someone-elses-thread"), []);
  assert.deepEqual(sender.sent, []);
});

test("an approval and a question notify at once, collapsed per thread and kind", async (t) => {
  const { sender, registered, event } = setUp(t);
  registered();
  assert.deepEqual(await event("approval", "swift test"), ["sent"]);
  assert.deepEqual(await event("question", "Python or Swift?"), ["sent"]);
  const [first, second] = sender.sent;
  assert.equal(first.token, DEVICE.token);
  assert.equal(first.payload.aps.alert.body, "Wants to run: swift test");
  assert.deepEqual(first.payload.aeriportal, { thread: THREAD_ID, kind: "approval", agent: "karina" });
  assert.equal(first.collapseID, `${THREAD_ID}-approval`);
  assert.equal(second.payload.aeriportal.kind, "question");
  assert.equal(second.collapseID, `${THREAD_ID}-question`);
});

test("the same request asked again within a minute notifies once", async (t) => {
  const { sender, clock, registered, event } = setUp(t);
  registered();
  assert.deepEqual(await event("approval", "swift test"), ["sent"]);
  assert.deepEqual(await event("approval", "swift test"), []);
  // Another command is another request, and so is the same one later on.
  assert.deepEqual(await event("approval", "swift build"), ["sent"]);
  clock.now += repeatWindow + 1;
  assert.deepEqual(await event("approval", "swift build"), ["sent"]);
  assert.equal(sender.sent.length, 3);
  // Two turns that end with the same words are two notifications.
  assert.deepEqual(await event("finished", "Done"), ["sent"]);
  assert.deepEqual(await event("finished", "Done"), ["sent"]);
});

test("a device that no longer wants notifications is forgotten", async (t) => {
  const { store, sender, registered, event } = setUp(t);
  registered();
  sender.result = "gone";
  assert.deepEqual(await event("approval", "ls"), ["gone"]);
  assert.deepEqual(store.state().devices, {});
  assert.deepEqual(await event("question", "?"), []);
});

test("a late refusal of an old registration does not forget its corrected replacement", async (t) => {
  const { store, sender, registered, event } = setUp(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  registered();
  let started!: () => void;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const send = sender.send.bind(sender);
  sender.send = async (...args) => {
    started();
    await held;
    return send(...args);
  };
  sender.result = "gone";
  const notified = event("finished", "Done");
  await sending;
  store.register({ device: { ...DEVICE, environment: "production" }, threads: [] });
  release();
  assert.deepEqual(await notified, ["gone"]);
  assert.equal(store.state().devices[DEVICE.token]?.environment, "production");
  sender.result = "sent";
  assert.deepEqual(await event("question", "?"), ["sent"]);
});

test("a slow notification send does not keep a removed member or an unwatched thread in its old snapshot", async (t) => {
  const changes = [
    { name: "dropMembers", apply: (store: PushStore, _token: string) => store.dropMembers(["phone-removed-0002"]) },
    { name: "unwatch", apply: (store: PushStore, _token: string) => store.unwatch(THREAD_ID) },
    { name: "removeWatcher", apply: (store: PushStore, token: string) => store.removeWatcher(THREAD_ID, token) },
  ];
  for (const change of changes) {
    await t.test(change.name, async (t) => {
      const { store, sender, event } = setUp(t);
      const other = { ...DEVICE, token: "cd".repeat(32) };
      store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }] }, "phone-kept-0001");
      store.register({ device: other, threads: [{ id: THREAD_ID, ...THREAD }] }, "phone-removed-0002");
      let started!: () => void;
      let release!: () => void;
      const sending = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send = sender.send.bind(sender);
      sender.send = async (...args) => {
        if (args[0] === DEVICE.token) {
          started();
          await held;
        }
        return send(...args);
      };
      const notified = event("finished", "Private result");
      await sending;
      change.apply(store, other.token);
      release();
      assert.deepEqual(await notified, ["sent"]);
      assert.deepEqual(sender.sent.map((entry) => entry.token), [DEVICE.token]);
    });
  }
});

test("a thread notifies the devices that registered it; one registered without a device notifies every device", async (t) => {
  const { store, sender, clock, event } = setUp(t);
  const phone = DEVICE;
  const simulator = { ...DEVICE, token: "cd".repeat(32) };
  store.register({ device: phone, threads: [{ id: THREAD_ID, ...THREAD }] });
  store.register({ device: simulator, threads: [{ id: "simulator-thread", agent: "karina", agent_name: "", title: "" }] });
  assert.deepEqual(await event("question", "?"), ["sent"]);
  assert.deepEqual(await event("question", "?", "simulator-thread"), ["sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [phone.token, simulator.token]);

  store.register({ threads: [{ id: "anyone", agent: "karina", agent_name: "", title: "" }] });
  assert.deepEqual(await event("question", "?", "anyone"), ["sent", "sent"]);

  store.dropDevice(phone.token);
  clock.now += repeatWindow + 1;
  assert.deepEqual(await event("question", "?"), []);
});

test("a device that muted a kind gets none of it, and the other devices still do", async (t) => {
  const { store, sender, event } = setUp(t);
  const phone = { ...DEVICE, muted: ["finished" as const, "failed" as const] };
  const iPad = { ...DEVICE, token: "cd".repeat(32), muted: ["approval" as const] };
  store.register({ device: phone, threads: [{ id: THREAD_ID, ...THREAD }] });
  store.register({ device: iPad, threads: [{ id: THREAD_ID, ...THREAD }] });
  assert.deepEqual(await event("finished", "Done."), ["sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [iPad.token]);
  assert.deepEqual(await event("approval", "rm -rf build"), ["sent"]);
  assert.deepEqual(await event("question", "Which one?"), ["sent", "sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [iPad.token, phone.token, phone.token, iPad.token]);
  // Unmuted again.
  store.register({ device: { ...DEVICE, muted: [] }, threads: [] });
  assert.deepEqual(await event("failed", "It broke."), ["sent", "sent"]);
});

test("a thread unwatched while push.json cannot be written notifies nobody, and a device registering it again is its only watcher", async (t) => {
  const { store, path, sender, event } = setUp(t);
  const tablet = { ...DEVICE, token: "cd".repeat(32) };
  store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }] });
  // The file stays as it is: its temporary file is in the way.
  const blocker = `${path}.${process.pid}.tmp`;
  mkdirSync(blocker);
  assert.throws(() => store.unwatch(THREAD_ID));
  assert.ok(THREAD_ID in JSON.parse(readFileSync(path, "utf8")).threads);
  assert.deepEqual(await event("finished", "Done"), []);
  // A registration that cannot be saved does not bring the old watchers back either.
  assert.throws(() => store.register({ device: tablet, threads: [{ id: THREAD_ID, ...THREAD }] }));
  assert.deepEqual(await event("failed", "Broke"), []);

  rmSync(blocker, { recursive: true });
  store.register({ device: tablet, threads: [{ id: THREAD_ID, ...THREAD }] });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).threads[THREAD_ID].devices, [tablet.token]);
  assert.deepEqual(await event("finished", "Done again"), ["sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [tablet.token]);
});

/** A push store whose file can be read only so many more times; after that it reads as nothing, as one that cannot be read. */
class FadingStore extends PushStore {
  readsLeft = Infinity;

  override state(): PushState {
    return this.readsLeft-- > 0 ? super.state() : { devices: {}, threads: {} };
  }
}

test("a thread taken off the bridge's list is forgotten from push.json as read once: a file that cannot be read a moment later is not emptied", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-notifier-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "push.json");
  const store = new FadingStore(path);
  store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }, { id: "kept", ...THREAD }] });
  store.readsLeft = 1;
  store.forget(THREAD_ID);
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual([Object.keys(file.devices), Object.keys(file.threads)], [[DEVICE.token], ["kept"]]);
});

test("a registration that changes nothing leaves push.json as it is, and one that changes anything is saved", (t) => {
  const { store, path } = setUp(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const key = Buffer.alloc(32, 9).toString("base64");
  const phone = { ...DEVICE, relay_token: "v1.claims.signature", key };
  const threads = [
    { id: THREAD_ID, ...THREAD },
    { id: "second", ...THREAD, title: "Naïve café 日本語" },
  ];
  /** Registers, a minute on, and says whether the file was written: every write puts a new file in its place. */
  const written = (registration: Parameters<PushStore["register"]>[0]) => {
    const before = statSync(path).ino;
    t.mock.timers.tick(60_000);
    const answer = store.summary(store.register(registration));
    return { written: statSync(path).ino !== before, ...answer };
  };
  store.register({ device: phone, threads, host: "mbp16" });
  const first = readFileSync(path, "utf8");
  assert.equal(JSON.parse(first).devices[DEVICE.token].updated_at, 1_800_000_000);

  // What the app sends at every connect: the same again. Nothing is written, and the answer is the same.
  assert.deepEqual(written({ device: phone, threads, host: "mbp16" }), { written: false, devices: 1, threads: 2, apns_configured: false });
  // The same without what a registration may leave out, which the file keeps; and fewer threads.
  assert.deepEqual(written({ device: DEVICE, threads: [threads[1]], host: "mbp16" }), { written: false, devices: 1, threads: 2, apns_configured: false });
  assert.equal(readFileSync(path, "utf8"), first);

  // Anything else is saved, with its time.
  const tablet = { ...DEVICE, token: "cd".repeat(32) };
  const changes: Parameters<PushStore["register"]>[0][] = [
    { device: phone, threads: [...threads, { id: "third", ...THREAD }], host: "mbp16" },
    { device: phone, threads: [{ ...threads[0], title: "Fix the build, again" }], host: "mbp16" },
    { device: phone, threads: [{ ...threads[0], title: "Fix the build, again", agent_name: "Winter" }], host: "mbp16" },
    { device: phone, threads: [], host: "mini" },
    { device: phone, threads: [] },
    { device: { ...phone, environment: "production" }, threads: [] },
    { device: { ...phone, environment: "production", relay_token: "v1.new.token" }, threads: [] },
    { device: { ...phone, environment: "production", relay_token: "v1.new.token", key: Buffer.alloc(32, 7).toString("base64") }, threads: [] },
    { device: { ...phone, environment: "production", bundle_id: "com.example.other" }, threads: [] },
    { device: tablet, threads: [threads[1]] },
  ];
  for (const [index, change] of changes.entries()) {
    assert.equal(written(change).written, true, `change ${index}`);
    assert.equal(written(change).written, false, `change ${index}, sent again`);
  }
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.threads.second.devices, [DEVICE.token, tablet.token]);
  assert.deepEqual([file.devices[DEVICE.token].bundle_id, file.devices[DEVICE.token].relay_token, file.devices[DEVICE.token].key, file.threads[THREAD_ID].agent_name], ["com.example.other", "v1.claims.signature", key, "Winter"]);
  // An entry's time is when it last changed.
  assert.equal(file.threads.third.updated_at, 1_800_000_000 + 3 * 60);

  // A thread unwatched while the file could not be written is still in it: the next registration takes it out, though it changes nothing else.
  const blocker = `${path}.${process.pid}.tmp`;
  mkdirSync(blocker);
  assert.throws(() => store.unwatch("third"));
  rmSync(blocker, { recursive: true });
  assert.ok("third" in JSON.parse(readFileSync(path, "utf8")).threads);
  assert.equal(written({ device: tablet, threads: [threads[1]] }).written, true);
  assert.equal("third" in JSON.parse(readFileSync(path, "utf8")).threads, false);
});

test("a registration or an unwatch while push.json cannot be read leaves the file as it is, and the thread unwatched leaves it at the next write", async (t) => {
  const { store, path, sender, event } = setUp(t);
  const tablet = { ...DEVICE, token: "cd".repeat(32) };
  store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }, { id: "other", ...THREAD }], host: "mbp16" });
  const held = readFileSync(path, "utf8");

  // There, and not to be read: what is read as nothing must not be written over it.
  chmodSync(path, 0o000);
  assert.throws(() => store.register({ device: tablet, threads: [{ id: "the tablet's", ...THREAD }] }), /push\.json/);
  assert.throws(() => store.unwatch("other"), /push\.json/);
  chmodSync(path, 0o600);
  assert.equal(readFileSync(path, "utf8"), held);

  // The phone's registration is still there, and the thread unwatched meanwhile notifies nobody.
  assert.deepEqual(await event("finished", "Done"), ["sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [DEVICE.token]);
  assert.deepEqual(await event("finished", "Done", "other"), []);
  // The tablet registers again at its next connect, and the file then has both devices and no thread unwatched.
  store.register({ device: tablet, threads: [{ id: "the tablet's", ...THREAD }] });
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual([Object.keys(file.devices), Object.keys(file.threads)], [[DEVICE.token, tablet.token], [THREAD_ID, "the tablet's"]]);

  // A file that is not there, or not JSON, is a new one, as before.
  writeFileSync(path, "{ not json");
  store.register({ device: tablet, threads: [] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).devices), [tablet.token]);
  rmSync(path);
  store.register({ device: DEVICE, threads: [] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).devices), [DEVICE.token]);
});

test("each device's notification names this bridge as that device's app calls it", async (t) => {
  const { store, sender, event } = setUp(t);
  store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }], host: "mbp16" });
  store.register({ device: { ...DEVICE, token: "cd".repeat(32) }, threads: [{ id: THREAD_ID, ...THREAD }] });
  assert.deepEqual(await event("finished", "Done"), ["sent", "sent"]);
  const [withHost, without] = sender.sent;
  assert.equal(
    JSON.stringify(withHost.payload),
    '{"aps":{"alert":{"title":"Karina","body":"Done","subtitle":"Fix the build"},"sound":"default","thread-id":"20261005_000000_root01","mutable-content":1},' +
      '"aeriportal":{"thread":"20261005_000000_root01","kind":"finished","agent":"karina","host":"mbp16"}}',
  );
  // Registered without a host (as Hermes's plugin is): the plugin's payload exactly.
  assert.equal(JSON.stringify(without.payload), JSON.stringify(compose("finished", THREAD_ID, THREAD, "Done")));
});

test("sessions' questions and turn ends become notifications; an interrupted turn none", async (t) => {
  const { sender, notifier, registered } = setUp(t);
  registered();
  notifier.requestOpened(THREAD_ID, { id: "srq-1", method: "approval", params: { session_id: THREAD_ID, command: "rm -rf ./fake-build", choices: ["once", "deny"] } });
  notifier.requestOpened(THREAD_ID, { id: "srq-2", method: "approval", params: { session_id: THREAD_ID, command: "", description: "Claude has a plan" } });
  notifier.requestOpened(THREAD_ID, {
    id: "srq-3",
    method: "clarify",
    params: { session_id: THREAD_ID, questions: [{ qid: "q0", question: "Which language should I use?", choices: ["Python", "Swift"] }, { qid: "q1", question: "Name?" }] },
  });
  notifier.requestOpened(THREAD_ID, { id: "srq-4", method: "something.else", params: {} });
  // Put again after a restart of the bridge (questions asked without waiting): notified when asked.
  notifier.requestOpened(THREAD_ID, { id: "srq-5", method: "clarify", params: { session_id: THREAD_ID, async: true, questions: [{ qid: "q0", question: "Which colour?" }] }, again: true });
  notifier.turnEnded(THREAD_ID, "interrupted", "Half an answ");
  notifier.turnEnded(THREAD_ID, "complete", "Fixed it.\nThe token is loaded first.");
  notifier.turnEnded(THREAD_ID, "error", "The fake agent failed on purpose.");
  notifier.turnEnded(THREAD_ID, "complete", "");
  await notifier.idle();
  assert.deepEqual(
    sender.sent.map((sent) => [sent.payload.aeriportal.kind, sent.payload.aps.alert.body]),
    [
      ["approval", "Wants to run: rm -rf ./fake-build"],
      ["approval", "Wants to run: Claude has a plan"],
      ["question", "Which language should I use?"],
      ["finished", "Fixed it."],
      ["failed", "Stopped with an error: The fake agent failed on purpose."],
      ["finished", "Finished"],
    ],
  );
});

test("a sender that throws costs that notification only", async (t) => {
  const { sender, notifier, registered } = setUp(t);
  registered();
  const send = sender.send.bind(sender);
  let calls = 0;
  sender.send = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    return send(...args);
  };
  notifier.turnEnded(THREAD_ID, "complete", "first");
  notifier.turnEnded(THREAD_ID, "complete", "second");
  await notifier.idle();
  assert.deepEqual(sender.sent.map((sent) => sent.payload.aps.alert.body), ["second"]);
});

// MARK: Through the bridge

test("a scratch bridge keeps a corrected registration after a late APNs refusal", async (t) => {
  let started!: () => void;
  let release!: (result: SendResult) => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<SendResult>((resolve) => { release = resolve; });
  const sent: { device: DeviceEntry; payload: object }[] = [];
  // No APNs connection or key is used: only the sender's asynchronous result is faked.
  t.mock.method(Apns.prototype, "send", async (_token: string, device: DeviceEntry, payload: object): Promise<SendResult> => {
    sent.push({ device, payload });
    if (sent.length !== 1) return "sent";
    started();
    return held;
  });
  const bridge = await startTestBridge({ config: { apns: { keyPath: "/unused-synthetic-key.p8", keyId: "TESTKEY", teamId: "TESTTEAM" } } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    release("failed");
    await client.close();
    await bridge.dispose();
  });
  const cookie = await sessionCookie(bridge);
  const thread = await createThread(client);
  const title = pairingLink({ url: "https://mac.example", user: "owner", password: "synthetic-credential", name: "Mac" }).replace("password=", "%70ass%77ord=");
  const register = async (environment: string) => {
    const response = await fetch(`${bridge.url}/api/plugins/aeriportal-push/registration`, {
      method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ device: { ...DEVICE, environment }, threads: [{ id: thread, agent: "fake", title }] }),
    });
    assert.equal(response.status, 200);
    await response.json();
  };
  const turn = async (text: string) => {
    await client.call("prompt.submit", { session_id: thread, text, profile: "fake" });
    await client.next((frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === thread);
  };
  await register("sandbox");
  await turn("first notification");
  await sending;
  await register("production");
  release("gone");
  // The next gateway round trip follows the old send's settled continuation.
  await client.call("net.list");
  const state = JSON.parse(readFileSync(pathsFor(bridge.home).push, "utf8")) as PushState;
  assert.equal(state.devices[DEVICE.token]?.environment, "production");
  await turn("second notification");
  await bridge.close(); // includes both queued notification results
  assert.deepEqual(sent.map(({ device }) => device.environment), ["sandbox", "production"]);
  assert.ok(JSON.stringify(sent.map(({ payload }) => payload)).includes("password=***"));
  assert.equal(JSON.stringify(sent.map(({ payload }) => payload)).includes("synthetic-credential"), false);
});

test("the fake agent's approvals, questions and turns notify through the bridge, with the host", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-dry-run-"));
  const dryRun = join(directory, "push.jsonl");
  const bridge: TestBridge = await startTestBridge({ config: { push: { dryRun } } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const cookie = await sessionCookie(bridge);
  const register = (body: unknown) =>
    fetch(`${bridge.url}/api/plugins/aeriportal-push/registration`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const watched = await createThread(client);
  const unwatched = await createThread(client);
  const response = await register({ device: DEVICE, host: "debug-2", threads: [{ id: watched, agent: "fake", agent_name: "Fake agent", title: "Try push" }] });
  assert.deepEqual(await response.json(), { devices: 1, threads: 1, apns_configured: false });

  const lines = () => {
    try {
      return readFileSync(dryRun, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const turn = async (session: string, text: string, answer?: (request: any) => unknown) => {
    await client.call("prompt.submit", { session_id: session, text, profile: "fake" });
    if (answer) {
      const request = await client.nextRequest();
      client.answer(request.id, answer(request));
    }
    await client.next((frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === session);
  };

  await turn(watched, "approve this", () => ({ choice: "once" }));
  await turn(watched, "ask me", (request) => ({ answers: { [request.params.questions[0].qid]: "Swift" } }));
  await turn(watched, "fail please");
  await client.call("prompt.submit", { session_id: watched, text: "slowly now", profile: "fake" });
  await client.next((frame) => frame.method === "event" && frame.params.type === "message.delta" && frame.params.session_id === watched);
  await client.call("session.interrupt", { session_id: watched });
  await client.next((frame) => frame.method === "event" && frame.params.type === "message.complete" && frame.params.session_id === watched);
  await turn(unwatched, "approve that", () => ({ choice: "deny" }));
  await turn(unwatched, "hello");
  await bridge.close(); // waits for what is queued

  const written = lines();
  assert.equal(statSync(dryRun).mode & 0o777, 0o600);
  const expected = (kind: string, body: string) => ({
    device: DEVICE.token.slice(0, 8),
    environment: "sandbox",
    topic: "com.danielou.aeriportal",
    collapse_id: `${watched}-${kind}`,
    payload: {
      aps: { alert: { title: "Fake agent", body, subtitle: "Try push" }, sound: "default", "thread-id": watched, "mutable-content": 1 },
      aeriportal: { thread: watched, kind, agent: "fake", host: "debug-2" },
    },
  });
  assert.deepEqual(written, [
    expected("approval", "Wants to run: rm -rf ./fake-build"),
    expected("finished", "The command ran. Hello from the fake agent. You said: approve this."),
    expected("question", "Which language should I use?"),
    expected("finished", "You chose Swift. Hello from the fake agent. You said: ask me."),
    expected("failed", "Stopped with an error: The fake agent failed on purpose."),
  ]);
});

test("an image a reply shows is named in its notification, not written out as its Markdown", () => {
  assert.equal(imagesNamed("![The chart](/tmp/chart.png)"), "[Image: The chart]");
  assert.equal(imagesNamed("See ![](</tmp/a b.png>) here"), "See [Image] here");
  assert.equal(imagesNamed('![Plot](plot.png "A title") and ![Two](/w/two.jpg)'), "[Image: Plot] and [Image: Two]");
  // A link is left as it is.
  assert.equal(imagesNamed("[docs](https://example.com)"), "[docs](https://example.com)");
  const payload = compose("finished", "t1", { agent_name: "Claude Code" }, "![Sales by month](/tmp/sales.png)\n\nThe chart shows a rise.");
  assert.equal(payload?.aps.alert.body, "[Image: Sales by month]");
});

test("a device of a member out of the net gets no notification, also when its registration could not be forgotten", async (t) => {
  const { store, path, sender, notifier, event } = setUp(t);
  const tablet = { ...DEVICE, token: "cd".repeat(32) };
  store.register({ device: DEVICE, threads: [{ id: THREAD_ID, ...THREAD }] }, "phone-1234-5678");
  store.register({ device: tablet, threads: [{ id: THREAD_ID, ...THREAD }] }, "ipad-1234-5678");
  // The phone is removed from the net while push.json cannot be written: its registration stays.
  const blocker = `${path}.${process.pid}.tmp`;
  mkdirSync(blocker);
  assert.throws(() => store.dropMembers(["phone-1234-5678"]));
  rmSync(blocker, { recursive: true });
  assert.ok(DEVICE.token in JSON.parse(readFileSync(path, "utf8")).devices);
  notifier.inNet = (member) => member !== "phone-1234-5678";
  assert.deepEqual(await event("finished", "Done."), ["sent"]);
  assert.deepEqual(sender.sent.map((sent) => sent.token), [tablet.token]);
});
