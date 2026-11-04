// Deterministic fixture for FileUndoUITests; never starts a real agent.
// node scripts/phone-bench/uitest/file-undo-bridge.mts <plan.json> <bundle-identifier> [output-folder]
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Prompt, Provider, SessionOptions, SessionSink, StoredMessage } from "../../../bridge/src/providers/types.ts";
import { startTestBridge, TestClient } from "../../../bridge/test/helpers.ts";

if (!process.argv[2] || !process.argv[3]) throw new Error("Pass a plan.json output path and the installed app bundle identifier.");
delete process.env.PORTALS_THREAD;
const planPath = resolve(process.argv[2]);
mkdirSync(dirname(planPath), { recursive: true });
const root = mkdtempSync(join(dirname(planPath), "file-undo-"));
const histories = new Map<string, StoredMessage[]>(), files = new Map<string, string>();
const restored = new Set<string>(), ambiguous = new Set<string>();
let source = "", run = "", cwd = "", file = "", baseline: StoredMessage[] = [];
let calls: unknown[] = [], rewinds: unknown[] = [];

const provider: Provider = {
  profile: { name: "claude", kind: "claude", displayName: "UI test agent", description: "Deterministic stand-in", model: "test", provider: "test" },
  models: async () => ({ providers: [{ slug: "test", name: "Test", models: ["test"] }], model: "test", provider: "test", reasoning: "low" }),
  startSession: async (settings, sink) => session(settings, sink),
  resumeSession: async (settings, sink) => session(settings, sink),
};

function session(settings: SessionOptions, sink: SessionSink) {
  if (!histories.has(settings.id)) histories.set(settings.id, [
    { role: "user", text: "Refine the welcome screen.", timestamp: Date.now() / 1000,
      checkpoint: { id: "latest", can_fork: false, can_edit: false, can_undo_files: true } },
    { role: "assistant", text: "Updated the feature file.", timestamp: Date.now() / 1000 },
  ]);
  return {
    history: async () => structuredClone(histories.get(settings.id)!), settings: () => settings.settings,
    startTurn(prompt: Prompt) {
      calls.push({ id: settings.id, text: prompt.text });
      sink.emit({ type: "turn.end", status: "error", error: "This fixture does not accept model prompts." });
    },
    interrupt: async () => false, setModel: async () => ({ deferred: false }), setReasoning: async () => {}, close: async () => {},
    async rewindFiles(checkpoint: string, dryRun: boolean) {
      const path = files.get(settings.id);
      if (!path || checkpoint !== "latest") throw new Error("Unknown fixture file checkpoint.");
      rewinds.push({ id: settings.id, checkpoint, dryRun });
      if (dryRun) return { canRewind: true, filesChanged: restored.has(settings.id) ? [] : [path], insertions: 3, deletions: 2 };
      if (restored.has(settings.id)) throw new Error("Duplicate actual restore.");
      restored.add(settings.id);
      writeFileSync(path, ambiguous.has(settings.id) ? "partial\n" : "before\n");
      for (const message of histories.get(settings.id)!) {
        if (message.role === "user" && message.checkpoint) message.checkpoint = { ...message.checkpoint, can_undo_files: false };
      }
      if (ambiguous.has(settings.id)) throw new Error("Stand-in connection lost during restore.");
      return { canRewind: true, skippedLinks: 0 };
    },
  };
}

const bridge = await startTestBridge({ providers: new Map([["claude", provider]]), temporaryFolders: [], userHome: root,
  config: { host: "127.0.0.1", generalFolder: root, providers: { claude: false, fake: false, hermes: false }, relay: { enabled: false } },
});
const client = await TestClient.open(bridge, { capabilities: { session_resync: true } });
function fixture() {
  return { url: bridge.url, cwd, source, title: "Welcome screen", hostID: `undo-${run}`, prompt: "Refine the welcome screen." };
}
async function reset(kind: string) {
  if (kind !== "undo" && kind !== "ambiguous") throw new Error("Unknown file-undo scenario.");
  run = randomUUID(); calls = []; rewinds = [];
  cwd = join(root, run, "Welcome"); file = join(cwd, "Sources", "feature.txt");
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "after\n");
  await client.call("folders.add", { path: cwd });
  source = (await client.call("session.create", { profile: "claude", source: "tui", cwd })).session_id;
  await client.call("session.rename", { session_id: source, title: "Welcome screen" });
  files.set(source, file);
  if (kind === "ambiguous") ambiguous.add(source);
  baseline = structuredClone(histories.get(source)!);
  return fixture();
}
async function state() {
  return { ...fixture(), calls, rewinds, baseline, content: readFileSync(file, "utf8"),
    snapshot: await client.call("session.resume", { session_id: source }),
  };
}
const control = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://localhost");
    let result: unknown;
    if (url.pathname === "/reset") result = await reset(url.searchParams.get("kind") ?? "undo");
    else {
      if (url.pathname === "/mutate") writeFileSync(file, "manual change after preview\n");
      result = await state();
    }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
writeFileSync(planPath, JSON.stringify({ fixture: "file-undo", control: controlURL, bundleIdentifier: process.argv[3],
  ...(process.argv[4] ? { output: resolve(process.argv[4]) } : {}),
}));
console.log(`File undo fixture ready; plan: ${planPath}`);
async function close() {
  control.close(); await client.close(); await bridge.dispose(); rmSync(root, { recursive: true, force: true });
  try { if (JSON.parse(readFileSync(planPath, "utf8")).control === controlURL) rmSync(planPath); } catch {}
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close(); });
