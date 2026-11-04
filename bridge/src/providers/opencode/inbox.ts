import type { SessionInboxInfo } from "@opencode/client";
import type { Prompt, SessionSink } from "../types.ts";
import type { OpenCodeApi } from "./client.ts";
import type { Message } from "./protocol.ts";

interface Pending {
  requestId: string;
  prompt: Prompt;
  uncertain?: boolean;
  deleting?: boolean;
  takenBack?: boolean;
  cancelled?: boolean;
  bytes: number;
}

const prefix = "msg_portals-";
export const inboxRetentionLimit = { entries: 128, bytes: 32 * 1024 * 1024 };

function payloadBytes(prompt: Prompt): number {
  return Buffer.byteLength(prompt.text)
    + prompt.images.reduce((bytes, image) => bytes + image.data.byteLength + Buffer.byteLength(image.filename), 0)
    + [...(prompt.files ?? []), ...(prompt.mentions ?? [])].reduce((bytes, path) => bytes + Buffer.byteLength(path), 0);
}

/** A deterministic native ID lets stored messages prove delivery after a bridge restart. */
function inboxID(requestId: string): string {
  return `msg_${requestId}`;
}

/** Native steering receipts. A successful POST admits a message; only delivery consumes it. */
export class OpenCodeInbox {
  private readonly pending = new Map<string, Pending>();
  private readonly consumed = new Set<string>();
  private readonly sessionID: string;
  private readonly api: () => Promise<OpenCodeApi>;
  private readonly sink: SessionSink;
  private closed = false;

  constructor(sessionID: string, api: () => Promise<OpenCodeApi>, sink: SessionSink, messages: Message[], waiting: SessionInboxInfo[]) {
    this.sessionID = sessionID;
    this.api = api;
    this.sink = sink;
    for (const message of messages) if (message.type === "user" && message.id.startsWith(prefix)) this.consumed.add(message.id);
    for (const item of waiting) {
      if (item.type !== "user" || !item.id.startsWith(prefix)) continue;
      const prompt = { text: item.payload.text, images: [] };
      this.pending.set(item.id, { requestId: item.id.slice(4), prompt, bytes: payloadBytes(prompt) });
    }
  }

  owns(id: string): boolean {
    return this.pending.has(id);
  }

  queuedConsumed(requestId: string): boolean {
    return this.consumed.has(inboxID(requestId));
  }

  async add(prompt: Prompt, requestId: string, files: { uri: string; name: string }[]): Promise<boolean> {
    const id = inboxID(requestId);
    if (this.closed) return false;
    if (this.pending.get(id)?.uncertain) throw new Error("OpenCode has not confirmed this message's admission. Wait for its receipt or review it before retrying.");
    if (this.pending.has(id) || this.consumed.has(id)) return true;
    const bytes = payloadBytes(prompt);
    const retained = [...this.pending.values()].reduce((sum, pending) => sum + pending.bytes, 0);
    if (this.pending.size >= inboxRetentionLimit.entries || retained + bytes > inboxRetentionLimit.bytes) {
      // Nothing was sent. The bridge can keep this prompt in its normal queue
      // until the turn ends, unlike an ambiguous failed native handoff.
      return false;
    }
    // Backpressure bounds retained payloads without discarding uncertain identity,
    // text or images that a late authoritative delivery still needs.
    this.pending.set(id, { requestId, prompt, bytes });
    try {
      await (await this.api()).prompt(this.sessionID, prompt.text, files, { id, delivery: "steer" });
      return true;
    } catch (error) {
      const pending = this.pending.get(id);
      if (!pending) return true; // Its delivery arrived before the failed HTTP response.
      pending.uncertain = true;
      throw error; // The bridge keeps a failed handoff, never an automatic duplicate.
    }
  }

  delivered(id: string): void {
    if (this.closed || !id.startsWith(prefix)) return;
    this.consumed.add(id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.sink.emit(pending.uncertain
      ? { type: "queue.taken", requestId: pending.requestId, prompt: pending.prompt }
      : { type: "queue.consumed", requestId: pending.requestId });
  }

  cancelled(id: string): void {
    if (this.closed) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.cancelled = true;
    this.pending.delete(id);
    if (pending.deleting || pending.takenBack) return;
    this.sink.emit({ type: "queue.failed", requestId: pending.requestId, error: "OpenCode cancelled this pending message. Review it and try again." });
  }

  async delete(requestId: string): Promise<boolean> {
    const id = inboxID(requestId);
    const pending = this.pending.get(id);
    if (!pending) return false;
    pending.deleting = true;
    try {
      await (await this.api()).cancelInbox(this.sessionID, id);
      if (this.consumed.has(id)) return false;
      // Native cancellation is a successful no-op when delivery already won.
      // Keep the original prompt identity for a later SSE or history receipt.
      pending.takenBack = true;
      pending.uncertain = true;
      return true;
    } catch (error) {
      if (pending.cancelled) return true;
      throw error;
    } finally { pending.deleting = false; }
  }

  async reconcile(): Promise<void> {
    if (this.closed || !this.pending.size) return;
    const api = await this.api();
    const [waiting, messages] = await Promise.all([api.inbox(this.sessionID), api.messages(this.sessionID)]);
    if (this.closed) return;
    const delivered = new Set(messages.filter((message) => message.type === "user").map((message) => message.id));
    const ids = new Set(waiting.map((item) => item.id));
    for (const id of this.pending.keys()) {
      if (delivered.has(id)) this.delivered(id);
      else if (!ids.has(id)) {
        const pending = this.pending.get(id)!;
        if (pending.uncertain) continue;
        // The two reads are not a transaction: delivery may be between inbox removal and history storage.
        // Keep the receipt identity so a late delivery reconciles the failed handoff, without a resend.
        pending.uncertain = true;
        this.sink.emit({ type: "queue.failed", requestId: pending.requestId, error: "OpenCode no longer lists this pending message, but its delivery cannot be confirmed. Review it before retrying." });
      }
    }
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
  }
}
