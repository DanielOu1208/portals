# Speed pass, 2026-10-30 (`n18/speed`)

Taken on 2026-10-30, 03:30 to 06:30 PDT, on branch `n18/speed` from `n18/bughunt` at
80a24d49 (every fix of bug hunt round 4 and PR #19). The ask: measure first; fix the
clear wins directly (a measured improvement, low risk, nothing a person notices but the
speed); propose the rest. This is the first pass on the **Mac mini** (Mac16,10, Apple M4,
10 cores, 16 GB, macOS 26.6 (25G72), a 60 Hz display, Node v24.14.1, Swift 6.4): every
earlier perf doc was taken on the MacBook Pro (M4 Pro, 120 Hz), so this page sets its
numbers beside theirs only where the machine cannot be what differs, and builds an older
commit on the mini where it might be (tab switching, below).

## In short

- **The bridge is in good shape for what people feel.** A 120-turn thread (2.5 MB) opens
  in 16-17 ms of the bridge's time; its pages (`history_pages`) take 5 ms for 30 turns. A
  real 40 MB Claude Code session loads in 48-63 ms with the event loop never held over
  9 ms. `thread.search` goes through this Mac's 517 MB of real Claude Code and Codex files
  in about 1.4 s, the loop held at most 20 ms. Turns, marks, connects and catch-ups
  measure as the baseline's "after" columns did, a little slower on this Mac.
  Nothing there was a clear win.
- **The heaviest thing found is what a Codex thread with big tool results sends.** A real
  14-turn Codex thread is an **11.4 MB** `session.resume` answer, 9.4 MB of it tool
  results and 2 MB tool arguments (base64 pictures in diffs), where the app keeps at most
  20,000 characters of any one (`HermesToolDisplay.textLimit`). Cut there it would be
  4.8 MB; another thread goes from 3.6 to 1.35 MB. That needs the wire: proposal 5.
- **PortalsKit**: a reply streamed into a thread costs `ThreadState` 0.3 µs a piece,
  however long the thread; the 120-turn thread's frame parses in 35.6 ms and becomes a
  transcript in 11 ms (off the main thread); its saved copy takes 12.4 ms to make and
  14.8 to read, which the app does **on the main thread** at each send and turn's end
  (proposal 4). Neither the date format nor sorted keys is what that costs.
- **The app**, Release builds with the launch switches: a reply streamed into the thread
  on screen costs the iPhone simulator app 12.99 CPU s; a tab switch on the Mac 190 ms of
  CPU, drawn in 57 ms; at rest with twelve tabs 0.10% of a core and 0.6 wakeups a second,
  as night n10 measured.
- **Tab switches cost more CPU than at night n11**, on this Mac, built from 042d197c and
  run against the head: going back to a tab 141.5 → 170 ms of CPU (+20%), first visits
  183 → 232 (+27%), mixed switches 163 → 190 (+16%), though mixed switches draw 35% sooner
  (nine chats kept, the choice of 2026-10-26). Half of it is the nine kept chats
  (3 to 4 ms a switch each: they are not inert), half came with the merges since
  2026-10-25. Found, not fixed: proposals 3 and 6.
- **Fixed** (three commits, nothing a person of a Release build sees): the development
  builds every bench runs read their launch environment once instead of at every update
  (a reply 12.99 → 12.44 CPU s on the simulator, a tab switch 190.3 → 186.5 ms on the
  Mac); tabs-bench refuses to measure a copy left running at its path (which gave this
  pass a false "1.78% at rest" for an hour); OpenBenchmarksWire times the saved copy.
- **Not measured here**: anything on a phone or iPad itself (heat, battery, the GPU), the
  Mac's scroll benches (not run: they scroll with cua-driver, which cannot click or type
  in a Catalyst copy on this Mac; its wheel was not tried), a real network, and Hermes,
  Pi, Cursor and Droid threads' loads.

## How it was measured

Every bench is the repository's own, run as its header says, on scratch copies and
scratch bridges with their own homes and ports (9583, 9581-9582, 9851, 9853, 9855); the
installed app and the installed bridge (port 9120) were not touched. Each number is the
median of three runs or more, with the range in brackets where the runs differ by more
than a tenth; the load average is beside each. Other agents' threads ran on the mini
meanwhile (load 1.5 to 4.5, once 115 while a simulator booted: those runs are marked).

