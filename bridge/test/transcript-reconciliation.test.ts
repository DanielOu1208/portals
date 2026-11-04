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

test("a message steered in and taken back by a Stop leaves the turn, which names its own message again while it runs", () => {
  const transcript = new Transcript();
  transcript.startTurn("Count to 25.", undefined, "first", "card");
  transcript.apply({ type: "text", text: "1, 2, 3" });
  transcript.steer("Then say banana.", "second");
  transcript.apply({ type: "text", text: ", 4" });
  assert.equal(transcript.inflight()?.user, "Then say banana.");
  assert.equal(transcript.withdraw("Then say banana.", "other"), false);
  assert.equal(transcript.withdraw("Then say banana.", "second"), true);
  assert.deepEqual(transcript.inflight(), { user: "Count to 25.", assistant: ", 4", message_id: "first", card_answer: "card" });
  assert.deepEqual(transcript.messages.map((message) => message.role === "user" ? message.text : message.role), ["Count to 25.", "assistant"]);
  transcript.apply({ type: "turn.end", status: "interrupted" });
  assert.equal(transcript.withdraw("Then say banana."), false);
});

test("a message steered in taken back after its turn has ended leaves the conversation all the same", () => {
  const transcript = new Transcript();
  transcript.startTurn("Count to 25.");
  transcript.steer("Then say banana.");
  transcript.apply({ type: "turn.end", status: "interrupted" });
  assert.equal(transcript.withdraw("Then say banana."), true);
  assert.equal(transcript.isInTurn, false);
  assert.deepEqual(transcript.messages.filter((message) => message.role === "user").map((message) => message.role === "user" && message.text), ["Count to 25."]);
});
