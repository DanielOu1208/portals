import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { log } from "../src/log.ts";

test("a log line the disk has no room for is lost, and the bridge goes on (2026-10-27)", (t) => {
  const write = process.stderr.write;
  t.after(() => { process.stderr.write = write; });
  let tried = 0;
  process.stderr.write = (() => { tried++; throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); }) as typeof process.stderr.write;
  assert.doesNotThrow(() => log.error("an error nothing caught; the bridge stops", { error: "ENOSPC" }));
  assert.doesNotThrow(() => log.warn("could not keep a turn's change in the thread's record"));
  assert.equal(tried, 2);
});
