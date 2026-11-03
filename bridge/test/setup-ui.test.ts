import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { wrap } from "../src/setup/ui.ts";

// The guided flow's line wrapping (src/setup/ui.ts): text is wrapped before it is drawn,
// so every line stays inside the line down the left.

test("text wraps at spaces, keeps its own line breaks, and breaks only a word too long for a line, after a slash", () => {
  assert.equal(wrap("Made a password for the app to sign in with.", 20), "Made a password for\nthe app to sign in\nwith.");
  assert.equal(wrap("One line\nand another", 40), "One line\nand another");
  assert.equal(wrap("at ~/Library/Application Support/portals-bridge/password.txt", 20), "at\n~/Library/\nApplication\nSupport/\nportals-bridge/\npassword.txt");
  assert.equal(wrap("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij\nklmnopqrst\nuvwxyz");
  assert.equal(wrap("", 20), "");
});
