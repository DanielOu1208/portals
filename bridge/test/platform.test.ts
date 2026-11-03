import "./environment.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeManagedSettings, dataFolder, hostOS, logFolder, prettyHostname, programFolders } from "../src/platform.ts";
import { bridgePath } from "../src/setup/install.ts";

// What differs between macOS and Linux (src/platform.ts), each asked for on either system.

test("the system is macOS on a Mac and Linux elsewhere", () => {
  assert.equal(hostOS, process.platform === "darwin" ? "macos" : "linux");
});

test("the bridge's folder goes in Application Support on a Mac, in XDG's data folder on Linux, and its log in ~/Library/Logs or XDG's state folder", () => {
  const home = "/home/dana";
  assert.equal(dataFolder("macos", { XDG_DATA_HOME: "/elsewhere" }, "/Users/dana"), "/Users/dana/Library/Application Support");
  assert.equal(logFolder("macos", { XDG_STATE_HOME: "/elsewhere" }, "/Users/dana"), "/Users/dana/Library/Logs");
  assert.equal(dataFolder("linux", {}, home), "/home/dana/.local/share");
  assert.equal(logFolder("linux", {}, home), "/home/dana/.local/state");
  assert.equal(dataFolder("linux", { XDG_DATA_HOME: "/data/dana " }, home), "/data/dana");
  assert.equal(logFolder("linux", { XDG_STATE_HOME: "/state/dana" }, home), "/state/dana");
  // XDG's spec ignores a relative path, or an empty one.
  assert.equal(dataFolder("linux", { XDG_DATA_HOME: "share" }, home), "/home/dana/.local/share");
  assert.equal(logFolder("linux", { XDG_STATE_HOME: "" }, home), "/home/dana/.local/state");
});

test("Claude Code's managed settings are where Claude Code reads them on each system", () => {
  assert.equal(claudeManagedSettings("macos"), "/Library/Application Support/ClaudeCode/managed-settings.json");
  assert.equal(claudeManagedSettings("linux"), "/etc/claude-code/managed-settings.json");
});

test("a bridge a service starts finds programs where the installers put them: on a Mac as before Linux, on Linux in Linuxbrew and Snap's folders too", () => {
  assert.deepEqual(programFolders("macos", "/Users/dana"), ["/Users/dana/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  assert.deepEqual(programFolders("linux", "/home/dana"), [
    "/home/dana/.local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/snap/bin",
  ]);
  // The agents' own folders and node's come first, each folder once.
  const path = bridgePath(["/home/dana/.nvm/versions/node/v24.1.0/bin/codex", null, "/usr/bin/claude"], "linux").split(":");
  assert.equal(path[0], "/home/dana/.nvm/versions/node/v24.1.0/bin");
  assert.equal(path[1], "/usr/bin");
  assert.ok(path.includes("/home/linuxbrew/.linuxbrew/bin") && !path.includes("/opt/homebrew/bin"));
  assert.equal(new Set(path).size, path.length);
});

test("a Linux machine's own name is the pretty host name in /etc/machine-info, quoted or not, the last one counting", () => {
  assert.equal(prettyHostname('PRETTY_HOSTNAME="Dana\'s Zephyrus"\nICON_NAME=computer-laptop\n'), "Dana's Zephyrus");
  assert.equal(prettyHostname("ICON_NAME=computer\nPRETTY_HOSTNAME=Workshop box\n"), "Workshop box");
  assert.equal(prettyHostname("PRETTY_HOSTNAME='Lab \"7\"'"), 'Lab "7"');
  assert.equal(prettyHostname('PRETTY_HOSTNAME="The \\"big\\" one"'), 'The "big" one');
  assert.equal(prettyHostname("PRETTY_HOSTNAME=first\nPRETTY_HOSTNAME=second"), "second");
  // Unset, empty, or another key that ends the same: none, so the host name is used.
  assert.equal(prettyHostname(""), "");
  assert.equal(prettyHostname('PRETTY_HOSTNAME=""'), "");
  assert.equal(prettyHostname("NOT_PRETTY_HOSTNAME=x"), "");
});
