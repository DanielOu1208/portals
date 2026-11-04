import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridgeHome, ConfigError, defaults, expandHome, loadConfig, parseConfig, pathsFor } from "../src/config.ts";
import { setLogLevel } from "../src/log.ts";
import { hostOS } from "../src/platform.ts";
import { agentInstructions, mathInstructions, visualInstructions } from "../src/portals/guide.ts";
import { cursorProgram } from "../src/providers/cursor/options.ts";
import { CursorProvider } from "../src/providers/cursor/provider.ts";
import { droidProgram } from "../src/setup/agents.ts";
import { makeProviders } from "../src/providers/index.ts";
import { Registry } from "../src/sessions/registry.ts";
import { temporaryHome } from "./helpers.ts";

test("a missing config is written with the defaults, readable by its owner only", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = loadConfig(home);
  assert.deepEqual(config, defaults);
  const path = pathsFor(home).config;
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(pathsFor(home).state).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), defaults);
});

test("a partial config takes defaults for the rest, and keys it does not know are left alone", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = pathsFor(home).config;
  writeFileSync(path, JSON.stringify({ port: 9300, auth: { username: "dana", passwordHash: "scrypt$1$1$1$a$b" }, claude: { idleMinutes: 15 } }), { mode: 0o644 });
  const config = loadConfig(home);
  assert.equal(config.port, 9300);
  assert.equal(config.host, "127.0.0.1");
  assert.deepEqual(config.auth, { username: "dana", passwordHash: "scrypt$1$1$1$a$b" });
  assert.equal(config.generalFolder, "~/Portals");
  // A hand-written file holding a hash is made private.
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).claude.idleMinutes, 15);
});

test("settings that cannot be used are refused with a sentence", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = pathsFor(home).config;
  for (const bad of [
    { host: "0.0.0.0" },
    { host: "192.168.1.5" },
    { port: 70000 },
    { port: "9120" },
    { auth: { username: "x" } },
    { allowedHosts: "localhost" },
    { providers: { claude: "yes" } },
    { providers: [] },
    { claude: { idleMinutes: 0 } },
    { claude: { maxWarm: 1.5 } },
    { claude: { path: "" } },
    { claude: { apiKey: "" } },
    { claude: { oauthToken: " " } },
    { claude: { oauthToken: 5 } },
    { claude: { toolSummaries: "yes" } },
    { providers: { codex: 1 } },
    { codex: { mode: "daemon" } },
    { codex: { path: 3 } },
    { codex: { socket: "" } },
    { codex: { titleModel: "" } },
    { codex: { titleModel: 5 } },
    { providers: { cursor: "yes" } },
    { cursor: [] },
    { cursor: "cursor-agent" },
    { cursor: { path: "" } },
    { cursor: { path: 3 } },
    { cursor: { idleMinutes: 0 } },
    { cursor: { idleMinutes: "15" } },
    { providers: { hermes: "auto" } },
    { hermes: { path: "" } },
    { hermes: { start: "yes" } },
    { folders: [] },
    { folders: { hide: "~/private" } },
    { folders: { hide: [3] } },
    { apns: "~/AuthKey.p8" },
    { apns: { keyPath: "~/AuthKey.p8", keyId: "ABC" } },
    { apns: { keyPath: "", keyId: "ABC", teamId: "TEAM" } },
    { apns: { keyPath: "~/AuthKey.p8", keyId: 3, teamId: "TEAM" } },
    { push: [] },
    { push: { dryRun: 3 } },
    { push: { dryRun: "" } },
    { push: { relay: "" } },
    { push: { relay: "portals-relay.example" } },
    { push: { relay: "ftp://relay.example" } },
    { push: { relay: 3 } },
  ]) {
    writeFileSync(path, JSON.stringify(bad));
    assert.throws(() => loadConfig(home), ConfigError, JSON.stringify(bad));
  }
  writeFileSync(path, "not json");
  assert.throws(() => loadConfig(home), ConfigError);
});

