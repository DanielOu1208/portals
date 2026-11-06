# Gateway protocol for portals-bridge

`portals-bridge` is a Mac-side daemon that the Portals app talks to as if it were
`hermes serve`. The app does not change: its `HermesBackend` connects, signs in, resumes
and replays exactly as it does against Hermes. This document is the subset of the Hermes
TUI-gateway protocol that `HermesBackend` uses, written down from the app's code and from
frames captured against Hermes 0.21.5.

Bare file names refer to `Packages/PortalsKit/Sources/HermesBackend/`. Tests are in
`Packages/PortalsKit/Tests/HermesBackendTests/`, captures in its `Fixtures/`. Captured
frames quoted here are trimmed to the keys the app reads.

## 1. Purpose and rule of thumb

The client is the reference, not Hermes. Where Hermes sends more, the bridge leaves it
out. Where this document and Hermes disagree, the app's code wins.

- **Send only keys the app reads.** Every result and payload key below is read somewhere;
  nothing else is needed. Unknown keys are ignored by the app's decoders
  (HermesWire.swift:11-12), but they are dead weight and drift.
- **Types are strict, presence is not.** Typed results go through `JSONDecoder`
  (JSONValue.swift:119-121). A missing optional key is fine; a known key with the wrong
  type (`"seq":"3"`, `"running":"true"`, a number in `models`) fails the whole call.
  Required keys: `profiles[].name`, `session_id` in `session.create` and `session.resume`,
  `providers[].slug` in `model.options` (HermesWire.swift:97-99, 158-160, 218-220, 367-368).
- **Accept params leniently.** The app only sends keys listed in
  `Fixtures/contract-subset.json` (HermesWire.swift:8-10). Hermes rejects an unknown key
  with error 4000; the bridge should ignore it instead.
- **Error messages are shown to the user** as they are (JSONRPCFrame.swift:19-21). Write
  them as sentences.

## 2. Transport and sign-in

`{base}` is the URL the user typed: `http` or `https`, possibly with a path prefix, which
every route keeps (PasswordAuthenticatorTests.swift:181-187). The app picks the sign-in by
whether the host has a user name (Portals/App/HostDirectory.swift:35-41).

### HTTP routes

| Route | Request | Answer the app reads | Status handling |
|---|---|---|---|
| `POST {base}/auth/password-login` | JSON `{"provider":"basic","username":"…","password":"…"}`, `Content-Type` and `Accept: application/json` (PasswordAuthenticator.swift:97-99, 126-133) | Status only. 200 must set the session cookie(s). | 200 signed in; 401 wrong password; 404 no password set up; 429 too many attempts; other: unexpected (PasswordAuthenticator.swift:100-106) |
| `POST {base}/api/auth/ws-ticket` | Body `{}`, session cookies | `{"ticket":"<non-empty string>"}` (PasswordAuthenticator.swift:113-117). Hermes adds `"ttl_seconds":30`, unread. | 200 ticket; 401 or 403: the app signs in again and asks once more, then gives up as "sign-in not accepted" (PasswordAuthenticator.swift:80-90, 118-120); other: unexpected |
| `GET {base}/` (loopback only) | Nothing | An HTML page containing `window.__HERMES_SESSION_TOKEN__="<token>"`, a JSON string literal (HermesAuthenticator.swift:118-123) | Non-200: unexpected. Fetched before every socket and every REST call (HermesAuthenticator.swift:101-114) |
| `GET {base}/api/status` | — | Not called by the app. Useful as a health check: it answers 200. | Optional |
| `POST {base}/net/join` | portals-bridge with feature `net` only: a code and who joins, no sign-in (section 11, docs/pairing-and-relay.md) | The member's token and the net's list | 200 joined; 400 a body it cannot use; 401 a code used, expired or wrong; 409 refused, with a sentence (a Mac joining a Mac set up for itself alone, among others); 429 too many wrong codes |
| Push routes | See section 10 | | |

- Loopback sign-in is what the simulator uses ("This Mac", no user name). REST calls then
  carry `X-Hermes-Session-Token: <token>` (HermesAuthenticator.swift:95-99). Only accept it
  from loopback peers.
- **portals-bridge does not offer loopback sign-in.** Behind `tailscale serve` every
  request reaches it from loopback, so a "loopback only" token would be open to the whole
  tailnet. It has password sign-in only; `?token=` closes with 4401. The simulator signs in
  to it with a user name and password (`PORTALS_HERMES_USER`, `PORTALS_HERMES_PASSWORD`;
  Portals/App/DebugLaunch.swift).
- Password REST calls carry the cookies. On a 401 the app signs in once and repeats the
  request; a 403 is not retried (PasswordAuthenticator.swift:72-78).
- Cookie names and lifetimes are the bridge's choice. The app's HTTP client keeps cookies in
  memory and times out a request after 20 s (PasswordAuthenticator.swift:14-21). When a
  session has expired, answer 401 (ticket route: 401 or 403) and the app signs in again by
  itself. A bridge restart may end every session.
- Tickets: single use, short-lived (Hermes: 30 s). The app mints one right before each
  socket and never reuses one (PasswordAuthenticator.swift:34-37, 65-68;
  PasswordAuthenticatorTests.swift:77-84).
- Retry behaviour: a 401 (wrong password), a 404 on sign-in and missing credentials stop
  the app's reconnect loop until the user acts; a 429 does not, so the app retries every
  10 s at most (HermesBackend.swift:600-611, 71). Size a rate limit for that.

### WebSocket

- URL: `{base}` with `http`→`ws`, `https`→`wss`, plus `/api/ws?ticket=<ticket>` or
  `/api/ws?token=<token>` (HermesAuthenticator.swift:48-63, 85; PasswordAuthenticator.swift:67).
- A member of a portals-bridge net (feature `net`, section 11) opens `/api/ws` with
  `Authorization: Bearer <token>` instead, and no ticket. When the Mac cannot be reached
  directly, a member may come through the relay's tunnel instead (docs/pairing-and-relay.md,
  "The tunnel"): the same messages, each sealed in a binary frame, at most 16 MiB of JSON
  a frame, signed in by the token in its first sealed frame.
- The query parameter is the only credential. The socket is opened on `URLSession.shared`,
  not on the client that holds the cookies, so the upgrade carries no cookie
  (WebSocketTransport.swift:52-59; HermesBackend.swift:72). Do not require `Origin`.
- Text frames, one JSON object each. Binary frames are read as UTF-8
  (WebSocketTransport.swift:81-82). The app accepts at most 64 MiB per frame
  (WebSocketTransport.swift:47-48): keep `session.resume` answers below that.
- Compression: `URLSessionWebSocketTask` offers a bare `permessage-deflate` on every
  socket, and once it is agreed compresses what it sends from about 100 bytes, keeping
  its context. The bridge agrees with `server_no_context_takeover` and compresses each
  frame of 1 KB or more on its own; smaller ones go as they are
  (`bridge/src/http/server.ts`). The bridge's own clients (links between Macs, the
  `portals` command) offer none.
- Close codes (WebSocketTransport.swift:23-26; HermesBackend.swift:605-607):

| Code | Meaning | App reaction |
|---|---|---|
| 4401 | Ticket, token or session not accepted, or a net member removed (feature `net`) | Reconnects with backoff, a fresh ticket each time (signing in again when the ticket route says 401/403) |
| 4403 | Host or Origin refused | Stops reconnecting: a configuration problem |
| anything else, or a drop | | Reconnects after 0.5, 1, 2, 4, 8, then every 10 s, each wait cut to between half of it and the whole (jitter), and at once, the waits starting over, when the device's way onto the network changes (HermesBackend.swift, `keepTrying`, `networkChanged`) |

- The bridge drops a connection, without a close frame (which would wait behind the
  rest), when the device stopped reading: when more than 8 MB waits in its socket besides
  the answers to its own calls and the largest other frame
  (`bridge/src/gateway/connection.ts`), and when it has not answered a protocol ping for
  30 s (`gateway.ts`). An independent 128 MiB ceiling counts all queued bytes,
  including answers: a frame that would exceed it while bytes already wait drops
  only that connection. An empty queue always admits one frame, even a larger direct
  snapshot. This leaves room for concurrent large reconnect answers, but not an
  unlimited unread reply backlog. The ceiling covers direct sockets and the bridge's
  sealed relay leg, not the relay provider's own downstream queue. It is per connection,
  not per member or a process-wide memory budget. The app takes it as any drop and
  catches up by `seq` (section 8).

## 3. Frames

