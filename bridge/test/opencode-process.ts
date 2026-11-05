import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ServerLocator, type ServerOptions } from "../src/providers/opencode/server.ts";
import { onTestCleanup } from "./opencode-test.ts";

const kill = process.kill.bind(process);
const execute = childProcess.execFileSync;
interface FixtureIdentity { pid: number; group: number; start: string }
const stoppedFixtures = new Map<string, Promise<void>>();
const stoppedChildren = new WeakMap<ChildProcess, Promise<void>>();

function identity(pid: number): FixtureIdentity | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return null;
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return { pid, group: Number(fields[2]), start: `proc:${boot}:${fields[19]}` };
    }
    // Keep cleanup independent of the OS-read failures injected into product code.
    const output = execute("/bin/ps", ["-o", "stat=,pgid=,lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 250, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const match = /^\s*(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(output);
    return match && !match[1].startsWith("Z") ? { pid, group: Number(match[2]), start: `ps-utc:${match[3]}` } : null;
  } catch { return null; }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { kill(pid, 0); } catch { return; }
    await sleep(20);
  }
}

/** An orphan has no live ChildProcess handle: require its original identity. */
export function stopFixture(expected: FixtureIdentity | undefined): Promise<void> {
  if (!expected || !Number.isSafeInteger(expected.pid) || expected.pid <= 1 || expected.group !== expected.pid) return Promise.resolve();
  const key = `${expected.pid}:${expected.group}:${expected.start}`;
  let stopping = stoppedFixtures.get(key);
  if (!stopping) {
    stopping = (async () => {
      const deadline = Date.now() + 1000;
      for (;;) {
        const current = identity(expected.pid);
        if (current) {
          if (current.start !== expected.start || current.group !== expected.group) return;
          try { kill(-expected.group, "SIGKILL"); } catch { return; }
          return waitGone(expected.pid);
        }
        try { kill(expected.pid, 0); } catch { return; }
        if (Date.now() >= deadline) throw new Error("Could not verify the disposable OpenCode fixture for cleanup");
        await sleep(20);
      }
    })();
    stoppedFixtures.set(key, stopping);
  }
  return stopping;
}

/** Emergency cleanup must not depend on the shutdown operation being tested. */
export function stopFixtureChild(child: ChildProcess | null): Promise<void> {
  if (!child) return Promise.resolve();
  let stopping = stoppedChildren.get(child);
  if (!stopping) {
    stopping = (async () => {
      try {
        // With a live handle, an unreaped child's PID cannot have been reused.
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try { kill(-child.pid, "SIGKILL"); }
          catch { try { kill(child.pid, "SIGKILL"); } catch { return; } }
          await waitGone(child.pid);
        }
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        if (child.connected) child.disconnect();
      }
    })();
    stoppedChildren.set(child, stopping);
  }
  return stopping;
}

export function fixtureLocator(options: ServerOptions): ServerLocator {
  const locator = new ServerLocator(options);
  onTestCleanup(() => stopLocatorFixture(locator));
  return locator;
}

export function stopLocatorFixture(locator: ServerLocator): Promise<void> {
  return stopFixtureChild((locator as unknown as { child: ChildProcess | null }).child);
}

/** Model an unavailable OS read separately from a positively different identity. */
export function processReadFault(t: TestContext, pid: number, fault: (read: number) => "unreadable" | "different" | undefined): () => number {
  const execute = childProcess.execFileSync;
  let reads = 0;
  const mocked = t.mock.method(childProcess, "execFileSync", (...args: any[]) => {
    if (args[0] === "/bin/ps" && args[1]?.includes(String(pid)) && args[2]?.timeout <= 250) {
      const outcome = fault(++reads);
      if (outcome === "unreadable") throw Object.assign(new Error("process identity read timed out"), { code: "ETIMEDOUT" });
      if (outcome === "different") return `Ss ${pid} a-different-start-identity\n`;
    }
    return (execute as (...given: any[]) => unknown)(...args);
  });
  syncBuiltinESMExports();
  onTestCleanup(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return () => reads;
}
