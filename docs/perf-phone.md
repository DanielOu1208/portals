# The phone's lag and heat (night of 2026-10-19, track `perf`)

the ask: on the phone, scrolling the chat and
the sidebar and going between them run at a low frame rate; the app is slower with two
or three threads running; the phone gets very warm while the app is in use; after a
restart it seemed a little better. Everything here was measured on an iPhone 18 Pro Max
**simulator** (iOS 27) on the MBP16 while other agents compiled, never on a phone: a
simulator runs the app on the Mac's CPU, draws with the Mac's GPU, at 60 Hz. Compare
its numbers with each other, not with a phone.

## In short

- **Debug or Release is not what makes the phone slow.** The phone and iPad have always
  been installed as Debug builds (`-Onone`). The same states measured on a Debug and a
  Release build of 06f3482 differ by 4 to 15%: a streamed reply 13.5 against 12.8 CPU
  seconds, scrolling the chat while three threads stream 14.8 against 13.9, going
  between the sidebar and threads while they stream 5.1 against 4.7, at rest and
  scrolling with nothing running the same. Most of the app's work is in SwiftUI,
  UIKit and Core Animation, which are optimised in either build. Release is still the
  better build to install (below), but expect a little, not a cure.
- **The night of 2026-10-18 (n4) did not make the phone's CPU work worse.** Release builds
  of 15a49fa (before n4), a217ee0 (n4) and 06f3482 (what the phone runs, with the
  visuals) in the same scenarios: a reply streaming in the thread on screen cost 17.1,
  12.4 and 12.7 CPU seconds; scrolling, opening threads and the sidebar the same in all
  three; the busy states (three threads streaming while you scroll and switch) about a
  quarter cheaper since n4. What n4 changed that a simulator cannot show is the GPU: the
  wash is now drawn by Metal 30 times a second into a layer of its own (its thread
  takes 0.8% of a core here, the main thread nothing). Whether that, or the display
  composing it, is what warms the phone can only be seen on the phone (the recipe at the
  end).
- **Where the app's CPU goes:** at rest on a thread 1.1% of a core; three threads
  streaming while the one on screen rests 1.5%; a reply streaming in the thread on
  screen (two others streaming too) about 20%, five sixths of it on the main thread,
  for as long as replies come. That is the state that costs: watching a thread work.
  Scrolling costs 12 to 17% of a core while it moves, and opening a thread from the
  sidebar has frames of 150 to 200 ms (the opening thread finding its end, hidden).
- **Found and fixed:** every piece of a reply on screen (12 to 30 a second) had the whole
  chat screen worked out again, about 3 ms of the main thread each, though the reply's
  text is eased in at 20 steps a second whatever the pieces. A reply in half as many
  pieces cost 14% less (12.66 against 10.90 CPU seconds, the same reply). Now the pieces
  of the reply on screen change the thread at most ten times a second (`PiecePacer`):
  a reply costs 11.57 CPU seconds where it cost 12.78 (−9.5%), the main thread 9.57
  where it took 10.87 (−12%). It looks the same: the reveal still steps 20 times a second.
- **After 50 minutes of use the app cost a little more** (a reply 9%, at rest 0.4 points),
  and a relaunch took it back: most of what grew is accessibility nodes the UI test's
  accessibility makes SwiftUI keep, and the threads opened meanwhile that were still
  running (+6.5% a reply for two of them). No display link, layer or web view was left
  behind (below).

## How it was measured

All of it is in scripts/phone-bench.sh and scripts/phone-bench/ (each script's header
says how to run it):

- **phone-bench.sh**: builds against each other, A, B, A, B…, on a scratch bridge with
  only the fake agent (port 9374), a copy of the app installed afresh for every launch
  (its own bundle id). States: `idle` (10 s on a 45-turn thread), `off` (three other
  threads stream the fake agent's minute-long reply, bridge/src/providers/fakeBench.ts),
  `on` (three threads stream, the one on screen among them), and a standalone UI test
  (scripts/phone-bench/uitest/PerfUITests.swift, in a throwaway Xcode project that drives
  the installed copy by bundle id): 16 flings of the chat, four trips to the sidebar and
  into a thread, 12 flings of the sidebar; then the same while three threads stream. For
  every stretch: the app's CPU (process time, including workers that ended) and its
  main thread's CPU time (phone-bench/threads.py), CPU seconds (the work done, steadier
  than a percentage on a loaded Mac), the app's frame meter (FrameMeter.swift: hitch ms
  a second, frames a second, longest frame), the wash's frames a second, idle wake-ups,
  memory.
  Poll-derived `cpu` and `main` remain authoritative in the results; the standalone
  sampler's diagnostics are `sample_cpu` and `sample_main`. For historical logs with
  duplicate keys, medians keep the first measurement instead of overwriting it.
