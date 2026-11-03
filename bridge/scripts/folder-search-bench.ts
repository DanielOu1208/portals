import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { FolderSearch } from "../src/folderSearch.ts";
import { Folders } from "../src/folders.ts";

// What folders.search costs (feature folder_search, docs/plans/2026-10-26-folder-search.md,
// section 4).
//
//   node --expose-gc scripts/folder-search-bench.ts tree <folder> [count]   # a synthetic home of about 100,000 folders
//   node --expose-gc scripts/folder-search-bench.ts measure <home> [--skip A,B] [--fresh] [--targets a,b,…]
//
// `measure` only reads the home folder (and with `--fresh`, which is for a synthetic home
// only, makes and removes one folder in it). It prints numbers only: counts and times,
// never a folder's name, so it can be run on a real home folder. `--skip` names folders at
// the top of the home folder never read (Desktop, Documents and Downloads, which macOS
// asks before reading). The queries are typed a character at a time.

const [command, home, ...rest] = process.argv.slice(2);
if (!command || !home) {
  console.error("usage: folder-search-bench.ts tree|measure <folder> …");
  process.exit(2);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2);
}

function prefixes(queries: string[]): string[] {
  return queries.flatMap((query) => Array.from({ length: query.length }, (_, index) => query.slice(0, index + 1)));
}

const gc = (globalThis as { gc?: () => void }).gc ?? (() => undefined);

// MARK: A synthetic home

function makeTree(root: string, count: number): void {
  let seed = 4242;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const words = "account agent api app auth bridge buffer cache chat client config connection core data debug device diff event file fleet folder gateway handler header history image index input item kit layout list loader log main manager message model net node option order parser path picker pool portal preview provider queue reader registry relay render request result route screen search server session settings sheet sidebar source state status store stream sync task test thread token tool transcript turn user util view watcher window worker".split(" ");
  const tops = ["coding_projects", "Documents", "work", "Desktop", "Downloads", "Projects", "Music", "Pictures", "notes", "archive"];
  let made = 0;
  const make = (path: string) => {
    mkdirSync(path, { recursive: true });
    made += 1;
  };
  for (const top of tops) make(join(root, top));
  // Repositories, each with a .git and a tree of sources; some with node_modules and build.
  for (let repo = 0; made < count * 0.6; repo += 1) {
    const top = join(root, pick(["coding_projects", "work", "Projects"]), `${pick(words)}-${pick(words)}${repo}`);
    make(top);
    mkdirSync(join(top, ".git", "objects"), { recursive: true });
    if (random() < 0.3) for (let index = 0; index < 50; index += 1) mkdirSync(join(top, "node_modules", `${pick(words)}-${index}`), { recursive: true });
    if (random() < 0.3) mkdirSync(join(top, "build", "intermediates"), { recursive: true });
    const folders = [top];
    for (let index = 0, size = 20 + Math.floor(random() * 200); index < size; index += 1) {
      const parent = pick(folders);
      const child = join(parent, random() < 0.5 ? pick(words) : `${pick(words)}_${pick(words)}`);
      make(child);
      folders.push(child);
    }
  }
  // Everything else: documents and the like, up to eight levels deep.
  const folders = tops.map((top) => join(root, top));
  while (made < count) {
    const parent = pick(folders);
    if (parent.split("/").length - root.split("/").length > 8) continue;
    const child = join(parent, `${pick(words)} ${pick(words)}`);
    make(child);
    folders.push(child);
  }
  mkdirSync(join(root, "Library", "Caches", "a"), { recursive: true });
  mkdirSync(join(root, ".cache", "b"), { recursive: true });
  console.log(JSON.stringify({ folders: made }));
}

// MARK: Measuring

