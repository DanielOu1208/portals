import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { SignedIn } from "../src/net/net.ts";
import { Prices, type PriceFile } from "../src/usage/prices.ts";
import { addDays, envLock, installID, ownerOf, readNetID, sentFields, Telemetry, telemetrySwitch, usageRows, type TelemetryDay } from "../src/usage/telemetry.ts";
import type { DayRow, ScanState } from "../src/usage/types.ts";
import { parseDay } from "../../stats/src/day.ts";

// The anonymous daily totals (src/usage/telemetry.ts): the body exactly as the stats
// Worker takes it (stats/src/day.ts), with no folder and a model the price table lacks as
// "other"; the owner a hash of the net's id; the switches and the environment's lock;
// once a day, each finished day the host was used on, at most the last 7, oldest first;
// and a server that fails waited for, longer each time, never tried in a loop.

setLogLevel("silent");

const table: PriceFile = {
  v: 1,
  at: "2026-11-01T00:00:00.000Z",
  source: "test",
  perMillion: { "claude-opus-5-5": [4, 20, 0.2, 5, 8], "gpt-5.5": [5, 30, 0.5, null, null] },
};

const install = "6f1c2b9e-4a7d-4d55-9c1e-2f0b7a8e3d41";
const netID = "0123456789abcdef";
const iphone: SignedIn = { kind: "member", id: "device-dana-iphone", member: "device", removed: false };
const ipad: SignedIn = { kind: "member", id: "device-dana-ipad", member: "device", removed: false };
const laptop: SignedIn = { kind: "member", id: "device-dana-mac", member: "device", removed: false };
const otherMac: SignedIn = { kind: "member", id: "mac-dana-mini", member: "mac", removed: false };
const platforms: Record<string, string> = { "device-dana-iphone": "ios", "device-dana-ipad": "ipados", "device-dana-mac": "macos" };

function row(day: string, fields: Partial<DayRow>): DayRow {
  return { day, agent: "claude", model: "claude-opus-5-5", folder: "/Users/dana/code/app", via: "portals", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, requests: 0, ...fields };
}

/** A host's state folder with a config.json, an install id and a net. */
function host(config: Record<string, unknown> = { port: 9120 }): { stateDir: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), "portals-telemetry-"));
  const stateDir = join(home, "state");
  mkdirSync(join(stateDir, "usage"), { recursive: true });
  writeFileSync(join(stateDir, "usage", "install.json"), JSON.stringify({ install }));
  writeFileSync(join(stateDir, "net.json"), JSON.stringify({ net: netID, revision: 3, members: [] }));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return { stateDir, configPath };
}

