import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { Provider, StoredMessage } from "../src/providers/types.ts";
import type { ThreadRecord } from "../src/sessions/registry.ts";
import { claudeFolderName, claudeSessionFile, ClaudeSessionFiles, CodexRollouts, RememberedFiles, rolloutId } from "../src/search/locate.ts";
import { fold, holds, matches, mayHold, parseQuery, snippet, snippetLength } from "../src/search/match.ts";
import { checkLinkedCursor, searchLinked } from "../src/search/linked.ts";
import { scanFile, storedMessages, type Budget, type SearchedMessage, type SearchFile } from "../src/search/readers.ts";
import { BadCursor, EmptyQuery, encodeCursor, ThreadSearch, type SearchResult, type ThreadHits } from "../src/search/search.ts";
import { createThread, runTurn, startTestBridge, TestClient } from "./helpers.ts";

// Search inside threads (feature thread_search): the matching, each agent's file read as
// that agent writes it, the paging, and the method through a bridge.

const fixtures = new URL("fixtures/search/", import.meta.url);
const fixture = (name: string) => new URL(name, fixtures).pathname;

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), "thread-search-"));
});
const claudeConfig = process.env.CLAUDE_CONFIG_DIR;
after(() => {
  rmSync(root, { recursive: true, force: true });
  if (claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = claudeConfig;
});

function budget(signal = new AbortController().signal): Budget {
  return { bytes: Number.MAX_SAFE_INTEGER, signal, pause: async () => {} };
}

async function scan(file: SearchFile, query: string): Promise<SearchedMessage[]> {
  const found: SearchedMessage[] = [];
  await scanFile(file, parseQuery(query)!, budget(), (message) => found.push(message));
  return found;
}

// MARK: Matching

test("a query is words and quoted phrases, folded for case and accents, a word that begins another left to it", () => {
  assert.deepEqual(parseQuery('Relay "push  Token" relay rela')!.terms, ["push token", "relay"]);
  // `token` begins a word of the phrase, `oken` does not: a hit for the phrase need not hold `oken` at a word's start.
  assert.deepEqual(parseQuery('"push token" token oken')!.terms, ["push token", "oken"]);
  assert.deepEqual(parseQuery("Café RÉSUMÉ")!.terms, ["resume", "cafe"]);
  assert.equal(parseQuery("   "), null);
  assert.equal(parseQuery('""'), null);
  assert.equal(fold("ΟΔΟΣ Straße"), "οδοσ strasse".replace("ss", "ß"));
  assert.equal(fold("a\n\n  b"), "a b");
});

test("a message is a hit when it holds every word, whatever the case, accents and line breaks", () => {
  const query = parseQuery('cafe "relay plan"')!;
  assert.equal(holds("The CAFÉ and the relay\nplan", query), true);
  assert.equal(holds("The café and the relay", query), false);
  assert.equal(holds("", query), false);
  // A word that begins a longer one.
  assert.equal(holds("Deployment notes", parseQuery("deploy")!), true);
});

// MARK: Where a word begins (2026-10-26: "Start of words")

test("a word matches where a word of the text begins: deploy finds deployment, log finds login but not catalog", () => {
  const log = parseQuery("log")!;
  assert.equal(holds("The login page", log), true);
  assert.equal(holds("The catalog page", log), false);
  assert.equal(holds("A blog, a dialog", log), false);
  assert.equal(holds("catalog, then login", log), true);
  assert.deepEqual(matches("catalog, then login", log), [{ start: 14, end: 17 }]);
  assert.equal(holds("Deployment", parseQuery("DEPLOY")!), true);
  assert.equal(holds("Redeploy it", parseQuery("deploy")!), false);
  // Every word must begin a word: one inside a word is not enough.
  assert.equal(holds("catalog of deployments", parseQuery("deploy log")!), false);
  // Digits are part of a word too: `2` is not the start of `v2`, `2026` is of `2026-10-26`.
  assert.equal(holds("Codex v2", parseQuery("2")!), false);
  assert.equal(holds("On 2026-10-26", parseQuery("10")!), true);
});

test("punctuation, white space, an underscore and an emoji end a word; a capital inside a word begins one", () => {
  const search = parseQuery("search")!;
  for (const text of ["thread_search", "thread-search", "thread.search", "(search)", "threadSearch", "ThreadSearchWire", "THREAD_SEARCH", "🔎search"]) {
    assert.equal(holds(text, search), true, text);
  }
  assert.equal(holds("research", search), false);
  assert.equal(holds("Researching", search), false);
  // The last capital of a run, before a small letter: HTTPServer is HTTP and Server.
  assert.equal(holds("HTTPServer", parseQuery("server")!), true);
  assert.equal(holds("HTTPServer", parseQuery("http")!), true);
  assert.equal(holds("HTTPSERVER", parseQuery("server")!), false);
  // A capital after a digit: utf8Decoder.
  assert.equal(holds("utf8Decoder", parseQuery("decoder")!), true);
  // A whole word written as one still matches all of it: `threadsearch` finds threadSearch.
  assert.equal(holds("threadSearch", parseQuery("threadsearch")!), true);
  // The marks fall on the word's own part.
  const text = "call threadSearch, then research";
  assert.deepEqual(matches(text, search).map((range) => text.slice(range.start, range.end)), ["Search"]);
});

test("accents and emoji: folded alike, a word after an accented letter is not a word's start", async () => {
  assert.equal(holds("Éclair", parseQuery("eclair")!), true);
  assert.equal(holds("Éclair", parseQuery("clair")!), false);
  // Decomposed: e and a combining accent, then the rest of the word.
  assert.equal(holds("e\u0301clair", parseQuery("clair")!), false);
  assert.equal(holds("e\u0301clair", parseQuery("éclair")!), true);
  assert.equal(holds("naïve CAFÉ", parseQuery("cafe naive")!), true);
  // A capital accented letter inside a word begins one: `cafeÉclair`.
  assert.equal(holds("cafeÉclair", parseQuery("eclair")!), true);
  // An emoji is not a letter: a word right after one begins there, and an emoji term matches anywhere.
  assert.equal(holds("go🚀launch", parseQuery("launch")!), true);
  assert.equal(holds("go🚀launch", parseQuery("🚀")!), true);
  assert.equal(holds("go🚀launch", parseQuery("o🚀")!), false);
  const shown = (await snippet("👍🏽 then 🚀launch, not relaunch", parseQuery("launch")!))!;
  assert.deepEqual(shown.ranges.map((range) => shown.text.slice(range.start, range.end)), ["launch"]);
  assert.equal(shown.text.slice(0, shown.ranges[0].start), "👍🏽 then 🚀");
});

test("scripts written without spaces: a word of them matches anywhere, and a word right after one of their letters begins there", async () => {
  assert.equal(holds("我们在线程里搜索消息", parseQuery("搜索")!), true);
  assert.equal(holds("スレッドを検索する", parseQuery("検索")!), true);
  assert.equal(holds("データベース", parseQuery("ベース")!), true);
  assert.equal(holds("การค้นหาข้อความ", parseQuery("ค้นหา")!), true);
  // Latin right after Chinese.
  assert.equal(holds("用Swift写", parseQuery("swift")!), true);
  const text = "我们用Swift写，不用Swiftly";
  const shown = (await snippet(text, parseQuery("swift")!))!;
  assert.deepEqual(shown.ranges.map((range) => shown.text.slice(range.start, range.end)), ["Swift", "Swift"]);
  // Korean is written with spaces: its words begin where they begin.
  assert.equal(holds("스레드 검색", parseQuery("검색")!), true);
  assert.equal(holds("스레드검색", parseQuery("검색")!), false);
  // A term of punctuation matches anywhere.
  assert.equal(holds("cp .env.local x.env", parseQuery(".env")!), true);
  assert.equal(holds("issue#12", parseQuery("#12")!), true);
});

test("a phrase begins at a word's start, and its last word may run on into a longer one", async () => {
  const phrase = parseQuery('"relay push"')!;
  assert.equal(holds("the relay pushes it", phrase), true);
  assert.equal(holds("the prerelay push", phrase), false);
  assert.equal(holds("the prerelay push, the relay\npush", phrase), true);
  const text = "the prerelay push, the relay\npushes";
  assert.deepEqual(matches(text, phrase).map((range) => text.slice(range.start, range.end)), ["relay\npush"]);
  const shown = (await snippet(text, phrase))!;
  assert.deepEqual(shown.ranges.map((range) => shown.text.slice(range.start, range.end)), ["relay push"]);
});

test("whether a message holds a word, its marks and its snippet agree, on text of every kind of letter and boundary", async () => {
  // Small texts of capitals, accents written both ways, digits, punctuation, white space, Chinese and an emoji.
  const pieces = ["a", "b", "A", "B", "é", "É", "e\u0301", "E\u0301", "\u0301", "\uff9e", "1", " ", "  ", "\n", "_", "-", "搜", "🚀", "ab", "Ab", "AB"];
  const terms = ["a", "b", "ab", "ba", "e", "eb", "1a", "搜a", "a b", "-b", "🚀a"];
  let seed = 7;
  const random = (count: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % count;
  };
  for (let round = 0; round < 3000; round += 1) {
    const text = Array.from({ length: 1 + random(9) }, () => pieces[random(pieces.length)]).join("");
    const term = terms[random(terms.length)];
    const query = parseQuery(term.includes(" ") ? `"${term}"` : term)!;
    const held = holds(text, query);
    const marked = matches(text, query);
    const shown = await snippet(text, query);
    const context = JSON.stringify({ text, term });
    assert.equal(marked.length > 0, held, context);
    assert.equal(shown !== null, held, context);
    if (shown) assert.equal(shown.ranges[0]?.start, (shown.text.startsWith("…") ? 1 : 0) + marked[0].start, context);
  }
});

test("a capital after a long run of combining marks is told in time, and what folds to nothing as a mark does is passed over alike", async () => {
  // Each mark looked at a bounded number of times: a run of 20,000 is milliseconds, not the 11 s it was (bounds kept wide for a busy machine).
  const long = `a${"\u0301".repeat(20_000)}Search`;
  const search = parseQuery("search")!;
  const started = performance.now();
  assert.equal(holds(long, search), true);
  const shown = (await snippet(long, search))!;
  assert.equal(shown.text.slice(shown.ranges[0].start, shown.ranges[0].end), "Search");
  assert.ok(performance.now() - started < 2500, `${performance.now() - started}`);
  // Marks that decomposing would put in order (two classes, alternating): removed first, in time all the same (about 6 s before).
  const unordered = `a${"\u0315\u0300".repeat(80_000)}Search`;
  const before = performance.now();
  assert.equal(holds(unordered, search), true);
  assert.ok(await snippet(unordered, search));
  assert.ok(performance.now() - before < 2500, `${performance.now() - before}`);
  // A halfwidth voiced mark (U+FF9E) decomposes to a combining one and folds to nothing: the capital after it begins a word, as after U+3099.
  for (const mark of ["\uff9e", "\u3099", "\uff9f"]) {
    const text = `thread${mark}Search`;
    assert.equal(holds(text, search), true, mark);
    assert.deepEqual(matches(text, search).map((range) => text.slice(range.start, range.end)), ["Search"], mark);
    assert.ok(await snippet(text, search), mark);
  }
});

test("a snippet marks only matches at a word's start, also where it begins inside a word", async () => {
  // The snippet starts 60 units before its match, here inside a word, on `log` of `qq…qlog`: not marked.
  const text = `${"q".repeat(100)}log${"z".repeat(56)}-login`;
  const shown = (await snippet(text, parseQuery("log")!))!;
  assert.ok(shown.text.startsWith("…log"));
  assert.deepEqual(shown.ranges.map((range) => shown.text.slice(range.start, range.end)), ["log"]);
  assert.equal(shown.ranges[0].start, shown.text.indexOf("-login") + 1);
  // A message whose only match is at a capital inside a word: found, its snippet marked there.
  const hump = (await snippet(`${"x ".repeat(100)}call ThreadSearch now`, parseQuery("search")!))!;
  assert.deepEqual(hump.ranges.map((range) => hump.text.slice(range.start, range.end)), ["Search"]);
  // Long, with the match far in and only inside words before it.
  const far = `${"catalog ".repeat(20_000)}the login`;
  const long = (await snippet(far, parseQuery("log")!))!;
  assert.deepEqual(long.ranges.map((range) => long.text.slice(range.start, range.end)), ["log"]);
  assert.ok(long.text.endsWith("the login"));
  // Holds and the snippet agree: no snippet for text with matches only inside words.
  assert.equal(await snippet("catalog blog", parseQuery("log")!), null);
});

test("the matches are marked in the original text's UTF-16 offsets, past accents, emoji and folded white space", () => {
  const text = "🙂 Résumé:\n\n the  RELAY plan";
  const query = parseQuery('resume "relay plan"')!;
  const found = matches(text, query);
  assert.deepEqual(found.map((range) => text.slice(range.start, range.end)), ["Résumé", "RELAY plan"]);
  // Decomposed accents count as the letter they sit on.
  const decomposed = "résumé relay";
  assert.deepEqual(matches(decomposed, parseQuery("résumé")!).map((range) => decomposed.slice(range.start, range.end)), ["résumé"]);
});

test("a snippet is cut around the first match, its white space one space each, with the matches as ranges into it", async () => {
  const long = `${"word ".repeat(40)}the relay keeps the push token\nand ${"more ".repeat(60)}relay again`;
  const shown = (await snippet(long, parseQuery("relay")!))!;
  assert.ok(shown.text.startsWith("…"));
  assert.ok(shown.text.endsWith("…"));
  assert.ok(shown.text.length <= 203, `${shown.text.length}`);
  assert.ok(!shown.text.includes("\n"));
  for (const range of shown.ranges) assert.equal(shown.text.slice(range.start, range.end).toLowerCase(), "relay");
  assert.equal(shown.ranges.length, 1);
  const short = (await snippet("Relay, relay!", parseQuery("relay")!))!;
  assert.equal(short.text, "Relay, relay!");
  assert.deepEqual(short.ranges, [{ start: 0, end: 5 }, { start: 7, end: 12 }]);
  assert.equal(await snippet("nothing here", parseQuery("relay")!), null);
});

test("a thread search keeps a short hit's snippet bounded through a long run of accents", async () => {
  const search = new ThreadSearch({
    source: {
      records: () => [{ id: "accented", agent: "hermes", cwd: "/work", updatedAt: 1 } as ThreadRecord],
      loaded: () => [{ role: "user", text: `relay${"\u0301".repeat(300_000)} done`, timestamp: 1 }],
    },
    providers: new Map([["hermes", { profile: { name: "hermes", displayName: "Hermes" } } as Provider]]),
  });
  const answer = await search.search({ query: "relay" }, {});
  const hit = answer.threads[0]?.hits[0];
  assert.ok(hit);
  assert.ok(hit.text.length <= snippetLength + 2, `${hit.text.length} units`);
  assert.equal(hit.ranges[0].start, 0);
  assert.ok(hit.ranges[0].end <= snippetLength);
});

test("snippet marking bounds its work between yields through millions of combining accents", async () => {
  const query = parseQuery("relay")!;
  const normalize = String.prototype.normalize;
  let work = 0;
  let most = 0;
  let pauses = 0;
  String.prototype.normalize = function (form) {
    work += 1;
    return normalize.call(this, form);
  };
  try {
    for (const text of [`relay${"\u0301".repeat(2_000_000)} done`, `x${"\u0301".repeat(2_000_000)}用relay`]) {
      const shown = (await snippet(text, query, async () => {
        most = Math.max(most, work);
        work = 0;
        pauses += 1;
      }))!;
      assert.ok(shown.text.length <= snippetLength + 2);
    }
    most = Math.max(most, work);
    assert.ok(pauses > 20, `${pauses} yields`);
    assert.ok(most < 10_000, `${most} normalizations between yields`);
  } finally {
    String.prototype.normalize = normalize;
  }
  const accented = (await snippet("🙂 résumé done", parseQuery("resume")!))!;
  assert.deepEqual(accented.ranges.map(({ start, end }) => accented.text.slice(start, end)), ["résumé"]);
});

test("a phrase across huge white space keeps its snippet and highlight bounded", async () => {
  const shown = (await snippet(`relay${" ".repeat(600_000)}plan`, parseQuery('"relay plan"')!))!;
  assert.ok(shown.text.length <= snippetLength + 2, `${shown.text.length} units`);
  assert.ok(shown.text.endsWith("…"));
  assert.deepEqual(shown.ranges, [{ start: 0, end: snippetLength }]);
});

test("F4: a later match crossing the snippet boundary keeps its visible highlight", async () => {
  const text = `relay ${"aa ".repeat(64)}planning more words here after it`;
  const shown = (await snippet(text, parseQuery("relay planning")!))!;
  assert.ok(shown.text.length <= snippetLength + 2);
  assert.deepEqual(shown.ranges.map(({ start, end }) => shown.text.slice(start, end)), ["relay", "pl"]);
  assert.equal(shown.ranges[1].end, shown.text.length - 1);
});

test("matching and marking fold alike: a character that comes to white space joins the white space around it", async () => {
  // `¨` is a space and a mark once decomposed: `a¨¨b` is `a b` to `holds`, and so to the marks.
  const query = parseQuery('"a b"')!;
  assert.equal(holds("a¨¨b", query), true);
  assert.deepEqual(matches("a¨¨b", query), [{ start: 0, end: 4 }]);
  const shown = (await snippet("x a¨¨b y", query))!;
  assert.deepEqual(shown.ranges, [{ start: 2, end: 6 }]);
});

test("a long message's snippet is found a window at a time, the loop given its turn, without mapping it whole", async () => {
  const long = `${"tool output line ".repeat(65_000)}the relay at the end`;
  const query = parseQuery("relay")!;
  let pauses = 0;
  const started = performance.now();
  const shown = (await snippet(long, query, async () => {
    pauses += 1;
  }))!;
  assert.ok(shown.text.includes("the relay at the end"));
  assert.equal(shown.text.slice(shown.ranges[0].start, shown.ranges[0].end), "relay");
  assert.ok(pauses > 20, `${pauses}`);
  // Each window is a few milliseconds; the whole message about a hundred and fifty before.
  assert.ok(performance.now() - started < 1000);
  // A match across two stretches' seam is found whole.
  const seam = `${"x".repeat(32 * 1024 - 3)} relay plan`;
  const across = (await snippet(seam, parseQuery('"relay plan"')!))!;
  assert.equal(across.text.slice(across.ranges[0].start, across.ranges[0].end), "relay plan");
  // A phrase across a long run of white space still matches, with its visible part marked.
  const spaced = `${"y ".repeat(40_000)}relay${" ".repeat(40_000)}plan`;
  const phrase = parseQuery('"relay plan"')!;
  assert.equal(holds(spaced, phrase), true);
  const wide = (await snippet(spaced, phrase))!;
  assert.ok(wide.text.slice(wide.ranges[0].start, wide.ranges[0].end).startsWith("relay"));
  assert.ok(wide.text.length <= snippetLength + 2);
  assert.equal(wide.ranges[0].end, wide.text.length - 1);
  // Other letters before the match: the walk back to it folds as `holds` does.
  const accented = `${"é ¨ ﬁ İ Σ ".repeat(20_000)}the relay`;
  const mark = (await snippet(accented, query))!;
  assert.equal(mark.text.slice(mark.ranges[0].start, mark.ranges[0].end), "relay");
  // A stretch of white space only, between others: one space all the same.
  const gap = `x${" ".repeat(600_000)}relay`;
  assert.equal(holds(gap, query), true);
  const afterGap = (await snippet(gap, query))!;
  assert.equal(afterGap.text.slice(afterGap.ranges[0].start, afterGap.ranges[0].end), "relay");
  // White space across the seam of two stretches folded apart is one space all the same.
  for (const cut of [256 * 1024 - 3, 256 * 1024, 256 * 1024 + 2]) {
    const seamed = `${"x".repeat(cut)}${" ".repeat(6)}x relay`;
    const shown = (await snippet(seamed, query))!;
    assert.equal(shown.text.slice(shown.ranges[0].start, shown.ranges[0].end), "relay", `${cut}`);
  }
});

test("the pre-test before parsing a line never turns away a message that holds the words", () => {
  // A phrase of punctuation, across a line break JSON writes as \n.
  const dashes = parseQuery('"--- ---"')!;
  assert.equal(holds("---\n---", dashes), true);
  assert.equal(mayHold(JSON.stringify({ text: "---\n---" }), dashes), true);
  // A letter a writer escaped.
  const cafe = parseQuery("cafe")!;
  assert.equal(mayHold('{"text":"caf\\u00e9"}', cafe), true);
  // Control characters escaped do not make every line worth parsing.
  assert.equal(mayHold('{"text":"\\u001b[0m nothing"}', cafe), false);
  assert.equal(mayHold('{"text":"nothing"}', cafe), false);
});

// MARK: Each agent's files

test("Claude Code: the user's typed messages and the assistant's text, not tool results, Claude Code's own lines, a subagent's or a compaction's summary", async () => {
  const file = { path: fixture("claude-session.jsonl"), format: "claude" as const };
  const relay = await scan(file, "relay");
  assert.deepEqual(
    relay.map((message) => [message.role, message.id]),
    [["user", "u-1"], ["assistant", "a-1"], ["user", "u-3"], ["user", "u-5"], ["assistant", "a-5"]],
  );
  // The command the user ran reads as typed.
  assert.equal(relay[2].text, "/compact keep the relay notes");
  assert.equal(relay[0].timestamp, Date.parse("2026-10-20T09:00:01.000Z") / 1000);
  // Accents and case: café = CAFE, Résumé = resume; both messages hold both words.
  assert.deepEqual((await scan(file, "CAFE resume")).map((message) => message.id), ["u-5"]);
  assert.deepEqual((await scan(file, "cafe")).map((message) => message.id), ["u-5", "a-5"]);
  // Thinking is not searched; neither is a tool's output.
  assert.deepEqual(await scan(file, "secrets"), []);
  assert.deepEqual(await scan(file, "docs/relay.md"), []);
  assert.deepEqual(await scan(file, "subagent"), []);
});

test("Codex: the thread's user and agent messages, from items and from an older Codex's events, not the instructions, commands or reasoning", async () => {
  const file = { path: fixture("codex-rollout.jsonl"), format: "codex" as const };
  const relay = await scan(file, "relay");
  assert.deepEqual(
    relay.map((message) => [message.role, message.id ?? null, message.text]),
    [
      ["user", "item-u1", "Where does the relay keep sessions?"],
      ["assistant", "item-a1", "The relay keeps sessions in a Durable Object."],
      ["user", null, "Naïve question: does the RELAY see the text?"],
      ["assistant", null, "No: the relay only sees sealed bytes."],
    ],
  );
  assert.deepEqual(await scan(file, "rg relay"), []);
  assert.deepEqual(await scan(file, "environment_context"), []);
  assert.deepEqual((await scan(file, "naive")).length, 1);
});

test("Pi: the user's and the assistant's messages of its session file, the same words the bridge's history shows", async () => {
  for (const name of ["plain", "tools", "steer", "compact"]) {
    const path = new URL(`fixtures/pi/${name}.session.jsonl`, import.meta.url).pathname;
    const history = JSON.parse(readFileSync(new URL(`fixtures/pi/${name}.history.json`, import.meta.url), "utf8")).messages as StoredMessage[];
    const shown = history.filter((message) => message.role === "user" || message.role === "assistant").map((message) => (message as { text: string }).text).filter((text) => text.trim() !== "");
    // Every word the history shows is found in the file, in a message of the same role.
    for (const message of history) {
      if ((message.role !== "user" && message.role !== "assistant") || message.text.trim() === "" || message.text.startsWith("/")) continue;
      const word = message.text.split(/\s+/).find((each) => /^[A-Za-z]{5,}$/.test(each));
      if (!word) continue;
      const found = await scan({ path, format: "pi" }, word);
      assert.ok(found.some((hit) => hit.role === message.role && hit.text.includes(word)), `${name}: ${word}`);
    }
    assert.ok(shown.length > 0, name);
  }
});

/**
 * An agent whose thread is the file at `path`. A Claude Code session is put where Claude
 * Code keeps one (`$CLAUDE_CONFIG_DIR`, a scratch folder), and its conversation read by
 * the SDK's `getSessionMessages`, as the provider's history does.
 */
function fileProvider(name: string, path: string, format: SearchFile["format"]): Provider {
  let file: SearchFile = { path, format };
  if (format === "claude") {
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
    const id = randomUUID();
    const cwd = `/w/${id}`;
    const folder = join(root, "claude-config", "projects", claudeFolderName(cwd));
    mkdirSync(folder, { recursive: true });
    copyFileSync(path, join(folder, `${id}.jsonl`));
    file = { path, format, shown: () => getSessionMessages(id, { dir: cwd }) };
  }
  return { profile: { name, kind: name, displayName: name, description: "", model: "", provider: "" }, searchFile: async () => file } as unknown as Provider;
}

async function searchOne(agent: string, path: string, format: SearchFile["format"], query: string): Promise<ThreadHits> {
  const search = new ThreadSearch({ source: { records: () => [record("t", 1, { agent })], loaded: () => undefined }, providers: new Map([[agent, fileProvider(agent, path, format)]]) });
  const result = await search.search({ query, hits: 10 }, {});
  assert.equal(result.threads.length, 1);
  return result.threads[0];
}

// MARK: Before a compaction (2026-10-26: "Open at compaction + note")

test("Claude Code: a hit from before the thread's latest compaction is kept, marked, with the compaction row's time to open at", async () => {
  const path = fixture("claude-session.jsonl");
  const compacted: number[] = [];
  await scanFile({ path, format: "claude" }, parseQuery("relay")!, budget(), () => {}, undefined, (at) => compacted.push(at));
  // The summary's time, which the bridge's history gives the compaction row.
  assert.deepEqual(compacted, [Date.parse("2026-10-20T09:01:01.000Z") / 1000]);
  const thread = await searchOne("claude", path, "claude", "relay");
  assert.equal(thread.count, 5);
  // Newest first: the /compact that asked for it (written after its summary) and what followed are shown in the thread.
  assert.deepEqual(thread.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["a-5", false], ["u-5", false], ["u-3", false], ["a-1", true], ["u-1", true]]);
  assert.equal(thread.compacted_at, Date.parse("2026-10-20T09:01:01.000Z") / 1000);
  // The history the app is shown (the session's messages from its compaction on) has its compaction row at that time.
  const { historyFromSession } = await import("../src/providers/claude/history.ts");
  const entries = readFileSync(path, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
  const history = historyFromSession(entries.slice(entries.findIndex((entry) => entry.isCompactSummary === true)), "/tmp");
  assert.equal(history.find((message) => message.role === "compaction")?.timestamp, thread.compacted_at);
  // Only hits after it: neither mark nor time.
  const after = await searchOne("claude", path, "claude", "cafe");
  assert.deepEqual(after.hits.map((hit) => hit.before_compaction ?? false), [false, false]);
  assert.equal(after.compacted_at, undefined);
});

/** A Claude Code session file's lines, as Claude Code writes them: `parentUuid` first, each entry's parent the one before it unless said. */
function claudeLines(entries: { uuid: string; parent?: string | null; at: string; kind: "said" | "boundary" | "summary" | "tool"; text?: string; logical?: string; extra?: Record<string, unknown> }[]): string {
  let previous: string | null = null;
  const lines = entries.map((entry) => {
    const parentUuid = entry.parent !== undefined ? entry.parent : previous;
    previous = entry.uuid;
    const base = { parentUuid, isSidechain: false, userType: "external", cwd: "/w", sessionId: "s" };
    switch (entry.kind) {
      case "boundary":
        return JSON.stringify({ parentUuid: null, logicalParentUuid: entry.logical, isSidechain: false, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: entry.uuid, timestamp: entry.at, compactMetadata: { trigger: "auto", preTokens: 160000 }, ...entry.extra });
      case "summary":
        return JSON.stringify({ ...base, type: "user", message: { role: "user", content: "This session is being continued from a previous conversation. The relay was discussed." }, isCompactSummary: true, uuid: entry.uuid, timestamp: entry.at });
      case "tool":
        // A long tool result, its ids read without parsing it.
        return JSON.stringify({ ...base, type: "user", message: { role: "user", content: [{ tool_use_id: "t", type: "tool_result", content: "relay ".repeat(5000) }] }, uuid: entry.uuid, timestamp: entry.at, toolUseResult: { stdout: "x" } });
      default:
        return JSON.stringify({ ...base, type: "user", message: { role: "user", content: entry.text }, uuid: entry.uuid, timestamp: entry.at, ...entry.extra });
    }
  });
  return `${lines.join("\n")}\n`;
}

test("Claude Code: with two compactions, every hit before the latest is marked, and the time is the latest's", async () => {
  const path = join(root, "two-compactions.jsonl");
  writeFileSync(
    path,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "r-1", at: "2026-10-20T09:00:01Z", kind: "tool" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "r-1" },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-2", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay two" },
      { uuid: "b-2", at: "2026-10-20T09:30:00Z", kind: "boundary", logical: "u-2" },
      { uuid: "s-2", at: "2026-10-20T09:30:01Z", kind: "summary" },
      { uuid: "u-3", at: "2026-10-20T09:40:00Z", kind: "said", text: "relay three" },
    ]) +
      // A subagent's compaction is not the thread's.
      `${JSON.stringify({ parentUuid: "u-3", isSidechain: true, type: "user", isCompactSummary: true, message: { role: "user", content: "x" }, uuid: "x-1", timestamp: "2026-10-20T09:50:00Z" })}\n`,
  );
  const thread = await searchOne("claude", path, "claude", "relay");
  assert.deepEqual(thread.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-3", false], ["u-2", true], ["u-1", true]]);
  assert.equal(thread.compacted_at, Date.parse("2026-10-20T09:30:01Z") / 1000);
  // With fewer hits asked for, the mark and the time go with the hits that are shown.
  const search = new ThreadSearch({ source: { records: () => [record("t", 1, { agent: "claude" })], loaded: () => undefined }, providers: new Map([["claude", fileProvider("claude", path, "claude")]]) });
  const newest = (await search.search({ query: "relay", hits: 1 }, {})).threads[0];
  assert.deepEqual(newest.hits.map((hit) => hit.before_compaction ?? false), [false]);
  assert.equal(newest.compacted_at, undefined);
  assert.equal(newest.count, 3);
});