- **Bridge**: `node scripts/bench.ts --only turns,marks,loads,resume,connect --sizes
  1000,5000` three times (03:32-03:37), `open.ts seed` and `open.ts fetch` on a scratch
  bridge for session.resume, and a CPU profile of a 5000-thread bridge through 100 turns
  (`NODE_OPTIONS=--cpu-prof`). "By hand" below is a script outside the repository, as in
  the baseline notes: Claude Code's `getSessionMessages` and `listSessions` and the
  bridge's `historyFromSession` on a copy of the longest session on this Mac (40 MB, in a
  scratch `CLAUDE_CONFIG_DIR`); `ThreadSearch` over this Mac's own Claude
  Code and Codex files, read only; `codex app-server` on a scratch `CODEX_HOME` holding
  copies of the two longest rollouts and Codex's databases, read with `thread/read` as the
  bridge reads it; `session.resume` with `limit` and `session.history` back to the start.
  Each took a 1 ms timer's longest gap as how long the event loop was held.
- **PortalsKit**: `PORTALS_BENCH=1 PORTALS_OPEN_FRAME=<t120 answer> swift test -c release
  -Xswiftc -enable-testing --no-parallel --filter OpenBenchmarksWire`, three times, on the
  120-turn answer saved from the scratch bridge (`BENCH_SAVE`); a scratch test beside it
  for `ThreadState` streaming and the saved copy's encoder settings (not kept).
- **App**: Release builds with the switches (`SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`,
  `ARCHS=arm64`). The iPhone: a new "iPhone Duo" simulator (iOS 27.1),
  `scripts/phone-bench/reply-cost.sh` (a reply streamed into the 45-turn thread on screen
  and two others) and `trace.sh stream` (Time Profiler). The Mac:
  `scripts/tabs-bench.sh --only tabs,tabsreturn,turns,renames,restore,idle,sidebar` (no
  `scroll`: it moves the wheel with cua-driver), three rounds, and `--profile` once.
  Opening threads: `scripts/open-bench.sh --sim` on the same simulator, three rounds
  (the head with the fix, a33aec45).

## The bridge

### Turns, marks, loads, catch-ups and connects (the harness)

