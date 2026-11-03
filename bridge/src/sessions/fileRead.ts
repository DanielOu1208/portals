import { constants } from "node:fs";
import { lstat, open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { hostOS, machineWord, type HostOS } from "../platform.ts";

// A file on this Mac, read for a device (feature file_read, `file.read`): an image an
// agent wrote into its reply as `![caption](/path.png)`, or a file a tool row names,
// opened to read. Only ever:
//
// - a regular file (no folder, link at the end, device or pipe), every link on the way
//   resolved, anywhere the bridge's user can read (2026-10-27, for
//   images and then for files to read): who asks is a device signed in with the password,
//   another Mac of the net or the `portals` command, each of which can start an agent that
//   reads any file here anyway. A relative path goes from the real folder the thread works
//   in, the home folder or `/` too;
// - at most 15 MB for an image and 2 MB for text: a larger one is refused, with why;
// - text that is text (UTF-8, no NUL): anything else is refused as binary, unless it is
//   an image, which is answered as one.
//
// The file is opened by its real path without following a link anywhere in it (macOS's
// O_NOFOLLOW_ANY; on Linux, the path the kernel says it opened), and what was opened is
// checked to be the file that path names still, so a link swapped in between the check
// and the read, at the end or for a folder on the way, is not followed to a file other
// than the one whose path is given back, a folder, a device or a pipe.

/** What the device asks the file for. */
export type FilePurpose = "image" | "text";

export const imageReadLimit = 15 * 1024 * 1024;
export const textReadLimit = 2 * 1024 * 1024;

/** Why a file is not given, as `refused` says it. */
export type FileRefusal = "outside" | "missing" | "not_file" | "too_large" | "binary" | "not_image" | "unreadable";

interface Described {
  /** The file's name. */
  name: string;
  /** Its real path, links resolved; absent when it was refused before that was known. */
  path?: string;
}

export interface FileRefused extends Described {
  refused: FileRefusal;
  /** For the person: why it cannot be shown. */
  message: string;
}

export interface FileGiven extends Described {
  path: string;
  kind: "image" | "text";
  /** An image's type (`image/png`); absent for text. */
  type?: string;
  /** In bytes. */
  size: number;
  /** Changes when the file does: a device that holds this one sends it back as `unless`. */
  etag: string;
  /** Set, with neither `data` nor `text`, when the device holds the file as it is (`unless`). */
  unchanged?: true;
  /** An image's bytes, base64. */
  data?: string;
  /** A text file's text. */
  text?: string;
}

export type FileAnswer = FileGiven | FileRefused;

export interface FileReaderOptions {
  /** The home folder, for `~/…`; tests give another. */
  home?: string;
}

export interface FileRequest {
  /** Where the thread works; undefined for a thread with no folder at all. */
  cwd: string | undefined;
  /** As the agent wrote it: absolute, `~/…`, or relative to where the thread works, its own folder or not. */
  path: string;
  purpose: FilePurpose;
  /** The `etag` of the copy the device holds. */
  unless?: string;
}

/**
 * The sizes a BMP's second header (its DIB header, at byte 14) may have: BITMAPCOREHEADER,
 * BITMAPINFOHEADER, its V2 and V3, OS/2's short and long, BITMAPV4HEADER and V5. "BM" alone
 * is how text may start ("BMI is…", "BMW,320i"), so a BMP is known by both.
 */
const bmpHeaderSizes = new Set([12, 40, 52, 56, 64, 108, 124]);

/** How much of a file's start `imageType` is given: enough for a BMP's header sizes. */
const imageHeadLength = 32;

/** The images a reply may show, by what their bytes start with. */
const imageSignatures: { type: string; test: (head: Buffer) => boolean }[] = [
  { type: "image/png", test: (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", test: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  // The whole of its version, not "GIF8" alone, which text may start with too.
  { type: "image/gif", test: (head) => ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1")) },
  { type: "image/webp", test: (head) => head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP" },
  {
    type: "image/heic",
    test: (head) => head.subarray(4, 8).toString("latin1") === "ftyp" && ["heic", "heix", "mif1", "msf1", "heif", "hevc"].includes(head.subarray(8, 12).toString("latin1")),
  },
  { type: "image/bmp", test: (head) => head.length >= 18 && head.subarray(0, 2).toString("latin1") === "BM" && bmpHeaderSizes.has(head.readUInt32LE(14)) },
  { type: "image/tiff", test: (head) => ["II*\u0000", "MM\u0000*"].includes(head.subarray(0, 4).toString("latin1")) },
];

/** The image type of a file that starts with `head`, if it is one the app draws. */
export function imageType(head: Buffer): string | undefined {
  return imageSignatures.find((signature) => signature.test(head))?.type;
}

export class FileReader {
  private readonly home: string;

  constructor(options: FileReaderOptions = {}) {
    this.home = options.home ?? homedir();
  }

  async read(request: FileRequest): Promise<FileAnswer> {
    const written = request.path.trim();
    const name = basename(written) || written;
    const refuse = (refused: FileRefusal, message: string, path?: string): FileRefused => ({ name, ...(path ? { path } : {}), refused, message });
    if (written === "" || written.includes("\0")) return refuse("missing", "No file was named.");

    // Where a relative path starts, by its real path, as the agent's `..` goes: where the
    // thread works, even when that is no folder of its own (the home folder, `/`).
    const base = await workingFolder(request.cwd);
    const expanded = written === "~" || written.startsWith("~/") ? resolve(this.home, written.slice(2)) : written;
    if (!isAbsolute(expanded) && base === undefined) return refuse("outside", `${name} is not in a folder this thread works in.`);
    const asked = isAbsolute(expanded) ? resolve(expanded) : resolve(base!, expanded);

    let real: string;
    try {
      real = await realpath(asked);
    } catch {
      return refuse("missing", `${name} is not on this ${machineWord()} any more.`);
    }

    let handle;
    try {
      handle = await openUnfollowed(real);
    } catch {
      return refuse("unreadable", `${name} cannot be read.`, real);
    }
    try {
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile()) return refuse("not_file", `${name} is not a file.`, real);
      // The file opened is the one the path names now: a link put in its place, or in a
      // folder on the way to it, after the check above is not followed.
      const named = await lstat(real, { bigint: true }).catch(() => undefined);
      if (!named || named.ino !== stats.ino || named.dev !== stats.dev || (await realpath(real).catch(() => "")) !== real) {
        return refuse("unreadable", `${name} changed while it was read.`, real);
      }
      const size = Number(stats.size);
      const etag = `${stats.size}-${stats.mtimeNs}-${stats.ino}`;
      const head = Buffer.alloc(Math.min(imageHeadLength, size));
      if (head.length > 0) await handle.read(head, 0, head.length, 0);
      const type = imageType(head);
      if (request.purpose === "image" && type === undefined) return refuse("not_image", `${name} is not an image the app can show.`, real);

      const kind = type !== undefined ? "image" : "text";
      const limit = kind === "image" ? imageReadLimit : textReadLimit;
      if (size > limit) {
        return refuse("too_large", `${name} is ${megabytes(size)}, larger than the ${megabytes(limit)} the app shows.`, real);
      }
      const given: FileGiven = { name: basename(real), path: real, kind, ...(type ? { type } : {}), size, etag };
      if (request.unless !== undefined && request.unless === etag) return { ...given, unchanged: true };

      const bytes = Buffer.alloc(size);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      // Shorter than it was a moment ago: it is being written. What there is.
      const content = bytes.subarray(0, read);
      if (kind === "image") return { ...given, size: read, data: content.toString("base64") };
      const text = asText(content);
      if (text === undefined) return refuse("binary", `${name} is not text, so it cannot be shown.`, real);
      return { ...given, size: read, text };
    } finally {
      await handle.close();
    }
  }
}

/** A thread's folder by its real path; undefined for none, the home folder, `/`, or one gone (for `files.search`). */
export async function ownFolder(cwd: string | undefined, home = homedir()): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  const real = await realpath(cwd).catch(() => undefined);
  if (real === undefined || real === sep) return undefined;
  const realHome = await realpath(home).catch(() => home);
  return real === realHome ? undefined : real;
}

/** Where a thread works by its real path, its own folder or not (the home folder, `/`); undefined for none or one gone. */
async function workingFolder(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  return realpath(cwd).catch(() => undefined);
}

/** macOS's `O_NOFOLLOW_ANY` (sys/fcntl.h): no link anywhere in the path, not only at its end. Node does not name it. */
const noFollowAny = 0x20000000;

/**
 * Opens a real path to read it, through no link anywhere in the path, so a folder on the
 * way swapped for a link elsewhere after the path was resolved (and put back before the
 * check after the open) is refused rather than read: on macOS by `O_NOFOLLOW_ANY`; on
 * Linux, which has no such flag for open(2), by asking the kernel which path it opened
 * (`/proc/self/fd`), which is no longer `real` when a link was followed. Without /proc,
 * only a link at its end is refused there, and the check after the open stays. Never
 * waits on a pipe that nothing writes into.
 */
export async function openUnfollowed(real: string, os: HostOS = hostOS): Promise<FileHandle> {
  const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | (os === "macos" ? noFollowAny : constants.O_NOFOLLOW));
  if (os === "linux") {
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);
    if (opened !== undefined && opened !== real && !(await sameInOtherCase(opened, real, handle))) {
      await handle.close();
      throw Object.assign(new Error(`${real} was opened through a link, as ${opened}`), { code: "ELOOP" });
    }
  }
  return handle;
}

/**
 * Whether the kernel named the file opened in another case only, as a case-insensitive
 * file system does (vfat, exFAT, a casefolded ext4 folder): its name as first looked up,
 * where realpath(3) kept the case asked for. A link followed gives another path, not the
 * same in another case; and it is the file opened by that name.
 */
async function sameInOtherCase(opened: string, real: string, handle: FileHandle): Promise<boolean> {
  if (opened.toLowerCase() !== real.toLowerCase()) return false;
  const [named, open] = await Promise.all([lstat(opened, { bigint: true }).catch(() => undefined), handle.stat({ bigint: true })]);
  return named !== undefined && named.ino === open.ino && named.dev === open.dev;
}

/** UTF-8 text with no NUL in it, else undefined. A byte order mark at its start is left out. */
function asText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.startsWith("﻿") ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

function megabytes(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} MB`;
}
