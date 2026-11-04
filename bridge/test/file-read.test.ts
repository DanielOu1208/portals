import { realHome } from "./environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryRoots } from "../src/folders.ts";
import { FileReader, imageReadLimit, imageType, openUnfollowed, textReadLimit } from "../src/sessions/fileRead.ts";
import { createThread, startTestBridge, TestClient, type TestBridge } from "./helpers.ts";

// A file read for a device (feature file_read): an image a reply names, or a file a tool
// row names, from anywhere on the Mac, and only what is a file of the kind asked for.

/** The smallest PNG there is: one pixel. */
const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

let root: string;
/** The thread's folder. */
let work: string;
/** A temporary folder. */
let scratch: string;
/** Somewhere neither. */
let elsewhere: string;
/** Another thread's folder. */
let other: string;
let home: string;
let reader: FileReader;

/** A new folder in the first of `places` that can take one and that none of the `temporary` folders holds; undefined when none does. */
function folderOutside(temporary: string[], places: string[]): string | undefined {
  const roots = temporary.map((folder) => realpathSync(folder));
  for (const place of places) {
    let made: string;
    try {
      made = realpathSync(mkdtempSync(join(place, ".file-read-")));
    } catch {
      // Not there, or not to be written to.
      continue;
    }
    if (!roots.some((root) => made.startsWith(root + sep))) return made;
    rmSync(made, { recursive: true, force: true });
  }
  return undefined;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "file-read-")));
  work = join(root, "work");
  scratch = join(root, "scratch");
  elsewhere = join(root, "elsewhere");
  other = join(root, "other");
  home = join(root, "home");
  for (const folder of [work, scratch, elsewhere, other, home, join(work, "src")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(work, "chart.png"), png);
  writeFileSync(join(work, "src", "main.ts"), "const a = 1;\nconsole.log(a);\n");
  writeFileSync(join(scratch, "plot.png"), png);
  writeFileSync(join(scratch, "notes.txt"), "scratch notes\n");
  writeFileSync(join(elsewhere, "secret.png"), png);
  writeFileSync(join(elsewhere, "secret.txt"), "not yours\n");
  writeFileSync(join(other, "theirs.png"), png);
  reader = new FileReader({ home });
});

after(() => rmSync(root, { recursive: true, force: true }));

test("an image in the thread's folder is given whole, by an absolute path or one relative to the folder", async () => {
  for (const path of [join(work, "chart.png"), "chart.png", "./src/../chart.png"]) {
    const answer = await reader.read({ cwd: work, path, purpose: "image" });
    assert.equal("refused" in answer, false, path);
    assert.equal(answer.name, "chart.png");
    assert.equal(answer.path, join(work, "chart.png"));
    assert.equal((answer as any).kind, "image");
    assert.equal((answer as any).type, "image/png");
    assert.equal((answer as any).size, png.length);
    assert.deepEqual(Buffer.from((answer as any).data, "base64"), png);
  }
});

test("an image anywhere on the Mac is given: a temporary folder, another thread's folder, .., anywhere else", async () => {
  for (const path of [join(scratch, "plot.png"), join(elsewhere, "secret.png"), "../elsewhere/secret.png", join(other, "theirs.png"), `${work}/../other/theirs.png`]) {
    const answer = await reader.read({ cwd: work, path, purpose: "image" });
    assert.equal((answer as any).refused, undefined, path);
    assert.equal((answer as any).kind, "image", path);
    assert.deepEqual(Buffer.from((answer as any).data, "base64"), png, path);
  }
  const theirs = await reader.read({ cwd: work, path: join(other, "theirs.png"), purpose: "image" });
  assert.deepEqual([theirs.name, theirs.path], ["theirs.png", join(other, "theirs.png")]);
  // A folder whose name starts as the thread's does is another folder, and its images are given too.
  mkdirSync(`${work}-two`, { recursive: true });
  writeFileSync(`${work}-two/a.png`, png);
  assert.equal(((await reader.read({ cwd: work, path: `${work}-two/a.png`, purpose: "image" })) as any).kind, "image");
});