Three runs, 03:32-03:37, loads 4.4, 2.6 and 1.5. Bytes a record 558 (the harness's
scratch folder here is shorter than the baseline's 668).

| Threads | ms in writes a turn | longest write, ms | bridge CPU a turn, ms | turns a second | ping 99th / longest, ms |
|---|---:|---:|---:|---:|---:|
| 1000 | 5.84 (2.49-6.98) | 5.7 (1.5-9.8) | 15.1 (7.1-17.0) | 31.9 | 7.0 / 10.7 (2.0-13.8) |
| 5000 | 6.55 | 32.7 (10.1-34.9) | 32.6 (31.1-36.5) | 33.1 | 12.0 / 26.6 (19.3-65.6) |

the baseline's "after", on the MBP16: 2.16 and 3.49 ms in writes a turn, 10.4
and 17.9 ms of CPU a turn. The same files are written (1.6 MB and 8.2 MB a turn), so the
difference is this Mac and its load (the 1000-thread runs went from 17 to 7 ms of CPU as
the load fell from 4.4 to 1.5). A CPU profile of the 5000-thread bridge over 100 turns:
4 ms a turn in `writeBytes` (three saves of `threads.json`), 2 ms making its bytes
(`Registry.bytes`, joining 5000 kept records), 2 ms collecting garbage, the rest the
WebSocket's deflate and the turn itself. That is the baseline's proposal 11
("the bridge writes `threads.json` less"), not new.

- marks (1000 threads): a pin, archive, rename or remove 1.05-2.37 ms a call.
- loads: 1000 threads read through `thread.read`, 0.098 ms a load, 0.216 ms a read; 73 MB
  more resident and none of it given back (proposal 9 of the baseline, unchanged).
- resume: a reconnect while a turn runs, 2.55 ms and 3.6 KB with `resume_replay` (19.2 ms
  and 166 KB without); back at the front 2.32 ms and 3 KB.
- connect: a later connect 21 ms until quiet with 1000 threads and 24 ms with 5000;
  `folders.list` 6.9 and 10.3 ms of it (3.3 and 4.4 at the first connect).

### Opening a thread, and its pages

The 120-turn thread of `open.ts seed` (2,040 messages, 2.5 MB) and the 45-turn one
(765 messages, 0.96 MB), `open.ts fetch` 7 times, three runs at 03:35 (load 2.3):
**16-17 ms** and **7 ms** from the call to the whole answer parsed.

Paged (`session.resume` with `limit`, then `session.history` back to its start), three
runs (load 2.8, a build running):

| | whole | first page, 30 turns | each page after, 30 turns | 10 turns a page |
|---|---:|---:|---:|---:|
| ms | 16.8-27.6 | 4.9-5.8 | 4.6-4.9 (longest 6.9) | 1.7-1.8 |
| KB | 2,557 | 640 | 639 | 213 |

A page costs what its turns weigh; the conversation is in memory once the thread is
loaded. Today only a Hermes Bot Chat is opened in pages (`HermesBackend`, `binding.paged`):
proposal 8.

### Loading a long Claude Code thread, and listing Claude's sessions (by hand)

The longest Claude Code session on this Mac, copied into a scratch `CLAUDE_CONFIG_DIR`,
three rounds:

| Session | file | messages kept | `getSessionMessages`, ms | loop held at most, ms | `historyFromSession`, ms | answer |
|---|---:|---:|---:|---:|---:|---:|
| n14-mentions | 40 MB | 844 of 1,621 | 47.4-62.5 | 3.2-9.3 | 1.7-2.8 | 1.4 MB |

(`getSessionMessages` gives 1,621 entries of the file's 2,398 lines, and the bridge's
history keeps 844 messages, 1.4 MB as sent: most of the 40 MB never reaches a device.)
`listSessions()` over this Mac's 449 MB of sessions: 10.6-16.5 ms, the loop held at most
7.9 ms; with a limit of 40 and no SDK sessions (`desk.list`): 2.1-3.4 ms.

### A long Codex thread (by hand)

`codex app-server` 0.163.0 on a scratch `CODEX_HOME`, `thread/read` with its turns, three
rounds each:

| Thread | rollout | answer from Codex | Codex's time, ms | parsed, ms | `historyFromThread`, ms | session.resume answer | made into text, ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| 01a160fd (19 turns) | 34 MB | 4.2 MB | 50-206 | 4.4-5.6 | 3.1-4.5 | 3.6 MB | 3.3-4.4 |
| 01a18099 (14 turns) | 21 MB | 10.6 MB | 208-268 | 7.7-8.2 | 6.7-13.7 | **11.4 MB** | 8.6-11.1 |

The bridge's own share is small (under 35 ms, each step on its own); Codex's read is most
of the wait. What weighs is the answer: of 01a18099's 11.4 MB, 9.4 MB is tool results
(`content`) and 2.0 MB tool arguments; the largest result is 1.16 MB, and three are
diffs of base64 pictures (0.79 MB together). Every byte goes to the phone, which keeps
20,000 characters of each (`HermesToolDisplay.textLimit`). Each `content` and `args` cut
at 20,000 characters would make the answer 4.84 MB (01a160fd: 1.35 MB). At the app's
35.6 ms of parsing for 2.5 MB (below), 11.4 MB is about 160 ms of parsing on this Mac
before anything is laid out, more on a phone, and seconds over a slow network.

### Search (by hand)

`ThreadSearch` as `thread.search` runs it, over every Claude Code session (not the
subagents') and Codex rollout on this Mac, read only: 142 threads, 517 MB, page after page
to the end, three rounds each.

| Query | pages | threads found | all pages, ms | loop held at most, ms |
|---|---:|---:|---:|---:|
| `zeppelin` (nowhere) | 2 | 0 | 1,361-1,609 | 19.7-21.1 |
| `relay` (common) | 2 | 38 | 1,430-1,452 | 20.2-21.1 |

docs/plans/2026-10-26-thread-search.md measured the scan at most 5-15 ms a hold on its
corpora. On these files a hold reached 13-20 ms six times in one search, every time in
one of two Claude Code sessions with long lines: the scan's slice is 10 ms and it looks
at the clock every 32 lines or once a 1 MB chunk, so a slice can run on by a chunk's
worth of long lines (proposal 2).

### What else was looked at

- **Sync work on hot paths**: the `*Sync` calls of `src/` (setup's aside) were listed and
  those on paths a device or a turn reaches were read. The
  registry's saves (above), `noteRepos` at start (0.17 s for 5000 threads, in batches of
  100), Droid's store (B9 of PR #19 already keeps its mapping by size and time), the
  waiting messages' and kept diffs' small files, and `folders.list`'s look at a few dozen
  folders: none holds the loop for long on a list of a few thousand threads.
- **`thread.read` and session loads** are the harness's `loads` (above).

## PortalsKit

`OpenBenchmarksWire` on the 120-turn answer (2.5 MB), release build, three runs at 05:26
(load 2.3), five rounds each:

| Frame parsed | Read as a resume | Tools' results parsed | Made a transcript | Saved copy made | Saved copy read | Saved copy |
|---:|---:|---:|---:|---:|---:|---:|
| 35.6 ms | 0.2 ms | 7.7 ms | 11.0-11.1 ms | 12.2-12.4 ms | 14.7-14.9 ms | 2,380 kB |

docs/perf-open.md had 28 ms for parsing 2.3 MB on the MBP16: the same parser, a little
slower here. The first four steps run on the backend's actor; the saved copy is made on
the main thread (`ThreadStore.saveTranscript`, from `HostModel.persist`) at each message
sent (twice: when it is put in and when the host answers), at each turn's end, and for
every open thread as the app leaves the screen. A copy the store wrote last is not
written again, but each of these changes it.

Tried for the saved copy, in the scratch test: without sorted keys 12.18 ms, dates as
Foundation's default 12.42, dates through `Date.ISO8601FormatStyle` 12.66 (the same
bytes), against 12.64 as it is; reading with the format style 15.05 against 15.21. The
cost is Codable's own, so no setting buys it back: moving it off the main thread is
proposal 4.

`ThreadState` with a reply streamed into it, 2,000 pieces after a `turnStarted`:
0.3 µs a piece into an empty thread and into the 120-turn one, 0.4 µs with a copy of the
state held between pieces (as a view holds one). Nothing grows with the thread.

## The app

### A reply streaming, iPhone simulator

`reply-cost.sh`, the fake agent's minute-long reply into the 45-turn thread on screen and
two others at once, CPU seconds over the reply:

| | CPU s a reply | main thread s |
|---|---:|---:|
| head (80a24d49), alone, 03:43-03:49 (load 115 at the start, as the simulator booted; 3.9 at the end) | 12.96 (12.6-13.3) | 11.06 |
| head, A/B with the fix, 05:14-05:24 (load 2.5-3.8) | 12.99 (12.9-13.0) | 11.21 |
| with the fix (a33aec45) | **12.44** (12.1-12.9) | **10.70** |

docs/perf-phone.md had 11.57 s after `PiecePacer` on the MBP16's iPhone 18 Pro Max
simulator; this is another Mac and another simulator. A Time Profiler recording of the
same state (10 s, three threads streaming, 2,068 samples): the reply's text views
(`ProseTextView.show`, 113), the reply's Markdown (`ParsedReply.blocks`, 98; already
incremental, `MarkdownStream`), the launch switches read from the environment
(`DebugLaunch.value`, 38, which a33aec45 takes away), `ChatScreen.body` (39), the frame
parsed (16). Nothing else of the app's above 1%.

