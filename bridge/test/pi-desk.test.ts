import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { readOnlyText } from "../src/gateway/methods.ts";
import { machineWord } from "../src/platform.ts";
import { foldersOf, lsofName, PiSessionFiles, procIsTerminalPi, procReadsAtOnce, procTerminalPis, sessionSummary, sessionTitle, terminalMayHaveIt, terminalPis, workingFolders } from "../src/providers/pi/desk.ts";
import { findSessionFile, sessionFileId, sessionFolderName, sessionFolders } from "../src/providers/pi/history.ts";
import { threadArguments } from "../src/providers/pi/options.ts";
import type { PiProvider } from "../src/providers/pi/provider.ts";
import { isEvent, RpcFailure, startTestBridge, streamedText, TestClient, type Frame, type TestBridge } from "./helpers.ts";
import { fixtureCwd, sessionText } from "./pi-fixtures.ts";
import { piProvider, standin, until, type Standin } from "./pi-standin.ts";

// Pi's sessions from the desk (src/providers/pi/desk.ts): which are listed and in what
// state, and how `session.adopt` takes one up (continued, forked or only read). The
// session files are written here, where the stand-in for Pi keeps its own (a folder that
// stands for `~/.pi/agent`), some with the lines the real Pi recorded; a test says in
// which folders a Pi "runs in a terminal". No test asks the Mac, reads `~/.pi` or starts
// the installed `pi`.

let root: string;
const at = (path: string) => join(root, path);
const minute = 60_000;
const now = Date.now();

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "portals-pi-desk-test-")));
  for (const path of ["projects/app", "projects/notes", "projects/secret", "scratch/run"]) mkdirSync(at(path), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Desk {
  pi: Standin;
  provider: PiProvider;
  bridge: TestBridge;
  client: TestClient;
  /** The folders in which a Pi runs in a terminal. */
  terminals: Set<string>;
  /** Makes asking the Mac fail, or work again. */
  cannotAsk(broken: boolean): void;
  /** Keeps the Mac from answering until `release`, which lets it answer as things are by then; `asked` resolves once it is asked. */
  hold(): { asked: Promise<void>; release(): void };
  /** The Pis in a terminal whose folder the Mac will not say, by process. */
  unread: number[];
  /** Lets time pass for the provider, without waiting for it. */
  later(ms: number): void;
  /** Closes the client and the bridge. Their folder and the stand-in stay until the test ends. */
  stop(): Promise<void>;
}

/** The bridges each test started, stopped and cleared away when it ends. */
const started = new Map<TestContext, Desk[]>();

/**
 * A bridge with Pi, whose General folder is `projects` and whose only temporary folder
 * is `scratch`. With `again`, a bridge started on the folder of one that was stopped,
 * with its stand-in and its terminals; with `pi`, one on a stand-in the test set up.
 */
async function desk(t: TestContext, options: { again?: Desk; pi?: Standin; checkVersion?: boolean } = {}): Promise<Desk> {
  const again = options.again;
  const pi = again?.pi ?? options.pi ?? standin();
  const terminals = again?.terminals ?? new Set<string>();
  const unread: number[] = [];
  let broken = false;
  let ahead = 0;
  let held: { asked: () => void; released: Promise<void> } | null = null;
  const provider = piProvider(pi, {
    checkVersion: options.checkVersion ?? false,
    folder: at("projects"),
    now: () => Date.now() + ahead,
    terminals: async () => {
      if (held) {
        held.asked();
        await held.released;
      }
      if (broken) throw new Error("ps could not be run: spawn /bin/ps ENOENT");
      return { folders: [...terminals], unread: [...unread] };
    },
  });
  const bridge = await startTestBridge({
    providers: new Map([["pi", provider]]),
    home: again?.bridge.home,
    keepHome: true,
    config: { generalFolder: at("projects"), folders: { hide: [at("projects/secret")] } },
    temporaryFolders: [at("scratch")],
  });
  const client = await TestClient.open(bridge);
  let stopped = false;
  const made: Desk = {
    pi,
    provider,
    bridge,
    client,
    terminals,
    unread,
    cannotAsk: (value) => (broken = value),
    hold: () => {
      const asked = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      held = { asked: asked.resolve, released: released.promise };
      return {
        asked: asked.promise,
        release: () => {
          held = null;
          released.resolve();
        },
      };
    },
    later: (ms) => (ahead += ms),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await client.close();
      await bridge.close();
    },
  };
  const mine = started.get(t);
  if (mine) {
    mine.push(made);
    return made;
  }
  started.set(t, [made]);
  t.after(async () => {
    const all = started.get(t) ?? [];
    started.delete(t);
    for (const one of all) await one.stop();
    // No test leaves one of the stand-in's processes behind.
    try {
      await until(() => all.every((one) => one.pi.alive().length === 0));
    } finally {
      for (const one of all) {
        one.pi.dispose();
        rmSync(one.bridge.home, { recursive: true, force: true });
      }
    }
  });
  return made;
}

let entryNumber = 0;
/** One line of a session file after the header, as Pi writes one, behind `parent`. */
function entry(parent: string | null, at: number, more: Record<string, unknown>): { id: string; line: Record<string, unknown> } {
  const id = (entryNumber += 1).toString(16).padStart(8, "0");
  return { id, line: { type: more.type, id, parentId: parent, timestamp: new Date(at).toISOString(), ...more } };
}

/** The lines of a short session as Pi writes one: the model, the level, then each message and a reply to it. */
function conversation(messages: string[], options: { name?: string; at?: number; model?: string; level?: string } = {}): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  let parent: string | null = null;
  let time = options.at ?? now - 60 * minute;
  const add = (more: Record<string, unknown>) => {
    const made = entry(parent, (time += 1000), more);
    parent = made.id;
    lines.push(made.line);
  };
  add({ type: "model_change", provider: "openai", modelId: options.model ?? "gpt-6-luna" });
  add({ type: "thinking_level_change", thinkingLevel: options.level ?? "off" });
  for (const text of messages) {
    add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: time } });
    add({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `Done: ${text}` }], provider: "openai", model: options.model ?? "gpt-6-luna", stopReason: "stop", timestamp: time } });
  }
  if (options.name) add({ type: "session_info", name: options.name });
  return lines;
}

/** The line Pi adds when a session is given a name, behind the last of `lines`. */
function naming(lines: Record<string, unknown>[], name: string): Record<string, unknown> {
  return entry((lines.at(-1)?.id as string | undefined) ?? null, Date.now(), { type: "session_info", name }).line;
}

/** The lines the real Pi left for a recording (test/fixtures/pi), as if it had run in `cwd`. */
function recorded(name: string, cwd: string): Record<string, unknown>[] {
  return sessionText(name)
    .replaceAll(fixtureCwd, cwd)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.type !== "session");
}

/**
 * Writes a session file where Pi keeps one for a session that ran in `cwd`, last changed
 * `age` minutes ago, and returns its path. `folder` puts it in another folder's place.
 */
function deskSession(pi: Standin, options: { id: string; cwd: string; lines: Record<string, unknown>[]; age?: number; folder?: string }): string {
  const folder = join(pi.agentDir, "sessions", sessionFolderName(options.folder ?? options.cwd));
  mkdirSync(folder, { recursive: true });
  const changed = Math.floor((now - (options.age ?? 0) * minute) / 1000);
  const began = new Date(changed * 1000 - 5 * minute).toISOString();
  const path = join(folder, `${began.replace(/[:.]/g, "-")}_${options.id}.jsonl`);
  const header = { type: "session", version: 3, id: options.id, timestamp: began, cwd: options.cwd };
  writeFileSync(path, [header, ...options.lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  utimesSync(path, changed, changed);
  return path;
}

function threads(bridge: TestBridge): Frame[] {
  return JSON.parse(readFileSync(join(bridge.home, "state", "threads.json"), "utf8")).threads;
}

/** A whole turn: the message, and its events up to its end. */
async function turn(client: TestClient, session: string, text: string): Promise<Frame[]> {
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text, profile: "pi" })).status, "streaming");
  await client.from(start, (frame) => isEvent(frame, "message.complete", session), 5000);
  const events = client.frames.slice(start).filter((frame) => frame.method === "event" && frame.params.session_id === session).map((frame) => frame.params);
  return events.slice(0, events.findIndex((event) => event.type === "message.complete") + 1);
}

function notices(events: Frame[]): string[] {
  return events.filter((event) => event.type === "status.update").map((event) => event.payload.text);
}

const refused = (message: string | RegExp) => (error: RpcFailure) => error.code === -32602 && (typeof message === "string" ? error.message === message : message.test(error.message));

// MARK: The files and the processes, read

test("a session file's summary: its id and folder, the name it was last given, how it began, and the model and level it was last put on", () => {
  const header = { type: "session", version: 3, id: "0199f3a0-1111-7000-8000-000000000001", timestamp: "2026-10-12T10:00:00.000Z", cwd: "/work/app" };
  const text = (lines: Record<string, unknown>[], head: Record<string, unknown> = header) => [head, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const user = (content: unknown) => ({ type: "message", id: "u", parentId: null, message: { role: "user", content } });

  assert.deepEqual(sessionSummary(text(conversation(["Fix the login\nand the logout", "Now the tests"]))), {
    id: header.id,
    cwd: "/work/app",
    name: null,
    first: "Fix the login\nand the logout",
    model: { provider: "openai", id: "gpt-6-luna" },
    level: "none",
  });
  // The name last given wins, and a name taken away again is none.
  const named = [...conversation(["Hello"], { name: "First name" }), { type: "session_info", id: "n2", parentId: null, name: " Second name " }];
  assert.equal(sessionSummary(text(named))?.name, "Second name");
  assert.equal(sessionSummary(text([...named, { type: "session_info", id: "n3", parentId: null }]))?.name, null);
  // The model and the level it was last put on; a level that is none of Pi's keeps the one before.
  const moved = [...conversation(["Hello"]), { type: "model_change", id: "m2", provider: "anthropic", modelId: "claude-x" }, { type: "thinking_level_change", id: "l2", thinkingLevel: "high" }, { type: "thinking_level_change", id: "l3", thinkingLevel: "loud" }];
  assert.deepEqual([sessionSummary(text(moved))?.model, sessionSummary(text(moved))?.level], [{ provider: "anthropic", id: "claude-x" }, "high"]);
  // As Pi restores it: the model that wrote the last answer, when that came after the last change of model.
  const answered = [...moved, { type: "message", id: "a9", message: { role: "assistant", content: [{ type: "text", text: "Hi." }], provider: "openai", model: "gpt-5" } }, { type: "message", id: "u9", message: { role: "user", content: "And then?" } }];
  assert.deepEqual(sessionSummary(text(answered))?.model, { provider: "openai", id: "gpt-5" });
  assert.deepEqual([sessionSummary(text([user("Hi")]))?.model, sessionSummary(text([user("Hi")]))?.level], [null, ""]);
  // A skill reads as it was typed, an image as the bridge stores one, an older message's plain text as it is.
  assert.equal(sessionSummary(text([user([{ type: "text", text: '<skill name="greet" location="/x/SKILL.md">\nGreet warmly.\n</skill>\n\nAda' }])]))?.first, "/skill:greet Ada");
  assert.equal(sessionSummary(text([user([{ type: "image", data: "aGk=", mimeType: "image/png" }])]))?.first, "@image:image-1.png");
  // Nothing to call that one by: no title, and none made up.
  assert.equal(sessionTitle(sessionSummary(text([user([{ type: "image", data: "aGk=", mimeType: "image/png" }])]))!), "");
  assert.equal(sessionTitle({ name: "Named", first: "Begins so\nand goes on" }), "Named");
  assert.equal(sessionTitle({ name: null, first: "Begins so\nand goes on" }), "Begins so");
  assert.equal(sessionSummary(text([user("Plain words")]))?.first, "Plain words");
  // A message that only holds the words of another record is not that record, and still says its own model.
  const mentions = [user("Hi"), { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { type: "session_info", name: "Not a name" } }], provider: "openai", model: "gpt-5" } }];
  assert.deepEqual([sessionSummary(text(mentions))?.name, sessionSummary(text(mentions))?.model], [null, { provider: "openai", id: "gpt-5" }]);
  // A line cut off mid-write costs only itself.
  assert.equal(sessionSummary(`${text([user("Whole")])}{"type":"session_info","id":"x","name":"Cut o`)?.name, null);

  // Not a session to take up: no header, an id no thread can have, no folder, no message of the user's.
  assert.equal(sessionSummary(""), null);
  assert.equal(sessionSummary("not json\n"), null);
  assert.equal(sessionSummary(text([user("Hi")], { ...header, type: "message" })), null);
  assert.equal(sessionSummary(text([user("Hi")], { ...header, id: "has a space" })), null);
  assert.equal(sessionSummary(text([user("Hi")], { ...header, cwd: "" })), null);
  assert.equal(sessionSummary(text(conversation([]))), null);
  assert.equal(sessionSummary(text([{ type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text: 'She said "role":"user" once.' }] } }])), null);
});

