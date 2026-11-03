import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { findGit } from "../src/sessions/fileSearch.ts";
import { gitDiffs, GitStatusError, gitStatus, type GitFileDiff } from "../src/sessions/gitStatus.ts";

// What the panel reads of a repository it does not control (`git.status`, `git.diff`): a
// repository's settings run nothing, and every file comes back with its diff or says it
// was cut, whatever its name, its content or git's settings.

const git = findGit();
const skip = !git && "no git";

function folder(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "portals-panel-git-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function run(root: string, ...args: string[]): string {
  return execFileSync(git!, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function seed(root: string, files: Record<string, string> = { "a.txt": "one\ntwo\n" }): string {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "user.name", "Test");
  run(root, "config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  run(root, "add", ".");
  run(root, "commit", "-q", "-m", "first");
  return root;
}

/** A command that leaves a mark when it runs, and passes its input on as a filter must. */
function marker(t: TestContext): { script: string; ran: () => number } {
  const base = folder(t);
  const mark = join(base, "ran");
  const script = join(base, "evil.sh");
  writeFileSync(script, `#!/bin/sh\necho ran >> '${mark}'\ncat\n`);
  chmodSync(script, 0o755);
  return { script, ran: () => (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n").length : 0) };
}

/** One read of each kind, and its files by path. */
async function both(root: string): Promise<Record<string, GitFileDiff>> {
  await gitStatus(root, git);
  const { files } = await gitDiffs(root, git);
  return Object.fromEntries(files.map((file) => [file.path, file]));
}

/** `.git/index` as it is now, to see it was not written. */
function indexState(root: string): string {
  const path = join(root, ".git", "index");
  return `${statSync(path).mtimeMs} ${readFileSync(path).toString("hex")}`;
}

/** A hook that leaves a mark if it runs. */
function hook(root: string, mark: string): void {
  const path = join(root, ".git", "hooks", "post-index-change");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ran >> '${mark}'\n`);
  chmodSync(path, 0o755);
}

function marks(mark: string): number {
  return existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n").length : 0;
}

/** `body` with these in the environment the host was started with. */
async function withEnvironment<T>(names: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(names).map((name) => [name, process.env[name]]));
  Object.assign(process.env, names);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Points git at a user's config of `text`, for this test. */
function globalConfig(t: TestContext, text: string): void {
  const path = join(folder(t), "gitconfig");
  writeFileSync(path, text);
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path;
  t.after(() => {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  });
}

// MARK: A repository's settings run nothing

test("a filter set in the repository's own config does not run, on a same-size edit either, and the diff is still right", { skip }, async (t) => {
  const root = seed(folder(t));
  const evil = marker(t);
  run(root, "config", "filter.x.clean", evil.script);
  run(root, "config", "filter.x.smudge", evil.script);
  run(root, "config", "filter.x.required", "true");
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=x\n");
  writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
  const files = await both(root);
  assert.equal(evil.ran(), 0);
  assert.match(files["a.txt"].diff, /^\+ONE$/m);
  assert.deepEqual([files["a.txt"].added, files["a.txt"].removed, files["a.txt"].cut], [2, 2, false]);
});

test("a filter's long-running process does not run either, nor one a repository's include names, nor one for a file git does not track yet", { skip }, async (t) => {
  const process_ = seed(folder(t));
  const evil = marker(t);
  run(process_, "config", "filter.x.process", evil.script);
  writeFileSync(join(process_, ".git", "info", "attributes"), "* filter=x\n");
  writeFileSync(join(process_, "a.txt"), "ONE\nTWO\n");
  writeFileSync(join(process_, "new.txt"), "new\n");
  await both(process_);
  assert.equal(evil.ran(), 0);

  const included = seed(folder(t));
  const extra = join(folder(t), "extra.cfg");
  writeFileSync(extra, `[filter "y"]\n\tclean = ${evil.script}\n`);
  run(included, "config", "include.path", extra);
  writeFileSync(join(included, ".git", "info", "attributes"), "* filter=y\n");
  writeFileSync(join(included, "a.txt"), "ONE\nTWO\n");
  writeFileSync(join(included, "new.txt"), "new\n");
  const files = await both(included);
  assert.equal(evil.ran(), 0);
  assert.match(files["new.txt"].diff, /^\+new$/m);
});

test("a filter set for one worktree does not run, and a name with a space in it is blanked like any other", { skip }, async (t) => {
  const root = seed(folder(t));
  const evil = marker(t);
  run(root, "config", "extensions.worktreeConfig", "true");
  run(root, "config", "--worktree", "filter.w.clean", evil.script);
  run(root, "config", "filter.with space.clean", evil.script);
  run(root, "config", "filter.dotted.name.clean", evil.script);
  writeFileSync(join(root, ".git", "info", "attributes"), "a.txt filter=w\nb.txt filter=dotted.name\n");
  writeFileSync(join(root, "b.txt"), "new\n");
  writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
  const files = await both(root);
  assert.equal(evil.ran(), 0);
  assert.match(files["a.txt"].diff, /^\+ONE$/m);
  assert.match(files["b.txt"].diff, /^\+new$/m);
});

test("a filter whose name git's -c cannot blank (an = in it) stops the read before anything can run it", { skip }, async (t) => {
  const root = seed(folder(t));
  const evil = marker(t);
  run(root, "config", "filter.a=b.clean", evil.script);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=a=b\n");
  writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
  assert.deepEqual(await gitStatus(root, git), { repo: false });
  await assert.rejects(gitDiffs(root, git), /not in a git repository/);
  assert.equal(evil.ran(), 0);
});

test("a filter with an empty name is blanked too", { skip }, async (t) => {
  const root = seed(folder(t));
  const evil = marker(t);
  run(root, "config", "filter..clean", evil.script);
  run(root, "config", "filter..process", evil.script);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=\n");
  writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  const files = await both(root);
  assert.equal(evil.ran(), 0);
  assert.match(files["a.txt"].diff, /^\+ONE$/m);
});

test("a filter whose name is not UTF-8 cannot be blanked, so the repository reads as none, whatever the locale, and the person's own is no matter", { skip }, async (t) => {
  const locale = process.env.LC_ALL;
  t.after(() => {
    if (locale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = locale;
  });
  // In a UTF-8 locale git leaves such a name out of what a pattern matches.
  for (const language of ["C", "C.UTF-8"]) {
    process.env.LC_ALL = language;
    for (const name of [Buffer.from([0xc3]), Buffer.from([0xff, 0xfe])]) {
      const root = seed(folder(t));
      const evil = marker(t);
      const config = join(root, ".git", "config");
      writeFileSync(config, Buffer.concat([readFileSync(config), Buffer.from('[filter "'), name, Buffer.from(`"]\n\tclean = ${evil.script}\n\tprocess = ${evil.script}\n`)]));
      writeFileSync(join(root, ".git", "info", "attributes"), Buffer.concat([Buffer.from("* filter="), name, Buffer.from("\n")]));
      writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
      assert.deepEqual(await gitStatus(root, git), { repo: false }, language);
      await assert.rejects(gitDiffs(root, git), /not in a git repository/);
      assert.equal(evil.ran(), 0, language);
    }
  }

  // In the person's own config it is not this repository's doing, and need not be blanked.
  const global = join(folder(t), "gitconfig");
  writeFileSync(global, Buffer.concat([Buffer.from('[filter "'), Buffer.from([0xc3]), Buffer.from('"]\n\tclean = cat\n')]));
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  t.after(() => {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
  });
  const theirs = seed(folder(t));
  writeFileSync(join(theirs, "a.txt"), "ONE\nTWO\n");
  assert.ok((await gitStatus(theirs, git)).repo);
});

test("a core.worktree into a second repository reads none of that one's settings: its filter does not run", { skip }, async (t) => {
  const first = seed(folder(t));
  const second = seed(folder(t));
  const evil = marker(t);
  run(second, "config", "filter.x.clean", evil.script);
  run(second, "config", "filter.x.process", evil.script);
  writeFileSync(join(second, ".git", "info", "attributes"), "* filter=x\n");
  writeFileSync(join(second, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(second, "a.txt"), "OTHER\n");
  run(first, "config", "core.worktree", second);
  const status = await gitStatus(first, git);
  assert.ok(status.repo && status.git);
  assert.equal(status.root, second);
  const files = await both(first);
  assert.equal(evil.ran(), 0);
  // What is compared is the first's HEAD and the folder it names, as `git status` there says.
  assert.match(files["a.txt"].diff, /^\+OTHER$/m);
  assert.match(files["a.txt"].diff, /^-one$/m);
});

test("a .git file naming another repository's directory reads that one's settings alone, its filters blanked", { skip }, async (t) => {
  const other = seed(folder(t));
  const evil = marker(t);
  run(other, "config", "filter.x.clean", evil.script);
  writeFileSync(join(other, ".git", "info", "attributes"), "* filter=x\n");
  const root = folder(t);
  writeFileSync(join(root, ".git"), `gitdir: ${join(other, ".git")}\n`);
  writeFileSync(join(root, "a.txt"), "ONE\nTWO\n");
  const status = await gitStatus(root, git);
  assert.ok(status.repo && status.git);
  assert.equal(status.root, root);
  assert.match((await both(root))["a.txt"].diff, /^\+ONE$/m);
  assert.equal(evil.ran(), 0);
});

test("a linked worktree is read as itself, from a folder inside it too, with the main repository's filters and its own blanked", { skip }, async (t) => {
  const main = seed(folder(t), { "a.txt": "one\n" });
  mkdirSync(join(main, "inner"));
  writeFileSync(join(main, "inner", "b.txt"), "one\n");
  run(main, "add", ".");
  run(main, "commit", "-q", "-m", "inner");
  const evil = marker(t);
  const linked = join(folder(t), "linked");
  run(main, "worktree", "add", "-q", "-b", "side", linked);
  run(main, "config", "extensions.worktreeConfig", "true");
  run(main, "config", "filter.common.clean", evil.script);
  run(linked, "config", "--worktree", "filter.own.clean", evil.script);
  writeFileSync(join(linked, ".gitattributes"), "a.txt filter=common\ninner/b.txt filter=own\n");
  writeFileSync(join(linked, "a.txt"), "ONE\nTWO\n");
  writeFileSync(join(linked, "inner", "b.txt"), "ONE\nTWO\n");
  writeFileSync(join(main, "a.txt"), "main's own change\n");
  const status = await gitStatus(join(linked, "inner"), git);
  assert.ok(status.repo && status.git);
  assert.equal(status.root, linked);
  assert.equal(status.branch, "side");
  assert.deepEqual(status.files.map((file) => file.path).sort(), [".gitattributes", "a.txt", "inner/b.txt"]);
  const { root, files } = await gitDiffs(join(linked, "inner"), git);
  assert.equal(root, linked);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.match(byPath["a.txt"].diff, /^\+ONE$/m);
  assert.match(byPath["inner/b.txt"].diff, /^\+TWO$/m);
  assert.equal(evil.ran(), 0);
});

test("a thread inside a submodule, whose own config sets core.worktree, reads the submodule, its filters blanked", { skip }, async (t) => {
  const inner = seed(folder(t), { "a.txt": "inner\n" });
  const root = seed(folder(t));
  run(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
  run(root, "commit", "-q", "-m", "sub");
  const sub = join(root, "sub");
  assert.match(run(sub, "config", "core.worktree"), /sub/);
  const evil = marker(t);
  run(sub, "config", "filter.x.clean", evil.script);
  writeFileSync(join(sub, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(sub, "a.txt"), "CHANGED\nLINES\n");
  const status = await gitStatus(sub, git);
  assert.ok(status.repo && status.git);
  assert.equal(status.root, sub);
  const files = await both(sub);
  assert.deepEqual(Object.keys(files).sort(), [".gitattributes", "a.txt"]);
  assert.match(files["a.txt"].diff, /^\+CHANGED$/m);
  assert.equal(evil.ran(), 0);
});

test("a read writes no index and runs no hook: a file only touched, the same in a repository that names its own hooks", { skip }, async (t) => {
  const root = seed(folder(t));
  const mark = join(folder(t), "ran");
  hook(root, mark);
  // Stat-dirty: not a byte changed, its time not what the index holds.
  const touch = () => {
    const hourAgo = new Date(Date.now() - 3_600_000 * (touched += 1));
    utimesSync(join(root, "a.txt"), hourAgo, hourAgo);
  };
  let touched = 0;
  touch();
  const named = join(folder(t), "hooks");
  mkdirSync(named);
  writeFileSync(join(named, "post-index-change"), `#!/bin/sh\necho ran >> '${mark}'\n`);
  chmodSync(join(named, "post-index-change"), 0o755);

  const before = indexState(root);
  const files = await both(root);
  assert.equal(marks(mark), 0);
  assert.equal(indexState(root), before);
  // Touched and not changed: nothing to list, as ever.
  assert.deepEqual(Object.keys(files), []);

  run(root, "config", "core.hooksPath", named);
  touch();
  const again = indexState(root);
  await both(root);
  assert.equal(marks(mark), 0);
  assert.equal(indexState(root), again);
});

test("the first read of a repository as it comes from a tarball, every file stat-dirty: no hook runs, the index is not written, and nothing is listed", { skip }, async (t) => {
  const base = folder(t);
  const original = seed(join(base, "orig"), { "a.txt": "one\n", "b.txt": "b\n" });
  const mark = join(base, "ran");
  hook(original, mark);
  execFileSync("/usr/bin/tar", ["-cf", join(base, "t.tar"), "-C", base, "orig"]);
  const elsewhere = join(base, "x");
  mkdirSync(elsewhere);
  execFileSync("/usr/bin/tar", ["-xf", join(base, "t.tar"), "-C", elsewhere]);
  const root = join(elsewhere, "orig");
  const before = indexState(root);
  const status = await gitStatus(root, git);
  assert.ok(status.repo && status.git);
  assert.deepEqual(status.files, []);
  const { files } = await gitDiffs(root, git);
  assert.deepEqual(files, []);
  assert.equal(marks(mark), 0);
  assert.equal(indexState(root), before);
});

test("the host's own GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE, as from inside a git hook, do not change which repository is read", { skip }, async (t) => {
  const here = seed(folder(t));
  writeFileSync(join(here, "a.txt"), "ONE\ntwo\n");
  const other = seed(folder(t), { "OTHER.txt": "other\n" });
  writeFileSync(join(other, "OTHER.txt"), "changed\n");
  const paths = (answer: Awaited<ReturnType<typeof gitStatus>>) => (answer.repo && answer.git ? [answer.root, answer.files.map((file) => [file.path, file.status])] : answer);
  const inherited = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git", "index"), GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"), GIT_COMMON_DIR: join(other, ".git"), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other, ".git", "objects") };
  const answer = await withEnvironment(inherited, () => gitStatus(here, git));
  assert.deepEqual(paths(answer), [here, [["a.txt", "modified"]]]);
  const { root, files } = await withEnvironment(inherited, () => gitDiffs(here, git));
  assert.equal(root, here);
  assert.match(files[0].diff, /^\+ONE$/m);
  // Each alone.
  for (const [name, value] of Object.entries({ GIT_INDEX_FILE: join(other, ".git", "index"), GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"), GIT_COMMON_DIR: join(other, ".git") })) {
    assert.deepEqual(paths(await withEnvironment({ [name]: value }, () => gitStatus(here, git))), [here, [["a.txt", "modified"]]], name);
  }
});

test("a filter from the person's own git config still works, unless the repository sets that name too", { skip }, async (t) => {
  const upper = join(folder(t), "upper.sh");
  writeFileSync(upper, "#!/bin/sh\ntr a-z A-Z\n");
  chmodSync(upper, 0o755);
  const evil = marker(t);
  globalConfig(t, `[filter "up"]\n\tclean = ${upper}\n[filter "both"]\n\tclean = ${upper}\n\trequired = true\n`);
  const root = seed(folder(t), { "a.txt": "ONE\n" });
  writeFileSync(join(root, ".git", "info", "attributes"), "a.txt filter=up\n");
  // The filter is what turns this into capitals: "one" here is "ONE" in what git compares.
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  const files = await both(root);
  assert.match(files["a.txt"].diff, /^\+TWO$/m);
  assert.doesNotMatch(files["a.txt"].diff, /^-ONE$/m);

  const shadowed = seed(folder(t), { "a.txt": "one\n" });
  run(shadowed, "config", "filter.both.clean", evil.script);
  writeFileSync(join(shadowed, ".git", "info", "attributes"), "a.txt filter=both\n");
  writeFileSync(join(shadowed, "a.txt"), "two\n");
  const answer = await both(shadowed);
  assert.equal(evil.ran(), 0);
  // Blanked whole: not even the person's half of that name, which would turn it to capitals.
  assert.match(answer["a.txt"].diff, /^\+two$/m);
});

test("git lfs install --local's settings: the read works with no git-lfs to run, a changed file showing as what is on disk", { skip }, async (t) => {
  // What a checked-out LFS file looks like: its pointer in HEAD, its real content on disk.
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 4\n";
  const root = seed(folder(t), { "big.bin": pointer, "a.txt": "one\n" });
  run(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
  run(root, "config", "filter.lfs.smudge", "git-lfs smudge -- %f");
  run(root, "config", "filter.lfs.process", "git-lfs filter-process");
  run(root, "config", "filter.lfs.required", "true");
  writeFileSync(join(root, ".git", "info", "attributes"), "*.bin filter=lfs\n");
  writeFileSync(join(root, "big.bin"), "real\n");
  const files = await both(root);
  assert.deepEqual(Object.keys(files), ["big.bin"]);
  assert.match(files["big.bin"].diff, /^-version https:\/\/git-lfs/m);
  assert.match(files["big.bin"].diff, /^\+real$/m);
});

test("a submodule's own filter and external diff do not run, and its new commits still show", { skip }, async (t) => {
  const inner = seed(folder(t), { "a.txt": "inner\n" });
  const root = seed(folder(t));
  run(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub");
  run(root, "commit", "-q", "-m", "sub");
  const evil = marker(t);
  const sub = join(root, "sub");
  // The superproject has a submodule's diff shown in full, which is a child `git diff`.
  run(root, "config", "diff.submodule", "diff");
  run(sub, "config", "diff.external", evil.script);
  run(sub, "config", "filter.x.clean", evil.script);
  run(sub, "config", "core.attributesFile", join(sub, "attributes"));
  writeFileSync(join(sub, "attributes"), "* filter=x\n");
  writeFileSync(join(sub, "a.txt"), "dirty\n");
  const dirty = await both(root);
  assert.equal(evil.ran(), 0);
  // What it costs: a submodule with only uncommitted changes inside it is not listed.
  assert.deepEqual(Object.keys(dirty), []);

  writeFileSync(join(sub, "a.txt"), "inner\n");
  run(sub, "-c", "core.attributesFile=", "-c", "filter.x.clean=", "commit", "-q", "--allow-empty", "-m", "next");
  const moved = await both(root);
  assert.equal(evil.ran(), 0);
  assert.deepEqual(Object.keys(moved), ["sub"]);
  assert.match(moved.sub.diff, /^\+Subproject commit /m);
});

test("a blob this partial clone does not have is not fetched: no ssh command runs, and git.diff says so in a plain sentence", { skip }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, "a.txt"), "two\nversions\n");
  run(root, "commit", "-q", "-a", "-m", "second");
  const blob = run(root, "rev-parse", "HEAD:a.txt").trim();
  writeFileSync(join(root, "a.txt"), "dirty\n");
  rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
  const evil = marker(t);
  run(root, "config", "core.repositoryformatversion", "1");
  run(root, "config", "extensions.partialClone", "origin");
  run(root, "config", "remote.origin.url", "ssh://example.invalid/x.git");
  run(root, "config", "remote.origin.promisor", "true");
  run(root, "config", "core.sshCommand", evil.script);
  await assert.rejects(gitDiffs(root, git), (error: Error) => {
    assert.ok(error instanceof GitStatusError, error.message);
    assert.doesNotMatch(error.message, /Command failed/);
    assert.match(error.message, /not on this computer/);
    return true;
  });
  assert.equal(evil.ran(), 0);
});

test("on a git too old for GIT_NO_LAZY_FETCH, the fetch it starts can use no transport, whatever the repository allows", { skip }, async (t) => {
  // What git before 2.45 does: as if GIT_NO_LAZY_FETCH was not set.
  const old = join(folder(t), "git");
  writeFileSync(old, `#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec '${git}' "$@"\n`);
  chmodSync(old, 0o755);
  const root = seed(folder(t));
  writeFileSync(join(root, "a.txt"), "two\nversions\n");
  run(root, "commit", "-q", "-a", "-m", "second");
  const blob = run(root, "rev-parse", "HEAD:a.txt").trim();
  writeFileSync(join(root, "a.txt"), "dirty\n");
  rmSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });
  const evil = marker(t);
  run(root, "config", "core.repositoryformatversion", "1");
  run(root, "config", "extensions.partialClone", "origin");
  run(root, "config", "remote.origin.promisor", "true");
  run(root, "config", "protocol.ssh.allow", "always");
  run(root, "config", "protocol.ext.allow", "always");
  run(root, "config", "protocol.file.allow", "always");
  run(root, "config", "core.sshCommand", evil.script);
  run(root, "config", "remote.origin.uploadpack", evil.script);
  for (const url of ["ssh://example.invalid/x.git", `ext::${evil.script}`, folder(t)]) {
    run(root, "config", "remote.origin.url", url);
    await assert.rejects(gitDiffs(root, old), (error: Error) => {
      assert.ok(error instanceof GitStatusError, error.message);
      assert.match(error.message, /not on this computer/, url);
      return true;
    });
    assert.equal(evil.ran(), 0, url);
  }
});