### Tabs, the sidebar, turns and the launch on the Mac

`tabs-bench.sh --rounds 3 --only tabs,tabsreturn,turns,renames,restore,idle,sidebar`,
head at 80a24d49, 600 threads, 04:44-05:01 (load 1.5-2.8):

| | |
|---|---:|
| Mixed switches: drawn / content, ms | 57.2 / 55.0 |
| Mixed switches: CPU a switch, ms | 190.8 (189.4-194.9) |
| Mixed switches: missed frames, ms a second / longest frame, ms | 151.4 / 126 |
| Going back to a tab shown a moment ago: drawn / content, ms | 57.0 / 55.0 |
| Going back: CPU a switch, ms | 172.1 (169.8-174.7) |
| ⌘S ten times: main thread until the next frame, ms / CPU a toggle, ms | 87.8 / 238.4 |
| Turns / titles from another device: missed frames, ms a second | 23.6 / 16.7 |
| Launch with the tab put back: chat shown / drawn, ms | 184.5 / 474.1 |
| At rest, twelve tabs: CPU %, wakeups a second (interrupt) | 0.10, 0.6 (1.6) |
| Three turns running in tabs not on screen / window covered: CPU % | 0.31 / 0.13 |
| Footprint at rest after a relaunch, MB | 68.6 |

