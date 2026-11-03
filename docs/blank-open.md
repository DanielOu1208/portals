# A thread opened blank until scrolled by hand

2026-10-19, on an iPhone: tapping a thread's row in the sidebar sometimes opens
it blank, nothing of the transcript, only the subagents line at the bottom when one is
running; scrolling a little makes the thread appear. Seen most with a thread that is
running, right after coming back to the app, and long threads or threads with visuals.
Reproduced on an iPhone 17 Pro simulator (iOS 27.0, Xcode 27, Debug) the same evening,
branch `fix/blank-open` from main e8e5d88, on a Mac mini at load 5 to 18.

## In short

The benchmark is now a gate as well as a report: missing or skipped UI work, missing
measurements, a blank screenshot after the dwell, or a probe blank lasting at least
one second (or never clearing) exits nonzero. Leaving a still-blank chat hidden or
closed (`aside`/`gone`) also fails, even under one second. Short genuine recoveries
remain in the report. UI-test failures and failed relaunches also fail the driver; `repairs.sh`
keeps every mode's summary and fails if any mode fails. The offline regressions run
with `python3 -I -B scripts/test-tools.py` (up to four file workers), without a
simulator, bridge, or Xcode build. Use `--jobs 1` for one worker, or
`python3 -I -B -m unittest discover -s scripts/tests -p 'test_*.py' -v` for the
original single-process run. The offline driver fixtures inject a 0.01 s poll and
0.65 s exit grace through `BLANK_UI_POLL_SECONDS` and `BLANK_UI_EXIT_GRACE_SECONDS`;
the real benchmark defaults remain 1 s and 2 s. Its late-failure fixture still
waits 0.5 s before failing.

- **It reproduces, nearly every time, with one thread shape**: "Visuals 45" (45 turns,
  a visual every few, ending on three turns with visuals: a tall list, five visuals, a
  savings calculator). Opened from the sidebar it showed nothing at 5 of 5, 8 of 9 and 8
  of 9 openings in three runs; opened from memory it stayed blank until the chat was
  slid aside or dragged (up to the 4.5 s the runs waited), and a short drag brought it
  back, as the user says. Pictures: `/tmp/portals-blank-repro/out/proof/none/shots/`
  (`uitest-main-shot-2.jpg` blank, `-3.jpg` after the drag), `out/run2/shots/`.
- **Elsewhere it is brief**: a long thread opened cold (fetched, or right after a
  relaunch from its saved copy) was sometimes blank for 1.1 to 3.2 s, until the host's
  copy was taken in; a thread with a reply streaming, for 90 to 175 ms after it was
  shown. Coming back from Settings, and the app ended in the background and opened again
  on its thread, added nothing of their own (44 taps, 16 comings back and 4 relaunches a
  run).
