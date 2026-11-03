import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromHere, fromLine, fromWords, longestWords, readFrom, senderOf, withoutFromLine, words, type From } from "../src/fleet/line.ts";

// Who a message sent through the fleet is from (feature senders): the facts, the line
// made from them, and the facts read back from the line, here and only here.

const mini = "7d2a41c09be36f58";
const mbp16 = "845e7c909e4ee7cb";

test("the line names a thread of the same Mac by its agent, title and id, and one of another Mac by that Mac's id and name too", () => {
  const local: From = { agent: "claude", agent_name: "Claude Code", thread: "6d3c", title: "Fix the login" };
  assert.equal(fromLine(local, "Check the build", mbp16), '[Portals: from Claude Code · "Fix the login" (thread 6d3c)]\nCheck the build');
  const far: From = { agent: "codex", agent_name: "Codex", thread: "019a", title: "Review", machine: mini, machine_name: "mini" };
  assert.equal(fromLine(far, "Done", mbp16), `[Portals: from Codex · "Review" (thread ${mini}/019a) on mini]\nDone`);
  // Its own Mac's thread, passed back to it, needs no Mac.
  assert.equal(fromLine(far, "Done", mini), '[Portals: from Codex · "Review" (thread 019a)]\nDone');
  // A title that only repeats the agent's name, or none, says nothing more.
  assert.equal(words({ agent_name: "Pi", thread: "p1", title: "Pi" }), "Pi (thread p1)");
  assert.equal(words({}), "the command line");
  assert.equal(words({ machine: mini, machine_name: "mini" }, mbp16), `the command line (machine ${mini}) on mini`);
  assert.deepEqual(senderOf(fromLine({ machine: mini, machine_name: "mini" }, "x", mbp16)), { machine: mini, machine_name: "mini" });
});

test("the facts are read back from the line, with the Mac only when it is another; a line of an older bridge's gives what it says", () => {
  const far: From = { agent_name: "Codex", title: "Review", thread: "019a", machine: mini, machine_name: "mini" };
  assert.deepEqual(senderOf(fromLine(far, "Done", mbp16)), far);
  assert.deepEqual(senderOf(fromLine({ agent_name: "Claude Code", thread: "6d3c", title: "Fix the login" }, "x")), { agent_name: "Claude Code", title: "Fix the login", thread: "6d3c" });
  assert.deepEqual(senderOf("[Portals: from the command line]\nRun it"), {});
  assert.deepEqual(senderOf("[Portals: from the command line on mini]\nRun it"), { machine_name: "mini" });
  // As older bridges wrote it: another Mac's thread by its host name, with no id.
  assert.deepEqual(senderOf('[Portals: from Claude Code · "Fix" (thread 6d3c) on dhcp-206-87.ubc.ca]\nhi'), { agent_name: "Claude Code", title: "Fix", thread: "6d3c", machine_name: "dhcp-206-87.ubc.ca" });
  assert.deepEqual(senderOf("[Portals: from Aeri (thread aeri)]\nhi"), { agent_name: "Aeri", thread: "aeri" });
  // A title with quotes and "(thread …)" of its own keeps them.
  assert.deepEqual(senderOf('[Portals: from Codex · "Fix (thread safety) "now"" (thread 01a1)]\nhi'), { agent_name: "Codex", title: 'Fix (thread safety) "now"', thread: "01a1" });
  // Words another bridge chose, which this one did not write: no facts.
  assert.equal(senderOf("[Portals: from Pi on mini]\nhi"), undefined);
  // Only the first line marks it.
  assert.equal(senderOf("Look\n[Portals: from the command line]"), undefined);
  assert.equal(senderOf("Fix the login"), undefined);
  assert.equal(withoutFromLine(fromLine(far, "Done\nand more", mbp16)), "Done\nand more");
});

test("facts passed on by another bridge are kept to short lines of known keys, and this Mac's own are told which Mac they are on", () => {
  assert.deepEqual(readFrom({ agent_name: " Claude\nCode ", thread: "6d3c", title: "x".repeat(400), extra: "no", machine: 7 }), { agent_name: "Claude Code", thread: "6d3c", title: "x".repeat(300) });
  assert.equal(readFrom({}), undefined);
  assert.equal(readFrom("Claude Code"), undefined);
  assert.equal(readFrom(null), undefined);
  assert.deepEqual(fromHere({ agent_name: "Pi", thread: "p1" }, { id: mbp16, name: "MBP16" }), { agent_name: "Pi", thread: "p1", machine: mbp16, machine_name: "MBP16" });
  // Another Mac's facts go on as they came.
  assert.deepEqual(fromHere({ thread: "p1", machine: mini, machine_name: "mini" }, { id: mbp16, name: "MBP16" }), { thread: "p1", machine: mini, machine_name: "mini" });
  // An older bridge's words are kept as they came, on one line.
  assert.equal(fromWords("Pi on\nmini", "hi"), "[Portals: from Pi on mini]\nhi");
});

test("a line too long to be one this bridge wrote is not read, so a crafted one cannot hold up the bridge", () => {
  // Its patterns take time with the square of the line: 16,000 of these took 0.66 s.
  const crafted = `[Portals: from Codex${' · "'.repeat(16_000)}]\nhi`;
  const started = performance.now();
  assert.equal(senderOf(crafted), undefined);
  assert.ok(performance.now() - started < 50);
  // The longest this bridge writes, every fact as long as a fact may be, is still read.
  const most = readFrom({ agent: "a".repeat(400), agent_name: "n".repeat(400), thread: "t".repeat(400), title: "x".repeat(400), machine: "m".repeat(400), machine_name: "y".repeat(400) })!;
  assert.equal(most.title!.length, 300);
  assert.equal(most.thread!.length, 100);
  assert.ok(words(most, mbp16).length <= longestWords);
  const { agent: _agent, ...written } = most;
  assert.deepEqual(senderOf(fromLine(most, "hi", mbp16)), written);
  assert.ok(words({ machine: most.machine, machine_name: most.machine_name }, mbp16).length <= longestWords);
});

test("a fact or an older bridge's words cut in the middle of an emoji are cut before it, never in half", () => {
  // Cut by UTF-16 units, half of the emoji went into the line, and from it into the agent's prompt.
  const title = `${"a".repeat(299)}\u{1F680}`;
  assert.equal(readFrom({ thread: "6d3c", title })?.title, "a".repeat(299));
  assert.equal(fromWords(title, "hello"), `[Portals: from ${"a".repeat(299)}]\nhello`);
});
