import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv[2] === "--version") { console.log("2.2.5"); process.exit(0); }
const scenario = JSON.parse(process.env.OPENCODE_SHUTDOWN_SCENARIO ?? "{}") as {
  active?: string[]; noIdle?: string[]; delay?: number; lateChild?: string; assistant?: boolean;
  hang?: "active" | "interrupt" | "message"; fail?: string; finish?: string; firstWrong?: boolean; staleIdle?: boolean;
};
const active = new Set(scenario.active ?? []);
const idle = new Map<string, string>();
const idleCreated = new Map<string, number>();
if (scenario.staleIdle) for (const id of active) { idle.set(id, "interrupted"); idleCreated.set(id, 1); }
const calls: { method: string; path: string; query: Record<string, string>; body?: unknown }[] = [];
let infoReads = 0;
const state = () => ({ active: [...active], idle: Object.fromEntries(idle), calls });
const save = (term = false) => {
  if (process.env.OPENCODE_SHUTDOWN_STATE) writeFileSync(process.env.OPENCODE_SHUTDOWN_STATE, JSON.stringify({ ...state(), term }));
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost"), path = url.pathname;
  let body = "";
  for await (const chunk of request) body += chunk;
  calls.push({ method: request.method!, path, query: Object.fromEntries(url.searchParams), ...(body ? { body: JSON.parse(body) } : {}) });
  save();
  const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`) return json({}, 401);
  if (path === "/api/info") {
    infoReads++;
    const fault = process.env.OPENCODE_SHUTDOWN_PROOF && readFileSync(process.env.OPENCODE_SHUTDOWN_PROOF, "utf8");
    if (fault === "hang") return;
    return json({ version: "2.2.5", pid: fault === "wrong" || (scenario.firstWrong && infoReads === 1) ? process.pid + 1 : process.pid });
  }
  if (path === "/api/session/active") {
    if (scenario.hang === "active") return;
    return json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) });
  }
  const match = /^\/api\/session\/([^/]+)\/(interrupt|message)$/.exec(path);
  if (!match) return json({}, 404);
  const [, id, action] = match;
  if (action === "message") {
    if (scenario.hang === "message") return;
    return json({ data: idle.has(id) ? [{ id: "idle_" + id, type: "idle", outcome: idle.get(id), time: { created: idleCreated.get(id) } }]
      : [...(scenario.assistant ? [{ id: "assistant_" + id, type: "assistant", content: [], time: { created: 2 } }] : []),
        { id: "old_user", type: "user", text: "still not terminal", time: { created: 1 } }], cursor: {} });
  }
  if (scenario.hang === "interrupt") return;
  if (id === scenario.fail) return json({ message: "temporary refusal" }, 503);
  const running = active.has(id);
  if (scenario.lateChild && id !== scenario.lateChild) active.add(scenario.lateChild);
  const finish = () => {
    active.delete(id);
    if (!scenario.noIdle?.includes(id)) { idle.set(id, scenario.finish ?? "interrupted"); idleCreated.set(id, Date.now()); }
    save();
  };
  if (scenario.delay) setTimeout(finish, scenario.delay); else finish();
  return json({ interrupted: running });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`opencode server listening on http://127.0.0.1:${(server.address() as { port: number }).port}\n`);
});
process.on("SIGTERM", () => { save(true); server.closeAllConnections(); server.close(() => process.exit(0)); });
