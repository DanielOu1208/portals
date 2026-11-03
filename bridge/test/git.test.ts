import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gitHead } from "../src/git.ts";
import { createThread, runTurn, startTestBridge, TestClient, type Frame } from "./helpers.ts";

// The branch of a thread's folder (feature thread_branch): read from git's own files,
// shown by /status and kept for the list every device shows, as a turn starts and ends.

/** A folder made to look like a repository: `.git/HEAD` says `head`. */
function repository(t: TestContext, head: string): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-git-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, ".git"));
  writeFileSync(join(folder, ".git", "HEAD"), head);
  return folder;
}

test("the branch is read from the repository a folder is in, a worktree's too; a detached HEAD gives its commit", async (t) => {
  const repo = repository(t, "ref: refs/heads/night/phone-wins\n");
  assert.deepEqual(await gitHead(repo), { branch: "night/phone-wins", commit: null });
  // A folder inside the repository.
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  assert.deepEqual(await gitHead(join(repo, "src", "deep")), { branch: "night/phone-wins", commit: null });

  // A worktree: its `.git` is a file naming where git keeps it, relative or not.
  const kept = join(repo, ".git", "worktrees", "other");
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, "HEAD"), "ref: refs/heads/feature\n");
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "portals-worktree-")));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  writeFileSync(join(worktree, ".git"), `gitdir: ${kept}\n`);
  assert.deepEqual(await gitHead(worktree), { branch: "feature", commit: null });

  writeFileSync(join(kept, "HEAD"), "4f2c9a1d0e6b8c7a5f3e2d1c0b9a8f7e6d5c4b3a\n");
  assert.deepEqual(await gitHead(worktree), { branch: null, commit: "4f2c9a1" });
  // Refs in a reftable, and a HEAD that cannot be read, say nothing.
  writeFileSync(join(kept, "HEAD"), "ref: refs/heads/.invalid\n");
  assert.equal(await gitHead(worktree), null);
  writeFileSync(join(worktree, ".git"), "nonsense");
  assert.equal(await gitHead(worktree), null);
});

test("a folder in no repository has no branch", async (t) => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "portals-plain-")));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  // The temporary folder is in no repository on a test machine.
  assert.equal(await gitHead(plain), null);
});

test("/status names the folder's branch now, and the list carries it as of the last turn's start or end", async (t) => {
  const repo = repository(t, "ref: refs/heads/main\n");
  const bridge = await startTestBridge({ config: { generalFolder: repo } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
  });
  assert.ok(client.readyPayload.bridge.features.includes("thread_branch"));
  const listed = async (thread: string): Promise<Frame> => {
    const changes = await client.call("threads.changes", {});
    return changes.threads.find((row: Frame) => row.id === thread);
  };
  const thread = await createThread(client);
  assert.match((await client.call("slash.exec", { session_id: thread, command: "status" })).output, /^Agent: fake\nFolder: .+\nBranch: main\nModel: /);
  await runTurn(client, thread, "hello");
  await waitFor(async () => (await listed(thread)).branch === "main");
  // The read as the turn ended, done: it changes nothing to wait on, and a busy machine
  // (several suites at once) has taken more than 50 ms over it.
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Checked out at the desk: /status says so at once, the list after the next turn.
  checkout(repo, "ref: refs/heads/fix-login\n");
  assert.match((await client.call("slash.exec", { session_id: thread, command: "status" })).output, /\nBranch: fix-login\n/);
  assert.equal((await listed(thread)).branch, "main");
  const before = (await client.call("sessions.activity")).thread_list.revision;
  await runTurn(client, thread, "again");
  await waitFor(async () => (await listed(thread)).branch === "fix-login");
  assert.ok((await listed(thread)).revision > before);

  // Detached: /status gives the commit, and the list no branch.
  await new Promise((resolve) => setTimeout(resolve, 500));
  checkout(repo, "4f2c9a1d0e6b8c7a5f3e2d1c0b9a8f7e6d5c4b3a\n");
  assert.match((await client.call("slash.exec", { session_id: thread, command: "status" })).output, /\nBranch: none, at commit 4f2c9a1\n/);
  await runTurn(client, thread, "once more");
  await waitFor(async () => (await listed(thread)).branch === undefined);
});

test("/status has no branch line for a folder in no repository, and the list no branch", async (t) => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "portals-plain-")));
  const bridge = await startTestBridge({ config: { generalFolder: plain } });
  const client = await TestClient.open(bridge);
  t.after(async () => {
    await client.close();
    await bridge.dispose();
    rmSync(plain, { recursive: true, force: true });
  });
  const thread = await createThread(client);
  await runTurn(client, thread, "hello");
  assert.doesNotMatch((await client.call("slash.exec", { session_id: thread, command: "status" })).output, /Branch/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const row = (await client.call("threads.changes", {})).threads.find((entry: Frame) => entry.id === thread);
  assert.equal(row.branch, undefined);
});

/** Checks out `head` as git does: the new HEAD written beside it, then put in its place. */
function checkout(repo: string, head: string): void {
  writeFileSync(join(repo, ".git", "HEAD.lock"), head);
  renameSync(join(repo, ".git", "HEAD.lock"), join(repo, ".git", "HEAD"));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
