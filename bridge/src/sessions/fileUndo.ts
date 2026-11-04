import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileRewindResult } from "../providers/types.ts";

export class FileUndoRefused extends Error {}

interface Preview {
  id: string;
  owner: object;
  checkpoint: string;
  expires: number;
  files: string[];
  signatures: string[];
  insertions?: number;
  deletions?: number;
}

type Rewind = (checkpoint: string, dryRun: boolean) => Promise<FileRewindResult>;
const previewLifetime = 60_000;
const fileLimit = 16 * 1024 * 1024;
const totalLimit = 64 * 1024 * 1024;

/** Single-use confirmations of an exact native preview and the files the person saw. */
export class FileUndo {
  private readonly previews = new Map<string, Preview>();

  async preview(owner: object, checkpoint: string, cwd: string, rewind: Rewind) {
    this.prune();
    for (const [id, preview] of this.previews) if (preview.owner === owner) this.previews.delete(id);
    const result = await rewind(checkpoint, true);
    const files = this.files(result, cwd);
    if (files.length === 0) throw new FileUndoRefused("There are no tracked file changes to undo.");
    const preview: Preview = {
      id: randomUUID(), owner, checkpoint, expires: Date.now() + previewLifetime,
      files, signatures: signatures(files, cwd),
      insertions: count(result.insertions), deletions: count(result.deletions),
    };
    this.previews.set(preview.id, preview);
    return {
      preview_id: preview.id, files, expires_at: preview.expires / 1000,
      ...(preview.insertions !== undefined ? { insertions: preview.insertions } : {}),
      ...(preview.deletions !== undefined ? { deletions: preview.deletions } : {}),
    };
  }

  async undo(owner: object, id: string, cwd: string, rewind: Rewind) {
    const preview = this.previews.get(id);
    if (!preview || preview.owner !== owner) throw new FileUndoRefused("This file preview is no longer available. Refresh it before confirming.");
    // A confirmation is consumed even when revalidation or the native restore fails.
    this.previews.delete(id);
    if (preview.expires <= Date.now()) throw new FileUndoRefused("This file preview expired. Refresh it before confirming.");
    const fresh = await rewind(preview.checkpoint, true);
    const files = this.files(fresh, cwd);
    if (!equal(files, preview.files) || count(fresh.insertions) !== preview.insertions || count(fresh.deletions) !== preview.deletions || !equal(signatures(files, cwd), preview.signatures)) {
      throw new FileUndoRefused("The files changed after this preview. Refresh it and review the changes again.");
    }
    const result = await rewind(preview.checkpoint, false);
    const skipped = count(result.skippedLinks) ?? 0;
    if (result.canRewind !== true || (result.skippedLinks !== undefined && count(result.skippedLinks) === undefined) || skipped > 0) return { restored: false, skipped_links: skipped };
    // Native restore can be partial. Only report success when its next preview says
    // explicitly that no tracked differences remain.
    try {
      const remaining = await rewind(preview.checkpoint, true);
      return { restored: remaining.canRewind === true && Array.isArray(remaining.filesChanged) && remaining.filesChanged.length === 0 && (remaining.skippedLinks === undefined || remaining.skippedLinks === 0), skipped_links: skipped };
    } catch {
      return { restored: false, skipped_links: skipped };
    }
  }

  private files(result: FileRewindResult, cwd: string): string[] {
    if (result.canRewind !== true) throw new FileUndoRefused(result.error || "The agent cannot restore this file checkpoint.");
    const invalidFiles = !Array.isArray(result.filesChanged) || result.filesChanged.some((file) => typeof file !== "string" || file.length === 0);
    const invalidCounts = (result.insertions !== undefined && count(result.insertions) === undefined) || (result.deletions !== undefined && count(result.deletions) === undefined);
    if (invalidFiles || invalidCounts || (result.skippedLinks !== undefined && result.skippedLinks !== 0)) throw new FileUndoRefused("The agent did not provide a safe file preview.");
    const changed = result.filesChanged!;
    if (changed.length > 100) throw new FileUndoRefused("This restore changes too many files to preview safely.");
    return [...new Set(changed.map((file) => isAbsolute(file) ? resolve(file) : resolve(cwd, file)))].sort();
  }

  private prune(): void {
    for (const [id, preview] of this.previews) if (preview.expires <= Date.now()) this.previews.delete(id);
    while (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function equal(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function signatures(files: readonly string[], cwd: string): string[] {
  let total = 0;
  try {
    const root = realpathSync(cwd);
    return files.map((file) => {
      const path = relative(root, file);
      if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || realpathSync(dirname(file)) !== dirname(file)) throw new FileUndoRefused("This restore includes a file outside the thread's folder or through a link.");
      let stat;
      try { stat = lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
      if (!stat.isFile() || stat.nlink !== 1) throw new FileUndoRefused("Linked files and special files cannot be restored here.");
      total += stat.size;
      if (stat.size > fileLimit || total > totalLimit) throw new FileUndoRefused("These files are too large to verify safely before restoring.");
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(descriptor, { bigint: true });
        if (before.size !== BigInt(stat.size) || before.ino !== BigInt(stat.ino) || before.nlink !== 1n || !before.isFile()) throw new FileUndoRefused("A file changed while its preview was being checked. Refresh the preview.");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
          if (read === 0) break;
          offset += read;
        }
        const after = fstatSync(descriptor, { bigint: true });
        if (offset !== bytes.length || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw new FileUndoRefused("A file changed while its preview was being checked. Refresh the preview.");
        return `${after.dev}:${after.ino}:${after.mode}:${after.size}:${after.mtimeNs}:${after.ctimeNs}:${createHash("sha256").update(bytes).digest("hex")}`;
      } finally { closeSync(descriptor); }
    });
  } catch (error) {
    if (error instanceof FileUndoRefused) throw error;
    throw new FileUndoRefused("A file could not be checked safely. Refresh the preview before restoring.");
  }
}