test("a folder for a fixture outside every temporary folder is made in the first place that is, or nowhere", () => {
  const places = join(root, "places");
  const held = join(places, "temporary", "checkout");
  const free = join(places, "free");
  for (const folder of [held, free]) mkdirSync(folder, { recursive: true });
  const temporary = [join(places, "temporary")];
  const missing = join(places, "not-there");

  const made = folderOutside(temporary, [missing, held, free]);
  assert.equal(made === undefined ? undefined : dirname(made), free);
  assert.deepEqual(readdirSync(held), [], "nothing is left where it would not do");
  assert.ok(existsSync(made!));
  assert.equal(folderOutside(temporary, [missing, held]), undefined);
  assert.deepEqual(readdirSync(held), []);
});

test("a file outside every temporary folder is given, an image as an image and text as text", async (t) => {
  // Every other fixture is under the temporary folder, where images were given before too:
  // this one is in the bridge's node_modules (ignored by git), or, for a checkout in a
  // temporary folder, in the home this test run came with: it is taken away again below.
  const away = folderOutside([...temporaryRoots, tmpdir()].filter((folder) => existsSync(folder)), [fileURLToPath(new URL("../node_modules/", import.meta.url)), realHome]);
  if (away === undefined) {
    t.skip("Nowhere to put a file outside every temporary folder: both this checkout and the home are in one, or cannot be written to.");
    return;
  }
  try {
    writeFileSync(join(away, "shot.png"), png);
    writeFileSync(join(away, "notes.txt"), "away\n");
    for (const cwd of [work, home, "/"]) {
      const image = await reader.read({ cwd, path: join(away, "shot.png"), purpose: "image" });
      assert.deepEqual([(image as any).kind, image.path], ["image", join(away, "shot.png")], cwd);
      assert.equal(((await reader.read({ cwd, path: join(away, "notes.txt"), purpose: "image" })) as any).refused, "not_image", cwd);
      const text = await reader.read({ cwd, path: join(away, "notes.txt"), purpose: "text" });
      assert.deepEqual([(text as any).kind, (text as any).text, text.path], ["text", "away\n", join(away, "notes.txt")], cwd);
      assert.equal(((await reader.read({ cwd, path: join(away, "shot.png"), purpose: "text" })) as any).kind, "image", cwd);
    }
  } finally {
    rmSync(away, { recursive: true, force: true });
  }
});

test("a relative path goes from the real folder the thread works in, as its `..` does, when that folder is reached through a link", async () => {
  mkdirSync(join(root, "shortcuts"), { recursive: true });
  writeFileSync(join(home, "portrait.png"), png);
  writeFileSync(join(home, "todo.md"), "- one\n");
  symlinkSync(work, join(root, "shortcuts", "app"));
  symlinkSync(home, join(root, "shortcuts", "me"));
  // Through the link, `..` is the folder that holds the real one, not the links' folder.
  const own = await reader.read({ cwd: join(root, "shortcuts", "app"), path: "../work/chart.png", purpose: "image" });
  assert.deepEqual([(own as any).kind, own.path], ["image", join(work, "chart.png")]);
  const atHome = await reader.read({ cwd: join(root, "shortcuts", "me"), path: "../home/portrait.png", purpose: "image" });
  assert.deepEqual([(atHome as any).kind, atHome.path], ["image", join(home, "portrait.png")]);
  // A file to read goes the same way.
  assert.equal(((await reader.read({ cwd: join(root, "shortcuts", "app"), path: "../work/src/main.ts", purpose: "text" })) as any).kind, "text");
  assert.equal(((await reader.read({ cwd: join(root, "shortcuts", "me"), path: "../home/todo.md", purpose: "text" })) as any).text, "- one\n");
});

