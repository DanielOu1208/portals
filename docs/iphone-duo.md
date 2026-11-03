# iPhone Duo

Building with the iOS 27.1 SDK makes an app edge to edge on both of iPhone Duo's displays.
Portals draws its own header, tabs and composer, so the system's bars and containers do not
adapt them for it.

## What the device reports

Measured on the simulator, in points, for the space inside the safe area:

| Pose | Size | Safe area | Fold |
| --- | --- | --- | --- |
| Closed | 382 × 644 | right 84, bottom 34 | none |
| Open, wide | 867 × 635 | right 84, bottom 34 | down the window, x 455.5 to 495.5 |
| Open, tall | 669 × 835 | top 82, bottom 34 | across the window, y 373.5 to 413.5 |

The status bar and camera take the column on the right in the closed and wide poses. The
fold's region exists in every open pose and is active only when the device is part open.
On the inner display the app rotates whatever its supported orientations say; on the outer
it stays portrait, as on any iPhone.

## What the app does

- **One chat through every pose.** `MainScreen` and `ChatDeck` keep the chat the same view
  with the tabs or without them. Crossing `WindowLayout.wideWidth` by opening or closing the
  device used to build the chat again, which sent a scrolled-up chat to its end and closed
  what was open over it. Each layout keeps its own panel state, so a panel opened on the
  closed phone is back when the phone closes again, and not shown while it is open.
- **Room above everything.** With the status bar at the side there is no top safe area, and
  the tabs, the sidebar's search and the header would touch the screen's edge.
  `WindowLayout.leastTopRoom` keeps 8 points there.
- **Tabs down the side.** Open in the wide pose the status bar leaves a column at the side,
  84 points wide, its top 124 taken. `TabRail` has the tabs there, over +, each with no title,
  where the bar would be over the chat. The chat names itself over its top on one line
  (`ChatTitleRow`): the small avatar beside the name and the thread's title, between the
  sidebar's button, on the sidebar's side of the screen, and the panel's, in one row. The bar's foot
  is 12 points above the pill's, for the soft edge under it to end higher.
- **The header up in the band.** Open and upright the status bar has only the end of the 82
  points over the chat, and a stacked header under them took the chat's first 190. There the
  chat's name goes up into the band on one line, in the middle of the screen and level with the
  clock, with the sidebar's button at the leading edge and the panel's at the trailing edge,
  just under the status bar (`ChatBandHeader`, `WindowLayout.headerBand`). They are in an
  overlay: out of a bar's bounds a touch does not reach what is there, which a real tap on the
  panel's button's foot showed. The chat starts under the band. Closed, and on any other
  device, the stacked header stays as it is.
- **Less under everything.** Both displays have a phone's 34 points at the bottom for the home
  indicator, which left the composer 42 above the screen's edge, a lot on screens this short.
  `WindowLayout.bottomTrim` brings the composer, the sidebar's footer and the rail down to an
  iPad's 28, clear of the indicator, which reaches 13 points up. Not by the safe
  area: a negative `safeAreaPadding` does nothing. A dark line along the bottom of the screen
  on the simulator comes with the composer focused and a hardware keyboard, and is not this.
- **The same layout part open.** The sidebar keeps its width in every pose, so part open in
  the wide pose the chat lies across the fold, its text and composer included. A sidebar
  reaching to the fold, with the chat on the other side, was tried and took half the screen:
  far too big (2026-11-03). Part open in the tall pose the fold crosses the transcript, which
  scrolls, with the header and composer clear of it.
- **Regular is not an iPad.** The inner display is regular in both directions in any pose, so
  what depends on the sidebar being beside the chat asks that, not the size class. The tall
  pose stays narrow: it is 17 points short of `wideWidth`, with the sidebar behind the chat.

## Checked on the simulator

Against the scripted agent, with the Duo simulator's controls in Device Hub:

- Every pose above, part open in both directions, and closed with the device turned sideways.
- Across open and close: an unsent draft, the keyboard and its focus, a scrolled-up position
  after a real swipe, the model picker, a pending approval, an expanded visual. A reply kept
  streaming through several folds and rotations and ended normally.
- The sidebar over the chat on the closed display, and back from it.
- Settings and the welcome screen on both displays.
- iPhone and iPad screenshots before and after these changes: no difference in layout.

There is no supported way to fold the simulator from `simctl` or XCTest. Device Hub's
controls can be pressed through its accessibility tree. An accessibility scroll does not count
as scrolling by hand (`followsEnd` stays true), so testing the scroll position needs a real
swipe, from a UI test.

## Not checked

- The tab rail with the software keyboard up. The simulator had a hardware keyboard by then.
- A real device. The fold's feel, the crease and the cameras can't be judged on a simulator.
- Split View, resizing either half.
- The image viewer across a fold. It sizes itself from its bounds.
- A live host and agent. The scripted agent stands in for both.
- Scanning a pairing code. It is VisionKit's scanner, and the simulator has no camera.

## Left for later

- Dragging tabs to reorder them in the rail, and a close button on them: for now they close
  from their menu, as a tab with no title does. Only the thread on screen is named.
- A faint line at the top of the screen where the chat meets the sidebar. It is the system's
  soft edge under the bar, which begins at once at the chat's edge. An iPad has it too, fainter.
  Hiding it with nothing in its place leaves the chat sharp and legible under the bar, and a
  blur of the app's in its place, tried with the tabs down the side, ended too suddenly.
- Keeping the chat's controls off the fold part open in the wide pose. The end of the model
  chip is on it.
- Landscape on the outer display, for standing the phone like a tent. The app's orientation
  setting is shared with every iPhone, and those layouts have not had a pass.
- The inner camera's region. It is inactive unless a camera is in use, and Portals only uses
  the rear one, so nothing avoids it.