JSON-RPC 2.0 over the one socket, in both directions. Classification is
JSONRPCFrame.swift. An explicitly negotiated `lean_deltas` connection also takes
the separate compact live frames in [section 11](#lean-deltas). PortalsKit expands
them into ordinary gateway events at this boundary; canonical JSON-RPC recognition
keeps its existing precedence.

| Frame | Shape | Rules |
|---|---|---|
| App request | `{"jsonrpc":"2.0","id":"r7","method":"…","params":{…}}` | Ids are `r1`, `r2`, … and start again at `r1` on every connection (JSONRPCPeer.swift:116-117). `params` is always an object. |
| Heartbeat | `{"jsonrpc":"2.0","id":"heartbeat-3","method":"gateway.ping","params":{}}` | See section 4 (JSONRPCPeer.swift:185-190). |
| Bridge response | `{"jsonrpc":"2.0","id":"r7","result":…}` or `{"jsonrpc":"2.0","id":"r7","error":{"code":4001,"message":"…","data":…}}` | No `method` key. `result` may be `null`, but must be present: a frame with neither `result` nor `error` is ignored and the call times out (JSONRPCFrame.swift:100-111). A numeric id echo is accepted (JSONRPCFrame.swift:115-119). |
| Event | `{"jsonrpc":"2.0","method":"event","params":{"type":"…","session_id":"…","seq":12,"payload":{…}}}` | `type` is required or the frame is dropped. `session_id` is the runtime id; leave it out for connection-wide events. `seq` is a whole number. `payload` may be absent (JSONRPCFrame.swift:86-94). |
| Server request | `{"jsonrpc":"2.0","id":"srq-1f2e","method":"approval","params":{"session_id":"…",…}}` | The id **must be a string**; a numeric id makes the frame unrecognizable and it is never answered (JSONRPCFrame.swift:96-98). Use a prefix that cannot meet the app's ids (`srq-`). Never reuse an id within a replay epoch. |
| App answer to a server request | `{"jsonrpc":"2.0","id":"srq-1f2e","result":{…}}` or `{…,"error":{"code":-32601,"message":"Not supported by this client"}}` | Told apart from app requests by having no `method` (JSONRPCPeer.swift:156-168; HermesBackend.swift:583-592). |

- The app handles events and server requests in arrival order, as one stream
  (JSONRPCPeer.swift:24-26). A `request.cancel` must follow its request, never pass it.
- A frame that is not JSON is skipped; the connection stays up (JSONRPCPeer.swift:209-210).
- Responses may come in any order. Events may come before the response that caused them:
  Hermes sends `error` events before answering `prompt.submit`
  (Fixtures/chat-no-provider.jsonl:6-8). The app copes as long as the session is already
  known to it (section 8, atomicity).
- Besides `gateway.ready`, the one connection-wide event is a bridge's `poll.now`
  (feature `poll_now`, section 11): no `session_id` and no `seq`, sent only to a
  connection that asked for it in `client.capabilities`. An app drops any other event
  without a session (section 6), so one from before the feature, which never asks,
  would drop it too.

## 4. Handshake

Every connection, in this order (HermesConnection.swift:25-55):

1. **Bridge sends `gateway.ready` first, within 15 s** of the socket opening
   (HermesConnection.swift:28, 57-77). Anything that arrives before it is thrown away,
   including server requests, which are then never answered.

   | Payload key | Read as | Source |
   |---|---|---|
   | `replay_epoch` | String naming the lifetime of the replay logs (section 8). Missing means "never the same run", so every reattach becomes a snapshot. | HermesWire.swift:52; HermesBackend.swift:142-143 |
   | `heartbeat` | Supported unless absent, `null` or `false`. Send `true`. | HermesWire.swift:53-57 |
   | `bridge` | Section 11. When present, the app records the host as a bridge and reads `features`; Hermes sends none. | HermesWire.swift (`GatewayReady`) |

   ```json
   {"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"replay_epoch":"8a9e048c70014c77aef21efa5a9a90ee","heartbeat":true}}}
   ```
   (Fixtures/handshake-profiles.jsonl:1)

2. **App sends `client.capabilities`** with `{"server_requests":true}`, and to a bridge
   the keys of the features it lists: `subagent_requests` with `subagents`, `poll_now`
   with `poll_now`, `async_questions` with `async_questions`, `device` with `answer_owner` (section 11; HermesConnection.swift, `BridgeWire.ClientCapabilitiesParams`).
   Answer `{"server_requests":["approval","clarify"]}`. From Hermes the app waits for the answer:
   the list is decoded (it must be strings) but only the probe prints it, and an error
   fails the connection (HermesConnection.swift). From a bridge (a `gateway.ready` with
   `bridge`) it does not wait: its next calls follow at once, one round trip sooner. So a
   bridge must take a connection's frames in the order they come and have applied
   `client.capabilities` before it reads the next frame, as portals-bridge does (its
   handler does all it does at once; bridge/src/gateway/connection.ts starts each frame's
   handler as the frame comes). An error answer from a bridge has the app close the
   connection and open another. Send server requests only to connections that declared
   `server_requests: true` (HermesWire.swift:64-65).

3. **Heartbeat.** When `heartbeat` is on, the app sends `gateway.ping` every 15 s and closes
   the socket when nothing at all has arrived for 45 s (JSONRPCPeer.swift:34-35, 173-193).
   Any inbound frame resets that clock (JSONRPCPeer.swift:208). Answer each ping at once
   with any result; Hermes answers `{"ok":true}` (Fixtures/chat-tools.jsonl:31-32). The
   result is not read (JSONRPCPeer.swift:213-214). Behind `tailscale serve` this is the only
   way the app notices a dead host, so always advertise and answer it. When the device's
   way onto the network changes while connected and the change takes away the interface
   the socket went out by (Wi-Fi gone for cellular), the app sends one `gateway.ping` at
   once, closes the socket when nothing at all has arrived 5 s later, and then reconnects
   at once (JSONRPCPeer.swift, `checkAlive`; HermesBackend.swift, `networkChanged`). Any
   frame will do, an error answer too: a host without the heartbeat (a Hermes from before
   it) answers the ping as a method it does not know, and keeps its socket. A change that
   leaves that interface (Wi-Fi joining cellular) sends nothing, so a large answer on its
   way over a slow link is not cut; a socket that died then is the heartbeat's to find,
   and on a host without the heartbeat the system's, which may take minutes to give up on
   it. Nothing more is sent at rest.

4. **The new connection follows no session** until it creates or resumes one
   (HermesBackend.swift:7-18). The app resumes at once the threads it believes are running,
   and the rest when they are next used (HermesBackend.swift:356-368, 436-445). It follows
   one until the connection ends or, on a bridge with `session_leave` (section 11), until
   it leaves it: the app does for a thread it let go of. A thread let go of is not resumed
   by a new connection either.

## 5. Methods

`profile` is the agent's `name` from `profiles.list`. The app sends it on every call that
takes it; treat it as the agent to act for. `session_id` is the **runtime** id, except in
`session.resume`, where it is the **stored** id (section 8). Default timeout is 60 s
(JSONRPCPeer.swift:36).

| Method | Params the app sends (`?` = may be absent) | Result keys the app reads | Timeout | Source |
|---|---|---|---|---|
| `client.capabilities` | `server_requests: true`; to a bridge also `subagent_requests?`, `poll_now?`, `async_questions?`, `device?` (`answer_owner`) (section 11) | `server_requests` [String] (probe only; a bridge's answer is not waited for, section 4) | 60 s | HermesConnection.swift |
| `profiles.list` | `{}` | `profiles[]`: `name` (required), `is_default`, `display_name` (empty means use `name`), `description`, `model`; `kind` from a bridge with `agent_kinds` (section 11); optional `adopt_modes` (`continue`, `fork`, `read`) from a bridge with `desk_sessions`: the app offers Fork thread only when `fork` is listed, not by agent kind; absent means none | 60 s | HermesBackend.swift:209-224; AgentCore/Model.swift:26-47 |
| `session.create` | `profile`, `source:"tui"`, `title?`, `cwd?`, `model?`, `provider?`, `reasoning_effort?` | `session_id` (required), `stored_session_id`, `info.title` | 120 s | HermesBackend.swift:221-242 |
| `session.resume` | `session_id` (stored id), `profile`, `inline_images:false`; to a bridge with `resume_replay` (section 11) also `replay_epoch`, with `since?` and `replay_base?` | `session_id` (required), `running`, `messages`, `inflight`, `open_requests`, `info` (section 8); a bridge's also `latest_seq`, the `seq` of the last event the answer holds (`turn_messages`), `status_line` while a run is going on and its status line is up (the text of the last `thinking.delta` or `status.update` other than a notice (`info`, `warn`, `error`), such as `Compacting the conversation…`: a device that opens the thread whole shows it until the next of them, as one that followed it does; a run's start and end take it down, and so does the agent going on, as on a device that follows: a `message.delta`, `reasoning.delta`, `message.interim` or a `tool.start` other than a `clarify`), `replay_base` for a resume that names this run's epoch, and, for a resume it could replay, `replayed` and `events` in place of `messages` and `inflight` (`resume_replay`) | 120 s | HermesBackend.swift:448-463 |
| `session.events.since` | `session_id`, `last_seen`, `profile` | `events`, `truncated`, `open_requests` | 60 s | HermesBackend.swift:402-430 |
| `prompt.submit` | `session_id`, `text`, `profile` | `status` | 60 s | HermesBackend.swift:289-312 |
| `image.attach_bytes` | `session_id`, `content_base64`, `filename?`, `profile` | `attached`, `message` | 60 s | HermesBackend.swift:292-304 |
| `session.interrupt` | `session_id`, `profile` | `status` | 60 s | HermesBackend.swift:315-323 |
| `model.options` | `profile` | `providers[]`: `slug` (required), `name`, `models` [String], `authenticated`; `model`, `provider` | 60 s | HermesBackend.swift:683-702 |
| `config.get` | `key:"reasoning"`, `profile` | `value` (String) | 60 s | HermesBackend.swift:688-690 |
| `config.set` | `key`, `value`, `session_id`, `profile`, `confirm_expensive_model?:true` | `confirm_required`, `confirm_message`, `deferred`, `warning` | 60 s | HermesBackend.swift:704-734 |
| `commands.catalog` | `profile` | Section 5.3 | 60 s | HermesBackend.swift:617-622 |
| `slash.exec` | `session_id`, `command`, `profile` | Section 5.3 | 120 s | HermesBackend.swift:660-666 |
| `command.dispatch` | `name`, `arg?`, `session_id`, `profile` | Section 5.3 | 120 s | HermesBackend.swift:667-676 |
| `subagent.list` | `session_id`, `profile` | `subagents[]` (same fields as `subagent.*` events) | 20 s | HermesBackend.swift:270-283 |
| `gateway.ping` | `{}` | Nothing | — | JSONRPCPeer.swift:185-190 |

Params are checked in HermesBackendTests.swift:201-226, 407-415, 417-433 and
HermesReconnectTests.swift:142, 279.

### 5.1 What each call means

- **`session.create`** makes a session and makes this connection follow it. `title` and
  `cwd` come from the user; `source` is always `"tui"` and can be ignored. The thread is
  named by `stored_session_id ?? session_id` (HermesBackend.swift:237). The app waits up to
  120 s, for a slow first agent build (HermesBackend.swift:233-234). A model the provider
  cannot serve should fail here with -32602 rather than on the first turn
  (HermesWire.swift:127-129).
- **`prompt.submit`** must answer at once; the turn arrives as events. `status` becomes the
  message's delivery (HermesEventMapper.swift:248-255):

  | `status` | Meaning |
  |---|---|
  | `streaming` (or anything not below) | A turn started for it |
  | `queued` | A turn is running; this runs after it |
  | `steered` | Folded into the running turn |
  | `redirected` | The running turn was cut and this message is answered in the same turn. Hermes sends one `message.complete` for both (Fixtures/chat-redirected.jsonl:13-14). |

  The app marks the thread running after any successful submit (HermesBackend.swift:310).
- **`image.attach_bytes`** queues one image on the session; the next `prompt.submit` takes
  all queued images (HermesWire.swift:436). `filename` gives the type by extension.
  `attached:false` stops the send and shows `message` (HermesBackend.swift:301-303). An
  error (Hermes: 4016 for an unsupported type) is shown as is (HermesBackendTests.swift:435-445).
  portals-bridge keeps each connection's images apart: a `prompt.submit` takes the
  images attached on its own connection, never another device's, and a connection that
  closes lets go of the ones it attached.
- **`session.interrupt`**: `status:"interrupted"` means stopped, anything else means it was
  not (HermesBackend.swift:322). The turn must still end with `message.complete`
  `status:"interrupted"` (Fixtures/chat-interrupt.jsonl, last line). With no turn
  running, portals-bridge takes back the questions the thread has open (one an agent
  put outside any turn, each with `request.cancel` reason `interrupted`) and answers
  `interrupted` when there was one; no `message.complete` follows then. It answers
  `interrupted` too when the agent stops a message that was handed to a turn which has
  ended since (Pi, before it has begun the run it takes such a message for): that run
  then shows as a turn that ends `interrupted` as it begins. An agent that has not taken
  the stop in 20 seconds, or failed to (Hermes out of reach), has its turn ended by
  portals-bridge, with `message.complete` `status:"interrupted"`, and the answer is
  `interrupted`; what the agent still says of that turn is not passed on, and a message
  sent before the agent ends that turn waits on the list (`queue.changed`) until it has.
- **`config.get`** is asked with `key:"reasoning"` only. `value` is a thinking level:
  `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`; anything else reads
  as unknown (AgentCore/ModelSetting.swift:5-9). A failure is ignored
  (HermesBackend.swift:688).
- **`config.set`** has two uses, both for one live session, never the agent's defaults
  (HermesWire.swift:395-396):
  - `key:"model"`, `value:"<model>[ --provider <slug>] --session"`, parsed like Hermes's
    `/model` (HermesBackend.swift:705-709). With `confirm_required:true` the app shows
    `confirm_message` and, on yes, sends the same call with `confirm_expensive_model:true`.
    `deferred:true` means the running turn keeps its model; otherwise a non-empty `warning`
    is shown (HermesBackend.swift:720-724; HermesBackendTests.swift:256-283).
  - `key:"reasoning"`, `value:<level>`. The result is not read but must decode.
- **`model.options`**: providers with `authenticated:false` are hidden; a missing
  `authenticated` counts as signed in (HermesBackend.swift:692). `model` and `provider` are
  the agent's default.
- **`subagent.list`** is sent, unawaited, after every snapshot; a failure is ignored
  (HermesBackend.swift:262, 270-283, 386). Only entries still working are shown
  (HermesBackend.swift:280), except from a bridge with `subagents` (section 11), whose
  ended ones are shown too.

### 5.2 Error codes the app reacts to

| Code | From | Meaning | App reaction |
|---|---|---|---|
| 4001 | `prompt.submit` (and the image attaches before it), `session.interrupt`, `slash.exec`, `command.dispatch`, `config.set` | The runtime id is not loaded any more (unloaded while idle) | Resumes by stored id and repeats the call once; a second failure is shown (HermesBackend.swift:336-350; HermesReconnectTests.swift:530-555) |
| 4009 | `session.resume` | Still settling an interrupt | Retries up to 5 times, 400 ms apart (HermesBackend.swift:458-461) |
| 4011, 4018 | `slash.exec` | Not a terminal command: a skill, or a command that becomes a message | Calls `command.dispatch` (HermesBackend.swift:667-676) |
| any other | anywhere | | Shown to the user. From `session.resume` during a reattach it becomes a warning in the thread and the thread is left detached (HermesBackend.swift:387-397; HermesReconnectTests.swift:369-383) |

A bridge that never unloads sessions never needs 4009. portals-bridge answers 4001
when the connection does not follow the session named (it has not created or resumed it
there), so the app resumes it and repeats the call. It also loads a thread again as a device opens it
(`session.resume`) when the thread was continued here and its agent's own copy went on
elsewhere since it was read, as a Pi at the desk does with its session file, so that it
shows what was said there; only at rest (no turn, card, message waiting or attachment).
Its events are numbered on from before. The connections that followed it follow it no
longer: they hear none of its events until they resume it, and a call on it is answered
4001, which the app takes as above. For a thread it does not know,
`session.resume` answers 4007, as Hermes does ("any other" above). Errors from
`session.events.since` are failures too, not a cue for a snapshot: return
`truncated:true` instead (section 8).

### 5.3 Commands

`commands.catalog` result, read leniently field by field (HermesCommands.swift:29-76):

| Key | Shape | Use |
|---|---|---|
| `categories` | `[{"name":"Session","pairs":[["/undo","Back up N user turns (usage: /undo [N])"],…]}]` | Commands offered, in order. Category `tui` or `exit`: terminal-only (HermesCommands.swift:37). A trailing ` (usage: …)` becomes the usage hint (HermesCommands.swift:97-103). |
| `commands` | `{"/undo":{"desktop":null,"desktop_subcommands":["…"]}}` | `desktop`: `null` offered; `"hidden"` runs but is not offered; `"terminal"`, `"messaging"` or anything else: refused with a reason (HermesCommands.swift:40-46, 86-93). `desktop_subcommands` limits the arguments (HermesCommands.swift:48). |
| `pairs` | All `[key, description]` pairs | Skills are the pairs whose key is in `skills` and not a command (HermesCommands.swift:62-68) |
| `skills` | `{"/arxiv":{"usage":3}}` | Sorted by `usage`, most used first |
| `canon` | `{"/compact":"/compress"}` | Aliases |

The app also hides some commands itself (HermesCommands.swift:15-18). Keys carry their
slash; names are lowercased.

`slash.exec` gets the command line without its slash (`"undo 2"`,
HermesBackend.swift:664). Its result, and `command.dispatch`'s, is read by `type`
(HermesCommands.swift:116-141):

| `type` | Keys read | Outcome |
|---|---|---|
| absent, `exec`, `plugin` | `output`, `warning` | Text shown in the thread (ANSI stripped, common indent removed) |
| `alias` | `target` | The app runs `target` instead, at most 3 hops (HermesBackend.swift:629-635) |
| `skill`, `send` | `message` (required, non-empty), `display`, `notice` | `message` is sent as the user's message, shown as `display` |
| `prefill` | `message`, `notice` | Put in the composer |
| anything else | | An error naming the type |

After `undo`, `compress` or `compact` the app resumes the session and replaces the thread
with the snapshot, because no event reports the rewrite (HermesCommands.swift:23;
HermesBackend.swift:637-655). Not when the answer was `skill` or `send`: nothing has
changed yet, and a bridge's `/compact` reports its compaction as its turn runs
(`session.compacted`, section 11).

How a command ended, as the app shows it: text from `exec` is the command's answer,
marked done; an error from `slash.exec` or `command.dispatch` (an unknown command, one
refused) is shown in its place with its message. A command sent as a message is a turn:
it ends like any other, and one that ends `complete` having said and done nothing shows
"Done". A command the agent runs and refuses ("No messages to compact") should end its
turn with `message.complete` `status:"error"`, `text` the reason and
`error_surface.retryable:false` when asking again would get the same answer.

## 6. Events

Payload keys read and what each becomes (HermesEventMapper.swift:20-87). Every one needs
the runtime `session_id` and a `seq` (rules below).

| `type` | Payload keys read | Becomes | Notes |
|---|---|---|---|
| `message.start` | none (a bridge's: `opened_by`, `text`, `queue_id`, `message_id`, below) | `turnStarted` | Once per turn. Marks the thread running (HermesBackend.swift:546-547). |
| `message.delta` | `text` | `textDelta` | Empty text is dropped |
| `message.interim` | `text`, `already_streamed` | `interimText` | Closes a piece of text written beside tool calls. `already_streamed:true` when it also came as deltas (HermesEventMapper.swift:15-18) |
| `reasoning.delta` | `text` | `reasoningDelta` | The model's reasoning |
| `thinking.delta` | `text` | `status` | A transient status line, not reasoning. `""` clears it. A spinner face followed by one verb ("(◔_◔) pondering...") is dropped as decoration (HermesEventMapper.swift:137-176). Send plain sentences. portals-bridge sends one of its own when a running turn has had no word from the agent for five minutes and no card is open ("No word from Codex for 5 minutes. It may still be working; Stop ends it."), and puts back the line before it with the agent's next word. |
| `status.update` | `kind`, `text` | `warn` → warning notice; `error` → error notice; `loop`, `process` → `announced` row + status; other → status | Leading symbols such as "⚠ " are stripped (HermesEventMapper.swift:54-64, 228-236; HermesHostEvents.swift:90-118) |
| `tool.start` | `tool_id`, `name`, `context`, `args` | `toolStarted` | `tool_id` and `name` required. `name:"clarify"` is skipped: the question is the row (HermesEventMapper.swift:27-30) |
| `tool.complete` | `tool_id`, `name`, `context`, `args`, `result`, `inline_diff`, `duration_s`, `summary` | `toolFinished` | Repeat `name`, `args` and `context`: after a reconnect the app may never have seen the start (HermesReconnectTests.swift:684-693) |
| `request.cancel` | `id`, `reason`; from a bridge with `agent_threads` (section 11), `by` and `answer` for one the thread that started the session answered; with `answer_owner`, `answered_by` (the device whose answer settled it) | `requestClosed` | `resolved` → "Answered elsewhere", `timeout` → "Timed out", `interrupt`/`interrupted` → "Stopped before it was answered", other → "Withdrawn" (HermesEventMapper.swift:238-245) |
| `error` | `message` | Error notice | |
| `session.title` | `title` | `titleChanged` | |
| `session.usage` | `usage.context_used`, `usage.context_max` | `contextChanged` | Both whole numbers above 0, else ignored (HermesEventMapper.swift:110-115). Hermes sends it every few seconds of a turn. |
| `message.complete` | `status`, `text`, `error`, `error_surface.retryable`, `recoverable`, `response_previewed`, `usage`; from a bridge with `turn_usage`, `turn_usage`, and with `turn_diff`, `turn_diff` (section 11); from a bridge since 2026-10-26, `turn` | `contextChanged` (from `usage`), then `turnListed` (from `turn`), then `turnFinished`, then `turnSpent` (from `turn_usage`), then `turnChanged` (from `turn_diff`) | See below; `turn` with the thread list's `turn` |
| `subagent.start`, `.tool`, `.thinking`, `.progress`, `.complete` | `subagent_id` (required), `goal`, `tool_name` or `last_tool`, `tool_preview`, `status`; from a bridge with `subagents`, its keys too (section 11) | `subagent` | `status` `running`/`queued`/absent: working; `completed`: finished; anything else, or `.complete` without `completed`: failed (HermesEventMapper.swift:92-106) |

`message.complete` (HermesEventMapper.swift:117-132):

| `status` | Outcome |
|---|---|
| `error` | Failed. Message: `text`, else `error`, else "The request failed." Retryable: `error_surface.retryable`, else `recoverable`, else true. |
| `interrupted` | Interrupted |
| anything else (Hermes: `complete`) | Completed. `text` is the whole reply; it is shown only if no text streamed after the last tool, and `response_previewed:true` suppresses it (AgentCore/ThreadState.swift:367-381) |

```json
{"type":"message.complete","session_id":"458dacdd","seq":9,"payload":{"status":"complete","text":"Hello from Hermes!","usage":{"context_used":12414,"context_max":1048576}}}
```
(Fixtures/chat-text-complete.jsonl, last line)

Not read, so not needed: `session.info`, `sessions.changed`, `session.reclaimed`,
`tool.generating`, `reasoning.available` (CapturedFrameTests.swift:211-214), and any other
type (HermesEventMapper.swift:84-85).

### Rules for `session_id` and `seq`

- `session_id` is the runtime id the app got from `session.create` or `session.resume`.
  Events with no `session_id`, `""`, or an id the app does not map to a thread are dropped
  (HermesBackend.swift:515, 523-526; HermesBackendTests.swift:507-522), but for a
  bridge's `poll.now`, which has none on purpose and is read only from a bridge that lists
  `poll_now` (section 11; PollNowWireTests.swift).
- `seq` numbers events per runtime session: whole numbers, increasing, starting at 1. The
  same event has the same `seq` live on every connection and in `session.events.since`.
  Gaps are fine (Hermes skips numbers).
- The app drops any event whose `seq` is not above the last one it applied
  (HermesBackend.swift:534-539). So **never reuse or lower a `seq` within one replay epoch
  and runtime id**: the app would silently drop everything until the numbers pass the old
  ones.
- An event without `seq` is applied unconditionally and never deduplicated. Only use that
  for events that are never replayed. Give every session event a `seq`.
- A turn opened with `message.start` ends with exactly one `message.complete`, whatever
  happens. Until it sees one, the app treats the thread as running and resumes it eagerly
  on every reconnect (HermesBackend.swift:544-547, 356-362).
- A turn the bridge starts by itself (background work done, a scheduled wake) can be
  announced with `status.update` kind `process` or `loop`, then `message.start`
  (Fixtures/chat-delegation.jsonl:51-52). Use those kinds only for that: they add a row.

## 7. Server requests

Only `approval` and `clarify`. The app finds the thread by `params.session_id`, the
runtime id (HermesBackend.swift:804-809).

### `approval`

Params read (HermesEventMapper.swift:183-189; AgentCore/Requests.swift:14-25):

| Key | Use |
|---|---|
| `command` | What will run. Redact secrets first. |
| `description` | Why it needs asking ("delete in root path"); empty is dropped |
| `choices` | Any of `once`, `session`, `always`, `deny`, in display order. Unknown strings are dropped; an empty list shows `once` and `deny`. |
| `subagent` | Feature `subagents`: the id of the subagent that asks, which may run on after the turn. The app keeps such a card when the turn ends and in a snapshot with nothing running, until it is answered or withdrawn, and says so with `client.capabilities` `subagent_requests` (section 11) |

Answer: `{"choice":"once"|"session"|"always"|"deny"}`. Dismissing the card sends `deny`,
whether or not `deny` was offered (HermesEventMapper.swift:209-212;
HermesBackendTests.swift:747-757). To a bridge that lists `approval_notes` (or
`modes`, for a plan), a `deny` may carry `"note"`, what to do instead (section 11).

```json
{"jsonrpc":"2.0","id":"srq-cf5bad148214","method":"approval","params":{"session_id":"f8be60e2","command":"rm -rf /nonexistent-aeriportal-approval-test …","description":"delete in root path","choices":["once","session","always","deny"]}}
{"jsonrpc":"2.0","id":"srq-cf5bad148214","result":{"choice":"deny"}}
```
(Fixtures/chat-approval-denied.jsonl:23-24)

### `clarify`

Params read: `questions[]` with `qid` and `question` (both required strings), `choices`
[String], `multi_select` (HermesEventMapper.swift:190-200), and `subagent` as for an
`approval`. From a bridge that lists `async_questions`, `async: true` marks questions the
agent asked without waiting (Codex's): the app keeps the card past the turn's end, until
it is answered or withdrawn, and shows the answer in the questions' row, not as a message
(`card_answer`, section 11). A clarify with no usable
question is cancelled at once (HermesBackend.swift:571).

Answer: `{"answers":{"<qid>":"<text>"|null,…}}` with every `qid` present; `null` means
skipped (HermesEventMapper.swift:213-219). A multi-select answer is one string, the picks
joined with `", "` (Portals/Chat/RequestCard.swift:214-224). Cancel is `{}`, with no
`answers` key (HermesEventMapper.swift:220-222; HermesBackendTests.swift:759-781).

```json
{"jsonrpc":"2.0","id":"srq-b050e16811aa","method":"clarify","params":{"session_id":"8ed7b082","questions":[{"qid":"q0","question":"Which language should I use?","choices":["Python (Recommended)","Swift"],"multi_select":false}]}}
{"jsonrpc":"2.0","id":"srq-b050e16811aa","result":{"answers":{"q0":"Swift"}}}
```
(Fixtures/chat-clarify.jsonl:57-58)

### Anything else

`sudo`, `secret`, `vault.code`, `vault.unlock_prompt`, `display.install.sudo` get
`{"value":""}` and a warning in the thread; any other method gets error -32601
(HermesBackend.swift:573-578; HermesBackendTests.swift:804-822). The bridge should not send
them.

### Routing rules

- **Send a request only on connections that created or resumed its session**, after the
  `session.create`/`session.resume` answer on that connection, and only if they declared
  `server_requests`. The app answers a request it cannot place without asking anyone:
  approval `deny`, clarify cancel (HermesBackend.swift:557-571; HermesBackendTests.swift:824-827).
  A broadcast lets a bystander deny the agent.
- A request outlives its connection. Keep it until answered, withdrawn or the turn ends,
  and list it in `open_requests` of `session.resume` and `session.events.since` as
  `{"id","method","params"}` with the original id and params (HermesWire.swift:233-235).
  Do not send the frame again on a new connection; the app re-shows it from the list
  (Fixtures/reattach-approval.jsonl:6-8). A repeat is harmless: the thread keeps one card
  per id (AgentCore/ThreadState.swift:322-327).
- Accept the answer by id on any connection that follows the session. The app answers on
  whichever connection is current, possibly not the one that carried the request
  (HermesBackend.swift:325-331; HermesReconnectTests.swift:431-433).
- The first answer wins. Then send `request.cancel` `{"id","reason":"resolved"}` to the
  other followers. Use `timeout` or `interrupted` when the bridge withdraws a request
  itself (for example on `session.interrupt`).
- A bridge with `agent_threads` (section 11) also takes the answer of the thread that
  started the session through the fleet (`thread.answer`), which follows nothing: its
  `request.cancel` goes to every follower and says who answered and how,
  `{"id","reason":"resolved","by":"Claude Code","answer":{"choice":"once"}}`.
- portals-bridge keeps `request.cancel` in the replay log with its `seq`, like any
  event, but does not send it live to the connection that answered: that one has closed
  its card, and skipping a `seq` is fine. It also keeps the recorded fixtures replayable:
  `RecordedServer` delivers every recorded event at once, and a cancel delivered before
  the test's own answer would make `respond` fail as an unknown request.
- An answer sent while the app was offline never arrived; the app shows the card again
  after reconnecting and the user answers again (HermesReconnectTests.swift:387-438).

## 8. Sessions, ids and replay

### Ids

| Id | Comes from | Used for |
|---|---|---|
| Stored id (`stored_session_id`) | `session.create` | The thread's name in the app, forever (HermesBackend.swift:237). `session.resume`'s `session_id`. The push thread id. |
| Runtime id (`session_id`) | `session.create`, `session.resume` | Every other call, every event, every server request (HermesWire.swift:159-162, 219-222) |

- A bridge that never reloads sessions may use one string for both.
- Stored ids must match `^[A-Za-z0-9_.:-]{1,200}$`. Push registration rejects the whole
  request if any thread id does not (section 10).
- `session.resume` must accept a stored id for as long as the thread exists, including
  after the bridge moved the conversation to a new stored id (Hermes follows compression
  lineage; HermesWire.swift:198-199).
- Keep the runtime id stable while the session is loaded. `session.resume` within the same
  epoch must return the same runtime id; a new one forces a full snapshot
  (HermesBackend.swift:379).

### `session.resume` result

| Key | Read as | Source |
|---|---|---|
| `session_id` | The runtime id from now on. Events under the old one are dropped. | HermesBackend.swift:466-474 |
| `running` | A turn is in progress. Absent means false. | HermesHistoryMapper.swift:120 |
| `messages` | The stored conversation, oldest first (below) | HermesHistoryMapper.swift:25-86 |
| `inflight` | `{"user","assistant","reasoning"?,"display_kind"?,"display_metadata"?}`; read only when `running`. A bridge's optional `reasoning` is the current uncommitted thought text, a string, not the whole turn's reasoning. | HermesHistoryMapper.swift:122-150 |
| `open_requests` | Requests waiting, `[{"id","method","params"}]`; **honoured only when `running` is true** | HermesHistoryMapper.swift:152-160; HermesBackend.swift:482-489 |
| `info` | `title`, `model`, `provider`, `reasoning_effort` (a level from section 5.1), `usage.context_used`, `usage.context_max` | HermesHistoryMapper.swift:156-174 |

Hermes also sends `session_key` and `status`; the app decodes and ignores them. With
`inline_images:false`, leave image data out of the messages (HermesWire.swift:202).

### Stored messages

With feature `message_fork`, a completed turn's opening user message may carry
`checkpoint: {id, can_fork, can_edit}`. Its opaque native id is separate from the
device's `message_id`. A steered message has no checkpoint of its own. The live
`message.checkpoint` event carries `{checkpoint}` for the current turn's opener,
before `message.complete`. Missing checkpoints and false capabilities offer no action.

`session.fork` takes `{session_id, checkpoint_id, before}` on a followed, writable,
idle thread. `before: false` copies through that completed turn; `before: true`
copies the conversation before it, ready for an edited prompt. A complete native
run includes messages steered into it; these cannot be branched individually.
The result is
`{session_id, stored_session_id, info}`, and the new thread is followed on this
connection. It keeps the source's model, thinking level and approval mode. The
source conversation stays intact. Both threads use the same folder and its current
files; forking does not restore older file contents. Clients send this call only to
hosts advertising `message_fork`. Unsupported agents, ambiguous native boundaries,
active work and stale checkpoint ids are refused.

With feature `turn_file_undo`, a checkpoint may also carry `can_undo_files: true`.
This is offered only for the latest successfully completed Claude run with native
file backups. Existing sessions without backups and copied fork histories do not
gain them retroactively. Preview requires stable Claude Code 2.1.318 or newer.
A live query proves this with its own version report. For a newly resumed idle
query, which reports no version before a turn, the host verifies the exact native
executable and launches that query from its resolved path, checking its identity
again before rewind calls. Launcher scripts receive no such fallback. An explicit
unknown or older query report overrides any launch proof and refuses rewind.

`session.files.preview` takes `{session_id, checkpoint_id}` on a followed writable
thread and returns `{preview_id, files, insertions?, deletions?, expires_at}`. The
files are absolute host paths, and `expires_at` is Unix seconds. It is read-only.
The client shows every listed file, explains that current tracked edits will be
overwritten while conversation history stays, and obtains explicit destructive
confirmation. It then sends `session.files.undo` with
`{session_id, preview_id, confirmed: true}` on the same connection within one minute.
The preview is single-use, including when revalidation or native restoration fails.
If files changed during revalidation before any restore was attempted, the host
may return `-32602` with optional `data: {reason: "files_changed"}`. The client may
fetch one updated preview, show that the files changed, and require confirmation
again. This reason never permits an automatic restore; absent or other error data
must not be treated as proof that files were untouched.

The host checks the native preview again and compares file contents and identity
with the reviewed state before restoring. Files outside the thread's folder,
symlinks, hardlinks, special files, more than 100 files, individual files over
16 MiB, or combined files over 64 MiB are refused. Known active threads with
overlapping folders must finish first; new messages into those folders are refused until
the file action ends. Other tools outside Portals must be stopped by the person.
Only native tracked changes are restored; shell edits and untracked files may remain.

The result is `{restored, skipped_links}`. `restored: true` means the native restore
reported success without skipped links and its postflight preview explicitly
reported no remaining tracked differences. A false result or a lost/error response
may follow partial changes: the client asks the person to inspect the folder and
never automatically retries. Once attempted, the checkpoint loses undo eligibility.
The host invalidates the changed capability after replying, so other devices refresh
their history; legacy followers reconnect as for other session invalidations.

Each message has `role` and `timestamp` (Unix seconds, may be fractional; a missing one
takes the previous message's). Other roles are ignored. Every `user` message starts a turn;
messages before the first one make a turn of their own; turns with nothing to show are
dropped (HermesHistoryMapper.swift:29-45, 85).

| Role | Keys read | Source |
|---|---|---|
| `user` | `text`; `display_kind` and `display_metadata.display_text` for messages the host wrote (table below). Images sent with it are `@image:<path>` lines after the text; the app shows the file name. | HermesHistoryMapper.swift:89-114 |
| `assistant` | `display_content` else `text` (the reply); `display_reasoning` else `reasoning`; `display_commentary` [String] (text beside tool calls); `display_kind:"failed_turn"` (the turn failed, `text` is why); `display_metadata.interrupted:true` (cut short) | HermesHistoryMapper.swift:47-71 |
| `tool` | `name` (required), `args` (object), `context`, `content` (**the result as a JSON string**, not an object; plain text is kept as text), `tool_call_id`, `display_metadata.tool_result_metadata.inline_diff` | HermesHistoryMapper.swift:176-208 |

- Tool rows come only from `tool` messages. Put `name` and `args` on the tool message
  itself; the app does not read `tool_calls` on assistant messages.
- A `clarify` tool message is shown as the question: `args.questions[].question`, and the
  answer from `content` `{"responses":[{"user_response":"Swift"}]}`. No `content` shows
  "Answered"; empty responses show "Skipped" (HermesHistoryMapper.swift:182-194).
- Approvals leave no record of their own. A denied command with no `content` reads as a
  success with no output (Fixtures/resume-denied.jsonl). Store the blocked result
  (`{"status":"blocked","user_summary":"You denied this command — it did not run."}`) to
  show it truthfully.

```json
{"role":"user","text":"Create hello.txt, then change hi to hello.","timestamp":1791179467.82}
{"role":"tool","name":"patch","tool_call_id":"call_2a25…","timestamp":1791179481.63,"context":"/tmp/aeriportal-cwd/...","args":{"path":"/tmp/aeriportal-cwd/hello.txt","old_string":"hi","new_string":"hello"},"content":"{\"success\": true, \"diff\": \"--- a//tmp/aeriportal-cwd/hello.txt\\n+++ b//tmp/aeriportal-cwd/hello.txt\\n@@ -1 +1 @@\\n-hi\\n+hello\\n\"}"}
{"role":"assistant","text":"The file now says hello.","timestamp":1791179490.1}
```
(after Fixtures/resume-tools.jsonl)

**Messages in the user's place that are not the user's** (HermesHostEvents.swift:23-71).
Anything the bridge itself writes into the conversation as `role:"user"` needs a
`display_kind`, or it shows as the user speaking:

| `display_kind` | Shown as |
|---|---|
| absent, `skill_invocation` | The user's message, unless the text is one of Hermes's own (below) |
| `steer` | The user's message, marked as sent mid-run |
| `hidden` | Nothing; only the agent's reply shows |
| `process_complete`, `async_delegation_complete` | One line: `display_metadata.display_text`, else "Background process finished" / "Background agents finished" |
| `auto_continue`, `model_switch`, `personality_switch` | A fixed line |
| `internal_notification` | One line read from the text |
| any other | "Automatic step (<kind>)" |

Untagged text that starts with `[System:`, `[System note:`, `[Background process <id>
heartbeat #<n> `, a `[/loop wakeup #<n>…]` header, or Hermes's "STILL IN PROGRESS"
compaction note is hidden or rewritten (HermesHostEvents.swift:54-75). Do not let a real
user message start that way.

### The turn in progress

When `running` is true (HermesHistoryMapper.swift:122-150):

- If the last stored turn was opened by the same thing as `inflight.user` (compared
  without time), that turn is reopened; otherwise a new turn starts with `inflight.user`.
  Store the user's message as soon as `prompt.submit` accepts it, and make
  `inflight.user` exactly that stored `text`, or the turn appears twice.
- `inflight.assistant` is appended once, as one block of text, after everything stored for
  the turn. Make it the text streamed since the turn's last stored message, not the whole
  turn's text.

### `session.events.since`

Params: `session_id` (runtime), `last_seen` (highest `seq` the app applied). Result:

| Key | Use | Source |
|---|---|---|
| `events` | Missed events, oldest first, each exactly the `params` of the live frame: `{"type","session_id","seq","payload"}`. Entries at or below `last_seen` are skipped by the app. | JSONRPCFrame.swift:42-53; HermesBackend.swift:414-416 |
| `truncated` | `true` when the log no longer reaches back to `last_seen + 1`. The app then shows the `session.resume` snapshot instead. | HermesBackend.swift:411 |
| `open_requests` | What is waiting now. **Always send it, `[]` when empty**: if it is absent the app reuses the list from `session.resume`, which may be stale. Open requests it held that are not listed are closed as "Answered elsewhere"; listed ones are shown again. | HermesBackend.swift:418-428 |

`latest_seq` is decoded and not read by the app. Send it anyway: the reconnect tests find
this answer in a capture by it (HermesReconnectTests.swift, `Recording`).

```json
{"id":"r3","method":"session.events.since","params":{"session_id":"effdbbc6","last_seen":473}}
{"id":"r3","result":{"events":[],"truncated":false,"open_requests":[{"id":"srq-faf23295555f","method":"approval","params":{"session_id":"effdbbc6","command":"rm -rf …","description":"delete in root path","choices":["once","session","always","deny"]}}]}}
```
(Fixtures/reattach-approval.jsonl:6-7)

### What the app does after a reconnect

For each thread it believes is running (HermesBackend.swift:356-398):

1. `session.resume` by stored id. Everything arriving for the session meanwhile is held
   (HermesBackend.swift:514-521).
2. If the epoch is the same as before, the runtime id is unchanged and it had applied at
   least one event: `session.events.since`, then apply the missed events in order, each
   once (HermesReconnectTests.swift:270-301, 590-636).
3. Otherwise, or if `truncated`: replace the thread with a snapshot built from the resume
   answer; `seq` tracking starts over (HermesBackend.swift:476;
   HermesReconnectTests.swift:303-367).
4. Held frames are then applied, deduplicated by `seq` (HermesBackend.swift:502-510).

Threads not running get `.detached` and are resumed when next opened or used
(HermesReconnectTests.swift:504-528). A failure in step 1 or 2 leaves a warning and a
detached thread.

From a bridge with `resume_replay` (section 11) steps 1 and 2 are one call: the
`session.resume` carries `since`, the last event the thread applied (or the answer's
`latest_seq` when it applied none since), `replay_epoch` and `replay_base`, where the
replay of the conversation the thread took whole begins (from that answer), when that
number is from the epoch of this connection and the thread's stream has brought the whole
thread up to it (`HermesBackend.replayPoint`; not after a resume for a call the thread was
not told of, nor for a thread made with `session.create` or taken up from the desk until a
resume answers it whole: its session may hold a conversation from before, which no event
tells). Every other resume to such a bridge carries
`replay_epoch` alone, so that its answer says where the replay of what it gives begins.
An answer with `replayed:true` goes through the path that applies replayed events, each
once, then the open requests as in step 2, the queue and `info` (`ThreadEvent.caughtUp`); a
whole answer becomes the snapshot of step 3, with no `session.events.since` after it. A
thread at rest that followed its stream until `.detached` is caught up the same way when
it is next opened (`HermesBackend.catchUp`, `ThreadController`): the thread on screen as
the app comes back to the front gets the events it missed, where it was opened whole. The
app sends none of the three keys to Hermes, nor to a bridge without the feature.

| Situation | Bridge sends | App does |
|---|---|---|
| Same process, session still loaded | Same `replay_epoch`, same runtime id, `seq` continuing | Replay |
| Bridge restarted (replay logs gone) | New `replay_epoch` | Snapshot |
| Session reloaded under a new runtime id | New runtime id; `seq` may restart at 1 | Snapshot; events for the old id dropped |
| Session loaded again under the same runtime id (portals-bridge: a thread only read and then continued, or removed and taken up again) | `seq` numbering on past the old session's; `truncated:true` for a `last_seen` the old session gave out | Snapshot |
| Conversation changed with no event (portals-bridge: a thread only read, read again for a resume or `thread.read`; a running Codex turn taken for a `/compact` found to be opened by a message) | `seq` numbering on past one number held back; `truncated:true` for a `last_seen` from before; with `resume_replay`, the whole answer to a resume whose `replay_base` is from before, however many events after the change the device applied | Snapshot |
| Log trimmed past `last_seen` | `truncated:true` | Snapshot |

### What must be atomic

1. **`session.create`**: make the connection a follower and send the answer before any
   event or request for the new session. Until the answer arrives the app cannot map the
   runtime id, and drops what comes for it.
2. **`session.resume`**: take the snapshot (`messages`, `inflight`, `running`,
   `open_requests`) and subscribe the connection in one step, so every later event goes
   out live and every earlier one is in the snapshot. Send the answer before any live
   event of that session on that connection; a new runtime id is unknown to the app until
   then (HermesBackend.swift:466-474). An answer with the events missed in place of the
   conversation (`resume_replay`, section 11) is taken in the same step: its last event is
   the one before the first that goes out live.
3. **`session.events.since`**: build `events` and `open_requests` from one consistent
   state. The connection is already live, so overlap with live frames is fine; a gap is
   not.
4. **Answering a request**: record the answer and send `request.cancel` to the other
   followers together; ignore later answers to the same id.

Older app limitation: when the app resumes a session its connection already follows
(opening a running thread), it resets `seq` tracking after the snapshot and then applies
the frames that arrived during the call (HermesBackend.swift:244-264, 476, 502-510).
Deltas already counted in `inflight.assistant` can then show twice. The bridge cannot
prevent this; answering `session.resume` quickly keeps the window small.

For portals-bridge, snapshot capture, following the session, and sending the response
run synchronously in the `Atomic` section (`gateway/methods.ts`, `connection.ts`):
there is no `await` between capture and socket send. A client rebuilding from this
snapshot drops held numbered events through `latest_seq`. Requests have no `seq`:
the client records each frame's local receipt index and the snapshot response's
receipt index. Held request frames received before that response are covered by its
`open_requests`; those received afterward are new. This boundary does not claim an
atomic upstream snapshot from Hermes.

**Deferred Hermes producer boundary (2026-10-20):** the bridge adapter holds live
frames behind ordered upstream replay and retries failed recovery, but still does
not apply an authoritative snapshot when Hermes replay is truncated. A transcript
can remain stale or a completed turn stay Running in that case. The installed
legacy Hermes producer and latest stable v0.22.2 (2026-10-15) do not pair a consistent
display snapshot with its event cursor. Repeating snapshots or observing idle
state cannot establish that boundary. The newer owner protocol on Hermes main is
not a drop-in replacement. That redesign is deferred, not fixed by `session_resync`:
the feature converges bridge-owned corrections, such as Droid text retractions,
and does not advertise atomic recovery from upstream Hermes. See
[bug-hunt scope](plans/2026-10-20-bug-hunt.md).

## 9. Tool display

Names the app styles (Portals/Chat/WorkRows.swift:263-302). Any other name is shown
with underscores turned to spaces and a capital first letter; names starting with
`browser` get a browser icon. A bridge for other agents should map their tools onto these
names.

| `name` | Title | `name` | Title |
|---|---|---|---|
| `terminal`, `process` | Terminal | `web_extract` | Read page |
| `read_file` | Read | `execute_code` | Run code |
| `write_file` | Write | `delegate_task` | Delegate (a Codex call about its sub-agents other than a spawn: one line naming them, `subagent_calls`) |
| `patch` | Edit | `todo` | To-do |
| `search_files` | Search | `memory` | Memory |
| `web_search` | Web search | `vision_analyze` | Look |
| | | `image_generate` | Draw |

How a row is built, the same for live events and history (HermesToolDisplay.swift):

| Part | First match wins | Lines |
|---|---|---|
| Label | `args.command` (first line) → file name of `args.path` or `args.file_path` → first non-empty of `args.query`, `pattern`, `url`, `prompt`, `name`, `question` → `context` unless it starts with `/`. Cut to 120 characters. | 48-65 |
| Input | `args.command` → `args.content` → nothing when `args` only has `path`, `file_path`, `offset`, `limit`, `old_string`, `new_string` → `args` as pretty JSON | 67-80 |
| Failed | `result.error` present, non-null and non-empty; or `result.success == false`; or `result.exit_code` non-zero; or `result.status` is `blocked`, `error` or `failed` | 84-90 |
| Output | `result.user_summary` → `result` if it is a string → first non-empty of `output`, `content`, `stdout`, `text`, plus `error` and `approval` → "Exit code N" (nothing for 0) → payload `summary` → nothing when there is a diff → `result` as pretty JSON | 92-118 |
| Diff | `result.diff` (plain unified diff) → `inline_diff` (ANSI codes stripped, the "review diff" heading dropped, `a/x → b/x` turned into `---`/`+++`) | 120-142 |
| Opens at | A file tool's Open File (`file_read`): the first line its diff changed → for `read_file`, `args.offset` when past 1 (a line counted from 1) → the top | HostFiles.swift `fileLocation`, HermesToolDisplay.swift `startLine` |
| Duration | `duration_s` (seconds) | 40 |

Input, output and diff are cut at 20 000 characters (HermesToolDisplay.swift:15).

Shapes that make good rows:

| Tool | `args` | `result` |
|---|---|---|
| `terminal` | `{"command"}` | `{"output","exit_code"}`; denied: `{"status":"blocked","error":"…","user_summary":"You denied this command — it did not run."}` |
| `read_file` | `{"path","offset"?,"limit"?}` | `{"content"}` |
| `write_file` | `{"path","content"}` | `{"diff"}` (a new file as an all-added diff) |
| `patch` | `{"path","old_string","new_string"}` | `{"success":true,"diff"}` |
| search and web tools | `{"query"}` or `{"pattern"}` or `{"url"}` | `{"output"}` or `{"content"}` |
| `todo` | `{"todos":[{"content","status","activeForm"?}]}` (Claude Code's TodoWrite; its task tools TaskCreate and TaskUpdate as the bridge maps them, each item with its `id` too; Codex's plan; Cursor's; OpenCode 2's `todowrite`; Hermes's `todo_list` since Hermes 0.22.0, which the bridge passes on as `todo` with the whole list, as it does `process_manage` as `process`), or `{"items":[{"text","status"}]}` (Hermes before 0.22.0, Droid), or Droid's numbered lines (`"1. [completed] Read"`); the whole list each time, `status` `pending`, `in_progress` (Codex's own `inProgress` too) or `completed` | `{"output"}`. The app makes the checklist and the running turn's to-do section from the list (`HermesToolDisplay.todoPlan`), and `activeForm`, the item in progress worded as it runs, a headline (`status_headline`) |

```json
{"type":"tool.complete","session_id":"88d17ced","seq":24,"payload":{"tool_id":"call_e8f3e228de0d43edb30cfa023b4b3bdd","name":"patch","context":"/tmp/aeriportal-cwd/...","args":{"path":"/tmp/aeriportal-cwd/hello.txt","old_string":"hi","new_string":"hello"},"duration_s":0.12,"result":{"success":true,"diff":"--- a//tmp/aeriportal-cwd/hello.txt\n+++ b//tmp/aeriportal-cwd/hello.txt\n@@ -1 +1 @@\n-hi\n+hello\n"}}}
```
(Fixtures/chat-tools.jsonl:37)

## 10. Push routes

The app calls these on the same server and with the same sign-in as section 2
(HermesBackend.swift:741-781). Today they are served by the `aeriportal-push` Hermes
plugin (`hermes-plugin/aeriportal-push/dashboard/plugin_api.py`); the bridge serves the
same routes for its own threads.

| Route | Body | Answer |
|---|---|---|
| `PUT {base}/api/plugins/aeriportal-push/registration` | Below | Any 2xx; body ignored. The plugin answers `{"devices":n,"threads":n,"apns_configured":bool}`. |
| `DELETE {base}/api/plugins/aeriportal-push/threads/{id}` | None. `{id}` is the stored id, percent-encoded (HermesBackend.swift:761-764) | Any 2xx |
| `DELETE {base}/api/plugins/aeriportal-push/threads/{id}/watcher` | `{"device_token":"<hex>"}` | Any 2xx. Stops notifying that one device about the thread; the other devices that registered it keep their notifications (a thread left with no watcher is removed, never turned into a broadcast). Served by a bridge that lists `push_watcher` and by a plugin whose status lists `watcher` |
| `GET {base}/api/plugins/aeriportal-push/status` | — | Same summary, and `"features":["watcher"]` from a bridge or plugin that serves the route above. The app asks it once a connection before removing a thread from a host that lists no features (Hermes, or one not connected to yet) |

When a thread is removed, the app stops this device's notifications about it with the
`/watcher` route where the host has it (`push_watcher`, or `watcher` in the status), and
otherwise with the older `DELETE threads/{id}`, which stops every device's: an older bridge
refuses the `/watcher` route (422) and an older plugin does not know it (404). A host
that has the route and fails it is never asked the older way.

404 tells the app the plugin is missing; any other non-2xx is an error. Both are only
logged (HermesBackend.swift, `pushPlugin`; Portals/App/HostModel.swift, `registerForPush`).

```json
{"device":{"token":"<hex>","environment":"sandbox","bundle_id":"com.danielou.portals"},
 "threads":[{"id":"20261005_000000_abc123","agent":"karina","agent_name":"Karina","title":"Fix the build"}]}
```
(HermesBackend.swift:743-757; PasswordAuthenticatorTests.swift:160-179)

A host that lists `push_host` in `gateway.ready` (section 11) also gets a top-level
`"host"`: the id the app gave that host. One that lists `push_relay` and `push_sealed`
also gets `device.relay_token` and `device.key` (section 11; docs/pairing-and-relay.md).
Hermes is never sent any of them; its plugin's model would drop them.

- Sent on connecting, when the device token arrives, and when a thread is added or renamed
  (HostModel.swift, `registerForPush`); `DELETE` when a thread is deleted, and for each of
  a host's threads when the host is removed from the app (HostModel.swift, `delete` and
  `shutDownForRemoval`).
- Registration only adds or updates. A thread is watched by the devices that registered it
  (core.py:177-215).
- A bridge that lists `thread_sync` (section 11) also forgets a thread's registration by
  itself when the thread is taken off its list (`thread.delete`), as the `DELETE` route
  does, so no device is notified about it any more. The file is written only when it
  lists the thread. When it cannot be read or written then, the bridge forgets the
  thread all the same (no notification about it goes out, also once the file is back),
  leaves a file it cannot read as it is, and the file loses the thread at the next write
  that succeeds. One still in the file when the bridge stops (it stopped between the two
  writes, or no write succeeded before it did) is forgotten when the bridge starts while
  the thread is off the list, and when the thread is taken up again, before the device
  taking it up registers it. Only one whose thread was taken up again before that stop
  is kept.
- Validation (plugin_api.py:40-55; core.py:87-89). A failure rejects the whole request
  (FastAPI answers 422):

| Field | Rule |
|---|---|
| `device.token` | Hex, 32–200 characters; a bridge keeps it in lower case (since 2026-10-26), so either case names the same device |
| `device.bundle_id` | `^[A-Za-z0-9.-]+$`, 1–200 characters; it is the APNs topic |
| `device.environment` | `production`, anything else means sandbox |
| `threads[].id` | `^[A-Za-z0-9_.:-]+$`, 1–200 characters; at most 2000 threads |
| `agent`, `agent_name`, `title` | Strings, default `""` |

What to notify about (hermes-plugin/aeriportal-push/__init__.py:58-87; core.py:437-475;
the bridge's port in bridge/src/push/notifier.ts): an
approval put to the user (not one an automatic reviewer settles), a clarify question, a
turn that finished (with its reply), a turn that failed. Never for an interrupted turn. The
same approval or question text for a thread is sent once per 60 s.

APNs payload (core.py:346-370):

```json
{"aps":{"alert":{"title":"Karina","subtitle":"Fix the build","body":"Wants to run: rm -rf build"},
        "sound":"default","thread-id":"20261005_000000_abc123","mutable-content":1},
 "aeriportal":{"thread":"20261005_000000_abc123","kind":"approval","agent":"karina"}}
```

| Field | Rule |
|---|---|
| `alert.title` | `agent_name`, else `agent`, else "Agent" |
| `alert.subtitle` | Thread title, one line, at most 80 characters; left out when empty |
| `alert.body` | One line, at most 150 characters: `approval` "Wants to run: …" or "Needs your approval"; `question` the first question or "Has a question for you"; `finished` the reply or "Finished"; `failed` "Stopped with an error: …" or "Stopped with an error". Redact secrets first. |
| `aeriportal.thread` | The stored id the app registered. Tapping opens it; it is not shown while that thread is on screen (Portals/Notifications/PushCoordinator.swift:61-62) |
| `aeriportal.agent` | The profile name. With `mutable-content:1`, the notification extension puts that agent's avatar on it (PortalsNotifications/NotificationService.swift:64-68) |
| `aeriportal.kind` | `approval`, `question`, `finished`, `failed` |
| `aeriportal.host` | portals-bridge only (`push_host`, section 11): the `host` the device registered with, left out when it gave none. The app opens the thread on that host and looks for the agent's avatar under it first; without it, it looks across hosts |

To a device that gave a key (`push_sealed`), the bridge sends the alert's words sealed
under `aeriportal.sealed` and `"alert":{"title":"Portals","body":"New activity"}` in the
open, kept under 4 KB by shortening the body. A bridge without an APNs key sends through
the Portals relay (`push_relay`) instead of to Apple.

Headers (core.py:296-314): `apns-push-type: alert`, `apns-priority: 10`,
`apns-expiration` one hour ahead, `apns-topic` = `bundle_id`,
`apns-collapse-id: <thread id>-<kind>` (at most 64 characters). Sandbox or production host
by `environment`. A 410 or `BadDeviceToken`, `Unregistered` or `DeviceTokenNotForTopic`
drops the device.

## 11. Extensions reserved for the bridge

### Lean deltas

`lean_deltas` is an experimental, opt-in client feature. A client first checks that
`gateway.ready.payload.bridge.features` contains `lean_deltas`, then sends
`client.capabilities` with `lean_deltas:true` alongside its other capability keys.
The reply adds `lean_deltas:true`. Only after that reply does the connection switch
its live text/reasoning frames. If the server does not advertise the feature or the
reply does not acknowledge it, the client must keep accepting the ordinary frames.
An older bridge ignores the unknown capability and returns no acknowledgement.

These are a **separate gateway frame type, not JSON-RPC notifications**:

```json
{"d":["<session_id>",41,"This "]}
{"t":["<session_id>",42,"Checking the result."]}
```

Each is a JSON object with exactly one key, `d` for `message.delta` or `t` for
`reasoning.delta`. Its value is exactly `[session_id, seq, text]`: the full runtime
session id, the canonical integer event sequence, and the string to append (including
any Unicode, whitespace or empty string). `t` does **not** mean `thinking.delta`.
There are no `jsonrpc`, `id`, `method`, `params`, `result` or `error` keys. Dispatch
these two shapes separately at the frame boundary, without changing canonical JSON-RPC
recognition. Send them only on a connection that negotiated the feature; never infer
a session from a prior frame. JSON-looking text inside the tuple is data, not another frame.

The compact form is equivalent to
`{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"…","seq":41,"payload":{"text":"This "}}}`.
Every other event, server request, answer and connection-wide event keeps its existing
JSON-RPC shape. A delta whose payload has an additional key also keeps that full shape,
so clients must accept both forms even after opting in. Frame order is unchanged: no
batching, alias mapping or extra binding event is involved. Deltas of different sessions,
tool events and approval requests may interleave as before.

The event log is unchanged. `session.events.since` and replayed `session.resume`
answers always contain **canonical event objects**, never compact tuples. Reconnect
renegotiates the capability on the new connection; its resume answer precedes new live
frames. Expand tuples to canonical events, then apply the existing per-session `seq`
deduplication rules across replay and live traffic. A snapshot/replay-base change still
requires the same full snapshot as before. The relay tunnel seals each gateway frame
unchanged, so these exact JSON strings travel through it without another envelope.

Another `client.capabilities` call with `lean_deltas:false`, null, or omitted disables
the feature after its reply, which has the ordinary result without `lean_deltas`.
Frames already queued before that reply still use the previous mode. Capability
changes affect this connection only. Older clients and bridge-to-bridge callers do not
opt in; their event frames remain byte-identical.

PortalsKit sends the opt-in only to an advertising bridge. `InboundFrame.parse` requires
a singleton object with a three-element tuple, a nonempty string session id, a positive
integral sequence number in its supported integer range, and a string text. It expands
valid tuples to existing `GatewayEvent` values before the unchanged event mapper and
transcript receive them. Unknown frame types are ignored with a payload-free diagnostic.
A malformed known compact frame closes the peer immediately, before a later frame can
advance the session's sequence number. Existing reconnect/resume recovers from the last
valid sequence number using canonical replay. A process-memory per-host fallback disables
the opt-in for the rest of the app session, including backend recreation and route changes;
nothing is persisted. Older bridge and Hermes capability parameters are unchanged.

The bridge's production deflate policy is unchanged: `threshold:1024` with
`serverNoContextTakeover:true`. Small deltas are uncompressed even on a connection
that negotiated permessage-deflate. Negotiation and transport compression are
independent features.

### Feature negotiation

The app reads the feature list and uses `folders`, `model_levels`, `push_host`,
`desk_sessions`, `model_names`, `compaction`, `rename`, `activity`,
`model_default_levels`, `question_details`, `modes`, `push_relay`, `push_sealed`, `push_muting`,
`folders_add`, `machine`, `agent_kinds`, `queue`, `files`, `agent_looks`, `sidebar_order`, `machine_order`, `approval_notes`, `thread_branch`, `subagents`, `subagents_clear`, `subagent_names`, `subagent_calls`, `status_headline`, `poll_now`, `resume_replay`, `agent_threads`, `recent_threads`, `turn_usage`, `session_leave`, `worktrees`, `turn_diff`, `file_read`, `session_resync`, `push_watcher`, `message_ids`, `senders`, `thread_search`, `file_search`, `file_mentions`, `folder_search`, `net_rename`, `net_rename_devices`, `update_notice` and `thread_sync`, `git_status`, `usage_read`, `open_on_host`, `steer_withdrawn`, `disk_space`, `subagent_read`, `agent_programs`, `usage_history`, `usage_telemetry`,
which makes the bridge's threads the list every device shows (docs/sync-plan.md).
The bridge also offers `fleet`, which the app does not use: it is for clients that
manage threads as a whole (docs/fleet-plan.md); `held_elsewhere`, which the net's Macs
speak to each other (below); and `net` (docs/net-plan.md), whose
methods the app calls since N2 (`NetWire.swift`: `net.list`, `net.invite`, `net.remove`,
`net.join_with`, in the subset's `bridge.methods`), and which joins the subset's feature
list once bridge/test/contract.test.ts no longer counts it among those the app does not use.

- The bridge advertises what it offers in `gateway.ready`:
  `"bridge":{"protocol":1,"version":"0.1.0","features":["folders","model_levels","push_host","desk_sessions","model_names","compaction","rename","activity","model_default_levels","question_details","modes","push_relay","push_sealed","folders_add","machine","fleet","thread_sync","agent_kinds","queue","files","agent_looks","sidebar_order","machine_order","approval_notes","thread_branch","subagents","subagents_clear","subagent_names","subagent_calls","poll_now","resume_replay","agent_threads","recent_threads","turn_usage","session_leave","worktrees","turn_diff","file_read","session_resync","push_watcher","message_ids","senders","thread_search","git_status","usage_read","open_on_host"],"machine":{"hostname":"mbp.local","home":"/Users/dev","id":"7d2a41c09be36f58","os":"macos"}}`
  (portals-bridge, `bridge/src/gateway/features.ts`). The app reads the block
  (HermesWire.swift, `GatewayReady`; `HermesBackend.hostFeatures`). `version` is the
  bridge's own (its package.json), which the app shows in Settings, About; a bridge from
  before it says none. A bridge with `update_notice` adds `latest` while a later
  portals-host is out, and one with `disk_space` adds `disk`, the free space on its disk,
  once it has read it (below).
- All are opt-in. The app sends a bridge-only key or method only to a host that lists its
  feature, and never to Hermes, which rejects keys it does not know (BridgeWire.swift,
  HermesBackend+Bridge.swift). The keys are in the `bridge` part of
  `Fixtures/contract-subset.json`, which `scripts/check-contract.sh` checks against a
  contract listing `x-bridge-features` (`bridge/contract.json`) and skips for Hermes's.
- Result keys of an extension (`model_levels`, `model_names`, `thread_list`, `looks`, `latest`, `disk`, a profile's `kind`) may be sent to any client:
  the app's decoders ignore keys they do not read, and it reads these only from a host
  that lists the feature. The same goes for an extension's events and stored messages
  (`compaction`): an app reads them only from such a host, and one that does not know
  them skips them (sections 6 and 8).
- Nothing here changes the meaning of a method, event or key in sections 2–10, except
  that a bridge offering `folders` refuses a `session.create` `cwd` that is not one it
  lists, that a thread taken up with `session.adopt` mode `read` refuses
  `prompt.submit`, `image.attach_bytes` and `config.set`, that a bridge offering
  `thread_sync` gives a thread taken off its list back with `session.adopt` also for an
  agent with no desk sessions, and that such a bridge forgets a removed thread's push
  registration by itself (section 10; all below).

| Name | Kind | Shape |
|---|---|---|
| `folders` | Feature: method `folders.list` | Params `{profile}`. Result `{"general":{"path":"/Users/dev/coding_projects","name":"General"},"folders":[{"path":"/Users/dev/coding_projects/aerirc","name":"aerirc","last_used":1791324000},…]}`. `path` is the folder's real path, `name` its last component, `last_used` Unix seconds (absent when unknown). General is never in `folders`; `folders` is newest first, at most 30 and the added ones (`"added":true`, from a bridge with `folders_add`). With this feature `session.create` takes only General (also when `cwd` is absent) or a `cwd` on the current list, and answers -32602 with a sentence otherwise (with `worktrees`, also a folder in a git worktree of one); `info.cwd` is the real path the thread runs in |
| `folders_add` | Feature: methods `folders.add`, `folders.remove`; key `added` in `folders.list` | `folders.add`: params `{path}` (required), a folder the user chose on the bridge's Mac. Result: the folder as `folders.list` gives it, `{"path":"/Users/dev/coding_projects/notes","name":"notes","last_used":1791324000,"added":true}` with its real path and the moment it was added, or `{"path":…,"name":"General"}` for the General folder. The bridge keeps it (`state/folders.json`): it is on the list from then on, marked `"added":true`, newest when added and still listed once 30 newer folders are ahead of it, and `session.create` takes it as `cwd`. The app shows an added folder as a project with no thread in it yet (`Folder.isAdded`, `SidebarProject.isAdded`). `folders.remove`: params `{path}` (required), result `{}`; the folder is no longer added, so it is listed only while it is among the 30 the agents worked in lately; a folder that was never added is left as it is. A folder that does not exist, or that is never offered (`/`, the home folder, a hidden or temporary folder, the bridge's own, one `folders.hide` names), answers -32602 with a sentence for the user. The app sends it only to a host that lists the feature (`HermesBackend.addFolder`, `FolderError.refused`) |
| `machine` | Feature: key in `gateway.ready`'s `bridge` block | `"machine":{"hostname":"mbp.local","home":"/Users/dev","os":"macos"}`: the Mac's host name (`gethostname`, read as the connection opens: it changes with the network), the home folder of the user the bridge runs as, and the system it runs on, `"macos"` or `"linux"` (docs/linux-plan.md; a bridge from before says none, and is a Mac's). An app on a Mac whose own two are the same takes the bridge to be on that Mac, and may then offer the Mac's folder dialog for `folders.add` (`Platform.isThisMac`). It is a convenience, not a proof: the bridge checks every folder itself. Read only from a host that lists the feature |
| `model_levels` | Feature: key in the `model.options` result | `"model_levels":{"<model>":["low","medium","high"],…}`: the thinking levels each model takes, as section 5.1 level names, weakest first. A model left out takes any level. Read leniently: an unknown level or an entry that is not a list costs only itself |
| `model_levels_none` | Feature: how an empty list in `model_levels` reads | `"model_levels":{"auto":[]}`: the model takes no thinking level, and none is offered for it (Cursor's Auto and Composer, a Droid model without reasoning). Without the feature an empty list reads as any level, as a model left out does |
| `push_host` | Feature: key in the push registration and payload | Which host sent the notification, for an app with several hosts. portals-bridge accepts an optional top-level `host` string (at most 200 characters) in the registration body and stores it with the device, to echo back as `aeriportal.host`; the plugin's model ignores the extra key. The app sends it only to a host that lists `push_host` (HermesBackend.swift, `register`) |
| `push_relay` | Feature: key in the push registration | `device.relay_token`: what the Portals relay calls this device (docs/pairing-and-relay.md), from `POST /v1/devices`; at most 1000 of `A-Z a-z 0-9 . _ -`. A bridge without an APNs key of its own sends through the relay with it (`push.relay`); a registration without one keeps the token given before. A 410 from the relay forgets the device. The app sends it only to a host that lists `push_relay` |
| `push_sealed` | Feature: key in the push registration and payload | `device.key`: 32 random bytes, base64, made by the app for this host and kept in the Keychain group it shares with its notification extension. Notifications to that device carry `aeriportal.sealed` (the alert's `{title, subtitle, body}` as JSON, AES-256-GCM, base64 of nonce + ciphertext + tag) and show `{"title":"Portals","body":"New activity"}` in the open; the extension opens the seal with the key for `aeriportal.host`. Kept like `relay_token` when a registration leaves it out. The app sends it only to a host that lists `push_sealed` |
| `push_muting` | Feature: key in the push registration | `device.muted`: the kinds of notification the device wants none of, a list of `approval`, `question`, `finished` and `failed` (the app's Settings, Notifications: "When an agent needs you" is the first two, "When an agent is done" the last two). The bridge sends that device no notification of those kinds; the device's other kinds, and other devices, as before. Stored sorted, each once; kept like `relay_token` when a registration leaves it out, and an empty list mutes none. Anything else in it is refused with 422. The app sends it only to a host that lists `push_muting` |
| `desk_sessions` | Feature: methods `desk.list` and `session.adopt` | Sessions an agent has on the host that were started there, in a terminal (desk sessions), and taking one up as a thread. Shapes below |
| `model_names` | Feature: key in the `model.options` result | `"model_names":{"default":"Opus 5.5","opus":"Opus 5.5","sonnet":"Sonnet 5.5",…}`: what to call models whose ids are not names, as the app shows them in place of the id (in the list, the composer's chip and what it says about a change). A model left out goes by its id. It may name models `providers[].models` leaves out, which a thread can still be on and `session.create` and `config.set` still take (Claude Code's `opus`, listed as its `default` when both run the same model). With names, the app marks the agent's own model (`model`) as its default in the list; `/status` says "Opus 5.5 (default)". Read leniently: an entry that is not a non-empty string costs only itself |
| `compaction` | Feature: event `session.compacted` and stored message role `compaction` | Where the agent summarised the conversation to free its context. Shapes below |
| `model_default_levels` | Feature: key in the `model.options` result | `"model_default_levels":{"default":"xhigh","sonnet":"medium",…}`: the thinking level each model runs at when a thread chooses none, as section 5.1 level names. Claude Code's differs by model (a model's own `effortLevel` in the settings, else Claude Code's default for it); the bridge asks a running Claude Code for each at its startup check. A model left out runs at the agent's level (`config.get` `reasoning`). The app shows it in the composer's chip for a thread that chose no level, and a level chosen for a thread stays with it when its model changes. Read leniently: an entry that is not a known level costs only itself |
| `modes` | Feature: `info.mode`, event `session.mode`, method `session.set_mode`, keys of an `approval` and its answer, key `modes` in `model.options` | How much a coding agent's thread asks before acting, as `/mode` sets it: `full`, `edits`, `ask`, `plan` or `default` (the agent's own settings). A thread's `info` has `mode`, and `mode_default` for what `default` comes to when known; `session.mode` `{mode, mode_default?}` is sent when it changes (`/mode`, `session.set_mode`, or an agent leaving plan mode for an approved plan); `session.set_mode` `{session_id, mode, profile}` changes it and answers `{mode, mode_default?}` (-32602 for an unknown mode, an agent without modes, or a mode the agent has none for, with a sentence for the user: Cursor has no `full` or `edits`). `model.options` has `"modes":{"default":"full"}` for an agent whose threads take a mode, `{}` when what its settings come to is not known yet. An agent whose modes are not the five lists its own as `mode_options`, `[{"id":"ask","label":"Ask","description":"…"},…]` in the order to offer them, in `profiles.list`, `model.options`, a thread's `info`, `session.mode` and `session.set_mode`'s answer (Droid's six, with `medium`; Claude Code's six, the five and `medium` for its auto mode; Cursor's three, `ask`, `plan` and `default`); the app offers those alone, by those labels, and `/mode` takes those alone; without it, the five. An `approval` that is an agent's plan (Claude's ExitPlanMode, Codex's plan mode, Cursor's plan) has `"plan":true` and `"starts_in"`: the mode the thread had before plan mode, which approving the plan returns to (Claude is told to leave plan mode for it, not for asking). Its answer may carry `"note"`: with `deny`, what to change, which Claude is told ("Keep planning, and change this: …"). For Codex, `plan` is Codex's own plan mode (`collaborationMode`, with the approval policy and sandbox of the mode before it), in which Codex may ask questions (`clarify`) and ends its turn with a plan: the bridge puts the plan as this card while the app's turn goes on. Approving it runs the next turn of Codex's in its default mode, told "Implement the plan." as Codex's own app tells it; a `deny` with a `note` sends the note to Codex in plan mode; either way in the same turn of the app's (one `message.start`, one `message.complete`). A `deny` without one ends the turn and the thread stays in plan mode; a stop while the card is open (or right behind its answer) ends it `interrupted`, a turn begun at the desk meanwhile closes the card (`request.cancel`) and ends the turn, and a message sent meanwhile waits for the turn to end. Pi uses these same mode fields and `clarify` question cards: Ask gates `bash`, `write` and `edit`; Accept edits gates `bash`; Plan permits only `read`, `grep`, `find` and `ls`; Default and Full access run without asking. Pi mode changes wait for the next turn. Other tools in Ask/Accept edits and Pi subagents are outside its extension gate; it is not a security boundary. Pi has no plan approval card: change modes to carry out its plan. The app shows the mode as an icon in the composer, a menu to change it, and a plan as a card of its own |
| `approval_notes` | Feature: key `note` in the answer to any `approval` | `{"choice":"deny","note":"Use printf, not echo."}`: what the user wants instead, given with a no to any approval and not only to a plan (`modes`). Ignored with any other choice, and when blank. The agent is told it: Claude Code with the no itself, as its reason (`Denied from Portals. The user wants this instead: …`); an agent that takes no reason with a no (Codex declines and goes on) gets it as the user's message once the no has gone back: listed as waiting with `queue.changed` and at once handed to the turn that asked (the next `queue.changed` names it `steered`, so every device shows it in that turn), else, where the agent takes none in, waiting for that turn to end like any message waiting; once no turn runs, opening a turn of its own with `message.start` `{"opened_by":"portals","text":"…"}`. A no to a Codex sub-agent's question (one with `subagent`) is the sub-agent's: its note is steered into the sub-agent's own turn after the no, never into the thread's, and is lost with a `notice` when that turn is over. The app offers a field for it on every approval card only for a host that lists the feature (`ApprovalRequest.takesNote`); a plain Deny stays one tap |
| `thread_branch` | Feature: key `branch` of a thread in the `threads.changes` result | `"branch":"main"`: the git branch checked out in the thread's folder (or the repository it is in, a worktree's too) as a turn last started or ended there, read from git's own files (`bridge/src/git.ts`); absent outside a repository, on a detached HEAD, and before the thread's first turn on a bridge that lists the feature. A change of branch moves the thread's revision like any key the list shows, without moving its time. `/status` names the branch checked out now (`Branch: main`, or `Branch: none, at commit 4f2c9a1`), and has no such line outside a repository. The app keeps it with the thread (`ThreadRecord.branch`) and shows it at the top of the thread's menu in the sidebar, and reads it only from a host that lists the feature |
| `question_details` | Feature: keys of a `clarify` question | `"header":"Auth method"` (a word or two naming the question) and `"descriptions":{"Passkeys":"No passwords; Face ID",…}` (what each choice means, by choice), when the agent gives them: Claude Code's AskUserQuestion has both, as does Codex's request_user_input. The app shows the heading over the question and each description under its choice. Read leniently: a description that is not text costs only itself |
| `activity` | Feature: method `sessions.activity` | Params `{}`; result `{"sessions":[{"session_id":"…","state":"running"},{"session_id":"…","state":"waiting"}]}`: the bridge's threads at work now, whether this connection follows them or not. `waiting` when an approval or a question is open, else `running` while a turn runs; threads not listed are idle. A bridge with `agent_threads` also lists as `running`, with `"inherited":true`, each of its threads one of those was started from (`started_by.thread`), and that one's starter, and so on up, while it is not listed for itself: a started thread at work, or waiting for an answer, keeps the thread that started it running after that one's turn (since 2026-10-27; an app from before ignores the key and shows the starter under Running as any thread at work). Such a thread may be one not loaded in the bridge. `inherited` tells a device that no turn of the thread's own ended when it leaves the list (its turn's end was told when it came), and that the thread's own chat, which knows of no thread it started, does not say all of its state. A command left running in the background keeps neither its thread nor its starter running, and a thread started from another Mac's thread does not reach that Mac's. A `running` thread with no turn of its own, running for its subagents or workflows or `inherited`, says `"turn":false` (since 2026-10-27): its turn's end was told when it came, and it leaving the list ends no turn, which a device would otherwise take as a turn that ended out of sight, unseen. Only threads loaded in the bridge can be either for themselves (a Claude thread runs only in a process the bridge started; at startup the bridge follows every Codex thread Codex still runs). The app asks on connecting and every few seconds while its sidebar is out, for Needs you and Running. Read leniently: an unknown state costs only its entry. A bridge with `thread_sync` adds `thread_list`, its list's id and revision (below), and one with `agent_looks` adds `looks`, the same for its agents' looks; one with `update_notice` adds `latest` while a later portals-host is out; one with `disk_space` adds `disk`, the free space on its disk |
| `rename` | Feature: method `session.rename` | Params `{session_id, title, profile}`; result `{}`. Gives a thread a title of the user's, which the agent keeps as its own name for the session (Claude Code's custom title, as `/rename` sets it; Codex's thread name), so a terminal shows it too. Runs of spaces become one; an empty title or one over 200 characters is -32602, as is a thread taken up only to read. It takes any of the bridge's threads, whether this connection follows it or not (4007 for one it does not know), so the app can rename from its list of threads. The thread's followers get `session.title` with it. A Claude Code thread with no message yet takes it when its first message starts Claude |
| `fleet` | Feature: methods `threads.list`, `thread.read`, `thread.send`, `thread.wait`, `thread.start`, `thread.stop` and `machines.list`; key `machine` in `folders.list` | The bridge's threads as a whole, and those of the Macs it is linked to: every one listed with what it is doing, and one read, sent to, waited for, started or stopped, whether this connection follows it or not. Shapes below |
| `fleet_delta` | Feature: method `threads.delta` | Opt-in local-only bridge-to-bridge fleet refreshes, with a restart-safe cursor, changed rows, removals, a complete live-state overlay and a registry insertion-order digest. Legacy list and device-sync shapes are unchanged. Shapes below |
| `fleet_delta_positions` | Feature: `positions` in `threads.delta` | Absolute registry positions parallel to changed summaries; preserves stable ordering after removal/readoption without another RPC. New callers require this capability; older callers can ignore the added field |
| `fleet_pages` | Feature: method `threads.page` | Frozen local-only bootstrap pages after a full-fetch timeout. Complete staged bases stay private until a fresh delta seals their current rows, order and active overlay. No app paging fields |
| `thread_sync` | Feature: methods `threads.changes`, `thread.mark` and `thread.delete`; key `thread_list` in the `sessions.activity` result; threads taken off the list in `desk.list` and `session.adopt` | The bridge's own threads as the list every device shows, with their pins, archive and unseen marks, a preview line and who started a thread, what changed since a revision of that list, and taking a thread off it. Shapes below |
| `agent_kinds` | Feature: key `kind` of each profile in the `profiles.list` result | `"kind":"claude"`: which agent runs it. portals-bridge's are `claude`, `codex`, `pi`, `cursor`, `droid`, `opencode`, `fake` (its scripted test agent) and `hermes` for every Hermes profile it offers (and `aeri`, its own agent named `portals-aeri`, until Aeri was taken out on 2026-10-21). The app draws a maker's logo by it (`CodingAgentLogo.logo`): Claude's, OpenAI's, Pi's, Cursor's or Factory's for the first five, none for any other kind, one it does not know included. It does not go by `name` there, because a Hermes profile keeps its own name unless another of the bridge's agents has it, and so is called `pi` or `cursor` on a bridge that runs no Pi or no Cursor. From a bridge that does not list the feature, and for a profile without a `kind` or with one that is not a string, the app goes by `name` as it did (`claude`, `codex`, `pi`, `cursor`) |
| `queue` | Feature: key `when_busy` of `prompt.submit` and `queue_id` in its result; event `queue.changed`; keys `queued` and `can_steer` in the `session.resume` result; key `queue_id` of `message.start`; methods `prompt.queue.remove` and `prompt.queue.steer` | What a message sent while a turn runs does, and the messages waiting for that turn to end, the same for every device. Shapes below |
| `files` | Feature: method `file.attach_bytes` | A file of any kind for the next message, saved in the thread's folder and named in the message by its path. Shapes below |
| `agent_looks` | Feature: methods `looks.list` and `look.set`; key `looks` in the `sessions.activity` result | How each of the bridge's agents looks, kept by the bridge so every device draws it the same. Shapes below |
| `sidebar_order` | Feature: methods `order.list` and `order.set`; key `order` in the `sessions.activity` result | The order the user gave the bridge's agents and folders in the sidebar, kept by the bridge so every device lists them the same. Shapes below |
| `machine_order` | Feature: key `id` in `gateway.ready`'s `bridge.machine`; keys `machines` and `machines_at` in what `order.list` and `order.set` answer, and as params of `order.set` | The order the user gave their Macs, a copy of which every bridge keeps, and the id each bridge gives itself to be named by in it. Shapes below, with `sidebar_order` |
| `subagents` | Feature: keys of the `subagent.*` events and `subagent.list` entries; method `subagent.stop`; param `keep_background` of `session.interrupt`; param `subagent_requests` of `client.capabilities`; key `subagent` of an `approval` or `clarify`; a thread with work running in `sessions.activity` | The subagents and workflows a thread's agent starts, running or ended, kept while the bridge runs, and Stop on one by itself. Shapes below |
| `turn_messages` | Feature: keys `text`, `sender` and `message_id` of `message.start`; event `message.steered`; param `message_id` of `prompt.submit` | Every message said in a thread, told to every device that follows it, whichever device, thread or terminal it came from. Before it, a turn started on one device showed on another without its message until the thread was opened again. A turn's `message.start` carries the message that opened it: `{"text":"Fix the login\n@image:photo.png","sender":"user","message_id":"4F1C…"}`, `text` as the stored message has it (section 8: the words, the files block of `files`, a line `@image:<name>` an image), `sender` `user` (sent with `prompt.submit`, or a note given with a no, `approval_notes`), `portals` (through the fleet: `thread.send`, `portals send`, with its `[Portals: from …]` line) or `desk` (typed in a terminal that has the session open), `message_id` the id the device that sent it gave it in `prompt.submit` (at most 100 characters; a longer one is left out), and `queue_id` too when it waited (`queue`). One through the fleet still has `"opened_by":"portals"`, which an app without the feature reads; a note's turn has it as well, for the same app. A turn opened by nothing said (one the agent began by itself, or a steered message the agent turned down said again in a turn of its own, which shows where it was steered) has no `text`. A message handed to the running turn with `prompt.submit` (its answer `steered`) is told as `message.steered` `{"text","sender","message_id"?}`; one handed over from the list of those waiting is named by `queue.changed` `steered` instead (`queue`). The app sends `message_id` (a UUID per message) only to a bridge that lists the feature, and takes a message under an id it gave as its own, which it shows already; any other opens the turn, or joins it, as that message (`turnOpened`, `messageSteered`). A message of its own sent as another's opened the turn on the bridge waits for its answer, which says where it went. A bridge's `session.resume` answer has `latest_seq`, the `seq` of the last event it holds: a device whose connection already followed the session, and held what came while it asked, leaves out a held `message.steered` numbered up to it, whose message the answer holds, so it is not shown twice. Every other held event it applies after the answer, as before: the answer does not hold all they say (a card raised and taken back meanwhile: its frame has no number, its `request.cancel` does) |
| `resume_replay` | Feature: params `since`, `replay_epoch` and `replay_base` of `session.resume`; keys `replay_base`, `replayed` and `events` of its result | A resume that brings only what a device missed, which the app asks for after a reconnect and as the thread on screen comes back to the front (section 8). `since` is the `seq` of the last event the device applied to the thread (or the `latest_seq` of the answer it last took, when it applied none since), `replay_epoch` the `gateway.ready` epoch that number is from, and `replay_base` where the replay of the conversation the device took whole begins: the `replay_base` of that answer. A device sends `since` and `replay_base` only for a conversation it took whole in a resume answer, not for a thread made with `session.create`: its session may hold what was said before it, which no event tells (an agent with one ongoing conversation gives that one: a Hermes profile's Bot Chat, `bot_chat`), so a `replay_base` of 0 would not say what the device holds. A conversation that changes with no event (a thread only read, read again; a running Codex turn taken for a `/compact` found to be opened by a message) moves the session's `replay_base` on, so a device that followed the thread on through such a change, whose `since` is past it with the conversation from before, is told apart from one that took the thread after it. Every answer to a resume whose `replay_epoch` is this run's has `replay_base` (an integer, the session's now), which the device keeps with the thread and sends back with its next `since`; an answer to any other has no such key. When that epoch is this run's, `replay_base` is the session's, the thread is not one taken up only to read (each resume of one reads its conversation from the agent again, which no event tells of), and the replay log reaches back to `since` (section 8, `session.events.since`: a number the session never gave out, one a session of the thread before this one gave out, or one from before a change no event told of, is not reached) with at most 500 events after it, which take no more bytes (UTF-8, as sent) than the conversation and the turn under way they stand in for (a reply streamed is many small events, so a short thread is sent whole), the answer leaves `messages` and `inflight` out and has `"replayed":true` and `events`, every event after `since` oldest first, each exactly the `params` of its live frame: `{"session_id":"…","running":true,"replayed":true,"events":[{"type":"message.delta","session_id":"…","seq":475,"payload":{"text":"lo"}}],"open_requests":[],"info":{…},"latest_seq":475,"replay_base":0}`. It is built in the step that makes the connection follow the thread (section 8, atomicity), so the first live event after it is the one after `latest_seq`: nothing missed, nothing twice. Otherwise, and whenever `since`, `replay_epoch` or `replay_base` is missing, it is the whole answer, as for any device. `open_requests` (always, `[]` when none), `info`, `queued` and `can_steer` (`queue`), `running`, `latest_seq` and `replay_base` are in both: a model or level changed with `config.set` tells no event, so the device takes `info` from either. Hermes rejects the three params |
| `subagents_clear` | Feature: event `subagent.cleared`; `subagent.list` leaves the cleared ones out | `{"subagent_ids":["a24479d5e93836222","wwn9e3l29"]}`: these had ended and left the line as a message went to the agent. Shapes below |
| `subagent_names` | Feature: keys `nickname`, `role` and `parent_id` of a subagent | `"nickname":"Darwin","role":"worker"`: what a Codex sub-agent is called and what kind it is; a Claude subagent's `role` is its type (`Explore`). The app shows a Codex sub-agent as "Darwin · worker", its path in its detail. Shapes below |
| `poll_now` | Feature: param `poll_now` of `client.capabilities`; event `poll.now` | A connection that asks is told, by one small event with no session, when something its poll reads has moved: the list of threads, what a thread is doing, the agents' looks, the sidebar's order, a later portals-host coming out or going (`update_notice`), or the free space on the bridge's disk (`disk_space`). Shapes below |
| `subagent_calls` | Feature: key `agents` of the `args` of a Codex `delegate_task` row other than a spawn | `{"name":"delegate_task","context":"wait","args":{"agents":["Darwin","Euclid"]}}`: who a Codex call about its sub-agents was about, by the names the subagents line gives them (the nickname, else what each was asked to do: its path for multi-agent v2, the first line of its task for v1, cut to 40 characters), in the order they started, in `tool.start`, `tool.complete` and the stored row alike. `context` is the call (`wait`, `closeAgent`, `sendInput`, `sendMessage`, `followupTask`, `resumeAgent`, `interruptAgent`, `listAgents`); a message or task it gives one is `args.task`. A spawn (`spawnAgent`) has no `agents` and keeps its task (`args.task`). A call that names its sub-agents (v1) is about those; a wait that names none (v2) about the thread's own sub-agents at work as it starts, and those that ended since a wait last ended, whose news it takes in: as it ends, the ones that ended meanwhile too. Read back from a stored thread (after a restart), the bridge reads each sub-agent's nickname from its own thread (`thread/read` without turns, once, the latest 24), and names one it cannot read by what it was asked to do. The app shows such a row as one short line ("Waited for Darwin and Euclid", "Closed Darwin", "Sent Euclid a message"), the subagents line keeping the rest; an app without the feature shows "Delegate wait" with `args` as its input |
| `subagent_read` | Feature: method `subagent.read`; key `can_read` of `subagent.*` events and `subagent.list` entries | What one subagent did, read only, for its detail in the app. `can_read: true` on a subagent whose own messages can be read: Claude Code's subagents, from the file Claude Code keeps for each beside the session's (the SDK's `getSubagentMessages`), and Codex's sub-agents, each a thread of its own (`thread/read` with its turns); not workflows or commands, nor the subagents of agents that keep none. `subagent.read` `{session_id, subagent_id, profile?}` answers `{"available":true,"messages":[…]}`, its messages oldest first in the shape `session.resume` gives a thread's (section 8), read again at each call, so one still at work gives what it has done so far (Codex's turn in progress has the items Codex has completed, with no mark of an end); or `{"available":false}` for one that cannot be read, one not known, or a thread not loaded here. What it was asked opens a Claude subagent's messages; a Codex sub-agent on multi-agent v2 keeps no message of it, so its messages open with what it did. The app offers its messages from the detail of one with `can_read`, on a page of the chat's own rows; a host without the feature leaves the detail as it was |
| `status_headline` | Feature: event `status.headline` | `{"text":"Read a.txt and b.txt","tool_ids":["toolu_01H1…","toolu_01Fw…"]}`: what the agent says it is working on, in its own words, which the app shows on the running turn's status line in place of "Thinking…" (the sheen sweeping it) until a newer headline comes, from this event or what it takes from the turn itself, or the agent says something (a new stretch of work) or the turn ends; a running tool call still takes the line. Sent for Claude Code's `tool_use_summary`, its summary of a run of tool calls on the main thread, which it makes with a small model call of its own once the run ends (with `claude.toolSummaries`, on unless set to false: the bridge sets `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES` for the sessions it starts); `tool_ids` are the calls it sums up, by which the app takes it only while one of them is in the stretch of work under way (a summary often comes once the next call has started, and now and then after Claude has said something). Not in the `session.resume` answer: a device that opens the thread meanwhile shows the next. Every bridge also lets the app take headlines with no event: the bold title opening each part of a GPT model's reasoning (`**Validating prime numbers**`, Codex always, Droid and Pi on such a model) and the wording of Claude Code's to-do in progress (`activeForm` of a `todo` row's item). An older app leaves the event unread; `PORTALS_DEBUG_STATUS_HEADLINE=before` has the app say "Thinking…" as before |
| `agent_threads` | Feature: key `shared` of a listed thread and of `thread.mark`; method `thread.answer`; keys `by` and `answer` of `request.cancel`; param `origin` of `thread.start` | Threads an agent started through the fleet: one a person put in the sidebar on every device is listed with `"shared":true` (the app otherwise lists such a thread only under the thread that started it), and the thread that started one answers its questions as a device answers them, within what its own mode allows. Shapes below, under the thread list |
| `recent_threads` | Feature: key `recent` of a listed thread and of `thread.mark` | The threads under Recent in the sidebar, kept per thread for every device: `"recent":true` while some device opened or wrote in the thread and none has dismissed it, archived it or let it go past the 25 of this bridge's that every device keeps. The bridge keeps the mark and nothing more: the devices set and clear it, and each shows as many as it was asked to (docs/sync-plan.md). Without the feature, Recent is each device's own. Since 2026-11-02 |
| `held_elsewhere` | Feature: method `threads.held`, from the net's Macs only | A thread started on another Mac of the net from one of this bridge's keeps it running in `sessions.activity`, as one started here does: that Mac says which of this bridge's threads its threads keep at work, every minute while any do, and its word holds three minutes (the net's methods, below; docs/fleet-plan.md). Since 2026-10-27. Not for the app |
| `turn_usage` | Feature: key `turn_usage` of `message.complete` and of an ended turn's last stored message | What a turn spent, for the quiet line the app shows under every ended turn (finished, stopped or failed): `{"seconds":102.4,"tokens":52300}`, either key may be missing. `seconds`: how long it ran, the agent's own time for it where it keeps one (Codex's `durationMs`, Droid's), else the bridge's from the turn's start to its end; none for a turn the bridge took up already under way. `tokens`: what the thread's own agent took in and gave out, cached ones too, each counted once, where the agent tells them: Claude Code's result `usage` (its main loop, every request of the turn with its tool calls, not its subagents', which each say their own on the subagents line; a stopped turn's result says none, so what its requests streamed), Codex's `thread/tokenUsage/updated` `total` (how far it rose in the turn; its input has its cached input in it), Pi's assistant messages' `usage`, Droid's and Hermes's session totals (how far they rose, once the bridge knows where they stood), an ACP agent's prompt `usage` (Cursor sends none). The same key on the turn's last stored message (`session.resume`), so every device shows it after a relaunch: Claude Code's and Pi's from their own stored sessions after a restart of the bridge (the same counts), Codex's time from its history and its tokens kept by the bridge (`state/spent/<thread>.json`, by Codex's turn id). A message steered into a turn opens a turn of its own in stored history: live, the whole turn's figures go with its end; from an agent's history, each part has its own. The app shows `1m 42s · 52.3k tokens`, the time alone where there are no tokens, and from a bridge without the feature the time from the turn's start and end |
| `session_leave` | Feature: method `session.leave` | Params `{session_id, profile}`; result `{}`. The connection stops following the thread: none of its events or questions are sent to it any more, and the thread runs on for its other followers (other devices, a terminal that has it open, the fleet). `{}` too for a thread the connection does not follow, one not loaded and one the bridge does not have; only a missing `session_id` is -32602. A `session.resume` follows it again. The app sends it for a thread it let go of (at rest and off screen, past the few it keeps open, `OpenThreads`), once nothing listens to the thread's events (`HermesBackend.letGo`), and resumes such a thread only after the leave is answered, so the leave never comes after a resume. Before it, a thread let go of was followed until the connection ended: every piece of a reply it got from another device, a terminal or the fleet came to the app and was thrown away, and a reconnect resumed it whole whenever it had worked. From a host without the feature the app sends nothing, drops what comes for such a thread unread (a question too, unanswered rather than refused) and does not resume it on the next connection |
| `worktrees` | Feature: key `repo` of a thread in the `threads.changes` result; how `folders.list`, `folders.add`, `session.create` and `thread.start` take a folder in a git worktree | A git worktree is never a folder of its own. A folder is in one when the nearest `.git` above it is a file naming a folder git keeps the worktree in, whose `commondir` names the `.git` folder of the repository's main checkout, which keeps it among its `worktrees` and whose `gitdir` names the worktree back, as git checks (what `git rev-parse --git-common-dir` says; read from git's own files, no `git` is run, `bridge/src/git.ts` `worktreeOf`). Such a folder is listed as the main checkout's: its top for the worktree's top, the same folder in it for a folder inside the worktree, or its top when the main checkout has no such folder. A submodule (its `.git` names a repository of its own, with no `commondir`), a worktree of a bare repository or of one whose `.git` is kept apart, and one whose main checkout is gone are no worktree here. `folders.list`: a folder in a worktree is listed as that folder, once, as of the newest use of any of them, never as a folder of its own. `threads.changes`: a thread whose folder is in a worktree carries `"repo":"/Users/dev/coding_projects/Portals"`, beside its own `folder`: the folder it is listed under, its project. The bridge reads it when the thread is first listed (made, taken up from the desk, back on the list), as a turn starts and ends, and for each thread as it starts; it keeps it while the thread's folder is gone (the worktree removed) or no longer kept by git, and drops it when the folder is there and in no worktree; a change moves the thread's revision like any key the list shows. `folders.add` of a folder in a worktree adds the folder it is listed as, and answers with the folder chosen (`path`, its real path, and `name`) and `"repo"`, the folder added in its place: an app from before the feature starts the new thread in `path`, where the person chose, as it did with a bridge from before. `session.create` (`cwd`) and `thread.start` (`cwd`, `portals start --folder`) take a folder in a worktree whose listed folder or main checkout they would take (General, on the list, added), except `/`, the home folder and one in the bridge's own folders or those `folders.hide` names; a hidden or temporary worktree is taken (Claude Code keeps its own under `.claude/worktrees`); the thread runs in the folder named, not in the main checkout. Any other folder is refused as before. A worktree whose matching folder in the main checkout is never offered (a main checkout in a hidden or temporary folder, `~/.config/nvim`, or in one `folders.hide` names) while its own folder may be is a folder of its own, as before the feature: `folders.list` lists it, `folders.add` adds it and answers with no `repo`, and `session.create` takes it as it would any listed folder. The app files a thread under `repo` when it has one (`SidebarProject.ID(of:)`, `ThreadRecord.repo`), shows its `branch` on its row, and says so when the Mac's folder dialog chose a worktree; it reads `repo` only from a host that lists the feature |
| `turn_diff` | Feature: key `turn_diff` of `message.complete` and of an ended turn's last stored message | What a turn changed, for the line the app shows under an ended turn that changed files ("3 files · +40 −12"), which opens the files and their diffs: `{"files":[{"path":"src/app.ts","status":"modified","added":3,"removed":2,"diff":"--- a/src/app.ts\n+++ b/src/app.ts\n@@ …"}],"added":3,"removed":2}`. `files` in the order the turn first changed them; `path` as the diffs name it (relative to the thread's folder when inside it, else the absolute path, with its leading `/`); `status` `added` (the turn created it), `modified` or `deleted` (its last change removed it); `added` and `removed` lines; `diff`, the file's unified diff: one header, then each of its edits' hunks in the order made (a bare `@@` line between edits that had no line numbers). At most about 512 KB of diffs a turn: past it a file's diff is cut at a line's end and those after it are empty, each with `cut: true`, and the whole with `cut: true`; counts are always whole. Worked out by the bridge from the diffs the turn's edits carry (a tool row's result `diff`, else its `inline_diff`, Hermes's terminal drawing of one read as a unified diff; none for an edit denied, failed or that changed nothing; a file's diff an agent's row cut short ends with a `\ Cut short: +A -R more` line, counted, and that file is `cut`): the agent's own record of its edits, for every agent alike, live and from its history after a restart; not `git diff`, which would mix in what the user or another agent changed. Where an agent's history gives an edit another diff than it had live (Claude Code's keeps no structured patch: an Edit with `replace_all` read back from it has one replacement, a Write over a file no lines removed, and neither has line numbers), the bridge keeps the live diff by the tool call's id (`state/diffs/<thread>.jsonl`, at most about 2 MB a thread, the latest kept) and puts it back when the thread is loaded again, so the tool rows and the turn's counts are those shown live; an edit the bridge did not see live (made in a terminal while it was off, or one whose diff it no longer keeps) has the one rebuilt from the history, whose counts can differ. Joined, not merged: a line two edits changed counts in both. A file removed with a shell command is not an edit. None for a turn that changed no file. A message steered into a turn: live, the whole turn's at its end; from stored history, each part its own, as for `turn_usage`. Old apps ignore it; from a bridge without it, nothing is shown |
| `file_read` | Feature: method `file.read` | Params `{session_id, path, purpose?, unless?, profile}`: `purpose` is `image` (an image a reply names) or `text` (a file to read, the default; an image file is answered as an image all the same), `unless` the `etag` of the copy the device holds. For any thread of the bridge's, followed on the connection or not; -32602 for another `purpose`, 4007 for a thread the bridge does not have. `path` as the agent wrote it: absolute, `~/…`, or relative to the real folder the thread works in (the home folder or `/` too). The file may be anywhere the bridge's user can read, every link resolved, for every thread (since 2026-10-27; before, it had to be inside the thread's folder, and an image in a temporary folder too). An image is given when its bytes are an image's, and refused as `not_image` when they are not. Only a regular file, opened without following a link anywhere in its real path (at its end off macOS) and checked to be the file the path names still. Result `{name, path, kind: "image"\|"text", type?, size, etag, data?, text?, unchanged?}`: an image's `type` (`image/png`, known by its bytes) and `data` (base64, at most 15 MB), a text file's `text` (UTF-8 with no NUL, at most 2 MB), or neither with `unchanged: true` when `unless` is its `etag`. A file not given: `{name, path?, refused, message}`, `refused` one of `outside` (a relative path for a thread with no folder at all), `missing`, `not_file`, `too_large`, `binary` (not text), `not_image` (asked for as an image), `unreadable`, `message` the sentence for the person. The app shows a Markdown image `![caption](path)` of a reply with it (`ReplyImages`), and opens a file a tool row names (`FileViewer`); from a host without the feature an image is a link with its caption and tool rows open nothing. Agents are told of the images in the line on math (`bridge/src/portals/guide.ts`), and a notification names an image `[Image: caption]` |
| `session_resync` | Feature: param `session_resync` of `client.capabilities`; event `session.invalidated` | An authoritative correction requires a full session snapshot, without ending the running turn. Shapes below |
| `push_watcher` | Feature: push route `DELETE threads/{id}/watcher`; key `features` of the push `GET status` | Section 10. The bridge serves the route that stops notifying one device, and its status lists `"features":["watcher"]` (as the plugin's does) |
| `message_ids` | Feature: key `message_id` of a stored user message and of `inflight` in the `session.resume` answer, and of a `queued` entry (`session.resume`, `queue.changed`) | The id `prompt.submit` gave the message (`turn_messages`), on the user row that opened its turn or that it was steered in as, and on `inflight` while it opened the running turn. Kept only while this run of the bridge keeps the session loaded: a message stored before, from the agent's own history, or sent with no id has none. The app matches a send whose answer was lost by it; from a host without the feature, by its words. A message waiting on the list carries it too, from the moment it is listed: a device whose send lost its answer (the host queued it) shows it as its own message waiting, not as another's beside its own copy failed |
| `async_questions` | Feature: key `async` of a `clarify`; param `async_questions` of `client.capabilities`; `request.cancel` reason `replied`, and key `answer` of one `resolved`; key `card_answer` of `message.start`, `message.steered`, a `queued` entry (`queue.changed`, `session.resume`), a stored user message and `inflight`; keys `unanswered` of a stored `clarify` row's result and `async` of its args | Questions an agent asks without waiting for the answer (Codex's `request_user_input_async`, which GPT-6.1 Sol uses in any mode): the agent goes on, and takes the user's next message as the answer. In a thread a device that sent `async_questions: true` has followed, they are a `clarify` with `"async":true`, else the reply's text as before (the questions, each option on a line `- …`). The card stays open past the turn's end; answered, its answers go to the agent as the user's message (handed to the running turn, else opening one, which every device opens with it: one answer by itself, several each under its question). That message is marked as the card's: `"card_answer":"<the row's tool_call_id>"` wherever it is told (its turn's `message.start`, `message.steered`, its `queued` entry while it waits, the stored user message and `inflight`); the app shows the answers in the questions' row and no bubble of its own for it (an app without the feature reads none of it and shows the message). The other devices' cards close with `request.cancel` `{"id","reason":"resolved","answer":{"answers":{"q0":"Blue"}}}` (`{}` for a card dismissed), which their row shows. A newer such question withdraws it (`withdrawn`), a message the user sends the agent closes it (`replied`), from a device or typed at the desk in a thread followed there too (also one Codex first took for a `/compact`, once its words come), Stop withdraws it (`interrupted`). The thread keeps a `clarify` tool row of the questions where they were asked, its args `{"questions":[…],"async":true}` (the app keeps such a row in view, where other answered questions fold with the work), whose result is `{"responses":[],"asking":true}` while the card is open (the app leaves such a row out), then the answers given, `null` when a message answered them (handed to the running turn or opening one; a command such as `/compact` does not), or `{"responses":[],"unanswered":true}`; Codex's blocking questions (plan mode) keep such a row too, without `async`. Codex's history keeps only the message, so the thread's record keeps how each card settled its questions (`threads.json` `cardAnswers`, the latest 20: the answers, and the message they went as): read back after a restart of the bridge, the row has the answers again and the user message right after it, when it is that message, has `card_answer`; a card skipped or taken back with Stop reads back so. The last questions a thread was asked, unanswered with no message of the user's after them, are put again as their card (the same `clarify`, `async`, open past the turn, the thread `waiting`) when a device that sent `async_questions: true` resumes the thread: in the step of its `session.resume`, whose answer lists it in `open_requests` and leaves out the row (`asking`); answered, it goes on as one asked live; it is not notified again. Older or superseded ones stay rows (`unanswered`), and a message sent first answers them |
| `senders` | Feature: key `from` of a stored user message, of `inflight` and of `queued` entries in the `session.resume` answer, of `message.start`, `message.steered` and `queue.changed`, and of a listed thread's `started_by`; param `sent_by` of `thread.send`, `thread.start` and `thread.answer` | Who a message sent through the fleet is from, and who started a thread through it, as a few facts (src/fleet/line.ts): `agent` (the sending thread's agent by its profile name on its Mac, when the bridge knows it), `agent_name` ("Claude Code"), `thread` (its id on its Mac), `title` (its title when it sent the message), and, when it came from another Mac, `machine` (that Mac's stable id, its `gateway.ready` `machine.id`) and `machine_name` (its name for itself: its Computer Name, or `fleet.name` in its config). Every key may be missing; `{}` is the command line (a person or a script in a terminal) of the thread's own Mac, `{"machine":"7d2a41c09be36f58","machine_name":"mini"}` another Mac's (`{"machine_name":"mini"}` when an older bridge passed it on). `{"agent":"codex","agent_name":"Codex","thread":"019a…","title":"Review","machine":"7d2a41c09be36f58","machine_name":"mini"}`. Read from the message's `[Portals: from …]` line as it goes out (the bridge stores nothing more), so a message stored before the feature has them too, but a line an older bridge passing it on worded as it liked has none, and another Mac's thread named by an older bridge has `machine_name` alone. The app shows these, with its own name for the Mac whose id it knows, and reads the line only from a host without the feature; the line stays the agent's (section 11, below). Between bridges: `sent_by` is the same facts, with the sending Mac's id and name, which the bridge passing a message, start or answer on gives beside `sender` (the same in words, for a bridge without the feature); a thread started so keeps them, lists them as `started_by.from`, and takes an answer passed on only from the same Mac's same thread by them (by `origin`, as before, when either side has none) |
| `background_commands` | Feature: `kind` `command` of `subagent.*` events and `subagent.list` entries, with keys `output` and `output_truncated` | A terminal command the agent left running in the background after its turn moved on, as a row of the subagents line: Claude Code's `run_in_background` Bash (its output read once a second from the file Claude Code names for it, `…/tasks/<task id>.output`, only its end, never a link), Codex's background terminals (a command still running when Codex completes its turn: its tool row closes with the output so far and "…still running in the background.", and takes the whole result in its place when the command completes), Droid's background commands as its footer lists them (`background_processes_changed`, Droid 1.0 and later: one row a process, `subagent_id` Droid's id for it with `#` and its pid, its output read from the file Droid names for it, `droid-bg-<start>-<uuid>.out`, only its end, never a link). `goal` is what it runs (Claude Code's description of it), `summary` its last line of output, `output` the end of its output so far (8 KB and 200 lines at most; `output_truncated` when its start was left out), `can_stop` while `subagent.stop` can stop it (Claude Code's `stopTask`, Codex's `thread/backgroundTerminals/terminate`, Droid's `droid.kill_background_process`; not while Droid lists two commands under one id, since Droid stops the first it finds). At most one `subagent.progress` a second for one, of which the replay log keeps the latest only (as for `tool.progress`), also past the turn's end; none of it is in the thread's history. Stop on the turn leaves them running, as before they had rows. `{"subagent_id":"exec-23bb…","kind":"command","goal":"npm run dev","status":"running","background":true,"can_stop":true,"summary":"ready in 412 ms","output":"> dev\nready in 412 ms\n"}`. An app without the feature shows one as an agent named by its goal. Apart from the feature, `tool.progress` now also comes from Codex (`item/commandExecution/outputDelta`, and a plan's row as Codex writes the plan, `item/plan/delta`), Pi (`tool_execution_update`) and Cursor (a command call's updates), at most four a second per call, the whole tail each time |
| `thread_search` | Feature: method `thread.search` | Params `{query, limit?, hits?, cursor?, agent?, folder?, linked?}`. Finds words in the user's messages and the agent's replies of every thread the bridge lists, every agent's, without loading any, each in its agent's own file, loaded or not (Claude Code's session file, Codex's rollout file, Pi's session file, the bridge's own record for Droid, Cursor and the fake agent); in memory only a thread whose agent keeps no such file (Hermes, while loaded) or whose file is not written yet, and a loaded Droid or Cursor thread's messages not saved to the bridge's record yet. Tool calls, their output and the agent's reasoning are not searched. Case and accents are ignored (NFKD, combining marks removed, lower case), and a word matches where a word of the text begins (`deploy` finds `deployment`, `log` finds `login` but not `catalog`): a word is letters and digits, anything else ends one (`search` finds `thread_search`), and a capital after a small letter or a digit, or the last capital of a run before a small letter, begins one (`threadSearch`, `HTTPServer`); in scripts written without spaces (Chinese, Japanese, Thai and the like) a term of their letters matches anywhere, and a word right after one of their letters begins there; a term that starts with neither a letter nor a digit (`.env`, an emoji) matches anywhere. A `"quoted phrase"` is matched as it stands with any run of white space as one space, beginning where a word begins, its last word free to run on into a longer one; a message is a hit when it holds every word and phrase (at most 8, from the first 200 characters). `agent` keeps an agent's threads (its profile name: `profile` is not read, so that a call carrying the app's usual `profile` still searches every agent); `folder` the threads in that folder, in a folder inside it, or listed under it (`repo`). Result `{threads, cursor, scanned, unsearched?, replaced?}`: `threads` newest first (the list's `updated`), at most `limit` (20, at most 50) that have a hit, each `{id, agent, agent_name, title?, folder, updated, archived?, count, hits, compacted_at?, partial?}`; `count` how many of its messages hold every word, `hits` the newest `hits` (3, at most 10) of them, newest first, each `{role: "user"\|"assistant", text, ranges, timestamp, id?, before_compaction?}`: `text` a snippet of about 200 characters around the first match, its white space shown as single spaces and an ellipsis (`…`) where text is left out, `ranges` the matches in it as `{start, end}` in UTF-16 code units (`end` not included), `timestamp` Unix seconds, `id` the agent's own id for the message where its file has one (Claude Code's `uuid`, Codex's item id, Pi's entry id; not the app's, which finds the row by role and time). `before_compaction: true` on a hit said before the thread's latest compaction where the thread no longer shows what came before it: Claude Code's, whose session's messages start again at its summary (`isCompactSummary`). The thread then has `compacted_at`, Unix seconds, the `timestamp` of the `compaction` row the thread's history shows for it (the summary's time); the app opens the thread at that row, with the snippet in a note, when the hit's own row (by role and time) is not there. Which hits are hidden is Claude Code's own reading of the session to say (the SDK's `getSessionMessages`, as the bridge's history reads it): a thread whose file is `partial` has no marks. Codex's, Pi's and the bridge's own records (Droid's) keep what was said before a compaction in the thread, so their hits are never marked. `archived`: an archived thread, searched like any other and marked so. `partial`: the thread's file is larger than 64 MB, and only its last 64 MB were searched. `cursor`: give it back for the next page, with the same query and filters (-32602 otherwise); null when every thread was searched. A thread's place is the one it had when the page searched it, which `updated` gives: one that moves up later is not searched again. A page ends at `limit` threads or after 1.5 s or 256 MB of files, checked between threads, so that a page always searches at least one thread whole; a thread that moved to the top of the list since the first page is not searched again. `scanned`: how many threads the page searched. `unsearched`: `[{agent, count, reason}]`, threads whose agent keeps them where the bridge cannot read them unloaded (Hermes), with the sentence for the person. A newer `thread.search` on the same connection replaces one still running, which answers `{threads: [], cursor: null, scanned: 0, replaced: true}`; the app drops it. -32602 for a query with no words. With `linked: true` (for fleet clients; the app asks each Mac it is connected to by itself) the linked Macs are asked too, each for 8 s: their threads come as `machine/id` with `machine`, `machines` says which answered (`{name, url, reachable, error?}`), and the cursor holds each Mac's own (a Mac that fails a later page is asked again where it left off on the next page, up to two pages in a row, a page on which it is resting after a failure a moment ago not counted; a newer search on the connection replaces the whole of it). Nothing of a query or of what it finds is logged |
| `file_search` | Feature: method `files.search` | Params `{session_id?, folder?, query?, limit?, profile}`: the files and folders of a thread's folder (`session_id`; any thread of the bridge's, followed on the connection or not) or of a folder new threads may start in (`folder`: General, one `folders.list` lists or that was added, or a git worktree of one; others -32602), ranked against `query` as an editor's quick-open does, for the menu an app shows when the person types `@` at the start of a word to mention a file (the new-thread screen searches its chosen `folder` before the thread exists). -32602 with neither, for a thread or folder that is the home folder or `/`, and for a param of the wrong type; 4007 for a thread the bridge does not have. Which files: where the folder is in a git repository, git's (`git ls-files --cached --others --exclude-standard`: tracked, and untracked ones no ignore rule leaves out; less the deleted), with the folders they are in; elsewhere, or on a Mac without git, a walk that follows no link and skips `node_modules`, `.git`, `DerivedData`, `.build`, `Pods`, `build`, `dist`, `target`, `.venv` and the like (`bridge/src/sessions/fileSearch.ts`, `skippedFolders`). A link is listed by its own name and never followed, so nothing outside the folder is named. The query is split at spaces and every word must match, its characters in order (fuzzy), case ignored; a match in the file's own name ranks above one spread over its path. An empty query lists the shallowest entries, folders first. `limit` 50 by default, at most 200; a query longer than 200 characters is cut. Result `{folder, files: [{path, name, kind: "file"\|"folder", score, ranges}], total, matched, source: "git"\|"walk", truncated?, refreshing?}`: `path` relative to `folder` with `/` between its parts (a folder's with no `/` at its end), `ranges` the parts of `path` the query matched as `[start, end)` in UTF-16 code units, `score` only for ordering one answer, `total` the entries listed, `matched` how many the query matched, `truncated` when the folder holds more than the 200,000 entries a listing keeps, `refreshing` when the folder changed and its new listing took longer than 150 ms: the answer is from the listing before, and the app asks again shortly (a folder of 100,000 files takes about half a second to list). A file hit also has `size`, its size in bytes (none for a folder, a link, or a file gone since it was listed). For an agent that reads a mentioned file in itself (Claude Code; the thread's agent, or for a `folder` the agent `profile` names, the one the new thread will run) the result has `mention_limit: {max_bytes, max_tokens, note_bytes}`: over `max_bytes` (262,144) the agent never reads the file in, over `max_tokens` (25,000, counted by the agent) it leaves it out without a word, and from `note_bytes` (60,000) the app shows a small note on the mention, as the file may be over the tokens (none on a PDF, which Claude Code reads its own way); `max_tokens` follows `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` in the bridge's environment, read as Claude Code reads it, at most 1,000,000,000 (Claude Code 2.1.299, docs/plans/2026-10-26-file-mentions.md section 3). Other agents' models read a mentioned file with their tools: no `mention_limit`, no note. The bridge keeps the listing of up to four folders (400,000 entries together), each kept fresh by a watcher and listed again on the next search after anything in it changed; a search may be answered from a listing up to 2 seconds old where the folder cannot be watched. A `folder` is checked against the list at most every 5 seconds (a folder just taken off it is searched that much longer) |
| `file_mentions` | Feature: param `mentions` of `prompt.submit` | `"mentions":["src/main.ts","docs"]`: the files and folders the message mentions, picked from `files.search`, relative to the thread's folder. The bridge keeps those that name something in the folder (links resolved; none absolute, with `..` out of it, with a `"` or a line break), each once, at most 20, and drops the rest without an error; a message with no text is not empty when it keeps one. The text is the truth: each kept mention stands in it as `@path`, or `@"path"` when the path has white space or does not end on an ASCII letter, digit or `_` (Claude Code reads a bare `@path` only at a word's start and up to its last such character, so `@notes.md,` is notes.md), and one the text does not hold as Claude Code reads it is put at its end, so the agent's history, `message.start`'s `text` and the stored user message hold it as the agent got it. The result has `large_mentions: [{path, size, fit: "maybe"|"unread"}]` when the thread's agent reads mentions in itself and some kept files (not PDFs) are over its `mention_limit`'s `note_bytes` (`unread` over `max_bytes`), for the note on the sent message. What each agent does with it: Claude Code reads every `@path` itself and gives the model the file, up to 262,144 bytes and 25,000 tokens: over the bytes it gives the model a line saying the file was too large to attach, over the tokens nothing at all (or the first 2,000 lines when they fit); Codex, Pi, Droid and Hermes get the text, with the path in it (Codex's own `mention` input is for apps, plugins and skills, not files, and its composer puts a picked file into the text as its path); Cursor gets a `resource_link` per mention (`file://` URI and name) after the text block, ACP's way of pointing at a file. The bridge never puts a file's contents into the message. A message waiting on the bridge's queue keeps its mentions across a restart (`bridge/src/sessions/mentions.ts`, docs/plans/2026-10-26-file-mentions.md) |
| `folder_search` | Feature: method `folders.search` | Params `{query?, limit?, machine?, profile?}`: the folders a new thread could start in under the bridge user's home folder, for the app's folder picker, where a person types (docs/plans/2026-10-26-folder-search.md). Two kinds of query. *Fuzzy* (no `/`, not starting with `~`): every folder walked under the home folder, each scored as its path relative to it with `files.search`'s scorer (words split at spaces, each must match, its characters in order, case ignored; a match in the folder's own name ranks above one spread over its path), plus a bonus for a git repository's top (a `.git` in it) and a larger one for a folder `folders.list` lists (more the newer its `last_used`, more again when `added`); an empty query lists those folders, then the repositories. *Path* (has a `/` or starts with `~`): completed as a terminal does, a level at a time from the home folder (`~/cod/por`, `cod/por`, or a real path under it, `/Users/dev/cod/por`; one outside it finds nothing), each part against the folders in the one before: its name exactly (case ignored; then only those are followed), then names it starts, then fuzzy; the best 8 of a level are followed on, at most 64 folders read; a trailing `/` lists what the folder holds, the folder itself first; read from the disk at each query. A folder the walk skips (below) is found in a path by its name's start only. Offered: only folders `folders.add` takes, which `session.create` then takes: never `/`, the home folder, a hidden folder (any part starting with `.`), a temporary one, the bridge's own or one `folders.hide` names. The walk follows no link (so nothing outside the home folder is named) and goes into none of those, nor `files.search`'s skipped folders (`node_modules`, `.git`, `DerivedData`, `build`, `dist`, `.venv`, …), `~/Library`, the folders macOS asks the person about before a process reads them (`~/Desktop`, `~/Documents`, `~/Downloads`, and `~/Pictures`, `~/Movies`, `~/Music`, which hold the Photos and Music libraries; since 2026-10-26: a background read of one would put macOS's question on the Mac's screen with nobody there), or packages (`.app`, `.xcodeproj`, `.photoslibrary`, …). A folder `folders.list` lists that the walk does not go into (one in `~/Documents`, say) is scored and offered all the same. A folder in a git worktree (feature `worktrees`) is offered as itself with `repo`, the folder `folders.add` adds in its place. `limit` 30 by default, 100 at most; a query longer than 200 characters is cut. Result `{home, folders: [{path, name, relative, ranges, score, git?, last_used?, added?, repo?}], total, matched, mode: "fuzzy"\|"path", truncated?, refreshing?, superseded?}`: `home` the home folder's real path; `path` the folder's real path, what `folders.add` takes; `relative` its path under `home` with `/` between its parts; `ranges` the parts of `relative` the query matched as `[start, end)` in UTF-16 code units; `score` only for ordering one answer; `git` for a repository's top; `last_used` (Unix seconds) and `added` as `folders.list` gives them; `total` the folders looked at; `matched` how many matched; `truncated` when the walk kept its most (200,000 folders, 24 levels), a search ran out of its 250 ms or a path read its 64 folders; `refreshing` when the first walk, or reading what changed, was still under way after 300 ms (150 ms for changes): the answer is from what was there, and the app asks again shortly; `superseded` when a newer `folders.search` on the same connection replaced this one while it ran: no folders, and the app drops it. The bridge keeps one listing of the home folder, walked 32 folders at a time between turns of the event loop when first searched and let go of after 10 minutes with no search; on a Mac a watcher on the home folder and a recursive one on each folder at its top that is walked mark the folders that change, each read again at the next search (folders gone taken off with all under them, new ones walked; more than 256, and the home folder is walked again whole, the listing before answering meanwhile); where it cannot watch, it is walked again once a minute old. Neither the walk nor a watcher goes into those six folders; a typed path that starts one's name goes in (`~/Doc/`, as the person asked), and macOS may then ask once whether the bridge may read it; refused, it holds nothing. With `machine` (feature `fleet`): that Mac's folders, as it ranks them, passed on as `folders.list` with `machine` is, with 10 seconds to answer; a Mac that cannot be reached is -32603 with a sentence, a bridge without the feature -32603 saying to update it. -32602 for a param of the wrong type or an agent the bridge does not have. The app sends it only to a host that lists the feature (`HermesBackend.searchFolders`) |
| `answer_owner` | Feature: param `device` of `client.capabilities`; key `answered_by` of `request.cancel` | Which device's answer settled a request (connect-17). An app gives itself an id with `client.capabilities` `{"device":"<id>"}` (PortalsKit: one random id for each launch, `BridgeWire.thisDevice`, the same on every connection; at most 128 characters, else ignored). A `request.cancel` that a connection's answer caused says `"answered_by":"<that device>"` when it gave one (it goes to every follower but that connection, and is in the replay log, so the same device can meet it again after a reconnect). An app that answered the card itself and whose answer the host has not taken yet (the send waits for the thread's catch-up, or fails) learns from a `request.cancel` whose `answered_by` is not its own id (absent: answered by a connection without one, by the thread that started this one, or taken back) that another answer won: it puts the host's settling (`answer` of an async one, else "Answered elsewhere" or the reason) in place of its own answer. One that names its own id is its own answer's, replayed. Older apps ignore the key; an app without the feature reads no `answered_by` and keeps its own answer as before. |
| `net_rename` | Feature: method `net.rename`; keys `named` and `named_by` of a Mac's entry in the net's list (`net.list`, `net.sync`, `POST /net/join`) | A Mac renamed from the app is renamed on every Mac and device of the net, the latest rename winning (2026-10-26). `net.rename {member?, name, after?}` from a device, the password or the command, on any Mac of the net; the Mac renamed takes the name as the list reaches it and goes by it over `fleet.name` and its Computer Name. The stamp and the merge are under **The net** below. The app (`NetWire.swift`, `Net.rename`) renames a Mac of its net through the Mac itself when connected, else another, and takes the net's name over one given on that device alone once the stamp moved (`HostConfig.netNamed`) |
| `net_rename_devices` | Feature: `net.rename`'s `member` may be a device's id; keys `named` and `named_by` of a device's entry too | A device of the net (a portal: an iPhone, an iPad, the Mac app) renamed from the app is renamed on every Mac and device, kept and merged as a Mac's name is (2026-10-28). A device that joins again (`POST /net/join` with an id the list has) replaces its entry as before, its name stamped as a rename made then, at the entry's own `changed` (past the entry before and its `named`; `named_by` the Mac it joined through), so the name it joins with is the net's everywhere, over an older given name that Mac had not heard of. A device's rename is stamped past its entry's `changed` too, so a name stamped past `changed`, or at it by another Mac than `by`, was given, not joined with: the app keeps only such a name as the one it joins with later (`NetMembership.givenName`). The app (`Net.rename(_ member:)`, Settings → Net → Portals) offers Rename on a device's row only while a connected Mac of its net lists the feature, and joins a net with the name it was last given (`NetMembership.givenName`) |
| `bot_chat` | Feature: key `ongoing` of a listed thread and of the `session.create` result; how `session.create`, `session.rename`, `thread.delete` and `/compress` go for such a thread | Each Hermes profile keeps one ongoing conversation, as Hermes is on Telegram or WhatsApp: its session titled `Bot Chat`, the one Hermes Desktop keeps for the profile too, found by that title (`session.list` `{title, include_hidden}`; Hermes allows one session of a title), so both apps show the same conversation. The bridge lists it as the profile's one thread, titled by the agent's name (`Hermes`, `Aeri`) and `"ongoing":true`; the profile's other threads leave the list as the bridge starts (kept in Hermes, `removed.json` as any thread taken off it). `session.create` for the profile follows that thread: the one listed, else the Bot Chat Hermes has, else one made (`session.create` hidden, following the profile's own settings, then titled `Bot Chat`; when Hermes refuses the title because another app made one meanwhile, that one), once however many devices ask at once; its result has `"ongoing":true` and its conversation may hold what was said before, which a `session.resume` gives (the app resumes such a thread right after creating it). A lookup that fails makes none: `session.create` fails, and the list is kept as it is, asked again as the bridge starts until Hermes answers. Such a thread keeps its name (`session.rename` -32602, Hermes's own `session.title` events are not passed on) and cannot be taken off the list (`thread.delete` refuses). A message `/compress` (or `/compact`) `[focus]` is a turn of its own that compacts the conversation in place (`session.compress`, up to 10 minutes), ending with a `compaction` row or a notice that nothing changed; the app's New thread for such a thread sends it. Hermes cannot stop a compression, so Stop (`session.interrupt`) ends the turn at once, with a notice that Hermes goes on with it, and nothing is sent to Hermes; the `compaction` row (or a notice) still comes when Hermes is done, and a message sent meanwhile waits for it (a status line says so; Stop ends it without Hermes hearing of it). What another of Hermes's apps says in the conversation (Hermes Desktop, a terminal: each runs it in a Hermes process of its own, so no event of it comes) is taken in when Hermes says its sessions changed (`sessions.changed`) and as a device resumes the thread, once it is at rest: where Hermes's stored copy stands (its latest segment and message count, `session.list` `{title}`) is compared with what the bridge last read (unknown for a Bot Chat the bridge just made, or when Hermes could not say as the thread was opened); when it moved, the bridge reads the conversation from Hermes, and a copy that is the one it last read with only the messages the bridge gave Hermes since and what their turns said is Hermes writing those turns down, taken as nothing new; a look a turn of the bridge's own overtakes is given up and made again with the next change; when another app moved it (any copy the bridge cannot account for so), the bridge puts what it read in place of its own (the list's preview and order follow when it grew) and tells every device that holds the thread to take it again (`session.invalidated`, feature `session_resync`). An app without the feature reads no `ongoing` and lists the thread as any other |
| `history_pages` | Feature: param `limit` of `session.resume`, keys `history_start` and `has_earlier` of its result; method `session.history` | A long conversation (an ongoing one, `bot_chat`) opened at its end and read back a page at a time as the person scrolls up. `session.resume` with `limit` (turns, at most 200) answers with only the conversation's last `limit` turns, a turn beginning at a message of the person's (a steered message is no turn's start), `history_start` the index of its first message in the whole conversation, `has_earlier` whether there is more before, and `replay_base` (also without `replay_epoch`); a replayed answer (`resume_replay`) is as before. `session.history` `{session_id, before, limit?, replay_epoch, replay_base, profile?}` answers `{messages, start, has_earlier}`: the `limit` turns (30 when not said, at most 200) before message `before` of the conversation, stored messages as in a resume answer, `start` where they begin. For a thread the bridge has loaded, whose conversation is the one the device took (`replay_epoch` this run's, `replay_base` the session's now, not a thread only read, `before` within it); otherwise `{"moved":true}`, and the device takes the thread again with a resume. -32602 for a `before` or `limit` below what they may be. The app asks for 30 turns, the last turns it holds plus 30 when it resumes again (at most 200), and the page before the first it holds when the top of the thread comes into view, keeping the place on screen. Hermes rejects `limit` |
| `git_status` | Feature: methods `git.status` and `git.diff` | What a thread's repository holds uncommitted, for the panel over a chat. `git.status` `{session_id, profile?}` answers `{"repo":false}` outside a repository; `{"repo":true,"git":false,branch,commit}` from git's own files where no git runs without asking to install anything; otherwise `{"repo":true,"git":true,root,branch,commit,upstream,ahead,behind,files,total,added,removed}`, at most 300 of `total` files, each `{path,status,from?,staged,added,removed}`, `added` and `removed` null for a binary file and one too large to count. `git.diff` `{session_id, profile?}` answers `root`, `total` and `files` as listed, each with its unified diff, staged and not together, a file git does not track yet as all added; a file's diff that does not fit in 512 KB in all, or that git could not give, is left out (`cut: true`, `diff` empty), and those after it that fit still come. A read runs no hook, writes no index, fetches nothing and blanks the filters the repository's own config sets; each git has 15 s (bridge/src/sessions/gitStatus.ts). |
| `usage_read` | Feature: method `usage.read` | `{session_id, profile?}` (or `{agent, profile?}`, feature `agent_programs`): how much of the plan the thread's agent has used, what `/usage` says, as data for the panel. `{"available":false}` for an agent that cannot say; otherwise its `plan`, `title` (the plan as people name it, "Claude Max"), each window (`name`, `percent`, `resets_at` in Unix seconds, `reached`, `window_seconds` where known, and `heard_at`, in milliseconds since 1970, for a window kept from an earlier answer or reported by a turn since this one), `heard_at` for limits not asked of the agent just now, and a `note`. An agent is asked at most once a minute, whoever asks, an answer it could not give standing for that minute too. Claude Code with none running is started to ask at most every ten minutes while it reads the limits; after an answer without them, a minute later, then after 2, 4, 8 and 10. Past a window's reset an answer held or kept no longer says what it said of that window. |
| `open_on_host` | Feature: methods `host.apps` and `folder.open` | `host.apps` `{}` lists the apps on the host a thread's folder opens in (the Finder, the editors and terminals installed), each an `id`, a `name`, its `kind` (files, editor, terminal) and its `icon`, a 64-pixel PNG in base64, where one could be drawn. `folder.open` `{session_id, app, profile?}` opens the thread's own folder in one of them on the host's own screen, or refuses with why; never a path a device names (bridge/src/openers.ts). |
| `steer_withdrawn` | Feature: key `withdrawn` of a `status.update` | A message handed to the running turn (`message.steered`, or `queue.changed` `steered`) that a Stop took back before the agent read it, so it was never sent: Claude Code would otherwise run it once the turn had stopped, as a turn of its own, and is asked to take back with the Stop what it has not read yet (`interrupt` with `cancelQueued`). Told as a notice, `{"kind":"warn","text":"Stop took back a message before the agent read it, so it was not sent: “Then say banana.”","withdrawn":{"text":"Then say banana.","message_id":"4F1C…"}}`: `text` the message as stored, `message_id` the id its device gave it (`turn_messages`), when it gave one. The app takes the message out of the turn it was shown in, and the device that sent it puts it back in its composer, with what it had attached where it still has that, before anything written there since, and says so in a line of its own in place of the notice; other devices show the notice. An app without the feature shows the notice, which quotes the message whole, and keeps the message in the turn. The conversation no longer has it (a resume, a restart: Claude Code never stored it). A message the agent had read already stops with the turn, as before. Other agents take none back |
| `agent_programs` | Feature: methods `programs.list` and `program.update`; param `agent` of `usage.read` | Settings > Agents: each host's agents' programs. `programs.list` `{}` answers `{"programs":[…]}`, one for each that is installed or has an agent on the host (Hermes only where the host runs it): `id` (`claude`, `codex`, `cursor`, `droid`, `pi`, `opencode`, `hermes`), `name`, `installed`, `version` (null when it did not say), `standing` (`tested`, `newer`, `untested`, `too old`, `missing`), `tested`, `minimum`, `how` it was installed (`own`, `npm`, `homebrew`, `app`, `other`, null when it is not), `can_update`, `command` (what updates it, or what to run on the host where the host cannot), `latest` and `update_available`, only where a release could be found from what updates this installation (Claude Code's own installer, its `autoUpdatesChannel`; an npm install, `latest`), an answer from another source being left out until the next round asks, `agents` (the agents on the host it runs), `takes_effect` (when threads at work move to a new release: `next_start`, as their process next starts; `service_restart`, as a service that stays up restarts, Codex's daemon, OpenCode's server; `gateway_restart`, as Hermes's update restarts its gateways), `running_version` (what such a service runs, where that is not `version`) and `update`, the last update known, one under way or that ended while the host was down taken up from its record: `state` (`running`, `done`, `failed`), `started_at`, `ended_at`, `from`, `to`, `timed_out`, `line` (the last thing it printed, while it runs), `tail` (the end of what it printed, once it failed), `unattended` (running with nothing to hold it to its time, its own process having gone), `cannot_tell_file` (its record cannot be read, or it is past its time with nothing to prove what is left is its own: the file a person may remove on the host, sure it is not running). A version is read at most once a minute. Hermes's `--version` looks for updates of its own, so it is read at most once an hour, the host's own read at its start included, and with `updates.check` false not at all, but after an update someone asked for: `version` is what the host knows, null until then. The latest releases are asked for at most every eight hours, as this is asked, not at all with `updates.check` false; what cannot be found is left out. Only absolute folders on the host's PATH are looked in. `program.update` `{program}` starts the program's own update command, chosen by the host from a fixed list by where its files are, and answers at once with `{"program":…}`: never a command from the device, one at a time per program (asked again while one runs, it answers with that one), and `-32602` with a sentence naming what to run for an installation the list does not know. An update runs in a process of its own, with its time limit, and goes on through a restart of the host. Its record is the lock: only that process writes it, a successor is a new record only one can create, and the next host reports it and starts no second. The updater cannot start until its record names it. Time alone frees nothing: the lock holds until the record says it ended, or both its process and the updater's group are gone by their identity (number and start time). A record that cannot be read holds too. With its process killed and the updater still running, the update stays `running` with `unattended`, and past its time the host ends the group only if it can prove it is the same process. It ends by itself after 10 minutes (Hermes 30) and counts as failed; one that failed or ran out of time is over only once what it started has gone, so that a retry cannot overlap it. It runs without what is the host's, a thread's or an agent's sign-in in its environment (a package manager's own stays), and what it prints has its terminal formatting taken out and is then masked before a device sees it. Afterwards the version is read again and the host goes by it without a restart. Nothing is stopped or restarted by it, so threads at work keep their release until `takes_effect` says, except that Hermes's own update (`hermes update --yes`) restarts its gateways, and with them its bots. A device follows an update by asking `programs.list` again. `usage.read` `{agent, profile?}` is `usage.read` for an agent rather than a thread, under the same once-a-minute limit. A Hermes thread on another model provider than its bot's default keeps its own answer, read from the same one call to Hermes a minute. |
| `usage_history` | Feature: method `usage.history` | Settings > Usage: what all coding on the host spent, read from each agent's own history files (Claude Code, Codex, Pi and Droid; docs/plans/2026-11-06-token-analytics.md). `usage.history` `{from, to}`, days as `"YYYY-MM-DD"` in the host's time zone, inclusive, at most 400 of them (else `-32602`), answers `{"time_zone":"Europe/London","agents":["claude","codex","pi","droid"],"scan":{…},"days":[…],"hours":[…],"limits":[…],"prices_at":1762400000000}`: `agents`, those whose history the host reads; `scan`, `scanning` while the host reads all of history the first time, `progress` from 0 to 1 while it reads, and `scanned_at` (milliseconds since 1970) once a read has ended; `days`, a row for each day, agent, `model`, `folder` ("" when the agent did not say) and `via` (`portals` for a session the host ran, from when it ran it, or a Codex session Portals started; `elsewhere` otherwise), with `input` (neither read from the cache nor written to it), `output`, `cache_read`, `cache_write`, `cache_write_1h` (of `cache_write`), `reasoning` (already inside `output`), `requests` and `usd`, what the tokens cost at API prices of now, LiteLLM's list, null for a model the table does not have; `hours`, each day's tokens by hour of the host's day (24 numbers, every type added once), by agent and `via`; `limits`, each reading of a plan's window the host kept those days (`at` in milliseconds, `agent`, `name`, `percent`, `resets_at` in Unix seconds or null, `window_seconds` where known): every answer an agent gave to `usage.read` or `/usage`, what Claude Code and Codex said by themselves as their turns ran, and one asked every 15 minutes while a thread runs, through `usage.read`'s once-a-minute path, a reading the same as its window's last left out, 90 days kept; `prices_at`, when the price table was fetched (null with none). The totals are the host's: they stay when an agent deletes old transcripts, and nothing leaves the host. |
| `usage_telemetry` | Feature: method `usage.telemetry` | Settings > Usage: each host's switch for the anonymous daily totals it sends (README, "Anonymous usage totals"; docs/plans/2026-11-06-token-analytics.md, section 6). `usage.telemetry` `{}` answers `{"enabled":true,"locked":null,"last_sent_day":"2026-11-05"}`: whether the host sends them, `locked: "env"` when `DO_NOT_TRACK` (anything but `""` or `0`) or `PORTALS_TELEMETRY=0` in the host's environment keeps them off whatever the switch says, and the last day the stats server took (null before any). `{enabled}` sets the switch first, `"telemetry"` in the host's `config.json`, every other key kept, and answers the same; turned off, the host lets go of what it counted for days not sent yet. A `config.json` that cannot be written answers `-32603` with a sentence. |
| `tell_starters` | Feature: method `thread.report`; key `tells_starter` of `thread.start`'s answer; params `from`, `sender`, `origin` and `sent_by` of `thread.wait`, and `notice` of `thread.send` | A thread started through the fleet tells the thread that started it when it finishes a turn, fails or waits for an answer, with a message from it ("Notice from the bridge"), unless that thread waits for it or it reported itself (`thread.report`). Under `thread.wait` below |
| `update_notice` | Feature: key `latest` of `gateway.ready`'s `bridge` block and of the `sessions.activity` result | `"latest":"0.3.1"`: a later version of portals-host than the bridge's own (`version`) is out, only while there is one: absent when there is none, when the bridge has not heard, and with `updates.check` false in its config.json. Nothing updates a bridge by itself (TestFlight and the App Store update the app), so the bridge asks npm's registry for the version tagged latest (`GET https://registry.npmjs.org/portals-host/latest`, of which it reads only `version`) as it starts and about once a day after, never more often, across restarts too (`state/update.json` keeps when it last asked and what it heard); offline, or on any error, it says nothing new and asks again a day later (bridge/src/updates.ts, since 2026-10-29). Versions are compared as semver orders them, a pre-release before its release. As one comes out or goes (the registry's latest moved back), a connection that asked for `poll_now` is told with `poll.now`, and its poll's `sessions.activity` answer says it; another learns it as it connects or polls. The app takes it only from a bridge that lists the feature, and only a version's characters (at most 40, beginning with a digit: `BridgeWire.laterVersion`), and shows it for that host (`HostUpdate`): on the host's row in Settings, in its page with the command in a box to copy, and as "Update available" in the sidebar's footer beside Settings, which opens the same. The command is `npx portals-host@latest update`, on a Mac and on Linux alike. `npx portals-host status` says it too (`Update:`), from `state/update.json` |
| `disk_space` | Feature: key `disk` of `gateway.ready`'s `bridge` block and of the `sessions.activity` result | `"disk":{"free":3200000000,"total":494000000000,"level":"low"}`: the free space on the volume the bridge keeps its folder on, in bytes, as an unprivileged process may use it (`statfs`'s available blocks), and its size; absent until the bridge has read it, and when it cannot. `level` is `ok`, `low` under 5 GB free (or under a tenth of a volume smaller than 50 GB) or `critical` under 1 GB (or under a fiftieth); an app reads another word as `ok`. The bridge reads it as it starts, every five minutes after (one `statfs`, never per event) and as one of its writes fails for want of space, at most once in ten seconds (bridge/src/disk.ts, since 2026-11-03). As the level changes, or the free space moves by a quarter of a gigabyte from what was last told, a connection that asked for `poll_now` is told with `poll.now`. As space first runs low (a spell that ends once there is a fifth more than the low mark again), each thread at work gets one notice, `status.update` `{kind:"warn"}`, "<host> is almost out of disk space. Agents may fail and history may not be saved until space is freed.", and each other thread the same as it next starts a turn, after `message.start`: once in each spell. A write of a thread's own that fails for want of space (its record in `threads.json`, its messages waiting, what its turns kept) tells that thread "<host> is out of disk space, so this thread could not be fully saved. Agents may fail until space is freed.", once until one of its turns' writes works again. `<host>` is the name the net goes by (`fleet.name`, else the computer's). The app shows it on the host's row in Settings: the free space, and a warning while `low` or `critical` |

**MCP sign-in** (feature `mcp_auth`). Droid threads only. `mcp.auth` requires a
followed runtime `session_id` and accepts optional `profile`:

- `{session_id, action:"list"}` lists live cards without starting a cold Droid
  process or model turn. Non-Droid threads return an empty list.
- `{session_id, action:"start", server_name}` starts a fresh sign-in, or returns
  the current active attempt unchanged.
- `{session_id, action:"submit", server_name, auth_id, code}` accepts a bare code
  or full final redirect URL. The host extracts exactly one nonempty `code` query
  parameter and validates any supplied `state` against its own held state. It
  sends only the extracted code and host-held SDK state to Droid.
- `{session_id, action:"cancel", server_name, auth_id}` cancels that attempt.

All actions return `{servers:[{auth_id,server_name,status,url?}]}`. `auth_id` is
random and opaque, not OAuth state. Status is `required`, `starting`, `waiting`,
`completed`, `cancelled` or `failed`. Only `waiting` includes a validated HTTPS
`url` (no credentials or fragment). A required card exposes no URL before Start.
Start returns immediately, while Droid waits for the browser. A successful host
localhost callback completes automatically; a phone can paste the browser's
final address or code instead. Submission stays waiting until Droid completes.
The app names the server and URL host before offering Open sign-in.

Numbered event `mcp.auth` has payload `{}` only, an invalidation that asks the app
to call List. No auth data is in replay. Cards and URLs exist only in memory and
live RPC results, never conversation history, logs or push. A ten-minute deadline,
Cancel or process loss clears URL and SDK state; terminal cards remain in memory
until unload/restart or a new attempt. Reconnect replaces cards with a fresh List;
disconnect clears them. The process stays warm during starting/waiting.

Unfollowed threads return `4001`. Invalid actions/fields, stale attempts, bad codes,
read-only mutations and unsupported providers return `-32602`. SDK errors return
generic `-32603` text, never raw SDK errors or authentication input. Completion
uses the request-correlated authenticate result: SDK completion notifications have
no attempt id, and cannot safely settle a newer attempt. A retry waits until the
previous authenticate RPC has settled. The SDK's `requiresAuth` can remain true
even on an authenticated, connected server.
Only a refused Start/Try again while that previous RPC is settling adds
`error.data:{"reason":"settling"}` to its `-32602` response. Other errors never
carry that reason.

The app uses the owning host's normal connection, including a linked host; no
relay OAuth endpoint or callback service is added. The OAuth URL's own query state
is allowed on the person's device; the separate SDK state is never exposed.
Old apps ignore the event and retain the host-sign-in notice. New apps send no
method or show controls unless the bridge advertises `mcp_auth`.

**Late message acceptance** (feature `message_reconciliation`). A client opts in
with `client.capabilities` `{"message_reconciliation":true}`. A failed handoff's
`message.complete` has `failed_request_id`; its stored `failed_turn` assistant row
keeps that id in `display_metadata.failed_request_id`. If the provider later accepts
that exact request in a running turn, `message.taken` removes only the failed
turn with that id. Its payload is `{"request_id":"…","replay_base":42,"removed_start":10,"removed_count":2}`.
`replay_base` is the new replay base, established before this event. `removed_start`
and `removed_count` name the deleted range of stored messages in the previous
history, not turns. They allow a follower to update its replay base and subtract
only deleted messages before its `history_start` from that cursor.
Portals instead uses the existing authoritative-resync path for paged conversations,
requesting full history without a `limit`: the UI may already hold an earlier
page behind a drag. The full snapshot cancels pending page answers and makes
the UI's first-turn guard reject already-returned stale pages.
Disconnected followers also take the normal canonical snapshot.
The following `message.steered` has `reconciled:true` and the
original `message_id`, when supplied. It adds that message to the running turn,
without reopening the failure or replacing the active turn. No words are matched.
Capable clients receive no bridge invalidation for this repair; Portals initiates
the full refresh itself for paged conversations. Nonpaged conversations keep the
narrow live repair. Older clients still take the authoritative snapshot below;
new clients on older bridges change nothing.
The bridge rebases replay for the repaired canonical transcript, so a disconnected
client takes a full snapshot rather than replaying stale failures.
If the receipt arrives between turns (for example, buffered before the process
stopped), it repairs closed history instead. All clients take an authoritative
snapshot; no `message.steered` claims a turn is running.

**Authoritative corrections** (feature `session_resync`). A client opts in with
`client.capabilities` `{"session_resync":true}`. A normal numbered event
`session.invalidated` has `{"replay_base":42}` (a nonnegative integer): the bridge
corrected text already streamed, so additive replay cannot repair the conversation.
It repairs its state and rebases its event log before sending the event. The client
holds later frames and requests a full `session.resume` without `since`, then
replaces its canonical conversation and applies only frames after the response's
coverage boundary described above. A `session.invalidated` that arrives while a resume
of the thread is under way waits with the other frames and is measured against what
that resume brought. Only such a snapshot replaces what was streamed (the app's
`ThreadSnapshot.authoritative`): the refresh an invalidation asked for, a whole answer
covering one, or one whose `replay_base` moved on in the run the thread was opened in
(a repair missed while away). An ordinary open, catch-up or reconnect keeps the detail
the app saw live, and even a repair keeps what only the app recorded (approvals and
answers given there, notices). A second invalidation after that boundary requires
another full resume; one already covered by the snapshot does not.

The snapshot preserves the running turn, stored tools, queued messages and open
request ids. Optional `inflight.reasoning` preserves the uncommitted thought text (for
`session.resume` only: the fleet's `thread.read` leaves it out).
With `message_ids` the stored user rows and `inflight` echo `prompt.submit`'s
`message_id` while the session stays loaded, so a failed or uncertain local send is
acknowledged by its id, never by matching text; from a host without it the app falls
back to its words. Clients retain local pending/failed sends and attachment data until
their outcome is known.

A follower that has not opted in is disconnected with WebSocket code **1012** and
recovers through its existing reconnect/full-snapshot path. This reconnect drops
connection-staged uploads on the bridge; an upload not yet submitted must be recoverable
from the client's local journal. Turns, tools, queued messages and request ids belong
to the session and survive the disconnect. Ordinary output continues streaming.

**Subagents and workflows** (feature `subagents`; `bridge/src/providers/claude/tasks.ts`,
`bridge/src/providers/codex/agents.ts`, `bridge/src/sessions/session.ts`, the app's
`SubagentsLine.swift`). Claude Code's subagents (the Agent tool, in the foreground or the
background) and workflows (the Workflow tool), and Codex's sub-agents (each a thread of
its own, from the parent's `subAgentActivity` items, or its `collabAgentToolCall` items
on a model with multi-agent v1), are kept by the thread's session for as long as the
bridge runs, also once they have ended. Background commands and watchers are not agents
and are left out. A Codex sub-agent's `goal` is its path (`pear reply` for
`/root/pear_reply`): its thread keeps no message of what it was asked. Its `result` is
the last thing it said there. With `subagent_names`, it also has the `nickname` and
`role` Codex gave it (`Darwin`, `worker`; from its thread as `thread/started` and
`thread/read` give it; Codex's `default` role, for one spawned with none, is left out), and a Claude subagent its type as its `role` (`Explore`,
`general-purpose`). A subagent's own subagents are on the line of the thread too, each
with its own Stop: Codex's as Codex starts them, Claude Code's as it reports them; with
`subagent_names`, such a one has `parent_id`, the subagent that started it (Claude
Code's `parent_task_id`, a Codex thread's `parentThreadId`), when that one is known
here. The app shows it under its parent, set in, and names the parent in its detail.

- Each change is an event with everything known of it now: `subagent.start` when it
  starts, `subagent.progress` while it runs, `subagent.complete` once it has ended (and
  again when more is said of it then, such as its reply). The payload, also each entry of
  `subagent.list`:
  `{"subagent_id":"wwn9e3l29","kind":"workflow","goal":"Two agents reply in parallel","name":"tiny-check","status":"running","turn":3,"started_at":1791975259.7,"background":true,"can_stop":true,"tokens":15824,"phases":[{"index":1,"title":"Check"}],"agents":[{"id":"1","label":"apple","phase":"Check","model":"claude-haiku-5-5","status":"completed","tokens":15824,"tool_uses":0,"duration_s":3.19,"result":"apple"},{"id":"2","label":"pear","phase":"Check","status":"running"}]}`.
  `kind` is `agent` or `workflow`; `goal` the description it was given; `name` a
  workflow's; `status` `running`, `completed`, `failed` or `stopped` (which an app
  without the feature reads as failed); `turn` the thread's turn that started it (they
  are numbered from 1 since the bridge started; one begun while none runs counts with
  the last); `started_at` and `ended_at` Unix seconds;
  `background`: it runs on after the turn that started it; `can_stop`: `subagent.stop`
  can stop it now (a running workflow or background subagent; one in the foreground is
  part of the turn, which Stop stops). A subagent may have `summary`, a line on what it
  is doing (Claude Code's progress summaries, or its line on the last tool before the
  first; once there is a summary, only a later one replaces it), `tool_name` (its last tool, section 9's name), `model`, `tokens` and
  `tool_uses`; once ended, `result`: its reply, or why it failed, at most 2000
  characters. A workflow has `phases` in order and `agents` in the order they were
  queued, each with `status` and, as they become known, `phase`, `model`, `tokens`,
  `tool_uses`, `duration_s` and `result` (the start of its reply).
- **`subagent.list`**: params `{session_id, profile}`. Result `{"subagents":[…]}`, every
  one the thread's agent started since the bridge started, oldest first, running or not.
  Only for a thread loaded here; `[]` otherwise. A thread loaded again after the bridge
  restarted lists too the ones its stored conversation tells of, numbered by turn back
  from 0, its last turn before the restart: for Claude, the Agent and Workflow calls and
  Claude Code's `<task-notification>`s, all ended, a workflow with the phases, agents,
  times and tokens of its journal (`<session>/workflows/<run>.json`, which Claude Code
  writes as the workflow ends and the Workflow call's answer names by its transcript
  folder; one cut off before it was written, as a restart of the bridge stops the
  workflow's process, has the agents and phases of the log Claude Code keeps as it goes,
  `<transcript folder>/journal.jsonl`, those with no answer stopped); for Codex, the sub-agent items of its stored turns, where one left at work is
  settled by its own thread's last turn (it may still be at work: Codex's sub-agents run
  in Codex, not in the bridge; a last turn left in progress in a thread Codex no longer
  runs was cut off, and the sub-agent is `stopped`). When the connection to Codex comes
  back, a Codex sub-agent thought to be at work, or one that ended in the last 30
  minutes (it may have been given more to do meanwhile), is settled the same way, a few
  at a time. A read that catches one between two states (its thread at work with no new
  turn listed yet, or at rest with its last turn still in progress) is taken again a
  little later, up to three times, before an unfinished turn in a thread at rest counts
  as cut off.
