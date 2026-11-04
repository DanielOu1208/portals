import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { FileRewindResult } from "../src/providers/types.ts";
import { FileUndo, FileUndoRefused } from "../src/sessions/fileUndo.ts";

function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "portals-file-undo-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "note.txt");
  writeFileSync(file, "after\n");
  const owner = {};
  const undo = new FileUndo();
  let restored = false;
  let preview: FileRewindResult = { canRewind: true, filesChanged: [file], insertions: 1, deletions: 1 };
  let actual: FileRewindResult = { canRewind: true, skippedLinks: 0 };
  let failure: Error | undefined;
  const calls: boolean[] = [];
  const rewind = async (_checkpoint: string, dryRun: boolean): Promise<FileRewindResult> => {
    calls.push(dryRun);
    if (dryRun) return restored ? { canRewind: true, filesChanged: [] } : preview;
    if (failure) throw failure;
    if (actual.canRewind && !actual.skippedLinks) { writeFileSync(file, "before\n"); restored = true; }
    return actual;
  };
  return {
    root, file, owner, undo, calls, rewind,
    preview: () => undo.preview(owner, "native-user", root, rewind),
    setPreview: (value: FileRewindResult) => { preview = value; },
    setActual: (value: FileRewindResult) => { actual = value; },
    fail: (value: Error) => { failure = value; },
  };
}

test("file undo previews without writing, verifies again, restores and consumes its connection-bound permit", async (t) => {
  const run = setup(t);
  const preview = await run.preview();
  assert.deepEqual(preview.files, [run.file]);
  assert.equal(preview.insertions, 1);
  assert.equal(readFileSync(run.file, "utf8"), "after\n");
  assert.deepEqual(run.calls, [true]);
  await assert.rejects(run.undo.undo({}, preview.preview_id, run.root, run.rewind), FileUndoRefused);
  assert.deepEqual(await run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), { restored: true, skipped_links: 0 });
  assert.equal(readFileSync(run.file, "utf8"), "before\n");
  assert.deepEqual(run.calls, [true, true, false, true]);
  await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), FileUndoRefused);
  assert.equal(run.calls.filter((dryRun) => !dryRun).length, 1);
});

test("changed contents and native file lists require a new reviewed preview before any restore", async (t) => {
  for (const change of ["contents", "list", "counts"] as const) {
    const run = setup(t);
    const preview = await run.preview();
    if (change === "contents") writeFileSync(run.file, "manual edit after preview\n");
    if (change === "list") run.setPreview({ canRewind: true, filesChanged: [run.file, join(run.root, "new.txt")], insertions: 1, deletions: 1 });
    if (change === "counts") run.setPreview({ canRewind: true, filesChanged: [run.file], insertions: 9, deletions: 1 });
    await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), /changed after this preview/);
    assert.ok(run.calls.every(Boolean));
    await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), /no longer available/);
  }
});

test("empty, unsupported, unsafe and overly large native previews are refused", async (t) => {
  const run = setup(t);
  for (const preview of [
    { canRewind: false, error: "No checkpoint" },
    { canRewind: true },
    { canRewind: true, filesChanged: [] },
    { canRewind: true, filesChanged: [run.file], skippedLinks: 1 },
    { canRewind: true, filesChanged: Array.from({ length: 101 }, (_, index) => join(run.root, `${index}.txt`)) },
    { canRewind: true, filesChanged: [join(run.root, "..", "outside.txt")] },
    { canRewind: true, filesChanged: [run.file], insertions: -1 },
  ]) {
    run.setPreview(preview);
    await assert.rejects(run.preview(), FileUndoRefused);
  }
  run.setPreview({ canRewind: "true", filesChanged: [run.file] } as unknown as FileRewindResult);
  await assert.rejects(run.preview(), FileUndoRefused);
  writeFileSync(run.file, Buffer.alloc(16 * 1024 * 1024 + 1));
  run.setPreview({ canRewind: true, filesChanged: [run.file] });
  await assert.rejects(run.preview(), /too large/);
  assert.ok(run.calls.every(Boolean));
});

test("links, parent-directory links and files replaced by links after preview are refused", async (t) => {
  const run = setup(t);
  const hard = join(run.root, "hard.txt");
  linkSync(run.file, hard);
  await assert.rejects(run.preview(), /Linked files/);
  unlinkSync(hard);
  const directory = join(run.root, "directory");
  mkdirSync(directory);
  const alias = join(run.root, "alias");
  symlinkSync(directory, alias);
  run.setPreview({ canRewind: true, filesChanged: [join(alias, "missing.txt")] });
  await assert.rejects(run.preview(), /through a link/);
  run.setPreview({ canRewind: true, filesChanged: [run.file], insertions: 1, deletions: 1 });
  const preview = await run.preview();
  unlinkSync(run.file);
  symlinkSync(hard, run.file);
  await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), /Linked files/);
  assert.ok(run.calls.every(Boolean));
});

test("expired and replaced confirmations cannot restore files", async (t) => {
  const run = setup(t);
  const preview = await run.preview();
  const clock = Date.now();
  t.mock.method(Date, "now", () => clock + 61_000);
  await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), /expired/);
  t.mock.restoreAll();
  const replaced = await run.preview();
  await run.preview();
  await assert.rejects(run.undo.undo(run.owner, replaced.preview_id, run.root, run.rewind), /no longer available/);
  assert.ok(run.calls.every(Boolean));
});

test("failed, skipped and unverifiable restores are never reported as complete or replayed", async (t) => {
  for (const result of [{ canRewind: false }, { canRewind: true, skippedLinks: 1 }]) {
    const run = setup(t);
    run.setActual(result);
    const preview = await run.preview();
    assert.deepEqual(await run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), { restored: false, skipped_links: result.skippedLinks ?? 0 });
    await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), FileUndoRefused);
  }
  const run = setup(t);
  const preview = await run.preview();
  run.fail(new Error("Native restore failed"));
  await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), /Native restore failed/);
  await assert.rejects(run.undo.undo(run.owner, preview.preview_id, run.root, run.rewind), FileUndoRefused);
  assert.equal(run.calls.filter((dryRun) => !dryRun).length, 1);
});
