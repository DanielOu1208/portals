import { machineWord } from "../platform.ts";

// What agents are told of the `portals` command (docs/fleet-plan.md): a few lines in
// their instructions, and the guide the command prints. Also the line on how the app
// shows math, which every agent is given, and the one on visuals with their guide.

/**
 * How the app shows math in a reply (MarkdownMath.swift). Without it agents write
 * exponents as plain text (n^1.5) or as superscript characters (n², which italics
 * crowd), and the app shows them as written. And that it shows an image a reply names
 * as a Markdown image of a file on this Mac (feature file_read, src/sessions/fileRead.ts).
 */
export const mathInstructions =
  "Your replies are shown in the Portals app, which typesets LaTeX math: inline between $...$, on a line of its own between $$...$$. Write formulas that way, exponents included ($n^{1.5}$, not n^1.5 or n²). Math in a code span or code block is shown as written. It also shows an image file from anywhere on this Mac, written on a line of its own as ![caption](/absolute/path.png) (a path with spaces between < and >).";

/**
 * How agents are told the app shows visuals (WidgetViews.swift): a line in their
 * instructions, and the rules the command prints (`portals guide visuals`) when they
 * make one, which keeps the rules out of every thread's prompt. `command` is the
 * command's full path. They were called widgets at first: the app still draws a
 * `portals-widget` block, and `portals guide widgets` still prints the guide.
 */
export function visualInstructions(command: string): string {
  return `The app can also show interactive visuals in a reply: a fenced code block whose language is \`portals-visual\` is drawn live, from HTML you write. Use one whenever seeing or trying something would help the user understand it better than words alone, especially when you explain or teach; you do not need to be asked. Draw diagrams (graphs, trees, flows) that way too, not as text art in a code block. The words come first: write what you have to say before the visual, so the user reads it while you make the visual; only then run \`"${command}" guide visuals\` for how to write one (before each visual), then write the visual and the rest of your reply.`;
}

/** What `portals guide visuals` prints: what the app's page for a visual allows (WidgetPage.swift). */
export const visualGuide = `portals guide visuals: how to show a visual in a reply.

The Portals app shows a fenced code block whose language is portals-visual as a live
visual in your reply, drawn from the HTML in it: a chart, a diagram, something to
play with. Other apps show it as code.

When
- Whenever seeing or trying something would help the user understand it better than
  words alone, especially when you explain or teach. You do not need to be asked. A
  reply that words already make clear does not need one.
- Diagrams (graphs of nodes and edges, trees, flows, layouts) are drawn as a visual,
  in SVG, not as text art in a code block.
- Say in words what it shows as well. The visual is not read back to you, and nothing
  the user does in it reaches you or the app: a slider, tab or toggle changes only the
  visual.

Making it quickly
- Words first: the user reads what you wrote before the visual while you make it. Put
  your explanation before the visual, and send it before you plan the visual: write it,
  then run this guide, then think out the visual and write it.
- Write it straight into your reply. Do not build test harnesses or preview it in a
  browser unless the user asks: the user is waiting for it. Plan it briefly.
- Keep it to one idea. Most fit in a couple of hundred lines; a simulation can take
  more.
- It is drawn while you write it: put <style> first, then the elements, and <script>
  last. Until a block's elements show something, and until its scripts have run when
  a script draws it, the app shows a small animation in its place.

Writing one
\`\`\`portals-visual title="Build time by target"
<style>
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .row b { width: 6em; font-weight: 500; color: var(--portals-text-2); }
  .row i { height: 10px; border-radius: 5px; background: var(--portals-series-1); }
</style>
<div id="rows"></div>
<script>
  const seconds = { app: 42, bridge: 12, tests: 30 };
  const most = Math.max(...Object.values(seconds));
  rows.innerHTML = Object.entries(seconds).map(([name, s]) =>
    \`<div class="row"><b>\${name}</b><i style="width: \${(s / most) * 70}%"></i>\${s} s</div>\`).join("");
</script>
\`\`\`
- The fence starts a line of its own, outside any list or quote. If the HTML holds
  three backticks itself, open and close the fence with four.
- title="…" names it in the line above it. height=N (points, 48 to 2000) gives it a fixed
  height; without one it is as tall as its content, so do not size the page with 100vh
  or height: 100%, and keep content in the flow (absolutely positioned content does
  not count).
- Write a fragment: <style>, elements and <script>, without <html>, <head> or <body>.
  Up to 200 KB. Scripts run in order, after the elements above them.
- It is about 300 to 850 pixels wide, from a phone to a Mac window: use a fluid layout
  and let charts resize with their container.
- Taller than about 560 points it scrolls inside itself (the user can expand it to
  see all of it): keep it shorter.
- It is used with touch and with a pointer: do not rely on hover alone, and do not
  capture vertical drags (they scroll the chat).

What it can load
- Scripts, style sheets and fonts from https://cdn.jsdelivr.net, https://unpkg.com and
  https://cdnjs.cloudflare.com only, with the version pinned: for example
  https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js, or
  import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm" in a module script.
- Nothing else. fetch, XMLHttpRequest, WebSocket and images from the network are
  blocked: put the data in the script, draw with SVG, canvas or CSS, and give images
  as data: URLs.
- No iframes, forms that submit, pop-ups, alert/confirm/prompt or navigation. A link
  the user taps opens in their browser.
- Nothing is stored: the app may keep a page as it was left while it is out of sight,
  or draw it again from the start; it is drawn again when the app switches between
  light and dark.

Looks
- It sits right in your reply, on the chat's background and in line with your text,
  under a small line with its title. Do not draw an outer card, border or background,
  or margins at the sides; group parts in tiles of --portals-surface if that helps.
- Use the app's colours and fonts, which follow light and dark mode:
  --portals-text, --portals-text-2 (secondary), --portals-surface (tiles, panels),
  --portals-line (borders, grid lines), --portals-accent, --portals-positive,
  --portals-negative, --portals-series-1 to --portals-series-6 (data series),
  --portals-font, --portals-mono, --portals-size (body text size), --portals-radius.
  Text already has the right colour, font and size. A colour of your own needs one
  for dark mode too (@media (prefers-color-scheme: dark)).
- A library that takes colours in JavaScript can read them:
  getComputedStyle(document.documentElement).getPropertyValue("--portals-series-1").`;

