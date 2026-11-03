import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { countersSwitch } from "./counters.ts";
import { dataFolder, hostOS, type HostOS } from "./platform.ts";
import { ensureDirectory, readJSON, writeJSON } from "./store/jsonFile.ts";

// The bridge keeps everything in one folder, `~/Library/Application Support/portals-bridge/`
// on a Mac and `~/.local/share/portals-bridge/` on Linux (src/platform.ts), unless
// `PORTALS_BRIDGE_HOME` (or, from before the rename, `AERIPORTAL_BRIDGE_HOME`) names
// another:
//
//   config.json         settings, written by setup or with defaults, then only edited by hand
//   password.txt        the sign-in password setup made, so `portals-host pair` can show it
//   setup.json          what setup found and made: the phone's address, the tailnet mapping
//   app/                the installed bridge the LaunchAgent runs (src/setup/install.ts)
//   bin/portals         the `portals` command of this bridge, written each time it starts
//   agent.sock          the socket that command reaches the bridge by, owner only
//   links.json          the other Macs this bridge can reach, with their sign-in (src/fleet/links.ts)
//   state/aeri.sqlite, state/aeri-memory.md  left by a bridge that ran Aeri, never read: Aeri
//                       was taken out on 2026-10-21, its code kept on the branch aeri-kept
//   state/threads.json  the threads the bridge knows
//   state/waiting/      the messages waiting for a running turn, while they wait (src/sessions/waiting.ts)
//   state/push.json     devices and the threads they want to hear about
//   state/net.json      the net's members, a copy of which every Mac in it keeps (src/net/net.ts)
//   state/net-own.json  this Mac's token, X25519 key and relay id and secret, which never leave it
//   state/folders.json  folders the user added for new threads
//   state/images/       images from the phone while Codex reads them
//   state/cursor/       Cursor's models as it last listed them, and its threads' conversations
//   state/droid/        Droid session identities and display conversations
//   state/hermes.json   Hermes's profiles, as it last listed them
//   state/update.json   when npm's registry was last asked for the latest portals-host, and what it said (src/updates.ts)
//   hermes-serve.log    what a `hermes serve` the bridge started printed
//   counters.log        a line of counts a minute while `counters` is on (src/counters.ts); counters.log.1 is the file before it
//
// Keys this version does not know are left alone.

export interface AuthConfig {
  username: string;
  /** From `hashPassword` (setup, or `scripts/hash-password.ts`): `scrypt$N$r$p$salt$hash`. */
  passwordHash: string;
}

export interface Config {
  /** Always a loopback address: the bridge is reached from elsewhere only through `tailscale serve`. */
  host: string;
  port: number;
  /** null until a password is set up; sign-in answers 404 meanwhile. */
  auth: AuthConfig | null;
  /** Names the `Host` header may carry (port left out). Anything else is refused. */
  allowedHosts: string[];
  /** The folder new threads run in when the app names none (`~/Portals`, made at startup). `~` is the home folder. */
  generalFolder: string;
  /** The folders offered for new threads besides General (src/folders.ts). */
  folders: FoldersConfig;
  /**
   * The agents offered. Pi only when config.json turns it on, which setup does where
   * it finds Pi. Cursor, Droid and Hermes only when installed. The scripted one is
   * for tests and development only.
   */
  providers: { claude: boolean; codex: boolean; pi: boolean; cursor: boolean; droid: boolean; hermes: boolean; fake: boolean };
  claude: ClaudeConfig;
  codex: CodexConfig;
  pi: PiConfig;
  cursor: CursorConfig;
  droid: DroidConfig;
  hermes: HermesConfig;
  /** The scripted agent used for testing; `agents` lists it under that many names (fake, fake-2, …), for benches that need several agents. */
  fake: { delayMs: number; agents: number };
  /** The APNs key notifications are sent with; null sends none (registrations are still kept). */
  apns: ApnsConfig | null;
  push: PushConfig;
  fleet: FleetConfig;
  net: NetConfig;
  relay: RelayConfig;
  visuals: VisualsConfig;
  counters: CountersConfig;
  updates: UpdatesConfig;
}

