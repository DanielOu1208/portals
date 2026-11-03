# The sidebar with hundreds of threads, the launch, and memory

Taken on the night of 2026-10-18 (track `sidebar`, branch `n4/sidebar` from main at
15a49fa). The ask of 2026-10-17 and the night's: the app quicker and lighter.

## In short

- **A change in the list drew every row in sight again.** The sidebar is one view, and
  any change it reads (a turn ending in any thread, a title, a group on top growing, a
  list folded, the thread on screen) worked its whole body out again: every thread row
  in sight, and on a Mac each row's menu, a button of UIKit's whose menu SwiftUI makes up
  front. Now a thread's row is drawn again only when what it shows changed
  (`ThreadRow`), and an agent's or a folder's menu button only when what it offers
  changed (`AgentMenuButton`, `ProjectMenuButton`). On the Mac with 600 threads, turns
  ending in other threads went from 39 to 17 ms of missed frames a second (the longest
  frame 102 -> 46 ms), titles changed on another device from 12 to 8 ms a second, Show
  fewer from 44 to 30 ms; with 2000 threads, turns ending 70 -> 40 ms a second (188 ->
  67 ms).
- **The layout was worked out from every thread each time.** `Fleet.layout` asked each
  thread whether it was at work (at 2000 threads that took longer than the layout) and
  built the layout again even when nothing it is made of had changed. Now only the
  threads that may be at work are asked (the ones the host reported and the ones open
  here), and the layout is kept until something it is made of changes
  (`SidebarLayoutCache`).
