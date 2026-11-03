# Fuzzy folder search when choosing where a new thread starts, 2026-10-26

Builds on `n12/file-mentions` (#14): it reuses that PR's scorer (`bridge/src/sessions/fileSearch.ts`).

2026-10-26: "we should open a pr for better folder search as well and if we can
just use the same system, like for macs over the net we cant just open the finder", "i
mean when choosing a new folder or path people can do fuzzy search". It covers
"Everything under home"; the PR includes "the SwiftUI picker".

## 1. Design (written first)

**Today.** On a Mac whose bridge is on that same Mac, the new-thread folder picker
(`Portals/Sidebar/FolderSheet.swift`) has a row that opens the Finder's folder dialog
(`HostModel.choosesFoldersOnThisMac`, `FolderDialog.swift`), whose choice goes through
`folders.add`. Everywhere else (a phone, an iPad, a Mac reaching another Mac over the net)
the picker offers only `folders.list`: General, the 30 folders the agents used last and the
added ones. `folders.add` takes any folder the bridge may offer, but nobody can browse to
one from there.

**The wire.** One method, `folders.search`, behind a new feature `folder_search`:

- Params `{query?, limit?, machine?, profile}`. `limit` 30 by default, 100 at most; a
  query is cut at 200 characters.
- Result `{home, folders: [hit], total, matched, mode: "fuzzy"|"path", truncated?,
  refreshing?, superseded?}`, each hit `{path, name, relative, ranges, score, git?,
  last_used?, added?, repo?}`: `path` the folder's real path (what `folders.add` takes),
  `relative` the same under the home folder with `/` between its parts (what the app shows
  after `~/`), `ranges` the matched parts of `relative` as `[start, end)` in UTF-16 code
  units (as `files.search`), `git` for a git repository's top, `last_used`/`added` for a
  folder `folders.list` lists, `repo` for a folder in a git worktree: the folder
  `folders.add` adds in its place (feature worktrees).
- `machine`: the same on a linked Mac, routed through the fleet as `folders.list` is
  (`Fleet.foldersOn`), with a shorter time limit (10 s) and the link's own errors (cannot
  be reached, too old for this).

**Two kinds of query.**

1. *Fuzzy* (no `/`, not starting with `~`): FileSearch's scorer over every folder under
   the home folder, each scored as its path relative to home (so a match in the folder's
   own name ranks above one spread over its path, as for files). Words split at spaces and
   all must match (as `files.search`). Ranked by the scorer plus a bonus for a git
   repository's top and a larger one for a folder `folders.list` lists (the newer, the
   more) or that was added, so that among folders the query fits about as well, the ones
   the person works in come first.
2. *Path* (has a `/` or starts with `~`): completes like a shell, level by level, each
   segment fuzzy against the folders in the folder before: `~/cod/por` finds
   `~/coding_projects/Portals`; `/Users/<me>/cod/por` the same (an absolute path must be
   under the home folder: nothing outside it is offered). A trailing `/` lists the
   folder's children. A segment's exact name (case ignored) wins, then its prefix, then
   fuzzy; at most the best 8 folders of each level are followed further, at most 64
   folders read, so a vague path stays cheap. Path mode reads the folders it names live
   (no cache): it is always right, and works before the walk has finished.

**What is offered.** Only what `folders.add` and then `session.create` take: never `/`,
the home folder, a hidden folder (a part starting with `.`), a temporary one, the bridge's
own or one `folders.hide` names (the bridge's `Folders` says, through a new public
`offers(path)` that is the same check `folders.add` makes). The walk skips what
FileSearch's walk skips (`skippedFolders`: `node_modules`, `.git`, `DerivedData`, `build`,
`dist`, `.venv`, …), plus `~/Library` (macOS's own, hundreds of thousands of folders) and
packages (`.app`, `.photoslibrary`, `.xcodeproj`, `.xcassets`, `.framework`, `.bundle`,
… : a folder the Finder shows as a file); it follows no link, so nothing outside home is
named. General is offered like any folder (adding it changes nothing). A folder in a git
worktree is offered as itself with `repo`, and picking it goes through `folders.add` as
the Finder dialog's does (the app says the repository was added, and starts the thread in
the worktree).

**The cache** (`bridge/src/folderSearch.ts`, one per bridge, its home folder):

- *Bounded walk*: breadth first, 32 folders read at a time between turns of the event
  loop, at most 200,000 folders and 24 levels (the rest left out, `truncated`).