test("Claude Code: a compaction on a branch left behind hides nothing, and a message a compaction kept is not marked", async () => {
  // Compacted after u-1, then resumed from u-1: the chain the thread shows does not pass the compaction.
  const branch = join(root, "left-behind.jsonl");
  writeFileSync(
    branch,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-1" },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-2", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay on the left branch" },
      { uuid: "u-3", parent: "u-1", at: "2026-10-20T09:30:00Z", kind: "said", text: "relay again from u-1" },
    ]),
  );
  const left = await searchOne("claude", branch, "claude", "relay");
  assert.equal(left.count, 3);
  assert.ok(left.hits.every((hit) => hit.before_compaction === undefined), JSON.stringify(left.hits));
  assert.equal(left.compacted_at, undefined);
  // A compaction that kept u-2 as it was (preservedMessages): shown after it, not marked; u-1 is.
  const kept = join(root, "kept.jsonl");
  writeFileSync(
    kept,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "u-2", at: "2026-10-20T09:01:00Z", kind: "said", text: "relay kept" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-2", extra: { compactMetadata: { trigger: "auto", preTokens: 1, preservedMessages: { anchorUuid: "s-1", uuids: ["u-2"] } } } },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-3", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay after" },
    ]),
  );
  const marked = await searchOne("claude", kept, "claude", "relay");
  assert.deepEqual(marked.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-3", false], ["u-2", false], ["u-1", true]]);
});

