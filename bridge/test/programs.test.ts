import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { methods } from "../src/gateway/methods.ts";
import { HermesProvider } from "../src/providers/hermes/provider.ts";
import { makeProviders, startProviders } from "../src/providers/index.ts";
import { defaults, pathsFor } from "../src/config.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { VersionCheck } from "../src/providers/program.ts";
import { latestEveryMs, LatestReleases, type LatestSource } from "../src/providers/programLatest.ts";
import { AgentPrograms, installationOf, plainLines, type ProgramsOptions } from "../src/providers/programs.ts";
import type { Provider, UsageReport } from "../src/providers/types.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

// The agents' programs on a host (feature agent_programs). Every program here is a
// stand-in in a scratch folder: nothing real is ever updated, or asked for its version.

function scratch(t: TestContext): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "portals-programs-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** A stand-in for a program: `--version` says what `<path>.version` holds; anything else runs `body`, with what it was given in `<path>.args`. */
function standIn(path: string, version: string, body = "exit 0"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.version`, version);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then cat "${path}.version"; exit 0; fi\necho "$@" >> "${path}.args"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const nowhere = Object.fromEntries(["claude", "codex", "pi", "cursor", "droid", "opencode", "hermes"].map((name) => [name, { path: `/nowhere/${name}` }]));

/** An agent of `kind`, with a version check as its provider has one. */
function agent(kind: string, name: string = kind, tested = "1.0.0", minimum?: string): Provider {
  const provider = new FakeProvider({ directory: mkdtempSync(join(tmpdir(), "portals-programs-fake-")), delayMs: 1, name });
  Object.defineProperty(provider, "profile", { value: { ...provider.profile, name, kind } });
  Object.defineProperty(provider, "version", { value: new VersionCheck({ name: kind, tested, minimum, path: `/nowhere/${kind}`, setting: `${kind}.path` }) });
  return provider as unknown as Provider;
}

async function open(t: TestContext, home: string, paths: Record<string, string>, providers: Map<string, Provider> = new Map(), programs: Partial<NonNullable<ProgramsOptions["latest"]>> & { updateMs?: number; env?: NodeJS.ProcessEnv } = {}, check = false) {
  const { updateMs, env, ...latest } = programs;
  const config: Record<string, unknown> = { ...nowhere, updates: { check } };
  for (const [name, path] of Object.entries(paths)) config[name] = { path };
  const bridge = await startTestBridge({ config, providers: new Map([...providers, ["fake", new FakeProvider({ directory: mkdtempSync(join(tmpdir(), "portals-programs-fake-")), delayMs: 1, name: "fake" }) as unknown as Provider]]), programs: { home, env: env ?? { PATH: "/usr/bin:/bin" }, updateMs, latest } });
  t.after(() => bridge.dispose());
  const client = await TestClient.open(bridge);
  t.after(() => client.close());
  return { bridge, client };
}

/** The program of `id`, once its update has ended. */
async function afterUpdate(bridge: { programs: { settled(id: never): Promise<void> } }, client: TestClient, id: string) {
  await bridge.programs.settled(id as never);
  return (await client.call("programs.list")).programs.find((program: { id: string }) => program.id === id);
}

// MARK: How it was installed

test("how a program was installed decides what updates it, and assumes nothing of the machine", (t) => {
  const home = scratch(t);
  const spec = { package: "@acme/tool", own: { args: ["update"], at: [".local/share/tool/versions"] }, command: "tool update" };

  // Its own installer's folder, through the link the host runs.
  const version = standIn(join(home, ".local/share/tool/versions/1.0.0"), "1.0.0");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(version, join(home, ".local/bin/tool"));
  assert.deepEqual(installationOf(spec, join(home, ".local/bin/tool"), home), { method: "own", command: "tool update", run: { program: join(home, ".local/bin/tool"), args: ["update"], folders: [join(home, ".local/bin")] } });

  // A global npm package, with the npm of the same prefix.
  const prefix = join(home, "node");
  const script = standIn(join(prefix, "lib/node_modules/@acme/tool/cli.js"), "1.0.0");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(script, join(prefix, "bin/tool"));
  standIn(join(prefix, "bin/npm"), "10.0.0");
  assert.deepEqual(installationOf(spec, join(prefix, "bin/tool"), home), {
    method: "npm",
    command: "npm install -g @acme/tool@latest",
    run: { program: join(prefix, "bin/npm"), args: ["install", "-g", "--prefix", prefix, "@acme/tool@latest"], folders: [join(prefix, "bin")] },
  });

  // The same under a prefix this user cannot write to: named, not run.
  const locked = join(home, "locked");
  const lockedScript = standIn(join(locked, "lib/node_modules/@acme/tool/cli.js"), "1.0.0");
  chmodSync(join(locked, "lib/node_modules"), 0o555);
  // Root writes anywhere, as in some containers: nothing to see there.
  if (process.getuid?.() !== 0) assert.deepEqual(installationOf(spec, lockedScript, home), { method: "npm", command: "npm install -g @acme/tool@latest" });
  chmodSync(join(locked, "lib/node_modules"), 0o755);

  // Other package managers and places: what to run, nothing to press.
  const elsewhere: [string, unknown][] = [
    ["brew/Caskroom/tool@latest/1.0.0/tool", { method: "homebrew", command: "brew upgrade --cask tool@latest" }],
    ["brew/Cellar/tool/1.0.0/bin/tool", { method: "homebrew", command: "brew upgrade tool" }],
    [".bun/install/global/node_modules/@acme/tool/cli.js", { method: "other", command: "bun add -g @acme/tool@latest" }],
    ["pnpm/global/5/node_modules/@acme/tool/cli.js", { method: "other", command: "pnpm add -g @acme/tool@latest" }],
    ["Applications/Factory.app/Contents/Resources/bin/tool", { method: "app" }],
    ["somewhere/else/tool", { method: "other", command: "tool update" }],
  ];
  for (const [path, expected] of elsewhere) {
    assert.deepEqual(installationOf(spec, standIn(join(home, path), "1.0.0"), home), expected, path);
  }

  // One that decides for itself: any installation, its own updater saying when it cannot.
  assert.equal(installationOf({ own: { args: ["update", "--yes"] }, command: "hermes update" }, join(home, "somewhere/else/tool"), home).method, "own");
});

test("what a command printed: colours out, a line rewritten in place as its last state", () => {
  assert.deepEqual(plainLines("\x1b[32madded\x1b[0m 1\r\nfetching 10%\rfetching 90%\rdone\n\n  last  \n"), ["added 1", "done", "last"]);
});

// MARK: Listing

test("programs.list says what is installed, by what it runs on this host, and leaves out what is not there", async (t) => {
  assert.ok((bridgeFeatures as readonly string[]).includes("agent_programs"));
  const home = scratch(t);
  const claude = standIn(join(home, ".local/share/claude/versions/2.1.318"), "2.1.318 (Claude Code)\n");
  const pi = standIn(join(home, "prefix/lib/node_modules/@earendil-works/pi-coding-agent/cli.js"), "0.9.0\n");
  const providers = new Map([["claude", agent("claude")], ["cursor", agent("cursor")], ["bot-a", agent("hermes", "bot-a")], ["bot-b", agent("hermes", "bot-b")]]);
  const { client } = await open(t, home, { claude, pi }, providers);
  const { programs } = await client.call("programs.list");
  const by = Object.fromEntries(programs.map((program: { id: string }) => [program.id, program]));

  assert.deepEqual(Object.keys(by), ["claude", "cursor", "pi", "hermes"]);
  assert.equal(by.claude.version, "2.1.318");
  assert.equal(by.claude.standing, "tested");
  assert.equal(by.claude.how, "own");
  assert.equal(by.claude.can_update, true);
  assert.equal(by.claude.command, "claude update");
  assert.deepEqual(by.claude.agents, ["claude"]);
  assert.equal(by.claude.takes_effect, "next_start");
  // Installed, not run here: listed, with no agent.
  assert.equal(by.pi.standing, "too old");
  assert.equal(by.pi.minimum, "1.1.0");
  assert.deepEqual(by.pi.agents, []);
  assert.equal(by.pi.can_update, true);
  // An agent turned on with no program: what is known, and no update.
  assert.equal(by.cursor.installed, false);
  assert.equal(by.cursor.version, null);
  assert.equal(by.cursor.standing, "missing");
  assert.equal(by.cursor.can_update, false);
  assert.equal(by.cursor.how, null);
  // Hermes's bots are one program.
  assert.deepEqual(by.hermes.agents, ["bot-a", "bot-b"]);
  assert.equal(by.hermes.takes_effect, "gateway_restart");
  // Nothing of the update before there is one, nor of a release nobody asked for.
  for (const program of programs) assert.deepEqual([program.update, program.latest, program.update_available], [undefined, undefined, undefined]);
});

test("Hermes is not looked for where the host does not run it: not even its --version", async (t) => {
  const home = scratch(t);
  const hermes = standIn(join(home, "hermes"), "Hermes Agent v0.22.5");
  // Would leave this behind if it ran at all.
  writeFileSync(hermes, `#!/bin/sh\ntouch "${hermes}.ran"\necho "Hermes Agent v0.22.5"\n`);
  const { client } = await open(t, home, { hermes });
  assert.deepEqual((await client.call("programs.list")).programs, []);
  assert.equal(existsSync(`${hermes}.ran`), false);
});