- **Scrolling the sidebar on a Mac is mostly its rows' menus.** Each thread row is a
  `Menu` (the pull-down one a secondary click opens, chosen on 2026-10-15 to keep
  macOS's "Ask Siri" field out of it), and making its UIKit button and menu is about a
  sixth of the main thread while the list scrolls. Rows without it scroll with a quarter
  of the hitches. Not changed: written up below as a proposal (it needs a check with a
  real pointer).
- **At launch, the notification pictures were drawn before the first frame**: about
  90 ms of the main thread on the Mac, every launch, for pictures already saved. They
  are now drawn two seconds later (coalesced); the ones saved last time are there
  meanwhile.
- **The saved list shows at once**: the first sidebar row is on screen from the saved
  copy about 0.3 s after the process starts on the Mac (0.4 s before), and the host's
  answer about 0.7 s (0.9 s before).
- **Memory**: the sidebar's own share is small. The footprint moves between about 105,
  220 and 300 MB with what the window shows (graphics memory, and a long thread on
  screen: the chat's). In the final A/B the footprint after the turns and the titles was
  298 MB in every run of main and 100 MB in every run of this branch, which fits fewer
  redraws; in earlier runs both moved over the whole range, so it is a hint only.
- **The iPhone simulator's 1.5 GB peak is not in a Release build**: opening the ten
  newest threads, the newest with the 20,000-character reply, peaks at 88 to 99 MB. It
  was the Debug build's.
- **Thread sync's writes and the bridge's list calls are not what makes the sidebar
  slow**: at 1000 threads a turn's sync step costs a device 3 ms (1.5 ms of it the
  write of threads.json, 447 KB); the bridge answers a whole `threads.changes` in 3 ms
  at 600 threads (248 KB) and 9 ms at 2000 (831 KB). Left as they are.

## The numbers

The Mac (MacBook Pro 16, Catalyst, Release build with the switches, the scratch copy's
window as it opens, the sidebar listing by agent, every agent open). Base is main at
15a49fa with the probe (5eeeff5); after is this branch. "Hitches" are the frame meter's:
ms of frames missed a second, hitches a second, the longest frame (120 Hz display). Each
number is the median of the runs' medians, A/B interleaved, with other agents building
on the same Mac (load averages 4 to 20, in the bench logs under
/private/tmp/portals-n4/bench/sidebar/, kept until the Mac restarts).

The final A/B (05:24 to 05:35, load 3 to 5; three runs each at 600 threads, one at
2000; base is main with the probe, after is this branch):

| What (600 threads) | Base | After |
|---|---:|---:|
| Turns ending in six threads, from another device | 38.9 ms/s, longest 102 ms | 16.8 ms/s, longest 46 ms |
| Six titles changed from another device | 12.4 ms/s, longest 46 ms | 7.8 ms/s, longest 28 ms |
| Show fewer on every open list (main thread until the next frame) | 43.6 ms | 30.1 ms |
| Show more on every open list | 53.0 ms (38 to 85) | 48.4 ms (41 to 72) |
| Scrolling the sidebar, every list shown whole | 13.4 ms/s, 1.3 hitches/s | 13.2 ms/s, 1.2 hitches/s |
| Launch on the saved list: the Fleet made | 253 ms | 185 ms |
| Launch: the first sidebar row (from the saved list) | 404 ms | 306 ms |
| Launch: the host's answer (its agents listed) | 897 ms | 710 ms |
| Footprint at the end of the run (after the renames) | 297 to 299 MB | 100 to 101 MB |

| What (2000 threads) | Base | After |
|---|---:|---:|
| Turns ending in six threads | 69.5 ms/s, longest 188 ms | 40.0 ms/s, longest 67 ms |
| Six titles changed | 18.2 ms/s, longest 48 ms | 12.0 ms/s, longest 34 ms |
| Show more / Show fewer on every open list | 59.0 / 49.8 ms | 36.5 / 43.6 ms |

The footprint at the end of the run was the same in each of the three runs of each build
here, but in the earlier runs it moved between about 100 and 300 MB in both with what
the window was redrawing (below): read it as a hint, not a result.

The first A/B (ab1: base against the rows, the layout cache and the still avatars, before
the agents' menus, the at-work threads and the pictures; three runs each, 600 threads):

| What | Base | After (first three fixes) |
|---|---:|---:|
| Turns ending in six threads, from another device | 35.4 ms/s, longest 120 ms | 19.5 ms/s, longest 52 ms |
| Six titles changed from another device | 13.2 ms/s, longest 46 ms | 7.6 ms/s, longest 24 ms |
| Show fewer on every open list | 32.7 ms to the next frame | 22.8 ms |
| Scrolling the sidebar (every list shown whole) | 20.7 ms/s, 1.9 hitches/s | 20.8 ms/s, 1.8 hitches/s |

Show more on every open list (575 rows coming in at once) varies too much between runs
to say more than that it is not worse: 25 to 92 ms in base, 21 to 72 ms after.

At 2000 threads (two runs each, same fixes): turns ending 43.6 -> 33.9 ms/s, titles
20.2 -> 12.1 ms/s (longest 48 -> 31 ms), Show fewer 43 -> 32 ms, Show more 58 -> 45 ms.

**The rows' menus on a Mac (an experiment, not kept).** The same build, its thread rows
as plain buttons by a launch switch, three runs each: scrolling the sidebar 20.0 -> 5.3
ms of hitches a second (1.9 -> 0.5 hitches a second); the first sidebar row 394 -> 371 ms
after the process started, the host's answer shown 964 -> 796 ms. The menus made as the
list came to rest instead (also not kept): 21.8 ms/s, longest frames 52 to 65 ms.

**Where the main thread goes** (Time Profiler, after the first fixes, 600 threads):
scrolling the sidebar is SwiftUI's lazy stack placing rows and CoreAnimation's commit
(29% of the samples), the rows' UIKit menu buttons (16%, 12% making their menus), text
(7%); the thread rows' own bodies 0.4%. While turns end, most of the main thread is
animations being drawn (the agent's avatar thinking, the spinners, the composer's glass
redrawn with them: about half of the samples); the sidebar's body was 7% at 2000
threads, most of it the layout's question to every thread of whether it was at work,
which the at-work threads now answer.

**The layout alone** (SidebarBenchmarks, release, five agents and eight folders): 0.57 ms
at 600 threads, 2.7 ms at 2000; the threads compared with the ones before 0.05 and
0.15 ms, which is what the cache costs when nothing changed. Thread sync's own benchmark
(SyncBenchmarks, release): a turn's step at 1000 threads 3.0 ms with a write of
threads.json of 1.5 ms (447 KB); at 5000, 14.1 and 7.4 ms (2.2 MB); a whole
`threads.changes` answer decoded 15.6 ms at 1000 threads (411 KB), which happens only
when the device takes the whole list.

**The bridge's list calls** (scripts/sidebar-bench/bridge.mts calls, median of seven):
`threads.changes` whole 2.9 ms and 248 KB at 600 threads, 9.4 ms and 831 KB at 2000;
`threads.list` 1.8 ms / 159 KB and 5.0 ms / 531 KB; `sessions.activity` 0.3 ms / 0.2 KB.
Not what the app waits for: nothing to change there.

**The launch on the Mac** (600 threads, the list saved, probe): the App's start 55 to
65 ms after the process's, RootView's 120 ms later (UIKit and SwiftUI setting up the
scene), each host's saved list loaded in 5 ms, looks given in 1 ms, then the
notification pictures drawn: 60 to 100 ms, now after the first frame; the first sidebar
row 390 to 450 ms after the process started on main (about 300 ms now), from the saved
list; the host's answer (its agents listed) 870 to 1020 ms on main (about 710 now). Nothing saved (the first launch): the first row
comes with the host's answer, about 950 ms.

**The iPhone simulator** (iPhone 18 Pro Max, Release, 600 threads, the list saved, two
runs of four launches each): the first sidebar row about 1.70 s after the process
started, both before and after (the simulator's dyld is 1.4 s of it: Time Profiler of a
launch), the host's answer about 2.25 s; the app's own share of the launch is small
(the Fleet 26 ms of samples, the sidebar 58). Opening the ten newest threads one after
another, the newest with the 20,000-character reply: footprint 86 MB, peak 88 to 89 MB,
before and after. So the 1.5 GB peak docs/perf-app.md saw was the Debug build's; not
looked into further.

**Memory on the Mac.** The footprint after a run was 98 to 218 MB in base and 99 to
182 MB after; opening the 20 newest threads it moved between about 105, 220 and 300 MB
in both, with what the window was showing (its graphics memory, and the long thread when
it was on screen: the chat's). The sidebar's share does not show above that.


## What changed (commits on n4/sidebar)

1. **Measuring** (5eeeff5, 45f180c): scripts/sidebar-bench.sh, scripts/sidebar-bench/
   (the scratch bridge with the scripted agent as five agents, the bridge's
   `fake.agents`, tested in config.test.ts; the iPhone simulator's launch), the probe
   (`SidebarProbe`, `PORTALS_DEBUG_SIDEBAR_PROBE`, `PORTALS_DEBUG_SIDEBAR_BENCH`) and
   `SidebarBenchmarks`.
2. **Rows drawn again only when they change** (AgentSidebar.swift): `ThreadRow`, a view
   of its own compared by what it shows (thread, kind, state, age, whether it is on
   screen, look, caption, folder, whether it can be removed) and not by the fleet and
   actions it is handed; `AgentMenuButton` and `ProjectMenuButton`, an agent's More and
   New thread menus and a folder's New thread menu (iPhone and iPad), compared by what
   their menus offer; `PinnedHeader` told only when a row reaches the top or leaves it;
   `RowAvatar` compared by look; the date's format made once.
3. **Still avatars worked out once per look** (`AgentAvatarDirector.frozen`).
4. **The layout kept until what it is made of changes** (`SidebarLayoutCache`, AgentCore,
   tested), and only the threads that may be at work asked (`HostModel.threadsMaybeAtWork`,
   for the layout and for an agent's and a folder's rows).
5. **The notification pictures drawn after the first frame**, two seconds after the
   last ask, once (`Fleet.saveNotificationAvatarsSoon`).

Checked: the bench itself goes through Show more and Show fewer on every list, a
thread moving between Running and Finished, titles changed on another device, the
relaunch on the saved list and opening 20 threads one after another, on both builds; the
iPhone simulator and the iPad simulator launch and show the sidebar (groups, open agents
with their menus, Show more), with no crash report. Not tried by hand: hovering a row,
a secondary click on a row and dragging a row (the night's automation cannot move the
pointer); the code of the rows' menus and of moving rows is the same, only where it sits.

## How to measure (repeatable)

Everything runs on scratch copies and a scratch bridge; nothing touches the installed app
or bridge.

1. **A Release build that reads the launch switches** (as in docs/perf-app.md):

       xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
         -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath <dd> \
         CODE_SIGNING_ALLOWED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
         'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG' build

   and the same with `-destination 'platform=iOS Simulator,id=<simulator>'` for the
   iPhone simulator.

2. **A scratch bridge with a long list**, the scripted agent listed as five agents
   (the bridge's `fake.agents`, for benches only):

       node scripts/sidebar-bench/bridge.mts start /private/tmp/<you>/b600 9353 600 <password>
       # 600 threads over five agents and eight folders, 25 minutes apart (ten days),
       # one in ten unseen (under Finished), one in twenty pinned, one in twenty-five
       # archived, one in forty of 20 turns, the newest with a 20,000-character reply
       node scripts/sidebar-bench/bridge.mts turn http://127.0.0.1:9353 <password> <thread>
       node scripts/sidebar-bench/bridge.mts rename http://127.0.0.1:9353 <password> <thread> "A title"
       node scripts/sidebar-bench/bridge.mts calls http://127.0.0.1:9353 <password>
       # the list calls' times and sizes

3. **The Mac bench** (under the gui lock), A/B interleaved:

       scripts/sidebar-bench.sh --rounds 3 base=<built .app> after=<built .app>

   For each app and round: a new bridge, a scratch copy launched in the background with
   every agent open (`PORTALS_DEBUG_SIDEBAR_BENCH`), then Show more and Show fewer on
   every open list at once (a Darwin notification the copy listens for; the probe notes
   the time until the main thread could draw again), the sidebar scrolled up and down
   with every list shown whole, turns ending in six threads, six titles changed from
   another device, a relaunch on the saved list, and the 20 newest threads opened one
   after another. Frames come from the app's frame meter (FrameMeter.swift): hitch ms a
   second, hitches a second, frames a second, the longest frame.
   `--threads 2000` for the scale check; `--profile` records Time Profiler over the
   scroll and the turns (read with scripts/app-footprint/timeprofile.py).

4. **The iPhone simulator** (under the sim lock):

       scripts/sidebar-bench/sim-launch.sh <built .app for the simulator> <out dir>

   launches a scratch copy once with nothing saved and five times on its saved list,
   with the probe's marks, then opens the ten newest threads and reads the footprint
   and its peak.

5. **The layout alone**: `PORTALS_BENCH=1 swift test -c release -Xswiftc -enable-testing
   --filter SidebarBenchmarks` in Packages/PortalsKit.

The probe (`PORTALS_DEBUG_SIDEBAR_PROBE=<file>`, Portals/Sidebar/SidebarProbe.swift)
writes `<ms since the process started> <event>`: `app-init` (the App's init),
`fleet-start` and `fleet-made` (the Fleet, with each host's saved list loaded),
`sidebar-row saved|host` (the first sidebar row on screen, and whether a host had answered
by then), `host-listed` (a host listed its agents), `list-merged` (a host's list merged),
`chat-shown`.

## Proposals (not built)

- **A thread row's menu made when the pointer comes to it (Mac).** Every thread row is a
  `Menu` with `primaryAction`, which on a Mac is a UIKit button whose whole menu SwiftUI
  makes up front (`UIKitButtonAdaptorCoordinator.makeMenu`, through its preferences
  machinery): 12 to 15% of the main thread while the sidebar scrolls, and with the menu
  taken out of the rows (an experiment, `EXPERIMENT_NOMENU`) the scroll's hitches fell
  from 20 to 5 ms a second (1.9 to 0.5 hitches a second, median of three runs each, same
  build). Tried tonight: rows made while the list scrolls as plain buttons that become
  menus once it is at rest. It did not help: a wheel's scroll comes to rest between its
  steps, and all the rows made meanwhile became menus at once, in long frames (52 to
  65 ms against 34 to 42). What would: a row is a plain button with the same look until
  the pointer is on it, and a menu from then on (kept, so a menu open under the row is
  not taken away when the pointer leaves the row for it), with the hover kept by the row
  rather than its box, so the highlight does not blink when it changes. Needs a check by
  hand, which the night's automation cannot do (hovering takes the real pointer): that
  a secondary click opens the menu on any row, also with another app in front (a window
  that is not key may not be told the pointer is over it), and that VoiceOver still
  reaches the row's actions. S to M.
- **Writing threads.json after the change, not with it.** Each change to a thread
  (a pin, a title, a turn ending, a merge) writes the device's whole threads.json on the
  main thread: 1.5 ms at 1000 threads, about 4 ms at 2000 (the bridge's list of 831 KB).
  A write coalesced over half a second, off the main thread, would take that away, but
  the sync's state (sync.json, which says up to which revision the list was merged) must
  never be written ahead of the list it speaks for, or a crash between the two would
  leave the device sure it has changes it lost. Both would have to go through one queue,
  in order. M; not worth it below a few thousand threads.
- **The groups on top and the list as views of their own.** The sidebar is one body:
  the search field, the groups on top, every host's list, the footer. With the rows and
  the menus now skipped when unchanged, what is left of a change is the body itself and
  the layout's check (a few tenths of a millisecond at 600 threads, about 2 ms at 2000:
  the threads compared with the ones before and sorted). Views of their own, each
  reading only what it shows, would leave the list alone when a group changes. M.

## Night n10: the new sidebar (2026-10-24)

The sidebar redesigned on 2026-10-23 (a Mac's space, every folder listed, tabs), measured
with scripts/tabs-bench.sh against main at 4a4a3acf (docs/perf-tabs.md has the baseline).
Three changes kept, on branch `n10/sidebar`:

- **A thread row's menu gets its items when the pointer comes onto it (Mac)**, the first
  proposal above, done another way: the row stays the same `Menu` button, its items
  (`ThreadRow.hasMenu`) only there from the pointer's first visit, or while the app is not
  the active one (AppKit's own state, `ActiveApp`: a Catalyst scene stays active with
  another app in front, where a pointer coming onto a row may not be told), or with
  VoiceOver or Switch Control. Scrolling a space with every thread listed: 19.7 to 8.4 ms
  of missed frames a second at 600 threads, 21.8 to 10.0 at 2000; 6.6 to 5.7% of a core;
  8 to 15 MB less held. A plain button in place of the empty menu saved more (6.8 ms/s,
  4.1% of a core) but drew the titles about 5% dimmer than the menu's button does: not
  kept. The bench's copies are never the active app, so `PORTALS_DEBUG_ROWS_IN_FRONT`
  makes their rows do as in the app in front. Not tried by hand: a secondary click on a
  row the pointer just reached, also with another app in front, and VoiceOver.
  **Undone by the review (69da8671):** with Full Keyboard Access, Voice Control or any
  assistive app but VoiceOver and Switch Control, a row the pointer never reached opened
  an empty menu (Codex review). Every row has its items from the start again, and
  scrolling costs what it did before the night; docs/perf-tabs.md, "The review", has
  what was tried instead and the numbers.
- **`Fleet.layout` no longer sorts the threads on each read**, and the thread in sight
  tells the layout's readers only when it changes the layout (an unseen thread): on a tab
  switch the getter went from 1.7 to 0.5 ms and the setter's synchronous graph update
  from 5.8 ms to nothing (Time Profiler); the bench's CPU a switch moved within its noise.
- **The old layout fields are gone** (`waiting`, `running`, `finished`, `hosts`,
  `hostsByProject`, `archived`): `SidebarLayout.build` 1.30 to 0.83 ms at 600 threads,
  4.25 to 2.81 ms at 2000.

Left as they are: the sidebar's and the spaces' bodies are under a millisecond a switch
now, so splitting them into views of their own is not worth its risk; a step between two
Macs' spaces is 36 ms with the app's own code under 3 ms of it, the rest SwiftUI's paging
animation (display link, CoreAnimation commits, the tab's title weight interpolated, the
glass interaction), which is what the user sees move; turns and titles from another
device moved within their noise.
