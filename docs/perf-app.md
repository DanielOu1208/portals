# What the app costs: memory and CPU on the Mac, iPhone and iPad

Taken on the night of 2026-10-15 (night 1 of 2, track `lean`, branch `n1/lean` from main
at 861a269). The bridge is not part of this: its costs are in the baseline notes, and
the ones seen from the app are written down for the Rust bridge at the end.

The user's own Mac app, at 04:50 that night, used 162 MB resident and about 17% of a core
while one of its threads ran. What follows reproduces that on a scratch copy, says where
it goes, and what was changed.

## In short

- **At rest, the avatar was the app's cost, the more so the longer the thread on
  screen** (each of its frames redraws a window full of text): 15.7% of a core at rest
  with a thread of 80 turns open, now 7.2%.
- **The avatar in detail.** The live avatar in the chat's bar was
  drawn 30 times a second for as long as it was on screen, and each of its frames
  redraws the window's picture: about 8.5% of a core with nothing going on, and 115 MB of
  graphics memory that is only kept while the window keeps being redrawn (a still avatar
  measured 0.1% and 89 MB). Now an avatar at rest is drawn eight times a second between
  blinks, and at the full rate for a blink or a change: about 4.8% at rest. Its slow drift
  moves a fraction of a point a frame, so it looks the same.
- **A covered window drew as much as a visible one.** On a Mac a window under others
  stays active and its animations go on. Now the avatars and the wash stop while no
  window of the app's can be seen (AppKit's occlusion state): covered at rest 0.1% of a
  core and 82 MB instead of 9.2% and 212 MB, covered while a reply streams 17% instead of
  29%.
- **The sidebar was worked out again for every word of a reply**, because whether a
  thread runs was read from the whole thread's state: about 8% of the app's CPU while a
  reply streamed. Now it is kept apart and changes only when it changes: 0%.
- **Every thread opened stayed in memory until the app quit**, with its transcript and
  the bytes of the files sent in it (up to 64 MB each). Now the threads at rest, off
  screen, and not among the eight looked at last are let go and opened again from their
  saved copy. With the bench's threads the transcripts are small (0.4 MB for a thread of
  80 turns); the file bytes are what this saves most.
- **What is left is the chat's** (the scroll track's files, not changed here): a long
  thread is drawn whole, every turn's text in its own backing store (a thread of 80
  turns costs about 200 MB on the Mac once open), each word of a reply lays the
  transcript out again (about 40% of the CPU while streaming, also while covered), and
  the Mac's wash draws a bitmap on the CPU at 30 frames a second while a reply streams
  (5 to 8%).

## How to measure (repeatable)

Everything runs on a scratch copy and a scratch bridge; nothing touches the installed
app or bridge.

1. **A build that reads the launch switches, optimised.** `DebugLaunch.swift` reads the
   `PORTALS_*` switches only under `DEBUG`, and it is the only code under `DEBUG`, so
   a Release build with that condition is the Release app plus its switches:

       xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
         -destination 'generic/platform=macOS,variant=Mac Catalyst' \
         -derivedDataPath /private/tmp/<you>/dd CODE_SIGNING_ALLOWED=NO ARCHS=arm64 \
         ONLY_ACTIVE_ARCH=YES 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG' build

2. **A scratch bridge with a realistic list** (the scripted agent only, in a new or empty
   home under /private/tmp, on the port given):

       node scripts/app-footprint/bridge.mts start /private/tmp/<you>/bridge 9342 400 <password>
       # 400 threads over 20 folders, every 10th a long one of 20 turns with tool rows
       node scripts/app-footprint/bridge.mts start /private/tmp/<you>/heavy 9352 60 <password> 1 80
       # 60 threads, every one 80 turns long
       node scripts/app-footprint/bridge.mts turns http://127.0.0.1:9342 <password> <thread> 2 "think tool slow please"
       # two turns of about 17 s each in a thread, as another device would start them

   The thread ids are in `<home>/ids.txt`, newest first. The scripted agent's words for
   longer turns are in bridge/src/providers/fake.ts.

