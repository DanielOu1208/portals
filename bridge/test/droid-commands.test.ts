import "./environment.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as commandsModule from "../src/providers/droid/commands.ts";
import { customCommands, expandCommand } from "../src/providers/droid/commands.ts";

function rig(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "portals-droid-commands-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), cwd = join(directory, "project");
  mkdirSync(home); mkdirSync(cwd);
  const put = (base: string, file: string, text: string) => {
    const path = join(base, ".factory", "commands", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  const list = (...names: string[]) => ({ commands: names.map((name) => ({ name, description: `SDK ${name}`, argumentHint: "[arguments]" })) });
  return { directory, home, cwd, put, list };
}

test("Droid custom commands discover safe Markdown without SDK metadata; project overrides user and nested files use filename slugs", (t) => {
  const r = rig(t);
  r.put(r.home, "Code Review.md", "Personal $ARGUMENTS");
  r.put(r.home, "personal.md", "Personal command");
  r.put(r.cwd, "nested/Code Review.md", "---\ndescription: local description\nargument-hint: [things]\n---\nProject $ARGUMENTS / $ARGUMENTS");
  r.put(r.cwd, "not-listed.md", "Available without starting a CLI.");
  r.put(r.cwd, "executable.sh", "printf must-never-run");
  r.put(r.cwd, "script.md", "Do not offer executable commands.");
  const listed = r.list("code-review", "personal", "script", "../../outside");
  listed.commands[2] = { ...listed.commands[2], ...{ isExecutable: true } };
  const commands = customCommands(listed, r.home, r.cwd);
  assert.deepEqual(commands.map(({ name, source, custom, skill }) => ({ name, source, custom, skill })), [
    { name: "code-review", source: "project", custom: true, skill: false },
    { name: "personal", source: "user", custom: true, skill: false },
    { name: "not-listed", source: "project", custom: true, skill: false },
  ]);
  assert.equal(commands[0].description, "SDK code-review", "metadata comes from the SDK, not a second YAML parser");
  assert.equal(commands[2].description, "Project Markdown command");
  assert.deepEqual(commands[0].expand?.("$(touch never); $&"), {
    message: "Project $(touch never); $& / $(touch never); $&", display: "/code-review $(touch never); $&",
  });
  const personal = customCommands(listed, r.home);
  assert.equal(personal[0].source, "user");
  assert.equal(personal[0].expand?.("now").message, "Personal now", "no thread means no inferred project cwd");
});

test("Droid command arguments are literal, replace every placeholder, and append when no placeholder exists", () => {
  assert.equal(expandCommand("$ARGUMENTS + $ARGUMENTS", "$&; `ignored`"), "$&; `ignored` + $&; `ignored`");
  assert.equal(expandCommand("Review", "carefully\nnow"), "Review\ncarefully\nnow");
  assert.equal(expandCommand("Review", ""), "Review");
  assert.equal(expandCommand("Review $ARGUMENTS", ""), "Review ");
});

test("Droid ignores escaping file/directory/root symlinks, ambiguous slugs, empty and malformed frontmatter", (t) => {
  const r = rig(t);
  const outside = join(r.directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "stolen.md"), "Outside command body");
  const linked = r.put(r.cwd, "seed.md", "seed");
  symlinkSync(join(outside, "stolen.md"), join(dirname(linked), "leak.md"));
  symlinkSync(outside, join(dirname(linked), "directory"));
  r.put(r.cwd, "one/duplicate.md", "one");
  r.put(r.cwd, "two/Duplicate.md", "two");
  r.put(r.home, "duplicate.md", "Do not fall back when the project is ambiguous.");
  r.put(r.cwd, "empty.md", " \n ");
  r.put(r.cwd, "broken.md", "---\ndescription: no closing delimiter");
  r.put(r.cwd, "large.md", "x".repeat(1_048_577));
  const listed = r.list("leak", "stolen", "duplicate", "empty", "broken", "large");
  assert.deepEqual(customCommands(listed, r.home, r.cwd).map((c) => c.name), ["seed"]);
  const linkedRoot = join(r.directory, "linked-root");
  mkdirSync(linkedRoot);
  mkdirSync(join(linkedRoot, ".factory"));
  symlinkSync(outside, join(linkedRoot, ".factory", "commands"));
  assert.deepEqual(customCommands(r.list("stolen"), r.home, linkedRoot).map((c) => c.name), ["duplicate"]);
});

test("Droid's command folders are read again only when something in them changed: a file written, added, removed or swapped for a link, also in a nested folder", (t) => {
  const r = rig(t);
  const reads = () => commandsModule.commandReadings;
  const names = () => customCommands({ commands: [] }, r.home, r.cwd).map((command) => `${command.name}:${command.expand?.("").message}`);
  const review = r.put(r.cwd, "review.md", "Review it");
  const nested = r.put(r.cwd, "deep/er/fix.md", "Fix it");
  assert.deepEqual(names(), ["fix:Fix it", "review:Review it"]);
  const once = reads();
  // Asked again with nothing changed: nothing is read.
  assert.deepEqual(names(), ["fix:Fix it", "review:Review it"]);
  assert.deepEqual(names(), ["fix:Fix it", "review:Review it"]);
  assert.equal(reads(), once);
  // A file written (its folder's time does not change), in the folder and deeper down.
  writeFileSync(review, "Review it twice");
  assert.deepEqual(names(), ["fix:Fix it", "review:Review it twice"]);
  writeFileSync(nested, "Fix it now");
  // Same size, older time: still seen, by its time.
  utimesSync(nested, new Date(1000), new Date(1000));
  assert.deepEqual(names(), ["fix:Fix it now", "review:Review it twice"]);
  writeFileSync(nested, "Fix it wow");
  utimesSync(nested, new Date(2000), new Date(2000));
  assert.deepEqual(names(), ["fix:Fix it wow", "review:Review it twice"]);
  // Added, renamed and removed.
  r.put(r.cwd, "deep/new.md", "New one");
  assert.deepEqual(names(), ["fix:Fix it wow", "new:New one", "review:Review it twice"]);
  renameSync(join(r.cwd, ".factory", "commands", "deep", "new.md"), join(r.cwd, ".factory", "commands", "deep", "newer.md"));
  assert.deepEqual(names(), ["fix:Fix it wow", "newer:New one", "review:Review it twice"]);
  rmSync(nested);
  assert.deepEqual(names(), ["newer:New one", "review:Review it twice"]);
  // A file swapped for a link to one outside is not offered.
  const outside = join(r.directory, "outside.md");
  writeFileSync(outside, "Outside");
  rmSync(review);
  symlinkSync(outside, review);
  assert.deepEqual(names(), ["newer:New one"]);
  // The home's commands are cached on their own.
  r.put(r.home, "mine.md", "Mine");
  assert.deepEqual(names(), ["mine:Mine", "newer:New one"]);
  const settled = reads();
  names();
  assert.equal(reads(), settled);
});

test("a command added in the tick its folder was read in is seen though the folder's time and size stay as they were, as on Linux's coarse clock and ext4", (t) => {
  const r = rig(t);
  const names = () => customCommands({ commands: [] }, r.home, r.cwd).map((command) => command.name);
  r.put(r.cwd, "review.md", "Review it");
  const folder = join(r.cwd, ".factory", "commands");
  const then = new Date(1_000_000);
  utimesSync(folder, then, then);
  assert.deepEqual(names(), ["review"]);
  // Added, and the folder's time put back: only its names say so.
  writeFileSync(join(folder, "fresh.md"), "New command");
  utimesSync(folder, then, then);
  assert.deepEqual(names(), ["fresh", "review"]);
  rmSync(join(folder, "fresh.md"));
  utimesSync(folder, then, then);
  assert.deepEqual(names(), ["review"]);
  // Renamed: on APFS too, where an entry added grows the folder, the size stays.
  renameSync(join(folder, "review.md"), join(folder, "check.md"));
  utimesSync(folder, then, then);
  assert.deepEqual(names(), ["check"]);
});
