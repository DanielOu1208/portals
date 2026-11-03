import "./environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { log, setLogLevel } from "../src/log.ts";
import { Registry } from "../src/sessions/registry.ts";
import { readStateFile, writeJSON } from "../src/store/jsonFile.ts";

setLogLevel("silent");

function folder(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "corrupt-name-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function mockLinks(t: TestContext, implementation: typeof fs.linkSync): void {
  t.mock.method(fs, "linkSync", implementation);
  syncMocks(t);
}

function syncMocks(t: TestContext): void {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("two recoveries in the same millisecond preserve every corrupt net file", () => {
  const preload = fileURLToPath(new URL("./fixtures/corrupt-same-ms.mjs", import.meta.url));
  const suite = fileURLToPath(new URL("./net.test.ts", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--import", preload, "--test",
    "--test-name-pattern=a net.json or net-own.json that cannot be used",
    suite,
  ], { env, encoding: "utf8", timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests 1/);
});

for (const copy of [false, true]) {
  test(`an aside collision retries without replacing the older evidence (${copy ? "copy" : "hard link"})`, (t) => {
    const home = folder(t);
    const path = join(home, "state.json");
    writeFileSync(path, "{ first corruption");
    writeFileSync(`${path}.bak`, '{"restored":true}');
    const recovered = readStateFile(path);
    assert.ok(recovered.aside);
    writeFileSync(recovered.aside, "older evidence");
    const warned = t.mock.method(log, "warn", () => undefined);
    if (copy) mockLinks(t, () => { throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" }); });

    writeJSON(path, recovered.found, { aside: recovered.aside });
    assert.equal(readFileSync(recovered.aside, "utf8"), "older evidence");
    const fresh = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-") && join(home, name) !== recovered.aside);
    assert.equal(fresh.length, 1);
    assert.equal(readFileSync(join(home, fresh[0]), "utf8"), "{ first corruption");
    assert.equal(warned.mock.calls.length, 1);
    assert.equal(warned.mock.calls[0].arguments[1]?.file, join(home, fresh[0]));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { restored: true });
    assert.equal(readFileSync(`${path}.bak`, "utf8"), '{"restored":true}');
  });
}

test("five occupied names leave the original corrupt file and backup intact", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ corrupt");
  writeFileSync(`${path}.bak`, '{"restored":true}');
  const recovered = readStateFile(path);
  const link = fs.linkSync;
  let attempts = 0;
  mockLinks(t, (source, target) => {
    attempts += 1;
    writeFileSync(target, `older evidence ${attempts}`, { flag: "wx" });
    link(source, target);
  });

  assert.throws(() => writeJSON(path, recovered.found, { aside: recovered.aside }), { code: "EEXIST" });
  assert.equal(attempts, 5);
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  assert.equal(readFileSync(`${path}.bak`, "utf8"), '{"restored":true}');
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 5);
  assert.deepEqual(kept.map(name => readFileSync(join(home, name), "utf8")).sort(), Array.from({ length: 5 }, (_, i) => `older evidence ${i + 1}`));
});

test("a failed quarantine rename leaves the source intact and removes its empty reservation", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ corrupt");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) throw Object.assign(new Error("disk failure"), { code: "EIO" });
    rename(from, to);
  });
  syncMocks(t);

  assert.throws(() => readStateFile(path), { code: "EIO" });
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 0);
  assert.equal(existsSync(`${path}.bak`), false);
});

test("an unreadable file with no usable backup can be quarantined without hard links or copying", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ unreadable corruption", { mode: 0o600 });
  fs.chmodSync(path, 0);
  assert.throws(() => readFileSync(path), { code: "EACCES" });
  mockLinks(t, () => { throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" }); });

  assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
  assert.equal(existsSync(path), false);
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  const aside = join(home, kept[0]);
  assert.equal(fs.statSync(aside).mode & 0o777, 0);
  fs.chmodSync(aside, 0o600);
  assert.equal(readFileSync(aside, "utf8"), "{ unreadable corruption");
});

test("a directory in place of an unusable state file is quarantined with all its contents", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  fs.mkdirSync(path);
  writeFileSync(join(path, "evidence"), "kept");

  assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
  assert.equal(existsSync(path), false);
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(home, kept[0], "evidence"), "utf8"), "kept");
});

