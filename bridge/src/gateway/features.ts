// The extensions to the gateway protocol this bridge offers (docs/gateway-protocol.md,
// section 11), listed in `gateway.ready` as `bridge.features`. The app uses one only
// when it is listed, and never sends Hermes any of them.
//
// - `folders`: the `folders.list` method, and `session.create` takes only a `cwd` from it.
// - `model_levels`: `model.options` says which thinking levels each model takes.
// - `push_host`: the app may send its id for this host when registering for
//   notifications, for them to name it.
// - `desk_sessions`: `desk.list` lists sessions started in a terminal at the desk, and
//   `session.adopt` makes one a thread (continued, forked or only read).
// - `model_names`: `model.options` says what to call each model, for agents whose ids
//   are not names (Claude Code's `default` and `opus` are both "Opus 5.5").
// - `compaction`: the `session.compacted` event and the `compaction` stored message say
//   where the agent summarised the conversation to free its context (`/compact`, or by
//   itself as the context filled up).
// - `rename`: the `session.rename` method gives a thread a title of the user's, which the
//   agent keeps as its own name for the session.
// - `activity`: the `sessions.activity` method lists the threads running or waiting on an
//   answer now, whether this connection follows them or not.
// - `model_default_levels`: `model.options` says the thinking level each model runs at
//   when a thread chooses none (Claude Code's differs by model).
// - `question_details`: a `clarify` question may carry `header` (a word or two naming it)
//   and `descriptions` (what each choice means, by choice).
// - `modes`: a thread's `info` says its `mode` (and `mode_default`, what following the
//   agent's settings comes to), the `session.mode` event says when it changes, and
//   `session.set_mode` changes it. An `approval` may be a `plan` with the mode its work
//   `starts_in`, and its answer may carry a `note` (what the user wants instead).
// - `push_relay`: the push registration's `device` may carry the `relay_token` the app got
//   from the relay, which a bridge without an APNs key sends through
//   (docs/pairing-and-relay.md).
// - `push_sealed`: the push registration's `device` may carry a `key`, and notifications
//   to that device then carry their words sealed to it under `aeriportal.sealed`.
// - `push_muting`: the push registration's `device` may carry `muted`, the kinds of
//   notification (`approval`, `question`, `finished`, `failed`) the device does not want;
//   the bridge sends it none of those (the app's Settings, Notifications).
// - `folders_add`: the `folders.add` method puts a folder the user chose on this Mac on
//   the list for new threads, where `folders.list` marks it `added` until
//   `folders.remove` takes it off again.
// - `machine`: `gateway.ready`'s `bridge` block carries `machine`, the Mac's host name
//   and the home folder of the user the bridge runs as, by which an app on a Mac tells
//   that the bridge is on the same one (and may offer that Mac's folder dialog).
// - `fleet`: `threads.list` lists every thread with what it is doing, and `thread.read`,
//   `thread.send`, `thread.wait`, `thread.start` and `thread.stop` act on one, whether or
//   not the connection follows it (docs/fleet-plan.md). For clients that manage threads
//   as a whole; the app does not use it yet.
// - `fleet_delta`: linked bridges explicitly request `threads.delta` for changed
//   rows, removals, a complete live-state overlay and an insertion-order digest.
//   Devices keep today's threads.list and threads.changes shapes.
// - `fleet_delta_positions`: changed rows carry absolute registry positions, so
//   remove/readopt preserves order without a repair call. Full replies imply positions.
// - `fleet_pages`: linked bridges can stage bounded frozen pages after a full-fetch
//   timeout, then seal the complete base with a fresh delta before showing any rows.
// - `thread_sync`: the bridge's own threads are the list every device shows, with their
//   pins, archive and unseen marks, previews and who started them (docs/sync-plan.md):
//   `threads.changes` gives what changed since a revision of the list and the threads
//   taken off it, `thread.mark` changes a thread's marks, `thread.delete` takes a thread
//   off the list (its agent keeps it: `desk.list` offers it again and `session.adopt`
//   takes it up), and `sessions.activity` says the list's id and revision
//   (`thread_list`), which a device checks to know when to ask.
// - `agent_kinds`: each agent in `profiles.list` says its `kind`, which agent runs it
//   (`claude`, `codex`, `pi`, `cursor`, `droid`, `fake`, or `hermes` for a Hermes profile).
//   The app draws a maker's logo by it and not by the agent's name, which for a Hermes
//   profile is the user's own choice and may be `pi` or `cursor`.
// - `queue`: `prompt.submit` takes `when_busy`: `steer` (the default) hands a message sent
//   while a turn runs to that turn where the agent can take it, `queue` keeps it for a turn
//   of its own. A message kept so is answered with its `queue_id`; the `queue.changed`
//   event, and the `session.resume` snapshot while any wait, list the messages waiting
//   (`queued`: `id`, `text`, `fleet`) and whether the agent can take one into a running
//   turn (`can_steer`), and the event names the one just handed to the running turn
//   (`steered`); `message.start` names the `queue_id` of the one opening a turn;
//   `prompt.queue.remove` takes one off the list and `prompt.queue.steer` hands it to the
//   running turn now.
// - `files`: `file.attach_bytes` takes a file of any kind (at most 25 MB, 10 a message)
//   for the next message. The bridge saves it in the thread's folder under
//   `.portals/files/<thread>/` (left out of git) and the message names its path, after a
//   line of its own (`Files attached in Portals (saved on this Mac):`, then `- <path>` a
//   file), as the agent reads it and the app finds it again.
// - `agent_looks`: the bridge keeps how each of its agents looks (a body shape, a face and
//   a colour as the app numbers them, and whether a coding agent shows its maker's logo),
//   so every device draws an agent the same: `looks.list` gives the looks, `look.set`
//   gives an agent one, and `sessions.activity` says the id and revision of the looks
//   (`looks`), which a device checks to know when to ask (src/looks.ts).
// - `sidebar_order`: the bridge keeps the order the user gave its agents and its folders
//   in the sidebar, so every device lists them the same: `order.list` gives the two
//   lists, `order.set` replaces one or both, and `sessions.activity` says the id and
//   revision of the order (`order`), which a device checks to know when to ask
//   (src/order.ts).
// - `machine_order`: `gateway.ready`'s `machine` carries `id`, which this bridge gave
//   itself once and keeps, and the order keeps a third list, `machines`: the user's Macs
//   by those ids, with when they were arranged (`machines_at`). `order.set` takes it with
//   that moment and keeps it unless it has one arranged later, so the order arranged
//   last is the one every bridge ends up with (src/order.ts).
// - `approval_notes`: the answer to any approval, not only a plan, may carry a `note` with
//   a no (what to do instead). The agent is told it with the no where it takes one (Claude
//   Code, as its reason); otherwise the bridge hands it to the thread as the user's message
//   once the no has gone back: listed as waiting and handed at once to the turn that asked
//   (Codex), so every device shows it there, waiting for that turn to end where the agent
//   takes none in, or opening a turn of its own.
// - `thread_branch`: each thread `threads.changes` lists may carry `branch`, the git branch
//   checked out in its folder as a turn last started or ended there (src/git.ts); absent
//   outside a repository and on a detached HEAD.
// - `subagents`: the subagents and workflows a thread's agent starts are shown and kept
//   while the bridge runs, running or ended: the `subagent.start`, `subagent.progress`
//   and `subagent.complete` events and `subagent.list` carry, besides Hermes's keys, the
//   bridge's (`kind`, `name`, times, `summary`, `result`, `can_stop`, a workflow's
//   `phases` and `agents`), `subagent.stop` stops one by itself, and a thread with one
//   still at work is `running` in `sessions.activity`. Stop on the turn leaves the ones
//   in the background running when the app says so (`keep_background`), and a question
//   one of them asks names it (`subagent`); in a thread a device that keeps such a card
//   after the turn (`client.capabilities` `subagent_requests`) has followed, the turn's
//   end leaves the question open.
// - `turn_messages`: every device following a thread is told each message said in it,
//   whichever device, thread or terminal it came from: `message.start` carries the one
//   that opened the turn (`text` as stored, with its images and files, and `sender`:
//   `user`, `portals` or `desk`), and the new event `message.steered` one handed to the
//   running turn. `prompt.submit` takes `message_id`, the device's own id for the
//   message, which both name, so the device that sent it knows it as its own. The
//   `session.resume` answer has `latest_seq`, the last event it holds, so a device that
//   already followed the thread does not show a message steered in meanwhile twice.
// - `subagents_clear`: the subagents and workflows that have ended leave the line when the
//   next message goes to the agent, from any device (typed, steered in, opening a turn
//   from the list of those waiting, through the fleet, or typed at the desk; not a slash
//   command, nor a turn the agent began by itself): the `subagent.cleared` event names
//   them (`subagent_ids`), and `subagent.list` no longer lists them. One at work stays,
//   and comes back if it is given more to do after it was cleared.
// - `subagent_names`: a subagent's entry may carry `nickname`, what its agent calls it (a
//   Codex sub-agent's, "Darwin"), and `role`, the kind of agent it is (a Codex
//   sub-agent's role, "worker"; a Claude subagent's type, "Explore"), and `parent_id`, the
//   subagent that started it, for a subagent's own subagent. A Codex sub-agent's own
//   sub-agents are on the line of the thread too.
// - `subagent_calls`: the row of a Codex call about its sub-agents other than a spawn
//   (`delegate_task` with `context` `wait`, `closeAgent`, `sendInput`, …) carries
//   `args.agents`, the names of those it was about as the subagents line calls them
//   (nickname, else what each was asked to do), live and in history; a wait that names
//   none is about the thread's sub-agents at work and those that ended since a wait.
// - `status_headline`: the `status.headline` event says what the agent is working on, in
//   its own words (`text`), for the status line in place of "Thinking…" until a newer one
//   comes or the agent says something: Claude Code's summary of a run of its tool calls
//   (`tool_use_summary`, with `claude.toolSummaries` on, the default), `tool_ids` the
//   calls it sums up. The app also takes headlines from what every bridge sends already
//   (a GPT model's bold reasoning titles, Claude Code's to-do in progress).
// - `poll_now`: a device that says so in `client.capabilities` (`poll_now`) is told by
//   `poll.now`, an event with no session, when something its poll reads has moved: the
//   list's revision (a change saved), a thread starting or stopping work or needing an
//   answer, the agents' looks or the sidebar's order. A burst is one event, a moment
//   after its first move (src/gateway/pollNow.ts); the device then polls at once.
// - `resume_replay`: `session.resume` takes `since`, the last event a device applied to the
//   thread, and `replay_epoch`, the epoch it was numbered in. When that is this run's, the
//   thread is not one only read, and the replay log reaches back to it with at most a few
//   hundred events to send, which take no more than the conversation, the answer has
//   `replayed: true` and the events missed (`events`) in place of the conversation
//   (`messages`, `inflight`), in the same step that follows the thread; otherwise it is
//   the whole answer, as for any device. Open questions, `info`, the queue and
//   `latest_seq` are in both.
// - `agent_threads`: a thread an agent started through the fleet is listed with `shared`
//   once a person put it in the sidebar (`thread.mark` takes `shared`), where the app
//   otherwise lists it only under the thread that started it. That thread answers the
//   new one's questions with `thread.answer`, as a device answers them: an approval once,
//   for the session or no, never always, and an allow only from a thread that has the
//   access it gives; every device's card closes with `request.cancel` `resolved`, which
//   then says `by` whom and the `answer`. A thread a linked Mac's thread started keeps
//   that thread's `origin`, never listed, so only it answers there. A started thread at
//   work or waiting keeps the thread that started it `running` in `sessions.activity`,
//   and so on up (since 2026-10-27).
// - `recent_threads`: the threads under Recent in the sidebar are the bridge's to keep for
//   every device: `thread.mark` takes `recent` and a listed thread says it, as for a pin,
//   and archiving clears it as it unpins. Otherwise the bridge only keeps the mark: the
//   devices decide when to set it and when to clear it, and each shows as many as it was
//   asked to (docs/sync-plan.md, since 2026-11-02).
// - `held_elsewhere`: another Mac of the net says with `threads.held` which of this
//   bridge's threads its threads keep at work, for a few minutes unless said again, and
//   `sessions.activity` lists them as running (`inherited`); this bridge says the same to
//   the Macs where its threads' starters are (docs/fleet-plan.md, 2026-10-27).
// - `turn_usage`: `message.complete` says what the turn spent (`turn_usage`): `seconds`,
//   how long it ran (the agent's own time for it where it keeps one, else the bridge's,
//   from the turn's start to its end), and `tokens`, in, out and cached, each counted
//   once, where the agent tells them; and an ended turn's last stored message carries the
//   same, so every device shows it after a relaunch too. Either may be missing.
// - `session_leave`: `session.leave` makes the connection stop following a thread it
//   followed: none of the thread's events or questions go to it any more, and the thread
//   runs on for its other followers. The app sends it for a thread it let go of (at rest,
//   off screen, past the few it keeps), which another device, a terminal or the fleet may
//   set to work; a resume follows it again.
// - `worktrees`: a git worktree is never a folder of its own. `folders.list` lists a folder
//   in one as the folder of its repository's main checkout it matches; each thread
//   `threads.changes` lists whose folder is in one carries `repo`, that folder, kept once
//   the worktree is gone; `folders.add` of a folder in one adds its repository's folder and
//   answers with the folder chosen and `repo`, the one added; and `session.create` and `thread.start` take a
//   folder in a worktree of a folder they would take (src/git.ts `worktreeOf`).
// - `turn_diff`: `message.complete` says what the turn changed (`turn_diff`), and an ended
//   turn's last stored message carries the same, so every device shows it after a relaunch
//   and a restart of the bridge too: `files` (in the order the turn first changed them,
//   each `path` as its diffs name it, `status` `added`, `modified` or `deleted`, `added` and
//   `removed` lines, its unified `diff`, and `cut` when that was cut short or left out),
//   `added` and `removed` in all, and `cut` when any file's was. Worked out by the bridge
//   from the diffs the turn's edits carry (sessions/turnDiff.ts), the agent's own record of
//   them, for every agent; none for a turn that changed no file. At most about 512 KB of
//   diffs a turn. A Claude Code edit the bridge saw live keeps its live diff after a
//   restart (sessions/keptDiffs.ts); one made while it was off has the one its history gives.
// - `file_read`: `file.read` gives a device a file on this Mac to show, for any thread of
//   the bridge's, followed or not: an image a reply names as a Markdown image
//   (`purpose` `image`, known by its bytes), or a file a tool row names, to read
//   (`purpose` `text`), from anywhere on this Mac (src/sessions/fileRead.ts). At most
//   15 MB for an image and 2 MB for
//   text. The answer carries an `etag`, and with `unless` that one, says `unchanged`
//   instead of sending the file again; a file not given is `refused` with why.
// - `session_resync`: a client that opts in with the same capability receives
//   `session.invalidated` when it must replace a thread with a full resume snapshot.
//   Legacy followers reconnect instead. Snapshots may carry inflight.reasoning.
// - `push_watcher`: the push route `DELETE threads/{id}/watcher` with `{device_token}`
//   stops notifying that one device about the thread, where `DELETE threads/{id}` stops
//   notifying every device; `GET status` says so too (`features: ["watcher"]`), for an
//   app that asks before it has connected. An app that finds neither uses the old route.
// - `message_ids`: in the `session.resume` answer, a stored user message and the
//   `inflight` turn carry `message_id`, the id `prompt.submit` gave the message (feature
//   `turn_messages`), for as long as this run of the bridge has kept the session loaded:
//   a device whose send failed without an answer knows from it whether the bridge has
//   the message. A `queued` entry carries it too (`session.resume`, `queue.changed`), so
//   one that waits on the list is known as well. One sent with no id, or stored before,
//   has none.
// - `senders`: who a message sent through the fleet is from, and who started a thread
//   through it, as facts (src/fleet/line.ts, docs/gateway-protocol.md section 11):
//   `from`, beside such a message in the `session.resume` answer (stored messages,
//   `inflight` and `queued`), `message.start`, `message.steered` and `queue.changed`, and in a listed
//   thread's `started_by`: `agent`, `agent_name`, `thread`, `title`, and `machine` and
//   `machine_name` (the Mac's stable id, `gateway.ready`'s `machine.id`, and its name for
//   itself) when it came from another Mac; `{}` is the command line of the thread's own
//   Mac. An app shows these and not the `[Portals: from …]` line, which is the agent's.
//   `thread.send`, `thread.start` and `thread.answer` take `sent_by`, the same facts,
//   from another Mac's bridge, which keeps them with a thread it starts and takes an
//   answer from that Mac's same thread by them.
// - `async_questions`: questions an agent asks without waiting for the answer (Codex's
//   `request_user_input_async`: it goes on working, and takes the person's next message
//   as the answer) are a `clarify` request with `async: true`, in a thread a device that
//   says it keeps such a card after the turn (`client.capabilities` `async_questions`)
//   has followed; elsewhere they stay the reply's text, as before. The card stays open
//   past the turn's end; its answers go to the agent as the person's message (handed to
//   the running turn, else opening one: one answer by itself, several each under its
//   question), marked as the card's with `card_answer` (the row's id) on `message.start`,
//   `message.steered`, a `queued` entry, the stored user message and `inflight`, which the
//   app shows in the row and not as a message of its own; the other devices' cards close
//   with `request.cancel` `resolved` and the `answer` given. A newer such question takes
//   it back (`withdrawn`), a message the person sends the agent answers it
//   (`request.cancel` reason `replied`), and Stop takes it back. The thread keeps a
//   `clarify` tool row of them where they were asked, as for Claude's questions, its args
//   with `async: true`, whose result is `{responses: [], asking: true}` while the card is
//   open, then the answers, null when a message answered them, or `{responses: [],
//   unanswered: true}`. The thread's record keeps how each card settled them
//   (`cardAnswers`), so a thread read back from the agent's history after a restart has
//   the same row and marked message; the last ones asked, unanswered with nothing sent
//   since, are their card again for the first device that keeps such cards and resumes
//   the thread.
// - `background_commands`: a command an agent left running in the background after its
//   turn moved on (Claude Code's `run_in_background`, Codex's background terminals, Droid's
//   background commands) is a `subagent.*` entry of `kind` `command`: `goal` what it
//   runs, `summary` its last line of output, `output` the end of its output so far (at
//   most 8 KB and 200 lines, with `output_truncated` when its start was left out),
//   `can_stop` where its agent can stop it; at most one `subagent.progress` a second for
//   it, of which the replay log keeps the latest only. Running commands' output also comes
//   as `tool.progress` from Codex, Pi and Cursor, as from Droid (no feature: that event is
//   older than the list).
// - `net`: the Macs and devices that pair once and reach every Mac (src/net/net.ts,
//   docs/net-plan.md). Every bridge keeps a copy of the member list, which `net.list`
//   gives (without the tokens' hashes) and `net.sync` copies between the Macs. A member
//   signs in with its token, `Authorization: Bearer`, on the WebSocket's upgrade (no
//   ticket) and on the push routes; a device gets one from `POST /net/join` with a code
//   a member made (`net.invite`). `net.remove` takes a member out on every Mac, closing
//   its connections with 4401; `net.join_with` and `net.leave` move this Mac into another
//   net or out of its own. `gateway.ready`'s `bridge` block and `poll.now` carry `net`,
//   the net's id and the list's revision, so a device asks `net.list` only when it moved.
// - `net_rename`: `net.rename` names a Mac of the net for every Mac and device, from any
//   Mac of it, and a Mac's entry carries `named` and `named_by` once its name was set so:
//   when (a stamp past every name of it the setting Mac had seen) and by which Mac. Of two
//   names the later stamp wins on every Mac and device, whichever copy of the entry does,
//   and the Mac named goes by it (what it passes on, `net.invite`'s link) over `fleet.name`
//   and its Computer Name until it is renamed again (src/net/net.ts, docs/net-plan.md).
// - `net_rename_devices`: `net.rename` names a device of the net too (2026-10-28),
//   kept and merged as a Mac's name is: its entry carries `named` and `named_by`, the later
//   stamp winning everywhere. A device that joins again replaces its entry, its name stamped
//   as a rename made then (docs/plans/2026-10-28-devices.md).