- *Never blocking*: the first query waits at most 300 ms for the walk and is answered from
  the folders walked so far (`refreshing`: ask again shortly); scoring yields to the event
  loop every 20,000 folders, and a query that a newer one from the same connection has
  replaced stops there and answers `superseded` with no folders (the app drops it anyway).
  A query's scoring stops at 250 ms and answers with what it scored (`truncated`).
- *Fresh*: on a Mac, one FSEvents watcher (`fs.watch` recursive) on each visible folder at
  the top of home (not `Library`), and one on home itself, not recursive. A change marks
  the folder it happened in as changed (changes in hidden, skipped and package folders
  are dropped but a `.git` appearing or going, which makes a folder a repository or not);
  the next query reads each changed folder again (at most 256; more, and the whole home is
  walked again in the background while answers come from the listing before,
  `refreshing`), takes away the folders gone with all under them and walks the new ones.
  Where it cannot watch (not a Mac, an error), the listing is walked again when older than
  60 s, in the background, the old one answering meanwhile.
- *Bounded in memory*: one listing (the bridge's home), let go of with its watchers after
  10 minutes with no query; measured below.
- *Recent and added*: `Folders.list()` read at most every 5 s.

**PortalsKit.** `FolderSearchHit` and `FolderSearchResults` (AgentCore), on
`FolderProviding`: `searchesFolders` and `searchFolders(_:limit:)`, with defaults for
hosts without it; `HermesBackend` sends `folders.search` only to a bridge listing
`folder_search`; wire types and decoding in `BridgeWire`; tests of decoding, of the
feature gate and of the refusal mapping.

**The picker** (`FolderSheet.swift` only, plus `HostModel` passing the call and the
feature on): a search field at the top, in the look of the sidebar's and the model
picker's (magnifying glass, tertiary fill, clear button). Empty: today's list, as now.
Typing: after 180 ms of no typing the host is asked (SwiftUI's `task(id:)` drops the older
query when a newer one comes); an answer saying `refreshing` asks again after 400 ms, a
few times. Rows: the folder icon (a repository's distinct), the name with the matched
letters bold, under it the path's head `~/coding_projects/` dimmed, matched letters bold
there too. Return on a path query takes the first row. Picking a listed folder (General, a
recent one) hands it over as today; any other goes through `folders.add` first (as the
Finder dialog's choice), its refusal said in an alert, a worktree said as the dialog says
it. Shown only for a host listing `folder_search`; on a Mac with its bridge on this Mac
the "Choose a folder…" row stays.

**Measured** (`bridge/scripts/folder-search-bench.ts`): cold (first query, walk included)
and warm p50/p95 per query for typed prefixes and unrelated queries, path queries, heap,
on the mini's real home (timing only: no folder name is logged, copied or committed) and
on a synthetic tree of about 100,000 folders.

## 2. What was built

**Bridge** (`bridge/src/folderSearch.ts`, `FolderSearch`, one per bridge; wired in
`bridge.ts`, `gateway/methods.ts` `folders.search`, `gateway/features.ts` `folder_search`,
`fleet/fleet.ts` `searchFoldersOn`):

- As designed in section 1, with these choices made on the way (the user was away; each is
  mine, and why):
  - *The scorer is FileSearch's, not a copy*: `fileSearch.ts` now exports `scoreAll`,
    `toRanges` and the `Scored` shape it reads (paths, folded paths, where each name
    starts), which `FolderSearch`'s listing has too. Nothing else in `fileSearch.ts` changed.
  - *Bonuses*: a repository's top +14, a folder `folders.list` lists +24 (+16 used within a
    day, +10 within a week, +5 within a month), added +10 more. A whole-name match is worth
    40 to the scorer, so `portals` still puts `Portals` (a whole name) above a listed
    `portals-old`, while `port` puts the listed one first. Tuned on the tests' home; to be
    tried by hand.
  - *Narrowing*: a query that only adds to the last whole one scores only what that one
    matched (as `files.search`); it took typing on the tree of 100,000 from p50/p95 62/85 ms
    to 20/34 ms.
  - *A path part that names a folder exactly* (case ignored) goes on in that one only, as a
    shell's completion would (`~/coding_projects/Portals/` lists Portals, not also
    `portals-old`); otherwise the best 8 of each level.
  - *In a path, the folders the walk skips are found by their name's start*
    (`~/Lib` finds Library, `~/x/node` node_modules): typed on purpose, and `folders.add`
    takes them. Packages and hidden folders never.
  - *`folders.search` needs `folders_add` too in the app* (`HermesBackend.searchesFolders`):
    a folder found is added before a thread starts there.
  - *A folder on the list is handed over as before*; any other goes through `folders.add`,
    so it becomes a project in the sidebar, as one chosen in the Finder's dialog does.
  - *`Folders.taking()` and `Folders.refusing()`*: the same checks `folders.add` makes,
    without adding (`taking`), and their string-only part for the walk (`refusing`), so
    the two can never disagree on what is offered.
  - *Bridge option `userHome`* (and `TestBridgeOptions.userHome`): the user's home folder
    for `Folders` and the search; tests and the scratch bridge give another, nothing else
    passes it.
  - *macOS privacy* (changed on 2026-10-26, evening, `n12/quick-net`; "If it's ...
    just a quick fix, do it now"): the walk first read `~/Desktop`, `~/Documents` and
    `~/Downloads` like any folder, which would put macOS's privacy question on the Mac's
    screen from the bridge's process, with nobody there. Now neither the walk nor a watcher
    goes into the folders macOS guards at the top of home (`protectedAtTop`): Desktop,
    Documents and Downloads (Apple's PrivacyPreferencesPolicyControl services
    `SystemPolicyDesktopFolder`, `SystemPolicyDocumentsFolder`,
    `SystemPolicyDownloadsFolder`; System Settings > Privacy & Security > Files & Folders),
    and Pictures, Movies and Music, which hold the Photos and Music libraries (`Photos`,
    `MediaLibrary`) and rarely code. iCloud Drive (`~/Library/Mobile Documents`), other
    apps' data (`SystemPolicyAppData`, `~/Library/Containers`) and network and removable
    volumes (`SystemPolicyNetworkVolumes`, `SystemPolicyRemovableVolumes`, under
    `/Volumes`) were never walked: `~/Library` is skipped, and the walk follows no link out
    of home. A typed path goes into one whose name it starts (`~/Doc/no`), as for
    `~/Library`: the person asked for it, and macOS may ask then. `~/` does not list them.
    A folder `folders.list` lists inside one (an agent's thread there) is scored and
    offered in a fuzzy search all the same, and only it is read (its `.git`, and
    `folders.add`'s checks). Shown by `folder-search.test.ts` "the folders macOS asks
    about … are neither walked nor watched …" on a home of its own under the temporary
    folder (so no prompt here), recording every folder read and the watchers.
- Tests: `bridge/test/folder-search.test.ts` (19, seven of them from Codex's review, section 6): ranking and what is never offered,
  the listed and added first, typed paths, `matchPart`, a worktree's `repo`, the bounds
  and the time budget, a newer search replacing an older, the first walk answered
  partly with `refreshing`, the unwatched re-walk, on a Mac folders made / moved /
  removed / turned into a repository followed without walking again, letting go when
  idle, and on the wire through a test bridge (a hit added and a thread started in it, a
  typed path, refusals) and through a second, linked bridge (`machine`).

**PortalsKit**: `FolderSearchHit`, `FolderSearchResults` (AgentCore `Folders.swift`), on
`FolderProviding` `searchesFolders` and `searchFolders(_:limit:)` with defaults for hosts
without them; `BridgeWire.Feature.folderSearch`, `Method.foldersSearch`,
`FoldersSearchParams`, `folderSearchResults(from:)`; `HermesBackend` sends it only to a
bridge listing `folder_search` and `folders_add`, a -32602 becoming `FolderError.refused`
with its sentence. Tests: `FolderSearchWireTests` (6) and the contract subset
(`ContractSubsetTests`, `Fixtures/contract-subset.json`).

**The picker** (`Portals/Sidebar/FolderSheet.swift`; `HostModel.searchesFolders` and
`searchFolders`; `FolderDialog` made internal for its worktree sentence; a development
switch `PORTALS_DEBUG_FOLDER_SEARCH` in `DebugLaunch.swift` to open the sheet with a query
typed, for screenshots): a search field pinned on top, in the model picker's look
(magnifying glass, `tertiarySystemFill`, rounded, clear button, a small spinner while
asking). Empty: the sheet as before, with "Choose a folder…" on a Mac whose bridge is on it.
Typing: asked 180 ms after the last keystroke (`task(id:)`, a newer query cancels the
older; an answer the host says was superseded is dropped); an answer still `refreshing`
is shown and asked for again 400 ms later, up to 10 times, with a footer saying the host
is still looking. Rows: the folder icon, the name with its matched letters bold and the
last-used age for a listed one, under it the folders it is in (`~/coding_projects/`)
dimmed with its matched letters bold, a branch mark for a repository. Return takes the
first. A refusal from `folders.add` is said in an alert; a worktree as the folder dialog
says it. None of the user's three files in progress was touched.

*Changed on 2026-10-27* (`n14/folders`; "it looks particularly ugly and is buggy
on mobile, on mobile its partially liquid glass and partially solid and when we enter one
character the keyboard disappears"):

- *The keyboard.* The field was in a safe-area inset of what is under it, which changes as
  it is typed in (the list, a spinner, the folders found), and each change made the field
  again, without the keyboard. It is now above what is under it in a stack, made once
  (`FolderSearchUITests`, on an iPhone and an iPad). On a Mac the same inset had put the
  field in the middle of the sheet when nothing was found.
- *One surface*, Settings' page (`SettingsScreen.background`, `SettingsSurface`,
  `settingsRows`): the grouped grey on an iPhone and an iPad at both heights (it was glass
  at the medium height around a solid strip under the field, and white over a grey list
  at the large one); on a Mac the app's white or black with the rows a little off it.
- *The sidebar's search field* (`SearchField`, the sidebar's own made a component), with
  the spinner in it; no second spinner under it while the first answer comes.
- *On a Mac the sheet's own bar* (`PanelChrome`, now with Cancel; Esc cancels): in the
  window's bar its Cancel was cut to "C…".
- *Rows* (`FolderRow`, both lists): the last-used age at the row's far end, as a sidebar
  row has a thread's; where a folder found is as `~/coding_projects` (`~` for one in the
  home folder itself); "⎇ git" after it for a repository's top, where a small branch mark
  alone read as a "Y". "Choose a folder…" in one section with No project.

Screenshots before and after (iPhone and iPad simulators, the Mac app, against a scratch
bridge with a demo home): `~/coding_projects/Portals-worktrees/n14-shots/folders/`.

Screenshots (a simulator of this agent's, the app against a scratch bridge on port 9811
with the fake agent and a demo home folder):
`/private/tmp/portals-n12/fix/folder-search/picker-fuzzy.png` (`cod por`) and
`/private/tmp/portals-n12/fix/folder-search/picker-path.png` (`~/cod/Portals/`).

## 3. The wire

`docs/gateway-protocol.md`, section 11, row `folder_search`, and the fleet section on
`machine`. In short: `folders.search {query?, limit?, machine?, profile?}` →
`{home, folders: [{path, name, relative, ranges, score, git?, last_used?, added?, repo?}],
total, matched, mode: "fuzzy"|"path", truncated?, refreshing?, superseded?}`. `limit` 30,
at most 100; -32602 for a wrong type or an unknown agent; with `machine`, -32603 with a
sentence for a Mac out of reach (10 s) or too old. The contract is regenerated
(`bridge/contract.json`) and `scripts/check-contract.sh` passes.

## 4. Measurements

**Machine**: the Mac mini, Apple M4, 10 cores, 16 GB, macOS 26.6, Node 24.14.1, shared
with four other agents (load average 10 to 19 while these ran). `bridge/scripts/folder-search-bench.ts`:
cold = a new `FolderSearch`, the whole walk waited for (three runs), and the first answer
as a person gets it (300 ms at most); warm = per query, every prefix of five targets
(`portals`, `coding projects`, `bridge src`, `notes`, `gateway`: 44 queries), unrelated
ones (1, 2, half and all of each, and `zq`, twice: 50 queries, nothing narrows), and typed
paths (every prefix of `~/cod/por`, `~/coding_projects/`, `~/wo/ser`, `~/Doc/no/`: 44);
CPU time per query beside the wall time; the event loop's delay while walking and
searching; heap = the listing in the V8 heap after a GC; fresh = from making a folder to
the first search that finds it, watched.

| Home | Folders | Walk (whole) | First answer | Typing p50 / p95 | Unrelated p50 / p95 | Paths p50 / p95 | Loop delay max (walk / search) | Heap | Fresh |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| The mini's own (read only; Desktop, Documents, Downloads not read) | 2,346 | 51 ms | 52 ms, whole | 3.0 / 3.7 ms | 2.3 / 3.4 ms | 0.4 / 3.0 ms | 12 / 1.6 ms | 0.9 MB | not measured (read only) |
| Synthetic, about 100,000 folders | 99,807 | 2.7 s (2.4 to 3.5) | 315 ms, partial, `refreshing` | 19.6 / 34.1 ms (CPU 23.6 / 48.3) | 15.9 / 30.8 ms | 0.5 / 1.6 ms | 15 / 14 ms | 33.9 MB | 27 ms (one folder read again, no walk) |

- The mini's home: only folder counts and times were printed; no name was logged, copied
  or committed. Desktop, Documents and Downloads were left out of this run so that
  macOS would not ask on the user's screen while they are away; the bridge itself reads them.
  The floor of about 2 to 3 ms a query there is `Folders.taking()` checking each of the 30
  hits on the disk (a `stat`, a real path and the worktree check), and reading the list
  of folders every 5 s.
- The synthetic home (`folder-search-bench.ts tree`, seeded): ten folders at the top,
  repositories with `.git` (60% of the folders), some with `node_modules` (50 folders,
  skipped) and `build`, the rest documents up to nine levels deep, names of one or two
  words from a list of 84; `~/Library/Caches` and `~/.cache` too, never walked. Before the
  narrowing (same machine, load 18): typing 62 / 85 ms, unrelated 49 / 83 ms, the event
  loop held up to 55 ms (scoring yielded every 20,000; now every 8,000).
- The walk reads each folder and checks its real path (a folder swapped for a link is
  not read through), 200,000 file-system calls for 100,000 folders, through libuv's four
  threads: about 2.7 s here, in the background; the first answer comes at 300 ms from the
  folders walked so far, shallowest first, and says `refreshing`.

## 5. What is left

- The user to try it by hand on a phone against the mini, and to tune the bonuses if the
  order feels wrong (section 2).
- macOS's privacy question: the background walk no longer goes into the folders macOS
  guards (section 2); a path typed into one may still bring the question, on the Mac's
  screen. Not seen here: this Mac's bridge was not touched.
- A linked Mac in the app itself: the app talks to each Mac's bridge directly, so
  `machine` is for `portals` and agents; `portals folders` has no search command yet.
- On Linux there is no watcher (Node's recursive watch would set one per folder): the
  home folder is walked again once the listing is a minute old.
- The walk is bounded at 200,000 folders and 24 levels; a home folder past that is said
  to be `truncated`, and what was left out is found only by typing its path.

## 6. Codex's review (2026-10-26, gpt-6.1-sol at xhigh, read-only)

One thread, the brief at `/private/tmp/portals-n12/fix/folder-search/brief.md`, on
`git diff origin/n12/file-mentions..HEAD`; then two re-checks of the fixes in the same
thread. Each finding and its fate:

| # | Severity | Finding | Fate |
|---|---|---|---|
| 1 | Medium | A typed path read and counted what is in a refused folder (`~/Hidden-by-config/…`: `matched` and `total` said what it held) | Fixed: every folder is passed through `Folders.refusing()` before it is read, matched or counted. Tested |
| 2 | Medium | `mentions.ts`: a file hit's size followed a link out | Not this work: `origin/n12/file-mentions` had moved after the merge, so the two-dot diff showed its newer commits as removals. Merged again; Codex confirmed the diff of those files is empty and withdrew it |
| 3 | Medium | A stale mark that came during a walk was cleared and lost; a first walk done answered not refreshing with changes queued | Fixed: the mark is cleared only by a walk that starts; a first walk done reads what changed before answering. Tested |
| 4 | Medium | Cancel while a folder found was being added still started the thread | Fixed: the addition is a task called off when the sheet goes. Built; not tested in the app |
| 5 | Medium | A failed search was hidden behind the last query's rows | Fixed: the problem is shown first, cleared at the next search. Built; not tested in the app |
| 6 | Medium | The Claude limit's parsing regressed | Not this work (as 2); withdrawn |
| 7 | Low | PDFs got a size note again | Not this work (as 2); withdrawn |
| 8 | Low | Folders past the depth limit left out without `truncated` | Fixed. Tested |
| 9 | Medium (re-check) | Reading changed folders, still running when a walk of the whole home started, read a change the new walk had missed into the old listing, lost when the new one replaced it | Fixed: that reading stops once such a walk is under way, leaving the changes to the new listing. Tested |
| 10 | Medium (re-check) | A first walk done with a stale mark left answered not refreshing | Fixed: it walks again and answers refreshing. Tested |
| 11 | Medium (second re-check) | A search that waited for changes said not refreshing when another search had started a walk meanwhile | Fixed: it says refreshing while a walk, more changes or a stale mark are left. Tested |

Every fix's test fails on the code before it. Codex's probes injected reads and the
watcher's marks; FSEvents itself is exercised by the test of folders made, moved and
removed on a Mac.
