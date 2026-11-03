import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { AppIcons, Openers } from "../src/openers.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { Provider, UsageReport } from "../src/providers/types.ts";
import { findGit } from "../src/sessions/fileSearch.ts";
import { DiffSplitter, gitDiffs, gitStatus, parseStatus } from "../src/sessions/gitStatus.ts";
import { createThread, startTestBridge, TestClient } from "./helpers.ts";

// The panel beside the chat (features git_status, usage_read, open_on_host): what a
// thread's repository holds uncommitted, its agent's usage, and the apps its folder opens in.

const git = findGit();

function folder(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "portals-panel-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function repo(t: TestContext): string {
  const root = folder(t);
  const run = (...args: string[]) => execFileSync(git!, args, { cwd: root, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  writeFileSync(join(root, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "gone.txt"), "a\nb\n");
  writeFileSync(join(root, "old name.txt"), "same\n");
  run("add", ".");
  run("commit", "-q", "-m", "first");
  return root;
}

test("git's porcelain v2 status is read: branch, upstream, ahead and behind, and each kind of change", () => {
  const output = [
    "# branch.oid 0123456789abcdef0123456789abcdef01234567",
    "# branch.head feature/panel",
    "# branch.upstream origin/feature/panel",
    "# branch.ab +3 -1",
    "1 .M N... 100644 100644 100644 aaaa bbbb src/a b.ts",
    "1 M. N... 100644 100644 100644 aaaa bbbb staged.ts",
    "1 A. N... 000000 100644 100644 0000 bbbb new.ts",
    "1 .D N... 100644 100644 000000 aaaa aaaa deleted.ts",
    "2 R. N... 100644 100644 100644 aaaa aaaa R100 renamed.ts",
    "was.ts",
    "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc both.ts",
    "? untracked file.md",
    "",
  ].join("\0");
  const status = parseStatus(Buffer.from(output));
  assert.equal(status.branch, "feature/panel");
  assert.equal(status.commit, "0123456");
  assert.equal(status.upstream, "origin/feature/panel");
  assert.equal(status.ahead, 3);
  assert.equal(status.behind, 1);
  assert.deepEqual(
    status.files.map((file) => [file.path, file.status, file.staged, file.from ?? null]),
    [
      ["src/a b.ts", "modified", false, null],
      ["staged.ts", "modified", true, null],
      ["new.ts", "added", true, null],
      ["deleted.ts", "deleted", false, null],
      ["renamed.ts", "renamed", true, "was.ts"],
      ["both.ts", "conflicted", false, null],
      ["untracked file.md", "untracked", false, null],
    ],
  );
});

test("a detached HEAD before the first commit has neither branch nor commit", () => {
  const status = parseStatus(Buffer.from(["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0")));
  assert.equal(status.branch, null);
  assert.equal(status.commit, null);
  assert.equal(status.upstream, null);
});

test("a repository's uncommitted files, with the lines each adds and removes, from a folder inside it", { skip: !git && "no git" }, async (t) => {
  const root = repo(t);
  writeFileSync(join(root, "kept.txt"), "one\n2\nthree\nfour\n");
  rmSync(join(root, "gone.txt"));
  writeFileSync(join(root, "fresh.md"), "x\ny\nz");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "binary.bin"), Buffer.from([0, 1, 2, 3]));
  execFileSync(git!, ["mv", "old name.txt", "new name.txt"], { cwd: root });
  const answer = await gitStatus(join(root, "sub"), git);
  assert.ok(answer.repo && answer.git);
  assert.equal(answer.root, root);
  assert.equal(answer.branch, "main");
  assert.match(answer.commit ?? "", /^[0-9a-f]{7}$/);
  assert.equal(answer.upstream, null);
  const files = Object.fromEntries(answer.files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(files).sort(), ["fresh.md", "gone.txt", "kept.txt", "new name.txt", "sub/binary.bin"]);
  assert.deepEqual([files["kept.txt"].status, files["kept.txt"].added, files["kept.txt"].removed], ["modified", 2, 1]);
  assert.deepEqual([files["gone.txt"].status, files["gone.txt"].added, files["gone.txt"].removed], ["deleted", 0, 2]);
  assert.deepEqual([files["fresh.md"].status, files["fresh.md"].added], ["untracked", 3]);
  assert.deepEqual([files["new name.txt"].status, files["new name.txt"].from, files["new name.txt"].staged], ["renamed", "old name.txt", true]);
  assert.equal(files["sub/binary.bin"].added, null);
  assert.equal(answer.total, 5);
  assert.equal(answer.added, 2 + 3);
  assert.equal(answer.removed, 1 + 2);
});

