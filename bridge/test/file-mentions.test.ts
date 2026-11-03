import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { historyFromSession } from "../src/providers/claude/history.ts";
import { ClaudeProvider } from "../src/providers/claude/provider.ts";
import { checkMentions, claudeMentionLimit, largeMentions, mentionedPaths, mentionFit, mentionsPerMessage, mentionToken, withMentions, withSizes } from "../src/sessions/mentions.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider } from "../src/providers/types.ts";
import { fakeClaude } from "./claude-fixtures.ts";
import { WaitingStore } from "../src/sessions/waiting.ts";
import { createThread, isEvent, startTestBridge, TestClient } from "./helpers.ts";

// Files mentioned in a message (feature file_mentions): checked to be in the thread's
// folder, each in the text as @path, kept with a message that waits, and read back as the
// person wrote them from Claude Code's own session file.

let root: string;
let work: string;
let outside: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "file-mentions-")));
  work = join(root, "work");
  outside = join(root, "outside");
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(join(work, "dir with space"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(work, "src", "main.ts"), "x\n");
  writeFileSync(join(work, "dir with space", "note.txt"), "x\n");
  writeFileSync(join(outside, "secret.txt"), "x\n");
  symlinkSync(outside, join(work, "linked-out"));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("checkMentions keeps what is in the thread's folder, as given, each once, and nothing else", () => {
  assert.deepEqual(
    checkMentions(work, ["src/main.ts", "./src/main.ts", "src", "src/", "dir with space/note.txt", "missing.txt", "../outside/secret.txt", join(outside, "secret.txt"), "linked-out/secret.txt", "linked-out", 'a"b', "a\nb", "", ".", "src/../src/main.ts"]),
    ["src/main.ts", "src", "dir with space/note.txt"],
  );
  assert.deepEqual(checkMentions(undefined, ["src/main.ts"]), []);
  assert.deepEqual(checkMentions(join(root, "gone"), ["src/main.ts"]), []);
  const many = Array.from({ length: mentionsPerMessage + 5 }, () => "src/main.ts");
  assert.deepEqual(checkMentions(work, many), ["src/main.ts"]);
});

test("each mention is in the text as @path, @\"path\" with a space; one already there is not written twice", () => {
  assert.equal(mentionToken("src/main.ts"), "@src/main.ts");
  assert.equal(mentionToken("dir with space/note.txt"), '@"dir with space/note.txt"');
  assert.equal(withMentions("Look at @src/main.ts please", ["src/main.ts"]), "Look at @src/main.ts please");
  assert.equal(withMentions("Look at @src/main.ts.", ["src/main.ts"]), "Look at @src/main.ts.");
  // Claude Code reads no @ inside a word: written again, where it reads it.
  assert.equal(withMentions("(@src/main.ts)", ["src/main.ts"]), "(@src/main.ts) @src/main.ts");
  // A longer path that starts the same is another file.
  assert.equal(withMentions("See @src/main.tsx", ["src/main.ts"]), "See @src/main.tsx @src/main.ts");
  assert.equal(withMentions("See @src/main.ts.bak", ["src/main.ts"]), "See @src/main.ts.bak @src/main.ts");
  assert.equal(withMentions("Compare", ["src/main.ts", "dir with space/note.txt"]), 'Compare @src/main.ts @"dir with space/note.txt"');
  assert.equal(withMentions("", ["src"]), "@src");
  assert.equal(withMentions("Line\n", ["src"]), "Line\n@src");
});

test("mentions are written and found as Claude Code reads them: a name not ending on a letter, digit or _ is quoted, and a longer name hides no shorter one", () => {
  // Claude Code drops what follows a bare mention's last ASCII letter, digit or _.
  assert.equal(mentionToken("report.md,"), '@"report.md,"');
  assert.equal(mentionToken("café"), '@"café"');
  assert.equal(mentionToken("note?"), '@"note?"');
  assert.equal(mentionToken("src/main_2"), "@src/main_2");
  assert.deepEqual(mentionedPaths('Read @src/main.ts, @"dir with space/note.txt" and @report.md. Mail me@example.com (@not.this) @a\u3002@b.md'), ["dir with space/note.txt", "src/main.ts", "report.md", "a\u3002@b.md"]);
  assert.deepEqual(mentionedPaths("@note?copy"), ["note?copy"]);
  assert.deepEqual(mentionedPaths('@"report.md,"'), ["report.md,"]);
  // note?copy is another file than note: both written.
  assert.equal(withMentions("", ["note?copy", "note"]), "@note?copy @note");
  assert.equal(withMentions("See @report.md,", ["report.md,"]), 'See @report.md, @"report.md,"');
  assert.equal(withMentions("See @report.md,", ["report.md"]), "See @report.md,");
});

test("a \\ in a mention is part of a name, as on a Mac, not a separator", () => {
  mkdirSync(join(work, "a"), { recursive: true });
  writeFileSync(join(work, "a", "b.txt"), "x\n");
  writeFileSync(join(work, "a\\b.txt"), "x\n");
  assert.deepEqual(checkMentions(work, ["a\\b.txt"]), ["a\\b.txt"]);
  assert.deepEqual(checkMentions(work, ["a/b.txt"]), ["a/b.txt"]);
  assert.deepEqual(checkMentions(work, ["a\\missing.txt"]), []);
});

test("a message waiting keeps its mentions across a restart", () => {
  const home = join(root, "waiting");
  const kept = new WaitingStore(home);
  kept.write("thread-1", [{ id: "1", text: "Read @src/main.ts", images: [], mentions: ["src/main.ts"] }, { id: "2", text: "no mentions", images: [] }]);
  const read = new WaitingStore(home).read("thread-1");
  assert.deepEqual(read.map((message) => message.mentions), [["src/main.ts"], undefined]);
});

test("Claude Code's session file with a mentioned file read in: the history shows the message as written, and not the file", async () => {
  // Shaped like the session Claude Code 2.1.299 wrote for a message with @secret.txt under
  // the Agent SDK (2026-10-26, run n12): the message, then an `attachment` line of type
  // `file` with the file's text, then the reply.
  const config = join(root, "claude-config");
  const cwd = "/private/tmp/portals-claude-record/mention";
  const id = "4c32be89-1e64-40f5-aba0-11313c3afe3c";
  const project = join(config, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  cpSync(new URL("./fixtures/claude/mention.session.jsonl", import.meta.url), join(project, `${id}.jsonl`));
  const fixture = readFileSync(join(project, `${id}.jsonl`), "utf8");
  assert.match(fixture, /"type":"attachment"/);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const messages = await getSessionMessages(id, { dir: cwd });
    const history = historyFromSession(messages, cwd);
    assert.deepEqual(history.map((message) => [message.role, (message as { text?: string }).text]), [
      ["user", "What is the secret word in @secret.txt? Do not use any tools; answer only from what you were given, or say you were not given it."],
      ["assistant", "The secret word in secret.txt is PELICAN-7731."],
    ]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("prompt.submit's mentions on the wire: listed in gateway.ready, the ones in the folder put in the text the agent gets", async () => {
  const bridge = await startTestBridge({ temporaryFolders: [], config: { generalFolder: work } });
  try {
    const client = await TestClient.open(bridge);
    assert.ok(client.readyPayload.bridge.features.includes("file_mentions"));
    const thread = await createThread(client);
    await client.call("session.resume", { session_id: thread, profile: "fake" }).catch(() => undefined);
    const start = client.frames.length;
    const submitted = await client.call("prompt.submit", {
      session_id: thread,
      text: "Compare @src/main.ts with",
      mentions: ["src/main.ts", "dir with space/note.txt", "../outside/secret.txt", "linked-out/secret.txt"],
      profile: "fake",
    });
    assert.equal(submitted.status, "streaming");
    const started = await client.from(start, (frame) => isEvent(frame, "message.start", thread));
    await client.from(start, (frame) => isEvent(frame, "message.complete", thread));
    assert.equal(started.params.payload.text, 'Compare @src/main.ts with @"dir with space/note.txt"');
    // Mentions alone are a message.
    const again = client.frames.length;
    await client.call("prompt.submit", { session_id: thread, text: "", mentions: ["src"], profile: "fake" });
    const second = await client.from(again, (frame) => isEvent(frame, "message.start", thread));
    assert.equal(second.params.payload.text, "@src");
    await client.from(again, (frame) => isEvent(frame, "message.complete", thread));
    // Nothing kept and no text: empty.
    await assert.rejects(client.call("prompt.submit", { session_id: thread, text: " ", mentions: ["../outside/secret.txt"], profile: "fake" }), (error: any) => error.code === -32602);
    await assert.rejects(client.call("prompt.submit", { session_id: thread, text: "x", mentions: "src", profile: "fake" }), (error: any) => error.code === -32602);
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

// 2026-10-26: "Yes, a small note": the app says when a mentioned file is too
// large for the agent to read in. Claude Code 2.1.299 reads in a file of at most 262,144
// bytes and 25,000 tokens (docs/plans/2026-10-26-file-mentions.md, section 3).

test("Claude Code's limit for a mentioned file: 256 KiB and 25,000 tokens, the note from 60,000 bytes; its environment's token limit replaces the 25,000", () => {
  assert.deepEqual(claudeMentionLimit(), { max_bytes: 262_144, max_tokens: 25_000, note_bytes: 60_000 });
  assert.deepEqual(claudeMentionLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "50000" }), { max_bytes: 262_144, max_tokens: 50_000, note_bytes: 120_000 });
  assert.deepEqual(claudeMentionLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "500000" }).note_bytes, 262_144);
  for (const value of ["0", "-3", "many", "", "0x10000", "1.5e0", "1e400"]) assert.equal(claudeMentionLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: value }).max_tokens, 25_000, value);
  // Read as Claude Code reads its own (its `int` setting, from Codex's review): separators
  // between thousands, a whole number in e-notation, else parseInt's start.
  const read = (value: string) => claudeMentionLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: value }).max_tokens;
  assert.deepEqual(["5_000", "5,000", " 30000 ", "1e5", "2.5e3", "30000abc", "1.5"].map(read), [5000, 5000, 30_000, 100_000, 2500, 30_000, 1]);
  // Said as a number a device reads exactly.
  assert.equal(read("1e100"), 1_000_000_000);
  assert.equal(claudeMentionLimit({ CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: "1e100" }).note_bytes, 262_144);
  const limit = claudeMentionLimit();
  assert.equal(mentionFit(60_000, limit), "whole");
  assert.equal(mentionFit(60_001, limit), "maybe");
  assert.equal(mentionFit(262_144, limit), "maybe");
  assert.equal(mentionFit(262_145, limit), "unread");
  // Only Claude Code reads mentions in itself: other agents' models read a file with their tools.
  assert.deepEqual(fakeClaude().provider.mentionLimit(undefined), limit);
  assert.equal((new FakeProvider({ directory: join(root, "fake-agent"), delayMs: 1 }) as Provider).mentionLimit, undefined);
});