test("Claude Code: the conversation is Claude Code's own: a late record of a background task, a uuid inside a tool's input, compactions that kept messages", async () => {
  // A background task's progress written last, under a message from before the compaction: the conversation is still the compacted one.
  const late = join(root, "late-progress.jsonl");
  writeFileSync(
    late,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-1" },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-2", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay two" },
    ]) + `${JSON.stringify({ parentUuid: "u-1", isSidechain: false, type: "progress", data: { type: "agent_progress" }, uuid: "p-1", timestamp: "2026-10-20T09:21:00Z" })}\n`,
  );
  assert.deepEqual((await searchOne("claude", late, "claude", "relay")).hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-2", false], ["u-1", true]]);
  // A tool's input with a uuid of its own, in a long line before the record's.
  const nested = join(root, "nested-uuid.jsonl");
  writeFileSync(
    nested,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-1" },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
    ]) +
      `${JSON.stringify({ parentUuid: "s-1", isSidechain: false, type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Write", input: { uuid: "document-id", body: "x".repeat(20000) } }] }, uuid: "a-1", timestamp: "2026-10-20T09:11:00Z" })}\n` +
      `${JSON.stringify({ parentUuid: "a-1", isSidechain: false, type: "user", message: { role: "user", content: "relay two" }, uuid: "u-2", timestamp: "2026-10-20T09:12:00Z" })}\n`,
  );
  const withNested = await searchOne("claude", nested, "claude", "relay");
  assert.deepEqual(withNested.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-2", false], ["u-1", true]]);
  assert.equal(withNested.compacted_at, Date.parse("2026-10-20T09:10:01Z") / 1000);
  // A first compaction kept u-2; a second kept nothing: u-2 is hidden now.
  const twice = join(root, "kept-then-not.jsonl");
  writeFileSync(
    twice,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "u-2", at: "2026-10-20T09:01:00Z", kind: "said", text: "relay kept once" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-2", extra: { compactMetadata: { trigger: "auto", preTokens: 1, preservedMessages: { anchorUuid: "s-1", uuids: ["u-2"] } } } },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-3", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay three" },
      { uuid: "b-2", at: "2026-10-20T09:30:00Z", kind: "boundary", logical: "u-3" },
      { uuid: "s-2", at: "2026-10-20T09:30:01Z", kind: "summary" },
      { uuid: "u-4", at: "2026-10-20T09:40:00Z", kind: "said", text: "relay four" },
    ]),
  );
  assert.deepEqual((await searchOne("claude", twice, "claude", "relay")).hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-4", false], ["u-3", true], ["u-2", true], ["u-1", true]]);
  // A compaction that kept a stretch (preservedSegment): shown after it, not marked.
  const segment = join(root, "kept-segment.jsonl");
  writeFileSync(
    segment,
    claudeLines([
      { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
      { uuid: "u-2", at: "2026-10-20T09:01:00Z", kind: "said", text: "relay two" },
      { uuid: "u-3", at: "2026-10-20T09:02:00Z", kind: "said", text: "relay three" },
      { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-3", extra: { compactMetadata: { trigger: "auto", preTokens: 1, preservedSegment: { anchorUuid: "s-1", headUuid: "u-2", tailUuid: "u-3" } } } },
      { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
      { uuid: "u-4", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay four" },
    ]),
  );
  const kept = await searchOne("claude", segment, "claude", "relay");
  assert.deepEqual(kept.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-4", false], ["u-3", false], ["u-2", false], ["u-1", true]]);
});

test("Claude Code: a session kept under another folder than the thread's is read there for its compaction; a file larger than the bridge reads has no marks", async () => {
  const lines = claudeLines([
    { uuid: "u-1", parent: null, at: "2026-10-20T09:00:00Z", kind: "said", text: "relay one" },
    { uuid: "b-1", at: "2026-10-20T09:10:00Z", kind: "boundary", logical: "u-1" },
    { uuid: "s-1", at: "2026-10-20T09:10:01Z", kind: "summary" },
    { uuid: "u-2", at: "2026-10-20T09:20:00Z", kind: "said", text: "relay two" },
  ]);
  // The session's lines say /w; the thread says /old (it moved): the search finds the file in /w's folder, and so must the compaction's reading.
  const config = join(root, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = config;
  const id = randomUUID();
  mkdirSync(join(config, "projects", claudeFolderName("/w")), { recursive: true });
  writeFileSync(join(config, "projects", claudeFolderName("/w"), `${id}.jsonl`), lines);
  const { ClaudeProvider, sdkSessionFiles } = await import("../src/providers/claude/provider.ts");
  const provider = new ClaudeProvider({
    settings: { path: "/nonexistent/claude", idleMinutes: 15, maxWarm: 1, apiKey: null, folder: "/tmp" },
    files: sdkSessionFiles,
    env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: config },
    agents: async () => [],
  });
  const search = new ThreadSearch({ source: { records: () => [record(id, 1, { agent: "claude", cwd: "/old" })], loaded: () => undefined }, providers: new Map([["claude", provider as unknown as Provider]]) });
  const moved = (await search.search({ query: "relay" }, {})).threads[0];
  assert.deepEqual(moved.hits.map((hit) => [hit.id, hit.before_compaction ?? false]), [["u-2", false], ["u-1", true]]);
  assert.equal(moved.compacted_at, Date.parse("2026-10-20T09:10:01Z") / 1000);
  // Larger than the bridge reads of one file: searched in its end, and Claude Code's reading of it all is not asked.
  const big = join(root, "big.jsonl");
  writeFileSync(big, lines);
  let asked = 0;
  const provider2 = fileProvider("claude", big, "claude");
  const file = await provider2.searchFile!({ id: "t", cwd: "/w" });
  const counting = { ...provider2, searchFile: async () => ({ ...file!, shown: async () => (asked += 1, file!.shown!()) }) } as unknown as Provider;
  const limited = new ThreadSearch({ source: { records: () => [record("t", 1, { agent: "claude" })], loaded: () => undefined }, providers: new Map([["claude", counting]]), fileLimit: lines.length - 10 });
  const cut = (await limited.search({ query: "relay" }, {})).threads[0];
  assert.equal(cut.partial, true);
  assert.ok(cut.hits.every((hit) => hit.before_compaction === undefined) && cut.compacted_at === undefined);
  assert.equal(asked, 0);
  // Whole, it is asked once.
  const whole = new ThreadSearch({ source: { records: () => [record("t", 1, { agent: "claude" })], loaded: () => undefined }, providers: new Map([["claude", counting]]) });
  assert.equal((await whole.search({ query: "relay" }, {})).threads[0].compacted_at, Date.parse("2026-10-20T09:10:01Z") / 1000);
  assert.equal(asked, 1);
});

test("Codex, Pi, Droid's and Cursor's records: a compaction leaves what came before in the thread, so no hit is marked", async () => {
  // Codex's rollout marks its compaction (`compacted`, `context_compacted`); its thread keeps every turn.
  const codex = await searchOne("codex", fixture("codex-rollout.jsonl"), "codex", "relay");
  assert.equal(codex.count, 4);
  assert.ok(codex.hits.every((hit) => hit.before_compaction === undefined) && codex.compacted_at === undefined);
  // Pi's session file has a `compaction` entry; the history shows the whole path, before it too.
  const pi = await searchOne("pi", new URL("fixtures/pi/compact.session.jsonl", import.meta.url).pathname, "pi", "reply");
  assert.ok(pi.count >= 2);
  assert.ok(pi.hits.every((hit) => hit.before_compaction === undefined) && pi.compacted_at === undefined);
  // The bridge's own record keeps every message, with a compaction row among them.
  const folder = join(root, "stored-compaction");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "t.json");
  writeFileSync(path, JSON.stringify({ messages: [{ role: "user", text: "relay before", timestamp: 1 }, { role: "compaction", trigger: "manual", timestamp: 2 }, { role: "user", text: "relay after", timestamp: 3 }] }));
  const stored = await searchOne("droid", path, "stored", "relay");
  assert.equal(stored.count, 2);
  assert.ok(stored.hits.every((hit) => hit.before_compaction === undefined) && stored.compacted_at === undefined);
});

test("Droid, Cursor and the fake agent: the bridge's own stored messages, user and assistant, not tools or a failed turn's row", async () => {
  const path = join(root, "stored.json");
  const messages: StoredMessage[] = [
    { role: "user", text: "Rename the relay", timestamp: 10 },
    { role: "tool", name: "terminal", args: { command: "mv relay" }, content: "relay moved", tool_call_id: "t", timestamp: 11 } as StoredMessage,
    { role: "assistant", text: "Renamed the relay.", timestamp: 12 },
    { role: "assistant", text: "The relay failed.", timestamp: 13, display_kind: "failed_turn" } as StoredMessage,
  ];
  writeFileSync(path, JSON.stringify({ version: 1, messages }));
  assert.deepEqual((await scan({ path, format: "stored" }, "relay")).map((message) => [message.role, message.timestamp]), [["user", 10], ["assistant", 12]]);
  assert.deepEqual(await scan({ path, format: "stored" }, "moved"), []);
  assert.equal(storedMessages(messages).length, 2);
  // Droid's record keeps milliseconds: given in seconds, as its history gives them.
  const droid = join(root, "droid.json");
  writeFileSync(droid, JSON.stringify({ messages: [{ role: "user", text: "the relay", timestamp: 1793008800123 }] }));
  assert.deepEqual((await scan({ path: droid, format: "stored" }, "relay")).map((message) => message.timestamp), [1793008800.123]);
});

test("a file larger than the limit is read from the line after its cut, and a file that is not there finds nothing", async () => {
  const path = join(root, "cut.jsonl");
  const lines = ["first relay", "second relay", "third relay"].map((text, index) => JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid: `u${index}` }));
  writeFileSync(path, `${lines.join("\n")}\n`);
  const found: SearchedMessage[] = [];
  // The cut falls inside the second line: it is not read as a line, the third is.
  const result = await scanFile({ path, format: "claude" }, parseQuery("relay")!, budget(), (message) => found.push(message), lines[2].length + 10);
  assert.deepEqual(found.map((message) => message.id), ["u2"]);
  assert.equal(result.partial, true);
  // A stored conversation is one JSON: larger than the limit, it is left out, said partial.
  const stored = join(root, "big-stored.json");
  writeFileSync(stored, JSON.stringify({ messages: [{ role: "user", text: "relay", timestamp: 1 }] }));
  const none: SearchedMessage[] = [];
  assert.equal((await scanFile({ path: stored, format: "stored" }, parseQuery("relay")!, budget(), (message) => none.push(message), 10)).partial, true);
  assert.deepEqual(none, []);
  assert.deepEqual(await scan({ path: join(root, "missing.jsonl"), format: "claude" }, "relay"), []);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(scanFile({ path: fixture("claude-session.jsonl"), format: "claude" }, parseQuery("relay")!, budget(stopped.signal), () => {}));
});

// MARK: Where the files are

test("Claude Code's session file is found by the folder's name, and in another folder when the thread's has moved", async () => {
  const config = join(root, "claude");
  const cwd = join(root, "work.d", "my project");
  mkdirSync(cwd, { recursive: true });
  const folder = join(config, "projects", claudeFolderName(cwd));
  mkdirSync(folder, { recursive: true });
  copyFileSync(fixture("claude-session.jsonl"), join(folder, "abc-1.jsonl"));
  assert.ok(claudeFolderName(cwd).endsWith("-work-d-my-project"));
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.equal(await claudeSessionFile("abc-1", cwd, env), join(folder, "abc-1.jsonl"));
  assert.equal(await claudeSessionFile("abc-1", "/somewhere/else", env), join(folder, "abc-1.jsonl"));
  assert.equal(await claudeSessionFile("abc-2", cwd, env), null);
  assert.equal(await claudeSessionFile("../abc-1", cwd, env), null);
  // Remembered: a thread with no file is looked for again only after a minute.
  let now = 0;
  const files = new ClaudeSessionFiles(env, () => now);
  assert.equal(await files.find("abc-2", cwd), null);
  copyFileSync(fixture("claude-session.jsonl"), join(folder, "abc-2.jsonl"));
  now = 30_000;
  assert.equal(await files.find("abc-2", cwd), null);
  now = 61_000;
  assert.equal(await files.find("abc-2", cwd), join(folder, "abc-2.jsonl"));
  assert.equal(await files.find("abc-1", cwd), join(folder, "abc-1.jsonl"));
  // Any agent's look, Pi's among them, remembered the same way: a miss is not looked for again for a minute.
  let looks = 0;
  const remembered = new RememberedFiles(async () => {
    looks += 1;
    return null;
  }, () => now);
  await remembered.find("p", cwd);
  await remembered.find("p", cwd);
  assert.equal(looks, 1);
});

test("Codex's rollout file is found by walking its folders, again when a new one appears after a while", async () => {
  const home = join(root, "codex");
  const day = join(home, "sessions", "2026", "10", "21");
  mkdirSync(day, { recursive: true });
  const id = "019a2b3c-4d5e-7f60-8192-a3b4c5d6e7f8";
  const name = `rollout-2026-10-21T10-00-00-${id}.jsonl`;
  assert.equal(rolloutId(name), id);
  copyFileSync(fixture("codex-rollout.jsonl"), join(day, name));
  let now = 0;
  const rollouts = new CodexRollouts({ CODEX_HOME: home }, () => now);
  assert.equal(await rollouts.find(id.toUpperCase()), join(day, name));
  const later = "019a2b3c-4d5e-7f60-8192-000000000001";
  const archived = join(home, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  copyFileSync(fixture("codex-rollout.jsonl"), join(archived, `rollout-2026-10-22T10-00-00-${later}.jsonl`));
  // Not walked again at once,
  now = 5_000;
  assert.equal(await rollouts.find(later), null);
  // but after ten seconds.
  now = 20_000;
  assert.equal(await rollouts.find(later), join(archived, `rollout-2026-10-22T10-00-00-${later}.jsonl`));
});

// MARK: Paging, order and limits

function record(id: string, updatedAt: number, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  return { id, agent: "fake", cwd: "/work/app", title: `Thread ${id}`, model: "m", provider: "p", reasoningEffort: "low", createdAt: 0, updatedAt, origin: "phone", ...extra };
}

function storedProvider(name: string, folder: string, displayName = name): Provider {
  return {
    profile: { name, kind: name, displayName, description: "", model: "m", provider: "p" },
    // As the agents' own: none for a thread without a file.
    searchFile: async ({ id }: { id: string }) => (existsSync(join(folder, `${id}.json`)) ? { path: join(folder, `${id}.json`), format: "stored" } : null),
  } as unknown as Provider;
}

function writeStored(folder: string, id: string, texts: string[]): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ messages: texts.map((text, index) => ({ role: index % 2 === 0 ? "user" : "assistant", text, timestamp: 100 + index })) }));
}