test("past the limit a filter of the person's that hangs holds nothing: the answer comes, and every file it did not reach says cut, a binary one too", { skip, timeout: 60_000 }, async (t) => {
  const base = folder(t);
  const started = join(base, "started");
  const slow = join(base, "slow.sh");
  writeFileSync(slow, `#!/bin/sh\necho ran >> '${started}'\nsleep 40\ncat\n`);
  chmodSync(slow, 0o755);
  globalConfig(t, `[filter "slow"]\n\tclean = ${slow}\n`);
  const root = seed(folder(t), { "a.txt": "one\n", "bin.dat": "one\n" });
  writeFileSync(join(root, ".git", "info", "attributes"), "a.txt filter=slow\n");
  writeFileSync(join(root, "a.txt"), "changed, a different size\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  const limit = 1500;
  const from = Date.now();
  const { files } = await gitDiffs(root, git, limit);
  const took = Date.now() - from;
  assert.equal(marks(started) > 0, true, "the filter ran, or nothing was tested");
  // One limit for the counts, one for the diff, and git's grace, however long the filter sleeps.
  assert.ok(took < limit * 2 + 4000, `took ${took} ms`);
  assert.deepEqual(files.map((file) => [file.path, file.diff, file.cut]), [["a.txt", "", true], ["bin.dat", "", true]]);
});

for (const [name, settings] of [
  ["by default", []],
  ["with status.renames=false", [["status.renames", "false"]]],
] as const) {
  test(`a file moved and staged, then rewritten, ${name}, keeps the deletion of its old path with it`, { skip }, async (t) => {
    const lines = (word: string) => Array.from({ length: 100 }, (_, index) => `${word} ${index}\n`).join("");
    const root = seed(folder(t), { "old.txt": lines("old") });
    for (const [key, value] of settings) run(root, "config", key, value);
    run(root, "mv", "old.txt", "new.txt");
    writeFileSync(join(root, "new.txt"), lines("new"));
    const status = await gitStatus(root, git);
    assert.ok(status.repo && status.git);
    assert.deepEqual([status.total, status.added, status.removed], [1, 100, 100]);
    const { files } = await gitDiffs(root, git);
    assert.deepEqual(files.map((file) => [file.path, file.status, file.added, file.removed, file.cut]), [["new.txt", "renamed", 100, 100, false]]);
    assert.match(files[0].diff, /^-old 0$/m);
    assert.match(files[0].diff, /^\+new 0$/m);
  });
}

test("a file moved and rewritten, with a new file made at its old path: what was there is that path's deletion, beside what is there now", { skip }, async (t) => {
  const lines = (word: string) => Array.from({ length: 100 }, (_, index) => `${word} ${index}\n`).join("");
  const root = seed(folder(t), { "old.txt": lines("old") });
  run(root, "mv", "old.txt", "new.txt");
  writeFileSync(join(root, "new.txt"), lines("new"));
  writeFileSync(join(root, "old.txt"), lines("again"));
  const status = await gitStatus(root, git);
  assert.ok(status.repo && status.git);
  assert.deepEqual([status.total, status.added, status.removed], [2, 200, 100]);
  const { files } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual([byPath["new.txt"].status, byPath["new.txt"].added, byPath["new.txt"].removed, byPath["new.txt"].cut], ["renamed", 100, 0, false]);
  assert.deepEqual([byPath["old.txt"].status, byPath["old.txt"].added, byPath["old.txt"].removed, byPath["old.txt"].cut], ["untracked", 100, 100, false]);
  assert.match(byPath["old.txt"].diff, /^-old 0$/m);
  assert.match(byPath["old.txt"].diff, /^\+again 0$/m);
  assert.doesNotMatch(byPath["new.txt"].diff, /^-old 0$/m);
});

test("a moved file too large to show, its deletion and its new text being one file, leaves all its room for the next", { skip, timeout: 60_000 }, async (t) => {
  const line = "a line of text\n";
  const root = seed(folder(t), { "a-old.txt": "gone 1\ngone 2\n", "c-later.txt": "one\n" });
  run(root, "mv", "a-old.txt", "b-new.txt");
  writeFileSync(join(root, "b-new.txt"), line.repeat(Math.ceil((600 * 1024) / line.length)));
  // A file that fits only if the deletion gave its room back.
  const body = (size: number) => `${"x".repeat(size)}\n`;
  writeFileSync(join(root, "c-later.txt"), body(1000));
  const measured = run(root, "diff", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--", "c-later.txt").length;
  writeFileSync(join(root, "c-later.txt"), body(1000 + 512 * 1024 - 20 - measured));
  const { files } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual([byPath["b-new.txt"].status, byPath["b-new.txt"].diff, byPath["b-new.txt"].cut], ["renamed", "", true]);
  assert.equal(byPath["c-later.txt"].cut, false);
  assert.equal(Buffer.byteLength(byPath["c-later.txt"].diff), 512 * 1024 - 20);
});

test("the limit untracked files share holds for each: the last to start has only what is left of it", { skip, timeout: 60_000 }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, "u1.txt"), "one\n");
  writeFileSync(join(root, "u2.txt"), "two\n");
  const stub = join(folder(t), "git");
  writeFileSync(stub, `#!/bin/sh\ncase " $* " in\n*" --no-index "*" u1.txt "*) sleep 3; exec '${git}' "$@" ;;\n*" --no-index "*" u2.txt "*) exec sleep 20 ;;\nesac\nexec '${git}' "$@"\n`);
  chmodSync(stub, 0o755);
  const limit = 4000;
  const from = Date.now();
  const { files } = await gitDiffs(root, stub, limit);
  const took = Date.now() - from;
  // Given the whole limit, the second would end about 7 s in.
  assert.ok(took < 6000, `took ${took} ms`);
  assert.deepEqual(files.filter((file) => file.status === "untracked").map((file) => [file.path, file.cut]), [["u1.txt", false], ["u2.txt", true]]);
});