// MARK: Updating

test("an update runs the program's own command, reads the version again and the host's check goes by it, with no restart", async (t) => {
  const home = scratch(t);
  // Its command moves the version on, as an updater does; it is given nothing else.
  const path = join(home, ".local/share/claude/versions/2.1.300");
  standIn(path, "2.1.300 (Claude Code)\n", `echo updating; printf '2.1.320 (Claude Code)\\n' > "${path}.version"`);
  const claude = agent("claude", "claude", "2.1.318");
  const { bridge, client } = await open(t, home, { claude: path }, new Map([["claude", claude]]));
  claude.version!.installedIs("2.1.300");
  claude.version!.runningIs("2.1.300");
  await client.call("programs.list");

  const started = await client.call("program.update", { program: "claude" });
  assert.equal(started.program.update.state, "running");
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(readFileSync(`${path}.args`, "utf8"), "update\n");
  assert.equal(after.update.state, "done");
  assert.equal(after.update.from, "2.1.300");
  assert.equal(after.update.to, "2.1.320");
  assert.ok(after.update.ended_at >= after.update.started_at);
  assert.equal(after.update.tail, undefined);
  assert.equal(after.version, "2.1.320");
  // What a process said of itself before it is over: the next one starts from the new release.
  assert.deepEqual(claude.version!.current(), { name: "claude", version: "2.1.320", standing: "newer", running: false });
});

test("a failed update says so with the end of what it printed, and keeps what is installed", async (t) => {
  const home = scratch(t);
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `i=1; while [ $i -le 30 ]; do echo "line $i"; i=$((i+1)); done; printf '\\033[31mnpm ERR! no room\\033[0m\\n' >&2; exit 3`);
  const { bridge, client } = await open(t, home, { claude: path });
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "failed");
  assert.equal(after.update.timed_out, undefined);
  assert.equal(after.update.to, "2.1.300");
  assert.equal(after.version, "2.1.300");
  const lines = after.update.tail.split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines.at(-1), "npm ERR! no room");
  assert.equal(lines[0], "line 20");
});

test("an update that takes too long is ended, what it started too, and says so", async (t) => {
  const home = scratch(t);
  const pids = join(home, "pids");
  // A shell that takes no notice of being asked, and a child of it: only the group's end stops them.
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `trap '' TERM; sleep 60 & echo $! >> "${pids}"; echo $$ >> "${pids}"; echo still going; wait`);
  const { bridge, client } = await open(t, home, { claude: path }, new Map(), { updateMs: 300 });
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "failed");
  assert.equal(after.update.timed_out, true);
  assert.match(after.update.tail, /still going/);
  // Ended within the two seconds SIGKILL follows SIGTERM by.
  let alive = true;
  for (let tries = 0; tries < 60 && alive; tries++) {
    alive = readFileSync(pids, "utf8").trim().split("\n").some((pid) => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive) await sleep(100);
  }
  assert.equal(alive, false);
});

test("one update at a time per program: asked again, it is the one running; afterwards it can run again", async (t) => {
  const home = scratch(t);
  const release = join(home, "release");
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `while [ ! -e "${release}" ]; do sleep 0.05; done`);
  const { bridge, client } = await open(t, home, { claude: path });
  const [one, two] = await Promise.all([client.call("program.update", { program: "claude" }), client.call("program.update", { program: "claude" })]);
  assert.equal(one.program.update.state, "running");
  assert.equal(two.program.update.started_at, one.program.update.started_at);
  const during = await client.call("programs.list");
  assert.equal(during.programs[0].update.state, "running");
  writeFileSync(release, "");
  await afterUpdate(bridge as never, client, "claude");
  assert.equal(readFileSync(`${path}.args`, "utf8"), "update\n");
  await client.call("program.update", { program: "claude" });
  await afterUpdate(bridge as never, client, "claude");
  assert.equal(readFileSync(`${path}.args`, "utf8"), "update\nupdate\n");
});

test("an update's end does not wait on what it left running", async (t) => {
  const home = scratch(t);
  // As Hermes's update leaves a gateway it restarted by hand, with what it was given to print to.
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `(sleep 4; echo still here) &\nexit 0`);
  const { bridge, client } = await open(t, home, { claude: path });
  const before = Date.now();
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "done");
  assert.ok(Date.now() - before < 3000);
});

test("no command comes from a device, and an installation the host does not know says what to run", async (t) => {
  const home = scratch(t);
  const claude = standIn(join(home, "somewhere/else/claude"), "2.1.300\n");
  const { client } = await open(t, home, { claude });
  const listed = (await client.call("programs.list")).programs[0];
  assert.equal(listed.how, "other");
  assert.equal(listed.can_update, false);
  assert.equal(listed.command, "claude update");
  await assert.rejects(client.call("program.update", { program: "claude" }), (error: { code: number; message: string }) => {
    assert.equal(error.code, -32602);
    assert.match(error.message, /run claude update on this host/);
    return true;
  });
  assert.equal(existsSync(`${claude}.args`), false);
  await assert.rejects(client.call("program.update", { program: "rm -rf /" }), { code: -32602 });
  await assert.rejects(client.call("program.update", { program: "pi" }), { code: -32602 });
  // A key it does not know is not read as a command, and none is run for it.
  await client.call("program.update", { program: "claude", command: "touch /nowhere/x" }).catch((error: { code: number }) => assert.equal(error.code, -32602));
  assert.equal(existsSync(`${claude}.args`), false);
});

