# Search inside threads, 2026-10-26

Backlog "Ranked by value", item 19: "Find the thread where something was decided". This is
the bridge's side, the wire and PortalsKit's model of it. The app's screens are the user's to
place (section 8 proposes them; the answers of 2026-10-26 are in section 8, and where the
search lives in the app is still open).

## 1. Design (written first, before the code)

**One method, `thread.search`, behind the feature `thread_search`.** A bridge without the
feature never sees the call; an app without it never sends it.

```
thread.search {query, limit?, hits?, cursor?, agent?, folder?, linked?}
→ {threads: [{id, agent, agent_name, title?, folder, updated, archived?, machine?, count, hits: [{role, text, ranges, timestamp, id?, before_compaction?}], compacted_at?, partial?}],
   cursor: string|null, scanned, unsearched?: [{agent, count, reason}], machines?: [...], replaced?: true}
```

- **What is searched: the threads the bridge lists** (its registry, `threads.json`), every
  agent's. Nothing else on the Mac: a session started at the desk and never taken up is not
  searched, and neither is anything outside the thread's own conversation.
- **Where the text comes from.** Every thread is read from its agent's own files, loaded
  or not, without loading it (no agent process, no daemon call). Only a thread whose agent
  keeps no such file (Hermes), or a loaded thread whose file is not written yet, is
  searched in memory (`Session.messages`, the rows the app shows). A loaded Droid or Cursor
  thread adds the messages shown but not saved to the bridge's record yet (those agents
  save when a tool or the turn ends): a message said N times loaded and M times in the
  file is unsaved N - M times, its last N - M sayings, those of them newer than the file,
  give or take five seconds. (The first build
  searched every loaded thread in memory; the review found that a loaded Claude thread
  then lost what came before its last compaction, and a loaded Pi thread its other
  branches, so that a thread found different things open and closed.)
  - Claude Code: `~/.claude/projects/<folder>/<id>.jsonl` (`$CLAUDE_CONFIG_DIR` honoured).
  - Codex: the rollout file `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` (`$CODEX_HOME`).
    Codex's own `thread/search` (experimental in 0.163) searches every Codex thread, not the
    bridge's, gives one snippet per thread and only for Codex: not used, so that every agent
    is searched the same way. Recorded in section 5.
  - Pi: its session file (`findSessionFile`, the one the bridge already reads).
  - Droid, Cursor and the fake agent: the bridge's own record of the thread, a JSON file of
    stored messages.
  - Hermes: only when loaded. `hermes serve` keeps the conversation and offers no search the
    bridge can call without loading each session; an unloaded Hermes thread is counted in
    `unsearched` with the reason, never silently missed.
- **Matching.** Words, case-insensitive and diacritic-insensitive (`café` = `cafe` = `CAFÉ`,
  NFKD with combining marks removed, then lower case). A word matches **where a word of the
  text begins** (2026-10-26: "Start of words"): `deploy` finds `deployment`, `log`
  finds `login` but not `catalog`. Quoted text is a phrase, matched as it stands, with any
  run of spaces or line breaks as one space, beginning where a word begins. A message is a
  hit when it holds **every** word and phrase. User messages and the agent's replies only:
  tool calls and their output are not searched, nor the agent's reasoning (2026-10-26: "Never"), because "where was it decided" is in what was said, and tool
  output (files read, test logs) would drown every query in hits and cost most of the bytes.