test("a folder in no repository is said to be in none", { skip: !git && "no git" }, async (t) => {
  assert.deepEqual(await gitStatus(folder(t), git), { repo: false });
});

test("with no git to run, the branch read from git's own files is all there is", async (t) => {
  const root = folder(t);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/topic\n");
  assert.deepEqual(await gitStatus(root, null), { repo: true, git: false, branch: "topic", commit: null });
  assert.deepEqual(await gitStatus(folder(t), null), { repo: false });
});

test("all that is not committed as one diff, file by file, a file git does not track yet as all added", { skip: !git && "no git" }, async (t) => {
  const root = repo(t);
  writeFileSync(join(root, "kept.txt"), "one\n2\nthree\n");
  rmSync(join(root, "gone.txt"));
  writeFileSync(join(root, "fresh.md"), "hello\n");
  const { root: top, files } = await gitDiffs(root, git);
  assert.equal(top, root);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ["fresh.md", "gone.txt", "kept.txt"]);
  assert.match(byPath["kept.txt"].diff, /^-two$/m);
  assert.match(byPath["kept.txt"].diff, /^\+2$/m);
  assert.equal(byPath["kept.txt"].status, "modified");
  assert.match(byPath["gone.txt"].diff, /^-a$/m);
  assert.match(byPath["fresh.md"].diff, /^\+hello$/m);
  assert.equal(byPath["fresh.md"].added, 1);
  assert.ok(files.every((file) => !file.cut));
  await assert.rejects(gitDiffs(folder(t), git), /not in a git repository/);
});

test("a diff of several files is split by the path each has now, however it comes in pieces", () => {
  const text = [
    "diff --git a/a.ts b/a.ts", "index 1..2 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-x", "+y",
    "diff --git a/old name.ts b/new name.ts", "similarity index 90%", "rename from old name.ts", "rename to new name.ts", "--- a/old name.ts\t", "+++ b/new name.ts\t", "@@ -1 +1 @@", "-p", "+q",
    "diff --git a/gone.ts b/gone.ts", "deleted file mode 100644", "--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-z",
    'diff --git "a/tab\\there \\303\\251.ts" "b/tab\\there \\303\\251.ts"', 'Binary files "a/tab\\there \\303\\251.ts" and "b/tab\\there \\303\\251.ts" differ',
    "diff --git a/mode only.sh b/mode only.sh", "old mode 100644", "new mode 100755",
    "",
  ].join("\n");
  const whole = new DiffSplitter(Infinity);
  whole.feed(Buffer.from(text));
  whole.end();
  const pieces = new DiffSplitter(Infinity);
  for (const byte of Buffer.from(text)) pieces.feed(Buffer.from([byte]));
  pieces.end();
  assert.deepEqual([...pieces.files], [...whole.files]);
  assert.deepEqual([...whole.files.keys()], ["a.ts", "new name.ts", "gone.ts", "tab\there é.ts", "mode only.sh"]);
  assert.match(whole.files.get("new name.ts")!.diff, /^\+q$/m);
  assert.match(whole.files.get("gone.ts")!.diff, /^-z$/m);
  assert.match(whole.files.get("mode only.sh")!.diff, /^new mode 100755$/m);
  assert.ok([...whole.files.values()].every((file) => !file.cut));
});

