# Opening a thread: at its end from the first frame, and sooner

Taken on the night of 2026-10-18 (night n4, track `open`, branch `n4/open` from main at
15a49fa). The ask: "fix the chat loading issue in the todolist", the backlog's "A
thread opened at its end, without the little scroll": on the Mac and elsewhere some
threads did not open at the bottom; the view started a bit short of the end and then
scrolled down to it. And "load stuff faster, be snappier".

## In short

- **The little scroll is gone, measured, on the Mac and the iPhone.** Every way of
  opening a thread (warm, from the saved copy, cold from the host, after a relaunch,
  switching back and forth) now shows its first frame at the end of the chat, and the
  chat does not move after it by itself. On the Mac 11 of 69 openings jumped or glided
  before (446 frames moved in all), none after; on the iPhone simulator every warm,
  saved and relaunched opening glided before, none after. Before, a thread opened from
  memory or from its saved copy started up to a whole long turn (4,400 points) short of
  the end and glided down for half a second to over a second; a thread fetched from the
  host showed one frame of its top (117,567 points from the end for 120 turns on the
  Mac) before jumping down.
- **The cause** was as the backlog guessed, and one more: the lazy transcript's first
  frame is placed by its guess at the height of turns not laid out yet, and the turns
  near the end replace the guess a frame later, leaving the chat short of its new end;
  then the check made "once a reply ends" (`lastTurnState`) also ran when the screen
  appeared, and glided the chat down with an animation at 0.3 s. That glide was the
  scroll the user saw. A thread fetched cold appeared at the top because it was empty
  when its screen appeared (the scroll view's first position is taken then) and its
  history arrived a few frames later.
- **The fix**: the chat is kept out of sight for the few frames it takes to put it at
  its end (to the last turn, which the lazy stack then lays out for real, then to the
  end marker, once a display frame, until it is at the end with the height of the frame
  before), then shown at once, with no animation. Never longer than 0.4 s. The check
  after a reply runs only when a reply ends while the thread is on screen; the safety
  net from 4fd2778 (0.3, 1 and 2.5 s) still runs, and moves the chat only when its end
  is not in view, so it is never seen.
- **The price**: the first frame that shows a thread comes a few frames later than the
  first frame laid out (the frames it is kept out of sight): 10–70 ms on the Mac,
  50–100 ms on the iPhone simulator for a thread opened from memory or its saved copy. In
  exchange it is settled at its end much sooner: on the iPhone simulator a warm thread
  was at its end 0.76 s after the tap before (A, final run), now 0.25 s, as it shows. A
  short thread, one that fits on the screen, is shown as soon as it is laid out.
- **A long thread is read more than twice as fast** once the host's copy arrives (120 long
  turns, a 2.3 MB answer: 102 ms on the Mac before, about 35–45 now, off the main
  thread; the iPhone simulator's fetch-and-read went from 106–118 ms to 60–71). The
  typed answer was read by writing the parsed frame out as JSON and decoding it a
  second time; it is now read straight from the parsed value. And the user's messages
  were each run through two of Hermes's patterns, which Swift built anew every time; a
  message that does not open with a bracket is now known as the user's without them.
- **A thread with nothing of it on the device** shows a spinner after half a second
  while its history comes, not the intro of a new thread ("What should Claude work
  on?").

## How it is measured

`scripts/open-bench.sh` (usage at its top). A scratch bridge with only the fake agent
(port 9351; 9361 for a second one), threads made of the fake agent's long `bench`
reply (headings, lists, code, a table, math, nine tool rows with diffs and output): 1,
10, 45 and 120 turns (the 120-turn one is 2.3 MB on the wire), one with five short
turns and a very long last reply, one with a turn running (the minute-long reply,
started before each run), one waiting on an approval card, and nine short ones. For
each app, on a new scratch home, the app opens (`PORTALS_DEBUG_OPEN_PLAN`, 4 s apart):

| Case | What |
|---|---|
| `cold` | each shaped thread once, with nothing of it on the device: fetched from the host |
| `warm` | the 45 and the 120 back and forth twice, still in memory |
| `cold-small` | the nine short ones, which lets the 45 and 120 go (the app keeps eight) |
| `saved` | the 45 and the 120 again: shown from the saved copy while the host's is fetched |
| `relaunch` | the app quit and started again on the same home, then the 120 and the 45 |

Each opening is measured by the app itself (`Portals/Chat/OpenProbe.swift`,
`PORTALS_DEBUG_OPEN_PROBE`, development builds only): a display link writes, every
frame for 3 s after the request, how far the chat is from its end and how tall it is.
From that:

- `first_dist`: how far the first frame that shows the thread is from the end (points);
- `moves`: frames after it in which the end moved on screen, with nothing touched;
- `lags`: layouts after it that left the chat short of its end, nothing touched (since
  2026-10-22): a reply followed a frame late shows here every time, where `moves` sees it
  only when the display link's frame falls between the two layouts, which varies from run
  to run (the `running` case read 0 to 34 moves with the same build);
- `content_ms`: from the request to the first frame that shows the thread;
- `laid_out_ms`: to the first frame with the thread laid out, shown or not;
- `settled_ms`: to the frame from which the chat stays at its end (3000: never);
- `fetched_took_ms`, `saved_took_ms`: the host's copy asked for and read (on the
  backend's actor, off the main thread), and the saved copy read (on the main thread).

The `running` case streams a reply while it opens: the chat follows it in the same layout
(since 2026-10-22: the end as the scroll view's anchor for size changes while the chat
keeps to it), so it reads 0 moves and 0 lags; followed a frame late, as from 2026-10-21's
plain stack to then, every new line was a lag. `scripts/open-bench/follow.sh` checks the
following itself on a Mac copy: it scrolls the chat (cua-driver, in the background)
while a reply streams, and reads the probe's watch (twice a second, how far the chat is
from its end).

What the app does with the host's answer is timed apart, without the app, by
`OpenBenchmarksWire` (Packages/PortalsKit, `PORTALS_BENCH=1`) on an answer saved from
the bridge (`open.ts fetch` with `BENCH_SAVE`).

The numbers are medians; four agents were building at the same time, with the load
average beside each run in the bench's output (bench/open/* under the night's folder).

