// Isolated real bridge/net for PairingFieldsUITests. No installed agents, real host
// configuration, relay, updates or push delivery are used.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "../../../bridge/src/bridge.ts";
import { pathsFor } from "../../../bridge/src/config.ts";
import { hashPassword } from "../../../bridge/src/http/auth.ts";

const root = "/private/tmp/n19-pairing-fields-ui.noindex";
mkdirSync(root, { recursive: true });
const home = mkdtempSync(join(root, "fixture-"));
const cwd = join(home, "work");
mkdirSync(cwd);
const username = "edited-pairing-user";
const password = randomBytes(24).toString("base64url");
writeFileSync(join(home, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: Number(process.env.PORTALS_N19_PAIRING_PORT ?? 18495),
  auth: { username, passwordHash: await hashPassword(password) },
  allowedHosts: ["127.0.0.1", "localhost", "::1"], generalFolder: cwd,
  providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: false },
  relay: { enabled: false }, push: { relay: null, dryRun: join(home, "push.jsonl") },
  updates: { check: false }, fleet: { name: "Edited pairing fixture", tellStarters: false },
}), { mode: 0o600 });
const bridge = await startBridge({ home, providers: new Map(), temporaryFolders: [] });
const original = {
  address: "http://127.0.0.1:18494", username: "original-user", password: "old-synthetic",
};
const query = new URLSearchParams({ v: "1", url: original.address, user: original.username, password: original.password, name: "Original fixture" });
writeFileSync(join(root, "plan.json"), JSON.stringify({
  link: `portals://pair?${query}`, original, address: bridge.url, username, password,
  members: pathsFor(home).net,
}), { mode: 0o600 });
console.log(`Pairing fields fixture ready on ${bridge.url}`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void bridge.close().then(() => process.exit(0)); });
}