async function measure(root: string, skip: string[], fresh: boolean, targets: string[]): Promise<void> {
  const folders = new Folders({ general: join(root, "Portals"), hide: skip.map((name) => join(root, name)), own: [], sources: [async () => []], home: root, temporary: [] });
  const make = (options: { watch?: boolean; firstWaitMs?: number } = {}) =>
    new FolderSearch({
      home: folders.homeFolder(),
      refusing: () => folders.refusing(),
      taking: () => folders.taking(),
      listed: async () => (await folders.list()).folders,
      ...options,
    });
  const delay = monitorEventLoopDelay({ resolution: 1 });

  // Cold: the whole walk, three times; and the first answer as a person gets it.
  const walks: number[] = [];
  const firsts: { ms: number; refreshing: boolean; hits: number }[] = [];
  let size = 0;
  let truncated = false;
  let heap = 0;
  delay.enable();
  for (let run = 0; run < 3; run += 1) {
    gc();
    const before = process.memoryUsage().heapUsed;
    const first = make({ watch: false });
    let start = performance.now();
    const answer = await first.search("a");
    firsts.push({ ms: +(performance.now() - start).toFixed(1), refreshing: answer.refreshing === true, hits: answer.folders.length });
    first.close();
    const whole = make({ watch: false, firstWaitMs: 600_000 });
    start = performance.now();
    const done = await whole.search("a");
    walks.push(performance.now() - start);
    size = whole.size;
    truncated = done.truncated === true;
    // The listing as a search keeps it, its arrays made.
    await whole.search("b");
    gc();
    heap = (process.memoryUsage().heapUsed - before) / 1e6;
    whole.close();
  }
  delay.disable();
  const walkLoop = { p99: +(delay.percentile(99) / 1e6).toFixed(1), max: +(delay.max / 1e6).toFixed(1) };
  delay.reset();

  // Warm: typing, unrelated queries, typed paths.
  const search = make({ watch: true, firstWaitMs: 600_000 });
  await search.search("a");
  const time = async (queries: string[]) => {
    const ms: number[] = [];
    const cpu: number[] = [];
    let hits = 0;
    for (const query of queries) {
      const before = process.cpuUsage();
      const start = performance.now();
      const answer = await search.search(query, 30);
      ms.push(performance.now() - start);
      const used = process.cpuUsage(before);
      cpu.push((used.user + used.system) / 1000);
      hits += answer.folders.length;
    }
    return { queries: queries.length, p50: percentile(ms, 50), p95: percentile(ms, 95), cpu_p50: percentile(cpu, 50), cpu_p95: percentile(cpu, 95), hits_per_query: +(hits / queries.length).toFixed(1) };
  };
  delay.enable();
  const typing = await time(prefixes(targets));
  const unrelated = await time([1, 2].flatMap(() => targets.flatMap((target) => [target.slice(0, 1), target.slice(0, 2), target.slice(0, Math.ceil(target.length / 2)), target, "zq"])));
  const paths = await time(prefixes(["~/cod/por", "~/coding_projects/", "~/wo/ser", "~/Doc/no/"]));
  delay.disable();
  const searchLoop = { p99: +(delay.percentile(99) / 1e6).toFixed(1), max: +(delay.max / 1e6).toFixed(1) };

  // Fresh: a folder made, then found (a synthetic home only).
  let freshMs: number | undefined;
  let rereads: number | undefined;
  if (fresh) {
    const tops = readdirSync(root).filter((name) => !name.startsWith(".") && name !== "Library");
    const made = join(root, tops[0], "zzfreshlymadefolder");
    const start = performance.now();
    mkdirSync(made);
    for (;;) {
      const answer = await search.search("zzfreshlymade");
      if (answer.folders.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (performance.now() - start > 10_000) break;
    }
    freshMs = +(performance.now() - start).toFixed(1);
    rereads = search.reread;
    rmSync(made, { recursive: true });
  }
  search.close();

  console.log(JSON.stringify({
    folders: size, truncated,
    walk_ms: { runs: walks.map((ms) => Math.round(ms)), median: Math.round(percentile(walks, 50)) },
    first_answer: firsts,
    heap_mb: +heap.toFixed(1),
    event_loop_delay_during_walk_ms: walkLoop,
    typing, unrelated, paths,
    event_loop_delay_during_searches_ms: searchLoop,
    ...(fresh ? { fresh_ms: freshMs, folders_read_again: rereads, walks: search.walks } : {}),
  }, null, 1));
}

if (command === "tree") {
  rmSync(home, { recursive: true, force: true });
  makeTree(home, Number(rest[0] ?? 100_000));
} else if (command === "measure") {
  const option = (name: string) => {
    const at = rest.indexOf(name);
    return at === -1 ? undefined : rest[at + 1];
  };
  const skip = (option("--skip") ?? "").split(",").filter((name) => name !== "");
  const targets = (option("--targets") ?? "portals,coding projects,bridge src,notes,gateway").split(",");
  await measure(home, skip, rest.includes("--fresh"), targets);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