## Numbers

Each table: A → B, per case. "Jumped or glided": openings whose first frame shown was
not at the end, or that moved afterwards by themselves, of all the openings of that
case; "farthest first frame": the farthest from the end a first frame was; "frames
moved": all the frames, over all its openings, in which the end moved with nothing
touched; then the medians of the first frame shown and of the chat settled at its end
(3000 when it never was within the 3 s). A turn running is the exception: there the
end moves as the reply grows and the chat follows it a frame later, which is what
following looks like, not the opening.

### Mac (Catalyst, this MacBook Pro, 120 Hz)

A: main + the probe (08f9d58); B: e51f9e8 (the fix as committed, with the faster
reading). Three rounds, A and B in turn, load average 4.4–6.9.

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 1/6 → 0/6 | 0 → 0 | 90 → 0 | 204 → 223 | 208 → 223 |
| warm, 120 turns | 1/6 → 0/6 | 4447 → 0 | 88 → 0 | 206 → 213 | 208 → 213 |
| saved copy, 45 | 0/3 → 0/3 | 0 → 0 | 0 → 0 | 177 → 219 | 177 → 219 |
| saved copy, 120 | 0/3 → 0/3 | 0 → 0 | 0 → 0 | 205 → 242 | 205 → 242 |
| after a relaunch, 45 | 1/3 → 0/3 | 4446 → 0 | 29 → 0 | 199 → 239 | 199 → 239 |
| after a relaunch, 120 | 0/3 → 0/3 | 0 → 0 | 0 → 0 | 180 → 258 | 180 → 258 |
| cold, 1 turn | 3/3 → 0/3 | 3835 → 0 | 234 → 0 | 140 → 167 | 930 → 167 |
| cold, 10 | 1/3 → 0/3 | 12415 → 0 | 1 → 0 | 200 → 199 | 200 → 199 |
| cold, 45 | 1/3 → 0/3 | 45872 → 0 | 1 → 0 | 303 → 285 | 312 → 285 |
| cold, 120 | 2/3 → 0/3 | 117567 → 0 | 2 → 0 | 326 → 345 | 445 → 345 |
| cold, very long last reply | 0/3 → 0/3 | 0 → 0 | 0 → 0 | 158 → 176 | 158 → 176 |
| cold, approval waiting | 1/3 → 0/3 | 15020 → 0 | 1 → 0 | 222 → 200 | 222 → 200 |
| cold, turn running | 2/3 → 0/3 | 15551 → 0 | 2 → 0 | 146 → 222 | 177 → 222 |
| cold, short (9 a run) | 0/27 → 0/27 | 0 → 0 | 0 → 0 | 81 → 90 | 81 → 90 |

