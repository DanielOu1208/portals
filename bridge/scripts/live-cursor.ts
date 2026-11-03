import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { CursorProvider } from "../src/providers/cursor/provider.ts";
import { modelAt } from "../src/providers/cursor/models.ts";
import { isEvent, startTestBridge, TestClient } from "../test/helpers.ts";

// A live check of the Cursor agent through a whole bridge: the test harness's bridge
// (the real gateway and sessions) with the real `cursor-agent` behind it, on cheap
// models, in a scratch folder. One PASS or FAIL line a check; exit 1 when one failed.
//
//   node scripts/live-cursor.ts
//
// It uses the user's Cursor sign-in and plan (some twenty short turns on GPT-5.4 Nano and
// Gemini 2.5 Flash, one subagent, one web search asked about and denied). Choosing a
// model selects it in Cursor itself, so the model Cursor was on, with its settings, is
// selected again at the end. What it leaves: its sessions in ~/.cursor/acp-sessions/,
// as every Cursor session does. LIVE_ROOT is the scratch folder.

const root = process.env.LIVE_ROOT ?? join(realpathSync("/tmp"), "portals-cursor-live");
const work = join(root, "work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(join(work, "notes.txt"), "The word of the day is quince.\n");
for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(work, name), `${name}\n`);

const cheap = "gpt-5.4-nano";
const noLevels = "gemini-2.5-flash";
const results: { name: string; ok: boolean; note: string }[] = [];
function check(name: string, ok: boolean, note = ""): void {
  results.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
}

const provider = new CursorProvider({ command: join(homedir(), ".local/bin/cursor-agent"), directory: join(root, "state-cursor"), idleMs: 20_000 });
const bridge = await startTestBridge({ providers: new Map([["cursor", provider]]), temporaryFolders: [], config: { generalFolder: work } });
const client = await TestClient.open(bridge);
const long = 240_000;
// Real Cursor: a call that starts its process, or loads a session, takes longer than the tests' 5 s.
let ids = 0;
client.call = async (method: string, params: Record<string, unknown> = {}) => {
  const id = `live${ids++}`;
  client.send({ jsonrpc: "2.0", id, method, params });
  const response = await client.find((frame: any) => frame.id === id && frame.method === undefined && ("result" in frame || "error" in frame), long);
  if (response.error) throw new Error(response.error.message);
  return response.result;
};

async function turn(session: string, text: string, extra: Record<string, unknown> = {}): Promise<any[]> {
  const before = client.events(session).length;
  const start = client.frames.length;
  const submitted = await client.call("prompt.submit", { session_id: session, text, ...extra });
  if (submitted.status !== "streaming") throw new Error(`expected a new turn, got ${submitted.status}`);
  await client.from(start, (frame: any) => isEvent(frame, "message.complete", session), long);
  return client.events(session).slice(before);
}
const last = (events: any[]) => events.at(-1)?.payload ?? {};
const on = async () => {
  const process = await provider.process(work);
  const current = process.current ?? [];
  const value = (id: string) => current.find((option: any) => option?.id === id)?.currentValue;
  return { model: modelAt(current), reasoning: value("reasoning"), effort: value("effort") };
};