test("what is not an image is not given as one from anywhere, and is given as text when it is opened to read", async () => {
  for (const path of [join(elsewhere, "secret.txt"), "../elsewhere/secret.txt", join(scratch, "notes.txt"), "/etc/hosts"]) {
    const image = await reader.read({ cwd: work, path, purpose: "image" });
    assert.equal((image as any).refused, "not_image", path);
    assert.equal((image as any).text, undefined, path);
    assert.equal((image as any).data, undefined, path);
    const text = await reader.read({ cwd: work, path, purpose: "text" });
    assert.equal((text as any).kind, "text", path);
    assert.equal(typeof (text as any).text, "string", path);
  }
  // A text file with an image's name is not one.
  writeFileSync(join(elsewhere, "fake.png"), "not a picture\n");
  assert.equal(((await reader.read({ cwd: work, path: join(elsewhere, "fake.png"), purpose: "image" })) as any).refused, "not_image");
});

test("a link to an image is followed anywhere, to what is not an image never: an image's name does not make it one", async () => {
  symlinkSync(join(elsewhere, "secret.txt"), join(elsewhere, "points-at-text.png"));
  symlinkSync(join(elsewhere, "secret.txt"), join(work, "text-link.png"));
  symlinkSync(join(elsewhere, "secret.png"), join(scratch, "image-link.png"));
  for (const path of [join(elsewhere, "points-at-text.png"), "text-link.png"]) {
    const answer = await reader.read({ cwd: work, path, purpose: "image" });
    assert.equal((answer as any).refused, "not_image", path);
    assert.equal((answer as any).path, join(elsewhere, "secret.txt"), path);
    assert.equal((answer as any).data, undefined, path);
  }
  const image = await reader.read({ cwd: work, path: join(scratch, "image-link.png"), purpose: "image" });
  assert.equal((image as any).kind, "image");
  assert.equal(image.path, join(elsewhere, "secret.png"));
});

test("a text file in the thread's folder is given as text, and an image opened to read is given as an image", async () => {
  const text = await reader.read({ cwd: work, path: "src/main.ts", purpose: "text" });
  assert.equal((text as any).kind, "text");
  assert.equal((text as any).text, "const a = 1;\nconsole.log(a);\n");
  assert.equal((text as any).data, undefined);
  const image = await reader.read({ cwd: work, path: "chart.png", purpose: "text" });
  assert.equal((image as any).kind, "image");
});