/** Whether a newer portals-host is out (src/updates.ts). */
export interface UpdatesConfig {
  /**
   * Ask npm's registry for the latest version when the bridge starts and about once a
   * day after, and tell the devices when it is later than this one. On unless set to false.
   */
  check: boolean;
}

/** The net of Macs and devices (src/net/net.ts, docs/net-plan.md). */
export interface NetConfig {
  /**
   * The address the other Macs and the devices reach this bridge at, with scheme and
   * port, when setup.json has none (a bridge set up by hand). null: setup's address,
   * else `http://127.0.0.1:<port>`, which only this Mac reaches.
   */
  url: string | null;
}

/** The relay's tunnel, the backup way in for a device that cannot reach this Mac directly (src/relay/, docs/net-plan.md). */
export interface RelayConfig {
  /** Keep a standby socket open to the relay, so devices can come through it. On unless set to false. */
  enabled: boolean;
  /** The relay's address: the deployed one unless set, as for `push.relay`. */
  url: string;
}

/** What the bridge costs, counted into `counters.log` (src/counters.ts). */
export interface CountersConfig {
  /**
   * Write a line of counts a minute. Off unless set. Read when the bridge starts; a
   * bridge started with it on reads it again every minute, so it can be turned off and
   * on again without a restart. Counts, sizes and timings only.
   */
  enabled: boolean;
}

/** Agents managing threads with the `portals` command (docs/fleet-plan.md). */
export interface FleetConfig {
  /**
   * Tell the agents the bridge runs that the command exists, in a few lines of their
   * instructions. Off, the command still works for whoever is told of it.
   */
  tellAgents: boolean;
  /**
   * What this Mac is called in what it passes on to another Mac's bridge (who a message
   * is from, who started a thread): its Computer Name when not given.
   */
  name: string | null;
  /**
   * Tell the thread that started a thread, with a message from that one, when it comes to
   * rest, fails or asks something (`Fleet.tellStarter`). Off, the starter learns of it only
   * by asking (`portals wait`, `portals read`).
   */
  tellStarters: boolean;
}

/** Visuals in replies: HTML the app draws inline (`portals guide visuals`). */
export interface VisualsConfig {
  /**
   * Tell the agents the bridge runs that the app shows visuals, in a line of their
   * instructions. Off, an agent that writes one anyway still has it shown.
   */
  tellAgents: boolean;
}

export interface ApnsConfig {
  /** The APNs auth key (`AuthKey_<keyId>.p8`) from the Apple developer account; `~` is the home folder. */
  keyPath: string;
  /** The key's id: the ten characters in its file name. */
  keyId: string;
  /** The developer team the key belongs to. */
  teamId: string;
}

export interface PushConfig {
  /**
   * A file each notification is appended to, as a line of JSON, instead of being sent:
   * for trying notifications without an APNs key. null sends them.
   */
  dryRun: string | null;
  /**
   * The Portals relay (relay/, docs/pairing-and-relay.md), which sends notifications for
   * a bridge without an APNs key of its own. Used only when `apns` is null. null sends
   * none that way.
   */
  relay: string | null;
}

export interface FoldersConfig {
  /** Never offered, nor anything under them. `~` is the home folder. */
  hide: string[];
}

export interface ClaudeConfig {
  /** The installed `claude`; `~` is the home folder. */
  path: string;
  /** A thread's process stops after this long with nothing running or waiting. */
  idleMinutes: number;
  /** At most this many thread processes run at once. */
  maxWarm: number;
  /**
   * An Anthropic API key for Claude Code to use instead of its own sign-in; setup asks
   * for one. null uses the login of the installed `claude`.
   */
  apiKey: string | null;
  /**
   * Claude Code says in a few words what each run of its tool calls did ("Read a.txt and
   * b.txt", its `tool_use_summary`), which the app shows as what the agent is working on
   * (feature status_headline). Each summary is one small model call of Claude Code's own.
   * On unless set to false.
   */
  toolSummaries: boolean;
}

