# The new sidebar and the tabs on a Mac: the baseline

Taken on the night of 2026-10-24 (night n10, branch `n10/perf` from main at 4a4a3acf, the
sidebar redesign and the tabs as merged that day). The ask for the night: "When the
sidebar has many items open, it should scroll smoothly. Tab switching should be quick,
cheap, and efficient. It should not hog resources." This is what the app does before any
change: the base every A/B of the night is measured against. The behaviour is taken as
it is:
a change for speed must change nothing anyone sees or does.

## In short

(The baseline. What the night kept, and the last numbers against it, are under "The final
state, night n10" near the end; the tab switches made quicker the next night, under "Tab
switching speed, night n11".)

- **A tab switch costs about a quarter of a second of CPU**: 246 ms of the app's CPU a
  switch, whatever the number of threads (248 ms at 2000). The main thread cannot draw
  for about 95 ms after the switch (the new chat is built: `ChatScreen` is made anew for
  each thread, `.id(chat.id)`), and works about 100 ms more over the next half second
  while something animates (SwiftUI's display link, text drawn by the CPU as it is
  interpolated, the glass's interaction effect). Switching one tab every 0.7 s, the
  frames miss 159 ms a second (4.4 hitches a second, the longest frame 130 ms). This is
  by far the biggest cost found tonight.
- **The chat is on screen and drawn about 97 ms after the switch** (112 ms until a frame
  shows its turns, the open probe's `content_ms`), for a thread still in memory and for
  one read from its saved copy alike (38 and 5 of the 43 switches a run).
- **Scrolling a Mac's space with every thread listed** misses 26 ms of frames a second at
  600 threads and 22 at 2000 (2.3 and 1.9 hitches a second, longest frames about 40 ms),
  6.6% of a core: as choppy as Apple's guide calls "visibly choppy" past 10 ms a second,
  and not worse with more threads (the list is lazy). A sixth of the main thread then is
  the thread rows' UIKit menu buttons being updated (`UIKitButtonAdaptor.updateUIView`),
  as on the old sidebar (docs/perf-sidebar.md).
- **At rest the app costs nothing worth fixing**: 0.10% of a core and 1.3 wakeups a
  second with twelve tabs open and the sidebar out; 0.07% with three turns running in
  tabs not on screen (their spinners are UIKit's, animated outside the app); 0.11% with
  the window covered and three turns running. Nothing here to gain.
- **Memory does not grow with switching**: 121 MB before 42 switches, 125 MB after (600
  threads; 138 and 145 MB at 2000), 102 MB at rest after a relaunch.
- **Stepping from one Mac's space to another** keeps the main thread from drawing for
  36 ms (the longest 72 ms), 34 ms of missed frames a second while stepping once a second.
- **Turns and titles from another device** with tabs open: 23 and 12 ms of missed frames a
  second (longest 62 and 32 ms), about what the old sidebar did after night n4.
- **The tab put back at launch** is on screen 215 ms after the process starts and drawn at
  621 ms; its saved copy took 0.7 ms to read on the main thread (the bench's long thread
  is one long turn; a thread of 45 to 120 turns takes 12 to 27 ms, docs/perf-open.md).
- **The layout alone** (SidebarBenchmarks): 1.27 ms at 600 threads, 4.17 ms at 2000; the
  fields the sidebar reads now (`top`, `spaces`) alone 0.85 and 2.73 ms. The old fields
  still worked out beside them (`waiting`, `running`, `finished`, `hosts`,
  `hostsByProject`, `archived`) are a third of each build. And a tab switch builds the
  layout again (the profile has `Fleet.layout` at 1.4 ms a switch at 600 threads, 4.1 ms
  at 2000), though nothing the sidebar lists changed.

## What was measured, and how

The Mac (MacBook Pro 16, Mac Catalyst), a Release build with the launch switches compiled
in (`SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`), as a scratch copy (its own bundle id, no
extension, no URL scheme) in a scratch home, launched in the background (not the app in
front) with its window as it opens (the sidebar out beside the chat), on scratch bridges
with only the scripted agent. The base is n10/perf at 2fab1af2 (main 4a4a3acf with the
measuring kit), built into /private/tmp/portals-n10/baseline/base/Portals.app.

`scripts/tabs-bench.sh`, for each round and each app in turn (A, B, A, B):

1. A scratch bridge on 9501 with 600 (or 2000) threads over five agents and twelve
   folders, 25 minutes apart, one in a hundred unseen (so that Recent is mostly the
   tabs: the old bench's one in ten put 60 threads with a dot there), one in twenty
   pinned, one in twenty-five archived, one in forty of 20 turns, the newest with a
   reply of 20,000 characters (scripts/sidebar-bench/bridge.mts).
2. The copy opens twelve threads as tabs one after another, 0.6 s apart
   (`PORTALS_DEBUG_OPEN_PLAN`): the newest, three of 20 turns, eight of one turn.
3. **scroll**: Show more on every folder (every thread of the space listed: 120 rows a
   folder at 600 threads), then the space scrolled down and up with the mouse wheel for
   15 s (cua-driver, in the background: 8 lines a step, three steps each way). Frames
   from the app's frame meter (`PORTALS_DEBUG_FRAMES`), CPU from the kernel's count.
4. **tabs**: 42 switches, 0.7 s apart, made by the app itself on a Darwin notification,
   in turn as ⌃Tab and ⌃⇧Tab do (`Fleet.cycleTabs`), as ⌘1 to ⌘9 do
   (`Fleet.showTab(at:)`) and as a click on a tab does (`Fleet.showTab`), never to the
   tab on screen (`TabsBench.swift`, `PORTALS_DEBUG_TAB_SWITCHES`); keys cannot be sent
   to a copy in the background. For each switch the probe notes `tab-frame` (until the
   main thread could draw again), `chat-shown` and `chat-drawn` (the chat put on screen,
   and the next frame after it: `drawn` is from the switch to that frame), and the open
   probe its `content_ms` (until a frame showed the thread's turns). With twelve tabs,
   eight are kept in memory at rest (`OpenThreads.keptAtRest`), so some switches read a
   saved copy (off the main thread) as they would for anyone.
5. **turns** (a turn in six threads, as another device starts it) and **renames** (six
   titles changed from another device), a second apart: frames.
6. **restore**: the copy quit and opened again, the tab it left on screen (the newest,
   the long one) put back (`PORTALS_DEBUG_RESTORE_TABS`: any switch skips that
   otherwise). A copy in a scratch home keeps no settings between launches (its
   preferences are not written there), so the bench keeps the tabs in a file instead
   (`PORTALS_DEBUG_TABS_FILE`).
7. **idle**, in that launch, with no frame meter and no open probe (both wake the app):
   60 s at rest, then 50 s with turns running in three tabs not on screen (a minute-long
   `bench` reply each), then 50 s with three others running and the window covered by
   another (scripts/app-footprint/cover.swift). CPU and wakeups from
   `proc_pid_rusage` (scripts/tabs-bench/rusage.swift; powermetrics needs sudo); the
   wakeups are the kernel's interrupt wakeups (its idle-wakeup count stayed 0).
8. **spaces**: a second scratch bridge on 9502 as a second Mac, a launch with both, and
   20 steps from one space to the other and back, a second apart, as ⌘⌥→ and ⌘⌥← make
   them (`Fleet.stepSpace`) and, every other one, as a click on a Mac's tab does
   (animated, `Fleet.showSpace`): `space-frame` (until the main thread could draw
   again) and frames.

One line of numbers a run in OUT/results.txt, the medians per app at the end
(scripts/tabs-bench/summary.py), the load beside each run.

## The baseline

Medians of six runs (the three A/A rounds of both copies), with the lowest and highest
run, taken on 2026-10-24 between 05:28 and 06:30, load averages 2.8 to 10.5 (the first
run at 10.5, the others under 5). Logs and results under
/private/tmp/portals-n10/baseline/bench/aa-600/ and aa-2000/.

| Scenario | 600 threads | 2000 threads |
|---|---:|---:|
| Scroll: missed frames, ms a second | 25.6 (20.9-28.3) | 22.1 (20.0-26.8) |
| Scroll: hitches a second | 2.25 (2.1-2.5) | 1.85 (1.6-2.4) |
| Scroll: longest frame, ms | 40 (33-50) | 42 (33-44) |
| Scroll: CPU, % of a core | 6.57 (6.54-6.71) | 6.57 (6.49-6.74) |
| Tabs: CPU a switch, ms | 245.9 (244.6-247.4) | 248.2 (247.1-249.2) |
| Tabs: main thread until it can draw (`tab_frame`), ms | 95.2 (85.0-101.0) | 94.8 (89.8-98.6) |
| Tabs: the same, 90th percentile / longest, ms | 121 / 127 | 121 / 132 |
| Tabs: switch to the chat drawn (`drawn`), ms | 96.9 (87.1-101.8) | 96.0 (90.2-99.5) |
| Tabs: switch to a frame showing its turns (`content`), ms | 112 (109-113) | 112.5 (110-114) |
| Tabs: missed frames while switching, ms a second | 158.6 (144.8-167.5) | 164.0 (161.8-169.1) |
| Tabs: hitches a second / longest frame, ms | 4.4 / 130.5 | 4.5 / 132.5 |
| Tabs: footprint before / after 42 switches, MB | 120.9 / 125.2 | 137.8 / 144.5 |
| Turns from another device: missed frames, ms a second (longest) | 23.0 (62.5) | - |
| Titles from another device: missed frames, ms a second (longest) | 12.2 (32) | - |
| Restore: chat shown / drawn, ms after the process started | 215 / 621 | 232 / 642 |
| Restore: its saved copy read on the main thread, ms | 0.7 | 0.8 |
| Restore: first sidebar row / host listed, ms | 708 / 841 | 732 / 887 |
| At rest: CPU %, interrupt wakeups a second | 0.10, 1.35 | 0.10, 1.30 |
| Three turns running: CPU %, wakeups a second | 0.07, 1.3 | 0.09, 1.35 |
| Covered, three turns running: CPU %, wakeups a second | 0.11, 1.4 | 0.14, 1.4 |
| At rest after the relaunch: footprint, MB | 101.8 | 119.2 |
| Spaces: main thread until it can draw after a step, ms | 36.5 (35.9-38.9), longest 72 | - |
| Spaces: missed frames stepping once a second, ms a second | 34.0 (30.3-40.5) | - |

The layout alone (SidebarBenchmarks, release, median of three runs of the test, each
row the median of 30 rounds; load about 5):

| SidebarBenchmarks | 600 threads | 2000 threads |
|---|---:|---:|
| `SidebarLayout.build`, the whole layout | 1.27 ms | 4.17 ms |
| the fields the sidebar reads now alone (`top`, `spaces`) | 0.85 ms | 2.71 ms |
| of which the groups on top (`SidebarGroups.build`, with its sort) | 0.23 ms | 0.81 ms |
| every host's threads sorted (`Fleet.allThreads`) | 0.10 ms | 0.31 ms |
| the cache when nothing changed (inputs made and compared) | 0.05 ms | 0.18 ms |
| `SidebarGroups.lines` | 0.004 ms | 0.006 ms |

## The noise

The A/A (the base against a second copy of itself, three rounds each, interleaved), the
two copies' medians and the spread of the runs. A change counts only past these:

| Metric | A/A medians (600; 2000) | Runs' spread | Counts when it moves by more than |
|---|---|---|---|
| Tabs: CPU a switch | 244.7 / 246.7; 248.4 / 247.8 ms | ±1% | 3% (8 ms) |
| Tabs: `tab_frame`, `drawn` | 86 / 96; 96 / 94 ms | 85 to 101 ms | 12% (12 ms) |
| Tabs: `content` | 112 / 110; 112 / 113 ms | 109 to 114 ms | 5% (6 ms) |
| Tabs: missed frames while switching | 157 / 159; 164 / 164 ms/s | 145 to 169 | 8% |
| Scroll: missed frames | 25.9 / 25.0; 21.5 / 22.8 ms/s | 20 to 28 | 25% (6 ms/s) |
| Scroll: hitches a second | 2.2 / 2.3; 1.8 / 1.9 | 1.6 to 2.5 | 20% |
| Scroll: longest frame | 47 / 37; 42 / 42 ms | 33 to 50 | 30%: a hint only |
| Scroll: CPU | 6.6 / 6.5; 6.6 / 6.5 % | 6.5 to 6.7 | 3% |
| Turns: missed frames | 22.8 / 29.1 ms/s | 19 to 35 | 40%: a hint only |
| Renames: missed frames | 11.4 / 13.7 ms/s | 10 to 15 | 30% |
| Spaces: `space_frame` | 36.1 / 38.8 ms | 36 to 39 | 10% |
| Spaces: missed frames | 31.5 / 35.5 ms/s | 30 to 41 | 20% |
| Restore: chat drawn | 623 / 614 ms | 603 to 780 | 10% |
| At rest: CPU | 0.10 / 0.10 % | 0.08 to 0.11 | 0.03 points |
| Footprint (tabs, rest) | within 1 MB | ±3 MB, one run of 2000 at 203-219 MB | 5 MB |
| SidebarBenchmarks | three runs | ±3% | 5% |

Turns and renames vary most: a turn's moment against the frames is never the same twice.
Read them with three rounds or more, and as a hint.

## Where the time goes (Time Profiler)

Recorded with `--profile` (one round of the base, 600 threads; tabs and scroll also at
2000), xctrace exported and read with scripts/app-footprint/timeprofile.py,
scripts/tabs-bench/appframes.py (the frames of the app's own binary, and the one of
them nearest the top of each sample) and scripts/tabs-bench/afterswitch.py (the main
thread's time after each switch). A sample is a millisecond of one thread's CPU. The
recordings are under /private/tmp/portals-n10/baseline/bench/profile-*/base-r1/.

**Tab switching** (9665 samples over 43 switches, 9208 on the main thread: about 215 ms
of main thread a switch). 88% of the main thread's samples have no frame of the app's in
them: SwiftUI working its graph, laying out and committing to CoreAnimation for what the
app's views said. By time after the switch:

- 0 to 120 ms, **the switch itself, 103 ms a switch**: SwiftUI's transaction
  (`GraphHost.flushTransactions`, 71%), the layer tree committed (`CA::Transaction::commit`,
  27%), the hosting view's layout (18%), the chat under the tab bar's inset laid out
  (`InsetLayoutComputer`, 15%; 19% at 2000) and its scroll view (`ScrollViewLayoutComputer`,
  12%), animations started (8%), `MainScreen.body` (6%), the UIKit menu buttons (the
  composer's and +'s: `UIKitButtonAdaptor`, 4 to 5%), the reply's text views made and laid
  out (`ProseTextView`, 4%), the glass (2.5%), `AgentSidebar.body` (1.5%; 2.7% at 2000),
  `Fleet.layout` (1.4 ms; 4.1 ms at 2000, a layout built again), `NewTabButton` (0.7 ms;
  2.5 ms at 2000), `Fleet.threadInSight`'s setter telling its observers (2.6% of all main
  thread samples), saving the tabs (`Fleet.saveTabs`, 0.7%).
- 150 to 680 ms, **after the switch, 102 ms a switch**, about 10 ms in every 50: SwiftUI's
  display link updating animations (`ViewGraphHost.displayLinkTimer`, 67%), the layer
  tree committed (26%), text drawn by the CPU as display lists are interpolated
  (`RBInterpolatedDisplayListContents`, 12%), the glass's interaction effect
  (`FlexCoreInteractionModifier`, 8 to 10%), the glass (3%). No frame of the app's own:
  something on screen animates for half a second after each switch. The tab strip has
  `.smooth(duration: 0.25)` animations on its tabs' ids and on the one selected, which
  move every tab's width and change two titles' weight and opacity, and the glass capsule
  of the tab shown goes from one tab to the other; which of these it is was not
  separated tonight (see the tabs track, item 1).

**Scrolling the space** (845 main-thread samples over 21 s: the wheel's steps are a few a
second, the main thread busy 4% of the time): the layer tree committed (26%), the lazy
stack placing rows (`LazySubviewPlacements`, 15%), the thread rows' menu buttons updated
(`UIKitButtonAdaptor.updateUIView`, 15%), `ThreadRow.body` 0.5%. As on the old sidebar,
the rows' `Menu` (the Mac's pull-down menu on a secondary click) is the app's biggest
share.

**Three turns running in tabs not on screen** (57 samples in 54 s, 12 on the main thread):
the five-second poll of what is at work (`Fleet.refreshActivity`, `HostModel.askActivity`)
and the socket. Nothing else.

## What else was noticed

- `DebugLaunch.value` reads the process's environment each time it is asked (0.5% of
  the main thread while switching): only in the measuring builds (a build without DEBUG
  returns at once), the same in A and B.
- The scratch copy keeps no settings between launches when its home is a scratch one
  (`CFFIXED_USER_HOME`): its preferences are written nowhere. Folded folders, the space
  shown and the folders' first-seen dates start afresh at each launch of the bench.
- The bench's copy is never the app in front (launched with `open -g`): its scene is
  inactive, which the app treats as on screen. Spinners are UIKit's (`ProgressView`).

## Proposals, in two tracks

Two agents build these in parallel, in worktrees of their own, from 2fab1af2. The files
are apart except Fleet.swift, where the sidebar track keeps to `layout` and what it reads
(the "Agents" part, `threadInSight`), and the tabs track to the "Tabs" part. Biggest
first. Each to be kept only when the bench says it helps past the noise above and
screenshots say nothing on screen changed.

**Sidebar** (the list, rows, layout, AgentCore, the sidebar's animations):

1. *The thread rows' menu buttons on a Mac.* 15% of the main thread while the space
   scrolls is `UIKitButtonAdaptor.updateUIView`: every row is a `Menu` (the pull-down
   menu of a secondary click), whose UIKit button and menu are made and brought up to
   date as rows come into the lazy stack. On the old sidebar the same rows without menus
   (an experiment) scrolled with a quarter of the hitches (20 to 5 ms a second). Either
   the row's menu made only once the pointer is on it (docs/perf-sidebar.md's proposal),
   or a UIKit button of the app's own whose menu is built only as it opens
   (`UIDeferredMenuElement`), looking and behaving the same. Expected: scroll missed
   frames 26 to about 10 ms a second. SidebarRows.swift. Risk: medium (a secondary click
   on any row, with another app in front, and VoiceOver's actions need a check by hand).
2. *The whole sidebar worked out again on every tab switch and every change of any
   thread.* `AgentSidebar.body` reads `fleet.chat` (the row on screen, and a folder's
   recent threads keep it) and `fleet.layout`, and `SpacePage` is handed the whole
   `AgentSidebar`, so it is never skipped: its body goes through every folder
   (`SidebarSections.recent` twice a folder, `agentsForFolder`, a folder's activity).
   Views of their own for the groups on top, the Macs' tabs, each space and each folder,
   compared by what they show, the thread on screen given only where it is shown.
   Expected: 2 to 4 ms of main thread a switch (more at 2000 threads), as much on each
   turn and title from another device, part of the 36 ms of a space's step. AgentSidebar
   .swift, SpacePage.swift, SidebarRows.swift. Risk: medium (a row must still be drawn
   again when its state changes: the lesson of `SidebarGroups.Line`).
3. *The layout built again on each tab switch.* `Fleet.layout` takes 1.4 ms a switch at
   600 threads and 4.1 ms at 2000 in the profile, about a whole build: one of its inputs
   changes as a tab is shown though nothing listed changed (the thread in sight,
   `ThreadRecord.inSight`, or the thread's record as its host's copy is taken in: to find
   with `SidebarLayoutCache.builds`). And `threadInSight`, set at each switch
   (MainScreen), tells every reader of the layout to work its body out again: its setter
   and the observers' bookkeeping are 2.6% of the main thread while switching. Give the
   layout the thread in sight only where it changes what it lists (an unseen thread),
   and keep the setter from telling anyone otherwise. Expected: 1.5 to 4 ms a switch, and
   fewer bodies worked out. Fleet.swift (`layout`, `threadInSight`). Risk: low.
4. *The old layout fields* (concern a): `SidebarLayout.build` still works out `waiting`,
   `running`, `finished`, `hosts`, `hostsByProject`, `archived` (no view of the app reads
   them), a third of each build: 0.42 ms at 600 threads, 1.45 ms at 2000, on every change
   of any thread. Remove them and rewrite the tests that read them (MultiHostTests,
   StartedThreadsTests, SidebarOrderTests, SidebarLayoutCacheTests, ComingBackTests and a
   few more) to `top` and `spaces`. Sidebar.swift and its tests. Risk: low (the tests
   keep the behaviour), M in size.
5. *Stepping between spaces* (36 ms until the main thread can draw, 34 ms a second of
   missed frames): not profiled tonight; profile it first (the spaces scenario with
   `--profile` is not wired: attach xctrace by hand). Items 1 and 2 should take part of it.
   SpacePage.swift (`SpacePager`), MacTabs.swift. Risk: low to medium.
6. *Turns and titles from another device* (23 and 12 ms of missed frames a second): to
   measure again after 2 to 4; the groups' moves (`matchedGeometryEffect`, their
   `.animation`) are what is left. AgentSidebar.swift. Risk: medium (the moves are seen).

**Tabs** (switching, the tab strip, +, the restore, the chat's swap, the strip's
animations):

1. *Half a second of animation after each switch.* After the switch itself the main
   thread works about 100 ms more over 500 ms, 40% of the 246 ms a switch costs:
   SwiftUI's display link updating an animation, text drawn by the CPU as it is
   interpolated (`RBInterpolatedDisplayListContents`) and the glass's interaction effect
   (`FlexCoreInteractionModifier`). First tell which view it is: a development switch
   that leaves the tab strip's animations out, measured with afterswitch.py. If it is the
   strip (its `.smooth(duration: 0.25)` on the tabs' ids and on the one selected moves
   every width and changes two titles' weight and opacity, and the tab shown's glass
   capsule goes from one tab to another), keep the same motion with less drawn on the
   CPU: the glass as one shape that moves (`glassEffectID` in a `GlassEffectContainer`)
   rather than taken off one tab and put on another, the titles' weight changed so that
   they are not interpolated glyph by glyph, compared frame by frame in screenshots.
   Expected: up to 100 ms of CPU a switch, and fewer missed frames while switching (159
   ms a second now); the switch's own 95 ms unchanged. TabStrip.swift. Risk: medium (the
   look of the motion: what cannot be kept the same is left as it is).
2. *The chat laid out with the bar.* The tabs are a `.safeAreaInset` of the chat
   (MainScreen `chatArea`), so a change to the bar lays the chat out with it, and the
   switch's layout goes through `InsetLayoutComputer` (15% of the switch, 19% at 2000).
   The bar's height is a constant (`TabBar.height`): the bar as an overlay and the chat
   given that room as a fixed top inset (`safeAreaPadding`), which the chat's top fade
   and blur under the bar read the same. Expected: some of 15 to 20 ms a switch (the new
   chat's own layout stays), and nothing of the chat laid out as the strip animates.
   MainScreen.swift. Risk: low to medium (screenshots of the top of the chat, scrolled
   and not, on a Mac and an iPad).
3. *The + menu* (concern b): `NewTabButton` reads the whole `fleet.layout` and builds its
   menu up front (a UIKit menu on a Mac) each time the bar is drawn again, which is on
   each switch (0.7 ms at 600 threads, 2.5 ms at 2000) and on each change of any thread.
   An equatable button handed only the space's folders and bots and the agents a folder
   asks between, or a menu built only as it opens. Expected: 1 to 3 ms a switch and on
   every thread change. TabStrip.swift (and a small accessor in Fleet's Tabs part).
   Risk: low.
4. *The composer's and the chat's UIKit menus made with each new chat* (4 to 5% of the
   switch, `UIKitButtonAdaptor`), and the reply's text views (`ProseTextView`, 4%): made
   only when first shown or opened, if that can be done without a visible difference.
   Expected: 3 to 8 ms a switch. ChatComposer and the chat's views. Risk: medium.
5. *Saving the tabs at each switch* (`Fleet.saveTabs`: JSON and the settings, 0.6 ms a
   switch): the tab on screen saved a moment later, coalesced, and at once on leaving
   the app. Expected: 0.6 ms a switch. Fleet.swift (Tabs). Risk: low (a crash within that
   moment brings back the tab before).
6. Not worth changing, by the numbers: the tab strip's measuring of the selected title
   (TabStrip and TabChip together 0.3 to 0.7 ms a switch), the restore's read on the main
   thread (0.7 ms here, 12 to 27 ms for very long threads, and moving it would show
   something else first), the app at rest (0.1% of a core), WindowMover (not seen in
   any profile). Keeping the last tabs' chats built rather than made anew at each switch
   would take most of the 95 ms, but each would come back where it was left rather than
   at its end, and keep its memory: a change of behaviour, not for tonight.

## The tabs track, night n10 (branch n10/tabs)

What the half second after each switch is, found with a measuring build that took parts
of the bar out one at a time (`PORTALS_DEBUG_TABS_EXP`, not kept), each run on the tabs
bench and recorded with Time Profiler (afterswitch.py's 150-680 ms after a switch):

| Taken out | CPU a switch | Main thread 150-680 ms after |
|---|---:|---:|
| nothing | 234-269 ms | 107-117 ms |
| the strip's two `.animation(.smooth(duration: 0.25))` | 116-141 ms | 12 ms |
| the whole bar (`TabBar`) | 118 ms | - |
| the titles' crossfade (`contentTransition(.identity)`) | 205-210 ms | 96 ms |
| every part of a tab at once (capsule, avatar, tooltip, menu, hover, crossfade, the composer's and the sidebar button's interactive glass, the animated scroll to the tab) | 214-250 ms | 94-128 ms |
| the tabs' widths not changing, the glass of the tab shown, the bar as an overlay instead of an inset | within the noise | within the noise |

So it is not what the tabs draw: any part of the strip moving costs about 1.7 ms of the
main thread a frame, because each frame of an animation brings the whole window's graph
and display list up to date (SwiftUI's display link, `ViewGraph.updateOutputs`), the chat
and the sidebar with it. Only less time moving, or the bar out of the window's graph,
takes it away.

Kept:

1. **The move ends once nothing moves by a pixel** (25b0ecb4, `Animation.settling`): SwiftUI
   runs a spring until a thousandth of a point is left, 0.55 s for the strip's
   `.smooth(duration: 0.25)`; the same curve now ends once every part is within a tenth of
   a point (a thousandth for an opacity) and slower than that a frame. Three rounds A/B,
   600 threads: CPU a switch 245.5 → 236.4 ms (-4%, every run under every run of the
   base), main thread 150-680 ms after a switch 116 → 100 ms; the rest within the noise.

Tried, not kept:

- **The bar in a hosting view of its own** (branch n10/tabs-hosted, b9eb45ba): CPU a switch
  248-252 → 149-150 ms (-40%), hitches while switching 4.5 → 2.2 a second, the bar the same
  pixel for pixel, the wheel over the band under the tabs still scrolling the chat (a view
  that lets the pointer through where the bar has nothing, `BarHits`), ⌃⌘S kept. But the
  chat is drawn about 18 ms later after a switch (98-100 → 116-119 ms; content 112-122 →
  128-133 ms), with or without measuring the bar, and clicks on the tabs cannot be sent to a
  copy in the background to try them. A choice for the user: a fifth of a second of CPU a
  switch against 18 ms more before the chat shows; the cause of the 18 ms is not found yet
  (profile its first 120 ms against the base's next).
- **The bar as an overlay** of the chat with a fixed safe area padding (proposal 2): no
  change past the noise (`InsetLayoutComputer` is the chat's own layout, which moves with it).

Not done tonight (left as proposed, each under the noise of the bench): the + menu built
from the space's folders only (3), the composer's menus and prose views made lazily (4),
the tabs' save coalesced (5).

## After: both tracks together (branch n10/all)

Branch `n10/all` is the base with `n10/sidebar` and `n10/tabs` merged into it (no
conflict: the two tracks changed different files, and the tabs' + menu reads only
`layout.spaces`, which the sidebar track kept). What it keeps:

- **A thread row's menu gets its items once the pointer has come onto the row** (Mac),
  or while the app is not the active one, or with VoiceOver or Switch Control on; until
  then it is the same button with an empty menu (58a15dd7, docs/perf-sidebar.md).
- **`Fleet.layout` no longer sorts every host's threads on each read**, and the thread in
  sight tells the layout's readers only when it changes the layout, an unseen thread
  (68368eb8).
- **The old layout fields are gone** (`waiting`, `running`, `finished`, `hosts`,
  `hostsByProject`, `archived`, `SidebarSection`, the `unasked` input), a third of each
  layout (b073dde9).
- **The tab strip's moves end once nothing moves by a pixel** (`Animation.settling`, the
  same `.smooth(duration: 0.25)` curve stopped within a tenth of a point of its end
  instead of a thousandth), so a switch animates about 0.4 s instead of 0.55 s (25b0ecb4).

The bar in a hosting view of its own (-40% CPU a switch, but the chat drawn 18 ms later)
stays on branch `n10/tabs-hosted`, not merged: the choice.

The base app (2fab1af2) against a Release build of `n10/all` with the switches, every
scenario of the tabs bench, three rounds interleaved (base, all, base, all…), the gui
lock held, 2026-10-24 between 09:59 and 11:04. Load averages 2.6 to 4.6, except the first
base run at 600 threads (25.9; its numbers are inside the other two base runs' spread but
for the restore, 802 ms, which the median leaves out). The `n10/all` copies ran with
`PORTALS_DEBUG_ROWS_IN_FRONT=1`, as the app in front does (the bench's copies are never
the active app; without it their rows' menus are filled as in the base). Medians, the
lowest and highest run in brackets; "noise" is how far a number must move to count (from
the A/A above). Results under /private/tmp/portals-n10/all/bench/final-600/ and
final-2000/.

| Scenario | 600: base | 600: n10/all | 2000: base | 2000: n10/all | Noise | Counts? |
|---|---:|---:|---:|---:|---|---|
| Scroll: missed frames, ms a second | 24.1 (23.6-25.7) | 9.7 (7.6-14.1) | 24.1 (23.7-26.4) | 11.6 (8.1-16.7) | 25% | yes, -60% / -52% |
| Scroll: hitches a second | 2.1 | 0.8 | 1.9 | 1.0 | 20% | yes |
| Scroll: longest frame, ms | 42 | 34 | 47 | 33 | 30%, a hint | a hint |
| Scroll: CPU, % of a core | 6.56 | 5.64 | 6.51 | 5.60 | 3% | yes, -14% |
| Tabs: CPU a switch, ms | 245.1 (244.1-245.8) | 229.1 (227.7-231.2) | 248.2 (243.4-248.7) | 230.2 (229.7-231.5) | 3% | yes, -7% (every run under every base run) |
| Tabs: `tab_frame`, ms (90th percentile) | 91.2 (117) | 91.8 (112) | 97.7 (123) | 90.5 (112) | 12% | no |
| Tabs: switch to the chat drawn (`drawn`), ms | 93.7 | 94.2 | 99.1 | 91.1 | 12% | no |
| Tabs: switch to a frame showing its turns (`content`), ms | 111 | 108 | 112 | 107 | 5% | at the edge (-3%, -4%) |
| Tabs: missed frames while switching, ms a second | 158.4 | 153.4 | 160.4 | 152.8 | 8% | no |
| Tabs: hitches a second / longest frame, ms | 4.4 / 136 | 4.5 / 118 | 4.5 / 131 | 4.5 / 118 | -, hint | longest a hint |
| Tabs: footprint before / after 42 switches, MB | 119.4 / 123.6 | 109.8 / 115.3 | 135.6 / 141.5 | 124.0 / 131.0 | 5 MB | yes, 8-11 MB less |
| Turns from another device, ms a second (longest) | 31.2 (58) | 29.8 (58) | - | - | 40% | no |
| Titles from another device, ms a second (longest) | 11.7 (33) | 13.1 (33) | - | - | 30% | no |
| Spaces: `space_frame`, ms (longest) | 37.5 (77) | 36.5 (59) | - | - | 10% | no (the longest a hint) |
| Spaces: missed frames, ms a second | 33.4 | 31.2 | - | - | 20% | no |
| Restore: chat shown / drawn, ms after the process started | 229 / 624 | 229 / 612 | 237 / 656 | 239 / 618 | 10% | no |
| Restore: first sidebar row / host listed, ms | 714 / 852 | 672 / 779 | 732 / 885 | 684 / 788 | - | a hint (-6 to -11%, every run) |
| At rest: CPU %, interrupt wakeups a second | 0.10, 1.3 | 0.10, 1.4 | 0.10 | 0.10 | 0.03 points | no |
| Three turns running: CPU % | 0.07 | 0.06 | 0.08 | 0.08 | 0.03 points | no |
| Covered, three turns running: CPU % | 0.11 | 0.12 | 0.14 | 0.13 | 0.03 points | no |
| At rest after the relaunch: footprint, MB | 101.6 | 92.2 | 112.8 | 99.4 | 5 MB | yes, 9-13 MB less |

The layout alone (SidebarBenchmarks, release, three runs each interleaved, load about 8):

| SidebarBenchmarks | 600: base | 600: n10/all | 2000: base | 2000: n10/all |
|---|---:|---:|---:|---:|
| `SidebarLayout.build`, the whole layout | 1.26 ms | 0.80 ms (-36%) | 4.10 ms | 2.65 ms (-35%) |
| two layouts compared (`==`) | 0.046 ms | 0.016 ms | 0.147 ms | 0.050 ms |
| the cache when nothing changed | 0.053 ms | 0.051 ms | 0.178 ms | 0.174 ms |

In short: scrolling a Mac's space with every thread listed misses less than half the
frames it did (under the 10 ms a second Apple's guide calls choppy at 600 threads) at 14%
less CPU; a tab switch costs 7% less CPU; the app holds 8 to 13 MB less; the rest (how
soon the chat shows after a switch, a step between spaces, turns and titles from another
device, the app at rest) is within the noise. Nothing the user sees changed: every
capture the bench takes (the tabs opened, the space before and after scrolling, after the
switches, the tab put back, turns running, the spaces) differs between the base and
`n10/all` by no more than it differs between two runs of the base (a few pixels: the
times and spinners; the spaces capture, taken mid-step, by about as much either way).
The biggest cost left is the switch itself: about 230 ms of CPU, most of it SwiftUI
building the new chat and the half second of the strip's move, which the hosted bar
(branch `n10/tabs-hosted`) would cut by another 40%.

Checked as well: `swift test` in Packages/PortalsKit (882 tests in 94 suites, and 491, 24,
23 and 19 in the other test products), a Release Mac Catalyst build, a Release simulator
build launched on new iPhone 18 Pro and iPad Pro 13-inch (M5) simulators with the sidebar
out (scripts/tabs-bench/sim-check.sh: both running after 15 s, no crash report).

## The review, night n10 (n10/all at 69da8671)

Codex reviewed `2fab1af2..adeef6de` read-only (thread "Night review: sidebar/tabs perf
(n10)"). One finding, medium, and two areas it could not settle:

- **Full Keyboard Access opened an empty thread-row menu (fixed: the row-menu change of
  58a15dd7 undone, 69da8671).** With Full Keyboard Access, Voice Control or any assistive
  app that is neither VoiceOver nor Switch Control, a row the pointer never reached had
  no items: no Pin, Rename, Archive, Remove. Every Mac row's menu has its items from the
  start again, as at the base (SidebarRows.swift and DebugLaunch.swift are the base's
  again). Tried first, and not kept: the items given once the lists had been still a
  while with the row in sight (`StillWaits`, branch `n10/review-stillwaits`). It still
  left a keyboard an empty menu just after the list moved (Full Keyboard Access's own
  scroll to the row it moves to included), and it gave the gain back anyway: the
  bench's wheel scrolls come about 2 s apart, every row in sight got its items in each
  pause (probe marks, at waits of 0.6, 1.0 and 1.5 s alike), and a row with its items
  costs again each time it is made. At 600 threads, three rounds: scroll CPU 6.83% of a
  core against 5.75 for the hover-only rows and 6.74 for the base, missed frames 22.1
  ms/s against 13.5 and 26.6. Dropping the items again as the list moves cost more
  (8.2%). A sandboxed Catalyst app cannot tell whether Full Keyboard Access is on, and
  `AccessibilityActionKind.showMenu` is not there on iOS or Catalyst.
- **A row moving under a pointer that stays still (no defect).** On a scratch copy in
  front, the pointer put on the space's list and the wheel turned at it without moving
  it, the row brought under the pointer showed its hover fill 0.25 s later, three times
  out of three: the row is told. Moot with the menus back as they were.
- **`Animation.settling`'s merge (no defect, change declined).** A diagnostic build
  asked `.smooth` at each `shouldMerge` with `previous` as given (the settling wrapper)
  and with it unwrapped to `.smooth`: twelve switches 0.08 s apart, twice, 3,732 calls,
  `previous` always the same settling animation, and `.smooth` answered true both ways
  every time. The strip's chips traced frame by frame looked the same with plain
  `.smooth`, settling as it is, and settling unwrapped, within what two runs of one
  differ by. The unwrapping the earlier review agent left unfinished changes nothing, so
  it is not in. Codex's re-check agrees, and notes that a plain `.smooth` under way (the
  drag's neighbours) is handed on as the base's `.smooth` would see it.

What is left of the night, base (2fab1af2) against n10/all at 69da8671, three rounds
interleaved, every scenario at 600 threads, scroll, tabs, restore and idle at 2000,
2026-10-24 16:25 to 17:25 (load 3.5 to 6, the first base run at 600 at 89.7). Results
under /private/tmp/portals-n10/review/bench/final-600/ and final-2000/.

| Scenario | 600: base | 600: n10/all | 2000: base | 2000: n10/all | Noise | Counts? |
|---|---:|---:|---:|---:|---|---|
| Scroll: missed frames, ms a second | 32.0 (20.0-34.5) | 32.1 (24.3-34.2) | 28.4 | 30.5 | 25% | no |
| Scroll: CPU, % of a core | 6.61 | 6.61 | 6.53 | 6.49 | 3% | no |
| Tabs: CPU a switch, ms | 238.6 (225.8-253.0) | 238.5 (200.4-239.2) | 248.3 (223.8-264.3) | 235.6 (204.8-240.6) | 3% | no at 600; -5% at 2000, with base runs 40 ms apart |
| Tabs: switch to the chat drawn, ms | 86.9 | 88.9 | 92.8 | 88.8 | 12% | no |
| Tabs: footprint before / after 42 switches, MB | 121.7 / 126.3 | 118.4 / 123.1 | 144.6 / 116.1 | 133.2 / 137.1 | 5 MB | no at 600; 2000 too scattered |
| Spaces: `space_frame`, ms | 28.1 | 28.2 | - | - | 10% | no |
| Turns / titles from another device, ms a second | 27.3 / 9.8 | 24.4 / 12.4 | - | - | 40% / 30% | no |
| Restore: chat drawn, ms after the start | 738 | 689 | 744 | 738 | 10% | no |
| At rest: CPU %; footprint after the relaunch, MB | 0.09; 102.6 | 0.08; 100.6 | 0.09; 111.6 | 0.09; 110.7 | 0.03 points; 5 MB | no |

In short: with the rows' menus as they were, scrolling and the app's memory are the
base's again; what the night keeps is the layout's own speed (`SidebarLayout.build` a
third quicker, the layout read without sorting) and the tab strip's shorter move, which
the bench now puts within its noise. Smoother scrolling needs the rows' menus to cost
less without being empty: the next thing to try is the highlight and the hover fill
drawn outside the row's `Menu` and the `Menu` in a view of its own compared by what its
items show, so that a row's menu is not made again when only its highlight changes (a
tab switch, the pointer); the menus of rows coming into sight while scrolling would
still be made.

## The final state, night n10 (n10/all at 57139140)

`n10/all` is now the review's state with `n10/newtab` merged into it (a merge commit, so
it can be dropped whole): + and ⌘T open a new tab at once with the agent and folder of
the tab on screen, and the new thread's screen has chips to change them (the backlog's
entry has the design). The only conflict was the list of the bench's scratch bridge's
ports. What the night keeps for speed is unchanged by it: the layout read without
sorting and without the old fields (`SidebarLayout.build` 1.26 → 0.80 ms at 600 threads,
4.10 → 2.65 at 2000, above; the new tab touches none of the layout's files) and the tab
strip's shorter move. The thread rows' menus are the base's, as the review left them.

The base app (2fab1af2) against a Release build of `n10/all` at 57139140 with the
switches, scroll, tabs and idle, three rounds interleaved (base, final, base, final…),
600 threads, the gui lock held, 2026-10-24 17:36 to 18:06. Load averages 2.5 to 5.6,
except the first base run (12.3, just after the builds). Medians, the lowest and highest
run in brackets; "noise" as in the A/A above. Results under
/private/tmp/portals-n10/final/bench/final-600/.

| Scenario | base | n10/all | Noise | Counts? |
|---|---:|---:|---|---|
| Scroll: missed frames, ms a second | 23.7 (22.3-25.6) | 23.7 (20.6-27.5) | 25% | no |
| Scroll: hitches a second | 2.0 | 2.2 | 20% | no |
| Scroll: longest frame, ms | 40 | 36 | 30%, a hint | no |
| Scroll: CPU, % of a core | 6.47 (6.44-6.54) | 6.54 (6.43-6.78) | 3% | no |
| Tabs: CPU a switch, ms | 230.2 (210.6-233.2) | 214.9 (214.6-215.3) | 3% | not counted: -7% by the medians, but the base's runs spread 23 ms, its lowest (210.6) is under every n10/all run, and the review saw none (238.6 against 238.5) with the same code less the new tab |
| Tabs: `tab_frame`, ms (90th percentile) | 84.3 (101.9) | 87.9 (105.9) | 12% | no |
| Tabs: switch to the chat drawn (`drawn`), ms | 86.8 | 89.0 | 12% | no |
| Tabs: switch to a frame showing its turns (`content`), ms | 107 (94-114) | 101 (97-102) | 5% | no: -6%, with the base's runs 20 ms apart |
| Tabs: missed frames while switching, ms a second | 150.3 | 153.1 | 8% | no |
| Tabs: hitches a second / longest frame, ms | 4.7 / 122 | 4.5 / 136 | -, a hint | no |
| Tabs: footprint before / after 42 switches, MB | 118.7 / 125.8 | 117.3 / 125.1 | 5 MB | no (one base run read 206.6 after, as one did at the baseline) |
| At rest: CPU %, interrupt wakeups a second | 0.11, 1.4 | 0.11, 1.3 | 0.03 points | no |
| Three turns running: CPU % | 0.21 (0.07-0.21) | 0.20 (0.20-0.31) | 0.03 points | no (both scattered) |
| Covered, three turns running: CPU % | 0.12 | 0.13 | 0.03 points | no |
| At rest after the relaunch: footprint, MB | 100.8 | 99.9 | 5 MB | no |

In short: the final `n10/all` scrolls, switches tabs, sits at rest and holds memory as
the base does, within the noise of every number. The night's lasting gains are the
layout's own speed (a third quicker, which the bench does not see at this size) and the
shorter strip move; the scrolling gain went with the row-menu change the review undid.
The captures differ from the base's in one place only, + at the bar's far end, about
2,000 pixels in every capture (base against base: 0 to 30 in the still ones): + is a plain button now, not
a menu, and draws its circle a shade differently, the same to the eye. The space after
scrolling and the window after the switches also differ in some runs by about 230,000
pixels base against base, as the list stops at a slightly different place.

Checked as well on 57139140: `swift test` in Packages/PortalsKit (885 tests in 95
suites, and 491, 24, 23 and 19 in the other test products); `bridge/` the base's (no
difference from 2fab1af2); a Release Mac Catalyst build with the switches; a Release
build for generic/platform=iOS with CODE_SIGNING_ALLOWED=NO; a Release simulator build
launched on new iPhone 18 Pro and iPad Pro 13-inch (M5) simulators with the sidebar out,
four tabs opened and six tab switches made by the app (both running after 25 s, every
switch in the probe, no crash report); and no crash report from the bench's scratch
copies.

## Tab switching speed, night n11 (branch tab-speed)

the ask for the night of 2026-10-25: "optimize tab switching speed and responsiveness
as much as possible without sacrificing functionality or other huge tradeoffs", memory
kept low by default, a bigger cache only as an option with its numbers. The goal set for
it: the time from choosing a tab until its chat is on screen, apart for a tab shown a
moment ago (a return) and one not built (a first visit), and what follows the switch;
nothing else slower (⌘S, scrolling, at rest, turns arriving) and nothing else different.

What the branch does, on top of main a1515856, each its own commit:

1. **The chats shown lately stay built** (an earlier helper's commit, kept): where the
   tabs are (a Mac, an iPad beside its sidebar), the chat on screen and the four shown
   before it that are still tabs are drawn in one stack, those out of sight transparent,
   taking no clicks, not read out, holding their moving parts and the pieces of a reply
   still (`Fleet.keptChats`, `ThreadController.isKeptOffScreen`). Going back to one shows
   it as it was left. A phone, and an iPad in a narrow window, build each chat anew.
2. **A switch works out the chats, not the whole screen**: the chats are a view of their
   own (`ChatDeck`), the only one besides a small modifier (`ChatWatch`) that reads the
   chat on screen; the swipe guard every button reads holds the screen's slide instead
   of a closure made in MainScreen's body (a new value at each update, which had every
   view reading it, in every chat kept, worked out again: SwiftUI's instrument counted
   16 environment updates of ChatScreen a switch from it); the Macs' names are the same
   dictionary while they are the same.
3. **⌘S as before**: a chat out of sight keeps the size the deck had as it left the
   screen, by the deck's top trailing corner, which stays put beside the sliding
   sidebar, and the wash's bleed it left with: the slide lays out and moves the chat on
   screen alone. Each frame of it moved every kept chat's UIKit views before (setCenter,
   and the geometry notices of every reply's text view).
4. **The tabs' titles change weight at once** while the tabs still move and widen as
   before: morphing glyphs between the two weights over the motion were a fifth of a
   switch's CPU.
5. **The sidebar's rows mark the thread on screen by a flag of their own**
   (`Fleet.currentRows`): a switch draws the two rows it changes, not the sidebar's lists.

The base (main a1515856 with the bench kit, 54e1ef2d) against a Release build of the
branch at 973177ab with the switches, three rounds interleaved (base, final, base,
final…), 600 threads, the gui lock held, 2026-10-25 05:55 to 06:43, load averages 2.3 to
3.4. The bench copy's window was partly covered by other windows in every run (552 of
the watcher's samples saw a window in front), so the frame and hitch numbers are rough;
the in-app times (`tab_frame`, `drawn`, `content`) and the CPU counts are the ones to
go by. Medians, the lowest and highest run in brackets. Results under
/private/tmp/portals-tab-speed/bench/final-ab/.

| Scenario | base | branch | Change |
|---|---:|---:|---:|
| **Going back** to a tab shown a moment ago (`tabsreturn`): chat drawn, ms | 83.1 (81.4-86.6) | **37.0** (33.9-37.2) | -55% |
| Going back: a frame showing its turns (`content`), ms | 100 (99-102) | **36** (32-36) | -64% |
| Going back: 90th percentile / longest drawn, ms | 93.3 / 126.0 | 46.3 / 62.4 | -50% |
| Going back: CPU a switch, ms | 188.4 | 108.6 | -42% |
| Going back: missed frames while switching, ms a second | 145.2 | 66.2 | -54% |
| **Mixed switches** (`tabs`: ⌃Tab, ⌘1-9, clicks; 15 of 43 to a kept chat): drawn, ms | 76.1 (73.1-80.8) | **54.6** (53.6-55.4) | -28% |
| Mixed: `content`, ms | 96 (95-96) | 73 (73-78) | -24% |
| Mixed: CPU a switch, ms | 199.8 | 142.3 | -29% |
| Mixed: missed frames, ms a second / longest frame, ms | 138.0 / 124 | 95.4 / 92 | -31% |
| **First visits** (`tabsfar`: the tab shown longest ago, built anew from its saved copy): drawn, ms | 82.2 (82.0-85.6) | **72.1** (70.4-74.1) | -12% |
| First visits: `content`, ms | 99 (97-103) | 87 (87-88) | -12% |
| First visits: CPU a switch, ms | 203.1 | 160.2 | -21% |
| ⌘S ten times: main thread until the next frame, ms | 25.8 (24.5-29.0) | 28.4 (27.0-29.4) | +10% (noise 12%) |
| ⌘S: CPU a toggle, ms | 246.5 (243.9-249.4) | 257.6 (257.5-261.4) | **+4.5%** (noise 3%) |
| ⌘S: missed frames, ms a second / hitches a second | 18.1 / 0.8 | 19.2 / 0.8 | same |
| Scroll (the space, every thread listed): missed frames, ms a second | 7.8 (5.3-10.5) | 8.8 (5.3-9.5) | noise 25% |
| Scroll: CPU, % of a core | 3.79 (3.69-3.97) | 3.96 (3.94-4.02) | +4% (noise 3%) |
| Turns from another device: missed frames, ms a second | 35.4 | 33.8 | same |
| At rest, twelve tabs: CPU %, interrupt wakeups a second | 0.10, 1.3 | 0.10, 1.4 | same |
| Three turns running in tabs not on screen: CPU % | 0.07 | 0.07 | same |
| Covered, three turns running: CPU % | 0.11 | 0.11 | same |
| Three turns running in tabs shown a moment ago, kept (`keptrun`): CPU %, interrupt wakeups a second | 3.77, 13.0 | 3.18, 3.3 | -16%, -75% |
| Footprint, twelve tabs just opened, MB | 84.3 | 105.0 | +21 MB |
| Footprint while switching (before / after 42 switches back), MB | 110.5 / 109.9 | 134.5 / 136.5 | +24 to +27 MB |
| Footprint at rest after a relaunch (one chat built), MB | 89.8 | 89.5 | same |

⌘S: the frames and hitches are the base's; the process's CPU a toggle is 11 ms more
(+4.5%, again +3.7% in a two-round run before). Time Profiler sees the main thread
alike (2237 against 2249 samples over the ten toggles); what is more is SwiftUI's
animation of the deck's places for the four chats out of sight (their places, not the
chats, follow the sliding deck), with some glass work. Two ways tried to take it away
cost more elsewhere (the chat area kept still with the chat inset by padding:
265 ms a toggle, first visits 63 ms against 56; UIKit-hosted chats: 353 ms).

Tried and left out (numbers from one or two rounds each, against the build before):

| Tried | What it did | Why not |
|---|---|---|
| Kept chats sized as the deck (as handed over, `PORTALS_DEBUG_KEPT_FREEZE=0`) | ⌘S: 36.8 ms to the next frame, 298 ms CPU a toggle (kept in place: 25.1, 267) | the ⌘S regression |
| Each kept chat in a UIKit hosting controller of its own, hidden as a UIKit view | returns 30.7 ms (37.3), first visits 73.2 (56.1), ⌘S CPU 353 (264) | first visits and ⌘S much worse |
| The same, the hidden ones out of the window | returns 44.3, first visits 70.7 | worse |
| Kept chats drawn past the window's edge instead of transparent | returns 46.5 ms (36.2), footprint 99.5 MB (106.4) | the chat is drawn again as it comes back, and more |
| Kept chats drawn behind the one on screen, not transparent | returns 32.8 (35.4), first visits 64.0 (60.6) | within the noise, and the chats behind would show under the sidebar's fading edge mid-slide |
| The tab strip without motion (`PORTALS_DEBUG_TAB_MOTION=instant`) | CPU a switch 98.5 ms (171.9), returns 70.7 (125.5); time to the chat drawn the same | a visible change of the tabs' motion; kept as a switch for the user |
| No glass on the selected tab (measuring) | returns 32.8 ms (36.2) | a visible change; it shows the glass's share |
| The sidebar not marking the thread on screen (measuring) | returns 29.2 ms (36.2), first visits 51.2 (58.2) | led to the row flags (5) |

What fills a return now (Time Profiler, 0 to 50 ms after the switch, about 35 ms of the
main thread): SwiftUI's graph update 24 ms spread thin over the two chats changing
(their `isShown`, the environment that holds their moving parts), the tab strip's motion
starting (glass, frames), the sidebar's two rows, then Core Animation's commit 8-11 ms
(mostly the layers of the chat coming back into sight). No one
part is more than a few milliseconds; one frame (16 ms) would need the chat flip to
skip SwiftUI and Core Animation both, which the UIKit-hosted deck above did not do.

**The option for the user: every tab kept built** (`PORTALS_DEBUG_KEPT_CHATS=11`, 12 tabs):
one round against the default in the same build (deck11 run, 07:00-07:14, load 2.4-3.1):

| | default (4 kept) | every tab kept |
|---|---:|---:|
| Mixed switches: drawn / `content`, ms | 58.8 / 77 | **35.9 / 35** |
| Going back: drawn, ms | 36.4 | 32.0 |
| To the tab shown longest ago: drawn / `content`, ms | 69.2 / 86 | **36.4 / 35** (every one kept) |
| CPU a switch, mixed / going back / longest ago, ms | 142.1 / 105.7 / 159.3 | 138.4 / 114.1 / 132.9 |
| Footprint, twelve tabs just opened / after the switches, MB | 104.4 / 121.9-132.4 | 145.6 / 180.9-189.1 (**+41 to +67 MB**) |
| ⌘S: next frame, ms / CPU a toggle, ms | 27.7 / 269.0 | 31.3 / 288.3 (+7%) |
| At rest after a relaunch, CPU % / footprint, MB | 0.10 / 90.1 | 0.09 / 89.2 |

So every tab kept makes every switch after a tab's first visit since launch about a
return (32-36 ms), for 40 to 70 MB more with twelve tabs and ⌘S a little dearer again.
It is a launch switch only (`PORTALS_DEBUG_KEPT_CHATS`, DEBUG builds); making it a
setting, or the default, is the call. Not built: building the tabs not yet shown at
idle after a launch, which would make first visits returns too.

Checked as well on 973177ab: `swift test` in Packages/PortalsKit (890 tests in 95 suites
passed); a Release Mac Catalyst build with the switches; a Release simulator build
launched on new iPhone 18 Pro and iPad Pro 13-inch (M5) simulators with five tabs
opened, sixteen switches and ten sidebar toggles made by the app (both running after
them, every switch in the probe, no crash report).

## Night n11: tab switching speed (the final A/B, with Codex's attempt)

Codex worked on the same ask on its own the same night (worktree portals-tab-speed-codex,
branch tab-speed-codex, one commit kept: 7c357bbd
on that branch). Its answer and its commit were read once it had finished (07:20), and
what it found that this branch had not was tried here, measured the same way.

**Where the two attempts agree.**

- Rebuilding and laying out `ChatScreen` on every switch is most of a switch's cost, with
  the tab strip's animation after it (Codex's profile: 92 ms of the main thread in the
  first 120 ms, then 82 ms over the animation; the same picture as above).
- A chat hosted in a `UIHostingController` of its own is not the way: it lowered the
  median and CPU but made the slow switches slower (Codex: return p90 117 → 158 ms; here
  first visits 56 → 73 ms and ⌘S CPU 264 → 353 ms), and Codex also saw the native sidebar
  and new-tab buttons lost under it.
- The tab titles' morph over the motion costs: Codex's profile saw 13.4 ms a switch of
  interpolated text drawing; this branch snaps the titles' weight.
- Reading a thread's saved copy is not the problem (Codex: 1-3 ms).

**What only Codex found:** a single-turn chat that already fits on screen waited for the
settling frames before it was shown, though its one turn is always built. Taken here as
8f634ccb (`ChatScreen.revealChat`, with `PORTALS_DEBUG_REVEAL=settle` to switch it off).
Measured on this branch in one build, three rounds interleaved, 07:26-07:40, load 2.5-7.1
(reveal-ab):

| | settle as before | revealed at once |
|---|---:|---:|
| First visits (`tabsfar`): `content`, ms | 87 (86-87) | **73** (73-78) |
| Mixed switches: `content`, ms | 77 (77-78) | **62** (55-64) |
| Going back: `content`, ms | 34 (32-36) | 31 (30-31) |
| CPU a switch, mixed / first visits, ms | 144.6 / 159.0 | 145.1 / 158.8 |

**What only this branch found:** keeping the chats shown lately built works once nothing
makes them all update at each switch. Codex built a cache of eight retained chats too
(hosting views detached from the window) and measured it slower than main (returns 95 →
203 ms, 355 ms CPU a switch, +61 MB) and dropped it; here the swipe guard closure made in
`MainScreen`'s body was found to update every view reading it in every kept chat at each
switch, and with that gone (and `KeptChat` compared by what it shows) the kept chats make
returns 2.5 times faster. Also only here: ⌘S with kept chats (`KeptSizes`), the sidebar's
row flags (`Fleet.currentRows`), the title snap, `ChatDeck`/`ChatWatch`.

**The final A/B.** main a1515856 with the bench kit's app side (54e1ef2d), this branch at
eed187e4 (everything above, the reveal and the review's fixes below), and Codex's head
7c357bbd with the same bench-kit file (TabsBench.swift), Release Mac Catalyst builds with
the switches; three rounds interleaved (main, branch, Codex, main…), 600 threads, every
scenario, the gui lock held, 2026-10-25 08:18 to 09:30. Load at each run's start 2.6 to
4.6, but main's first run at 12.2 (a test run of mine had just finished; its numbers sit
with the other two rounds' but for restore, so medians are kept). The copy's window was
partly covered in every run (828 watcher samples saw a window in front): frames and
hitches are rough, the in-app times and CPU are the ones to go by. Medians, lowest and
highest run in brackets. Results: /private/tmp/portals-tab-speed/n11/bench/final-ab/.

| Scenario | main | this branch | Codex's branch |
|---|---:|---:|---:|
| **Going back** to a tab shown a moment ago: chat drawn, ms | 83.7 (80.3-86.5) | **33.1** (30.9-37.0) | 85.7 (83.9-87.5) |
| Going back: a frame showing its turns (`content`), ms | 103 (100-104) | **32** (30-36) | 100 (98-103) |
| Going back: drawn p90 / longest, ms | 92.8 / 121.8 | 42.1 / 62.8 | 93.4 / 124.2 |
| Going back: CPU a switch, ms | 186.7 | 106.6 | 188.6 |
| Going back: missed frames, ms a second | 148.3 | 62.3 | 142.2 |
| **First visits** (the tab shown longest ago, built anew): drawn, ms | 82.1 (75.5-82.9) | **71.3** (68.4-72.0) | 84.2 (84.0-85.6) |
| First visits: `content`, ms | 100 (97-100) | **78** (77-81) | 86 (85-87) |
| First visits: `content` p90, ms | 124 | 104 | 120 |
| First visits: CPU a switch, ms | 201.3 | 160.2 | 203.5 |
| **Mixed switches** (⌃Tab, ⌘1-9, clicks; 15 of 43 to a kept chat): drawn, ms | 78.6 (74.9-79.9) | **55.7** (50.2-59.3) | 78.8 (74.9-85.4) |
| Mixed: `content`, ms | 96 (95-97) | **61** (61-62) | 92 (86-96) |
| Mixed: CPU a switch, ms | 200.7 | 143.3 | 200.5 |
| Mixed: missed frames, ms a second / longest frame, ms | 138.2 / 108 | 94.4 / 92 | 141.0 / 129 |
| ⌘S ten times: main thread until the next frame, ms | 26.6 (26.1-27.8) | 28.9 (28.8-29.3) | 28.4 (25.6-29.2) |
| ⌘S: CPU a toggle, ms | 245.5 (244.6-248.7) | 253.1 (230.0-257.1) | 246.2 (245.0-250.4) |
| ⌘S: missed frames, ms a second / hitches a second | 18.9 / 0.9 | 21.2 / 1.1 | 19.0 / 1.1 |
| Scroll (the space, every thread listed): CPU, % of a core | 3.89 (3.76-3.93) | 4.14 (4.11-4.14) | 3.76 (3.76-3.96) |
| Scroll: missed frames, ms a second / longest, ms | 7.7 / 32 | 10.2 / 42 | 9.2 / 37 |
| Turns from another device: missed frames, ms a second | 35.4 | 35.2 | 33.8 |
| Launch with the tab put back: chat shown / drawn, ms | 234.8 / 593.9 | 231.1 / 584.6 | 238.8 / 596.9 |
| At rest, twelve tabs: CPU %, interrupt wakeups a second | 0.10, 1.3 | 0.10, 1.4 | 0.10, 1.3 |
| Three turns running in tabs not on screen / window covered: CPU % | 0.07 / 0.10 | 0.07 / 0.10 | 0.07 / 0.12 |
| Three turns running in tabs shown a moment ago (`keptrun`): CPU %, interrupt wakeups a second | 3.93, 12.3 | 3.18, 3.3 | 3.78, 12.3 |
| Footprint, twelve tabs just opened, MB | 84.4 | 104.8 (+20) | 84.5 |
| Footprint while switching (before / after), MB | 100.6-111.4 | 122.4-136.9 (+22 to +26) | 100.8-111.9 |
| Footprint at rest after a relaunch, MB | 89.8 | 89.4 | 89.5 |

Codex's change alone makes first visits' turns show 14 ms sooner (100 → 86) and little
else; here it is in, and the kept chats do the rest.

What costs more on this branch than on main, all small:

- ⌘S: about 8 ms (3%) more CPU a toggle and 2 ms more until the next frame, hitches
  alike (as before: the places of the four chats kept out of sight follow the sliding
  deck).
- Scrolling the sidebar's space: about 0.25% of a core more (4.14 against 3.89%; frames
  within their noise). It is the kept chats: the same build with none kept
  (`PORTALS_DEBUG_KEPT_CHATS=0`) scrolls at 4.00% against 4.22% kept, three rounds
  interleaved, 09:31-09:45, load 2.6-5.1 (scroll-kept). Not looked into further tonight.
- Memory: 20-26 MB with twelve tabs, for the four chats kept.

The option of every tab kept built (`PORTALS_DEBUG_KEPT_CHATS=11`, measured above: every
switch after a tab's first visit about 32-36 ms, for 40 to 70 MB more with twelve tabs)
stands as it was; Codex found no memory option that paid.

**The review.** Codex reviewed a1515856..8f634ccb read-only (thread "Review: fast tab
switching (n11)") and found two medium bugs, then one more in the re-check; all three are
fixed and re-checked, no high finding:

1. A run's tool output held while its chat was kept out of sight grew without a bound:
   every progress (the output's tail anew, up to four 8 KiB tails a second) was kept and
   replayed on the way back. Fixed in 80850a16: progress is folded into the last one held
   of its tool, status lines into the last status (HeldPiecesTests).
2. A hidden chat kept the keyboard: text selected in a reply of tab A, then ⌃Tab to B,
   and the keys typed next went into A's draft and focused A's composer, out of sight;
   pictures read for A's composer after leaving took the focus back. Fixed in ba1d80f6.
3. (re-check) The same with a question's own answer, an approval's or a plan's note.
   Fixed in eed187e4: those fields let go of their focus as the chat goes out of sight,
   and whatever holds the keyboard under a view drawn nowhere is resigned
   (`OutOfSightFocus`).

Checked on eed187e4: `swift test` in Packages/PortalsKit, all five test products (891,
491, 24, 23 and 19 tests) passed (one run under a simulator check's load reported a
HermesBackendTests failure that did not come again, alone or in a quiet full run); the
Release Mac Catalyst build; the Release simulator build on new iPhone 18 Pro and iPad Pro
13-inch (M5) simulators, five tabs, sixteen switches and ten sidebar toggles each (both
running after them, 18 switches and 11 toggles in each probe, no crash report, the
screenshots right). Not tried by hand (no input could be sent at night): typing after a
switch with text selected or an answer field focused, drafts and scroll positions per
chat, closing a tab while its chat is kept, VoiceOver over the kept chats.

## How to measure again

    # A Release build with the switches (as scripts/mac-scroll-bench.sh says), then:
    /private/tmp/portals-n10/scripts/lock.sh take gui <you>
    scripts/tabs-bench.sh --rounds 3 base=/private/tmp/portals-n10/baseline/base/Portals.app after=<your .app>
    scripts/tabs-bench.sh --rounds 3 --threads 2000 --only scroll,tabs,restore,idle base=… after=…
    /private/tmp/portals-n10/scripts/lock.sh release gui <you>
    # One scenario only: --only tabs (or tabsreturn, tabsfar, sidebar, keptrun, scroll, turns,
    # renames, restore, idle, spaces). Several switches for one app: label=<app>@NAME=value@NAME=value.
    # Another Instruments template: PROFILE_TEMPLATE=SwiftUI with --profile.
    # Profiles: --profile --rounds 1, then for each OUT/<run>/*.trace:
    xcrun xctrace export --input tabs.trace \
      --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]' > tabs.xml
    scripts/tabs-bench/appframes.py tabs.xml
    scripts/tabs-bench/afterswitch.py tabs.xml NewTabButton RBInterpolatedDisplayListContents
    # The layout alone:
    cd Packages/PortalsKit && PORTALS_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter SidebarBenchmarks
    # A simulator build launching on a new iPhone and iPad simulator, sidebar out:
    scripts/tabs-bench/sim-check.sh <Release-iphonesimulator/Portals.app> <out dir>

The bench uses ports 9501 (and 9502 for spaces; PORT and PORT2 choose others, 9511 to 9569
for other agents side by side), the bundle id
`com.danielou.portals.n10-tabs`, and removes the copy's settings and scratch homes after
each run. It takes about 7 minutes a run with every scenario at 600 threads.

## Ten chats kept, and a kept chat's screen alone (2026-10-26)

the ask: ten chats kept built where the tabs are, on an iPad as on a Mac ("10 threads
is ok", "ipad should keep 10 as well"), and could a chat kept out of sight keep only what
is on its screen ("u can maybe show like whats on the screen and a page up")? Measured on
Release copies with the switches (main 7bd3649f, and the same with the experiment), ten of
the user's own threads opened as tabs from the MBP16 bridge, then the first shown again,
read 60 s after, two rounds each, interleaved:

| | footprint, MB | malloc, MB | text views |
|---|---:|---:|---:|
| main, five kept | 188, 189 | 88, 89 | 42, 42 |
| main, ten kept | 172 (loading still), 229 | 77, 112 | 54, 108 |
| ten kept, out of sight only the screen and a page above (`TranscriptTrim`) | 237, 254 | 93, 113 | 57, 99 |
| the same build with every built turn kept (`PORTALS_DEBUG_KEPT_TRIM=0`) | 265, 266 | 111, 115 | 108, 108 |

The day before, on main 241c8c89, ten kept took 267-270 MB against five kept's 206-209
(three rounds each). Core Animation's and IOSurface's dirty memory (the drawn pictures)
came and went between 0 and 70 MB from one run to the next, as the system kept or let go
of the hidden window's backing stores; the malloc and text view counts are steadier.

The trim saved 2 MB of malloc and nine text views of 108: next to nothing, and it was not
kept. An agent's thread is one to three turns, each one long run (nine of these ten:
340-770 KB of one turn's steps and replies, the tenth 33 turns), and a chat is built a
turn at a time (`TranscriptTurn`): the turn on screen is most of the chat, and the margin
above the screen a page reaches into is a few hundred points of it. Keeping less would
mean building a long turn a piece at a time, a change to how turns are laid out, not to
the kept chats. Kept: ten chats (`MainScreen.chatsKeptBehind`, nine behind the one on
screen), and every kept chat let go of on a memory warning (`Fleet.letGoOfKeptChats`).
