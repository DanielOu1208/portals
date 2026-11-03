# The Mac chat while a reply streams: what made it choppy, and what was done

2026-10-14: the Mac app's chat is choppy when scrolling while a thread is
running. Measured and fixed on the night of 2026-10-15 (branch `n1/scroll`, from main
861a269). The numbers are from Release builds of the Mac app (Catalyst) on the MBP16,
with other agents building at the same time (`uptime` load is beside every run in the
bench's log).

In short:

- **It was the size of the chat, not any one part of it.** The transcript was a plain
  `VStack`: every turn of the thread was built, laid out and drawn as one piece. Each
  streamed word, each step of the reply's reveal and each frame of scrolling went
  through all of it. In a thread of 45 long turns the main thread was busy 99% of the
  time, 91% of it in SwiftUI's own graph updates, layout and drawing; the app's own
  code (the bodies of the turns, the Markdown parser) was under 2%.
- **Building only the turns near the screen** (`LazyVStack`, which the user allowed:
  "older turns only built as you scroll up to them") took that thread from 11 frames a
  second while a reply streamed to 105, and the app from 101% CPU to 38%. The thread's
  length no longer matters: 45 turns now cost what 1 turn cost before.
- **Revealing the reply 30 times a second instead of 60**, and parsing its Markdown
  again only when the text shown changed, took a little more off (34% CPU; frames
  late 105 ms a second while scrolling, from 156).
- **The wash and the avatars were not the cause**: the wash's drawing was under 0.1%
  of the main thread before the fixes (1.6% after, of a much smaller whole), the
  avatars nothing measurable.
- **What is left** while a reply streams is the reply itself: laying out the growing
  text and drawing it, about 14 late frames a second, each late by about one frame.
  Proposals for night 2 are at the end.

The branch against main, at the end of the night (two interleaved rounds each, medians;
scroll-final for 1 turn, scroll-final2 for 45; load 4 to 11). Frames are "hitch ms/s
(frames/s, longest frame ms)"; under 5 ms/s is smooth.

| | turns | CPU while streaming | streaming | streaming + scrolling | at rest + scrolling |
| --- | ---: | ---: | --- | --- | --- |
| main 861a269 | 45 | 101% | 895 (13, 274) | 932 (9, 347) | 147 (102, 166) |
| this branch | 45 | 35% | 125 (106, 25) | 103 (108, 40) | 2.5 (120, 17) |
| main 861a269 | 1 | 38% | 153 (102, 30) | 148 (102, 35) | 4.6 (120, 17) |
| this branch | 1 | 34% | 116 (106, 25) | 97 (108, 26) | 4.0 (120, 17) |

## How it is measured

`scripts/mac-scroll-bench.sh` (its use is at its top). In short:

```sh
# a Release build with the launch switches compiled in (read only when DEBUG is set)
xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Release \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath <dd> \
  CODE_SIGNING_ALLOWED=NO SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG build
cp -R <dd>/Build/Products/Release-maccatalyst/Portals.app /somewhere/new.app

# under the gui lock; A and B interleaved, medians printed at the end
scripts/mac-scroll-bench.sh --rounds 3 --short old=/somewhere/old.app new=/somewhere/new.app
```

For each app and round it starts a scratch bridge (port 9341, only the fake agent),
makes a thread of 45 turns there, opens a scratch copy of the app on it in the
background, and has the fake agent stream a reply like a real one for a minute
(`bench` in a prompt: bridge/src/providers/fakeBench.ts, headings, lists, code, a
table, inline and display math, file reads, edits with diffs, commands with output; 2
to 14 characters every 30 to 80 ms, from a fixed seed so every run is the same). It
measures:

- **CPU**: the app's, over 12 s of the stream with nobody scrolling (`ps`).
- **Frames** (in the app: `FrameMeter.swift`, switched on by `PORTALS_DEBUG_FRAMES`
  in development builds only): a display link on the main thread notes when each of
  its calls comes, which it can only do when the main thread is free. A call later than
  half a frame past when it was due counts as a hitch, and the time it is late as hitch
  time; "fps" is how many calls came a second. This is how well the main thread keeps
  up with the display, which is what the chat's work costs. It is not Instruments' hitch
  time: a frame the render server presents late while the main thread is free is not
  seen. "Hitch ms/s" is read against Apple's guide for its hitch time ratio (under 5
  smooth, over 10 visibly choppy) as a rough scale only. The display runs at 120 Hz. A
  meter line comes at the first call a second or more after the last; the bench divides
  by the time the lines really cover. Until the review of 2026-10-15 it took the first
  line of a stretch as one second, which made a busy stretch read worse by at most
  about 3% (that line runs over by under one late frame, at most 350 ms here, of a 12
  to 20 s stretch); the numbers below were not measured again.
  Measured three ways: streaming with nobody scrolling (the chat follows the end),
  streaming while the chat is scrolled up and down, and at rest scrolled the same way.
- **Main thread** (`--profile`): a `sample` of the app over 10 s of streaming and
  scrolling, kept for reading what it was busy with.

A run in which the app used under 15% CPU while the reply streamed is left out of the
medians, with a screenshot of what it showed (`streaming.png`): once, the app was
opened on the thread and the reply streamed, but it hardly worked (7%) and its frames
were all on time, so it was not showing the reply. Why was not found.

