import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setLogLevel } from "../src/log.ts";
import { connect } from "./bench/connect.ts";
import { cost } from "./bench/cost.ts";
import { fleet } from "./bench/fleet.ts";
import { idle } from "./bench/idle.ts";
import { loads } from "./bench/loads.ts";
import { marks } from "./bench/marks.ts";
import { network } from "./bench/network.ts";
import { pushes } from "./bench/pushes.ts";
import { recipe } from "./bench/registry.ts";
import { resume } from "./bench/resume.ts";
import { markdown, type Run, type Scenario, type Table } from "./bench/run.ts";
import { Scratch } from "./bench/scratch.ts";
import { stream } from "./bench/stream.ts";
import { tokens } from "./bench/tokens.ts";
import { turns } from "./bench/turns.ts";

// The harness: what the bridge's fleet and thread sync cost, measured on scratch
// bridges. Each bridge is a process of its own in a folder the
// harness makes and removes, on port 0, with the scripted agent only: no model is
// called, nothing is installed, and no installed bridge is touched. It prints a table
// for each scenario, ready to paste into your notes.
//
//   node scripts/bench.ts                          every scenario but cost, counters on
//   node scripts/bench.ts --only turns,marks       some of them; `all` is every one, cost too
//   node scripts/bench.ts --sizes 100,1000,5000    the list sizes (these are the default)
//   node scripts/bench.ts --counters off           the bridges' counters off: the numbers from outside only
//   node scripts/bench.ts --json <path>            also every table's rows as JSON
//   node scripts/bench.ts --idle 120               how long idle watches, in seconds (60)
//   node scripts/bench.ts --scratch <folder>       where its scratch folder is made (the system's temporary folder)
//   node scripts/bench.ts --pid-notes <prefix>     each running bridge's pid in a file `<prefix><n>`, removed when it is gone
//   node scripts/bench.ts --quick                  small sizes, seconds; the test suite runs this
//
// The default run takes about five minutes (`network`, a device on a slow link, two of
// them), and `--only cost` about four.

const scenarios: Record<string, Scenario> = { idle, turns, marks, fleet, stream, loads, connect, network, pushes, resume, tokens, cost };
/** Left out unless named: it takes as long as the rest together. */
const onlyWhenNamed = new Set(["cost"]);

class UsageError extends Error {}

interface Options {
  only: string[];
  sizes: number[] | undefined;
  counters: boolean;
  json: string | undefined;
  idleSeconds: number;
  scratch: string | undefined;
  notes: string | undefined;
  quick: boolean;
}

function read(argv: string[]): Options {
  const options: Options = { only: Object.keys(scenarios).filter((name) => !onlyWhenNamed.has(name)), sizes: undefined, counters: true, json: undefined, idleSeconds: 60, scratch: undefined, notes: undefined, quick: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const given = argv[++index];
      if (given === undefined) throw new UsageError(`${flag} takes a value.`);
      return given;
    };
    switch (flag) {
      case "--only": {
        const names = value().split(",");
        const unknown = names.filter((name) => name !== "all" && !Object.hasOwn(scenarios, name));
        if (unknown.length > 0) throw new UsageError(`There is no scenario called ${unknown.join(", ")}. The scenarios are: ${Object.keys(scenarios).join(", ")}.`);
        // Each once: a scenario's bridges are in folders named after it.
        options.only = names.includes("all") ? Object.keys(scenarios) : [...new Set(names)];
        break;
      }
      case "--sizes":
        options.sizes = value().split(",").map(Number);
        if (!options.sizes.every((size) => Number.isInteger(size) && size >= 1 && size <= 20_000)) throw new UsageError("--sizes takes whole numbers from 1 to 20000, with commas between.");
        break;
      case "--counters": {
        const given = value();
        if (given !== "on" && given !== "off") throw new UsageError("--counters takes on or off.");
        options.counters = given === "on";
        break;
      }
      case "--json":
        options.json = resolve(value());
        break;
      case "--idle":
        options.idleSeconds = Number(value());
        if (!(options.idleSeconds >= 1 && options.idleSeconds <= 3600)) throw new UsageError("--idle takes a number of seconds from 1 to 3600.");
        break;
      case "--scratch":
        options.scratch = resolve(value());
        break;
      case "--pid-notes":
        options.notes = resolve(value());
        break;
      case "--quick":
        options.quick = true;
        break;
      default:
        throw new UsageError(`${flag} is not an option of the harness.`);
    }
  }
  return options;
}

/** The commit the numbers are of, and whether the tree had changes on top of it. */
function commit(): string {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `${run(["rev-parse", "--short", "HEAD"])}${run(["status", "--porcelain"]) === "" ? "" : " with changes not committed"}`;
  } catch {
    return "not known";
  }
}

async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = read(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  // The harness's own process counts in `cost`; what the counters say there is not its report.
  setLogLevel("warn");
  const started = performance.now();
  const scratch = new Scratch({ parent: options.scratch, notes: options.notes, pollMs: options.quick ? 5 : 20 });
  const run: Run = {
    scratch,
    counters: options.counters,
    quick: options.quick,
    sizes: options.sizes ?? (options.quick ? [30] : [100, 1000, 5000]),
    idleSeconds: options.idleSeconds,
    tick: options.quick ? 0.1 : 1,
    say: (message) => console.error(`${((performance.now() - started) / 1000).toFixed(1).padStart(6)} s  ${message}`),
  };

  // Interrupted: the bridges are stopped and the folder removed before the harness ends.
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    console.error("interrupted: stopping the bridges");
    void scratch
      .dispose()
      .catch((error: Error) => console.error(error.message))
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  // Ending any other way with one still running: it is killed, not left.
  process.on("exit", () => scratch.killAll());

  const tables: Table[] = [];
  let failure: Error | undefined;
  try {
    for (const name of options.only) {
      const made = await scenarios[name](run);
      tables.push(...made);
      for (const one of made) console.log(`${markdown(one)}\n`);
    }
  } catch (error) {
    failure = error as Error;
  }
  try {
    await scratch.dispose();
  } catch (error) {
    failure ??= error as Error;
  }
  if (interrupted) return 130;

  const report = {
    taken: new Date().toISOString(),
    commit: commit(),
    node: process.version,
    mac: `${cpus()[0]?.model ?? "unknown"}, ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GB, ${arch()}, Darwin ${release()}`,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    options: { only: options.only, sizes: run.sizes, counters: options.counters, quick: options.quick, idle_seconds: options.idleSeconds, counters_tick_seconds: run.tick },
    // What the written lists are made of and what the turns send: with the commit, what a number is a number of.
    recipe,
    bridges_started: scratch.started,
    failed: failure?.message,
    tables,
  };
  console.log(`Run: commit ${report.commit}, Node ${report.node}, ${report.mac}; counters ${options.counters ? "on" : "off"}; ${scratch.started.length} bridges started and stopped; ${report.seconds} s.`);
  if (options.json) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify(report, null, 1)}\n`);
  }
  if (failure) {
    console.error(`the harness failed: ${failure.stack ?? failure.message}`);
    return 1;
  }
  return 0;
}

const code = await main(process.argv.slice(2));
// Once what was printed is out: into a pipe it may still be on its way, and the
// connections the harness's requests kept open would hold the process a few seconds.
process.stdout.write("\n", () => process.exit(code));