test("Claude Code's token limit for a mentioned file is read from its settings' env as Claude Code takes it: the global config, then user, project, local and managed settings, each over the one before and all over the environment; read again when a file changes", () => {
  const key = "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS";
  const home = join(root, "settings-home");
  const project = join(root, "settings-project");
  const other = join(root, "settings-other");
  const managed = join(root, "settings-managed.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(other, { recursive: true });
  const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify({ env: { [key]: value }, model: "haiku" }));
  const { provider } = fakeClaude({ home, managedSettings: managed });
  const tokens = (cwd: string | undefined) => provider.mentionLimit(cwd).max_tokens;
  // Nothing set: Claude Code's 25,000. The bridge's own environment never reaches Claude
  // Code (childEnvironment leaves out every CLAUDE_CODE_ key), so it does not count.
  assert.equal(tokens(project), 25_000);
  write(join(home, ".claude.json"), 30_000);
  assert.equal(tokens(project), 30_000);
  write(join(home, ".claude", "settings.json"), "40000");
  assert.equal(tokens(project), 40_000);
  assert.equal(tokens(other), 40_000);
  assert.equal(tokens(undefined), 40_000);
  write(join(project, ".claude", "settings.json"), "50000");
  assert.equal(tokens(project), 50_000);
  // Only that folder's threads.
  assert.equal(tokens(other), 40_000);
  write(join(project, ".claude", "settings.local.json"), "60000");
  assert.equal(tokens(project), 60_000);
  write(managed, "70000");
  assert.equal(tokens(project), 70_000);
  assert.equal(tokens(other), 70_000);
  // Changed or taken away, read again; one that does not parse sets nothing.
  rmSync(managed);
  assert.equal(tokens(project), 60_000);
  writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
  assert.equal(tokens(project), 50_000);
  write(join(project, ".claude", "settings.json"), "55,000");
  assert.equal(tokens(project), 55_000);
  // A value that is no number gives Claude Code's own limit, as in Claude Code: the last set wins.
  write(join(project, ".claude", "settings.json"), "many");
  assert.equal(tokens(project), 25_000);
  // CLAUDE_CONFIG_DIR moves ~/.claude and the global config.
  const moved = join(root, "settings-config-dir");
  mkdirSync(moved, { recursive: true });
  writeFileSync(join(moved, "settings.json"), JSON.stringify({ env: { [key]: "45000" } }));
  const elsewhere = new ClaudeProvider({ settings: { path: "/nonexistent/claude", idleMinutes: 15, maxWarm: 1, apiKey: null, folder: "/tmp" }, env: { HOME: home, CLAUDE_CONFIG_DIR: moved }, managedSettings: managed, agents: async () => [] });
  assert.equal(elsewhere.mentionLimit(other).max_tokens, 45_000);
});