- **What the blank is**: the lazy stack has built *none* of its turns (no `TurnView`
  appeared, no visual's view in the UIKit scroll view), though its frame covers the
  screen, and the scroll view sits at the end of the stack's estimated height
  (`dist` 0). Nothing the safety nets look at is wrong, and the open probe counts it as
  shown at its end.
- **What repairs it**: only a scroll to a *row of the lazy stack*. `proxy.scrollTo(last
  turn, anchor: .bottom)` repaired 4 of 4 within 100 to 140 ms of it being seen, at the
  end (dist 0), nothing jumping; the turn before the last and then the end marker a frame
  later, 5 of 5; the last turn and the end marker a frame later, 4 of 4. A scroll to the
  end marker (outside the stack), UIKit moving the offset 1 point and back (in one frame
  or two), or a UIKit layout pass repaired none (0 of 4 each). **The last turn and the end
  marker in the same frame, which is what `settle` and the 0.3/1/2.5 s safety net do,
  repaired 0 of 4**: the second scroll, worked out from the stale estimate, undoes the
  first.
- **What prevents it**: `settle` making one move a frame (to the last turn, and only in
  the next frame to the end marker). Visuals 45: 0 blank of 5 openings, where 5 of 5
  were; the whole plan: 1 blank where there were 10. With a chat still left blank moved
  to a turn as well, the fix that went in (What was done, below): 3 blanks in 128
  openings, none longer than 254 ms, and no blank screen in 126 looks.

## How it was found

`PORTALS_DEBUG_BLANK=<file>` (`Portals/Chat/BlankProbe.swift`, development builds in a
simulator or on a Mac only): each turn tells a box that nothing draws when the lazy stack
builds it and lets go of it (`onAppear`/`onDisappear`), where it is in the scroll view
(`frame(in: .scrollView)`) and whether the scroll view counts it as visible
(`onScrollVisibilityChange`); a display link looks at the box once a frame and writes a
line when the chat is shown (not kept out of sight, not slid aside) with turns and none
of them between its bars for 3 frames (`blank`), at 0.5, 1, 2 and 5 s (`persist`), and
when it ends and why (`clear`, `by` repair, hand, aside, self), with the thread, the
geometry, the built turns' indexes, the frames of the last turn, the stack and the end
marker, and what UIKit has in the scroll view. `PORTALS_DEBUG_BLANK_TRACE` adds each turn
built or let go of and each geometry change over a chat's first 4 s;
`PORTALS_DEBUG_BLANK_FIX` tries a repair on what it sees.

`scripts/blank-bench.sh` runs it: a scratch bridge on 9374 with only the fake agent and
threads made by `bridge/scripts/bench/blank.ts` (Long 60, Long 45, Visuals 45, Streaming
45 and Streaming visuals, the last two streaming the fake agent's minute-long reply over
and over), a copy of the app under its own bundle id, and the UI test
`scripts/phone-bench/uitest/UITests/BlankUITests.swift`, which taps the sidebar's rows,
puts Settings in front and comes back (and taps a row at once), and after each opening
looks at a picture of the screen for text in the chat's middle (`ink`), keeping the blank
ones: a check that does not rely on the probe. Then the app is ended in the background
(kill -9 with Settings in front) and launched again on the thread it had on screen, four
times. `scripts/blank-bench/repairs.sh` runs it once per repair; `summary.py` sums a run up.
The UI test taps the sidebar's button where it is and waits for the chat to slide aside
(2026-10-22: tapped as an element, it did nothing on the new thread the app opens to, so
every row tapped after it landed on that empty chat and every look read as blank), and
the bench ends an `xcodebuild` left on after the tests, reading their verdict from its log.

## Why it happens (from the traces)

A warm opening of Visuals 45 after a long thread, frame by frame (`out/longs/none`):
the new scroll view starts on the lazy stack's first estimate (about 3,000 points a
turn: 136,027 for 45 turns) at its bottom (offset 135,153). The stack then measures a
little of it and estimates 91,060, but the offset stays at 135,153: the screen is past
the end, where there are no rows, and none is built. The check for a chat past its end
and `settle` move it to the end marker, which is after the stack, while the stack's
estimate shrinks (77,009, 55,934, 48,909) without it ever building a row. It ends at the
end of an estimate that its rows do not reach, and stays there: nothing moves it, and
moving to the end marker lands in the same place. A long thread whose turns are all
taller than the estimate (5,913 points each here) grows instead: the offset stays inside
it, and its last turns are built in the first frame. A long thread ending on one short
turn, or on one turn with a visual, did not open blank from memory (0 of 6 and 0 of 3);
Visuals 45 ends on three short ones (a tall list, then 1,558 and 415 points). On the phone, what
does the same would be any long thread ending on a few turns shorter than the estimate:
visuals, short replies, a turn just started. That last part is a guess.

## What was done (2026-10-19)

The fix is in `ChatScreen`, with no restructuring; `PORTALS_DEBUG_BLANK_SETTLE=before`
gives back the app as it was, to compare on one build.

1. **`settle` makes one move a frame**: to the last turn, and only in the next frame to
   the end marker, never both in one.
