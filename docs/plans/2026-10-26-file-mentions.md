# @-mention a file with fuzzy search (bridge, wire, PortalsKit), 2026-10-26

Backlog "Ranked by value", item 10: "Codex `fuzzyFileSearch` (needs no thread, so it can
serve Claude too) and a `mention` input; for Claude an `@path` in the text. Like the
slash-command menu". Why on a phone: "Typing paths on a phone is painful". Built in run n12
on the Mac mini, unattended (the user away); every decision below says why. No SwiftUI: the
screens are the user's.

## 1. Design (written first)

**Search.** A bridge method `files.search {session_id | folder, query, limit}` ranks the
files and folders of one folder against a fuzzy query, as an editor's quick-open does, and
answers each hit as `{path (relative), name, kind (file|folder), score, ranges}`.

- *Which folder.* A thread's own folder (by `session_id`, the thread need not be followed,
  as `file.read`), or a `folder` that `folders.resolve` accepts: General, one on the list,
  or a git worktree of one. Never the home folder or `/` (as `file.read`).
- *Which files.* In a git repository: `git ls-files --cached --others --exclude-standard`
  (the index plus untracked files not ignored), minus what `--deleted` lists. Elsewhere a
  bounded walk that follows no link and skips `node_modules`, `.git`, `DerivedData`,
  `.build`, `Pods` and the like. Folders are the ones the files are in. Strictly inside: a
  listing never holds `..` and no link is followed, so nothing outside is ever named.
- *Cache.* One listing per folder, kept fresh by one recursive `fs.watch` (FSEvents on a
  Mac) that marks it stale; a stale listing is listed again on the next query (one at a
  time, coalesced). At most a few folders and a fixed number of paths are held, least
  recently used dropped, watchers closed after idling.
