import "./environment.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { lockDirectory, proves, readServeRecord, ServeLocator, type ServeEndpoint } from "../src/providers/hermes/serve.ts";
import { findHermes, hermesVersion } from "../src/providers/hermes/setup.ts";

// Finding the `hermes serve` this Mac runs from Hermes's own record of it, starting one
// when none does, and what setup asks of an installed Hermes. A small script stands in
// for `hermes`: `serve` answers Hermes's identity check and writes the record as
// Hermes does; `--version` prints what Hermes prints.

let folder: string;
let records: string;
let hermes: string;
const started: number[] = [];

const script = `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
if (process.argv[2] === "--version") {
  console.log("Hermes Agent v0.21.5+5295.g234badf (2026.9.24) · upstream 234badf4");
  process.exit(0);
}
const token = "stand-in-token";
const server = createServer((request, response) => {
  if (request.url === "/api/host/identity" && request.headers["x-hermes-token"] === token) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, protocolVersion: 1, pid: process.pid, role: "serve", servesSpa: false }));
    return;
  }
  response.writeHead(401);
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  const directory = process.env.HERMES_GATEWAY_LOCK_DIR;
  writeFileSync(join(directory, "host-serve.token"), token, { mode: 0o600 });
  const record = { role: "serve", pid: process.pid, port: server.address().port, host: "127.0.0.1", protocolVersion: 1,
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 16), profiles: ["default"] };
  writeFileSync(join(directory, "host-serve.json"), JSON.stringify(record), { mode: 0o600 });
  console.log("serving on " + server.address().port + " from " + process.cwd());
});
`;

before(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "portals-hermes-setup-")));
  records = mkdtempSync(join(tmpdir(), "portals-hermes-locks-"));
  hermes = join(folder, "hermes");
  writeFileSync(hermes, script);
  chmodSync(hermes, 0o755);
});

after(() => {
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  rmSync(folder, { recursive: true, force: true });
  rmSync(records, { recursive: true, force: true });
});

function writeRecord(directory: string, record: Record<string, unknown>, token = "a-token"): void {
  writeFileSync(join(directory, "host-serve.token"), token);
  writeFileSync(join(directory, "host-serve.json"), JSON.stringify(record));
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

test("Hermes's records are in its lock folder, under the state folder unless named", () => {
  assert.equal(lockDirectory({ HERMES_GATEWAY_LOCK_DIR: "/x/locks" }), "/x/locks");
  assert.equal(lockDirectory({ XDG_STATE_HOME: "/x/state" }), "/x/state/hermes/gateway-locks");
  // A relative XDG_STATE_HOME is ignored, as Hermes ignores it.
  assert.match(lockDirectory({ XDG_STATE_HOME: "state" }), /\/\.local\/state\/hermes\/gateway-locks$/);
});

test("a record counts only with its own token, a live process and the format Hermes writes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "portals-hermes-record-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const good = { role: "serve", pid: process.pid, port: 9119, host: "127.0.0.1", protocolVersion: 1, tokenFingerprint: fingerprint("a-token") };
  assert.equal(readServeRecord(directory), null);
  writeRecord(directory, good);
  assert.deepEqual(readServeRecord(directory), { host: "127.0.0.1", port: 9119, token: "a-token", pid: process.pid });
  // Bound to every address: reached on loopback.
  writeRecord(directory, { ...good, host: "0.0.0.0" });
  assert.equal(readServeRecord(directory)?.host, "127.0.0.1");
  for (const bad of [
    { ...good, tokenFingerprint: fingerprint("another") },
    { ...good, protocolVersion: 2 },
    { ...good, role: "gateway" },
    { ...good, pid: 999_999_999 },
    { ...good, port: 0 },
    { ...good, host: "100.64.0.1" },
  ]) {
    writeRecord(directory, bad);
    assert.equal(readServeRecord(directory), null, JSON.stringify(bad));
  }
});

test("without a backend running, the locator says so, or starts `hermes serve` and finds it", async () => {
  const env = { ...process.env, HERMES_GATEWAY_LOCK_DIR: records };
  const logPath = join(folder, "hermes-serve.log");
  const waiting = new ServeLocator({ path: hermes, start: false, cwd: folder, logPath, env });
  await assert.rejects(waiting.locate(), /Hermes is not running/);

  const locator = new ServeLocator({ path: hermes, start: true, cwd: folder, logPath, env, startTimeoutMs: 10_000 });
  const endpoint: ServeEndpoint = await locator.locate();
  started.push(endpoint.pid);
  assert.equal(endpoint.token, "stand-in-token");
  assert.notEqual(endpoint.pid, process.pid);
  assert.equal(await proves(endpoint), true);
  // It runs from the folder given, and writes where it was told.
  assert.match(readFileSync(logPath, "utf8"), new RegExp(`from ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // One that answers as another process does not prove itself.
  assert.equal(await proves({ ...endpoint, pid: endpoint.pid + 1 }), false);
  assert.equal(await proves({ ...endpoint, token: "wrong" }), false);
  // Asked again, the same backend: none is started twice.
  assert.equal((await locator.locate()).pid, endpoint.pid);
});

test("setup finds Hermes where it is configured, on PATH, or where its installer puts it, and reads its version", async () => {
  assert.equal(findHermes(hermes, {}, "/nonexistent"), hermes);
  assert.equal(findHermes("hermes", { PATH: `/nonexistent:${folder}` }, "/nonexistent"), hermes);
  assert.equal(findHermes("hermes", { PATH: "/nonexistent" }, hermes), hermes);
  assert.equal(findHermes("/nonexistent/hermes", {}, "/nonexistent"), null);
  assert.equal(await hermesVersion(hermes), "0.21.5+5295.g234badf");
  assert.equal(await hermesVersion("/nonexistent/hermes"), null);
  assert.equal(existsSync(join(records, "host-serve.json")), true);
});