// - `thread_search`: `thread.search` finds words in the user's messages and the agent's
//   replies of every thread the bridge lists, every agent's, without loading them (a
//   loaded thread in memory, any other in its agent's own file), grouped by thread,
//   newest first, with a cursor for more (src/search/, docs/plans/2026-10-26-thread-search.md).
//   Hermes threads are searched only while loaded; the answer counts the others.
// - `file_search`: the `files.search` method ranks the files and folders of a thread's
//   folder, or of a folder new threads may start in, against a fuzzy query, for the menu
//   an app shows when the person types `@` to mention a file (sessions/fileSearch.ts); a
//   file hit has its `size`, and the answer `mention_limit` for an agent that reads a
//   mentioned file in itself (Claude Code), for the note on a file too large for it.
// - `file_mentions`: `prompt.submit` takes `mentions`, the files and folders a message
//   mentions, relative to the thread's folder; those in it are in the text the agent gets
//   as `@path`, and Cursor gets a link to each as well; its answer lists those the agent
//   may not read in (`large_mentions`) (sessions/mentions.ts).
// - `folder_search`: the `folders.search` method ranks every folder under the bridge
//   user's home folder against a fuzzy query, or completes a typed path a level at a time,
//   for choosing where a new thread starts; only folders `folders.add` takes (folderSearch.ts).
// - `lean_deltas`: a client that opts in through client.capabilities takes compact live
//   text/reasoning frames, with the same session id and seq; replay stays canonical.
// - `answer_owner`: `client.capabilities` takes `device`, an id the app made for itself
//   (one for each launch is enough), and `request.cancel` then says `answered_by`, the
//   `device` of the connection whose answer settled the request, when it gave one. An
//   app that answered a card here whose answer the host has not taken yet learns from a
//   `request.cancel` without its own id that another answer won (or the request was
//   taken back), and shows that in place of its own (connect-17); one with its own id
//   (replayed after a reconnect) is its own answer's.
// - `bot_chat`: a Hermes profile keeps one ongoing conversation, the one Hermes Desktop
//   keeps for it too (its session titled "Bot Chat"): `session.create` for the profile
//   gives that thread, made in Hermes only when it has none, whoever asks and however
//   many ask at once. It is listed with `ongoing: true` and the profile's name, is never
//   removed nor renamed, and the profile's other threads leave the list as the bridge
//   starts, kept in Hermes. Its `/compress` (`/compact` too), offered in
//   `commands.catalog`, summarises the conversation as a turn of its own, which says
//   `session.compacted` when Hermes compacted it, else what Hermes said, as a notice.
//   Stop ends that turn at once (Hermes cannot stop a compression, so it finishes it,
//   and a message sent meanwhile waits). What another of Hermes's apps says in it (Hermes
//   Desktop, a terminal) is taken in when Hermes says its sessions changed and as a device
//   resumes it: every device that holds it is told `session.invalidated`.
// - `history_pages`: `session.resume` takes `limit`, a number of turns: the answer's
//   `messages` are only the conversation's last turns, that many, with `history_start`
//   (where they begin in it), `has_earlier` and `replay_base`. `session.history` gives the
//   turns before a message (`before`, an index into the conversation), for a device that
//   took it so in this run (`replay_epoch`) as it was where its replay began
//   (`replay_base`): `messages`, `start` and `has_earlier`, or `moved: true` when that is
//   not the conversation now (a change no event told of), which the device takes again.
//   A replayed answer has none of them: the device has its pages.
// - `update_notice`: `gateway.ready`'s `bridge` block and the `sessions.activity` answer carry
//   `latest`, a later version of portals-host that is out, only while there is one, and
//   `poll.now` tells the devices that ask as it comes or goes. The bridge asks npm's registry
//   for the version tagged latest as it starts and about once a day after, never more often
//   (src/updates.ts; `updates.check` false in config.json: never, and so never `latest`).
//   Nothing updates a bridge by itself: the app says so for the host, with the command to
//   run on its computer, `npx portals-host@latest update`.
// - `model_levels_none`: in `model_levels`, an empty list says the model takes no thinking
//   level at all (Cursor's Auto and Composer, a Droid model without reasoning), and the app
//   offers none for it. Without the feature an empty list reads as any level, as a model
//   left out still does.
// - `git_status`: `git.status` says what is not committed in the repository a thread's
//   folder is in, for the panel beside the chat: its branch, how far it is ahead of and
//   behind the branch it follows, and each file that differs from HEAD with the lines it
//   adds and removes; `git.diff` gives all of it as one diff, file by file. git is run
//   only where it runs without asking to install anything; elsewhere the branch alone
//   (src/sessions/gitStatus.ts).
// - `open_on_host`'s apps come with their icons (`icon`, a PNG in base64).
// - `usage_read`: `usage.read` gives what `/usage` says, as data for the panel: the plan
//   and each window's share used and when it resets, or `available: false` for an agent
//   that cannot say. An agent is asked at most once a minute, whoever asks, a failure
//   standing for that minute too. A window kept from an earlier answer has its own
//   `heard_at` (milliseconds since 1970).
// - `open_on_host`: `host.apps` lists the apps on the host a thread's folder opens in (the
//   Finder, the editors and terminals installed), and `folder.open` opens the thread's
//   folder in one, on the host's own screen (src/openers.ts).
// - `steer_withdrawn`: a message handed to the running turn that a Stop took back before
//   the agent read it (Claude Code: it would have run once the turn had stopped, as a turn
//   of its own) is told with a `status.update` `warn`, as before, carrying `withdrawn`:
//   `{text, message_id?}`, the message as stored and the id its device gave it. The app
//   takes it out of the turn it was shown in, and the device that sent it puts it back in
//   its composer; an app without the feature shows the notice, which quotes the message
//   whole. The conversation no longer has it, after a resume too.

