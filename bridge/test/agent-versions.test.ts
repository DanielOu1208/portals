import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { testedClaudeVersion } from "../src/providers/claude/options.ts";
import type { RpcMessage, Transport, TransportHandlers } from "../src/providers/codex/client.ts";
import { testedCodexVersion } from "../src/providers/codex/options.ts";
import { CodexProvider } from "../src/providers/codex/provider.ts";
import { DroidProvider } from "../src/providers/droid/provider.ts";
import { HermesHost, testedHermesVersion } from "../src/providers/hermes/provider.ts";
import type { Provider } from "../src/providers/types.ts";
import { fakeClaude } from "./claude-fixtures.ts";
import { FakeHermes } from "./hermes-serve.ts";
import { startTestBridge, TestClient } from "./helpers.ts";

// Which release of each agent runs, as the bridge learns it and `/status` shows it: from
// `--version` at start, and from what a running process says of itself where it does
// (Claude Code's `system/init`, Codex's `initialize`). Stand-ins all: a script that
// prints a version, a played Claude stream, a connection that answers `initialize`.
// Pi and Cursor, which ask `--version` again as they go, are in their own tests.

let folder: string;

before(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-versions-")));
});

after(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A program whose `--version` prints what the file beside it holds. */
function program(name: string, says: string): { path: string; says(text: string): void } {
  const path = join(folder, name);
  const said = `${path}.version`;
  writeFileSync(said, `${says}\n`);
  writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] || exit 9\ncat '${said}'\n`);
  chmodSync(path, 0o755);
  return { path, says: (text) => writeFileSync(said, `${text}\n`) };
}

test("/status names the Claude Code a thread's process says it is, newer than tested or not", async () => {
  const { provider, queries } = fakeClaude();
  const cwd = mkdtempSync(join(folder, "claude-"));
  const bridge = await startTestBridge({ providers: new Map([["claude", provider]]), config: { generalFolder: cwd } });
  const client = await TestClient.open(bridge);
  try {
    const session = (await client.call("session.create", { profile: "claude", source: "tui", cwd })).session_id;
    // The program at the provider's path does not run: so `--version` says, until a process says otherwise.
    await until(() => provider.version.current() !== null);
    const status = async () => (await client.call("slash.exec", { session_id: session, command: "status" })).output as string;
    assert.match(await status(), /^Agent: claude\nVersion: Claude Code was not found or did not run at \/nonexistent\/claude\. Set claude\.path in config\.json\.\nFolder: /);

    await client.call("prompt.submit", { session_id: session, text: "Hello.", profile: "claude" });
    await until(() => queries.some((query) => query.received.length > 0 && query.options.persistSession !== false));
    const query = queries.find((query) => query.received.length > 0 && query.options.persistSession !== false)!;
    query.emit({ type: "system", subtype: "init", model: "claude-version-test", permissionMode: "bypassPermissions", claude_code_version: "2.1.320", session_id: session });
    await until(() => provider.version.current()?.version === "2.1.320");
    assert.match(await status(), new RegExp(`^Agent: claude\\nVersion: Claude Code 2\\.1\\.320, newer than the ${testedClaudeVersion.replaceAll(".", "\\.")} Portals was tested with\\n`));
    assert.equal(provider.version.current()?.running, true);

    // Another process, on the tested release.
    query.emit({ type: "system", subtype: "init", model: "claude-version-test", permissionMode: "bypassPermissions", claude_code_version: testedClaudeVersion, session_id: session });
    await until(() => provider.version.current()?.version === testedClaudeVersion);
    assert.match(await status(), new RegExp(`^Agent: claude\\nVersion: Claude Code ${testedClaudeVersion.replaceAll(".", "\\.")}\\nFolder: `));
  } finally {
    await client.close();
    await bridge.dispose();
  }
});

/** A Codex app server that answers `initialize` with `userAgent()`, and every other call with an error. */
function codexServer(userAgent: () => string): { connect: (handlers: TransportHandlers) => Promise<Transport>; drop(): void } {
  let open: TransportHandlers | null = null;
  return {
    connect: async (handlers) => {
      open = handlers;
      return {
        send: (message: RpcMessage) => {
          if (typeof message.id !== "number") return;
          const answer = message.method === "initialize"
            ? { id: message.id, result: { userAgent: userAgent(), codexHome: "/Users/dev/.codex", platformFamily: "unix", platformOs: "macos" } }
            : { id: message.id, error: { code: -32601, message: `not in this stand-in: ${message.method}` } };
          queueMicrotask(() => handlers.message(answer as RpcMessage));
        },
        close: () => undefined,
      };
    },
    drop: () => open?.closed("dropped by the test"),
  };
}

test("Codex's release is the one the app server names at each connect, over what `codex --version` says", async () => {
  const codex = program("codex", "codex-cli 0.167.0");
  let agent = `portals-bridge/${testedCodexVersion} (Mac OS 27.0.0; arm64) xterm-256color (portals-bridge; 0.3.2)`;
  const server = codexServer(() => agent);
  const provider = new CodexProvider({
    settings: { mode: "shared", path: codex.path, socket: join(folder, "codex.sock"), imagesDir: join(folder, "codex-images") },
    connect: server.connect,
    configPath: join(folder, "config.toml"),
    backoff: [0.01],
  });
  try {
    provider.start();
    await until(() => provider.version.current()?.running === true);
    // The shared daemon still runs the release before the one installed.
    assert.equal(provider.version.statusLine(), `Version: Codex ${testedCodexVersion}`);
    // Restarted on the update: the next connect says so.
    agent = "portals-bridge/0.168.0 (Mac OS 27.0.0; arm64) xterm-256color (portals-bridge; 0.3.2)";
    server.drop();
    await until(() => provider.version.current()?.version === "0.168.0");
    assert.equal(provider.version.statusLine(), `Version: Codex 0.168.0, newer than the ${testedCodexVersion} Portals was tested with`);
  } finally {
    await provider.close();
  }
});

test("Droid's release is what `droid --version` says at start, 1.3.0 among the tested", async () => {
  const droid = program("droid", "1.3.0");
  const start = async () => {
    const directory = mkdtempSync(join(folder, "droid-"));
    const provider = new DroidProvider({ command: droid.path, directory, idleMs: 100, maxWarm: 1, sdk: { models: async () => [] } as never, env: { ...process.env, HOME: directory } });
    provider.start();
    await until(() => provider.version.current() !== null);
    await provider.close();
    return provider.version.statusLine();
  };
  assert.equal(await start(), "Version: Droid 1.3.0");
  droid.says("1.1.0");
  assert.equal(await start(), "Version: Droid 1.1.0, not one Portals was tested with (the newest it was is 1.3.0)");
  droid.says("1.4.0");
  assert.equal(await start(), "Version: Droid 1.4.0, newer than the 1.3.0 Portals was tested with");
});

test("every Hermes profile's /status names the Hermes installed, a build past the tested release as newer", async () => {
  const hermesProgram = program("hermes", `Hermes Agent v${testedHermesVersion} (2026.10.30)`);
  const hermes = await FakeHermes.start();
  const cwd = mkdtempSync(join(folder, "hermes-"));
  const agents = new Map<string, Provider>();
  const host = new HermesHost({
    settings: { path: hermesProgram.path, start: false, folder: cwd, logPath: join(cwd, "hermes-serve.log") },
    cachePath: join(cwd, "hermes.json"),
    connect: hermes.connector(),
    backoff: [0.05, 0.1],
    oneThread: false,
  });
  host.addTo(agents);
  const bridge = await startTestBridge({ providers: agents, config: { generalFolder: cwd } });
  const client = await TestClient.open(bridge);
  try {
    await until(() => host.version.current() !== null);
    const session = (await client.call("session.create", { profile: "hermes", source: "tui", cwd })).session_id;
    const status = (await client.call("slash.exec", { session_id: session, command: "status" })).output as string;
    assert.match(status, new RegExp(`^Agent: hermes\\nVersion: Hermes ${testedHermesVersion.replaceAll(".", "\\.")}\\nFolder: `));
    for (const provider of agents.values()) assert.equal(provider.version, host.version);
  } finally {
    await client.close();
    await bridge.dispose();
    await hermes.close();
  }

  // A build some commits past the release, as a checkout of Hermes says it.
  hermesProgram.says(`Hermes Agent v${testedHermesVersion}+12.g1a2b3c4 (2026.11.01)`);
  const later = new HermesHost({
    settings: { path: hermesProgram.path, start: false, folder: cwd, logPath: join(cwd, "hermes-serve.log") },
    cachePath: join(cwd, "hermes.json"),
    connect: async () => { throw new Error("no Hermes in this test"); },
    backoff: [60],
  });
  try {
    later.start();
    await until(() => later.version.current() !== null);
    assert.equal(later.version.statusLine(), `Version: Hermes ${testedHermesVersion}+12.g1a2b3c4, newer than the ${testedHermesVersion} Portals was tested with`);
  } finally {
    later.close();
  }
});
