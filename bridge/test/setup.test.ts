import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { encode } from "uqr";
import { pathsFor } from "../src/config.ts";
import { computerName } from "../src/platform.ts";
import { verifyPassword } from "../src/http/auth.ts";
import { droidProgram, findClaude, findCursor, findDroid, findPi, piFolders } from "../src/setup/agents.ts";
import { pair, relayReset, setup, status, uninstall, update, type Context, type SetupOptions } from "../src/setup/commands.ts";
import { appManifest } from "../src/setup/install.ts";
import { oldLabel, plist } from "../src/setup/launchAgent.ts";
import { moveOldInstall } from "../src/setup/migrate.ts";
import { pairingLink, qrCode } from "../src/setup/pairing.ts";
import { namesFor, readSetupState } from "../src/setup/state.ts";
import { unit, unitName } from "../src/setup/systemd.ts";
import { factoryAppDroids } from "../src/setup/system.ts";
import type { RunOptions, RunResult, System } from "../src/setup/system.ts";
import { freeServePort, mappingTo, parseServeStatus, parseStatus } from "../src/setup/tailscale.ts";
import type { Choice, Ui } from "../src/setup/ui.ts";

// `portals-host setup` and its other commands (src/setup/), against stand-ins for
// launchctl, tailscale, npm, claude, codex, pi and cursor-agent, in a home folder of the
// test's own.
// Nothing here touches launchd, the tailnet, a real bridge or an installed agent.

let root: string;
let home: string;
let realHome: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "portals-setup-test-"));
  realHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  process.env.PORTALS_SETUP_LAUNCHCTL = "/fake/launchctl";
  process.env.PORTALS_SETUP_TAILSCALE = "/fake/tailscale";
  process.env.PORTALS_SETUP_SYSTEMCTL = "/fake/systemctl";
  process.env.PORTALS_SETUP_LOGINCTL = "/fake/loginctl";
  process.env.PORTALS_SETUP_SUDO = "/fake/sudo";
});

after(() => {
  process.env.HOME = realHome;
  delete process.env.PORTALS_SETUP_LAUNCHCTL;
  delete process.env.PORTALS_SETUP_TAILSCALE;
  delete process.env.PORTALS_SETUP_SYSTEMCTL;
  delete process.env.PORTALS_SETUP_LOGINCTL;
  delete process.env.PORTALS_SETUP_SUDO;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  home = join(root, "home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  for (const program of [join(home, ".local", "bin", "claude"), join(home, "bin", "codex")]) {
    writeFileSync(program, "#!/bin/sh\nexit 1\n");
    chmodSync(program, 0o755);
  }
});

const dnsName = "mac.example.ts.net";
const signedInToCursor = "\n ✓ Logged in as dana@example.com\n\n";

/** launchd (systemd on Linux), Tailscale, npm and the agents as setup sees them, with every call kept. */
class FakeSystem implements System {
  uid = 501;
  calls: { program: string; args: string[]; options: RunOptions }[] = [];
  /** Label → pid of the loaded LaunchAgents. */
  loaded = new Map<string, number>();
  /** Label → the script the loaded job runs, from its plist when it was loaded. */
  scripts = new Map<string, string>();
  /** Labels switched off with `launchctl disable`. */
  disabled = new Set<string>();
  /** How many more times `print` finds a LaunchAgent after its bootout: a bridge takes a moment to stop. */
  stopsAfter = 0;
  private stopping = new Map<string, number>();
  /** Port → target of `tailscale serve`, with the ports something else serves. */
  served = new Map<number, string>([[443, "http://127.0.0.1:8787"], [10010, "http://127.0.0.1:8792"]]);
  tailscaleRunning = true;
  claudeSignedIn = false;
  /** Where `pi` is on PATH; null on a Mac without it. */
  pi: string | null = null;
  /** Where `cursor-agent` is on the PATH; most Macs have none. */
  cursor: string | null = null;
  droid: string | null = null;
  droidVersionCode = 0;
  appDroids?: () => string[];
  standaloneDroids?: () => string[];
  /** What `cursor-agent status` prints. */
  cursorStatus = signedInToCursor;
  /** On Linux: the folder of the user's systemd units, read at each daemon-reload. */
  unitFolder = "";
  /** Unit → its ExecStart line as systemd last loaded it. */
  units = new Map<string, string>();
  enabled = new Set<string>();
  /** Unit → pid of the ones running. */
  active = new Map<string, number>();
  /** Whether the user's systemd manager answers. */
  systemdReachable = true;
  linger = false;
  lingerWorks = true;
  /** Whether tailscaled lets only its operator change what it serves, as on Linux; and who that is. */
  operatorOnly = false;
  operator: string | null = null;
  /** The app that opens `portals://` links here; most Macs that run setup have none. */
  portalsApp: string | null = null;

  which(name: string): string | null {
    if (name === "pi") return this.pi;
    if (name === "cursor-agent") return this.cursor;
    if (name === "droid") return this.droid;
    return name === "codex" ? join(home, "bin", "codex") : null;
  }

  async run(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ program, args, options });
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    const name = basename(program);
    if (program === "/fake/launchctl") {
      const target = args[1] ?? "";
      const label = args[0] === "bootstrap" ? basename(args[2], ".plist") : target.split("/").at(-1)!;
      switch (args[0]) {
        case "print": {
          if (!this.loaded.has(label)) return { code: 113, stdout: "", stderr: "not found" };
          const script = this.scripts.get(label);
          const found = ok(`state = running\n\tpid = ${this.loaded.get(label)}\n${script ? `\targuments = {\n\t\t/usr/local/bin/node\n\t\t${script}\n\t}\n` : ""}`);
          const left = this.stopping.get(label);
          if (left === 0) {
            this.stopping.delete(label);
            this.loaded.delete(label);
            return { code: 113, stdout: "", stderr: "not found" };
          }
          if (left !== undefined) this.stopping.set(label, left - 1);
          return found;
        }
        case "enable":
          this.disabled.delete(label);
          return ok();
        case "bootstrap":
          // launchd's one answer to a label that is switched off, or still there.
          if (this.disabled.has(label) || this.loaded.has(label)) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
          this.loaded.set(label, 4242);
          // What launchd runs is the plist as it was loaded.
          this.scripts.set(label, /<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/.exec(readFileSync(args[2], "utf8"))?.[1] ?? "");
          return ok();
        case "bootout":
          if (this.stopsAfter > 0 && this.loaded.has(label)) this.stopping.set(label, this.stopsAfter);
          else this.loaded.delete(label);
          return ok();
        case "kickstart":
          return ok();
      }
    }
    if (program === "/fake/tailscale") {
      if (args.join(" ") === "status --json") {
        return ok(JSON.stringify({ BackendState: this.tailscaleRunning ? "Running" : "Stopped", Self: { DNSName: `${dnsName}.` }, CertDomains: [dnsName] }));
      }
      if (args.join(" ") === "serve status --json") {
        const tcp = Object.fromEntries([...this.served.keys()].map((port) => [String(port), { HTTPS: true }]));
        const web = Object.fromEntries([...this.served].map(([port, proxy]) => [`${dnsName}:${port}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(JSON.stringify({ TCP: tcp, Web: web }));
      }
      if (args[0] === "serve" && args.at(-1) === "off") {
        this.served.delete(Number(args[1].split("=")[1]));
        return ok();
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        if (this.operatorOnly && this.operator === null) {
          return { code: 1, stdout: "", stderr: `Access denied: serve config denied\nUse 'sudo tailscale serve ${args.slice(1).join(" ")}'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n` };
        }
        this.served.set(Number(args[3].split("=")[1]), args[4]);
        return ok();
      }
    }
    if (program === "/fake/systemctl" && args[0] === "--user") {
      const [verb, ...rest] = args.slice(1);
      const named = rest.find((arg) => arg.endsWith(".service")) ?? "";
      switch (verb) {
        case "show-environment":
          return this.systemdReachable ? ok("HOME=/home/dana\n") : { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" };
        case "daemon-reload":
          this.units.clear();
          for (const file of existsSync(this.unitFolder) ? readdirSync(this.unitFolder) : []) {
            if (file.endsWith(".service")) this.units.set(file, readFileSync(join(this.unitFolder, file), "utf8").split("\n").find((line) => line.startsWith("ExecStart=")) ?? "");
          }
          return ok();
        case "enable":
          this.enabled.add(named);
          return ok();
        case "start":
        case "restart":
          if (!this.units.has(named)) return { code: 5, stdout: "", stderr: `Failed to start ${named}: Unit ${named} not found.` };
          this.active.set(named, 4343);
          return ok();
        case "stop":
          this.active.delete(named);
          return ok();
        case "disable":
          this.enabled.delete(named);
          if (rest.includes("--now")) this.active.delete(named);
          return ok();
        case "reset-failed":
          return ok();
        case "show": {
          const execStart = this.units.get(named);
          if (execStart === undefined) return ok("MainPID=0\nLoadState=not-found\nActiveState=inactive\nExecStart=\n");
          // As systemd prints a command it loaded: its arguments unquoted, one space apart.
          const argv = [...execStart.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$")).join(" ");
          const pid = this.active.get(named) ?? 0;
          return ok(`MainPID=${pid}\nExecStart={ path=${argv.split(" ")[0]} ; argv[]=${argv} ; ignore_errors=no ; start_time=[n/a] ; pid=${pid} }\nLoadState=loaded\nActiveState=${pid ? "active" : "inactive"}\n`);
        }
      }
    }
    if (program === "/fake/loginctl") {
      if (args[0] === "show-user") return ok(this.linger ? "yes\n" : "no\n");
      if (args[0] === "enable-linger") {
        if (!this.lingerWorks) return { code: 1, stdout: "", stderr: "Could not enable linger: Access denied" };
        this.linger = true;
        return ok();
      }
    }
    if (program === "/fake/sudo" && args[0] === "/fake/loginctl" && args[1] === "enable-linger") {
      this.linger = true;
      return ok();
    }
    if (program === "/fake/sudo" && args[0] === "/fake/tailscale" && args[1] === "set" && args[2]?.startsWith("--operator=")) {
      this.operator = args[2].slice("--operator=".length);
      return ok();
    }
    if (name === "npm") {
      mkdirSync(join(options.cwd!, "node_modules"), { recursive: true });
      return ok();
    }
    if (name === "scutil") return ok("Test Mac\n");
    if (name === "claude" && args[0] === "--version") return ok("2.1.295 (Claude Code)\n");
    if (name === "claude" && args[0] === "auth") return ok(JSON.stringify({ loggedIn: this.claudeSignedIn }));
    if (name === "codex" && args[0] === "--version") return ok("codex-cli 0.162.0\n");
    if (name === "codex" && args[0] === "login") return ok("Logged in using ChatGPT\n");
    if (name === "pi" && args[0] === "--version") return ok("1.1.0\n");
    if (name === "cursor-agent" && args[0] === "--version") return ok("2026.10.01-e373342\n");
    if (name === "cursor-agent" && args[0] === "status") return ok(this.cursorStatus);
    if (name === "droid" && args[0] === "--version") return { code: this.droidVersionCode, stdout: "Droid 0.236.0\n", stderr: "" };
    if (program === "/usr/bin/osascript" && args.join(" ").includes("portals://")) return ok(this.portalsApp ? `${this.portalsApp}\n` : "\n");
    if (program === "/usr/bin/open" && args[0]?.startsWith("portals://pair?")) return ok();
    return { code: 127, stdout: "", stderr: `no stand-in for ${program} ${args.join(" ")}` };
  }

  ran(program: string, ...args: string[]): boolean {
    return this.calls.some((call) => call.program === program && args.every((arg, index) => call.args[index] === arg));
  }
}

/** Takes each question's default, unless `answers` has one for a question containing its key; keeps every line. */
class ScriptedUi implements Ui {
  lines: string[] = [];
  answers: Record<string, boolean | string>;

  constructor(answers: Record<string, boolean | string> = {}) {
    this.answers = answers;
  }

  private answer(question: string): boolean | string | undefined {
    const key = Object.keys(this.answers).find((part) => question.includes(part));
    return key === undefined ? undefined : this.answers[key];
  }

  begin(title: string, subtitle?: string) {
    this.lines.push(`# ${title}`);
    if (subtitle) this.lines.push(subtitle);
  }
  end(text: string) {
    this.lines.push(`. ${text}`);
  }
  task<T>(text: string, work: () => Promise<T>): Promise<T> {
    this.lines.push(`… ${text}`);
    return work();
  }
  say(text: string) {
    this.lines.push(text);
  }
  step(title: string) {
    this.lines.push(`## ${title}`);
  }
  ok(text: string) {
    this.lines.push(`ok ${text}`);
  }
  warn(text: string) {
    this.lines.push(`! ${text}`);
  }
  raw(text: string) {
    this.lines.push(text);
  }
  async confirm(question: string, fallback: boolean) {
    this.lines.push(`? ${question}`);
    const answer = this.answer(question);
    return typeof answer === "boolean" ? answer : fallback;
  }
  async choose<T extends string>(question: string, _choices: readonly Choice<T>[], fallback: T) {
    this.lines.push(`? ${question}`);
    const answer = this.answer(question);
    return (typeof answer === "string" ? answer : fallback) as T;
  }
  async secret(question: string) {
    this.lines.push(`? ${question}`);
    const answer = this.answer(question);
    return typeof answer === "string" ? answer : "";
  }

  get text(): string {
    return this.lines.join("\n");
  }
}

/** A stand-in `cursor-agent` in a folder of its own, where only the PATH finds it. */
function installCursor(system: FakeSystem): string {
  const program = join(home, "tools", "cursor-agent");
  mkdirSync(join(home, "tools"), { recursive: true });
  writeFileSync(program, "#!/bin/sh\nexit 1\n");
  chmodSync(program, 0o755);
  system.cursor = program;
  return program;
}

/** A package with a built bridge in it, as `npm pack` makes one. */
function fakePackage(): string {
  const path = mkdtempSync(join(root, "package-"));
  mkdirSync(join(path, "dist"));
  writeFileSync(join(path, "dist", "main.js"), "// the bridge\n");
  writeFileSync(join(path, "README.md"), "# portals-bridge\n");
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name: "portals-bridge", version: "9.9.9", dependencies: { ws: "8.22.0" }, peerDependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.292" }, devDependencies: { typescript: "7.0.2" } }),
  );
  return path;
}

/** Something answering the bridge's health check on a port of its own, standing in for the bridge launchd would start. */
async function healthCheck(): Promise<Server & { port: number }> {
  const server = createServer((_request, response) => response.end('{"status":"ok"}'));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(server, { port: (server.address() as AddressInfo).port });
}

function context(system: FakeSystem, ui: ScriptedUi, env: NodeJS.ProcessEnv = {}): Context {
  // No folder besides PATH is searched for Pi: the Mac the tests run on may have one beside its node.
  // A Mac's setup, on Linux too; a Linux computer's has its own tests (`linuxContext`).
  return { ui, system, env, interactive: false, plistFolder: join(home, "Library", "LaunchAgents"), packageRoot: fakePackage(), piFolders: [], os: "macos" };
}

/** A dummy `pi` where npm puts it under nvm, beside a node of its own. */
function dummyPi(): string {
  const path = join(home, ".nvm", "versions", "node", "v24.0.0", "bin", "pi");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

const apiKey = "sk-ant-api03-" + "x".repeat(40);

test("the pairing link carries the address, user, password and name, each percent-encoded", () => {
  const link = pairingLink({ url: "https://mac.example.ts.net:10010", user: "dana", password: "a+b/c=d&e", name: "Dana's Mac" });
  assert.equal(link, "portals://pair?v=1&url=https%3A%2F%2Fmac.example.ts.net%3A10010&user=dana&password=a%2Bb%2Fc%3Dd%26e&name=Dana's%20Mac");
  const read = new URL(link).searchParams;
  assert.deepEqual(Object.fromEntries(read), { v: "1", url: "https://mac.example.ts.net:10010", user: "dana", password: "a+b/c=d&e", name: "Dana's Mac" });
  assert.ok(!pairingLink({ url: "https://x:1", user: "u", password: "p" }).includes("name="));
});

test("the QR code sets both colours of every cell, two rows of modules to a line", () => {
  const text = "portals://pair?v=1&url=x";
  const modules = encode(text, { border: 2 }).data;
  const lines = qrCode(text, { color: true }).split("\n");
  assert.equal(lines.length, Math.ceil(modules.length / 2));
  // The top-left corner is quiet zone: white over white.
  assert.ok(lines[0].startsWith("\x1b[97;107m▀"));
  // The finder pattern's dark corner sits two modules in.
  assert.ok(lines[1].includes("\x1b[30;40m▀"));
  assert.ok(lines.every((line) => line.endsWith("\x1b[0m")));
});

test("Tailscale's status gives the Mac's name and whether HTTPS works; serve status the ports in use", () => {
  assert.deepEqual(parseStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "mac.example.ts.net." }, CertDomains: ["mac.example.ts.net"] })), {
    running: true,
    dnsName: "mac.example.ts.net",
    https: true,
  });
  assert.deepEqual(parseStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: {}, CertDomains: null })), { running: false, dnsName: null, https: false });

  const serve = parseServeStatus(
    JSON.stringify({
      TCP: { "443": { HTTPS: true }, "10010": { HTTPS: true }, "10011": { TCPForward: "127.0.0.1:22" } },
      Web: { "mac.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } }, "mac.example.ts.net:10010": { Handlers: { "/": { Proxy: "http://127.0.0.1:9120" } } } },
    }),
  );
  assert.deepEqual(mappingTo(serve, 9120), { port: 10010, proxy: "http://127.0.0.1:9120" });
  assert.equal(mappingTo(serve, 9121), undefined);
  // 10010 and 10011 are taken, the TCP forward included.
  assert.equal(freeServePort(serve), 10012);
  assert.deepEqual(parseServeStatus(""), { ports: new Set(), mappings: [] });
});

