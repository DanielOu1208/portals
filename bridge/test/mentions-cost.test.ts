import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Prompt } from "../src/providers/types.ts";
import { mentionedPaths, mentionsPerMessage, withMentions } from "../src/sessions/mentions.ts";
import { createThread, isEvent, startTestBridge, TestClient } from "./helpers.ts";

test("many distinct mentioned paths keep their order without scanning the preceding paths", () => {
  const paths = Array.from({ length: 4000 }, (_, index) => `file${index}.ts`);
  const text = paths.map((path) => `@${path}`).join(" ");
  const includes = Array.prototype.includes;
  let compared = 0;
  Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) {
    compared += this.length;
    return includes.apply(this, args);
  };
  let found: string[];
  try {
    found = mentionedPaths(`${text} @file0.ts @file3999.ts`);
  } finally {
    Array.prototype.includes = includes;
  }
  assert.deepEqual(found, paths, "each path is resolved once, in the original order");
  assert.ok(compared <= paths.length * 2, `de-duplication scanned ${compared} preceding entries`);
});

test("several explicit mentions parse the message once and keep the same resolved paths", (t) => {
  const text = 'Read @existing.ts and @"space already.txt"';
  const mentions = ["existing.ts", "space already.txt", "new.ts", "new space.txt", "café", "new.ts"];
  const matchAll = String.prototype.matchAll;
  let scans = 0;
  const mock = t.mock.method(String.prototype, "matchAll", function (this: string, ...args: Parameters<typeof matchAll>) {
    scans += 1;
    return matchAll.apply(this, args);
  });
  let written: string;
  try {
    written = withMentions(text, mentions);
  } finally {
    mock.mock.restore();
  }
  assert.equal(written, `${text} @new.ts @"new space.txt" @"café"`);
  assert.deepEqual(mentionedPaths(written), ["space already.txt", "new space.txt", "café", "existing.ts", "new.ts"]);
  assert.equal(scans, 2, "one quoted-path scan and one word scan, regardless of mention count");
});

test("a message with no explicit mentions needs no mention scan", (t) => {
  const mock = t.mock.method(String.prototype, "matchAll", () => { throw new Error("an unnecessary scan"); });
  try {
    assert.equal(withMentions("Read @plain.ts", []), "Read @plain.ts");
  } finally {
    mock.mock.restore();
  }
});

test("an unfinished quoted mention keeps the paths recognized after each appended token", () => {
  assert.equal(withMentions('@"unclosed', ["hello world", "unclosed @"]), '@"unclosed @"hello world"');
});

test("a quoted picked filename keeps any inner mentions recognized by the parser", () => {
  assert.equal(withMentions("", ["notes @file.ts", "file.ts"]), '@"notes @file.ts"');
});

test("an unfinished quoted tail stays linear across the full explicit-mention limit", (t) => {
  const paths = Array.from({ length: 4000 }, (_, index) => `file${index}.ts`);
  const text = `${paths.map((path) => `@${path}`).join(" ")} @"unclosed`;
  const mentions = Array.from({ length: mentionsPerMessage }, (_, index) => `picked${index}.ts`);
  const matchAll = String.prototype.matchAll;
  let scans = 0;
  const mock = t.mock.method(String.prototype, "matchAll", function (this: string, ...args: Parameters<typeof matchAll>) {
    scans += 1;
    return matchAll.apply(this, args);
  });
  const includes = Array.prototype.includes;
  let compared = 0;
  Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) {
    compared += this.length;
    return includes.apply(this, args);
  };
  let written: string;
  try {
    written = withMentions(text, mentions);
  } finally {
    Array.prototype.includes = includes;
    mock.mock.restore();
  }
  assert.equal(written, `${text} ${mentions.map((path) => `@${path}`).join(" ")}`);
  assert.ok(scans <= mentions.length * 2, `${scans} scans exceed one parse per explicit mention`);
  assert.ok(compared <= paths.length * mentions.length * 2, `de-duplication scanned ${compared} preceding entries`);
});

test("a scratch bridge forwards a many-mention prompt without quadratic de-duplication", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mentions-cost-"));
  writeFileSync(join(root, "picked.txt"), "a valid explicit mention\n");
  const provider = new FakeProvider({ directory: join(root, "fake"), delayMs: 0 });
  const startSession = provider.startSession.bind(provider);
  let forwarded = "";
  t.mock.method(provider, "startSession", async (...args: Parameters<typeof startSession>) => {
    const session = await startSession(...args);
    const startTurn = session.startTurn.bind(session);
    t.mock.method(session, "startTurn", (prompt: Prompt) => {
      forwarded = prompt.text;
      // Capture the real forwarded text, but don't echo thousands of words on timers.
      return startTurn({ ...prompt, text: "fixture reply" });
    });
    return session;
  });
  const bridge = await startTestBridge({ providers: new Map([["fake", provider]]), config: { generalFolder: root } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  const thread = await createThread(client);
  const text = Array.from({ length: 4000 }, (_, index) => `@file${index}.ts`).join(" ");
  const includes = Array.prototype.includes;
  let compared = 0;
  Array.prototype.includes = function (this: unknown[], ...args: Parameters<typeof includes>) {
    compared += this.length;
    return includes.apply(this, args);
  };
  try {
    await client.call("prompt.submit", { session_id: thread, profile: "fake", text, mentions: ["picked.txt"] });
    await client.next((frame) => isEvent(frame, "message.complete", thread));
  } finally {
    Array.prototype.includes = includes;
  }
  assert.equal(forwarded, `${text} @picked.txt`);
  assert.ok(compared < 40_000, `gateway de-duplication scanned ${compared} preceding entries`);
});