/** A stand-in for the stats Worker, answering each day with the next status given (204 after them). */
async function standIn(statuses: number[] = []): Promise<{ url: string; bodies: TelemetryDay[]; close(): Promise<void>; server: Server }> {
  const bodies: TelemetryDay[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const pieces: Buffer[] = [];
    request.on("data", (piece: Buffer) => pieces.push(piece));
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/day");
      assert.equal(request.headers["content-type"], "application/json");
      bodies.push(JSON.parse(Buffer.concat(pieces).toString("utf8")) as TelemetryDay);
      response.statusCode = statuses.shift() ?? 204;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/day`,
    bodies,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Rig {
  telemetry: Telemetry;
  now: { at: number };
  scan: ScanState;
  rows: DayRow[];
  stateDir: string;
  configPath: string;
}

function rig(url: string, options: { env?: NodeJS.ProcessEnv; config?: Record<string, unknown>; at?: string; backoffMs?: number; net?: boolean } = {}): Rig {
  const { stateDir, configPath } = host(options.config);
  const now = { at: Date.parse(options.at ?? "2026-11-05T10:00:00Z") };
  const scan: ScanState = { scanning: false };
  const rows: DayRow[] = [];
  const telemetry = new Telemetry({
    stateDir,
    configPath,
    env: { PORTALS_STATS_URL: url, ...options.env },
    book: { days: (from, to) => rows.filter((one) => one.day >= from && one.day <= to), scan: () => scan },
    prices: new Prices({ stateDir, bundled: table }),
    timeZone: "UTC",
    version: "0.3.3",
    os: "darwin",
    netID: options.net === false ? () => undefined : () => netID,
    platformOf: (id) => platforms[id],
    clock: () => now.at,
    backoffMs: options.backoffMs,
  });
  return { telemetry, now, scan, rows, stateDir, configPath };
}

/** To `iso`, with a scan of history finished then. */
function moveTo(rig: Rig, iso: string): void {
  rig.now.at = Date.parse(iso);
  rig.scan.scannedAt = rig.now.at;
}

test("a day goes exactly as the stats Worker takes it: no folder, Portals' rows only, an unknown model as other, devices by kind", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url);
    const { telemetry, rows } = host;
    // Three turns and four devices; the same iPhone twice, a linked Mac and the command's socket are not devices.
    telemetry.turnStarted();
    telemetry.turnStarted();
    telemetry.turnStarted();
    for (const signedIn of [iphone, iphone, ipad, laptop, otherMac, { kind: "local" } as SignedIn]) telemetry.deviceConnected(signedIn, undefined);
    telemetry.deviceConnected({ kind: "password" }, "app-launch-1");
    rows.push(
      row("2026-11-05", { input: 100, output: 2000, cacheRead: 300000, cacheWrite: 10000, cacheWrite1h: 4000, requests: 10 }),
      // The same model in another folder adds to the same row.
      row("2026-11-05", { folder: "/Users/dana/code/other", input: 20, output: 30, requests: 1 }),
      // Elsewhere: never sent.
      row("2026-11-05", { via: "elsewhere", input: 999999, output: 999999, requests: 99 }),
      row("2026-11-05", { agent: "codex", model: "gpt-5.5", folder: "/Users/dana/code/app", input: 1000, output: 500, reasoning: 200, cacheRead: 4000, requests: 3 }),
      // A name the table does not know, and one it knows under a prefix of someone's own.
      row("2026-11-05", { agent: "droid", model: "custom:dana-secret-model", input: 7, output: 8, requests: 1 }),
      row("2026-11-05", { agent: "pi", model: "dana-corp/gpt-5.5", input: 10, output: 10, requests: 1 }),
      // Another day.
      row("2026-11-04", { input: 5, output: 5, requests: 1 }),
    );
    moveTo(host, "2026-11-06T01:00:00Z");
    await telemetry.tick();
    assert.equal(server.bodies.length, 1);
    const [body] = server.bodies;
    assert.deepEqual(Object.keys(body), ["v", "install", "owner", "day", "version", "os", "turns", "portals", "usage"]);
    const opus = 100 * 4e-6 + 2000 * 20e-6 + 300000 * 0.2e-6 + 6000 * 5e-6 + 4000 * 8e-6 + 20 * 4e-6 + 30 * 20e-6;
    const gpt = 1000 * 5e-6 + 500 * 30e-6 + 4000 * 0.5e-6;
    assert.deepEqual(body, {
      v: 1,
      install,
      owner: "2b395f7cd2faf260d05f69d509ef8ea3",
      day: "2026-11-05",
      version: "0.3.3",
      os: "darwin",
      turns: 3,
      portals: { iphone: 1, ipad: 1, mac: 1, other: 1 },
      usage: [
        { agent: "claude", model: "claude-opus-5-5", requests: 11, input: 120, output: 2030, cache_read: 300000, cache_write: 10000, reasoning: 0, usd: Math.round(opus * 1e6) / 1e6 },
        { agent: "codex", model: "gpt-5.5", requests: 3, input: 1000, output: 500, cache_read: 4000, cache_write: 0, reasoning: 200, usd: Math.round(gpt * 1e6) / 1e6 },
        { agent: "droid", model: "other", requests: 1, input: 7, output: 8, cache_read: 0, cache_write: 0, reasoning: 0, usd: null },
        { agent: "pi", model: "gpt-5.5", requests: 1, input: 10, output: 10, cache_read: 0, cache_write: 0, reasoning: 0, usd: Math.round((10 * 5e-6 + 10 * 30e-6) * 1e6) / 1e6 },
      ],
    });
    const text = JSON.stringify(body);
    for (const leak of ["folder", "/Users/dana", "dana-secret", "dana-corp", "device-dana", "app-launch", netID]) assert.ok(!text.includes(leak), `the body holds ${leak}`);
    // The Worker's own check takes it as it is.
    assert.ok(parseDay(body, "2026-11-06"));
    // The day before had usage but nobody used Portals then: not sent.
    assert.equal(telemetry.answer().last_sent_day, "2026-11-05");
  } finally {
    await server.close();
  }
});

test("the owner is a hash of the net's id, the same for every host in it; with no net, the install id", () => {
  assert.equal(ownerOf(netID, install), "2b395f7cd2faf260d05f69d509ef8ea3");
  assert.equal(ownerOf(undefined, install), install);
  const { stateDir } = host();
  assert.equal(readNetID(stateDir), netID);
  assert.equal(installID(stateDir), install);
  // A host with no install id makes one, once.
  const fresh = mkdtempSync(join(tmpdir(), "portals-telemetry-fresh-"));
  const made = installID(fresh);
  assert.match(made, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(installID(fresh), made);
  assert.equal(readNetID(fresh), undefined);
});

test("a host in no net sends its install id as the owner", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url, { net: false });
    host.telemetry.turnStarted();
    moveTo(host, "2026-11-06T01:00:00Z");
    await host.telemetry.tick();
    assert.equal(server.bodies[0].owner, install);
    assert.deepEqual(server.bodies[0].usage, []);
  } finally {
    await server.close();
  }
});

test("on by default; off with config.json's telemetry, and DO_NOT_TRACK or PORTALS_TELEMETRY=0 lock it off", () => {
  assert.deepEqual(telemetrySwitch({}, undefined), { enabled: true, locked: null, why: "default" });
  assert.deepEqual(telemetrySwitch({}, true), { enabled: true, locked: null, why: "config" });
  assert.deepEqual(telemetrySwitch({}, false), { enabled: false, locked: null, why: "config" });
  // What someone wrote there to change it, whatever its shape, is off.
  assert.equal(telemetrySwitch({}, "off").enabled, false);
  assert.equal(telemetrySwitch({}, 0).enabled, false);
  for (const value of ["1", "true", "yes"]) assert.deepEqual(telemetrySwitch({ DO_NOT_TRACK: value }, true), { enabled: false, locked: "env", why: "DO_NOT_TRACK" });
  for (const value of ["", "0"]) assert.equal(envLock({ DO_NOT_TRACK: value }), undefined);
  assert.deepEqual(telemetrySwitch({ PORTALS_TELEMETRY: "0" }, undefined), { enabled: false, locked: "env", why: "PORTALS_TELEMETRY" });
  assert.equal(envLock({ PORTALS_TELEMETRY: "1" }), undefined);
});

test("usage.telemetry's switch writes config.json with its other keys kept, and the environment's lock wins", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url, { config: { port: 9120, auth: null, providers: { claude: true } } });
    assert.deepEqual(host.telemetry.answer(), { enabled: true, locked: null, last_sent_day: null });
    host.telemetry.turnStarted();
    assert.deepEqual(host.telemetry.set(false), { enabled: false, locked: null, last_sent_day: null });
    assert.deepEqual(JSON.parse(readFileSync(host.configPath, "utf8")), { port: 9120, auth: null, providers: { claude: true }, telemetry: false });
    // Off: nothing counted, and what was counted is let go of, so turning it on sends none of it.
    host.telemetry.turnStarted();
    host.telemetry.deviceConnected(iphone, undefined);
    assert.deepEqual(host.telemetry.set(true), { enabled: true, locked: null, last_sent_day: null });
    assert.equal(JSON.parse(readFileSync(host.configPath, "utf8")).telemetry, true);
    moveTo(host, "2026-11-06T01:00:00Z");
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 0);

    const locked = rig(server.url, { env: { DO_NOT_TRACK: "1" } });
    assert.deepEqual(locked.telemetry.set(true), { enabled: false, locked: "env", last_sent_day: null });
    locked.telemetry.turnStarted();
    moveTo(locked, "2026-11-06T01:00:00Z");
    await locked.telemetry.tick();
    assert.equal(server.bodies.length, 0);
    assert.equal(existsSync(join(locked.stateDir, "usage", "telemetry.json")), false);
  } finally {
    await server.close();
  }
});

test("a config.json edited by hand is read again within a minute", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url);
    host.telemetry.turnStarted();
    writeFileSync(host.configPath, JSON.stringify({ port: 9120, telemetry: false }));
    moveTo(host, "2026-11-06T01:00:00Z");
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 0);
    assert.equal(host.telemetry.answer().enabled, false);
  } finally {
    await server.close();
  }
});

test("once a day: each finished day not sent yet, oldest first, at most the last 7, and only once a scan has read past its end", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url, { at: "2026-11-01T12:00:00Z" });
    // Used on ten days in a row while the server could not be reached (the host offline).
    for (let day = 0; day < 10; day++) {
      host.now.at = Date.parse(`${addDays("2026-11-01", day)}T12:00:00Z`);
      host.telemetry.turnStarted();
    }
    // The 10th is today: not finished. A scan that ended before midnight has not read the end of the 9th.
    host.scan.scannedAt = Date.parse("2026-11-09T23:59:00Z");
    host.now.at = Date.parse("2026-11-10T12:00:00Z");
    await host.telemetry.tick();
    assert.deepEqual(server.bodies.map((body) => body.day), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
    // The first scan of a restart is under way: nothing yet.
    host.scan.scannedAt = Date.parse("2026-11-10T00:01:00Z");
    host.scan.scanning = true;
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 6);
    host.scan.scanning = false;
    await host.telemetry.tick();
    assert.deepEqual(server.bodies.slice(6).map((body) => body.day), ["2026-11-09"]);
    // Nothing more that day, however often it looks.
    await host.telemetry.tick();
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 7);
    assert.equal(host.telemetry.answer().last_sent_day, "2026-11-09");
    // The next day: only the 10th.
    moveTo(host, "2026-11-11T01:00:00Z");
    await host.telemetry.tick();
    assert.deepEqual(server.bodies.slice(7).map((body) => body.day), ["2026-11-10"]);
    // A day nobody used Portals on is not sent.
    moveTo(host, "2026-11-12T01:00:00Z");
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 8);
  } finally {
    await server.close();
  }
});

test("what was counted and sent stays across a restart, so a day is sent once", async () => {
  const server = await standIn();
  try {
    const host = rig(server.url);
    host.telemetry.turnStarted();
    host.telemetry.deviceConnected(iphone, undefined);
    host.telemetry.stop();
    const again = new Telemetry({
      stateDir: host.stateDir,
      configPath: host.configPath,
      env: { PORTALS_STATS_URL: server.url },
      book: { days: () => [], scan: () => ({ scanning: false, scannedAt: Date.parse("2026-11-06T00:30:00Z") }) },
      prices: new Prices({ stateDir: host.stateDir, bundled: table }),
      timeZone: "UTC",
      version: "0.3.3",
      os: "darwin",
      netID: () => netID,
      clock: () => Date.parse("2026-11-06T01:00:00Z"),
    });
    await again.tick();
    assert.equal(server.bodies.length, 1);
    assert.equal(server.bodies[0].turns, 1);
    assert.deepEqual(server.bodies[0].portals, { iphone: 1, ipad: 0, mac: 0, other: 0 });
    again.stop();
    const third = new Telemetry({
      stateDir: host.stateDir,
      configPath: host.configPath,
      env: { PORTALS_STATS_URL: server.url },
      book: { days: () => [], scan: () => ({ scanning: false, scannedAt: Date.parse("2026-11-06T00:30:00Z") }) },
      prices: new Prices({ stateDir: host.stateDir, bundled: table }),
      timeZone: "UTC",
      version: "0.3.3",
      clock: () => Date.parse("2026-11-06T02:00:00Z"),
    });
    await third.tick();
    assert.equal(server.bodies.length, 1);
    assert.equal(third.answer().last_sent_day, "2026-11-05");
  } finally {
    await server.close();
  }
});

test("a server that fails is waited for, an hour and then longer each time; a day it refuses is not sent again", async () => {
  const server = await standIn([503, 500]);
  try {
    const hour = 60 * 60_000;
    const host = rig(server.url, { at: "2026-11-04T10:00:00Z", backoffMs: hour });
    host.telemetry.turnStarted();
    moveTo(host, "2026-11-05T10:00:00Z");
    host.telemetry.turnStarted();
    moveTo(host, "2026-11-06T01:00:00Z");
    // 503: the first day is tried, and nothing after it.
    await host.telemetry.tick();
    assert.deepEqual(server.bodies.map((body) => body.day), ["2026-11-04"]);
    // Within the hour: not tried.
    host.now.at += hour - 1;
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 1);
    // After it: tried, and 500, so two hours now.
    host.now.at += 1;
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 2);
    host.now.at += 2 * hour - 1;
    await host.telemetry.tick();
    assert.equal(server.bodies.length, 2);
    host.now.at += 1;
    await host.telemetry.tick();
    assert.deepEqual(server.bodies.slice(2).map((body) => body.day), ["2026-11-04", "2026-11-05"]);
    assert.equal(host.telemetry.answer().last_sent_day, "2026-11-05");
  } finally {
    await server.close();
  }

  const refusing = await standIn([400]);
  try {
    const host = rig(refusing.url, { at: "2026-11-04T10:00:00Z" });
    host.telemetry.turnStarted();
    moveTo(host, "2026-11-05T10:00:00Z");
    host.telemetry.turnStarted();
    moveTo(host, "2026-11-06T01:00:00Z");
    await host.telemetry.tick();
    // Refused as it was: the next day goes on, and the refused one is never tried again.
    assert.deepEqual(refusing.bodies.map((body) => body.day), ["2026-11-04", "2026-11-05"]);
    await host.telemetry.tick();
    assert.equal(refusing.bodies.length, 2);
    assert.equal(host.telemetry.answer().last_sent_day, "2026-11-05");
  } finally {
    await refusing.close();
  }
});

test("a server that cannot be reached or does not answer in time costs one try, and the host goes on", async () => {
  // A port nothing listens on.
  const closed = await standIn();
  const url = closed.url;
  await closed.close();
  const host = rig(url, { at: "2026-11-05T10:00:00Z" });
  host.telemetry.turnStarted();
  moveTo(host, "2026-11-06T01:00:00Z");
  await host.telemetry.tick();
  assert.equal(host.telemetry.answer().last_sent_day, null);
  // Saved as it stops: the day is still to send.
  host.telemetry.stop();

  // One that takes the request and never answers.
  const silent = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = silent.address() as AddressInfo;
    const { stateDir, configPath } = host;
    const slow = new Telemetry({
      stateDir,
      configPath,
      env: { PORTALS_STATS_URL: `http://127.0.0.1:${port}/v1/day` },
      book: { days: () => [], scan: () => ({ scanning: false, scannedAt: Date.parse("2026-11-07T00:30:00Z") }) },
      prices: new Prices({ stateDir, bundled: table }),
      timeZone: "UTC",
      version: "0.3.3",
      clock: () => Date.parse("2026-11-07T01:00:00Z"),
      answerMs: 200,
    });
    const started = Date.now();
    await slow.tick();
    assert.ok(Date.now() - started < 5_000);
    assert.equal(slow.answer().last_sent_day, null);
  } finally {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});

