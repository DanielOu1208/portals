# The main thread's watchdog (2026-10-19, branch `watchdog`)

On 2026-10-19 Instruments showed Portals keeping one core of an iPhone at 100% all
the time (a SwiftUI rebuild loop, fixed in e25a918), and nothing had told us: iOS wrote
no CPU report, and the app logged almost nothing. The watchdog is there so that the next
one is written down, on any device, in any build.

## What it records, and where

When the main thread is

- **busy**: 80% of a core or more over 10 s or longer (`busy`), or
- **stuck**: one turn of its run loop lasting 2 s or more (`hang`),

it writes

- a line in the system log: subsystem `com.danielou.portals`, category `watchdog`
  (`log show --predicate 'subsystem == "com.danielou.portals" AND category == "watchdog"'`,
  or Console with the device attached);
- an entry at the end of `Diagnostics/watchdog.jsonl` in the app's data folder
  (`Library/Application Support/AeriPortal/`), one JSON object a line, the file kept
  under 512 KB (the oldest entries go first).

An entry:

```json
{"kind":"busy","phase":"began","start":"2026-10-19T13:01:25.746-0700","seconds":8.25,"busy":0.996,
 "screen":"active · narrow · chat with fake, thread 074f157e","app":"Portals 0.1.0 (1) · iOS 27.0 · iPhone18,2",
 "stack":["Portals 0x1003a4c20 +0x3a4c20 …", "…"],"images":{"Portals":"FBCF5A17-…","SwiftUICore":"…"}}
```

- `kind`: `busy` or `hang`. `phase`: `began` (with the stack), `continues` (a busy
  stretch still going at 60 s, then at each double: 120, 240…, with a new stack), `ended`
  (how long it lasted in all, no stack).
- `start`: when it began, local time. `seconds`: how long so far, or in all. `busy`: the
  share of a core the main thread used meanwhile.
- `screen`: the scene's phase, wide or narrow, and the thread on screen (its agent and the
  start of its id), or the sidebar.
- `stack`: the main thread's return addresses, innermost first, each with its image, its
  offset in the image and the nearest exported symbol. The symbol is only a hint (an app
  built for release keeps few, so a function of the app's own is often named after the
  last exported one before it); `images` gives each image's UUID, which finds the right
  dSYM. To name a frame of the app:
  `atos -o Portals.app.dSYM/Contents/Resources/DWARF/Portals -l <address - offset> <address>`.