/** A few lines for an agent's instructions. `command` is the command's full path. */
export function agentInstructions(command: string): string {
  return [
    `You run inside Portals, which runs several coding agents on this ${machineWord()}, each in its own thread.`,
    `The command "${command}" (always by this full path) lists, reads, messages, starts and stops the other threads.`,
    "Use it only when the user asks you to work with, check on or hand work to another agent or thread; run its `guide` first.",
    'A message opening with "[Portals: from …]" is from another agent or a command line, not the user.',
  ].join(" ");
}

export const usage = `portals: see and drive the other agent threads that Portals runs on this Mac.

  portals threads [--state idle|working|blocked|error] [--agent NAME] [--limit N]
  portals agents
  portals folders [--machine NAME]
  portals read THREAD [--last N] [--full]
  portals send THREAD "text" [--wait] [--timeout MS]
  portals report "text"
  portals wait THREAD [--timeout MS]
  portals start --agent NAME [--machine NAME] [--folder PATH] [--title TITLE] ["text"] [--wait] [--timeout MS]
  portals answer THREAD REQUEST (--choice once|session|deny [--note TEXT] | --answers JSON)
  portals stop THREAD
  portals machines
  portals link [PAIRING-LINK] [--name NAME]
  portals unlink NAME
  portals guide [visuals]`;

/**
 * The net's commands, for the person at the Mac: printed with the usage, never in the
 * agents' guide. A join link lets whoever has it into the net.
 */
export const netUsage = `The net of your Macs and devices (for you, in a terminal):

  portals net                        the net's members
  portals net invite                 a join link for another device or Mac, ten minutes, one use
  portals net join [JOIN-LINK]       this Mac joins the net of a link (asks for it when not given)
  portals net remove MEMBER          takes a member out of the net, on every Mac
  portals net rename [MEMBER] NAME   renames this Mac, or another member of the net, on every Mac and device
  portals net leave                  this Mac leaves its net`;