- **`programs.list`** (feature `agent_programs`): params `{}`. **`program.update`**: params `{program}`, the id `programs.list` gave. See the feature's row in section 11.
- **`usage.history`** (feature `usage_history`): params `{from, to}`. What all coding on the host spent those days, by day, agent, model, folder and whether it went through Portals, with dollars, hours and the plans' limit readings. See the feature's row in section 11.
- **`usage.telemetry`** (feature `usage_telemetry`): params `{enabled?}`. Says, and with `enabled` sets, whether the host sends its anonymous daily totals: `{enabled, locked, last_sent_day}`. See the feature's row in section 11.
- **`subagent.read`** (feature `subagent_read`): params `{session_id, subagent_id, profile}`.
  What one with `can_read` did: `{"available":true,"messages":[…]}`, as the feature's row
  above says; `{"available":false}` otherwise.
- **`subagent.stop`**: params `{session_id, subagent_id, profile}`. Stops that one alone
  (Claude Code's `stopTask`; for Codex, `turn/interrupt` of the turn the sub-agent's own
  thread runs): the turn, if one runs, and the others go on, and the subagent ends
  `stopped` with `subagent.complete`. Result `{"status":"stopped"}`, or
  `{"status":"not_running"}` when it is not one that can be stopped now (ended, in the
  foreground, unknown). 4001 for a thread this connection does not follow.
