// Real Claude provider/session/gateway. Only the external SDK query is stood in.
// Its permission control waits on an owned marker so UI sends can race its reply.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";
import { ClaudeProvider } from "../../../bridge/src/providers/claude/provider.ts";
import { FakeFiles, FakeQuery, play } from "../../../bridge/test/claude-fixtures.ts";

const root = "/private/tmp/n19-existing-mode-ui.noindex";
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "fixture-"));
const cwd = join(home, "work");
mkdirSync(cwd);
const audit = join(home, "mode.jsonl");
const hold = join(home, "hold-mode");
writeFileSync(audit, "", { mode: 0o600 });
const record = (row: object) => appendFileSync(audit, JSON.stringify(row) + "\n");
const provider = new ClaudeProvider({
  settings: { path: "/nonexistent/claude", idleMinutes: 15, maxWarm: 6, apiKey: null, folder: cwd },
  files: new FakeFiles(),
  env: { PATH: "/usr/bin", HOME: home, CLAUDE_CODE_ENTRYPOINT: "cli" },
  managedSettings: join(home, "managed-settings.json"),
  agents: async () => [],
  query: (input, options) => {
    const query = new FakeQuery(input, options);
    let effective = options.permissionMode ?? "default";
    const setMode = query.setPermissionMode.bind(query);
    query.setPermissionMode = async (mode) => {
      record({ event: "mode_pending", mode });
      while (mode === "default" && existsSync(hold)) await new Promise((done) => setTimeout(done, 20));
      await setMode(mode);
      effective = mode;
      record({ event: "mode_applied", mode });
    };
    query.onMessage = (message) => {
      record({ event: "native_input", mode: effective, text: message.message.content });
      void play(query, "plain", { from: query.received.length - 1 }).then(
        () => record({ event: "turn_finished" }),
        (error: unknown) => { record({ event: "play_failed", error: String(error) }); query.end(); },
      );
    };
    return query;
  },
});
const username = "mode-fixture";
const password = randomBytes(24).toString("base64url");
writeFileSync(join(home, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: Number(process.env.PORTALS_N19_MODE_PORT ?? 18493),
  auth: { username, passwordHash: await hashPassword(password) },
  allowedHosts: ["127.0.0.1", "localhost", "::1"], generalFolder: cwd,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: false },
  relay: { enabled: false }, push: { relay: null, dryRun: join(home, "push.jsonl") },
  updates: { check: false }, fleet: { tellStarters: false },
}), { mode: 0o600 });
const bridge = await startBridge({ home, providers: new Map([["claude", provider]]), temporaryFolders: [] });
writeFileSync(join(root, "plan.json"), JSON.stringify({
  hosts: JSON.stringify([{ name: "Mode fixture", url: bridge.url, user: username, password }]),
  cwd, audit, hold,
}), { mode: 0o600 });
console.log(`Existing-mode fixture ready on ${bridge.url}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    if (existsSync(hold)) unlinkSync(hold);
    void bridge.close().then(() => process.exit(0));
  });
}