export interface CodexConfig {
  /**
   * `shared`: join the app-server daemon every Codex on this Mac uses, so threads live
   * on when the bridge stops and a terminal can work on the same thread. `own`: run a
   * `codex app-server` of the bridge's own (the fallback).
   */
  mode: "shared" | "own";
  /** The installed `codex`; `~` is the home folder. A bare name is looked up on PATH. */
  path: string;
  /** The shared daemon's socket; null is the one `~/.codex` uses. */
  socket: string | null;
  /**
   * The model a new thread is named with after its first message, the way Codex's own
   * apps name theirs (one short request per thread). null: no names are made, and a
   * thread keeps the first line of its first message.
   */
  titleModel: string | null;
}

export interface PiConfig {
  /** The installed `pi`; `~` is the home folder. A bare name is looked up on PATH. */
  path: string;
  /** A thread's process stops after this long with nothing running or waiting. */
  idleMinutes: number;
  /** At most this many thread processes run at once. */
  maxWarm: number;
  /**
   * The model a new Pi thread starts on, as Pi lists it with its provider first
   * ("openai/gpt-6.1-sol"). null: Pi's own default, which under launchd can be another
   * than in a terminal, since it goes by the keys the environment has.
   */
  model: string | null;
  /**
   * The model ("provider/id") a new thread is named with after its first message, in one
   * short request at no thinking (`pi --print` with none of the user's tools or
   * extensions). Left out: the thread's own model. null: no names are made, and a thread
   * keeps the first line of its first message.
   */
  titleModel?: string | null;
}

export interface CursorConfig {
  /** The installed `cursor-agent`; `~` is the home folder. A bare name is looked up on PATH. */
  path: string;
  /** A folder's Cursor process stops after this long with nothing running or waiting. */
  idleMinutes: number;
}

export interface HermesConfig {
  /** The installed `hermes`; `~` is the home folder. A bare name is looked up on PATH. */
  path: string;
  /**
   * Start `hermes serve` when none runs. The bridge otherwise joins the one this Mac
   * runs (Hermes runs one for all its profiles), and its threads wait until there is one.
   */
  start: boolean;
}

export interface DroidConfig {
  /** The installed `droid`; `~` is the home folder. A bare name is looked up on PATH. */
  path: string;
  /** A thread's process stops after this long with nothing running or waiting. */
  idleMinutes: number;
  /** At most this many thread processes run at once. */
  maxWarm: number;
  /**
   * The model a new thread is named with after its first message, in one short `droid
   * exec`. Left out: the thread's own model. null: the bridge makes no names, and a thread
   * takes Droid's own.
   */
  titleModel?: string | null;
}

export interface Paths {
  home: string;
  config: string;
  /** The sign-in password in plain text, as setup made it (0600). */
  password: string;
  /** What setup found and made (src/setup/state.ts). */
  setup: string;
  /** The installed bridge the LaunchAgent runs. */
  app: string;
  /** The folder of the `portals` command, put on the PATH of the agents the bridge runs. */
  bin: string;
  /** The `portals` command: a launcher for the bridge that runs from this folder. */
  command: string;
  /** The socket the command reaches the bridge by. */
  socket: string;
  /** The other Macs this bridge can reach: their address and sign-in (0600). */
  links: string;
  state: string;
  threads: string;
  /** The threads taken off the list (`thread.delete`), kept to be taken up again (sessions/registry.ts). */
  removed: string;
  push: string;
  /** The folders the user added for new threads (src/folders.ts). */
  folders: string;
  /** How the agents look on every device (src/looks.ts). */
  looks: string;
  /** The messages waiting for a running turn, while they wait (src/sessions/waiting.ts). */
  waiting: string;
  /** What turns spent, for agents whose history keeps no tokens (src/sessions/spent.ts). */
  spent: string;
  /** The diffs of edits, for agents whose history will not give them back as they were (src/sessions/keptDiffs.ts). */
  diffs: string;
  /** The order of the agents and the folders in the sidebar on every device (src/order.ts). */
  order: string;
  /** The id this bridge gave itself (src/order.ts, `machineID`). */
  machine: string;
  /** The net's members (src/net/net.ts). */
  net: string;
  /** What of the net never leaves this Mac: its token, key and relay secret (0600). */
  netOwn: string;
  /** Where the scripted agent keeps its conversations. */
  fake: string;
  /** Images from the phone, written for Codex to read, and deleted again. */
  images: string;
  /** What Cursor said of its models and commands, and its threads' conversations. */
  cursor: string;
  /** Droid's session identities and its threads' display conversations. */
  droid: string;
  /** Hermes's profiles, as it last listed them. */
  hermesProfiles: string;
  /** What a `hermes serve` the bridge started printed. */
  hermesLog: string;
  /** The counters' lines, when they are on (src/counters.ts). */
  counters: string;
  /** When npm's registry was last asked for the latest version, and what it said (src/updates.ts). */
  update: string;
}