- **Stop on the turn** (`session.interrupt`): the app sends `keep_background: true` to a
  bridge with `subagents`, and then Stop stops only the turn: Claude Code is started with
  `perTaskStopAffordance`, so subagents and workflows in the background run on, each with
  its own Stop. Without `keep_background` (an app from before the feature, which has no
  Stop for each, or `thread.stop`), Stop on a running turn also stops every subagent and
  workflow that can be stopped by itself, as Claude Code did by itself before, also when it
  arrives once the turn is over. A question one in the background asks has `subagent`,
  its id, in its `approval` or `clarify`; a Codex sub-agent's questions, which Codex puts
  to whoever follows the thread that spawned it, are that thread's cards with the
  sub-agent's thread id there, also for a sub-agent of a sub-agent and one whose start
  the bridge did not see. Once a device that said in
  `client.capabilities` that it keeps such a card after the turn (`subagent_requests:
  true`, which this app sends to a bridge with `subagents`) has followed the thread
  (created or resumed it) in this run of the bridge, the question stays open when the
  turn ends or is stopped with `keep_background` (it may still be answered), until it is
  answered or the subagent is stopped; in a thread only older apps have followed, the
  turn's end takes it back as before, since an older app drops every card when the turn
  ends and could never answer it; a Codex sub-agent's question taken back so is answered
  no (`decline`, or no answers), since the sub-agent works on and waits for one. The app
  keeps such a card after the turn, shows it
  with no turn running (in a snapshot whose `running` is false too), and a message sent
  meanwhile leaves it open; a card asked between turns opens no turn.
