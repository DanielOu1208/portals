import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageInput, QueuePlacement } from "../providers/types.ts";
import { readJSON, writeJSON } from "../store/jsonFile.ts";
import { failedKept, type FailedMessage } from "./failed.ts";

// The messages waiting for a running turn to end (feature `queue`), kept on disk while
// they wait: `state/waiting/<thread>.json`, and each one's images beside it in
// `state/waiting/<thread>/`. A message a device was told is queued is the bridge's to
// send, so one that waits when the bridge stops, or is stopped, still has its turn when
// the bridge starts again. A thread with nothing waiting has no file.
//
// Each change writes the thread's list whole, in the step that changes the list: a
// message that left it to open its turn is gone from the file before its turn starts, so
// it is never sent twice.
//
// After them, the file keeps the thread's latest messages that failed without reaching
// the agent (src/sessions/failed.ts), never sent, shown failed once the thread is loaded
// again: `{"failed":{"text","error","at","turn"}}`, with no id or text of its own, which a bridge
// from before them skips. A message that fails leaves the list and joins those in one
// write, so a bridge stopped at any moment neither sends it nor loses it.

/** A message waiting, as the session keeps it. */
export interface WaitingMessage {
  id: string;
  /** As the agent is sent it, with the paths of its files after it. */
  text: string;
  images: ImageInput[];
  files?: string[];
  /** The files it mentions (feature file_mentions), relative to the thread's folder. */
  mentions?: string[];
  fleet?: boolean;
  /** Steered into a turn that ended before the agent took it: shown there already. */
  resent?: boolean;
  /** For one `resent`: the agent surely never had it, so a conversation read back from the agent does not have it. */
  refused?: boolean;
  placement?: QueuePlacement;
  requestId?: string;
  failure?: string;
  failedRequestId?: string;
  /** The ids it was handed to the agent under and taken back from it with (Droid's own queue). */
  takenBackRequestIds?: string[];
  messageID?: string;
  /** The answers given on a card (feature async_questions): their row's id, which the message is marked with. */
  cardAnswer?: string;
}

/** One message in the thread's file: its images are named, and kept beside it. */
interface Stored {
  id: string;
  text: string;
  images?: { filename: string; file: string }[];
  files?: string[];
  mentions?: string[];
  fleet?: boolean;
  resent?: boolean;
  refused?: boolean;
  placement?: QueuePlacement;
  requestId?: string;
  failure?: string;
  failedRequestId?: string;
  takenBackRequestIds?: string[];
  messageID?: string;
  cardAnswer?: string;
}

export class WaitingStore {
  private readonly folder: string;
  /** The file each image waiting is kept in, once written: each is written once, under a name of its own. */
  private readonly written = new WeakMap<ImageInput, string>();

  /** `folder`: `state/waiting`. */
  constructor(folder: string) {
    this.folder = folder;
  }

  /** The threads that have messages waiting on disk (not those that only keep failed ones). */
  threads(): string[] {
    if (!existsSync(this.folder)) return [];
    return readdirSync(this.folder)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((thread) => this.read(thread).length > 0);
  }

  /** The messages a thread keeps that failed without reaching the agent, oldest first; an entry that cannot be read costs only itself. */
  readFailed(thread: string): FailedMessage[] {
    const stored = readJSON<unknown>(this.file(thread), []);
    if (!Array.isArray(stored)) return [];
    const failed: FailedMessage[] = [];
    for (const entry of stored as { failed?: Partial<FailedMessage> }[]) {
      const message = entry?.failed;
      if (typeof message?.text !== "string" || typeof message.error !== "string" || typeof message.at !== "number" || !Number.isFinite(message.at)) continue;
      const kept: FailedMessage = { text: message.text, error: message.error, at: message.at };
      if (message.turn === null || typeof message.turn === "string") kept.turn = message.turn;
      if (typeof message.requestId === "string") kept.requestId = message.requestId;
      if (typeof message.messageID === "string") kept.messageID = message.messageID;
      failed.push(kept);
    }
    return failed;
  }

