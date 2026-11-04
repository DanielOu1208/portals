import "./environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LaunchAgent, plist } from "../src/setup/launchAgent.ts";
import { replaceDefinition, specFromPlist, specFromUnit } from "../src/setup/serviceDefinition.ts";
import type { ServiceSpec } from "../src/setup/service.ts";
import type { System } from "../src/setup/system.ts";
import { SystemdService, unit } from "../src/setup/systemd.ts";

const spec: ServiceSpec = {
  label: "org.example.portals.bridge.custom",
  node: '/custom "node" & tools/node',
  script: "/custom app/50%/$bridge/dist/main.js",
  workingDirectory: "/custom app/50%/$bridge",
  path: "/custom/bin:/other/bin",
  log: "/custom logs/bridge & output.log",
  environment: { PORTALS_BRIDGE_HOME: "/custom home", CUSTOM: 'a=b "c" \\ d & <e>' },
};

for (const [name, render, parse] of [["plist", plist, specFromPlist], ["unit", unit, specFromUnit]] as const) {
  test(`${name}: regeneration preserves the installed node, paths and environment, not the updater's`, () => {
    assert.deepEqual(parse(render(spec), spec.label), spec);
    assert.equal(render(parse(render(spec), spec.label)), render(spec));
  });
}

test("systemd whitespace around sections, keys and values preserves the installed environment", () => {
  const text = unit(spec).replace("[Service]", "  [Service]  ").replaceAll("Environment=", "  Environment = ");
  assert.deepEqual(specFromUnit(text, spec.label), spec);
});

test("unsupported service commands and settings fail before replacing anything", () => {
  assert.throws(() => specFromPlist(plist(spec).replace("</array>", "<string>extra</string></array>"), spec.label), /unsupported command/);
  assert.throws(() => specFromPlist(plist(spec).replace("<key>PATH</key>", "<key>OTHER</key>"), spec.label), /no PATH/);
  assert.throws(() => specFromUnit(unit(spec).replace("WorkingDirectory=", "WorkingDirectory=%h"), spec.label), /specifiers/);
  assert.throws(() => specFromUnit(unit(spec).replace("ExecStart=:", "ExecStart="), spec.label), /unsupported command/);
  assert.throws(() => specFromUnit(unit(spec).replace("[Service]", '[Service]\n  Environment = "CUSTOM=old"\n  Environment = '), spec.label), /resets its environment/);
});

test("atomic replacement keeps a backup until commit, preserves permissions, and is a no-op when unchanged", async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "service");
  fs.writeFileSync(file, "before", { mode: 0o640 });
  let reloads = 0;
  const reload = async () => { reloads++; };
  const unchanged = await replaceDefinition(file, "before", reload);
  assert.equal(unchanged.changed, false);
  assert.equal(reloads, 0);
  assert.deepEqual(fs.readdirSync(folder), ["service"]);
  const changed = await replaceDefinition(file, "after", reload);
  assert.equal(changed.changed, true);
  assert.equal(reloads, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const backup = fs.readdirSync(folder).find((name) => name !== "service")!;
  assert.equal(fs.readFileSync(join(folder, backup, "previous"), "utf8"), "before");
  await changed.rollback();
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.equal(reloads, 2);
  assert.deepEqual(fs.readdirSync(folder), ["service"]);
  const again = await replaceDefinition(file, "after", reload);
  again.commit();
  assert.deepEqual(fs.readdirSync(folder), ["service"]);
});

for (const rollback of [false, true]) {
  test(`${rollback ? "rollback" : "replacement"} preserves ACL restrictions on a service definition`, { skip: process.platform !== "darwin" }, async (t) => {
    const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    fs.chmodSync(folder, 0o755);
    const file = join(folder, "service");
    fs.writeFileSync(file, "FAKE_SECRET=before", { mode: 0o644 });
    const acl = spawnSync("/bin/chmod", ["+a", "user:nobody deny read", file], { encoding: "utf8" });
    assert.equal(acl.status, 0, acl.stderr);
    const restrictions = (path = file) => {
      const listing = spawnSync("/bin/ls", ["-lde", path], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      return listing.stdout.split("\n").filter((line) => /^\s*\d+:/.test(line));
    };
    const before = restrictions();
    assert.ok(before.some((line) => line.includes("user:nobody deny read")));
    const inode = fs.statSync(file).ino;
    const update = await replaceDefinition(file, "FAKE_SECRET=after");
    const backupFolder = fs.readdirSync(folder).find((name) => name.startsWith(".portals-service-update-"))!;
    const backup = join(folder, backupFolder, "previous");
    assert.equal(fs.statSync(backup).ino, inode);
    assert.deepEqual(restrictions(backup), before);
    if (rollback) await update.rollback();
    assert.deepEqual(restrictions(), before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(file, "utf8"), rollback ? "FAKE_SECRET=before" : "FAKE_SECRET=after");
    if (rollback) assert.equal(fs.statSync(file).ino, inode);
    update.commit();
  });
}

test("read-only definitions retain their mode through replacement and rollback", async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "service");
  fs.writeFileSync(file, "before", { mode: 0o444 });
  const inode = fs.statSync(file).ino;
  const update = await replaceDefinition(file, "after");
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  await update.rollback();
  assert.equal(fs.statSync(file).mode & 0o777, 0o444);
  assert.equal(fs.statSync(file).ino, inode);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
});