MetricKit's own reports go beside it, in `Diagnostics/MetricKit/`: each diagnostics
payload (CPU use over the system's limit, hangs, crashes, disk writes) and each day's
metrics (CPU time, hang times), as the system delivers them (at most daily), named by the
day they cover, the newest 30 and 8 MB at most. iOS 27 has a Swift successor
(`MetricManager`, async sequences of Codable reports); the app uses `MXMetricManager`,
which still works there, while it runs on iOS 26.

## Reading it

- **iPhone or iPad** (Developer Mode, on a cable or the same network):

      xcrun devicectl device copy from --device <id> --domain-type appDataContainer \
          --domain-identifier com.danielou.portals \
          --source "Library/Application Support/AeriPortal/Diagnostics" --destination <folder>

- **Mac**: `~/Library/Containers/com.danielou.portals/Data/Library/Application Support/AeriPortal/Diagnostics/`.
- **Simulator**: `xcrun simctl get_app_container <sim> com.danielou.portals data`, then the
  same path.

## How it works, and what it costs

- An observer on the main run loop (`CFRunLoopObserver`, first on waking and at each part
  of a turn, last before sleeping, after Core Animation's commit and SwiftUI's updates)
  notes the time in atomics. The main thread never takes a lock or waits for the watchdog.
  A turn is a hang when the time between two of its marks, asleep excluded, reaches 2 s.
- A timer on the watchdog's own queue (utility) looks once a second: the main thread's
  CPU time (`thread_info`) and the observer's marks. `MainThreadWatch`
  (Packages/PortalsKit/Sources/Watchdog) decides, and is tested on its own.
- Only when it has something to write does it stop the main thread
  (`thread_suspend`/`thread_get_state`) to copy its frame pointers with
  `vm_read_overwrite`, for well under a millisecond, into a buffer made beforehand (no
  allocation or lock while it is stopped), then names the frames with `dladdr`. These
  are Mach calls the SDK declares, as crash reporters use them; no private API. arm64
  only (every device and Mac it runs on); elsewhere entries have no stack.
- A look that finds nothing costs well under a tenth of a millisecond of the watchdog's
  thread (numbers below). Nothing is written at rest or while a reply streams.
- A process stopped meanwhile (an iPhone app suspended in the background, a Mac app
  napping, a debugger) shows as a look much later than the one before; nothing is made of
  the time it was stopped.

## Debug switches (simulator and Mac debug builds)

- `PORTALS_DEBUG_BUSY=turns:<seconds>`: five seconds after launch, keeps the main thread
  busy in 30 ms turns (a loop of updates); `hang:<seconds>`: in one turn.
- `PORTALS_DEBUG_NO_WATCHDOG=1`: leaves it out, for measuring what it costs.
- `PORTALS_DEBUG_WATCHDOG_COST=<file>`: every 10 s, `<seconds> <looks> <CPU seconds> <entries>`.

## Numbers (2026-10-19, iPhone 18 Pro and iPad Pro 13" simulators, iOS 27, and a Mac copy, on the MBP16)

Scratch bridge with the fake agent only; load average 5 to 115 from other work on the Mac,
beside each run in /private/tmp/portals-watchdog.

| What | Result |
|---|---|
| It fires: 15 s of 30 ms turns (`PORTALS_DEBUG_BUSY=turns:15`) | `busy began` 8.25 s in at 99.6%, `busy ended` 15 s at 99.3%, stack in `AppWatchdog.spin` |
| It fires: a 3 s hang (`hang:3`), iPhone / Mac | `hang began` at 2.25 s / 3 s with the stack, `hang ended` 3.0 s |
| The fleet loop (f0e3553 with the watchdog), relaunched after the system ended it with a thread on screen | 99.8% CPU; `busy began` after 11 s at 98.5%, stack in `ThreadController.prepare` |
| Silent: the same with e25a918, 60 s at rest | 0.81% CPU, no file |
| Silent: a minute-long reply streaming on screen | 19.6% CPU, no file |
| Silent: iPad, 40 s in the background and back; Mac copy hidden 90 s and shown | no file |
| Its cost: the watchdog's own CPU (Release, `PORTALS_DEBUG_WATCHDOG_COST`) | 70 looks in 0.94 ms: 13 µs a look, 0.0013% of a core |
| The app at rest with and without it (60 s, two rounds) | 0.75 / 0.65% and 0.93 / 0.46%: lost in a run's spread |

The observer on the run loop costs a few atomic stores a turn: nothing at rest, where the
run loop hardly turns.

## The review of 2026-10-19

After the fleet loop, the app was read for the same kinds of trouble (feedback loops, work
redone at each rebuild, work nobody sees, disk on the main thread, things that grow), on
iPhone, iPad and Mac. P1: pegs a core, drains the battery or hangs; P2: real waste in a
common state; P3: minor. Nothing else of the fleet loop's kind (P1) was found.

**Fixed on this branch**

- P2 `MainScreen.swift` (sidebar), `AgentAvatarView.swift`: the sidebar behind the chat
  (iPhone, narrow windows) or out of a wide window drew Aeri's live avatar 30 times a
  second while Aeri worked. iPhone simulator, a thread at rest on screen: 8.8% → 2.1%
  (0.7% with Aeri idle); iPad with the sidebar showing, 8.25% (it still moves there).
- P2 `ChatScreen.swift` (`washMood`, `avatarMood`): a run cut off by the host going out of
  reach kept the wash and avatar going for as long as it was away. 9.2% → 1.0%.
- P2 `ThreadStore.saveTranscript`: every open thread's whole transcript was encoded and
  written on the main thread each time the app left the screen (twice on the way to the
  background, once per Control Center pull) and twice per turn end, changed or not.
  0.9 MB thread: 42 ms on the MBP16 → 0.04 ms when unchanged.
- P2 `RequestCard.swift` (`PlanText`): the plan's Markdown was parsed again at each key
  typed in its note (3.4 ms for 6 KB on the MBP16, more on a phone).
- P3 `ChatScreen.swift`: the chat's avatar held still while slid aside (21.7% → 19.6%,
  one run each, within the spread).

**Checked and not a problem**: the Mac window bar's title (`ChatBarTitle`) holds an avatar
in each of the `ViewThatFits` choices; sampled while a reply streamed with the whole title
showing, the avatars' drawing was 13 of 2,452 main-thread samples: the unchosen ones do
not draw.