test("the diff says how many files differ in all, from the same look as the files it lists", { skip }, async (t) => {
  const root = seed(folder(t));
  for (let index = 0; index < 301; index += 1) writeFileSync(join(root, `f${index}.txt`), "x\n");
  const { files, total } = await gitDiffs(root, git);
  assert.deepEqual([files.length, total], [300, 301]);
});

test("a git that will not go when told is killed, and what came before the limit is kept", { skip, timeout: 60_000 }, async (t) => {
  const root = seed(folder(t), { "a.txt": "one\n", "b.txt": "one\n" });
  writeFileSync(join(root, "a.txt"), "two\n");
  writeFileSync(join(root, "b.txt"), Buffer.from([0, 1, 2, 3]));
  const stub = join(folder(t), "git");
  const pid = join(folder(t), "pid");
  writeFileSync(stub, `#!/bin/sh\ncase " $* " in\n*" --numstat "*) exec '${git}' "$@" ;;\n*" diff "*" HEAD "*) trap '' TERM; echo $$ > '${pid}'; printf 'diff --git a/a.txt b/a.txt\\n--- a/a.txt\\n+++ b/a.txt\\n@@ -1 +1 @@\\n-one\\n+two\\n'; sleep 20; exit 0 ;;\nesac\nexec '${git}' "$@"\n`);
  chmodSync(stub, 0o755);
  const limit = 1000;
  const from = Date.now();
  const { files } = await gitDiffs(root, stub, limit);
  const took = Date.now() - from;
  assert.ok(took < limit + 4000, `took ${took} ms`);
  // The last part that came may not be all of it, and the one never reached is no empty diff.
  assert.deepEqual(files.map((file) => [file.path, file.diff, file.cut]), [["a.txt", "", true], ["b.txt", "", true]]);
  // Killed, not left running; a moment for the system to take it away.
  const gone = () => {
    try {
      process.kill(Number(readFileSync(pid, "utf8")), 0);
      return false;
    } catch {
      return true;
    }
  };
  for (let tries = 0; tries < 40 && !gone(); tries += 1) await new Promise((done) => setTimeout(done, 50));
  assert.ok(gone(), "still running");
});