3. **A scratch copy of the app** (`com.danielou.portals.footprint`), launched in the
   background against that bridge, and sampled:

       scripts/app-footprint.sh prepare <built Portals.app> /private/tmp/<you>/app
       pid=$(scripts/app-footprint.sh launch /private/tmp/<you>/app 9342 <password> PORTALS_DEBUG_OPEN_EACH=1:0.5)
       scripts/app-footprint.sh sample $pid "rest, thread open" 8
       scripts/app-footprint.sh stop /private/tmp/<you>/app

   Each launch makes a new home for the copy, and stop removes it: stop the copy before
   launching it again.

   `PORTALS_DEBUG_OPEN_EACH=<n>[:<seconds>]` opens the n most recent threads one after
   another (the log says "Opened each of n threads"); `=1:0.5` is the way to start with a
   thread on screen (`PORTALS_DEBUG_OPEN_LATEST` runs before the list has arrived).
   A sample line has the footprint (`footprint`'s phys_footprint, what Activity Monitor
   calls Memory) and its peak, the resident size, the CPU over the seconds given (from the
   process's own CPU time), idle wake-ups a second, threads, and the load average.

4. **Where the CPU goes**: Time Profiler on the scratch copy, read with
   `scripts/app-footprint/timeprofile.py` (its top says how). `heap <pid>` gives the
   heap by class; `footprint -p <pid>` the memory by kind (the graphics memory and
   CoreAnimation's backing stores are most of it); `vmmap --summary <pid>` the regions.

5. **States.** A thread is "on screen" when it is the most recent one (OPEN_EACH=1 opens
   it) and the turns run in it; "off screen" when the turns run in an older one. A
   window "covered" is under an opaque window of the same size: a small AppKit tool that
   shows one without activating anything (scripts/app-footprint/cover.swift). The app drops its connection when its
   window is minimized, hidden or on another Space, so those are the background state,
   where the avatars and the wash already stopped.

Other agents compiled on the same Mac all night: each number is the median of three
samples or more, with the load average written beside it in
/private/tmp/portals-n1/bench/lean-*.txt (kept until the Mac restarts).

## The numbers

The Mac (MacBook Pro 16, Catalyst, Release build with the switches, window 1180 × 820,
400 threads in the list, the scripted agent). Base is main at 861a269; after is this
branch. CPU is the percentage of one core.

| State | CPU base | CPU after | Footprint base | Footprint after |
|---|---:|---:|---:|---:|
| At rest, a thread open | 8.5% | 4.8% | 212 MB | 210 MB |
| At rest, a thread of 80 turns open (60-thread bridge) | 15.7% | 7.2% | 420 MB | 419 MB |
| A reply streaming in the thread on screen | 25.4% | 25.2% | 223 MB | 221 MB |
| A reply streaming in a thread off screen | 8.4% | 4.6% | 217 MB | 214 MB |
| At rest, the window covered by another | 9.2% | 0.1% | 212 MB | 82 MB |
| Streaming, the window covered by another | 28.6% | 17.1% | 221 MB | 145 MB |
| (the same two runs, window visible before covering) | 9.2% / 28.7% | 5.2% / 25.2% | 211 / 221 MB | 213 / 224 MB |

Medians of six samples (two launches of three) for the first three rows and of two for
the covered ones, from /private/tmp/portals-n1/bench/lean-final.txt, taken 06:25 to 06:40
with the one-minute load average between 3.4 and 8.5 (other agents building). The
covered footprint falls once the surfaces are let go, a few seconds after the window is
covered; streaming covered, the second sample was 87 MB.

Other readings:

| What | Base | After | How |
|---|---:|---:|---|
| Idle avatar, frames a second | 30 | 8, and 30 during a blink (0.18 s every 2 to 5 s) or a change | `AvatarCadence` |
| CPU at rest with the avatar not drawn at all (experiment) | | 0.1%, footprint 89 MB | avatar paused |
| CPU at rest drawing only blinks (experiment, not built) | | 1.2%, footprint 73 to 188 MB | rest gap 3 s |
| CPU at rest with the avatar on a task loop instead of TimelineView (experiment, not built) | | 3.1% (TimelineView 4.15%) | `.task` + `Task.sleep` |
| Sidebar's share of the CPU while a reply streams | 7.8% of samples | 0 | Time Profiler, 10 s |
| Heap after opening 30 threads of 80 turns | 126.2 MB | 117.0 MB | `heap` |
| Footprint after opening 30 threads of 80 turns | 482 MB | 473 MB | `footprint` |
| Footprint with one thread of 80 turns open | 416 MB | (same: the chat's) | `footprint` |
| Footprint after opening 40 threads of the 400 | 217 MB | 220 MB | (short threads: nothing to gain) |
| Launch to connected | 510 to 530 ms | 486 to 499 ms | the app's log |
| A sync step at 1000 threads, at rest | 0.027 ms | | SyncBenchmarks (Debug build) |
| A sync step at 1000 threads, one thread changed | 5.9 ms, 447 KB written | | SyncBenchmarks |
| The sidebar's layout at 1000 threads | 3.3 ms | | SyncBenchmarks |
| iPhone simulator (Debug), one thread open, rest | | 3.5% CPU, 48 MB | simulator |
| Waiting for an approval in the thread on screen | 13.3% | 10.7% | `waiting` pose at rest too |

Where the memory is on the Mac, at rest with a short thread open (footprint 205 MB):
113 MB is graphics memory owned by the app (Metal surfaces: the window's picture and
RenderBox's surfaces, kept while it is redrawn), 34 MB the heap's small allocations, a
few MB each the binaries' data, CoreAnimation and the rest. The heap itself is about
42 MB with 400 threads listed and 40 opened, most of it SwiftUI's view graph.

## What changed (commits on n1/lean)

1. `scripts/app-footprint.sh`, `scripts/app-footprint/bridge.mts`,
   `scripts/app-footprint/timeprofile.py` and the launch switch
   `PORTALS_DEBUG_OPEN_EACH`: the measuring above.
2. **The avatar's cadence** (`AgentCore/AvatarCadence.swift`, tested in
   `AvatarCadenceTests`; `AgentAvatarDirector.nextFrame(after:mood:style:)`,
   `AgentLiveAvatar`'s own TimelineSchedule). At the full rate (30 a second) while
   anything moves: a blink, for a second after a change of mood, look, gaze or shape, a
   mood that loops (thinking, talking), the waiting pose until its dot has popped up. At
   rest, eight a second, and every frame of each blink from its start. The timeline
   starts again from now when the mood or the look changes, and the schedule is told the
   mood and look about to be drawn (it is asked for the next date before the frame that
   starts a change is drawn), so a change is drawn at the full rate from its start.
3. **Run state kept apart** (`ThreadController.isRunning` and `pendingRequest` are
   stored, set from `state` only when they change). The sidebar, the list's marks and
   `Fleet.layout` read only these, so a word of a reply no longer redraws them.
4. **Threads at rest let go** (`AgentCore/OpenThreads.swift`, tested in
   `OpenThreadsTests`; `HostModel.letGoOfThreadsAtRest`). Kept: the thread on screen,
   every thread with a run, a question, an agent it set to work still at it, a message
   on its way or queued, being reopened or tried again, a command running, or a call to
   the host waiting on its answer (a change of model, level or mode, an answer, a Stop),
   and the eight at rest looked at last. Checked each time a thread is opened, each time
   a turn ends, at each poll of what is at work, and when the app goes inactive or to
   the background. A thread let go is saved first, and kept if the save fails (a full
   disk: it may hold a message that never reached the host); shown again, it shows its
   saved copy and is brought in line with the host, as after a launch. A thread let go
   never reopens itself on the host (that would take the host's news from the copy now
   shown), and while it is not followed, what the host last said of it (running,
   waiting) is kept. "Try again" on a message with files in a thread that was let go
   gives the words back to the composer, as it already did when the bytes were let go
   for size.
5. **Nothing drawn for a window no one can see** (`WindowVisibility` in Platform.swift;
   used by `AgentLiveAvatar` and, one line, by the wash in AmbientGradient.swift). On an
   iPhone and iPad it is never hidden; the scene's phase already covers the background.

## Found and left (for night 2 or the scroll track)

- **A long thread is drawn whole** (the chat). With one thread of 80 turns open the Mac
  app's footprint is 416 MB instead of about 205: CoreAnimation's backing stores 107 MB
  in 1795 regions (every turn's text has its own), and the view graph about 70 MB more of
  heap. "Older turns only built as you scroll up to them" is the fix the user allowed.
- **Each word of a reply lays the transcript out again.** While a reply streams, about 40%
  of the app's CPU samples are SwiftUI updating the graph and the layout of the transcript
  (`GraphHost.flushTransactions`), also while the window is covered (15% of a core).
  Coalescing words (a few at a time, allowed) and holding updates while no window can be
  seen would take most of it.
- **The Mac's wash** (`RasterWash`) renders a MeshGradient to a bitmap on the CPU
  (`ImageRenderer`) 30 times a second while a reply streams: 5 to 8% of the app's CPU.
  It also drifts while the agent only waits for the user's answer to an approval: then
  it is 36% of the app's samples, and the app 11% of a core (13.3% before this branch);
  a wash that holds still while the agent waits for you would take most of that. Done
  on 2026-10-15 (day, below).
- **iPhone simulator peak.** A Debug build in the simulator peaked at about 1.5 GB while
  opening ten threads one after another, of which one is the bench's long thread (a
  20,000-character reply, 10,000 characters of tool output, 2,000 of reasoning);
  opening the six most recent (short) ones peaks at 61 MB. At rest afterwards 76 to
  89 MB. Not attributed further: confirm on a Release build or a phone. On the Mac the
  same thread is far below that.
- **Interactive glass on every frame.** The composer's and the header buttons' glass
  (`.glassEffect(.regular.interactive())`) runs its spring (`FlexCoreInteractionModifier`)
  on each frame the window is redrawn: about 14% of the CPU at rest with the avatar at
  30 a second. Fewer frames (above) took most of it.
- **A device's sync rewrites its whole threads.json** at each change (447 KB at 1000
  threads, 2.2 MB at 5000), already in the baseline notes.

## Proposals (not built)

- **An avatar at rest that only blinks.** Built on 2026-10-15 (day, below), as the user
  decided it: the avatar holds still between blinks, and its gaze does not move during
  them either. Holding the gaze between blinks and moving it
  during each blink (as bloub hides its shape changes in a blink) measured 1.2% of a core
  at rest instead of 4%, and lets the Mac drop its surfaces between blinks (footprint 73
  MB between blinks, 188 MB during one). It changes how the resting avatar looks (its
  gaze stops drifting), so it is the call. One line: `AvatarCadence(rest: 3.0)`.
- **The avatar on its own layer.** Each avatar frame costs 2.5 to 5 ms of the main thread
  with a short thread on screen, and about 9 ms with a thread of 80 turns (7.2% at rest at
  eight frames a second), because it redraws the window's picture through SwiftUI and
  RenderBox (the update, the display list, the commit, the glass). The Mac's wash already
  avoids that by drawing itself into a bitmap (`RasterWash`); the avatar could do the
  same at its 44 or 64 points, or draw its paths into a CAShapeLayer. Drawn into a CAShapeLayer of its own (a
  UIViewRepresentable fed the engine's paths), a frame would be a layer's path change for
  the render server. Probably most of the remaining 4% at rest and of the thinking
  avatar's share while a reply streams. M.
- **Frames at rest without a display link.** A task loop instead of TimelineView for the
  resting avatar measured 3.1% instead of 4.15%. Mixed with TimelineView at the full rate
  (a task loop at 30 a second is not tied to the display and may judder). S.
- **Hold the transcript while no window can be seen**, and bring it up to date when one
  can be: the 15% left while covered and streaming. The chat's; S to M. Done on
  2026-10-18 (`n4/stream`, docs/perf-mac-scroll.md): a thread holds a reply's pieces
  while no window can be seen; covered while the bench's reply streams, 38% → 7.7%.

## Day of 2026-10-15 (branch `n2/polish`): an avatar that holds still, a wash that waits

the decisions 1 and 3 after trying night 1. **The avatar holds still between
blinks** in the moods that hold a pose (idle, listening, waiting, the end of happy): their
looks set bloub's drift of the gaze (`wander`) and of the body (`float`: its float and
breath) to 0, and glide it out as the mood starts; thinking and talking keep it. With
nothing moving between blinks, `AvatarCadence` at rest waits for the next blink (at most
three seconds), where it drew eight frames a second. **The wash holds still while the
agent only waits for an answer** (`ThreadState.waitsOnlyOnUser`: a request is open and no
subagent or workflow but the ones that asked is at work): it eases to the calm wash, which
the Mac draws once and not again (`RasterWash` skips a bitmap it has already drawn).

Measured as above (scripts/app-footprint.sh, scratch bridge of 400 threads, the newest
open), main 386565e against `n2/polish`, interleaved, six samples of 8 s each per row,
with other agents building (load 14 to 24):

| State | CPU main | CPU n2/polish | Footprint main | Footprint n2/polish |
|---|---:|---:|---:|---:|
| At rest, a thread open | 5.5% (5.1 to 6.2) | 1.4% (1.0 to 2.6) | 221 MB | 110 MB between blinks, 224 MB in one |
| Waiting for an approval in the thread on screen | 12.3% (9.4 to 12.8) | 1.95% (0.9 to 2.1) | 233 MB | 114 MB between blinks, 226 MB in one |

Checked: a harness that runs the app's own engine and director (copied out with the
AgentCore package) over all 48 looks (8 shapes by 6 faces) found every frame between
blinks identical in idle, listening, waiting and after happy for 40 s, the picture on
screen never stale under the new cadence, thinking and talking still moving, and every
change of mood gliding no faster than on main. On the Mac and the iPhone simulator the
chat bar's avatar changed only in blink pairs over several seconds, and the wash not at
all while an approval was open; on main both changed in every frame.

## For the Rust bridge

Nothing measured here costs the bridge more than it did; two things to know:

- Letting threads go means a thread looked at again after more than eight others is
  resumed again (`session.resume`, with its history) where it used to be followed all
  along. On a bridge where resuming a long session is costly that is a cost to keep low.
- At rest a device polls `sessions.activity` every 5 s while the sidebar is out, which on
  a Mac is always (16 small calls a minute, the baseline notes). The app's side of it
  costs nothing measurable; a push of activity changes would let both stop polling.

## The wash, 2026-10-18 (track `wash`, branch `n4/wash`)

the user, after the night of 2026-10-18 had started: "also keep trying to optimize the
background animation, must not sacrifice visuals in any major way. fps and resolution
must stay pretty high." His rule: the same look (the colours, the tints, light and dark,
the motion and its speed and amplitude, the easing in and out of motion, the listening
swell, the edge under the sidebar), never fewer than 30 frames a second while it moves,
never a smaller picture than before (1024 pixels on its long side on the Mac, the full
resolution on an iPhone and iPad), and no new banding.

### What it was, and what it is now

- **Before, on the Mac** (`RasterWash`): a display link on the main thread, 30 times a
  second, had SwiftUI's `ImageRenderer` draw the `MeshGradient` into a bitmap of at most
  1024 pixels on its long side (and one pixel a point in a smaller window), set as a
  layer's contents and scaled to the window. About 1 ms of the main thread a frame.
- **Before, on an iPhone and iPad** (`MeshWash`): a `TimelineView` rebuilt the
  `MeshGradient` 30 times a second, and SwiftUI updated, laid out and redrew it with the
  window around it.
- **Now, everywhere** (`Portals/Theme/GPUWash.swift`, the package target `Wash`): a
  Metal shader draws the same mesh into a layer of its own (`CAMetalLayer`), from a
  thread of its own ("Wash") with its own display link at 30 frames a second. The main
  thread hands it the palette, the background and the eased `presence` and `energy`
  when SwiftUI changes them, and does nothing per frame. Its picture is at most 1024
  pixels on its long side, scaled to the view, on every device: on the Mac the bound is
  on the mesh at its smallest, so that a tall window keeps its pixels too, and a small
  window has the screen's pixels (where it had one a point); on an iPhone and iPad (at
  the screen's full resolution at first, bounded later that day on request, below)
  it is on the whole layer. Where there is no Metal the SwiftUI mesh is drawn as before.
- **The same picture.** The shader draws the mesh as SwiftUI's `MeshGradient(points:,
  smoothsColors: true)` does, found by drawing probes with SwiftUI and fitting them
  (`Packages/PortalsKit/Sources/Wash/WashShader.swift` has the formulas): each
  point's Bézier handles a third of the way to each neighbour along the bisector of the
  two directions (an explicit `MeshGradient(bezierPoints:)` with these handles draws
  bit for bit what `points:` draws); each patch the Coons patch of its four edges; the
  colours as Hermite curves in their gamma-encoded sRGB values with tangents that never
  overshoot (0 at the mesh's edges and where a channel turns, else the mean of the two
  differences bounded by three times either), blended over the patch as a Coons patch;
  the same grid of cells (every patch n × n, n the smallest power of two for which the
  most any edge bends, in pixels, over n² is at most 4.5) split along the same diagonal; a
  fixed half-step of noise against banding, where SwiftUI dithers its 8 bits too. The
  colours are mixed without SwiftUI: `Color.mix` is a straight line in Oklab between
  the two colours (checked against SwiftUI to a millionth), so `WashScene` resolves the
  palette once and mixes it on the wash's thread.
- **Its time is gapless**: back from the background or a covered window it goes on from
  where it stopped, a frame later, instead of jumping ahead by the time it was away
  (`WashClock`, a step of more than a quarter of a second counts as one frame; asked for
  by the `return` track). The SwiftUI fallback (no Metal) keeps the wall clock, as
  before, and jumps ahead on return.
- **The swell no longer lays the view out**: the layer keeps the tallest height the wash
  reaches (65% of the screen) and the mesh covers the share its energy gives it, the
  page the rest. Before, the view's height followed the energy, ten times a second while
  listening.

### The look, compared

`swift test --filter WashLookTests` draws each case with SwiftUI's `MeshGradient`
(`ImageRenderer`, 8 bits, as the Mac drew it) and with the renderer (no dither), and
compares every pixel. With `WASH_LOOK_OUT=<folder>` it runs all 168 cases at 1024 × 460
(4 tints: blue, orange, green, ink; light and dark; presence 0, 0.5 and 1; energy 0, 0.5
and 1; times 0, 7.3, 123.4 and 4567.8) and writes both pictures and `report.tsv`;
otherwise 36 of them.

| Of 168 cases, the worst | |
|---|---:|
| any pixel, any channel | 2 steps of 8 bits |
| mean per pixel and channel | 0.37 |
| ΔE (CIE76), mean | 0.37 (0.26 to 0.46 a case) |
| ΔE, 99% of pixels under | 1.6 |
| ΔE, single pixels | 2.8 (2 steps near black) |
| mean signed difference over any 8 × 8 block | 0.84 of a step |

On the iPhone simulator's screen, the still wash of the app before (SwiftUI's
`MeshGradient` on screen) and after (the GPU), screenshots of the same screen in light
and dark: 0.22 and 0.09 steps apart on average over the wash, at most 2
(`iphone-still-4up-base-gpu7-base-gpu7.png`: before, after, before, after).

SwiftUI's own dither puts its pixels up to about 2 steps (0.42 on average) from an exact
drawing, so single pixels cannot be closer than that; the 8 × 8 blocks average the noise
out. The side-by-side stills (left SwiftUI, right the GPU) and six-second films (top
SwiftUI, bottom the GPU, the same instants) are in /private/tmp/portals-n4/shots/wash/
(`stills-left-before-right-after.png`, `side-by-side-{light,dark}-blue-…mp4`), and
recordings of the iPhone simulator drifting before and after
(`iphone-{light,dark}-{base,gpu6}.mov`), and the iPad simulator (`ipad-light-gpu7.png`).

### The numbers

Taken with scripts/wash-bench.sh (its header says how; the runs, logs and the apps'
frame logs are in /private/tmp/portals-n4/bench/wash/): Release builds with the launch
switches compiled in, base = 15a49fa plus the measuring switches (81bccae), against this
branch, A/B interleaved, medians of the runs, with the scripted backend in the app (no
bridge). States: **still** (nothing going on), **drift** (the wash held working by
`PORTALS_DEBUG_WASH=working`, nothing else changing), **listen** (held listening to a
made-up voice; the app has no way to reach listening yet), **stream** (the fake agent
streams its Markdown reply, a piece every 150 ms, the wash drifting) and **stream-calm**
(the same with the wash held still: the difference is the wash's share while a reply
streams). Four other agents were building at the same time: the load average is beside
each row. CPU is the app's own CPU time over 10 s, as % of a core.

**Mac** (MBP16, built-in display at 2056 × 1329 points, 2×, 120 Hz; a large window of
2056 × 1290 points, the whole screen but the menu bar, and a small one of 800 × 700,
where the mesh is 1024 pixels wide after and 403 to 582 high with the energy, and was
800 wide and 315 to 455 high before, a pixel a point).
Four rounds late in the night, when the Mac was quieter:

| State | CPU before | CPU after | WindowServer before | after | the wash's own drawing a frame | load |
|---|---:|---:|---:|---:|---:|---|
| still, large | 0.9% | 0.8% | 28.6% | 30.1% | none | 2.6 to 5.3 |
| drift, large | 6.8% | 4.2% | 38.4% | 35.4% | 1.38 → 0.30 ms | 3.1 to 5.0 |
| still, small | 1.2% | 1.1% | 42.8% | 41.8% | none | 3.0 to 5.3 |
| drift, small | 6.5% | 4.8% | 45.0% | 43.8% | 1.29 → 0.35 ms | 2.7 to 4.7 |

Listening and streaming, large window, two rounds (load 6 to 89), and listening in the
small window (two rounds, load 4 to 5.5):

| State | CPU before | CPU after | the wash's own drawing a frame |
|---|---:|---:|---:|
| listen, large | 13.1% | 5.3% | 1.62 → 0.32 ms |
| listen, small | 14.2% | 4.9% | 1.81 → 0.27 ms |
| stream, large | 24.2% | 23.9% | 0.86 → 0.22 ms |
| stream-calm, large | 20.9% | 21.0% | none |

- Drifting with nothing else changing, the wash cost the app 5.9 points of a core in
  the large window (6.8% against 0.9% still) and costs 3.4 now; 5.3 and 3.7 in the
  small one; listening (the height following the voice ten times a second, laid out each
  time) about 12 and 4. While a reply streams it is a smaller share of a busier app,
  whose runs differ by a few points from one to the next: 3.3 points before and 2.9
  after, the difference of two medians of two runs each, so read it as "a little less,
  and none of it on the main thread".
- The wash's own time a frame was on the main thread before (`ImageRenderer`), and is
  on its own thread now; a `sample` of 8 s drifting found the main thread busy for 183
  samples of 1 ms before and 25 after, and everything the wash runs (the main thread,
  its thread, Metal's and Core Animation's queues) about 280 before and 110 after.
- WindowServer, the Mac's render server, mostly draws what the other agents have on
  screen (24 to 47% of a core in these runs); what the wash adds to it while drifting
  did not grow, and may have shrunk in the large window (9.8 points over still before,
  5.3 after, medians of four noisy runs). Its frames reach it 30 times a second, before
  as a new bitmap for a layer's contents, now as a Metal layer's next picture.
- Memory: 6 MB more (the layer's two pictures and Metal's own). At rest the app's
  footprint goes between two levels with the avatar's blinks (the window's surfaces
  dropped between them, n1/lean): 66 and 180 MB before, 72 and 186 MB after, sampled
  every 3 s for 36 s, small and large windows, two rounds.
- Frames: 30 a second while it moves, before and after (30.0 in every run of the
  four-round table, counted by the app itself, `PORTALS_DEBUG_WASH_FRAMES`; the
  bench's first count, which a review found read a little low, gave 28 to 31).

**What more would cost, on the Mac** (same build, launch switches, 2 rounds):

| Drifting | CPU | memory |
|---|---:|---:|
| 30 a second, 1024 pixels (shipped) | 4.5% | 235 MB |
| 30 a second, full Retina (4112 × 1678 pixels) | 4.8% | 285 MB |
| 60 a second, 1024 pixels | 7.3% | 235 MB |

Neither is shipped, and the user settled both that day (no full Retina on the Mac, 30
frames a second everywhere): a picture at the full resolution costs 50 MB for a gradient
with nothing sharp in it (the `stream` track measured a 1024-pixel picture scaled up
within half a step of a full one on average), and 60 frames a second costs more than the
wash did before (7.3% against 6.2%) for a motion slow enough that 30 already carries it.

**iPhone simulator** (iPhone 18 Pro Max, iOS 27; a simulator draws with the Mac's GPU
and is not a phone: relative numbers only; render server = the simulator's backboardd;
the GPU wash here still at the screen's full resolution, before the bound below, which
changes the GPU's pixels and not the CPU's work):

| State | CPU before | CPU after | backboardd before | after | load |
|---|---:|---:|---:|---:|---|
| still | 0.7% | 0.6% | 0.6% | 0.6% | 48.39/7.74/38.47/6.89 |
| drift | 6.4% | 3.0% | 19.8% | 19.8% | 28.60/7.70/22.83/7.29 |
| listen | 8.2% | 3.5% | 24.6% | 20.0% | 23.28/6.98/19.53/5.97 |
| stream | 15.8% | 14.5% | 17.9% | 20.5% | 15.78/6.29/13.07/5.97 |
| stream-calm | 16.3% | 16.6% | 12.6% | 13.1% | 11.00/6.23/9.09/5.87 |

Drifting, the wash's cost to the app went from 5.7 points to 2.4 (SwiftUI no longer
updates and redraws the window for it), listening from 7.5 to 2.9. While a reply streams
the runs differ by more than the wash (the build before measured less with the wash
moving than held still). backboardd shows no consistent difference. Memory: see below.
The simulator's frames: 30 a second before and after.

### What is left

- **WindowServer and backboardd** composite the wash's layer 30 times a second while it
  moves, before and after; that share could not be told apart from what the other
  agents had on screen (40 to 47% of a core for WindowServer in every run). A quieter
  Mac (or Instruments' System Trace) would say what it is.
- **The GPU's own energy** was not measured (`powermetrics` needs sudo). The shader
  fills about 0.4 million pixels a frame on the Mac and about 0.75 million on an
  iPhone (a 725 × 1024 picture since the bound), a few hundred operations each.
- **Memory on a real iPhone and iPad**: measured on the simulators only (below); the
  simulator's own footprint does not count the pictures, `vmmap`'s IOSurface line does.
- **Not built**: a SwiftUI shader (`.colorEffect`) would still have SwiftUI update and
  redraw the window every frame; rendering off the main thread with `ImageRenderer` is
  not possible (it is bound to the main actor). 60 frames a second and the full
  resolution on the Mac are a switch away (above).
- **The fallback** (no Metal device) is SwiftUI's mesh as before, with its old costs;
  every Mac, iPhone and iPad the app runs on has Metal.

### The bound on the iPhone and iPad (later on 2026-10-18, branch `n4/wash-cap`)

the user accepted the GPU wash's CPU saving but wanted its memory down: the layer's two
pictures at an iPhone's full resolution took about 20 MB. Now the picture is bounded at
1024 pixels on its long side there too, on the whole layer (on an iPhone 18 Pro Max 725
× 1024 pixels, about 3 MB a picture), and the layer scales it to the screen as on the
Mac (`GPUWash.longestSide`, `WashRenderer.boundShare`, tested in `WashCapTests`).

**The look.** `WASH_CAP_OUT=<folder> swift test -c release --filter WashCapLook` draws
SwiftUI's `MeshGradient` at the screen's full resolution (as the app drew it there before)
against the bounded GPU picture scaled up to the screen with linear filtering, as the
layer is: iPhone 18 Pro Max and 13-inch iPad, blue and orange, light and dark, still and
drifting at three moments, 32 cases.

| Of 32 cases, the worst | bounded GPU picture | (full-resolution GPU picture, above) |
|---|---:|---:|
| any pixel, any channel | 3 steps | 2 |
| mean per pixel and channel | 0.36 | 0.37 |
| ΔE, mean | 0.44 | 0.37 |
| ΔE, 99% of pixels under | 1.6 | 1.6 |
| mean signed difference over any 8 × 8 block | 0.97 of a step | 0.84 |

No softening shows: the wash has nothing sharp to soften, and the numbers sit where
SwiftUI's own dither puts them. On the simulators' screens, the still wash before
(SwiftUI, 15a49fa) and after (bounded GPU), the chat screen's wash in Karina's tint, over
the wash's part of the screen:

| Simulator, still wash | mean per pixel and channel | any pixel | ΔE mean | ΔE max | worst block (32 × 32 pixels) |
|---|---:|---:|---:|---:|---:|
| iPhone, light, Karina | 0.23 | 2 | 0.26 | 1.8 | 0.63 |
| iPhone, dark, Karina | 0.10 | 2 | 0.10 | 1.8 | 0.38 |
| iPad, light, Karina | 0.23 | 2 | 0.26 | 1.9 | 0.61 |
| iPad, dark, Karina | 0.11 | 2 | 0.11 | 1.1 | 0.31 |

A second run of the final build gave 0.08 to 0.18 on average, at most 2, ΔE at most 2.1
(the avatar, which blinks, left out). A second tint could not be put on the simulators'
screens with the launch switches and the scripted backend (`PORTALS_DEBUG_AGENT` and
`PORTALS_DEBUG_LOOK_EDITOR` left Karina's chat on screen); blue and orange are in the
comparison above.

Stills in /private/tmp/portals-n4/shots/wash/: `{phone,pad}-still-{light,dark}-…-{base,capped}.png`
and the bounded wash drifting `{phone,pad}-drift-{light,dark}-Karina-capped.png`.

**Memory** (the app's IOSurfaces, `vmmap --summary`; the simulator's footprint leaves
them out), two rounds each, identical in both: before = the SwiftUI wash (15a49fa), full
= the GPU wash at the screen's resolution (b9804df), bounded = now:

| iPhone 18 Pro Max simulator | still | drifting | in the background | back |
|---|---:|---:|---:|---:|
| before (SwiftUI) | 24 to 38 MB | 25.7 MB | 25.4 to 26.0 MB | 25.4 MB |
| full | 10.7 MB | 20.2 MB | 29.4 MB | 19.9 MB |
| bounded | 4.1 MB | 7.1 MB | 9.75 MB | 6.75 MB |

| 13-inch iPad simulator | still | drifting | in the background | back |
|---|---:|---:|---:|---:|
| before (SwiftUI) | 17.8 MB | 29.1 MB | 28.4 MB | 28.8 MB |
| full | 11.7 MB | 22.8 MB | 33.4 MB | 22.5 MB |
| bounded | 4.25 MB | 8.2 MB | 11.2 MB | 7.7 MB |

These are all the app's IOSurfaces, the window's own included. A still wash has drawn
one picture; a drifting one keeps two; in the background one more picture's worth
appears with either GPU build (the system's copy of the layer for the app switcher, it
seems) and goes on return. Asking the layer for pictures of a pixel while away, to let
its pictures go, changed nothing measurable (the bounded build measured the same 4.1,
7.1, 9.75 and 6.75 MB with it and without it), so it was taken out again: the picture on show has to
stay for the return anyway, and on return the first frame is the wash as it was left (a
recording of the iPhone simulator coming back from Settings, 30 frames a second: the app
slides in with its wash drawn in every frame, `phone-return-capped.mov`, `phone-return-capped-final.mov`). The SwiftUI
wash before kept a whole window's pictures, 25 to 29 MB, at rest and away.

**Not built: letting the pictures go while away.** the user asked for it if the pictures
stay, and they do (two while it drifted, about 6 MB bounded, plus the system's copy). A
`CAMetalLayer` has no call that empties its pool, and the picture on show is one of them,
so a release that keeps the return seamless needs the picture handed to something else
first. A way, for the call (M): the view holds the Metal layer as a sublayer; going
away, the picture on show is handed to a plain layer above it (on the Mac, where the GPU
may still be used, a small copy drawn then; on an iPhone the copy has to be made before
the app is in the background, at `inactive`, since iOS refuses GPU work after) and the
Metal layer is removed, which frees its pool; on return a new Metal layer draws its first
frame, and the plain layer goes once that frame is on screen. It would free the Metal
layer's pool (about 6 MB of the 9.75 the app's pictures take in the background on an
iPhone, which is already a third of what the SwiftUI wash kept, 26 MB); what it saves in
the end is less by the copy the plain layer keeps (about 3 MB at the bounded size, less
if made smaller) and is not measured.

Measured on the night's simulators only, not on a phone. The package suite, a plain
Release Mac Catalyst build and the iPhone and iPad simulators' launches (no crash
reports) pass with the bound.