export const bridgeFeatures = [
  "message_fork",
  "mcp_auth",
  "folders",
  "model_levels",
  "push_host",
  "desk_sessions",
  "model_names",
  "compaction",
  "rename",
  "activity",
  "model_default_levels",
  "question_details",
  "modes",
  "push_relay",
  "push_sealed",
  "push_muting",
  "folders_add",
  "machine",
  "fleet",
  "fleet_delta",
  "fleet_delta_positions",
  "fleet_pages",
  "thread_sync",
  "agent_kinds",
  "queue",
  "files",
  "agent_looks",
  "sidebar_order",
  "machine_order",
  "approval_notes",
  "thread_branch",
  "subagents",
  "turn_messages",
  "subagents_clear",
  "subagent_names",
  "subagent_calls",
  "status_headline",
  "poll_now",
  "resume_replay",
  "agent_threads",
  "recent_threads",
  "held_elsewhere",
  "turn_usage",
  "session_leave",
  "worktrees",
  "turn_diff",
  "file_read",
  "session_resync",
  "message_reconciliation",
  "push_watcher",
  "message_ids",
  "senders",
  "async_questions",
  "background_commands",
  "net",
  "net_rename",
  "net_rename_devices",
  "lean_deltas",
  "thread_search",
  "file_search",
  "file_mentions",
  "folder_search",
  "answer_owner",
  "bot_chat",
  "history_pages",
  "tell_starters",
  "update_notice",
  "model_levels_none",
  "git_status",
  "usage_read",
  "open_on_host",
  "steer_withdrawn",
] as const;

export const bridgeProtocol = 1;
