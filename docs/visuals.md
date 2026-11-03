# Visuals in replies

A ```` ```portals-visual ```` block in a reply (```` ```portals-widget ```` as it was first
called) is HTML the app draws live in the reply, in a locked-down web view. Agents are told
about it in one line of their instructions and read the rules with `portals guide visuals`
(bridge/src/portals/guide.ts). Other apps show the block as code. Code names still say
"widget": `MarkdownWidget`, `WidgetPage`, `WidgetPool`, `WidgetSession`, `WidgetViews`.

This page says how it works, what was measured on the night of 2026-10-19, and what is left.

## How it works

- **Parsing.** `Markdown` and `MarkdownStream` give a top-level fence whose info string starts
  with `portals-visual` as a `.widget` block (`MarkdownWidget`: its title, an optional fixed
  height, its HTML, whether it is finished). A fence in a list or a quote is code.
- **The page.** `WidgetPage` makes the page: the app's head (a content security policy, the
  app's colours and type as CSS variables) and the visual's HTML as its body. Scripts, style
  sheets and fonts may come only from jsDelivr, unpkg and cdnjs; nothing else reaches the
  network (`WidgetPage.contentRules` says it again to WebKit's loader; `WidgetPage.sealing`
  takes WebRTC away). `WidgetSandbox` sets the web view up (storage in memory only, no
  pop-ups, no text selection, no link previews).
- **Measuring.** A script in the app's own content world (`WidgetPage.measuring`) posts the
  page's height and whether it shows anything yet. The page's own scripts cannot post to the
  app. Heights are remembered by the visual's HTML and width (`WidgetHeights`, in the app's
  caches), so a visual drawn again takes its place at once.
- **Drawn while written.** A visual still being written has a draft session: an empty page
  under `script-src 'none'`, into which the HTML written so far, without its scripts, is put
  at most every 150 ms (`WidgetPage.draft`; a `<` or `</` at its very end, which the page
  would show as text, is left out). Once the fence closes, the same web view loads the
  whole page with its scripts, so the drawing stays where it is.
- **The pool.** `WidgetPool` keeps the sessions outside the transcript: when the chat lets go
  of a row far from the screen and makes it again, the page moves into the new row as it was.