test("a Pi in a terminal is a process named pi that has a terminal; the folders are the ones lsof names", () => {
  const listing = [
    "  501 ttys003  pi",
    "  502 ??       pi",
    "  503 ttys004  /Users/dev/.nvm/versions/node/v24.14.1/bin/pi",
    "  504 ttys005  node",
    "  505 ttys006  /usr/local/bin/pip",
    "  506 ttys007  -zsh",
    " 1507 ttys008  pi     ",
    "  508 ?        pi",
    "",
    "garbage",
  ].join("\n");
  // 502 and 508 have no terminal (the bridge's own Pi processes have none); 504 to 506 are not Pi.
  assert.deepEqual(terminalPis(listing), [501, 503, 1507]);
  assert.deepEqual(terminalPis(""), []);

  // One folder per process `lsof` could read; 1508 is named with no folder.
  assert.deepEqual(
    [...workingFolders("p501\nfcwd\nn/Users/dev/app\np503\nfcwd\nn/Users/dev/app\np1507\nfcwd\nn/private/tmp/with space/café\np1508\n")],
    [[501, "/Users/dev/app"], [503, "/Users/dev/app"], [1507, "/private/tmp/with space/café"]],
  );
  assert.deepEqual([...workingFolders("")], []);
  // `lsof` prints a backslash as two, a tab as `\t`, and a byte it takes for unprintable as `\x..`: with no locale every letter outside ASCII, with one still a joiner.
  assert.equal(lsofName("/Users/dev/caf\\xc3\\xa9 \\xe9\\xa1\\xb9\\xe7\\x9b\\xae"), "/Users/dev/café 项目");
  assert.equal(lsofName("/Users/dev/back\\\\slash/a\\tb/dev\\xe2\\x80\\x8dx/👨‍👩‍👧 café"), "/Users/dev/back\\slash/a\tb/dev\u200dx/👨‍👩‍👧 café");
  // What is no escape stays as it is.
  assert.equal(lsofName("/Users/dev/a\\qb/end\\"), "/Users/dev/a\\qb/end\\");
  assert.deepEqual([...workingFolders("p7\nfcwd\nn/Users/dev/caf\\xc3\\xa9\n")], [[7, "/Users/dev/café"]]);

  // The folders of the Pis asked about, each once. One that has gone since it was listed runs nowhere.
  const said = "p501\nfcwd\nn/Users/dev/app\np503\nfcwd\nn/Users/dev/app\np1507\nfcwd\nn/Users/dev/notes\n";
  assert.deepEqual(foldersOf([501, 503, 1507, 1600], said, (pid) => pid !== 1600), { folders: ["/Users/dev/app", "/Users/dev/notes"], unread: [] });
  // One that is there and that `lsof` could not read may be in any folder; the folders it did name still count.
  assert.deepEqual(foldersOf([501, 1600], said, () => true), { folders: ["/Users/dev/app"], unread: [1600] });
  assert.deepEqual(foldersOf([501], "", () => true), { folders: [], unread: [501] });
  assert.deepEqual(foldersOf([501], "", () => false), { folders: [], unread: [] });
});

test("the session files are read where Pi keeps them: a folder per working folder, or the one folder its environment names", async (t) => {
  const pi = standin();
  t.after(() => pi.dispose());
  const one = "0199f3a0-0000-7000-8000-0000000000a1";
  const two = "0199f3a0-0000-7000-8000-0000000000a2";
  const first = deskSession(pi, { id: one, cwd: at("projects/app"), age: 2, lines: conversation(["In app"]) });
  deskSession(pi, { id: two, cwd: at("projects/notes"), age: 1, lines: conversation(["In notes"]) });
  const sessions = join(pi.agentDir, "sessions");
  assert.deepEqual(await sessionFolders(pi.env), [join(sessions, sessionFolderName(at("projects/app"))), join(sessions, sessionFolderName(at("projects/notes")))]);

  const files = new PiSessionFiles(pi.env);
  assert.deepEqual((await files.newest(10)).map((session) => [session.id, session.cwd, session.title]), [[two, at("projects/notes"), "In notes"], [one, at("projects/app"), "In app"]]);
  // At least as many as wanted, the newest first.
  assert.equal((await files.newest(1))[0].id, two);
  assert.deepEqual([(await files.find(one))?.path, await files.find("0199f3a0-0000-7000-8000-0000000000a9")], [first, null]);
  // Read once: the same answer while the file is as it was, a new one when it has changed.
  assert.equal(await files.find(one), await files.find(one));
  appendFileSync(first, JSON.stringify(naming([], "Named since")) + "\n");
  assert.equal((await files.find(one))?.title, "Named since");

  // A session is found by its whole id, which is what follows the first `_` of its file's name.
  assert.deepEqual(["2026-10-12T10-43-01-721Z_my_task.jsonl", "2026-10-12T10-43-01-721Z_task.jsonl", "notes.jsonl", "2026-10-12T10-43-01-721Z_.jsonl", "2026-10-12T10-43-01-721Z_task.txt"].map(sessionFileId), ["my_task", "task", null, null, null]);
  deskSession(pi, { id: "my_task", cwd: at("projects/app"), lines: conversation(["Mine"]) });
  assert.equal(await files.find("task"), null);
  assert.equal(await findSessionFile("task", at("projects/app"), pi.env), null);
  const task = deskSession(pi, { id: "task", cwd: at("projects/notes"), age: 3, lines: conversation(["The task"]) });
  assert.deepEqual([(await files.find("task"))?.title, (await files.find("my_task"))?.title], ["The task", "Mine"]);
  assert.equal(await findSessionFile("task", at("projects/app"), pi.env), task);

  // For a listing, one look through the folders serves for a moment; a session is taken up by a look made then.
  let clock = 0;
  const timed = new PiSessionFiles(pi.env, () => clock);
  assert.equal((await timed.newest(10)).length, 4);
  rmSync(task);
  assert.equal((await timed.find("task", 2000))?.id, "task");
  assert.equal(await timed.find("task"), null);
  deskSession(pi, { id: "task", cwd: at("projects/notes"), age: 3, lines: conversation(["The task"]) });
  clock += 1999;
  assert.equal((await timed.find("task", 2000))?.id, "task");
  clock += 1;
  // The look is too old now: the folders are read again, and the new file is another one.
  assert.equal((await timed.find("task", 2000))?.title, "The task");
  assert.equal((await timed.find("task"))?.id, "task");

  // A copy the bridge had Pi make is found by its id, and is not among the sessions listed.
  deskSession(pi, { id: "fork-0199f3a0", cwd: at("projects/app"), lines: conversation(["A copy"]) });
  assert.equal((await files.find("fork-0199f3a0"))?.title, "A copy");
  assert.deepEqual((await files.newest(10)).map((session) => session.id).sort(), [one, two, "my_task", "task"].sort());

  // Moved to one folder for every working folder: read there, whatever the folder is called, and nowhere else.
  const moved = join(pi.agentDir, "all-sessions");
  mkdirSync(moved);
  const three = "0199f3a0-0000-7000-8000-0000000000a3";
  writeFileSync(join(moved, `2026-10-12T00-00-00-000Z_${three}.jsonl`), [{ type: "session", version: 3, id: three, timestamp: "2026-10-12T00:00:00.000Z", cwd: at("projects/app") }, ...conversation(["Moved"])].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const env = { ...pi.env, PI_CODING_AGENT_SESSION_DIR: moved };
  assert.deepEqual(await sessionFolders(env), [moved]);
  assert.deepEqual((await new PiSessionFiles(env).newest(10)).map((session) => session.id), [three]);
  // A folder for each working folder (not a whole path) cannot be listed.
  assert.deepEqual(await sessionFolders({ ...pi.env, PI_CODING_AGENT_SESSION_DIR: ".pi-sessions" }), []);
  assert.deepEqual(await new PiSessionFiles({ ...pi.env, PI_CODING_AGENT_SESSION_DIR: ".pi-sessions" }).newest(10), []);
  // No folder at all yet: no sessions.
  assert.deepEqual(await sessionFolders({ ...pi.env, PI_CODING_AGENT_DIR: join(pi.agentDir, "none") }), []);
});

test("the folders Pi's sessions ran in, from each file's header alone, read again only once the file changes", async (t) => {
  const pi = standin();
  t.after(() => pi.dispose());
  const one = "0199f3a0-0000-7000-8000-0000000000b1";
  const garden = deskSession(pi, { id: one, cwd: "/Users/dana/garden", age: 2, lines: conversation(["In the garden"]) });
  // No message yet: the folder was used all the same.
  deskSession(pi, { id: "0199f3a0-0000-7000-8000-0000000000b2", cwd: "/Users/dana/recipes", age: 1, lines: [] });
  const folder = join(pi.agentDir, "sessions", sessionFolderName("/Users/dana/garden"));
  writeFileSync(join(folder, "2026-10-12T00-00-00-000Z_notes.jsonl"), "not a session\n");
  writeFileSync(join(folder, "2026-10-12T00-00-00-000Z_other.jsonl"), JSON.stringify({ type: "session", id: "other", cwd: "relative/folder" }) + "\n");
  const files = new PiSessionFiles(pi.env);
  const sorted = async (sessions = files) => (await sessions.folders()).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(await sorted(), [
    { path: "/Users/dana/garden", lastUsed: Math.floor((now - 2 * minute) / 1000) * 1000 },
    { path: "/Users/dana/recipes", lastUsed: Math.floor((now - minute) / 1000) * 1000 },
  ]);

  // A header as it was is not read again; one that changed is, and a file gone is forgotten.
  const changed = Math.floor((now - 2 * minute) / 1000);
  writeFileSync(garden, readFileSync(garden, "utf8").replace("/Users/dana/garden", "/Users/dana/meadow"));
  utimesSync(garden, changed, changed);
  assert.equal((await sorted())[0].path, "/Users/dana/garden");
  utimesSync(garden, changed + 60, changed + 60);
  assert.deepEqual((await sorted()).map((entry) => entry.path), ["/Users/dana/meadow", "/Users/dana/recipes"]);
  rmSync(garden);
  assert.deepEqual((await sorted()).map((entry) => entry.path), ["/Users/dana/recipes"]);

  // Moved to one folder for every working folder: read there alone.
  const moved = join(pi.agentDir, "all-sessions");
  mkdirSync(moved);
  writeFileSync(join(moved, `2026-10-12T00-00-00-000Z_${one}.jsonl`), JSON.stringify({ type: "session", version: 3, id: one, timestamp: "2026-10-12T00:00:00.000Z", cwd: "/Users/dana/notes" }) + "\n");
  assert.deepEqual((await sorted(new PiSessionFiles({ ...pi.env, PI_CODING_AGENT_SESSION_DIR: moved }))).map((entry) => entry.path), ["/Users/dana/notes"]);
});

test("Pi: folders.list offers the folders Pi worked in at the desk, as it does any agent's: not those never offered", async (t) => {
  for (const path of ["projects/dana-garden", "projects/dana-recipes"]) mkdirSync(at(path), { recursive: true });
  const { pi, client } = await desk(t);
  const id = (n: number) => `0199f3a0-0000-7000-8000-0000000000c${n}`;
  deskSession(pi, { id: id(1), cwd: at("projects/dana-garden"), age: 1, lines: conversation(["Water the tomatoes"]) });
  deskSession(pi, { id: id(2), cwd: at("projects/dana-recipes"), age: 30, lines: [] });
  deskSession(pi, { id: id(3), cwd: at("scratch/run"), age: 2, lines: conversation(["In a scratch folder"]) });
  deskSession(pi, { id: id(4), cwd: at("projects/secret"), age: 3, lines: conversation(["Hidden by config.json"]) });
  deskSession(pi, { id: id(5), cwd: at("projects/gone"), age: 4, lines: conversation(["Its folder is gone"]) });
  const listed = await client.call("folders.list", { profile: "pi" });
  assert.deepEqual(listed.folders, [
    { path: at("projects/dana-garden"), name: "dana-garden", last_used: Math.floor((now - minute) / 1000) },
    { path: at("projects/dana-recipes"), name: "dana-recipes", last_used: Math.floor((now - 30 * minute) / 1000) },
  ]);
});

// MARK: desk.list

test("Pi: the desk's sessions, newest first, each open while a Pi runs in a terminal in its folder; the bridge's own threads, folders never offered and files that are no session left out", async (t) => {
  const made = await desk(t);
  const { pi, client, terminals } = made;
  const id = (n: number) => `0199f3a0-0000-7000-8000-00000000000${n}`;
  deskSession(pi, { id: id(1), cwd: at("projects/app"), age: 1, lines: conversation(["Make the login keep its session"], { name: "Fix the login" }) });
  deskSession(pi, { id: id(2), cwd: at("projects/notes"), age: 30, lines: conversation(["Tidy the notes\n  and   sort them"]) });
  deskSession(pi, { id: id(3), cwd: at("projects/notes"), age: 90, lines: conversation(["x".repeat(300)]) });
  deskSession(pi, { id: id(4), cwd: at("scratch/run"), age: 2, lines: conversation(["In a scratch folder"]) });
  deskSession(pi, { id: id(5), cwd: at("projects/secret"), age: 3, lines: conversation(["Hidden by config.json"]) });
  deskSession(pi, { id: id(6), cwd: at("projects/gone"), age: 4, lines: conversation(["Its folder is gone"]) });
  // Where a thread's process would not find it: in the folder Pi names after another one.
  deskSession(pi, { id: id(7), cwd: at("projects/app"), folder: at("projects/notes"), age: 5, lines: conversation(["Misplaced"]) });
  // Nothing was said in it yet.
  deskSession(pi, { id: id(8), cwd: at("projects/app"), age: 6, lines: conversation([]) });
  writeFileSync(join(pi.agentDir, "sessions", sessionFolderName(at("projects/app")), "2026-10-12T00-00-00-000Z_notes.jsonl"), "not a session\n");
  writeFileSync(join(pi.agentDir, "sessions", sessionFolderName(at("projects/app")), "README.txt"), "not a session file\n");
  // One of the bridge's own threads, with a session file of its own.
  const own = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id as string;
  await turn(client, own, "hello");
  assert.equal(pi.sessionFiles(own).length, 1);
  terminals.add(at("projects/app"));

  const listed = await client.call("desk.list", { profile: "pi" });
  assert.deepEqual(listed.sessions, [
    { id: id(1), title: "Fix the login", folder: at("projects/app"), updated: Math.floor((now - minute) / 1000), state: "open" },
    { id: id(2), title: "Tidy the notes", folder: at("projects/notes"), updated: Math.floor((now - 30 * minute) / 1000), state: "closed" },
    { id: id(3), title: `${"x".repeat(79)}…`, folder: at("projects/notes"), updated: Math.floor((now - 90 * minute) / 1000), state: "closed" },
  ]);
  assert.deepEqual((await client.call("desk.list", { profile: "pi", limit: 2 })).sessions.map((entry: Frame) => entry.id), [id(1), id(2)]);

  // The Pi in the terminal has gone, and one runs in another folder.
  terminals.clear();
  terminals.add(at("projects/notes"));
  made.later(2100);
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => [entry.id, entry.state]), [[id(1), "closed"], [id(2), "open"], [id(3), "open"]]);
  // When the Mac cannot be asked, the sessions are listed all the same, as closed.
  made.cannotAsk(true);
  made.later(2100);
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => entry.state), ["closed", "closed", "closed"]);
  made.cannotAsk(false);

  // A session that went on at the desk moves up, with its new name; one deleted there is gone.
  const [second] = pi.sessionFiles(id(2));
  assert.ok(second.startsWith(join(pi.agentDir, "sessions", sessionFolderName(at("projects/notes")))));
  appendFileSync(second, JSON.stringify(naming([], "Notes, sorted")) + "\n");
  rmSync(pi.sessionFiles(id(3))[0]);
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => [entry.id, entry.title]), [[id(2), "Notes, sorted"], [id(1), "Fix the login"]]);

  // Taken up, a session is a thread of the bridge's and no longer listed.
  terminals.clear();
  await client.call("session.adopt", { profile: "pi", session_id: id(2), mode: "continue" });
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => entry.id), [id(1)]);
  await client.call("thread.delete", { thread: own });
});