test("a git stopped at the limit holding its pipes after it has gone is not waited for either", { skip, timeout: 60_000 }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, "a.txt"), "two\n");
  const stub = join(folder(t), "git");
  writeFileSync(stub, `#!/bin/sh\ncase " $* " in\n*" --numstat "*) exec '${git}' "$@" ;;\n*" diff "*" HEAD "*) sleep 20 & exit 0 ;;\nesac\nexec '${git}' "$@"\n`);
  chmodSync(stub, 0o755);
  const from = Date.now();
  const { files } = await gitDiffs(root, stub, 1000);
  assert.ok(Date.now() - from < 5000);
  assert.deepEqual(files.map((file) => [file.path, file.cut]), [["a.txt", true]]);
});

// MARK: Every file comes back

test("each file's diff comes back whatever its name: spaces, a tab, a line feed, a quote, a backslash, non-ASCII, a leading dash", { skip }, async (t) => {
  const names = ["with space.txt", "dir with/inner.txt", "tab\there.txt", "tab and\tspace.txt", "line\nfeed.txt", 'quo"te.txt', "back\\slash.txt", "é ü.txt", "日本語.txt", "-dash.txt", "+++ b.txt", "--- a.txt", "\u0001control.txt"];
  const root = folder(t);
  mkdirSync(join(root, "dir with"));
  seed(root, Object.fromEntries(names.map((name) => [name, "one\n"])));
  for (const name of names) writeFileSync(join(root, name), "two\n");
  const files = await both(root);
  assert.deepEqual(Object.keys(files).sort(), [...names].sort());
  for (const name of names) {
    const file = files[name];
    assert.equal(file.status, "modified", name);
    assert.deepEqual([file.added, file.removed, file.cut], [1, 1, false], name);
    assert.match(file.diff, /^-one$/m, name);
    assert.match(file.diff, /^\+two$/m, name);
  }
});