- **Expand** moves the same live page into a sheet (a panel on the Mac) and back. It goes
  back to its row as soon as the sheet or panel is closed, which keeps a still picture of
  it while it slides or fades away; the row keeps one while the page is expanded
  (`WidgetSession.closeExpanded`, `WidgetHostView.keepPicture`). Before 2026-10-20 it went
  back only once SwiftUI let go of the sheet's view, and the row stayed blank meanwhile.
  Closed, the chat is where it was, the visual where you left it, however far from the
  end. On a Mac the panel disables the chat under it, which takes the composer's focus,
  and on an iPhone or iPad a touch on the page in the sheet takes it with the keyboard up;
  either gives the focus back as it closes, and until 2026-10-20 the chat took that for
  you starting to type and glided to its end. A sheet or panel open over the chat says so
  (`PanelOpenKey`), and focus given back as it closes is not typing (`FocusWithApp`).
  Expanded wider than its row (a Mac's panel), a page its own script draws (a chart) is
  scaled up to fill it rather than drawn again, which would lose what was done on it: a
  WebKit page zoom keeps it laying itself out as wide as its row (`WidgetHostView.scalesFrom`,
  2026-10-22). A page of elements alone reflows to the panel's width by itself; a narrower
  sheet shows the page at its own size.

## Feeling fast (2026-10-19)

### Words first

"if there's text before the diagram don't hold it until the diagram is ready, just
stream the text before the diagram first".

Nothing in the app or the bridge held the words: the bridge streams Claude's partial
messages and Codex's deltas as they come, and the app's reveal shows text in order. The agent
did. Timed on a scratch bridge (bench/visuals/live-*.json under /private/tmp/portals-n5,
same prompt, "Explain how Dijkstra's algorithm finds the shortest paths from one node, using
a small example graph."):

| Run | Guide read | First word | Visual begun | Turn ended |
|---|---|---|---|---|
| Claude Code (default model), old line: "Before your first one in a thread, run guide" | 3.3 s | 194.4 s (with the visual) | 194.4 s | 230.4 s |
| Claude Code, new line: words first | 15.1 s (after the words) | 9.4 s | 169.4 s | 201.6 s |
| Codex (default model), new line | 4.7 s (after a first sentence) | 2.9 s | 40.7 s | 66.9 s |

Told to read the guide first, Claude read it at once and then thought for 187 s, planning the
answer and the visual together, before writing anything; its first words came with the
visual. Thinking only happens at the start of a turn and after a tool call, so the new line
puts the words before the call: write what comes before the visual, then run
`portals guide visuals` (before each visual), then write the visual. The words now come
185 s earlier; Claude still plans the visual for minutes (145 s here), but the reader has
the explanation meanwhile. The guide says the same ("Words first", and "Plan it briefly").

### The orb

A visual being planned or drawn shows the thinking orb instead of an empty box: a native
port of Thinking Orbs by Jakub Antalík (MIT; `ThinkingOrb.swift` in AgentCore, drawn by
`ThinkingOrbView.swift` with a SwiftUI Canvas at 30 frames a second on one clock for all
orbs, paused in the background, while no window can be seen, out of the chat's view and
with Reduce Motion). Nine states; the app uses **composing** (an undulating sash).
`PORTALS_DEBUG_ORB=<state>` tries another (working, searching, solving, listening,
connecting, weaving, composing, breathing, shaping); shots/visuals/orb-*.png show each.

- **Planning.** From the moment the agent reads the guide in a turn until its reply lays the
  visual out, the turn holds the visual's place below the words (`VisualPlanningView`: the
  title line and the 120-point room a draft starts with, the orb in it). It goes at once
  when the visual takes its place, whose orb runs on the same clock, so the swap does not
  show (`Turn.awaitsWidget(shown:)`: the reply reports how many visuals it lays out, as it
  eases its text in a moment behind the stream). A page is made ready meanwhile.
- **Drawing.** Until the page is worth looking at (`WidgetSession.isPresentable`), the orb
  stands over it and the page shows faded under the orb, at 40% (35% in dark mode, where
  light text stands out more), so that the visual can be watched taking shape as it is
  written; a page that shows nothing yet (a canvas before its script, a page still loading
  its library) shows nothing. The orb stands on a soft clearing of the chat's background
  (`DraftClearing`: a still radial gradient, no blur), so that it reads clearly over the
  lines and controls drawn under it. Faded, the page takes no touch and VoiceOver passes
  over it (`WidgetHostView.takesTouches`, as well as `allowsHitTesting`): nothing in it can
  be tapped or scrolled, and a drag on it scrolls the chat. A draft is worth looking at once
  it shows text or shapes, at least 48 points of them, and no control or canvas; a finished
  page once it has loaded, after its scripts ran. SVG and CSS diagrams therefore come up to
  full as they are written; anything with a control or a canvas (what a script draws) stays
  faded under the orb until the block is finished and its scripts have run, because
  mid-stream such drafts are half drawn and unstyled
  (shots/visuals/s2-savings-dark-*-before-half-drawn.png). Then the page comes up to full
  and the orb fades out, in one 0.3 s move. Once presentable it stays so, through the
  reload when the visual finishes and in the other look. The orb sits in the top 120 points
  of the frame, so it does not move as the page grows under it. The page was drawn while
  hidden as well: showing it faded adds no work in the page or the app, only its
  compositing while it is written.
- **Faded, not hidden (2026-10-20).** "i think we do not remove the thinking orb
  until the whole visual is finished generating; we can instead show the visual generation
  streaming underneath with some opacity". Until then the page under the orb was kept
  invisible (opacity 0) and the orb stood over an empty box until the visual was finished.
  Recorded on an iPhone 18 Pro simulator with the fake `widgets` script, before and after,
  light and dark (frames under /private/tmp/portals-answers/visual-draft/frames, side by
  side in picked/compare-*.png): the savings calculator now shows its labels and sliders
  faded as they are written, then its bars and total come up with the orb fading out; the
  Chart.js chart shows nothing faded (an empty canvas) until its script has drawn it; the
  SVG diagram draws live as before. No flash to blank between the draft and the finished
  page: the finished page is drawn faded, then comes up.
- The reply is laid out in runs (text, visual, text) from its first word, so the first visual
  to arrive no longer makes the text above it anew.

### A page made ready

`WidgetPool.warm()` makes a web view and loads an empty page into it, which starts its
WebContent process, when the agent starts planning a visual and when a visual whose page
was let go of comes within twice the prefetch distance of the view (`WidgetSight.approaching`).
The next page made takes it (`takeSpare`); unused, it goes after a minute or at a memory
warning. Measured on the iPhone simulator (log lines under DEBUG, bench/visuals/log-paused2.txt):
a visual drawn again in a page made ready was presentable **10 to 21 ms** after it was asked
for (median 13 ms, 12 returns in two runs); in a new web view, **543 to 701 ms**.

### Out of view, out of the window

Measured first with ten visuals that count their frames and timers and spin a box with CSS
(the in-app fake `widgets` with "gallery"), on the iPhone 18 Pro Max simulator, CPU from
`ps` every 2 s, memory from `footprint` (bench/visuals/sample-*.txt):

- A page in the window keeps running when it is scrolled out of view: WebKit only stops a
  page whose web view is out of the window. With all ten kept in the window (as before;
  `PORTALS_DEBUG_VISUALS=drawn`), at rest at the end of the reply the ten WebContent
  processes used **42%** of a core, the GPU process **11%**, the app 15%.
- A page out of the window used **0.1 to 0.4%** (its frames, timers and animations stand
  still; the counters show it when it comes back), against 5.4% in view.

So each visual's frame now says how near the chat's view it is (`WidgetSight`, from its
geometry in the scroll view): seen, near (within 600 points: its page made and in the window,
drawn ready), approaching (within 1,200: out of the window, a page made ready if it has none)
or away (out of the window). Nothing reaches the page itself; out of the window it is kept
exactly as it was left. With that, at rest at the end of the same reply: WebContent **10.8%**
(the two in view), GPU **3.1%**, the app 7.1%.

### How many pages are kept

Footprints on the iPhone simulator: a page **24 to 42 MB** (the counting page; it grows a
little as it runs), the GPU process **12 to 19 MB**, the networking process **7.5 to 8.5 MB**,
all pages sharing the last two. To keep visuals near **100 MB** on the phone, it now keeps
**three** pages (in view and out of it; it was four): measured 99.5 to 99.6 MB at the end
of the reply and 112 to 128 MB at its top in two runs (the counting pages grow as they run). An iPad keeps four and a Mac eight, as before. Older pages are
let go of (least recently seen first) and drawn again from the reply's text as they come
near, in a page made ready: in the run with three kept, **0 of 44** visuals reached the
screen without their page drawn (`seen, presentable: false` never logged), scrolling by half
a screen every 2.6 s, and 0 of 44 again in a second run. Without the approaching band (pages made only within 600 points), 1 of
9 came in behind the orb.

## When a page misbehaves (2026-10-22, night n7)

- **Its process ends** (a crash, or the system ending it for memory, tried by killing the
  WebContent process in the simulator): the orb stands in for the page and it is drawn
  again, at once if it is shown, else when it is next. One whose process ends three times
  within two minutes while shown is given up on (`WidgetEndings`): its source is shown
  under "Visual could not be drawn", rather than a process started and ended for ever.
  Endings while out of the window are not counted (the system ends those first).
- **A script that never ends.** A finished page not loaded ten seconds after it began is
  asked to answer a script of the app's (three seconds): if it does, it is waiting on the
  network and is shown as far as it got; if not, it is given up on ("Visual stopped
  responding", its source shown, its page let go of). A loaded page that stops answering
  later (a script that loops after it drew) is asked as it leaves the window (five
  seconds). Given up on is remembered by the visual's HTML for as long as the app runs, so
  a reply drawn again does not try it again. WebKit keeps such a page's process busy
  whatever the app does (there is no public way to end it); the app no longer draws it
  again in a new one each time it comes back. The page is asked before it is taken out of
  the window, not after; a page that did not answer while the app went into the
  background (WebKit suspends it with the app) is not given up on, and a look that fell
  due while the app was away is taken when it is back. A page that answered while still
  loading is looked at again, and asked as it leaves, like a loaded one (review, n7).
- **A script that throws** draws what came before the error, as a browser does; a page of
  five thousand rows scrolls inside its card at the cap. The fake agent has a page for
  each: `stuck`, `freeze`, `throws` and `huge` in a widgets prompt.
- **Widened again.** A finished page drawn by a script of its own is drawn again, half a
  second after its row stops changing width, when it is shown `WidgetHeights.widthStep`
  or more wider than the narrowest it measured itself at since it loaded
  (`WidgetWidening`): Chart.js never grows a chart past the size it first drew, so a chart
  in a Mac window narrowed and widened again kept its narrow size. Narrower, it reflows by
  itself; in the expanded view it is never drawn again. Nor is a page the user has done
  something on since it loaded (a tap, a key, a slider moved: the measuring script tells
  the first at once, `used`; only the user's own, `isTrusted`, not a page's script
  clicking a tab as it draws), which would lose that. A redraw due is dropped when the
  width goes back, and done when the page is back in its row should it have moved into
  the expanded view or out of the window meanwhile (review, n7).
- **Moved between widths** (into the expanded view and back), the page is covered by the
  row's picture of it, else the page's background, until it has laid itself out at the
  new width (half a second at most), not shown cut at its old width. The page is hidden
  while it is covered: drawn on nothing, it showed through the picture, which is drawn on
  nothing too (n8). Back in its row from a narrower view (an iPad's sheet), a page drawn by
  a script of its own and not used is drawn again at once (Chart.js keeps a chart at the
  sheet's narrower width), under the row's picture of it, held until it has loaded and
  0.7 s more for a chart's first drawing (2.5 s at most). Recorded at the simulators' full
  frame rate on 2026-10-22: no cut or doubled frame either way, on an iPhone or an iPad.
- **Given up on**, a visual shows a small card in its place with what happened and Try
  again (n8, "the button shouldnt reprompt the prompt that started the thread
  should just prompt to retry visual"): it is drawn again from the reply's own source, as
  if it had never been tried (its endings counted afresh, forgotten as given up on),
  sending nothing to the agent or the bridge; the orb stands in the room a visual being
  drawn has until it is. Given up on again, the card comes back. Its source is in the
  title line's menu: Copy Source, Show Source.

## Kept after leaving a chat (2026-10-22, day run n8)

"leave it for a specific time maybe and then free?". A chat that leaves the screen
(another thread opened) tells the pool (`WidgetPool.chatLeft`), which keeps its pages,
among the few most recently seen it keeps anyway (3 on an iPhone, 4 on an iPad, 8 on a
Mac), for **two minutes** (`WidgetsLeft.life`) and then lets them go; a chat shown again
meanwhile keeps them (`chatShown`); nothing is let go of while any screen shows the
chat (each screen says which chat it shows, so a screen of the same chat made again, say
by a layout change, keeps them whichever SwiftUI tells first, and a turn that came
meanwhile too: review, n8). One timer for all the
left chats, sleeping until the next are due; nothing else runs while they wait. A memory
warning lets them go at once, as before. `PORTALS_DEBUG_VISUALS_KEPT=<seconds>` shortens
the two minutes to watch it: on a scratch bridge with Visuals 45 and Long 45 opened in
turn, the pages went 15 s after the last leave and not while the chat was back within the
time (night run's live/visuals/log-kept-*.txt). An iPhone keeps 3 pages: a thread with
more visuals than that near its end (Visuals 45) draws some again when it is opened again,
as before; one with three or fewer finds them as they were.

## Checks

- Swift package: 616 + 359 + 19 + 18 tests (ThinkingOrbTests, WidgetTests,
  WidgetSandboxTests, which loads drafts in a real web view and reads what the measuring
  script posts). Bridge: 1343, typecheck.
- iPhone simulator (Release with DEBUG): words, planning orb, drawing orb, SVG drawing live,
  script visuals behind the orb until finished, light and dark; the gallery run up and down.
- Mac Catalyst: a scratch copy drew the diagram live (shots/visuals/s2-mac-diagram-dark-*.png).
- Faded drafts (2026-10-20): the Swift package's tests (732 + 392 + 24 + 21 + 19, with a
  test for the draft's dangling `<`), an iPhone simulator build recorded before and after
  in light and dark (above), and a Mac Catalyst build (not run).

## What is left

- Claude still thinks for minutes about a visual before writing it (145 s of 201 s); the
  words come first now, but the visual itself is no faster. A shorter guide or a smaller
  model for the visual would be the next thing to try.
- A visual whose controls come after a drawing (an SVG, then its buttons) shows the drawing
  live and then its controls, unstyled until its scripts run if its styles come late.
- Half-drawn drafts now show, faded: one whose styles come after its elements (the fake
  savings calculator) shows plain labels and sliders in a row for its first moment, and
  its controls cannot be used until its scripts run. Whether that reads as the visual
  being built or as something broken is for the user to say on a phone; a lower opacity,
  or holding a draft back until its first style sheet, would be the next things to try.
- The clearing behind the orb is drawn over a blank page too, where it shows only over the
  wash (a visual near the top of the screen), as a faint patch; the planning orb has none.
- An app too busy for a moment as a visual becomes presentable lets the 0.3 s fade pass
  unseen, and the visual comes up at once, as it did before (seen once on the simulator
  while the Mac was loaded with other builds; the same run again faded as it should).
- The iPad was not run tonight (its simulator is shared); it keeps four pages. Nor the
  faded drafts on an iPad, a Mac (built, not run) or a phone.
- The frame of a visual behind the orb grows with its faded page, so the reply below it can
  move while the orb shows; the finished visual then keeps that height.
- Memory per page was measured with a small page; a page with a large library (Chart.js,
  D3) takes more, and the limit of three is by count, not by bytes.
