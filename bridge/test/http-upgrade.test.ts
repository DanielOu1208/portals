import "./environment.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("a malformed WebSocket request target is refused without stopping the HTTP server", async (t) => {
  const fixture = fileURLToPath(new URL("./http-upgrade-server.ts", import.meta.url));
  const child = spawn(process.execPath, [fixture], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  t.after(async () => {
    child.kill();
    await exited;
  });
  const [line] = await once(child.stdout, "data");
  const port = Number(String(line).trim());
  assert.ok(port > 0 && port !== 9120);
  const answer = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("the upgrade was not answered")));
    socket.on("error", reject);
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("close", () => resolve(response));
    socket.on("connect", () => socket.end([
      "GET //[ HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: AAECAwQFBgcICQoLDA0ODw==",
      "", "",
    ].join("\r\n")));
  });
  assert.match(answer, /^HTTP\/1\.1 400 /, errors);
  const status = await fetch(`http://127.0.0.1:${port}/api/status`);
  assert.equal(status.status, 200);
  assert.equal(child.exitCode, null);
});