- **Where a word begins.** A word is letters and digits (`\p{L}`, `\p{N}`); anything else
  ends one: white space, punctuation, `_`, an emoji. A capital after a small letter or a
  digit begins one inside a longer word, and so does the last capital of a run before a
  small letter, as camelCase writes them. So `search` finds `thread_search`,
  `thread-search`, `threadSearch` and `ThreadSearchWire`, `server` finds `HTTPServer`, and
  `threadsearch` still finds `threadSearch` whole; `search` does not find `research`.
  Letters and digits together are one word (`2` does not find `v2`; `10` finds
  `2026-10-26`). In scripts written without spaces between words (Han, Hiragana,
  Katakana, Bopomofo, Thai, Lao, Khmer, Myanmar, Tibetan, Yi) a term that starts with one of
  their letters matches anywhere, and a word right after one of their letters begins there
  (`swift` in `用Swift写`); Korean is written with spaces and is matched as Latin is. A term
  that starts with neither a letter nor a digit (`.env`, `#12`, `🚀`) matches anywhere. A
  phrase's first word must begin a word; its last may run on into a longer one (`"relay
  push"` finds `relay pushes`), so that a phrase is no stricter at its end than its words
  are one by one, and a half-remembered last word still finds it. The snippet marks only
  matches that begin a word, also when the snippet itself starts inside one.
- **Scope.** Everywhere by default (2026-10-26: "Everywhere"): without `folder` or
  `agent` the bridge searches every thread it lists, every agent's, and the app sends
  neither unless the person narrows it. Archived threads are searched and marked
  (`archived`), as before: not answered, the default taken, open to change.