- **`subagent.cleared`** (feature `subagents_clear`): the ones that have ended leave the
  line when the next message goes to the agent, from any device: a message opening a
  turn, one steered into the running turn (as it is handed over), one that waited on the
  list (as its turn starts: one taken off the list never does), one through the fleet
  (`thread.send`, `portals send`), a no's note the bridge says for Codex, and one typed
  at the desk. Not a slash command sent as a message (`/compact`, a skill) nor the
  bridge's own (`/status`, `/mode`, `/usage`, which never reach the agent), and not a
  turn the agent began by itself (Claude Code reporting a background subagent's end).
  The event, after the turn's `message.start`, names them:
  `{"subagent_ids":["a24479d5e93836222"]}`, and `subagent.list` leaves them out from
  then on, so a device that reconnects or opens the thread later does not bring them
  back. Those still at work stay, and leave with the message after the one they end
  before. More said of a cleared one while it has ended is kept and not sent; one at
  work again (a Codex sub-agent given more to do) comes back with `subagent.progress`.
  A thread loaded after a restart leaves out the ones that had left the line while they
  have ended: the thread's record keeps the latest 64, each with the run it had come to
  where its agent says (a Codex sub-agent's turn; `subagentsCleared`), since the stored
  conversation's times cannot say it (Codex dates a message steered in and a sub-agent's
  end by their turn's). A closer look at one later (a read of a Codex sub-agent's thread,
  a sub-agent's own found after the restart) keeps it off while it is that run, ended,
  and brings back another run of it; one a restart brought back at work and found to have
  ended in that run gets `subagent.complete`, then `subagent.cleared`. One seen at work
  again, or in a run its agent names other than the one that left, is no longer kept. One the bridge never took off (for a message
  typed at the desk while it was off) stays until the next message. So does one for a
  turn typed at the desk while the connection to Codex was down, told once it is back
  (`turn_messages`): that message came before what the bridge heard meanwhile, so it
  clears nothing. A desk message Codex sends as the bridge reads the thread again is held
  until the missed turns are told; told from the read or from what was held, it clears
  the ones that had ended when it came, in the run they had ended in, not one whose end
  (or a later run's) came after it.
- **`sessions.activity`** lists a thread with a subagent or workflow still running as
  `running`, also with no turn running, so the sidebar shows it at work; with
  `agent_threads`, a thread started from it still at work does too (the `activity` row).
- What the app does with it: the subagents line under the chat keeps the agents the
  latest turn that started any started, with any of an earlier turn still at work, after
  they have ended, with their times, summaries and results, until `subagent.cleared`
  takes the ended ones off; a workflow's row shows its phase
  and how many agents run and are done, and opens its phases and agents. A running one
  with `can_stop` has a Stop. An agent with a `nickname` is called by it and its role
  ("Darwin · worker"), its goal in its detail; a `role` alone shows in the detail. Since
  2026-10-26 that line is one with the threads started from the thread (`agent_threads`)
  and its background commands (`background_commands`), in parts in that order: subagents,
  workflows, the threads, the commands (`Portals/Chat/FootLine.swift`, AgentCore's
  `FootLine`). A thread whose only work left is a command is finished in the app as
  `sessions.activity` has it, while the command's row stays live.

**Looks** (feature `agent_looks`; `bridge/src/looks.ts`, the app's `LookSync.swift`). An
agent's avatar is three whole numbers the app reads from its own lists (`AgentLook`: a
body `shape`, a resting `face` and a colour, `tint`) and, for a coding agent, whether it
shows its maker's logo instead. Without the feature each device keeps its own, and the
same agent is drawn differently on a phone and on a Mac. With it the bridge keeps the
look, in `state/looks.json`, and draws nothing itself.

- A look is kept with its `origin`, who decided it: `chosen` by the user by hand, or
  `assigned` by an app to tell agents apart. A chosen look is replaced only by another
  chosen one.
- **`looks.list`**: params `{}`. Result
  `{"list":{"id":"9c1e04b7a2d35f68","revision":14},"looks":[{"agent":"claude","shape":1,"face":2,"tint":3,"shows_logo":false,"origin":"chosen"},{"agent":"codex","shape":5,"face":0,"tint":8,"origin":"assigned"}]}`:
  every look the bridge keeps, by agent name (the profile's `name`), always whole: they
  are few and small. `shows_logo` is left out when nobody chose, which shows the logo.
  An agent with no look kept is not listed. `list` is the id of the bridge's list of
  looks and its revision, which goes up by one with every change.
- **`look.set`**: params `{profile, shape, face, tint, shows_logo?, origin?, unless?}`.
  The three numbers are whole, from 0 to 999; `origin` is `chosen` when left out;
  `unless` names when the bridge leaves the look it has: `any` when the agent has any
  look, `chosen` when it has one that was chosen. Whatever `unless` says, an `assigned`
  look never replaces a chosen one. Result
  `{"list":{…},"look":{"agent":"claude",…},"taken":true}`: the look the agent has now,
  which is the one to draw, and whether it is the one sent. -32602 with a sentence for
  an agent the bridge does not run, a number out of range, or an `origin` or `unless` it
  does not know.
- **`sessions.activity`** carries `"looks":{"id":"9c1e04b7a2d35f68","revision":14}`, so a
  device that polls it learns of a change within one poll and asks `looks.list` again
  when the id or the revision is not the one it took last. The id is new when the
  bridge had no `state/looks.json` to read, so a device asks again then too.
- What the app does with it (`LookStep`): it draws each agent as the bridge has it. It
  sends a look when the user chose one on that device (no `unless`: it replaces whatever
  the bridge has); when the bridge has none for the agent (`unless: "any"`, so of two
  devices that meet a new agent the first one's look is everyone's); and, once, when it
  holds a choice made before the bridge kept looks and the bridge has only an assigned
  one (`unless: "chosen"`). A look the bridge keeps is never changed by the app's own
  giving of looks (`AgentLook.assign`), which still gives a new agent one that differs
  from the others the device shows before sending it.
- The bridge keeps a look for an agent it no longer runs, which has it again when it is
  back. Linked Macs each keep their own agents' looks.

**The sidebar's order** (feature `sidebar_order`; `bridge/src/order.ts`, the app's
`SidebarOrder.swift`). The user can put a bridge's agents and its folders in an order of
their own in the sidebar. Without the feature each device keeps its own order. With it
the bridge keeps two lists, in `state/order.json`: the agents by profile `name`, and the
folders by their real `path`. It arranges nothing itself: `profiles.list` and
`folders.list` answer as before, and the app puts the rows in order. Threads are not
arranged: pinned ones first, then the most recently active.

- **`order.list`**: params `{}`. Result
  `{"list":{"id":"4be07c1d9a2f6e35","revision":3},"agents":["codex","claude"],"folders":["/Users/dev/notes","/Users/dev/coding_projects/app"]}`:
  both lists, always whole. `list` is the id of the bridge's order and its revision,
  which goes up by one with every change. An empty list is no order: the agents as the
  bridge lists them, the folders by when each was last worked in.
- **`order.set`**: params `{agents?, folders?}`, each a list of strings that replaces
  the one the bridge has; a list left out stays as it is, so a device sends only the one
  it arranged. A name given twice is kept once, where it came first. Result: as
  `order.list`, both lists as they are now. -32602 with a sentence when neither is
  given, or for a list of more than 500 names, an empty name or one over 4096
  characters. The bridge does not check that a name is an agent it runs or a folder it
  offers: a name stays on its list while the agent or the folder is away.
- **`sessions.activity`** carries `"order":{"id":"4be07c1d9a2f6e35","revision":3}`, so a
  device that polls it learns of a change within one poll and asks `order.list` again
  when the id or the revision is not the one it took last.
- What the app does with it (`SidebarOrder`): an agent on the list comes in the list's
  order, and one that is not comes after them, as the bridge lists it. With no folder
  list the folders are by last use, as before. With one, a folder on the list has the
  list's place and one that is not comes before them, by last use: a new folder is on
  top. Moving a row sends the whole list of that kind as the device shows it then, so
  every agent or folder listed at that moment is placed. A move made while the bridge
  cannot be reached is kept on the device and sent when it can, and until it is taken
  the device does not take the bridge's list of that kind. Linked Macs each keep the
  order of their own agents and folders.

**The Macs' order** (feature `machine_order`, with `sidebar_order`; `bridge/src/order.ts`,
the app's `MachineOrder`). The user can put their Macs in an order too. No one bridge
owns that order, and each device gives a Mac an id of its own, so:

- Each bridge gives itself an id once, sixteen hex digits kept in `state/machine.json`,
  and says it in `gateway.ready`: `"machine":{"hostname":…,"home":…,"id":"7d2a41c09be36f58"}`.
  It stays the same whatever the Mac is called on its network. The app keeps it with
  the host (`HostConfig.machineID`).
- The order keeps a third list, `machines`, the Macs by those ids, with `machines_at`:
  when they were arranged, in milliseconds since 1970 by the clock of the device they
  were arranged on. Both are in what `order.list` and `order.set` answer; `machines_at`
  is 0, and the list empty, while the Macs were never arranged.
- **`order.set`** takes `machines` with `machines_at` (-32602 with a sentence for the
  list without the moment, or a moment that is no whole number above zero). The bridge
  keeps the order given only when it was arranged later than the one it has (of two
  arranged at the same moment, the one whose ids come later joined by line breaks), and
  answers with the one it keeps, which is the one to go by. So every bridge keeps a
  copy, and whichever device tells a bridge last, the order arranged last is the one
  every bridge ends up with.
- What the app does with it: it goes by the newest order it knows of, its own or any
  of its hosts' copies, and lists its Macs by it; a Mac that is not on the list (one
  whose bridge gives no id) stays where the device has it. A host whose copy is older
  is given the newer one. Moving a Mac arranges the device's Macs anew: the ids as it
  lists them then, a Mac it does not have kept after the one it followed, at a moment
  later than the order replaced, whatever the device's clock says. A bridge without
  the feature is given nothing, and the order is then the device's own.

**`desk.list`** (feature `desk_sessions`). Params `{profile, limit?}`; `limit` is a whole
number of at least 1, 40 when absent. Result:
`{"sessions":[{"id":"6d3c…","title":"Fix the login","folder":"/Users/dev/coding_projects/app","updated":1791324000,"state":"open"},…]}`,
newest first, at most `limit`.

- Only sessions that are not threads of the bridge's own already (its registry), in a
  folder that exists and is not temporary (`/tmp`, `/private/tmp`, `/var/folders`, unless
  it is the General folder or under it), the bridge's own or hidden in its config.
- `id` is the agent's own session id (Claude Code's session, Codex's thread, Pi's
  session, Cursor's chat); `title` one line: Claude's custom title, summary or first
  prompt, Codex's thread name or first message, Pi's name for the session or the first
  line of its first message, Cursor's title for the chat (empty when it gave none);
  `folder` the real path; `updated` Unix seconds.
- `adopt_modes`, optional: the ways the session can be taken up (`session.adopt`
  `mode`), when not all those its agent lists in `profiles.list`. Cursor's chats have
  `["fork"]`. The app offers only those; an app before it asks to continue, is refused
  with a sentence saying to fork, and offers the fork then.
- `state`: Claude Code `open` (a terminal, or Claude Code in the background, has it:
  `claude agents`) or `closed`; Codex `running`, `waiting` (on an approval or a
  question), `idle` (loaded, nothing running) or `closed` (not loaded); Pi `open` (a Pi
  runs in a terminal in the session's folder, and may have it: Pi does not say which
  session a terminal has) or `closed`. The app reads an unknown state as `idle`.
- Pi's sessions are read from its session files (`~/.pi/agent/sessions/`), as it has no
  command that lists them: every session with a message in it, whoever started it, that a
  thread could open by its id in its folder (`bridge/src/providers/pi/desk.ts`). A copy
  the bridge made (`fork`, below) is not among them.
- Cursor's are the chats of its terminal (`~/.cursor/chats/`), each with a conversation
  and its folder in its `meta.json`, not a subagent's (`bridge/src/providers/cursor/desk.ts`),
  all `closed`: Cursor does not say whether a terminal has one open, and a chat is only
  forked.
- An agent without desk sessions answers `{"sessions":[]}`.
- A bridge with `thread_sync` also lists the agent's threads taken off its list
  (`thread.delete`) that the agent's own list lacks, as `closed`, with the folder the
  thread had and the time of its last turn: every one of an agent without desk sessions
  (Hermes), Claude Code's threads started from a device (its list leaves out sessions
  started through its SDK), and any other the agent leaves out. A removed thread has the
  title it had, also where the agent lists it. Each is offered for good, until it is
  taken up again, except one that never had a message, which leaves nothing to take up,
  and one the agent has deleted since (Claude Code deletes sessions older than its
  `cleanupPeriodDays`; a Pi session is deleted by deleting its file).

**`session.adopt`** (feature `desk_sessions`). Params `{profile, session_id, mode}`, the
last two required; `mode` is `continue`, `fork` or `read`. Answered like `session.create`
(`{session_id, stored_session_id, info}`), and the connection follows the thread. The
thread is then like any other (resume, replay, approvals, push), kept in the registry
with origin `desk`, and no longer in `desk.list`.

| Mode | Claude Code | Codex | Pi |
|---|---|---|---|
| `continue` | The thread is the session, resumed by its id. Refused (-32602, with a sentence) while a terminal has it open: resuming it would write behind that terminal's back. Each time Claude starts for it again, it is checked once more, and the turn ends with that sentence as its error if a terminal has it | The thread is joined live on the shared daemon, even while a terminal has it: an approval the terminal is waiting on comes to the app too, and answering it there closes the terminal's dialog | The thread is the session, opened by its id in its folder. Refused (-32602, with a sentence) while a Pi runs in a terminal in that folder, which may have it open, when the Mac cannot be asked, and when the folder has since become a link to another (Pi would not find the session from there). Before every turn of the thread the Mac is asked once more, and the turn ends with that sentence as its error while one does, or with one saying the Mac could not be asked; nothing is written for such a turn, and a title, model or level given meanwhile (`session.rename`, `config.set`) is kept for the next turn. A turn also ends with a sentence, and no Pi is started, when the folder has become such a link since the session was taken up. A message sent while Pi works for the thread is taken as usual |
| `fork` | A copy of the session with its history, under a new id (`session_id`); the original is left alone | `thread/fork`: a new thread with the history so far | Pi's own `--fork`: a copy with the history so far, under a new id that starts `fork-`, in the same folder. Its turns run also while a Pi is in that folder's terminal, and taken off the list it is taken back without being asked about: the copy is the bridge's own |
| `read` | The thread shows the session's history (read again at each `session.resume`) and takes nothing: `prompt.submit`, `image.attach_bytes` and `config.set` answer -32602 with a sentence saying to fork it | The same; the thread is never joined | The same; no Pi is ever started for it. While a Pi runs in a terminal in the session's folder, a tool call with no result yet has no message (it may still be running) |

Cursor's chats are only forked (`adopt_modes`): `continue` and `read` are -32602 with a
sentence saying to fork. A fork copies the chat's folder into `~/.cursor/acp-sessions/`
under a new id, the way Cursor keeps the sessions its ACP opens, and Cursor opens the copy
there and then (`session/load`): what it sends again of the conversation is the thread's
history, its title the chat's (or the first message's first line). One Cursor cannot open
is refused, with what Cursor said, and its copy removed. When the chat's store keeps Cursor's
Run Everything (a chat run with `--force`, or under Cursor's own Run Everything setting), so does the copy, and Cursor then searches the
web and fetches pages for the thread without asking: the thread says so in a `warn`
`status.update` as its first turn starts.

A session that is already one of the bridge's threads is that thread (`fork` excepted);
`continue` on a thread taken up for `read` continues it once that may be done. Refusals
(no such session, a thread with no message yet, a session open in a terminal, a session
in a folder `desk.list` offers none from, in any mode, a copy Pi could not make) are
-32602 with a sentence for the user. A Pi thread taken up runs on the model and thinking
level Pi itself comes back on when it opens the session; until its first turn `info`
shows the ones the session file last names.

A thread taken off the list (feature `thread_sync`) is taken up again the agent's usual
way, with its checks (Claude Code's refusal while a terminal has the session, Pi's while
a Pi runs in a terminal in its folder), as a thread of origin `desk`. For an agent without desk sessions (Hermes) `continue` puts the
thread back as it was, with its title, marks and preview, and `fork` and `read` are
-32602. Either way it is on the list again, in every device's `threads.changes`, and no
longer offered; a `fork` leaves the thread it copied offered. Its events are numbered on
past the `seq` the removed session had reached in this run of the bridge (section 6), with
a replay that cannot reach back before them: a device that holds one of the removed
session's numbers is told `truncated` and takes the thread whole (section 8, the row for a
session loaded again under the same runtime id).