test("a diff split in little room keeps what fits, marks the rest cut, and a read stopped early marks its last file cut", () => {
  const part = (name: string, lines: number) => [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1 @@", ...Array.from({ length: lines }, () => "+a line")].join("\n") + "\n";
  const split = new DiffSplitter(part("a", 10).length + part("c", 1).length);
  split.feed(Buffer.from(part("a", 10) + part("b", 1000)));
  split.feed(Buffer.from(part("c", 1)));
  split.end();
  assert.deepEqual([...split.files].map(([path, file]) => [path, file.cut, file.diff.length > 0]), [["a", false, true], ["b", true, false], ["c", false, true]]);
  assert.equal(split.room, 0);

  const stopped = new DiffSplitter(1000);
  stopped.feed(Buffer.from(part("a", 1) + part("b", 1)));
  stopped.end(false);
  assert.deepEqual([...stopped.files].map(([path, file]) => [path, file.cut]), [["a", false], ["b", true]]);
});

test("a type change, which git gives as two parts of one file, keeps both or neither", () => {
  const parts = 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-file\ndiff --git a/x b/x\nnew file mode 120000\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+link\n';
  const split = new DiffSplitter(Infinity);
  split.feed(Buffer.from(parts));
  split.end();
  assert.equal(split.files.get("x")!.diff, parts);
  const small = new DiffSplitter(parts.indexOf("diff --git a/x b/x\nnew") + 1);
  small.feed(Buffer.from(parts));
  small.end();
  assert.deepEqual(small.files.get("x"), { diff: "", cut: true });
});

test("a part of a file that ends up cut gives its room back: only what stays in the answer is charged", () => {
  const first = "diff --git a/x b/x\ndeleted file mode 120000\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-link\n";
  const second = `diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+${"x".repeat(500)}\n`;
  const next = "diff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n+y\n";
  const room = first.length + next.length;
  const split = new DiffSplitter(room);
  split.feed(Buffer.from(first + second + next));
  split.end();
  assert.deepEqual(split.files.get("x"), { diff: "", cut: true });
  assert.deepEqual(split.files.get("y"), { diff: next, cut: false });
  assert.equal(split.room, room - next.length);

  // A part after the file was cut, which fitted, takes none either.
  const later = new DiffSplitter(first.length + 10);
  later.feed(Buffer.from(second + first));
  later.end();
  assert.deepEqual(later.files.get("x"), { diff: "", cut: true });
  assert.equal(later.room, first.length + 10);

  // What is charged is what the answer holds: a byte that is not UTF-8 comes back as three.
  const bad = Buffer.concat([Buffer.from("diff --git a/b b/b\n+"), Buffer.alloc(40, 0xff), Buffer.from("\n")]);
  const narrow = new DiffSplitter(bad.length + 1);
  narrow.feed(bad);
  narrow.end();
  assert.deepEqual(narrow.files.get("b"), { diff: "", cut: true });
});

test("the apps a folder opens in are those installed, the Finder first, then editors, then terminals, each with its icon", async () => {
  const installed = new Set(["/System/Library/CoreServices/Finder.app", "/Applications/Cursor.app", "/System/Applications/Utilities/Terminal.app", "/Users/me/Applications/Ghostty.app"]);
  const drawn: string[][] = [];
  const icons = new AppIcons(async (bundles) => {
    drawn.push(bundles);
    // Ghostty's could not be drawn.
    return Object.fromEntries(bundles.filter((bundle) => !bundle.includes("Ghostty")).map((bundle) => [bundle, `png:${bundle}`]));
  });
  const openers = new Openers("macos", ["/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices", "/Users/me/Applications"], (path) => installed.has(path), icons);
  const apps = await openers.apps();
  assert.deepEqual(
    apps.map((app) => [app.id, app.kind, app.icon ?? null]),
    [
      ["finder", "files", "png:/System/Library/CoreServices/Finder.app"],
      ["cursor", "editor", "png:/Applications/Cursor.app"],
      ["terminal", "terminal", "png:/System/Applications/Utilities/Terminal.app"],
      ["ghostty", "terminal", null],
    ],
  );
  // Drawn once: only the one that could not be is tried again.
  await openers.apps();
  assert.equal(drawn.length, 2);
  assert.deepEqual(new Set(drawn[0]), installed);
  assert.deepEqual(drawn[1], ["/Users/me/Applications/Ghostty.app"]);
});

test("an app that is not installed, or a folder that is gone or is a file, is refused with why", async (t) => {
  const work = folder(t);
  writeFileSync(join(work, "a.command"), "#!/bin/sh\n");
  const opened: string[][] = [];
  const launcher = async (_command: string, args: string[]) => void opened.push(args);
  const openers = new Openers("macos", ["/Applications"], () => false, undefined, launcher);
  await assert.rejects(openers.open("cursor", work), /not on this computer/);
  const finder = new Openers("macos", ["/Apps"], (path) => path === "/Apps/Finder.app", undefined, launcher);
  await assert.rejects(finder.open("finder", "/gone"), /not there any more/);
  await assert.rejects(finder.open("finder", join(work, "a.command")), /not there any more/);
  assert.deepEqual(opened, []);
  const linux = new Openers("linux", [], (path) => path === "/usr/bin/xdg-open", undefined, launcher);
  assert.deepEqual(await linux.apps(), [{ id: "files", name: "Files", kind: "files" }]);
  await assert.rejects(linux.open("vscode", work), /not on this computer/);
});

test("the Finder is named like any app, and a folder that is a bundle is only shown in it, since it would run the bundle even named", async (t) => {
  const plain = folder(t);
  const bundle = join(plain, "Probe.app");
  mkdirSync(bundle);
  const opened: [string, string[]][] = [];
  const openers = new Openers("macos", ["/Apps"], (path) => path === "/Apps/Finder.app" || path === "/Apps/Zed.app", undefined, async (command, args) => void opened.push([command, args]), async (path) => path === bundle);
  await openers.open("finder", plain);
  await openers.open("finder", bundle);
  await openers.open("zed", bundle);
  assert.deepEqual(opened, [["/usr/bin/open", ["-a", "/Apps/Finder.app", plain]], ["/usr/bin/open", ["-R", bundle]], ["/usr/bin/open", ["-a", "/Apps/Zed.app", bundle]]]);
});

test("whether a folder is a bundle is the system's word, on a Mac", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const plain = folder(t);
  const bundle = join(plain, "Probe.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  const shown: string[][] = [];
  const openers = new Openers("macos", ["/Apps"], (path) => path === "/Apps/Finder.app", undefined, async (_command, args) => void shown.push(args));
  await openers.open("finder", plain);
  await openers.open("finder", bundle);
  assert.deepEqual(shown, [["-a", "/Apps/Finder.app", plain], ["-R", bundle]]);
});

test("a thread's folder that is now a link is opened as what it points to, so a link to a bundle is only shown in the Finder", async (t) => {
  const base = folder(t);
  const bundle = join(base, "Probe.app");
  const real = join(base, "real");
  mkdirSync(bundle);
  mkdirSync(real);
  symlinkSync(bundle, join(base, "link-to-app"));
  symlinkSync(bundle, join(base, "link.app"));
  symlinkSync(real, join(base, "link-to-folder"));
  symlinkSync(join(base, "gone"), join(base, "dangling"));
  const opened: [string, string[]][] = [];
  const launcher = async (command: string, args: string[]) => void opened.push([command, args]);
  // The system's word is asked of the real path only: a link it says no to.
  const openers = new Openers("macos", ["/Apps"], (path) => path === "/Apps/Finder.app" || path === "/Apps/Zed.app", undefined, launcher, async (path) => path === bundle);
  await openers.open("finder", join(base, "link-to-app"));
  await openers.open("finder", join(base, "link.app"));
  await openers.open("zed", join(base, "link-to-app"));
  await openers.open("finder", join(base, "link-to-folder"));
  await assert.rejects(openers.open("finder", join(base, "dangling")), /not there any more/);
  const linux = new Openers("linux", [], () => true, undefined, launcher);
  await linux.open("files", join(base, "link-to-folder"));
  assert.deepEqual(opened, [
    ["/usr/bin/open", ["-R", bundle]],
    ["/usr/bin/open", ["-R", bundle]],
    ["/usr/bin/open", ["-a", "/Apps/Zed.app", bundle]],
    ["/usr/bin/open", ["-a", "/Apps/Finder.app", real]],
    ["/usr/bin/xdg-open", [real]],
  ]);
});

test("a link to a bundle is a bundle by the system's word too, on a Mac", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const base = folder(t);
  const bundle = join(base, "Probe.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  symlinkSync(bundle, join(base, "link-to-app"));
  const shown: string[][] = [];
  // The launcher is a fake: nothing is opened or run.
  const openers = new Openers("macos", ["/Apps"], (path) => path === "/Apps/Finder.app", undefined, async (_command, args) => void shown.push(args));
  await openers.open("finder", join(base, "link-to-app"));
  assert.deepEqual(shown, [["-R", bundle]]);
});

test("over the gateway: git.status, usage.read and host.apps for a thread, and folder.open refusing an app it does not have", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  for (const feature of ["git_status", "usage_read", "open_on_host"]) assert.ok((bridgeFeatures as readonly string[]).includes(feature));
  const thread = await createThread(client);
  const status = await client.call("git.status", { session_id: thread });
  assert.equal(typeof status.repo, "boolean");
  // The usual fake says nothing of a plan.
  assert.deepEqual(await client.call("usage.read", { session_id: thread }), { available: false });
  assert.ok(Array.isArray((await client.call("host.apps")).apps));
  await assert.rejects(client.call("folder.open", { session_id: thread, app: "no-such-app" }), { code: -32602 });
  await assert.rejects(client.call("git.status", { session_id: "no-such-thread" }), { code: 4007 });
});