**Fixed on branch `perf-p2s` (the four P2s, 2026-10-19)**, measured on an iPhone 18 Pro
simulator against a scratch bridge with the fake agent:

- A thread the app let go of is not followed any more (`HermesBackend.letGo`, bridge
  feature `session_leave`, docs/gateway-protocol.md): once nothing listens to its events
  the app forgets it, a reconnect does not resume it, and the bridge is told to stop
  sending; what still comes for it is dropped unread (its questions too, unanswered rather
  than refused). Twelve threads opened, the first three let go of, another device
  streaming a reply into each of those three: 2.70% and 3.10% of a core before (two
  runs), 0.95% and 1.15% after; on a Mac copy, 3.82% and 1.47%.
- A sidebar swipe moves the chat, its dimming, the fade and the sidebar's "out of sight"
  through modifiers that read the swipe (`SidebarSlide`), not `MainScreen`'s body, and its
  stuck check is one task a swipe (`StuckSwipe`, tested). Eight slow swipes open and
  closed by the UI test's drag: 15.7 CPU seconds before, 7.3 after (main thread 15.4,
  6.9); 58 frames a second in both, hitches 1.6 a second before, 0.9 after.
- A reply's blocks are compared before they are made again, and settled ones by their
  place and parse (`BlockView`, `MarkdownStream.startedOver`, tested), so a reveal step
  makes again only the block being written. CPU seconds over a whole reply on screen and
  two others (reply-cost.sh, 6 each): one long answer (`bench whole`) 10.81 before, 10.26
  after; the bench reply 11.38 and 10.93. The rest is laying out and drawing the growing
  text twenty times a second, the pace being kept as it is.
- A thread opened from its saved copy has it read off the main thread
  (`ThreadStore.loadTranscriptInBackground`, tested): 14 to 21 ms of the main thread at
  the tap for the 45-turn thread before, none after, shown as soon (264 ms median before,
  256 after). The thread left on screen at a relaunch is still read at once.

**Open, for later**

- P3 `MainScreen.swift:331,391` (`firstThreadHint` builds the list to test it is empty, so
  any change to the thread list makes MainScreen again); `HostModel.swift:1394` (`persist`
  writes the observed dictionary every time); `Fleet.swift:721-735` (the started-threads
  footer filters and sorts every thread about ten times a second while a reply streams);
  `Fleet.swift:250-279,598-600` (`layout` sorts every thread at each access).
- P3 `MainScreen.swift:176-182,416`: the 5 s activity poll never stops while the
  sidebar is pinned (iPad, Mac), the window covered too.
- P3 return to the front: agents.json rewritten at each reconnect (`HostModel.swift:401`),
  a Keychain read on the main thread in `registerForPush` (`:483`), `enterForeground` twice
  per return (`MainScreen.swift:186,191`), looks.json read three times.
- P3 `MainScreen.swift:165`: a new swipe-guard closure in the environment at each body
  makes every view that reads it again; `OpenRows.swift:20-24` one dictionary for all rows.
- P3 `ImageViews.swift:18-24,62`: sent pictures decoded on the main thread in a body; a
  missing one tried again at each body.
- P3 `AgentLookEditor.swift:98`: each change of a look stalls the main thread (notification
  pictures, about 90 ms on a Mac).
- P3 `WidgetPool.swift:285-297`: visuals not paused while the Mac window is covered; a
  visual's script that loops forever is not stopped.
- P3, plausible `ThinkingOrbView.swift:17,31`: an orb first laid out off screen may
  animate (its in-view state starts true).
- P3 `ChatScreen.swift:401`, `SubagentsLine.swift:56,190`: the subagents line's spinner and
  clocks run however far up the chat is scrolled.
- P3 `AgentSidebar.swift:2021-2030`: the sidebar's spinners turn behind the chat (Core
  Animation's, not the main thread's).
- P3 growth: `HermesBackend.bindings` keeps one entry per thread opened in the run;
  `Files.swift:33` caps sent files' bytes per thread (64 MB), not overall;
  `ThreadState.swift:484-485,527-529` copy the text so far for each streamed piece.
- P3, benchmarks only `DebugLaunch.swift:24-33`: in builds with `DEBUG` (the benchmarks'
  Release builds too) each switch reads the environment again at each access, in bodies
  and initialisers; a phone's build is not affected.