/** The deployed relay (relay/README.md): notifications (`push.relay`) and the tunnel (`relay.url`). */
const deployedRelay = "https://portals-relay.danielou1208.workers.dev";

export const defaults: Config = {
  host: "127.0.0.1",
  port: 9120,
  auth: null,
  allowedHosts: ["127.0.0.1", "localhost", "::1"],
  generalFolder: "~/Portals",
  folders: { hide: [] },
  providers: { claude: true, codex: true, pi: false, cursor: true, droid: true, hermes: true, fake: false },
  claude: { path: "~/.local/bin/claude", idleMinutes: 15, maxWarm: 6, apiKey: null, toolSummaries: true },
  // Codex's own model for titles (codex-cli 0.162.1).
  codex: { mode: "shared", path: "codex", socket: null, titleModel: "gpt-5.6-luna" },
  pi: { path: "pi", idleMinutes: 15, maxWarm: 6, model: null },
  cursor: { path: "~/.local/bin/cursor-agent", idleMinutes: 15 },
  droid: { path: "~/.local/bin/droid", idleMinutes: 15, maxWarm: 6 },
  hermes: { path: "~/.local/bin/hermes", start: true },
  fake: { delayMs: 40, agents: 1 },
  apns: null,
  push: { dryRun: null, relay: deployedRelay },
  fleet: { tellAgents: true, name: null, tellStarters: true },
  net: { url: null },
  relay: { enabled: true, url: deployedRelay },
  visuals: { tellAgents: true },
  counters: { enabled: false },
  updates: { check: true },
};

export class ConfigError extends Error {}

/** The bridge's folder: `$PORTALS_BRIDGE_HOME` or `$AERIPORTAL_BRIDGE_HOME`, else the usual one (`defaultBridgeHome`). */
export function bridgeHome(env: NodeJS.ProcessEnv = process.env, os: HostOS = hostOS): string {
  const override = env.PORTALS_BRIDGE_HOME?.trim() || env.AERIPORTAL_BRIDGE_HOME?.trim();
  if (override) return expandHome(override);
  return defaultBridgeHome(os, env);
}

/** The usual folder, whatever `PORTALS_BRIDGE_HOME` says: in Application Support on a Mac, in XDG's data folder on Linux. */
export function defaultBridgeHome(os: HostOS = hostOS, env: NodeJS.ProcessEnv = process.env): string {
  return join(dataFolder(os, env), "portals-bridge");
}

export function pathsFor(home: string): Paths {
  const state = join(home, "state");
  return {
    home,
    config: join(home, "config.json"),
    password: join(home, "password.txt"),
    setup: join(home, "setup.json"),
    app: join(home, "app"),
    bin: join(home, "bin"),
    command: join(home, "bin", "portals"),
    socket: socketPath(home),
    links: join(home, "links.json"),
    state,
    threads: join(state, "threads.json"),
    removed: join(state, "removed.json"),
    push: join(state, "push.json"),
    folders: join(state, "folders.json"),
    looks: join(state, "looks.json"),
    waiting: join(state, "waiting"),
    spent: join(state, "spent"),
    diffs: join(state, "diffs"),
    order: join(state, "order.json"),
    machine: join(state, "machine.json"),
    net: join(state, "net.json"),
    netOwn: join(state, "net-own.json"),
    fake: join(state, "fake"),
    images: join(state, "images"),
    cursor: join(state, "cursor"),
    droid: join(state, "droid"),
    hermesProfiles: join(state, "hermes.json"),
    hermesLog: join(home, "hermes-serve.log"),
    counters: join(home, "counters.log"),
    update: join(state, "update.json"),
  };
}

