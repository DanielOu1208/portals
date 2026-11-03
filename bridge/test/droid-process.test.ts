import "./environment.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { onDroidExit } from "../src/providers/droid/sdk.ts";

test("Droid's last output is read before its process is declared gone (D8)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter() as ChildProcess;
  const heard: string[] = [];
  onDroidExit(child, () => heard.push("gone"));
  child.emit("exit", 1, null);
  assert.equal(heard.length, 0);
  heard.push("last reply", "turn end");
  child.emit("close", 1, null);
  assert.deepEqual(heard, ["last reply", "turn end", "gone"]);
  t.mock.timers.tick(2000);
  assert.equal(heard.filter((entry) => entry === "gone").length, 1);
});

test("an inherited Droid pipe cannot delay process loss forever, and letting go cancels that wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancelled of [false, true]) {
    const child = new EventEmitter() as ChildProcess;
    let ended = 0;
    const stop = onDroidExit(child, () => { ended++; });
    child.emit("exit", 1, null);
    t.mock.timers.tick(1999);
    assert.equal(ended, 0);
    if (cancelled) stop();
    t.mock.timers.tick(1);
    assert.equal(ended, cancelled ? 0 : 1);
    child.emit("close", 1, null);
    assert.equal(ended, cancelled ? 0 : 1);
    assert.equal(child.listenerCount("exit") + child.listenerCount("close"), 0);
  }
});
