import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { pathsFor } from "../src/config.ts";
import { cutWhole, wellFormedJSON } from "../src/json.ts";
import { titleFrom } from "../src/providers/titles.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

// What the bridge sends a device is JSON that Swift's JSONDecoder takes: a string cut in
// the middle of a character outside the Basic Multilingual Plane (an emoji) holds half of
// its surrogate pair, which JSON.stringify writes as `\ud83d` alone, and the app's decoder
// refuses the whole frame for it ("Missing low code point in surrogate pair"). The peer
// then skips the frame, so the call it answers never comes back.

/** Whether JSON text holds a surrogate written alone: `\ud800` to `\udfff` after an even run of backslashes. */
function holdsLoneSurrogate(text: string): boolean {
  return /(?<!\\)(?:\\\\)*\\ud[89a-f][0-9a-f]{2}/i.test(text);
}

test("a lone surrogate is sent as U+FFFD; a whole pair, and the text \\ud83d typed as such, are sent as they are", () => {
  assert.equal(cutWhole("a😀😀", 4), "a😀");
  assert.equal(cutWhole("a😀😀", 3), "a😀");
  assert.equal(cutWhole("ab", 4), "ab");
  const cut = "a😀😀".slice(0, 4);
  assert.equal(holdsLoneSurrogate(JSON.stringify({ name: cut })), true);
  assert.deepEqual(JSON.parse(wellFormedJSON({ name: cut })), { name: "a😀�" });
  assert.equal(holdsLoneSurrogate(wellFormedJSON({ name: cut })), false);
  assert.deepEqual(JSON.parse(wellFormedJSON({ name: "\udc00x\ud83d", typed: "\\\udc00" })), { name: "�x�", typed: "\\�" });
  for (const value of [{ name: "a😀" }, { name: "\\ud83d" }, { name: "\\\\\\ud83d😀" }, { list: [1, "two", null] }]) {
    assert.equal(wellFormedJSON(value), JSON.stringify(value));
    assert.equal(holdsLoneSurrogate(wellFormedJSON(value)), false);
  }
});

test("a device whose name is cut in the middle of an emoji as it joins is listed, and told it joined, in JSON every device can read", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const person = await TestClient.open(bridge);
  t.after(() => person.close());
  const { code } = await person.call("net.invite");
  // 81 UTF-16 units: the name is cut to 80, between the halves of the last emoji.
  const name = `a${"😀".repeat(40)}`;
  const joined = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "phone-1234-5678", kind: "device", name, platform: "ios" } }),
  });
  const answer = await joined.text();
  assert.equal(joined.status, 200);
  assert.equal(holdsLoneSurrogate(answer), false, answer.slice(-200));
  const { token } = JSON.parse(answer) as { token: string };

  const device = await TestClient.open(bridge, { token });
  t.after(() => device.close());
  const raw: string[] = [];
  device.socket.on("message", (data) => raw.push(data.toString()));
  const listed = await device.call("net.list");
  const entry = listed.members.find((member: { id: string }) => member.id === "phone-1234-5678");
  assert.equal(entry.name, `a${"😀".repeat(39)}`);
  assert.ok(raw.some((text) => text.includes("phone-1234-5678")));
  assert.equal(raw.some(holdsLoneSurrogate), false);
});

test("a thread titled from its first message, cut in the middle of an emoji, is listed in JSON every device can read", () => {
  // Codex, Droid, Cursor and Pi threads are titled so (providers/titles.ts): 79 units and an ellipsis.
  // Cut between characters, the title holds no half of one; were one there, it would be sent as U+FFFD.
  const title = titleFrom(`${"a".repeat(78)}😀 and the rest`)!;
  assert.equal(title, `${"a".repeat(78)}…`);
  assert.equal(holdsLoneSurrogate(JSON.stringify({ threads: [{ title }] })), false);
  const cut = `${"a".repeat(78)}😀`.slice(0, 79);
  assert.equal(holdsLoneSurrogate(wellFormedJSON({ threads: [{ title: cut }] })), false);
});

test("a name with half of a surrogate pair kept by an older bridge reaches every device as U+FFFD, in net.list and in /net/join's answer", async (t) => {
  const first = await startTestBridge({ keepHome: true });
  const home = first.home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await first.dispose();
  // An older bridge cut a device's name in an emoji and kept it so.
  const path = pathsFor(home).net;
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.members.push({ id: "ipad-0000-1111", kind: "device", name: "iPad \ud83d", platform: "ipados", changed: 1000, by: saved.members[0].id });
  writeFileSync(path, JSON.stringify(saved));
  const bridge = await startTestBridge({ home });
  t.after(() => bridge.dispose());

  const person = await TestClient.open(bridge);
  t.after(() => person.close());
  const { code } = await person.call("net.invite");
  const joined = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "phone-1234-5678", kind: "device", name: "iPhone", platform: "ios" } }),
  });
  const answer = await joined.text();
  assert.equal(joined.status, 200);
  assert.ok(answer.includes("ipad-0000-1111"));
  assert.equal(holdsLoneSurrogate(answer), false, answer);

  const device = await TestClient.open(bridge, { token: (JSON.parse(answer) as { token: string }).token });
  t.after(() => device.close());
  const raw: string[] = [];
  device.socket.on("message", (data) => raw.push(data.toString()));
  const listed = await device.call("net.list");
  assert.equal(listed.members.find((member: { id: string }) => member.id === "ipad-0000-1111").name, "iPad \ufffd");
  assert.equal(raw.some(holdsLoneSurrogate), false);
});
