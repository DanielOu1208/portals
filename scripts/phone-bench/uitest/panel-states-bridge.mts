// The fake agent with usage the plain one never gives, for PanelUITests.testUsageStates: more
// windows than a screen holds, one full but not marked reached, one past its reset, one kept
// from an earlier answer; and a failing usage.read while /private/tmp/portals-panel/states-mode.txt
// says "fail". The host holds an answer for a minute, a failure too (`usage.read`). Its General
// folder is a git repository with more changed files than a host lists, one binary and one too
// long among them, for PanelUITests.testDiffStates; or, while /private/tmp/portals-panel/states-git.txt
// says "binary", one binary file changed alone, and back when it says "many". While the first
// says "git-fail", git.status refuses with a host's long sentence (testChangesFailure); while it
// says "down", nothing listens (testBannerMovesWithTheColumn). Each usage.read and git.status is a
// line in /private/tmp/portals-panel/states-asks.txt, for the tests of when the app asks.
//
//   node scripts/phone-bench/uitest/panel-states-bridge.mts
//
// Then put its line in /private/tmp/portals-panel/uitest-<simulator>/plan-states.txt.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { ErrorCode, RpcError } from "../../../bridge/src/gateway/errors.ts";
import { methods } from "../../../bridge/src/gateway/methods.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";
import { FakeProvider } from "../../../bridge/src/providers/fake.ts";
import { PlanLimitsError } from "../../../bridge/src/providers/planLimits.ts";

const root = process.env.PANEL_UITEST_ROOT ?? "/tmp/portals-panel";
const modeFile = join(root, "states-mode.txt");
mkdirSync(root, { recursive: true });
writeFileSync(modeFile, "ok");
const home = mkdtempSync(join(root, "states-host-"));
const cwd = join(home, "work");
mkdirSync(cwd);

// A real repository, read by the host's real git.status and git.diff.
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Panel", "-c", "user.email=panel@example.com", ...args], { cwd });
const write = (name: string, text: string | Buffer) => writeFileSync(join(cwd, name), text);
const named = Array.from({ length: 349 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
git("init", "-q");
write("0-binary.dat", Buffer.from([0, 1, 2, 3]));
write("0-too-long.txt", "a\n");
for (const name of named) write(name, "before\n");
git("add", "-A");
git("commit", "-q", "-m", "first");
write("0-binary.dat", Buffer.from([0, 9, 8, 7]));
write("0-too-long.txt", "long line of a long file\n".repeat(30_000));
for (const name of named) write(name, "after\n");

const gitModeFile = join(root, "states-git.txt");
writeFileSync(gitModeFile, "many");
let gitMode = "many";
setInterval(() => {
  const wanted = readFileSync(gitModeFile, "utf8").trim();
  if (wanted === gitMode) return;
  gitMode = wanted;
  if (wanted === "binary") {
    git("add", "-A");
    git("commit", "-q", "-m", "all of them");
    write("0-binary.dat", Buffer.from([0, 5, 5, 5]));
  } else {
    git("reset", "-q", "--hard");
    git("reset", "-q", "--mixed", "HEAD~1");
  }
}, 200).unref();

const provider = new FakeProvider({ directory: join(home, "fake"), delayMs: 30, usage: true });
Object.assign(provider, {
  usage: async () => {
    console.log(`usage asked at ${new Date().toISOString()}`);
    if (readFileSync(modeFile, "utf8").trim() === "fail") throw new PlanLimitsError("Its sign-in has expired.");
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    return {
      plan: "max",
      limits: [
        { name: "5-hour", percent: 100, resetsAt: now + 3600, windowSeconds: 5 * 3600 },
        { name: "monthly", percent: 70, resetsAt: now - 60, windowSeconds: 30 * day },
        { name: "weekly Fable", percent: 30, resetsAt: now + 4 * day, windowSeconds: 7 * day, heardAt: Date.now() - 3 * 3600 * 1000 },
        // As a bare report from a turn leaves one: it has no number to it.
        { name: "weekly Sonnet", percent: null, resetsAt: now + 2 * day, windowSeconds: 7 * day },
        ...Array.from({ length: 27 }, (_, index) => ({ name: `weekly ${index + 1}`, percent: index + 5, resetsAt: now + 3600 + index * 600, windowSeconds: 30 * day })),
      ],
    };
  },
});

writeFileSync(join(home, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: Number(process.env.PANEL_UITEST_PORT ?? 9189),
  auth: { username: "panel", passwordHash: await hashPassword("panel-test-pass") },
  allowedHosts: ["127.0.0.1", "localhost", "::1"], generalFolder: cwd,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: false },
  relay: { enabled: false }, push: { relay: null, dryRun: join(home, "push.jsonl") },
  updates: { check: false }, fleet: { tellStarters: false },
}), { mode: 0o600 });

const asksFile = join(root, "states-asks.txt");
writeFileSync(asksFile, "");
for (const name of ["usage.read", "git.status"]) {
  const { handle } = methods[name];
  methods[name].handle = async (params, context) => {
    appendFileSync(asksFile, `${name}\n`);
    if (name === "git.status" && readFileSync(modeFile, "utf8").trim() === "git-fail") {
      throw new RpcError(ErrorCode.internal, "git could not read this repository: fatal: detected dubious ownership in repository at /private/tmp/portals-panel/work");
    }
    if (name === "usage.read") {
      let mode = readFileSync(modeFile, "utf8").trim();
      // Hold the first answer to check the panel before anything is known.
      while (mode === "usage-wait") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        mode = readFileSync(modeFile, "utf8").trim();
      }
      if (mode.startsWith("usage-")) {
        appendFileSync(asksFile, "usage.answered\n");
        if (mode === "usage-fail") throw new RpcError(ErrorCode.internal, "Its sign-in has expired.");
        if (mode === "usage-none") return { available: false };
        return {
          available: true, title: "Test plan",
          limits: mode === "usage-window" ? [{ name: "weekly", percent: 25, resets_at: Math.floor(Date.now() / 1000) + 86400 }] : [],
          ...(mode === "usage-note" ? { note: "No plan limits apply." } : {}),
          ...(mode === "usage-blocked" ? { note: "The workspace's credits are used up.\nCredits left: 100." } : {}),
        };
      }
    }
    return handle(params, context);
  };
}

const start = () => startBridge({ home, providers: new Map([["fake", provider]]), temporaryFolders: [] });
let bridge: Awaited<ReturnType<typeof start>> | null = await start();
console.log(JSON.stringify([{ name: "Panel states", url: bridge.url, user: "panel", password: "panel-test-pass" }]));
let turning = false;
setInterval(() => {
  const down = readFileSync(modeFile, "utf8").trim() === "down";
  if (turning || down === (bridge === null)) return;
  turning = true;
  void (async () => {
    if (down) {
      await bridge?.close();
      bridge = null;
    } else {
      bridge = await start();
    }
    turning = false;
  })();
}, 200);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void Promise.resolve(bridge?.close()).then(() => process.exit(0)));
}