test("Claude Code, Codex, Cursor, Droid and Hermes are on by default, the scripted agent only when asked for, and their settings take defaults", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(defaults.providers, { claude: true, codex: true, pi: false, cursor: true, droid: true, hermes: true, fake: false });
  assert.deepEqual(defaults.claude, { path: "~/.local/bin/claude", idleMinutes: 15, maxWarm: 6, apiKey: null, oauthToken: null, toolSummaries: true });
  assert.deepEqual(defaults.codex, { mode: "shared", path: "codex", socket: null, titleModel: "gpt-5.6-luna" });
  assert.deepEqual(defaults.cursor, { path: "~/.local/bin/cursor-agent", idleMinutes: 15 });
  assert.deepEqual(defaults.hermes, { path: "~/.local/bin/hermes", start: true });
  writeFileSync(
    pathsFor(home).config,
    JSON.stringify({ providers: { fake: true }, claude: { maxWarm: 2, apiKey: " sk-test " }, codex: { mode: "own", socket: "~/x.sock" }, cursor: { idleMinutes: 0.5 }, hermes: { start: false } }),
  );
  const config = loadConfig(home);
  assert.deepEqual(config.providers, { claude: true, codex: true, pi: false, cursor: true, droid: true, hermes: true, fake: true });
  assert.deepEqual(config.claude, { path: "~/.local/bin/claude", idleMinutes: 15, maxWarm: 2, apiKey: "sk-test", oauthToken: null, toolSummaries: true });
  // A long-lived token from `claude setup-token`, in place of the login.
  assert.equal(parseConfig({ claude: { oauthToken: " sk-ant-oat01-test " } }).claude.oauthToken, "sk-ant-oat01-test");
  // Claude Code's summaries of its calls, each a small model call of its own, turned off.
  assert.equal(parseConfig({ claude: { toolSummaries: false } }).claude.toolSummaries, false);
  assert.deepEqual(config.codex, { mode: "own", path: "codex", socket: "~/x.sock", titleModel: "gpt-5.6-luna" });
  // Threads keep the first line of their first message, with no name made.
  assert.equal(parseConfig({ codex: { titleModel: null } }).codex.titleModel, null);
  assert.equal(parseConfig({ codex: { titleModel: " gpt-6-luna " } }).codex.titleModel, "gpt-6-luna");
  assert.deepEqual(config.cursor, { path: "~/.local/bin/cursor-agent", idleMinutes: 0.5 });
  assert.deepEqual(config.hermes, { path: "~/.local/bin/hermes", start: false });
  // A bridge set up before it could run Cursor says nothing of it, and has it on; one line turns it off.
  assert.equal(parseConfig({ providers: { claude: true, codex: true } }).providers.cursor, true);
  assert.equal(parseConfig({ providers: { cursor: false }, cursor: { path: "cursor-agent" } }).providers.cursor, false);
  // What Cursor said of itself and its threads' conversations are kept in a folder of their own.
  assert.equal(pathsFor(home).cursor, join(home, "state", "cursor"));
});

test("Cursor is offered when its program is there and not otherwise, after Codex and Pi, with the portals command", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = pathsFor(home);
  const program = join(home, "cursor-agent");
  writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(home, "not-a-program"), "");
  // Nothing is started here: a provider runs its agent only once the bridge starts it. Hermes is
  // off, so that this Mac's own does not count. The `aeri` section of a bridge that ran Aeri,
  // taken out on 2026-10-21, is left alone and starts nothing.
  const settings = (cursor: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    parseConfig({ codex: { socket: join(home, "codex.sock") }, aeri: { enabled: true }, cursor, ...more, providers: { hermes: false, droid: false, fake: true, ...(more.providers as object | undefined) } });
  const names = (config: ReturnType<typeof parseConfig>) => [...makeProviders(config, paths).keys()];

  const offered = makeProviders(settings({ path: program }), paths);
  // After Codex; before the scripted agent and Hermes.
  assert.deepEqual([...offered.keys()], ["claude", "codex", "cursor", "fake"]);
  // With Pi turned on as well, Pi comes before it.
  assert.deepEqual(names(settings({ path: program }, { providers: { pi: true } })), ["claude", "codex", "pi", "cursor", "fake"]);
  const cursor = offered.get("cursor");
  assert.ok(cursor instanceof CursorProvider);
  assert.equal(cursor.profile.displayName, "Cursor");
  // It is told of the `portals` command, unless agents are not told, of how the app shows math, and that it shows visuals.
  assert.equal(cursor.note, `${agentInstructions(paths.command)}\n\n${mathInstructions}\n\n${visualInstructions(paths.command)}`);
  assert.equal((makeProviders(settings({ path: program }, { fleet: { tellAgents: false } }), paths).get("cursor") as CursorProvider).note, `${mathInstructions}\n\n${visualInstructions(paths.command)}`);

  // No program, or a file that is none: a Mac without Cursor offers none, whatever the setting.
  assert.deepEqual(names(settings({ path: join(home, "missing") })), ["claude", "codex", "fake"]);
  assert.deepEqual(names(settings({ path: join(home, "not-a-program") })), ["claude", "codex", "fake"]);
  // Turned off.
  assert.deepEqual(names(settings({ path: program }, { providers: { cursor: false } })), ["claude", "codex", "fake"]);

  // The configured program: `~` is the home folder, and a bare name is looked up on the PATH.
  assert.equal(cursorProgram(program), program);
  assert.equal(cursorProgram("cursor-agent", { PATH: `${join(home, "nowhere")}:${home}` }), program);
  assert.equal(cursorProgram("cursor-agent", { PATH: join(home, "nowhere") }), null);
  assert.equal(cursorProgram("cursor-agent", {}), null);
  assert.equal(cursorProgram("not-a-program", { PATH: home }), null);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(cursorProgram("~/cursor-agent"), program);
  } finally {
    process.env.HOME = realHome;
  }
});