test("Codex as an npm package: the prefix's npm updates it, its daemon is not touched, and its threads stay on what it runs", async (t) => {
  const home = scratch(t);
  const prefix = join(home, "node");
  const codex = standIn(join(prefix, "lib/node_modules/@openai/codex/bin/codex.js"), "codex-cli 0.166.0\n");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(codex, join(prefix, "bin/codex"));
  const npm = standIn(join(prefix, "bin/npm"), "11.0.0\n", `printf 'codex-cli 0.170.0\\n' > "${codex}.version"`);
  const provider = agent("codex", "codex", "0.166.0");
  const { bridge, client } = await open(t, home, { codex: join(prefix, "bin/codex") }, new Map([["codex", provider]]));
  provider.version!.installedIs("0.166.0");
  provider.version!.runningIs("0.166.0");
  await client.call("programs.list");
  await client.call("program.update", { program: "codex" });
  const after = await afterUpdate(bridge as never, client, "codex");
  assert.equal(readFileSync(`${npm}.args`, "utf8").trim(), `install -g --prefix ${prefix} @openai/codex@latest`);
  // Nothing was asked of Codex itself but its version.
  assert.equal(existsSync(`${codex}.args`), false);
  assert.equal(after.update.state, "done");
  assert.equal(after.version, "0.170.0");
  assert.equal(after.running_version, "0.166.0");
  assert.equal(after.takes_effect, "service_restart");
  // `/status` goes on saying what its threads run.
  assert.deepEqual(provider.version!.current(), { name: "codex", version: "0.166.0", standing: "tested", running: true });
});

test("Hermes updates with its own command, which restarts its gateways, and says it asks nobody", async (t) => {
  const home = scratch(t);
  const hermes = standIn(join(home, ".local/bin/hermes"), "Hermes Agent v0.22.5 (2026.9.24)\n", `printf 'Hermes Agent v0.22.7 (2026.11.3)\\n' > "${join(home, ".local/bin/hermes")}.version"`);
  const provider = agent("hermes", "bot-a", "0.22.5");
  const { bridge, client } = await open(t, home, { hermes }, new Map([["bot-a", provider], ["bot-b", agent("hermes", "bot-b")]]));
  await client.call("program.update", { program: "hermes" });
  const after = await afterUpdate(bridge as never, client, "hermes");
  assert.equal(readFileSync(`${hermes}.args`, "utf8"), "update --yes\n");
  assert.equal(after.update.state, "done");
  assert.equal(after.update.to, "0.22.7");
  assert.equal(after.how, "own");
  assert.equal(after.takes_effect, "gateway_restart");
  assert.equal(provider.version!.current()!.version, "0.22.7");
});

test("Hermes refusing an installation it does not own is told in its own words", async (t) => {
  const home = scratch(t);
  const hermes = standIn(join(home, ".local/bin/hermes"), "Hermes Agent v0.22.5\n", `echo "use: nix profile upgrade hermes-agent"; exit 2`);
  const { bridge, client } = await open(t, home, { hermes }, new Map([["bot-a", agent("hermes", "bot-a")]]));
  await client.call("program.update", { program: "hermes" });
  const after = await afterUpdate(bridge as never, client, "hermes");
  assert.equal(after.update.state, "failed");
  assert.match(after.update.tail, /nix profile upgrade/);
});

test("too old for a thread, then updated: the refusal goes without a host restart", async (t) => {
  const home = scratch(t);
  const path = join(home, "prefix/lib/node_modules/@earendil-works/pi-coding-agent/cli.js");
  mkdirSync(join(home, "prefix/bin"), { recursive: true });
  standIn(path, "0.9.0\n");
  standIn(join(home, "prefix/bin/npm"), "11.0.0\n", `printf '1.5.0\\n' > "${path}.version"`);
  const pi = agent("pi", "pi", "1.5.0", "1.1.0");
  const { bridge, client } = await open(t, home, { pi: path }, new Map([["pi", pi]]));
  pi.version!.installedIs("0.9.0");
  assert.match(pi.version!.refusal()!, /too old/);
  await client.call("program.update", { program: "pi" });
  await afterUpdate(bridge as never, client, "pi");
  assert.equal(pi.version!.refusal(), null);
  assert.equal(pi.version!.current()!.standing, "tested");
});

// MARK: The latest release

const codexSource: LatestSource = { kind: "npm", package: "@openai/codex", tag: "latest" };