test("a file renamed, deleted, or new with such a name keeps its diff, by the path it has now", { skip }, async (t) => {
  const root = seed(folder(t), { "old name.txt": "same\nlines\nhere\n", "gone space.txt": "bye\n", 'old"quote.txt': "same\nlines\nhere\ntoo\n" });
  run(root, "mv", "old name.txt", "new name.txt");
  run(root, "mv", 'old"quote.txt', 'new"quote.txt');
  writeFileSync(join(root, "new name.txt"), "same\nlines\nhere\nmore\n");
  rmSync(join(root, "gone space.txt"));
  writeFileSync(join(root, "fresh space.txt"), "hello\n");
  run(root, "add", "fresh space.txt");
  const files = await both(root);
  assert.match(files["new name.txt"].diff, /^\+more$/m);
  assert.match(files['new"quote.txt'].diff, /^rename to "new\\"quote.txt"$/m);
  assert.match(files["gone space.txt"].diff, /^-bye$/m);
  assert.match(files["fresh space.txt"].diff, /^\+hello$/m);
  assert.ok(Object.values(files).every((file) => !file.cut));
});

test("a binary file, a mode change and an emptied new file keep what git says of them, with no hunk to show", { skip }, async (t) => {
  const root = seed(folder(t), { "bin.dat": "one\n", "script.sh": "echo\n" });
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  chmodSync(join(root, "script.sh"), 0o755);
  writeFileSync(join(root, "empty file.txt"), "");
  run(root, "add", "empty file.txt");
  const files = await both(root);
  assert.match(files["bin.dat"].diff, /^Binary files a\/bin\.dat and b\/bin\.dat differ$/m);
  assert.match(files["script.sh"].diff, /^new mode 100755$/m);
  assert.match(files["empty file.txt"].diff, /^new file mode 100644$/m);
  assert.ok(Object.values(files).every((file) => !file.cut));
});

test("a line of a changed file cannot start a file of its own: a bare CR or U+2028 is not a line's end", { skip }, async (t) => {
  const forged = (separator: string) => `+shown${separator}diff --git a/n b/n${separator}+++ b/not-listed.txt${separator}+hidden${separator}\nkept\n`;
  const root = seed(folder(t), { "cr.txt": "one\n", "ls.txt": "one\n", "victim.txt": "one\n" });
  writeFileSync(join(root, "cr.txt"), forged("\r"));
  writeFileSync(join(root, "ls.txt"), forged(" "));
  writeFileSync(join(root, "victim.txt"), "two\n");
  const files = await both(root);
  for (const name of ["cr.txt", "ls.txt"]) {
    assert.match(files[name].diff, /hidden/, name);
    assert.match(files[name].diff, /^\+kept$/m, name);
  }
  assert.doesNotMatch(files["victim.txt"].diff, /hidden|FORGED|not-listed/);
  assert.match(files["victim.txt"].diff, /^\+two$/m);
});

test("a line of a changed file that looks like a file's header, after the hunk began, is the diff's text and not its name", { skip }, async (t) => {
  const root = seed(folder(t), { "a.txt": "one\n" });
  writeFileSync(join(root, "a.txt"), "++ b/other.txt\n-- a/other.txt\n");
  const files = await both(root);
  assert.deepEqual(Object.keys(files), ["a.txt"]);
  assert.match(files["a.txt"].diff, /^\+\+\+ b\/other\.txt$/m);
});

for (const [setting, value] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"]] as const) {
  test(`${setting} changes nothing: tracked files keep their diffs, from the repository's settings or the person's`, { skip }, async (t) => {
    const here = seed(folder(t));
    run(here, "config", setting, value);
    writeFileSync(join(here, "a.txt"), "ONE\ntwo\n");
    assert.match((await both(here))["a.txt"].diff, /^\+ONE$/m);

    const [section, key] = setting.split(".");
    globalConfig(t, `[${section}]\n\t${key} = ${value}\n`);
    const theirs = seed(folder(t));
    writeFileSync(join(theirs, "a.txt"), "ONE\ntwo\n");
    assert.match((await both(theirs))["a.txt"].diff, /^\+ONE$/m);
  });
}

test("a listed tracked file with counts whose diff git did not give comes back cut, never as an empty diff marked whole", { skip }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, "a.txt"), "ONE\ntwo\n");
  // A git that gives the counts and then no diff text, for whatever reason.
  const stub = join(folder(t), "git");
  writeFileSync(stub, `#!/bin/sh\ncase " $* " in\n*" --numstat "*) exec '${git}' "$@" ;;\n*" diff "*) exit 0 ;;\nesac\nexec '${git}' "$@"\n`);
  chmodSync(stub, 0o755);
  const { files } = await gitDiffs(root, stub);
  assert.deepEqual(files.map((file) => [file.path, file.added, file.removed, file.diff, file.cut]), [["a.txt", 1, 1, "", true]]);
});