// MARK: session.adopt

test("Pi: a session is not continued while a Pi runs in a terminal in its folder; once that Pi is gone it is, on its own id, and every turn asks again", async (t) => {
  const made = await desk(t);
  const { pi, provider, bridge, client, terminals } = made;
  const id = "0199f3a0-0000-7000-8000-000000000011";
  const lines = recorded("tools", at("projects/app"));
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: [...lines, naming(lines, "Five steps")] });
  terminals.add(at("projects/app"));

  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }), refused(terminalMayHaveIt));
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: "missing", mode: "continue" }), refused(`Pi has no session by that id on this ${machineWord()}.`));
  made.cannotAsk(true);
  await assert.rejects(
    client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }),
    refused(`Portals could not check whether Pi is running in a terminal on the ${machineWord()} (ps could not be run: spawn /bin/ps ENOENT). Fork the session instead.`),
  );
  made.cannotAsk(false);
  // A Pi in a terminal whose folder the Mac will not say (one run with sudo) may be in this one.
  terminals.clear();
  made.unread.push(4242);
  await assert.rejects(
    client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }),
    refused("Portals could not check whether Pi is running in a terminal in this session's folder (the Mac would not say where a Pi in a terminal runs). Fork the session instead."),
  );
  // One the Mac does place in the folder is the reason given, whatever else it will not say.
  terminals.add(at("projects/app"));
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }), refused(terminalMayHaveIt));
  made.unread.length = 0;
  assert.deepEqual(threads(bridge), []);
  assert.deepEqual(pi.starts(id), []);

  // A Pi in another folder's terminal is no reason.
  terminals.clear();
  terminals.add(at("projects/notes"));
  const adopted = await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  assert.equal(adopted.session_id, id);
  assert.equal(adopted.stored_session_id, id);
  // The folder, the name and the model the session had at the desk.
  assert.deepEqual({ cwd: adopted.info.cwd, title: adopted.info.title, model: adopted.info.model, provider: adopted.info.provider, level: adopted.info.reasoning_effort }, { cwd: at("projects/app"), title: "Five steps", model: "gpt-6-luna", provider: "openai", level: "none" });
  const [record] = threads(bridge);
  assert.equal(record.origin, "desk");
  assert.equal(record.readOnly, undefined);
  // Taking it up started nothing.
  assert.deepEqual(pi.starts(id), []);

  // The history so far, then a turn in the session itself.
  const resumed = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.deepEqual(
    resumed.messages.map((message: Frame) => (message.role === "tool" ? message.name : message.role)),
    ["user", "read_file", "terminal", "patch", "terminal", "write_file", "assistant"],
  );
  const before = readFileSync(file, "utf8");
  const first = await turn(client, id, "Hello.");
  assert.equal(streamedText(first), "Working. You said: Hello.");
  assert.deepEqual(notices(first), []);
  const [started] = pi.starts(id);
  assert.deepEqual(started.args, threadArguments(id, null, pi.agentDir));
  assert.equal(started.cwd, at("projects/app"));
  // Pi came back on the session's own model, level and name: nothing was set.
  assert.deepEqual(pi.sentTo(id).map((sent) => sent.type).slice(0, 3), ["get_state", "get_session_stats", "prompt"]);
  assert.deepEqual(pi.sentTo(id).filter((sent) => String(sent.type).startsWith("set_")), []);
  // The same file, longer by the turn.
  assert.deepEqual(pi.sessionFiles(id), [file]);
  assert.ok(readFileSync(file, "utf8").startsWith(before) && readFileSync(file, "utf8").length > before.length);

  // The process goes cold; meanwhile a Pi was started in a terminal in the folder: the
  // next turn starts none, and says why.
  provider.pool.sweep(Date.now() + 16 * minute);
  await until(() => pi.alive().length === 0);
  terminals.add(at("projects/app"));
  const held = readFileSync(file, "utf8");
  const stopped = await turn(client, id, "Again.");
  assert.deepEqual([stopped.at(-1).payload.status, stopped.at(-1).payload.text], ["error", terminalMayHaveIt]);
  assert.equal(pi.starts(id).length, 1);
  assert.equal(readFileSync(file, "utf8"), held);
  // That Pi quit: the thread goes on.
  terminals.delete(at("projects/app"));
  assert.equal(streamedText(await turn(client, id, "Once more.")), "Working. You said: Once more.");
  assert.equal(pi.starts(id).length, 2);

  // A Pi started in a terminal while the thread's process is still up: the next turn is
  // not written either, and the process is let go of, since it would not see what that
  // Pi writes.
  await until(() => pi.alive().length === 1);
  terminals.add(at("projects/app"));
  const kept = readFileSync(file, "utf8");
  const refusedWarm = await turn(client, id, "And again.");
  assert.deepEqual([refusedWarm.at(-1).payload.status, refusedWarm.at(-1).payload.text], ["error", terminalMayHaveIt]);
  await until(() => pi.alive().length === 0);
  assert.equal(readFileSync(file, "utf8"), kept);
  assert.equal(pi.sentTo(id, "prompt").length, 2);
  // Gone again: a new process, which reads the file as the desk left it.
  terminals.clear();
  assert.equal(streamedText(await turn(client, id, "Now.")), "Working. You said: Now.");
  assert.equal(pi.starts(id).length, 3);

  // A new title while a Pi is in the folder's terminal is not written into the session
  // either: the process is let go of, and Pi is given the name when it next starts. A Pi
  // the Mac places there counts also when it will not say where another one runs.
  await until(() => pi.alive().length === 1);
  terminals.add(at("projects/app"));
  made.unread.push(4242);
  const names = pi.sentTo(id, "set_session_name").length;
  const unnamed = readFileSync(file, "utf8");
  await client.call("session.rename", { session_id: id, title: "Five steps, renamed", profile: "pi" });
  await until(() => pi.alive().length === 0);
  assert.equal(pi.sentTo(id, "set_session_name").length, names);
  assert.equal(readFileSync(file, "utf8"), unnamed);
  const blocked = await turn(client, id, "Named?");
  assert.deepEqual([blocked.at(-1).payload.status, blocked.at(-1).payload.text], ["error", terminalMayHaveIt]);
  terminals.clear();
  made.unread.length = 0;
  assert.equal(streamedText(await turn(client, id, "Named.")), "Working. You said: Named.");
  assert.deepEqual(pi.sentTo(id, "set_session_name").map((sent) => sent.name).slice(names), ["Five steps, renamed"]);
  assert.equal(pi.starts(id).length, 4);

  // The desk's Pi wrote two messages and quit, while the thread's process was still up:
  // that process no longer has the conversation as it is. The next turn starts another,
  // which reads the file again, and what it writes follows what the desk wrote.
  await until(() => pi.alive().length === 1);
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  const question = entry(last.id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk" }], timestamp: Date.now() } });
  const reply = entry(question.id, Date.now(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answered at the desk" }], provider: "openai", model: "gpt-6-luna", stopReason: "stop", timestamp: Date.now() } });
  appendFileSync(file, [question.line, reply.line].map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(streamedText(await turn(client, id, "And after the desk.")), "Working. You said: And after the desk.");
  assert.equal(pi.starts(id).length, 5);
  const written = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const mine = written.find((line) => line.message?.role === "user" && line.message.content?.[0]?.text === "And after the desk.");
  assert.equal(mine.parentId, reply.id);

  // The Mac cannot be asked before a turn: nothing is written on a guess, and the turn says so.
  made.cannotAsk(true);
  const unasked = await turn(client, id, "Asked?");
  assert.deepEqual([unasked.at(-1).payload.status, unasked.at(-1).payload.text], ["error", `Portals could not check whether Pi is running in a terminal on the ${machineWord()} (ps could not be run: spawn /bin/ps ENOENT), so nothing was sent to this session. Send the message again.`]);
  assert.deepEqual(pi.sentTo(id, "prompt").filter((sent) => sent.message === "Asked?"), []);
  // Nor is a new title written then; the process stays, and Pi gets the name with the next turn.
  await client.call("session.rename", { session_id: id, title: "Five steps, once more", profile: "pi" });
  assert.equal(pi.sentTo(id, "set_session_name").at(-1).name, "Five steps, renamed");
  made.cannotAsk(false);
  assert.equal(streamedText(await turn(client, id, "Asked.")), "Working. You said: Asked.");
  assert.equal(pi.sentTo(id, "set_session_name").at(-1).name, "Five steps, once more");
  assert.equal(pi.starts(id).length, 5);

  // A message sent while Pi works for the thread joins that work, whatever runs at the desk by now.
  const start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "hold desk-1", profile: "pi" })).status, "streaming");
  await client.from(start, (frame) => isEvent(frame, "message.delta", id));
  terminals.add(at("projects/app"));
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "and this", profile: "pi" })).status, "steered");
  pi.release("desk-1");
  assert.equal((await client.from(start, (frame) => isEvent(frame, "message.complete", id), 5000)).params.payload.status, "complete");
  assert.equal(pi.starts(id).length, 5);
  terminals.clear();
  await client.call("thread.delete", { thread: id });
});

