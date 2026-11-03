# Sync plan: every device shows the same threads

Decided on 2026-10-11. Today each device keeps its own list of threads (`threads.json` in
the app's store), with pins, archive and unseen marks only that device knows, and it
lists only the threads it started. A thread Aeri or an agent starts through the fleet
(`thread.start`, the `portals` command) shows on no device. The user's goal is "threads
synced between all their devices, with several hosts": for every host that is a bridge
offering the new feature, the phone, the iPad and the Mac show the same threads for that
Mac, with the same titles, pins, archive and unseen marks, and a change made on one
device shows on the others within a few seconds while the app is open.

This is the fleet plan's first Later item ("The app lists threads from the bridge"),
planned in detail.

Decisions behind it (settled; not to be reopened):

- **Each Mac's bridge is the source of truth for its own threads**: which exist, their
  titles, pinned, archived, unseen. A device's `threads.json` becomes a cache for such a
  host: it still opens a thread at once and reads without a connection.
- **A host lists only its own threads.** A bridge linked to other Macs gives a device
  only its local threads: a linked Mac's threads show through the device's own pairing
  with that Mac, so nothing shows twice.
- **Every thread on the bridge shows on every device**: started from any device, taken
  up from the desk (`session.adopt`), or started by Aeri or an agent through the fleet.
- **Threads started by Aeri or an agent carry a small mark** saying who started them
  ("Started by Aeri"), and are in Needs you and Running like any other. A thread a
  person started from a device has no mark.
- **Pins and archive sync.** Archiving still unpins, and something new in an archived
  thread still brings it back by itself, by the same rule on every device.
- **Unseen syncs.** A turn that ends while nobody is looking marks the thread unseen
  (under Finished) on every device; opening it on any device clears it everywhere. A
  thread on screen somewhere when its turn ends does not stay unseen (a brief flash
  elsewhere is acceptable).
- **Delete removes the thread from the Mac's list, so it leaves every device.** The
  agent's own session stays on the Mac and can be taken up again from desk sessions. A
  running thread is never left running with no list entry. Aeri's one thread cannot be
  deleted.
- **One-time carry-over.** The pins, archive and unseen marks a device holds for a
  host's threads are sent up when it first syncs with that host. Nothing a device holds
  is silently dropped.
- **Compatibility.** Everything new is a bridge feature, opt-in both ways (section 11 of
  docs/gateway-protocol.md, `scripts/check-contract.sh`). An app with a bridge without
  the feature (npm 0.1.0) or with plain Hermes behaves exactly as today. An older app
  with the new bridge keeps working.
- **Simple over clever.** No CRDTs, no iCloud, no new storage: JSON files in the bridge's
  `state/`. Last write wins for pins, archive and titles. The phone may be on cellular,
  so the list is never re-sent whole every few seconds.
- **Transcripts are not copied between devices.** A device opening a thread it never had
  loads it from the bridge (`session.resume` finds any thread in the registry). A thread
  from another device still shows a sensible preview line and time in the list.

## What gets built

### What the bridge keeps

The registry (`bridge/src/sessions/registry.ts`, `state/threads.json`) becomes the list
every device shows. Each record gains:

| Key | Meaning |
|---|---|
| `pinned`, `archived`, `unseen` | `true` when set; absent is false |
| `preview` | The first line of the last message sent into the thread (one that opened a turn, or was handed to the running one), without a `[Portals: from …]` line, at most 140 characters, worded as the app words its own (`ThreadController.preview`) |
| `startedBy` | `{name, thread?}` for a thread started through the fleet: who started it, in a few words, and that thread's id when it is one of this bridge's |
| `revision` | The list's revision when the record last changed |
| `turnRevision` | The list's revision when a turn last started or ended in the thread: the seen guard (`thread.mark`). Not listed |
| `turnStarted` | The list's revision when the thread's latest turn began (or ended, for an end with no start recorded): which turn that is, listed as `turn`. A seen that names a `turn` is ignored when it is another (net-20, 2026-10-26) |
| `inTurn` | A turn's start was recorded and its end not yet: a turn found running when the thread is loaded again (after a restart) is that one. Not listed |

The file itself gains `list` (a random id made when the file has none, saved at once)
and `revision` (a whole number that goes up by one with every change to the list). A
bridge from before this reads `threads` as it always has and keeps the records' new
keys, but drops `list` and `revision` when it saves. This bridge then makes a new list
when it next starts, with its revision starting above every stamp in the files, so a
record stamped under the old list never counts as changed in the new one; the devices
carry over (below).

A record taken off the list goes to `state/removed.json`, with the revision of its
removal, and stays there until the same session is taken up again. It tells a device
which threads to forget, and lets `desk.list` offer the agent's removed threads again.
It is a file of its own, written only by a delete or a taking up, so an older bridge
never rewrites it and the registry's frequent saves do not carry it. It is written
before `threads.json`; an id found in both when loading is still on the list (the delete
did not finish) and leaves `removed.json`.

There are two kinds of write to a record. `update`, as today, also moves `updatedAt`
(the thread's time in every list), and is used only when a turn starts or ends. `set`
changes only what it is given, and is used for everything else: marks, a preview found
on loading, a title, the model, level and mode, read-only cleared, and the manager's fix
of an ongoing thread's agent name at startup. So pinning, renaming or changing the model
of a thread does not move it up anyone's list, as today. A write that changes a key the
listing carries moves the list's revision and stamps the record; one that changes none
(the model, level or mode) does not.

Rules the bridge applies, the same for every device:

- **A turn starts** (a message from any device or the fleet, a turn begun at the desk or
  by the agent itself): `update` with the turn's message as `preview` (a message resent
  after a turn turned it down keeps the old one, as does a turn the agent opens with a
  line of its own) and `archived` cleared. A message handed to a running turn (steered)
  `set`s the preview: the app shows it as the last thing said.
- **A turn ends**: `update` with `archived` cleared and `unseen: true`, however it ended
  (the app marks a turn that ended off screen so today, a stopped one too). Done in the
  same step as `message.complete`, so a device that answers the event with "seen" always
  comes after it.
- **A thread is loaded** (resumed, adopted or started) with no `preview` yet: `set` it
  from the last user message of its history. A turn already running when it is loaded
  (started at the desk while the bridge was off) is a turn's start, as above; one the
  bridge saw start before it restarted changes nothing, unless the thread was archived
  since. Every agent titles a thread from its first
  message, so an older thread already shows its title; its preview comes the first time
  any device opens it (or from a device's carry-over), and nothing is loaded to find one.
- **Archiving unpins.** `archived: true` also clears `pinned`, unless the same mark
  pins (a device's archive and a pin made after it, sent as one change).
- **Who started a thread** is set when its record is made, by `fleet.start(params, by)`,
  which `thread.start` and Aeri's start_thread tool call with who is starting it. A
  thread from `session.create` (a device) or `session.adopt` (the desk, taken up by a
  person) has no mark. `from` naming one of the bridge's threads gives that thread's
  agent's name and id (`{"name":"Aeri","thread":"aeri"}`,
  `{"name":"Claude Code","thread":"6d3c…"}`); `sender` (a start passed on by a linked
  Mac) gives its words without the quoted title and thread id they carry ("Claude Code
  on mini"), one line, at most 80 characters; neither gives
  `{"name":"the portals command"}` (the person at the Mac, or a Codex thread, which
  cannot name itself).

### Feature `thread_sync`

Listed in `gateway.ready` and `bridge/src/gateway/features.ts`. The methods take only
this bridge's own threads: a `machine/thread` id is a thread it does not know (4007).

A thread is listed as the fleet describes it (`id`, `agent`, `agent_name`, `title`,
`folder`, `updated`, `read_only`), plus:

```json
{"id":"6d3c…","agent":"claude","agent_name":"Claude Code","title":"Fix the login",
 "folder":"/Users/dev/coding_projects/app","state":"idle","updated":1791324000,
 "created":1791320000,"revision":805,"preview":"Make the login keep its session",
 "pinned":true,"unseen":true,"started_by":{"name":"Aeri","thread":"aeri"}}
```

`created` is Unix seconds; `revision` is the list's revision when the thread last
changed; `pinned`, `archived`, `unseen`, `preview`, `started_by` and `ongoing` are left
out when false or unknown. `ongoing: true` marks an agent's one ongoing thread (Aeri's),
which cannot be removed. `state` is as of the answer and does not move the revision; the
app does not read it (`sessions.activity` says what is at work, as today).

| Method | Params (`?` = may be absent) | Result |
|---|---|---|
| `threads.changes` | `list?`, `since?` | `{"list":{"id":"3f9a1c0e7b2d4a65","revision":812},"threads":[…],"removed":["…"],"full"?:true}`. With `list` this bridge's id and `since` not above its revision: the threads changed since then and the ids removed since then (an id is in only one of the two). Otherwise (`list` or `since` absent, another id, `since` above the revision): `full: true`, every thread, and in `removed` every id `removed.json` holds, so a device that held threads under another list can tell the ones removed from the ones the bridge never knew |
| `thread.mark` | `thread`, `pinned?`, `archived?`, `unseen?`, `revision?`, `list?`, `turn?`, `preview?` | `{"thread":{…}}`, the thread as listed after the change. At least one mark or the preview is given (-32602 otherwise). Last write wins; `updatedAt` does not move. `revision` goes with `unseen: false`: the thread's revision as the device last listed it, and the seen is ignored when a turn has started or ended in the thread since (`turnRevision` above it), so a seen on its way never clears a turn that ended after it, while a pin or rename made elsewhere meanwhile does not hold it back. `list` goes with `revision`: a seen listed under another list (a bridge home before this one), or with a revision ahead of this list's, is ignored too. `turn` goes with `unseen: false`: the turn the seen is of, as listed; ignored when the thread's latest turn is another, so a turn read on a device before its list had the turn's end, seen with a revision fetched later, never clears a later turn from another device (net-20). `preview` is taken only when the thread has none (a carry-over) |
| `thread.delete` | `thread` | `{}` once the thread is off the list (below). -32602 with a sentence for an agent's one ongoing thread ("Aeri's conversation is always there: it cannot be removed.") and for a thread at work ("Claude Code is still working in this thread. Stop it, then remove it.") |
| `sessions.activity` | unchanged | Also `"thread_list":{"id":"3f9a1c0e7b2d4a65","revision":812}`, the list's id and revision now. A result key, sent to every client; an older app's decoder ignores it |

`threads.list` and the other fleet methods are unchanged: Aeri's tools and the `portals`
command see no new keys.

### Delete

`thread.delete` (`SessionManager.remove`) never stops anything: a thread at work is
refused, and the person stops it first.

1. A thread the registry does not know is 4007; an agent's one ongoing thread
   (`provider.onlyThread`) is refused.
2. A thread that is not loaded runs nothing, except in an agent that runs threads
   without the bridge: Codex (and Hermes) is asked (`liveThreads`, as at startup), and a
   thread it still has open is loaded first, so a turn it runs is seen even in the
   moments after a restart before the bridge follows it again. An agent that cannot be
   asked makes the delete fail (-32603, with a sentence) rather than go ahead. A thread
   being loaded or taken up is waited for.
3. A thread at work is refused: a turn running, a message handed to the running turn
   and not yet taken, an open question, a turn the bridge ended for the agent that the
   agent has not ended itself, or work the agent runs on in the background after its
   turn. The fourth is a new optional `ProviderSession.stopping()`: Codex's grace timer
   ends a turn Codex did not stop, and Codex may still be running it until it says that
   turn completed; Codex is also asked about every thread the bridge has loaded but one
   only read, for a turn the bridge never heard of (begun while its connection to Codex
   was down, or in a thread loaded after a restart only to be shown). The last is
   `ProviderSession.hasBackgroundWork()`: Claude Code's background commands and
   subagents run in its process, which closing the session ends, and Stop does not end
   them, so the refusal says to remove the thread once that work is done.
4. Otherwise, in one synchronous step: the session leaves the live sessions and is marked
   closed, the record leaves the registry and joins `removed.json`, and the revision
   moves. A send then finds the thread not open, and resuming or sending to it through
   the fleet finds it unknown (4007). A closed session starts nothing again, whatever
   answers late. Then it closes: Claude Code's process ends, Codex and Hermes keep the
   thread as their own.
5. Listeners hear `threadRemoved(id)` (a new optional `SessionListener` method): the
   push store forgets the thread (`forget`, like the app's DELETE route's `unwatch`). No
   fleet wait is left hanging: a thread at rest has none. `forget` keeps the id in
   memory and leaves it out of every state, so nobody is notified about it, and writes
   push.json only when it lists the thread, as read that once (the startup cleanup
   forgets the same way). So when the file cannot be read or written, nobody is notified
   about the thread all the same, also once the file is back; a file that cannot be read
   is not replaced by an empty one; and the next write that succeeds takes the thread
   out. A registration still in the file when the bridge stops (between the two writes,
   or with no write succeeding before the stop) is forgotten when the bridge starts while
   the thread is off the list, and when the thread is taken up again (`threadReturning`),
   before a device registers it; only one whose thread was taken up again before that
   stop is kept, and the take-up goes ahead.

Nothing the agent stores is erased. Taking it up again: `desk.list` already lists the
sessions that are not in the registry, which covers Codex's and Claude Code's started at
a terminal; it now also offers an agent's removed threads that its own list lacks and
that it still keeps (every removed Hermes thread, since Hermes lists no desk sessions,
and Claude Code's threads started from a device, since its list leaves out sessions
started through its SDK, until Claude Code deletes them as old), newest first, as
`closed`, with the title the thread had. `session.adopt` of a removed thread takes it up
the agent's usual way where it has one (with its checks, such as Claude Code's refusal
while a terminal has the session), keeping the title, model, level and mode it had (one
set to ask first never comes back on the agent's own settings); an agent with none
(Hermes) gets the record back as it was, with `continue` only.
Either way it leaves `removed.json`; a fork of it is a thread of its own and leaves the
removed one offered.

**A session loaded again in the same run numbers its events on from where the last one
stopped** (the manager keeps each id's last `seq`). Today a thread unloaded and loaded
again (a read-only thread continued, and now one removed and taken up again) starts at 1
under the same runtime id and epoch, and a device that held the old numbers would
replay from the wrong place; with this it gets `truncated` and takes a snapshot.

### How changes reach the other devices

No new event. The app already asks every host `sessions.activity` on connecting and
every few seconds while its sidebar is out; the answer now carries the list's id and
revision. When they differ from what the device holds, it calls `threads.changes` with
what it holds and gets only what changed: a few hundred bytes per changed thread, and
nothing at all while nothing changes. The sidebar's poll goes from every 8 seconds to
every 5, so a change shows within about five seconds wherever a list is visible (an
iPad or Mac window with the sidebar pinned beside the chat polls for as long as it is
connected). A device whose list is hidden fetches when the sidebar comes out, since the
poll runs at once then. A device also fetches right after a turn ends in the thread it
is looking at, to send that thread's seen (below), and about a second after a turn ends
or a title comes in any other thread it follows (one open here, whose events it gets):
what it hears within that second is one fetch, a fetch begun meanwhile leaves it none to
make, and the second leaves a device looking at that thread the time to say it saw it
(`HostSync.listMoved`).

A bridge that lists `poll_now` (docs/gateway-protocol.md, section 11; core plan phase 2)
also tells the devices that ask when something their poll reads moved: its list, a
thread starting or stopping work or needing an answer, its looks or its order. A second
after it says so the device runs its poll, sidebar out or hidden, and fetches only when
the list's revision is not the one it holds: the same one code path, a burst is one
fetch, and a change it made and merged from its answer fetches nothing more, nor does the
seen of a device looking at a thread, whose answer it merges as a pin's. The event
is a signal, not the changes, so the ordering rules here are unchanged, and the poll
every five seconds while the sidebar is out stays.

A poll is also kinder to the unseen flash than an event would be: the moment between a
turn's end and the "seen" from the device showing it is two quick calls, which a poll
rarely lands in.

### What the app keeps

`ThreadRecord` (AgentCore/ThreadStore.swift) gains, all optional so older files read:

| Field | Meaning |
|---|---|
| `startedBy` | `{name, thread?}` from `started_by` |
| `ongoing` | From `ongoing`: Remove is not offered |
| `revision` | The host's, as last listed: sent with a seen |
| `fromHost` | Listed by the host, not started or taken up on this device. Such a thread is not registered for notifications, so each device is notified about the same threads as before (below) |
| `localOnly` | Not listed and not removed when this device first synced with that list: kept here only, and never removed by the host's list. Cleared once the host lists it |

A new file `sync.json` in the app's store keeps, per host, the list id and revision last
merged and the **pending** changes: made here and not yet taken by the host,
`{thread, pinned?, archived?, unseen?, title?, preview?, remove?}` (a title with the one
it replaced here, `titleBefore`, which the thread gets back should the host say no).
`forgetHost` erases a host's entry.

### How the app merges

`ThreadSync` in AgentCore, a pure function tested in the package, applies a
`threads.changes` answer to a host's records and pending changes:

1. **Carry-over** first, when the answer is full and from a list this device has not
   merged before (no list held, or another id: a new bridge home, an older bridge that
   rewrote the file, a lost `sync.json`). For each listed thread, a mark the device holds
   and the host lacks becomes pending (where none is pending already): a pin always, an
   archive or unseen mark only when the host's time for the thread is not later than the
   device's (one older than the thread's last turn is stale, as something new in a thread
   brings it back), and the device's preview when the host has none, on the same
   condition. Only marks that are set are sent up, so a second device's carry-over adds
   to the first's pins and archive and clears none. A thread the host has unseen that
   the device holds seen, with the host's time not later than the device's, was seen
   here since its last turn (an app from before the list could not say so): it stays
   seen here and the host is told, as for the thread looked at. A thread the host does
   not list is forgotten when it is among the answer's removed ids, and otherwise kept
   and marked `localOnly` (its session may still be on the Mac, to take up from the
   desk).
2. **Removed ids**, and in a full answer every thread the device held when it asked that
   is not listed and not `localOnly`, are forgotten here: the record, its cached
   transcript and images, its open controller. A thread started here while the answer
   was on its way may be newer than the answer, so only what was held when asking counts.
   The thread on screen gives way to a new thread with the same agent, as a delete here
   does today.
3. **Each listed thread** is then added or updated: its title (a pending one, else the
   host's, else the one held: a title is never cleared), folder, read-only, created, time
   (the host's, so every device orders the list by one clock), revision, preview (the
   host's, else the one held), pinned, archived and unseen (the host's, except where a
   mark is pending: the pending value), `startedBy` and `ongoing`; `localOnly` is
   cleared. Its
   context and cached transcript stay as held. A thread with a pending removal stays
   hidden. One listed for the first time is `fromHost`.
4. **The thread looked at** (below), if unseen after merging, is marked seen.

`HostSync` in AgentCore runs a host's sync steps (send the pending changes, fetch, merge,
save) against a `ThreadSyncing` host, so the package tests drive it with a fake host and
two stores; HostModel calls it and applies what it returns.

### What the app does with a host that syncs

A host syncs while `sync.json` holds a list id for it: from its first merge until a
`gateway.ready` from it lacks `thread_sync`. Not being connected, or not yet connected in
this launch, changes nothing.

- **On connecting and at each poll**: the pending changes are sent, then, when the
  list's id or revision differs from the one held (or a change was just sent),
  `threads.changes` is called and merged, and what the merge added to the pending
  changes (a carry-over) is sent at once. A change that was only marks (a pin, an
  archive) needs no call: `thread.mark` answers with the thread as listed after it, and
  when the answers to what was sent are each one revision on from the list held, the
  first from it, they are all that moved the list and are merged as its answer would be.
  A title or a removal (answered with nothing), a change refused or not answered, or a
  revision missing between them (another device's change) is fetched as before. The
  answer to a seen is merged so only from a bridge that lists `poll_now`, whose
  `poll.now` the seen itself brings would otherwise fetch the list the seen moved, at
  every seen; elsewhere it is not merged: no fetch follows a seen, and the next one
  brings what it moved with the rest. A host's sync steps run one at a time, so an
  answer never crosses a change on its way, and in a task of their own, so a slow host
  does not hold up the others' polls. Each host's poll is its own too: one whose last
  `sessions.activity` is still on its way skips its next poll. Steps asked for while one
  runs are one more step after it (`HostSync.stepSoon`), which fetches when the asks did
  not agree on where the list is.
- **Pin, archive, unarchive, rename**: changed here at once and kept pending, which is
  sent right away (`thread.mark`, `session.rename`). Archiving here unpins here too. A
  title the host refuses (a thread only read) gives way to the one before it, and the
  host's sentence is shown (an alert, "Not renamed"). A step's refusals share one alert,
  and one that comes while an alert is on screen is shown once it is read.
- **Remove from Portals**: not offered for an `ongoing` thread, nor while the thread is
  running or waiting (stop it first). The thread is hidden at once and kept pending, sent
  as `thread.delete`; on screen it gives way at once to a new thread with the same agent.
  Its record, cached transcript, images and notification registration stay until the
  host confirms (its answer, or a list without it), and are then forgotten. One the host
  refuses leaves pending and shows again, and the host's sentence is shown (an alert, "Not
  removed"). A `localOnly` thread is forgotten here only, as today.
- **Seen**: the thread looked at is the one notifications are held back for
  (`PushCoordinator.visibleThread`: the app in front and the chat not slid aside). When
  a thread becomes looked at, and when a merge finds it unseen, the device clears it here
  and sends `unseen: false` with the thread's `revision`. When its turn ends while looked
  at, the device fetches at once, and the merge finds it unseen. A seen goes with the
  thread's revision as listed when it was seen and that list's id, so the bridge leaves
  a turn that ended after it, which this device never showed, and ignores it if its list
  has since been replaced (a new bridge home). From a bridge that lists `poll_now` its
  answer is merged as a pin's is, so such a turn shows unseen here as on every device,
  unless the thread is still looked at when the answer comes: it is then seen with the
  newer revision, sent at once. One that does not reach the host (not
  connected yet in this launch, or not reachable) is sent again at each step until the
  host takes it, looked at still or not; one that keeps failing holds up no other, and a
  merge of another list drops them all. It is never saved: one lost with the app leaves
  the thread seen here only, until something changes in it.
- **Unseen comes from the bridge only.** The device's own marking (a turn that ended out
  of sight in `onTurnFinished`, one that `refreshActivity` saw stop) is off for such a
  host: applied late, after another device's seen, it would leave a mark no fetch
  corrects.
- **Saving an open thread** (`persist`) changes only its time (when the controller's is
  later: a message sent here moves the thread up at once, until the next merge gives the
  host's), context and transcript. Its title, preview and marks come from the host's
  list, so a controller that has fallen behind (detached, say) never undoes a change
  made elsewhere.
- **A thread started or taken up here** (`createThread`, `adopt`) clears `fromHost` and
  is registered for notifications, also when a poll listed it first. Opening a thread
  another device started does neither.
- **Sending changes**: oldest first, one at a time. One the host answers with an error
  (4007, -32602, or any other, such as -32603 when it could not ask the agent) is
  dropped, a removal with the host's sentence shown, so one that keeps failing cannot
  hold up the rest (the next fetch shows the host's state); one that could not be sent,
  or that the host did not answer (the connection went, or it took longer than the app
  waits), stays for the next step with the rest of its thread's changes, while the other
  threads' changes, the fetch and the seen go on. One changed again while it was on
  its way stays pending with its new value. So a pin, a rename or a delete made while
  the Mac cannot be reached is not lost.
- **Saving**: a pending change is saved before the list changes; after a merge, the
  records are saved, and only once that save succeeded is `sync.json` (pending changes,
  list id and revision) saved. ThreadStore's saves of these two report failure for this.
  After a failure or a stop in between, the next fetch starts again from the revision
  held before, and merging what was merged already changes nothing.
- **Notifications stay as they are**: `registerForPush` registers the host's threads
  that are not `fromHost`, which are the ones this device started or took up, as
  before, and removing the host from the app unregisters only those. A thread an agent
  started notifies nobody (as today; the fleet section of the protocol says so).
- **The row's mark**: the caption under a thread's title begins with "Started by Aeri"
  (or "Started by Claude Code", "Started by the portals command"), with a small icon, and
  says so to VoiceOver.
- **Previews**: the app's own preview leaves out a `[Portals: from …]` first line too,
  and lines of nothing but spaces (the bridge's first line is the first with something
  on it), and a message with nothing to show gives way to the one before it, so the two
  agree (`Transcript.preview`).

With a host that does not list the feature (an older bridge, Hermes), nothing of this
runs and no new call is sent: the list, marks and delete are the device's own, as today.
For a host that synced before, the list id and revision are dropped when a
`gateway.ready` without the feature arrives, and pins, archive, renames and Remove made
meanwhile still go into its pending changes (true, false, a title or remove), unsent, so
should the feature come back, the device carries over again and sends the newest of
what was done.

### Recent threads (feature `recent_threads`, 2026-11-02)

The sidebar's Recent used to be each device's own (`RecentThreads`). On a bridge that
lists `recent_threads` it is one mark per thread, `recent`, as `pinned` is: `thread.mark`
takes it and a listed thread says it, so every portal shows the same ones without any
host copying anything. The mark does not move `updated`. Opening a thread, using it, or a
new thread's first message sets it on the thread's own host; × or a swipe clears it, a
person's word like a pin, kept pending while the host cannot be reached. Removing a
thread takes it with the thread. Archiving clears it (2026-11-02), on the host as it
unpins, unless the same `thread.mark` sets it (an archive and a use after it, sent together),
and from the device's own set on a host without the feature; an archived thread does not
show under Recent unless unread, and opening one to read it does not mark it. Something new
in one brings it out of the archive, as ever: it is under Running, then under Recent with
its dot; opened then, it is marked as any other, and with its dot gone it would otherwise leave.
Taken out of the archive by hand, it is not back under Recent until it is used.

- **Which host decides.** `sync.json`'s `keepsRecent`, per host: set by the first step that
  has a list from a host offering the feature, cleared by a connection that finds it
  gone, and what was marked then goes back to the device's own set. A host without the
  feature, a thread `localOnly`, and a key naming no thread held stay in the device's set,
  exactly as before, so older hosts see no call and no key. A marked thread a replaced list
  leaves out becomes `localOnly`, and its mark goes back to the device's set as well.
- **Carry-over.** In that step (`HostSync.carryRecent`) each key the device holds that
  names a thread on the list goes up as a pending `recent: true`, and the device lets go of
  the key once that is saved. Only `true` goes up, so two portals carrying over around the
  same time end with both's. A portal carrying over after another's person dismissed a
  thread brings that thread back, once: the same accepted race as a pin.
- **What is kept.** 25 read, idle threads of each host (`RecentThreads.readLimit`), the most
  any portal can show, so that whichever hosts a portal has, what it shows is among them
  and no portal takes off what another can show. A portal's number and its off switch
  only limit what it shows, from every host at once (`SidebarGroups.build`, `RecentChoice`,
  per device in Settings, Appearance). Keys in the device's set past 25 of their host are
  dropped as they were past 15. A mark past 25 of its host is taken off by a portal that
  sees that (`RecentThreads.pastKept`, `HostSync.expireRecent`), only from that host's own
  list, once a step of this connection found it current, and it is not kept pending: a
  portal away for a week sends nothing it worked out then. Portals work out the same
  marks; a mark taken off twice changes nothing. A dismissed row brings on the next of
  those kept where a portal shows fewer, or of another host's at 25. Only opening a thread
  older than all 25 of a host found current marks nothing, as that mark would only come off
  again and the thread shows at no number; using it marks it, which moves it up.
- **Off.** Marks go on being set and kept; only unread results show, which leave once read.

### Compatibility

| App | Host | What happens |
|---|---|---|
| New | Bridge with `thread_sync` | The host's list, synced as above |
| New | Bridge without it (npm 0.1.0, the fleet build), or Hermes | As today. No new method or key is sent (BridgeWire, HermesBackend+Bridge) |
| Old | Bridge with `thread_sync` | As today: it never calls the new methods and ignores `thread_list`. Its own list, marks and delete stay its own. A thread removed from another device fails to open there with the bridge's sentence (4007) |
| New | Bridge with `thread_sync`, without `recent_threads` | The list is the host's, and Recent the device's own, as above |
| Old | Bridge with `recent_threads` | Its Recent stays its own; it ignores the listing's `recent` |

The bridge's `contract.json` lists the new methods, and the app's
`Fixtures/contract-subset.json` lists `thread_sync` with `threads.changes` (`list`,
`since`), `thread.mark` (`thread`, `pinned`, `archived`, `unseen`, `revision`,
`preview`) and `thread.delete` (`thread`), so `scripts/check-contract.sh` checks them
against this bridge and skips them for Hermes, as for every feature. That check is for
the current bridge; the new app with an older bridge is covered by package tests that
give it a `gateway.ready` without the feature (npm 0.1.0's, and Hermes's) and check
that no new call or key is sent. Section 11 of the protocol gets the feature's row and
shapes, the `desk_sessions` paragraphs say that removed threads are offered again, and
its "Nothing here changes … except" line gains two cases: `session.adopt` gives a removed
thread back for an agent with no desk sessions, and a bridge with the feature forgets a
removed thread's push registration itself (section 10 says so too).

## Left out

- **An event for list changes.** The poll carries the revision; an event would need the
  app to route events with no session, and would show the unseen flash more often.
  (Since built, as a feature of its own: `poll_now`, docs/gateway-protocol.md section 11.
  The event only says when to poll, a second later, which gives the device looking at
  the thread the time to send its seen first.)
- **Polling while the list is hidden.** A phone in a chat, or a Mac window with its
  sidebar tucked away, fetches when the list shows again, on reconnecting and coming to
  the front; meanwhile a thread removed elsewhere stays in its chat, and a send there gets
  the bridge's sentence, as with an older app. (With a bridge that lists `poll_now` it
  polls when the bridge says something moved, sidebar out or hidden.)
- **Notifications for threads from other devices or agents.** Each device is notified
  about the threads it started or took up, as before. Registering every listed thread
  would notify every device about every thread; that is to decide still.
- **A change sent again after its answer was lost.** A pin or Remove the bridge took
  but whose answer never came is sent again at the next connection, and can undo a
  change made elsewhere in between (a pin undone, a thread taken up again removed again,
  which the desk offers again). It needs a lost answer and a change in between; marking
  each change with its own id would close it.
- **Threads of an agent the host no longer runs** stay hidden on every device, as today:
  the sidebar lists threads under the agents the host lists. Their records are kept and
  show again when the agent comes back.
- **Syncing context usage and transcripts.** A device shows a thread's context once it
  has opened it.
- **Previews for old threads before they are opened**, beyond what a carry-over sends
  up, which would mean loading every thread (and Codex loads a thread for good when
  asked); their titles show meanwhile.
- **Read state finer than unseen**, a confirmation for Remove, and `portals` commands or
  Aeri tools to archive or delete.
- **`done` as a fleet state.** The fleet's states stay OSC 7501's four; the sync listing
  says `unseen` instead.
- Out of scope by the brief: agent looks, syncing the paired hosts between devices,
  merging projects across Macs, the iPad/Mac redesign. (Agent looks came later, as a
  feature of their own: `agent_looks`, docs/gateway-protocol.md section 11.)

## Open questions

Choices made without asking, the simplest that fit the decisions; each is easy to change.

- **Who is notified.** Each device stays notified about the threads it started or took
  up, so a thread an agent started notifies nobody, also after someone sends a message into it
  from a phone. Registering a thread when a device sends into it, or every device for
  every thread, is a line in `registerForPush`.
- **The poll** goes from 8 to 5 seconds, for "within a few seconds", and runs only while
  the list shows.
- **The mark for the command**: a thread started with `portals start` and no thread
  named (the person at the Mac, or any Codex thread) says "Started by the portals
  command".
- **Remove** has no confirmation, now leaves every device, and is not offered while the
  thread is running or waiting: stop it first. The other way (Remove stops the turn
  and waits for it to end) costs a wait of up to 15 seconds and Codex's grace timer.
  Not offered for Aeri's thread.
- **Looked at** is what notifications already use: the chat, with the app in front and
  not slid aside. A Mac window left open on a thread counts as looking, so every turn
  that ends there is seen on every device; requiring the key window or recent input
  would change that. A turn that ends while the phone's sidebar covers the chat goes
  under Finished until the chat is shown again (today the chat's thread is never
  marked).
- **Threads a bridge does not know** at a device's first sync stay on that device,
  listed as before; opening one gives the bridge's sentence until it is removed or taken
  up from the desk.
- **Threads of an agent the host no longer runs** stay hidden, as today. Showing them
  would need a section of their own in the sidebar.
- **`removed.json` is never trimmed**: a removed thread stays offered for taking up
  again for good, at a few hundred bytes each.
- **The first sync on real bridges** lists every thread they hold, live-check
  threads included.
- **A title only a device had** (renamed while the Mac could not be reached, or a thread
  only read, with an app from before the list) is not sent up at the device's first
  sync: the host's title wins. Titles have no time, so which side is newer cannot be
  told; sending the device's would undo an agent's later title, and a second device's
  would undo the first's.
- **A carried-over archive** can land just after a turn started in the thread (in the
  one round trip between the first listing and the mark), archiving a thread with new
  work, which still shows under Finished until opened. Closing it would mean the bridge
  ignoring an archive older than the thread's last turn, a change to last write wins.
- **The carry-over trusts the device's clock**: a mark, a preview or a seen is carried
  only when the host's time for the thread is not later than the device's. A device whose
  clock runs ahead can carry a seen over a turn that ended within that much after it last
  showed the thread, which then leaves Finished everywhere unread. Dropping the check
  for the seen would bring back the flood of Finished at the first sync for threads read
  with an older app.

## Milestones

Each ends with every check below passing, then a commit on `sync` (no push).

| | What | Done when |
|---|---|---|
| S1 | **The bridge's list.** The registry's revision, list id, `set` and `update`, marks, preview and `startedBy`; the turn and load rules; `fleet.start(params, by)` for `thread.start` and Aeri's start_thread; `threads.changes` (no removals yet), `thread.mark` with its seen guard and preview, and `thread_list` in `sessions.activity`, as feature `thread_sync`; features.ts, `contract.json`, protocol section 11 | Tests with the fake agent and two clients as two devices: a thread created on one, started with `thread.start` (from a thread, from Aeri's id, from nobody, passed on with `sender`, which comes out short), started by Aeri's start_thread tool, or adopted, is in the other's changes with the right mark or none; pins and archive cross, archiving unpins, a new turn unarchives; two clients pinning and unpinning at once end on the last write; a turn's end marks unseen (a stopped one too), a seen clears it, and a seen with an older revision leaves a newer turn's unseen; changing the model, level, mode or title does not move `updated`, and the model, level and mode do not move the revision; a delta carries only what changed; the revision survives a restart; another list id and a revision ahead answer `full`; a file saved by an older bridge (no `list`) gives a new list whose revision starts above the old stamps; a client that never calls the new methods sees what it saw before |
| S2 | **Delete on the bridge.** `thread.delete`: refused for an ongoing thread and for one at work (with `ProviderSession.stopping()` for Codex, and a Codex thread still open after a restart loaded first), else removed in one step, its session closed for good; `removed.json`; `threadRemoved` for push; full answers carrying every removed id; event numbers that carry on across a reload; removed threads offered in `desk.list` and taken up again; protocol sections 10 and 11 | Tests: delete takes an idle thread off the list, another client's changes show its removal, and its push registration is gone; it is refused for an ongoing thread, a running turn, an open question, a steered message not yet taken, a Codex turn only the grace timer ended (the Codex test daemon) until Codex ends it, and a Codex thread Codex runs right after a bridge restart; after a delete a send, a resume and a `thread.send` start nothing; a removed thread is in `desk.list` and taken up again (Claude desk fixtures, the Codex test daemon's fork, a fake agent with no desk sessions) and leaves `removed.json`; `removed.json` survives a restart and a save by an older bridge; a device that missed a removal and a taking up gets the thread, not its removal; a reloaded session's events carry on numbering |
| S3 | **The app's side of the wire, the merge and the sync step.** BridgeWire's feature, methods and types; a `ThreadSyncing` protocol in AgentCore that HermesBackend serves only to a host listing the feature; `ThreadActivityReporting` also returning `thread_list`; the new `ThreadRecord` fields; `sync.json` and saves that report failure in ThreadStore; `ThreadSync`'s merge; `HostSync`; the contract subset; `portals-probe threads`, which prints a host's list through the app's own client | Package tests: the wire's shapes; nothing sent to a host whose `gateway.ready` lacks the feature (npm 0.1.0's and Hermes's); today's activity result still decodes with `thread_list` in it; the merge's rules one by one (pending wins; carry-over adds set marks, skips a stale archive or unseen, sends a preview, forgets removed threads and keeps unknown ones `localOnly`; a second carry-over clears nothing; a listed `localOnly` thread is cleared; full and delta removals; a thread added while the answer was on its way is not forgotten by it; the host's time wins; the thread looked at is marked seen with its revision); `HostSync` with a fake host and two stores: a pin toggled again while the first is on its way ends on the newer value, a refused Remove brings the thread back with its transcript and images, an offline rename survives a merge, a failed save of the records leaves the revision where it was, the feature going and coming back keeps what was done meanwhile, a host counts as syncing before its `gateway.ready`; old `threads.json` files still read; the contract check; both app builds |
| S4 | **Every device shows the host's list.** HostModel running `HostSync` on connecting and at each poll; pins, archive, rename and Remove through pending changes, Remove not offered while running or waiting or for `ongoing`, a refusal's sentence shown; seen for the thread looked at, sent only while connected; no local unseen for such a host; `persist` keeping to time, context and transcript; `createThread` and `adopt` clearing `fromHost`; notifications and removing a host for threads not `fromHost` only; the feature going away and coming back; the poll at 5 s; the row's mark; the app's preview without the fleet line | Both builds, and an iOS launch. Live, on a scratch bridge with fake agents only: device A (`portals-probe` and a test client) and device B (a scratch iPhone simulator). B lists A's thread with its preview and time; a thread started with `thread.start` from another thread shows "Started by …" on B; a pin, an archive and a rename made on B reach A within one poll, and A's reach B (screenshots); a turn ending while B's sidebar is out puts the thread under Finished on B, and a mark from A clears it; with the thread looked at on B, its turn's end leaves it seen; Remove is not offered on B while a turn runs, and once it ends Remove on B takes the thread off A's list and the fake session is offered again in `desk.list`; B's earlier marks carry over on its first sync |

## Things to check early

- That the Codex test daemon can show a turn/interrupt that Codex refuses, and a turn
  completed after the grace timer ended it (`stopping()`).
- Whether Codex's adopt takes up a fork by its id as it takes up any thread (removed
  forks are offered again). Checked in S2 against the test daemon only: it does. Whether
  Codex's own `thread/list` gives a fork (and a first message for it) was not checked
  against a real Codex.
- How the sidebar's poll behaves when an iPad or Mac window keeps the sidebar beside the
  chat (`sidebarIsOut`): it should run all the time the app is connected.
- How many threads the user's real registries hold: the first sync lists every one,
  including live-check threads. Not checked here (real bridges are off limits).

## Testing rules

- Never an installed bridge and never the devices. Live checks run this branch's
  bridge in the foreground from a small script that starts it with fake providers, its
  own `PORTALS_BRIDGE_HOME` in the session's scratch folder, its own port and an `auth`
  hash, and no real agent or model call.
- The simulator is a scratch one made for the check (`xcrun simctl create`), deleted
  afterwards; no other simulator is shut down, erased or deleted. No GUI scripting of
  the Mac.
- Every bridge and simulator started is stopped by its pid or id, and its child
  processes checked gone.
- Nothing is pushed, merged, published or installed.

## Verification

For every milestone, from the worktree:

- `cd bridge && npm test && npm run typecheck && npm run contract`, then from the root
  `scripts/check-contract.sh` (this Mac's Hermes contract, which only reads its file)
  and `scripts/check-contract.sh bridge/contract.json` (416 bridge tests before S1).
- `cd Packages/PortalsKit && swift test`.
- `xcodebuild -project Portals.xcodeproj -scheme Portals -destination 'generic/platform=iOS Simulator' -derivedDataPath <scratch>/dd-ios build`
  and the Mac Catalyst build with `CODE_SIGNING_ALLOWED=NO`; after any change that looks
  Mac-only, an iOS launch too.

S4 adds the live check above, with screenshots from the scratch simulator
(`xcrun simctl io <id> screenshot`) and the app's `threads.json` and `sync.json` read
from its container.

## Progress

- 2026-10-11, S1 done: the bridge's list (registry list id and revision, `set` and
  `update`, marks, preview, `startedBy`, the turn and load rules, `fleet.start(params,
  by)`, `threads.changes`, `thread.mark`, `thread_list` in `sessions.activity`, feature
  `thread_sync`, protocol section 11). Tests in `bridge/test/sync.test.ts` and two in
  `aeri.test.ts`. Where the code led away from the plan:
  - The seen guard compares the device's revision with the revision of the thread's
    last turn start or end (`turnRevision`, a new stored key that is not listed), not
    with the thread's own revision. Compared with the thread's revision, a pin, archive
    or rename made on another device (or on the same one, still on its way) between a
    device's listing and its seen would drop the seen, and a thread opened briefly would
    stay unseen everywhere. The promise is unchanged: a seen never clears a turn that
    ended after the device listed the thread.
  - A message handed to a running turn becomes the preview, as the app's own preview
    already shows it; the turn it runs in after an agent turned it down keeps it.
  - `ongoing` is listed from S1, since the listing's shape is S1's.
  - A bridge whose `threads.json` is missing writes it at once with the new list (and
    no thread), so a fresh bridge home now has the file before any thread is made.
  - Found in Codex's review of S1: a turn found running when a thread is loaded or
    taken up (Codex at the desk while the bridge was off) is a turn's start, so it
    takes the thread out of the archive and gives its preview; a turn's end (or title)
    an agent reports while its thread is still being taken up is kept in the record
    the registry then adds, where it used to be lost; a thread started over a
    conversation its agent kept (Aeri's, after its registry entry was lost) takes its
    preview from it. The bridge's preview skips lines of nothing but spaces, which the
    app does not yet; S4's preview item now says the app skips them too.
  - From Codex's second pass: two devices taking up the same desk session at once now
    get the one thread (the second waits for the first, then finds it), where the
    second used to replace the first's record, and with it a pin made in between; and a
    turn found running after a restart that the bridge saw start, with the same preview
    and the thread not archived, leaves the thread where it was, so a restart mid-turn
    does not move it up every list.
  - From Codex's third pass: "the bridge saw it start" is a stored mark (`inTurn`, set
    by a turn's start and cleared by its end), not the preview alone, so a new desk
    turn that says what the last one said still counts as a start; and continuing a
    thread only read is under the same one-at-a-time rule as taking one up, so two
    devices continuing it at once no longer unload each other's session.
  - From Codex's fourth pass: a thread loaded at rest with `inTurn` still set (its turn
    ended while the bridge was off) clears it. Accepted and left: a turn that ends while
    the bridge is off is not marked unseen (no agent says so afterwards), and if in the
    same outage a new desk turn starts whose first line is the old one's, that turn's
    start is taken for the old one, so the thread moves up only when it ends. Telling
    the two apart would need a turn id from every agent.
- 2026-10-11, S2 done: delete on the bridge (`thread.delete`, `SessionManager.remove`,
  `removed.json`, `threadRemoved` for push, removed ids in `threads.changes`, event
  numbers that carry on across a reload, removed threads in `desk.list` and taken up
  again, `ProviderSession.stopping()` for Codex's grace timer, protocol sections 10 and
  11). Tests at the end of `bridge/test/sync.test.ts` (fake agent, two devices), in
  `codex-bridge.test.ts` (grace timer, restart), `desk.test.ts` (Claude Code, a Codex
  fork), `aeri.test.ts` (Aeri's thread) and `eventlog.test.ts`: 468 bridge tests pass.
  No Swift changed, so the app builds were not run; `swift test` passes. Codex reviewed
  it in four passes in a herdr pane; what it found is below. Where the code led away
  from the plan:
  - Codex's own desk list does not leave forks out: the filter it goes through drops
    `parentThreadId`, which Codex's types say marks a sub-agent's thread (a fork has
    `forkedFromId`). The list Claude Code gives does leave out the bridge's own threads
    (`includeProgrammatic: false`), so a Claude Code thread started from a device would
    not have been offered again. `desk.list` offers any removed thread the agent's own
    list lacks, whichever agent, so each case shows once; the Delete section says so.
  - A thread taken up again the agent's usual way keeps the title it had, as the desk's
    list offered it (Claude Code would otherwise rename a thread started from a device
    to its own summary).
  - Hermes, which has `liveThreads` too, is asked like Codex. An agent that cannot be
    asked makes the delete fail with -32603 and a sentence: a thread it may be running
    is not taken off the list blind.
  - `ProviderSession.stopping()` asks Codex again (`thread/read`) while the turn its
    grace timer ended has not been reported completed, so a Codex that ended it without
    the bridge hearing (its own restart, a dropped connection) does not keep the thread
    from being removed until the bridge restarts. The grace timer can be shortened for
    tests (`interruptGraceMs`, as Claude Code's).
  - A session let go of for good is `retire`d in the step that takes it out of the live
    sessions: it starts no turn, resends nothing and writes no record afterwards, and
    `session.create`, `session.resume`, `session.adopt`, `session.rename` and
    `thread.send` that loaded it just before answer 4007. Continuing a thread only read
    retires the old session the same way. `SessionListener`'s methods are all optional
    now, so the push store listens for `threadRemoved` alone, with or without a way to
    send notifications. Aeri's private `stopping` field is `stopAsked`, to leave the
    name to the new method.
  - An agent with no sessions from the desk now answers `session.adopt` of one of its
    threads that is on the list with that thread, as agents with desk sessions always
    did, so two devices taking up the same removed Hermes thread at once get the one
    thread.
  - From Codex's review of S2: a turn begun at the desk in a Codex thread the bridge
    follows counts as at work from its `turn/started`, before its message arrives (a
    compaction at the desk never brings one), through `stopping()`, checked with Codex
    as the grace timer's turn is; a delete whose files cannot be written changes
    nothing (the record is written first, before the session is let go of, and the
    registry undoes its own change when either file fails); a removed thread is offered
    with the title it had also where the agent's own list has it (a Codex fork, which
    Codex lists under the first message of the thread it copied); a removed thread that
    never had a message is not offered, as Claude Code and Codex keep nothing of it to
    take up (it is still in every full answer's `removed`); a call that loaded a thread
    only read while another device continued it uses the session that replaced it, where
    it used to answer 4007 (`SessionManager.current`, and `load` gives way the same way).
  - From Codex's second pass: a thread being continued after it was only read is
    loaded by anyone else only once that is done (`load` waits for the taking up, which
    loads with `loadOnce`), where a device opening it in between used to load it again
    only for reading, which the continuing device then joined (an S1 race too); and
    `stopping()` counts a turn Codex began while it was being asked about the last one.
    From its third pass: continuing a thread only read also waits for a load of it
    already under way (a device opening it after a restart) and lets that go too, and a
    `session.resume` whose session was let go of while it read the thread loads it again.
    Accepted: whether a removed thread had a message is read from its preview, or a time
    later than its creation; a thread from before S1 can be judged wrongly either way
    (an empty one whose model was changed is offered and refused when taken up; one whose
    only turn ended within the second it was made, and that was never opened since, is
    not offered, unless its agent's own list has it).
  - Accepted from that review: a thread taken up only for reading is never at work in
    the bridge, which neither runs nor follows it, so it is removed even while the
    terminal that has it runs a turn. Only the bridge's view of it leaves the list: the
    terminal's work goes on, and the desk's list still offers the session (Codex's with
    its state). Refusing it would mean asking each agent about sessions it runs for
    someone else, and Claude Code cannot tell a session open in a terminal from one at
    work there.
- 2026-10-11, S3 done: the app's side of the wire, the merge and the sync step.
  HermesBackend serves `ThreadSyncing` (BridgeWire's `thread_sync`, `threads.changes`,
  `thread.mark`, `thread.delete`, a title as `session.rename`) only to a host whose
  `gateway.ready` lists the feature, and `sessions.activity` gives a
  `ThreadActivityReport` with the list's id and revision from such a host. AgentCore
  has `ThreadSync.merge` (pure), `HostSync` (a host's steps, one at a time), the new
  `ThreadRecord` fields, and `sync.json` in ThreadStore, whose saves of it and of
  `threads.json` say when they fail. `portals-probe threads [--list ID --since N]`
  prints a bridge's list through the app's own client, and a capture of it from this
  branch's bridge with the fake agent is a fixture (`bridge-threads-changes.jsonl`). Tests
  in `ThreadSyncTests` (each merge rule), `HostSyncTests` (a fake host that keeps the
  list as the bridge does, and two devices with a store each), `ThreadSyncWireTests`
  (shapes, npm 0.1.0's and Hermes's `gateway.ready`, the activity answer),
  `ThreadStoreTests`, `LegacyFileTests` and `ContractSubsetTests`. HostModel only reads
  `.threads` from the report and keeps the new fields when it saves a thread; it runs
  none of this until S4, so the Debug build launched in a scratch simulator against a
  scratch bridge starts, connects and reads the activity answer with `thread_list`, and
  still shows the device's own list. Where the code led away from the plan:
  - A step sends the pending changes a second time after merging, so what a carry-over
    added (and a change made again while the first was on its way) goes up in the same
    step rather than at the next poll.
  - The thread looked at is asked for when a merge is made (`HostSync.lookedAt`), not
    when the step is asked for, so a thread opened while a fetch is on its way is seen
    when it arrives; a seen asked for before a merge goes with the revision the merge
    gave.
  - A change the host answers with any error, not only 4007 or -32602, is dropped (a
    removal with the host's sentence, as for a refusal), so one that keeps failing
    (-32603 when the bridge could not ask Codex) cannot hold up every later step.
  - A thread entry the app cannot read is kept as held, neither changed nor forgotten;
    a full answer without its threads, or with an entry that has no id, is not merged
    at all, since every thread it leaves out would be forgotten.
  - `HostSync.record` throws when the change cannot be saved, keeping nothing, so the
    caller leaves its list as it was: a change kept only in memory could be lost behind
    an older one saved before it. It still answers false for a host that never kept the
    list.
  - Archiving records `pinned: false` with it, as archiving unpins.
  - An answer asked for before a connection found the host without the feature is not
    merged, also on a first sync.
  - HostSync deletes a forgotten thread's transcript and images itself, after the
    records without it are saved; the device lets go of the rest (an open thread) in
    `holdThreads`, which is told which threads were forgotten.
  - From Codex's review in a herdr pane: the answer to a change does not settle a key
    recorded again for that thread while it was on its way (an answer slow to come back
    no longer clears a newer pin that came back to the same value after another device
    unpinned), while the keys not recorded again are settled (a rename meanwhile does not
    send an old pin again over another device's unpin). A change the host said no to
    moves the list merged last back to before that thread was last listed, so the next
    fetch puts the host's title or marks back where the device showed its own (an empty
    delta could not); for a thread listed at revision 0, from before the list, the
    revision held becomes -1, which asks for every thread of the same list again. A
    title the host said no to gives way to the one the thread had here before it
    (`titleBefore`, kept with the pending title, and saved back into the thread before
    the pending title goes), which stands where the host lists the thread with no title,
    as a title is never cleared; once the host takes a title while a newer one waits,
    that taken title is the one to go back to, and a title recorded while a thread's
    marks are on their way is the one sent after them. Also from it: the failed save in
    `record`, the full answer taken only whole, a seen queued behind a merge going with
    the merge's revision, and an answer from before the feature went not merged on a
    first sync, above. Codex reviewed it in seven passes.
  - Accepted from that review: sending a change, saving `threads.json` and saving
    `sync.json` are three steps, so a stop between them, or a settled change whose save
    failed, sends a change again (the plan's "A change sent again after its answer was
    lost", under Left out).
- 2026-10-11, S4 done: every device shows the host's list. HostModel keeps a `HostSync`
  for a host whose backend can keep the list (HermesBackend; the scripted backend has
  none), given its own `threads` and the thread looked at, and runs a step on connecting
  and at each poll, now every 5 seconds. Pin, archive, rename and Remove are recorded as
  pending changes before the list here changes and are sent at once; Remove hides the
  thread until the host takes it and is offered only for a thread at rest that is not
  an agent's ongoing one; a refusal shows the host's sentence. Seen goes up for the
  thread looked at (`threadLookedAt`), and a turn that ends while it is looked at fetches
  at once; such a host gets no local unseen marks. `persist` takes only the time and
  context (`ThreadRecord.saving`); a thread started or taken up here leaves `fromHost`
  and is registered for notifications; notifications and removing a host cover only
  threads that are not `fromHost`. The row's caption begins with "Started by …" and an
  icon (`ThreadStarter.caption`), and the app's preview is `Transcript.preview`. Tests in
  `ThreadStateTests` (the preview), `ThreadSyncTests` (`saving`, `offersRemoval`, the
  caption) and `HostSyncTests` (`stop`, `stepSoon`); the app has no test target, so the
  rest is shown by the live check. Live check, on a scratch bridge with the fake agent
  (its General folder outside its home: `desk.list` never offers the bridge's own
  folder): device A was a test client and `portals-probe`, device B a scratch iPhone
  simulator driven by a UI test in a throwaway copy of the project. B's first sync
  listed A's threads with their previews and times and carried its own pin and archive
  up; the thread started with `thread.start` from another showed "Started by Fake
  agent"; B's pin, archive and rename were on the bridge as soon as B made them, and A's
  pin, rename and unarchive showed on B within one poll (5 and 0.7 seconds in the two
  runs, the second on the code as committed); a turn ending out of B's sight
  put the thread under Finished on B within 4 seconds, and A's seen cleared it within 4;
  a turn ending while B looked at the thread was seen on the bridge 0.3 seconds after it
  ended; B's menu had no Remove while a turn ran and had it at rest, and Remove on B took
  the thread off A's list and `desk.list` offered it again; a thread the bridge never had
  stayed on B, `localOnly`. Where the code led away from the plan:
  - `HostSync.stop()`, new: a model let go of (its host edited, or removed from the app)
    stops its sync, so a step under way sends and saves nothing more, over what the next
    model or the removal does with the same files.
  - The step coalescing is in AgentCore (`HostSync.stepSoon`, with `stepped`), where it is
    tested, rather than in HostModel.
  - The thread on screen gives way to a new thread as soon as Remove hides it, as a delete
    did, rather than when the host confirms.
  - A message with nothing to show (spaces only) no longer gives an empty preview: the
    one before it is the preview, as on the bridge.
  - Opening a thread while the Mac cannot be reached clears it here and keeps the seen
    for the next step, which sends it if the thread is still looked at then (the plan's
    retry rule); it is still never saved.
  - From Codex's review in a herdr pane: a sync stopped while a change was on its way
    used to send the rest of that step (a title, a removal, a fetch), and now sends
    nothing after the call on its way; a slow host's `sessions.activity` held up every
    host's next poll, and each host now polls on its own; a title the host refused, or
    one given on another device, now shows in an open thread too
    (`ThreadController.titleListed`), not only in the list; and two asks for a step that
    disagreed on the list (a poll that saw it move, a change here with the list merged
    last) could end in a step that did not fetch, and now fetch. Each of the two in
    AgentCore has a test that fails without its fix.
- 2026-10-11, the reviews of the branch: three Claude reviewers (the bridge, the app, a
  live run on a scratch bridge and simulator), each with a Codex pass of its own, and a
  Codex review of the whole branch, found 17 things; each fix has a test that fails
  without it, and Codex reviewed the fixes in a herdr pane in two or three passes, whose
  points are fixed too (4ead6a2 the bridge, 89cff75 the app). What changed:
  - Remove: a Claude Code thread whose background command or subagent still runs is
    refused with its own sentence (Stop does not end that work, and closing the session
    would); Codex is asked about every thread the bridge has loaded but one only read,
    so a turn begun while the connection to Codex was down, or in a thread loaded after a
    restart only to be shown, is seen; when Codex cannot be asked, the delete fails with
    -32603 and a sentence (it used to refuse as "still working").
  - A removed thread taken up again keeps its model, level and mode as well as its title
    (a thread set to ask first came back on the agent's own settings); a turn that
    starts or ends while it is taken up stamps `turnRevision`; a push registration that
    outlived a removal is forgotten when the bridge starts or the thread is taken up
    again, and one push.json could not lose is no longer notified about while the bridge
    runs and leaves the file at its next write (from Codex's check of the fixes);
    `desk.list` no longer offers a removed thread its agent has deleted since
    (`Provider.keeps`, Claude Code's old sessions), nor one another device took up while
    it asked.
  - The registry's `set` and `update` leave the record and the revision as they were
    when threads.json cannot be written, as `add` and `remove` did.
  - `thread.mark`: an archive's unpin comes before the same call's pin, so an offline
    archive and a pin made after it, sent as one change, stay pinned; a seen takes the
    list it was listed under (`list`), and one from another list, or with a revision
    ahead of this one's, is ignored.
  - The app: a change the host does not answer (the app's timeout, a dropped connection)
    waits for the next step with the rest of its thread's changes, while the other
    threads' changes, the fetch and the seen go on; a seen is kept until the host takes
    it, looked at still or not (the plan dropped it, a rule from before the bridge's
    `turnRevision` guard), with the revision as listed when it was seen, and is dropped
    when a merge brings another list; the first sync tells the host of threads this
    device had seen since their last turn (the bridge marks every turn's end unseen,
    also while only an older app, which never says seen, is used), and sends a preview
    only under the same time check as the marks; a refused title is shown, "Not
    renamed", and a step's refusals share one alert; a thread taken up here while a
    fetch was on its way, and removed elsewhere before the answer, is asked about again
    at the next step rather than kept for good.
  - Left open (Open questions): a title only a device had at its first sync, a
    carried-over archive landing just after a new turn, and the carry-over's trust in
    the device's clock (also for the seen it now sends).
- 2026-10-11: plan written, then reviewed by a Claude critic and by Codex. What each
  point changed, or why it did not:
  - Critic 1 and Codex 1, Remove forgets at once: taken. A Remove is hidden until the
    host confirms, keeping the record, transcript, images and `fromHost`; a refusal
    brings it back with no full fetch.
  - Critic 2, a second carry-over leaves threads removed elsewhere as `localOnly`
    ghosts: taken, by a different fix. A full answer lists every removed id, so a
    carry-over forgets those and marks `localOnly` only threads the bridge never knew.
  - Critic 3, refuse to delete a busy thread instead of interrupting and waiting: taken.
    It drops the 15 s wait and the grace-timer race, and the refusal's sentence is shown.
  - Critic 4, removing a host unwatches other devices' threads: taken; only threads not
    `fromHost` are unwatched, which is today's behaviour.
  - Critic 5, `registry.update` callers would move threads up every list: taken. Only a
    turn's start and end move `updatedAt`, and writes to keys the listing does not carry
    do not move the revision.
  - Critic 6, syncing is unknown before `gateway.ready`: taken. A host syncs while
    `sync.json` holds its list id, dropped only by a ready that lacks the feature.
  - Critic 7 and Codex 9, an offline rename is lost: taken; titles join the pending
    changes.
  - Critic 8, Aeri's start_thread bypasses `thread.start`: taken; `fleet.start` takes who
    is starting, and S1 tests the tool itself.
  - Critic 9, old revision stamps outlive a new list: taken; a new list's revision
    starts above every stamp.
  - Critic 10 and Codex 7, removal records inside `threads.json` and capped at 500: taken.
    They live in `removed.json`, which an older bridge never rewrites, are never trimmed,
    and keep removed Hermes threads and Codex forks recoverable for good; `forgotten` is
    gone.
  - Critic 11, an adopt that a poll listed first stays `fromHost`: taken; `createThread`
    and `adopt` clear it themselves.
  - Critic 12 and Codex 3, a change replayed after a lost answer: not taken. It needs a
    lost answer and a change in between, and the harm is a mark undone or a thread
    removed again that the desk still offers; a generation and an id per change are more
    than that is worth. Listed under Left out.
  - Critic 13, a late device's carry-over re-archives or re-marks unseen: taken; an
    archive or unseen mark older than the host's time for the thread is not carried.
  - Critic 14, a passed-on `sender` makes a long mark: taken; the quoted title and
    thread id are cut.
  - Critic 15 and Codex review 2 item 16, untitled old threads show "New thread": taken;
    a carry-over sends the device's preview where the host has none.
  - Critic 16 and 17, notifications after sending into a thread and a Mac window left
    open: not decided here; both added under Open questions.
  - Critic 18, the protocol's "Nothing here changes" line: taken; its two new
    exceptions are named.
  - Critic 19, split delete out and promise more tests: taken. Delete is its own
    milestone (S2), and the tests it listed are in the Done when columns.
  - Codex 2, a delete after the grace timer or right after a restart: taken in a simple
    form. `ProviderSession.stopping()` counts a turn Codex has not ended as at work, and
    an unloaded Codex thread Codex still has open is loaded before the check.
  - Codex 4, carry-over as a once-only operation with an import token: not taken. The
    stale-mark check (critic 13) covers the common case, and a replay is the same
    lost-answer case accepted above.
  - Codex 5, a seen crossing a newer turn's end, and a failed seen never retried: taken.
    A seen carries the thread's revision and is ignored if the thread changed since, and
    a failed one is sent again while the thread is still looked at. The Left out item that
    accepted the race is gone.
  - Codex 6, an interrupted turn is not always a person's Stop: taken; every turn that
    ends out of sight marks unseen, as the app does today. The open question is gone.
  - Codex 8, poll while a chat is in front too: not taken. The list is not on screen
    then, so the requests on cellular would buy nothing visible; it is fetched when the
    list shows, and a send in a removed thread gets the bridge's sentence. Listed under
    Left out.
  - Codex 10, device clocks ahead keep devices from agreeing on order: taken; the host's
    time wins in a merge, and a send here moves a thread up only until the next merge.
  - Codex 11, threads of a disabled agent stay hidden: not taken. They are hidden the
    same way on every device and today; showing them needs a new sidebar section, which
    is UI work the brief leaves out. Kept under Open questions.
  - Codex 12, the contract check cannot prove older-bridge compatibility: taken in part.
    The plan no longer leans on the check for that; package tests with npm 0.1.0's and
    Hermes's `gateway.ready` do. No compatibility mode is added to the script.
  - Codex 13, test the sync coordination, not only the pure merge: taken. `HostSync` in
    AgentCore runs a host's sync steps and is tested with a fake host and two stores; a
    change made again while on its way stays pending.