- *Ranking.* Our own scorer in TypeScript (fzf-like: a subsequence, with bonuses for the
  start of a word or a path part, for runs, and for matching in the file's name), so the
  results are the same whatever agent runs the thread. Codex's `fuzzyFileSearch` is
  measured against it on the same trees (section 5) to decide.
- *Feature* `file_search` in `bridge.features`: an app shows the menu only when listed.

**Sending a mention.** The text stays the truth: the app writes each picked file into the
message as `@path` (`@"path"` for one with spaces, or not ending on an ASCII letter, digit
or `_`, which Claude Code would cut short), as Claude Code's own prompt reads it, and may send
`mentions: [path]` beside it in `prompt.submit` (feature `file_mentions`). How each agent
gets it is decided from evidence (section 3): Claude Code expands `@path` itself; the
others are given the path in the text, and an agent spoken to over ACP (Cursor) also a
`resource_link` per file. The bridge never pastes a file's contents into a message.

## 2. What was built

Branch `n12/file-mentions`, from `main` at `7bd3649f`. Nothing installed, nothing merged.

| Part | Where | What |
|---|---|---|
| Search | `bridge/src/sessions/fileSearch.ts` | `FileSearch`: listing (git or walk), per-folder cache with a watcher, bounds, the scorer, narrowing a query typed on from the last one's matches |
| Method | `bridge/src/gateway/methods.ts` `files.search`, feature `file_search` | A thread's folder (`session_id`, followed or not) or a folder new threads may start in (`folder`, through `Folders.resolve`); never the home folder or `/` (`ownFolder`, shared with `file.read`) |
| Mentions | `bridge/src/sessions/mentions.ts`; `prompt.submit` param `mentions`, feature `file_mentions` | Kept when inside the thread's folder; written into the text as `@path` when the text lacks it; carried by `Prompt.mentions` through the bridge's queue (and its file across a restart); Cursor gets a `resource_link` each |
| Large files (the decision 3, section 10) | `mentions.ts` (`claudeMentionLimit`, `mentionFit`, `largeMentions`, `withSizes`), `Provider.mentionLimit` (Claude Code's only), `files.search` and `prompt.submit` in `methods.ts` | A file hit's `size`; `mention_limit` in `files.search`'s answer for an agent that reads mentions in itself (the thread's, or for a `folder` the `profile`'s); `large_mentions` in `prompt.submit`'s answer |
| Wire | `docs/gateway-protocol.md` (rows `file_search`, `file_mentions`), `bridge/contract.json`, `contract-subset.json` | Checked with `scripts/check-contract.sh` |
| PortalsKit | `AgentCore/FileMentions.swift`, `BridgeWire` (`FilesSearchParams`, `fileSearchResults`, `PromptSubmitParams.mentions`, `LargeMentions`), `HermesBackend+Bridge.swift` (`FileSearching`, `FileMentionSending`) | The request, the result types and their decoding, sending mentions; `FileMention.token(for:)` and `FileMention.paths(in:)`; `FileSearchHit.size`, `FileSearchResults.mentionLimit` and `fit(of:)`, `FileMentionLimit.fit(size:)`, `FileMentionFit.note`, `SendReceipt.largeMentions`; `searchFiles(_:in:limit:agent:)` for the new-thread screen. No view |
| Tests | `bridge/test/file-search.test.ts` (25), `bridge/test/file-mentions.test.ts` (10), one each in `bridge/test/cursor-bridge.test.ts` and `bridge/test/codex-bridge.test.ts`, `PortalsKit/Tests/HermesBackendTests/FileSearchWireTests.swift` (14), two in `BridgeExtensionTests`, `ContractSubsetTests` | Unit, the wire through a test bridge with the fake agent (and one standing in for Claude Code's limit), Cursor's and Codex's stand-ins, Claude Code's session file read back through the SDK |
| Measurements | `bridge/scripts/file-search-bench.ts` | Section 5, to run again |

Decisions made on the way, and why:

- **git with its file system monitor off.** `git ls-files` runs the command a repository's
  `core.fsmonitor` names (tried here with git 2.54: a monitor script left its mark). The
  bridge runs git by itself as the person types, so it passes `-c core.fsmonitor=false`.
  It also never runs `/usr/bin/git` on a Mac without the developer tools (that stub asks
  to install them; `src/git.ts` avoids git for the same reason): `findGit` takes a git on
  the PATH other than the stub, or the developer tools' own, else the walk.
- **A folder git lists nothing in is walked.** A thread in a repository's ignored
  `build/` would otherwise find nothing.
- **Skipped folders**, walk only and for the watcher: `.git .hg .svn node_modules
  DerivedData .build build Pods .swiftpm Carthage .venv venv __pycache__ .mypy_cache
  .pytest_cache .tox .next .nuxt .turbo .cache .gradle target dist .parcel-cache .Trash
  .portals`. `build`, `dist` and `target` are outputs in nearly every project; a project
  that keeps sources there and has no git loses them from the menu. The user kept this
  (section 10, decision 2).
- **A link is listed by its own name and never followed**, in the walk and from git (git
  lists a link as a file). Mentioning one that leads out of the folder is dropped by
  `checkMentions`, which resolves links.
- **Stale-while-listing.** A folder that changed is listed again on the next search; when
  that takes longer than 150 ms (a 100,000-file folder takes about half a second), the
  search is answered from the listing it had, with `refreshing: true`, and the app asks
  again. A keystroke never waits half a second because an agent wrote a file.
- **A named folder is checked every 5 seconds, not every keystroke.** `Folders.resolve`
  reads the folders every agent reported and looks at each on disk; a query typed a
  keystroke at a time would do that each time. A folder taken off the list is searched
  for up to 5 seconds more.
- **Folders are hits too**, ranked as files are. An empty query lists the shallowest
  entries, folders first, so the menu has something to show as soon as `@` is typed.
- **Several words** in a query must all match (`gw meth` finds `src/gateway/methods.ts`),
  as in VS Code's quick-open.
- **Mentions: the text is the truth.** The app writes `@path` where the person picked the
  file; the `mentions` list is a declaration beside it. The bridge appends the token of a
  mention the text lacks, so the agent, the agent's own history and every device see the
  same words, and an older bridge (which ignores `mentions`) still gives Claude Code the
  `@path`. Mentions that fail the check are dropped without an error, as the text still
  says what the person meant.
- **Mentions are checked synchronously** in `prompt.submit`'s handler (a few `realpath`
  calls), so a message sent after one with mentions never overtakes it.
- **A protocol of its own for sending mentions.** `FileMentionSending.send(…, mentions:,
  …)`, which `HermesBackend` implements, rather than a new parameter on
  `AgentBackend.send`, whose every conformer and caller would change: the composer, which
  is the user's, calls it when the backend conforms. `HermesBackend` sends `mentions` only
  to a bridge that lists `file_mentions`, and the text alone otherwise; the `@path` in the
  text is enough for every agent (section 3).

## 3. How each agent gets a mention (evidence)

| Agent | What it does with a mentioned file | Evidence | What the bridge does |
|---|---|---|---|
| Claude Code (Agent SDK) | Reads every `@path` of a user message itself, before the model, and gives the model the file as a `Read` result (a `<system-reminder>`); `@"path with spaces"` too; also in a message sent as content blocks. Up to a limit, 262,144 bytes and 25,000 tokens (below): a 6,000-line, 199,501-byte text file was not given, and the model was not told. A path that does not exist gives nothing | A short real run on 2026-10-26: Claude Code 2.1.299, Haiku 5.5, five prompts in a scratch folder with every tool call denied; the model quoted the words in `secret.txt`, `dir with space/note.txt` and (as blocks) `secret2.txt`, and had nothing for `src/big.txt`. The session file holds an `attachment` line of type `file` with the file's text after the user line (now `bridge/test/fixtures/claude/mention.session.jsonl`, paths replaced). The session and its folder were deleted after | Nothing more: the `@path` in the text. The bridge's history reader shows the message as written and not the file (tested through `getSessionMessages`) |
| Codex | Its `UserInput` `mention {name, path}` is for apps, plugins and skills: the targets its binary knows are `app://<connector-id>`, `plugin://<plugin-name>@<marketplace-name>` and `skill://` (`strings` of codex-cli 0.163.0, beside `tui/src/app/connector_mentions.rs`, `plugin_mentions.rs`, `skills/src/mentions.rs`). Its own composer's `@` file search (`tui/src/file_search.rs`) puts the picked file's path into the text | Codex's generated protocol types (`codex app-server generate-ts`) and the binary's strings | The text, with `@path`: the model reads the file with its tools, as after Codex's own `@`. Tested on the stand-in daemon: `turn/start` has one text input |
| Cursor (ACP) | ACP's prompt takes `resource_link` blocks (`{uri, name}`), which every ACP agent must accept (of the other kinds, `image` and `audio` need a prompt capability, and `resource`, with the contents inside, needs `embeddedContext`) | The ACP schema; Cursor itself is not installed on the mini, so it was not run | The text, and a `resource_link` per mention after it (`file://` URI, the file's name). Tested on the stand-in |
| Pi, Droid, Hermes | No mention input the bridge speaks to: Pi's RPC `prompt`, Droid's message and Hermes's `prompt.submit` take text | Their providers in `bridge/src/providers/`; Pi, Droid and Cursor are not installed on the mini | The text, with `@path` |

No agent is given a file's contents by the bridge. Claude Code's reading is its own, the
same as at the desk.

**Claude Code's limit for a mentioned file** (the decision 3, section 10). The bridge
runs `~/.local/bin/claude`, Claude Code 2.1.299.

*From its CLI.* The binary carries its JavaScript; read with a script over the file
(a few lines of Perl printing what surrounds a pattern), on 2026-10-26:

- `defaultFileReadingLimits = {maxSizeBytes: 262144, maxTokens: 25000}`; the environment's
  `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` replaces the tokens.
- A mentioned file over 262,144 bytes (one with an extension that is not binary or a
  notebook; a PDF has a way of its own) is not read: Claude Code keeps an
  `at_mention_reference` with `unread: "too_large"` and its size, shows "not read: too
  large" at the desk, and tells the model "The user @-mentioned X (size). Its contents
  were not attached because the file is too large to read all at once. Read it in
  portions …".
- Otherwise it is read as its `Read` tool reads a file, and its tokens counted (an
  estimate; for a file estimated over a quarter of the limit, the API's own count). Over
  25,000 tokens the first 2,000 lines are tried, and given with "No need to mention the
  truncation" when they fit; when they are over too, nothing is attached and the model
  is told nothing (the read's error is caught and the mention dropped). That is the
  silent case the first run showed.

*A run to bracket it*, 18:10 to 18:12: `claude -p --model haiku --tools "" --permission-mode
dontAsk --strict-mcp-config --setting-sources project`, so no tool at all, in a scratch
folder of generated files (lines of common English words, the
bridge's own TypeScript, random base64), five prompts each mentioning a few and asking
for the word on each file's first line. What was attached is read from the session
file's `attachment` lines, not the model's answer (Haiku called the whole `c060.ts`
partial). The sessions were deleted after.

| File | Bytes | Lines | Attached |
|---|---:|---:|---|
| TypeScript | 59,978 | 1,356 | whole |
| TypeScript | 65,006 to 84,994 (five, every 5,000) | 1,496 to 2,052 | nothing, no word to the model |
| TypeScript | 90,006 and 120,012 | 2,178 and 2,791 | nothing (their first 2,000 lines are over too) |
| English words | 60,016 and 80,011 | 1,045 and 1,387 | whole |
| English words | 100,027 to 180,026 (four) | 1,738 to 3,129 | nothing |
| Random base64 | 197,982 | 6,000 | nothing (as the 199,501-byte file of the first run) |
| English words | 300,045 | 5,202 | not attached: `at_mention_reference`, `too_large`, the model told |

So the limit that bites is the tokens: about 60,000 bytes of code, 80,000 to 100,000 of
prose, fewer of dense text. The bridge cannot count tokens as the API does, so it gives
the app the limit and each file's size, and the app's note starts at 60,000 bytes (2.4
bytes a token, code's): a file between that and 262,144 bytes "may" be left out, one over
262,144 is not read in. A PDF has no note: Claude Code reads one its own way (section 11).
Claude Code's settings can also set the token limit, in their `env`, and the bridge reads
them (the follow-up, 2026-10-26 evening; `bridge/src/providers/claude/settingsEnv.ts`).
From Claude Code 2.1.299's CLI: it assigns each source's `env` onto its process
environment in turn (`applyConfigEnvironmentVariables`: `Object.assign(process.env, …)`
over the sources in the order `["userSettings","projectSettings","localSettings",
"flagSettings","policySettings"]`, after the global config's `env`), so the last wins and
all win over the environment it was started with: `~/.claude.json`, then
`~/.claude/settings.json`, `<cwd>/.claude/settings.json`, `<cwd>/.claude/settings.local.json`
and managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json`).
Project settings are read in the session's cwd, not the repository's root. The bridge
asks for user, project and local (`settingSources`) and passes no flag settings; the
global config and managed settings always count. The limit is taken once per session
(`defaultFileReadingLimits ??= …`), after the settings' env is applied. The bridge reads
the files for the thread's folder (or, for a new thread, the folder searched), each kept
until its stat changes. Its own environment never reaches Claude Code for this key
(`childEnvironment` leaves out every `CLAUDE_CODE_` variable), so it does not count. Not
followed: a worktree's or a subfolder's `settings.local.json`, which Claude Code reads
at the repository's main root when the user owns it (the cwd's under it), managed
settings from MDM or a server, and a value changed while a session runs.

## 4. The wire

In full in `docs/gateway-protocol.md`, section 11 (rows `file_search` and `file_mentions`).

```
→ {"id":7,"method":"files.search","params":{"session_id":"3f9a…","query":"gw meth","limit":1}}
← {"id":7,"result":{"folder":"/Users/dev/portals","files":[{"path":"bridge/src/gateway/methods.ts","name":"methods.ts","kind":"file","score":244,"ranges":[[11,12],[15,16],[19,23]],"size":41213}],"total":1638,"matched":29,"source":"git","mention_limit":{"max_bytes":262144,"max_tokens":25000,"note_bytes":60000}}}

→ {"id":8,"method":"prompt.submit","params":{"session_id":"3f9a…","text":"Why does @bridge/src/gateway/methods.ts check params?","mentions":["bridge/src/gateway/methods.ts"]}}
← {"id":8,"result":{"status":"streaming"}}

→ {"id":9,"method":"prompt.submit","params":{"session_id":"3f9a…","text":"What is in @logs/run.log","mentions":["logs/run.log"]}}
← {"id":9,"result":{"status":"streaming","large_mentions":[{"path":"logs/run.log","size":300045,"fit":"unread"}]}}
```

- `files.search`: `{session_id?, folder?, query?, limit?, profile}`; result `{folder, files:
  [{path, name, kind, score, ranges, size?}], total, matched, source, truncated?, refreshing?,
  mention_limit?}`; `profile`, with `folder`, names the agent a new thread will run, whose
  `mention_limit` the answer then has (a thread's own agent is known).
  `ranges` are `[start, end)` in UTF-16 code units (what JavaScript and `String.utf16`
  count; `FileSearchHit.matchedRanges` turns them into ranges of the path). Errors: -32602
  (neither scope, a folder not on the list, the home folder or `/`, a wrong type), 4007 (no
  such thread).
- `prompt.submit` `mentions`: a list of strings; up to 20 kept. Its result has
  `large_mentions: [{path, size, fit}]` (`maybe` or `unread`) when the thread's agent
  reads mentions in itself and some are over the note's size. All of it additive within
  the two features, which no released bridge has yet.
- Features `file_search` and `file_mentions` in `gateway.ready`'s `bridge.features`. An
  app shows the menu only with `file_search`, and sends `mentions` only with
  `file_mentions`; Hermes's `prompt.submit` rejects keys it does not define, so `mentions`
  is never sent to it (`ContractSubsetTests`).

## 5. Measurements

**Machine.** The Mac mini: Apple M4, 10 cores, 16 GB, macOS 26 (Darwin 25.6), Node
24.14.1, git 2.54.0 (Apple Git-157), codex-cli 0.163.0. Shared with the other agents of
run n12 the whole time: the load average was between 9 and 60 while these ran (each table
says what it was), so the times are slower and more spread than on a quiet Mac. The CPU
time per query (this process only) is given beside the wall time where it was measured:
it moves less with the load.

**Corpora.**

- *This repository*: the worktree of `n12/file-mentions` (git; 1,638 entries: 1,518
  files and 120 folders).
- *A synthetic tree*: 100,000 empty files in 13,443 folders, 2 to 6 levels deep under ten
  top folders, names made of camel-cased words from a list of 84 with 14 extensions
  (`bridge/scripts/file-search-bench.ts tree`, seeded: the same tree each time), committed
  into git; 113,442 entries with the folders. Searched both through git and by the walk (`git: null`).

**Queries.** Typing: every prefix of eight targets, one keystroke at a time (each narrows
the last), 101 queries on the repository, 123 on the tree. Unrelated: 1, 2, 3, half and all
of each target's characters, each after a query that shares nothing with it, three rounds
(120 queries): nothing narrows. Targets on the repository `fileread gateway-protocol
MainScreen HermesWire contract.json sessions/session.ts ChatHeader feature-backlog`; on
the tree eight files picked every 9,973rd of git's listing, typed as a person would
(`sheetMessageConfig previewpicker routeDevice.go threadloader worker-app/apiparser
utilLoaderWatcher "gw reg route" transcriptGateway`). Limit 50.

**What is measured** (`bridge/scripts/file-search-bench.ts ours`, run three times, the
middle run's number; `codex` and `codex-session` for Codex's):
cold = a new `FileSearch`'s first query, its listing included (5 each run, the median);
warm p50/p95 per query; fresh = from writing a new file to the first search that finds it
(the watcher's event, a new listing, and the 150 ms wait); heap = the listing's size in
the V8 heap after a GC; idle = the process's CPU over 10 s with the watcher on and
nothing changing.

**Ours, in the bridge's process** (`FileSearch`; 14:53 to 14:58, load average 8.7 to 12.6;
times in ms):

| Corpus | Entries | Cold | Warm typing p50 / p95 | Warm unrelated p50 / p95 | CPU typing p50 / p95 | Fresh after a change | Heap | Idle CPU in 10 s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| This repository (git) | 1,638 | 10 | 0.10 / 0.57 | 0.17 / 0.41 | 0.11 / 1.9 | 22 | 0.2 MB | 0.3 |
| Tree of 100,000 (git) | 113,442 | 391 | 2.8 / 16.8 | 11.5 / 20.4 | 2.8 / 20.3 | 436 | 13.8 MB | 0.3 |
| Tree of 100,000 (walk) | 113,442 | 237 | 2.8 / 16.8 | 11.1 / 19.7 | 2.8 / 19.1 | 236 | 19.5 MB | 0.2 |

The same three runs earlier (14:35 to 14:41, load average 23 to 25), for how much the
machine moved them: repository cold 34, typing 0.11 / 6.8; tree (git) cold 1,469, typing
10.4 / 59.3, unrelated 20.7 / 45.4; tree (walk) cold 234, typing 3.5 / 20.4.

**Over the wire**: a whole bridge (the test bridge: scripted agent, no relay) on port 9751,
General the corpus, a thread in it, a client signed in over WebSocket on the same Mac;
limit 20; 14:58, load average 9 to 10; the middle of three runs:

| Corpus | Cold (first search) | Typing p50 / p95 | Answer size |
|---|---:|---:|---:|
| This repository | 34 | 0.78 / 2.8 | 1.9 KB |
| Tree of 100,000 (git) | 1,080 | 8.1 / 46.3 | 2.5 KB |

The client and the bridge share one process here, so the client's own work is in these
numbers; a phone's round trip adds its network.

**What keeping fresh costs.** Watching costs nothing measurable while nothing changes
(0.2 to 0.3 ms of CPU in 10 s). After a change the folder is listed again; git's listing
of the 100,000-file tree takes about 370 ms (`ls-files --cached` 26 ms, `--others
--exclude-standard` 305 ms, which reads every folder for untracked files, `--deleted` 160 ms
alongside), of this repository 15 ms; the walk of the tree about 240 ms. Searches during a
listing longer than 150 ms are answered from the one before (`refreshing`), so a keystroke
never waits for it. A change in a skipped folder (`node_modules`, `.git` but its index,
HEAD and info/exclude, …) costs nothing in a walked folder; in a git listing one in a
skipped folder git listed nothing in (a build writing into an ignored `dist`) makes the
listing be made again at a search at most every 10 s, since a file there that is not
ignored would be listed (section 9), and one git listed something in (a tracked `dist`)
counts as any change. The listing of a subfolder of a repository or of a linked worktree
is also made again at a search once it is 30 s old: ignore rules above the folder are
not watched.

**Memory.** 14 to 20 MB of heap for 113,000 entries; at most 400,000 entries held (four
folders), about 70 MB at worst, and a folder not searched for 10 minutes is let go of.

## 6. Codex's fuzzyFileSearch, or our own

Codex has two searches (codex-cli 0.163.0, measured through an `app-server` of the
benchmark's own on stdio with a `CODEX_HOME` in the scratch folder, not the shared daemon;
the same queries, the same three runs at load 8.7 to 12.6):

| Codex | Corpus | First query | Typing p50 / p95 |
|---|---|---:|---:|
| `fuzzyFileSearch` (one call a query; walks the roots each time) | This repository | 79 | 83 / 109 |
| | Tree of 100,000 | 245 | 200 / 275 |
| `fuzzyFileSearch/sessionStart` + `sessionUpdate` (experimental; walks once, then matches; results by notification) | This repository | 0.5 | 0.36 / 0.73 |
| | Tree of 100,000 | 183 | 1.3 / 6.9 |

(For the session search the time is to the first `sessionUpdated` naming the query;
`sessionCompleted` came before or after the last update, so it does not mark the end.)

Rankings: on this repository the first hit was the same for all eight queries and the top
five overlapped 92%; on the tree the first hit agreed for four of eight. Where they
differ, three are ties between files of the same name in different folders (ours ranks
the shorter path first, Codex another), and one is `transcriptGateway`, where ours puts
`transcriptGateway.js` above Codex's `transcriptGatewayWorker.js`.

**Decision: our own, only.** The one-call search is 16 to 800 times slower than ours per
keystroke (p95 on the tree, p50 on the repository) and walks the folder each time. The
session search is as fast as ours or faster once it has walked, but:

- it needs Codex: a Mac with Claude Code alone has none, and the results must not differ
  by agent, so a bridge would need our own search all the same;
- it is experimental (only in `codex app-server generate-ts --experimental`, and only for a
  client that initializes with `experimentalApi`), and moves with Codex's releases;
- it holds a session per query box in the shared daemon, with ordering between
  `sessionUpdated` and `sessionCompleted` the client has to work around;
- our own is within the aim (a warm query in a few tens of ms: p95 17 ms on 100,000
  files, under 1 ms on a real repository), reads git's own listing (exact ignore rules),
  and is cached and kept fresh in the bridge, which every agent shares.

"Both" would make the menu differ by agent, for a gain under 15 ms on a tree larger than
any the user works in.

## 7. What is left

- **The app's screens** (section 8, as decided): built in run n14 (section 12).
- **Cursor's handling of `resource_link`** is from the protocol, not seen: Cursor is not
  installed on the mini. Record a turn with a mention (`scripts/record-cursor.ts`) the next
  time Cursor is recorded, and check its reply reads the file.
- **Pi, Droid and Hermes** were not run with a mention either (not installed here, or not
  to be touched: Hermes is the live install's). They get text; nothing to record unless
  one grows a file input.
- **A folder outside the list.** `folder` takes only what a new thread may start in. The
  new-thread screen searches General and listed folders before a thread exists (the user:
  "Yes"); anything else waits for a thread.
- **The note's threshold is bytes, the limit tokens.** 60,000 bytes is code's; prose
  fits more, dense text (minified, base64) less, so the note can be wrong both ways near
  it. A file over 262,144 bytes is certain. Claude Code's next releases may move either
  number: read again with the next upgrade (section 3 says how).
- **Submodules** are listed by git as one entry, shown as a file: their files are not
  searched. Rare in the folders the user uses; `git ls-files --recurse-submodules` with `--others`
  is an "unsupported mode" (git 2.54), so it would be a second listing.
- **Very large folders** are cut at 200,000 entries (`truncated`). The cut is git's order
  (by path) or the walk's (breadth first), not by relevance.
- **Rename and delete while the menu is open**: a hit may name a file deleted a moment ago
  (until the next search); a mention of it is then dropped by the bridge's check.

## 8. The app (2026-10-26 in, section 10)

What the model layer gives the composer: `FileSearching.searchesFiles` (show the `@` menu
at all), `searchFiles(query, in: .thread(id) | .folder(path), limit:, agent:)`,
`FileMentionSending.send(…, mentions:, …)`, `FileSearchHit`
(`path`, `name`, `kind`, `matchedRanges` to bold, `token` to insert, `size`), `refreshing`
(ask again in half a second), `FileSearchResults.fit(of:)` and `FileMentionFit.note` (the
note on a large file), `SendReceipt.largeMentions` (the same for a message sent), and
`FileMention.paths(in:)` to find the mentions in a text (for chips in sent messages, from
history too, since the text holds them).

The shape, following the slash-command menu the composer already has:

1. Typing `@` at the start of a word opens a menu above the keyboard, like `/`; an `@`
   inside a word (an email address) does not (decided). Empty query: the folder's top
   level (folders first). Each keystroke after `@` searches; the menu shows up to about 8
   rows on a phone, more on a Mac.
2. A row: an SF Symbol for file or folder, the name with matched letters bold, and the
   folder it is in, dimmed, on one line (the path's head truncated in the middle). A file
   whose `fit(of:)` is not `.whole` has the small note (decided), e.g. "Large file: the
   agent may not get all of it with the message".
3. Picking a file replaces the `@query` with the token (`@src/main.ts `, a space after).
   Picking a folder descends into it: the query becomes `folder/`, with a row at the top
   to mention the folder itself (the default taken; the user did not answer, open to change).
4. While typing, a token is plain `@path` text, coloured; in sent messages a chip: the
   file's name in a pill, tapping it opens the file with the viewer `file.read` already
   feeds (decided). A sent chip of a file in `SendReceipt.largeMentions` keeps the note.
5. The new-thread screen searches the chosen folder before the thread exists
   (`.folder(path)`, `agent:` the agent picked, so the note is that agent's) (decided).
6. Sent with `mentions` when the host lists `file_mentions`; with a host that does not,
   the text alone (Claude Code still reads it).

## 9. Codex's review (2026-10-26, gpt-6.1-sol at xhigh, read-only)

One review of `origin/main...n12/file-mentions` at `e2adeed6`, then one re-check of the
fixes. Every finding was checked here first: each has a test that fails on the code
before it (but one race, noted), in `bridge/test/file-search.test.ts`,
`bridge/test/file-mentions.test.ts` and `FileSearchWireTests.swift`.

| # | Finding (Codex's severity) | Real? | Fate |
|---|---|---|---|
| 1 | The walk could read through a folder swapped for a link between being seen and being read (high) | Yes, a race; names only, to the owner's own device | Fixed in `9f909c61`: a folder's entries are kept only when its real path after the read is the one expected. A window of one read stays: Node has no `fdopendir` |
| 1b | Re-check: the walk took the root's real path at its start, so a root swapped for a link before the walk adopted the link's target, and git ran in it (high) | Yes | Fixed in `fca64869`: the folder handed in is the real path checked (`files.search` now passes the real path of a named folder too), and a listing is kept only when the folder is still that path after |
| 2 | A search during a relisting of a watched folder dropped `refreshing` (medium) | Yes | Fixed in `32649e51`: a search during a relisting answers at once from the old listing with `refreshing` |
| 3 | The watcher ignored `.git/info/exclude` and a new file in a tracked `dist` (medium) | Yes | Fixed in `9f909c61`; the re-check's case (a `dist` git listed nothing in, holding only ignored files) in `fca64869`: such a change makes a git listing be made again within 10 s |
| 4 | A subfolder's or a linked worktree's index is outside the folder watched (medium) | Yes, for index-only changes (`git rm --cached`) | Fixed in `9f909c61`: that git folder is watched for `index` and `HEAD`; the re-check's cases (its `info/exclude`, `.gitignore` files above the folder, a worktree's common folder) in `fca64869`: such a listing is made again at a search once 30 s old. A git folder that cannot be watched leaves the listing fresh only as long as an unwatched one (2 s) |
| 5 | `checkMentions` turned `\` into `/`, so `a\b.txt` became `a/b.txt` (medium) | Yes | Fixed in `650cbd20` |
| 6 | `@note?copy` in the text hid a mention of `note` (medium) | Yes | Fixed in `650cbd20`: the bridge reads the text as Claude Code does (its parser, read from the CLI of `@anthropic-ai/claude-agent-sdk` 0.3.292: a bare `@path` only at a word's start, up to the word's last ASCII letter, digit or `_`; `@"path"` after the start or white space). This also showed that `(@a.ts)` is no mention to Claude Code, so the bridge writes such a mention again |
| 7 | PortalsKit's `FileMention` wrote `@report.md,` and read it back as `report.md` (medium) | Yes | Fixed in `650cbd20`: a path with white space or not ending on an ASCII letter, digit or `_` is written `@"path"`, by the bridge and PortalsKit alike, and `paths(in:)` reads as Claude Code does |
| 8 | 🚀 matched 😁🪀 (each half of a surrogate pair matched alone) (medium) | Yes | Fixed in `9f909c61`: a pair's halves match only together |
| 9 | `İstanbul.md` could not be found by `İstanbul`, and `Ü` in `İÜBER.md` was not folded (low) | Yes | Fixed in `9f909c61`: folded a character at a time where the whole string's small form is longer; `İ` folds to `i` |
| 10 | An untracked repository inside showed as a folder and a file with no name (low) | Yes (`git ls-files --others` lists it as `inner/`) | Fixed in `32649e51` |
| 11 | A relisting kept the last query's matches into the old listing, past the memory bound (low) | Yes | Fixed in `32649e51`; the re-check's overlap (a search finishing after its listing was replaced) in `fca64869`, by reading; no test, as it needs two events in one turn of the loop |
| 12 | `findGit("/usr/bin/")` returned macOS's stub (low) | Yes | Fixed in `32649e51`: a PATH folder that resolves to `/usr/bin`, or a git whose real path is the stub, is passed over |

What the fixes cost (`bridge/scripts/file-search-bench.ts ours`, the tree of 100,000 files
and this repository, before (`e2adeed6`) and after, interleaved, three runs each, middle
run, 15:43 to 15:48 at load 4.7 to 9.3, ms): tree through git, typing p50/p95 3.7/18.5
before and 5.3/29.8 after (the third, quietest round: 3.3/18.5 and 3.5/19.1); tree walked
3.3/18.3 and 3.5/19.9; repository 0.11/0.71 and 0.10/0.64. A CPU-only loop of 600 unrelated
queries on the walked tree, four runs each: 7.7 to 9.7 s before, 8.7 to 9.2 s after, about
10% more, from the surrogate check in the matcher. Still within the aim.

## 10. The decisions (2026-10-26)

the user answered section 8's questions on 2026-10-26 (away from the Mac; built the same
evening, unattended).

1. **The `@` menu opens only at the start of a word**, as Claude Code reads `@path`: an
   email address does not open it. Already the bridge's (`mentionedPaths`) and
   `FileMention.paths(in:)`'s rule; nothing changed. So a mention right after
   punctuation, `(@a.ts)`, does not come from the composer; the bridge still writes a
   mention sent whose token the text lacks as Claude Code reads it again at the end of
   the text (`withMentions`), kept as a safety net (an edited token, another app).
2. **In folders without git, `build`, `dist` and `target` stay skipped.** Nothing changed
   (section 2).
3. **Large files: "Yes, a small note".** Claude Code's limit found and bracketed (section
   3: 262,144 bytes and 25,000 tokens; over the tokens a file is left out without a word).
   Built: a file hit's `size` and `mention_limit` in `files.search`'s answer for an agent
   that reads mentions in itself (Claude Code only: `Provider.mentionLimit`; Codex,
   Cursor and the rest get none, their models read with their tools), `large_mentions`
   in `prompt.submit`'s; in PortalsKit `FileSearchHit.size`,
   `FileSearchResults.mentionLimit` and `fit(of:)`, `FileMentionLimit.fit(size:)`,
   `FileMentionFit.note`, `SendReceipt.largeMentions`. The note starts at 60,000 bytes
   (`note_bytes`); a file over 262,144 is certain not to be read in. Additive within
   `file_search` and `file_mentions` (no released bridge has them yet, so no new feature).
4. **The new-thread screen searches the chosen folder before the thread exists: "Yes".**
   The bridge already took `folder`; PortalsKit's `searchFiles(_, in: .folder(path),
   limit:, agent:)` now names the agent the new thread will run (`profile` on the wire), so
   its note is that agent's.
5. **The mention's look**: coloured `@path` text while typing; in sent messages a chip,
   the file's name in a pill, tapping it opens the file. Recorded in section 8 for the
   screens.
6. **Picking a folder in the `@` menu**: not answered. The default taken: it descends into
   the folder (the query becomes `folder/`), with a row at the top to mention the folder
   itself. Open to change; one line of the composer.

## 11. Codex's review of the decisions' pass (2026-10-26, gpt-6.1-sol at xhigh, read-only)

One review of `7cccdfc8..51a28aa9` (this pass), then one re-check of the fixes
(`51a28aa9..52eb10f4`). Each finding was checked here first; the fixed ones have a test
that fails on the code before.

| # | Finding (Codex's severity) | Real? | Fate |
|---|---|---|---|
| 1 | A PDF over 262,144 bytes was called `unread`, but Claude Code reads PDFs its own way (medium) | Yes (its size check skips the `pdf` extension) | Fixed in `b292c036`, `9a5e716f`: no note on a PDF, on the bridge and in PortalsKit |
| 1b | Re-check: a file named `.pdf` was taken for a PDF; to Claude Code (Node's `extname`) it has no extension (low) | Yes | Fixed in `e46556b6` |
| 2 | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` was read unlike Claude Code (`5_000`, `0x10000`) (low) | Yes (Claude Code's `int` setting: trimmed, e-notation when whole, thousands separators, else `parseInt`) | Fixed in `b292c036`: read as it reads it |
| 3 | A file hit reached through a folder swapped for a link after the listing got the size of a file outside (low) | Yes | Fixed in `b292c036`: a size only when the hit's real path is its path |
| 3b | Re-check: a swap back between the `lstat` and the `realpath` still passes (low) | Yes, a race | Not fixed: the same window of one call the walk keeps (Node has no `openat`), and what leaks is a size, to the owner's own device |
| 4 | A token limit past an `Int` (`1e100`) made PortalsKit drop `mention_limit` (low) | Yes | Fixed in `b292c036`, `9a5e716f`: the bridge says at most 1,000,000,000, and PortalsKit reads a larger one as `Int.max` |

## 12. The app (run n14, 2026-10-27)

2026-10-27: "build @mentions". Branch `n14/mentions`, from `main` at `351cdafc`.
Section 8 as decided; where it left a look open, the plainest was taken, and each is
listed below to be changed.

| Part | Where | What |
|---|---|---|
| Typing | `AgentCore/MentionTyping.swift` (`MentionQuery`, `MentionEdit`, `MentionRow`, `FileMentionDraft`), `FileMention.mentions(in:)` | Where an `@` being typed is (at a word's start, after white space or CJK punctuation, as Claude Code reads one; `@"` for a path with a space), what a pick writes (the token and a space; a folder gone into as `folder/`, or `@"my folder/`), the folder row, the picked mentions the text still names |
| Search | `FileMentionSearch` (same file) | One query at a time: an older query's late answer is dropped, a `refreshing` one is asked again after half a second, an answered query is not asked twice |
| The menu | `Portals/Chat/MentionMenu.swift` (`ComposerMentions`, `MentionMenu`) | Above the composer, in the slash commands' menu's place and glass; the thread's folder, or before a new thread exists the folder chosen for it with the agent picked (`ThreadController.mentionScope`, `searchFiles`); only where the host lists `file_search` |
| Keys | `ChatComposer`, `MenuEscapeKey` | Arrows, Return and Tab pick, Escape closes, on a Mac and an iPad. A Mac's field takes Return and Tab itself: the line break or tab it puts in is taken back out and the row picked (`ComposerText.isTyped`); it takes Escape and lets go of the focus, so while the menu is open a key command that comes first is added to the composer's view controller |
| Tokens while typing | `ComposerTokens` | The picked tokens in blue, drawn by the field's text view (TextKit 2 rendering attributes): SwiftUI's field takes a string, and set its text's attributes again over any put in it |
| Sending | `ThreadController.send(…, mentions:)`, `ComposerDraft.mentions`, `SavedSubmission.mentions` | The picked paths the text still names (`FileMentionDraft.mentions`), to a host that lists `file_mentions` (`FileMentionSending`), the text alone to any other; kept for "Try again" with the saved message, and once the host took it by message while the app runs (`SentMentions`, `SentMentionsMemory`) |
| Chips | `SelectablePlainText.chipsMentions`, `ProseMention`, `UserBubble` | Each `@path` of a message of yours (from history too: read from its text) is the file's name in a pill, which a tap opens in the file viewer and which copies as the `@path`; only where the host reads the thread's files. A file `prompt.submit` named in `large_mentions` has its note under that message (`SentMentionsMemory`, by message) |

Choices made here, each open to change:

- **Colour while typing**: the system's blue (the app's tint is the text's own colour). On
  a Mac a token has no red underline (2026-10-27, `plan.md` underlined): Catalyst's
  text checker marks a misspelled word on the text and as a TextKit 2 rendering attribute
  (`NSSpellingState`), some time after it is typed and with no word of it, so the marks
  inside tokens are taken off then and every half second while the field is typed in and
  holds a token (`ComposerTokens.unmarkSpelling`); the rest of the text is checked as before.
- **Chip**: the name in medium weight on a pill a shade darker than the bubble
  (`secondarySystemFill`), no symbol; a chip of a folder is a pill too, and a tap on it
  opens the viewer on the bridge's word ("docs is not a file.").
- **Note on a sent large file**: a caption line under the bubble, "name: note", as the
  bubble's other lines ("Sent as guidance"); not inside the pill.
- **Rows**: one line, about 6 on a phone and 8 on a Mac or a wide iPad, more by
  scrolling (50 asked for); 8 and 12 until 2026-10-28, when the user asked for fewer and
  for less room above and below each (36 points high, 32 on a Mac; they were 40); a large file's note on a second line, cut to one line; a folder
  has a chevron; the folder gone into is "name  This folder" at the top.
- **The row a keyboard picks** is marked on a Mac and an iPad only: a phone's Return
  starts a new line.
- **Nothing matched**: "No files match" in the menu; a refusal says the host's sentence.
- **Escape** keeps the menu closed until the caret leaves that `@`; the composer losing
  its focus closes it until it is typed in again.
- **A token picked, the caret back at its end** (the space after it deleted) does not open
  the menu again for that path.
- **Which mentions go**: those picked from the menu and still in the text. An `@path`
  typed by hand is the text's alone (Claude Code still reads it), and so is a draft's after
  a relaunch: the picked list is kept with the draft's images, in memory (a thread whose
  composer holds some is not let go of as others are opened).
- **The note on a sent chip** is known for messages sent from this device while the app
  runs (`large_mentions` is the send's answer); a message from history, or after a
  relaunch, has its chip without the note.
- **Which `@` tokens are chips** (2026-10-27, having seen "ask @claude" made one):
  a path-like one, with a `/` or an extension (`FileMention.isPathLike`: something before
  the last dot and after it letters or digits with a letter among them, so `plan.md`,
  `main.c`, `src/main` and `@"my folder/note.txt"`, not `claude`, `v1.2`, `3.14` or `.env`),
  in history too; and one picked from the menu whatever its shape (`@docs`, `@Makefile`),
  for the message it was sent with while the app runs (`SentMentionsMemory`).

Checked: `swift test` (`MentionTypingTests`, `FileMentionSearchTests`,
`ComposerTextTests`), and the app against a scratch bridge from this worktree with the
scripted agent standing in for Claude Code's mention limit. On a Mac, by hand: the menu at
`@` on the new-thread screen and in a thread, a query, a folder gone into, a quoted folder,
the arrows, Return, Tab and Escape, the coloured tokens, the bridge given `mentions`, the
chips, a chip opened, the notes in the menu and under a sent message. In an iPhone and an
iPad simulator (`scripts/phone-bench/uitest/UITests/MentionsUITests.swift`): by touch the
menu at `@`, a query, a pick, a folder gone into and its own row, a large file's note, the
message sent with its `mentions`, its chips and the note under it, a chip opened; on the
iPad the arrows and Tab too. Return and Escape on an iPad were not: XCUITest's
`typeKey` gives the app neither there (the composer's own Return, which sends with a
keyboard attached, does not send that way either), so they want an iPad with a keyboard.

## 13. Codex's review (2026-10-27, gpt-6.1-sol at xhigh, read-only)

One review of `351cdafc..8181274d` (run n14's app pass). Each finding was checked here
first; those whose code is PortalsKit's have a test that fails on the code before it.

| # | Finding (Codex's severity) | Real? | Fate |
|---|---|---|---|
| 1 | "Try again" on a message the host had taken sent it without its mentions: its saved copy, which held them, is let go once taken (medium) | Yes | Fixed in `bba80869`: `SentMentions` keeps them by message while the app runs (`SentMentionsTests`) |
| 2 | A refused query kept the older query's rows on screen, to be picked into it, and hid the refusal (medium) | Yes | Fixed in `ce5ad3ac`: `FileMentionSearch.shown(for:)`, none for a refused query (`aRefusedQueryShowsItsRefusalNotAnOlderQuerysRows`; before, the rule was the app's, by folder alone) |
| 3 | A pick with the caret inside a quoted path stopped at its first space and left the rest behind (medium) | Yes | Fixed in `06d16ea0`: to the closing quote on the line |
| 4 | `@"my @notes.md"` drew three chips, the middle one opening notes.md (medium) | Yes | Fixed in `048979f2`: `FileMention.tokens(in:)`, each token as written once, for chips and colour; `paths(in:)` keeps the inner mention, as Claude Code and the bridge read it |
| 5 | On a Mac a tab pasted or put back by Undo with the menu open picked a row (medium) | Yes | Fixed in `d0bde22a`: `Platform.handlesPlainTab`, AppKit's event in hand, as for Return. No unit test (AppKit's current event); a real Tab checked again on the Mac |
| 6 | The menu's arrows, Tab and Escape took keys from a word being composed (Chinese, Japanese) (medium, Codex unsure of the native routing) | Yes, by reading | Fixed in `7375c99c`: the menu closes while there is marked text and its keys pass. Not run with an input method |
| 7 | A note was kept by path, so a later message mentioning the file changed an earlier one's (low) | Yes | Fixed in `bba80869` with 1: by message (`SentMentionsTests`) |

Then one re-check of the fixes (`8181274d..7375c99c`):

| # | Finding (Codex's severity) | Real? | Fate |
|---|---|---|---|
| 1b | What a message was sent with was kept by its thread's controller, which is let go of as other threads are opened (medium) | Yes | Fixed in `970f515a`: `SentMentionsMemory`, for every thread while the app runs; and a thread whose composer holds picked files is not let go of, as one holding images or files is not |
| 5b | With no key event in hand, the Tab check fell back on no modifier being held (medium, Codex unsure the case arises) | Yes, by reading | Fixed in `a3a3b91b`: only a Tab key in hand picks |
| 6b | An input method can give its word without the text or the caret changing, and the menu, closed while composing, did not look again (medium, Codex unsure) | Yes, by reading | Fixed in `1299b0fa`: looked at again every 0.3 s while a word is composed at an `@`. Not run with an input method |