test("Pi: a session whose folder has become a link to another is not continued, since Pi would not find it from there; it can be forked", async (t) => {
  const made = await desk(t);
  const { pi, bridge, client } = made;
  const id = "0199f3a0-0000-7000-8000-000000000061";
  // Written when `projects/old` was a folder of its own; since then the project moved and left a link.
  deskSession(pi, { id, cwd: at("projects/old"), lines: conversation(["Before the move"]) });
  mkdirSync(at("projects/moved"));
  symlinkSync(at("projects/moved"), at("projects/old"));
  t.after(() => {
    // The links themselves, not what they lead to.
    for (const link of ["projects/old", "projects/was"]) {
      try {
        unlinkSync(at(link));
      } catch {
        // Not made, or not a link yet: the test failed before that.
        rmSync(at(link), { recursive: true, force: true });
      }
    }
    rmSync(at("projects/moved"), { recursive: true, force: true });
    rmSync(at("projects/went"), { recursive: true, force: true });
  });

  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => [entry.id, entry.folder]), [[id, at("projects/moved")]]);
  await assert.rejects(
    client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }),
    refused(`This session's folder, ${at("projects/old")}, now leads to ${at("projects/moved")}, where Pi would not find the session. Fork it instead.`),
  );
  assert.deepEqual(threads(bridge), []);
  const fork = (await client.call("session.adopt", { profile: "pi", session_id: id, mode: "fork" })).session_id as string;
  assert.equal(streamedText(await turn(client, fork, "After the move.")), "Working. You said: After the move.");
  // Pi made the copy for the folder the link leads to, and the thread's process finds it there.
  assert.equal(JSON.parse(readFileSync(pi.sessionFiles(fork)[0], "utf8").split("\n")[0]).cwd, at("projects/moved"));
  assert.deepEqual((await client.call("session.resume", { session_id: fork, profile: "pi" })).messages.map((message: Frame) => message.text), ["Before the move", "Done: Before the move", "After the move.", "Working. You said: After the move."]);
  await client.call("thread.delete", { thread: fork });

  // A folder that became a link only after its session was taken up: Pi is not started
  // where the link leads, where it would begin an empty session under the same id.
  const later = "0199f3a0-0000-7000-8000-000000000062";
  mkdirSync(at("projects/was"));
  const file = deskSession(pi, { id: later, cwd: at("projects/was"), lines: conversation(["Before the second move"]) });
  await client.call("session.adopt", { profile: "pi", session_id: later, mode: "continue" });
  rmSync(at("projects/was"), { recursive: true });
  mkdirSync(at("projects/went"));
  symlinkSync(at("projects/went"), at("projects/was"));
  const kept = readFileSync(file, "utf8");
  const lost = await turn(client, later, "After the second move.");
  assert.deepEqual(
    [lost.at(-1).payload.status, lost.at(-1).payload.text],
    ["error", `This session's folder, ${at("projects/was")}, now leads to ${at("projects/went")}, where Pi would not find the session, so nothing was sent to it.`],
  );
  assert.deepEqual(pi.starts(later), []);
  assert.deepEqual(pi.sessionFiles(later), [file]);
  assert.equal(readFileSync(file, "utf8"), kept);
  await client.call("thread.delete", { thread: later });
});