test("threads come newest first with their newest hits first, a page holds at most limit threads, and the cursor goes on where it stopped", async () => {
  const folder = join(root, "paging");
  const records = [record("a", 50), record("b", 40), record("c", 30), record("d", 20), record("e", 10), record("f", 30)];
  for (const each of records) writeStored(folder, each.id, ["the relay one", "nothing", "the relay two", "the relay three", "the relay four"]);
  writeStored(folder, "d", ["nothing at all"]);
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers: new Map([["fake", storedProvider("fake", folder, "Fake")]]) });
  const caller = {};
  const first = await search.search({ query: "relay", limit: 2, hits: 2 }, caller);
  assert.deepEqual(first.threads.map((thread) => thread.id), ["a", "b"]);
  assert.equal(first.threads[0].count, 4);
  assert.deepEqual(first.threads[0].hits.map((hit) => hit.text), ["the relay four", "the relay three"]);
  assert.equal(first.threads[0].agent_name, "Fake");
  assert.equal(first.threads[0].title, "Thread a");
  assert.equal(first.scanned, 2);
  assert.ok(first.cursor);
  const second = await search.search({ query: "relay", limit: 2, hits: 2, cursor: first.cursor! }, caller);
  // Same time, by id; d has no hit.
  assert.deepEqual(second.threads.map((thread) => thread.id), ["c", "f"]);
  const third = await search.search({ query: "relay", limit: 2, cursor: second.cursor! }, caller);
  assert.deepEqual(third.threads.map((thread) => thread.id), ["e"]);
  assert.equal(third.cursor, null);
  // A cursor given with another query is refused.
  await assert.rejects(search.search({ query: "other", cursor: first.cursor! }, caller), BadCursor);
  await assert.rejects(search.search({ query: "relay", cursor: "nonsense" }, caller), BadCursor);
  await assert.rejects(search.search({ query: "  " }, caller), EmptyQuery);
});