test("largeMentions lists the kept files over the note's size, with theirs and what becomes of them; a folder or a small file is none", () => {
  const big = join(root, "big");
  mkdirSync(join(big, "docs"), { recursive: true });
  writeFileSync(join(big, "small.ts"), "x".repeat(60_000));
  writeFileSync(join(big, "medium.ts"), "x".repeat(60_001));
  writeFileSync(join(big, "huge.txt"), "x".repeat(300_000));
  // Claude Code reads a PDF its own way, whatever its size (from Codex's review): no note.
  writeFileSync(join(big, "paper.PDF"), "x".repeat(300_000));
  // A file named .pdf has no extension to Claude Code (Node's extname): the usual limit (from Codex's re-check).
  writeFileSync(join(big, ".pdf"), "x".repeat(300_000));
  symlinkSync(join(big, "huge.txt"), join(big, "huge-link.txt"));
  const limit = claudeMentionLimit();
  assert.deepEqual(largeMentions(big, ["small.ts", "docs", "medium.ts", "paper.PDF", "huge.txt", ".pdf", "huge-link.txt", "gone.txt"], limit), [
    { path: "medium.ts", size: 60_001, fit: "maybe" },
    { path: "huge.txt", size: 300_000, fit: "unread" },
    { path: ".pdf", size: 300_000, fit: "unread" },
    // Claude Code reads a link's file.
    { path: "huge-link.txt", size: 300_000, fit: "unread" },
  ]);
});

