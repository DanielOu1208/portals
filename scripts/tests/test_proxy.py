"""Exercise the actual TCP proxy with an inert clock, filesystem and network."""
import shutil
import subprocess
import unittest

from support import ROOT


HARNESS = r'''
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let now = 0, nextTimer = 0, wantedDelay = "100", accept, serverOptions;
const timers = new Map(), intervals = [], upstreams = [], logged = [];
class Socket {
  handlers = new Map();
  sent = [];
  destroyed = false;
  readableEnded = false;
  writableFinished = false;
  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }
  emit(event, value) {
    if (event === "end") this.readableEnded = true;
    for (const handler of this.handlers.get(event) ?? []) handler(value);
    if (event === "end") this.closeIfComplete();
  }
  write(chunk) {
    assert.equal(this.destroyed, false, "no write after abort");
    assert.equal(this.writableFinished, false, "no write after FIN");
    this.sent.push(chunk.toString());
    return true;
  }
  end() {
    this.sent.push("FIN");
    this.writableFinished = true;
    this.closeIfComplete();
  }
  closeIfComplete() {
    if (this.readableEnded && this.writableFinished && !this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}
const fs = {
  lstatSync() { throw Error("new log"); },
  unlinkSync() { assert.fail("unexpected unlink"); },
  openSync() { return 1; },
  readFileSync() { return wantedDelay; },
  writeSync(fd, text) { logged.push(text); },
};
const net = {
  createServer(options, callback) {
    serverOptions = typeof options === "function" ? {} : options;
    accept = callback ?? options;
    return { listen() {} };
  },
  createConnection(options) {
    const socket = new Socket();
    socket.options = options;
    upstreams.push(socket);
    return socket;
  },
};
const context = vm.createContext({
  console,
  Date: class extends Date { static now() { return now; } },
  process: {
    argv: ["node", "proxy.mjs", "9364", "9354", "inert.txt"],
    env: { RETURN_DELAY_MS: "100" },
    exit(code) { assert.fail(`unexpected exit ${code}`); },
  },
  setInterval(callback) { intervals.push(callback); },
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
});
const module = new vm.SourceTextModule(readFileSync(process.argv[2], "utf8"), { context });
await module.link((name) => {
  const exports = name === "node:fs" ? fs : name === "node:net" ? net : undefined;
  assert.ok(exports, `unexpected import ${name}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
function connect() {
  const app = new Socket();
  accept(app);
  return { app, bridge: upstreams.at(-1) };
}
function delay(ms) { wantedDelay = String(ms); intervals[0](); }
function data(socket, text) { socket.emit("data", Buffer.from(text)); }
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
    if (!next || next[1].due > end) break;
    timers.delete(next[0]);
    now = Math.max(now, next[1].due);
    next[1].callback();
  }
  now = end;
}
'''


class ProxyTests(unittest.TestCase):
    def run_proxy(self, scenario):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is needed for offline proxy regressions")
        result = subprocess.run(
            [node, "--experimental-vm-modules", "--input-type=module", "-",
             str(ROOT / "scripts/return-bench/proxy.mjs")],
            input=HARNESS + "\n" + scenario, text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_decreasing_delay_preserves_each_direction(self):
        self.run_proxy('''
const {app, bridge} = connect();
data(app, "up-first"); data(bridge, "down-first");
advance(10); delay(0);
data(app, "up-second"); data(bridge, "down-second");
assert.deepEqual(app.sent, []); assert.deepEqual(bridge.sent, []);
advance(90);
assert.deepEqual(app.sent, ["down-first", "down-second"]);
assert.deepEqual(bridge.sent, ["up-first", "up-second"]);
''')

    def test_increasing_delay_keeps_each_chunks_minimum_delay(self):
        self.run_proxy('''
const {app, bridge} = connect();
data(app, "first"); advance(10); delay(200); data(app, "second");
advance(90); assert.deepEqual(bridge.sent, ["first"]);
advance(109); assert.deepEqual(bridge.sent, ["first"]);
advance(1); assert.deepEqual(bridge.sent, ["first", "second"]);
''')

    def test_connections_and_directions_have_independent_queues(self):
        self.run_proxy('''
const first = connect(); data(first.app, "slow");
advance(10); delay(0);
const second = connect();
data(second.app, "other"); data(first.bridge, "reply");
assert.deepEqual(second.bridge.sent, ["other"]);
assert.deepEqual(first.app.sent, ["reply"]);
assert.deepEqual(first.bridge.sent, []);
advance(90); assert.deepEqual(first.bridge.sent, ["slow"]);
''')

    def test_abort_cancels_both_directions_without_late_writes(self):
        self.run_proxy('''
for (const side of ["app", "bridge"]) for (const event of ["close", "error"]) {
  const {app, bridge} = connect(); delay(100);
  data(app, "up"); data(bridge, "down");
  (side === "app" ? app : bridge).emit(event);
  assert.equal(app.destroyed, true); assert.equal(bridge.destroyed, true);
  assert.equal(timers.size, 0);
  advance(100);
  assert.deepEqual(app.sent, []); assert.deepEqual(bridge.sent, []);
}
''')

    def test_graceful_half_close_flushes_data_before_fin(self):
        self.run_proxy('''
const {app, bridge} = connect();
assert.equal(serverOptions.allowHalfOpen, true);
assert.equal(bridge.options.allowHalfOpen, true);
data(app, "request"); advance(10); delay(0); app.emit("end");
assert.deepEqual(bridge.sent, []);
advance(90); assert.deepEqual(bridge.sent, ["request", "FIN"]);
assert.equal(app.destroyed, false); assert.equal(bridge.destroyed, false);
delay(100); data(bridge, "response"); bridge.emit("end");
advance(100); assert.deepEqual(app.sent, ["response", "FIN"]);
''')

    def test_overdue_timer_cannot_be_overtaken_by_zero_delay_data(self):
        self.run_proxy('''
const {app, bridge} = connect();
data(app, "first");
now = 110; delay(0); data(app, "second");
advance(0);
assert.deepEqual(bridge.sent, ["first", "second"]);
''')

    def test_clean_source_close_does_not_cancel_queued_response(self):
        self.run_proxy('''
const {app, bridge} = connect();
delay(0); data(app, "request"); app.emit("end");
assert.equal(bridge.writableFinished, true);
delay(50); data(bridge, "response"); bridge.emit("end");
assert.equal(bridge.destroyed, true, "completed upstream closes before response timer");
assert.equal(app.destroyed, false, "downstream is still waiting for response");
advance(50);
assert.deepEqual(app.sent, ["response", "FIN"]);
assert.deepEqual(bridge.sent, ["request", "FIN"]);
assert.equal(app.destroyed, true, "both halves finish normally");
assert.equal(timers.size, 0);
''')

    def test_zero_delay_and_byte_counters_keep_their_existing_meaning(self):
        self.run_proxy('''
delay(0);
const {app, bridge} = connect();
data(app, "é"); data(bridge, "😀");
assert.deepEqual(bridge.sent, ["é"]); assert.deepEqual(app.sent, ["😀"]);
assert.equal(timers.size, 0);
intervals[1]();
assert.match(logged.at(-1), / 2 4\\n$/);
intervals[1](); assert.equal(logged.length, 1);
''')
