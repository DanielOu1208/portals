# Coming back to the app: what moved, and how soon it is current

2026-10-17, a priority: on the phone and on the Mac, leaving the app and coming
back to it shows small movements, things shifting about, which makes it feel strange;
nothing should move. And on 2026-10-18: "switching from other apps back into Portals
sometimes it will also jump and stuff, the app should just return to the state it was
left in". Looked into and fixed on the night of 2026-10-18 (branch `n4/return`, from
main 15a49fa). The numbers are from Release builds that read the launch switches
(`SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG`), on the MBP16 with four other agents
building at the same time (load 4 to 13, beside each run in the bench's files).

In short:

- **The biggest movement was the app saying it had lost the connection it let go of
  itself.** In the background the app closes every host's connection (battery), and
  opens it again on the way back. Shown as it was, that is the chat's "Reconnecting…"
  banner coming down over the header once the app had been away more than a moment and
  sliding away again once the host answered, moving the whole chat 36 points (27 on the
  Mac) down and back up, twice on each return; and the sidebar's foot reading Not
  connected with a Retry button, then Connecting…, then the Mac's name. A connection the
  app let go of while it was up now shows as up until the host answers again (a fraction
  of a second), the attempt fails, or three seconds pass (`ComingBack`, `HostModel.isAway`,
  `shownConnection`). With nothing changed while away, nothing moves now: none of 22
  returns moved anything (15 on the iPhone simulator, 7 on the Mac, an approval card and
  the phone's sidebar slid over the chat among them), where all 14 before did.
- **What changed while away arrives without the sidebar's animations**, for four seconds
  from the return and from the reconnect after it (`ComingBack.isQuiet`,
  `HostModel.quietly`, `isCatchingUp`): a thread that finished meanwhile is in its place
  at once rather than gliding there, and the groups on top take their new height at once.
  A thread's catch-up is taken in whole at its end (`CatchUpHold`): applied event by
  event, a frame could show a turn that ended while away running again, its thread in
  Running and the list jumping 90 points down and back.
- **The thread whose chat is on screen is never listed under Finished.** A turn that ended
  in it while the app was away showed there as the app came back and left once the host
  was told it was seen, Finished closing and the list sliding up (Mac, iPad).
- **A chat scrolled up stays where it is** when a turn begun elsewhere arrives or is caught
  up on return; it was pulled to its end. What you send (a message, a command, a retry)
  still brings the end into view, and the chat keeps to it to show what that becomes.
- **On a Mac, another app in front and back no longer scrolls the chat**: with the composer
  focused, its focus went with the app and came back with it, which the chat took for you
  starting to type and glided to its end (9 turns about 100 points, every time), the
  avatar going from listening to idle and back. Focus that comes back with the app now
  changes nothing (`FocusWithApp`, `Platform.isAppActive`). This is likely the
  movement the user saw on the Mac when only focusing and unfocusing the app: nothing else
  moves then. (The same went for a panel opened over the chat and closed, an expanded
  visual for one, until 2026-10-20: docs/visuals.md, `PanelOpenKey`.)
- **The wash and the avatars go on from where they stopped** instead of jumping ahead by
  as long as the app was away (the wash's `WashClock` since n4/wash, `Pause`); a coding agent's breathing logo
  is paused by its layer's clock rather than taken off and started over.
- **The paste button** reads the clipboard again only when it changed (`changeCount`).
- **Faster catch-up**: the hosts are reached as the app starts to show again (the scene
  inactive on the way back) rather than once it is active, and on reconnecting what is at
  work and the list are asked for first. Behind a link of 50 ms each way, the list is
  current 0.60-0.69 s after the return where it was 1.14-1.25 s, the open thread caught up
  after 0.49-0.52 s where it was 0.91-1.07 s. The bytes are as they were, a little less
  where a thread was caught up twice (the bridge's `resume_replay` and `poll_now` were
  already in use and need nothing more).
- **The app ended by the system in the background opens with the thread that was on
  screen**, at its end, where it opened with a new thread.

## How it was measured

`scripts/return-bench.sh` (usage at its top), with the probe behind
`PORTALS_DEBUG_RETURN` (`Portals/App/ReturnProbe.swift`): the app writes, each
time it changes, the frame of every sidebar row and group title, every turn of the chat,
the composer, and the chat's scroll position and content height, with what it does
meanwhile (the scene's phase, the connection, the agents listed, the list merged, the
thread caught up or taken whole). The bench runs a scratch bridge (scripted agent, 60
threads) behind a relay that counts the bytes and can be slowed to a phone's link, and
leaves and comes back to:

- the Mac: a scratch copy (`com.danielou.portals.n4-return`), through NSRunningApplication
  (`scripts/return-bench/app.swift`): Finder in front and back; hidden (as Command-H) and
  shown; its window covered by another and uncovered; hidden while a turn runs in the
  open thread, in another thread, and while a reply is still streaming as it comes back;
  then the same with the chat scrolled up;
- the iPhone simulator: Preferences in front and back (the background), the same turns,
  with a screen recording of each round; then the app ended in the background
  (`simctl terminate`) and opened again.

Simulator runs require an explicit target:
`SIM=<booted-iOS-simulator-UDID> scripts/return-bench.sh sim <built.app> <dir> <label>`.
The script checks that target before preparing a separately signed copy with bundle
ID `com.danielou.portals.n4-return`. It replaces only that scratch bundle, never
`com.danielou.portals`, and leaves the supplied build unchanged. The scratch app is
left installed but stopped. No simulator is selected or booted implicitly.

`summary.py` says, for each return, what moved within 3 s (a frame changed by more than
half a point: the movement metric), the chat's scroll changes, when the connection, the
agents, the list and the open thread were current, and the bytes through the relay.
Movement that is the change itself (a new turn below a chat at its end, rows taking their
new order after a real change) is counted too, and read apart below.

## The numbers

iPhone 18 Pro Max simulator, nothing changed while away (4 s in the background), the
long thread open at its end. A/B interleaved, base 15a49fa with the probe (bbfe453):

| | returns | moved | the chat |
| --- | ---: | --- | --- |
| before | 4 | 4-5 turns, 36 pt, every return | down 36 and back at 0.17-0.24 s, again at 0.62-0.67 s (the banner) |
| after | 5 | nothing | still |

Mac (scratch copy, local bridge), each case once a run; before: two runs of base, after:
the branch's last build (fix7) and the two builds before it (fix5, fix6) where the case
was already fixed in them:

| | before | after |
| --- | --- | --- |
| Finder in front and back | nothing moved | nothing moved |
| covered and uncovered | nothing | nothing |
| hidden 4 s and shown | 5-6 turns, 27 pt down and back, twice | nothing (3 of 3) |
| chat scrolled up 100 pt, Finder in front and back | nothing | nothing |
| chat scrolled up 100 pt, hidden and shown | 8 views, the chat 27 pt down and back | nothing (3 of 3) |
| a turn in the open thread while hidden | the chat 27 pt down and back; Finished opened over the list with the thread on screen in it, then closed | the new turn below, the chat to its new end (97-98 pt) in one step, nothing else |
| the same, chat scrolled up | pulled to the end (about 460 pt) | stays; the new turn below (fix6, fix7); fix6 still showed the replayed turn running for 40 ms, Running opening and the rows 91 pt down and back, gone in fix7 |
| a turn in another thread while hidden | the chat 27 pt down and back, 8 rows | the two rows trade places (34 pt): the real change |
| the composer focused with a draft, chat scrolled up, Finder in front and back | 9 turns about 100 pt: the chat glided to its end (base and the branch before the fix) | nothing |
| the same, hidden and shown / a turn in the open thread while hidden | the chat 27 pt down and back / pulled to its end | nothing / stays, the new turn below |
| an approval card waiting, Finder in front and back / hidden and shown | not run on base on the Mac (the iPhone's base: the banner, 36 pt down and back twice) | nothing |

iPhone simulator with an approval card waiting over the composer, the background and back:
before, the chat 36 pt down and back twice; after, nothing. The same with the sidebar slid
over the chat (`PORTALS_DEBUG_SIDEBAR=1`): before, every return moved the chat behind
it, by up to 1949 pt as its turns were laid out again; after, nothing with nothing
changed, and only the rows that really changed when a turn ended in another thread.

How soon it is current, iPhone simulator behind a link of 50 ms each way (a phone on a
mobile network reaching the Mac through Tailscale), seconds after the app was asked to
come back, two runs each:

| | connected | open thread caught up | list current | agents listed |
| --- | --- | --- | --- | --- |
| before | 0.79-0.84 | 0.91-1.07 | 1.14-1.25 | 1.10-1.18 |
| list asked first | 0.80-0.84 | 0.91-1.04 | 1.03-1.10 | 1.01-1.05 |
| and reconnecting at inactive | 0.38-0.56 | 0.49-0.75 | 0.61-0.81 | 0.59-0.78 |
| and one catch-up, taken in whole (the branch) | 0.38-0.41 | 0.49-0.52 | 0.60-0.69 | 0.59-0.62 |

(Rows 2 and 3 are steps on the way, two runs each; the first and last rows three runs
each. The last row's catch-up is one `session.resume` where the step before made two: the
agents being listed after the reconnect asked for it again while the first one's events
were still on their way in.)

On the Mac against a local bridge the whole catch-up takes 0.1-0.3 s either way.

Bytes through the relay per return (same before and after): nothing changed, 1.16 KB up
and 2.66 KB down; a turn ended in the open thread, 1.3 KB up and 4.0-5.5 KB down; a reply
still streaming, 10-12 KB down (the reply itself). The thread's catch-up is the bridge's
light replay (`resume_replay`); the list is fetched only when it moved (`thread_sync`'s
revision); the host says when to poll (`poll_now`). Both features are always on in a
default bridge config and the app asks for them; nothing on the bridge needed changing.

The app ended by the system in the background (iPhone simulator, at the end of every run:
8 before, 13 after): before, it opened with a new thread each time; after, with the
thread that was on screen each time.

## What moved, cause by cause

1. **The connection banner** (`ChatScreen`, `ConnectionBanner`): `isConnected` went false
   as the app closed the connection in the background; after `ChatFeature.connectionGrace`
   (1.5 s) the banner was put up, which the app still in the background on the way out
   (or a Mac window hidden) did; on return it showed in the first frames, then slid away
   once connected, moving the chat with the top bar. Fixed by `shownConnection`.
2. **The sidebar's foot** (`AgentSidebar.footer`): Not connected and Retry, Connecting…,
   the Mac's name, a line taller then shorter. Same fix.
3. **Groups and rows after a real change** (`AgentSidebar`'s `.smooth` animations, the
   groups' animated height): animated as though the change happened then. Now at once
   while catching up (`quietly`, `isCatchingUp`).
4. **The thread on screen under Finished** on return. Fixed by `ThreadRecord.inSight`.
5. **A replayed turn shown running for a frame** (events applied one at a time while the
   backend was still yielding them). Fixed by `CatchUpHold`; the second catch-up that the
   agents being listed asked for meanwhile is skipped too.
6. **A chat scrolled up pulled to the end** by a turn from elsewhere
   (`ChatScreen.onChange(of: lastMessageID)`). Fixed: a new message scrolls only a chat
   that keeps to its end, and what you send makes it keep to its end
   (`ThreadController.sentHere`); and on a Mac by the composer's focus coming back with the
   app (`onChange(of: isComposing)`). Fixed by `FocusWithApp`.
7. **The wash** (`AmbientGradient`): its time was the wall clock's, so after a pause it
   jumped ahead (only while it moves, during a reply). `GaplessClock` here; `n4/wash`
   redraws the wash with Metal with a gapless clock of its own (`WashClock`), and at the
   merge (n4/all) its file was taken and `GaplessClock`, used by nothing else, removed.
8. **The avatars** (`AgentAvatarDirector`): a pure function of the time since their
   origin; paused in the background, they jumped ahead on return (mid-thought, mid-blink).
   The origin moves by the pause (`Pause`). **The logo's breathing** (`AgentLogo`) was
   taken off and added again from its smallest: now its layer's clock is stopped.
9. **The paste button** (`ChatComposer`): read anew on every `didBecomeActive` and focus
   change; now only when `changeCount` moved.
10. **Saving everything on the way out** (`HostModel.persist`): changed the list in place,
   which told the sidebar it changed though nothing did; now the list is put back whole
   and only when it differs. Not a movement, but a whole sidebar layout per open thread.

What did not move, before or after: the Mac app with Finder in front and the composer not
focused (the scene stays active on a Mac, so nothing happens), a window covered and uncovered (only the wash and the
avatars pause), the composer's draft and its focus on the iPhone (kept through the
background), the sidebar's rows with the sidebar at its top and the selected row.

## What the review changed (Codex, four rounds, no P1 or P2 left)

The review of the branch (Codex thread "Night review: Nothing moves when the app comes
back", reviews/return-r1..r4.md in the night's folder) found, and the branch now has:

- **A thread running as the app left** is caught up in one change too: the backend's own
  replay on reconnecting is marked (`ThreadEvent.catchUpBegan` before it, `.caughtUp`
  after it, nothing awaited between) and held like a catch-up the thread asks for.
- **What you send** keeps the chat to its end from the moment you send it
  (`ThreadController.sentHere`, a retry counted once), and only then: a slash command's
  answer, or a queued message's turn, was left out of sight with the chat scrolled up,
  and a late steer receipt pulled a chat scrolled up after sending back down.
- **The composer's focus that does not come back with the app** (moved away on purpose
  meanwhile) is let go of a second after the latest return (`FocusWithApp`): it left the
  avatar listening.
- **The thread left on screen** is kept only while the app is away: forgotten as it comes
  back or is quit, read once per run at launch (`LeftOnScreenNote`, `Fleet.leftAtLaunch`;
  `RootView` can make more than one fleet as the app starts, and the bench's relaunch
  check caught the first taking it for all).
- **The host is asked what it takes** (files) on each real connection
  (`ChatScreen.hostIsConnected`), not only when the shown connection changes.
- **An avatar drawn while paused** is drawn at the time it paused (`Pause.sampled`); the
  breathing logo pauses while no window is seen, as the avatars do.
- **The bench**: labels and folders that could reach out of the scratch folder (a label
  with `..`, a link) are refused; the relay's byte log is made anew, never through a link;
  a return counts only when the probe saw the app come back (the probe writes which way a
  window's occlusion went), movement is measured from where a view was before the return,
  and what became current is counted only up to the next leaving.

Rerun during the review (iPhone 18 Pro Max simulator at af4fd3c, no link delay; the Mac at
22a10b7): nothing changed while away, 0 of 2 returns moved (background, approval card); the app
ended in the background reopened the thread left on screen; the iPad simulator, one
return, nothing moved. Mac, the composer focused with a draft: Finder in front and back,
hidden, covered, the chat scrolled up (each), an approval card: nothing moved; a turn in
the open thread at its end, the new turn below (98 pt); a turn in another thread, two rows
trade places (34 pt).

## What is left

- **Not measured, only read**: the wash's and the avatars' resume (the probe sees where
  views are, not their pixels, and the recordings were not compared frame by frame), and
  the paste button (a picture cannot be put on the simulator's clipboard from the command
  line). The tests check the clocks (`PausingTests`; the wash's `WashClockTests`).
- **Not run**: an open sheet or panel (a subagent's detail, Select Text, the model picker,
  the look editor) as the app comes back: nothing on the way back touches them, and the
  banner that moved the chat under them is gone. The sidebar scrolled far down (the rows'
  frames are probed; the bench can scroll it with `RETURN_SCROLL_X=12`, but 60 threads
  folded under one agent did not fill it). The iPad beyond one return (nothing moved).

- **The chat "near the same place" after the system ended the app** (proposal, not
  built): it opens the thread left on screen, at its end, not where it was scrolled to.
  The chat would keep the id of the turn at the top of its window (`scrollPosition(id:)`
  with the lazy stack as its `scrollTargetLayout`, or the probe's turn frames) and how far
  into it, note them with the thread as the app goes to the background
  (`LeftOnScreen`), and open there instead of at the end when it was not at its end. About
  80 lines in `ChatScreen` and `Fleet`, with the hard part the lazy stack's estimated
  heights: a turn far from the end has to be laid out and kept in place while the turns
  around it are, the same problem the `open` track works on for the end. Worth doing
  after `open`'s change to how a thread opens has settled, in the same place.
- **A turn that ran while away appears with the chat gliding to its end** (`withAnimation(
  .smooth)` on a new message) when the chat was at its end; one could argue for no glide
  while catching up. Left as it is: it is the change itself, once, in one direction.
- **The iPhone keyboard**: the simulator ran with a hardware keyboard, so the software
  keyboard's coming back was not seen; the composer kept its draft and its focus.
- **A slower reconnect than the grace** (three seconds) shows Connecting… as before.
- **The Running group for a reply still streaming on return**: a real state, shown as soon
  as the host says so.