/**
 * Where the bridge in `home` listens for the `portals` command. In its folder, unless
 * that makes a path longer than a socket's may be (103 bytes on macOS): then in the
 * user's own folder under `/tmp` (`checkSocketFolder`), named by the bridge's folder.
 */
export function socketPath(home: string): string {
  const inHome = join(home, "agent.sock");
  if (Buffer.byteLength(inHome) <= 103) return inHome;
  const name = createHash("sha256").update(home).digest("hex").slice(0, 16);
  return join(sharedSocketFolder(), `${name}.sock`);
}

function sharedSocketFolder(): string {
  return `/tmp/portals-${userInfo().uid}`;
}

/**
 * For a socket under `/tmp`: checks its folder is this user's own, which no one else
 * can enter, so no other user of the Mac can have put a socket of theirs in its place.
 * `make` makes the folder when there is none (the bridge, before it listens). Throws
 * with a sentence when the folder is someone else's or open to others.
 */
export function checkSocketFolder(path: string, make = false, shared = sharedSocketFolder()): void {
  const folder = dirname(path);
  if (folder !== shared) return;
  if (make) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const found = lstatSync(folder);
  if (!found.isDirectory() || found.uid !== userInfo().uid || (found.mode & 0o077) !== 0) {
    throw new Error(`${folder} is not a folder only you can open, so the portals command's socket is not kept there. Remove it and start the bridge again.`);
  }
}

/** `~` and `~/…` with the home folder spelled out. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Reads `config.json` from `home`, writing one with the defaults first when there is
 * none. Missing keys take their defaults. Throws `ConfigError` with a sentence for a
 * setting that cannot be used.
 */
