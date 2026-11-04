import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathsFor } from "../src/config.ts";
import { isLoopbackAddress } from "../src/net/members.ts";
import { startTestBridge, TestClient } from "./helpers.ts";
import { RelayStandIn } from "./relay-standin.ts";

// A Mac set up without Tailscale (2026-11-03): setup gives it 127.0.0.1 as its address, which
// means something only on that Mac. Portals on the Mac joins the net as usual; nothing else is
// handed that address, and the host says what to do instead. The address setup replaces it
// with once Tailscale is there puts everything back as usual.

const tailnet = "https://mac.example.ts.net:10010";

test("isLoopbackAddress is the addresses only the computer itself answers at", () => {
  for (const address of ["http://127.0.0.1:9120", "http://127.1.2.3:80", "http://localhost:9120", "http://LOCALHOST", "http://[::1]:9120"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["https://mac.tailnet.ts.net:10010", "http://100.64.0.1:9120", "http://192.168.1.5:9120", "http://127.0.0.1.example.com", "not an address", ""]) {
    assert.equal(isLoopbackAddress(address), false, address);
  }
});

test("a host set up for its own Mac: Portals there joins, nothing else is handed its address, and Tailscale later undoes it", async (t) => {
  const relay = await RelayStandIn.start();
  t.after(() => relay.close());
  // A first run makes the settings, as setup does before the host starts for good.
  const first = await startTestBridge({ keepHome: true, config: { relay: { enabled: true, url: relay.url } } });
  const home = first.home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await first.close();

  const setupFile = pathsFor(home).setup;
  writeFileSync(setupFile, JSON.stringify({ label: "test", log: "test.log", address: "http://127.0.0.1:9120" }));
  const local = await startTestBridge({ home, keepHome: true });
  let owner = await TestClient.open(local);
  try {
    const listed = await owner.call("net.list");
    const here = listed.members.find((member: { id: string }) => member.id === listed.here);
    assert.equal(here.url, "http://127.0.0.1:9120");

    // With no one to come through it, it keeps no connection to the relay.
    await sleep(100);
    assert.equal(relay.open(here.relay, "mac").length, 0);

    // Portals on this Mac: the password, a code, and in.
    const { code } = await owner.call("net.invite");
    const joined = await fetch(`${local.url}/net/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, member: { id: "this-mac-portals", kind: "device", name: "Mac", platform: "macos" } }),
    });
    assert.equal(joined.status, 200);
    const { token } = (await joined.json()) as { token: string };

    // Add a portal from that Portals: a code with 127.0.0.1 in it would lead a phone to itself.
    const portal = await TestClient.open(local, { token });
    await assert.rejects(portal.call("net.invite"), /install Tailscale and run npx portals-host setup again/);
    portal.socket.close();

    // Nor does it join another net, whose Macs and devices would dial themselves to reach it.
    await assert.rejects(owner.call("net.join_with", { link: `portals://join?v=1&url=${encodeURIComponent(tailnet)}&code=abc&name=Mini` }), /install Tailscale and run npx portals-host setup again/);
    owner.socket.close();
    await local.close();

    // Setup run again with Tailscale: the new address, for Portals on this Mac as for anyone.
    writeFileSync(setupFile, JSON.stringify({ label: "test", log: "test.log", address: tailnet }));
    const reachable = await startTestBridge({ home, keepHome: true });
    owner = await TestClient.open(reachable);
    const relisted = await owner.call("net.list");
    assert.equal(relisted.members.find((member: { id: string }) => member.id === relisted.here).url, tailnet);
    assert.ok(relisted.members.some((member: { id: string }) => member.id === "this-mac-portals"), "Portals on this Mac stays in the net");
    const again = await TestClient.open(reachable, { token });
    const invite = await again.call("net.invite");
    assert.equal(invite.url, tailnet);
    for (const end = Date.now() + 5000; relay.open(here.relay, "mac").length === 0;) {
      assert.ok(Date.now() < end, "the relay's standby opens");
      await sleep(10);
    }
    again.socket.close();
    owner.socket.close();
    await reachable.close();
  } finally {
    owner.socket.close();
  }
});

test("config's net.url is a real address: a host given one is not for its own Mac alone", async (t) => {
  const first = await startTestBridge({ keepHome: true, config: { net: { url: tailnet } } });
  const home = first.home;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await first.close();
  writeFileSync(pathsFor(home).setup, JSON.stringify({ label: "test", log: "test.log", address: "http://127.0.0.1:9120" }));
  const bridge = await startTestBridge({ home, keepHome: true });
  t.after(() => bridge.close());
  const owner = await TestClient.open(bridge);
  t.after(() => owner.socket.close());
  const { code, url } = await owner.call("net.invite");
  assert.equal(url, tailnet);
  // A device in its net can make codes too, which a host for its own Mac refuses.
  const joined = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "configured-device", kind: "device", name: "iPhone", platform: "ios" } }),
  });
  const { token } = (await joined.json()) as { token: string };
  const device = await TestClient.open(bridge, { token });
  t.after(() => device.socket.close());
  assert.equal((await device.call("net.invite")).url, tailnet);
});

test("a scratch bridge with no setup address still hands out its own: the rule is setup's word, not the address", async (t) => {
  const bridge = await startTestBridge();
  t.after(() => bridge.dispose());
  const owner = await TestClient.open(bridge);
  t.after(() => owner.socket.close());
  const { code } = await owner.call("net.invite");
  const joined = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "scratch-device", kind: "device", name: "iPhone", platform: "ios" } }),
  });
  const { token } = (await joined.json()) as { token: string };
  const device = await TestClient.open(bridge, { token });
  t.after(() => device.socket.close());
  assert.ok(isLoopbackAddress((await device.call("net.invite")).url));
});