test("usage.read over the wire: one call a minute, whoever asks, a failure held as long as an answer, each window's length and its own heard_at", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const directory = folder(t);
  let asked = 0;
  let answer: () => Promise<UsageReport> = async () => ({
    plan: "max",
    limits: [
      { name: "weekly", percent: 12, resetsAt: 1794000000, windowSeconds: 604800 },
      { name: "weekly Fable", percent: 3, resetsAt: null, windowSeconds: 604800, heardAt: 1793000000000, reached: true },
    ],
  });
  const agent = new FakeProvider({ directory, delayMs: 1, usage: true });
  (agent as { usage?: Provider["usage"] }).usage = () => ((asked += 1), answer());
  const bridge = await startTestBridge({ providers: new Map<string, Provider>([["fake", agent]]) });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  const thread = await createThread(client);
  const other = await createThread(client);

  const [one, two] = await Promise.all([client.call("usage.read", { session_id: thread }), client.call("usage.read", { session_id: other })]);
  assert.equal(asked, 1);
  assert.deepEqual(one, two);
  assert.deepEqual(one, {
    available: true,
    plan: "max",
    title: "Fake agent Max",
    limits: [
      { name: "weekly", percent: 12, resets_at: 1794000000, window_seconds: 604800 },
      { name: "weekly Fable", percent: 3, resets_at: null, reached: true, window_seconds: 604800, heard_at: 1793000000000 },
    ],
  });
  t.mock.timers.tick(59_000);
  await client.call("usage.read", { session_id: thread });
  assert.equal(asked, 1);

  // A minute on it is asked again, and failing, its failure stands as long.
  t.mock.timers.tick(2_000);
  answer = async () => {
    throw new Error("Factory answered 429.");
  };
  const failing = await Promise.allSettled([client.call("usage.read", { session_id: thread }), client.call("usage.read", { session_id: other })]);
  assert.equal(asked, 2);
  assert.ok(failing.every((result) => result.status === "rejected" && /did not say how much is used: Factory answered 429\./.test(result.reason.message)));
  t.mock.timers.tick(30_000);
  await assert.rejects(client.call("usage.read", { session_id: thread }), /Factory answered 429/);
  assert.equal(asked, 2);

  answer = async () => ({ limits: [] });
  t.mock.timers.tick(31_000);
  assert.deepEqual((await client.call("usage.read", { session_id: thread })).limits, []);
  assert.equal(asked, 3);
});