test("the LaunchAgent's plist runs the installed bridge with its PATH and log, escaped", () => {
  const text = plist({ label: "com.danielou.portals.bridge", node: "/n/node", script: "/a & b/dist/main.js", workingDirectory: "/a & b", path: "/x:/y", log: "/l.log", environment: { PORTALS_BRIDGE_HOME: "/h" } });
  assert.match(text, /<key>Label<\/key><string>com.danielou.portals.bridge<\/string>/);
  assert.match(text, /<string>\/n\/node<\/string>\s*<string>\/a &amp; b\/dist\/main.js<\/string>/);
  assert.match(text, /<key>PATH<\/key><string>\/x:\/y<\/string>/);
  assert.match(text, /<key>PORTALS_BRIDGE_HOME<\/key><string>\/h<\/string>/);
  assert.match(text, /<key>KeepAlive<\/key><true\/>/);
  assert.equal(text.match(/<string>\/l.log<\/string>/g)?.length, 2);
});

test("a bridge in its own folder gets a label and a log of its own", () => {
  const usual = join(home, "Library", "Application Support", "portals-bridge");
  assert.deepEqual(namesFor(usual, {}, "macos"), { label: "com.danielou.portals.bridge", log: join(home, "Library", "Logs", "portals-bridge.log") });
  assert.deepEqual(namesFor(join(home, "Library", "Application Support", "portals-bridge-dev"), {}, "macos"), {
    label: "com.danielou.portals.bridge.dev",
    log: join(home, "Library", "Logs", "portals-bridge-dev.log"),
  });
  assert.equal(namesFor("/tmp/my bridge", {}, "macos").label, "com.danielou.portals.bridge.my-bridge");
  assert.equal(namesFor(usual, { PORTALS_BRIDGE_LABEL: "x.test" }, "macos").label, "x.test");
  // On Linux, in XDG's data and state folders.
  assert.deepEqual(namesFor(join(home, ".local", "share", "portals-bridge"), {}, "linux"), { label: "com.danielou.portals.bridge", log: join(home, ".local", "state", "portals-bridge.log") });
  assert.deepEqual(namesFor(join(home, ".local", "share", "portals-bridge-dev"), { XDG_STATE_HOME: "/var/state/dana" }, "linux"), {
    label: "com.danielou.portals.bridge.dev",
    log: "/var/state/dana/portals-bridge-dev.log",
  });
});