test("a file staged and put back as HEAD has it is listed with nothing to show, and is not called cut", { skip }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, "a.txt"), "ONE\n");
  run(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "one\ntwo\n");
  const { files } = await gitDiffs(root, git);
  assert.deepEqual(files.map((file) => [file.path, file.diff, file.cut]), [["a.txt", "", false]]);
});

test("a diff too large to hold: the small files still come back, the huge one is cut, and the answer does not fail", { skip, timeout: 60_000 }, async (t) => {
  const root = seed(folder(t), { "a small.txt": "one\n", "z small.txt": "one\n" });
  writeFileSync(join(root, "a small.txt"), "two\n");
  writeFileSync(join(root, "z small.txt"), "two\n");
  // Past the 64 MB a single read of git holds, in a file only marked to be added.
  const line = "a line of text long enough to fill the file up quickly enough\n";
  writeFileSync(join(root, "m huge.txt"), line.repeat(Math.ceil((70 * 1024 * 1024) / line.length)));
  run(root, "add", "--intent-to-add", "m huge.txt");
  const { files } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual([byPath["m huge.txt"].diff, byPath["m huge.txt"].cut], ["", true]);
  assert.equal(byPath["m huge.txt"].added, Math.ceil((70 * 1024 * 1024) / line.length));
  for (const name of ["a small.txt", "z small.txt"]) {
    assert.equal(byPath[name].cut, false, name);
    assert.match(byPath[name].diff, /^\+two$/m, name);
  }
});

