import "./environment.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathsFor } from "../src/config.ts";
import { setUpHermes } from "../src/setup/hermes.ts";
import type { RunOptions, RunResult, System } from "../src/setup/system.ts";
import type { Choice, Ui } from "../src/setup/ui.ts";

// Setup's Hermes step (src/setup/hermes.ts), in a home folder of the test's own, so the
// Hermes on this Mac is never found, run or started.

let root: string;
let realHome: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "portals-setup-hermes-"));
  realHome = process.env.HOME;
  process.env.HOME = root;
});

after(() => {
  process.env.HOME = realHome;
  rmSync(root, { recursive: true, force: true });
});

class QuietUi implements Ui {
  readonly questions: string[] = [];
  private readonly answer: boolean;
  constructor(answer: boolean) {
    this.answer = answer;
  }
  begin(): void {}
  end(): void {}
  task<T>(_text: string, work: () => Promise<T>): Promise<T> {
    return work();
  }
  say(): void {}
  step(): void {}
  ok(): void {}
  warn(): void {}
  raw(): void {}
  async confirm(question: string): Promise<boolean> {
    this.questions.push(question);
    return this.answer;
  }
  async choose<T extends string>(_question: string, _choices: readonly Choice<T>[], fallback: T): Promise<T> {
    return fallback;
  }
  async secret(): Promise<string> {
    return "";
  }
}

class StandIn implements System {
  readonly runs: { program: string; args: string[]; options: RunOptions }[] = [];
  uid = process.getuid?.() ?? 501;
  private readonly hermes: string | null;
  private readonly onInstall?: () => void;
  constructor(hermes: string | null, onInstall?: () => void) {
    this.hermes = hermes;
    this.onInstall = onInstall;
  }
  which(name: string): string | null {
    return name === "hermes" ? this.hermes : null;
  }
  async run(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.runs.push({ program, args, options });
    if (program === "/bin/bash") {
      this.onInstall?.();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "--version") return { code: 0, stdout: "Hermes Agent v0.21.5+5295.g234badf (2026.9.24) · up to date\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  }
}

const paths = () => pathsFor(join(root, "bridge"));

function installHermes(): string {
  const path = join(root, ".local", "bin", "hermes");
  mkdirSync(join(root, ".local", "bin"), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

test("a Hermes on the PATH is offered, with its version, without starting it", async () => {
  const system = new StandIn("/opt/hermes/bin/hermes");
  const result = await setUpHermes({ ui: new QuietUi(false), system, interactive: true, paths: paths(), enabled: true });
  assert.equal(result.state, "ready");
  assert.match(result.summary, /^Hermes 0\.21\.5: this host offers it\./);
  assert.match(result.summary, /hermes setup model/);
  assert.deepEqual(result.config, { path: "/opt/hermes/bin/hermes" });
  assert.deepEqual(system.runs.map((run) => run.args), [["--version"]]);
});

test("without Hermes, setup offers its installer only when someone can answer", async () => {
  const quiet = new QuietUi(true);
  const unattended = await setUpHermes({ ui: quiet, system: new StandIn(null), interactive: false, paths: paths(), enabled: true });
  assert.equal(unattended.state, "missing");
  assert.match(unattended.summary, /install\.sh \| bash/);
  assert.deepEqual(quiet.questions, []);

  const declined = await setUpHermes({ ui: new QuietUi(false), system: new StandIn(null), interactive: true, paths: paths(), enabled: true });
  assert.equal(declined.state, "missing");
});

test("Hermes's installer runs in the terminal, and the Hermes it installs is offered", async () => {
  const system = new StandIn(null, installHermes);
  const ui = new QuietUi(true);
  const result = await setUpHermes({ ui, system, interactive: true, paths: paths(), enabled: true });
  assert.equal(ui.questions.length, 1);
  const install = system.runs[0];
  assert.equal(install.program, "/bin/bash");
  assert.deepEqual(install.args, ["-c", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"]);
  assert.equal(install.options.inherit, true);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.config, { path: join(root, ".local", "bin", "hermes") });
});

test("a Hermes the config turns off stays off, and nothing is run or offered", async () => {
  const system = new StandIn("/opt/hermes/bin/hermes");
  const ui = new QuietUi(true);
  const result = await setUpHermes({ ui, system, interactive: true, paths: paths(), enabled: false });
  assert.equal(result.state, "off");
  assert.match(result.summary, /^Hermes: installed, and off on this host \(providers\.hermes in /);
  assert.equal(result.config, undefined);
  assert.deepEqual(system.runs, []);
  assert.deepEqual(ui.questions, []);
});
