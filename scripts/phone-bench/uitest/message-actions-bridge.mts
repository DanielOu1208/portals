// Opt-in deterministic fixture for MessageActionsUITests. No real provider is started.
// node scripts/phone-bench/uitest/message-actions-bridge.mts <plan.json> <bundle-identifier> [output-folder]
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Prompt, Provider, SessionOptions, SessionSink, StoredMessage } from "../../../bridge/src/providers/types.ts";
import { startTestBridge, TestClient } from "../../../bridge/test/helpers.ts";

if (!process.argv[2] || !process.argv[3]) throw new Error("Pass a plan.json output path and the installed app bundle identifier.");
delete process.env.PORTALS_THREAD;
const planPath = resolve(process.argv[2]);
mkdirSync(dirname(planPath), { recursive: true });
const root = mkdtempSync(join(dirname(planPath), "message-actions-"));
const cwd = join(root, "Welcome");
mkdirSync(cwd);
const image = join(root, "reference.png"), attachment = join(root, "notes.txt");
writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABVUlEQVR4nO3aQQ2AMBQFwapACYrwxh0FaMMC6YGE7ST/Pm32+sZ2XtO3H/f0cb9xx2ofXs0VOO4KHHcFjrsCx12B467AcVfguCtw3BU47gocdwWOuwLHXYHjrsBxV+C4K3DcFTjuChx3xx8fzX1/AsddgeOuwHFX4LgrcNwVOO4KHHcFjrsCx12B467AcVfguCtw3BU47gocdwWOuwLHXYHjrsBx1+gu7gocdwWOuwLHXYHjrsBxV+C4K3DcFTjuChx3BY67AsddgeOuwHFX4LgrcNwVOO4KHHcFjrsCx12ju7grcNwVOO4KHHcFjrsCx12B467AcVfguCtw3BU47gocdwWOuwLHXYHjrsBxV+C4K3DcFTjuChx3je7irsBxV+C4K3DcFTjuChx3BY67AsddgeOuwHFX4LgrcNwVOO4KHHcFjrsCx12B467AcVfguCtw3H0AgNnVvCQpbmsAAAAASUVORK5CYII=", "base64"));
writeFileSync(attachment, "A real test attachment.\n");
const histories = new Map<string, StoredMessage[]>(), options = new Map<string, SessionOptions>();
let appOriginated = false, source = "", run = "", baseline: StoredMessage[] = [];
let calls: any[] = [], forks: any[] = [];
let heldFork: Promise<void> | undefined, releaseFork: (() => void) | undefined;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const provider: Provider = {
  profile: { name: "claude", kind: "claude", displayName: "UI test agent", description: "Deterministic stand-in", model: "test", provider: "test" },
  models: async () => ({ providers: [{ slug: "test", name: "Test", models: ["test"] }], model: "test", provider: "test", reasoning: "low" }),
  startSession: async (settings, sink) => session(settings, sink),
  resumeSession: async (settings, sink) => session(settings, sink),
  async forkAt(id, checkpoint, before, expectedCwd) {
    if (expectedCwd !== options.get(id)?.cwd) throw new Error("Unexpected fork folder.");
    const pending: any = { id, checkpoint, before, expectedCwd, waiting: !!heldFork };
    forks.push(pending);
    if (heldFork) await heldFork;
    const history = histories.get(id)!;
    const at = history.findIndex((row) => row.role === "user" && row.checkpoint?.id === checkpoint);
    if (at < 0) throw new Error("Unknown fixture checkpoint.");
    const next = history.findIndex((row, index) => index > at && row.role === "user");
    const newID = randomUUID();
    const prefix = structuredClone(history.slice(0, before ? at : next < 0 ? undefined : next));
    histories.set(newID, prefix);
    Object.assign(pending, { newID, prefix: structuredClone(prefix), waiting: false });
    return { id: newID, cwd: expectedCwd, title: "Welcome screen", settings: options.get(id)!.settings };
  },
};
function session(settings: SessionOptions, sink: SessionSink) {
  options.set(settings.id, settings);
  const stamp = Date.now() / 1000;
  if (!histories.has(settings.id)) histories.set(settings.id, appOriginated ? [] : [
    { role: "user", text: "Update the welcome message.", timestamp: stamp, checkpoint: { id: "first", can_fork: true, can_edit: true } },
    { role: "assistant", text: "Updated the welcome message.", timestamp: stamp },
    { role: "user", text: "Adjust the footer spacing.", timestamp: stamp, checkpoint: { id: "later", can_fork: true, can_edit: true } },
    { role: "assistant", text: "Adjusted the footer spacing.", timestamp: stamp },
  ]);
  return {
    history: async () => structuredClone(histories.get(settings.id)!), settings: () => settings.settings,
    startTurn(prompt: Prompt) {
      calls.push({ id: settings.id, text: prompt.text,
        images: prompt.images.map((item) => ({ filename: item.filename, sha256: hash(item.data), bytes: item.data.length })),
        files: (prompt.files ?? []).map((path) => { const bytes = readFileSync(path); return { filename: basename(path), sha256: hash(bytes), bytes: bytes.length }; }),
      });
      const history = histories.get(settings.id)!;
      const checkpoint = { id: history.length === 0 ? "first" : "sent", can_fork: true, can_edit: true };
      history.push({ role: "user", text: [prompt.text, ...prompt.images.map((item) => `@image:${item.filename}`)].join("\n"), timestamp: Date.now() / 1000, checkpoint });
      setImmediate(() => {
        history.push({ role: "assistant", text: "Stand-in reply", timestamp: Date.now() / 1000 });
        sink.emit({ type: "text", text: "Stand-in reply" }); sink.emit({ type: "checkpoint", checkpoint }); sink.emit({ type: "turn.end", status: "complete" });
      });
    },
    interrupt: async () => false, setModel: async () => ({ deferred: false }), setReasoning: async () => {}, close: async () => {},
  };
}
const bridge = await startTestBridge({ providers: new Map([["claude", provider]]), temporaryFolders: [], userHome: root,
  config: { host: "127.0.0.1", generalFolder: root, providers: { claude: false, fake: false, hermes: false }, relay: { enabled: false } },
});
const client = await TestClient.open(bridge, { capabilities: { session_resync: true } });
function registry() { return (bridge.fleet as any).sessions.registry; }
await client.call("folders.add", { path: cwd });
function fixture() { return { url: bridge.url, cwd, source, title: "Welcome screen", hostID: `actions-${run}`, prompt: appOriginated ? "Review the attached reference." : "Update the welcome message.", image, attachment }; }
async function reset(kind: string) {
  releaseFork?.(); heldFork = undefined; releaseFork = undefined;
  appOriginated = kind === "attachments"; run = randomUUID(); calls = []; forks = []; baseline = []; source = "";
  if (!appOriginated) {
    source = (await client.call("session.create", { profile: "claude", source: "tui", cwd })).session_id;
    await client.call("session.rename", { session_id: source, title: "Welcome screen" });
    baseline = structuredClone(histories.get(source)!);
  }
  return fixture();
}
async function state() {
  let snapshot: unknown = {};
  if (source) {
    try { snapshot = await client.call("session.resume", { session_id: source }); }
    catch (error) { snapshot = { error: String(error) }; }
  }
  return { ...fixture(), calls, baseline, histories: Object.fromEntries(histories), snapshot,
    sourceListed: !!registry().get(source),
    forks: forks.map((fork) => ({ ...fork, adopted: fork.newID ? !!registry().get(fork.newID) : false })),
  };
}
const control = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://localhost");
    let result: unknown;
    if (url.pathname === "/reset") result = await reset(url.searchParams.get("kind") ?? "plain");
    else if (url.pathname === "/seal") {
      source = calls[0]?.id;
      if (!source) throw new Error("No app-originated attachment turn.");
      baseline = structuredClone(histories.get(source)!);
      const originalPayload = calls[0]; calls = []; forks = [];
      result = { ...fixture(), originalPayload };
    } else if (url.pathname === "/hold-fork") {
      heldFork = new Promise<void>((done) => { releaseFork = done; }); result = { held: true };
    } else if (url.pathname === "/release-fork") {
      releaseFork?.(); heldFork = undefined; result = { released: true };
    } else if (url.pathname === "/remove-source") {
      // Simulate removal arriving while fork waits; normal deletion refuses an active call.
      const records = registry(), before = records.revision;
      const removed = records.remove(source);
      result = { removed: !!removed, before, after: records.revision };
    } else result = await state();
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
await new Promise<void>((done) => control.listen(0, "127.0.0.1", done));
const controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
mkdirSync(dirname(planPath), { recursive: true });
writeFileSync(planPath, JSON.stringify({ fixture: "message-actions", control: controlURL, bundleIdentifier: process.argv[3], ...(process.argv[4] ? { output: resolve(process.argv[4]) } : {}) }));
console.log(`Message actions fixture ready; plan: ${planPath}`);
async function close() {
  releaseFork?.(); control.close(); await client.close(); await bridge.dispose(); rmSync(root, { recursive: true, force: true });
  try { if (JSON.parse(readFileSync(planPath, "utf8")).control === controlURL) rmSync(planPath); } catch {}
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void close(); });
