# Fleet plan: threads managed through the bridge, then Aeri

**Aeri taken out, 2026-10-21.** At the word ("for future builds we should remove and
defer aeri the meta orchestrator ... keep the code somewhere"), Aeri, the bridge's own
agent, is no longer in the bridge or the app. Its code is kept on the branch `aeri-kept`
and the tag `aeri-last` (main 0ab8fb5a, the last with it). The fleet (F1 to F3: the
`portals` command, the gateway's thread methods, linked Macs) stays. What follows is the
plan as it was written. How the fleet, the net and links work now, in detail, is in
`bridge/DEVELOPING.md`, "Agents working with each other" (from the README until 0.3.0);
the README keeps a short part for the person using it.

Decided on 2026-10-10. Aeri is to be the assistant that manages every agent in Portals,
so a person talks to Aeri and opens single threads only when they want to. Before Aeri
can exist, the bridge has to be able to manage threads as a whole: today every call
works on one thread that the calling connection follows, nothing lists all threads,
nothing waits for a turn to end, and an agent has no way in. That layer is called
fleet, and it is what this plan builds first.

Decisions behind it:

- **No agent-to-agent protocol.** An agent drives another agent through the bridge
  with the same operations a person has, as if a person were at the controls. This
  works across Macs too.
- **Fleet is a thread manager, not a terminal multiplexer.** tmux and herdr multiplex
  terminals: bytes on a screen. The bridge multiplexes sessions through each agent's
  headless interface, which is what gives the app transcripts, typed approvals, diffs
  and replies in notifications. That part exists; fleet adds the calls across threads.
- **Thread states use OSC 7501's words** (the Program Status Protocol): `idle`,
  `working`, `blocked` with `kind` `permission` or `question`, and `error`. The bridge
  does not read or send the escape sequence: its agents run without a terminal.
  `sessions.activity` keeps `running` and `waiting` for the app.
- **Agents use a command, `portals`,** from their own shell, modelled on herdr's
  `agent` commands. Underneath it speaks the gateway protocol the app speaks, so an
  agent is one more client of the bridge.
- **Aeri lives on a host device**, one Mac's bridge, and runs on pi-durable with its
  version locked.
- **The bridge stays TypeScript.** pi-durable, the Claude Agent SDK and Codex's types
  are all TypeScript, so a bridge in Rust would still need a Node process beside it.
  The new calls are a wire protocol, so a rewrite stays possible.
- **Kept simple.** The first pass has six operations, one command and links. What it
  leaves out is listed under Later, to be added when something needs it.

## What gets built

**Six operations in `bridge/src/fleet/`**, used by everything else:

| Operation | What it does |
|---|---|
| threads | Every thread the bridge knows, with agent, title, folder and state. Loads nothing |
| read | The last turns of a thread, the reply in progress and open questions, without following it |
| send | A message into a thread: starts a turn, steers or queues |
| wait | Resolves when the turn ends (with the reply) or the thread is blocked, or on timeout |
| start | A new thread for an agent in a listed folder, with an optional first message |
| stop | Interrupts the running turn |

**Gateway methods, feature `fleet`:** `threads.list`, `thread.read`, `thread.send`,
`thread.wait`, `thread.start`, `thread.stop`. None needs the connection to follow the
thread. Their shapes are in docs/gateway-protocol.md, section 11.

**The `portals` command**, for agents and for the person at the Mac. It reaches the
bridge over a Unix socket in the bridge's folder, owner only: no password reaches an
agent, and `tailscale serve` does not expose it. JSON output.

```
portals threads [--state idle|working|blocked|error] [--agent NAME]
portals read THREAD [--last N]
portals send THREAD "text" [--wait] [--timeout MS]
portals wait THREAD [--timeout MS]
portals start --agent NAME [--folder PATH] "text" [--wait]
portals answer THREAD REQUEST (--choice once|session|deny [--note TEXT] | --answers JSON)
portals stop THREAD
portals agents | folders | machines | guide
```

- A message sent this way opens with one fixed line saying it came through Portals
  and from which thread, when known, so neither the receiving agent nor a reader takes
  it for the user's. Claude's process is given `PORTALS_THREAD` in its environment;
  without it the line says the message came from the command line.
- Agents the bridge runs are told the command exists in a few lines of instructions,
  and to use it only when the user asks to work with another agent.
- No limit on how many messages a thread takes this way: a conversation that grows long
  is compacted, or carried on in a new thread at a natural place.

**Answers from the thread that started one** (feature `agent_threads`, added
2026-10-18 on request: a blocked thread an agent started waited for the user, which
was a big limitation). `thread.answer` and `portals answer` let the thread that started
another answer what it asks, as a device does, and nobody else: questions and plans,
and approvals once, for the session or no, never always. An allow needs the caller's own
thread to have the access it gives ("it depends on the approval mode from the main
agent too"): full access for a command, the mode a plan starts in for a plan, and a
thread whose mode is not known can only say no. Every device's card closes saying who
answered and how. On a linked Mac the thread keeps the caller's `origin`, so only that
thread answers it there. Shapes in docs/gateway-protocol.md, section 11.

**Links between Macs.** `portals link <pairing link>` on Mac A stores Mac B's
address and sign-in in A's bridge folder (owner only). A's bridge signs in to B as a
client, lists B's threads beside its own, and forwards calls for them. A thread on
another Mac is named `machine/thread`. A link gives reach one way; link both Macs for
both directions.

## Milestones

Each ends with the tests, the typecheck and the contract check passing, then a commit
and a push of the `fleet` branch.

| | What | Done when |
|---|---|---|
| F1 | **The six operations and their gateway methods** | With the fake agent: a thread never opened on a connection is listed, read, sent to, waited on (turn end and blocked) and stopped, while an app connection following it sees the turn as usual |
| F2 | **The socket and the `portals` command**, with the message line and the instructions | Tests drive a test bridge through the command. Live on a scratch bridge: a Claude Code thread, asked to, starts a Codex thread, waits and reads its reply |
| F3 | **Links** | Two scratch bridges on one Mac, linked: list, send, wait and read across; a stopped bridge gives a plain error. Then, with the OK, MBP16 and the mini |

## Later

In the order they are likely to be wanted. None is planned in detail yet.

**The app lists threads from the bridge.** The sidebar's threads come from
`threads.list`, so every device shows the same ones, and a thread an agent started is
visible and notifies. The message line shows as "from" another thread instead of the
user's words. `done` (finished and not yet seen) joins the states once the bridge
knows what was seen. This waits for the app's open branches to settle.

**Aeri.** Decided on 2026-10-10, after F3:

- Aeri is a new agent built into the bridge, separate from the user's Hermes agents
  (one of which is also called Aeri).
- One ongoing conversation, always: the same one on every device.
- It runs on the ChatGPT sign-in, through pi-ai, or whatever else pi signs in to.

The spike (2026-10-10, in a scratch folder) settled the parts it depends on:
`@earendil-works/pi-durable`, `pi-ai` and `chord` 1.1.0 (released together; pinned
exactly, since pi-durable asks for the others by range) on Node's own SQLite; pi's
`~/.pi/agent/auth.json` read and refreshed under the same lock pi takes
(`proper-lockfile`), so Aeri and pi share one sign-in; `gpt-6.1-sol` answers through
it; a tool call works; a process killed mid-answer finishes the answer when the store
is opened again (the cut-off part stays stored as an aborted message). The three
packages bring about 116 MB of other providers' SDKs with them.

| | What | Done when |
|---|---|---|
| A1 | **The Aeri agent** in `bridge/src/providers/aeri/`: one thread, `aeri`, that `session.create` always returns; its conversation in pi-durable (`state/aeri.sqlite`); the fleet operations as its tools; off unless `aeri.enabled` | Tests with pi-ai's scripted provider. Live on a scratch bridge: Aeri, asked in words, lists the threads, starts a Codex thread and reports its reply; a bridge restart mid-answer and the answer still ends |
| A2 | **Aeri hears what happens**: the stream of thread changes, written into its conversation without a model call; it speaks up when a thread it started ends or one is blocked | Planned in detail after A1 |
| A3 | **The host and the app**: Aeri on the host bridge, and as the app's home screen | Planned with the app's part |

**Left out of the first pass:**

- A stream of state changes for all threads. Aeri needs it: A2.
- Reports sent back to the caller when the other thread finishes. `--wait` and
  `portals wait` cover the first pass.
- Agents answering another thread's approvals or questions. A blocked thread is
  reported by `wait`, and the person answers in the app.
- Telling a Codex thread its own id, so its messages name the thread they came from.
  Codex runs one process for all its threads, so an environment variable cannot.
  (Done 2026-10-22, see below: Codex and Cursor tell each command they run its thread.)
- Agents that only run in a terminal. If a provider for them is ever added, the bridge
  should own that terminal, answer OSC 7501's probe and take its state from the
  reports.

## Who a relayed message is from: what a rework must keep (2026-10-22)

2026-10-22, on reworking this part: "consider a solution that doesnt lock us into
our current setup", the bridge being due for larger changes whose direction is not
settled. So who sent a message through the fleet, and who started a thread through it,
is a small set of facts with one maker and one reader (feature `senders`,
docs/gateway-protocol.md):

- **Keep: the facts.** `agent`, `agent_name`, `thread`, `title`, and for another Mac
  `machine` (its stable id, `state/machine.json`, the `gateway.ready` `machine.id` an
  app already knows each host by) and `machine_name` (its Computer Name, or
  `fleet.name`). Made in one place in the bridge (`bridge/src/fleet/line.ts`), read in
  one place in the app (`MessageSender`, AgentCore `Relayed.swift`). The app shows a
  Mac by its own name for the host with that id and falls back to the Mac's own name;
  it puts a thread started from another Mac's thread under that thread when it has
  both Macs as hosts (`StartedThreads.nested`, `machines`).
- **Keep: the line for the agent.** `[Portals: from …]` opens the message, since the
  agent must know it is not the user's; apps without the feature read it too. Its
  words are made from the facts and read back into them (`senderOf`), so the bridge
  stores nothing new: the facts of a stored message are read from its line when it
  goes out.
- **May be replaced: everything that carries them.** Links (`portals link`, a ticket
  and a WebSocket a call), the `sent_by` param between bridges (beside `sender`, the
  words older bridges take), `StartedBy.origin` (the host name and thread an older
  bridge answers by), the environment variables that name a command's thread
  (`PORTALS_THREAD`, `CODEX_THREAD_ID`, `CURSOR_CONVERSATION_ID`,
  `bridge/src/portals/access.ts`), and the line's exact wording, as long as a new
  bridge gives the same facts.

## A thread on another Mac keeping its starter working (2026-10-27)

2026-10-27, on a thread started from another Mac's thread: "i feel like we should
have parity here shouldnt bridge talk to each other to make cross device orchestration work
smoother?" On one Mac a thread is listed as running in `sessions.activity` while a thread
started from it is at work (`inherited`, n14/foot); a thread started on another Mac
(`portals start --machine`) kept nothing working on the Mac it came from.

**Who knows what.** The child's bridge (B) records who started it: `started_by.from` with
`machine`, the starter's Mac's stable id (`state/machine.json`, also its id in the net), and
`thread`, the starter's id there. The starter's bridge (A) records nothing of the child.
Each device asks each Mac it has for that Mac's own threads. So the answer must come from
A, which every device connected to A asks, whether or not it also has B; and only B knows
when the child works. B tells A.

**The link.** In a net every Mac reaches every other one both ways, with its own token
(`Links`, `netLinks`; one WebSocket for one call, as every link call). B finds A's link by
the machine id; A knows B by the id the token signs in as (`MemberSignIn`). No new transport
and no new pairing. Links made by hand (`links.json`) are one way and are left out: only
Macs of one net tell each other.

**What is said.** A new method on A, `threads.held` (feature `held_elsewhere`), only from a
Mac of the net: `{"threads":["<A's thread id>", …]}`, every thread of A's that threads on
the calling Mac keep at work now (at work or waiting, or kept at work by a thread they
started in turn), the whole set each time, which replaces what that Mac said before; an
empty set clears it. B says it when the set changes (its threads' activity moved) and again
every minute while it is not empty. A takes each Mac's word for three minutes: a Mac gone
from the net, asleep or unreachable stops renewing it, and its threads stop keeping A's
working three minutes later at most. A restarted forgets, and has it again within the
minute. A lists each such thread in `sessions.activity` as it lists one a thread of its own
keeps at work (`running`, `inherited`, `turn: false`), goes on up the threads that started
it, and tells its devices to poll (`poll_now`) when the set changes or a word runs out.

**Older bridges.** B asks only an A whose greeting lists `held_elsewhere` (the call's
fallback, `gateway.ping`, otherwise), and remembers an A from before for ten minutes. An A
from before is never told; a B from before never tells: both as today. Devices read nothing
new.

## Things to check early

- That Claude Code's shell sees `PORTALS_THREAD`, and what an appended system prompt
  does on a thread started earlier: the SDK keeps the first one until compaction.
- How Codex shows `developerInstructions` to the model. The bridge was tested on Codex
  0.160.1 and Claude Code 2.1.292; both are newer now.
- Until the app lists threads from the bridge, a thread an agent starts is in no
  device's list, so nobody is notified when it is blocked. The driving agent sees
  `blocked` from `wait` and has to say so in its own thread.
- Reading a Codex thread loads it in Codex for good, so
  `threads` never loads and `read` loads only the thread asked for.

## Testing rules

- Never an installed bridge. Live checks use this branch's bridge in the foreground
  with its own `PORTALS_BRIDGE_HOME` in a scratch folder, another port,
  `providers.hermes: false` and `codex.mode: "own"`, in scratch project folders.
- Nothing is published to npm, and nothing is installed on a real bridge, without
  the go-ahead.

## Progress

- **Review fixes:** (2026-10-11) A review by a Claude workflow and a Codex agent, against
  the user's intent: fleet is the interface for managing agents (and later terminals)
  across Macs, used by people, Aeri and agents alike. Fixed on this branch:
  - No message limit: long conversations are compacted instead.
  - Aeri: Stop reaches its waits; its turns end as stopped or failed when they were; it
    does not stop or wait on itself; its whole conversation survives compaction and a
    restart; a retried answer is the retry's alone; read_thread gives the reply and
    open questions first within pi-durable's 50 KB; its agent is `portals-aeri`, so a
    Hermes profile called aeri keeps its threads; its thread's model and level are
    used; one session when two devices open it at once; pi's sign-in file read and
    written under pi's lock; the bridge with Aeri on stops cleanly on SIGTERM (Aeri's
    proper-lockfile brings signal-exit, which ended the process mid-close).
  - Fleet: a fleet message opens its own turn in the app (`message.start` says so),
    takes none of the person's attached images, titles a Codex thread by what it says,
    and is waited for to its end when Codex turns a steer down; a wait that runs out
    gives the text so far.
  - Links: a refused sign-in is not retried for ten minutes (it locked out the phone),
    a sleeping Mac is left out of listings for 30 s, one time budget per call, plain
    sentences for a refused address or a stopped bridge, no other Mac under a taken name.
  - The command: messages may open with a dash, `read` puts what waits first and cuts
    long arguments, `threads` shows the newest 50, `link` reads the pairing link from
    its input and is for the person only; agents run it by its full path; Codex keeps
    the user's own developer instructions; the /tmp socket folder is the user's own.
  Checked live on a scratch bridge with Claude Code 2.1.296, Codex 0.162.1 and Aeri on
  gpt-6.1-sol: Aeri handed Codex a sum and reported it; Stop during Aeri's wait on a
  Claude Code thread answered in 15 ms; a SIGTERM stopped the bridge with exit 0.

- **F1:** done (2026-10-10). `bridge/src/fleet/fleet.ts` has the six operations, and
  the gateway serves them as feature `fleet`; `session.create` makes its thread through
  the same code as `thread.start`. The session manager tells more than one listener, so
  waits and notifications both hear of a turn's end. The app does not know the feature,
  so the bridge's contract test now lets the bridge offer more than the app uses.
- **F2:** done (2026-10-10). The bridge listens on `agent.sock` in its folder and writes
  the launcher `bin/portals` each time it starts; the command is `bridge/src/portals.ts`.
  Checked live on a scratch bridge with Claude Code 2.1.296 and Codex 0.162.1: a Claude
  Code thread, asked to hand a job to another agent, ran `portals guide`, started a
  Codex thread and reported its reply; a Codex thread, asked to check on the Claude
  thread, sent it a question and reported the answer. What that settled:
  - Claude Code's shell sees `PORTALS_THREAD`: the Codex thread's first message named
    the Claude thread it came from.
  - Both agents read their few lines and ran `portals guide` first (Claude from the
    appended system prompt, Codex from `developerInstructions` on `thread/start`).
  - Not settled: a Claude thread started before this learns of the command only after
    compaction, by the SDK's notes; and Codex threads are told only when started, not
    when resumed.
  - Simpler than planned: the command has a client of its own for one call; the Hermes
    client moves to a shared place with F3, which needs a connection that stays up.
    `fleet.tellAgents` in config.json turns the instructions off.
- **F3:** done (2026-10-10). `bridge/src/fleet/links.ts` keeps the links in
  `links.json` and calls the other bridge as the app would: it signs in (keeping the
  session), takes a ticket, asks once and hangs up. No standing connection was needed,
  so the Hermes client stays where it is; the one-call client the command and links
  share is `bridge/src/gateway/call.ts`. A thread on another Mac is `machine/thread`
  everywhere a thread is named; `threads.list` asks each linked Mac for its own threads
  only, so two Macs linked to each other do not ask each other for ever. `portals link`,
  `unlink` and `machines`, and `--machine` on `start` and `folders`. Checked live with
  two scratch bridges on MBP16: a Claude Code thread on one started a Codex thread on
  the other through the link and reported its reply; the Codex thread's message named
  the Claude thread and the Mac; with the second bridge stopped, the first said it could
  not reach it. Not checked yet: a link over `tailscale serve` to another Mac (the mini
  waits for the OK), and a linked bridge that restarts, whose session the link
  then signs in for again.
- **Aeri spike:** done (2026-10-10), as above.
- **A1:** done (2026-10-10). `bridge/src/providers/aeri/`: the provider (thread `aeri`,
  which `session.create` always returns), its conversation in pi-durable, pi's sign-in
  file shared under pi's lock, and seven tools over the fleet (list_threads,
  list_agents, read_thread, send_to_thread, wait_for_thread, start_thread,
  stop_thread). Checked live on a scratch bridge, through the app's own client, on the
  ChatGPT sign-in with gpt-6.1-sol: asked what was going on, Aeri listed agents and
  threads; asked to get Codex to work out 17 times 23, it started a Codex thread,
  waited and reported 391, and the Codex thread's message said it was from Aeri; with
  the bridge killed mid-answer and started again, the answer ended whole. Found on the
  way: pi-durable hands on an answer a commit at a time, so its first words come with
  the answer's start, and a fast answer comes in one piece.