test("quarantine moves a symlink itself and leaves its directory target untouched", (t) => {
  const home = folder(t);
  const target = join(home, "target");
  fs.mkdirSync(target);
  writeFileSync(join(target, "evidence"), "kept");
  const path = join(home, "state.json");
  fs.symlinkSync(target, path);

  assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
  assert.equal(existsSync(path), false);
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.lstatSync(join(home, kept[0])).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(join(home, kept[0])), target);
  assert.equal(readFileSync(join(target, "evidence"), "utf8"), "kept");
});

for (const directory of [false, true]) {
  test(`quarantine retries an occupied ${directory ? "directory" : "file"} reservation without overwriting it`, (t) => {
    const home = folder(t);
    const path = join(home, "state.json");
    if (directory) {
      fs.mkdirSync(path);
      writeFileSync(join(path, "evidence"), "new corruption");
    } else writeFileSync(path, "{ new corruption");
    let occupied: string | undefined;
    const write = fs.writeFileSync;
    const mkdir = fs.mkdirSync;
    if (directory) {
      t.mock.method(fs, "mkdirSync", ((target: fs.PathLike, options: fs.MakeDirectoryOptions) => {
        if (String(target).startsWith(`${path}.corrupt-`) && !occupied) {
          occupied = String(target);
          mkdir(target);
          write(join(occupied, "evidence"), "older evidence");
        }
        return mkdir(target, options);
      }) as typeof fs.mkdirSync);
    } else {
      t.mock.method(fs, "writeFileSync", ((target, data, options) => {
        if (String(target).startsWith(`${path}.corrupt-`) && !occupied) {
          occupied = String(target);
          write(target, "older evidence", { flag: "wx" });
        }
        return write(target, data, options);
      }) as typeof fs.writeFileSync);
    }
    syncMocks(t);

    assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
    assert.ok(occupied);
    assert.equal(readFileSync(directory ? join(occupied, "evidence") : occupied, "utf8"), "older evidence");
    const fresh = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-") && join(home, name) !== occupied);
    assert.equal(fresh.length, 1);
    assert.equal(readFileSync(directory ? join(home, fresh[0], "evidence") : join(home, fresh[0]), "utf8"), directory ? "new corruption" : "{ new corruption");
  });
}

test("five occupied quarantine reservations leave every older file and the source intact", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ corrupt");
  const write = fs.writeFileSync;
  let attempts = 0;
  t.mock.method(fs, "writeFileSync", ((target, data, options) => {
    if (String(target).startsWith(`${path}.corrupt-`)) {
      attempts += 1;
      write(target, `older evidence ${attempts}`, { flag: "wx" });
    }
    return write(target, data, options);
  }) as typeof fs.writeFileSync);
  syncMocks(t);

  assert.throws(() => readStateFile(path), { code: "EEXIST" });
  assert.equal(attempts, 5);
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.deepEqual(kept.map(name => readFileSync(join(home, name), "utf8")).sort(), Array.from({ length: 5 }, (_, i) => `older evidence ${i + 1}`));
});

test("quarantine preserves a replacement written just before the source is moved", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ old corruption");
  const replacement = '{"otherWriter":"new state"}';
  const rename = fs.renameSync;
  const link = fs.linkSync;
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    const temporary = join(home, "other-writer.tmp");
    writeFileSync(temporary, replacement);
    rename(temporary, path);
  };
  t.mock.method(fs, "linkSync", (from: fs.PathLike, to: fs.PathLike) => {
    link(from, to);
    if (String(from) === path) replace();
  });
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) replace();
    rename(from, to);
  });
  syncMocks(t);

  assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
  assert.equal(replaced, true);
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(home, kept[0]), "utf8"), replacement);
});

