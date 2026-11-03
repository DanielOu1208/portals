import "./environment.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitHead } from "../src/git.ts";
import { projectTrust } from "../src/providers/codex/options.ts";

function folder(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "portals-git-security-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

// A bad metadata file must not hold the test runner itself: the child is killed if
// opening a pipe waits, as it did before all the readers used nonblocking opens.
async function readInChild(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", source], { timeout: 2000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

for (const marker of ["HEAD", ".git"]) {
  test(`reading a branch never waits on a pipe in place of ${marker}`, async (t) => {
    const root = folder(t);
    const module = JSON.stringify(new URL("../src/git.ts", import.meta.url).href);
    const repo = join(root, marker);
    mkdirSync(repo);
    if (marker === "HEAD") mkdirSync(join(repo, ".git"));
    execFileSync("mkfifo", [marker === "HEAD" ? join(repo, ".git", "HEAD") : join(repo, ".git")]);
    await readInChild(`import { gitHead } from ${module}; if (await gitHead(${JSON.stringify(repo)}) !== null) process.exit(1);`);
  });
}

test("reading a branch refuses an oversized HEAD or worktree pointer rather than reading it whole", async (t) => {
  const repo = folder(t);
  const kept = join(repo, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "HEAD"), `ref: refs/heads/${"a".repeat(70 * 1024)}\n`);
  writeFileSync(join(repo, ".git"), `gitdir: ${kept}\n`);
  assert.equal(await gitHead(repo), null);
  writeFileSync(join(kept, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, ".git"), `gitdir: ${kept}\n${" ".repeat(70 * 1024)}`);
  assert.equal(await gitHead(repo), null);
});

test("Codex's project trust never waits on a pipe in place of .git", async (t) => {
  const repo = folder(t);
  execFileSync("mkfifo", [join(repo, ".git")]);
  const module = JSON.stringify(new URL("../src/providers/codex/options.ts", import.meta.url).href);
  await readInChild(`import { projectTrust } from ${module}; if (projectTrust(${JSON.stringify(repo)}, {}) !== null) process.exit(1);`);
});

test("Codex's project trust does not follow an oversized worktree pointer", (t) => {
  const repo = folder(t);
  const main = join(repo, "main");
  writeFileSync(join(repo, ".git"), `gitdir: ${main}/.git/worktrees/feature\n${" ".repeat(70 * 1024)}`);
  assert.equal(projectTrust(repo, { [main]: "trusted" }), null);
});