test("only an agent's threads, or a folder's (one inside it, or a worktree listed under it), when asked", async () => {
  const folder = join(root, "filters");
  const records = [record("a", 3, { cwd: "/work/app" }), record("b", 2, { cwd: "/work/app/sub" }), record("c", 1, { cwd: "/work/other", repo: "/work/app" }), record("d", 0, { cwd: "/work/apple", agent: "other" })];
  for (const each of records) writeStored(folder, each.id, ["relay"]);
  const providers = new Map([["fake", storedProvider("fake", folder)], ["other", storedProvider("other", folder)]]);
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers });
  assert.deepEqual((await search.search({ query: "relay", folder: "/work/app" }, {})).threads.map((thread) => thread.id), ["a", "b", "c"]);
  assert.deepEqual((await search.search({ query: "relay", folder: "/work/app/" }, {})).threads.map((thread) => thread.id), ["a", "b", "c"]);
  assert.deepEqual((await search.search({ query: "relay", agent: "other" }, {})).threads.map((thread) => thread.id), ["d"]);
  // The root holds every folder.
  assert.deepEqual((await search.search({ query: "relay", folder: "/" }, {})).threads.map((thread) => thread.id), ["a", "b", "c", "d"]);
});

test("a thread whose time moves while a page searches it keeps the place it was searched at: the next page neither repeats nor skips", async () => {
  const folder = join(root, "moving");
  const records = [record("a", 50), record("b", 40), record("c", 30)];
  for (const each of records) writeStored(folder, each.id, ["relay"]);
  const plain = storedProvider("fake", folder);
  const moving = {
    ...plain,
    // A turn of b ends while its file is looked for.
    searchFile: async (thread: { id: string; cwd: string }) => {
      if (thread.id === "b") records[1].updatedAt = 60;
      return plain.searchFile!(thread);
    },
  } as unknown as Provider;
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers: new Map([["fake", moving]]) });
  const first = await search.search({ query: "relay", limit: 2 }, {});
  assert.deepEqual(first.threads.map((thread) => [thread.id, thread.updated]), [["a", 50], ["b", 40]]);
  const second = await search.search({ query: "relay", limit: 2, cursor: first.cursor! }, {});
  assert.deepEqual(second.threads.map((thread) => thread.id), ["c"]);
});

