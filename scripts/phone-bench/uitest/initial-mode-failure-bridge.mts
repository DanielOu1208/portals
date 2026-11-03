// Scratch-only APP2 fixture. Real Codex provider and daemon protocol; only the native
// daemon is played. The explicit fault is a mode RPC rejected before its application.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";
import { socketConnector } from "../../../bridge/src/providers/codex/client.ts";
import { CodexProvider } from "../../../bridge/src/providers/codex/provider.ts";
import type { CodexSession } from "../../../bridge/src/providers/codex/session.ts";
import type { SessionOptions, SessionSink, ThreadMode } from "../../../bridge/src/providers/types.ts";
import { FakeDaemon } from "../../../bridge/test/codex-daemon.ts";

const home = mkdtempSync(join(tmpdir(), "portals-mode-failure-"));
const cwd = join(home, "work");
mkdirSync(cwd);
const audit = join(home, "mode.jsonl");
const failure = join(home, "fail-mode");
writeFileSync(audit, "", { mode: 0o600 });
const record = (row: object) => appendFileSync(audit, JSON.stringify(row) + "\n");
const daemon = await FakeDaemon.start();
daemon.scripts.push("plain");

class FaultedCodex extends CodexProvider {
  override async startSession(options: SessionOptions, sink: SessionSink): Promise<CodexSession> {
    const session = await super.startSession(options, sink);
    const setMode = session.setMode.bind(session);
    session.setMode = async (mode: ThreadMode) => {
      const failed = existsSync(failure);
      record({ event: "mode_requested", mode, failed, thread: options.id });
      if (failed) throw new Error("Injected mode RPC failure before application");
      await setMode(mode);
    };
    const startTurn = session.startTurn.bind(session);
    session.startTurn = (prompt) => {
      record({ event: "send_requested", mode: session.mode().mode, thread: options.id, text: prompt.text });
      startTurn(prompt);
    };
    return session;
  }
}

const provider = new FaultedCodex({
  settings: { mode: "shared", path: "/nonexistent/codex", socket: daemon.socketPath, imagesDir: join(home, "images") },
  connect: socketConnector(daemon.socketPath), checkVersion: false,
  configPath: join(daemon.folder, "config.toml"), backoff: [0.05, 0.1],
});
let seen = 0;
const observe = setInterval(() => {
  for (const call of daemon.calls.slice(seen)) {
    if (call.method !== "turn/start") continue;
    const native = daemon.threads.get(call.params.threadId);
    record({ event: "native_turn", thread: call.params.threadId,
      approval: native?.approvalPolicy, sandbox: native?.sandbox });
  }
  seen = daemon.calls.length;
}, 20);
const username = "mode-fixture";
const password = randomBytes(24).toString("base64url");
writeFileSync(join(home, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: Number(process.env.PORTALS_N19_MODE_PORT ?? 18492),
  auth: { username, passwordHash: await hashPassword(password) },
  allowedHosts: ["127.0.0.1", "localhost", "::1"], generalFolder: cwd,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: false },
  relay: { enabled: false }, push: { relay: null, dryRun: join(home, "push.jsonl") },
  updates: { check: false }, fleet: { tellStarters: false },
}), { mode: 0o600 });
const bridge = await startBridge({ home, providers: new Map([["codex", provider]]), temporaryFolders: [] });
const plan = process.env.PORTALS_N19_MODE_PLAN ?? "/private/tmp/n19-app-mode-failure-ui.json";
writeFileSync(plan, JSON.stringify({
  hosts: JSON.stringify([{ name: "Mode fixture", url: bridge.url, user: username, password }]),
  cwd, audit, failure,
}), { mode: 0o600 });
console.log(`Mode failure fixture ready on ${bridge.url}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    clearInterval(observe);
    void bridge.close().then(() => daemon.close()).then(() => process.exit(0));
  });
}