2. **A chat left blank is moved to a turn** (`repairIfBlank`). Blank is the lazy stack on
   screen (its end below the top of the view) with *none* of its rows built
   (`BuiltTurns` in AgentCore, each row noting in a box that draws nothing when the
   stack builds it and lets go of it; the messages waiting under the turns count too),
   for three frames in a row. Looked at a few frames after the chat is shown, each time
   the stack lets go of a row (the host's copy taking the place of the one kept here
   included), and by the safety net at 0.3, 1.3 and 3.8 s. The move: to the last turn,
   then, once the stack has built a row there (up to six frames), to the end marker if the
   chat keeps to its end; still blank, to the turn before the last. Two moves at most each
   time it goes blank, one at a time, and none for a chat that has left the screen.
3. **The safety net**, when the end is not in view, moves to the end marker alone, as it
   did in effect before (its move to the last turn in the same frame was undone).

Three ways of telling a blank chat were tried before this one, and given up:
`onScrollVisibilityChange` (it counts a fraction of the turn, and a reply many screens
tall streaming never showed one: it moved a streaming thread five times in a row with
nothing blank); a turn's frame against the view (a row built already in view, whose
answer never changes, was never told, and a second move was made on a chat already
back); and one look, not three frames (a frame with nothing built while a reply streams
was taken for a blank). Moving to the end marker in the frame after the turn, rather
than once a row is built, put the chat back where it was blank (the offset never moved,
2.3 s blank).

With the fix, on the same bench (`none`; the moves the app made, written to the probe's
file, checked against its blanks):

| | before (same build) | with the fix |
|---|---|---|
| Visuals 45, 10 openings a run | 4 blank in 1 run, each 3.9 to 4.4 s, until slid aside or dragged | 1 blank in 3 runs, 254 ms |
| the whole plan, 49 openings and 4 relaunches a run | 9 blank in 1 run, 8 of them 1 s or more | 2 blank in 2 runs, 213 and 168 ms |
| pictures with almost nothing in the chat | 12 of 58 | 0 of 126 |
| moves made by the fix | | 3, each on a chat the probe saw blank; cleared 0.15 to 0.24 s after |

Not measured: a real phone at 120 Hz, a running subagent (the fake agent has no
subagents, so the subagents line was never on screen), and threads from real agents. A
thread with a reply streaming can still be blank for a fraction of a second as it opens
(168 ms above), as it could before.

## Re-running it

    xcrun simctl create Portals-blank-repro com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0
    (cd bridge && npm ci --ignore-scripts)
    xcodebuild -project Portals.xcodeproj -scheme Portals -configuration Debug \
      -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath /tmp/portals-blank-repro/dd \
      CODE_SIGNING_ALLOWED=NO build
    xcodebuild build-for-testing -project scripts/phone-bench/uitest/WidgetUI.xcodeproj -scheme UITests \
      -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath /tmp/portals-blank-repro/dd
    A=/tmp/portals-blank-repro/dd/Build/Products/Debug-iphonesimulator/Portals.app
    X=/tmp/portals-blank-repro/dd/Build/Products/UITests_iphonesimulator27.0-arm64.xctestrun
    scripts/blank-bench.sh --sim <udid> --app $A --xctestrun $X                  # the whole plan
    scripts/blank-bench/repairs.sh --sim <udid> --app $A --xctestrun $X \
      --modes "before none"                                                      # Visuals 45, before the fix and with it
    scripts/blank-bench/repairs.sh --sim <udid> --app $A --xctestrun $X --plain \
      --modes "before none"                                                      # the whole plan, the same

`before` is `PORTALS_DEBUG_BLANK_SETTLE=before`, the app as it opened threads before the
fix; `none` is the app as it is. The probe's own repairs (`PORTALS_DEBUG_BLANK_FIX`) were
tried on the app before the fix, and still run on top of it. The moves the fix makes are
written to the probe's file (`repair-look`, `repair-move`).

The first run seeds the bridge's home (about 3 minutes) into `/tmp/portals-blank-repro/
bridge-template`; `blank.ts add … shortlast|vislast` adds the two control threads.
