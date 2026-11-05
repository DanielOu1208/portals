import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeFeatures } from "../src/gateway/features.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { VersionCheck } from "../src/providers/program.ts";
import { latestEveryMs, LatestReleases } from "../src/providers/programLatest.ts";
import { installationOf, plainLines, type ProgramsOptions } from "../src/providers/programs.ts";
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

async function open(t: TestContext, home: string, paths: Record<string, string>, providers: Map<string, Provider> = new Map(), programs: Partial<NonNullable<ProgramsOptions["latest"]>> & { updateMs?: number } = {}, check = false) {
  const { updateMs, ...latest } = programs;
  const config: Record<string, unknown> = { ...nowhere, updates: { check } };
  for (const [name, path] of Object.entries(paths)) config[name] = { path };
  const bridge = await startTestBridge({ config, providers: new Map([...providers, ["fake", new FakeProvider({ directory: mkdtempSync(join(tmpdir(), "portals-programs-fake-")), delayMs: 1, name: "fake" }) as unknown as Provider]]), programs: { home, env: { PATH: "/usr/bin:/bin" }, updateMs, latest } });
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
  const source = new Map([["codex", { kind: "npm", package: "@openai/codex", tag: () => "latest" } as const], ["pi", { kind: "npm", package: "@earendil-works/pi-coding-agent", tag: () => "latest" } as const]]);
  const fetching = answers({ "https://registry.npmjs.org/-/package/@openai/codex/dist-tags": JSON.stringify({ latest: "0.170.0" }) }, asked);
  const latest = new LatestReleases({ file, check: true, now: () => now, fetch: fetching });
  latest.askIfDue(source);
  latest.askIfDue(source);
  await latest.settled;
  assert.equal(asked.length, 2);
  assert.equal(latest.version("codex"), "0.170.0");
  assert.equal(latest.version("pi"), undefined);

  // Asked again only when that time has gone, whoever restarted meanwhile.
  now += latestEveryMs - 1;
  const again = new LatestReleases({ file, check: true, now: () => now, fetch: fetching });
  again.askIfDue(source);
  await again.settled;
  assert.equal(asked.length, 2);
  assert.equal(again.version("codex"), "0.170.0");
  now += 1;
  again.askIfDue(source);
  await again.settled;
  assert.equal(asked.length, 4);

  // Offline for days: a release heard so long ago is no longer said.
  now += 3 * 24 * 60 * 60 * 1000;
  assert.equal(again.version("codex"), undefined);

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
    latest.askIfDue(new Map([["codex", { kind: "npm", package: "@openai/codex", tag: () => "latest" }]]));
    await latest.settled;
    assert.equal(latest.version("codex"), undefined);
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
