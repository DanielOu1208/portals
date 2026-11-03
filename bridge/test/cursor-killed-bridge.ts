import { setLogLevel } from "../src/log.ts";
import { CursorProvider } from "../src/providers/cursor/provider.ts";
import type { SessionSink } from "../src/providers/types.ts";

// A bridge's Cursor provider in a process of its own, for the test that kills a bridge
// in the middle of a turn (test/cursor-bridge.test.ts): nothing of it is closed, as
// after `kill -9`, a crash or a power cut. It runs the stand-in for `cursor-agent acp`
// (test/acp-agent.ts, whose folder and features come in the environment), makes one
// thread, sends it each message given and waits for its turn to end, except the last:
// once that one's turn runs it prints the thread's id, and stays until it is killed.
//
//   node test/cursor-killed-bridge.ts <stand-in script> <state folder> <thread folder> <message>...

setLogLevel("silent");

const [script, directory, cwd, ...messages] = process.argv.slice(2);
const settings = { model: "default", provider: "cursor", reasoningEffort: "" };
const provider = new CursorProvider({ command: process.execPath, args: [script], directory, idleMs: 600_000, checkVersion: false, cursorHome: null });
provider.start();

let ended: (() => void) | null = null;
const sink: SessionSink = {
  emit(event) {
    if (event.type === "turn.end") ended?.();
  },
  ask: async () => ({ kind: "withdrawn", reason: "nobody is there" }),
};

const id = await provider.newThread({ cwd, settings });
const session = await provider.startSession({ id, cwd, settings, title: null }, sink);
for (const text of messages.slice(0, -1)) {
  const turn = new Promise<void>((resolve) => (ended = resolve));
  session.startTurn({ text, images: [] });
  await turn;
}
session.startTurn({ text: messages.at(-1) ?? "", images: [] });
console.log(JSON.stringify({ thread: id }));
setInterval(() => undefined, 1000);