test("usage.read names the plan as people do, and says how long each window is", async () => {
  const { usageTitle } = await import("../src/gateway/methods.ts");
  assert.equal(usageTitle("claude", "Claude Code", "max"), "Claude Max");
  assert.equal(usageTitle("codex", "Codex", "Pro 100"), "Codex Pro 100");
  assert.equal(usageTitle("droid", "Droid", "max"), "Factory Max");
  assert.equal(usageTitle("pi", "Pi", undefined), "Pi");
  assert.equal(usageTitle("claude", "Claude Code", "team_premium"), "Claude Team Premium");

  const { planUsageReport } = await import("../src/providers/claude/usage.ts");
  const claude = planUsageReport({
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2026-11-01T20:00:00Z" },
      seven_day: { utilization: 65, resets_at: "2026-11-05T20:00:00Z" },
      // Fable's, nothing used of it yet, as Claude Code's /usage shows it ("Current week (Fable): 0% used").
      model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-11-05T20:00:00Z" }],
    },
  })!;
  assert.deepEqual(claude.limits.map((limit) => [limit.name, limit.percent, limit.windowSeconds]), [["5-hour", 12, 18000], ["weekly", 65, 604800], ["weekly Fable", 0, 604800]]);

  const { usageReport } = await import("../src/providers/codex/stream.ts");
  const codex = usageReport({ rateLimits: { limitId: "codex", primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1793774147 }, planType: "prolite" } as never });
  assert.equal(codex.plan, "Pro 100");
  assert.equal(codex.limits[0].windowSeconds, 604800);
});