**`session.compacted`** (feature `compaction`). An event of the running turn, with a
`seq` like any other, sent where the agent summarised the conversation so far:
`{"trigger":"manual","tokens_before":24063}`. `trigger` is `manual` when `/compact`
asked for it and `auto` when the agent did it by itself as the context filled up (the
app reads anything but `auto` as `manual`); `tokens_before`, a whole number above 0, is
how full the context was before, left out when the agent does not say. A `session.usage`
with the smaller context may follow. `/compact` is sent as a message (`command.dispatch`
answers `send`) and is a turn of its own: `message.start`, a `thinking.delta` while it
runs, this event, then `message.complete` with no text; one that fails ends that turn
with the reason. A slash command sent while any turn runs is answered `queued`, not
`steered`. So is any message sent while Codex compacts, since Codex takes none into a
compaction; one sent while Claude Code compacts is steered as usual.

The stored conversation keeps it as a message of its own after the `/compact` that
asked for it, or where the agent did it mid-turn:
`{"role":"compaction","trigger":"manual","tokens_before":24063,"timestamp":1791363643.4}`,
with `tokens_before` only when known (Claude Code's and Codex's own histories do not
keep it). The app shows it as a line in the turn ("Conversation compacted · 24k tokens
before"), which also says that `/compact` is done.

**What a turn spent** (feature `turn_usage`; `bridge/src/sessions/spent.ts`,
`bridge/src/providers/spent.ts`). `message.complete` carries
`"turn_usage":{"seconds":5,"tokens":53771}`, and the turn's last stored message (whatever
its role: the reply, a tool's, the mark of a compaction, or the message that opened a turn
in which nothing was said) the same key:
`{"role":"assistant","text":"alpha.txt says …","timestamp":1792412730.2,"turn_usage":{"seconds":5,"tokens":53771}}`.
An app without the feature reads neither. Figures from a live check (2026-10-19, haiku and
gpt-6-luna): Claude 53,771 tokens for a Read and a reply, the same read back from Claude
Code's stored session after a restart; Codex 51,277 for a command and a reply, kept by the
bridge, with Codex's 3.603 s.