test("more models than the server takes in a day: the smallest go into their agent's other", () => {
  const prices = new Prices({ stateDir: mkdtempSync(join(tmpdir(), "portals-telemetry-rows-")), bundled: { ...table, perMillion: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`claude-model-${index}`, [1, 1, null, null, null]])) } });
  const rows = Array.from({ length: 80 }, (_, index) => row("2026-11-05", { model: `claude-model-${index}`, input: 1000 + index, requests: 1 }));
  const sent = usageRows(rows, "2026-11-05", prices);
  assert.ok(sent.length <= 64);
  const other = sent.find((one) => one.model === "other")!;
  assert.equal(other.requests, 80 - (sent.length - 1));
  assert.equal(sent.reduce((sum, one) => sum + one.input, 0), rows.reduce((sum, one) => sum + one.input, 0));
  assert.ok(parseDay({ v: 1, install, owner: install, day: "2026-11-05", version: "0.3.3", os: "darwin", turns: 1, portals: { iphone: 0, ipad: 0, mac: 0, other: 0 }, usage: sent }, "2026-11-06"));
});

test("the README lists every field sent", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("## Anonymous usage totals"));
  assert.ok(section.length > 0 && readme.includes("## Anonymous usage totals"));
  for (const [key] of sentFields) assert.ok(section.includes(`\`${key}\``), `the README does not name ${key}`);
  for (const key of ["agent", "model", "requests", "input", "output", "cache_read", "cache_write", "reasoning", "usd", "iphone", "ipad", "mac", "other"]) assert.ok(section.includes(`\`${key}\``), `the README does not name ${key}`);
  for (const way of ["portals-host telemetry off", "\"telemetry\": false", "DO_NOT_TRACK", "PORTALS_TELEMETRY=0", "PORTALS_STATS_URL"]) assert.ok(section.includes(way), `the README does not say ${way}`);
});