test("a thread is searched in its agent's file, loaded or not; in memory only without one; an agent with no file of its own is counted as not searched, with why", async () => {
  const folder = join(root, "loaded");
  // Loaded, its file holds what the loaded thread no longer does (before a compaction, another branch).
  writeStored(folder, "a", ["before the compaction: relay", "since"]);
  const records = [record("a", 4), record("n", 3), record("h1", 2, { agent: "hermes" }), record("h2", 1, { agent: "hermes" })];
  const providers = new Map<string, Provider>([["fake", storedProvider("fake", folder)], ["hermes", { profile: { name: "hermes", kind: "hermes", displayName: "Hermes", description: "", model: "", provider: "" } } as unknown as Provider]]);
  const live = new Map<string, StoredMessage[]>([
    ["a", [{ role: "user", text: "since", timestamp: 5 }]],
    // Loaded, no file written yet.
    ["n", [{ role: "user", text: "new relay", timestamp: 5 }]],
    ["h2", [{ role: "assistant", text: "relay from Hermes", timestamp: 6 }]],
  ]);
  const search = new ThreadSearch({ source: { records: () => records, loaded: (id) => live.get(id) }, providers });
  const result = await search.search({ query: "relay" }, {});
  assert.deepEqual(result.threads.map((thread) => [thread.id, thread.hits[0].text]), [["a", "before the compaction: relay"], ["n", "new relay"], ["h2", "relay from Hermes"]]);
  assert.equal(result.unsearched?.length, 1);
  assert.equal(result.unsearched![0].agent, "hermes");
  assert.equal(result.unsearched![0].count, 1);
  assert.match(result.unsearched![0].reason, /only while it is open/);
  // An agent turned off since: said so.
  records.push(record("gone", 0, { agent: "pi" }));
  assert.match((await search.search({ query: "relay" }, {})).unsearched!.find((each) => each.agent === "pi")!.reason, /not turned on/);
  records.pop();
  // A thread loaded but not yet given its history is read from its file all the same.
  live.set("a", []);
  assert.equal((await search.search({ query: "relay" }, {})).threads[0].hits[0].text, "before the compaction: relay");
  // Loaded, with a message shown but not saved yet (Cursor saves when a tool ends): found too, once.
  const now = Date.now() / 1000;
  live.set("a", [
    { role: "user", text: "before the compaction: relay", timestamp: 100 },
    { role: "assistant", text: "since", timestamp: 101 },
    { role: "assistant", text: "commentary about the relay, not saved yet", timestamp: now + 1 },
  ]);
  const unsaved = (await search.search({ query: "relay" }, {})).threads[0];
  assert.deepEqual(unsaved.hits.map((hit) => hit.text), ["commentary about the relay, not saved yet", "before the compaction: relay"]);
  assert.equal(unsaved.count, 2);
  // The same words said again, not saved yet: another message, found.
  live.get("a")!.push({ role: "user", text: "before the compaction: relay", timestamp: now + 2 });
  const again = (await search.search({ query: "relay" }, {})).threads[0];
  assert.equal(again.count, 3);
  assert.equal(again.hits[0].timestamp, now + 2);
  live.get("a")!.pop();
  // Saved since: still once.
  writeStored(folder, "a", ["before the compaction: relay", "since"]);
  const saved = join(folder, "a.json");
  const kept = JSON.parse(readFileSync(saved, "utf8"));
  kept.messages.push({ role: "assistant", text: "commentary about the relay, not saved yet", timestamp: now + 1 });
  writeFileSync(saved, JSON.stringify(kept));
  assert.equal((await search.search({ query: "relay" }, {})).threads[0].count, 2);
});

