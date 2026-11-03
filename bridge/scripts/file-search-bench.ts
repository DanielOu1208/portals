import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { FileSearch } from "../src/sessions/fileSearch.ts";

// What files.search costs (feature file_search, docs/plans/2026-10-26-file-mentions.md,
// section 5), and Codex's own searches beside it on the same folder.
//
//   node --expose-gc scripts/file-search-bench.ts tree <folder> [count]    # makes a synthetic tree (100,000 files)
//   node --expose-gc scripts/file-search-bench.ts ours <folder> [--walk] <query>…
//   node scripts/file-search-bench.ts codex <folder> <query>…            # fuzzyFileSearch, one call a query
//   node scripts/file-search-bench.ts codex-session <folder> <query>…    # the experimental session search
//
// Each query is typed a character at a time. `codex` and `codex-session` start a `codex
// app-server` of their own on stdio with a CODEX_HOME in a temporary folder (no login: the
// search calls no model), never the shared daemon. Prints JSON.

const [command, folder, ...rest] = process.argv.slice(2);
if (!command || !folder) {
  console.error("usage: file-search-bench.ts tree|ours|codex|codex-session <folder> …");
  process.exit(2);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2);
}

function prefixes(queries: string[]): string[] {
  return queries.flatMap((query) => Array.from({ length: query.length }, (_, index) => query.slice(0, index + 1)));
}

// MARK: A synthetic tree

function makeTree(root: string, count: number): void {
  let seed = 12345;
  // mulberry32: the same tree each time.
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const words = "account agent api app auth bridge buffer cache chat client config connection core data debug device diff event file fleet folder gateway handler header history image index input item kit layout list loader log main manager message model net node option order parser path picker pool portal preview provider queue reader registry relay render request result route screen search server session settings sheet sidebar source state status store stream sync task test thread token tool transcript turn user util view watcher window worker".split(" ");
  const extensions = [".ts", ".ts", ".ts", ".swift", ".swift", ".js", ".json", ".md", ".py", ".css", ".tsx", ".go", ".rs", ".yml"];
  const tops = ["src", "packages", "apps", "lib", "docs", "test", "scripts", "Sources", "Tests", "vendor"];
  const camel = (list: string[]) => list.map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1))).join("");
  const made = new Set<string>();
  const folders = new Set<string>();
  while (made.size < count) {
    const parts = [pick(tops)];
    for (let level = 1, depth = 2 + Math.floor(random() * 5); level < depth; level += 1) parts.push(random() < 0.5 ? pick(words) : `${pick(words)}-${pick(words)}`);
    const dir = join(root, ...parts);
    if (!folders.has(dir)) {
      mkdirSync(dir, { recursive: true });
      folders.add(dir);
    }
    for (let index = 0, files = 5 + Math.floor(random() * 30); index < files && made.size < count; index += 1) {
      const path = join(dir, camel([pick(words), pick(words), ...(random() < 0.3 ? [pick(words)] : [])]) + pick(extensions));
      if (made.has(path)) continue;
      made.add(path);
      writeFileSync(path, "");
    }
  }
  console.log(JSON.stringify({ files: made.size, folders: folders.size }));
}

// MARK: Ours