test("staging is private before copying a definition from a directory with inheritable ACL grants", { skip: process.platform !== "darwin" }, async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const grant = spawnSync("/bin/chmod", ["+a", "user:nobody allow read,execute,file_inherit,directory_inherit", folder], { encoding: "utf8" });
  assert.equal(grant.status, 0, grant.stderr);
  const file = join(folder, "service");
  fs.writeFileSync(file, "FAKE_SECRET=before");
  const open = fs.openSync;
  let inspected = false;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof open>) => {
    if (String(args[0]).endsWith("/next")) {
      const staging = join(String(args[0]), "..");
      const listing = spawnSync("/bin/ls", ["-lde", staging], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      assert.doesNotMatch(listing.stdout, /user:nobody/);
      assert.equal(fs.statSync(staging).mode & 0o777, 0o700);
      inspected = true;
    }
    return Reflect.apply(open, fs, args);
  });
  const update = await replaceDefinition(file, "FAKE_SECRET=after");
  assert.ok(inspected);
  update.commit();
});

for (const operation of ["writeFileSync", "renameSync"] as const) {
  test(`a failed ${operation} leaves the previous definition intact`, async (t) => {
    const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const file = join(folder, "service");
    fs.writeFileSync(file, "before");
    const original = fs[operation];
    const mock = t.mock.method(fs, operation, (...args: unknown[]) => {
      if (operation === "writeFileSync" || String(args[0]).endsWith("/next")) throw new Error("disk failure");
      return Reflect.apply(original, fs, args);
    });
    try {
      await assert.rejects(replaceDefinition(file, "after"), /disk failure/);
    } finally {
      mock.mock.restore();
    }
    assert.equal(fs.readFileSync(file, "utf8"), "before");
    assert.deepEqual(fs.readdirSync(folder), ["service"]);
  });
}

test("a failed daemon-reload restores the old unit and reloads it without stopping the running service", async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "service");
  fs.writeFileSync(file, "before");
  const seen: string[] = [];
  await assert.rejects(replaceDefinition(file, "after", async () => {
    seen.push(fs.readFileSync(file, "utf8"));
    if (seen.length === 1) throw new Error("reload failure");
  }), /reload failure/);
  assert.deepEqual(seen, ["after", "before"]);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.deepEqual(fs.readdirSync(folder), ["service"]);
});

test("a failed recovery reports both reload errors and keeps the previous definition's backup", async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "service");
  fs.writeFileSync(file, "before");
  const errors = [new Error("reload failed"), new Error("recovery failed")];
  let reloads = 0;
  await assert.rejects(replaceDefinition(file, "after", async () => { throw errors[reloads++]; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], errors[0]);
    assert.equal(error.errors[1].cause, errors[1]);
    assert.match(error.message, /Could not restore.*backup/);
    return true;
  });
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  const backup = fs.readdirSync(folder).find((name) => name !== "service")!;
  assert.equal(fs.readFileSync(join(folder, backup, "previous"), "utf8"), "before");
});

test("rollback after a restart failure reports a failed recovery reload and its retained backup", async (t) => {
  const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "service");
  fs.writeFileSync(file, "before");
  let reloads = 0;
  const update = await replaceDefinition(file, "after", async () => {
    if (++reloads === 2) throw new Error("recovery reload failed");
  });
  const backup = fs.readdirSync(folder).find((name) => name !== "service")!;
  await assert.rejects(update.rollback(), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(join(folder, backup, "previous")));
    assert.match(error.message, /recovery reload failed/);
    return true;
  });
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.equal(fs.readFileSync(join(folder, backup, "previous"), "utf8"), "before");
});

for (const os of ["macos", "linux"] as const) {
  test(`${os}: changed definitions use the current template, with only a safe reload, and unchanged ones do nothing`, async (t) => {
    const folder = fs.mkdtempSync(join(tmpdir(), "portals-definition-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const calls: string[][] = [];
    const system: System = {
      uid: 501, which: () => "/fake/systemctl",
      async run(_program, args) { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
    };
    const service = os === "macos" ? new LaunchAgent(system, spec.label, folder) : new SystemdService(system, spec.label, folder);
    const render = os === "macos" ? plist : unit;
    const current = render(spec);
    const old = current.replace(os === "macos" ? "<key>KeepAlive</key><true/>" : "TimeoutStopSec=20", os === "macos" ? "<key>KeepAlive</key><false/>" : "TimeoutStopSec=10");
    fs.writeFileSync(service.file, old);
    const update = await service.refreshDefinition();
    assert.equal(update.changed, true);
    assert.equal(fs.readFileSync(service.file, "utf8"), current);
    assert.deepEqual(calls, os === "macos" ? [] : [["--user", "daemon-reload"]]);
    update.commit();
    calls.length = 0;
    const unchanged = await service.refreshDefinition();
    assert.equal(unchanged.changed, false);
    assert.deepEqual(calls, []);
  });
}
