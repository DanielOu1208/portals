import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Transcript } from "../src/sessions/transcript.ts";

test("taking back the final failed handoff leaves no row to inspect after its pair is removed", () => {
  const transcript = new Transcript([
    { role: "user", text: "same words", timestamp: 1 },
    { role: "assistant", text: "No receipt.", timestamp: 1, display_kind: "failed_turn", display_metadata: { failed_request_id: "one" } },
  ]);
  assert.doesNotThrow(() => transcript.removeFailed("one"));
  assert.deepEqual(transcript.messages, []);
  assert.doesNotThrow(() => transcript.removeFailed("one"));
});

test("a receipt between turns records its accepted message without opening an inflight turn", () => {
  const transcript = new Transcript();
  transcript.steer("accepted before the process stopped", "mine");
  assert.equal(transcript.isInTurn, false);
  assert.equal(transcript.inflight(), null);
  assert.equal(transcript.turnStart, null);
  assert.equal(transcript.messages.length, 1);
  const message = transcript.messages[0];
  assert.ok(message.role === "user");
  assert.equal(message.text, "accepted before the process stopped");
  assert.equal(message.message_id, "mine");
  assert.equal(message.display_kind, "steer");
});