**Against night n11, on this Mac.** docs/perf-tabs.md's final A/B was taken on the
MBP16 at 120 Hz, so the main of 2026-10-25 with n11's tab speed in it (042d197c, the
merge of pull request #12) was built here the same way and run against the head,
interleaved, three rounds each (05:30-05:43, load 1.5-3.4); then the head with its nine
chats kept behind the one on screen against the head with four, as 042d197c keeps
(`PORTALS_DEBUG_KEPT_CHATS=4`; 05:44-05:57, load 1.8-2.5):

| | 042d197c (4 kept) | head, 4 kept | head (9 kept) |
|---|---:|---:|---:|
| Mixed switches: drawn / content, ms | 79.0 / 86 | 85.1 / 89 | **52.8 / 52** |
| Mixed: CPU a switch, ms | 163.3 (162.5-167.9) | 188.6 | 189.4-191.5 |
| Mixed: missed frames, ms a second | 108.2 | 149.6 | 145.8-146.2 |
| Going back: drawn / content, ms | 51.0 / 50 | 50.0 / 49 | 55.1-55.5 / 54-55 |
| Going back: CPU a switch, ms | **141.5** (141.4-143.2) | 155.3 (153.2-155.4) | 169.9-172.0 |
| Going back: missed frames, ms a second | 79.7 | 110.2 | 130.4-130.5 |
| First visits: drawn / content, ms | 84.5 / 87 | 89.8 / 93 | 94.8-95.2 / 97-100 |
| First visits: CPU a switch, ms | **183.3** (182.1-184.3) | 212.7 (209.9-212.9) | 232.3-232.9 |
| Footprint after the switches, MB | 106.1 | 114.5 | 150.5-150.8 |

(The head's two columns are from two A/Bs; where both measured it, the range of the two
medians is given.) Keeping nine chats built makes mixed switches draw 35% sooner, as
chosen on 2026-10-26, but **every switch now costs more CPU than at n11**: going back
141.5 → 170 ms (+20%), first visits 183 → 232 ms (+27%), mixed 163 → 190 ms (+16%), and
the missed frames a second rise with it. About half is the kept chats themselves: four
against nine on the same build is 15 to 20 ms a switch, 3 to 4 ms for each chat kept out
of sight, so a kept chat is not inert when another is shown. The other half (14 to 30 ms
a switch, four chats kept either way) came with what was merged between 2026-10-25 and
2026-10-30. Neither was found tonight: proposals 3 and 6.

The burst after a switch: a Time Profiler recording of the returns has the main thread
busy for 49 ms in the 50 ms after each switch, then 70 ms more between 300 and 400 ms
after it, nearly all of it SwiftUI's graph (`GraphHost.flushTransactions`, the app's own
views 3 to 4 ms of it): the end of the tab strip's animation, as night n11 found ("then
82 ms over the animation").

**A false regression, and the bench's fix.** The first three rounds of this pass read the
app at rest at 1.78% of a core and 73 wakeups a second, with turns running 4.92%, and
from the second round a tab switch at 1.1 ms of CPU. None of it was the app: a bench I
had stopped part way left its copy running at the same path, and the bench finds its
copy with `pgrep -f <path> | head -1`, so it read that one. Each phase run alone, and the
whole bench again once the copy was gone, read 0.10% and 0.6 wakeups. tabs-bench now
refuses to launch while a copy runs at its path (9f61f7fa). `mac-scroll-bench.sh`,
`stream-bench.sh`, `sidebar-bench.sh`, `open-bench.sh` (and its `shots.sh`, `follow.sh`,
`profile.sh`) and `wash-bench.sh` find their copy the same way (proposal 1).

