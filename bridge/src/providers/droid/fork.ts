import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { droidSessionId, object, snapshotField, type StoredDroidSession } from "./desk.ts";
import type { DroidSdk } from "./sdk.ts";
import { settledDroidSnapshot } from "./pending.ts";

/** `started`: when its bridge's process started (`processStart`), which with `pid` says which process owns it. */
interface Manifest { id: string; token: string; cwd: string; pid: number; started?: string }
const snapshotId = /^706f7274-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A marked throwaway source, never a load of the person's original conversation. */
export class DroidForks {
  private readonly manifests: string;
  private readonly sessions: string;
  /** When this process started (`processStart`), read at its first fork. */
  private started: string | undefined;
  constructor(directory: string, home: string) {
    this.manifests = join(directory, "fork-snapshots");
    this.sessions = join(home, ".factory", "sessions");
  }

  async copy(source: StoredDroidSession, title: string, sdk: DroidSdk): Promise<string> {
    if (!sdk.fork) throw new Error("This Droid connection cannot fork sessions.");
    this.started ??= processStart(process.pid);
    const manifest: Manifest = { id: `706f7274${randomUUID().slice(8)}`, token: randomUUID(), cwd: source.cwd, pid: process.pid,
      ...(this.started ? { started: this.started } : {}) };
    mkdirSync(this.manifests, { recursive: true, mode: 0o700 });
    const note = join(this.manifests, `${manifest.id}.json`);
    // Written before a session copy can exist: a crash always leaves its ownership record.
    writeFileSync(note, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    const folder = join(this.sessions, "btw");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const path = join(folder, `${manifest.id}.jsonl`);
    try {
      const text = readFileSync(source.path, "utf8");
      const newline = text.indexOf("\n");
      const header = object(JSON.parse(text.slice(0, newline)));
      if (newline < 0 || header?.type !== "session_start" || (header.id ?? header.sessionId) !== source.id) throw new Error("Droid's source conversation changed before it could be copied.");
      const snapshot = `${JSON.stringify({ ...header, id: manifest.id, [snapshotField]: manifest.token })}\n${text.slice(newline + 1)}`;
      writeFileSync(path, settledDroidSnapshot(snapshot), { flag: "wx", mode: 0o600 });
      try {
        writeFileSync(join(folder, `${manifest.id}.settings.json`), readFileSync(source.path.replace(/\.jsonl$/, ".settings.json")), { flag: "wx", mode: 0o600 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const runtime = join(this.manifests, `${manifest.id}.settings.json`);
      writeFileSync(runtime, JSON.stringify({ hooks: { hooksDisabled: true } }), { flag: "wx", mode: 0o600 });
      const id = await sdk.fork(manifest.id, source.cwd, title, runtime);
      if (!droidSessionId.test(id) || id === source.id || id === manifest.id) throw new Error("Droid did not make a separate session.");
      // Native forking copies unknown header fields too. The real fork is no snapshot,
      // and its parent is the original, not the bridge's throwaway source.
      const made = join(this.sessions, source.cwd.replaceAll("/", "-"), `${id}.jsonl`);
      // Only a header with this id and this snapshot's token proves the file is the
      // bridge's copy. Anything else (no token, another, a header that cannot be read) may
      // be anyone's: it is refused, and left as it is.
      let fork = "", split = -1, first: Record<string, unknown> | undefined;
      try {
        fork = readFileSync(made, "utf8");
        split = fork.indexOf("\n");
        first = object(JSON.parse(fork.slice(0, split)));
      } catch { first = undefined; }
      if (split < 0 || !first || first.id !== id || first[snapshotField] !== manifest.token) throw new Error("Droid's fork could not be verified.");
      delete first[snapshotField];
      first.parent = source.id;
      // Written whole beside it, under a name Droid does not list, then put in its place at
      // once: until then the fork on disk keeps its token, so no one else can take it up,
      // and a failure leaves it the bridge's proven copy, which `remove` then deletes. Once
      // it is in place, it is a session of its own, and nothing here deletes it.
      const temporary = join(dirname(made), `.${id}.${process.pid}.tmp`);
      // Only a file this call made is taken away again: one already there under that name
      // (`wx` refuses it) is not proven the bridge's, and is left as it is.
      let created = false;
      try {
        const descriptor = openSync(temporary, "wx", 0o600);
        created = true;
        try {
          writeFileSync(descriptor, `${JSON.stringify(first)}\n${fork.slice(split + 1)}`);
          fsyncSync(descriptor);
        } finally { closeSync(descriptor); }
        renameSync(temporary, made);
      } catch (error) {
        if (created) try { unlinkSync(temporary); } catch { /* Already put in place. */ }
        throw error;
      }
      return id;
    } finally { this.remove(manifest, note); }
  }

  /** Startup only: no other live bridge's snapshot is removed. */
  sweep(): void {
    let names: string[];
    try { names = readdirSync(this.manifests); } catch { return; }
    for (const name of names) {
      if (!snapshotId.test(name.replace(/\.json$/, "")) || !name.endsWith(".json")) continue;
      const path = join(this.manifests, name);
      try {
        const value = object(JSON.parse(readFileSync(path, "utf8")));
        if (!value || !snapshotId.test(String(value.id)) || name !== `${value.id}.json` || typeof value.token !== "string" ||
          typeof value.cwd !== "string" || !value.cwd.startsWith("/") || typeof value.pid !== "number") continue;
        let alive = true;
        try { process.kill(value.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; alive = false; }
        // A pid running now may be another process's, the owner having ended: it is the
        // owner only when it started when the owner did. One that cannot be told is kept:
        // no start kept, one kept in a form this bridge does not read the same way (before
        // the form was named), or a start that cannot be read now.
        if (alive && (typeof value.started !== "string" || !startForm.test(value.started) || [undefined, value.started].includes(processStart(value.pid)))) continue;
        this.remove(value as unknown as Manifest, path);
      } catch { /* An unreadable ownership record is never guessed at. */ }
    }
  }

  /**
   * Deletes the sessions Droid made from this snapshot that still carry its token: the
   * token, a random one of the bridge's in the header Droid copies, proves each is a copy
   * of the snapshot and of nothing of the person's. Only files changed since the record
   * was written are looked at. False when one could not be deleted, or when a recent file
   * could not be looked at (its header unreadable, or still being written): it may be
   * such a copy, and the record is kept so a later sweep can tell.
   */
  private removeOutputs(manifest: Manifest, note: string): boolean {
    const folder = join(this.sessions, manifest.cwd.replaceAll("/", "-"));
    let since = 0;
    try { since = lstatSync(note).mtimeMs - 2000; } catch { /* Every file is looked at. */ }
    let names: string[];
    try { names = readdirSync(folder); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    let removed = true;
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || !droidSessionId.test(id) || id === manifest.id) continue;
      const path = join(folder, name);
      let info: ReturnType<typeof lstatSync>;
      try { info = lstatSync(path); } catch (error) {
        // Gone since it was listed: not there to be anyone's.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") removed = false;
        continue;
      }
      // Droid writes its sessions as files; one older than the record is no copy of it.
      if (!info.isFile() || info.mtimeMs < since) continue;
      let first: Record<string, unknown> | undefined;
      try { first = object(JSON.parse(firstLine(path))); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        first = undefined;
      }
      if (!first) { removed = false; continue; }
      if (first.id !== id || first[snapshotField] !== manifest.token) continue;
      discardFork(path);
      try { lstatSync(path); removed = false; } catch { /* Gone. */ }
    }
    return removed;
  }

  private remove(manifest: Manifest, note: string): void {
    const path = join(this.sessions, "btw", `${manifest.id}.jsonl`);
    try {
      if (!lstatSync(path).isFile()) return;
      const first = object(JSON.parse(readFileSync(path, "utf8").split("\n")[0]));
      if (first?.id !== manifest.id || first[snapshotField] !== manifest.token) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    // Droid's copy of the snapshot, should it have been written without the bridge
    // learning of it (its answer lost, or the bridge stopped before the copy was made a
    // fork of its own), goes first: the record is what lets it be found again.
    if (!this.removeOutputs(manifest, note)) return;
    const sidecars = [dirname(path), join(this.sessions, manifest.cwd.replaceAll("/", "-"))]
      .flatMap((folder) => [".settings.json", ".settings.json.bak"].map((suffix) => join(folder, `${manifest.id}${suffix}`)));
    // Ownership is retained until all sidecars are gone, with the marked JSONL last.
    for (const file of [...sidecars, join(this.manifests, `${manifest.id}.settings.json`), path, note]) {
      try {
        if (!lstatSync(file).isFile()) return;
        unlinkSync(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    }
  }
}

/**
 * Deletes a fork Droid made for the bridge, which no thread has (a failure after it was
 * made): its conversation and its settings files. Only what is there is deleted.
 */
export function discardFork(path: string): void {
  for (const file of [path.replace(/\.jsonl$/, ".settings.json"), path.replace(/\.jsonl$/, ".settings.json.bak"), path]) {
    try {
      if (lstatSync(file).isFile()) unlinkSync(file);
    } catch { /* Not there, or not deletable: nothing else to do for it. */ }
  }
}

/** A file's first line, read only as far as a session header can reach (1 MiB). */
function firstLine(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const text = buffer.subarray(0, readSync(descriptor, buffer, 0, buffer.length, 0)).toString("utf8");
    const end = text.indexOf("\n");
    return end < 0 ? text : text.slice(0, end);
  } finally { closeSync(descriptor); }
}

/** The forms of a start identity (`processStart`) that read the same in every bridge. */
const startForm = /^(?:proc-ticks|ps-lstart-utc):./;

/**
 * When the process `pid` started, as the system says it, named by its form (Linux: its
 * start in clock ticks since boot; macOS: ps's start time, to the second, in UTC and the C
 * locale, so that bridges run with other time zones or languages read it alike): with the
 * pid, which process it is, as a pid alone is reused once its process ends. Undefined when
 * it cannot be read.
 */
export function processStart(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The fields after the command's name, which may itself hold spaces and brackets: the 22nd field is the 20th of these.
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks ? `proc-ticks:${ticks}` : undefined;
    }
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    }).trim();
    return started ? `ps-lstart-utc:${started}` : undefined;
  } catch { return undefined; }
}