async function ours(root: string, walk: boolean, queries: string[]): Promise<void> {
  const options = walk ? { git: null } : {};
  const gc = (globalThis as { gc?: () => void }).gc ?? (() => undefined);
  const cold: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const search = new FileSearch({ ...options, watch: false });
    const start = performance.now();
    await search.search(root, queries[0].slice(0, 1), 50);
    cold.push(performance.now() - start);
    search.close();
  }
  gc();
  const before = process.memoryUsage().heapUsed;
  const search = new FileSearch(options);
  const { total, source } = await search.search(root, "", 50);
  gc();
  const heap = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  const timed = async (query: string, wall: number[], cpu: number[]) => {
    const used = process.cpuUsage();
    const start = performance.now();
    await search.search(root, query, 50);
    wall.push(performance.now() - start);
    const spent = process.cpuUsage(used);
    cpu.push((spent.user + spent.system) / 1000);
  };
  const typing: number[] = [];
  const typingCpu: number[] = [];
  for (const query of prefixes(queries)) await timed(query, typing, typingCpu);
  const unrelated: number[] = [];
  const unrelatedCpu: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    for (const query of queries) {
      for (const length of [1, 2, 3, Math.ceil(query.length / 2), query.length]) {
        await search.search(root, `zz${round}`, 1);
        await timed(query.slice(0, length), unrelated, unrelatedCpu);
      }
    }
  }
  // A file made, then searched for until found: the watcher, a new listing, the wait.
  const name = `zqxfresh${Date.now()}.txt`;
  const start = performance.now();
  writeFileSync(join(root, name), "");
  let fresh = -1;
  for (let tries = 0; tries < 400 && fresh < 0; tries += 1) {
    if ((await search.search(root, name, 5)).files.some((hit) => hit.path === name)) fresh = performance.now() - start;
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  unlinkSync(join(root, name));
  // Idle, once the listing after the removal is in.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (let tries = 0; tries < 200 && (await search.search(root, "a", 1)).refreshing; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const idle = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const idleUsed = process.cpuUsage(idle);
  const top = (await search.search(root, queries[0], 5)).files.map((hit) => hit.path);
  search.close();
  console.log(JSON.stringify({
    folder: root, source, total, cold_ms: percentile(cold, 50), heap_mb: +heap.toFixed(1),
    typing_ms: { p50: percentile(typing, 50), p95: percentile(typing, 95), queries: typing.length },
    typing_cpu_ms: { p50: percentile(typingCpu, 50), p95: percentile(typingCpu, 95) },
    unrelated_ms: { p50: percentile(unrelated, 50), p95: percentile(unrelated, 95), queries: unrelated.length },
    unrelated_cpu_ms: { p50: percentile(unrelatedCpu, 50), p95: percentile(unrelatedCpu, 95) },
    fresh_after_change_ms: Math.round(fresh), idle_cpu_ms_per_10s: +((idleUsed.user + idleUsed.system) / 1000).toFixed(1), top,
  }));
}

// MARK: Codex

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: unknown;
}

async function codex(root: string, session: boolean, queries: string[]): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "file-search-codex-"));
  const child = spawn("codex", ["app-server"], { env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (message: Message) => void>();
  const listeners: ((message: Message) => void)[] = [];
  let next = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)!(message);
      waiting.delete(message.id);
    } else if (message.method) {
      for (const listener of [...listeners]) listener(message);
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<Message>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    const init = await call("initialize", { clientInfo: { name: "portals-bench", title: null, version: "0" }, capabilities: session ? { experimentalApi: true } : null });
    if (init.error) throw new Error(JSON.stringify(init.error));
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    let search: (query: string) => Promise<{ ms: number; paths: string[] }>;
    if (!session) {
      search = async (query) => {
        const start = performance.now();
        const answer = await call("fuzzyFileSearch", { query, roots: [root], cancellationToken: null });
        if (answer.error) throw new Error(JSON.stringify(answer.error));
        return { ms: performance.now() - start, paths: answer.result.files.map((file: { path: string }) => file.path) };
      };
    } else {
      const sessionId = "bench";
      const started = await call("fuzzyFileSearch/sessionStart", { sessionId, roots: [root] });
      if (started.error) throw new Error(JSON.stringify(started.error));
      // The time is to the first update naming the query: Codex may say the search
      // completed before or after its last update. The next query waits for 30 ms quiet.
      search = (query) =>
        new Promise((resolve) => {
          const start = performance.now();
          let first: number | undefined;
          let paths: string[] = [];
          let quiet: NodeJS.Timeout | undefined;
          const listener = (message: Message) => {
            if (message.method !== "fuzzyFileSearch/sessionUpdated" || message.params?.sessionId !== sessionId || message.params.query !== query) return;
            first ??= performance.now() - start;
            paths = message.params.files.map((file: { path: string }) => file.path);
            clearTimeout(quiet);
            quiet = setTimeout(() => {
              listeners.splice(listeners.indexOf(listener), 1);
              resolve({ ms: first!, paths });
            }, 30);
          };
          listeners.push(listener);
          void call("fuzzyFileSearch/sessionUpdate", { sessionId, query });
        });
    }
    const first = await search(queries[0].slice(0, 1));
    const typing: number[] = [];
    for (const query of prefixes(queries)) typing.push((await search(query)).ms);
    const tops: Record<string, string[]> = {};
    for (const query of queries) tops[query] = (await search(query)).paths.slice(0, 5);
    console.log(JSON.stringify({ folder: root, search: session ? "session" : "fuzzyFileSearch", first_ms: +first.ms.toFixed(1), typing_ms: { p50: percentile(typing, 50), p95: percentile(typing, 95), queries: typing.length }, tops }));
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

if (command === "tree") makeTree(folder, Number(rest[0] ?? 100_000));
else if (command === "ours") await ours(folder, rest.includes("--walk"), rest.filter((arg) => arg !== "--walk"));
else if (command === "codex") await codex(folder, false, rest);
else if (command === "codex-session") await codex(folder, true, rest);
else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
