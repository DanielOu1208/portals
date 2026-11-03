import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// The streaming input of one live query: messages are pushed as the user sends them,
// and ending it closes Claude's stdin, so the process finishes and exits.

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly waiting: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(message: SDKUserMessage): void {
    if (this.ended) throw new Error("The Claude session has closed its input.");
    this.waiting.push(message);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.waiting.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
  }
}