Before, 11 of the 69 openings (the running thread left out) jumped or glided, 446
frames moved in all; after, none and none. At this low load the warm, saved and
relaunch cases mostly opened right on the Mac, and when they did not they glided for
over a second (a trial at load 53 had more of them: up to 88 frames). The cold ones
were the worst: one frame of the thread's top (117,567 points from the end for 120
turns), or the 1-turn thread gliding for 0.9 s. The price is the first frame shown,
10 to 80 ms later for a thread opened from memory or its saved copy (the frames it is
kept out of sight: the probe's first frame laid out came at 176–222 ms, the first
shown at 213–258); the cold ones are shown at the end no later than they used to settle
there, and sooner for the long ones (the faster reading).

The build as committed (91e1e8e: a thread that fits on the screen shown as soon as it
is laid out), one round, load 4.7–5.8:

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 1/2 → 0/2 | 0 → 0 | 29 → 0 | 195 → 240 | 334 → 240 |
| warm, 120 turns | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 192 → 220 | 192 → 220 |
| saved copy, 45 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 205 → 227 | 205 → 227 |
| saved copy, 120 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 189 → 234 | 189 → 234 |
| after a relaunch, 45 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 216 → 235 | 216 → 235 |
| after a relaunch, 120 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 164 → 235 | 164 → 235 |
| cold, 1 turn | 1/1 → 0/1 | 3835 → 0 | 73 → 0 | 154 → 164 | 934 → 164 |
| cold, 10 | 1/1 → 0/1 | 12415 → 0 | 1 → 0 | 183 → 203 | 218 → 203 |
| cold, 45 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 359 → 336 | 359 → 336 |
| cold, 120 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 476 → 368 | 476 → 368 |
| cold, very long last reply | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 199 → 169 | 199 → 169 |
| cold, approval waiting | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 197 → 197 | 197 → 197 |
| cold, turn running | 1/1 → 0/1 | 13370 → 0 | 1 → 0 | 156 → 198 | 179 → 198 |
| cold, short (9 a run) | 0/9 → 0/9 | 0 → 0 | 0 → 0 | 113 → 110 | 113 → 110 |

`scripts/open-bench/follow.sh` on B: PASS on all four (follows the end while a reply
streams; scrolled up 24 lines it stays there, 985 to 1,020 points from the end as the
reply grows; scrolled back down it follows again; at the end once the reply is over).

`scripts/open-bench/shots.sh` on B (91e1e8e): the 120-turn thread opened right after a
relaunch, from its saved copy, the case once seen blank until scrolled by hand
(4fd2778): pictured every 0.4 s, it shows at its end with its text from the first
picture it is in (`shots/open-relaunch-B-01.26.png` and `-01.77.png` in the night's
folder), and the probe has it shown 278 ms after the request, at its end, not moving.

### Where the main thread's time goes when threads are opened

`scripts/open-bench/profile.sh` on B: the 45- and 120-turn threads opened in turn every
1.5 s, from memory, `sample` over 20 s (6,790 samples of the main thread). 73% of them
are SwiftUI updating its graph, and most of that (34% of all) the lazy stack placing
the turns near the end, measuring each one's height (28%): a long turn is a deep stack
of Markdown blocks, tool rows with their diffs and output, a table and math. Core
Animation's commit is 9%, Markdown parsing 3% (`ParsedReply.blocks`,
`AttributedString(markdown:)`), measuring text about 1%; the app's own code is under 5%
in all. So a warm thread's 200–250 ms to its first frame is the building and sizing of
the views of its last turns: the turn's rendering (the stream track's files), not the
opening. A long turn folded as one view until it is near the screen, or its tool rows
built only when opened, is where the next gain is.