test("withSizes gives no size for a file reached through a link: a folder swapped for one after it was listed would show the size of a file outside (from Codex's review)", async () => {
  const folder = join(root, "swapped");
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(join(folder, "docs", "note.txt"), "inside");
  writeFileSync(join(folder, "top.txt"), "top");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "note.txt"), "x".repeat(300_000));
  const answer = () => ({ folder, files: [{ path: "docs/note.txt", kind: "file" }, { path: "top.txt", kind: "file" }] as { path: string; kind: string; size?: number }[] });
  assert.deepEqual((await withSizes(answer())).files.map((file) => file.size), [6, 3]);
  // The listing still names docs/note.txt; docs is now a link out of the folder.
  rmSync(join(folder, "docs"), { recursive: true });
  symlinkSync(elsewhere, join(folder, "docs"));
  assert.deepEqual((await withSizes(answer())).files.map((file) => file.size), [undefined, 3]);
});

test("files.search gives each file hit its size, and mention_limit for an agent that reads mentions in itself: the thread's, or the profile's for a folder", async () => {
  const folder = join(root, "sized");
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(join(folder, "big.txt"), "x".repeat(70_000));
  writeFileSync(join(folder, "small.txt"), "x\n");
  symlinkSync(join(folder, "big.txt"), join(folder, "link.txt"));
  // A scripted agent standing in for Claude Code: what counts is the agent's mentionLimit.
  const reader = new FakeProvider({ directory: join(root, "fake-reader"), delayMs: 1, name: "fake-2" });
  Object.defineProperty(reader, "mentionLimit", { value: () => claudeMentionLimit() });
  const providers = new Map<string, Provider>([["fake", new FakeProvider({ directory: join(root, "fake-plain"), delayMs: 1 })], ["fake-2", reader]]);
  const bridge = await startTestBridge({ temporaryFolders: [], providers, config: { generalFolder: folder } });
  try {
    const client = await TestClient.open(bridge);
    const plain = await createThread(client);
    const reads = await createThread(client, { profile: "fake-2" });
    const sizes = (answer: any) => Object.fromEntries(answer.files.map((file: any) => [file.path, file.size]));
    const ofPlain = await client.call("files.search", { session_id: plain, query: "", profile: "fake" });
    assert.deepEqual(sizes(ofPlain), { docs: undefined, "big.txt": 70_000, "small.txt": 2, "link.txt": undefined });
    assert.equal(ofPlain.mention_limit, undefined);
    const ofReader = await client.call("files.search", { session_id: reads, query: "big", profile: "fake" });
    assert.deepEqual(ofReader.mention_limit, { max_bytes: 262_144, max_tokens: 25_000, note_bytes: 60_000 });
    assert.equal(ofReader.files[0].size, 70_000);
    // Before the thread exists: the agent the new thread will run.
    const newThread = await client.call("files.search", { folder, query: "big", profile: "fake-2" });
    assert.deepEqual(newThread.mention_limit, ofReader.mention_limit);
    assert.equal((await client.call("files.search", { folder, query: "big", profile: "fake" })).mention_limit, undefined);
    assert.equal((await client.call("files.search", { folder, query: "big" })).mention_limit, undefined);

    // prompt.submit says which kept mentions the agent may not read in; none for another agent.
    await client.call("session.resume", { session_id: reads, profile: "fake-2" }).catch(() => undefined);
    const start = client.frames.length;
    const sent = await client.call("prompt.submit", { session_id: reads, text: "Read", mentions: ["big.txt", "small.txt", "docs"], profile: "fake-2" });
    assert.deepEqual(sent.large_mentions, [{ path: "big.txt", size: 70_000, fit: "maybe" }]);
    await client.from(start, (frame) => isEvent(frame, "message.complete", reads));
    await client.call("session.resume", { session_id: plain, profile: "fake" }).catch(() => undefined);
    const again = client.frames.length;
    const other = await client.call("prompt.submit", { session_id: plain, text: "Read", mentions: ["big.txt"], profile: "fake" });
    assert.equal(other.large_mentions, undefined);
    await client.from(again, (frame) => isEvent(frame, "message.complete", plain));
    await client.close();
  } finally {
    await bridge.dispose();
  }
});