test("past 512 KB a file too large for what is left is cut, and those after it that fit still come back", { skip }, async (t) => {
  const root = seed(folder(t), { "a.txt": "one\n", "b.txt": "one\n", "c.txt": "one\n" });
  const line = "x".repeat(99) + "\n";
  writeFileSync(join(root, "a.txt"), line.repeat(3000));
  writeFileSync(join(root, "b.txt"), line.repeat(3000));
  writeFileSync(join(root, "c.txt"), "two\n");
  writeFileSync(join(root, "d.txt"), "new\n");
  const { files } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.equal(byPath["a.txt"].cut, false);
  assert.deepEqual([byPath["b.txt"].cut, byPath["b.txt"].diff], [true, ""]);
  assert.equal(byPath["c.txt"].cut, false);
  assert.match(byPath["c.txt"].diff, /^\+two$/m);
  assert.equal(byPath["d.txt"].cut, false);
  assert.match(byPath["d.txt"].diff, /^\+new$/m);
  assert.ok(files.reduce((all, file) => all + Buffer.byteLength(file.diff), 0) <= 512 * 1024);
});

test("a part of a type change that ends up cut leaves its room for the next file", { skip, timeout: 60_000 }, async (t) => {
  const root = seed(folder(t), { "b.txt": "one\n" });
  symlinkSync("target", join(root, "a link"));
  run(root, "add", ".");
  run(root, "commit", "-q", "-m", "link");
  // A link become a file too large to fit: two parts, a small one, then one that does not.
  unlinkSync(join(root, "a link"));
  const line = "a line of text\n";
  writeFileSync(join(root, "a link"), line.repeat(Math.ceil((600 * 1024) / line.length)));
  assert.equal(lstatSync(join(root, "a link")).isFile(), true);
  // Then a file that fits only if the small part gave its room back.
  const body = (size: number) => `${"x".repeat(size)}\n`;
  writeFileSync(join(root, "b.txt"), body(1000));
  const measured = run(root, "diff", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--", "b.txt").length;
  writeFileSync(join(root, "b.txt"), body(1000 + 512 * 1024 - 20 - measured));
  const { files } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  assert.deepEqual([byPath["a link"].diff, byPath["a link"].cut], ["", true]);
  assert.equal(byPath["b.txt"].cut, false);
  assert.equal(Buffer.byteLength(byPath["b.txt"].diff), 512 * 1024 - 20);
});

for (const [name, settings] of [
  ["diff.renames=false", [["diff.renames", "false"]]],
  ["status.renames=false", [["status.renames", "false"]]],
  ["diff.renames=copies", [["diff.renames", "copies"]]],
  ["status.renameLimit=1", [["status.renameLimit", "1"]]],
  ["diff.renameLimit=1", [["diff.renameLimit", "1"]]],
] as const) {
  test(`with ${name} a moved file is one entry in the list and the diff, its old path left with no empty diff`, { skip }, async (t) => {
    const text = (word: string) => `${word} and a good many lines that stay the same\n`.repeat(20);
    const root = seed(folder(t), { "big.txt": text("big"), "other.txt": text("other") });
    for (const [key, value] of settings) run(root, "config", key, value);
    run(root, "mv", "big.txt", "moved.txt");
    run(root, "mv", "other.txt", "moved too.txt");
    // Changed as well: a move of the same bytes is found whatever the limit.
    writeFileSync(join(root, "moved.txt"), `${text("big")}one more\n`);
    writeFileSync(join(root, "moved too.txt"), `${text("other")}one more\n`);
    run(root, "add", ".");
    const files = await both(root);
    assert.deepEqual(Object.keys(files).sort(), ["moved too.txt", "moved.txt"]);
    for (const file of Object.values(files)) {
      assert.equal(file.status, "renamed", file.path);
      assert.equal(file.cut, false, file.path);
      assert.match(file.diff, /^rename to /m, file.path);
    }
  });
}

// MARK: Before the first commit, and the folder's name

test("a repository with no commit yet: one combined diff and counts against nothing, what is staged and what is not as one", { skip }, async (t) => {
  const root = folder(t);
  run(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "staged-old\n");
  run(root, "add", "a.txt");
  writeFileSync(join(root, "a.txt"), "working-final\n");
  writeFileSync(join(root, "only staged.txt"), "kept\n");
  run(root, "add", "only staged.txt");
  writeFileSync(join(root, "untracked.txt"), "new\n");
  const status = await gitStatus(root, git);
  assert.ok(status.repo && status.git);
  assert.equal(status.commit, null);
  assert.deepEqual([status.added, status.removed], [3, 0]);
  const files = Object.fromEntries(status.files.map((file) => [file.path, [file.added, file.removed]]));
  assert.deepEqual(files, { "a.txt": [1, 0], "only staged.txt": [1, 0], "untracked.txt": [1, 0] });
  const { files: diffs } = await gitDiffs(root, git);
  const byPath = Object.fromEntries(diffs.map((file) => [file.path, file]));
  assert.match(byPath["a.txt"].diff, /^\+working-final$/m);
  assert.doesNotMatch(byPath["a.txt"].diff, /staged-old/);
  assert.equal(byPath["a.txt"].diff.match(/^diff --git /gm)?.length, 1);
  assert.match(byPath["only staged.txt"].diff, /^\+kept$/m);
  assert.ok(diffs.every((file) => !file.cut));
});

test("a repository whose folder's name ends in a space or a line feed is read from that folder", { skip }, async (t) => {
  const base = folder(t);
  for (const name of ["trailing space ", "trailing feed\n"]) {
    const root = seed(join(base, name));
    writeFileSync(join(root, "a.txt"), "ONE\ntwo\n");
    const status = await gitStatus(root, git);
    assert.ok(status.repo && status.git, JSON.stringify(name));
    assert.equal(status.root, root);
    assert.equal(status.total, 1);
    assert.match((await gitDiffs(root, git)).files[0].diff, /^\+ONE$/m);
  }
});

test("new files have their lines counted however many tracked files changed before them", { skip }, async (t) => {
  const many = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`t${index}`, "one\n"]));
  const root = seed(folder(t), many);
  for (const path of Object.keys(many)) writeFileSync(join(root, path), "two\n");
  writeFileSync(join(root, "zz-new.txt"), "a\nb\n");
  const status = await gitStatus(root);
  assert.ok(status.repo && status.git);
  assert.deepEqual([status.files.at(-1)?.path, status.files.at(-1)?.added, status.added, status.removed], ["zz-new.txt", 2, 122, 120]);
});