test("the installed bridge's package.json has the SDK as a dependency and nothing for development", () => {
  assert.deepEqual(
    appManifest({ name: "portals-bridge", version: "1.0.0", dependencies: { ws: "8.22.0" }, peerDependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.292" } }),
    { name: "portals-bridge", version: "1.0.0", description: undefined, private: true, type: "module", dependencies: { ws: "8.22.0", "@anthropic-ai/claude-agent-sdk": "0.3.292" } },
  );
});

test("setup on a new Mac: password, Claude through an API key, a tailnet address, the LaunchAgent and the pairing code", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "bridge-home");
  rmSync(bridgeHome, { recursive: true, force: true });
  const bridge = await healthCheck();
  try {
    const code = await setup({ service: true, tailscale: true, port: bridge.port, claude: "api-key" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome, ANTHROPIC_API_KEY: apiKey }));
    assert.equal(code, 0, ui.text);
  } finally {
    bridge.close();
  }
  const paths = pathsFor(bridgeHome);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  assert.equal(config.port, bridge.port);
  assert.equal(config.generalFolder, "~/Portals");
  assert.ok(existsSync(join(home, "Portals")));
  // No Pi on this Mac: it is off, and setup says how to get it.
  assert.deepEqual(config.providers, { claude: true, codex: true, pi: false, cursor: false, droid: false, hermes: true, fake: false });
  assert.ok(ui.lines.includes("Pi: not found. Install it with: npm install -g @earendil-works/pi-coding-agent"));
  // No Cursor either: a new install turns it off, and says nothing of it.
  assert.ok(!ui.text.includes("Cursor"), ui.text);
  // Nor Droid.
  assert.ok(!ui.text.includes("Droid"), ui.text);
  assert.equal(config.claude.apiKey, apiKey);
  assert.equal(config.claude.path, join(home, ".local", "bin", "claude"));
  assert.equal(config.codex.path, join(home, "bin", "codex"));
  assert.ok(config.allowedHosts.includes(dnsName));

  const password = readFileSync(paths.password, "utf8");
  assert.match(password, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(statSync(paths.password).mode & 0o777, 0o600);
  assert.equal(config.auth.username, process.env.USER ?? config.auth.username);
  assert.ok(await verifyPassword(password, config.auth.passwordHash));

  // 10010 serves something else, so the bridge gets the next port.
  assert.ok(system.ran("/fake/tailscale", "serve", "--bg", "--yes", "--https=10011", `http://127.0.0.1:${bridge.port}`));
  const state = readSetupState(paths.setup)!;
  assert.equal(state.address, `https://${dnsName}:10011`);
  assert.equal(state.servePort, 10011);
  assert.equal(state.label, "com.danielou.portals.bridge.bridge-home");
  assert.equal(state.name, "Test Mac");

  assert.ok(existsSync(join(paths.app, "dist", "main.js")));
  assert.equal(JSON.parse(readFileSync(join(paths.app, "package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"], "0.3.292");
  const plistText = readFileSync(join(home, "Library", "LaunchAgents", `${state.label}.plist`), "utf8");
  assert.ok(plistText.includes(`<string>${paths.app}/dist/main.js</string>`));
  assert.ok(plistText.includes(`<key>PORTALS_BRIDGE_HOME</key><string>${bridgeHome}</string>`));
  assert.ok(system.loaded.has(state.label));

  const link = ui.lines.find((line) => line.startsWith("portals://pair?"))!;
  const read = new URL(link).searchParams;
  assert.equal(read.get("url"), `https://${dnsName}:10011`);
  assert.equal(read.get("password"), password);
  assert.equal(read.get("name"), "Test Mac");
  assert.match(ui.text, /Codex 0\.162\.0 .*signed in/);

  // Again: nothing new is made, the mapping is the one setup made, and the code is the same.
  const again = new ScriptedUi();
  const bridgeAgain = await healthCheck();
  const config2 = { ...config, port: bridgeAgain.port };
  writeFileSync(paths.config, JSON.stringify(config2));
  system.served.set(10011, `http://127.0.0.1:${bridgeAgain.port}`);
  try {
    assert.equal(await setup({ service: true, tailscale: true }, context(system, again, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, again.text);
  } finally {
    bridgeAgain.close();
  }
  assert.equal(readFileSync(paths.password, "utf8"), password);
  assert.equal(readSetupState(paths.setup)!.servePort, 10011);
  assert.equal(system.calls.filter((call) => call.args[0] === "serve" && call.args[1] === "--bg").length, 1);
  assert.match(again.text, /uses the API key in config.json/);
  assert.ok(again.lines.includes(link));

  // pair shows the same code; uninstall removes the LaunchAgent and the mapping, and keeps the folder.
  const paired = new ScriptedUi();
  assert.equal(await pair(context(system, paired, { PORTALS_BRIDGE_HOME: bridgeHome })), 0);
  assert.ok(paired.lines.includes(link));
  const removed = new ScriptedUi();
  assert.equal(await uninstall(context(system, removed, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, removed.text);
  assert.ok(!system.loaded.has(state.label));
  assert.ok(!existsSync(join(home, "Library", "LaunchAgents", `${state.label}.plist`)));
  assert.ok(!system.served.has(10011));
  assert.ok(system.served.has(10010));
  assert.ok(existsSync(paths.config));
});

/** A Linux computer's setup: its systemd user units in ~/.config/systemd/user. */
function linuxContext(system: FakeSystem, ui: ScriptedUi, env: NodeJS.ProcessEnv = {}, interactive = false): Context {
  system.unitFolder = join(home, ".config", "systemd", "user");
  return { ...context(system, ui, env), plistFolder: system.unitFolder, os: "linux", interactive };
}

/** An installed home and service, with every system command handled by the stand-in. */
async function uninstallFixture(os: "macos" | "linux", name: string) {
  const system = new FakeSystem();
  const ui = new ScriptedUi({ "Also delete": true });
  const paths = pathsFor(join(root, name));
  const env = { PORTALS_BRIDGE_HOME: paths.home };
  const ctx = os === "macos" ? context(system, ui, env) : linuxContext(system, ui, env);
  const label = `com.danielou.portals.bridge.${name}`;
  const spec = { label, node: process.execPath, script: join(paths.app, "dist", "main.js"), workingDirectory: paths.app, path: "/usr/bin:/bin", log: join(paths.home, "bridge.log") };
  mkdirSync(join(paths.app, "dist"), { recursive: true });
  mkdirSync(ctx.plistFolder!, { recursive: true });
  writeFileSync(spec.script, "// The test bridge is never run.\n");
  writeFileSync(paths.config, JSON.stringify({ port: 39150, providers: { fake: true } }));
  writeFileSync(paths.setup, JSON.stringify({ label, log: spec.log, servePort: 10011 }));
  system.served.set(10011, "http://127.0.0.1:39150");
  const file = join(ctx.plistFolder!, os === "macos" ? `${label}.plist` : unitName(label));
  writeFileSync(file, os === "macos" ? plist(spec) : unit(spec));
  if (os === "macos") {
    system.loaded.set(label, 4242);
    system.scripts.set(label, spec.script);
  } else {
    await system.run("/fake/systemctl", ["--user", "daemon-reload"]);
    system.active.set(unitName(label), 4343);
    system.enabled.add(unitName(label));
  }
  return { system, ui, paths, ctx, label, spec, file };
}

for (const os of ["macos", "linux"] as const) {
  test(`R1: relay reset on ${os} works without a service manager and keeps an answering home alone`, async () => {
    for (const running of [false, true]) {
      const { system, ui, paths, ctx } = await uninstallFixture(os, `reset-unmanaged-${os}-${running}`);
      const own = { token: "token", relay: { id: "relay", secret: "secret" } };
      mkdirSync(dirname(paths.netOwn), { recursive: true });
      writeFileSync(paths.netOwn, JSON.stringify(own));
      writeFileSync(`${paths.netOwn}.bak`, JSON.stringify(own));
      const run = system.run.bind(system);
      system.run = async (program, args, options) => {
        if (program === "/fake/systemctl" || (program === "/fake/launchctl" && args[0] === "print")) {
          system.calls.push({ program, args, options: options ?? {} });
          return { code: os === "macos" ? 112 : 127, stdout: "", stderr: "The service manager could not be reached." };
        }
        return run(program, args, options);
      };
      const socket = createSocketServer(() => {});
      if (running) {
        mkdirSync(dirname(paths.socket), { recursive: true });
        await new Promise<void>((resolve) => socket.listen(paths.socket, resolve));
      }
      try {
        assert.equal(await relayReset(ctx), running ? 1 : 0, ui.text);
        for (const file of [paths.netOwn, `${paths.netOwn}.bak`]) {
          assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), running ? own : { token: "token" });
        }
        assert.ok(!ui.text.includes("changed while you were asked"), ui.text);
        assert.ok(!system.calls.some((call) => call.args[0] === "bootout" || call.args[0] === "bootstrap" || call.args[1] === "stop" || call.args[1] === "start"));
      } finally {
        if (running) await new Promise<void>((resolve) => socket.close(() => resolve()));
      }
    }
  });

  test(`F1: status on ${os} reports an unknown service state and still checks the bridge`, async () => {
    for (const code of [os === "macos" ? 112 : 127, 124]) {
      const { system, ui, paths, ctx } = await uninstallFixture(os, `status-unknown-${os}-${code}`);
      const run = system.run.bind(system);
      system.run = async (program, args, options) => {
        if ((program === "/fake/launchctl" && args[0] === "print") || (program === "/fake/systemctl" && args[1] === "show")) {
          system.calls.push({ program, args, options: options ?? {} });
          return { code, stdout: "", stderr: "The service manager could not be reached." };
        }
        return run(program, args, options);
      };
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      try {
        assert.equal(await status(ctx), 0, ui.text);
        assert.match(ui.text, /Running:  can't tell/);
        assert.ok(ui.text.includes(`answers on 127.0.0.1:${bridge.port}`), ui.text);
        assert.ok(ui.text.includes(`Folder:   ${paths.home}`), ui.text);
        assert.ok(!ui.text.includes("unit and home were left"), ui.text);
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`F1: update on ${os} succeeds without restarting when the manager state is unknown`, async () => {
    const { system, ui, paths, ctx } = await uninstallFixture(os, `update-unknown-${os}`);
    const run = system.run.bind(system);
    system.run = async (program, args, options) => {
      if ((program === "/fake/launchctl" && args[0] === "print") || (program === "/fake/systemctl" && args[1] === "show")) {
        system.calls.push({ program, args, options: options ?? {} });
        return { code: os === "macos" ? 112 : 127, stdout: "", stderr: "The service manager could not be reached." };
      }
      return run(program, args, options);
    };
    assert.equal(await update(ctx), 0, ui.text);
    assert.equal(readSetupState(paths.setup)!.version, "9.9.9");
    assert.match(ui.text, /couldn't be checked.*nothing was restarted/);
    assert.ok(!system.calls.some((call) => call.args[0] === "kickstart" || call.args[1] === "restart"));
  });
}

for (const os of ["macos", "linux"] as const) {
  test(`two scratch homes on ${os}: updating a copied install leaves the original service alone`, async () => {
    const system = new FakeSystem();
    const original = pathsFor(join(root, `update-two-homes-${os}-original`));
    const copy = pathsFor(join(root, `update-two-homes-${os}-copy`));
    const ui = new ScriptedUi();
    const makeContext = (path: string, output: ScriptedUi) => os === "macos"
      ? context(system, output, { PORTALS_BRIDGE_HOME: path })
      : linuxContext(system, output, { PORTALS_BRIDGE_HOME: path });
    const ownerContext = makeContext(original.home, ui);
    const bridge = await healthCheck();
    try {
      assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" }, ownerContext), 0, ui.text);
      const label = readSetupState(original.setup)!.label;
      const script = join(original.app, "dist", "main.js");
      writeFileSync(script, "// the original running install\n");
      cpSync(original.home, copy.home, { recursive: true });
      const before = {
        definition: readFileSync(join(ownerContext.plistFolder!, os === "macos" ? `${label}.plist` : unitName(label)), "utf8"),
        pid: os === "macos" ? system.loaded.get(label) : system.active.get(unitName(label)),
      };
      assert.equal(typeof before.pid, "number", "the original service is running");
      const changed = new ScriptedUi();
      const at = system.calls.length;
      assert.equal(await update(makeContext(copy.home, changed)), 0, changed.text);
      assert.equal(readSetupState(copy.setup)!.version, "9.9.9");
      assert.equal(readFileSync(join(copy.app, "dist", "main.js"), "utf8"), "// the bridge\n");
      assert.equal(readFileSync(script, "utf8"), "// the original running install\n");
      assert.equal(readFileSync(join(ownerContext.plistFolder!, os === "macos" ? `${label}.plist` : unitName(label)), "utf8"), before.definition);
      assert.equal(os === "macos" ? system.loaded.get(label) : system.active.get(unitName(label)), before.pid);
      assert.ok(!system.calls.slice(at).some((call) => call.args[0] === "kickstart" || call.args[1] === "restart"), changed.text);
      assert.match(changed.text, /nothing was restarted/);
      // Updating the actual owner still restarts it through the same stand-in.
      assert.equal(await update(ownerContext), 0, ui.text);
      assert.ok(system.calls.slice(at).some((call) => call.args[0] === "kickstart" || call.args[1] === "restart"));
    } finally {
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  for (const changed of ["loaded job", "definition", "unverifiable job"] as const) {
    test(`update on ${os} installs without restarting an unowned service (${changed})`, async () => {
      const { system, ui, paths, ctx, label, spec, file } = await uninstallFixture(os, `update-ownership-${os}-${changed.replaceAll(" ", "-")}`);
      const other = { ...spec, script: join(root, "original-home", "app", "dist", "main.js") };
      if (changed === "definition") {
        writeFileSync(file, os === "macos" ? plist(other) : unit(other));
      } else if (changed === "loaded job") {
        if (os === "macos") system.scripts.set(label, other.script);
        else system.units.set(unitName(label), unit(other).split("\n").find((line) => line.startsWith("ExecStart="))!);
      } else {
        const run = system.run.bind(system);
        system.run = async (program, args, options) => {
          const result = await run(program, args, options);
          if (program === "/fake/launchctl" && args[0] === "print") result.stdout = "state = running\n\tpid = 4242\n";
          if (program === "/fake/systemctl" && args.includes("ExecStart")) result.stdout = "LoadState=loaded\nActiveState=active\n";
          return result;
        };
      }
      const definition = readFileSync(file, "utf8");
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      try {
        assert.equal(await update(ctx), 0, ui.text);
        assert.equal(readSetupState(paths.setup)!.version, "9.9.9");
        assert.equal(readFileSync(file, "utf8"), definition);
        assert.ok(!system.calls.some((call) => call.args[0] === "kickstart" || call.args[1] === "restart"), ui.text);
        assert.match(ui.text, /nothing was restarted/);
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    });
  }
}

test("R2: Linux uninstall skips an unreachable manager only without a unit, socket or listener", async () => {
  for (const mode of ["quiet", "busy", "socket", "unit"]) {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture("linux", `unmanaged-${mode}`);
    system.active.delete(unitName(label));
    system.units.delete(unitName(label));
    if (mode !== "unit") rmSync(file);
    const run = system.run.bind(system);
    system.run = async (program, args, options) => {
      if (program === "/fake/systemctl") {
        system.calls.push({ program, args, options: options ?? {} });
        return { code: 127, stdout: "", stderr: "systemctl is not installed." };
      }
      return run(program, args, options);
    };
    const bridge = await healthCheck();
    writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
    system.served.set(10011, `http://127.0.0.1:${bridge.port}`);
    const socket = createSocketServer(() => {});
    if (mode === "socket") {
      mkdirSync(dirname(paths.socket), { recursive: true });
      await new Promise<void>((resolve) => socket.listen(paths.socket, resolve));
    }
    if (mode !== "busy") await new Promise<void>((resolve) => bridge.close(() => resolve()));
    const calls = system.calls.length;
    try {
      if (mode === "quiet") {
        assert.equal(await uninstall(ctx), 0, ui.text);
        assert.ok(!existsSync(paths.home) && !system.served.has(10011));
        assert.match(ui.text, /service step was skipped/);
      } else {
        await assert.rejects(uninstall(ctx), /could not confirm/);
        assert.ok(existsSync(paths.config) && system.served.has(10011));
        assert.ok(!ui.text.includes("? Also delete"), ui.text);
      }
      assert.ok(!system.calls.slice(calls).some((call) => call.program === "/fake/systemctl" && ["disable", "stop", "daemon-reload"].includes(call.args[1])));
    } finally {
      if (bridge.listening) await new Promise<void>((resolve) => bridge.close(() => resolve()));
      if (mode === "socket") await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }
});

test("R2: an unmanaged home's quiet port is checked again after the delete question", async () => {
  const { system, ui, paths, ctx, label, file } = await uninstallFixture("linux", "unmanaged-late-listener");
  system.active.delete(unitName(label));
  system.units.delete(unitName(label));
  rmSync(file);
  const run = system.run.bind(system);
  system.run = async (program, args, options) => {
    if (program === "/fake/systemctl") {
      system.calls.push({ program, args, options: options ?? {} });
      return { code: 127, stdout: "", stderr: "systemctl is not installed." };
    }
    return run(program, args, options);
  };
  const bridge = await healthCheck();
  const port = bridge.port;
  writeFileSync(paths.config, JSON.stringify({ port, providers: { fake: true } }));
  system.served.set(10011, `http://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
  const listener = createServer((_request, response) => response.end("another bridge"));
  ui.answers["Remove the tailscale"] = false;
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (question, fallback) => {
    if (question.startsWith("Also delete")) await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
    return confirm(question, fallback);
  };
  try {
    await assert.rejects(uninstall(ctx), /could not confirm/);
    assert.ok(ui.text.includes("? Also delete"), ui.text);
    assert.ok(existsSync(paths.config) && system.served.has(10011));
  } finally {
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("SETUP-2: uninstall keeps the unit and home when a failed stop cannot be confirmed", async () => {
  for (const code of [1, 124]) {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture("linux", `unknown-stop-${code}`);
    const run = system.run.bind(system);
    let stopping = false;
    system.run = async (program, args, options) => {
      if (program === "/fake/systemctl" && (args[1] === "disable" || (stopping && args[1] === "show"))) {
        system.calls.push({ program, args, options: options ?? {} });
        stopping = true;
        return { code, stdout: "", stderr: code === 124 ? "systemctl took too long and was stopped." : "Failed to connect to bus: Connection reset by peer" };
      }
      return run(program, args, options);
    };
    await assert.rejects(uninstall(ctx), /could not confirm|can't be reached|disable --now failed/);
    assert.ok(system.active.has(unitName(label)));
    assert.ok(existsSync(file) && existsSync(paths.config));
    assert.ok(system.served.has(10011));
    assert.ok(!ui.text.includes("ok Stopped.") && !ui.text.includes("? Also delete"), ui.text);
  }
});

test("SETUP-2: a failed disable can remove a positively inactive or absent unit", async () => {
  for (const loadState of ["loaded", "not-found"]) {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture("linux", `stopped-${loadState}`);
    const run = system.run.bind(system);
    let stopping = false;
    system.run = async (program, args, options) => {
      if (program === "/fake/systemctl" && args[1] === "disable") {
        system.calls.push({ program, args, options: options ?? {} });
        stopping = true;
        system.active.delete(unitName(label));
        return { code: 1, stdout: "", stderr: "The unit is already disabled." };
      }
      if (program === "/fake/systemctl" && stopping && args[1] === "show") {
        system.calls.push({ program, args, options: options ?? {} });
        return { code: 0, stdout: `LoadState=${loadState}\nActiveState=inactive\nMainPID=0\n`, stderr: "" };
      }
      return run(program, args, options);
    };
    assert.equal(await uninstall(ctx), 0, ui.text);
    assert.ok(!existsSync(file) && !existsSync(paths.home));
  }
});

for (const os of ["macos", "linux"] as const) {
  test(`SETUP-1: uninstall on ${os} leaves another home's loaded job, definition and mapping alone`, async () => {
    for (const situation of ["original", "unloaded", "own-file", "own-job"]) {
      for (const deleteHome of [false, true]) {
        const { system, paths, ctx, label, spec, file } = await uninstallFixture(os, `ownership-${os}-${situation}-${deleteHome}`);
        const copy = pathsFor(`${paths.home}-copy`);
        mkdirSync(copy.home);
        writeFileSync(copy.config, readFileSync(paths.config));
        writeFileSync(copy.setup, readFileSync(paths.setup));
        const copyScript = join(copy.app, "dist", "main.js");
        if (situation === "unloaded") {
          system.loaded.delete(label);
          system.active.delete(unitName(label));
        }
        if (situation === "own-file") {
          const copied = { ...spec, script: copyScript };
          writeFileSync(file, os === "macos" ? plist(copied) : unit(copied));
        }
        if (situation === "own-job") {
          system.scripts.set(label, copyScript);
          system.units.set(unitName(label), unit({ ...spec, script: copyScript }).split("\n").find((line) => line.startsWith("ExecStart="))!);
        }
        const definition = readFileSync(file, "utf8");
        const ui = new ScriptedUi({ "Also delete": deleteHome });
        const calls = system.calls.length;
        const runningCopy = situation === "own-job";
        assert.equal(await uninstall({ ...ctx, ui, env: { PORTALS_BRIDGE_HOME: copy.home } }), runningCopy ? 1 : 0, ui.text);
        assert.equal(readFileSync(file, "utf8"), definition);
        assert.equal(os === "macos" ? system.loaded.has(label) : system.active.has(unitName(label)), situation !== "unloaded");
        assert.ok(existsSync(paths.config));
        assert.equal(existsSync(copy.config), runningCopy || !deleteHome);
        assert.ok(!ui.text.includes("Run npx portals-host setup"), ui.text);
        assert.ok(system.served.has(10011));
        assert.ok(!system.calls.slice(calls).some((call) => call.args[0] === "bootout" || call.args[1] === "disable" || call.args.at(-1) === "off"));
      }
    }
  });

  test(`SETUP-1: uninstall on ${os} rechecks the loaded job and definition after confirmation`, async () => {
    for (const change of ["job", "file"]) {
      const { system, ui, paths, ctx, label, spec, file } = await uninstallFixture(os, `changed-${os}-${change}`);
      const foreign = { ...spec, script: join(root, "elsewhere", "app", "dist", "main.js") };
      ui.confirm = async (question) => {
        ui.lines.push(`? ${question}`);
        if (question.startsWith("Stop Portals")) {
          if (change === "file") writeFileSync(file, os === "macos" ? plist(foreign) : unit(foreign));
          else {
            system.scripts.set(label, foreign.script);
            system.units.set(unitName(label), unit(foreign).split("\n").find((line) => line.startsWith("ExecStart="))!);
          }
        }
        return true;
      };
      const calls = system.calls.length;
      assert.equal(await uninstall(ctx), 1, ui.text);
      assert.match(ui.text, /changed while you were asked/);
      assert.ok(existsSync(file) && existsSync(paths.config));
      assert.ok(system.served.has(10011));
      assert.ok(!system.calls.slice(calls).some((call) => call.args[0] === "bootout" || call.args[1] === "disable" || call.args.at(-1) === "off"));
    }
  });

  test(`F3: uninstall on ${os} offers mapping removal without a service when its port is quiet`, async () => {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture(os, `no-service-${os}`);
    system.loaded.delete(label);
    system.active.delete(unitName(label));
    system.units.delete(unitName(label));
    rmSync(file);
    const bridge = await healthCheck();
    writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
    system.served.set(10011, `http://127.0.0.1:${bridge.port}`);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    assert.equal(await uninstall(ctx), 0, ui.text);
    assert.ok(!system.served.has(10011));
    assert.ok(ui.text.includes("? Remove the tailscale"), ui.text);
    assert.ok(!existsSync(paths.home));
  });

  test(`F3: uninstall on ${os} distinguishes its own socket from another home's busy port`, async () => {
    for (const ours of [false, true]) {
      const { system, ui, paths, ctx, label, file } = await uninstallFixture(os, `busy-port-${os}-${ours}`);
      system.loaded.delete(label);
      system.active.delete(unitName(label));
      system.units.delete(unitName(label));
      rmSync(file);
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      system.served.set(10011, `http://127.0.0.1:${bridge.port}`);
      const socket = createSocketServer(() => {});
      if (ours) {
        mkdirSync(dirname(paths.socket), { recursive: true });
        await new Promise<void>((resolve) => socket.listen(paths.socket, resolve));
      }
      try {
        assert.equal(await uninstall(ctx), ours ? 1 : 0, ui.text);
        assert.equal(system.served.has(10011), !ours);
        assert.equal(ui.text.includes("? Remove the tailscale"), ours, ui.text);
        if (!ours) assert.ok(ui.text.includes("tailscale serve --https=10011 off"), ui.text);
        assert.equal(existsSync(paths.home), ours);
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
        if (ours) await new Promise<void>((resolve) => socket.close(() => resolve()));
      }
    }
  });

  test(`F3: uninstall on ${os} rechecks a quiet port after mapping confirmation`, async () => {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture(os, `new-listener-${os}`);
    system.loaded.delete(label);
    system.active.delete(unitName(label));
    system.units.delete(unitName(label));
    rmSync(file);
    const bridge = await healthCheck();
    const port = bridge.port;
    writeFileSync(paths.config, JSON.stringify({ port, providers: { fake: true } }));
    system.served.set(10011, `http://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    const confirm = ui.confirm.bind(ui);
    const listener = createServer((_request, response) => response.end("another bridge"));
    ui.confirm = async (question, fallback) => {
      if (question.startsWith("Remove the tailscale")) await new Promise<void>((resolve) => listener.listen(port, "127.0.0.1", resolve));
      return confirm(question, fallback);
    };
    try {
      assert.equal(await uninstall(ctx), 0, ui.text);
      assert.ok(ui.text.includes("? Remove the tailscale"), ui.text);
      assert.ok(system.served.has(10011));
      assert.ok(ui.text.includes("tailscale serve --https=10011 off"), ui.text);
    } finally {
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  test(`F3: uninstall on ${os} keeps a mapping when another home takes its label during confirmation`, async () => {
    const { system, ui, ctx, label, spec, file } = await uninstallFixture(os, `mapping-label-${os}`);
    const foreign = { ...spec, script: join(root, "another-home", "app", "dist", "main.js") };
    const definition = os === "macos" ? plist(foreign) : unit(foreign);
    const confirm = ui.confirm.bind(ui);
    ui.confirm = async (question, fallback) => {
      if (question.startsWith("Remove the tailscale")) {
        writeFileSync(file, definition);
        system.loaded.set(label, 4242);
        system.scripts.set(label, foreign.script);
        system.units.set(unitName(label), unit(foreign).split("\n").find((line) => line.startsWith("ExecStart="))!);
        system.active.set(unitName(label), 4343);
      }
      return confirm(question, fallback);
    };
    assert.equal(await uninstall(ctx), 0, ui.text);
    assert.ok(ui.text.includes("? Remove the tailscale"), ui.text);
    assert.ok(system.served.has(10011));
    assert.equal(readFileSync(file, "utf8"), definition);
    assert.ok(!ui.text.includes("tailscale serve --https=10011 off"), ui.text);
  });

  test(`SETUP-1: uninstall on ${os} keeps a mapping whose target belongs elsewhere, including after confirmation`, async () => {
    for (const duringConfirmation of [false, true]) {
      const { system, ui, ctx } = await uninstallFixture(os, `mapping-${os}-${duringConfirmation}`);
      const elsewhere = "http://127.0.0.1:8799";
      if (!duringConfirmation) system.served.set(10011, elsewhere);
      const confirm = ui.confirm.bind(ui);
      ui.confirm = async (question, fallback) => {
        if (question.startsWith("Remove the tailscale")) system.served.set(10011, elsewhere);
        return confirm(question, fallback);
      };
      assert.equal(await uninstall(ctx), 0, ui.text);
      assert.equal(system.served.get(10011), elsewhere);
      assert.ok(!system.calls.some((call) => call.program === "/fake/tailscale" && call.args.at(-1) === "off"));
    }
  });

  test(`SETUP-1: uninstall on ${os} keeps an unreadable mapping and still offers the home choice`, async () => {
    for (const code of [1, 124, 0]) {
      for (const failAt of [1, 2]) {
        const { system, ui, paths, ctx } = await uninstallFixture(os, `mapping-status-${os}-${code}-${failAt}`);
        const run = system.run.bind(system);
        let queries = 0;
        system.run = async (program, args, options) => {
          if (program === "/fake/tailscale" && args.join(" ") === "serve status --json" && ++queries === failAt) {
            system.calls.push({ program, args, options: options ?? {} });
            return { code, stdout: code === 0 ? "{broken" : "", stderr: "tailscaled could not be reached." };
          }
          return run(program, args, options);
        };
        assert.equal(await uninstall(ctx), 0, ui.text);
        assert.ok(system.served.has(10011));
        assert.ok(!existsSync(paths.home));
        assert.ok(!system.calls.some((call) => call.program === "/fake/tailscale" && call.args.at(-1) === "off"));
      }
    }
  });

  test(`F2: setup on ${os} refuses a copied or colliding label before changing its service`, async () => {
    for (const derived of [false, true]) {
      const { system, paths, ctx, label, file } = await uninstallFixture(os, `setup-copy-${os}-${derived}`);
      const copy = pathsFor(join(root, `copy-${os}-${derived}`, basename(paths.home)));
      mkdirSync(copy.home, { recursive: true });
      writeFileSync(copy.config, readFileSync(paths.config));
      if (!derived) writeFileSync(copy.setup, readFileSync(paths.setup));
      const definition = readFileSync(file, "utf8");
      const bridge = await healthCheck();
      writeFileSync(copy.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      const ui = new ScriptedUi();
      const calls = system.calls.length;
      try {
        assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, ui, env: { PORTALS_BRIDGE_HOME: copy.home } }), 1, ui.text);
        assert.match(ui.text, /belongs to another folder/);
        assert.match(ui.text, /unused PORTALS_BRIDGE_LABEL/);
        assert.equal(readFileSync(file, "utf8"), definition);
        assert.ok(os === "macos" ? system.loaded.has(label) : system.active.has(unitName(label)));
        assert.ok(!system.calls.slice(calls).some((call) => call.args[0] === "bootout" || call.args[0] === "bootstrap" || call.args[1] === "restart"));
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`F2: setup on ${os} accepts an explicit unused label instead of a copied saved label`, async () => {
    const { system, paths, ctx, file } = await uninstallFixture(os, `setup-label-${os}`);
    const copy = pathsFor(`${paths.home}-copy`);
    mkdirSync(copy.home);
    writeFileSync(copy.setup, readFileSync(paths.setup));
    const bridge = await healthCheck();
    writeFileSync(copy.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
    const definition = readFileSync(file, "utf8");
    const ui = new ScriptedUi();
    const label = `com.danielou.portals.bridge.copy-${os}`;
    try {
      assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, ui, env: { PORTALS_BRIDGE_HOME: copy.home, PORTALS_BRIDGE_LABEL: label } }), 0, ui.text);
      assert.equal(readFileSync(file, "utf8"), definition);
      assert.equal(readSetupState(copy.setup)!.label, label);
      assert.ok(os === "macos" ? system.loaded.has(label) : system.active.has(unitName(label)));
    } finally {
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  test(`F2: setup on ${os} rechecks service ownership after the install question`, async () => {
    const { system, ui, paths, ctx, spec, file } = await uninstallFixture(os, `setup-changed-${os}`);
    const foreign = { ...spec, script: join(root, "elsewhere", "app", "dist", "main.js") };
    const definition = os === "macos" ? plist(foreign) : unit(foreign);
    const confirm = ui.confirm.bind(ui);
    ui.confirm = async (question, fallback) => {
      if (question.startsWith("Install Portals host")) writeFileSync(file, definition);
      return confirm(question, fallback);
    };
    const bridge = await healthCheck();
    writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
    try {
      assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, ctx), 1, ui.text);
      assert.equal(readFileSync(file, "utf8"), definition);
    } finally {
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  test(`R3: setup on ${os} replaces its own saved service when the label changes`, async () => {
    for (const service of [true, false]) {
      const { system, ui, paths, ctx, label: oldLabel, file } = await uninstallFixture(os, `relabel-${os}-${service}`);
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      const label = `${oldLabel}-new`;
      const calls = system.calls.length;
      try {
        assert.equal(await setup({ service, tailscale: false, claude: "off" }, { ...ctx, env: { ...ctx.env, PORTALS_BRIDGE_LABEL: label } }), 0, ui.text);
        assert.ok(!existsSync(file));
        assert.ok(os === "macos" ? !system.loaded.has(oldLabel) : !system.active.has(unitName(oldLabel)));
        assert.equal(os === "macos" ? system.loaded.has(label) : system.active.has(unitName(label)), service);
        assert.equal(readSetupState(paths.setup)!.label, label);
        assert.ok(ui.text.includes(os === "macos" ? oldLabel : unitName(oldLabel)), ui.text);
        const changed = system.calls.slice(calls);
        const removed = changed.findIndex((call) => call.args[0] === "bootout" || call.args[1] === "disable");
        const installed = changed.findIndex((call) => call.args[0] === "bootstrap" || call.args[1] === "restart");
        assert.ok(removed >= 0 && (!service || installed > removed));
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`R3: setup on ${os} refuses an unverifiable saved service before changing labels`, async () => {
    for (const failure of ["state", "identity", "definition"]) {
      const { system, ui, paths, ctx, label: oldLabel, file } = await uninstallFixture(os, `relabel-unknown-${os}-${failure}`);
      const definition = readFileSync(file, "utf8");
      if (failure === "definition") {
        system.loaded.delete(oldLabel);
        system.active.delete(unitName(oldLabel));
        writeFileSync(file, definition.slice(0, definition.length - 30));
      }
      const saved = readFileSync(file, "utf8");
      const run = system.run.bind(system);
      let prints = 0;
      system.run = async (program, args, options) => {
        const old = os === "macos" ? args[1]?.endsWith(`/${oldLabel}`) : args[2] === unitName(oldLabel);
        const identity = os === "macos" ? old && args[0] === "print" && ++prints === 2 : args.includes("ExecStart");
        if (old && failure !== "definition" && (failure === "state" || identity)) {
          system.calls.push({ program, args, options: options ?? {} });
          return { code: 124, stdout: "", stderr: "The old service cannot be checked." };
        }
        return run(program, args, options);
      };
      const label = `${oldLabel}-new`;
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      try {
        assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, env: { ...ctx.env, PORTALS_BRIDGE_LABEL: label } }), 1, ui.text);
        assert.match(ui.text, /could not be verified/);
        assert.ok(ui.text.includes(os === "macos" ? oldLabel : unitName(oldLabel)), ui.text);
        assert.equal(readFileSync(file, "utf8"), saved);
        assert.equal(readSetupState(paths.setup)!.label, oldLabel);
        assert.ok(os === "macos" ? !system.loaded.has(label) : !system.active.has(unitName(label)));
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`R3: setup on ${os} keeps its old label when replacement is declined or ownership changes`, async () => {
    for (const change of ["decline", "foreign"]) {
      const { system, ui, paths, ctx, label: oldLabel, spec, file } = await uninstallFixture(os, `relabel-confirm-${os}-${change}`);
      const original = readFileSync(file, "utf8");
      const foreign = { ...spec, script: join(root, "another-home", "app", "dist", "main.js") };
      const changed = os === "macos" ? plist(foreign) : unit(foreign);
      const confirm = ui.confirm.bind(ui);
      ui.confirm = async (question, fallback) => {
        if (question.startsWith("Install Portals host")) {
          if (change === "decline") {
            ui.lines.push(`? ${question}`);
            return false;
          }
          writeFileSync(file, changed);
        }
        return confirm(question, fallback);
      };
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      const label = `${oldLabel}-new`;
      try {
        assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, env: { ...ctx.env, PORTALS_BRIDGE_LABEL: label } }), change === "decline" ? 0 : 1, ui.text);
        assert.equal(readSetupState(paths.setup)!.label, oldLabel);
        assert.equal(readFileSync(file, "utf8"), change === "decline" ? original : changed);
        assert.ok(os === "macos" ? system.loaded.has(oldLabel) : system.active.has(unitName(oldLabel)));
        assert.ok(os === "macos" ? !system.loaded.has(label) : !system.active.has(unitName(label)));
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`R3: a copied home on ${os} keeps an unloaded foreign service and names it once`, async () => {
    const { system, paths, ctx, label: oldLabel, file } = await uninstallFixture(os, `relabel-copy-${os}`);
    system.loaded.delete(oldLabel);
    system.active.delete(unitName(oldLabel));
    const copy = pathsFor(`${paths.home}-copy`);
    mkdirSync(copy.home);
    writeFileSync(copy.setup, readFileSync(paths.setup));
    const definition = readFileSync(file, "utf8");
    const bridge = await healthCheck();
    writeFileSync(copy.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
    const ui = new ScriptedUi();
    const label = `${oldLabel}-new`;
    try {
      assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, ui, env: { PORTALS_BRIDGE_HOME: copy.home, PORTALS_BRIDGE_LABEL: label } }), 0, ui.text);
      assert.equal(readFileSync(file, "utf8"), definition);
      const notices = ui.lines.filter((line) => line.includes("belongs to another folder and was left alone"));
      assert.equal(notices.length, 1, ui.text);
      assert.ok(notices[0].includes(file));
      assert.ok(notices[0].includes(os === "macos" ? oldLabel : unitName(oldLabel)));
      assert.equal(readSetupState(copy.setup)!.label, label);
    } finally {
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  test(`R3: setup on ${os} refuses relabeling when the saved job and definition belong to different homes`, async () => {
    for (const changed of ["job", "definition"]) {
      const { system, ui, paths, ctx, label: oldLabel, spec, file } = await uninstallFixture(os, `relabel-mixed-${os}-${changed}`);
      const foreign = { ...spec, script: join(root, "original-home", "app", "dist", "main.js") };
      if (changed === "job") {
        system.scripts.set(oldLabel, foreign.script);
        system.units.set(unitName(oldLabel), unit(foreign).split("\n").find((line) => line.startsWith("ExecStart="))!);
      } else {
        writeFileSync(file, os === "macos" ? plist(foreign) : unit(foreign));
      }
      const definition = readFileSync(file, "utf8");
      const bridge = await healthCheck();
      writeFileSync(paths.config, JSON.stringify({ port: bridge.port, providers: { fake: true } }));
      const label = `${oldLabel}-new`;
      try {
        assert.equal(await setup({ service: true, tailscale: false, claude: "off" }, { ...ctx, env: { ...ctx.env, PORTALS_BRIDGE_LABEL: label } }), 1, ui.text);
        assert.match(ui.text, /could not be verified/);
        assert.equal(readFileSync(file, "utf8"), definition);
        assert.equal(readSetupState(paths.setup)!.label, oldLabel);
        assert.ok(os === "macos" ? system.loaded.has(oldLabel) : system.active.has(unitName(oldLabel)));
        assert.ok(os === "macos" ? !system.loaded.has(label) : !system.active.has(unitName(label)));
      } finally {
        await new Promise<void>((resolve) => bridge.close(() => resolve()));
      }
    }
  });

  test(`F2: uninstall on ${os} keeps a home whose own socket still answers`, async () => {
    const { system, ui, paths, ctx } = await uninstallFixture(os, `socket-${os}`);
    const socket = createSocketServer(() => {});
    mkdirSync(dirname(paths.socket), { recursive: true });
    await new Promise<void>((resolve) => socket.listen(paths.socket, resolve));
    try {
      assert.equal(await uninstall(ctx), 1, ui.text);
      assert.ok(existsSync(paths.config));
      assert.ok(!ui.text.includes("? Also delete"), ui.text);
      assert.match(ui.text, /still running/);
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  test(`F2: uninstall on ${os} keeps a live home when its loaded identity query fails`, async () => {
    for (const code of [1, 124]) {
      const { system, ui, paths, ctx, label, file } = await uninstallFixture(os, `identity-query-${os}-${code}`);
      const run = system.run.bind(system);
      let prints = 0;
      system.run = async (program, args, options) => {
        const identity = (program === "/fake/launchctl" && args[0] === "print" && ++prints === 2)
          || (program === "/fake/systemctl" && args[1] === "show" && args.includes("ExecStart"));
        if (identity) {
          system.calls.push({ program, args, options: options ?? {} });
          return { code, stdout: "", stderr: "The loaded job could not be checked." };
        }
        return run(program, args, options);
      };
      await assert.rejects(uninstall(ctx), /could not be checked|could not be verified/);
      assert.ok(existsSync(paths.config) && existsSync(file));
      assert.ok(os === "macos" ? system.loaded.has(label) : system.active.has(unitName(label)));
      assert.ok(system.served.has(10011));
      assert.ok(!ui.text.includes("? Also delete"), ui.text);
    }
  });

  test(`F3: uninstall on ${os} keeps a localhost mapping with an IPv6-only listener`, async () => {
    const { system, ui, paths, ctx, label, file } = await uninstallFixture(os, `ipv6-${os}`);
    system.loaded.delete(label);
    system.active.delete(unitName(label));
    system.units.delete(unitName(label));
    rmSync(file);
    const listener = createServer((_request, response) => response.end("another bridge"));
    await new Promise<void>((resolve) => listener.listen({ port: 0, host: "::1", ipv6Only: true }, resolve));
    const port = (listener.address() as AddressInfo).port;
    writeFileSync(paths.config, JSON.stringify({ port, providers: { fake: true } }));
    system.served.set(10011, `http://localhost:${port}`);
    try {
      assert.equal(await uninstall(ctx), 0, ui.text);
      assert.ok(system.served.has(10011));
      assert.ok(!ui.text.includes("? Remove the tailscale"), ui.text);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
}

test("SETUP-1: an unreadable loaded LaunchAgent cannot authorize stopping another home's job", async () => {
  for (const code of [1, 124]) {
    const { system, paths, ctx, label, spec, file } = await uninstallFixture("macos", `unreadable-job-${code}`);
    system.scripts.set(label, join(root, "original", "app", "dist", "main.js"));
    const run = system.run.bind(system);
    system.run = async (program, args, options) => {
      if (program === "/fake/launchctl" && args[0] === "print") {
        system.calls.push({ program, args, options: options ?? {} });
        return { code, stdout: "", stderr: "launchctl print could not reach launchd." };
      }
      return run(program, args, options);
    };
    await assert.rejects(uninstall(ctx), /could not confirm|launchctl print failed/);
    assert.ok(system.loaded.has(label));
    assert.equal(readFileSync(file, "utf8"), plist(spec));
    assert.ok(existsSync(paths.config) && system.served.has(10011));
    assert.ok(!system.ran("/fake/launchctl", "bootout"));
  }
});

test("the systemd unit runs the installed bridge with its PATH, folder and log, kept running, stopping its own process only, escaped as systemd reads it", () => {
  const spec = { label: "com.danielou.portals.bridge", node: "/home/dana$lab/n/node", script: '/a "b" 100% $HOME\\x/dist/main.js', workingDirectory: "/a b", path: "/x:/y", log: "/l 1%.log", environment: { PORTALS_BRIDGE_HOME: "/h" } };
  const text = unit(spec);
  // `:` first: systemd puts no variables in the command, so a `$` stays one, in node's path too.
  assert.ok(text.includes('\nExecStart=:"/home/dana$lab/n/node" "/a \\"b\\" 100%% $HOME\\\\x/dist/main.js"\n'), text);
  assert.match(text, /^WorkingDirectory=\/a b$/m);
  assert.match(text, /^Environment="PATH=\/x:\/y"$/m);
  assert.match(text, /^Environment="PORTALS_BRIDGE_HOME=\/h"$/m);
  assert.match(text, /^Restart=always$/m);
  // hermes serve and Codex's daemon outlive a restart, as under launchd.
  assert.match(text, /^KillMode=process$/m);
  assert.match(text, /^StandardOutput=append:\/l 1%%\.log$/m);
  assert.match(text, /^StandardError=append:\/l 1%%\.log$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.throws(() => unit({ ...spec, script: "/a\nb" }), /line break/);
  assert.equal(unitName("com.danielou.portals.bridge"), "portals-host.service");
  assert.equal(unitName("com.danielou.portals.bridge.dev"), "portals-host-dev.service");
  assert.equal(unitName("x.test"), "x.test.service");
  assert.equal(unitName("my label/1"), "my-label-1.service");
});

test("setup on a new Linux computer: a systemd user service, lingering turned on when asked, and tailscale serve once the person is Tailscale's operator; status, update, relay reset and uninstall through systemd", async () => {
  const system = new FakeSystem();
  system.operatorOnly = true;
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "linux-home");
  rmSync(bridgeHome, { recursive: true, force: true });
  const user = userInfo().username;
  const service = "portals-host-linux-home.service";
  const bridge = await healthCheck();
  try {
    const code = await setup({ service: true, tailscale: true, port: bridge.port, claude: "api-key" }, linuxContext(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome, ANTHROPIC_API_KEY: apiKey }, true));
    assert.equal(code, 0, ui.text);
    const paths = pathsFor(bridgeHome);
    const state = readSetupState(paths.setup)!;
    // Its own words: a Linux computer, never a Mac, and nothing a Mac has run.
    assert.match(ui.text, /Sets up Portals host on this Linux computer/);
    assert.match(ui.text, /The iPhone reaches this Linux computer through Tailscale/);
    assert.ok(!ui.text.includes("Mac"), ui.text);
    assert.ok(!system.calls.some((call) => ["/fake/launchctl", "/usr/sbin/scutil", "/usr/bin/osascript", "/usr/bin/open"].includes(call.program)));
    // Refused at first; the person made Tailscale's operator with sudo; then mapped.
    assert.match(ui.text, /Tailscale lets only root, or the user it names its operator, change what it serves/);
    assert.ok(system.ran("/fake/sudo", "/fake/tailscale", "set", `--operator=${user}`));
    assert.equal(system.operator, user);
    assert.equal(system.calls.filter((call) => call.program === "/fake/tailscale" && call.args[1] === "--bg").length, 2);
    assert.equal(state.address, `https://${dnsName}:10011`);
    // The unit, enabled and running, with the bridge's folder named always.
    const text = readFileSync(join(system.unitFolder, service), "utf8");
    assert.ok(text.includes(` "${paths.app}/dist/main.js"\n`), text);
    assert.ok(text.includes(`Environment="PORTALS_BRIDGE_HOME=${bridgeHome}"`), text);
    assert.ok(text.includes(`StandardOutput=append:${state.log}\n`), text);
    assert.ok(system.enabled.has(service) && system.active.has(service));
    assert.ok(ui.lines.includes(`ok Started it. It starts again at login (systemd user service ${service}).`), ui.text);
    // Lingering, asked and turned on.
    assert.match(ui.text, /\? Turn lingering on/);
    assert.ok(system.ran("/fake/loginctl", "enable-linger", user));
    assert.ok(system.linger);
    // Linux's name and log.
    assert.equal(state.name, computerName("linux") || hostname());
    assert.equal(state.log, join(home, ".local", "state", "linux-home.log"));
    // systemd makes no folder for the log it appends to: setup does.
    assert.ok(existsSync(dirname(state.log)));
    assert.ok(ui.lines.some((line) => line.startsWith("portals://pair?")));

    const shown = new ScriptedUi();
    assert.equal(await status(linuxContext(system, shown, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, shown.text);
    assert.match(shown.text, /Running: {2}yes, process 4343, answers on/);

    const updated = new ScriptedUi();
    assert.equal(await update(linuxContext(system, updated, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, updated.text);
    assert.equal(system.calls.filter((call) => call.program === "/fake/systemctl" && call.args[1] === "restart").length, 2);

    // relay reset stops and starts the unit around the change.
    const own = paths.netOwn;
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, JSON.stringify({ token: "t".repeat(43), key: { kty: "OKP" }, relay: { id: "r".repeat(22), secret: "s".repeat(43) } }));
    const reset = new ScriptedUi();
    assert.equal(await relayReset(linuxContext(system, reset, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, reset.text);
    assert.ok(system.ran("/fake/systemctl", "--user", "stop", service));
    assert.ok(system.ran("/fake/systemctl", "--user", "start", service));
    assert.ok(!("relay" in JSON.parse(readFileSync(own, "utf8"))));
    assert.match(reset.text, /Devices reach this Linux computer through the relay again/);
  } finally {
    bridge.close();
  }

  const removed = new ScriptedUi();
  assert.equal(await uninstall(linuxContext(system, removed, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, removed.text);
  assert.match(removed.text, /Stop Portals host and remove its systemd user service\?/);
  assert.ok(system.ran("/fake/systemctl", "--user", "disable", "--now", service));
  assert.ok(!existsSync(join(system.unitFolder, service)));
  assert.ok(!system.active.has(service) && !system.enabled.has(service));
  assert.ok(removed.lines.includes(`ok Stopped. systemd user service ${service} removed.`), removed.text);
  assert.ok(!system.served.has(10011));
});

test("on a Linux computer with nobody to ask, setup says how to turn lingering on and how to make the operator; without the person's systemd manager, it stops before installing", async (t) => {
  const system = new FakeSystem();
  system.operatorOnly = true;
  const ui = new ScriptedUi();
  const user = userInfo().username;
  const bridgeHome = join(root, "linux-quiet");
  const bridge = await healthCheck();
  t.after(() => bridge.close());
  assert.equal(await setup({ service: true, tailscale: true, port: bridge.port, claude: "off" }, linuxContext(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  assert.ok(ui.lines.includes(`! tailscale serve was refused. Run: sudo tailscale set --operator=${user}\nThen run setup again.`), ui.text);
  assert.ok(!system.calls.some((call) => call.program === "/fake/sudo"));
  assert.equal(readSetupState(join(root, "linux-quiet", "setup.json"))!.address, null);
  assert.ok(ui.lines.includes(`To keep it running without you logged in: sudo loginctl enable-linger ${user}`), ui.text);
  assert.ok(!system.ran("/fake/loginctl", "enable-linger", user));
  // Lingering on already: said so, nothing asked.
  const lingering = new FakeSystem();
  lingering.linger = true;
  const quiet = new ScriptedUi();
  assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off", address: "https://box.example.ts.net:443" }, linuxContext(lingering, quiet, { PORTALS_BRIDGE_HOME: join(root, "linux-lingering") }, true)), 0, quiet.text);
  assert.match(quiet.text, /lingering is on for you/);
  assert.ok(!quiet.text.includes("? Turn lingering on"), quiet.text);
  // Without polkit, the person may not: asked again, it is turned on with sudo.
  const noPolkit = new FakeSystem();
  noPolkit.lingerWorks = false;
  const asked = new ScriptedUi();
  assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off", address: "https://box.example.ts.net:443" }, linuxContext(noPolkit, asked, { PORTALS_BRIDGE_HOME: join(root, "linux-sudo") }, true)), 0, asked.text);
  assert.match(asked.text, /\? That needs root here\. Run sudo loginctl enable-linger/);
  assert.ok(noPolkit.ran("/fake/sudo", "/fake/loginctl", "enable-linger", user));
  assert.ok(noPolkit.linger);
  assert.match(asked.text, /ok Lingering is on/);

  const none = new FakeSystem();
  none.systemdReachable = false;
  const stopped = new ScriptedUi();
  const noneHome = join(root, "linux-none");
  assert.equal(await setup({ service: true, tailscale: false, port: 39130, claude: "off", address: "https://box.example.ts.net:443" }, linuxContext(none, stopped, { PORTALS_BRIDGE_HOME: noneHome })), 1, stopped.text);
  assert.match(stopped.text, /systemd's user services can't be reached/);
  // Said first: nothing written, mapped or installed.
  assert.ok(!existsSync(pathsFor(noneHome).config) && !existsSync(pathsFor(noneHome).app));
  assert.ok(!none.calls.some((call) => (call.program === "/fake/systemctl" && call.args[1] !== "show-environment") || call.program === "/fake/tailscale"));
  // Nor removed while it may still run.
  const removing = new ScriptedUi();
  await assert.rejects(uninstall(linuxContext(none, removing, { PORTALS_BRIDGE_HOME: bridgeHome })), /user manager can't be reached/);
});

test("without an API key and without questions, Claude Code is off and setup says how to turn it on", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "no-key");
  assert.equal(await setup({ service: false, tailscale: false, port: 39121, address: "https://mac.example.ts.net:443" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.equal(config.providers.claude, false);
  assert.equal(config.claude.apiKey, null);
  assert.ok(config.allowedHosts.includes("mac.example.ts.net"));
  assert.match(ui.text, /set ANTHROPIC_API_KEY or pass --claude=login/);
  assert.ok(!system.calls.some((call) => call.program === "/fake/launchctl"));
  assert.ok(!system.calls.some((call) => call.program === "/fake/tailscale"));
  assert.equal(readSetupState(pathsFor(bridgeHome).setup)!.address, "https://mac.example.ts.net:443");
});

test("own Claude login is a choice, with a note on how to use an API key instead", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "login");
  assert.equal(await setup({ service: false, tailscale: false, port: 39122, claude: "login" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.equal(config.providers.claude, true);
  assert.equal(config.claude.apiKey, null);
  assert.match(ui.text, /To use an API key instead \(what Anthropic's terms cover most clearly\): npx portals-host setup --claude=api-key/);
  assert.match(ui.text, /not signed in\. Run claude once/);
  // No address, so no code: setup says what is missing.
  assert.match(ui.text, /no address the iPhone can reach yet/);
});

test("choosing the own Claude login drops a token from claude setup-token kept in config.json", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "login-over-token");
  const paths = pathsFor(bridgeHome);
  mkdirSync(bridgeHome, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ port: 39136, providers: { fake: true }, claude: { oauthToken: "stand-in-setup-token" } }));
  const kept = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false }, context(system, kept, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, kept.text);
  assert.match(kept.text, /uses the token in config\.json/);
  const ui = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false, claude: "login" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  assert.equal(config.providers.claude, true);
  assert.equal(config.claude.apiKey, null);
  assert.equal(config.claude.oauthToken, null);
});

test("a password set by hand is kept when nobody can be asked, and Claude Code turned off stays off", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "by-hand");
  mkdirSync(bridgeHome, { recursive: true });
  const auth = { username: "dana", passwordHash: "scrypt$16384$8$1$c2FsdA==$a2V5" };
  writeFileSync(join(bridgeHome, "config.json"), JSON.stringify({ port: 39124, auth, providers: { claude: false, codex: true } }));
  assert.equal(await setup({ service: false, tailscale: false, address: "https://mac.example.ts.net:10010" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.deepEqual(config.auth, auth);
  assert.equal(config.providers.claude, false);
  assert.ok(!existsSync(pathsFor(bridgeHome).password));
  assert.match(ui.text, /Keeping it\. Sign in as dana/);
  assert.match(ui.text, /no password setup made, so there is no pairing code/);
});

test("Pi found on a new Mac is on with its path and a line that it does not ask, its folder is on the LaunchAgent's PATH, and status lists it", async () => {
  const system = new FakeSystem();
  system.pi = dummyPi();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "with-pi");
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    const paths = pathsFor(bridgeHome);
    const config = JSON.parse(readFileSync(paths.config, "utf8"));
    assert.deepEqual(config.providers, { claude: false, codex: true, pi: true, cursor: false, droid: false, hermes: true, fake: false });
    assert.deepEqual(config.pi, { path: system.pi, idleMinutes: 15, maxWarm: 6, model: null });
    assert.ok(ui.lines.includes(`ok Pi 1.1.0 at ${system.pi}`));
    assert.ok(ui.lines.includes("Pi runs commands and edits files without asking first, from the phone as at the desk."));
    assert.ok(!ui.text.includes("Pi is off on this host"));

    // A LaunchAgent gets no terminal's PATH, and `pi` is a script run by the `node` on it.
    const plistText = readFileSync(join(home, "Library", "LaunchAgents", `${readSetupState(paths.setup)!.label}.plist`), "utf8");
    const path = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(plistText)![1].split(":");
    assert.deepEqual(path.slice(0, 3), [join(home, ".local", "bin"), join(home, "bin"), dirname(system.pi)]);

    const shown = new ScriptedUi();
    assert.equal(await status(context(system, shown, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, shown.text);
    // (Hermes too, on a Mac that has it where its installer puts it.)
    assert.ok(shown.lines.some((line) => /^Agents:   Codex, Pi(, Hermes)?$/.test(line)), shown.text);
  } finally {
    bridge.close();
  }
});

test("setup again: a config.json from before Pi was an agent gets it turned on where it is found, and one that turned it off is asked", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "older");
  mkdirSync(bridgeHome, { recursive: true });
  const configPath = join(bridgeHome, "config.json");
  writeFileSync(configPath, JSON.stringify({ port: 39125, providers: { claude: false, codex: true, hermes: true, fake: false } }));
  const again = async (answers: Record<string, boolean> = {}) => {
    const ui = new ScriptedUi(answers);
    assert.equal(await setup({ service: false, tailscale: false, address: "https://mac.example.ts.net:10010" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    return { ui, config: JSON.parse(readFileSync(configPath, "utf8")) };
  };

  // Not installed: config.json still says nothing of Pi, so a later setup can turn it on.
  const without = await again();
  assert.deepEqual(without.config.providers, { claude: false, codex: true, hermes: true, fake: false });
  assert.equal("pi" in without.config, false);

  system.pi = dummyPi();
  const found = await again();
  assert.equal(found.config.providers.pi, true);
  assert.deepEqual(found.config.pi, { path: system.pi });
  assert.ok(!found.ui.text.includes("Pi is off on this host"));
  assert.match(found.ui.text, /Pi runs commands and edits files without asking first/);

  // Turned off since: asked, and left off when nobody answers.
  writeFileSync(configPath, JSON.stringify({ ...found.config, providers: { ...found.config.providers, pi: false } }));
  const asked = await again();
  assert.ok(asked.ui.lines.includes("? Pi is off on this host. Turn it on?"));
  assert.equal(asked.config.providers.pi, false);
  assert.ok(!asked.ui.text.includes("without asking first"));
  assert.equal((await again({ "Pi is off on this host": true })).config.providers.pi, true);
});

test("Pi is looked for on PATH, then beside the node setup runs under and where Homebrew's npm puts it", async () => {
  const system = new FakeSystem();
  assert.deepEqual(piFolders(), [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"]);
  assert.deepEqual(await findPi(system, []), { path: null, version: null, signedIn: null });
  // Not on PATH (a terminal that has not loaded nvm, say), but beside a node.
  const beside = dummyPi();
  assert.deepEqual(await findPi(system, [join(home, "nothing-here"), dirname(beside)]), { path: beside, version: "1.1.0", signedIn: null });
  // The one on PATH comes first.
  system.pi = join(home, "bin", "pi");
  writeFileSync(system.pi, "#!/bin/sh\nexit 1\n");
  chmodSync(system.pi, 0o755);
  assert.equal((await findPi(system, [dirname(beside)])).path, system.pi);
  // It is asked for its version, and nothing else.
  assert.deepEqual(system.calls.map((call) => [call.program, ...call.args]), [[beside, "--version"], [system.pi, "--version"]]);
});

test("Cursor is found when it is installed: reported, written to config.json, on the LaunchAgent's PATH and in status", async () => {
  const system = new FakeSystem();
  const program = installCursor(system);
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "with-cursor");
  const env = { PORTALS_BRIDGE_HOME: bridgeHome };
  const path = pathsFor(bridgeHome).config;
  const bridge = await healthCheck();
  try {
    const options = { service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions;
    assert.equal(await setup(options, context(system, ui, env)), 0, ui.text);
    assert.ok(ui.lines.includes(`ok Cursor 2026.10.01 at ${program}, signed in`), ui.text);
    // What `cursor-agent status` printed is read for whether it is signed in, and never shown.
    assert.ok(!ui.text.includes("dana@example.com"));
    const config = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(config.providers, { claude: false, codex: true, pi: false, cursor: true, droid: false, hermes: true, fake: false });
    assert.deepEqual(config.cursor, { path: program, idleMinutes: 15 });
    // A LaunchAgent does not get a terminal's PATH: the program's folder is put on it.
    const plistText = readFileSync(join(home, "Library", "LaunchAgents", "com.danielou.portals.bridge.with-cursor.plist"), "utf8");
    const launchPath = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(plistText)?.[1].split(":") ?? [];
    assert.ok(launchPath.includes(join(home, "tools")), plistText);

    const listed = new ScriptedUi();
    assert.equal(await status(context(system, listed, env)), 0, listed.text);
    // (Hermes is among them on a Mac that has it.)
    assert.match(listed.text, /Agents: +Codex, Cursor(, Hermes)?\n/);

    // Not signed in: setup says what to run.
    system.cursorStatus = "Not logged in\n";
    const signedOut = new ScriptedUi();
    assert.equal(await setup(options, context(system, signedOut, env)), 0, signedOut.text);
    assert.ok(signedOut.lines.includes(`! Cursor 2026.10.01 at ${program} is not signed in. Run: cursor-agent login`), signedOut.text);
    // A status that says neither (another release's words): nothing is claimed of the sign-in.
    system.cursorStatus = "All good.\n";
    const unsure = new ScriptedUi();
    assert.equal(await setup(options, context(system, unsure, env)), 0, unsure.text);
    assert.ok(unsure.lines.includes(`ok Cursor 2026.10.01 at ${program}`), unsure.text);
    system.cursorStatus = signedInToCursor;

    // Turned off in config.json: it stays off unless setup is told to turn it on, as for Codex.
    writeFileSync(path, JSON.stringify({ ...config, providers: { ...config.providers, cursor: false } }));
    const kept = new ScriptedUi();
    assert.equal(await setup(options, context(system, kept, env)), 0, kept.text);
    assert.ok(kept.lines.includes("? Cursor is off on this host. Turn it on?"), kept.text);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.cursor, false);
    const off = new ScriptedUi();
    await status(context(system, off, env));
    assert.match(off.text, /Agents: +Codex(, Hermes)?\n/);
    const turnedOn = new ScriptedUi({ "Cursor is off": true });
    assert.equal(await setup(options, context(system, turnedOn, env)), 0, turnedOn.text);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.cursor, true);

    // The program has gone since (uninstalled): the bridge offers none, and status lists none.
    rmSync(program);
    const gone = new ScriptedUi();
    await status(context(system, gone, env));
    assert.match(gone.text, /Agents: +Codex(, Hermes)?\n/);
    // Setup says so, since config.json asks for it.
    const missing = new ScriptedUi();
    assert.equal(await setup(options, context(system, missing, env)), 0, missing.text);
    assert.ok(missing.lines.includes("! Cursor: not found. Install it with: curl https://cursor.com/install -fsS | bash"), missing.text);
  } finally {
    bridge.close();
  }
});

test("status says when a later version is out, as the bridge last heard from npm's registry, while it asks", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "with-update");
  const env = { PORTALS_BRIDGE_HOME: bridgeHome };
  const paths = pathsFor(bridgeHome);
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" }, context(system, ui, env)), 0, ui.text);
    const shown = async () => {
      const said = new ScriptedUi();
      assert.equal(await status(context(system, said, env)), 0, said.text);
      return said.lines.filter((line) => line.startsWith("Update:"));
    };
    // Never asked yet, or nothing later than 9.9.9 (the package installed).
    assert.deepEqual(await shown(), []);
    mkdirSync(paths.state, { recursive: true });
    // A file that is no such object says nothing, and stops nothing.
    writeFileSync(paths.update, "null");
    assert.deepEqual(await shown(), []);
    writeFileSync(paths.update, JSON.stringify({ checked: new Date().toISOString(), latest: "9.9.9" }));
    assert.deepEqual(await shown(), []);
    writeFileSync(paths.update, JSON.stringify({ checked: new Date().toISOString(), latest: "10.0.0" }));
    assert.deepEqual(await shown(), ["Update:   version 10.0.0 is out. Run: npx portals-host@latest update"]);
    // With the check turned off, what it found before is not said.
    const config = JSON.parse(readFileSync(paths.config, "utf8"));
    writeFileSync(paths.config, JSON.stringify({ ...config, updates: { check: false } }));
    assert.deepEqual(await shown(), []);
  } finally {
    bridge.close();
  }
});

test("whether Cursor is signed in is read from what its status prints, and left open when that says neither", async () => {
  const program = installCursor(new FakeSystem());
  const found = (said: string, code = 0, version = "2026.10.01-e373342\n") =>
    findCursor({
      uid: 501,
      which: () => program,
      run: async (_program, args) => (args[0] === "--version" ? { code: version === "" ? 127 : 0, stdout: version, stderr: "" } : { code, stdout: said, stderr: "" }),
    });
  assert.deepEqual(await found(signedInToCursor), { path: program, version: "2026.10.01", signedIn: true });
  assert.equal((await found("\u001b[32m✓\u001b[39m Logged in as user id 12\n")).signedIn, true);
  assert.equal((await found("Login successful!\n")).signedIn, true);
  // Whatever the exit code is then.
  assert.equal((await found("\u001b[31mNot logged in\u001b[39m\n")).signedIn, false);
  assert.equal((await found("Not logged in\n", 1)).signedIn, false);
  assert.equal((await found("Partially authenticated (missing refresh token)\n")).signedIn, false);
  // Nothing printed (it took too long, say), other words, or the words from a status that failed.
  assert.equal((await found("", 124)).signedIn, null);
  assert.equal((await found("Status: fine\n")).signedIn, null);
  assert.equal((await found("Logged in as dana@example.com\n", 1)).signedIn, null);
  // A program that does not say its version is still found.
  assert.deepEqual(await found(signedInToCursor, 0, ""), { path: program, version: null, signedIn: true });
  assert.deepEqual(await findCursor({ uid: 501, which: () => null, run: async () => ({ code: 127, stdout: "", stderr: "" }) }), { path: null, version: null, signedIn: null });
});

test("Cursor alone is an agent to run; a bridge set up before it could run Cursor hears nothing of one that is not there", async () => {
  // Neither Claude Code nor Codex on this Mac.
  rmSync(join(home, ".local", "bin", "claude"));
  rmSync(join(home, "bin", "codex"));
  const none = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false, port: 39127 }, context(new FakeSystem(), none, { PORTALS_BRIDGE_HOME: join(root, "no-agent") })), 1);
  assert.match(none.text, /There is no agent for Portals host to run\. Install Claude Code, Codex, Pi, Cursor, Droid or Hermes, then run setup again\./);

  const system = new FakeSystem();
  const program = installCursor(system);
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "only-cursor");
  assert.equal(await setup({ service: false, tailscale: false, port: 39128, address: "https://mac.example.ts.net:443" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.deepEqual(config.providers, { claude: false, codex: false, pi: false, cursor: true, droid: false, hermes: true, fake: false });
  assert.equal(config.cursor.path, program);

  // A config.json from before: no word of Cursor in it. Without the program nothing is said or written of it.
  const before = join(root, "before-cursor");
  mkdirSync(before, { recursive: true });
  writeFileSync(join(before, "config.json"), JSON.stringify({ port: 39129, providers: { claude: false, codex: false, fake: true } }));
  const old = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false, address: "https://mac.example.ts.net:443" }, context(new FakeSystem(), old, { PORTALS_BRIDGE_HOME: before })), 0, old.text);
  assert.ok(!old.text.includes("Cursor"), old.text);
  const kept = JSON.parse(readFileSync(join(before, "config.json"), "utf8"));
  assert.deepEqual(kept.providers, { claude: false, codex: false, fake: true });
  assert.equal(kept.cursor, undefined);
  // With it, the bridge offers Cursor from then on, and setup writes where it is.
  const found = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false, address: "https://mac.example.ts.net:443" }, context(system, found, { PORTALS_BRIDGE_HOME: before })), 0, found.text);
  assert.ok(found.lines.includes(`ok Cursor 2026.10.01 at ${program}, signed in`), found.text);
  const now = JSON.parse(readFileSync(join(before, "config.json"), "utf8"));
  assert.deepEqual(now.providers, { claude: false, codex: false, fake: true });
  assert.deepEqual(now.cursor, { path: program });
});

test("Droid discovery only probes the installed version, with automatic updates disabled", async () => {
  const system = new FakeSystem();
  assert.deepEqual(await findDroid(system), { path: null, version: null, signedIn: null });
  const program = join(home, "bin", "droid");
  writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.droid = program;
  assert.deepEqual(await findDroid(system), { path: program, version: "0.236.0", signedIn: null });
  assert.equal(system.calls.length, 1);
  assert.deepEqual(system.calls[0].args, ["--version"]);
  assert.equal(system.calls[0].options.env?.FACTORY_DROID_AUTO_UPDATE_ENABLED, "false");
  assert.equal(system.calls[0].options.timeoutMs, 20_000);
  system.droidVersionCode = 124;
  assert.deepEqual(await findDroid(system), { path: program, version: null, signedIn: null });
  const configured = join(home, "custom-droid");
  writeFileSync(configured, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal((await findDroid(system, "~/custom-droid")).path, configured);
  assert.equal((await findDroid(system, "droid")).path, program);
});

test("Droid setup enables a detected CLI, adds its folder to PATH, and status requires enablement and installation", async () => {
  const system = new FakeSystem();
  const program = join(home, "droid-tools", "droid");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.droid = program;
  const bridgeHome = join(root, "with-droid");
  const env = { PORTALS_BRIDGE_HOME: bridgeHome };
  const bridge = await healthCheck();
  const path = pathsFor(bridgeHome).config;
  try {
    const options = { service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions;
    const ui = new ScriptedUi();
    assert.equal(await setup(options, context(system, ui, env)), 0, ui.text);
    const config = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(config.providers.droid, true);
    assert.deepEqual(config.droid, { path: program, idleMinutes: 15, maxWarm: 6 });
    assert.match(ui.text, /Droid 0\.236\.0 at/);
    assert.match(ui.text, /run droid in a terminal and use \/login/);
    const plistText = readFileSync(join(home, "Library", "LaunchAgents", `${readSetupState(pathsFor(bridgeHome).setup)!.label}.plist`), "utf8");
    assert.ok(plistText.includes(dirname(program)));
    const shown = new ScriptedUi();
    assert.equal(await status(context(system, shown, env)), 0);
    assert.match(shown.text, /Agents: +Codex, Droid/);
    writeFileSync(path, JSON.stringify({ ...config, providers: { ...config.providers, droid: false } }));
    const off = new ScriptedUi();
    assert.equal(await setup(options, context(system, off, env)), 0, off.text);
    assert.match(off.text, /Droid is off on this host\. Turn it on\?/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.droid, false);
    const hidden = new ScriptedUi();
    await status(context(system, hidden, env));
    assert.doesNotMatch(hidden.text, /Agents:.*Droid/);
    const on = new ScriptedUi({ "Droid is off": true });
    assert.equal(await setup(options, context(system, on, env)), 0, on.text);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.droid, true);
    rmSync(program);
    const gone = new ScriptedUi();
    await status(context(system, gone, env));
    assert.doesNotMatch(gone.text, /Agents:.*Droid/);
    const missing = new ScriptedUi();
    assert.equal(await setup(options, context(system, missing, env)), 0, missing.text);
    assert.match(missing.text, /Droid: not found/);
    assert.ok(system.calls.filter((call) => basename(call.program) === "droid").every((call) => call.args.join(" ") === "--version"));
  } finally {
    bridge.close();
  }
});

test("setup preserves old installations without Droid, enables it when found later, and accepts Droid alone", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "before-droid");
  mkdirSync(bridgeHome);
  const path = pathsFor(bridgeHome).config;
  writeFileSync(path, JSON.stringify({ port: 39130, providers: { claude: false, codex: true }, custom: "kept" }));
  const options = { service: false, tailscale: false };
  const env = { PORTALS_BRIDGE_HOME: bridgeHome };
  assert.equal(await setup(options, context(system, new ScriptedUi(), env)), 0);
  let config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.providers.droid, undefined);
  assert.equal(config.droid, undefined);
  const program = join(home, "bin", "droid");
  writeFileSync(program, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.droid = program;
  assert.equal(await setup(options, context(system, new ScriptedUi(), env)), 0);
  config = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(config.providers.droid, true);
  assert.deepEqual(config.droid, { path: program });
  assert.equal(config.custom, "kept");
  rmSync(join(home, ".local", "bin", "claude"));
  rmSync(join(home, "bin", "codex"));
  const only = new ScriptedUi();
  assert.equal(await setup({ ...options, port: 39131 }, context(system, only, { PORTALS_BRIDGE_HOME: join(root, "only-droid") })), 0, only.text);
  const alone = JSON.parse(readFileSync(pathsFor(join(root, "only-droid")).config, "utf8"));
  assert.equal(alone.providers.droid, true);
  assert.equal(alone.providers.claude, false);
  assert.equal(alone.providers.codex, false);
});

test("Tailscale not connected: setup says so and makes no mapping", async () => {
  const system = new FakeSystem();
  system.tailscaleRunning = false;
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "offline");
  assert.equal(await setup({ service: false, tailscale: true, port: 39123, claude: "off" }, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
  assert.match(ui.text, /Tailscale is not connected/);
  assert.ok(!system.calls.some((call) => call.args[0] === "serve" && call.args[1] === "--bg"));
});

test("with someone at the terminal, setup waits for Tailscale to connect and checks again", async () => {
  const system = new FakeSystem();
  system.tailscaleRunning = false;
  const ui = new ScriptedUi();
  const confirm = ui.confirm.bind(ui);
  // The person opens Tailscale and signs in, then answers that it is done.
  ui.confirm = async (question, fallback) => {
    if (question.includes("Check again")) system.tailscaleRunning = true;
    return confirm(question, fallback);
  };
  const bridgeHome = join(root, "waits-for-tailscale");
  assert.equal(await setup({ service: false, tailscale: true, port: 39132, claude: "off" }, { ...context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome }), interactive: true }), 0, ui.text);
  assert.match(ui.text, /Tailscale is not connected\. Open it and sign in\./);
  assert.ok(!ui.text.includes("Then run setup again"), ui.text);
  assert.ok(system.calls.some((call) => call.args[0] === "serve" && call.args[1] === "--bg"));
  assert.equal(readSetupState(pathsFor(bridgeHome).setup)!.address, `https://${dnsName}:10011`);
});

test("signed in to Claude, setup offers the own login first, and takes it without questions", async () => {
  const system = new FakeSystem();
  system.claudeSignedIn = true;
  const asked = new ScriptedUi();
  const bridgeHome = join(root, "own-login-default");
  assert.equal(await setup({ service: false, tailscale: false, port: 39133 }, { ...context(system, asked, { PORTALS_BRIDGE_HOME: bridgeHome, ANTHROPIC_API_KEY: apiKey }), interactive: true }), 0, asked.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.equal(config.providers.claude, true);
  assert.equal(config.claude.apiKey, null);
  assert.match(asked.text, /Claude Code uses your own login/);

  const quiet = new ScriptedUi();
  const quietHome = join(root, "own-login-quiet");
  assert.equal(await setup({ service: false, tailscale: false, port: 39134 }, context(system, quiet, { PORTALS_BRIDGE_HOME: quietHome, ANTHROPIC_API_KEY: apiKey })), 0, quiet.text);
  const quietConfig = JSON.parse(readFileSync(pathsFor(quietHome).config, "utf8"));
  assert.equal(quietConfig.providers.claude, true);
  assert.equal(quietConfig.claude.apiKey, null);
});

test("not signed in to Claude, with a key in the terminal, setup offers the key first", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "key-default");
  assert.equal(await setup({ service: false, tailscale: false, port: 39135 }, { ...context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome, ANTHROPIC_API_KEY: apiKey }), interactive: true }), 0, ui.text);
  const config = JSON.parse(readFileSync(pathsFor(bridgeHome).config, "utf8"));
  assert.equal(config.providers.claude, true);
  assert.equal(config.claude.apiKey, apiKey);
});

test("setup asks Claude Code whether it is signed in without the terminal's API key, as the bridge runs it", async () => {
  const system = new FakeSystem();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = apiKey;
  try {
    await findClaude(system);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
  const status = system.calls.find((call) => basename(call.program) === "claude" && call.args[0] === "auth")!;
  assert.ok(status.options.env, "auth status runs with an environment of its own");
  assert.equal(status.options.env.ANTHROPIC_API_KEY, undefined);
});

test("with Portals on this Mac too, setup offers to add this Mac to it, and pair does again", async () => {
  const system = new FakeSystem();
  system.portalsApp = "/Applications/Portals.app";
  const ui = new ScriptedUi();
  const bridgeHome = join(root, "portals-here");
  const env = { PORTALS_BRIDGE_HOME: bridgeHome };
  assert.equal(await setup({ service: false, tailscale: false, port: 39136, address: "https://mac.example.ts.net:10010", claude: "off" }, { ...context(system, ui, env), interactive: true }), 0, ui.text);
  const link = ui.lines.find((line) => line.startsWith("portals://pair?"))!;
  assert.ok(ui.text.includes("? Portals is on this Mac too. Add this Mac to it now?"), ui.text);
  assert.ok(system.ran("/usr/bin/open", link));
  assert.match(ui.text, /Opened Portals with this Mac filled in/);

  const paired = new ScriptedUi();
  assert.equal(await pair({ ...context(system, paired, env), interactive: true }), 0, paired.text);
  assert.equal(system.calls.filter((call) => call.program === "/usr/bin/open").length, 2);

  // Declined, or with nobody to ask, nothing opens.
  const declined = new ScriptedUi({ "Add this Mac to it now?": false });
  assert.equal(await pair({ ...context(system, declined, env), interactive: true }), 0, declined.text);
  const quiet = new ScriptedUi();
  assert.equal(await pair(context(system, quiet, env)), 0, quiet.text);
  assert.equal(system.calls.filter((call) => call.program === "/usr/bin/open").length, 2);
  assert.ok(!quiet.text.includes("Portals is on this Mac too"));
});

test("without Portals on this Mac, setup only shows the code", async () => {
  const system = new FakeSystem();
  const ui = new ScriptedUi();
  assert.equal(await setup({ service: false, tailscale: false, port: 39137, address: "https://mac.example.ts.net:10010", claude: "off" }, { ...context(system, ui, { PORTALS_BRIDGE_HOME: join(root, "no-portals-here") }), interactive: true }), 0, ui.text);
  assert.ok(!ui.text.includes("Portals is on this Mac too"), ui.text);
  assert.ok(!system.calls.some((call) => call.program === "/usr/bin/open"));
  assert.match(ui.text, /Done\. Scan the code with your iPhone's Camera to add this Mac\./);
});

test("an install from before the rename is moved to the new names, threads and password included", async () => {
  const system = new FakeSystem();
  const support = join(home, "Library", "Application Support");
  const old = join(support, "aeriportal-bridge");
  mkdirSync(join(old, "state"), { recursive: true });
  mkdirSync(join(old, "app", "src"), { recursive: true });
  const bridge = await healthCheck();
  writeFileSync(join(old, "config.json"), JSON.stringify({ port: bridge.port, auth: null, allowedHosts: ["127.0.0.1", dnsName], generalFolder: "~/Portals", providers: { claude: true, codex: true } }));
  writeFileSync(join(old, "state", "threads.json"), '{"threads":{"t1":{}}}');
  const plistFolder = join(home, "Library", "LaunchAgents");
  mkdirSync(plistFolder, { recursive: true });
  writeFileSync(join(plistFolder, `${oldLabel}.plist`), "<plist/>");
  system.loaded.set(oldLabel, 999);
  system.served.set(10012, `http://127.0.0.1:${bridge.port}`);

  const ui = new ScriptedUi();
  try {
    assert.equal(await setup({ service: true, tailscale: true }, context(system, ui)), 0, ui.text);
  } finally {
    bridge.close();
  }
  const moved = join(support, "portals-bridge");
  assert.ok(!existsSync(old));
  assert.equal(readFileSync(join(moved, "state", "threads.json"), "utf8"), '{"threads":{"t1":{}}}');
  assert.ok(!system.loaded.has(oldLabel));
  assert.ok(!existsSync(join(plistFolder, `${oldLabel}.plist`)));
  assert.ok(system.loaded.has("com.danielou.portals.bridge"));
  assert.ok(existsSync(join(plistFolder, "com.danielou.portals.bridge.plist")));
  // The mapping that reached the old bridge is kept, and is not setup's to remove.
  const state = readSetupState(join(moved, "setup.json"))!;
  assert.equal(state.address, `https://${dnsName}:10012`);
  assert.equal(state.servePort, null);
  assert.equal(state.log, join(home, "Library", "Logs", "portals-bridge.log"));
  // The old config had no password setup could show, so it made one.
  assert.match(readFileSync(join(moved, "password.txt"), "utf8"), /^[A-Za-z0-9_-]{32}$/);
});

test("a move that fails starts the old LaunchAgent again and leaves everything in place", async () => {
  const system = new FakeSystem();
  const old = join(root, "old-bridge");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "config.json"), "{}");
  const plistFolder = join(root, "agents");
  mkdirSync(plistFolder, { recursive: true });
  writeFileSync(join(plistFolder, `${oldLabel}.plist`), "<plist/>");
  system.loaded.set(oldLabel, 999);
  await assert.rejects(moveOldInstall(system, old, join(root, "missing", "parent", "portals-bridge"), { plistFolder }));
  assert.ok(existsSync(join(old, "config.json")));
  assert.ok(existsSync(join(plistFolder, `${oldLabel}.plist`)));
  assert.ok(system.loaded.has(oldLabel));
});

test("setup again while the bridge runs waits for it to stop before loading it again", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "again");
  const bridge = await healthCheck();
  try {
    const options = { service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions;
    assert.equal(await setup(options, context(system, new ScriptedUi(), { PORTALS_BRIDGE_HOME: bridgeHome })), 0);
    system.stopsAfter = 2;
    const ui = new ScriptedUi();
    assert.equal(await setup(options, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    assert.ok(system.loaded.has("com.danielou.portals.bridge.again"));
  } finally {
    bridge.close();
  }
});

test("a LaunchAgent switched off with launchctl disable is switched on by setup", async () => {
  const system = new FakeSystem();
  system.disabled.add("com.danielou.portals.bridge.off");
  const bridgeHome = join(root, "off");
  const ui = new ScriptedUi();
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions, context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    assert.ok(system.ran("/fake/launchctl", "enable", "gui/501/com.danielou.portals.bridge.off"));
    assert.ok(system.loaded.has("com.danielou.portals.bridge.off"));
  } finally {
    bridge.close();
  }
});

test("update installs the new version and restarts the LaunchAgent", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "update");
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions, context(system, new ScriptedUi(), { PORTALS_BRIDGE_HOME: bridgeHome })), 0);
    const ui = new ScriptedUi();
    assert.equal(await update(context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    assert.ok(system.ran("/fake/launchctl", "kickstart", "-k", "gui/501/com.danielou.portals.bridge.update"));
    assert.match(ui.text, /Installed version 9\.9\.9/);
  } finally {
    bridge.close();
  }
});

test("relay reset takes the relay id out of net-own.json and its .bak, keeping the token and key, and restarts a bridge its LaunchAgent runs around it (net-19)", async () => {
  const system = new FakeSystem();
  const bridgeHome = join(root, "reset");
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions, context(system, new ScriptedUi(), { PORTALS_BRIDGE_HOME: bridgeHome })), 0);
    const own = pathsFor(bridgeHome).netOwn;
    const relay = { id: "r".repeat(22), secret: "s".repeat(43) };
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, JSON.stringify({ token: "t".repeat(43), key: { kty: "OKP" }, relay }));
    writeFileSync(`${own}.bak`, JSON.stringify({ token: "t".repeat(43), key: { kty: "OKP" }, relay }));
    // The file is changed only while the bridge is stopped: it has the relay id at the
    // bootout, and none at the bootstrap.
    const hasRelay = () => "relay" in JSON.parse(readFileSync(own, "utf8"));
    const seen: string[] = [];
    const run = system.run.bind(system);
    system.run = async (program, args, options) => {
      if (args[0] === "bootout" || args[0] === "bootstrap") seen.push(`${args[0]} ${hasRelay() ? "with" : "without"}`);
      return run(program, args, options);
    };
    const ui = new ScriptedUi();
    assert.equal(await relayReset(context(system, ui, { PORTALS_BRIDGE_HOME: bridgeHome })), 0, ui.text);
    assert.deepEqual(seen, ["bootout with", "bootstrap without"]);
    for (const file of [own, `${own}.bak`]) assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { token: "t".repeat(43), key: { kty: "OKP" } });
    assert.ok(system.ran("/fake/launchctl", "bootout", "gui/501/com.danielou.portals.bridge.reset"));
    assert.ok(system.loaded.has("com.danielou.portals.bridge.reset"));
    assert.match(ui.text, /Started with a new relay id/);
    // Its plist on disk another folder's (a setup of a copy stopped halfway): not stopped,
    // since it could not be started again from it.
    const plistPath = join(home, "Library", "LaunchAgents", "com.danielou.portals.bridge.reset.plist");
    const plistText = readFileSync(plistPath, "utf8");
    writeFileSync(own, JSON.stringify({ token: "t".repeat(43), relay }));
    writeFileSync(plistPath, plistText.split(pathsFor(bridgeHome).app).join(join(root, "elsewhere", "app")));
    const elsewhere = new ScriptedUi();
    const before = system.calls.length;
    assert.equal(await relayReset(context(system, elsewhere, { PORTALS_BRIDGE_HOME: bridgeHome })), 1, elsewhere.text);
    assert.match(elsewhere.text, /its plist .* is now another folder's or not whole/);
    assert.ok(!system.calls.slice(before).some((call) => call.args[0] === "bootout" || call.args[0] === "bootstrap"));
    assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).relay, relay);
    // Cut short after the script: not whole, so not stopped either.
    writeFileSync(plistPath, plistText.slice(0, plistText.indexOf("</array>")));
    assert.equal(await relayReset(context(system, new ScriptedUi(), { PORTALS_BRIDGE_HOME: bridgeHome })), 1);
    assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).relay, relay);
    writeFileSync(plistPath, plistText);
    // What runs it changes while the question is open (another folder's setup takes the
    // label): looked at again, and nothing is done.
    const changing = new ScriptedUi();
    changing.confirm = async (question: string) => {
      changing.lines.push(`? ${question}`);
      writeFileSync(plistPath, plistText.split(pathsFor(bridgeHome).app).join(join(root, "elsewhere", "app")));
      return true;
    };
    const asked = system.calls.length;
    assert.equal(await relayReset(context(system, changing, { PORTALS_BRIDGE_HOME: bridgeHome })), 1, changing.text);
    assert.match(changing.text, /changed while you were asked/);
    assert.ok(!system.calls.slice(asked).some((call) => call.args[0] === "bootout" || call.args[0] === "bootstrap"));
    assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).relay, relay);
    writeFileSync(plistPath, plistText);
    // Said no to: nothing changes.
    writeFileSync(own, JSON.stringify({ token: "t".repeat(43), relay }));
    assert.equal(await relayReset(context(system, new ScriptedUi({ "new relay id": false }), { PORTALS_BRIDGE_HOME: bridgeHome })), 1);
    assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).relay, relay);
  } finally {
    bridge.close();
  }
});