function answers(table: Record<string, string>, asked: string[] = []): typeof fetch {
  return (async (url: string) => {
    asked.push(String(url));
    const body = table[String(url)];
    return body === undefined ? new Response("nothing", { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch;
}

test("the latest release comes from where each updater looks, and only for an installation that follows it", async (t) => {
  const home = scratch(t);
  const asked: string[] = [];
  const claude = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n");
  const cursor = standIn(join(home, ".local/share/cursor-agent/versions/2026.10.22-27dcf5f/cursor-agent"), "2026.10.22-27dcf5f\n");
  const droid = standIn(join(home, ".local/bin/droid"), "1.3.0\n");
  const hermes = standIn(join(home, ".local/hermes"), "Hermes Agent v0.22.5+12.gabc1234\n");
  const opencode = standIn(join(home, "brew/Cellar/opencode/2.2.5/bin/opencode"), "2.2.5\n");
  const { bridge, client } = await open(t, home, { claude, cursor, droid, hermes, opencode }, new Map([["bot-a", agent("hermes", "bot-a")]]), {
    fetch: answers({
      "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags": JSON.stringify({ latest: "2.1.320", stable: "2.1.311" }),
      "https://cursor.com/install": `DOWNLOAD_URL="https://downloads.cursor.com/lab/2026.11.05-86047df/\${OS}/\${ARCH}/agent-cli-package.tar.gz"`,
      "https://registry.npmjs.org/-/package/@factory/cli/dist-tags": JSON.stringify({ latest: "1.3.0" }),
      "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest": JSON.stringify({ tag_name: "v0.22.5" }),
      "https://registry.npmjs.org/-/package/@opencode/cli/dist-tags": JSON.stringify({ latest: "2.3.0" }),
    }, asked),
  }, true);
  await client.call("programs.list");
  await bridge.programs.latest.settled;
  const by = Object.fromEntries((await client.call("programs.list")).programs.map((program: { id: string }) => [program.id, program]));
  assert.equal(by.claude.latest, "2.1.320");
  assert.equal(by.claude.update_available, true);
  assert.equal(by.cursor.latest, "2026.11.05");
  assert.equal(by.cursor.update_available, true);
  assert.equal(by.droid.latest, "1.3.0");
  assert.equal(by.droid.update_available, false);
  // A build past the release says nothing of what comes next.
  assert.equal(by.hermes.latest, "0.22.5");
  assert.equal(by.hermes.update_available, undefined);
  // Homebrew may be behind npm: nothing said rather than a guess.
  assert.equal(by.opencode.how, "homebrew");
  assert.equal(by.opencode.latest, undefined);
  assert.equal(by.opencode.update_available, undefined);
  // Nothing asked of a program not installed.
  assert.ok(!asked.some((url) => url.includes("@openai/codex")));
});

test("the latest releases are asked for a few times a day, across restarts, and what cannot be found is not said", async (t) => {
  const home = scratch(t);
  const file = join(home, "programs.json");
  let now = 1_800_000_000_000;
  const asked: string[] = [];
  const source = new Map<string, LatestSource>([["codex", codexSource], ["pi", { kind: "npm", package: "@earendil-works/pi-coding-agent", tag: "latest" }]]);
  const fetching = answers({ "https://registry.npmjs.org/-/package/@openai/codex/dist-tags": JSON.stringify({ latest: "0.170.0" }) }, asked);
  const latest = new LatestReleases({ file, check: true, now: () => now, fetch: fetching });
  latest.askIfDue(source);
  latest.askIfDue(source);
  await latest.settled;
  assert.equal(asked.length, 2);
  assert.equal(latest.version("codex", codexSource), "0.170.0");
  assert.equal(latest.version("pi", source.get("pi")!), undefined);

  // Asked again only when that time has gone, whoever restarted meanwhile.
  now += latestEveryMs - 1;
  const again = new LatestReleases({ file, check: true, now: () => now, fetch: fetching });
  again.askIfDue(source);
  await again.settled;
  assert.equal(asked.length, 2);
  assert.equal(again.version("codex", codexSource), "0.170.0");
  now += 1;
  again.askIfDue(source);
  await again.settled;
  assert.equal(asked.length, 4);

  // Offline for days: a release heard so long ago is no longer said.
  now += 3 * 24 * 60 * 60 * 1000;
  assert.equal(again.version("codex", codexSource), undefined);

  // `updates.check` false: never.
  const silent = new LatestReleases({ file: join(home, "silent.json"), check: false, now: () => now, fetch: fetching });
  silent.askIfDue(source);
  await silent.settled;
  assert.equal(asked.length, 4);
  assert.equal(existsSync(join(home, "silent.json")), false);
});

test("what a source says that is not a release, or a source that fails, says nothing", async () => {
  for (const fetching of [
    (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ latest: "not a version" }))) as unknown as typeof fetch,
    (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
  ]) {
    const latest = new LatestReleases({ file: join(tmpdir(), `portals-programs-${process.pid}-${Math.random()}.json`), check: true, fetch: fetching });
    latest.askIfDue(new Map([["codex", codexSource]]));
    await latest.settled;
    assert.equal(latest.version("codex", codexSource), undefined);
  }
});

// MARK: Usage by agent

test("usage.read by agent, for a page with no thread: the same once a minute, and nothing to say where nothing is known", async (t) => {
  const home = scratch(t);
  let asked = 0;
  const agreed: (string | undefined)[] = [];
  const claude = agent("claude");
  (claude as { usage?: Provider["usage"] }).usage = async (thread): Promise<UsageReport> => {
    asked += 1;
    agreed.push(thread);
    return { plan: "max", limits: [{ name: "5-hour", percent: 42, resetsAt: null }] };
  };
  const { client } = await open(t, home, {}, new Map([["claude", claude]]));
  const first = await client.call("usage.read", { agent: "claude" });
  assert.equal(first.available, true);
  assert.equal(first.limits[0].percent, 42);
  await client.call("usage.read", { agent: "claude" });
  assert.equal(asked, 1);
  assert.deepEqual(agreed, [undefined]);
  assert.deepEqual(await client.call("usage.read", { agent: "no-such-agent" }), { available: false });
  assert.deepEqual(await client.call("usage.read", { agent: "fake" }), { available: false });
  await assert.rejects(client.call("usage.read", {}), { code: -32602 });
  await assert.rejects(client.call("usage.read", { session_id: "no-such-thread" }), { code: 4007 });
});

// MARK: An update's life beyond the host

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await sleep(25);
  return done();
}

const programsModule = fileURLToPath(new URL("../src/providers/programs.ts", import.meta.url));
const configModule = fileURLToPath(new URL("../src/config.ts", import.meta.url));

/** A host in a process of its own, that starts `claude`'s update and exits at once, as a host's restart does: nothing of it is left to watch. */
function hostThatExits(state: string, home: string, claude: string, updateMs: number): void {
  const code = `
    import { existsSync } from "node:fs";
    import { setTimeout as sleep } from "node:timers/promises";
    import { defaults } from ${JSON.stringify(configModule)};
    import { AgentPrograms } from ${JSON.stringify(programsModule)};
    const config = { ...defaults, updates: { check: false }, claude: { ...defaults.claude, path: ${JSON.stringify(claude)} } };
    const programs = new AgentPrograms({ config, paths: { state: ${JSON.stringify(state)}, programs: ${JSON.stringify(join(state, "programs.json"))} }, providers: new Map(), home: ${JSON.stringify(home)}, env: { PATH: "/usr/bin:/bin" }, updateMs: ${updateMs} });
    await programs.update("claude");
    while (!existsSync(${JSON.stringify(`${claude}.args`)})) await sleep(20);
    process.exit(0);
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
}

function programsIn(state: string, home: string, claude: string): AgentPrograms {
  return new AgentPrograms({ config: { ...defaults, updates: { check: false }, claude: { ...defaults.claude, path: claude } }, paths: { state, programs: join(state, "programs.json") }, providers: new Map(), home, env: { PATH: "/usr/bin:/bin" }, updateMs: 60_000 });
}

test("a host's restart leaves an update running as one: the new host says so, starts no second, and follows it to its end", async (t) => {
  const home = scratch(t);
  const state = join(home, "state");
  const release = join(home, "release");
  const path = join(home, ".local/share/claude/versions/2.1.300");
  standIn(path, "2.1.300\n", `while [ ! -e "${release}" ] && [ -d "${home}" ]; do sleep 0.05; done; printf '2.1.320\\n' > "${path}.version"`);
  hostThatExits(state, home, path, 60_000);

  const programs = programsIn(state, home, path);
  t.after(() => programs.close());
  const during = (await programs.list()).find(({ id }) => id === "claude")!;
  assert.equal(during.update?.state, "running");
  const again = await programs.update("claude");
  assert.equal(again.update?.state, "running");
  assert.equal(again.update?.startedAt, during.update?.startedAt);
  await sleep(150);
  assert.equal(readFileSync(`${path}.args`, "utf8"), "update\n");

  writeFileSync(release, "");
  await programs.settled("claude");
  const after = (await programs.list()).find(({ id }) => id === "claude")!;
  assert.equal(after.update?.state, "done");
  assert.equal(after.update?.from, "2.1.300");
  assert.equal(after.update?.to, "2.1.320");
  assert.equal(after.version, "2.1.320");
});

test("an update's time limit holds with no host to watch it, and the next host says how it ended", async (t) => {
  const home = scratch(t);
  const state = join(home, "state");
  const pid = join(home, "pid");
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `echo $$ > "${pid}"; echo still going; trap '' TERM; sleep 60 & wait; sleep 60`);
  hostThatExits(state, home, path, 400);
  assert.ok(await until(() => existsSync(pid), 5000));
  const updater = Number(readFileSync(pid, "utf8"));
  // No host has run since it began: only what began with it can end it.
  assert.ok(await until(() => !alive(updater), 8000), "the updater outlived its time limit");

  const programs = programsIn(state, home, path);
  t.after(() => programs.close());
  await programs.list();
  await programs.settled("claude");
  const after = (await programs.list()).find(({ id }) => id === "claude")!;
  assert.equal(after.update?.state, "failed");
  assert.equal(after.update?.timedOut, true);
  assert.match(after.update?.tail ?? "", /still going/);
});

test("a timed-out update is over only once everything it started has gone, so a retry cannot overlap it", async (t) => {
  const home = scratch(t);
  const descendant = join(home, "descendant");
  // The updater ends at the first SIGTERM. What it started takes no notice, until the group's SIGKILL.
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", `sh -c 'trap "" TERM; echo $$ > "${descendant}"; while :; do sleep 0.1; done' & wait`);
  const { bridge, client } = await open(t, home, { claude: path }, new Map(), { updateMs: 250 });
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "failed");
  assert.equal(after.update.timed_out, true);
  assert.equal(alive(Number(readFileSync(descendant, "utf8"))), false, "its descendant was still running when it was called over");
});

// MARK: Which program, and in what environment

test("a relative folder on the PATH is not looked in: what was checked is what runs, whatever folder that runs in", async (t) => {
  const home = scratch(t);
  // What the folder `.` finds from the host's folder, and what it would find from the home folder an update runs in.
  const version = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(version, join(home, ".local/bin/claude"));
  const decoy = standIn(join(home, "claude"), "9.9.9\n");
  const before = process.cwd();
  process.chdir(join(home, ".local/bin"));
  t.after(() => process.chdir(before));

  // Found where its installer puts it, by that folder's own absolute name.
  const { bridge, client } = await open(t, home, { claude: "claude" }, new Map(), { env: { PATH: ".:/usr/bin:/bin" } });
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "done");
  assert.equal(after.version, "2.1.300");
  assert.equal(readFileSync(`${version}.args`, "utf8"), "update\n");
  assert.equal(existsSync(`${decoy}.args`), false, "another copy from the one checked ran");
});

test("a program only a relative folder on the PATH finds is not there", async (t) => {
  const home = scratch(t);
  const elsewhere = standIn(join(home, "elsewhere/claude"), "2.1.300\n");
  const before = process.cwd();
  process.chdir(join(home, "elsewhere"));
  t.after(() => process.chdir(before));
  const { client } = await open(t, home, { claude: "claude" }, new Map(), { env: { PATH: ".:/usr/bin:/bin" } });
  assert.equal((await client.call("programs.list")).programs.find((program: { id: string }) => program.id === "claude"), undefined);
  await assert.rejects(client.call("program.update", { program: "claude" }), { code: -32602 });
  assert.equal(existsSync(`${elsewhere}.args`), false);
});

test("an absolute folder on the PATH finds a program named barely, and that is the one that runs", async (t) => {
  const home = scratch(t);
  const version = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  symlinkSync(version, join(home, ".local/bin/claude"));
  const { bridge, client } = await open(t, home, { claude: "claude" }, new Map(), { env: { PATH: `${join(home, ".local/bin")}:/usr/bin:/bin` } });
  await client.call("program.update", { program: "claude" });
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "done");
  assert.equal(readFileSync(`${version}.args`, "utf8"), "update\n");
});

test("an updater is given no credentials of the host's or its agents', keeps the package manager's, and what it prints reaches devices masked", async (t) => {
  const home = scratch(t);
  const seen = join(home, "environment");
  const release = join(home, "release");
  const bearer = "abcdefghijklmnopqrstuvwxyz0123456789";
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", [
    `env > "${seen}"`,
    `echo "Authorization: Bearer ${bearer}"`,
    `while [ ! -e "${release}" ] && [ -d "${home}" ]; do sleep 0.05; done`,
    `echo "thread=$PORTALS_THREAD password=$PORTALS_PASSWORD"`,
    `echo "PORTALS_PASSWORD=synthetic-password-value"`,
    `echo "npm ERR! //registry.example/:_authToken=npm_syntheticTokenValue0123456789"`,
    `echo "Authorization: Bearer ${bearer}"`,
    `exit 1`,
  ].join("\n"));
  const env = {
    PATH: "/usr/bin:/bin",
    PORTALS_THREAD: "synthetic-thread",
    PORTALS_PASSWORD: "synthetic-password-value",
    AERIPORTAL_PASSWORD: "synthetic-password-value",
    ANTHROPIC_API_KEY: "synthetic-key-value",
    OPENAI_API_KEY: "synthetic-key-value",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token-value",
    NPM_TOKEN: "npm-keeps-this",
    NODE_AUTH_TOKEN: "npm-keeps-this-too",
    npm_config_registry: "https://registry.example/",
    HTTPS_PROXY: "http://proxy.example:8080",
  };
  const { bridge, client } = await open(t, home, { claude: path }, new Map(), { env });
  await client.call("program.update", { program: "claude" });
  assert.ok(await until(() => existsSync(seen) && readFileSync(seen, "utf8").includes("HTTPS_PROXY"), 5000));
  const lines = readFileSync(seen, "utf8");
  for (const gone of ["PORTALS_THREAD", "PORTALS_PASSWORD", "AERIPORTAL_PASSWORD", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.ok(!lines.includes(`${gone}=`), `${gone} reached the updater`);
  for (const kept of ["NPM_TOKEN=npm-keeps-this", "NODE_AUTH_TOKEN=npm-keeps-this-too", "npm_config_registry=", "HTTPS_PROXY=", "PATH="]) assert.ok(lines.includes(kept), `${kept} did not reach the updater`);

  // While it runs, as at its end.
  assert.ok(await until(() => existsSync(join(bridge.home, "state/program-updates/claude.log")) && readFileSync(join(bridge.home, "state/program-updates/claude.log"), "utf8").includes("Bearer"), 5000));
  const running = (await client.call("programs.list")).programs.find((program: { id: string }) => program.id === "claude");
  assert.equal(running.update.state, "running");
  assert.ok(!JSON.stringify(running).includes(bearer), JSON.stringify(running.update));

  writeFileSync(release, "");
  const after = await afterUpdate(bridge as never, client, "claude");
  assert.equal(after.update.state, "failed");
  const said = JSON.stringify(after);
  for (const secret of [bearer, "synthetic-password-value", "npm_syntheticTokenValue0123456789", "synthetic-thread"]) assert.ok(!said.includes(secret), `${secret} reached a device: ${said}`);
  assert.match(after.update.tail, /Authorization: Bearer/);
});

// MARK: The latest release, from what updates it

const claudeTags = { "https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags": JSON.stringify({ latest: "2.1.320", stable: "2.1.311" }) };

test("an npm install goes by npm's latest, what its command installs, whatever Claude Code's own channel says", async (t) => {
  const home = scratch(t);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ autoUpdatesChannel: "stable" }));
  const claude = standIn(join(home, "prefix/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "2.1.300\n");
  const { bridge, client } = await open(t, home, { claude }, new Map(), { fetch: answers(claudeTags), env: { PATH: "/usr/bin:/bin", HOME: home } }, true);
  await client.call("programs.list");
  await bridge.programs.latest.settled;
  const listed = (await client.call("programs.list")).programs[0];
  assert.equal(listed.how, "npm");
  assert.match(listed.command, /@latest$/);
  assert.equal(listed.latest, "2.1.320");
  assert.equal(listed.update_available, true);
});

test("Claude Code's own updater goes by its channel, and an answer from another channel is not said, until the next round asks", async (t) => {
  const home = scratch(t);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude/settings.json");
  writeFileSync(settings, JSON.stringify({ autoUpdatesChannel: "latest" }));
  const claude = standIn(join(home, ".local/share/claude/versions/2.1.311"), "2.1.311\n");
  const asked: string[] = [];
  let now = 1_800_000_000_000;
  const { bridge, client } = await open(t, home, { claude }, new Map(), { fetch: answers(claudeTags, asked), now: () => now, env: { PATH: "/usr/bin:/bin", HOME: home } }, true);
  await client.call("programs.list");
  await bridge.programs.latest.settled;
  const onLatest = (await client.call("programs.list")).programs[0];
  assert.equal(onLatest.latest, "2.1.320");
  assert.equal(onLatest.update_available, true);
  assert.equal(asked.length, 1);

  writeFileSync(settings, JSON.stringify({ autoUpdatesChannel: "stable" }));
  const switched = (await client.call("programs.list")).programs[0];
  assert.equal(switched.latest, undefined);
  assert.equal(switched.update_available, undefined);
  await bridge.programs.latest.settled;
  assert.equal(asked.length, 1);

  now += latestEveryMs;
  await client.call("programs.list");
  await bridge.programs.latest.settled;
  const onStable = (await client.call("programs.list")).programs[0];
  assert.equal(onStable.latest, "2.1.311");
  assert.equal(onStable.update_available, false);
  assert.equal(asked.length, 2);
});

// MARK: Hermes's --version, which looks for updates itself

/** A stand-in Hermes that keeps count of each `--version` it is asked for. */
function countingHermes(home: string, version = "Hermes Agent v0.22.5 (2026.9.24)", body = "exit 0"): { path: string; runs: () => number } {
  const path = join(home, ".local/bin/hermes");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.version`, `${version}\n`);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo x >> "${path}.ran"; cat "${path}.version"; exit 0; fi\necho "$@" >> "${path}.args"\n${body}\n`);
  chmodSync(path, 0o755);
  return { path, runs: () => (existsSync(`${path}.ran`) ? readFileSync(`${path}.ran`, "utf8").split("\n").filter(Boolean).length : 0) };
}

test("with update checks off, the page never runs hermes --version: it says what the host knows, until an update is asked for", async (t) => {
  const home = scratch(t);
  const hermes = countingHermes(home, "Hermes Agent v0.22.5 (2026.9.24)", `printf 'Hermes Agent v0.22.7 (2026.11.3)\\n' > "${join(home, ".local/bin/hermes")}.version"`);
  const bot = agent("hermes", "bot-a", "0.22.5");
  const { bridge, client } = await open(t, home, { hermes: hermes.path }, new Map([["bot-a", bot]]));
  const unknown = (await client.call("programs.list")).programs.find((program: { id: string }) => program.id === "hermes");
  assert.equal(unknown.installed, true);
  assert.equal(unknown.version, null);
  bot.version!.installedIs("0.22.5");
  // A minute on, as the page asks again.
  await client.call("programs.list");
  assert.equal(hermes.runs(), 0);

  await client.call("program.update", { program: "hermes" });
  const after = await afterUpdate(bridge as never, client, "hermes");
  assert.equal(after.update.state, "done");
  assert.equal(after.version, "0.22.7");
  // The one read an update asked for: Hermes has just been to the network for it anyway.
  assert.equal(hermes.runs(), 1);
});

test("with update checks on, hermes --version is run at most once an hour, not with each look", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const home = scratch(t);
  const hermes = countingHermes(home);
  const { client } = await open(t, home, { hermes: hermes.path }, new Map([["bot-a", agent("hermes", "bot-a", "0.22.5")]]), { fetch: answers({}) }, true);
  const first = (await client.call("programs.list")).programs.find((program: { id: string }) => program.id === "hermes");
  assert.equal(first.version, "0.22.5");
  assert.equal(hermes.runs(), 1);
  t.mock.timers.tick(59 * 60_000);
  await client.call("programs.list");
  assert.equal(hermes.runs(), 1);
  t.mock.timers.tick(2 * 60_000);
  await client.call("programs.list");
  assert.equal(hermes.runs(), 2);
});

test("with update checks off, a host starting Hermes does not run its --version; with them on, it does", async (t) => {
  for (const check of [false, true]) {
    const home = scratch(t);
    const hermes = countingHermes(home);
    const before = process.env.HERMES_GATEWAY_LOCK_DIR;
    process.env.HERMES_GATEWAY_LOCK_DIR = join(home, "locks");
    const config = { ...defaults, providers: { ...defaults.providers, claude: false, codex: false, cursor: false, droid: false, hermes: true }, hermes: { path: hermes.path, start: false }, updates: { check } };
    const providers = makeProviders(config, pathsFor(join(home, "bridge")));
    startProviders(providers);
    await until(() => hermes.runs() > 0, check ? 5000 : 500);
    for (const provider of new Set(providers.values())) await provider.close?.();
    if (before === undefined) delete process.env.HERMES_GATEWAY_LOCK_DIR;
    else process.env.HERMES_GATEWAY_LOCK_DIR = before;
    assert.equal(hermes.runs(), check ? 1 : 0, `updates.check ${check}`);
  }
});

// MARK: Whose limits

/** A Hermes bot whose default provider has used 10%, and whose thread `thread` runs on another that has used 90%. */
function hermesBot() {
  let asks = 0;
  const host = {
    oneThread: false,
    call: async () => {
      asks += 1;
      return { provider: "default", providers: [
        { slug: "default", name: "Default", usage: { windows: [{ label: "weekly", used_percent: 10 }] } },
        { slug: "other", name: "Other", usage: { windows: [{ label: "weekly", used_percent: 90 }] } },
      ] };
    },
    sessionFor: (thread: string) => (thread === "thread" ? { settings: () => ({ provider: "other" }) } : undefined),
  };
  const provider = new HermesProvider(host as never, { name: "bot", displayName: "Bot", profile: "default" } as never);
  const gateway = { providers: new Map([["bot", provider]]), sessions: { record: (id: string) => (id === "thread" ? { id, agent: "bot" } : undefined) } };
  const read = async (params: Record<string, unknown>) => (await methods["usage.read"].handle(params, { gateway } as never)) as { limits: { percent: number }[] };
  return { read, provider, asks: () => asks };
}

test("a page's read of a Hermes bot and a thread's read of its own provider each get their own limits, whichever comes first, on one ask of Hermes", async () => {
  const settingsFirst = hermesBot();
  assert.equal((await settingsFirst.read({ agent: "bot" })).limits[0].percent, 10);
  assert.equal((await settingsFirst.read({ session_id: "thread" })).limits[0].percent, 90);
  assert.equal(settingsFirst.asks(), 1);

  const threadFirst = hermesBot();
  assert.equal((await threadFirst.read({ session_id: "thread" })).limits[0].percent, 90);
  assert.equal((await threadFirst.read({ agent: "bot" })).limits[0].percent, 10);
  assert.equal(threadFirst.asks(), 1);

  // Each stands for its minute.
  assert.equal((await threadFirst.read({ agent: "bot" })).limits[0].percent, 10);
  assert.equal((await threadFirst.read({ session_id: "thread" })).limits[0].percent, 90);
  assert.equal(threadFirst.asks(), 1);
});

test("asked directly, as a person typing /usage asks, a Hermes bot asks Hermes each time: only usage.read's reads share a minute", async () => {
  const { provider, asks } = hermesBot();
  assert.equal((await provider.usage(undefined)).limits[0].percent, 10);
  assert.equal((await provider.usage("thread")).limits[0].percent, 90);
  assert.equal(asks(), 2);
});

// MARK: The update's lock

/** A stand-in Claude whose every update notes its pid and its parent's, then runs `body`: by default, waits for its own `release-<n>`. */
function lockFixture(t: TestContext, { versionBody, body }: { versionBody?: (home: string) => string; body?: (home: string, file: string) => string } = {}) {
  const home = scratch(t);
  const state = join(home, "state");
  const file = join(home, ".local/share/claude/versions/2.1.300");
  const pidFile = join(home, "pids");
  const parentFile = join(home, "parents");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.version`, "2.1.300\n");
  const waits = `while [ ! -e "${home}/release-$count" ] && [ -d "${home}" ]; do sleep 0.03; done\nprintf '2.1.320\\n' > "${file}.version"\ntouch "${home}/first-done"`;
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then\n${versionBody?.(home) ?? ""}\ncat "${file}.version"; exit 0; fi\necho $$ >> "${pidFile}"\necho $PPID >> "${parentFile}"\ncount=$(wc -l < "${pidFile}" | tr -d ' ')\n${body ? body(home, file) : waits}\n`);
  chmodSync(file, 0o755);
  const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const managers: AgentPrograms[] = [];
  t.after(() => managers.forEach((manager) => manager.close()));
  return {
    home,
    state,
    file,
    pids: () => lines(pidFile),
    parents: () => lines(parentFile),
    release: (count: number) => writeFileSync(join(home, `release-${count}`), ""),
    manager(extra: Partial<ProgramsOptions> & { startMs?: number } = {}) {
      const manager = new AgentPrograms({
        config: { ...defaults, ...nowhere, updates: { check: false }, claude: { ...defaults.claude, path: file } } as never,
        paths: { state, programs: join(state, "programs.json") }, providers: new Map(), home, env: { HOME: home, PATH: "/usr/bin:/bin" }, updateMs: 60_000, ...extra,
      });
      managers.push(manager);
      return manager;
    },
  };
}

const claudeOf = async (programs: AgentPrograms) => (await programs.list()).find(({ id }) => id === "claude")!;

test("a slow observer's end cannot free a successor's lock: no third updater runs beside the second", async (t) => {
  // Its version read after the update, held open by the stand-in until it is let go.
  const lock = lockFixture(t, { versionBody: (home) => `if [ "$SLOW_VERSION" = "1" ] && [ -e "${home}/first-done" ]; then touch "${home}/version-blocked"; while [ ! -e "${home}/version-release" ] && [ -d "${home}" ]; do sleep 0.03; done; fi` });
  const slow = lock.manager({ env: { HOME: lock.home, PATH: "/usr/bin:/bin", SLOW_VERSION: "1" } });
  await slow.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));

  const other = lock.manager();
  await other.list();
  lock.release(1);
  assert.ok(await until(() => existsSync(join(lock.home, "version-blocked")), 8000));
  await other.settled("claude");

  // A successor starts while the slow observer is still at its read of the first update's end.
  const next = lock.manager();
  await next.update("claude");
  assert.ok(await until(() => lock.pids().length === 2, 8000));

  writeFileSync(join(lock.home, "version-release"), "");
  await slow.settled("claude");

  const third = lock.manager();
  assert.equal((await third.update("claude")).update?.state, "running");
  await sleep(600);
  assert.equal(lock.pids().length, 2, "a third updater ran beside the second");

  lock.release(2);
  await next.settled("claude");
  assert.equal((await claudeOf(next)).update?.state, "done");
});

test("a supervisor held up before it starts cannot run or overwrite anything once it resumes", async (t) => {
  const lock = lockFixture(t);
  const paused = join(lock.home, "paused");
  const preload = join(lock.home, "pause-once.mjs");
  writeFileSync(preload, `import { existsSync, writeFileSync } from "node:fs";\nif (!existsSync(${JSON.stringify(paused)})) { writeFileSync(${JSON.stringify(paused)}, String(process.pid)); process.kill(process.pid, "SIGSTOP"); }\n`);
  const first = lock.manager({ env: { HOME: lock.home, PATH: "/usr/bin:/bin", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, startMs: 400 });
  await first.update("claude");
  assert.ok(await until(() => existsSync(paused), 8000));
  const held = Number(readFileSync(paused, "utf8"));
  t.after(() => { try { process.kill(held, "SIGKILL"); } catch { /* gone */ } });
  await first.settled("claude");
  assert.equal((await claudeOf(first)).update?.state, "failed");

  const second = lock.manager();
  await second.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));

  process.kill(held, "SIGCONT");
  assert.ok(await until(() => !alive(held), 8000), "the resumed supervisor went on running");
  await sleep(300);
  assert.equal(lock.pids().length, 1, "the resumed supervisor ran an updater beside the second");
  assert.equal((await claudeOf(second)).update?.state, "running");

  lock.release(1);
  await second.settled("claude");
  assert.equal((await claudeOf(second)).update?.state, "done");
});

test("a supervisor killed with its updater running: the lock stays held, the host says so, and past its time ends what it can prove is the same process", async (t) => {
  const lock = lockFixture(t);
  const programs = lock.manager({ updateMs: 1500 });
  await programs.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));
  const [updater] = lock.pids();
  const [supervisor] = lock.parents();
  process.kill(supervisor, "SIGKILL");
  assert.ok(await until(() => !alive(supervisor), 8000));

  // Said at the host's next look.
  let during = await claudeOf(programs);
  for (let tries = 0; tries < 40 && !during.update?.unattended; tries++) {
    await sleep(50);
    during = await claudeOf(programs);
  }
  assert.equal(during.update?.state, "running");
  assert.equal(during.update?.unattended, true);
  assert.equal((await programs.update("claude")).update?.state, "running");
  await sleep(200);
  assert.equal(lock.pids().length, 1, "a second updater ran beside the first");

  assert.ok(await until(() => !alive(updater), 10_000), "the updater outlived its time limit");
  await programs.settled("claude");
  assert.equal((await claudeOf(programs)).update?.state, "failed");

  // Free now, and with nothing of the first left to overlap.
  const next = lock.manager();
  await next.update("claude");
  assert.ok(await until(() => lock.pids().length === 2, 8000));
  assert.equal(alive(updater), false);
  lock.release(2);
  await next.settled("claude");
});

test("a killed supervisor's group that cannot be proved the same is not signalled: the lock stays until it has gone, however long past its time", async (t) => {
  const lock = lockFixture(t, {
    // The updater leaves something behind and ends by itself, so its own process can no longer prove whose the group is.
    body: (home) => `(while [ ! -e "${home}/stop" ] && [ -d "${home}" ]; do sleep 0.03; done) &\necho $! > "${home}/descendant"\nwhile [ ! -e "${home}/leader-go" ] && [ -d "${home}" ]; do sleep 0.03; done\nexit 0`,
  });
  const programs = lock.manager({ updateMs: 300 });
  await programs.update("claude");
  assert.ok(await until(() => existsSync(join(lock.home, "descendant")), 8000));
  const descendant = Number(readFileSync(join(lock.home, "descendant"), "utf8"));
  const [supervisor] = lock.parents();
  process.kill(supervisor, "SIGKILL");
  assert.ok(await until(() => !alive(supervisor), 8000));
  writeFileSync(join(lock.home, "leader-go"), "");
  const [updater] = lock.pids();
  assert.ok(await until(() => !alive(updater), 8000));

  // Well past its time.
  await sleep(2500);
  assert.equal(alive(descendant), true, "a group not proved the same was signalled");
  const during = await claudeOf(programs);
  assert.equal(during.update?.state, "running");
  assert.equal(during.update?.unattended, true);
  await programs.update("claude");
  await sleep(200);
  assert.equal(lock.pids().length, 1);

  writeFileSync(join(lock.home, "stop"), "");
  assert.ok(await until(() => !alive(descendant), 8000));
  await programs.settled("claude");
  assert.equal((await claudeOf(programs)).update?.state, "failed");
});

test("nothing of an update runs until its record names it: a record that cannot be written ends it before the updater starts", async (t) => {
  const lock = lockFixture(t);
  const preload = join(lock.home, "cannot-publish.mjs");
  writeFileSync(preload, `import fs from "node:fs";\nimport { syncBuiltinESMExports } from "node:module";\nfs.renameSync = () => { const error = new Error("EACCES: synthetic"); error.code = "EACCES"; throw error; };\nsyncBuiltinESMExports();\n`);
  const failing = lock.manager({ env: { HOME: lock.home, PATH: "/usr/bin:/bin", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, startMs: 3000 });
  await failing.update("claude");
  await failing.settled("claude");
  await sleep(400);
  assert.equal(lock.pids().length, 0, "the updater escaped a record that could not be written");
  assert.equal((await claudeOf(failing)).update?.state, "failed");

  // And nothing is left holding the lock.
  const next = lock.manager();
  await next.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));
  lock.release(1);
  await next.settled("claude");
  assert.equal((await claudeOf(next)).update?.state, "done");
});

test("two hosts' asking at once runs one updater", async (t) => {
  const lock = lockFixture(t);
  const one = lock.manager();
  const two = lock.manager();
  await Promise.all([one.update("claude"), two.update("claude")]);
  assert.ok(await until(() => lock.pids().length >= 1, 8000));
  await sleep(600);
  assert.equal(lock.pids().length, 1);
  lock.release(1);
  await Promise.all([one.settled("claude"), two.settled("claude")]);
  assert.equal((await claudeOf(one)).update?.state, "done");
  assert.equal((await claudeOf(two)).update?.state, "done");
});

test("a record that cannot be read holds nothing", async (t) => {
  const lock = lockFixture(t);
  const programs = lock.manager();
  mkdirSync(join(lock.state, "program-updates"), { recursive: true });
  for (const name of ["claude.json", "claude.1.json"]) writeFileSync(join(lock.state, "program-updates", name), "not json");
  await programs.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));
  lock.release(1);
  await programs.settled("claude");
  assert.equal((await claudeOf(programs)).update?.state, "done");
});

test("the last update's end is said for a day, whichever host saw it, and holds nothing", async (t) => {
  const lock = lockFixture(t);
  const folder = join(lock.state, "program-updates");
  mkdirSync(folder, { recursive: true });
  const ended = (at: number) => JSON.stringify({ id: 4, startedAt: at - 1000, deadlineAt: at + 1000, from: "2.1.200", supervisor: { pid: 999_999, start: "gone", group: 999_999 }, ended: { at, code: 3, timedOut: false } });
  writeFileSync(join(folder, "claude.4.json"), ended(Date.now() - 60_000));
  const recent = lock.manager();
  await recent.list();
  await recent.settled("claude");
  assert.equal((await claudeOf(recent)).update?.state, "failed");

  writeFileSync(join(folder, "claude.4.json"), ended(Date.now() - 25 * 60 * 60_000));
  const old = lock.manager();
  await old.list();
  await old.settled("claude");
  assert.equal((await claudeOf(old)).update, undefined);

  await old.update("claude");
  assert.ok(await until(() => lock.pids().length === 1, 8000));
  lock.release(1);
  await old.settled("claude");
  assert.equal((await claudeOf(old)).update?.state, "done");
});

// MARK: Formatting cannot hide a credential

test("what an updater prints is stripped of terminal formatting before it is masked, running and at its end", async (t) => {
  const home = scratch(t);
  const release = join(home, "release");
  const bearer = "abcdefghijklmnopqrstuvwxyz0123456789";
  const path = standIn(join(home, ".local/share/claude/versions/2.1.300"), "2.1.300\n", [
    `printf '\\033[31mAuthorization\\033[0m: Bearer ${bearer}\\n'`,
    `while [ ! -e "${release}" ] && [ -d "${home}" ]; do sleep 0.05; done`,
    `printf 'PORTALS_PASS\\033[1mWORD\\033[0m=synthetic-password-value\\n'`,
    `printf '\\033]8;;https://example.invalid\\007Authorization\\033]8;;\\007: Bearer ${bearer}\\n'`,
    `printf 'Author\\010ization: Bearer ${bearer}\\n'`,
    `exit 2`,
  ].join("\n"));
  const programs = new AgentPrograms({ config: { ...defaults, ...nowhere, updates: { check: false }, claude: { ...defaults.claude, path } } as never, paths: { state: join(home, "state"), programs: join(home, "state/programs.json") }, providers: new Map(), home, env: { PATH: "/usr/bin:/bin" }, updateMs: 60_000 });
  t.after(() => programs.close());
  await programs.update("claude");
  assert.ok(await until(() => existsSync(join(home, "state/program-updates/claude.log")) && readFileSync(join(home, "state/program-updates/claude.log"), "utf8").includes("Bearer"), 8000));
  const running = await claudeOf(programs);
  assert.equal(running.update?.state, "running");
  assert.ok(!JSON.stringify(running.update).includes(bearer), JSON.stringify(running.update));

  writeFileSync(release, "");
  await programs.settled("claude");
  const after = await claudeOf(programs);
  assert.equal(after.update?.state, "failed");
  for (const secret of [bearer, "synthetic-password-value"]) assert.ok(!(after.update?.tail ?? "").includes(secret), after.update?.tail);
  assert.match(after.update?.tail ?? "", /Authorization: Bearer/);
});

// MARK: Hermes's version, the host's own read counted

test("the host's own read of Hermes's version at start counts in the hourly rule, in flight or done", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const home = scratch(t);
  const hermes = countingHermes(home);
  const before = process.env.HERMES_GATEWAY_LOCK_DIR;
  process.env.HERMES_GATEWAY_LOCK_DIR = join(home, "locks");
  t.after(() => {
    if (before === undefined) delete process.env.HERMES_GATEWAY_LOCK_DIR;
    else process.env.HERMES_GATEWAY_LOCK_DIR = before;
  });
  const config = { ...defaults, ...nowhere, providers: { ...defaults.providers, claude: false, codex: false, cursor: false, droid: false, hermes: true }, hermes: { path: hermes.path, start: false }, updates: { check: true } } as never;
  const providers = makeProviders(config, pathsFor(join(home, "bridge")));
  t.after(async () => { for (const provider of new Set(providers.values())) await provider.close?.(); });
  startProviders(providers);
  const programs = new AgentPrograms({ config, paths: { state: join(home, "state"), programs: join(home, "state/programs.json") }, providers, home, env: { PATH: "/usr/bin:/bin" }, latest: { check: false } });
  t.after(() => programs.close());

  // Asked while the host's own is still under way.
  const first = (await programs.list()).find(({ id }) => id === "hermes")!;
  assert.equal(first.version, "0.22.5");
  assert.equal(hermes.runs(), 1);
  await programs.list();
  assert.equal(hermes.runs(), 1);

  t.mock.timers.tick(61 * 60_000);
  await programs.list();
  assert.equal(hermes.runs(), 2);
  await programs.list();
  assert.equal(hermes.runs(), 2);
});