test("a page that has spent its time ends after the thread it was on, with a cursor, and always searches one thread", async () => {
  const folder = join(root, "time");
  const records = [record("a", 3), record("b", 2), record("c", 1)];
  for (const each of records) writeStored(folder, each.id, ["relay"]);
  let clock = 0;
  const providers = new Map([["fake", storedProvider("fake", folder)]]);
  // Each look at the clock is a second later: the time is up after the first thread.
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers, pageTimeMs: 1500, now: () => (clock += 1000) });
  const first = await search.search({ query: "relay" }, {});
  assert.deepEqual(first.threads.map((thread) => thread.id), ["a"]);
  assert.ok(first.cursor);
  const bytes = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers, pageBytes: 1 });
  const page = await bytes.search({ query: "relay" }, {});
  assert.deepEqual(page.threads.map((thread) => thread.id), ["a"]);
  assert.deepEqual((await bytes.search({ query: "relay", cursor: page.cursor! }, {})).threads.map((thread) => thread.id), ["b"]);
});

test("a newer search from the same caller replaces the one under way, which answers replaced; another caller's is left alone", async () => {
  const folder = join(root, "replace");
  const records = Array.from({ length: 30 }, (_, index) => record(`t${index}`, 100 - index));
  for (const each of records) writeStored(folder, each.id, ["relay ".repeat(2000)]);
  const providers = new Map([["fake", storedProvider("fake", folder)]]);
  let pauses = 0;
  const slow = {
    ...storedProvider("fake", folder),
    searchFile: async ({ id }: { id: string }) => {
      pauses += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { path: join(folder, `${id}.json`), format: "stored" as const };
    },
  } as unknown as Provider;
  providers.set("fake", slow);
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers });
  const caller = {};
  const other = {};
  const first = search.search({ query: "relay", limit: 50 }, caller);
  const theirs = search.search({ query: "relay", limit: 50 }, other);
  await new Promise((resolve) => setTimeout(resolve, 12));
  const second = search.search({ query: "relay", limit: 1 }, caller);
  const [replaced, newer, untouched] = await Promise.all([first, second, theirs]);
  assert.equal(replaced.replaced, true);
  assert.deepEqual(replaced.threads, []);
  assert.equal(newer.threads.length, 1);
  assert.equal(untouched.threads.length, 30);
  assert.ok(pauses > 0);
  // Threads in memory never wait on a file: a replaced search stops between them all the same.
  const live = new ThreadSearch({ source: { records: () => records, loaded: () => [{ role: "user", text: "relay", timestamp: 1 }] }, providers });
  const going = new AbortController();
  const memory = live.search({ query: "relay", limit: 50 }, {}, going.signal);
  going.abort();
  assert.equal((await memory).replaced, true);
  // A caller that went stops its search.
  const gone = new AbortController();
  const stopped = search.search({ query: "relay", limit: 50 }, {}, gone.signal);
  gone.abort();
  assert.equal((await stopped).replaced, true);
});

test("a search replaced while it searched its last thread answers replaced, not what it found", async () => {
  const gone = new AbortController();
  const hermes = { profile: { name: "hermes", kind: "hermes", displayName: "Hermes", description: "", model: "", provider: "" } } as unknown as Provider;
  const search = new ThreadSearch({
    source: {
      records: () => [record("x", 1, { agent: "hermes" })],
      // The newer search comes in while this thread is searched (here, as it is read).
      loaded: () => {
        gone.abort();
        return [{ role: "user", text: "relay", timestamp: 1 }];
      },
    },
    providers: new Map([["hermes", hermes]]),
    // The clock never moves: the scan never needs to give the loop its turn.
    now: () => 0,
  });
  const result = await search.search({ query: "relay" }, {}, gone.signal);
  assert.equal(result.replaced, true);
  assert.deepEqual(result.threads, []);
});

test("the scan gives the event loop its turn while it reads a large file", async () => {
  const path = join(root, "large.jsonl");
  const line = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(4000) }] } });
  writeFileSync(path, `${`${line}\n`.repeat(8000)}${JSON.stringify({ type: "user", message: { role: "user", content: "the relay at the end" }, uuid: "last" })}\n`);
  const records = [record("big", 1, { agent: "claude" })];
  const providers = new Map<string, Provider>([["claude", { profile: { name: "claude", kind: "claude", displayName: "Claude", description: "", model: "", provider: "" }, searchFile: async () => ({ path, format: "claude" }) } as unknown as Provider]]);
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers });
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 1);
  const result = await search.search({ query: "relay" }, {});
  clearInterval(timer);
  assert.equal(result.threads[0].hits[0].id, "last");
  assert.ok(ticks > 0, "the loop never ran during the scan");
});

// MARK: Linked Macs

test("with linked, each linked Mac is asked for its own threads, named machine/id; one that fails is said, and a cursor goes on per Mac", async () => {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const macs = {
    linked: () => [{ name: "mini", url: "ws://mini" }, { name: "away", url: "ws://away" }],
    askLinked: async (name: string, _method: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (name === "away") throw new Error("Could not reach away: timed out");
      return params.cursor
        ? { threads: [{ id: "m2", agent: "codex", agent_name: "Codex", folder: "/w", updated: 5, count: 1, hits: [] }], cursor: null, scanned: 1 }
        : { threads: [{ id: "m1", agent: "codex", agent_name: "Codex", folder: "/w", updated: 50, count: 1, hits: [] }], cursor: "mini-next", scanned: 3 };
    },
  };
  const here = async (): Promise<SearchResult> => ({ threads: [{ id: "h1", agent: "fake", agent_name: "Fake", folder: "/w", updated: 20, count: 1, hits: [] }], cursor: null, scanned: 2 });
  const first = await searchLinked({ query: "relay" }, here, macs);
  assert.deepEqual(first.threads.map((thread) => [thread.id, thread.machine ?? null]), [["mini/m1", "mini"], ["h1", null]]);
  assert.deepEqual(first.machines.map((machine) => [machine.name, machine.reachable]), [["mini", true], ["away", false]]);
  assert.equal(first.scanned, 5);
  assert.equal(calls[0].params.linked, undefined);
  assert.ok(first.cursor);
  calls.length = 0;
  const second = await searchLinked({ query: "relay", cursor: first.cursor! }, async () => assert.fail("this Mac had no more"), macs);
  assert.deepEqual(second.threads.map((thread) => thread.id), ["mini/m2"]);
  assert.deepEqual(calls.map((call) => [call.name, call.params.cursor]), [["mini", "mini-next"]]);
  assert.equal(second.cursor, null);
});