  /** What a thread had waiting, oldest first; an entry that cannot be read costs only itself. */
  read(thread: string): WaitingMessage[] {
    const stored = readJSON<unknown>(this.file(thread), []);
    if (!Array.isArray(stored)) return [];
    const messages: WaitingMessage[] = [];
    for (const entry of stored as Partial<Stored>[]) {
      if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") continue;
      const images: ImageInput[] = [];
      for (const image of Array.isArray(entry.images) ? entry.images : []) {
        try {
          const input: ImageInput = { filename: image.filename, data: readFileSync(join(this.images(thread), image.file)) };
          this.written.set(input, image.file);
          images.push(input);
        } catch {
          // Its picture is gone: the message waits on without it.
        }
      }
      const message: WaitingMessage = { id: entry.id, text: entry.text, images };
      if (Array.isArray(entry.files) && entry.files.every((path) => typeof path === "string")) message.files = entry.files;
      if (Array.isArray(entry.mentions) && entry.mentions.every((path) => typeof path === "string")) message.mentions = entry.mentions;
      if (entry.fleet === true) message.fleet = true;
      if (entry.resent === true) message.resent = true;
      if (entry.refused === true) message.refused = true;
      if (entry.placement === "steer" || entry.placement === "queue") message.placement = entry.placement;
      if (typeof entry.requestId === "string") message.requestId = entry.requestId;
      if (typeof entry.failure === "string") message.failure = entry.failure;
      if (typeof entry.failedRequestId === "string") message.failedRequestId = entry.failedRequestId;
      if (Array.isArray(entry.takenBackRequestIds) && entry.takenBackRequestIds.every((id) => typeof id === "string")) message.takenBackRequestIds = entry.takenBackRequestIds;
      if (typeof entry.messageID === "string") message.messageID = entry.messageID;
      if (typeof entry.cardAnswer === "string") message.cardAnswer = entry.cardAnswer;
      messages.push(message);
    }
    return messages;
  }

  /**
   * Keeps what a thread has waiting now, in place of what it had, and the messages it
   * keeps as failed (`failed`, the latest `failedKept`; left out, those on disk stay);
   * nothing of either, no file. When that cannot be written, the thread's file goes too,
   * and throws: a list on disk that is not the one waiting would send a message taken off
   * it, or one sent already, at the next start; with none, the messages waiting now last
   * until the bridge stops, as they did before they were kept.
   */
  write(thread: string, messages: readonly WaitingMessage[], failed: readonly FailedMessage[] = this.readFailed(thread)): void {
    try {
      this.replace(thread, messages, failed.slice(-failedKept));
    } catch (error) {
      rmSync(this.file(thread), { force: true });
      throw error;
    }
  }

  private replace(thread: string, messages: readonly WaitingMessage[], failed: readonly FailedMessage[]): void {
    const images = this.images(thread);
    if (messages.length === 0) {
      if (failed.length === 0) rmSync(this.file(thread), { force: true });
      else writeJSON(this.file(thread), failed.map((message) => ({ failed: message })));
      // The list is written: pictures that cannot be deleted are only left over.
      try {
        rmSync(images, { recursive: true, force: true });
      } catch {
        // Tried again at the next change.
      }
      return;
    }
    const kept = new Set<string>();
    const stored = messages.map((message) => {
      const entry: Stored = { id: message.id, text: message.text };
      if (message.images.length > 0) {
        entry.images = message.images.map((image) => {
          let file = this.written.get(image);
          // Written before, and deleted since with a list it was not on (a message steered
          // in, then sent back): written again.
          if (file === undefined || !existsSync(join(images, file))) {
            file = randomBytes(8).toString("hex");
            mkdirSync(images, { recursive: true, mode: 0o700 });
            writeFileSync(join(images, file), image.data, { mode: 0o600 });
            this.written.set(image, file);
          }
          kept.add(file);
          return { filename: image.filename, file };
        });
      }
      if (message.files && message.files.length > 0) entry.files = message.files;
      if (message.mentions && message.mentions.length > 0) entry.mentions = message.mentions;
      if (message.fleet) entry.fleet = true;
      if (message.resent) entry.resent = true;
      if (message.refused) entry.refused = true;
      if (message.placement) entry.placement = message.placement;
      if (message.requestId) entry.requestId = message.requestId;
      if (message.failure) entry.failure = message.failure;
      if (message.failedRequestId) entry.failedRequestId = message.failedRequestId;
      if (message.takenBackRequestIds && message.takenBackRequestIds.length > 0) entry.takenBackRequestIds = message.takenBackRequestIds;
      if (message.messageID) entry.messageID = message.messageID;
      if (message.cardAnswer !== undefined) entry.cardAnswer = message.cardAnswer;
      return entry;
    });
    writeJSON(this.file(thread), [...stored, ...failed.map((message) => ({ failed: message }))]);
    // The pictures of messages that no longer wait. The list is written: a picture that
    // cannot be deleted is only left over.
    try {
      if (existsSync(images)) for (const file of readdirSync(images)) if (!kept.has(file)) rmSync(join(images, file), { force: true });
    } catch {
      // Tried again at the next change.
    }
  }

  private file(thread: string): string {
    return join(this.folder, `${safe(thread)}.json`);
  }

  private images(thread: string): string {
    return join(this.folder, safe(thread));
  }
}

/** A thread id as a file name. Ids are made by the bridge and its agents; this keeps any other in the folder. */
function safe(thread: string): string {
  return thread.replace(/[^A-Za-z0-9._:-]/g, "_");
}