test("Pi: a turn of a session from the desk that ends before it wrote anything writes nothing after it either: a title, a model or a level given meanwhile waits, and what the desk wrote is still seen", async (t) => {
  const made = await desk(t);
  const { pi, client, terminals } = made;
  const id = "0199f3a0-0000-7000-8000-000000000071";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["First at the desk"], { name: "Kept apart" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  assert.equal(streamedText(await turn(client, id, "Hello.")), "Working. You said: Hello.");
  await until(() => pi.alive().length === 1);
  const settings = () => pi.sentTo(id).filter((sent) => String(sent.type).startsWith("set_")).map((sent) => sent.type);
  /** The entries the message with this text was written behind, nearest first. */
  const behind = (text: string) => {
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const before: Frame[] = [];
    let at = lines.find((line) => line.message?.role === "user" && line.message.content?.[0]?.text === text);
    while ((at = lines.find((line) => line.id === at.parentId))) before.push(at);
    return before;
  };
  /** Long enough for what a turn's end would write to have been written. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 100));

  // The desk's Pi wrote two messages and quit, while the thread's process is still up.
  // Then the Mac cannot be asked: a new title is kept, and the turn is refused.
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  const question = entry(last.id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk" }], timestamp: Date.now() } });
  const reply = entry(question.id, Date.now(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answered at the desk" }], provider: "openai", model: "gpt-6-luna", stopReason: "stop", timestamp: Date.now() } });
  appendFileSync(file, [question.line, reply.line].map((line) => JSON.stringify(line)).join("\n") + "\n");
  made.cannotAsk(true);
  await client.call("session.rename", { session_id: id, title: "Kept apart, renamed", profile: "pi" });
  let before = readFileSync(file, "utf8");
  const unasked = await turn(client, id, "Asked?");
  assert.equal(unasked.at(-1).payload.status, "error");
  assert.match(unasked.at(-1).payload.text, /so nothing was sent to this session/);
  // Nothing was: not the title either, at the turn's end.
  await settled();
  assert.deepEqual(settings(), []);
  assert.equal(readFileSync(file, "utf8"), before);
  // The Mac answers again. The refused turn did not make the process's own what the desk
  // wrote: another is started, the message follows the desk's reply, and Pi has the title.
  made.cannotAsk(false);
  assert.equal(streamedText(await turn(client, id, "And after the desk.")), "Working. You said: And after the desk.");
  assert.equal(pi.starts(id).length, 2);
  assert.deepEqual(pi.sentTo(id, "set_session_name").map((sent) => sent.name), ["Kept apart, renamed"]);
  // Behind the title, which is behind the desk's reply.
  assert.deepEqual(behind("And after the desk.").slice(0, 2).map((line) => [line.type, line.id === reply.id]), [["session_info", false], ["message", true]]);

  // A Pi is opened in the folder's terminal. A message is sent, and while the Mac is
  // still being asked for it a title and a model are given: neither is written before
  // the turn is refused, nor after.
  await until(() => pi.alive().length === 1);
  terminals.add(at("projects/app"));
  let sent = settings().length;
  before = readFileSync(file, "utf8");
  let look = made.hold();
  let start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "While the desk has it", profile: "pi" })).status, "streaming");
  await look.asked;
  await client.call("session.rename", { session_id: id, title: "Renamed during the look", profile: "pi" });
  await client.call("config.set", { session_id: id, key: "model", value: "o3-mini --provider openai --session" });
  await client.call("config.set", { session_id: id, key: "reasoning", value: "high" });
  await settled();
  assert.equal(settings().length, sent);
  look.release();
  assert.deepEqual((await client.from(start, (frame) => isEvent(frame, "message.complete", id), 5000)).params.payload.text, terminalMayHaveIt);
  await until(() => pi.alive().length === 0);
  assert.equal(settings().length, sent);
  assert.equal(readFileSync(file, "utf8"), before);
  // That Pi quit: the next turn's process is given all three before the message.
  terminals.clear();
  assert.equal(streamedText(await turn(client, id, "Now.")), "Working. You said: Now.");
  assert.equal(pi.starts(id).length, 3);
  assert.deepEqual(settings().slice(sent).sort(), ["set_model", "set_session_name", "set_thinking_level"]);
  assert.equal(pi.sentTo(id, "set_session_name").at(-1).name, "Renamed during the look");

  // The same with the Mac unable to answer in the end: the model given during the look waits.
  await until(() => pi.alive().length === 1);
  sent = settings().length;
  before = readFileSync(file, "utf8");
  look = made.hold();
  start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "While the Mac is asked", profile: "pi" })).status, "streaming");
  await look.asked;
  await client.call("config.set", { session_id: id, key: "model", value: "gpt-5 --provider openai --session" });
  made.cannotAsk(true);
  look.release();
  assert.equal((await client.from(start, (frame) => isEvent(frame, "message.complete", id), 5000)).params.payload.status, "error");
  await settled();
  assert.equal(settings().length, sent);
  assert.equal(readFileSync(file, "utf8"), before);
  made.cannotAsk(false);

  // A title kept while the Mac could not be asked, then a Pi in the terminal and a
  // message stopped while the Mac is being asked: the stopped turn writes no title.
  made.cannotAsk(true);
  await client.call("session.rename", { session_id: id, title: "Kept for later", profile: "pi" });
  made.cannotAsk(false);
  terminals.add(at("projects/app"));
  look = made.hold();
  start = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: id, text: "Stopped early", profile: "pi" })).status, "streaming");
  await look.asked;
  await client.call("session.interrupt", { session_id: id, profile: "pi" });
  assert.equal((await client.from(start, (frame) => isEvent(frame, "message.complete", id), 5000)).params.payload.status, "interrupted");
  look.release();
  await settled();
  assert.equal(settings().length, sent);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(pi.sentTo(id, "prompt").filter((prompt) => prompt.message === "Stopped early"), []);
  // Once that Pi is gone, the thread goes on with the title and the model it was given.
  terminals.clear();
  assert.equal(streamedText(await turn(client, id, "Later.")), "Working. You said: Later.");
  assert.equal(pi.sentTo(id, "set_session_name").at(-1).name, "Kept for later");
  assert.equal(pi.sentTo(id, "set_model").at(-1).modelId, "gpt-5");
  await client.call("thread.delete", { thread: id });
});

test("Pi: a thread started on the phone whose session went on at the desk while its process was up starts another, which has what the desk wrote; what its own Pi writes at rest is not taken for the desk's", async (t) => {
  const made = await desk(t);
  const { pi, client } = made;
  const session = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id as string;
  // An entry Pi announces before the session has a file is in no file yet: nothing is counted for it.
  await turn(client, session, "/note before any message");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(pi.sessionFiles(session), []);
  await turn(client, session, "remember kiwi");
  assert.equal(pi.starts(session).length, 1);
  const [file] = pi.sessionFiles(session);
  const lines = () => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const parentOf = (text: string) => lines().find((line) => line.message?.role === "user" && line.message.content?.[0]?.text === text).parentId;
  // Nothing written since: the same process takes the next message.
  await turn(client, session, "and plum");
  assert.equal(pi.starts(session).length, 1);
  // Nor after a new title, which the thread's own Pi wrote into the file.
  await client.call("session.rename", { session_id: session, title: "Fruit", profile: "pi" });
  await turn(client, session, "and pear");
  assert.equal(pi.starts(session).length, 1);
  // Nor after an entry an extension of its own wrote outside any run, since Pi said so.
  await turn(client, session, "/note a word of my own");
  await until(() => lines().filter((line) => line.customType === "standin-note").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await turn(client, session, "and fig");
  assert.equal(pi.starts(session).length, 1);

  // The desk's Pi wrote a message and quit. A Pi still in the folder's terminal stops
  // nothing here: a thread started on the phone is not asked about.
  const question = entry(lines().at(-1).id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk" }], timestamp: Date.now() } });
  appendFileSync(file, JSON.stringify(question.line) + "\n");
  made.terminals.add(at("projects"));
  assert.equal(streamedText(await turn(client, session, "which words?")), "Working. You said: which words?");
  assert.equal(pi.starts(session).length, 2);
  assert.equal(parentOf("which words?"), question.id);

  // The desk wrote again, and then the thread's own Pi wrote an entry at rest: its saying
  // so does not cover what it did not write.
  await turn(client, session, "/note another word");
  await until(() => lines().filter((line) => line.customType === "standin-note").length === 3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = entry(lines().at(-1).id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk again" }], timestamp: Date.now() } });
  appendFileSync(file, JSON.stringify(second.line) + "\n");
  await turn(client, session, "/note a third word");
  await until(() => lines().filter((line) => line.customType === "standin-note").length === 4);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pi.starts(session).length, 3);
  // A new title is a write too: with the file changed from elsewhere it is kept for the next process.
  appendFileSync(file, JSON.stringify(entry(lines().at(-1).id, Date.now(), { type: "custom", customType: "desk", data: {} }).line) + "\n");
  const names = pi.sentTo(session, "set_session_name").length;
  await client.call("session.rename", { session_id: session, title: "Fruit, again", profile: "pi" });
  await until(() => pi.alive().length === 0);
  assert.equal(pi.sentTo(session, "set_session_name").length, names);
  assert.equal(streamedText(await turn(client, session, "named?")), "Working. You said: named?");
  assert.deepEqual(pi.sentTo(session, "set_session_name").map((sent) => sent.name).slice(names), ["Fruit, again"]);
  assert.equal(pi.starts(session).length, 4);
  made.terminals.clear();
  await client.call("thread.delete", { thread: session });
});

// The backlog's "What was said at the desk without a bridge restart" (Pi), done as Dana
// chose on 2026-10-27: by loading the thread again, as after a restart; a device that
// followed it opens it again to go on hearing it.
test("Pi: a thread continued here whose session went on at the desk shows what was said there once opened again, loaded again as after a restart; one at work is left as it is", async (t) => {
  const made = await desk(t);
  const { pi, client, provider, bridge } = made;
  const session = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id as string;
  await turn(client, session, "remember kiwi");
  const [file] = pi.sessionFiles(session);
  const lines = () => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const atDesk = (text: string) => {
    const question = entry(lines().at(-1).id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
    const answer = entry(question.id, Date.now(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: `Done: ${text}` }], provider: "openai", model: "gpt-6-luna", stopReason: "stop", timestamp: Date.now() } });
    appendFileSync(file, JSON.stringify(question.line) + "\n" + JSON.stringify(answer.line) + "\n");
  };
  const resume = (on = client) => on.call("session.resume", { session_id: session, profile: "pi" });
  const texts = async (on = client) => (await resume(on)).messages.map((message: Frame) => message.text);
  const listed = async () => (await client.call("threads.list", { local: true })).threads.find((thread: Frame) => thread.id === session);
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  // Opened again with nothing written elsewhere: the same session, its process kept.
  assert.deepEqual(await texts(other), ["remember kiwi", "Working. You said: remember kiwi"]);
  assert.equal(pi.alive().length, 1);

  // The process went cold, as a thread's at rest does, and the desk's Pi went on with the session.
  provider.pool.sweep(Date.now() + 16 * minute);
  await until(() => pi.alive().length === 0);
  atDesk("Asked at the desk");
  const before = await resume();
  const mark = await listed();
  const shown = await texts();
  assert.deepEqual(shown.slice(-2), ["Asked at the desk", "Done: Asked at the desk"]);
  // Its events go on from where they were, and the list's marks of its turns are as they were.
  assert.ok((await resume()).latest_seq >= before.latest_seq);
  assert.deepEqual(await listed(), mark);
  // A device that followed it opens it again to go on hearing it.
  await assert.rejects(other.call("prompt.submit", { session_id: session, text: "from the other", profile: "pi" }), (error: RpcFailure) => /Resume it first/.test(error.message));
  await resume(other);
  const start = client.frames.length;
  assert.equal(streamedText(await turn(client, session, "which words?")), "Working. You said: which words?");
  const began = client.frames.slice(start).find((frame) => isEvent(frame, "message.start", session));
  assert.ok(began.params.seq > before.latest_seq, "the thread's events are numbered on from before it was loaded again");
  assert.equal(lines().at(-2).message?.content?.[0]?.text, "which words?");

  // Written at the desk while its process is up: the same.
  assert.equal(pi.alive().length, 1);
  atDesk("Asked with the process up");
  assert.deepEqual((await texts()).slice(-2), ["Asked with the process up", "Done: Asked with the process up"]);
  await resume(other);

  // Written at the desk, then a message sent before the thread was opened again: the
  // turn's new process has what the desk wrote, and so does the thread once opened.
  atDesk("Asked before a message");
  assert.equal(streamedText(await turn(client, session, "and now?")), "Working. You said: and now?");
  assert.deepEqual((await texts()).slice(-4), ["Asked before a message", "Done: Asked before a message", "and now?", "Working. You said: and now?"]);
  await resume(other);

  // At work: nothing is let go of, and the turn ends as it would have.
  const working = client.frames.length;
  assert.equal((await client.call("prompt.submit", { session_id: session, text: "hold desk-2", profile: "pi" })).status, "streaming");
  await client.from(working, (frame) => isEvent(frame, "message.delta", session));
  appendFileSync(file, JSON.stringify(entry(lines().at(-1).id, Date.now(), { type: "custom", customType: "desk", data: {} }).line) + "\n");
  const starts = pi.starts(session).length;
  await resume(other);
  pi.release("desk-2");
  assert.equal((await client.from(working, (frame) => isEvent(frame, "message.complete", session), 5000)).params.payload.status, "complete");
  assert.equal(pi.starts(session).length, starts);
  await client.call("thread.delete", { thread: session });
});

// From Codex's review of a6e4bd2c, both reproduced.
test("Pi: a setting chosen while a device opens the thread again is kept, the thread not loaded again under it", async (t) => {
  const made = await desk(t);
  const { pi, client, bridge } = made;
  const id = "0199f3a0-0000-7000-8000-000000000191";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["Initial"], { level: "none" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  await turn(client, id, "warm it");
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  appendFileSync(file, JSON.stringify(entry(last.id, Date.now(), { type: "custom", customType: "desk", data: {} }).line) + "\n");
  // The level is on its way: it waits for the Mac to say whether a Pi runs in the folder's terminal.
  const held = made.hold();
  t.after(() => held.release());
  const choosing = client.call("config.set", { session_id: id, key: "reasoning", value: "high", profile: "pi" });
  await held.asked;
  await other.call("session.resume", { session_id: id, profile: "pi" });
  held.release();
  await choosing;
  assert.equal((await other.call("session.resume", { session_id: id, profile: "pi" })).info.reasoning_effort, "high");
});

test("Pi: what the thread's own Pi wrote before it died is not taken for the desk's: the failed turn stays, and so do the devices that follow it", async (t) => {
  const made = await desk(t);
  const { pi, client, bridge } = made;
  const id = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id;
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  await turn(client, id, "die");
  await until(() => pi.alive().length === 0);
  const after = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.ok(after.messages.some((message: Frame) => message.display_kind === "failed_turn"), "the bridge's record of the turn that failed stays");
  // Not loaded again: the other device still follows it.
  assert.equal((await other.call("slash.exec", { session_id: id, command: "/status", profile: "pi" })).type, "exec");
});

// From Codex's re-check of 112091df, both reproduced.
test("Pi: a desk write still shows when the thread's Pi, idle, ends by itself before the thread is opened again", async (t) => {
  const { pi, client } = await desk(t);
  const id = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id;
  await turn(client, id, "a phone turn");
  // Opened again once the turn's settings have settled, before the desk writes.
  await client.call("session.resume", { session_id: id, profile: "pi" });
  const file = pi.sessionFiles(id)[0];
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  const question = entry(last.id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk while Pi idled" }], timestamp: Date.now() } });
  const answer = entry(question.id, Date.now(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answered at the desk" }], provider: "openai", model: "gpt-6-luna", stopReason: "stop", timestamp: Date.now() } });
  appendFileSync(file, JSON.stringify(question.line) + "\n" + JSON.stringify(answer.line) + "\n");
  // This thread's Pi alone, idle, ends by itself.
  const pid = pi.starts(id).at(-1)!.pid;
  process.kill(pid, "SIGTERM");
  await until(() => !pi.alive().includes(pid));
  const resumed = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.ok(resumed.messages.some((message: Frame) => message.text === "Asked at the desk while Pi idled"));
});

// From Codex's re-check of 989e97d8, reproduced.
test("Pi: a desk write still shows when the thread's Pi ends by itself while a turn waits to write to it", async (t) => {
  const made = await desk(t);
  const { pi, client } = made;
  const id = "0199f3a0-0000-7000-8000-000000000193";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["Initial"], { level: "none" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  await turn(client, id, "warm it");
  await client.call("session.resume", { session_id: id, profile: "pi" });
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  const question = entry(last.id, Date.now(), { type: "message", message: { role: "user", content: [{ type: "text", text: "Asked at the desk before the turn wrote" }], timestamp: Date.now() } });
  const answer = entry(question.id, Date.now(), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Answered at the desk" }], provider: "openai", model: "gpt-6-luna", stopReason: "stop", timestamp: Date.now() } });
  appendFileSync(file, JSON.stringify(question.line) + "\n" + JSON.stringify(answer.line) + "\n");
  // The turn waits for the Mac to say whether a Pi runs in the folder's terminal; its Pi ends meanwhile.
  const before = pi.sentTo(id, "prompt").length;
  const held = made.hold();
  t.after(() => held.release());
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: id, text: "a turn that waits", profile: "pi" });
  await held.asked;
  assert.equal(pi.sentTo(id, "prompt").length, before, "the turn has written nothing yet");
  const pid = pi.starts(id).at(-1)!.pid;
  process.kill(pid, "SIGTERM");
  await client.from(start, (frame) => isEvent(frame, "message.complete", id));
  held.release();
  await until(() => !pi.alive().includes(pid));
  const resumed = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.ok(resumed.messages.some((message: Frame) => message.text === "Asked at the desk before the turn wrote"));
});

// From Codex's re-check of 47d8c47e, reproduced.
test("Pi: what the thread's own Pi wrote for a setting before it ended is not taken for the desk's: the failed turn stays, and so do the devices that follow it", async (t) => {
  const pi = standin();
  // A stand-in that writes the model change and ends before it answers set_model.
  const agent = new URL("pi-agent.ts", import.meta.url).pathname;
  const altered = join(pi.agentDir, "exit-after-model-write.ts");
  const source = readFileSync(agent, "utf8");
  const answering = '      return answer(id, "set_model", model);';
  assert.ok(source.includes(answering));
  writeFileSync(altered, source.replace(answering, "      return leave(1);").replaceAll("import.meta.url", JSON.stringify(`file://${agent}`)));
  writeFileSync(pi.path, readFileSync(pi.path, "utf8").replace(agent, altered));
  const { client, bridge } = await desk(t, { pi });
  const id = "0199f3a0-0000-7000-8000-000000000194";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["Initial"], { level: "none" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  await client.call("config.set", { session_id: id, key: "model", value: "o3-mini --provider openai --session", profile: "pi" });
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  const events = await turn(client, id, "a turn still giving Pi its model");
  await until(() => pi.alive().length === 0);
  assert.equal(pi.sentTo(id, "prompt").length, 0, "the turn never wrote its prompt");
  assert.ok(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((line) => line.type === "model_change" && line.modelId === "o3-mini"), "Pi wrote its own model change");
  assert.equal(events.at(-1)!.payload.status, "error");
  const after = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.ok(after.messages.some((message: Frame) => message.display_kind === "failed_turn"), "the bridge's record of the turn that failed stays");
  assert.equal((await other.call("slash.exec", { session_id: id, command: "/status", profile: "pi" })).type, "exec");
});

// From Codex's re-check of 88e7bce6, both reproduced.
test("Pi: what the thread's own Pi wrote for a /compact before it ended is not taken for the desk's, though a rename ended meanwhile", async (t) => {
  const pi = standin();
  // A stand-in that writes the compaction and ends before it says the compaction ended.
  const agent = new URL("pi-agent.ts", import.meta.url).pathname;
  const altered = join(pi.agentDir, "exit-after-compact-write.ts");
  const source = readFileSync(agent, "utf8");
  const ending = '  say({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false });';
  assert.ok(source.includes(ending));
  writeFileSync(altered, source.replace(ending, "  return leave(1);").replaceAll("import.meta.url", JSON.stringify(`file://${agent}`)));
  writeFileSync(pi.path, readFileSync(pi.path, "utf8").replace(agent, altered));
  const { client, bridge } = await desk(t, { pi });
  const id = "0199f3a0-0000-7000-8000-000000000195";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["One", "Two"], { name: "Before compaction", level: "none" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  const start = client.frames.length;
  await client.call("prompt.submit", { session_id: id, text: "/compact hold compact-exit", profile: "pi" });
  await until(() => pi.sentTo(id, "compact").length === 1);
  await client.from(start, (frame) => isEvent(frame, "thinking.delta", id) && frame.params.payload.text.includes("Compacting"));
  await client.call("session.rename", { session_id: id, title: "Renamed while compacting", profile: "pi" });
  assert.ok(readFileSync(file, "utf8").includes("Renamed while compacting"));
  pi.release("compact-exit");
  assert.equal((await client.from(start, (frame) => isEvent(frame, "message.complete", id))).params.payload.status, "error");
  await until(() => pi.alive().length === 0);
  assert.ok(readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((line) => line.type === "compaction"), "Pi wrote its own compaction");
  const after = await client.call("session.resume", { session_id: id, profile: "pi" });
  assert.ok(after.messages.some((message: Frame) => message.display_kind === "failed_turn"), "the bridge's record of the turn that failed stays");
  assert.equal((await other.call("slash.exec", { session_id: id, command: "/status", profile: "pi" })).type, "exec");
});

test("Pi: a thread's Pi is not let go of while a setting is on its way to it, and the setting is kept", async (t) => {
  const pi = standin();
  // A stand-in that writes the model change and answers set_model only once let.
  const agent = new URL("pi-agent.ts", import.meta.url).pathname;
  const altered = join(pi.agentDir, "hold-after-model-write.ts");
  const source = readFileSync(agent, "utf8");
  const answering = '      return answer(id, "set_model", model);';
  assert.ok(source.includes(answering));
  writeFileSync(altered, source.replace(answering, '      await released("model-reply");\n' + answering).replaceAll("import.meta.url", JSON.stringify(`file://${agent}`)));
  writeFileSync(pi.path, readFileSync(pi.path, "utf8").replace(agent, altered));
  const { client, bridge, provider } = await desk(t, { pi });
  const id = (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id;
  await turn(client, id, "warm with the default model");
  await client.call("session.resume", { session_id: id, profile: "pi" });
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  const file = pi.sessionFiles(id)[0];
  const choosing = client.call("config.set", { session_id: id, key: "model", value: "o3-mini --provider openai --session", profile: "pi" });
  await until(() => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((line) => line.type === "model_change" && line.modelId === "o3-mini"));
  // The pool's sweep finds it busy: it is not cooled under the setting.
  provider.pool.sweep(Date.now() + 16 * minute);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pi.alive().length, 1);
  pi.release("model-reply");
  await choosing;
  assert.equal((await client.call("session.resume", { session_id: id, profile: "pi" })).info.model, "o3-mini");
  assert.equal((await other.call("slash.exec", { session_id: id, command: "/status", profile: "pi" })).type, "exec");
});

test("Pi: a model chosen while Pi's models are still being read is kept when a device opens the thread again meanwhile", async (t) => {
  const pi = standin();
  // Only the short-lived Pi that lists the models waits, as a slow first start can.
  const original = readFileSync(pi.path, "utf8");
  const gate = join(pi.agentDir, "release", "catalog-ready");
  writeFileSync(pi.path, original.replace("#!/bin/sh\n", `#!/bin/sh\ncase " $* " in *" --no-session "*) while [ ! -f '${gate}' ]; do sleep 0.02; done;; esac\n`));
  const made = await desk(t, { pi });
  const { client, provider, bridge } = made;
  t.after(() => {
    try {
      pi.release("catalog-ready");
    } catch {
      // Released already.
    }
  });
  const id = "0199f3a0-0000-7000-8000-000000000192";
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["Initial"], { level: "none" }) });
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  const other = await TestClient.open(bridge);
  t.after(() => other.close());
  await other.call("session.resume", { session_id: id, profile: "pi" });
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
  appendFileSync(file, JSON.stringify(entry(last.id, Date.now(), { type: "custom", customType: "desk", data: {} }).line) + "\n");
  const entered = Promise.withResolvers<void>();
  const models = provider.models.bind(provider);
  provider.models = async () => {
    entered.resolve();
    return models();
  };
  const choosing = client.call("config.set", { session_id: id, key: "model", value: "o3-mini --provider openai --session", profile: "pi" });
  await entered.promise;
  await other.call("session.resume", { session_id: id, profile: "pi" });
  pi.release("catalog-ready");
  await choosing;
  assert.equal((await other.call("session.resume", { session_id: id, profile: "pi" })).info.model, "o3-mini");
});

test("Pi: a session taken up comes back on the model Pi has for it, which only Pi can say; one whose model this Pi cannot run keeps it, and says so when it is used", async (t) => {
  const made = await desk(t);
  const { pi, client } = made;
  // Put on gpt-5, and answered last by another model: as when the session was left on a router, or on another branch.
  const routed = "0199f3a0-0000-7000-8000-000000000071";
  const lines = conversation(["Route this"], { model: "gpt-5", level: "low" });
  (lines.at(-1)!.message as Record<string, unknown>).model = "gpt-6-luna";
  deskSession(pi, { id: routed, cwd: at("projects/app"), lines });
  const adopted = await client.call("session.adopt", { profile: "pi", session_id: routed, mode: "continue" });
  // Until Pi has opened it, the thread shows what the file last names.
  assert.deepEqual([adopted.info.model, adopted.info.reasoning_effort], ["gpt-6-luna", "low"]);
  assert.equal(streamedText(await turn(client, routed, "Hello.")), "Working. You said: Hello.");
  // Pi came back on gpt-5: that is the thread's, and nothing was set.
  assert.deepEqual(pi.sentTo(routed).filter((sent) => sent.type === "set_model" || sent.type === "set_thinking_level"), []);
  const resumed = await client.call("session.resume", { session_id: routed, profile: "pi" });
  assert.deepEqual([resumed.info.model, resumed.info.provider, resumed.info.reasoning_effort], ["gpt-5", "openai", "low"]);
  // A model chosen here is given to Pi, as for any thread.
  await client.call("config.set", { session_id: routed, key: "model", value: "o3-mini --provider openai --session" });
  assert.deepEqual(pi.sentTo(routed, "set_model").map((sent) => sent.modelId), ["o3-mini"]);
  await client.call("thread.delete", { thread: routed });

  // A session that ran on a model this Pi does not have (a key the bridge's environment
  // lacks): Pi falls back to its default. The thread keeps the session's model, and its
  // turn fails with Pi's word on it, until a model is chosen for the thread.
  const keyless = "0199f3a0-0000-7000-8000-000000000072";
  const other = conversation(["Needs a key"], { model: "mimo-pro" }).map((line) => {
    if (line.type === "model_change") return { ...line, provider: "xiaomi" };
    return line.message && (line.message as Record<string, unknown>).role === "assistant" ? { ...line, message: { ...(line.message as object), provider: "xiaomi" } } : line;
  });
  deskSession(pi, { id: keyless, cwd: at("projects/app"), lines: other });
  const taken = await client.call("session.adopt", { profile: "pi", session_id: keyless, mode: "continue" });
  assert.deepEqual([taken.info.model, taken.info.provider], ["mimo-pro", "xiaomi"]);
  const failed = await turn(client, keyless, "Hello.");
  assert.deepEqual([failed.at(-1).payload.status, failed.at(-1).payload.text], ["error", "Model not found: xiaomi/mimo-pro"]);
  assert.deepEqual(pi.sentTo(keyless, "prompt"), []);
  await client.call("config.set", { session_id: keyless, key: "model", value: "gpt-5 --provider openai --session" });
  assert.equal(streamedText(await turn(client, keyless, "Hello again.")), "Working. You said: Hello again.");
  assert.deepEqual((await client.call("session.resume", { session_id: keyless, profile: "pi" })).info.model, "gpt-5");
  await client.call("thread.delete", { thread: keyless });

  // The file's last word is a model this Pi does not have, but Pi came back on another
  // than its default: it did not fall back, it knows the session better (the model
  // behind a router, a branch the session was not left on). Pi's word stands.
  const behind = "0199f3a0-0000-7000-8000-000000000073";
  const answered = conversation(["Routed"], { model: "gpt-5", level: "low" });
  Object.assign(answered.at(-1)!.message as Record<string, unknown>, { provider: "xiaomi", model: "mimo-pro" });
  deskSession(pi, { id: behind, cwd: at("projects/app"), lines: answered });
  assert.equal((await client.call("session.adopt", { profile: "pi", session_id: behind, mode: "continue" })).info.model, "mimo-pro");
  assert.equal(streamedText(await turn(client, behind, "Hello.")), "Working. You said: Hello.");
  assert.deepEqual(pi.sentTo(behind, "set_model"), []);
  assert.equal((await client.call("session.resume", { session_id: behind, profile: "pi" })).info.model, "gpt-5");
  // A copy's thread has it from the Pi that made the copy, before any turn.
  const copied = await client.call("session.adopt", { profile: "pi", session_id: routed, mode: "fork" });
  assert.deepEqual([copied.info.model, copied.info.reasoning_effort], ["o3-mini", "low"]);
  await client.call("thread.delete", { thread: copied.session_id });
  await client.call("thread.delete", { thread: behind });

  // A model and a level chosen on the phone before Pi was ever started for the thread are given to Pi at its first start.
  const chosen = "0199f3a0-0000-7000-8000-000000000074";
  deskSession(pi, { id: chosen, cwd: at("projects/app"), lines: conversation(["Choose for me"]) });
  await client.call("session.adopt", { profile: "pi", session_id: chosen, mode: "continue" });
  await client.call("config.set", { session_id: chosen, key: "model", value: "o3-mini --provider openai --session" });
  await client.call("config.set", { session_id: chosen, key: "reasoning", value: "high" });
  assert.deepEqual(pi.starts(chosen), []);
  assert.equal(streamedText(await turn(client, chosen, "Hello.")), "Working. You said: Hello.");
  assert.deepEqual(pi.sentTo(chosen, "set_model").map((sent) => sent.modelId), ["o3-mini"]);
  assert.deepEqual(pi.sentTo(chosen, "set_thinking_level").map((sent) => sent.level), ["high"]);
  const kept = await client.call("session.resume", { session_id: chosen, profile: "pi" });
  assert.deepEqual([kept.info.model, kept.info.reasoning_effort], ["o3-mini", "high"]);
  await client.call("thread.delete", { thread: chosen });
});

test("Pi: a session is forked by Pi itself into a new thread with its history, also while a terminal has it; the original is left alone and the copy is not asked about", async (t) => {
  const made = await desk(t);
  const { pi, bridge, client, terminals } = made;
  const id = "0199f3a0-0000-7000-8000-000000000021";
  const lines = recorded("tools", at("projects/app"));
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: [...lines, naming(lines, "Edit hello")] });
  const original = readFileSync(file, "utf8");
  terminals.add(at("projects/app"));

  const forked = await client.call("session.adopt", { profile: "pi", session_id: id, mode: "fork" });
  const fork = forked.session_id as string;
  assert.match(fork, /^fork-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual({ title: forked.info.title, cwd: forked.info.cwd, model: forked.info.model }, { title: "Edit hello (fork)", cwd: at("projects/app"), model: "gpt-6-luna" });
  // One short-lived Pi made the copy, in the session's folder, and is gone.
  const [copier] = pi.starts(fork);
  assert.deepEqual(copier.args, ["--mode", "rpc", "--fork", file, "--session-id", fork, "--offline"]);
  assert.equal(copier.cwd, at("projects/app"));
  assert.deepEqual(pi.log().filter((line) => line.pid === copier.pid && line.kind === "got").map((line) => line.record.type), ["get_state"]);
  await until(() => pi.alive().length === 0);
  const [copy] = pi.sessionFiles(fork);
  const header = JSON.parse(readFileSync(copy, "utf8").split("\n")[0]);
  assert.deepEqual({ id: header.id, cwd: header.cwd, parentSession: header.parentSession }, { id: fork, cwd: at("projects/app"), parentSession: file });
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal((await client.call("session.resume", { session_id: fork })).messages.length, 7);

  // The copy is the bridge's own session: its turn runs though a Pi is in a terminal in the folder.
  assert.equal(streamedText(await turn(client, fork, "Hello.")), "Working. You said: Hello.");
  const [, runner] = pi.starts(fork);
  assert.deepEqual(runner.args, threadArguments(fork, null, pi.agentDir));
  // Pi is given the thread's title as the copy's name, so the desk tells the two apart.
  assert.deepEqual(pi.sentTo(fork, "set_session_name").map((sent) => sent.name), ["Edit hello (fork)"]);
  assert.equal(readFileSync(file, "utf8"), original);
  // The original is still on the desk's list, open.
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => [entry.id, entry.state]), [[id, "open"]]);

  // A Pi that cannot make the copy: refused with why, and no thread is made.
  pi.install(false);
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: id, mode: "fork" }), refused(/^Pi could not copy the session: Pi could not be started at .*\/bin\/pi \(spawn .* ENOENT\)\. Check pi\.path in config\.json\.$/));
  pi.install(true);
  // Nor is one made for a session whose folder is gone, where Pi would have nowhere to start; nor is it continued.
  // A fork is refused by the bridge once Pi has said where the session is, as any agent's
  // session from a folder `desk.list` offers none from; continued, by Pi, which looks first.
  const gone = "0199f3a0-0000-7000-8000-000000000022";
  deskSession(pi, { id: gone, cwd: at("projects/gone"), lines: conversation(["Its folder is gone"]) });
  const starts = pi.starts().length;
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: gone, mode: "fork" }), refused(/^That session is in a folder Portals does not list \(one that is gone/));
  terminals.clear();
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: gone, mode: "continue" }), refused(`The session's folder, ${at("projects/gone")}, is no longer there.`));
  terminals.add(at("projects/app"));
  assert.equal(pi.starts().length, starts);
  assert.deepEqual(threads(bridge).map((thread: Frame) => thread.id), [fork]);

  // Taken off the list, the copy is offered again as the bridge's own removed thread, with its title, and comes back as the same thread.
  await client.call("thread.delete", { thread: fork });
  await until(() => pi.alive().length === 0);
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => [entry.id, entry.title]).sort(), [[fork, "Edit hello (fork)"], [id, "Edit hello"]].sort());
  // Still the bridge's own: taken back though a Pi is in the folder's terminal, where the original is refused.
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }), refused(terminalMayHaveIt));
  assert.equal((await client.call("session.adopt", { profile: "pi", session_id: fork, mode: "continue" })).session_id, fork);
  assert.equal(streamedText(await turn(client, fork, "Still mine.")), "Working. You said: Still mine.");
  await client.call("thread.delete", { thread: fork });
});

test("Pi: a session only read shows no row for a command the Pi in its folder's terminal has not finished, shows the row once the result is written, and shows it as stopped when no Pi is there", async (t) => {
  const made = await desk(t);
  const { pi, client, terminals } = made;
  const id = "0199f3a0-0000-7000-8000-000000000034";
  const lines = conversation(["List the files"]);
  // The desk's Pi is in the middle of a turn: the file ends with its call of a long command.
  const asked = entry(lines.at(-1)!.id as string, now, { type: "message", message: { role: "user", content: [{ type: "text", text: "Run the long one" }], timestamp: now } });
  const calling = entry(asked.id, now, {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Running it." }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 600" } }], provider: "openai", model: "gpt-6-luna", stopReason: "toolUse", timestamp: now },
  });
  const file = deskSession(pi, { id, cwd: at("projects/notes"), lines: [...lines, asked.line, calling.line] });
  terminals.add(at("projects/notes"));
  await client.call("session.adopt", { profile: "pi", session_id: id, mode: "read" });
  /** What the thread shows: each message's text, and each tool row as its name and how it ended. */
  const shown = async () => (await client.call("session.resume", { session_id: id })).messages.map((message: Frame) => (message.role === "tool" ? [message.name, JSON.parse(message.content).error ?? "done"] : message.text));
  const said = ["List the files", "Done: List the files", "Run the long one", "Running it."];

  // The command may still be running: it is not shown as stopped.
  assert.deepEqual(await shown(), said);
  // Nor when the Mac cannot be asked whether a Pi is there.
  made.cannotAsk(true);
  assert.deepEqual(await shown(), said);
  made.cannotAsk(false);
  // No Pi in the folder's terminal: nothing can still be running, so the command was stopped.
  terminals.clear();
  assert.deepEqual(await shown(), [...said, ["terminal", "Stopped before it finished."]]);
  // The Pi at the desk again, and the command done: the row has its result.
  terminals.add(at("projects/notes"));
  const result = entry(calling.id, now, { type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "slept\n" }], isError: false, durationMs: 600_000, timestamp: now } });
  appendFileSync(file, JSON.stringify(result.line) + "\n");
  assert.deepEqual(await shown(), [...said, ["terminal", "done"]]);
  assert.deepEqual(pi.starts(id), []);
  await client.call("thread.delete", { thread: id });
});

