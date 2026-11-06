import "./environment.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setLogLevel } from "../src/log.ts";
import type { TelemetryDay } from "../src/usage/telemetry.ts";
import { createThread, RpcFailure, runTurn, startTestBridge, TestClient } from "./helpers.ts";

// The anonymous totals in the running host (feature usage_telemetry): usage.telemetry says
// and sets the switch in config.json, a device that connects and a turn that starts are
// counted for the day, and the finished day goes to the stats server; a host whose
// environment says DO_NOT_TRACK (as every test's does, PORTALS_TELEMETRY=0) is locked off.

setLogLevel("silent");

test("usage.telemetry says and sets the switch; a device and a turn are counted, and the finished day is sent", async () => {
  const bodies: TelemetryDay[] = [];
  const server = createServer((request, response) => {
    const pieces: Buffer[] = [];
    request.on("data", (piece: Buffer) => pieces.push(piece));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(pieces).toString("utf8")) as TelemetryDay);
      response.statusCode = 204;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/day`;
  const now = { at: Date.parse("2026-11-05T10:00:00Z") };
  const bridge = await startTestBridge({ telemetry: { env: { PORTALS_STATS_URL: url }, clock: () => now.at, timeZone: "UTC" } });
  try {
    const client = await TestClient.open(bridge, { capabilities: { device: "dana-iphone-launch" } });
    assert.ok((client.readyPayload.bridge.features as string[]).includes("usage_telemetry"));
    assert.deepEqual(await client.call("usage.telemetry"), { enabled: true, locked: null, last_sent_day: null });
    const thread = await createThread(client);
    await runTurn(client, thread, "hello");

    // The next day, once history has been read past its end: the day goes.
    now.at = Date.parse("2026-11-06T01:00:00Z");
    for (let tries = 0; bodies.length === 0 && tries < 50; tries++) {
      await bridge.telemetry!.tick();
      if (bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].day, "2026-11-05");
    assert.equal(bodies[0].turns, 1);
    assert.deepEqual(bodies[0].portals, { iphone: 0, ipad: 0, mac: 0, other: 1 });
    assert.deepEqual(await client.call("usage.telemetry"), { enabled: true, locked: null, last_sent_day: "2026-11-05" });

    const config = JSON.parse(readFileSync(join(bridge.home, "config.json"), "utf8"));
    assert.deepEqual(await client.call("usage.telemetry", { enabled: false }), { enabled: false, locked: null, last_sent_day: "2026-11-05" });
    assert.deepEqual(JSON.parse(readFileSync(join(bridge.home, "config.json"), "utf8")), { ...config, telemetry: false });
    await client.close();
  } finally {
    await bridge.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a host whose environment keeps the totals off says so, and setting the switch does not turn them on", async () => {
  const bridge = await startTestBridge();
  try {
    const client = await TestClient.open(bridge);
    assert.deepEqual(await client.call("usage.telemetry"), { enabled: false, locked: "env", last_sent_day: null });
    assert.deepEqual(await client.call("usage.telemetry", { enabled: true }), { enabled: false, locked: "env", last_sent_day: null });
    assert.equal(JSON.parse(readFileSync(join(bridge.home, "config.json"), "utf8")).telemetry, true);
    await assert.rejects(client.call("usage.telemetry", { enabled: "yes" }), (error: unknown) => error instanceof RpcFailure && error.code === -32602);
    await client.close();
  } finally {
    await bridge.dispose();
  }
});
