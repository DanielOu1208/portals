import { readFileSync } from "node:fs";

// Sends one test notification through the deployed relay to every Portals device a
// bridge knows: it registers each device token with the relay, as the app does, then
// notifies with the token it got back, as a bridge does. Prints what the relay answered,
// never a token.
//
//   node scripts/test-notification.ts <relay address> <bridge's state/push.json>

const [relay, pushFile] = process.argv.slice(2);
if (!relay || !pushFile) {
  console.error("usage: node scripts/test-notification.ts <relay address> <bridge's state/push.json>");
  process.exit(2);
}

const state = JSON.parse(readFileSync(pushFile, "utf8")) as { devices?: Record<string, { environment?: string; bundle_id?: string }> };
const devices = Object.entries(state.devices ?? {}).filter(([, device]) => device.bundle_id === "com.danielou.portals");
if (devices.length === 0) {
  console.error("The bridge knows no Portals device: open Portals on the phone with this bridge added.");
  process.exit(1);
}

for (const [index, [token, device]] of devices.entries()) {
  const environment = device.environment === "production" ? "production" : "sandbox";
  const registered = await fetch(new URL("/v1/devices", relay), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, environment, bundle_id: device.bundle_id }),
  });
  if (!registered.ok) {
    console.log(`device ${index + 1} (${environment}): registering answered ${registered.status} ${await registered.text()}`);
    continue;
  }
  const { relay_token: relayToken } = (await registered.json()) as { relay_token: string };
  const sent = await fetch(new URL("/v1/notify", relay), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${relayToken}` },
    body: JSON.stringify({ payload: { aps: { alert: { title: "Portals", body: "A test notification through the relay" }, sound: "default" } } }),
  });
  console.log(`device ${index + 1} (${environment}): notify answered ${sent.status} ${await sent.text()}`);
}