- **Before a compaction** (2026-10-26: "Open at compaction + note"). A hit said
  before the thread's latest compaction, where the thread no longer shows what came
  before it, is kept and marked `before_compaction: true`, and its thread carries
  `compacted_at`, the time of the `compaction` row the thread's history shows there. The
  app looks for the hit's row by role and time as for any hit; not finding it, it opens
  the thread at the compaction row and shows the snippet in a note. Per agent: **Claude
  Code**, marked: its session's messages start again at the compaction's summary
  (`isCompactSummary`, after the `compact_boundary` record and before the `/compact` that
  asked for it), and the bridge's history marks the place with a `compaction` row at the
  summary's time, which is `compacted_at`. Which messages are hidden is Claude Code's own
  reading of the session to say: the SDK's `getSessionMessages`, which the bridge's history
  reads, follows the chain of `parentUuid`s from the session's last message back to its
  latest compaction, through branches and the messages a compaction kept
  (`preservedMessages`, `preservedSegment`). A hit is marked when that conversation does
  not hold it and it was said before the compaction's summary. So those between two
  compactions are marked too, and a compaction on a branch left behind (the session
  resumed from a message before it) marks nothing. It is asked only for a thread with a
  compaction (found as the file is scanned) and a hit, by the folder the session says it
  is in when the thread's finds nothing (a moved thread); it parses the whole session
  file at once, so a file over 64 MB (searched in its end) is not asked and has no marks,
  and its bytes count against the page's. (A chain read by hand from the file was built
  first, and differed from Claude Code's in four ways Codex's re-check showed.) **Codex**, not marked: its rollout has
  `compacted` records and `context_compacted` events, but `thread/read` keeps every turn,
  and the app shows what came before the compaction. **Pi**, not marked: its file has
  `compaction` entries, and its history shows the whole path, before them too. **Droid**
  (the bridge's record, with `compaction` rows), **Cursor** and the fake agent keep every
  message: not marked. **Hermes**, searched in memory, is what the app shows.
- **Results.** Grouped by thread, threads newest first (the list's own order, `updated`), up
  to `limit` threads (20, at most 50) that have a hit. Each thread gives its newest `hits`
  hits (3, at most 10), newest first, and `count`, how many messages hit in all. A hit is
  the role, a snippet of at most about 200 characters around the first match with every
  match in it as `ranges` (UTF-16 offsets into the snippet, as Swift's `String.utf16` and
  JavaScript count), the message's time, and the agent's own id for the message where its
  file has one (informational: the app finds the row by role and time).
- **Paging.** `cursor` is opaque; it says where the scan stopped (the last thread's
  `updated` and id) and the query it belongs to. A page ends when it has `limit` threads,
  or when its budget is spent: 1.5 s of scanning or 256 MB read. `cursor` null means every
  thread was searched. A thread that moves to the top between pages is not searched again
  on a later page.
- **The event loop.** Files are read in 1 MB chunks with `fs.promises`, every line is
  checked for the words with a cheap byte-level test before it is parsed as JSON, and the
  scan yields to the loop at least every 10 ms of work. A JSON-lines file over 64 MB is
  searched in its last 64 MB only (`partial: true`); a stored conversation over 64 MB (one
  JSON, which cannot be read from its middle) is left out. At most two searches run at once on a bridge; a
  newer search on the same connection replaces the older one, which answers
  `replaced: true` with no threads; a connection that closes cancels its search.
- **No index** unless the numbers say a scan is too slow (section 6 has the numbers).
- **Logs.** Nothing of the query or the text is logged; at debug, only counts and times.
- **Linked Macs** (`linked: true`, for fleet clients; the app asks each Mac it is connected
  to by itself and merges, as it does for the thread list): the query is passed to each
  linked Mac with `local` semantics and an 8 s timeout, its threads come back with ids
  `machine/id` and `machine`, and `machines` says which answered. The cursor carries one
  position per Mac, and is tied to the query and filters as this Mac's own is. A Mac that
  fails a later page keeps its position, and is asked again on the next page, up to two
  pages in a row (a page on which the fleet would turn it away unasked, for failing a
  moment ago, does not count); one that fails its first page is left out of that search. The search
  holds its caller's place until every Mac has answered, so that a newer search of the
  same connection replaces all of it.

## 2. What was built (branch `n12/thread-search`)

| Where | What |
|---|---|
| `bridge/src/search/match.ts` | The query (words, phrases, at most 8, from the first 200 characters), folding, where a word begins, the cheap test a line must pass before it is parsed, whether a message holds every word, the matches and the snippet with its UTF-16 ranges |
| `bridge/src/search/readers.ts` | Each agent's file read as that agent writes it (Claude Code, Codex, Pi, the bridge's own stored conversations), in 1 MB chunks, a line parsed only when it may hold the words; Claude Code's compactions found as it goes |
| `bridge/src/search/locate.ts` | Where Claude Code's session file and Codex's rollout file are, found without asking either |
| `bridge/src/search/search.ts` | `ThreadSearch`: the threads in the list's order, filters, the page's limits and cursor, two searches at once, a caller's newer search replacing its older one |
| `bridge/src/search/linked.ts` | `linked: true`: the linked Macs asked too, each with its own cursor |
| `Provider.searchFile` | Claude, Codex, Pi, Droid, Cursor and the fake agent say where a thread's conversation is; Hermes has none |
| `thread.search`, feature `thread_search` | `bridge/src/gateway/methods.ts`, `features.ts`; `bridge/contract.json`; `docs/gateway-protocol.md` section 11 |
| `bridge/test/thread-search.test.ts` | 37 tests: matching and where a word begins (accents, emoji, camelCase, scripts without spaces, phrases, and 3,000 small texts on which holding, marking and the snippet must agree), each agent's file, hits before a compaction per agent (fixtures in `bridge/test/fixtures/search/`, and Pi's recorded session files checked against the history the bridge shows), locating, paging, filters, limits, replacing, the loop's turns, linked Macs, and the method through a bridge with the fake agent before and after a restart |
| PortalsKit | `AgentCore/ThreadSearch.swift` (the query, the page, a thread's hits and `compactedAt`, a hit with its ranges as `Range<String.Index>` and `beforeCompaction`, the threads not searched, the error, the `ThreadSearching` protocol); `HermesBackend/ThreadSearchWire.swift` (the feature, the params, the decoding, `HermesBackend.searchThreads`); `ThreadSearchWireTests`; the contract subset. No views |

## 3. The wire

`thread.search {query, limit?, hits?, cursor?, agent?, folder?, linked?}`, in full in
`docs/gateway-protocol.md` section 11 (`thread_search`). An example answer:

```json
{"threads":[{"id":"019a2b3c-…","agent":"codex","agent_name":"Codex","title":"Relay decisions",
  "folder":"/Users/dev/portals","updated":1761500000,"count":4,
  "hits":[{"role":"assistant","text":"…Decision: the bridge keeps the push token; the relay only forwards…",
           "ranges":[{"start":32,"end":36},{"start":48,"end":53}],"timestamp":1761499000.5,"id":"item-a1"}]}],
 "cursor":"eyJ2IjoxLCJrIjoi…","scanned":37,
 "unsearched":[{"agent":"hermes","count":2,"reason":"This agent keeps its threads where the bridge cannot read them without opening each one: a thread of it is searched only while it is open."}]}
```

## 4. Coverage per agent

| Agent | Searched in | What is searched | Not searched |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<folder>/<id>.jsonl` (`$CLAUDE_CONFIG_DIR`); found by the folder's name (Claude Code's: every character but a letter or digit a `-`), else in any folder | `user` records with typed text (a slash command as typed: `/compact keep the notes`), `assistant` text blocks | tool results, thinking, `isMeta`, `isSidechain` (subagents), `isCompactSummary`, caveats, interruptions, task notifications |
| Codex | its rollout file under `$CODEX_HOME/sessions/YYYY/MM/DD` or `archived_sessions`, found by a walk kept in memory and walked again (at most every 10 s) for an id it lacks | `event_msg` `item_completed` `UserMessage` and `AgentMessage` (Codex since 0.150), `user_message` and `agent_message` (before) | `response_item`s (what the model was sent: instructions, folder context), commands and their output, reasoning |
| Pi | its session file (`findSessionFile`, as the bridge reads its history) | `message` entries of `user` and `assistant`, every branch of the session | `toolResult`, the system message, other entries |
| Droid, Cursor, fake | the bridge's own record of the thread (`state/droid/threads/<sha256>.json`, `state/cursor/threads/<id>.json`, `state/fake/<id>.json`) | stored `user` and `assistant` messages | tool rows, a failed turn's row, compaction marks |
| Hermes | in memory only, while the thread is loaded in this run of the bridge | the stored messages the app is shown | an unloaded thread: counted in `unsearched` with the sentence. `hermes serve` keeps the conversation; asking it would load each session |
| A loaded thread with no file yet | `Session.messages`, the rows the app is shown | user and assistant rows | |

## 5. Decisions, and why

- **Every agent read the same way, from files, not through the agents.** Codex 0.163 has
  `thread/search` (experimental) and `thread/searchOccurrences`. It searches every Codex
  thread on the Mac, not the bridge's list, one snippet per thread, case-insensitive
  substrings only (no accents, no "every word"), and only Codex's; using it would mean two
  kinds of results and an experimental API that may change. Its rollout files are
  read in about 0.2 s per 100 MB, which settles it. If Codex's search becomes stable it can
  serve as a fast path for Codex threads later (section 8).
- **User and agent text only, never tool output or reasoning** (2026-10-26:
  "Never"). Tool output is most of a session's bytes and would put nearly every thread in
  every result ("relay" is in every `rg` output of the relay's code); reasoning is hidden
  in the app by default.
- **Everywhere by default** (2026-10-26: "Everywhere"). The bridge searches every
  thread it lists unless `folder` or `agent` narrows it; the app sends neither by default.
- **Every word in one message, not across the thread.** A snippet can then show them
  together, and "where was X decided about Y" is mostly said in one message.
- **A word matches where a word begins** (2026-10-26: "Start of words"). `deploy`
  finds `deployment`, since people remember stems, and `log` no longer finds `catalog`.
  camelCase parts begin words because agents' talk is full of names written so, and a
  person looking for `search` means `threadSearch` too; `_` and other punctuation end a
  word for the same reason. A phrase's last word may run on, as a single word may. In
  scripts written without spaces there is no telling where a word begins without a
  dictionary, so their terms match anywhere. Folding is unchanged, and the cheap test a
  line passes before it is parsed is the same (a word that begins a word is in the line).
- **Newest thread first, newest hits first.** The thread list's own order, which a page
  can follow with a cursor, and where a decision was last stated. No relevance ranking: it
  would need every thread scanned before the first page.
- **`agent`, not `profile`, for the filter.** The app sends `profile` on most calls as
  the agent the call is for; a search spans agents, and reading `profile` would quietly
  narrow every search the app sends that way.
- **Hits are found by role and time, not by an id.** The app's rows have no ids that last
  (`message_ids` holds only for the run that sent them); the agent's own id is given when
  there is one, for later.
- **No index.** The numbers below: 1 GB of session files is searched in about 2 s on the
  mini (page cache warm), a page at a time, and the event loop is never held over 15 ms. An index would be state to
  keep right through compaction, deletion and adoption, for no need yet.
- **Claude Code after `/compact`** (2026-10-26: "Open at compaction + note"). Its
  file keeps the text before the compaction, which the app no longer shows (the thread's
  messages start again at the compaction): such a hit is found and marked
  `before_compaction`, with the compaction row's time as its thread's `compacted_at`, so
  that the app opens the thread there with the snippet in a note (section 1 says why only
  Claude Code's are marked).
- **Archived threads are searched and marked** (`archived`), as before. Not answered on
  2026-10-26: the default taken, open to change (the app can drop them, or the bridge
  take a param).
- **Pi's abandoned branches** are searched too: the file holds them, and a hit there is
  still something said in that thread.
- **Linked Macs** (`linked: true`): built, because the fleet already asks every linked Mac
  with a timeout and marks the ones that do not answer (`machines`). The app does not use
  it: it is connected to every Mac of the net by itself, and asks each.
- **Who may search.** Anyone the bridge lets in: a device of the net, a linked Mac, an
  agent's `portals` command. They can read any thread with `thread.read` already, so the
  search shows nothing new; it is part of the open question of permission ceilings for
  agents' local calls, not answered here.

## 6. Measurements

Mac mini M4 (10 cores, 16 GB), macOS 26.6, Node 24.14.1, while about six other agents
were building and testing (load average 12 to 17). The page cache was warm (the corpus had
just been written; a cold read is bounded by the SSD, several GB/s on this Mac). Scripts:
`/private/tmp/portals-n12/thread-search/scripts/` (`corpus.mjs` makes the corpus, `bench.ts`
times `ThreadSearch` page after page with a 5 ms timer and `monitorEventLoopDelay`
running, `e2e-setup.ts` and `e2e-client.ts` time it through a running scratch bridge on
port 9741 with a second client pinging it every 10 ms).

Synthetic corpus A: 500 threads, 300 shaped as Claude Code's and 200 as Codex's files,
1.0 GB (2 MB average, 0.2 to 6 MB), each turn up to 6 tool calls with 2 to 32 KB of
output, 30 % of threads with accented words and emoji. Corpus B: 5,000 smaller threads,
453 MB. Corpus C: 400 fake-agent threads of 450 messages each (the bridge's own stored
format, as Droid's and Cursor's), 367 MB, in a running bridge. Real: the mini's own Claude
Code and Codex files, 26 files, 100 MB (read only; nothing of them printed, kept or logged).

| Corpus | Query | Threads with hits | Whole search | Pages | Loop held at most | Other client's ping during |
|---|---|---:|---:|---:|---:|---|
| A, 1 GB, first version (every line lower-cased) | `zeppelin` (one thread) | 1 | 6.0 s | 5 | 82 ms | |
| A, first version | `relay` (common) | 500 | 8.6 s | 10 | 156 ms | |
| A, 1 GB | `zeppelin` | 1 | 1.9 s | 5 | 5 ms | |
| A | `relay` (31,216 messages) | 500 | 2.5 s | 10 | 11 ms | |
| A | `café menu` (accents) | 0 | 1.9 s | 5 | 4 ms | |
| A | `"relay bridge token"` | 0 | 2.0 s | 5 | 5 ms | |
| B, 5,000 threads, 453 MB | `zeppelin` | 1 | 0.9 s | 2 | 3 ms | |
| B | `relay` | 4,834 | 1.7 s | 97 | 4 ms | |
| Real, 100 MB | a rare word | 0 | 0.31 s | 1 | 6 ms | |
| Real | a common word | 25 | 0.44 s | 1 | 15 ms | |
| C, 367 MB stored, in process | `zeppelin` | 1 | 0.9 s | 2 | 3 ms | |
| C, in process | `relay` (92,807 messages) | 400 | 0.9 s | 8 | 3 ms | |
| C, through a bridge (load 11) | `zeppelin` | 1 | 0.6 s | 2 | | p50 0.7 ms, max 25.7 ms (idle: 0.8, 2.2) |
| C, through a bridge (load 11) | `relay` | 400 | 1.0 s | 8 | | p50 0.8 ms, max 4.1 ms (idle: 0.9, 2.3) |
| C, through a bridge (load 11) | `café` | 0 | 0.5 s | 2 | | p50 0.7 ms, max 3.0 ms (idle: 1.0, 1.7) |
| C, through a bridge (load 25 to 33) | `relay` | 400 | 5.8 s | 8 | | p50 3.9 ms, max 81 ms (idle max 5 to 18 ms) |

The last row was taken while the other agents' builds held the machine at a load of 25 to
33 on 10 cores: the bridge was then starved of CPU as a whole (an idle ping took up to
18 ms), and the in-process benchmark's loop delay rose to about 130 ms for every query,
the rare ones that parse nothing included, so those numbers measure the machine, not the
scan; the rows above it were measured again once the load was down to about 11. Corpus A's
`zeppelin` and `relay` were rerun then too: 2.5 s each, the loop held at most 6 ms.

After Codex's review (section 9), corpus A was made again (the same generator and seed)
and searched at a load of about 8: `zeppelin` 2.7 s, `relay` 2.3 s (31,216 messages),
`café menu` 2.3 s, the loop held at most 5 ms each, 200 to 310 MB RSS: no change from
before. A snippet of a 1 MB message, which took 176 ms and about 120 MB in one go before
the review, now takes 7 to 9 ms (about 200 ms for 1 MB of accented letters), the loop
given its turn at least every 2 ms.

After the answers (words matched where a word begins, hits before a Claude Code
compaction marked), corpus A was made again with the same generator and seed, and searched
by this code and by the code before it (6af61762) in turns, three times each, at a load of
about 8: `zeppelin` 2.04 to 2.08 s against 2.02 to 2.04 s, `relay` 2.24 to 2.27 s against
2.19 to 2.28 s, the loop held at most 5 ms either way; at a load of about 11, `café menu`
2.2 s and `"relay bridge token"` 2.2 s both ways. No change. A query found only inside
words everywhere (`ist`, in `list` and `history`: no hits now, 37,120 before) takes 2.7 s
against 2.2 s, every message that holds it parsed and told apart; the loop held at most 7
ms. A first build looked for Claude Code's compaction summary through every line, tool
output too, and took 2.6 s for `zeppelin`; it now looks only in user lines that are not a
tool's result. A 1 MB message of camelCase words that holds the query only inside words
keeps the loop 19 ms to say it is not a hit (40 ms accented), against 14 ms (27 ms) before
for folding it whole, as any message of that size is; a first build that walked the whole
message to find its capitals took 64 ms (206 ms), and one with a pattern that looked
behind each capital held it seconds on a long run of combining marks (Codex's review,
section 9). A Claude Code thread with a compaction and a hit has its chain of messages
read once more (section 1); corpus A has none, so its numbers do not show it.

The first version lower-cased (or decomposed) every candidate line before testing it,
and gave the loop its turn only between 1 MB chunks; testing the raw line with
case-ignoring patterns, folding only a non-ASCII line that misses, and giving the loop
its turn every 32 lines made it three to four times faster and the loop's longest hold 15
times shorter. A page ends at 256 MB on corpus A (about 0.5 s), at 50 threads with hits
on a common word, and never later than the first thread after 1.5 s. Memory: the scan
holds one chunk and the current line; the benchmark process stayed at 170 to 340 MB RSS.

## 7. What is left

- **The app's screens** (section 8), on the word.
- **Codex's own `thread/search`** as a fast path for Codex threads, once it is stable,
  if the files ever get too many to walk (a walk of the mini's 22 rollouts is a few ms).
- **Hermes threads unloaded**: if `hermes serve` gains a search, or a way to read a
  session's messages without loading it, its threads can join; until then they are counted.
- **A date range**: a param, if wanted. (Tool output and reasoning: never, 2026-10-26. Whole words: answered with word starts.)
- **Where search lives in the app** (question 1 of section 8): not answered on 2026-10-26.
- **An index**, only if a Mac's files grow to many GB: the numbers say a scan is fine
  up to a few GB (a page per 256 MB, about half a second each).
- **Very large stored conversations** (Droid, Cursor, over 64 MB) are left out rather
  than parsed: not seen in practice; a thread's stored file is rewritten whole at every
  tool row, so it stays far smaller.
- **Claude Code's long folder names** (over 200 characters, cut and hashed): found by the
  cut name's start, else by looking in every project folder. Not seen on the mini.
- Codex reviewed the branch (section 9).

## 8. A proposal for the app's screens, and questions for the user

Proposal: the sidebar's search field keeps filtering titles and previews at once, as now,
and below those rows, under a "In messages" heading, the hosts' `thread.search` results
arrive as they come: each thread one row (agent logo, title, folder, time), with its
newest one to three snippets under it, the matched words bold, "You" or the agent's name
before each, and "and N more" when `count` is larger. The query is sent 300 ms after the
last keystroke; a newer one replaces the older on each host (the bridge answers the old
one `replaced`, which the app drops). Each connected host is asked by itself and the rows
merged by time, as the thread list is; a host without the feature, or that does not answer
within a few seconds, is named at the bottom ("Not searched: Studio (needs an update)").
Scrolling to the end asks each host with more for its next page. Tapping a snippet opens
the thread and scrolls to the row with that role and time, the words highlighted (a hit
`before_compaction` whose row is not there opens at the compaction row, the snippet in a
note above it);
`unsearched` is one quiet line ("2 Hermes threads were not searched: open them to search them").

Questions, with the answers of 2026-10-26:

1. Where should it live: the sidebar's search field (below the title matches), a search
   screen of its own (a magnifier in the sidebar's header), or both, with ⌘⇧F on a Mac?
   **Open**: not answered (the attention is on picking folders).
2. Should it be scoped to the open folder or agent by default (`folder`, `agent`), with
   "everywhere" one tap away, or everywhere by default? **"Everywhere"**: the app sends
   neither by default; the bridge already searches everywhere without them.
3. Tool output and reasoning: never, or behind a switch ("Include tool output")?
   **"Never"**: as built; no param for them is planned.
4. A hit before a Claude `/compact` is not shown in the thread any more: open the thread at
   the compaction row with a note, or leave such hits out? **"Open at compaction +
   note"**: built: `before_compaction` on the hit and `compacted_at` on its thread
   (section 1). When the hit's own row is not in the thread, the app opens it at the
   `compaction` row with that time and shows the snippet in a note above it.
5. Whole words only, or words inside words as now (`deploy` finds `deployment`)? **"Start
   of words"**: built (section 1, "Where a word begins").
6. Archived threads: in the results (marked, as now), or only when the archive is open?
   **Not answered**: they stay in the results, marked, the default taken, open to change.

## 9. Outside review (Codex, gpt-6.1-sol at xhigh, 2026-10-26)

Read only, on the branch as first pushed (894c076a), then three re-checks of the fixes.
Each finding was reproduced, and each fix has a test that fails on the code before it.

First pass, eleven findings, all fixed:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | medium | A thread whose time moved while a page searched it gave the cursor its new time: the next page repeated threads | each thread's place is taken before the page searches; cursor and `updated` hold it |
| 2 | medium | A search replaced during its last thread answered what it found | checked once more before it answers |
| 3 | medium | With `linked`, a newer search could not stop the linked Macs' part | the search holds its caller's claim until every Mac has answered |
| 4 | medium | A loaded thread was searched in memory: a loaded Claude thread lost what came before its compaction, a Pi thread its other branches | every thread read from its agent's file; memory only without one |
| 5 | medium | Droid's hits came out in milliseconds | made seconds, as its history does |
| 6 | medium | A linked Mac that failed a later page was never asked again | its cursor kept for two pages in a row |
| 7 | medium | A snippet mapped the whole message: 176 ms and 120 MB for 1 MB | found in the folded text, mapped back a stretch at a time |
| 8 | medium | The pre-test turned away `"--- ---"` across a line break, and `caf\u00e9` | needle of punctuation as JSON writes it; escaped letters parsed |
| 9 | low | A linked cursor was not tied to its query | tied, refused with -32602 |
| 10 | low | `¨` folded to one space matching, two marking: a count with no hits | marking joins it with the white space around it |
| 11 | low | `folder: "/"` matched nothing inside the root | the root holds every folder |

First re-check: seven held; four problems in the fixes, all fixed: a phrase across a run
of white space longer than the windows had no snippet; a loaded Cursor or Droid thread's
messages not saved yet were not found; the fleet's 30 s rest after a failure used up a
linked Mac's tries without asking it; a bad linked cursor stopped the search under way.

Second re-check: two of those partial, both fixed: a stretch of white space only shifted
the snippet's match; an unsaved message with the same words as a saved one was taken for
it (now counted: said N times loaded and M times in the record, unsaved N - M times).

Third re-check: both fixed, nothing new found.

### After the answers (2026-10-26, evening)

Codex (gpt-6.1-sol at xhigh, read only) reviewed the diff from 6af61762 (word starts, hits
before a compaction, PortalsKit, docs). Three findings, each reproduced and fixed with a
test that fails on the code reviewed:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | medium | The camelCase pattern looked behind each capital over runs of combining marks, again at each mark: `a`, 20,000 marks and `Search` held the bridge 11 s | each capital that may begin the term told by stepping back from it; a few ms |
| 2 | medium | A compaction on a branch left behind (resumed from a message before it) marked the messages before it, with a compaction row the thread does not have | marked by the session's chain of `parentUuid`s and the boundary's `logicalParentUuid`, as Claude Code tells its conversation |
| 3 | low | U+FF9E or U+FF9F before a capital (they decompose to combining marks) was passed over by marking, not by holding: a mark with no hit | the character before a capital is the one the folded text has before it |

Re-check (head e38d6e1b): all three held. Four new findings in the chain read by hand for
finding 2, and one older one, all fixed with tests:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 4 | medium | The last entry taken for the conversation's end: a background task's progress written last under a message from before the compaction lost the marks | the conversation is Claude Code's own reading (`getSessionMessages`), asked of the provider |
| 5 | medium | A long line's ids taken by its first `"uuid"`: one in a tool's input broke the chain | the same |
| 6 | medium | A message kept by an earlier compaction stayed kept after a later one that kept nothing | the same |
| 7 | medium | A kept stretch (`preservedSegment`) was not read: messages still shown were marked | the same |
| 8 | medium (older than these changes) | Decomposing put each run of combining marks in order, in the square of its length: `a`, 40,000 pairs of marks and `Search` held the loop 0.4 s and more | the marks written out removed before decomposing too |

Second re-check (head 5512dc0b): all five held; no fold result changed across every
Unicode scalar. Two new, both fixed with tests:

| # | Severity | Finding | Fix |
|---|---|---|---|
| 9 | medium | A moved session (kept under another folder than the thread's) read as empty by Claude Code's reading, so its hits lost their marks | asked again by the folder the session says it is in |
| 10 | medium | Claude Code's reading parsed a file over 64 MB whole, outside the page's budget and with nothing to stop it | not asked for such a file (no marks); otherwise its bytes count against the page |

Third re-check (head 65501885): both held, nothing new found.


My own, alongside: Pi's session files are remembered as Claude Code's are (a miss looked
in every folder of Pi's sessions at every search), and the Cursor provider's `start()`
has its comment back.