test("Pi is off until config.json turns it on, its settings take defaults, and one that cannot be used is refused with its sentence", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(defaults.providers.pi, false);
  assert.deepEqual(defaults.pi, { path: "pi", idleMinutes: 15, maxWarm: 6, model: null });
  // A config.json from before Pi was an agent names neither.
  writeFileSync(pathsFor(home).config, JSON.stringify({ providers: { claude: true, codex: true, hermes: true, fake: false } }));
  assert.equal(loadConfig(home).providers.pi, false);
  assert.deepEqual(loadConfig(home).pi, defaults.pi);
  writeFileSync(pathsFor(home).config, JSON.stringify({ providers: { pi: true }, pi: { path: "~/bin/pi", maxWarm: 2 } }));
  const config = loadConfig(home);
  assert.deepEqual(config.providers, { claude: true, codex: true, pi: true, cursor: true, droid: true, hermes: true, fake: false });
  assert.deepEqual(config.pi, { path: "~/bin/pi", idleMinutes: 15, maxWarm: 2, model: null });
  assert.deepEqual(parseConfig({ pi: { idleMinutes: 0.5, maxWarm: 1 } }).pi, { path: "pi", idleMinutes: 0.5, maxWarm: 1, model: null });
  // The model new threads start on: Pi's own names, the provider first. An id may have slashes of its own.
  assert.equal(parseConfig({ pi: { model: "openai/gpt-6.1-sol" } }).pi.model, "openai/gpt-6.1-sol");
  assert.equal(parseConfig({ pi: { model: "openrouter/anthropic/claude-opus-4-8" } }).pi.model, "openrouter/anthropic/claude-opus-4-8");
  assert.equal(parseConfig({ pi: { model: null } }).pi.model, null);
  // The model a thread's name is made with: left out, the thread's own; null, none made.
  assert.equal("titleModel" in parseConfig({}).pi, false);
  assert.equal(parseConfig({ pi: { titleModel: "openai/gpt-5.6-luna" } }).pi.titleModel, "openai/gpt-5.6-luna");
  assert.equal(parseConfig({ pi: { titleModel: null } }).pi.titleModel, null);

  for (const [bad, sentence] of [
    [{ providers: { pi: "auto" } }, "providers.pi must be true or false."],
    [{ pi: "pi" }, "pi must be an object."],
    [{ pi: ["pi"] }, "pi must be an object."],
    [{ pi: { path: "" } }, "pi.path must be the path of the installed pi."],
    [{ pi: { model: "gpt-6.1-sol" } }, 'pi.model must name a model as Pi lists it, its provider first: "openai/gpt-6.1-sol".'],
    [{ pi: { model: "openai/" } }, 'pi.model must name a model as Pi lists it, its provider first: "openai/gpt-6.1-sol".'],
    [{ pi: { model: "openai/gpt 6" } }, 'pi.model must name a model as Pi lists it, its provider first: "openai/gpt-6.1-sol".'],
    [{ pi: { model: 3 } }, 'pi.model must name a model as Pi lists it, its provider first: "openai/gpt-6.1-sol".'],
    [{ pi: { path: 3 } }, "pi.path must be the path of the installed pi."],
    [{ pi: { titleModel: "gpt-5.6-luna" } }, 'pi.titleModel must name a model as Pi lists it, its provider first ("openai/gpt-5.6-luna"), or be null to leave threads unnamed.'],
    [{ pi: { titleModel: false } }, 'pi.titleModel must name a model as Pi lists it, its provider first ("openai/gpt-5.6-luna"), or be null to leave threads unnamed.'],
    [{ pi: { idleMinutes: 0 } }, "pi.idleMinutes must be a number above 0."],
    [{ pi: { idleMinutes: "15" } }, "pi.idleMinutes must be a number above 0."],
    [{ pi: { maxWarm: 0 } }, "pi.maxWarm must be a whole number, 1 or more."],
    [{ pi: { maxWarm: 1.5 } }, "pi.maxWarm must be a whole number, 1 or more."],
  ] as const) {
    assert.throws(() => parseConfig(bad), (error: Error) => error instanceof ConfigError && error.message === sentence, JSON.stringify(bad));
  }
});

