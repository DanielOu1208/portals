import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge } from "../src/bridge.ts";
import { hashPassword } from "../src/http/auth.ts";
import { setLogLevel } from "../src/log.ts";
import { rawPublicKey } from "../src/relay/seal.ts";
import { password, TestClient, username } from "../test/helpers.ts";
import { TunnelDevice } from "./tunnel-device.ts";

// The tunnel end to end against a relay run elsewhere, such as the Worker under
// `wrangler dev` (relay/README.md): a scratch bridge with the scripted agent alone and
// `relay.url` set to that relay, and a device in its net through the relay. Nothing is
// deployed and no installed bridge is touched.
//
//   node scripts/tunnel-check.ts http://127.0.0.1:8790 /private/tmp/portals-net-r1/bridge
//
// The folder is made (and emptied first); the bridge listens on a port of the system's choice.

const [relay, home] = process.argv.slice(2);
if (!relay || !home) {
  console.error("Usage: node scripts/tunnel-check.ts <relay address> <scratch folder for the bridge>");
  process.exit(2);
}

function step(text: string): void {
  console.log(`- ${text}`);
}

rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "general"), { recursive: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    port: 0,
    auth: { username, passwordHash: await hashPassword(password) },
    generalFolder: realpathSync(join(home, "general")),
    providers: { claude: false, codex: false, pi: false, cursor: false, droid: false, hermes: false, fake: true },
    codex: { mode: "own" },
    fake: { delayMs: 5 },
    push: { relay: null },
    relay: { enabled: true, url: relay },
  }),
);
// The helpers make the log silent; the bridge's lines about the relay are worth seeing here.
setLogLevel("info");
const bridge = await startBridge({ home });
step(`scratch bridge at ${bridge.url}, home ${home}, relay.url ${relay}`);
let failed = false;
try {
  const toBridge = await TestClient.open(bridge);
  const listed = await toBridge.call("net.list");
  const mac = listed.members.find((member: { id: string }) => member.id === listed.here) as { id: string; relay: string; key: string };
  step(`the Mac's entry: relay id ${mac.relay}, key ${mac.key}`);
  const thread = (await toBridge.call("session.create", { profile: "fake", source: "tui" })).session_id as string;

  // A device joins the net as the app does: a code, then POST /net/join.
  const { code } = await toBridge.call("net.invite");
  const joined = await fetch(`${bridge.url}/net/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, member: { id: "tunnel-check-phone", kind: "device", name: "Tunnel check", platform: "ios" } }),
  });
  assert.equal(joined.status, 200);
  const token = ((await joined.json()) as { token: string }).token;
  step("a device joined the net with a code and has its token");

  // The standby socket opens as the bridge starts; until it is there the relay says 4503.
  let device: TunnelDevice | undefined;
  for (let tries = 0; !device; tries++) {
    const trying = await TunnelDevice.open({ relay, relayID: mac.relay, macKey: mac.key, token });
    const first = await Promise.race([trying.find((frame) => frame.params?.type === "gateway.ready", 15_000).then(() => "ready", () => trying.closed), trying.closed]);
    if (first === "ready") device = trying;
    else if (typeof first === "object" && first.code === 4503 && tries < 20) await new Promise((resolve) => setTimeout(resolve, 500));
    else throw new Error(`the tunnel closed: ${JSON.stringify(first)}`);
  }
  step("through the relay: handshake, token, gateway.ready");
  await device.call("client.capabilities", { server_requests: true });
  const you = (await device.call("net.list")).you;
  assert.equal(you, "tunnel-check-phone");
  step(`net.list through the tunnel says you = ${you}`);
  const threads = (await device.call("threads.list")).threads as { id: string }[];
  assert.ok(threads.some((listed) => listed.id === thread));
  step(`threads.list through the tunnel: ${threads.length} thread(s), the one made over the direct connection among them`);
  await device.call("session.resume", { session_id: thread, profile: "fake" });
  step("session.resume through the tunnel");
  const submitted = await device.call("prompt.submit", { session_id: thread, text: "Hello through the relay", profile: "fake" });
  assert.equal(submitted.status, "streaming");
  const done = await device.find((frame) => frame.method === "event" && frame.params?.type === "message.complete" && frame.params.session_id === thread, 30_000);
  step(`prompt.submit through the tunnel; the fake agent answered: ${JSON.stringify(done.params.payload.text)}`);
  assert.match(done.params.payload.text, /You said: Hello through the relay\./);
  const closed = await device.close();
  step(`the device closed the tunnel: ${closed.code}`);

  const stranger = await TunnelDevice.open({ relay, relayID: mac.relay, macKey: mac.key, token: randomBytes(32).toString("base64url") });
  const refused = await stranger.closed;
  assert.equal(refused.code, 4401);
  step(`a token the bridge does not know: closed ${refused.code} "${refused.reason}"`);

  const wrongKey = rawPublicKey(generateKeyPairSync("x25519").publicKey).toString("base64url");
  const impostor = await TunnelDevice.open({ relay, relayID: mac.relay, macKey: wrongKey, token });
  const broken = await impostor.closed;
  assert.equal(broken.code, 4400);
  assert.equal(impostor.frames.length, 0);
  step(`a device using another key for the Mac: closed ${broken.code} "${broken.reason}" at its first sealed frame, nothing opened`);
  await toBridge.close();
} catch (error) {
  failed = true;
  console.error(`FAILED: ${(error as Error).stack ?? error}`);
} finally {
  await bridge.close();
  step("the scratch bridge stopped");
}
console.log(failed ? "The tunnel check failed." : "The tunnel check passed.");
process.exit(failed ? 1 : 0);