export const guide = `${usage}

Every command prints JSON. An error is JSON on stderr with exit status 1; a command
line that cannot be read exits with 2.

Threads
- THREAD is the "id" from \`portals threads\`. Read ids from the output; do not guess them.
- "state" is idle (at rest), working (a turn is running), blocked (it asked the user
  for leave or for an answer; "kind" says which) or error (its last turn failed).
- \`threads\` gives the newest 50 unless --limit says; "more" counts the others.
- \`read\` gives the last turn, or the last N with --last: the thread, the questions it
  waits on ("open_requests") and the turn in progress first, then the messages, oldest
  first. Long tool output and arguments are cut short unless you pass --full.

Sending
- \`send\` puts your text into the thread as a message. The other agent sees a first
  line saying it came through Portals and from which thread, so it knows the message is
  not from the user.
- A message from another Mac's thread names it "(thread <that Mac's id>/<thread id>) on
  <Mac>": to write back, use the id \`portals threads\` gives that thread ("mini/<thread id>").
- "status" in the answer: streaming (a turn started for it), steered (it joined the
  running turn) or queued (it runs after the running turn).
- --wait answers once the thread is at rest or blocked, with "reply": the last thing
  it said. --timeout is in milliseconds, 60000 unless given. "timed_out": true means it
  is still working: run \`portals wait THREAD\` again; do not send again.

Starting
- \`start\` needs an agent from \`portals agents\`. It runs in the General folder unless
  --folder names one from \`portals folders\`, or a git worktree of one (its thread is
  listed under that folder, on the worktree's branch).
- Say in the first message everything the other agent needs. It knows nothing of your
  conversation.
- A thread you started tells you when it finishes a turn, fails or waits for an answer,
  when \`start\` answered "tells_starter": true: the bridge sends you a message from it,
  opening "Notice from the bridge". Then you need not wait for it or poll it; while you
  wait for it (--wait, \`wait\`) the wait tells you instead. Without "tells_starter": true
  (an older bridge on another Mac, or notices off), nothing comes by itself: check on it
  with \`wait\` or \`read\`. Answer a notice only when there is something to do.
- Started by another thread yourself? The bridge tells that thread when your turn ends,
  with your last reply. To ask it something or tell it how far you are while you work,
  \`send\` it a message: the bridge still tells it when you finish. To end your work with a
  report of your own instead, \`report\` it, as the last thing you do: the bridge then sends
  no notice of that turn. \`report\` finds the thread that started yours by itself.

Answering
- A thread you started that is blocked can be answered with \`answer\`: REQUEST is the
  "id" of one of its "open_requests" (from \`read\` or \`wait\`).
- An approval ("method": "approval") takes --choice: once, session (for the rest of
  its session) or deny, never always. --note, with deny only, says what to do instead.
- Allowing needs your own thread to run in full access; a plan ("plan": true) needs
  at least the mode its work starts in ("starts_in"). Otherwise deny, or leave it to
  the user.
- A question ("method": "clarify") takes --answers, JSON from each question's "qid" to
  one of its "choices" or your own words, null to skip one: '{"q0":"Swift"}'.
- Every device's card closes, and says you answered it.

Other Macs
- \`portals machines\` lists the Macs this one is linked to, and their agents. Their
  threads are in \`portals threads\` too, with "machine" set and ids like
  "mini/6d3c…": use such an id as any other.
- \`start --machine NAME\` starts the thread on that Mac, with one of its agents, in its
  General folder or one from \`portals folders --machine NAME\`.
- \`link\` and \`unlink\` add and remove a Mac. They are for the user, in a terminal:
  a pairing link holds that Mac's password. Do not ask for one or run them yourself.

Rules
- Use this only when the user asked you to work with, check on or hand work to another
  agent or thread.
- Answer a blocked thread you started only the way the user would. Leave to the user
  anything destructive, that cannot be undone, outside the task, or that you are not
  sure of: tell them which thread is blocked and on what ("open_requests"), and stop
  waiting on it. A thread you did not start you cannot answer.
- Do not stop a thread you did not start unless the user asked.
- A timeout or an error does not prove a message was not delivered. Read the thread
  before sending again.`;