- **reply-cost.sh**: the steadiest number: the app's CPU seconds over one whole reply
  streaming into the thread on screen and two others, four replies per build, A/B. Its
  spread was ±0.3 s on 12.7.
- **trace.sh**: a Time Profiler recording of a state, summarised by
  scripts/app-footprint/timeprofile.py.
- **soak.sh**: one process measured at rest and with four threads streaming, kept busy
  for 50 minutes (three threads streaming reply after reply while the UI test scrolls
  and switches, over and over), measured again, then relaunched on the same data and
  measured a third time; the objects alive that keep work going (`heap`) each time.

Two things learned on the way, for whoever measures next:

- **XCUITest's look at the app is expensive.** Each time a UI test asks where something
  is, the app's accessibility tree is snapshotted: about 0.1 s of the main thread for a
  chat (most of it SwiftUI turning every `Text` into attributed text), 17% of a core at
  two a second. The UI test therefore finds its points before measuring and touches
  through SpringBoard's coordinates (`XCUIApplication(bundleIdentifier:
  "com.apple.springboard").coordinate…`), which asks SpringBoard, not the app. The app
  still keeps its accessibility tree up to date while a test is attached (about a seventh
  of its samples in a profile of the UI test): the stretches' absolute numbers include
  that, the comparisons do not suffer from it. Earlier nights' simulator UI numbers
  (n4) were taken with element queries and include more of it.
- **Which thread a launch opens first is not settled** among many threads with a fresh
  install (`PORTALS_DEBUG_OPEN_EACH=1`, the first in the app's list as it arrives):
  reply-cost.sh, trace.sh and soak.sh launch on a bridge holding only the long thread
  and make the others afterwards. phone-bench.sh does not, and in its runs the thread on
  screen was one of the 10-turn threads, which streamed in both `off` and `on`: its
  `off` numbers are a second `on`. The `off` state (three threads streaming, the one on
  screen at rest) was measured in the earlier attempts, where the thread on screen was
  not among them: 0.8 to 1.0 CPU seconds a minute, 1.5% of a core.

## The numbers

Release builds with the launch switches compiled in (`SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`)
unless said, medians; load average 6 to 90 (other agents compiling), beside each run in
/private/tmp/portals-n5/bench/perf/.

**Debug against Release** (06f3482, 3 rounds; phone-bench.sh; `dbg-rel/`):

| State | Debug: CPU s (main) | Release: CPU s (main) | frames: Debug / Release |
|---|---:|---:|---|
| at rest, 12 s | 0.2 | 0.1 | 60 fps / 60 fps |
| a reply on screen, whole (~64 s) | 13.5 (11.6) | 12.8 (10.9) | 60 / 60 |
| 16 chat flings, nothing running | 5.6 (5.4) | 5.5 (5.3) | 59 fps, 0.6 hitches/s / 59, 0.5 |
| 4 trips sidebar ↔ thread | 2.7 (2.5) | 2.7 (2.5) | longest frame 165 / 146 ms |
| 12 sidebar flings | 3.4 (3.2) | 3.3 (3.1) | 57 / 58 fps |
| chat flings, three threads streaming | 14.8 (13.2) | 13.9 (12.4) | longest 122 / 125 ms |
| trips, three threads streaming | 5.1 (4.4) | 4.7 (4.1) | longest 208 / 186 ms |
| sidebar flings, three streaming | 5.6 (4.8) | 5.1 (4.5) | 58 / 58 fps |

**Before n4, n4, now** (Release, 2 rounds; `commits/`):

| State | 15a49fa | a217ee0 | 06f3482 |
|---|---:|---:|---:|
| a reply on screen, whole: CPU s (main) | 17.1 (15.8) | 12.4 (10.6) | 12.7 (10.9) |
| 16 chat flings | 5.5 | 5.5 | 5.4 |
| 4 trips sidebar ↔ thread (longest frame) | 2.8 (158 ms) | 2.8 (155 ms) | 2.7 (200 ms) |
| 12 sidebar flings | 3.2 | 3.3 | 3.3 |
| chat flings, three streaming | 17.5 | 13.0 | 13.9 |
| trips, three streaming (longest frame) | 5.8 (385 ms) | 4.5 (182 ms) | 4.6 (194 ms) |
| sidebar flings, three streaming | 6.5 | 4.8 | 5.3 |
| memory at the end (footprint / IOSurfaces) | 106 MB / 50.5 MB | — | 98–103 MB / 7.8 MB |

06f3482 is 2 to 10% over a217ee0 in the busy states, within two runs' spread but on the
same side every time: the visuals' work per block of a reply (fences, drafts) is the
likely share; a line for the visuals track is in progress.log.

**The fix** (reply-cost.sh, 4 replies each, A/B interleaved, load 5 to 9):

| | base 06f3482 | `PiecePacer` |
|---|---:|---:|
| CPU s a reply | 12.78 (12.7–12.9) | 11.57 (11.4–11.7) |
| main thread s a reply | 10.87 | 9.57 |
| (for scale: the same reply in half as many pieces, base) | 10.90 | |

## The suspects

- **The wash at 30 frames a second while any thread runs.** Only the thread on screen
  moves it (the chat's mood), not other threads: with three threads streaming off screen
  it was still (0 frames). While it moves, its own thread takes 0.8% of a core and the
  main thread nothing. Cleared for the CPU. Its GPU work and the display's composing
  30 times a second are not visible here: the first thing to look at on the phone.
- **Work per streamed piece for threads not on screen.** Three threads streaming off
  screen cost 1.5% of a core (their rows' spinners are drawn by Core Animation, the
  sidebar's rows are drawn again only when what they show changes). Cleared.
- **Work per streamed piece for the thread on screen.** Confirmed and fixed (above).
  Why each piece costs that much: `ChatScreen`'s body reads the thread's whole state
  (`chat.turns`, `chat.isEmpty`, `chat.state.queued`, `runStatus`, the title…), so it is
  worked out again, the composer and the header with it, for every change of the state.
  Splitting what the screen reads into values kept apart from the state (as `isRunning`
  is) and moving the transcript into a view of its own would take more off; not done
  tonight (a large change to a tuned file), written down below.
- **The reveal timer.** 20 steps a second while text is behind; each step lays out the
  reply's last block and draws it again. It is most of what a reply costs once the
  pieces are paced (about 9 of the 11.6 CPU seconds come with time, not with pieces).
  Not changed: fewer steps would show.
- **The avatars and logos per row.** Sidebar rows show a spinner (a `ProgressView`) for a
  running thread, no live avatar (only Aeri's pin has one). The chat header's avatar
  draws 30 times a second while the agent works: 0.6% of the samples directly, and it
  drives SwiftUI's display link, whose frames were 15 to 18% of the samples while a reply
  streamed (they also carry other updates). It is part of the look; left.
- **Things that grow over the app's life.** No display link, Metal layer, timer or web
  view was left behind after 50 minutes; what grew is in the soak, below.

## The soak

One copy of 06f3482 (Release), scripts/phone-bench/soak.sh: measured, then 50 minutes in
which three threads streamed reply after reply (148 replies) while the UI test flung the
chat and the sidebar and went between threads, over and over; measured again in the
same process; quit, launched again on the same data, measured a third time. Single
measurements, the reply's CPU seconds steady to ±0.3 s (reply-cost.sh):

| | at the start | after 50 minutes | launched again |
|---|---:|---:|---:|
| at rest, 12 s: CPU (main) | 1.5% (1.2%) | 1.9% (1.7%) | 1.5% (1.3%) |
| a reply in each of the four long threads, the one on screen among them: CPU s (main) | 12.71 (10.84) | 13.86 (11.84) | 12.03 (10.27) |
| footprint / the app's IOSurfaces | 147 MB / 4.7 MB | 117 MB / 7.7 MB | 102 MB / 4.3 MB |
| display links / Metal layers / timers / thread controllers alive | 2 / 1 / 2 / 1 | 3 / 1 / 3 / 3 | 2 / 1 / 2 / 1 |

So the app did cost a little more after a while (a reply 9% more, at rest 0.4 points
more) and a relaunch took it back, which fits what the user felt. What had grown
(`heap`, start → after → relaunched): SwiftUI's accessibility nodes (1 → 1,090
`AccessibilityNodeList`, 0 → 687 `AXCodeItem`, 0 → 570 `AccessibilityGeometryStorage`) and
`ScrollViewFocusableBorder` (23 → 1,811), which come from the UI test keeping
accessibility on (a phone without VoiceOver and the like would not build them, though an
accessibility user's would); and the threads opened during the soak that were still
running (three thread controllers, each with its stream, and one display link and timer
more), which is what anyone switching between running threads gets. Their cost, measured
on its own (reply-cost.sh with `OPEN_FIRST=2`: the app opens two of the running threads
before the one on screen): a reply costs 12.05 CPU seconds where it costs 11.31 with only
the thread on screen open, +6.5%, almost all of it off the main thread (9.43 against 9.31
s): their streams' events decoded and applied. No display link, Metal layer or web view
was left behind, and the memory went down rather than up (the start's footprint includes
making the threads). A phone used for hours, with VoiceOver off, was not tried: the
recipe's step 4 is the way to see it there.

## Left, and proposals

- **The chat screen worked out again with every change of the thread's state** (above):
  give `ThreadController` an outline of what the screen asks (empty or not, the number of
  turns, the last turn's id, whether it runs and how it ended, the last message's id, the
  queued messages, the run status, the title, the mode and model, the subagents) kept
  apart from `state` and set only when it changes, and move the transcript's `ForEach`
  into a view of its own that reads the turns. Then a piece changes only the transcript
  view and the last turn. Medium; worth it if the phone shows streaming as its cost.
- **Opening a thread** (the trips to the sidebar and back) has frames of 150 to 200 ms on
  the simulator, the same before and after n4: the lazy stack laying out the turns near
  the end while the thread is hidden (`EndSettling`). On a phone in Debug that may be
  what the user feels as "going between them".
- **The GPU and the display** cannot be measured here: the recipe below.
- **An app with accessibility on** (VoiceOver, Voice Control, Switch Control, some
  keyboards and password managers) keeps SwiftUI's accessibility tree up to date, which
  cost about a seventh of the app's work under the UI test, and a full look at a long
  chat takes 0.1 s of the main thread.

## Debug or Release on the phone

The phone, iPhone 15 Pro Max and iPad have been installed with
`-configuration Debug`. A Release build installs the same way:

    xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
      -destination 'id=<device>' -derivedDataPath <dir> -allowProvisioningUpdates build
    xcrun devicectl device install app --device <device> <dir>/Build/Products/Release-iphoneos/Portals.app

Nothing else changes: the signing is automatic with the Apple Development certificate in
both configurations (no `CODE_SIGN_IDENTITY` is set), so the profile is a development one
and the app can still be installed with devicectl and debugged; push stays `development`
in every configuration (`PORTALS_APS_ENVIRONMENT` in Config/Portals.xcconfig fills
the entitlement and the Info.plist key alike); the notification extension is built
Release with it. What a Release build lacks: the launch switches (`DebugLaunch` reads
them only in a simulator or Mac DEBUG build anyway, never on a phone) and the Web
Inspector on the visuals' web views (`isInspectable`, DEBUG only). A Release build for
a device was compiled without signing tonight (`-destination 'generic/platform=iOS'
CODE_SIGNING_ALLOWED=NO`): it builds.

## On a phone (Instruments on the device)

What the simulator cannot say: the GPU, the 120 Hz display, heat. With the phone on its
cable, unlocked, Developer Mode on, Portals in front:

1. **The build.** Install a Release build as above (keep the Debug one's build folder
   to go back). Same data: an install over the app keeps it.
2. **Frame rate.** Xcode → Open Developer Tool → Instruments → *Animation Hitches*, the
   phone as the target, Portals attached. Record 30 s each: scrolling the chat of a long
   thread; scrolling the sidebar; going sidebar → thread → sidebar four times; then the
   same while a thread streams on screen. Read the hitch time ratio (ms of hitches a
   second) and the frames' rate. Then the same on the Debug build: the difference is
   what the build costs on the phone.
3. **Heat.** Instruments → *Power Profiler* (CPU, GPU and display power, and the thermal
   state), 2 minutes with a thread streaming on screen, then 2 minutes with the same
   thread at rest on screen, then 2 minutes streaming with the sidebar out. The GPU
   share while streaming against at rest is the wash plus the text; if the GPU is high
   while only the wash moves, a build with the wash held still (`AmbientMood.calm` in
   `ChatScreen.washMood`, a one-line change for a test build, as the launch switches do
   not work on a phone) tells the wash's share.
4. **Over the app's life.** Note the hitch ratio and power of step 3's first stretch,
   use the app for an hour as usual, measure again, then quit it from the app switcher,
   open it and measure a third time.
5. **Where the main thread goes**, if steps 2–3 point at the CPU: *Time Profiler* on the
   phone, 10 s while a reply streams on screen, and read it as docs/perf-mac-scroll.md
   does.