test("Droid registration requires enablement and an installed executable, with configured paths resolved", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = join(home, "droid");
  writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const notExecutable = join(home, "not-executable");
  writeFileSync(notExecutable, "");
  const providers = (path: string, enabled = true) => makeProviders(parseConfig({
    providers: { claude: false, codex: false, pi: false, cursor: false, hermes: false, droid: enabled },
    droid: { path, idleMinutes: 0.5, maxWarm: 2 },
  }), pathsFor(home));
  assert.deepEqual([...providers(program, false).keys()], []);
  assert.deepEqual([...providers(join(home, "missing")).keys()], []);
  assert.deepEqual([...providers(notExecutable).keys()], []);
  const offered = providers(program);
  assert.deepEqual([...offered.keys()], ["droid"]);
  assert.equal(offered.get("droid")?.profile.displayName, "Droid");
  assert.equal(offered.get("droid")?.profile.kind, "droid");
  assert.deepEqual([...makeProviders(parseConfig({
    providers: { claude: false, codex: false, cursor: false, hermes: false },
    droid: { path: program },
  }), pathsFor(home)).keys()], ["droid"]);
  assert.equal(droidProgram(program), program);
  assert.equal(droidProgram("droid", { PATH: `${home}/nowhere:${home}` }), program);
  assert.equal(droidProgram("droid", {}), null);
  assert.equal(droidProgram("not-executable", { PATH: home }), null);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(droidProgram("~/droid"), program);
    assert.equal(droidProgram("~/.local/bin/droid", { PATH: home }), program);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
});

test("notifications go through the relay until an APNs key is named; a dry run needs neither", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(defaults.apns, null);
  assert.deepEqual(defaults.push, { dryRun: null, relay: "https://portals-relay.danielou1208.workers.dev" });
  writeFileSync(
    pathsFor(home).config,
    JSON.stringify({ apns: { keyPath: "~/keys/AuthKey_ABC1234567.p8", keyId: " ABC1234567 ", teamId: "TEAM456789" }, push: { dryRun: "/tmp/push.jsonl" } }),
  );
  const config = loadConfig(home);
  assert.deepEqual(config.apns, { keyPath: "~/keys/AuthKey_ABC1234567.p8", keyId: "ABC1234567", teamId: "TEAM456789" });
  assert.deepEqual(config.push, { dryRun: "/tmp/push.jsonl", relay: defaults.push.relay });
  writeFileSync(pathsFor(home).config, JSON.stringify({ apns: null, push: { dryRun: null } }));
  assert.equal(loadConfig(home).apns, null);
  assert.equal(loadConfig(home).push.dryRun, null);
  writeFileSync(pathsFor(home).config, JSON.stringify({ push: { relay: "http://127.0.0.1:8787" } }));
  assert.equal(loadConfig(home).push.relay, "http://127.0.0.1:8787");
  writeFileSync(pathsFor(home).config, JSON.stringify({ push: { relay: null } }));
  assert.equal(loadConfig(home).push.relay, null);
});