**What a turn changed** (feature `turn_diff`; `bridge/src/sessions/turnDiff.ts`, the app's
`TurnDiffView.swift`). `message.complete` carries `turn_diff` (the table above), and so
does the turn's last stored message, whatever its role, as `turn_usage` does. The bridge
works it out when a thread is loaded (`withTurnDiffs` over the agent's history: each
stored turn, opened by a `user` message, gets its own, a turn still running none) and at
each turn's end. Only where the agent's history loses an edit's exact diff (Claude Code's)
does the bridge keep the diff it saw live beside it (`bridge/src/sessions/keptDiffs.ts`),
for a thread loaded again after a restart, and drop it when the thread is removed. The app shows
`3 files · +40 −12` after the time and tokens, which opens a sheet (a panel on the Mac):
the files with their counts, each opening its diff with the new file's line numbers.

**Messages sent while a turn runs** (feature `queue`; `bridge/src/sessions/session.ts`).
`prompt.submit` takes `when_busy`: `steer` (the same as leaving it out) hands the message
to the running turn where the agent can take one in, and `queue` keeps it for a turn of
its own once the running one has ended, whatever the agent can do. Anything else is
-32602. With no turn running it changes nothing. An agent that cannot take a message in
(Hermes, the fake agent), a slash command, and a message sent while Codex or Pi
compacts wait either way. Cursor cannot add a message to a running prompt: a message
handed to a Cursor turn (`message.steered`) stops what Cursor was doing, as Stop does
(cards open close with `request.cancel` `withdrawn`, rows Cursor said no end of close as
at a stop), and goes to Cursor once it has answered the stop and said nothing more of it
for 0.3 seconds (at most 3), in the same turn; what Cursor says meanwhile is left out. A
Stop before it went ends the turn, and it is not sent. A message that waits is answered
`{"status":"queued","queue_id":"3"}`: its id on the thread's list of messages waiting.

The list is the bridge's, so every device shows the same one, and it is kept on disk while
any wait (`state/waiting/`): messages waiting when the bridge stops, or is stopped, have
their turns, with their images and files, once it starts again. A message leaves the disk
once its turn has been handed to the agent, so a bridge that stops in that very moment may
lose it rather than send it twice; a list that cannot be written takes the thread's file
with it, and its messages then last only until the bridge stops. It is sent
whenever it changes, as the event `queue.changed`:
`{"queued":[{"id":"3","text":"Then run the tests."},{"id":"4","text":"[Portals: from Claude Code (thread 6d3c…)]\nStatus?","fleet":true}],"can_steer":true}`.
`text` is the message as stored (`@image:` lines, the list of its files); `fleet` marks
one another thread or agent sent through the fleet; `message_id` is the id the device
that sent it gave it in `prompt.submit` (`message_ids`), when it gave one; `can_steer`
says whether the agent can take a message into a running turn at all. The `session.resume` result carries
`queued` and `can_steer` while any wait, and leaves both out while none do. When a
waiting message opens its turn, that turn's `message.start` carries its `queue_id`, and
the `queue.changed` without it follows the start, so a device that sees it leave the list
has opened the turn with it already. Until that start it stays listed, also in a
`session.resume` answered meanwhile, and can no longer be taken off or steered.

A message sent with no turn running while the bridge catches up with a Codex thread
after its connection to Codex dropped (until it has told the turns missed meanwhile)
waits on the list too, answered `queued`, so its turn comes after those. When the
connection to Codex is still down about 15 seconds after it began to wait (as long as a
call waits for Codex), or drops again after that before the bridge is back in step, it
fails: its turn opens with `message.start` (with its `queue_id`) and ends at once with
`message.complete`
`{"status":"error","text":"Codex is not reachable right now. The message was not sent.","error_surface":{"retryable":true}}`,
the `queue.changed` without it follows, it leaves the list on disk, and it is never sent.
The messages waiting behind it fail with it, a turn each, in the order sent; one steered
in and turned down, said again in a turn of its own, waits on. The app shows each as a
failed turn with Try again, the stored conversation keeps it (`display_kind`
`failed_turn`), and `thread.wait` answers `error` with that sentence. Codex never had it,
so its history does not either: the bridge keeps the latest 20 such messages of each
thread in its file of messages waiting (`state/waiting/`, as
`{"failed":{"text","error","at","turn"}}` after those waiting, which a bridge from before
skips), written in the one step that takes them off the list there, so a bridge stopped
at any moment neither sends nor loses one; and a thread loaded again, after a restart
too, has each where it showed: right after Codex's turn it showed after (`turn`: Codex's
id for the latest turn the bridge had shown when it failed, null before any; a turn
missed at the desk and told after the failure comes after it, as it did), in the order
they failed, so a device that held the thread finds its turns in the same order and the
thread's latest is what it was; by time when that turn is no longer in Codex's thread
(before the first of Codex's turns begun in the second it failed or later: Codex times
turns in whole seconds); always before a turn Codex still runs. When that file cannot be written, the message does not fail and waits on, as it
did before. Back on its
connection and reading the thread, Codex can be reached: a message waits for that read
however long it takes. One waiting behind a running turn, also one missed at the desk and
told meanwhile, is timed afresh once that turn has ended with the bridge still catching
up. Such a turn takes nothing off the subagents line (`subagents_clear`): the agent never
had the message.

| Method | Params | Result |
|---|---|---|
| `prompt.queue.remove` | `session_id`, `queue_id`, `profile?` | `{"removed":true}`: the message is off the list and is never sent. `false` when it was not waiting any more |
| `prompt.queue.steer` | `session_id`, `queue_id`, `profile?` | `{"status":"steered"}`: the running turn has it, it is stored there (`display_kind` `steer`), and the `queue.changed` that follows names it (`"steered":"3"`) so every device moves it into the turn. `queued`: the agent cannot take it in now, and it waits on. `gone`: it was not waiting any more |

Both need the thread followed on the connection (4001 otherwise), and a thread only read
answers -32602. The app sends `when_busy` and these methods only to a host that lists
the feature (BridgeWire.swift; `QueueControlling`), from one setting for every thread
(`WhenBusy`, steer unless changed), and shows the list above the composer. On a host
without the feature the setting changes nothing: a message sent while the agent waits on
an approval or a question declines it first, as it always did, and steers.

**Files** (feature `files`; `bridge/src/sessions/files.ts`). `file.attach_bytes` takes
`{session_id, content_base64, filename?, id?, profile?}`: a file of any kind, at most 25 MB,
for the next message sent on the same connection, at most ten a message (counting files
still being saved, so files sent at once cannot pass ten). `id` is the device's own for
the file: a file attached again with the id of one still waiting for that message is not
saved again, and the answer is the one it had, so a send tried again after a reply that
never came carries each file once. A file turned down (`attached:false`) fails its
message: whatever the connection attached for it, images too, no longer waits, and the
device attaches it all again when it tries again. The bridge saves it at once in the
thread's folder, as `<cwd>/.portals/files/<thread>/<name>`, and answers
`{"attached":true,"name":"notes.txt","path":"/Users/dev/proj/.portals/files/20261012_101500_ab12cd/notes.txt"}`,
or `{"attached":false,"message":"…"}` with a sentence to show. Only the name is taken
from `filename`: no folder, no leading dot, nothing a shell or the Finder trips on; a
name taken already gets ` 2`, ` 3`, … before its extension. `.portals/.gitignore` (`*`)
keeps the folder out of git, and `.portals/files/.gitignore` and the thread's folder's own
`.gitignore` (each ending in `*`, given that line when it lacks it) the files, whatever a
`.gitignore` already there says: the deepest one, the thread's, no rule above it can undo. A link in place of `.portals`, its `files` or the thread's
folder there (a repository can hold one) is not followed: the file is turned down. The files stay when the thread is taken off the list, as the
agent's own session does.

The next `prompt.submit` on the connection takes every file it attached since its last,
and may then have an empty `text`; another device's message takes none of them, and a
connection that closes lets go of the ones it attached (the files stay in the folder). The message the agent is sent, and that every history keeps, is the text,
a blank line, then

```
Files attached in Portals (saved on this Mac):
- /Users/dev/proj/.portals/files/20261012_101500_ab12cd/notes.txt
- /Users/dev/proj/.portals/files/20261012_101500_ab12cd/report.pdf
```

(the list alone for a message of files only), followed in the stored message by its
`@image:` lines. The app finds the list again by that first line, when a path a line
follows it to the end of the message, and shows the files as files (`SentText`); a
message of files alone is previewed by its file's name, or as `2 files`, or as
`3 attachments` with images. A message with files is never a slash command, for any
agent: Claude Code, which runs a leading slash command itself, is sent such a message with
a space before it, which it reads as words. Images go
on as before (`image.attach_bytes`), to the agents that see them.

**Fleet** (feature `fleet`). Six methods on the bridge's threads as a whole
(`bridge/src/fleet/fleet.ts`). None needs the connection to follow the thread, and none
makes it follow one: a turn started here goes out to the thread's followers as any
other, and this connection gets no event of it. `thread` is the thread's stored id; one
the bridge does not know is 4007. A thread on a Mac the bridge is linked to is
`machine/thread` (stored ids have no `/`), and every call on it is passed on to that
Mac's bridge (below).

A thread is described the same way everywhere:
`{"id":"6d3c…","agent":"claude","agent_name":"Claude Code","title":"Fix the login","folder":"/Users/dev/coding_projects/app","state":"blocked","kind":"permission","updated":1791324000}`.

- `agent` is the profile name and `agent_name` what to call it; `title` is left out
  until the thread has one; `folder` is the real path; `updated` is Unix seconds;
  `read_only: true` marks a thread taken up only to read.
- `state` uses the words of the Program Status Protocol (OSC 7501): `working` while a
  turn runs; `blocked` while an approval or a question is open, with `kind` `permission`
  or `question`; `error` when the last turn failed, until the next one; else `idle`.
  Only a thread loaded in the bridge can be anything but `idle` (as for
  `sessions.activity`, which keeps its own two words for the app).

| Method | Params (`?` = may be absent) | Result |
|---|---|---|
| `threads.list` | `state?`, `profile?`, `local?` | `{"threads":[…],"machines"?:[…]}`: every thread in the bridge's registry, and unless `local: true` those of each linked Mac, newest first; only those in `state` or of the agent `profile` when given. It loads none. With links, `machines` says which answered: `[{"name","url","reachable","error"?}]`; one that did not adds no threads and is no error. A `state` that is not one of the four is -32602 |
| `machines.list` | — | `{"machines":[{"name":"mini","url":"https://…","reachable":true,"agents":[{"name","display_name"}]},…]}`: the linked Macs, with the agents of those that answer and `error` for those that do not |
| `thread.read` | `thread`, `last?` | `{"thread":{…},"messages":[…],"inflight"?:{…},"open_requests":[…]}`: the last `last` turns (1 when absent, at least 1) as `session.resume` returns messages, every user message opening a turn; `inflight` while a turn runs; the questions waiting. It loads the thread |
| `thread.send` | `thread`, `text`, `from?`, `sender?`, `origin?`, `sent_by?`, `wait?`, `timeout_ms?`, `notice?` | `{"status":"streaming"}`, `steered` or `queued`, as `prompt.submit` answers. With `wait: true` the answer comes when `thread.wait` would give it, and has its keys too. `from` is the thread the message comes from, when there is one; `sender` says who in words, and `sent_by` as facts (`senders`), when another bridge passes a message on. `notice` (`tell_starters`, at most 100 characters, without `wait`) is a starter's notice's own id, which another bridge gives each time it tries that notice: a second `thread.send` into the same thread with an id taken in the last 7 hours sends nothing and has the first one's answer. The ids are known only while the bridge runs: one restarted between taking a notice and its sender's next try takes that try again, and the starter may be told twice. That is on purpose: a notice its starter was still to be handed (an agent warming up) is lost with the restart, and a record of it on disk would answer the try for it, so the starter would never be told. An empty message, a thread only read, and a thread sending to itself are -32602. With `wait`, the wait is there before the message goes, so that a turn that ends as it begins (an agent that fails to start) is told to it alone; on `machine/thread` the message and the wait go in one call, and the other Mac does the same |
| `thread.report` | `text`, `from` | `{"status":"streaming","thread":"…"}`, `status` as `thread.send` answers and `thread` the one told. Sends `text` to the thread that started `from` (`started_by`: its id here, or `name/id` on the linked Mac it is on), as `thread.send` with `from` does, as `from`'s report of the work it is doing: no notice of the rest that work comes to follows (below). -32602 with a sentence when `from` is no thread of this bridge, when no thread started it, and when the Mac of the thread that did is not linked now |
| `thread.wait` | `thread`, `timeout_ms?`, `from?`, `sender?`, `origin?`, `sent_by?` | `{"state":"idle","timed_out":false,"reply":"…","open_requests":[]}`, with `kind` when blocked. Answered once the thread is at rest (`idle` or `error`, with no message queued) or `blocked`: at once when it already is. `reply` is the last text of the last turn, which for a failed turn is why. After `timeout_ms` (60 000 when absent, at most an hour) it answers as things are, with `timed_out: true`. `from` is the thread waiting, when one is (the `portals` command gives it, as for `thread.send`), and `sender`, `origin` and `sent_by` say who waits when another bridge passes the wait on, as for `thread.answer`: the thread that started this one, waiting for it, is not sent a notice of the same rest (below). On `machine/thread` they are passed on |
| `thread.start` | `profile?`, `cwd?`, `title?`, `model?`, `provider?`, `reasoning_effort?`, `text?`, `from?`, `sender?`, `origin?`, `sent_by?`, `machine?`, `wait?`, `timeout_ms?` | `{"thread":{…}}`: a new thread, made and checked as `session.create` makes one, which this connection does not follow. With `text` it is sent as the first message and the result has `thread.send`'s keys too. With `machine`, the thread is started on that linked Mac, with its agents and folders, and passed `origin` (`agent_threads`) when `from` names one of this bridge's threads: this Mac's name for itself and that thread's id, `mbp16/6d3c…`, which the new thread keeps with who started it, never listed, so that only that thread answers it, and `sent_by` (`senders`), who as facts with this Mac's stable id, which it keeps and lists |
| `thread.stop` | `thread` | `{"stopped":true}` when a running turn was interrupted, `false` when none was running. The turn still ends with `message.complete` `interrupted`. With no turn running it is `true` where `session.interrupt` answers `interrupted` (section 5.1): a question taken back, or a message stopped on its way |

A thread started through the fleet tells the thread that started it (`started_by.thread`,
or `started_by.from` on another Mac of the net, through the link to that Mac) when it comes
to rest, fails or is blocked, unless config's `fleet.tellStarters` is `false`: the bridge
sends that thread a message as `thread.send` does, from the started thread (its
`[Portals: from …]` line), saying "Notice from the bridge: this thread finished its turn."
with its last reply (at most 2 000 characters), "…ended with an error." with why, or
"…is waiting for an answer" with each open request's kind, id and words. Once for each
rest, and not while a message is queued for the thread; not when the starter waits for it
(`thread.wait`, `thread.send` or `thread.start` with `wait` and `from`), whose answer says
it; not of a rest or a failure when the thread reported to its starter (`thread.report`)
while it was working since its last rest, which was its own report, unless its starter
sent it a message since, whose work the report did not cover (a message it sent with
`thread.send` is no report, and the notice follows it; a blocked thread's notice is sent
whatever it sent, as only it has the request's id); not for a thread a person or the
command in a shell started. A turn that ended while a steered message
waited for the agent to take it is told once that settles; one that ended while the bridge
was down, as the thread is loaded again. A notice that cannot be sent (the starter's Mac
asleep, out of reach or restarting) is tried again after 10 s, 30 s, 1, 2 and 5 minutes,
then every 10 minutes for up to 6 hours, with the same `notice` id each time, so that the
starter's bridge takes it once when an answer was lost on the way (an older bridge ignores
the id, and one restarted meanwhile may take it twice), until the thread comes to another rest or asks
something else (told instead) or is taken off the list; a starter that is gone, or a Mac
that refuses it, is not told, and the bridge logs it. `thread.start` answers `tells_starter`: true when the
thread will tell the one starting it, false when it will not (no thread starts it, or
`fleet.tellStarters` is off); a bridge without the feature `tell_starters` says nothing of
it, and tells nothing. New on the wire: `from` on
`thread.wait`, and `thread.report`.

- A wait is for the thread, not for one message: a message that was `queued` is waited
  for until its own turn has ended, and one `steered` until the turn it joined has. A
  steered message the agent turns down as that turn ends (Codex can) runs in a turn of
  its own, and the thread is `working` until that turn has ended too.
- A message sent with `thread.send` or `thread.start` is not the user's, and is stored
  and given to the agent with a first line that says so (src/fleet/line.ts):
  `[Portals: from Claude Code · "Fix the login" (thread 6d3c…)]` when `from` names one
  of the bridge's threads (without the title when it has none), else
  `[Portals: from the command line]`; when another bridge passed it on with `sent_by`,
  its thread is named by that Mac's stable id and its own, and the Mac by its name for
  itself: `[Portals: from Codex · "Review" (thread 7d2a41c09be36f58/019a…) on mini]`,
  `[Portals: from the command line (machine 7d2a41c09be36f58) on mini]`; with `sender` alone (an older bridge),
  `[Portals: from <sender>]`. The message follows on the next line. A message sent with
  `prompt.submit` is the user's and gets no line. Devices are given who as facts
  (`senders`) and need not read the line, which a later bridge may word otherwise.
- The `portals` command says which thread it runs in by `PORTALS_THREAD`, which the
  bridge gives each Claude Code, Pi and Droid thread's process, else by the id Codex
  (`CODEX_THREAD_ID`) or Cursor (`CURSOR_CONVERSATION_ID`) gives each command it runs,
  one process running many threads. None of them is passed on from the bridge's own
  environment to an agent's.
- A turn such a message opens starts with `message.start` `{"opened_by":"portals",
  "text":"[Portals: from …]\n…"}`, so a client following the thread opens the turn with
  that message, not with one of its own still queued. A bridge that lists
  `turn_messages` gives every turn's `message.start` its message (`sender` `portals` for
  these), and tells of one steered into a running turn with `message.steered`.
- Such a message takes none of the images a client has attached for its next message
  (`image.attach_bytes`); those stay for the client's own.
- A blocked thread is answered by a connection that follows it, as in section 7. These
  methods answer no question; a bridge with `agent_threads` also takes the answer of the
  thread that started it, with `thread.answer` (below, under the thread list).
- A thread started here is in no device's push registration until a device registers
  it, so nothing is notified for it.

**Links.** A bridge is linked to another Mac's by keeping that bridge's address and
sign-in (`links.json`, from its pairing link; `bridge/src/fleet/links.ts`). For a call
on `machine/thread` it signs in to that bridge as section 2 says, keeping the session
from one call to the next, takes a ticket, makes the same call with the bare id and
hangs up; the answer comes back as that bridge gave it, with the thread named
`machine/thread` and `machine` set. `threads.list` asks each linked bridge with
`local: true`, so that two bridges linked to each other do not ask each other in turn.
Both password/ticket and net-token link clients offer `permessage-deflate`, with no
context takeover in either direction and a 1 KB compression threshold. A peer that
does not support it declines the extension and answers uncompressed on the same
connection. This changes wire encoding only, not RPC fields, order, features or
deadlines. A socket lasts for one RPC and is terminated on its answer; its compression
state (about 360 KB once used) is not retained between calls.
`folders.list` with `machine` answers with that Mac's folders, and `folders.search` with `machine` searches them (feature `folder_search`, 10 seconds). A Mac that cannot be
reached, or does not take the sign-in, is -32603 with a sentence saying so
("Could not reach mini: …"); a bridge without the feature, -32603 saying to update it.
A sign-in the other bridge refused is not tried again for ten minutes, or until the
link changes, and one it refused as too many is not tried for a minute: each try counts
against its limit, which its other clients share. A Mac that did not answer a listing
(`threads.list`, `machines.list`) is left out of the next listings for 30 seconds, as
not reachable with the same sentence; a call that names one of its threads asks it
again.

**Incremental links** (features `fleet_delta`, `fleet_delta_positions`). A bridge checks the other Mac's
`gateway.ready` features on the connection it is already opening. If `fleet_delta_positions`
is absent, it sends today's `threads.list` with `{"local":true}` on that same socket,
not a failed probe followed by another connection. If present, it explicitly opts in
by calling `threads.delta` for an unfiltered list; no events or fields are added to
ordinary list/sync replies. Queries with `state` or `profile` retain the original
exactly filtered remote `threads.list` RPC, avoiding a larger cold unfiltered base.
These are the only forwarded filters: `local` selects local-only handling before the
fleet is called; the command's `--limit` slices its final answer locally, not remotely.

`threads.delta` takes optional `{epoch, list, since}` and answers only this Mac's
threads, never its linked Macs:

```json
{"epoch":"a781…","list":{"id":"f983…","revision":45},"threads":[{"id":"6d3c…","agent":"fake","agent_name":"Fake agent","folder":"/w","state":"idle","updated":1791324000}],"positions":[0],"removed":["old-id"],"active":[{"id":"6d3c…","state":"blocked","kind":"permission"}],"order":{"count":1,"digest":"sha256…"}}
```

`threads` holds changed summaries in registry insertion order, and `removed` holds
ids removed since the cursor and not re-adopted. Missing/invalid cursors, a different
list, a future revision or a new runtime `epoch` give every current row and `full:true`.
The epoch changes even when a restart preserves the registry's list id and revision,
and whenever an agent's display name changes (a row's `agent_name` comes from its
provider, not the registry, so no revision would carry it).
On a full response `removed` is empty: every row is replaced, so old tombstones need
not consume bandwidth. The app's separate `threads.changes` remains unchanged.
`active` is the complete non-idle overlay, including approval/question, queued work
and failed turns; absent ids are idle. It overrides row state even without a registry
revision change, so a refresh is as current as a full local list at that RPC's snapshot.

On incremental replies, `positions` gives each changed row's absolute position in the current registry.
Full replies omit it: all rows already appear in registry order, so their positions
are their zero-based array indices. A receiver also accepts explicit valid positions
on a full reply, for compatibility with an earlier draft.
The receiver removes deleted/changed ids from its prior order, places changed rows
in their final slots, and fills the gaps with unchanged rows in their prior relative
order. `order` is the current id count and SHA-256 of `JSON.stringify(ids)` in that
registry order. Verify both before applying the complete overlay and the same stable
newest-first sort as a full list. Ties and removal/readoption need no extra RPC.
An invalid row, position, cursor or digest discards the base and fails closed, with
the existing `Could not reach <Mac>: it hung up before answering.` sentence and no
cached remote rows. Only a payload-free reason is logged and counted in
`fleet_rejected`; the next actual refresh requests a full base.

Ordinary callers make independent fresh RPCs, using their own immutable merge bases;
out-of-order responses cannot replace a newer request's cached base. A full
`threads.delta` safety read replaces one incremental delta every 120 seconds,
retaining its verified registry-order cursor rather than needing another full call.
The existing eight-second per-Mac refresh budget
and ordinary missing-Mac behavior remain unchanged:
an unsuccessful incremental refresh adds no cached rows. Full safety replacements
retain the last verified list as described below. Each link retains at most 20,000 rows or an
estimated 16 MiB (object allowance plus UTF-16 strings); a larger answer is delivered
whole without a retained delta base. Removed/replaced links free their caches at once;
after an unsuccessful incremental refresh, a minute without success frees that Mac's rows/cursor.
The cache closes with the fleet.