export function loadConfig(home: string): Config {
  const paths = pathsFor(home);
  ensureDirectory(home);
  ensureDirectory(paths.state);
  if (!existsSync(paths.config)) {
    writeJSON(paths.config, defaults);
  }
  // It holds the password hash: owner only, even when written by hand.
  try {
    chmodSync(paths.config, 0o600);
  } catch {
    // Not ours to change; reading it still works.
  }
  const raw = readJSON<unknown>(paths.config, undefined);
  if (raw === undefined || typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${paths.config} is not a JSON object.`);
  }
  return parseConfig(raw as Record<string, unknown>);
}

const loopback = new Set(["127.0.0.1", "::1", "localhost"]);

export function parseConfig(raw: Record<string, unknown>): Config {
  const config: Config = {
    host: stringSetting(raw, "host", defaults.host),
    port: raw.port === undefined ? defaults.port : (raw.port as number),
    auth: null,
    allowedHosts: stringList(raw, "allowedHosts", defaults.allowedHosts).map((name) => name.toLowerCase()),
    generalFolder: stringSetting(raw, "generalFolder", defaults.generalFolder),
    folders: parseFolders(raw.folders),
    providers: parseProviders(raw.providers),
    claude: parseClaude(raw.claude),
    codex: parseCodex(raw.codex),
    pi: parsePi(raw.pi),
    cursor: parseCursor(raw.cursor),
    droid: parseDroid(raw.droid),
    hermes: parseHermes(raw.hermes),
    fake: { delayMs: defaults.fake.delayMs, agents: defaults.fake.agents },
    apns: parseApns(raw.apns),
    push: parsePush(raw.push),
    fleet: parseFleet(raw.fleet),
    net: parseNet(raw.net),
    relay: parseRelay(raw.relay),
    visuals: parseVisuals(raw.visuals),
    // Unlike the rest, a value that cannot be used is off and no error: a slip in this
    // key must not stop the bridge, which the LaunchAgent would start again for ever.
    // Nothing is said here either (this runs at every sign-in): the counters say it.
    counters: { enabled: countersSwitch(raw.counters) === true },
    updates: parseUpdates(raw.updates),
  };
  if (!loopback.has(config.host)) {
    throw new ConfigError(`host must be a loopback address (127.0.0.1, ::1 or localhost), not ${config.host}. The bridge is never exposed directly.`);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new ConfigError(`port must be a whole number from 0 to 65535.`);
  }
  if (raw.auth !== undefined && raw.auth !== null) {
    const auth = raw.auth as Record<string, unknown>;
    if (typeof auth.username !== "string" || auth.username === "" || typeof auth.passwordHash !== "string" || !auth.passwordHash.startsWith("scrypt$")) {
      throw new ConfigError(`auth needs a username and a passwordHash made by portals-host setup or scripts/hash-password.ts.`);
    }
    config.auth = { username: auth.username, passwordHash: auth.passwordHash };
  }
  const fake = raw.fake as Record<string, unknown> | undefined;
  if (fake && typeof fake.delayMs === "number" && fake.delayMs >= 0) {
    config.fake.delayMs = fake.delayMs;
  }
  if (fake && Number.isInteger(fake.agents) && (fake.agents as number) >= 1 && (fake.agents as number) <= 10) {
    config.fake.agents = fake.agents as number;
  }
  return config;
}

function section(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function parseFolders(value: unknown): FoldersConfig {
  const raw = section(value, "folders");
  return { hide: stringList(raw, "hide", defaults.folders.hide, "folders.hide") };
}

function parseProviders(value: unknown): Config["providers"] {
  const raw = section(value, "providers");
  const providers = { ...defaults.providers };
  for (const name of ["claude", "codex", "pi", "cursor", "droid", "hermes", "fake"] as const) {
    if (raw[name] === undefined) continue;
    if (typeof raw[name] !== "boolean") throw new ConfigError(`providers.${name} must be true or false.`);
    providers[name] = raw[name];
  }
  return providers;
}

function parseClaude(value: unknown): ClaudeConfig {
  const raw = section(value, "claude");
  const claude = { ...defaults.claude };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path === "") throw new ConfigError("claude.path must be the path of the installed claude.");
    claude.path = raw.path;
  }
  if (raw.idleMinutes !== undefined) {
    if (typeof raw.idleMinutes !== "number" || !(raw.idleMinutes > 0)) throw new ConfigError("claude.idleMinutes must be a number above 0.");
    claude.idleMinutes = raw.idleMinutes;
  }
  if (raw.maxWarm !== undefined) {
    if (!Number.isInteger(raw.maxWarm) || (raw.maxWarm as number) < 1) throw new ConfigError("claude.maxWarm must be a whole number, 1 or more.");
    claude.maxWarm = raw.maxWarm as number;
  }
  if (raw.apiKey !== undefined && raw.apiKey !== null) {
    if (typeof raw.apiKey !== "string" || raw.apiKey.trim() === "") throw new ConfigError("claude.apiKey must be an API key, or null to use the Claude sign-in.");
    claude.apiKey = raw.apiKey.trim();
  }
  if (raw.toolSummaries !== undefined) {
    if (typeof raw.toolSummaries !== "boolean") throw new ConfigError("claude.toolSummaries must be true or false.");
    claude.toolSummaries = raw.toolSummaries;
  }
  return claude;
}

function parseCodex(value: unknown): CodexConfig {
  const raw = section(value, "codex");
  const codex = { ...defaults.codex };
  if (raw.mode !== undefined) {
    if (raw.mode !== "shared" && raw.mode !== "own") throw new ConfigError('codex.mode must be "shared" (the app-server daemon) or "own" (a codex app-server of the bridge\'s own).');
    codex.mode = raw.mode;
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path === "") throw new ConfigError("codex.path must be the path of the installed codex.");
    codex.path = raw.path;
  }
  if (raw.socket !== undefined && raw.socket !== null) {
    if (typeof raw.socket !== "string" || raw.socket === "") throw new ConfigError("codex.socket must be the path of the app-server daemon's socket, or null for the usual one.");
    codex.socket = raw.socket;
  }
  if (raw.titleModel !== undefined) {
    if (raw.titleModel !== null && (typeof raw.titleModel !== "string" || raw.titleModel.trim() === "")) {
      throw new ConfigError("codex.titleModel must be a model Codex lists, or null to leave threads unnamed.");
    }
    codex.titleModel = raw.titleModel === null ? null : raw.titleModel.trim();
  }
  return codex;
}

function parsePi(value: unknown): PiConfig {
  const raw = section(value, "pi");
  const pi = { ...defaults.pi };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path === "") throw new ConfigError("pi.path must be the path of the installed pi.");
    pi.path = raw.path;
  }
  if (raw.idleMinutes !== undefined) {
    if (typeof raw.idleMinutes !== "number" || !(raw.idleMinutes > 0)) throw new ConfigError("pi.idleMinutes must be a number above 0.");
    pi.idleMinutes = raw.idleMinutes;
  }
  if (raw.maxWarm !== undefined) {
    if (!Number.isInteger(raw.maxWarm) || (raw.maxWarm as number) < 1) throw new ConfigError("pi.maxWarm must be a whole number, 1 or more.");
    pi.maxWarm = raw.maxWarm as number;
  }
  if (raw.model !== undefined && raw.model !== null) {
    // A provider, a slash, an id; no space, which a model change could not carry.
    if (typeof raw.model !== "string" || !/^[^\s/]+\/\S+$/.test(raw.model)) {
      throw new ConfigError('pi.model must name a model as Pi lists it, its provider first: "openai/gpt-6.1-sol".');
    }
    pi.model = raw.model;
  }
  if (raw.titleModel !== undefined) {
    if (raw.titleModel !== null && (typeof raw.titleModel !== "string" || !/^[^\s/]+\/\S+$/.test(raw.titleModel))) {
      throw new ConfigError('pi.titleModel must name a model as Pi lists it, its provider first ("openai/gpt-5.6-luna"), or be null to leave threads unnamed.');
    }
    pi.titleModel = raw.titleModel;
  }
  return pi;
}

function parseCursor(value: unknown): CursorConfig {
  const raw = section(value, "cursor");
  const cursor = { ...defaults.cursor };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path === "") throw new ConfigError("cursor.path must be the path of the installed cursor-agent.");
    cursor.path = raw.path;
  }
  if (raw.idleMinutes !== undefined) {
    if (typeof raw.idleMinutes !== "number" || !(raw.idleMinutes > 0)) throw new ConfigError("cursor.idleMinutes must be a number above 0.");
    cursor.idleMinutes = raw.idleMinutes;
  }
  return cursor;
}

function parseDroid(value: unknown): DroidConfig {
  const raw = section(value, "droid");
  const droid = { ...defaults.droid };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim() === "") throw new ConfigError("droid.path must be the path of the installed droid.");
    droid.path = raw.path;
  }
  if (raw.idleMinutes !== undefined) {
    if (typeof raw.idleMinutes !== "number" || !Number.isFinite(raw.idleMinutes) || !(raw.idleMinutes > 0)) throw new ConfigError("droid.idleMinutes must be a number above 0.");
    droid.idleMinutes = raw.idleMinutes;
  }
  if (raw.maxWarm !== undefined) {
    if (!Number.isInteger(raw.maxWarm) || (raw.maxWarm as number) < 1) throw new ConfigError("droid.maxWarm must be a whole number, 1 or more.");
    droid.maxWarm = raw.maxWarm as number;
  }
  if (raw.titleModel !== undefined) {
    if (raw.titleModel !== null && (typeof raw.titleModel !== "string" || !/^\S+$/.test(raw.titleModel))) {
      throw new ConfigError('droid.titleModel must name a model as Droid lists it ("glm-5.3-flash"), or be null to leave the names to Droid.');
    }
    droid.titleModel = raw.titleModel;
  }
  return droid;
}

function parseHermes(value: unknown): HermesConfig {
  const raw = section(value, "hermes");
  const hermes = { ...defaults.hermes };
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path === "") throw new ConfigError("hermes.path must be the path of the installed hermes.");
    hermes.path = raw.path;
  }
  if (raw.start !== undefined) {
    if (typeof raw.start !== "boolean") throw new ConfigError("hermes.start must be true or false.");
    hermes.start = raw.start;
  }
  return hermes;
}

function parseApns(value: unknown): ApnsConfig | null {
  if (value === undefined || value === null) return null;
  const raw = section(value, "apns");
  const field = (key: keyof ApnsConfig, what: string): string => {
    const setting = raw[key];
    if (typeof setting !== "string" || setting.trim() === "") throw new ConfigError(`apns.${key} must be ${what}, or apns null to send them through the relay (push.relay) instead.`);
    return setting.trim();
  };
  return {
    keyPath: field("keyPath", "the path of the APNs auth key (.p8)"),
    keyId: field("keyId", "the key's id"),
    teamId: field("teamId", "the developer team's id"),
  };
}

function parsePush(value: unknown): PushConfig {
  const raw = section(value, "push");
  const push = { ...defaults.push };
  if (raw.dryRun !== undefined && raw.dryRun !== null) {
    if (typeof raw.dryRun !== "string" || raw.dryRun === "") throw new ConfigError("push.dryRun must be the path of a file to write notifications to, or null to send them.");
    push.dryRun = raw.dryRun;
  }
  if (raw.relay === null) {
    push.relay = null;
  } else if (raw.relay !== undefined) {
    let url: URL | null = null;
    try {
      url = typeof raw.relay === "string" ? new URL(raw.relay) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new ConfigError("push.relay must be the relay's https address, or null to send no notifications through it.");
    }
    push.relay = raw.relay as string;
  }
  return push;
}

function parseFleet(value: unknown): FleetConfig {
  const raw = section(value, "fleet");
  const fleet = { ...defaults.fleet };
  if (raw.tellAgents !== undefined) {
    if (typeof raw.tellAgents !== "boolean") throw new ConfigError("fleet.tellAgents must be true or false.");
    fleet.tellAgents = raw.tellAgents;
  }
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.length > 100 || /[\n\r]/.test(raw.name)) throw new ConfigError("fleet.name must be this Mac's name, one line of at most 100 characters, or null for its Computer Name.");
    fleet.name = raw.name.trim();
  }
  if (raw.tellStarters !== undefined) {
    if (typeof raw.tellStarters !== "boolean") throw new ConfigError("fleet.tellStarters must be true or false.");
    fleet.tellStarters = raw.tellStarters;
  }
  return fleet;
}

function parseNet(value: unknown): NetConfig {
  const raw = section(value, "net");
  const net = { ...defaults.net };
  if (raw.url !== undefined && raw.url !== null) {
    let url: URL | null = null;
    try {
      url = typeof raw.url === "string" ? new URL(raw.url) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new ConfigError("net.url must be the address the other Macs and your devices reach this bridge at, with scheme and port, or null for setup's.");
    }
    net.url = (raw.url as string).replace(/\/+$/, "");
  }
  return net;
}

function parseRelay(value: unknown): RelayConfig {
  const raw = section(value, "relay");
  const relay = { ...defaults.relay };
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new ConfigError("relay.enabled must be true or false.");
    relay.enabled = raw.enabled;
  }
  if (raw.url !== undefined) {
    let url: URL | null = null;
    try {
      url = typeof raw.url === "string" ? new URL(raw.url) : null;
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new ConfigError("relay.url must be the relay's https address, or leave it out for the deployed relay's.");
    }
    relay.url = (raw.url as string).replace(/\/+$/, "");
  }
  return relay;
}

function parseUpdates(value: unknown): UpdatesConfig {
  const raw = section(value, "updates");
  const updates = { ...defaults.updates };
  if (raw.check !== undefined) {
    if (typeof raw.check !== "boolean") throw new ConfigError("updates.check must be true or false.");
    updates.check = raw.check;
  }
  return updates;
}

function parseVisuals(value: unknown): VisualsConfig {
  const raw = section(value, "visuals");
  const visuals = { ...defaults.visuals };
  if (raw.tellAgents !== undefined) {
    if (typeof raw.tellAgents !== "boolean") throw new ConfigError("visuals.tellAgents must be true or false.");
    visuals.tellAgents = raw.tellAgents;
  }
  return visuals;
}

function stringSetting(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value === "") throw new ConfigError(`${key} must be a non-empty string.`);
  return value;
}

function stringList(raw: Record<string, unknown>, key: string, fallback: string[], name = key): string[] {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigError(`${name} must be a list of strings.`);
  }
  return value as string[];
}