test("linked search merges every reachable Mac's unsearched counts by agent and reason on each page", async () => {
  const remote = new ThreadSearch({
    source: {
      records: () => [
        { id: "h", agent: "hermes", cwd: "/work", updatedAt: 2 } as ThreadRecord,
        { id: "p", agent: "pi", cwd: "/work", updatedAt: 1 } as ThreadRecord,
      ],
      loaded: () => undefined,
    },
    providers: new Map([["hermes", { profile: { name: "hermes", displayName: "Hermes" } } as Provider]]),
  });
  const skipped = (await remote.search({ query: "relay" }, {})).unsearched!;
  assert.equal(skipped.length, 2);
  const local = skipped.map((entry) => ({ ...entry, count: 2 }));
  local.push({ agent: "hermes", count: 3, reason: "Hermes is disabled here." });
  const macs = {
    linked: () => [{ name: "mini", url: "ws://mini" }, { name: "desk", url: "ws://desk" }],
    askLinked: async (_name: string, _method: string, params: Record<string, unknown>) => ({
      ...(await remote.search({ query: "relay" }, {})), cursor: params.cursor ? null : "next",
    }),
  };
  const first = await searchLinked({ query: "relay" }, async () => ({ threads: [], scanned: 3, cursor: null, unsearched: local }), macs);
  assert.ok(first.machines.every((machine) => machine.reachable));
  assert.deepEqual(first.unsearched, [...skipped.map((entry) => ({ ...entry, count: 4 })), local[2]]);
  assert.equal(local[0].count, 2);
  const second = await searchLinked({ query: "relay", cursor: first.cursor! }, async () => assert.fail("the local search was exhausted"), macs);
  assert.deepEqual(second.unsearched, skipped.map((entry) => ({ ...entry, count: 2 })));
  assert.equal(second.cursor, null);
});

test("with linked, a Mac that fails a later page is asked again where it left off, a few times; a cursor is tied to its query", async () => {
  let down = false;
  const asked: (string | undefined)[] = [];
  const macs = {
    linked: () => [{ name: "mini", url: "ws://mini" }],
    askLinked: async (_name: string, _method: string, params: Record<string, unknown>) => {
      asked.push(params.cursor as string | undefined);
      if (down) throw new Error("Could not reach mini: timed out");
      return params.cursor
        ? { threads: [{ id: "m2", agent: "codex", agent_name: "Codex", folder: "/w", updated: 5, count: 1, hits: [] }], cursor: null, scanned: 1 }
        : { threads: [{ id: "m1", agent: "codex", agent_name: "Codex", folder: "/w", updated: 50, count: 1, hits: [] }], cursor: "mini-next", scanned: 1 };
    },
  };
  // This Mac has pages of its own the whole time.
  const here = async (): Promise<SearchResult> => ({ threads: [], cursor: encodeCursor({ query: "relay" }, { updated: 1, id: "h" }), scanned: 1 });
  const first = await searchLinked({ query: "relay" }, here, macs);
  down = true;
  const second = await searchLinked({ query: "relay", cursor: first.cursor! }, here, macs);
  assert.equal(second.machines[0].reachable, false);
  down = false;
  const third = await searchLinked({ query: "relay", cursor: second.cursor! }, here, macs);
  assert.deepEqual(third.threads.map((thread) => thread.id), ["mini/m2"]);
  assert.deepEqual(asked, [undefined, "mini-next", "mini-next"]);
  // Down for good: left out after missesKept pages in a row.
  down = true;
  let cursor = second.cursor!;
  for (let page = 0; page < 5; page += 1) cursor = (await searchLinked({ query: "relay", cursor }, here, macs)).cursor!;
  asked.length = 0;
  await searchLinked({ query: "relay", cursor }, here, macs);
  assert.deepEqual(asked, []);
  // Given with another query, refused here, not taken for a Mac out of reach; checked before the search takes its caller's place.
  await assert.rejects(searchLinked({ query: "other", cursor: first.cursor! }, here, macs), BadCursor);
  assert.throws(() => checkLinkedCursor({ query: "other", cursor: first.cursor! }), BadCursor);
  assert.throws(() => checkLinkedCursor({ query: "relay", cursor: "not-a-cursor" }), BadCursor);
  checkLinkedCursor({ query: "relay", cursor: first.cursor! });
});

test("with linked, a Mac resting after a failure a moment ago is not counted as missing a page: its place is kept until it is asked", async () => {
  let resting = false;
  let down = false;
  const asked: (string | undefined)[] = [];
  const macs = {
    linked: () => [{ name: "mini", url: "ws://mini" }],
    resting: () => resting,
    askLinked: async (_name: string, _method: string, params: Record<string, unknown>) => {
      asked.push(params.cursor as string | undefined);
      if (down) throw new Error("Could not reach mini: timed out");
      return params.cursor
        ? { threads: [{ id: "m2", agent: "codex", agent_name: "Codex", folder: "/w", updated: 5, count: 1, hits: [] }], cursor: null, scanned: 1 }
        : { threads: [{ id: "m1", agent: "codex", agent_name: "Codex", folder: "/w", updated: 50, count: 1, hits: [] }], cursor: "mini-next", scanned: 1 };
    },
  };
  const here = async (): Promise<SearchResult> => ({ threads: [], cursor: encodeCursor({ query: "relay" }, { updated: 1, id: "h" }), scanned: 1 });
  let page = await searchLinked({ query: "relay" }, here, macs);
  // It fails once for real, then rests: many quick pages do not use up its tries.
  down = true;
  page = await searchLinked({ query: "relay", cursor: page.cursor! }, here, macs);
  resting = true;
  for (let each = 0; each < 5; each += 1) {
    page = await searchLinked({ query: "relay", cursor: page.cursor! }, here, macs);
    assert.equal(page.machines[0].reachable, false);
  }
  assert.deepEqual(asked, [undefined, "mini-next"]);
  resting = false;
  down = false;
  page = await searchLinked({ query: "relay", cursor: page.cursor! }, here, macs);
  assert.deepEqual(page.threads.map((thread) => thread.id), ["mini/m2"]);
});

test("with linked, a newer search of the caller's stops the older one while a linked Mac is still asked, which answers replaced", async () => {
  const records = [record("a", 1)];
  const folder = join(root, "linked-replace");
  writeStored(folder, "a", ["relay"]);
  const search = new ThreadSearch({ source: { records: () => records, loaded: () => undefined }, providers: new Map([["fake", storedProvider("fake", folder)]]) });
  const slow = {
    linked: () => [{ name: "mini", url: "ws://mini" }],
    askLinked: (_name: string, _method: string, _params: Record<string, unknown>, _timeout: number, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), 5000);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("called off"));
        });
      }),
  };
  const caller = {};
  const claim = search.claim(caller);
  const older = searchLinked({ query: "relay" }, (page) => search.searchUnder(page, claim.signal), slow, claim.signal).finally(() => claim.done());
  // This Mac's part is done; the linked Mac has not answered.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = await search.search({ query: "relay" }, caller);
  assert.equal(newer.threads.length, 1);
  const answered = await older;
  assert.equal(answered.replaced, true);
  assert.deepEqual(answered.threads, []);
});

// MARK: Through a bridge

test("thread.search through a bridge: listed in the features, finds a fake agent's words loaded and after a restart, and refuses an empty query", async () => {
  let bridge = await startTestBridge({ keepHome: true });
  const home = bridge.home;
  try {
    let client = await TestClient.open(bridge);
    const ready = client.frames.find((frame) => frame.params?.type === "gateway.ready");
    assert.ok(ready.params.payload.bridge.features.includes("thread_search"));
    const relay = await createThread(client);
    await runTurn(client, relay, "Where should the relay keep the push token?");
    const other = await createThread(client);
    await runTurn(client, other, "Something else entirely");
    const found = await client.call("thread.search", { query: "RELAY push" });
    assert.deepEqual(found.threads.map((thread: any) => thread.id), [relay]);
    const thread = found.threads[0];
    assert.equal(thread.agent, "fake");
    assert.equal(thread.count, 2);
    assert.deepEqual(thread.hits.map((hit: any) => hit.role), ["assistant", "user"]);
    assert.equal(thread.hits[1].text, "Where should the relay keep the push token?");
    const asked = "Where should the relay keep the push token?";
    assert.deepEqual(thread.hits[1].ranges, [{ start: asked.indexOf("relay"), end: asked.indexOf("relay") + 5 }, { start: asked.indexOf("push"), end: asked.indexOf("push") + 4 }]);
    assert.equal(found.cursor, null);
    await assert.rejects(client.call("thread.search", { query: "   " }), /no words/);
    await assert.rejects(client.call("thread.search", {}), /query is missing/);
    client.close();
    await bridge.close();
    // After a restart nothing is loaded: the fake agent's stored file is read.
    bridge = await startTestBridge({ home });
    client = await TestClient.open(bridge);
    const again = await client.call("thread.search", { query: "relay" });
    assert.deepEqual(again.threads.map((thread: any) => thread.id), [relay]);
    assert.equal(again.threads[0].count, 2);
    client.close();
  } finally {
    await bridge.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
