import assert from "node:assert/strict";
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { FileSearch } from "../src/sessions/fileSearch.ts";
import * as current from "../test/helpers.ts";

// Actual @-mention requests, after actual filesystem refreshes, against an older
// checkout and this one. Both test bridges use temporary homes, ephemeral loopback
// ports, and only the fake agent. No installed bridge, agent, relay or host config.
//
// First make a scratch tree with file-search-bench.ts tree and git add its files.
// Then: node scripts/file-search-rank-bench.ts <baseline-checkout> <scratch-tree>
// The baseline must be a checkout of this repository before the ranking change.
const [before, tree] = process.argv.slice(2);
if (!before || !tree) throw new Error("usage: file-search-rank-bench.ts <baseline-checkout> <scratch-tree>");
const folder = realpathSync(tree);
const baseline = await import(pathToFileURL(join(resolve(before), "bridge/src/sessions/fileSearch.ts")).href);
const previous = await import(pathToFileURL(join(resolve(before), "bridge/test/helpers.ts")).href);
const marker = join(folder, `zz_n19_perf_wire_${process.pid}.txt`);

type Key = "before" | "after";
type Cache = { held: Map<string, { stale: boolean; listing: { shallow?: number[] } }> };
const keys: Key[] = ["before", "after"];
const captures = new Map<Key, Cache>();
const bridges = new Map<Key, current.TestBridge>();
const clients = new Map<Key, current.TestClient>();
const coldMs: Partial<Record<Key, number>> = {};
const samples: Record<Key, number[]> = { before: [], after: [] };
const cpu: Record<Key, number[]> = { before: [], after: [] };
const original = { before: baseline.FileSearch.prototype.search, after: FileSearch.prototype.search };
const params = { folder, query: "", limit: 50, profile: "fake" };
const startLoad = loadavg();
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function invalidated(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!keys.every((key) => captures.get(key)!.held.get(folder)!.stale)) {
    if (Date.now() > deadline) throw new Error("watcher did not invalidate the actual listing");
    await sleep(10);
  }
}

writeFileSync(marker, "initial", { flag: "wx" });
try {
  for (const key of keys) {
    const Type = key === "before" ? baseline.FileSearch : FileSearch;
    const tools = key === "before" ? previous : current;
    Type.prototype.search = function (this: FileSearch, ...args: Parameters<FileSearch["search"]>) {
      captures.set(key, this as unknown as Cache);
      return original[key].apply(this, args);
    };
    const bridge = await tools.startTestBridge({ temporaryFolders: [], config: { generalFolder: folder } });
    bridges.set(key, bridge);
    const client: current.TestClient = await tools.TestClient.open(bridge);
    clients.set(key, client);
    const started = performance.now();
    const answer = await client.call("files.search", params);
    coldMs[key] = performance.now() - started;
    assert.equal(answer.source, "git");
    assert.equal(answer.files.length, params.limit);
  }
  let total = 0;
  for (let round = 0; round < 12; round += 1) {
    writeFileSync(marker, String(round));
    await invalidated();
    for (const key of keys) {
      let answer;
      do {
        answer = await clients.get(key)!.call("files.search", { ...params, query: "zz_n19_perf_wire" });
        if (answer.refreshing) await sleep(10);
      } while (answer.refreshing);
      assert.equal(captures.get(key)!.held.get(folder)!.listing.shallow, undefined);
    }
    const answers: Partial<Record<Key, any>> = {};
    for (const key of round % 2 ? [...keys].reverse() : keys) {
      const used = process.cpuUsage();
      const started = performance.now();
      answers[key] = await clients.get(key)!.call("files.search", params);
      const spent = process.cpuUsage(used);
      if (round >= 2) {
        samples[key].push(performance.now() - started);
        cpu[key].push((spent.user + spent.system) / 1000);
      }
    }
    assert.deepEqual(answers.before, answers.after);
    total = answers.before.total;
  }
  console.log(JSON.stringify({
    total, limit: params.limit, coldMs,
    wallMs: { before: median(samples.before), after: median(samples.after) },
    cpuMs: { before: median(cpu.before), after: median(cpu.after) },
    startLoad, endLoad: loadavg(), samples, cpu,
  }));
} finally {
  baseline.FileSearch.prototype.search = original.before;
  FileSearch.prototype.search = original.after;
  for (const client of clients.values()) await client.close();
  for (const bridge of bridges.values()) await bridge.dispose();
  unlinkSync(marker);
}