test("the folder comes from PORTALS_BRIDGE_HOME, else the old AERIPORTAL_BRIDGE_HOME, else Application Support (XDG's data folder on Linux)", () => {
  assert.equal(bridgeHome({ PORTALS_BRIDGE_HOME: "/tmp/x", AERIPORTAL_BRIDGE_HOME: "/tmp/y" }), "/tmp/x");
  assert.equal(bridgeHome({ AERIPORTAL_BRIDGE_HOME: "/tmp/x" }), "/tmp/x");
  assert.equal(bridgeHome({ PORTALS_BRIDGE_HOME: "~/b" }), join(homedir(), "b"));
  const usual = hostOS === "macos" ? join(homedir(), "Library", "Application Support") : process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share");
  assert.equal(bridgeHome({}), join(usual, "portals-bridge"));
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("/abs"), "/abs");
});

test("the counters are off unless counters.enabled is true, and a value that cannot be used is off without a word", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = pathsFor(home).config;
  assert.deepEqual(defaults.counters, { enabled: false });
  assert.equal(pathsFor(home).counters, join(home, "counters.log"));
  assert.deepEqual(parseConfig({}).counters, { enabled: false });
  assert.deepEqual(parseConfig({ counters: { enabled: true } }).counters, { enabled: true });
  assert.deepEqual(parseConfig({ counters: { enabled: false } }).counters, { enabled: false });
  assert.deepEqual(parseConfig({ counters: {} }).counters, { enabled: false });
  assert.deepEqual(parseConfig({ counters: null }).counters, { enabled: false });

  // Every other section stops the bridge when it cannot be used. This one must not: the
  // LaunchAgent would start the bridge again for ever. Nothing is logged here either.
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setLogLevel("debug");
  t.after(() => {
    process.stderr.write = write;
    setLogLevel("silent");
  });
  for (const bad of ["yes", true, 1, ["enabled"], { enabled: "yes" }, { enabled: 1 }, { enabled: null }]) {
    writeFileSync(path, JSON.stringify({ counters: bad }));
    assert.deepEqual(loadConfig(home).counters, { enabled: false }, JSON.stringify(bad));
  }
  assert.deepEqual(written, []);
});

test("the thread registry is saved privately and read back", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = pathsFor(home).threads;
  const registry = new Registry(path);
  registry.add({
    id: "t1",
    agent: "fake",
    cwd: "/tmp",
    title: null,
    model: "fake-1",
    provider: "fake",
    reasoningEffort: "medium",
    createdAt: 1,
    updatedAt: 1,
    origin: "phone",
  });
  registry.update("t1", { title: "Named" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const again = new Registry(path);
  assert.equal(again.get("t1")?.title, "Named");
  assert.equal(again.get("t1")?.origin, "phone");
  assert.ok((again.get("t1")?.updatedAt ?? 0) > 1);
});

test("the scripted agent is listed once, or under several names for a bench that asks (fake.agents)", (t) => {
  const home = temporaryHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const only = { claude: false, codex: false, pi: false, cursor: false, hermes: false, droid: false, fake: true };
  const offered = (fake: Record<string, unknown> = {}) => makeProviders(parseConfig({ providers: only, fake }), pathsFor(home));
  assert.deepEqual([...offered().keys()], ["fake"]);
  const several = offered({ agents: 3 });
  assert.deepEqual([...several.keys()], ["fake", "fake-2", "fake-3"]);
  assert.deepEqual([...several.values()].map((provider) => [provider.profile.name, provider.profile.displayName]), [
    ["fake", "Fake agent"],
    ["fake-2", "Fake agent 2"],
    ["fake-3", "Fake agent 3"],
  ]);
  // A count it cannot use leaves one.
  for (const agents of [0, 11, 2.5, "4"]) assert.deepEqual([...offered({ agents }).keys()], ["fake"]);
});

test("fleet.name names this Mac to its other Macs, its Computer Name when not given; one that cannot be a name is refused", () => {
  assert.equal(parseConfig({}).fleet.name, null);
  assert.equal(parseConfig({ fleet: { name: " MBP16 " } }).fleet.name, "MBP16");
  assert.equal(parseConfig({ fleet: { name: null } }).fleet.name, null);
  for (const name of ["", "  ", 7, "two\nlines", "x".repeat(101)]) {
    assert.throws(() => parseConfig({ fleet: { name } }), ConfigError, String(name));
  }
});