**Paged bootstrap** (feature `fleet_pages`). Healthy cold links retain one full
`threads.delta` RPC. Only an actual unfiltered full-fetch timeout and the advertised
capability enable paging. `threads.page` takes optional `{snapshot, offset}` to resume
an opaque frozen snapshot, or `{epoch, list, since}` to capture a frozen delta phase,
or `{}` for a full phase. Its result has `epoch`, `list`, `order`, optional `full`,
`threads`, parallel absolute `positions`, `removed`, opaque `snapshot`, and integer
`offset`, `next`, `total`. The sequence consists of changed rows followed by removals.
Offsets address that immutable snapshot, never a mutable live registry array.
Each result body is at most 32 KiB. It has no historical `active` overlay.

An unknown/expired token or invalid offset returns `{reset:true}`; discard every
old staged row/cursor before requesting a new full phase. An unpageable row or
snapshot returns `{unavailable:true}`, which discards the stage and fails closed,
never truncating an otherwise valid legacy full answer. Frozen summary values
survive title changes, deletion and readoption between pages. After all pages pass
schema, unique-id/position, count and digest checks, stage the complete base privately,
then ask `threads.delta` with its cursor for a fresh seal and complete current active
overlay. Only that seal may publish replacement rows. A timed-out seal can page its
catch-up backlog and try another fresh seal; continuous churn may keep an initial
bootstrap unreachable.

After a complete list has been verified, its two-minute full safety replacement is
built privately. A failure, timeout or incomplete phase leaves the last verified list
visible, with its last verified titles and live states. It does not publish any part
of the candidate or turn a full safety read into an incremental one. Later requested
refreshes retry; a complete replacement swaps in only after its fresh seal succeeds.

Sequential pages and their seal share one ephemeral socket and the original
eight-second authentication/socket deadline. The app gets no partial candidate rows,
and its existing failed-list backoff still answers immediately: an initial bootstrap
is unreachable, while a safety replacement returns its last verified list. An explicit
refresh during that backoff may start one detached, bounded paging exchange per Mac;
it is not awaited and a second refresh does not start another while it is in flight.
There is no timer or network poller starting requests. Outside that branch callers
remain independent; sequence and generation guards reject late invalidated work.
Old peers and filtered calls keep their exact legacy route.

The near-side verified base, private replacement and pending phase share 20,000
entries/estimated 16 MiB. A replacement that cannot fit is abandoned without removing
the verified list; a later whole answer can still replace it without truncation.
The far-side store is globally capped at four snapshots and 16 MiB across requesting
Macs. Private staging and far-side snapshots expire after 60 idle seconds, refreshed
by valid page progress/access, not by unsuccessful requests. Expiry, malformed pages
and overflow discard private staging without erasing a verified safety fallback.
Link removal/replacement and close discard both. Invalidated work is aborted.
Runtime epoch/list changes and
expired tokens restart without mixing snapshots. The fixed numeric `fleet_paging`
counters record starts, pages, rows, seals, resets, detached starts, completions and
expiries; rejection logs/counters contain only a fixed payload-free reason.

The bridge also serves this protocol on a Unix socket in its folder (`agent.sock`,
mode 0600; `bridge/src/http/local.ts`): the same frames over a WebSocket at any path,
with no sign-in and no ticket. The `portals` command (`bridge/src/portals.ts`) is a
client of it, one connection per call. When the folder's path is too long for a socket
(over 103 bytes), the socket is in `/tmp/portals-<uid>/` instead, which the bridge and
the command use only while it is the user's own and closed to others (mode 0700).

**Thread list** (feature `thread_sync`; `bridge/src/fleet/fleet.ts`,
`bridge/src/sessions/registry.ts`, docs/sync-plan.md). The bridge's threads are the list
every device shows, with the marks each device used to keep for itself. Only the
bridge's own: a `machine/thread` id is a thread these methods do not know (4007), and a
linked Mac's threads show through a device's own pairing with that Mac.

The list has an id (16 hex digits) and a revision, a whole number that goes up by one
with every change a listing shows. The `sessions.activity` result carries both,
`"thread_list":{"id":"3f9a1c0e7b2d4a65","revision":812}`, so a device that polls it
knows when to ask what changed. Both are kept in the bridge's `state/threads.json` and
survive a restart. A bridge from before the feature, run on the same folder, keeps the
threads but drops the list's id and revision when it saves; this bridge then makes a new
list when it next starts, whose revision starts above every revision a thread was
stamped with, and a device that held the old one takes the new one whole.

A thread is listed as the fleet describes it, plus its marks:
`{"id":"6d3c…","agent":"claude","agent_name":"Claude Code","title":"Fix the login","folder":"/Users/dev/coding_projects/app","state":"idle","updated":1791324000,"created":1791320000,"revision":805,"preview":"Make the login keep its session","pinned":true,"unseen":true,"started_by":{"name":"Aeri","thread":"aeri"}}`.

- `created` is Unix seconds. `updated` moves only when a turn starts or ends: pinning,
  archiving, renaming, a preview, the model, thinking level or mode leave it, so none
  of them moves the thread up a list. `revision` is the list's revision when the thread
  last changed; the model, level and mode are not listed and do not move it. `state` is
  as of the answer and does not move it either.
- `turn` (since 2026-10-26): which turn is the thread's latest, as the list's revision when
  it began (or ended, for one the bridge never saw begin, run while it was down); absent
  for a thread with none recorded since. A device sends it with a seen of that turn
  (`thread.mark`'s `turn`). An older app ignores it; an older bridge gives none. The
  live `message.complete` says it too, as `turn` (since 2026-10-26, net-20): the same
  number the list gives the turn, so a device that heard nothing of a quick turn before
  it was read (no list and no `sessions.activity` here had it) names the right turn in
  its seen. Absent for a turn whose start the bridge could not keep in its record (then
  the list's `turn` is the one its end gave). An older app ignores it.
- `preview`: the first line with more than spaces on it of the last message sent into
  the thread, leaving out a `[Portals: from …]` first line and the `@image:` lines, at
  most 140 characters (as Swift counts them), or `Image` or `2 images` for a message of
  images alone.
- `started_by`, for a thread started through the fleet: `{"name":"Claude Code","thread":"6d3c…"}`
  when `thread.start`'s `from` names one of the bridge's threads;
  `{"name":"Claude Code on mini"}` when a linked Mac passed the start on, its agent and
  name for itself from `sent_by`, or (an older bridge) its `sender` without the quoted
  title and thread id it carries, on one line of at most 80 characters;
  `{"name":"the portals command"}` when neither says who. With `senders`, also `from`,
  who as facts: `{"agent":"claude","agent_name":"Claude Code","thread":"6d3c…"}` for one
  of the bridge's threads, and with `machine` and `machine_name` for another Mac's, by
  which a device puts the thread under the one that started it on that Mac (a thread
  started before the feature has none). A thread started
  with `session.create` or taken up with `session.adopt` has none. A start passed on with `origin` (`agent_threads`) keeps it
  too, which is never listed.
- `shared: true` (feature `agent_threads`): a person put the thread, which an agent
  started, in the sidebar on every device; the app otherwise lists a thread whose
  `started_by` names one of the bridge's threads only under that thread.
- `recent: true` (feature `recent_threads`): the thread is under Recent on every device.
- `pinned`, `archived`, `unseen`, `preview`, `started_by`, `shared` and `recent` are left out
  when false or unknown.
- `ongoing: true` (feature `bot_chat`): the agent's one ongoing conversation, a Hermes
  profile's Bot Chat, titled by the agent's name; the agent's only thread on the list.
  (Aeri's ongoing thread carried the same key until Aeri was taken out on 2026-10-21; the
  app reads it only from a bridge that lists `bot_chat`.)

What changes the marks, the same for every device:

- A turn's start (a message from any client or through the fleet, a turn begun at the
  desk or by the agent itself) takes its message as the preview and takes the thread
  out of the archive. A turn the agent opens with a line of its own keeps the preview
  it had, as does a message steered into a turn that ended first and then run in a turn
  of its own. A message handed to a running turn becomes the preview too.
- A turn's end, however it ended (complete, interrupted or failed), marks the thread
  `unseen` and takes it out of the archive, in the same step as its `message.complete`:
  a device that answers that event with a seen always comes after it.
- A thread loaded with no preview (one from before the feature) takes one from its
  stored conversation. Nothing is loaded only to find one.
- A turn found running when a thread is loaded or taken up (one started at the desk
  while the bridge was off) is a turn's start. The one whose start the bridge recorded
  before it restarted changes nothing, unless the thread was archived since.
- Archiving unpins, unless the same `thread.mark` pins, and takes the thread out of Recent
  (`recent_threads`), unless the same `thread.mark` sets `recent`.

| Method | Params (`?` = may be absent) | Result |
|---|---|---|
| `threads.changes` | `list?`, `since?` | `{"list":{"id":"3f9a1c0e7b2d4a65","revision":812},"threads":[…],"removed":["…"]}`. With `list` this list's id and `since` a revision of it (from 0 to the revision now): the threads changed since then, newest first, and the ids taken off the list since then, and nothing at all while nothing changed. Otherwise (`list` or `since` absent, another list's id, `since` ahead of the list): `"full":true`, every thread, and in `removed` every id taken off the list and not taken up again, so a device that held threads under another list can tell the ones removed from the ones this bridge never had. An id is in only one of the two: a thread removed and taken up again since is listed |
| `thread.mark` | `thread`, `pinned?`, `archived?`, `unseen?`, `shared?`, `recent?`, `revision?`, `list?`, `turn?`, `preview?` | `{"thread":{…}}`, the thread as listed after the change. At least one of `pinned`, `archived`, `unseen`, `shared` (`agent_threads`), `recent` (`recent_threads`) and `preview` is given (-32602 otherwise); 4007 for a thread the bridge does not know. The last write wins, and `updated` does not move. `archived: true` also unpins, unless the call gives `pinned: true` (an archive and a pin made after it, sent together). `revision` goes with `unseen: false`: the thread's revision as the device last listed it. The seen is ignored when a turn has started or ended in the thread since then, so a seen on its way never clears a turn that ended after the device listed the thread; marks and titles changed meanwhile do not hold it back. It is ignored too when it was listed under another list (a bridge home before this one), whose revisions are not this one's: `list`, which goes with `revision`, names another list's id, or `revision` is ahead of the list's revision now. `turn` (since 2026-10-26) goes with `unseen: false` too: the listed `turn` of the turn the seen is of, for a turn read on the device before its list had the turn's end, whose seen then goes with a revision fetched later; the seen is ignored when the thread's latest turn is another one, so a seen of an earlier turn never clears a later one (net-20). An older bridge ignores `turn` and goes by `revision` alone, as before; an older app sends none. `preview` is taken only by a thread that has none (a device's own, for a thread from before the feature), worded as above |
| `thread.delete` | `thread` | `{}` once the thread is off the list. 4007 for a thread the bridge does not know; -32602 with a sentence for a thread at work (`"Claude Code is still working in this thread. Stop it, then remove it."`), and for one whose agent still runs work of it in the background (`"Claude Code still has work running in the background in this thread. Remove it once that work is done."`); -32603 with a sentence when the agent cannot say whether the thread is at work (`"Portals could not ask Codex whether this thread is at work (…). Try again in a moment."`), or when the bridge's files cannot be written |

**Taking a thread off the list.** `thread.delete` never stops anything: a thread at work
is refused, and the person stops it first. At work means a turn running, a message
handed to the running turn that the agent has not taken yet, an open approval or
question, a turn the bridge ended for the app that the agent has not ended itself
(Codex goes on with a turn it did not stop until it says the turn completed), a turn
begun at the desk that the app is not shown yet (Codex's, before its message arrives,
or one the bridge never heard of, begun while its connection to Codex was down or in a
thread it loaded only to show: Codex is asked whether it runs a turn in any thread the
bridge has loaded, except one only read), or work the agent runs on in the
background after its turn (Claude Code's background commands and subagents, which end
with its process: Stop does not end them, so the thread is removed once they are done;
with feature `subagents`, also any subagent or workflow still at work, such as a Codex
sub-agent, which runs on in Codex and would be lost sight of).
A thread taken up only to read is never at work here: a terminal runs it, and goes on
doing so when the bridge's thread is removed. A thread
the agent runs without the bridge (Codex, Hermes) that is not loaded is asked about
first, and loaded when the agent still has it open, so a turn running there right after
the bridge restarted is seen. Otherwise, in one step, the thread leaves the list (its
record goes to `state/removed.json`; when that cannot be written, the delete fails and
nothing changes) and its session is closed for good: a message or a
`thread.send` sent to it after that starts nothing, and `session.resume` and the fleet
methods answer 4007. Every device's `threads.changes` names it in `removed`, its push
registration is forgotten (section 10), and nothing the agent keeps is erased: Claude
Code's session, Codex's thread and Hermes's session stay on the Mac, `desk.list` offers
the thread again and `session.adopt` takes it up (above). `removed.json` is never
trimmed, and a bridge from before the feature never rewrites it.

`threads.list` and the other fleet methods are unchanged: their threads carry none of
these keys.

The app sends these methods only to a host that lists the feature, and reads
`thread_list` only from one (HermesBackend+Bridge.swift, `ThreadSyncing`). A new title
goes as `session.rename`. A thread entry the app cannot read (one without `id`,
`agent`, `updated` or `revision`) is kept as the device holds it, neither changed nor
forgotten; a `full` answer without `threads`, or with an entry that has no `id`, is not
merged at all. Any error answer other than 4007 to a change is taken as the bridge
saying no, with its message as the sentence shown. What changed is merged into the
device's own copy of the list (AgentCore's `ThreadSync`, run by `HostSync`;
docs/sync-plan.md).

**Answers from the thread that started one** (feature `agent_threads`;
`bridge/src/fleet/fleet.ts`, the `portals answer` command). A thread started through
the fleet from one of the bridge's threads (`started_by.thread`) is answered by that
thread, as a device answers it (section 7): the agent there reads the question in
`open_requests` (`thread.read`, `thread.wait`) and answers it by its id. Nobody else
answers this way: a thread started from a command line run outside any thread is
answered only on the user's devices.

| Method | Params (`?` = may be absent) | Result |
|---|---|---|
| `thread.answer` | `thread`, `request`, `choice?`, `note?`, `answers?`, `from?`, `sender?`, `origin?`, `caller_mode?` | `{"answered":true}` once the question is settled: the agent asking is given the answer, and every follower's card closes with `request.cancel` `{"id","reason":"resolved","by":"Claude Code","answer":{"choice":"once"}}`, `by` the name `started_by` has and `answer` what was given. An approval (`"method":"approval"`) takes `choice` `once`, `session` or `deny`, and with `deny` a `note`, what to do instead, which the agent asking is given after the no as the answering thread's own message, as `thread.send` puts one (`[Portals: from …]`), and not with the no, which tells an agent and shows on every device a note as the user's own words (`approval_notes`); the cancel's `answer` has it; a question (`clarify`) takes `answers`, each question's `qid` and its answer or null, as a device sends them (a `qid` it was not asked is left out). -32602 with a sentence for the agent: for a caller that is not the thread that started it (`from` is not `started_by.thread`), for `always` ("An agent cannot allow always: it would change the agent's settings for good. …"), for a choice the approval does not offer (`deny` always is one), for a note with an allow, for `answers` to an approval or a `choice` to a question, for no answer at all, and for an allow the caller's mode does not give (below). 4007 for a thread the bridge does not know, and for a question that is not open (answered or withdrawn already). On `machine/thread` it is passed on to that Mac with `origin` and `caller_mode` |

- An allow needs the caller's own thread to have the access it gives, as its mode is
  now (`modes`; `default` as what the agent's settings come to): a command or an edit
  asked for, `full`; a plan (`"plan":true`), at least the mode its work starts in
  (`starts_in`, its `default` as the asking thread's settings come to, `full` when not
  known), and the mode the asking thread is in now when it was moved out of plan mode
  while the plan waited and that is more (the work goes on in it), with `plan` < `ask` <
  `edits` < `full`. A thread whose mode is not known (an
  agent without modes) can only say no. Questions, and a no, need nothing.
- A thread on a linked Mac: the caller's bridge checks the caller is one of its own
  threads, and passes the answer on with `origin` (its name for itself and the caller's
  id, as `thread.start` passed it) and `caller_mode` (the caller's mode, when known);
  that Mac takes it only when `origin` is the one the thread keeps, and checks the allow
  against `caller_mode`.
- `portals answer THREAD REQUEST (--choice once|session|deny [--note TEXT] | --answers JSON)`
  makes the call with `from` the thread the command runs in.

**Polling at once** (feature `poll_now`; `bridge/src/gateway/pollNow.ts`). Without it a
device learns that something moved only from its own poll: `sessions.activity` every
few seconds while its sidebar is out, and nothing while it is hidden. With it the bridge
tells a device that asks when to poll.

- A connection asks with `client.capabilities` `{"server_requests":true,"poll_now":true}`,
  and is told from then on, until a `client.capabilities` without the key or until it
  closes. A connection that does not ask is never told: links between Macs and the
  `portals` command send no `client.capabilities`, an app from before the feature sends
  no such key, and Hermes is never sent it.
- The event, a moment after something moved:
  `{"jsonrpc":"2.0","method":"event","params":{"type":"poll.now","payload":{"thread_list":{"id":"3f9a1c0e7b2d4a65","revision":812}}}}`.
  No `session_id` and no `seq`: it is never logged nor replayed (section 3).
  `thread_list` is the list's id and revision as the event goes, as `sessions.activity`
  gives them (`thread_sync`).
- What moves it: the list's revision (a change a listing shows, once `threads.json` has
  it); what `sessions.activity` says of a thread (a turn starting or ending, a question
  or an approval opening or closing, the last subagent or workflow at work ending, a
  thread at work let go of); the looks' revision (`agent_looks`) and the order's
  (`sidebar_order`). Nothing for a change the bridge could not save (`threads.json`,
  `looks.json` or `order.json` that cannot be written: the change is refused and
  nothing moved), nor for one no listing shows (a thread's model, level or mode, a mark
  it had already, a seen the bridge ignores, a look or an order given again).
- A burst is one event: the first move starts a wait of 200 ms, which later moves do not
  start again, and the event says where the list is as it goes. A turn's end, its title
  and the seen of a device looking at the thread are one event when they come within it;
  a turn's start and its end are two, but for a turn shorter than that.
- It comes after what moved it. A turn's end is told (`message.complete`) and saved in
  one step, in which the wait starts: a device that follows the thread has the turn's
  `message.complete` before the `poll.now` that tells of it.
- It is a signal, not the changes: the device then polls as
  it does every few seconds, `sessions.activity` and, when the list moved, `threads.changes`
  from the revision it holds, so the sync plan's rules are unchanged. The poll's answer
  may be ahead of the event's `thread_list`.
- What the app does with it (`HostSync.hostMoved`, `HostModel.pollNow`): it asks for it
  only from a bridge that lists the feature, and reads the event only from one; from any
  other host an event with no session is dropped, as before (HermesBackend.swift,
  `handle`). A second after the event (`HostSync.listMoveWait`, the wait a followed
  thread's turn end already had), sidebar out or hidden, it runs the poll it runs every
  five seconds while the sidebar is out: `sessions.activity` (Needs you, Running, looks,
  order), then a sync step with the list as it gave it, which fetches only when that is
  not the list merged here. What is heard within the second, more events and a followed
  thread's turn end or title, is that one poll, and the second gives a device looking at
  the thread the time to send its seen first (docs/sync-plan.md). Measured with that
  device behind a link of 150 ms each way (the harness's `pushes`, `bridge/scripts/bench`):
  half a second after the event still came after its seen, a quarter did not (every turn
  shown unseen, and one fetch more), so the second is kept for slower links than that. A poll asked for while
  one is on its way is asked again after it. A change this device made and took from
  its answer (a pin, an archive: `thread.mark` answers with the thread as listed) fetches
  nothing more: the poll finds the list where the device has it. So does the seen of the
  device looking at a thread, whose answer it takes the same way from such a bridge only
  (from any other the answer to a seen is not merged, docs/sync-plan.md). It does not
  read the event's `thread_list`. The five-second poll stays as it was.

**The net** (feature `net`; `bridge/src/net/`, docs/net-plan.md). The Macs and devices
that reach each other after pairing once. Every bridge is in a net, at first a net of its
own, and keeps a copy of the member list (`state/net.json`); any Mac in it may change it
and copies the change to the others with `net.sync`. A member is
`{"id","kind","name","url"?,"key"?,"relay"?,"platform"?,"removed"?,"changed","by"}`: `id`
a Mac's `machine.id` or the id a device made for itself (8 to 64 letters, digits and
dashes), `kind` `mac` or `device`, a Mac's `url` (its address with scheme and port), `key`
(its X25519 public key, 32 bytes in base64url) and `relay` (its relay id), a device's
`platform` (`ios`, `ipados`, `macos`), `removed: true` once removed (the entry is kept),
`changed` in milliseconds since 1970 and `by` the member that made the change. Between
the Macs each entry also carries `token_hash`, the SHA-256 of the member's token in hex;
nothing a device is given does. What a device is given (`net.list`, `net.remove`, the
answer to `POST /net/join`) carries `token_tag` in its place (since 2026-10-26): 16 hex
digits of SHA-256 over `"portals token tag\n" + token_hash`, the same for two entries under
one token and telling nothing of the token or its hash. With it the device applies the
Macs' rule that a member's own word under the token it was removed with never undoes the
removal (net-5). An entry with no `token_hash` has none. An older app ignores the key; a
device given an entry without it (an older bridge) judges it as before. A Mac's entry
carries `named` and `named_by` (feature `net_rename`) once its name was set from the app:
when, a stamp in milliseconds since 1970 past every name of it the setting Mac had seen,
and that Mac's id; both or neither (an entry with one alone does not fit, and is
dropped). A device's entry carries them too once it was renamed so (feature
`net_rename_devices`, 2026-10-28). A bridge from before the feature leaves them out of its
copies (one from before 2026-10-28, a device's), keeping the name it held for an entry it
has, and an app from before ignores them.

- **The relay id in use by another bridge.** `gateway.ready`'s `bridge` block has
  `"relay_problem":"in_use"` while another bridge with this Mac's relay id and secret (a
  copy of the bridge's folder) holds the relay's standby socket, so devices cannot reach
  this Mac through the relay; the key is absent otherwise, and from a bridge from before
  it. It is read as the connection opens. The app shows it with the host in Settings,
  with what mends it: `npx portals-host relay reset` on that Mac (docs/pairing-and-relay.md,
  "The tunnel").
- **Signing in with a token.** A member opens the WebSocket with `Authorization: Bearer
  <token>` and no ticket: 32 random bytes in base64url, which a device gets when it joins
  (`POST /net/join`, docs/pairing-and-relay.md) and a Mac makes for itself. A token the
  bridge does not know has it ask every other Mac for the list first (at most once every
  30 seconds, those who come meanwhile waiting together), then it looks again; refused,
  the socket closes with 4401 "The token was not accepted." The push routes (section 10)
  take the same header (401 with a token not accepted), and a registration made with it
  is kept under the device's id and forgotten when the device is removed.
- **Removing.** A member removed on any Mac is out on every Mac once it has the change:
  its open connections close with 4401 "This device was removed from the net." ("This
  Mac was removed from the net." for a Mac), and its token is refused. A removed Mac may
  still call `net.sync`, and is answered without being heard, with its own entry alone,
  so it learns it is out and starts a net of its own (a new net id and token; its key and
  relay id stay). A Mac's own entry under the token it was removed with never undoes its
  removal, whatever the clocks say; a join brings it back. A Mac that leaves keeps the
  net it left (in `state/net.json`, `left`): a Mac of that net that was off then is
  answered so too when it next calls, with the leaver's entry, removed. A device's token
  known as removed is refused without asking the other Macs.
- **Who may call what**, by how the connection signed in: with the password (and a
  ticket), with a member's token (a device or a Mac), or on the `portals` command's
  socket. Any other way is 4003 with a sentence.

| Method | Who | Params | Result |
|---|---|---|---|
| `net.list` | anyone | — | `{"net":"<16 hex>","here":"<this Mac's id>","you":"<the caller's member id>" or null,"revision":12,"members":[…]}`, without `token_hash` |
| `net.invite` | anyone | — | `{"link":"portals://join?v=1&url=…&code=…&name=…","code","url","expires_at"}`: a join code, one use, for ten minutes (`expires_at` in milliseconds since 1970), at most 20 open (making one more lets go of the oldest), forgotten when the bridge restarts. `url` is this Mac's address On a Mac set up for itself alone (docs/net-plan.md), only a password sign-in gets one; anyone else is refused, with what to do. |
| `net.remove` | password, a device, the command | `member`, `net?` | Marks the member removed and copies the list to every Mac; answers as `net.list`. -32602 for a member the net does not have, for this Mac itself (`net.leave`), and, with `net` (since 2026-10-26), when this Mac is in another net than that one ("This Mac is not in that net any more: nothing was removed."). A device that switched nets names the old net when it asks a Mac of it to take it out, so a Mac that moved into the new net meanwhile does not take the device out of it. An older bridge ignores `net` and removes as before; an older app sends none |
| `net.join_with` | password, the command | `link` | This Mac joins the net of a `portals://join` link, bringing its devices (`POST /net/join` on the link's Mac, as a Mac); answers as `net.list`. -32602 with the other Mac's sentence when it refuses (this Mac is in a net with other Macs), and for a link with a `v` above 1 ("Update Portals to join this net.") Refused on a Mac set up for itself alone. |
| `net.rename` | password, a device, the command | `name`, `member`, `after`, `net?` | Names the Mac `member` (this Mac when not given) `name` on every Mac and device of the net (feature `net_rename`), from any Mac of it: the Mac renamed need not be the one called; with `net_rename_devices`, a device `member` too (any member may rename any device, itself included). The name is trimmed; -32602 for one empty, of more than one line, or over 80 characters as UTF-16 counts them ("A Mac's name …", "A device's name …"), and for a member the net has not or has removed ("There is no member X in this net."). `after`: the stamp (`named`) of the name the caller holds for that Mac, which the new one comes after; one more than a day past this Mac's clock and the stamp it holds is not taken. The name is stamped `max(now, named before + 1, after + 1)` and set on that Mac's entry with `named_by` this Mac's id; the entry's `changed` and `by` stay, so a rename never undoes a removal. -32602 too when the stamp held cannot be moved past (the largest whole number). With `net`, -32602 when this Mac is in another net than that one ("This Mac is not in that net any more: nothing was renamed."), as for `net.remove`: the app names the net it is in as it asks, so a device that switched nets meanwhile does not rename a Mac in the net this one has moved into. The same name again changes nothing when `after` is absent or older than the stamp this Mac holds; with that stamp or a later one it is a rename all the same (the caller saw another name win since, at the same stamp by a greater id or later, and asks for this one back). Answers as `net.list`, and copies the list to every Mac |
| `net.leave` | the command | — | This Mac leaves: the other Macs are told it is removed, then it is a net of its own; answers as `net.list` |
| `threads.held` | a Mac | `threads` | Feature `held_elsewhere` (2026-10-27): every thread of this bridge's that threads on the calling Mac keep at work now (at work, waiting, or kept at work by threads they started), the whole set each time, which replaces what that Mac said before; `[]` clears it. Held three minutes unless said again: the calling Mac says it again every minute while it is not empty. `sessions.activity` lists each as `running`, `inherited`, `turn: false`, and the threads that started it in turn; `poll.now` goes when the set changes or a word runs out. Threads this bridge does not have are left out. Answers `{}`. A Mac says it to the Mac where a thread of its own was started from (`started_by.from.machine`, the net's id of that Mac), only when that Mac's greeting lists the feature (docs/fleet-plan.md) |
| `net.sync` | a Mac | `net`, `members` | The calling Mac's copy, merged into this one, which is the answer: `{"net","members"}`, with `token_hash`. Per id the entry changed later wins, at the same moment the one whose `by` is greater, but for a removal, which the member's own entry under the same token does not undo; entries are never deleted, by a merge, a read or a sync, so a removal is kept for good. Every entry is taken in, past the 200 members and the 1000 entries a join may make (two Macs apart may each let one in). A list is taken whole however long it is, and so is the answer, so a removal reaches every Mac. A removed Mac's call is answered with its entry alone, and not taken in. A Mac's name set from the app is merged apart from the rest of its entry: of the two copies the later `named` wins (at the same stamp the greater `named_by`; a name never set so comes first), whichever entry wins. Of this Mac's own entry, besides a removal, only such a later name is taken: the Mac goes by it from then on (what it passes on to other Macs, `net.invite`'s link) over `fleet.name` and its Computer Name, and writes its entry anew with it. -32602 for another net |

- **Where the list is.** `gateway.ready`'s `bridge` block carries
  `"net":{"id":"3e5a9c1f0b7d2468","revision":12}`, and `poll.now` carries the same beside
  `thread_list`; the revision goes up with every change the bridge saves (its own count,
  not the net's). A device asks `net.list` again only when the id or the revision is not
  the one it holds.
- **Links follow from the list.** Every other Mac in the net, not removed and with an
  address, is a link of the fleet's (`threads.list`, `machines.list`, `machine/thread`),
  named after the Mac (`mac-mini`; a clash among them gets `-2`, `-3`) and reached with
  this Mac's token: no sign-in and no ticket. A link made by hand (`links.json`) is kept
  unless a Mac of the net has its name or its address.