The thread waiting on an approval, opened the same way right after a relaunch, shows at
its end with the approval card above the composer (`shots/open-relaunch-approval-02.00.png`
in the night's folder).

### Tried and dropped

The settling seeded with the height laid out before the chat was first moved to its end,
so that a first frame at the end with that height would be shown at once: the time out
of sight was the same within the noise (iPhone simulator, two rounds: 51–54 ms against
55–58; Mac, one round: no better), as the height nearly always changes with the move.

The end as the scroll view's anchor for size changes (`defaultScrollAnchor(.bottom, for:
.sizeChanges)`) while a thread is out of sight or its history comes, so that the turns
near the end would be laid out first: on the Mac the same as without; on the iPhone
simulator the 45- and 120-turn threads fetched cold were shown 125 and 245 ms later.

### iPhone 18 Pro Max simulator

A: main + the probe (08f9d58); B: the first version of the fix (0f7bd52: the end looked
for after a 16 ms sleep, two steady frames; with the faster reading). Two rounds, load
5.7–10.

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 4/4 → 0/4 | 1586 → 0 | 155 → 0 | 133 → 227 | 1069 → 227 |
| warm, 120 turns | 4/4 → 0/4 | 2123 → 0 | 117 → 0 | 154 → 232 | 747 → 232 |
| saved copy, 45 | 2/2 → 0/2 | 1363 → 0 | 30 → 0 | 194 → 229 | 473 → 229 |
| saved copy, 120 | 2/2 → 0/2 | 5572 → 0 | 29 → 0 | 212 → 256 | 470 → 256 |
| after a relaunch, 45 | 2/2 → 0/2 | 1363 → 0 | 54 → 0 | 251 → 262 | 784 → 262 |
| after a relaunch, 120 | 2/2 → 0/2 | 519 → 0 | 26 → 0 | 378 → 470 | 717 → 470 |
| cold, 1 turn | 2/2 → 0/2 | 2149 → 0 | 39 → 0 | 320 → 349 | 760 → 349 |
| cold, 10 | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 184 → 226 | 184 → 226 |
| cold, 45 | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 294 → 406 | 294 → 406 |
| cold, 120 | 2/2 → 0/2 | 155755 → 0 | 2 → 0 | 292 → 456 | 410 → 456 |
| cold, very long last reply | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 122 → 194 | 122 → 194 |
| cold, approval waiting | 2/2 → 0/2 | 19897 → 0 | 2 → 0 | 138 → 258 | 212 → 258 |
| cold, turn running | 1/2 → 2/2 | 0 → 0 | 15 → 44 | 178 → 224 | 1590 → 2798 |
| cold, short (9 a run) | 0/18 → 0/18 | 0 → 0 | 0 → 0 | 60 → 112 | 60 → 112 |

That first version already took every jump away (the running thread's moves are the
reply growing), and settled warm threads at their end four times sooner, but showed
them 60–100 ms later. The second version (e51f9e8: once a display frame, one steady
frame):

Two rounds, load 4.5–14.6:

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 4/4 → 0/4 | 5572 → 0 | 85 → 0 | 192 → 244 | 444 → 244 |
| warm, 120 turns | 4/4 → 0/4 | 5572 → 0 | 59 → 0 | 174 → 240 | 446 → 240 |
| saved copy, 45 | 2/2 → 0/2 | 2441 → 0 | 26 → 0 | 204 → 246 | 446 → 246 |
| saved copy, 120 | 2/2 → 0/2 | 1839 → 0 | 28 → 0 | 192 → 254 | 466 → 254 |
| after a relaunch, 45 | 2/2 → 0/2 | 5572 → 0 | 27 → 0 | 211 → 269 | 454 → 269 |
| after a relaunch, 120 | 2/2 → 0/2 | 0 → 0 | 17 → 0 | 293 → 416 | 570 → 416 |
| cold, 1 turn | 2/2 → 0/2 | 1869 → 0 | 38 → 0 | 336 → 328 | 752 → 328 |
| cold, 10 | 2/2 → 0/2 | 19470 → 0 | 2 → 0 | 162 → 236 | 207 → 236 |
| cold, 45 | 1/2 → 0/2 | 60667 → 0 | 1 → 0 | 250 → 362 | 309 → 362 |
| cold, 120 | 2/2 → 0/2 | 155755 → 0 | 2 → 0 | 314 → 390 | 439 → 390 |
| cold, very long last reply | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 148 → 164 | 148 → 164 |
| cold, approval waiting | 1/2 → 0/2 | 19897 → 0 | 1 → 0 | 150 → 247 | 186 → 247 |
| cold, turn running | 1/2 → 0/2 | 22366 → 0 | 1 → 0 | 159 → 258 | 182 → 258 |
| cold, short (9 a run) | 0/18 → 0/18 | 0 → 0 | 0 → 0 | 76 → 121 | 76 → 121 |

No jump in any case (also the running thread this time); settled at the end 180–230 ms
sooner for the warm, saved and relaunched threads; the first frame shown 40–70 ms
later for those, the frames it is kept out of sight.

The build as committed (91e1e8e: also a thread that fits on the screen shown as soon as
it is laid out), two rounds, load 4.5–8.2:

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 4/4 → 0/4 | 5572 → 0 | 121 → 0 | 198 → 258 | 759 → 258 |
| warm, 120 turns | 4/4 → 0/4 | 4840 → 0 | 121 → 0 | 196 → 248 | 758 → 248 |
| saved copy, 45 | 2/2 → 0/2 | 2123 → 0 | 57 → 0 | 194 → 262 | 754 → 262 |
| saved copy, 120 | 2/2 → 0/2 | 5572 → 0 | 26 → 0 | 207 → 279 | 463 → 279 |
| after a relaunch, 45 | 2/2 → 0/2 | 5572 → 0 | 27 → 0 | 214 → 278 | 456 → 278 |
| after a relaunch, 120 | 2/2 → 0/2 | 0 → 0 | 30 → 0 | 322 → 426 | 708 → 426 |
| cold, 1 turn | 2/2 → 0/2 | 4906 → 0 | 13 → 0 | 212 → 326 | 352 → 326 |
| cold, 10 | 1/2 → 0/2 | 19470 → 0 | 1 → 0 | 176 → 238 | 194 → 238 |
| cold, 45 | 1/2 → 0/2 | 60667 → 0 | 1 → 0 | 264 → 374 | 307 → 374 |
| cold, 120 | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 367 → 386 | 367 → 386 |
| cold, very long last reply | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 120 → 200 | 120 → 200 |
| cold, approval waiting | 2/2 → 0/2 | 19897 → 0 | 2 → 0 | 122 → 250 | 202 → 250 |
| cold, turn running | 0/2 → 0/2 | 0 → 0 | 0 → 0 | 184 → 250 | 184 → 250 |
| cold, short (9 a run) | 0/18 → 0/18 | 0 → 0 | 0 → 0 | 78 → 104 | 78 → 104 |

No jump anywhere; warm, saved and relaunched threads settled at their end 180–500 ms
sooner; shown 50–100 ms later than A first showed them (out of sight while they find
their end), and the cold ones 20–130 ms later.

### iPad simulator

A: main + the probe (08f9d58); B: f497c2e (the fix as committed). One round (an iPad
check, not a measure: load 14–37).

| Case | jumped or glided | farthest first frame, pt | frames moved | first frame shown, ms | at its end, ms |
|---|---:|---:|---:|---:|---:|
| warm, 45 turns | 2/2 → 0/2 | 1349 → 0 | 51 → 0 | 214 → 226 | 747 → 226 |
| warm, 120 turns | 2/2 → 0/2 | 4118 → 0 | 86 → 0 | 212 → 230 | 1120 → 230 |
| saved copy, 45 | 1/1 → 0/1 | 2077 → 0 | 15 → 0 | 179 → 230 | 448 → 230 |
| saved copy, 120 | 1/1 → 0/1 | 4424 → 0 | 15 → 0 | 202 → 248 | 471 → 248 |
| after a relaunch, 45 | 1/1 → 0/1 | 1564 → 0 | 39 → 0 | 211 → 245 | 1061 → 245 |
| after a relaunch, 120 | 1/1 → 0/1 | 4740 → 0 | 11 → 0 | 278 → 287 | 588 → 287 |
| cold, 1 turn | 1/1 → 0/1 | 3611 → 0 | 1 → 0 | 314 → 207 | 370 → 207 |
| cold, 10 | 1/1 → 0/1 | 16037 → 0 | 1 → 0 | 201 → 219 | 236 → 219 |
| cold, 45 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 333 → 398 | 333 → 398 |
| cold, 120 | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 436 → 383 | 436 → 383 |
| cold, very long last reply | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 164 → 169 | 164 → 169 |
| cold, approval waiting | 0/1 → 0/1 | 0 → 0 | 0 → 0 | 270 → 203 | 270 → 203 |
| cold, turn running | 1/1 → 0/1 | 34 → 0 | 15 → 0 | 261 → 206 | 2904 → 206 |
| cold, short (9 a run) | 0/9 → 0/9 | 0 → 0 | 0 → 0 | 82 → 118 | 82 → 118 |

The same as on the iPhone: every opening that glided or jumped before (10 of 23, the
running thread left out) opens at its end; no crash report.

### What the app does with a long thread's answer

`OpenBenchmarksWire`, the 120-turn thread's answer (2.3 MB), Release, on this Mac,
before and after, the same load (8–11):

| | Frame parsed | Read as a `session.resume` | Made a transcript | Total |
|---|---:|---:|---:|---:|
| before (15a49fa) | 28 ms | 38 ms | 36 ms | 102 ms |
| after | 28 ms | 0.3 ms | about 15 ms | about 45 ms |

The frame is still parsed by `JSONDecoder` into a `JSONValue`, by trying each kind of
value in turn. Foundation's `JSONSerialization` did it in 11 ms, but read some numbers
a bit differently from `JSONDecoder` (the tests that compare the two bit for bit,
`ValueReadingTests`, caught it), and its strings came bridged, which made everything
after slower until copied; left as a proposal below.

## Review

Codex reviewed the branch as a Portals thread ("Night review: A thread opens at its end,
and fast"). What it found, fixed with tests:

- An empty thread followed again after a reconnect showed its loading spinner for
  ever: the host replays nothing and says the thread is caught up, which did not end
  the loading. Whether a thread's history is on its way is now kept with the thread's
  state (`ThreadState.isLoadingHistory`), and taking in the host's copy, a snapshot
  or the stream's "caught up" each end it.
- The faster reading of a typed answer read some values differently from
  `JSONDecoder`: a `Decimal` (failed), a `Float` (rounded twice, not refused out of
  range), a whole number past 2^53 and 128-bit ones, a list element after a failed
  try, and some error kinds. These now read as before (from the number's text where
  `JSONDecoder` reads the text); none of them is in a thread's history, and the typed
  read of the 120-turn answer is still under a millisecond.
- `EndSettling` no longer takes frames with nothing laid out (no height) for a chat
  steady at its end.
- The bench: a scratch copy can no longer change an app it was linked to or a file a
  link in it leads to; a run that did not open every thread, opened them out of plan
  or not in the way its case says is left out of the tables; a launch given up on is
  undone (its probe lines and its home) before the next try; follow.sh fails when a
  check fails. Every run written up above passes these checks.

Spot-checked in review: one Mac A/B round (A = main + probe, B = the fix; load 7.5):
A, 5 of 23 openings jumped or glided besides the running one (157 frames moved); B, 0
of 24. On the iPhone simulator, the reviewed build: 24 of 24 openings at their end, no
frame moved, no crash report.

## What is left

- **The first frame shown comes a few frames later** than before for a warm or cold
  thread (the frames it is kept out of sight): 10–70 ms on the Mac, 50–100 ms on the
  iPhone simulator. The way to win them back is for the turns near the end to be laid out
  for real before the first frame: a lazy stack cannot be asked that, but a thread
  could remember its turns' heights (per thread, per width) so its guess is exact when
  it is opened again. Not built: it needs the heights from TurnView (the stream track's)
  and a cache that follows the width.
- **Opening a warm thread costs 130–230 ms** to its first frame on the iPhone simulator
  even before the fix: building the screen and laying out the last turn, a long one
  with code blocks, a table and math. That is the turn's rendering (the stream track's
  files): a long last turn could be built from its end first.
- **A thread let go and opened again fetches its whole history again** (2.3 MB for 120
  turns), even when nothing changed. The bridge can already send only what changed
  (`resume_replay`), but only to a connection that followed the thread up to an event;
  a saved copy could keep its replay point (epoch, last event, base) so that opening it
  again asks for what changed only. Proposal, not built.
- **Parsing a frame** is still 28 ms for 2.3 MB: a parser written for `JSONValue`
  (bytes to values, numbers read as `JSONDecoder` reads them) would be several times
  faster for every frame, also while a reply streams.
- **The saved copy is read on the main thread** (12–27 ms for 45–120 turns on the
  iPhone simulator); it could be read off it while the screen is built.
- **The sidebar overlay on the iPhone** was not driven by the bench (no way to tap in
  the simulator from a script); the chat it opens is the same screen and the same code.