test("failed quarantine never cleans up a reservation replaced by another file", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ corrupt");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) {
      const temporary = join(home, "other-writer.tmp");
      writeFileSync(temporary, "other evidence");
      rename(temporary, to);
      throw Object.assign(new Error("rename failed"), { code: "EIO" });
    }
    rename(from, to);
  });
  syncMocks(t);

  assert.throws(() => readStateFile(path), { code: "EIO" });
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(home, kept[0]), "utf8"), "other evidence");
});

test("a leftover reservation does not block the next recovery or hide the original rename failure", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  writeFileSync(path, "{ corrupt");
  const rename = fs.renameSync;
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) throw Object.assign(new Error("rename failed"), { code: "EIO" });
    rename(from, to);
  });
  t.mock.method(fs, "unlinkSync", (target: fs.PathLike) => {
    if (String(target).startsWith(`${path}.corrupt-`)) throw Object.assign(new Error("cleanup failed"), { code: "EPERM" });
    unlink(target);
  });
  syncMocks(t);

  assert.throws(() => readStateFile(path), { code: "EIO" });
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  t.mock.restoreAll();
  syncBuiltinESMExports();
  assert.deepEqual(readStateFile(path), { found: {}, fromBackup: false });
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.deepEqual(kept.map(name => readFileSync(join(home, name), "utf8")).sort(), ["", "{ corrupt"]);
});

test("failed directory quarantine never recursively removes evidence added to its reservation", (t) => {
  const home = folder(t);
  const path = join(home, "state.json");
  fs.mkdirSync(path);
  writeFileSync(join(path, "source"), "original evidence");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === path) {
      writeFileSync(join(String(to), "added"), "other evidence");
      throw Object.assign(new Error("rename failed"), { code: "EIO" });
    }
    rename(from, to);
  });
  syncMocks(t);

  assert.throws(() => readStateFile(path), { code: "EIO" });
  assert.equal(readFileSync(join(path, "source"), "utf8"), "original evidence");
  const kept = readdirSync(home).filter(name => name.startsWith("state.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(home, kept[0], "added"), "utf8"), "other evidence");
});

test("an exhausted aside collision fails a restore like an I/O error, leaving its backup for the next start", (t) => {
  const home = folder(t);
  const path = join(home, "threads.json");
  const record = { id: "t1", agent: "fake", cwd: home, title: "Kept", model: "fake-1", provider: "fake", reasoningEffort: "", createdAt: 1, updatedAt: 1, origin: "phone", revision: 5 };
  const backup = JSON.stringify({ list: "held", revision: 5, threads: [record] });
  writeFileSync(path, "{ corrupt");
  writeFileSync(`${path}.bak`, backup);
  const errors = t.mock.method(log, "error", () => undefined);
  const link = fs.linkSync;
  let attempts = 0;
  mockLinks(t, (source, target) => {
    attempts += 1;
    writeFileSync(target, `older evidence ${attempts}`, { flag: "wx" });
    link(source, target);
  });

  assert.throws(() => new Registry(path), { code: "EEXIST" });
  assert.equal(attempts, 5);
  assert.equal(errors.mock.calls.length, 1);
  assert.match(String(errors.mock.calls[0].arguments[0]), /threads\.json could not be used/);
  assert.equal(readFileSync(path, "utf8"), "{ corrupt");
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
  t.mock.restoreAll();
  syncBuiltinESMExports();

  const registry = new Registry(path);
  assert.deepEqual(registry.all(), [record]);
  assert.notEqual(registry.list, "held");
  assert.equal(registry.revision, 6);
  assert.equal(readFileSync(`${path}.bak`, "utf8"), backup);
  assert.equal(readdirSync(home).filter(name => name.startsWith("threads.json.corrupt-")).length, 6);
});