test("a link not tracked yet counts as the one line git shows of it, not as what it points at", { skip }, async (t) => {
  const root = seed(folder(t));
  writeFileSync(join(root, ".git", "long"), "line\n".repeat(5000));
  symlinkSync(join(root, ".git", "long"), join(root, "to a file"));
  symlinkSync(join(root, ".git"), join(root, "to a folder"));
  const files = await both(root);
  for (const path of ["to a file", "to a folder"]) assert.deepEqual([files[path].added, files[path].removed], [1, 0], path);
  assert.equal(files["to a file"].diff.split("\n").filter((line) => /^\+[^+]/.test(line)).length, 1);
  // git will not diff a link to a folder as a new file: said to be cut, not empty.
  assert.deepEqual([files["to a folder"].diff, files["to a folder"].cut], ["", true]);
});

test("files not tracked yet and too large to show leave the room for fifty that fit to the ones that do", { skip }, async (t) => {
  const root = seed(folder(t));
  const log = join(root, ".git", "log");
  writeFileSync(log, `${"x".repeat(79)}\n`.repeat(8000));
  for (let index = 0; index < 51; index += 1) linkSync(log, join(root, `big${String(index).padStart(2, "0")}.log`));
  writeFileSync(join(root, "small.txt"), "tiny\n");
  const { files } = await gitDiffs(root);
  const small = files.find((file) => file.path === "small.txt")!;
  assert.deepEqual([small.cut, small.diff.includes("+tiny")], [false, true]);
  assert.ok(files.filter((file) => file.path.endsWith(".log")).every((file) => file.cut && file.diff === ""));
});