The scrolling is the mouse wheel, sent by cua-driver in the background (the pointer
does not move and the app does not come forward), six notches at a time, up twice and
down twice in turn. A trackpad's scrolling with gesture phases could not be sent: the
Catalyst app takes no scroll events posted to its process (`CGEventPostToPid`, and
SkyLight's `SLEventPostToPid` with an authentication message), and posting them to the
system would move whatever is under the user's pointer.

Instruments' Animation Hitches template is not used: on this Mac it wrote an 11 GB
trace into `$TMPDIR` within a minute of a 24 s recording and filled the disk
(2026-10-15 05:25; removed at once). The SwiftUI instrument records the same way and
was not tried for that reason. `sample` stands in for the Time Profiler.

## Numbers

Medians of two interleaved rounds each (bench output: /private/tmp/portals-n1/bench/
scroll-ab1, scroll-ab2 and scroll-ab3; the last compared only the last two builds).
Frames are "hitch ms/s (hitches/s, frames/s, longest frame ms)".

| build | turns | CPU while streaming | streaming | streaming + scrolling | at rest + scrolling |
| --- | ---: | ---: | --- | --- | --- |
| main 861a269 | 45 | 101% | 910 (11.1, 11, 284) | 933 (8.6, 9, 389) | 222 (4.1, 94, 254) |
| main 861a269 | 1 | 37% | 144 (17.1, 103, 26) | 150 (17.8, 102, 29) | 4.3 (0.5, 120, 21) |
| + finished turns not redrawn, width measured only for math | 45 | 101% | 913 (11.4, 12, 284) | 927 (9.1, 9, 376) | 170 (3.5, 100, 186) |
| + lazy transcript | 45 | 38% | 132 (15.7, 104, 24) | 156 (17.8, 101, 49) | 4.4 (0.5, 120, 25) |
| + lazy transcript | 1 | 41% | 128 (15.2, 105, 22) | 146 (17.1, 103, 37) | 2.6 (0.3, 120, 17) |
| + reveal at 30 Hz | 45 | 34% | 128 (15.1, 105, 28) | 114 (13.4, 106, 33) | 4.3 (0.5, 120, 17) |
| + reveal at 30 Hz | 1 | 35% | 140 (16.4, 104, 26) | 116 (13.8, 106, 26) | 3.7 (0.5, 120, 17) |
| reveal at 30 Hz, again (scroll-ab3) | 45 | 34% | 117 (13.8, 106, 29) | 124 (14.7, 105, 30) | – |
| + parse only when the text shown changed | 45 | 34% | 116 (13.8, 107, 23) | 105 (12.3, 108, 34) | – |

Load averages during these runs ran from 5 to 75 (other agents' builds); the order of
apps was interleaved in every round.

### Where the main thread went

From `sample` while streaming and scrolling (shares of the main thread's samples;
sample-streaming.txt under each run's folder).

Before (main 861a269, 45 turns): idle 1%. SwiftUI graph updates 91% (of which
`propagate_dirty` 28%, flushing transactions from `@Observable` changes and `@State`
changes 60%), layout of the hosting view 16%, the display list 24%, scroll geometry
commits 6%. The app's own code: `ReplyTextView.body` with `Markdown.blocks` 0.7%,
`TurnView.body` 0.3%, `ChatScreen.body` 0.4%, the sidebar 0.3%, the wash (`RasterWash`,
its `ImageRenderer`) 0.05%, the avatars none.

After the lazy transcript (45 turns, sampled every millisecond, which slows the app):
drawing and committing layers 34%, the display list 29%, text layout 25%,
`Markdown.blocks` 8% (the reveal parses the whole reply at every step), the sidebar's
body 6% (`AgentSidebar.body`, run again for every streamed word), the composer's body
3%, scroll geometry commits 3%.

With everything on the branch (sampled every 5 ms): the main thread is busy 52% of the
time while a reply streams and the chat is scrolled. Of its samples: committing layers
30%, most of it drawing text into layers on the CPU (`CALayer display` → glyphs: the
paragraph being revealed is drawn again at each step), the display list 25%, SwiftUI's
graph updates 23%, text layout 9%, `ReplyTextView.body` with the parse 2%, the wash 1.6%,
the composer's body 0.9%, the sidebar's body 0.7%.

## The suspects, one by one

1. **The transcript as a plain `VStack`.** Confirmed, and the cause. Now a
   `LazyVStack` (`ChatScreen.transcript`). Kept working, checked on the Mac (Release,
   scratch copy) and in the iPhone and iPad simulators: the chat opens at the end of a
   45-turn thread (`defaultScrollAnchor`), follows the end while a reply streams, shows
   the end once the reply is done, and Copy and Select Text open from a reply. On the
   Mac it can be scrolled up with the wheel during a reply without being pulled back
   (trackpad gestures could not be sent; see above). Screenshots:
   /private/tmp/portals-n1/shots/scroll-mac-*.png and scroll-ios-*.png, scroll-ipad-*.png.
   Not checked: the software keyboard (the simulator uses the Mac's keyboard; the
   composer takes focus and the end stays in view), the subagents line and images
   (the fake agent makes neither; their code is unchanged and sits outside the turns).
   A lazy stack may make a turn's views again when it comes back from far away, and a
   reply's reveal began from nothing whenever its view was made (also when a thread
   was opened in the middle of a reply, before this branch). A reply longer than 400
   characters when its view is made is now shown whole, and only what follows eases
   in (checked on the Mac: the app opened in the middle of a reply shows it at once and
   follows on; scroll-mac-opened-mid-reply.png). Whether the lazy stack does make the
   running reply again could not be seen: the wheel, sent in the background, does not
   scroll far enough.

   The lazy stack does let go of a turn far from the screen, and of what its rows
   held (found in the review, on the Mac: the last turn's steps opened, the chat
   scrolled to its first turn and back, the steps were closed again). So whether a
   turn's steps, a tool call's details, the reasoning or a command's whole answer are
   open is now kept by the chat (`OpenRows`), not by the rows, for as long as the
   thread is open, as before. Select Text opens its sheet from the chat, not from the
   turn, which could have closed it as a reply streaming in below moved the turn away.
   The subagents line sits after the lazy stack, so it keeps whether its list is open.
2. **Every finished turn re-evaluated for every word.** True (`onRetry`, a closure made
   anew on every update, made every `TurnView` differ), but cheap next to the layout:
   `TurnView` is now `Equatable`, leaving `onRetry` out. Measured with the plain
   `VStack`, it and the next one took scrolling at rest from 208 to 170 ms late a
   second and nothing off streaming.
3. **A geometry reader on every paragraph** (`ProseText` measured its width for its
   formulas). Every paragraph of the thread updated its geometry on every frame of
   scrolling. Only text with a formula in it measures now.
4. **The reveal: a step every 16 ms, each parsing the whole reply.** The parse itself
   is small (under 1% before, 8% after the lazy transcript). Revealing 30 times a
   second, 4 characters or a fifth of what is behind a step (it was 2 or a tenth, 60
   times), took CPU from 38% to 34% and hitch time while scrolling from 156 to 114 ms
   a second. A reply now comes a few characters at a time rather than one or two. The
   reply's blocks are now parsed again only when the text shown changed (a word that
   arrives while the reveal is behind changes nothing shown), and blocks that stayed
   the same keep their very value: the parse went from 8% of the main thread to 2%,
   and hitch time while scrolling from 124 to 105 ms a second, within the noise.
5. **`.animation(…, value:)` on whole turns.** Not seen in the profile: unchanged.
6. **The wash and the live avatars.** Not the cause (above): unchanged. Pausing the
   wash while scrolling was allowed but would buy nothing measurable.
7. **`ThreadController` granularity.** Every streamed word changes `state`, one
   `@Observable` property, so the whole `ChatScreen` body, the composer and the
   sidebar's body run again. Together about 10% of the main thread after the lazy
   transcript, under 2% with everything on this branch. The sidebar's part is fixed on
   the lean track's branch (`n1/lean`: the sidebar is not recomputed for every word).
   The rest is left as a proposal (below): it means splitting what views observe.
8. **`onScrollGeometryChange` scrolling to the end on every change.** 6% before, 3%
   after: left as it is. Scrolled up with the mouse wheel, the chat was not pulled
   back, before the fixes or after; whether a trackpad's gesture goes the same way was
   not tried (below).

### What the late frames that are left are not

About 13 to 15 frames a second are still late while a reply streams, each by about one
frame, in a thread of 45 turns as in one of 1. Three experiments, each against the
branch's build in two interleaved rounds (scroll-ab4, -ab5, -ab6), none kept:

| changed | CPU | streaming | streaming + scrolling |
| --- | ---: | --- | --- |
| nothing (the branch) | 34–36% | 121–131 (14.1–15.2/s) | 99 (11.6–11.7/s) |
| reveal at 20 Hz, 6 characters or a quarter a step | 33% | 131 (15.3/s) | 107 (12.6/s) |
| half as many streamed pieces, twice as large (`bench coarse`) | 33% | 110 (12.8/s) | 93 (10.8/s) |
| the wash never moving | 34% | 127 (14.9/s) | 102 (12.1/s) |

The `bench coarse` row was measured before the review of 2026-10-15 made coarse pieces
keep the plain bench's schedule. Then, it drew one pause for each two pieces and
doubled it, so the reply's later pieces and tool calls came up to about a second away
from the plain run's (for round 18, 62.1 s in all against 61.2 s), besides coming in half as many
pieces. That small a shift is unlikely to explain the row, but it was not measured
again.

So they come neither from the reveal's pace nor from the wash, and only a little from
how many pieces arrive. What makes them is the next thing to find, with a tool that
can say which update a late frame belongs to (the SwiftUI instrument, on a Mac with
room on its disk, or signposts around the chat's updates read by `log`).

## Left for night 2 (proposals, not built)

- **Find what the remaining late frames are** (above). Until that is known the
  proposals below are guesses at where they come from.

- **Draw less of the paragraph being revealed.** What remains is drawing the text that
  grows: each reveal step draws the whole paragraph being written again into its layer,
  on the CPU (about 30% of the busy main thread). Ideas, to measure: reveal by whole
  words or lines at 20 Hz; or show the settled lines of the paragraph as one text and
  the line being written as another, so only the short one is drawn again. The first is
  a small visible change; the second is M.
- **Parse only the tail of a streaming reply.** Each step still parses the whole reply
  (2% now). Blocks before the last blank line outside a code fence are settled; parse
  the tail and keep the settled blocks (their ids are positions). Care: a list split by a
  blank line, numbered lists' numbers, `$$` spanning lines. Tests in AgentCore. S–M,
  for little.
- **Observe less per word.** Give `ThreadController` separate observable properties for
  what the header and composer read (running, request, queued, title), changed only
  when they change, so that a streamed word invalidates only the transcript. Under 2%
  now; worth it mostly for the phone's battery. M.
- **The iPhone and iPad.** The fixes are shared code and were checked there for
  behaviour (follows the end, end in view, no crash), not measured: the bench drives
  only the Mac app. A phone run would need the frame meter read from the device.
- **Trackpad scrolling in the bench.** The wheel scrolls in notches; a trackpad's
  gesture has phases (began, changed, momentum) that drive `.interacting` and
  `followsEnd`. Needs a way to deliver phased scroll events to a background Catalyst
  window, or a run with the app in front, with the go-ahead. The user trying the
  build with a real trackpad is the quicker check.

## Night of 2026-10-18 (n4, track `stream`): what a reply streaming costs, Mac and iPhone

the ask for the night: the app snappier and lighter on the battery, on the Mac and
the phone. This track took what is left while a reply streams (branch `n4/stream`, from
main 15a49fa). Numbers are from Release builds with the launch switches compiled in, on
the MBP16, while four other agents built and measured on the same Mac (`uptime`'s load is
beside every run in the bench logs under /private/tmp/portals-n4/bench/stream-*).

### How it is measured

`scripts/stream-bench.sh` (usage at its top), new tonight. For each app and round it
starts a scratch bridge with only the fake agent, makes the 45-turn thread of the scroll
bench, opens a scratch copy of the app on it and has the fake agent stream its
minute-long reply (bridge/src/providers/fakeBench.ts), nobody touching the app. It reads
the app's CPU over 12 s and its frames then (FrameMeter), with `--trace` a Time Profiler
recording of 10 s more (summarised by scripts/app-footprint/timeprofile.py), then its CPU
over 10 s with the window covered (Mac) or the app in the background (iPhone), and a
screenshot of what it shows once seen again. Apps are interleaved (A, B, A, B).

The same script runs in the iPhone simulator (`--ios <udid>`): the app is a Release build
for the simulator with the switches, installed under a throwaway bundle id, opened on the
same thread (`PORTALS_DEBUG_OPEN_EACH=1:0.5`, which waits for the list: with
`OPEN_LATEST` the app opened a new thread instead in about one run in four, on the Mac
and in the simulator; a run where the app hardly works is left out), its frames written by the same
FrameMeter (the simulator's display runs at 60 Hz), its CPU read with `ps` on the
simulator's process. **The simulator is not a phone**: it runs the app on the Mac's CPU
and draws with the Mac's GPU. Its numbers are for comparing builds with each other, not
for what a phone spends.

Found while setting up: since Droid joined (main 80d2ee5), the bench bridges turned
Droid on too (its setting defaults to on), and the app then opened Droid's empty thread
instead of the bench's: a scroll-bench or footprint run on main since then would have
measured an empty chat. The bench bridges now keep Droid off.

### Where a streaming reply's CPU went (main 15a49fa)

Time Profiler, 10 s of the bench's reply in the 45-turn thread, shares of the app's
samples (the Mac at about 42% of a core then, the iPhone simulator at about 24%):

| | Mac | iPhone sim |
| --- | ---: | ---: |
| parsing the reply's Markdown (`Markdown.blocks`, at each step of the reveal) | 8.1% | 11.5% |
| drawing text into layers (`CABackingStoreUpdate`; on the Mac glyphs drawn on the CPU) | 19.4% | 4.5% |
| SwiftUI's display list | 16.3% | 18.1% |
| RenderBox (the iPhone draws with it) | about 4% | 10% |
| the chat's body and the composer's for each streamed word (`ChatScreen`, `ChatComposer`, their glass) | 3.6% | 3.8% |
| the wash (`RasterWash`, Mac; now track `wash`'s) | 2.1% main + ~2% other threads | 0.0% |
| the avatars (the talking one in the bar) | 0.1% | 0.5% |
| the lazy stack's layout | 2.3% | 2.7% |

A reply streaming cost the Mac as much with its window covered (40% against 36% in view, in
that run): the chat goes on laying out and drawing each step of the reveal for a window
no one sees; only the wash and the avatars stopped there (night 1).

### What was changed (branch `n4/stream`)

1. **The reply is parsed again only from its last finished block** while it is being
   written (`AgentCore/MarkdownStream.swift`, tested in `MarkdownStreamTests` at every
   character of the bench's reply, the showcases, loose and nested lists, code with blank
   lines, math, quotes and tables, against a whole parse). A cut is a blank line outside
   fenced code followed by a whole line in the first column that is neither a list item
   nor a fence: a formula and a code span never run over a blank line, a paragraph,
   quote and table end at one, a line in the first column ends a list; an item after a
   blank line could carry on the list above, with its number, so no cut is made before
   one, nor before a line still being written ("2" can become "2. "). Fences are counted
   line by line exactly as `Markdown.fencedLines` counts them (it decides what is kept
   from formulas and closes a fence left open), and at each new cut the parser is asked
   once whether the text parsed in two there gives what it gives in one; where a line
   only looks like a fence to that count (a line of backticks indented as code inside a
   fence, a fence after a list item's marker) it does not, and from there the reply is
   parsed whole (review rounds 1 and 2). A reply with what may be a link or footnote
   definition (also in a quote or a list item, or with its label over two lines), HTML
   that can run over blank lines (comments, `<pre>`, …), Windows line ends, a byte order
   mark or a character of the formulas' placeholders is parsed whole. Each step reads only the lines added since the last.
   Once the reply is done it is parsed whole once. A block's text no longer carries the
   parser's marks of which block it is in (nothing drawn read them), so the same block
   parsed from part of the reply or all of it is the same value. A step of a reply of
   4,000 characters: 1.04 ms parsed whole, 0.12 ms with the stream (release build of the
   package, this Mac; `PORTALS_BENCH=1 swift test -c release --filter
   MarkdownStreamBenchmarks`; 0.08 ms before the review's check at each cut). At 80,000
   characters of the showcase repeated, 13.9 ms against 0.01 ms. A reply with no cut at
   all costs what a whole parse costs once under way (0.98 to 1.02x a step at 80,000
   characters of one long line, code still open, one list, or code whose blank lines look
   like cuts the parser refuses, where the one step that asks and is refused parses about
   twice; before the review the stream looked through the whole reply at each step
   and cost 1.5 to 1.6 times a whole parse there, and twice one where cuts were refused). What still grows
   with the reply is a comparison of its bytes with the step before, a few microseconds.
2. **The reveal steps twenty times a second instead of thirty**, about a word a step
   (at least six characters, and two sevenths of what is behind), at the same pace as
   before: 120 characters a second at the slowest, a burst caught up as fast. A small
   visible change: the reply grows in slightly larger steps.
3. **A thread holds the pieces of a reply while no window of the Mac app can be seen**
   (`AgentCore/HeldPieces.swift`, tested in `HeldPiecesTests`; `ThreadController.follow`).
   Pieces of text and reasoning are kept back while `WindowVisibility` says no window can
   be seen, and applied together, as one change, once one can; anything else the thread
   hears (a tool, a request, the end of the turn, a snapshot) is applied at once, after
   the pieces held before it, so the order is kept, and the end of a turn is saved,
   notified and shown as before. Each piece is applied at the time it came, so reasoning
   that streamed while covered still says how long it took; the pieces held are applied
   before the app changes the transcript itself (a message sent or delivered, an answer,
   a line of its own), so they keep their place before it; and a thread saved while
   covered (the app quit or sent to the background) saves the pieces held with it
   (review rounds 1 and 2). Seen again, what came meanwhile eases in from where the
   reply stood (checked: covered 8 s, then uncovered, the chat at its end and following;
   live/stream/check-cand2/uncovered.png). A first try held only the reply view (no
   parse, no reveal while hidden): it took the reply's own cost away but not the chat's
   and the composer's bodies, which every streamed word still ran, and the window
   covered still cost 28% of a core in its profile.
4. Smaller: whether a reply has anything to show no longer copies it at every step.

### Numbers

The Mac, Release with the switches, 45-turn thread, the fake agent's reply (median of
two interleaved runs each; load 4 to 29; bench output under
/private/tmp/portals-n4/bench/stream-mac-whole, stream-mac4 and stream-mac-cand2):

| | main 15a49fa | n4/stream |
| --- | ---: | ---: |
| CPU over the whole reply, in view | 36.7% | 33.3% |
| CPU over 12 s of the reply, in view | 35.1% (34.0–36.4) | 33.5% (33.0–34.3) |
| CPU with the window covered | 38.0% (35.5–39.8) | 7.7% (7.6–7.7) |
| frames while it streams: late ms a second (late frames a second), frames a second | 116 (13.7), 106 | 110 (12.9), 106 |
| samples in 10 s of Time Profiler (≈ % of a core × 10) | 4019 | 3389 |
| of which parsing the Markdown | 9.0% | 3.5% |
| of which drawing text into layers | 19.3% | 16.0% |

The final build of the branch (3549d16's code) against main once more, the window covered:
7.5% against 32.1%. And scripts/mac-scroll-bench.sh as on night 1 (two interleaved
rounds, no scrolling at rest; /private/tmp/portals-n4/bench/stream-scroll-final): CPU
while streaming 35.5% → 34.0%; late ms a second (late frames a second, frames a second)
115 (13.7, 107) → 111 (13.0, 107) while streaming, 94 (11.1, 109) → 99 (11.6, 108) while
also scrolled with the wheel: the frames are as they were, within the noise.

The iPhone 18 Pro Max simulator (Release with the switches, same thread and reply; CPU
over the whole reply; medians of interleaved runs; bench output under
/private/tmp/portals-n4/bench/stream-ios-*). **Not a phone**: compare the rows with each
other only.

| | CPU while it streams | frames |
| --- | ---: | --- |
| main 15a49fa (three runs, and two) | 25.0%, 24.2% | 60/s, 0.5–3 ms/s late |
| n4/stream (three runs, and two) | 23.2%, 22.6% | 60/s, 0.7–2 ms/s late |
| the parse alone, at 30 Hz (exp, three runs) | 22.9% (base 22.3% then) | |
| the parse and a 20 Hz reveal (three runs) | 20.8% | |
| the parse and a 15 Hz reveal, eight characters a step (three runs) | 20.0% | |
| in the background (Settings in front) | 0% on both: the app is suspended within 3 s | |

The simulator's runs a quarter of an hour apart differ by more than the builds do (22.3
and 25.0 for main): read the rows of one A/B against each other. In the 10 s profiles
the parse went from 11.5% to 5% of the samples, and the samples from about 2390 to 2280
with the parse alone and 2070 with a 15 Hz reveal.

The iPad simulator (Portals iPad) ran the branch's build once: the reply streamed with
the chat at its end, 18.7% CPU over 12 s. The iPhone simulator's runs of the last builds
left no crash report.

Checked on the Mac with the branch's build (scratch copy, background, screenshots in
/private/tmp/portals-n4/live/stream/check-cand1b and check-cand2): the chat opens at the
end of the 45-turn thread and follows the reply; scrolled up with the wheel during the
reply it stays where it was over 5 s while the reply goes on below; scrolled back down
it follows again; covered for 8 s and uncovered it is at the end with what came
meanwhile; after the reply the end is in view, with the math, the code block and the
table drawn. In the iPhone simulator the reply streamed with the end in view, and after
the background and back it showed the reply at its end. Not checked tonight (not
touched by these changes): Select Text and the copy menu, images, the request cards,
the subagents line, queued rows, the composer and keyboard on the iPhone, opening a
long thread after a relaunch, and the lazy transcript letting go of turns and threads.

Checked again at the review (Codex, four rounds; the fixes changed the parser's cuts and
when held pieces are applied, not what a step costs at the bench's pace), Mac, stream
bench, main against the branch, interleaved: the builder's last build (2 rounds, load
3-5) covered 31.7% → 5.8%, in view 35.4% → 33.2%; the reviewed build 453558b (1 round,
load 4-6) covered 32.0% → 6.4%, in view 35.8% → 34.3%; frames as before (105-106 a
second, about 14 late a second). The same check of the behaviour on the Mac (follows,
stays scrolled up, follows again, uncovered at the end, the end drawn after the reply;
/private/tmp/portals-n4/live/review-stream/check-final) and in the iPhone simulator
(453558b: streams at 60 frames a second, 22.3% of a core, 0% in the background, at its
end after it, no crash report) and the iPad simulator (f00d5a9, a round earlier: streams
at 60 frames a second) gave what it gave before.

### Tried and dropped

- **The block being written in a layer of its own** (`.drawingGroup()` or
  `.compositingGroup()` on the reply's last block while it grows), to draw less of the
  text at each step: no gain (3569 and 3745 samples against 3389 without; 33.1% and
  34.2% CPU against 33.0%). The text drawn on the CPU is not only the growing block's.
- **Applying streamed pieces every 100 ms while in view** (coalescing): half the chat's
  and composer's body time in the simulator, no measurable change overall (22.2% and
  20.9% against 22.0% and 22.4%; samples 2262 against 2263). At the bench's 18 pieces a
  second the reveal, not the pieces, sets how often the chat changes.
- **The wash's bitmap** (a 256-pixel one looks the same: mean 0.02 levels from the
  1024-pixel one, against a full-resolution render): left to track `wash`, which owns it
  now and draws it with Metal.

## Left for later (proposals, not built)

- **Observe less per word.** What a streamed word still runs, in view and now the main
  cost left when hidden is held: `ChatScreen.body`, `ChatComposer.body` and their glass,
  1.7% + 1.1% + 0.8% of the Mac's samples, 2.7% + 1.5% of the simulator's, plus the
  graph's work around them (on the Mac covered, before the hold: about a quarter of what
  was left). `ThreadController` would keep stored properties for what the header and
  composer read (queued, pending, asides, title, context, mode, model, subagents, run
  status, the last turn's id and end), each set only when it changes, and the transcript's
  `ForEach` would move into a child view that alone reads the turns. It means changing
  ChatScreen's body, which tracks `open` and `return` changed tonight: for after the
  merge. M.
- **The text drawn on the CPU on the Mac** (16% of the samples): Catalyst draws SwiftUI
  text with CoreGraphics into layers, where the iPhone draws with RenderBox. A layer of
  its own for the growing block did not help, so first find which layers are drawn at
  each step (Instruments' Core Animation template, on a Mac with room on its disk).
- **The late frames on the Mac** (about 13 a second, ~110 ms a second while a reply
  streams in view): unchanged by the parse, the reveal's rate, the hold, a layer for the
  growing block, and (night 1) the wash and the pieces' size. Signposts around the
  chat's updates read by `log` would say which update each belongs to.
- **A 15 Hz reveal** would take another 4% off the phone's cost (20.0% against 20.8%):
  steps of eight characters or more, visibly coarser. The call.
- **Pieces applied in batches while in view**, for agents that stream faster than the
  bench (Claude and Codex can send many small pieces a second): measure with a real
  agent's reply first; at the bench's pace it bought nothing. The bridge was not changed:
  receiving and decoding its frames is about 1% of the Mac app's samples while a reply
  streams (JSON 0.4%, JSON-RPC 0.4%, the socket 0.2%), so batching them there would buy
  little.
- The bench builds read the launch switches' environment in `ChatScreen.body` at every
  update (`DebugLaunch`, about 1% of the samples); a Release build without `DEBUG` does
  not, so the bench slightly overstates the per-word cost.

## 2026-10-20: Droid activity parity, partial comparison

The initial series was **not a completed performance pass**. Five runs completed
before Cua lost the exact window's accessibility surface and refused background input. Two
incomplete current-45 runs were excluded. The planned second current-45,
baseline-1 and current-1 repetitions were blocked; no foreground escalation was
used. The same-bridge follow-up below supersedes these initial comparisons.

Clean Release Catalyst snapshots compare `98f97f92` (Phase 1 baseline) with
`0003fb65` (Phase 2/3 UI and composer hit-target repair). This does not measure later
approval, queue, command or subagent changes. Both apps used the same bridge from
the latter snapshot, the same deterministic `fakeBench` reply, and a harness-only
overlay: cumulative stdout at 5 Hz, turn usage at 1 Hz, and initial/final todo.
Nothing actually executed. The baseline ignores updates it does not support.

`scripts/phone-bench/uitest/droid-parity-perf.mts` keeps scratch homes, app groups,
bundle IDs and authenticated loopback bridges separate from the normal app and
installed bridge. Cua launched exact owned app instances and sent background wheel
events. No builds, UI tests or other GUI control ran during measurements. CPU is
the owned app's 12-second streaming interval; frames are main-thread FrameMeter
samples, not render-server presentation. Histories contain 45 or 1 seeded turns.
Completed streaming intervals were 62.3–62.4 seconds, with 6–7 alternating wheel
events per scrolling stretch; host load ranged from 4.7 to 7.0 in completed runs.

Frames below are **hitch ms/s (fps)**. The baseline-45 row is the median of two
runs; every other row has only one run.

| snapshot | turns | n | streaming CPU | streaming | streaming + scrolling | rest + scrolling |
| --- | ---: | ---: | ---: | --- | --- | --- |
| baseline `98f97f92` | 45 | 2 | 31.4% (31.1–31.7) | 101.8 (108.0) | 106.1 (106.8) | 3.5 (119.7) |
| current `0003fb65` | 45 | 1 | 44.8% | 97.8 (108.5) | 114.2 (106.4) | 0.5 (120.0) |
| baseline `98f97f92` | 1 | 1 | 30.9% | 101.1 (108.0) | 106.7 (107.4) | 4.9 (119.5) |
| current `0003fb65` | 1 | 1 | 38.8% | 81.6 (110.3) | 96.9 (108.4) | 8.3 (119.1) |

**CPU needs follow-up:** current is 13.5 percentage points above the 45-turn
baseline median (+42.9%), and 7.9 points above the 1-turn baseline (+25.6%).
The 45-turn difference is much larger than the observed baseline repeat spread
(0.6 points), but current has not been repeated. These initial pairs do not meet a
no-CPU-regression goal. They do not isolate which new activity update causes it.
Streaming/scrolling frame results have no consistent direction across thread
lengths; the single current 1-turn rest result also exceeds the rough 5 ms/s
smoothness reference. Do not call either result noise or a proven regression
without the remaining interleaved repetitions.

Evidence: `/private/tmp/portals-droid-perf-waco4j_i/results.jsonl` and completed
run directories `r1-{baseline,current}-{45,1}`, plus `r2-baseline-45`, contain
individual CPU/frame results, timestamps, screenshots, accessibility snapshots and
raw FrameMeter rows. `r2-current-45/scroll-before-73.json` and the initial
`r3-current-45` snapshots document `ax_window_unresolved`, zero AXWindows, and
refused input routes. No `result.json` from either incomplete run enters the table.
Streaming screenshots were checked for the intended long reply, not an empty chat.

### Resumed after unlock: separate pre-fix and animation-fix snapshots

The exact-window route recovered after the user unlocked the Mac. The baseline's
missing 1-turn repeat and two runs per thread length of clean `353a2c0c` and
`22a7276` snapshots completed. Do **not** pool these with the `0003fb65` rows
above. `22a7276` changes activity animation, not the bridge workload. Resumed
pre/fix runs and the second short baseline used bridge `353a2c0c`; the earlier
long baselines and first short baseline used `0003fb6`, with the same overlay.
Pre-to-fix comparison is same-bridge controlled.

Three fresh baseline controls on `353a2c0c` then completed in a quiet window:
45 turns, 1 turn, 45 turns. The table below replaces both earlier long baseline
samples with the fresh controls. Its short baseline combines the fresh sample
with the matching `353a2c0c` historical short repeat; no `0003fb6` bridge sample
enters this table. All twelve results have the same frozen bridge `source`.
The controls stream for 62.42–62.45 seconds with seven wheel events per scrolling
stretch; their one-minute host load is 4.76–5.74. Their streaming PNGs show the
intended reply in the wide window. These later controls were not interleaved with
pre/fix measurements. A result's `source` identifies the bridge, not the app.

Every row below has **two valid runs**, with no overlapping build or GUI test.
Frames remain hitch ms/s (fps). CPU ranges show the individual samples.

| app snapshot | turns | streaming CPU, median (range) | streaming | streaming + scrolling | rest + scrolling |
| --- | ---: | --- | --- | --- | --- |
| baseline `98f97f92` | 45 | 32.8% (32.5–33.1) | 136.9 (103.2) | 126.2 (104.9) | 7.0 (119.2) |
| pre-fix `353a2c0c` | 45 | 40.9% (36.8–45.1) | 94.5 (108.8) | 117.5 (105.6) | 6.5 (119.2) |
| fix `22a7276` | 45 | 32.9% (32.2–33.7) | 117.1 (106.1) | 106.1 (107.0) | 7.6 (119.1) |
| baseline `98f97f92` | 1 | 31.9% (31.7–32.2) | 115.8 (106.2) | 117.1 (105.4) | 7.4 (119.1) |
| pre-fix `353a2c0c` | 1 | 41.6% (41.2–41.9) | 87.9 (109.5) | 152.6 (101.0) | 11.8 (118.4) |
| fix `22a7276` | 1 | 31.2% (29.2–33.2) | 115.0 (105.6) | 110.2 (106.6) | 3.2 (119.6) |

The animation fix reduces median streaming CPU from the pre-fix snapshot by
19.5% (45 turns) and 25.0% (1 turn). Against the same-bridge baseline it is about
0.5% higher at 45 turns and 2.3% lower at 1 turn; individual CPU ranges overlap.
This is a useful improvement, **not an unqualified no-regression pass**. Frame
timing is mixed against pre-fix; the fresh controls also demonstrate substantial
frame variability. Fix streaming/scrolling hitch medians are no higher than the
controlled baseline, but 45-turn rest scrolling is higher (7.57 versus 6.99 ms/s),
and both exceed the rough 5 ms/s reference. Individual outliers include a
294.1 ms pre-fix scrolling frame and a 259.4 ms fix streaming frame. Only two
samples per case, host load (up to 8.8 in the resumed runs), and FrameMeter's
main-thread-only scope limit the conclusion.

One additional fix 1-turn launch was excluded because the app aborted, not
because of a low-CPU or unavailable-input flag. PID 22721, window 15664, was a
wide 1300×820 Catalyst window with the sidebar visible. Its seeded capture
finished about 180 ms before the abort, before any wheel events or streaming
measurement. The main-thread crash stack goes through AttributeGraph's
`precondition_failure`, SwiftUI's gesture recognizer responder and UIKit hover
handling. The crash report is
`~/Library/Logs/DiagnosticReports/Portals-2026-10-20-233332.ips`.
The same-binary, separately tagged retry completed successfully. The runner now
tolerates `ESRCH` when cleaning up an already-exited owned app, so cleanup cannot
hide that original failure. This is not evidence that the animation fix caused
the crash.

A bounded follow-up on `3ce6a4a8` (Release+DEBUG) did **not** reproduce it:
10/10 sequential wide 1300×820 launches opened a seeded 1-turn thread, submitted
`bench`, remained alive for five seconds, and quit. Every submit begin/ack has a
UTC timestamp. No new Portals crash reports appeared, so the conditional
baseline 10-trial loop was not run. This does not establish that the intermittent
crash is fixed or new. Evidence: `crash-main-3ce6a4a8/r{1..10}-current-1` under
the same root, `trace.jsonl` and before/after PNGs; first and last streaming
captures were personally checked. No CPU/frame result was generated by these
launch probes.

Evidence under `/private/tmp/portals-droid-perf-waco4j_i`:

- controlled baseline: `baseline-353-controls/r{31,32}-baseline-45`,
  `baseline-353-controls/r31-baseline-1`, and historical `r2-baseline-1`;
- historical baseline (not pooled above): `r{1,2}-baseline-45`, `r1-baseline-1`;
- `main-353a2c0-runs`: `r{4,6}-current-45`, `r{2,4}-current-1`;
- `fix-22a7276-runs`: `r{5,7}-current-45`, `r{3,8}-current-1`;
- excluded crash: `fix-22a7276-runs/r5-current-1`, with seeded PNG/AX state
  and FrameMeter rows but no `result.json`;
- excluded setup-only control: `baseline-353-controls/r1-baseline-45`. Cua refused
  its already-ended historical session before launching the app; no streaming,
  wheel input or sample occurred. Runner sessions now include a unique invocation
  suffix, also logged in the trace. The three fresh controls completed after that
  lifecycle-only repair;
- `baseline-353-controls/aggregate.json`: all twelve exact input directories,
  CPU median/range and frame medians, with bridge-source equality verified.

All completed streaming PNGs were personally checked for the intended reply.
These snapshots precede the later plan-status styling change; they do not
measure that change.