### Opening a thread, iPhone simulator

`open-bench.sh --sim --rounds 3`, a33aec45, 05:58-06:03 (load 1.9-2.5): every opening's
first frame at the end of the chat, and no frame moved after it, in all 72. Medians, set
beside docs/perf-open.md's build as committed (91e1e8e, an iPhone 18 Pro Max simulator on
the MBP16, two rounds):

| Case | first frame shown, ms | then (91e1e8e) | saved copy read, ms | host's copy fetched / read, ms |
|---|---:|---:|---:|---:|
| warm, 45 turns | 192 | 258 | | |
| warm, 120 turns | 192 | 248 | | |
| saved copy, 45 | 195 | 262 | 19 | 174 / 35 |
| saved copy, 120 | 239 | 279 | 39 | 267 / 79 |
| after a relaunch, 45 | 217 | 278 | 20 | 190 / 35 |
| after a relaunch, 120 | 333 | 426 | 27 | 353 / 87 |
| cold, 1 turn | 333 | 326 | | 114 / 9 |
| cold, 10 | 245 | 238 | | 90 / 9 |
| cold, 45 | 280 | 374 | | 105 / 34 |
| cold, 120 | 358 | 386 | | 164 / 86 |
| cold, very long last reply | 195 | 200 | | 55 / 3 |
| cold, approval waiting | 246 | 250 | | 55 / 9 |
| cold, turn running | 238 | 250 | | 89 / 10 |
| cold, short (9 a run) | 117 | 104 | | 71 / 4 |

Nothing has slowed down since night n4; the long threads opened from memory or a saved
copy are shown 40 to 90 ms sooner (another Mac and another simulator, so read the size,
not the digits). Each cold opening has one "lag" (a layout after the first frame shown
that left the chat short of its end, which no frame showed: `moves` 0); the probe counts
those since 2026-10-22, after docs/perf-open.md's tables. The 120-turn thread's host copy
takes 79 to 87 ms to read on the backend's actor, as OpenBenchmarksWire's 35.6 + 7.7 + 11
ms on this Mac would have it on a simulator.

## What was fixed

| Commit | What | Before → after |
|---|---|---|
| a33aec45 | A development build reads its launch environment once (`DebugLaunch.environment`): `ProcessInfo.environment` made a dictionary of every variable at each switch read, which `ChatScreen`'s body and others do at every update. Release builds read no switch and are unchanged | A reply on the simulator: 12.99 → **12.44** CPU s, main thread 11.21 → 10.70 s (4 replies each, interleaved). A tab switch on the Mac: 190.3 → 186.5 ms of CPU, going back 173.8 → 170.7 (3 rounds each, interleaved; frames the same). `DebugLaunch.value` was 2.0% of the main thread's samples over the switches, 1.8% of all the app's samples while a reply streams |
| 9f61f7fa | tabs-bench refuses to launch a copy while one runs at the same path | A leftover copy read as 1.78% at rest, 73 wakeups a second; the copy launched rests at 0.10%, 0.6 |
| fdf43a9f | `OpenBenchmarksWire` also times the saved copy made and read as `ThreadStore` does | 12.4 / 14.8 ms for 2.4 MB, now repeatable |

Why none can change what a person sees: the first is compiled only into development
builds on a simulator or a Mac (`#if DEBUG && (simulator || macCatalyst)`), where nothing
sets a variable after launch (no `setenv` in the app); `SidebarProbe` and `RowProbe`
already read the environment once the same way. The other two are a bench and a test.

## Proposals

Ranked by gain against risk, the cheapest first. None is built.