test("relay reset on a copied folder leaves the LaunchAgent of the bridge it was copied from alone, and does not reset a bridge running from it some other way", async () => {
  const system = new FakeSystem();
  const original = join(root, "original");
  const bridge = await healthCheck();
  try {
    assert.equal(await setup({ service: true, tailscale: false, port: bridge.port, claude: "off" } satisfies SetupOptions, context(system, new ScriptedUi(), { PORTALS_BRIDGE_HOME: original })), 0);
    // The copy, with the original's setup.json (its label) and relay id, under the same
    // name in another place, so that its own label would be the original's too; short, for
    // its socket's path.
    const copyParent = mkdtempSync(join(tmpdir(), "prc-"));
    const copy = join(copyParent, "original");
    mkdirSync(copy);
    try {
      writeFileSync(join(copy, "setup.json"), readFileSync(pathsFor(original).setup));
      writeFileSync(join(copy, "config.json"), readFileSync(pathsFor(original).config));
      const own = pathsFor(copy).netOwn;
      mkdirSync(dirname(own), { recursive: true });
      const relay = { id: "r".repeat(22), secret: "s".repeat(43) };
      writeFileSync(own, JSON.stringify({ token: "t".repeat(43), relay }));
      // Running by hand: its socket answers, so nothing is changed.
      const listening = createSocketServer(() => {});
      await new Promise<void>((resolve) => listening.listen(pathsFor(copy).socket, resolve));
      const busy = new ScriptedUi();
      try {
        assert.equal(await relayReset(context(system, busy, { PORTALS_BRIDGE_HOME: copy })), 1, busy.text);
      } finally {
        await new Promise<void>((resolve) => listening.close(() => resolve()));
      }
      assert.match(busy.text, /is running, and not from its LaunchAgent/);
      assert.deepEqual(JSON.parse(readFileSync(own, "utf8")).relay, relay);
      // A setup of the copy stopped halfway left its plist under the shared label while
      // launchd still runs the original's: the loaded job decides, not the plist on disk.
      const plistPath = join(home, "Library", "LaunchAgents", "com.danielou.portals.bridge.original.plist");
      writeFileSync(plistPath, readFileSync(plistPath, "utf8").split(pathsFor(original).app).join(pathsFor(copy).app));
      // Stopped: reset, and the original's LaunchAgent is neither stopped nor started.
      const calls = system.calls.length;
      const ui = new ScriptedUi();
      assert.equal(await relayReset(context(system, ui, { PORTALS_BRIDGE_HOME: copy })), 0, ui.text);
      assert.deepEqual(JSON.parse(readFileSync(own, "utf8")), { token: "t".repeat(43) });
      assert.ok(!system.calls.slice(calls).some((call) => call.program === "/fake/launchctl" && call.args[0] !== "print"), JSON.stringify(system.calls.slice(calls)));
      assert.ok(system.loaded.has("com.danielou.portals.bridge.original"));
      assert.match(ui.text, /makes a new relay id when it starts/);
    } finally {
      rmSync(copyParent, { recursive: true, force: true });
    }
    // A bridge with no net-own.json yet has nothing to reset.
    const fresh = new ScriptedUi();
    assert.equal(await relayReset(context(system, fresh, { PORTALS_BRIDGE_HOME: join(root, "never") })), 0);
    assert.match(fresh.text, /has no relay id yet/);
  } finally {
    bridge.close();
  }
});