test("Pi: a session only read takes no message and starts no process, shows what the terminal adds, and is continued once no Pi runs in its folder", async (t) => {
  const made = await desk(t);
  const { pi, bridge, client, terminals } = made;
  const id = "0199f3a0-0000-7000-8000-000000000031";
  const lines = conversation(["Write a haiku", "Now one about rain"], { model: "gpt-5", level: "low" });
  // The model, the level, and the first message with its reply.
  const file = deskSession(pi, { id, cwd: at("projects/app"), lines: lines.slice(0, 4) });
  terminals.add(at("projects/app"));

  const read = await client.call("session.adopt", { profile: "pi", session_id: id, mode: "read" });
  assert.equal(read.session_id, id);
  // Named after how it began, and on the model and level it was last put on at the desk.
  assert.deepEqual({ title: read.info.title, model: read.info.model, provider: read.info.provider, level: read.info.reasoning_effort }, { title: "Write a haiku", model: "gpt-5", provider: "openai", level: "low" });
  assert.equal(threads(bridge)[0].readOnly, true);
  await assert.rejects(client.call("prompt.submit", { session_id: id, text: "Hi." }), refused(readOnlyText));
  await assert.rejects(client.call("config.set", { session_id: id, key: "reasoning", value: "low" }), refused(readOnlyText));
  assert.deepEqual((await client.call("session.resume", { session_id: id })).messages.map((message: Frame) => message.text), ["Write a haiku", "Done: Write a haiku"]);
  // The terminal went on: the next look shows it.
  appendFileSync(file, lines.slice(4).map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.deepEqual((await client.call("session.resume", { session_id: id })).messages.map((message: Frame) => message.text), ["Write a haiku", "Done: Write a haiku", "Now one about rain", "Done: Now one about rain"]);

  // Continued, while a Pi is still in the folder's terminal: refused, and it stays only read.
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" }), refused(terminalMayHaveIt));
  await assert.rejects(client.call("prompt.submit", { session_id: id, text: "Hi." }), refused(readOnlyText));
  assert.deepEqual(pi.starts(id), []);
  // That Pi quit: it is continued, as the same thread.
  terminals.clear();
  const continued = await client.call("session.adopt", { profile: "pi", session_id: id, mode: "continue" });
  assert.equal(continued.session_id, id);
  assert.equal(threads(bridge)[0].readOnly, undefined);
  assert.equal(streamedText(await turn(client, id, "Hello.")), "Working. You said: Hello.");
  assert.equal(pi.starts(id).length, 1);
  // Pi came back on that model and level by itself: neither was set.
  assert.deepEqual(pi.sentTo(id).filter((sent) => sent.type === "set_model" || sent.type === "set_thinking_level"), []);
  await client.call("thread.delete", { thread: id });

  // A session with nothing to call it by is listed as untitled and taken up with no title: its next message titles it, and Pi is given no made-up name.
  const untitled = "0199f3a0-0000-7000-8000-000000000033";
  deskSession(pi, { id: untitled, cwd: at("projects/app"), lines: [entry(null, now, { type: "message", message: { role: "user", content: [{ type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: now } }).line] });
  assert.equal((await client.call("desk.list", { profile: "pi" })).sessions.find((listed: Frame) => listed.id === untitled).title, "Untitled session");
  const plain = await client.call("session.adopt", { profile: "pi", session_id: untitled, mode: "continue" });
  assert.equal(plain.info.title, undefined);
  await turn(client, untitled, "What is in the picture?");
  assert.deepEqual(pi.sentTo(untitled, "set_session_name").map((sent) => sent.name), ["What is in the picture?"]);
  await client.call("thread.delete", { thread: untitled });

  // A session whose file names no model is taken up on Pi's own default, at the model's own level.
  const bare = "0199f3a0-0000-7000-8000-000000000032";
  deskSession(pi, { id: bare, cwd: at("projects/app"), lines: [entry(null, now, { type: "message", message: { role: "user", content: "From an older Pi", timestamp: now } }).line] });
  const taken = await client.call("session.adopt", { profile: "pi", session_id: bare, mode: "read" });
  assert.deepEqual({ title: taken.info.title, model: taken.info.model, provider: taken.info.provider, level: taken.info.reasoning_effort }, { title: "From an older Pi", model: "gpt-6-luna", provider: "openai", level: "" });
});

test("Pi: a Pi too old to run a turn makes no copy either", async (t) => {
  const pi = standin();
  pi.version("0.99.0");
  const made = await desk(t, { pi, checkVersion: true });
  const id = "0199f3a0-0000-7000-8000-000000000051";
  deskSession(pi, { id, cwd: at("projects/app"), lines: conversation(["Old Pi"]) });
  await assert.rejects(made.client.call("session.adopt", { profile: "pi", session_id: id, mode: "fork" }), refused(`Pi 0.99.0 is too old for the bridge, which needs 1.1.0 or newer. Update it on the ${machineWord()} (pi update), then send the message again.`));
  assert.deepEqual(pi.starts().filter((line) => line.args?.includes("--fork")), []);
  assert.deepEqual(threads(made.bridge), []);
});

test("Pi: threads taken up from the desk are kept across a restart as they were taken up: one continued is asked about again, a copy is not, one only read takes nothing", async (t) => {
  const first = await desk(t);
  const { pi, terminals } = first;
  const continued = "0199f3a0-0000-7000-8000-000000000041";
  const read = "0199f3a0-0000-7000-8000-000000000042";
  const source = "0199f3a0-0000-7000-8000-000000000043";
  for (const id of [continued, read, source]) deskSession(pi, { id, cwd: at("projects/notes"), lines: conversation([`Session ${id.slice(-1)}`]) });
  await first.client.call("session.adopt", { profile: "pi", session_id: continued, mode: "continue" });
  await first.client.call("session.adopt", { profile: "pi", session_id: read, mode: "read" });
  const fork = (await first.client.call("session.adopt", { profile: "pi", session_id: source, mode: "fork" })).session_id as string;
  await until(() => pi.alive().length === 0);
  await first.stop();

  const second = await desk(t, { again: first });
  const { client } = second;
  assert.deepEqual(
    threads(second.bridge).map((thread: Frame) => [thread.id, thread.origin, thread.readOnly === true]).sort(),
    [[continued, "desk", false], [read, "desk", true], [fork, "desk", false]].sort(),
  );
  // Only the session nobody took up as it was is still offered.
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions.map((entry: Frame) => entry.id), [source]);
  for (const id of [continued, read, fork]) {
    assert.deepEqual((await client.call("session.resume", { session_id: id, profile: "pi" })).messages.map((message: Frame) => message.role), ["user", "assistant"]);
  }

  terminals.add(at("projects/notes"));
  const stopped = await turn(client, continued, "Hello.");
  assert.deepEqual([stopped.at(-1).payload.status, stopped.at(-1).payload.text], ["error", terminalMayHaveIt]);
  assert.equal(streamedText(await turn(client, fork, "Hello.")), "Working. You said: Hello.");
  await assert.rejects(client.call("prompt.submit", { session_id: read, text: "Hi." }), refused(readOnlyText));
  assert.deepEqual([pi.starts(continued).length, pi.starts(read).length], [0, 0]);
  await client.call("thread.delete", { thread: fork });
});

test("Pi: a thread taken off the list is offered again while Pi still has its session, with the title it had, and comes back as the same thread", async (t) => {
  const made = await desk(t);
  const { pi, provider, bridge, client } = made;
  const create = async () => (await client.call("session.create", { profile: "pi", source: "tui", cwd: at("projects") })).session_id as string;
  const kept = await create();
  await turn(client, kept, "remember kiwi");
  await client.call("session.rename", { session_id: kept, title: "The kiwi thread", profile: "pi" });
  const deleted = await create();
  await turn(client, deleted, "remember plum");
  const empty = await create();
  provider.pool.sweep(Date.now() + 16 * minute);
  await until(() => pi.alive().length === 0);
  for (const thread of [kept, deleted, empty]) await client.call("thread.delete", { thread });
  // Its session deleted at the desk since.
  for (const file of pi.sessionFiles(deleted)) rmSync(file);

  const listed = (await client.call("desk.list", { profile: "pi" })).sessions;
  // One with no message has nothing to take up; one Pi no longer has cannot be.
  assert.deepEqual(listed.map((entry: Frame) => [entry.id, entry.title, entry.folder, entry.state]), [[kept, "The kiwi thread", at("projects"), "closed"]]);
  await assert.rejects(client.call("session.adopt", { profile: "pi", session_id: deleted, mode: "continue" }), refused(`Pi has no session by that id on this ${machineWord()}.`));

  const back = await client.call("session.adopt", { profile: "pi", session_id: kept, mode: "continue" });
  assert.deepEqual([back.session_id, back.info.title], [kept, "The kiwi thread"]);
  assert.deepEqual((await client.call("session.resume", { session_id: kept, profile: "pi" })).messages.map((message: Frame) => message.text), ["remember kiwi", "Working. You said: remember kiwi"]);
  assert.equal(threads(bridge)[0].origin, "desk");
  assert.deepEqual((await client.call("desk.list", { profile: "pi" })).sessions, []);
  assert.equal(streamedText(await turn(client, kept, "which word?")), "Working. You said: which word?");
  await client.call("thread.delete", { thread: kept });
});

test("on Linux a Pi in a terminal is found in /proc: its stat names it pi and gives it a terminal", () => {
  // pid (comm) state ppid pgrp session tty_nr tpgid …: 34817 is /dev/pts/1.
  assert.equal(procIsTerminalPi("4242 (pi) S 4100 4242 4100 34817 4242 4194304 0 0"), true);
  // The bridge's own Pi has no terminal (0); a process of another name is no Pi.
  assert.equal(procIsTerminalPi("4243 (pi) S 1 4243 4243 0 -1 4194304 0 0"), false);
  assert.equal(procIsTerminalPi("4244 (node) S 4100 4244 4100 34817 4244 4194304 0 0"), false);
  assert.equal(procIsTerminalPi("4245 (pip) S 4100 4245 4100 34817 4245 4194304 0 0"), false);
  // A name may hold spaces and brackets: the last bracket ends it.
  assert.equal(procIsTerminalPi("4246 (a (pi) b) S 4100 4246 4100 34817 4246 0 0 0"), false);
  assert.equal(procIsTerminalPi(""), false);
  assert.equal(procIsTerminalPi("4247 (pi) S"), false);
});

test("on Linux /proc is read a few files at a time; a process gone or hidden is skipped, any other failure fails the check rather than hide a Pi", async () => {
  const names = ["self", ...Array.from({ length: 1500 }, (_, index) => String(1000 + index))];
  let open = 0;
  let most = 0;
  const reader = (fail: (pid: number) => NodeJS.ErrnoException | undefined) => ({
    list: async () => names,
    read: async (path: string) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
      const pid = Number(path.split("/")[2]);
      const error = fail(pid);
      if (error) throw error;
      return `${pid} (bash) S 1 ${pid} ${pid} 34817 ${pid} 0 0 0`;
    },
  });
  const failing = (code: string) => Object.assign(new Error(code), { code });
  // No Pi among them; gone and another user's are skipped.
  assert.deepEqual(await procTerminalPis(reader((pid) => (pid === 1200 ? failing("ENOENT") : pid === 1300 ? failing("EACCES") : undefined))), { folders: [], unread: [] });
  assert.ok(most <= procReadsAtOnce, `${most} at once`);
  // Out of files: the check fails, and the turn is not sent.
  await assert.rejects(procTerminalPis(reader((pid) => (pid === 1400 ? failing("EMFILE") : undefined))), /\/proc\/1400\/stat could not be read/);
});