/** What Cursor was on before the run: its model and that model's settings, selected again at the end. */
let was: { session: string; options: { id: string; value: string }[] } | null = null;
try {
  // 1. The catalogue.
  const session = (await client.call("session.create", { profile: "cursor", source: "tui" })).session_id;
  const startedOn = (await provider.process(work)).current ?? [];
  const model = startedOn.find((option: any) => option?.id === "model")?.currentValue;
  const settings = startedOn.filter((option: any) => option?.category === "thought_level" || option?.category === "model_config");
  if (typeof model === "string") was = { session, options: [{ id: "model", value: model }, ...settings.map((option: any) => ({ id: option.id, value: String(option.currentValue) }))] };
  const options = await client.call("model.options", { profile: "cursor" });
  check("model list", options.providers[0].models.length > 40, `${options.providers[0].models.length} models`);
  check("no levels for Cursor's own and Auto", JSON.stringify(options.model_levels.default) === "[]" && JSON.stringify(options.model_levels.auto) === "[]");
  check(`levels for ${cheap}`, (options.model_levels[cheap] ?? []).includes("low"), JSON.stringify(options.model_levels[cheap]));
  check(`no levels for ${noLevels}`, JSON.stringify(options.model_levels[noLevels]) === "[]");
  const ready = client.readyPayload.bridge.features as string[];
  check("model_levels_none offered", ready.includes("model_levels_none"));

  // 2. A model and a level, set in Cursor before the turn.
  await client.call("config.set", { key: "model", value: `${cheap} --provider cursor --session`, session_id: session });
  await client.call("config.set", { key: "reasoning", value: "low", session_id: session });
  let events = await turn(session, "Reply with the single word ok.");
  check("first turn completes", last(events).status === "complete", JSON.stringify(last(events).text));
  let now = await on();
  check(`Cursor on ${cheap} at low`, now.model === cheap && (now.reasoning === "low" || now.effort === "low"), JSON.stringify(now));
  await client.call("config.set", { key: "reasoning", value: "medium", session_id: session });
  events = await turn(session, "Reply with the single word two.");
  now = await on();
  check("level change applied at the next turn", now.model === cheap && (now.reasoning === "medium" || now.effort === "medium"), JSON.stringify(now));

  // 3. A model with no levels: a level is refused with a sentence, the turn runs.
  await client.call("config.set", { key: "model", value: `${noLevels} --provider cursor --session`, session_id: session });
  let refused = "";
  try {
    await client.call("config.set", { key: "reasoning", value: "high", session_id: session });
  } catch (error) {
    refused = (error as Error).message;
  }
  check("a level for a model with none is refused", /no thinking levels/i.test(refused), refused);
  events = await turn(session, "Reply with the single word three.");
  now = await on();
  check(`turn on ${noLevels}`, last(events).status === "complete" && now.model === noLevels, `${JSON.stringify(last(events).text)} ${JSON.stringify(now)}`);
  await client.call("config.set", { key: "model", value: `${cheap} --provider cursor --session`, session_id: session });

  // 4. Ask mode: reads only.
  await client.call("session.set_mode", { session_id: session, mode: "ask" });
  events = await turn(session, "Create a file named made.txt holding the word hi. If you cannot, say so in one short sentence.");
  check("ask mode edits nothing", !existsSync(join(work, "made.txt")), JSON.stringify(last(events).text).slice(0, 160));
  await client.call("session.set_mode", { session_id: session, mode: "default" });

  // 5. A mention: Cursor reads the file itself.
  events = await turn(session, "What is the word of the day in the file I mention? Answer with the word only.", { mentions: ["notes.txt"] });
  check("mentioned file read", /quince/i.test(String(last(events).text)), JSON.stringify(last(events).text));

  // 6. An image.
  const png = square(32, [220, 20, 20]);
  await client.call("image.attach_bytes", { session_id: session, content_base64: png.toString("base64"), filename: "red.png" });
  events = await turn(session, "What colour is this image? One word.");
  check("image seen", /red/i.test(String(last(events).text)), JSON.stringify(last(events).text));

  // 7. A subagent on the line.
  const mark = client.events(session).length;
  events = await turn(session, "Use your Task tool exactly once: start one subagent that lists the files in this folder and says how many .txt files there are. Wait for it, then reply with that number only.");
  const lines = client.events(session).slice(mark).filter((event: any) => event.type.startsWith("subagent."));
  const start = lines.find((event: any) => event.type === "subagent.start");
  const end = lines.find((event: any) => event.type === "subagent.complete");
  check("subagent started on the line", !!start, start ? `${start.payload.goal} / ${start.payload.role}` : "");
  check("subagent ended with its answer", end?.payload.status === "completed" && !!end?.payload.result, end ? `${end.payload.status}: ${String(end.payload.result).slice(0, 80)}` : "");
  check("turn after the subagent", last(events).status === "complete", JSON.stringify(last(events).text).slice(0, 120));

  // 8. A web search asked about: denied, blocked.
  const before = client.frames.length;
  const asking = client.call("prompt.submit", { session_id: session, text: "Search the web once for: agent client protocol. If you are not allowed to, say so in one short sentence and do not try another way." });
  await asking;
  const request = await client.from(before, (frame: any) => frame.method === "approval" || isEvent(frame, "message.complete", session), long);
  if (request.method === "approval") {
    check("web search asks first", true, request.params.command);
    client.answer(request.id, { choice: "deny" });
    await client.from(before, (frame: any) => isEvent(frame, "message.complete", session), long);
    const rows = client.events(session).filter((event: any) => event.type === "tool.complete");
    check("denied search is blocked", JSON.stringify(rows.at(-1)?.payload ?? {}).includes("blocked"), JSON.stringify(rows.at(-1)?.payload?.result ?? "").slice(0, 100));
  } else {
    check("web search asks first", false, "no approval came (Cursor's settings may allow it)");
  }

  // 8b. Full access: Cursor started with --force asks nothing, so the search runs.
  const agentLabel = (options.mode_options ?? []).find((option: any) => option.id === "default")?.label;
  check("the agent mode is called Agent", agentLabel === "Agent", String(agentLabel));
  await client.call("session.set_mode", { session_id: session, mode: "full" });
  const fullStart = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "Search the web once for: agent client protocol. Then say in one short sentence what you found." });
  const fullEnd = await client.from(fullStart, (frame: any) => frame.method === "approval" || isEvent(frame, "message.complete", session), long);
  if (fullEnd.method === "approval") {
    check("Full access asks nothing", false, `an approval came: ${fullEnd.params.command}`);
    client.answer(fullEnd.id, { choice: "deny" });
    await client.from(fullStart, (frame: any) => isEvent(frame, "message.complete", session), long);
  } else {
    const searched = client.frames.slice(fullStart).filter((frame: any) => isEvent(frame, "tool.complete", session) && JSON.stringify(frame.params.payload).includes("web_search"));
    check("Full access asks nothing", fullEnd.params.payload.status === "complete", `${searched.length} search(es), ${JSON.stringify(fullEnd.params.payload.text).slice(0, 100)}`);
    check("the search ran, not blocked", searched.length > 0 && !JSON.stringify(searched.at(-1)?.params.payload).includes("blocked"), JSON.stringify(searched.at(-1)?.params.payload?.result ?? "").slice(0, 100));
  }
  await client.call("session.set_mode", { session_id: session, mode: "default" });

  // 9. Stop.
  const stopStart = client.frames.length;
  await client.call("prompt.submit", { session_id: session, text: "Count from 1 to 400, one number per line, with no other text. Do not use any tools." });
  await client.from(stopStart, (frame: any) => isEvent(frame, "message.delta", session), long);
  await client.call("session.interrupt", { session_id: session });
  const stopped = await client.from(stopStart, (frame: any) => isEvent(frame, "message.complete", session), 60_000);
  check("Stop ends the turn", stopped.params.payload.status === "interrupted", stopped.params.payload.status);

  // 10. Fork: a new thread that goes on from the conversation.
  const forked = await client.call("session.adopt", { profile: "cursor", session_id: session, mode: "fork" });
  const fork = forked.session_id;
  check("fork made", typeof fork === "string" && fork !== session, fork);
  events = await turn(fork, "Earlier in this conversation you were shown a file. What was the word of the day in it? Answer with the word only.");
  check("fork goes on from the conversation", /quince/i.test(String(last(events).text)), JSON.stringify(last(events).text));

  // 11. Idle stop, then the session taken up again.
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  events = await turn(session, "What was the single word I asked you to reply with in my very first message? Answer with that word only.");
  check("after the idle stop, the session is taken up again", last(events).status === "complete" && /ok/i.test(String(last(events).text)), JSON.stringify(last(events).text));

  // 12. Folders.
  const folders = (await client.call("folders.list")).folders.map((folder: any) => folder.path);
  check("Cursor's own folders offered", folders.some((path: string) => path.includes("cursor-roblox") || path.includes("aericode")), `${folders.length} folders`);
} catch (error) {
  check("the run", false, (error as Error).stack ?? String(error));
} finally {
  if (was) {
    // On a session of its own: the run's may be gone with its process, and a set on a session Cursor has not loaded fails.
    let restored = false;
    try {
      const process = await provider.process(work);
      const made = await process.client.call<any>("session/new", { cwd: work, mcpServers: [] });
      let options: any[] = made?.configOptions ?? [];
      for (const option of was.options) {
        const answer = await process.client.call<any>("session/set_config_option", { sessionId: made.sessionId, configId: option.id, value: option.value });
        if (Array.isArray(answer?.configOptions)) options = answer.configOptions;
      }
      const at = (id: string) => String(options.find((option: any) => option?.id === id)?.currentValue);
      restored = was.options.every((option) => at(option.id) === option.value);
    } catch (error) {
      console.log(`could not select Cursor's model again: ${(error as Error).message}`);
    }
    const said = was.options.map((option) => `${option.id}=${option.value}`).join(", ");
    check("Cursor's model selected again as it was", restored, said);
  }
  await client.close();
  await bridge.dispose();
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2));
}

function square(size: number, colour: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const whole = Buffer.alloc(body.length + 8);
    whole.writeUInt32BE(data.length, 0);
    body.copy(whole, 4);
    whole.writeUInt32BE(crc32(body), body.length + 4);
    return whole;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).fill(Buffer.from(colour))]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
process.exit(results.every((result) => result.ok) ? 0 : 1);