test("Droid inside the Factory app is found when the CLI is installed nowhere else, and a CLI installed on its own comes first, on PATH or off it (2026-10-30; Codex's review)", async () => {
  const system = new FakeSystem();
  const inApp = join(home, "Applications", "Factory.app", "Contents", "Resources", "bin", "droid");
  mkdirSync(dirname(inApp), { recursive: true });
  writeFileSync(inApp, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.appDroids = () => [join(home, "nowhere", "droid"), inApp];
  system.standaloneDroids = () => [join(home, "nowhere", "brew", "droid")];
  assert.equal((await findDroid(system)).path, inApp);
  // A CLI installed off PATH, in Homebrew's folder say, still comes before the app's.
  const brewed = join(home, "brew-bin", "droid");
  mkdirSync(dirname(brewed), { recursive: true });
  writeFileSync(brewed, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.standaloneDroids = () => [brewed];
  assert.equal((await findDroid(system)).path, brewed);
  // And one on PATH before both.
  const cli = join(home, "cli-bin", "droid");
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  system.droid = cli;
  assert.equal((await findDroid(system)).path, cli);
  // At run time the same order: PATH, then a CLI off PATH, then the app's own. Every place is
  // given here, so no droid of the machine running the test is found.
  const nowhere = { PATH: join(home, "nowhere") };
  assert.equal(droidProgram("~/.local/bin/droid", nowhere, [inApp], []), inApp);
  assert.equal(droidProgram("~/.local/bin/droid", nowhere, [inApp], [brewed]), brewed);
  assert.equal(droidProgram("~/.local/bin/droid", { PATH: dirname(cli) }, [inApp], [brewed]), cli);
  // Only a Mac has the app.
  assert.deepEqual(factoryAppDroids("/Users/someone", "linux"), []);
  assert.deepEqual(factoryAppDroids("/Users/someone", "darwin"), [
    "/Applications/Factory.app/Contents/Resources/bin/droid",
    "/Users/someone/Applications/Factory.app/Contents/Resources/bin/droid",
  ]);
});
