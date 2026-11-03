import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { nameFrom, titlePrompt } from "../src/providers/codex/naming.ts";

test("a name is read from the title-generation thread's answer: one line, without the quotes and the full stop it was told to leave out", () => {
  assert.equal(nameFrom('{"title":"Update Gray to latest version"}'), "Update Gray to latest version");
  assert.equal(nameFrom('{"title":"  \\"Fix the push retries.\\"  "}'), "Fix the push retries");
  assert.equal(nameFrom(JSON.stringify({ title: "“Check Tokscale logs”" })), "Check Tokscale logs");
  // A quoted or code term at either end keeps its quotes.
  assert.equal(nameFrom(JSON.stringify({ title: 'Run "npm test"' })), 'Run "npm test"');
  assert.equal(nameFrom(JSON.stringify({ title: "Update `config.ts`" })), "Update `config.ts`");
  assert.equal(nameFrom(JSON.stringify({ title: "`main` and `dev` merge" })), "`main` and `dev` merge");
  assert.equal(nameFrom(JSON.stringify({ title: '"a" vs "b"' })), '"a" vs "b"');
  assert.equal(nameFrom('{"title":"Review PR-142\\nand more"}'), "Review PR-142");
  assert.equal(nameFrom('{"title":"   "}'), null);
  assert.equal(nameFrom('{"name":"Fix it"}'), null);
  assert.equal(nameFrom("Fix it"), null);
  assert.equal(nameFrom(JSON.stringify({ title: "x".repeat(200) }))?.length, 80);
});

test("the title prompt is Codex's, with the message after it; a long message is cut", () => {
  const prompt = titlePrompt("Read the brief.");
  assert.match(prompt, /^Generate a concise, single-line task title of at most 40 characters/);
  assert.ok(prompt.endsWith("Recent conversation messages:\n<conversation>\nUser: Read the brief.\n</conversation>"));
  assert.ok(titlePrompt("a".repeat(10_000)).includes(`User: ${"a".repeat(4000)}…\n</conversation>`));
});

test("a name or a first message cut in the middle of an emoji is cut before it, never in half", () => {
  // Cut by UTF-16 units, half of the emoji was left: the name became the thread's title
  // (shown as U+FFFD), and the prompt went to Codex with a lone surrogate.
  const name = `${"a".repeat(78)}\u{1F680}${"b".repeat(10)}`;
  assert.equal(nameFrom(JSON.stringify({ title: name })), `${"a".repeat(78)}…`);
  const message = `${"a".repeat(3999)}\u{1F680}`;
  const prompt = titlePrompt(message);
  assert.ok(prompt.includes(`User: ${"a".repeat(3999)}…`));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(prompt), "no lone high surrogate in the prompt");
});
