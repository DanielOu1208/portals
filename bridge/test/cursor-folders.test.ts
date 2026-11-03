import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cursorFolders, pathsNamed, projectName } from "../src/providers/cursor/folders.ts";

// The folders Cursor worked in, from what it keeps on disk (src/providers/cursor/folders.ts).

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

test("a project's name is its path with every other character a dash, and is found again on disk however it was written", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cursor-folders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ["coding_projects/my-app", "coding-projects/my_app", "coding_projects/other", "a.b/c"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "coding_projects", "a file"), "");
  assert.equal(projectName("/Users/dev/coding_projects/my-app"), "Users-dev-coding-projects-my-app");
  // Two folders on disk are written the same: both are found, and the hashes tell them apart later.
  assert.deepEqual((await pathsNamed("coding-projects-my-app", root)).sort(), [join(root, "coding-projects/my_app"), join(root, "coding_projects/my-app")].sort());
  assert.deepEqual(await pathsNamed("a-b-c", root), [join(root, "a.b/c")]);
  assert.deepEqual(await pathsNamed("coding-projects-gone", root), []);
});

test("the folders of Cursor's ACP sessions and of its terminal chats, newest first", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cursor-home-"));
  const work = mkdtempSync(join(tmpdir(), "cursor-work-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });
  const desk = join(work, "desk_app");
  const phone = join(work, "phone-app");
  mkdirSync(desk);
  mkdirSync(phone);
  // A terminal chat in `desk_app`, and a project folder Cursor names with no chat (not offered).
  const chat = join(home, "chats", md5(desk), "chat-1");
  mkdirSync(chat, { recursive: true });
  utimesSync(chat, new Date(2000), new Date(2000));
  mkdirSync(join(home, "projects", projectName(desk)), { recursive: true });
  mkdirSync(join(home, "projects", projectName(phone)), { recursive: true });
  // An ACP session in `phone-app`, newer; one whose meta cannot be read.
  const session = join(home, "acp-sessions", "s-1");
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "meta.json"), JSON.stringify({ schemaVersion: 1, cwd: phone, title: "x" }));
  writeFileSync(join(session, "store.db"), "");
  utimesSync(join(session, "store.db"), new Date(5000), new Date(5000));
  mkdirSync(join(home, "acp-sessions", "s-2"));
  writeFileSync(join(home, "acp-sessions", "s-2", "meta.json"), "{");
  assert.deepEqual(await cursorFolders(home), [
    { path: phone, lastUsed: 5000 },
    { path: desk, lastUsed: 2000 },
  ]);
  // Nothing kept yet: none.
  assert.deepEqual(await cursorFolders(join(home, "none")), []);
});
