import "./environment.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { filesFolder, filesHeading, safeFileName, saveAttachment, splitFiles, withFiles } from "../src/sessions/files.ts";
import { previewOf } from "../src/sessions/preview.ts";

// The list of a message's files, as the agent reads it and the app finds it again
// (feature files), and the previews of messages that carry files.

test("a message's files are named after its text under one line, and found again", () => {
  const sent = withFiles("look at these", ["/w/.portals/files/t/a.pdf", "/w/.portals/files/t/b c.txt"]);
  assert.equal(sent, `look at these\n\n${filesHeading}\n- /w/.portals/files/t/a.pdf\n- /w/.portals/files/t/b c.txt`);
  assert.deepEqual(splitFiles(sent), { text: "look at these", paths: ["/w/.portals/files/t/a.pdf", "/w/.portals/files/t/b c.txt"] });
  // Files alone, and no files.
  assert.equal(withFiles("", ["/w/a.pdf"]), `${filesHeading}\n- /w/a.pdf`);
  assert.deepEqual(splitFiles(withFiles("", ["/w/a.pdf"])), { text: "", paths: ["/w/a.pdf"] });
  assert.equal(withFiles("plain", []), "plain");
  assert.deepEqual(splitFiles("plain"), { text: "plain", paths: [] });
});

test("the line only counts with a list of paths after it to the end of the message", () => {
  const quoted = `The bridge writes\n${filesHeading}\nbefore the paths.`;
  assert.deepEqual(splitFiles(quoted), { text: quoted, paths: [] });
  assert.deepEqual(splitFiles(`${filesHeading}`), { text: filesHeading, paths: [] });
  assert.deepEqual(splitFiles(`${filesHeading}\n- `), { text: `${filesHeading}\n- `, paths: [] });
  // The last such line is the bridge's: one quoted earlier stays in the text.
  const both = `${filesHeading}\nquoted\n\n${filesHeading}\n- /w/a.txt`;
  assert.deepEqual(splitFiles(both), { text: `${filesHeading}\nquoted`, paths: ["/w/a.txt"] });
});

test("a file's name keeps no folder, no hidden dot and nothing the Finder or a shell trips on", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName(".env"), "env");
  assert.equal(safeFileName("..."), "file");
  assert.equal(safeFileName("a:b*c?.txt"), "a_b_c_.txt");
  assert.equal(safeFileName("Quarterly report (final).pdf"), "Quarterly report (final).pdf");
  assert.equal(safeFileName("x".repeat(300)).length, 120);
});

test("a message of attachments alone is previewed by what it carries", () => {
  assert.equal(previewOf(withFiles("", ["/w/.portals/files/t/report.pdf"])), "report.pdf");
  assert.equal(previewOf(withFiles("", ["/w/a.pdf", "/w/b.pdf"])), "2 files");
  assert.equal(previewOf(`${withFiles("", ["/w/a.pdf"])}\n@image:photo.jpg`), "2 attachments");
  assert.equal(previewOf("@image:photo.jpg"), "Image");
  // The person's words come first, files or not.
  assert.equal(previewOf(`${withFiles("Summarise this", ["/w/a.pdf"])}\n@image:photo.jpg`), "Summarise this");
});

test("a thread is titled by the person's words, or by the first file's name when there are none", async () => {
  const { titleFrom } = await import("../src/providers/titles.ts");
  assert.equal(titleFrom(withFiles("Summarise this", ["/w/a.pdf"])), "Summarise this");
  assert.equal(titleFrom(withFiles("", ["/w/.portals/files/t/report.pdf", "/w/b.txt"])), "report.pdf");
  assert.equal(titleFrom(""), null);
});

// MARK: Saving

let root: string;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-files-test-")));
});
after(() => rmSync(root, { recursive: true, force: true }));

test("a file is saved under the thread folder's .portals, which git leaves out, and a .gitignore there already is left as it is", async () => {
  const project = join(root, "plain");
  const path = await saveAttachment(project, "thread-1", "notes.txt", Buffer.from("hi"));
  assert.equal(path, join(filesFolder(project, "thread-1"), "notes.txt"));
  assert.equal(readFileSync(path, "utf8"), "hi");
  assert.equal(readFileSync(join(project, ".portals", ".gitignore"), "utf8"), "*\n");
  writeFileSync(join(project, ".portals", ".gitignore"), "mine\n");
  await saveAttachment(project, "thread-1", "more.txt", Buffer.from("x"));
  assert.equal(readFileSync(join(project, ".portals", ".gitignore"), "utf8"), "mine\n");
  // The files are left out of git by a line of their own all the same, given to one there already that lacks it.
  assert.equal(readFileSync(join(project, ".portals", "files", ".gitignore"), "utf8"), "*\n");
  writeFileSync(join(project, ".portals", "files", ".gitignore"), "*\n!*.txt");
  await saveAttachment(project, "thread-1", "third.txt", Buffer.from("x"));
  assert.equal(readFileSync(join(project, ".portals", "files", ".gitignore"), "utf8"), "*\n!*.txt\n*\n");
  await saveAttachment(project, "thread-1", "fourth.txt", Buffer.from("x"));
  assert.equal(readFileSync(join(project, ".portals", "files", ".gitignore"), "utf8"), "*\n!*.txt\n*\n");
  // And the thread's folder has its own, deepest.
  assert.equal(readFileSync(join(filesFolder(project, "thread-1"), ".gitignore"), "utf8"), "*\n");
});

test("a link in place of the bridge's folders is not followed: the file is not saved, and nothing is written where it leads", async () => {
  for (const [index, linked] of [".portals", ".portals/files", ".portals/files/thread-1"].entries()) {
    const project = join(root, `linked-${index}`);
    const elsewhere = join(root, `elsewhere-${index}`);
    mkdirSync(join(project, linked, ".."), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, linked));
    await assert.rejects(saveAttachment(project, "thread-1", "notes.txt", Buffer.from("private")), /not a folder of its own/);
    assert.deepEqual(readdirSync(elsewhere), []);
  }
  // A .gitignore in .portals/files that is a link is left as it is: the thread's folder has its own.
  const linkedFiles = join(root, "linked-files-ignore");
  mkdirSync(join(linkedFiles, ".portals", "files"), { recursive: true });
  writeFileSync(join(root, "their-ignore"), "theirs\n");
  symlinkSync(join(root, "their-ignore"), join(linkedFiles, ".portals", "files", ".gitignore"));
  await saveAttachment(linkedFiles, "thread-1", "notes.txt", Buffer.from("x"));
  assert.equal(readFileSync(join(root, "their-ignore"), "utf8"), "theirs\n");
  assert.equal(readFileSync(join(filesFolder(linkedFiles, "thread-1"), ".gitignore"), "utf8"), "*\n");
  // Nor is a .gitignore that is a link, even to nothing.
  const project = join(root, "linked-ignore");
  mkdirSync(join(project, ".portals"), { recursive: true });
  symlinkSync(join(root, "made-through-link"), join(project, ".portals", ".gitignore"));
  await saveAttachment(project, "thread-1", "notes.txt", Buffer.from("x"));
  assert.equal(existsSync(join(root, "made-through-link")), false);
});

test("a long file name is cut before an emoji, never in half", () => {
  // Cut by UTF-16 units, half of the emoji was in the path the agent's prompt names.
  assert.equal(safeFileName(`${"a".repeat(119)}\u{1F680}.txt`), "a".repeat(119));
});