test("a file to read is given from anywhere: .., another thread's folder, a temporary folder, anywhere else; an image there as an image", async () => {
  for (const path of ["../elsewhere/secret.png", join(elsewhere, "secret.png"), join(other, "theirs.png"), `${work}/../other/theirs.png`, join(scratch, "plot.png")]) {
    const answer = await reader.read({ cwd: work, path, purpose: "text" });
    assert.equal((answer as any).refused, undefined, path);
    assert.deepEqual([(answer as any).kind, (answer as any).type], ["image", "image/png"], path);
  }
  for (const path of ["../elsewhere/secret.txt", join(scratch, "notes.txt")]) {
    const answer = await reader.read({ cwd: work, path, purpose: "text" });
    assert.equal((answer as any).refused, undefined, path);
    assert.equal((answer as any).kind, "text", path);
  }
  assert.equal(((await reader.read({ cwd: work, path: join(elsewhere, "secret.txt"), purpose: "text" })) as any).text, "not yours\n");
  // Outside the thread's folder, what is not text is still not given as text, nor more than 2 MB.
  writeFileSync(join(elsewhere, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  assert.equal(((await reader.read({ cwd: work, path: join(elsewhere, "blob.bin"), purpose: "text" })) as any).refused, "binary");
  const long = join(elsewhere, "long.txt");
  writeFileSync(long, "a");
  truncateSync(long, textReadLimit + 1);
  assert.equal(((await reader.read({ cwd: work, path: long, purpose: "text" })) as any).refused, "too_large");
  rmSync(long);
});

test("a link is followed wherever it goes, out of the thread's folder too, and the file given back is the one it names", async () => {
  symlinkSync(join(elsewhere, "secret.txt"), join(work, "link.txt"));
  symlinkSync(join(elsewhere, "secret.png"), join(work, "link.png"));
  symlinkSync(elsewhere, join(work, "linked-folder"));
  for (const [path, kind, real] of [
    ["link.txt", "text", "secret.txt"],
    ["link.png", "image", "secret.png"],
    ["linked-folder/secret.txt", "text", "secret.txt"],
    ["linked-folder/secret.png", "image", "secret.png"],
  ]) {
    const answer = await reader.read({ cwd: work, path, purpose: "text" });
    assert.deepEqual([(answer as any).kind, answer.name, answer.path], [kind, real, join(elsewhere, real)], path);
  }
  // A link to a folder is still not a file.
  assert.equal(((await reader.read({ cwd: work, path: "linked-folder", purpose: "text" })) as any).refused, "not_file");
  // A link that stays inside is followed: it is the file it names.
  symlinkSync(join(work, "src", "main.ts"), join(work, "inside.ts"));
  const inside = await reader.read({ cwd: work, path: "inside.ts", purpose: "text" });
  assert.equal((inside as any).path, join(work, "src", "main.ts"));
});

test("the file is opened through no link at all: a folder on the way swapped for a link out after the check is not read through", async () => {
  // What the race leaves at the moment of the open: the path checked, with a folder on
  // the way now a link to elsewhere (put back before any check after the open).
  const swapped = join(work, "swapped");
  symlinkSync(elsewhere, swapped);
  await assert.rejects(openUnfollowed(join(swapped, "secret.txt")), { code: "ELOOP" });
  // A real path with no link in it opens.
  const handle = await openUnfollowed(join(work, "src", "main.ts"));
  await handle.close();
});

test("a folder, a missing file, a pipe and nothing at all are refused, each with why", async () => {
  assert.equal(((await reader.read({ cwd: work, path: "src", purpose: "text" })) as any).refused, "not_file");
  assert.equal(((await reader.read({ cwd: work, path: "gone.png", purpose: "image" })) as any).refused, "missing");
  assert.equal(((await reader.read({ cwd: work, path: "  ", purpose: "text" })) as any).refused, "missing");
  execFileSync("mkfifo", [join(work, "pipe")]);
  // Opened without waiting for a writer, and refused as not a file.
  assert.equal(((await reader.read({ cwd: work, path: "pipe", purpose: "text" })) as any).refused, "not_file");
  const missing = await reader.read({ cwd: work, path: "gone.png", purpose: "image" });
  assert.match((missing as any).message, /gone\.png/);
  // The same outside the thread's folder.
  execFileSync("mkfifo", [join(elsewhere, "pipe")]);
  for (const purpose of ["text", "image"] as const) {
    assert.equal(((await reader.read({ cwd: work, path: elsewhere, purpose })) as any).refused, "not_file", purpose);
    assert.equal(((await reader.read({ cwd: work, path: join(elsewhere, "pipe"), purpose })) as any).refused, "not_file", purpose);
    assert.equal(((await reader.read({ cwd: work, path: join(elsewhere, "gone.txt"), purpose })) as any).refused, "missing", purpose);
    assert.equal(((await reader.read({ cwd: work, path: "/dev/null", purpose })) as any).refused, "not_file", purpose);
  }
});

test("a file larger than the limits is refused, and binary is not given as text", async () => {
  const big = join(work, "big.png");
  writeFileSync(big, png);
  truncateSync(big, imageReadLimit + 1);
  const image = await reader.read({ cwd: work, path: "big.png", purpose: "image" });
  assert.equal((image as any).refused, "too_large");
  assert.match((image as any).message, /15 MB/);
  const long = join(work, "long.txt");
  writeFileSync(long, "a");
  truncateSync(long, textReadLimit + 1);
  // Past the limit, refused before it is read: the NULs it was padded with are not looked at.
  assert.equal(((await reader.read({ cwd: work, path: "long.txt", purpose: "text" })) as any).refused, "too_large");
  writeFileSync(join(work, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  assert.equal(((await reader.read({ cwd: work, path: "blob.bin", purpose: "text" })) as any).refused, "binary");
  writeFileSync(join(work, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(((await reader.read({ cwd: work, path: "latin.txt", purpose: "text" })) as any).refused, "binary");
  // Text asked for as an image is not one.
  assert.equal(((await reader.read({ cwd: work, path: "src/main.ts", purpose: "image" })) as any).refused, "not_image");
});

test("a file the device holds already is not sent again until it changes", async () => {
  const first = await reader.read({ cwd: work, path: "chart.png", purpose: "image" });
  const etag = (first as any).etag;
  assert.equal(typeof etag, "string");
  const again = await reader.read({ cwd: work, path: "chart.png", purpose: "image", unless: etag });
  assert.equal((again as any).unchanged, true);
  assert.equal((again as any).data, undefined);
  writeFileSync(join(work, "chart.png"), Buffer.concat([png, Buffer.from([0])]));
  const changed = await reader.read({ cwd: work, path: "chart.png", purpose: "image", unless: etag });
  assert.equal((changed as any).unchanged, undefined);
  assert.notEqual((changed as any).etag, etag);
  assert.ok((changed as any).data);
  writeFileSync(join(work, "chart.png"), png);
});

test("sub-millisecond changes to a file of the same size invalidate the device's cached copy", async () => {
  const path = join(work, "fast.txt");
  const seconds = 1_800_000_000;
  writeFileSync(path, "before");
  utimesSync(path, seconds, seconds + 0.0001);
  const before = statSync(path).mtimeMs;
  const first = await reader.read({ cwd: work, path, purpose: "text" });
  assert.ok(!("refused" in first));

  writeFileSync(path, "after!");
  utimesSync(path, seconds, seconds + 0.0009);
  const after = statSync(path).mtimeMs;
  assert.notEqual(before, after);
  assert.equal(Math.trunc(before), Math.trunc(after));
  const changed = await reader.read({ cwd: work, path, purpose: "text", unless: first.etag });
  assert.ok(!("refused" in changed));
  assert.equal(changed.unchanged, undefined);
  assert.notEqual(changed.etag, first.etag);
  assert.equal(changed.text, "after!");
});

test("replacing a file by rename invalidates the cache even with the same size and modification time", async () => {
  const path = join(work, "replaced.txt");
  const replacement = join(work, "replacement.txt");
  const seconds = 1_800_000_000;
  writeFileSync(path, "before");
  utimesSync(path, seconds, seconds);
  const before = statSync(path, { bigint: true });
  const first = await reader.read({ cwd: work, path, purpose: "text" });
  assert.ok(!("refused" in first));

  writeFileSync(replacement, "after!");
  utimesSync(replacement, seconds, seconds);
  renameSync(replacement, path);
  const after = statSync(path, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ino, before.ino);
  const changed = await reader.read({ cwd: work, path, purpose: "text", unless: first.etag });
  assert.ok(!("refused" in changed));
  assert.equal(changed.unchanged, undefined);
  assert.notEqual(changed.etag, first.etag);
  assert.equal(changed.text, "after!");
});

test("a file growing between its stat and read is not cached as the complete newer version", async (t) => {
  const path = join(work, "growing.txt");
  const seconds = 1_800_000_000;
  writeFileSync(path, "before");
  utimesSync(path, seconds, seconds);
  const inode = statSync(path, { bigint: true }).ino;
  const handle = await open(path, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const original = prototype.stat;
  let grew = false;
  t.mock.method(prototype, "stat", async function (this: FileHandle, options?: Parameters<FileHandle["stat"]>[0]) {
    const stats = await original.call(this, options);
    assert.ok(stats);
    if (!grew && BigInt(stats.ino) === inode) {
      grew = true;
      writeFileSync(path, "after! and more");
      utimesSync(path, seconds, seconds + 1);
    }
    return stats;
  });

  const partial = await reader.read({ cwd: work, path, purpose: "text" });
  assert.ok(!("refused" in partial));
  assert.equal(grew, true);
  assert.equal(partial.text, "after!");
  const whole = await reader.read({ cwd: work, path, purpose: "text", unless: partial.etag });
  assert.ok(!("refused" in whole));
  assert.equal(whole.unchanged, undefined);
  assert.notEqual(whole.etag, partial.etag);
  assert.equal(whole.text, "after! and more");
});

test("a thread with no folder of its own (in the home folder, at /, or none) shows images and opens files from anywhere", async () => {
  writeFileSync(join(home, "photo.png"), png);
  writeFileSync(join(home, "notes.txt"), "home notes\n");
  for (const cwd of [home, undefined, "/"]) {
    for (const path of [join(home, "photo.png"), join(scratch, "plot.png"), join(elsewhere, "secret.png"), "~/photo.png"]) {
      assert.equal(((await reader.read({ cwd, path, purpose: "image" })) as any).kind, "image", `${cwd} ${path}`);
    }
    assert.equal(((await reader.read({ cwd, path: join(home, "notes.txt"), purpose: "image" })) as any).refused, "not_image");
    for (const path of [join(home, "notes.txt"), "~/notes.txt", join(elsewhere, "secret.txt")]) {
      assert.equal(((await reader.read({ cwd, path, purpose: "text" })) as any).kind, "text", `${cwd} ${path}`);
    }
    assert.equal(((await reader.read({ cwd, path: join(home, "photo.png"), purpose: "text" })) as any).kind, "image");
  }
  // A path relative to where the thread works is taken from there, the home folder too.
  for (const purpose of ["image", "text"] as const) {
    assert.equal(((await reader.read({ cwd: home, path: "photo.png", purpose })) as any).path, join(home, "photo.png"), purpose);
    assert.equal(((await reader.read({ cwd: "/", path: "photo.png", purpose })) as any).refused, "missing", purpose);
    // With no folder at all, a relative path names nothing.
    assert.equal(((await reader.read({ cwd: undefined, path: "photo.png", purpose })) as any).refused, "outside", purpose);
  }
  assert.equal(((await reader.read({ cwd: home, path: "notes.txt", purpose: "text" })) as any).text, "home notes\n");
});

test("images are known by their bytes, not their names", () => {
  assert.equal(imageType(png.subarray(0, 16)), "image/png");
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageType(Buffer.from("\0\0\0\x18ftypheic", "latin1")), "image/heic");
  assert.equal(imageType(Buffer.from("hello")), undefined);
  assert.equal(imageType(Buffer.alloc(0)), undefined);
});

test("text that starts like a BMP or a GIF ('BM', 'GIF8') is text: opened as text, held to the text limit; a real BMP is still an image", async () => {
  writeFileSync(join(work, "notes.md"), "BMI is weight over height squared.\n\nSee below.\n");
  const notes = (await reader.read({ cwd: work, path: "notes.md", purpose: "text" })) as any;
  assert.deepEqual([notes.kind, notes.type, notes.text?.slice(0, 3)], ["text", undefined, "BMI"]);
  assert.equal(((await reader.read({ cwd: work, path: "notes.md", purpose: "image" })) as any).refused, "not_image");

  writeFileSync(join(work, "gifs.md"), "GIF8 frames are listed below.\n");
  assert.equal(((await reader.read({ cwd: work, path: "gifs.md", purpose: "text" })) as any).kind, "text");

  const cars = join(work, "cars.csv");
  writeFileSync(cars, "BMW,320i,2019\n".repeat(Math.ceil((textReadLimit + 1) / 14)));
  try {
    assert.equal(((await reader.read({ cwd: work, path: "cars.csv", purpose: "text" })) as any).refused, "too_large");
  } finally {
    rmSync(cars);
  }

  // One pixel, 24 bits: the file header, then a BITMAPINFOHEADER (40 bytes).
  const bmp = Buffer.alloc(58);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(58, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  writeFileSync(join(work, "pixel.bmp"), bmp);
  for (const purpose of ["image", "text"] as const) {
    const answer = (await reader.read({ cwd: work, path: "pixel.bmp", purpose })) as any;
    assert.deepEqual([answer.kind, answer.type], ["image", "image/bmp"], purpose);
  }
  assert.equal(imageType(bmp.subarray(0, 32)), "image/bmp");
  assert.equal(imageType(Buffer.from("BMI is weight over height squared.")), undefined);
  assert.equal(imageType(Buffer.from("BM")), undefined);
  assert.equal(imageType(Buffer.from("GIF87a")), "image/gif");
  assert.equal(imageType(Buffer.from("GIF8 frames")), undefined);
});

// MARK: On the wire

let bridge: TestBridge;

test("file.read on the wire: listed in gateway.ready, for a thread not followed, from outside its folder, refused for no such thread", async () => {
  bridge = await startTestBridge({ temporaryFolders: [] });
  try {
    const client = await TestClient.open(bridge);
    assert.ok(client.readyPayload.bridge.features.includes("file_read"));
    const thread = await createThread(client, { cwd: realpathSync(tmpdir()) });
    // Its folder is the temporary one, General in tests.
    const folder = mkdtempSync(join(realpathSync(tmpdir()), "file-read-wire-"));
    try {
      writeFileSync(join(folder, "a.png"), png);
      const other = await TestClient.open(bridge);
      const answer = await other.call("file.read", { session_id: thread, path: join(folder, "a.png"), purpose: "image" });
      assert.equal(answer.kind, "image");
      assert.deepEqual(Buffer.from(answer.data, "base64"), png);
      const text = await other.call("file.read", { session_id: thread, path: join(folder, "a.png") });
      assert.equal(text.kind, "image");
      const hosts = await other.call("file.read", { session_id: thread, path: "/etc/hosts", purpose: "text" });
      assert.equal(hosts.kind, "text");
      assert.equal((await other.call("file.read", { session_id: thread, path: "/etc", purpose: "text" })).refused, "not_file");
      await assert.rejects(other.call("file.read", { session_id: "no-such-thread", path: "a.png" }), (error: any) => error.code === 4007);
      await assert.rejects(other.call("file.read", { session_id: thread, path: "a.png", purpose: "video" }), (error: any) => error.code === -32602);
      await other.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    await client.close();
  } finally {
    await bridge.dispose();
  }
});

test("the fake agent's picture turn shows images the bridge gives, from its folder and outside it, and names a file that is not one", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "file-read-fake-")));
  const pictures = await startTestBridge({ temporaryFolders: [], config: { generalFolder: folder } });
  try {
    const client = await TestClient.open(pictures);
    const thread = await createThread(client);
    const { runTurn, streamedText } = await import("./helpers.ts");
    const events = await runTurn(client, thread, "imagetest: show me a picture");
    const text = streamedText(events);
    assert.match(text, /!\[Sales by month\]\(fake-pictures\/sales-chart\.png\)/);
    const chart = await client.call("file.read", { session_id: thread, path: "fake-pictures/sales-chart.png", purpose: "image" });
    assert.equal(chart.type, "image/png");
    const notes = await client.call("file.read", { session_id: thread, path: join(folder, "fake-pictures", "notes.md") });
    assert.match(notes.text, /Line 42: the edited line/);
    assert.match(text, /!\[Not an image\]\(\/etc\/hosts\)/);
    assert.equal((await client.call("file.read", { session_id: thread, path: "/etc/hosts", purpose: "image" })).refused, "not_image");
    assert.equal((await client.call("file.read", { session_id: thread, path: "/etc/hosts", purpose: "text" })).kind, "text");
    const plot = /!\[A tall gradient\]\(([^)]+)\)/.exec(text)?.[1];
    assert.ok(plot);
    // Outside the thread's folder: given all the same.
    assert.ok(!plot.startsWith(folder));
    const shown = await client.call("file.read", { session_id: thread, path: plot, purpose: "image" });
    assert.deepEqual([shown.kind, shown.type], ["image", "image/png"]);
    assert.equal((await client.call("file.read", { session_id: thread, path: plot, purpose: "text" })).kind, "image");
    rmSync(plot, { force: true });
    await client.close();
  } finally {
    await pictures.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});