| | What | Gains | Risk / what a person would see | To build |
|---|---|---|---|---|
| 1 | The other Mac benches refuse a copy already running at their path, as tabs-bench now does | Numbers that are the copy's own | None | Five lines in each of seven scripts |
| 2 | `thread.search` gives the loop its turn more often in long lines: the clock looked at every 8 lines, or the slice 5 ms | The longest hold while a search runs 20 ms → about 10 on this Mac's files | A search a little slower to its end (more turns of the loop); nothing else | Small |
| 3 | Find what each chat kept out of sight does when another tab is shown, as night n11 found the swipe guard's closure (a Time Profiler of `tabsreturn` with 4 against 9 kept, the kept chats' bodies counted with signposts) | 3 to 4 ms of CPU a switch for each kept chat: 15 to 20 ms of every switch with nine | None if the kept chats still show what they showed | Small to find, if signposts show it; the fix as n11's |
| 4 | The saved copy made off the main thread: encode on a serial queue, write there, and let a thread go only once its write is done | 12.4 ms of the main thread for a 120-turn thread at each send (twice), each turn's end, and for every open thread as the app leaves the screen; more on a phone | Medium: `persist` answers whether the copy is on disk, which letting a thread go and the recovery journal rely on; the order of writes must hold | Medium |
| 5 | Tool results and arguments in a thread's history cut where the app cuts them (20,000 characters), the whole length sent beside them so "… (N more characters)" stays right; a feature, as `history_pages` is | A long Codex thread 11.4 → 4.8 MB to send, parse and keep (3.6 → 1.35 for another); Claude Code's not measured (its history is 1.4 MB for the 40 MB session) | The wire; the app shows the same, given the count. Whatever reads the whole result from history (copy output?) would need it fetched | Medium |
| 6 | Bisect the rest of the switch's growth since 042d197c (255 commits touch the app between it and 80a24d49: about 8 builds, tabs-bench `--only tabsreturn,tabsfar --rounds 2` at each) | 14 to 30 ms of CPU a switch | Depends on what it is | About four hours of building and benching on this Mac |
| 7 | A parser for `JSONValue` from bytes (docs/perf-open.md's proposal) | 35.6 ms of 2.5 MB parsed, likely several times less, on every frame, streaming too | Odd texts read differently (the baseline's proposal 14 was built and taken out for three of them); needs a corpus of frames to compare | Medium to large |
| 8 | Every thread opened in pages (`history_pages` with `limit`), earlier turns asked for as the chat scrolls up, as a Hermes Bot Chat is | A 120-turn thread 2.5 MB → 640 KB to open (bridge 17 → 5 ms; the phone parses and maps a quarter) | The chat's top loads as it is reached; opening at the end (docs/perf-open.md) must hold; search's "open at compaction" needs the page holding the hit | Large, in the app |
| 9 | The bridge writes `threads.json` less (the baseline's 11) | At 5000 threads 4 ms of writes, 2 ms of bytes and some of the 2 ms of collecting a turn; the longest ping 19-66 ms | A stop between saves loses the last change unless journaled | Medium; reopens the sync plan |

Looked at and left as it is: the bridge's session loads, Claude Code's listings, paging,
`session.resume`, catch-ups and connects (each a few to 20 ms); `ThreadState` while a
reply streams; the saved copy's encoder settings; `Fleet.saveTabs` (already coalesced to
250 ms after the last switch, 1 to 2 ms each); the SwiftUI transaction at the end of a tab
switch's animation (night n11's).

## Checks

At fdf43a9f (the last commit of code; this page after it): the bridge's typecheck and its
2,384 tests pass (`npm test`, 62 s); PortalsKit's `swift test`, 1,722 tests in five runs,
none failed; the Debug builds for the iOS Simulator and for Mac Catalyst (`ARCHS=arm64
ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO`, DerivedData in the worktree) succeed.
Nothing was pushed.

## Cleaned up

The scratch simulator (n18-speed-phone), the scratch bridges (ports 9583, 9851, 9853,
9855, 9581-9582) and their homes, the copies' settings (the benches' `defaults delete`),
the scratch worktree for 042d197c and its DerivedData, the Release DerivedData of the
benches, and the copies of this Mac's Claude Code sessions and Codex databases made for
the by-hand numbers were removed after the runs. The raw results (bench logs, the
harness's JSON, the 120-turn answer) are under /private/tmp/n18-speed; the by-hand
scripts are in /private/tmp/n18-speed/scripts.
