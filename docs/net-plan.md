# Net plan: pair once, reach every Mac

Decided on 2026-10-23, from the backlog's "Easier pairing, and setting the host device".
"i just want this connection and onboarding process to be smoother while
maintaining a reliable connection between all devices that can be performant in poor
cellular", and "a phone or ipad should be able to see all servers after connecting to one
(or the net) same with computers". For the alpha: "before rn everything is being preped
for alpha testers". Then: "Just make the current bridge changes, and then you can build
Cloudflare as a backup", built by a workflow, with the remaining design decisions left to
me ("make any more design decisions for the bridge and the plan"); they are written down
below as decided.

## Today

- Each device keeps its own list of Macs (`hosts.json`, passwords in the keychain per
  host, `HostConfig` in AgentCore `Host.swift`) and nothing is shared between devices.
  Every device pairs with every Mac by that Mac's pairing link
  (`portals://pair?…&password=…`, docs/pairing-and-relay.md), which only the Mac's
  terminal shows (`portals-bridge setup`, `portals-bridge pair`). The app can scan one
  (`PairingScanner.swift`) but not show one.
- Macs reach each other by fleet links made by hand, one way each
  (`portals link`, `links.json`, `bridge/src/fleet/links.ts`), with the other Mac's
  password.
- A connection: password sign-in (scrypt) for a session cookie that lives in memory, so
  after every relaunch; then `POST /api/auth/ws-ticket`; then the WebSocket
  (`PasswordAuthenticator.swift`, `bridge/src/http/auth.ts`). One WebSocket per Mac.
- Everything goes over Tailscale (`tailscale serve` in front of `127.0.0.1:9120`).

## the decisions

- **A net, no home** ("maybe not home yet"). Every bridge keeps a copy of the net's
  member list and any Mac in it can add a member, so no Mac has to be awake for the
  others to work. A home Mac that owns the list can come later on top of this.
- **Pairing with any one Mac reaches all of them**, devices and Macs alike (yes). Any
  Mac's pairing link is now a key to the whole net.
- **A device already in the net can add another** (yes), by a code it shows, so adding
  a device needs no terminal.
- **One net per device.**
- **Before the alpha.**
- **Cloudflare as a backup:** Tailscale first; the relay only when the Mac cannot be
  reached directly ("if it's working normally through Tailscale, people won't have to
  use Cloudflare"). Each Mac keeps an idle standby connection to the relay so it is
  ready.

## Why a backup path: Tailscale on iOS 27

Tailscale on iOS 27 can look connected while nothing gets through after the phone moves
between Wi-Fi and cellular, and turning it off and on fixes it. The user pointed at
magicsock: in tailscale/tailscale 21832 (Tailscale 1.104.1, iOS 27.0.1) magicsock's
ReceiveDERP loop stops on every move from Wi-Fi to LTE while the VPN still shows
Connected; 19504 is the same with ReceiveIPv4 since iOS 26.4; also 21388, 21819. No fix
from Tailscale yet. It is inside Tailscale's network extension, which Portals cannot
restart or toggle, so the app can only notice it and say so, or reach the Mac another
way: the relay.

## Decided for the build: the bridge (N1)

**Always in a net.** A bridge with no `state/net.json` makes a net of one at start: a new
net id (16 hex), its own Mac entry, its own token, its own X25519 key pair, its own relay
id and secret. Nothing changes for a bridge nobody joins.

**Files** (owner only, `writeJSON`):
- `state/net.json`: `{ "net": "<16 hex>", "members": [ … ] }`, copied to every Mac.
- `state/net-own.json`: what never leaves this Mac: `token`, `key` (the X25519 private
  key as a JWK), `relay: { id, secret }`.

**A member:**

| Field | For | What |
|---|---|---|
| `id` | both | a Mac's machine id (`state/machine.json`); a device's id, made by the app once. `^[A-Za-z0-9-]{8,64}$` |
| `kind` | both | `mac` or `device` |
| `name` | both | at most 80 characters |
| `url` | Mac | its address with scheme and port, from `setup.json`'s `address`, else config `net.url`, else `http://127.0.0.1:<port>` (scratch bridges) |
| `key` | Mac | its X25519 public key, raw 32 bytes, base64url |
| `relay` | Mac | its relay id (16 random bytes, base64url) |
| `platform` | device | `ios`, `ipados` or `macos` |
| `token_hash` | both | SHA-256 of its token, hex. Never in what a device is given, which has `token_tag` instead: 16 hex digits of SHA-256 over `"portals token tag\n" + token_hash`, made as the entry is given and never kept, so a device can tell two entries under one token (net-5) |
| `removed` | both | `true` once removed; the entry is kept |
| `changed` | both | milliseconds since 1970 of the last change |
| `by` | both | the member id that made it |
| `named` | both | when its name was set from the app (`net.rename`, a Mac's since 2026-10-26, a device's since 2026-10-28): a stamp past every name of it the setting Mac had seen; absent while it goes by its own, or the one it joined with |
| `named_by` | both | the Mac that set it |

Incoming entries that do not fit this are dropped. A net takes in at most 200 members
not removed (removed ones are not counted), and a join may leave the list with at most
1000 entries, removed ones included: admission limits, checked on the whole list a
device or a Mac joining would make before its code is used, which refuse the whole join
(409, a sentence saying the net is full); what a join lets in is kept. A merge, a read
and a sync never drop an entry, so a removal is kept for good and nothing can come back.
Two Macs that each let one in while they could not reach each other end up over a limit,
and both keep both. A list from another Mac (`net.sync`, a Mac's join, the answer to
either) is taken whole however long it is: Macs apart may each have made 1000 entries,
and a removal must reach every Mac. The 64 MiB a frame may carry bounds it.
A Mac rewrites its own entry at start when its name (`macName`), url, key or relay id
changed.

**Merging two copies:** per id, the newer `changed` wins, a tie going to the greater
`by`. Entries are never deleted, so a Mac that slept through a removal cannot bring the
member back. A change to an entry (a removal, a device or a Mac joining again) is stamped
at `max(now, changed of the entry it replaces + 1)`, so a Mac whose clock is behind still
makes the newer one. Every saved change moves the list's `revision`.

**Copying:** `net.sync {net, members}` answers with the receiver's `{net, members}`, so
one call goes both ways. After a change a Mac calls it on every other Mac in the list
(not removed, with a url), in parallel, 10 s each, failures logged at debug level. A Mac
that learns something new from a call copies it on to the others, not back to the
sender. At start (once listening) and every 10 minutes, each Mac calls every other Mac.
A Mac that finds itself removed starts a new net of one (new net id and token; it keeps
its key and relay id) and logs it.

**Tokens:** 32 random bytes, base64url, sent as `Authorization: Bearer <token>`. A token
the bridge does not know makes it call every other Mac first (at most once every 30 s,
callers waiting together), then look again; then it is refused.

**Join codes:** 16 random bytes, base64url; one use, 10 minutes, in memory (a restart
forgets them), at most 20 open (the oldest goes). A code remembers the net it was made
in and lets in to that net only: a Mac that moves to another net (joining one, leaving,
being removed) drops every open code. The link:
`portals://join?v=1&url=<issuing Mac's url>&code=<code>&name=<issuing Mac's name>`. A `v`
above 1 is refused with "Update Portals to join this net".

**`POST /net/join`**, without a sign-in (the code is the credential). Ten failures a
minute, then 429, as for sign-in.
- Body: `{ "code", "member": { id, kind, name, platform? | url?, key?, relay?, token_hash? }, "members"?, "net"? }` (`net`: the net a joining Mac's list is of).
- A device: the Mac makes its token and adds the entry (an existing one with that id is
  replaced and un-removed). Answer `{ net, member, token, members }`, `members` without
  `token_hash`.
- A Mac: it brings its own `token_hash` and its whole list as `members`. Refused (409)
  when that list holds another Mac not removed: "This Mac is in a net with other Macs.
  Run `portals net leave` on it first." Refused (409) as well, whole and before its
  code is used, when the list with the Mac and its devices would have more than 200
  members not removed. Otherwise the Mac merges the joiner's entries (its devices come
  along), answers `{ net, members }` with `token_hash`, and copies the list to every
  Mac. The joiner takes the answer as its list and net id, then copies it to every Mac
  too.

**Gateway, feature `net`** (docs/gateway-protocol.md, section 11). A connection knows how
it signed in: a password session, a member (with its id and kind), or the `portals`
command's socket.

| Method | Who | What |
|---|---|---|
| `net.list` | anyone signed in | `{ net, here, you, revision, members }`: `here` this Mac's id, `you` the caller's member id or null, members without `token_hash` |
| `net.invite` | password, any member, local | `{ link, code, url, expires_at }` |
| `net.remove {member, net?}` | password, device members, local | marks it removed and copies the list; a Mac cannot remove itself so (`net.leave`); with `net`, refused when this Mac is in another net (a switch of nets, net-17) |
| `net.join_with {link}` | password, local | this Mac joins the net of a `portals://join` link, as above |
| `net.rename {name, member?, after?}` | password, device members, local | names a Mac (2026-10-26) or a device (2026-10-28, `net_rename_devices`) of the net for every Mac and device, the latest rename winning (below) |
| `net.leave` | local | this Mac leaves: a new net of one |
| `net.sync {net, members}` | Mac members | as above |

`gateway.ready`'s `bridge` block carries `net: {id, revision}`, and `poll.now` carries the
same, so a device asks `net.list` again only when it moved.

**Signing in with a token:**
- The WebSocket upgrade takes `Authorization: Bearer` and needs no ticket: one round
  trip fewer on every connection, and no scrypt sign-in after a relaunch. The ticket
  path stays as it is for passwords.
- The push routes take the same header. A registration made so is tagged with the
  device's id, and goes when the device is removed. The token is checked again once the
  body is read, right before anything is kept: a device removed while its request was on
  the way is refused (401).
- A removal closes the removed member's open connections with 4401 "This device was
  removed from the net."

**Links follow from the list.** `Links.all()` gives every other Mac in the net (not
removed, with a url) as a link named `machineName(name)` (a clash among them gets `-2`,
`-3`), then the `links.json` links whose name and url no net Mac has. A net link signs
in with this Mac's own token on the upgrade: no sign-in, no ticket.

**The `portals` command** (not in the agents' guide, like `link`): `portals net` (the
list), `portals net invite`, `portals net join [link]` (from its input when not given),
`portals net remove MEMBER`, `portals net rename [MAC] NAME` (2026-10-26), `portals net leave`.

**Setup:** after the pairing QR code, one line: "Already use Portals on another device?
Scan this with Add a Mac there instead." `portals-bridge pair` stays as it is, and so
does the pairing link (`v=1`).

## Decided for the build: the relay (backup path)

**Where:** the same Worker, `portals-relay` (relay/), with a SQLite-backed Durable
Object class `MacTunnel` (a `new_sqlite_classes` migration, so it runs on the free
plan), one object per Mac, named by the Mac's relay id.

**Routes** (WebSockets):
- `GET /v1/tunnel/<relay id>/mac`: the Mac's standby socket, `Authorization: Bearer
  <relay secret>`. The first one claims the object (SHA-256 of the secret kept in its
  storage); later ones must match, else 401.
- `GET /v1/tunnel/<relay id>/mac/<channel>`: the Mac's leg of one device connection,
  same secret.
- `GET /v1/tunnel/<relay id>/device`: a device. No credential at the relay: what is
  sent is sealed end to end, and the bridge checks the device.

**Flow:** a device connects; the object gives it a random channel id and sends
`{"type":"open","channel":"…"}` as text on the standby socket; the bridge opens that
channel's socket; the object pairs the two and passes every message both ways as it is.
When either side closes, so does the other. No standby socket: the device is closed with
4503 "The Mac is not connected to the relay." A channel not taken within 10 s: 4504
"The Mac did not answer."

**Running it cheaply:** the Hibernation API (`ctx.acceptWebSocket` with tags, the channel
in `serializeAttachment`); `setWebSocketAutoResponse` answers the text keepalive `ping`
with `pong` without waking the object; the bridge pings its standby socket every 30 s.
Frames up to 16 MiB (a larger one the bridge answers with an error for that call); at
most 20 device sockets per Mac; at most 60 connections a minute per relay id (a rate
limit binding `TUNNEL_LIMIT`, like the relay's others).

**End to end, between device and bridge** (binary frames; the relay never has a key):
1. Device → `e_d`: an ephemeral X25519 public key, 32 bytes.
2. Bridge → `e_m`: its own ephemeral, 32 bytes.
3. Both: `ikm = X25519(e_d, e_m) ‖ X25519(e_d, S_m)`, with `S_m` the Mac's static key
   from the list (the bridge uses its private half); `salt = SHA-256("portals-tunnel-v1"
   ‖ e_d ‖ e_m ‖ S_m)`; HKDF-SHA256 with info `keys`, 64 bytes: `k_dm` the first 32,
   `k_md` the next 32.
4. Every later frame: AES-256-GCM under its direction's key, nonce 4 zero bytes then an
   8-byte big-endian counter from 0, frame = ciphertext ‖ 16-byte tag, no additional
   data. A frame that does not open closes the tunnel.
5. The device's first sealed frame is `{"token":"<device token>"}`. The bridge checks it
   as it checks a Bearer token, then hands the tunnel to the gateway as a connection
   signed in as that member; refused, it closes with 4401, after one sealed
   `{"refused":"token"}` (`{"refused":"removed"}` for a member removed while its tunnel
   is open). Only that sealed frame is a refusal to the app: a close from the relay
   alone, 4401 too, is a connection failure (docs/pairing-and-relay.md, "The tunnel").
   At most 4 frames and 64 KiB may come while the token is checked.
6. After that each sealed frame is one JSON-RPC text frame, as on a direct WebSocket. No
   compression in this version.

The relay cannot read or change what passes, and a relay pretending to be the Mac fails
at the first frame, having no `S_m`.

**The bridge's side** (`bridge/src/relay/`): the standby socket, opened at start and
again with backoff from 1 s to 60 s, an opening not done within 15 s counting as a
failed attempt; a channel socket per `open`, closed when it is not open and through the
handshake within 10 s; the handshake and
sealing; a socket-like object the gateway takes as it takes a `ws` WebSocket. Config
`relay.enabled` (default true) and `relay.url` (default the deployed relay's address, as
`push.relay`).

**Not yet:** a Mac reached without Tailscale from another device (joining needs the issuing
Mac's url; for Portals on the same Mac, see "A Mac for itself" below); compression over the
relay; files over 16 MiB in pieces.

## Decided for the build: the app

**Membership:** one per device. The device's id is a UUID made once; its token is in the
keychain; the net id and the Macs' entries as last listed are in the app's data folder.

**Macs as hosts:** each Mac in the net is a host signed in with the token
(`Authorization: Bearer` on the upgrade and the HTTP routes). Named by its entry unless
the user renamed it; its address from the entry. A host the user added by hand with the
same machine id becomes the net's (one host, not two). A Mac removed from the net goes,
with its threads, as removing a host does today. Hermes servers and bridges without the
feature stay hand-added as today.

**Keeping up:** `net.list` from the first Mac that connects, and again when
`gateway.ready` or `poll.now` gives a revision other than the one held. The membership
has a generation, this launch's only, that moves on every join, leave and switch; a list
or a removal asked for under an earlier one, or answered by a host let go of, is dropped,
and so is what a host let go of says.

**Refusals:** a Mac refuses the token with 4401 at its address, and through the relay only
with its sealed `{"refused": …}` (docs/pairing-and-relay.md, "The tunnel"); any close from
the relay without one, 4401 too, is the Mac not reached, tried again, never a reason to
leave the net or remove a host. When every Mac of the net refuses, the device is out.

**Scanning** (the scanner in the hosts sheet, and links opened from the Camera):
- `portals://join`, in no net: `POST <url>/net/join`, keep the token, add every Mac.
- `portals://join` of another net: "Switch to this net? Your current Macs will be
  removed from this device." Then join and, once joined, have a Mac of the old net take the
  device out (`net.remove` naming the old net), and leave it here. With no Mac of the old
  net connected, or none answering, the old net is kept (`NetLeftBehind`: its Macs'
  addresses in `net.json`, its token in the Keychain) and its Macs are asked again every
  ten minutes while the app runs, across launches, for seven days; then it is given up and
  the device says so once ("Still listed in your old net").
- `portals://pair` (a Mac's password link), in no net: sign in with the password once,
  `net.invite` on that Mac, redeem the code. The device joins that Mac's net.
- `portals://pair` of a Mac already in the device's net: nothing new; that host is shown.
- `portals://pair` of a Mac outside it ("Add a Mac"): sign in to the new Mac,
  `net.invite` on a Mac of the device's net, `net.join_with` on the new Mac. If the new
  Mac refuses (it is in a net with other Macs), show its message and offer to switch this
  device to that Mac's net instead.
- A bridge without `net`: as today.
- Each of these runs under the membership generation it started in: after every await,
  and so before every call that changes something (`net.invite`, `net.join_with`,
  `POST /net/join`), it stops, with no further call, once the device joined, left or
  switched nets meanwhile ("Your net changed while this was under way. Try again.") or
  the sheet that started it was closed, which cancels it. So does Add a device's code.
  Once a join has worked, though, a closed sheet stops only the wait for the old net's
  Mac in a switch: the new net has the device, so its token and list are kept, and the
  old net is kept to be asked again (bug hunt round 4, APP1). Joins, Adds a Mac and
  switches run one at a time (`NetChanges`) from a code's redemption until what it came
  to is saved, each checking the membership the one before left: two switches at once
  could each redeem a code, and the one saved last keep a token the net had already
  replaced (Codex's review of the round 4 app fixes). A pairing link's password sign-in
  comes before the turn, as it does not stop for a cancel, and one cancelled while it
  waits its turn is dropped at once.

**Settings:** the hosts sheet gets **Add a device**: the QR code of a `net.invite` link
from a Mac that answers, its text below with Copy, and the minutes left. And
**Devices**: every member, Macs and devices, this device marked, each with Remove (with
a confirmation). Removing this device is leaving the net.

**The relay as backup, per host:** direct first. When the direct connection cannot be
made within 5 s (8 s at first; 5 s since N4), or its heartbeat stalls, or its check after a
change of network fails, and the Mac's entry has a `relay` and a `key`,
the app connects through the relay (`PortalsRelayURL` + `/v1/tunnel/<relay>/device`)
with the handshake above in CryptoKit, behind the same transport the JSON-RPC peer uses.
While on the relay it tries direct again every 60 s and when the network changes, and
goes back when direct answers. The host's status reads "via relay" in small text.

## Poor cellular

- **Measure:** how long from coming back to the foreground to a thread's latest reply,
  on the phone over Network Link Conditioner's poor profiles, before and after the
  token sign-in and with the relay.
- **Notice a stall sooner:** check how long the heartbeat takes to notice a stalled
  tunnel and shorten it where it is safe; on the relay path it decides the switch.
- **Say what to do:** when the phone has a network and no Mac answers either way, say
  Tailscale may be stuck and to turn it off and on.

## Milestones

Built on branch `net` (worktree `~/coding_projects/portals-net`). Each ends with its
tests and typechecks passing, then a commit.

| | What | Done when |
|---|---|---|
| N1 | **Bridge net**, as above | Three scratch bridges on one Mac: a device joined through A connects to B and C with its token; a Mac joined through B is linked to A and C both ways; a removal on C keeps the device out of A and closes its connection; a bridge stopped during a change catches up when started again |
| R1 | **Relay**: `MacTunnel`, the routes, the bridge's side, the handshake | Node tests of the object's logic and of the sealing; locally with `wrangler dev`, a scratch bridge and a Node client playing the device: a thread listed and a message sent through the tunnel; a wrong key or token refused |
| N2 | **App net**: hosts from the list, token sign-in, scanning, Add a device, Devices | Unit tests; iPhone and iPad simulators with three scratch bridges: the iPad joins by the iPhone's code and lists all three Macs; a removal takes them away; a hand-added host is matched, not doubled |
| R2 | **App relay backup** | Unit tests of the sealing against the bridge's test vectors; a simulator whose direct address is dead reaches a scratch bridge through the local relay, and goes back to direct when it answers |
| N3 | **the user's Macs and devices**, with the OK | MBP16 and the mini in one net, the devices joined, the relay deployed |
| N4 | **Poor cellular**: measurements, the quicker stall, the message | Before-and-after numbers on a phone |

## A Mac for itself (2026-11-03)

"if they are just on their mac and want to use portals they shouldnt have to setup
tailscale", with users told a phone does need it. The host listens on 127.0.0.1 anyway, so
Portals on the same Mac needs nothing in between.

- **Setup.** Tailscale stays the way setup leads with ("should be an exception to not use
  tailscale"). A Mac with no address goes without it only when the person says so: **Use just
  this Mac without it** beside Check again while Tailscale isn't ready, No to the mapping, or
  `--no-tailscale`. `--yes` and a Tailscale that fails do not count: they leave no address, as
  before, and say how. Setup then writes `http://127.0.0.1:<port>` as the address in
  `setup.json`, and shows a link, not a code. A Mac that already has a tailnet address keeps
  it: its devices count on it, so Tailscale being off is to be put right. Linux has no Portals
  of its own to reach it, and stays as it was.
- **What makes a host one.** Setup's address being a loopback one with no `net.url` set
  (`Net.thisMacOnly`), never the address alone: scratch bridges, the simulator and the tests
  use loopback addresses for real joins between them.
- **The host.** `net.invite` answers only a password sign-in, which is how Portals on that Mac
  joins. Anyone else, and `net.join_with`, is refused with what to do: 127.0.0.1 in a code or
  an entry would have whoever got it dial themselves. It opens no standby to the relay.
- **The app.** A Mac whose net has only loopback hosts (`portalsNeedTailscale`) shows the
  steps in Add a portal in place of a code. An iPhone or iPad given such a link says why it
  can't use it. A Mac in a net with real hosts adds a loopback host by itself, outside the net.
- **Later.** Setup run again with Tailscale replaces the address. The host starts with the new
  one, its entry changes, the app moves to it, and Add a portal, open or not, shows a code.

## Later

- A Mac without Tailscale, reached from other devices through the relay alone.
- A home Mac that owns the list.
- The Macs' order (`machine_order`, newest wins per bridge today) kept in the list.
- Notifications for every thread on every device (the backlog entry on them): every
  device in the net is known to every Mac now.
- Short typed join codes through the relay.

## Testing rules

- Never an installed bridge, the installed Mac app, or real devices. Live checks use this
  branch's bridges in the foreground with their own `PORTALS_BRIDGE_HOME` in scratch
  folders, other ports, `providers.hermes: false` and `codex.mode: "own"` (or the fake
  agent alone).
- The relay is tried with `wrangler dev` on this Mac only. Deploying it to Cloudflare,
  installing anything, publishing to npm and merging into main wait for a go-ahead.

## Progress

### N1, 2026-10-23

**Built** (branch `net`, commits efae8262, a938f9a6, e3ba7a2a), in `bridge/src/net/`
(`members.ts`: the entry, its checks, merging; `codes.ts`: join codes and their failure
limit; `net.ts`: the files, the key pair, relay id and secret, tokens, joining, removal,
leaving, copying), wired in `bridge.ts`, `http/server.ts` (Bearer on the upgrade and the
push routes, `POST /net/join`), the gateway (feature `net`, the six methods, `net` in
`gateway.ready` and `poll.now`, how each connection signed in), `fleet/links.ts` (the net's
Macs as links, by token), `push/store.ts` (registrations kept under the member, dropped on
removal), `config.ts` (`net.url`, `state/net.json`, `state/net-own.json`), `portals.ts`
(`portals net …`, in the usage and not in the agents' guide), and setup's line after the
QR code. Documented in docs/gateway-protocol.md (sections 2 and 11),
docs/pairing-and-relay.md and bridge/README.md (since 0.3.0 in bridge/DEVELOPING.md).

**Checked:** `npm test` (1600 tests, all pass), `npm run typecheck`, `npm run contract`, and
`scripts/check-contract.sh bridge/contract.json` (OK). `bridge/test/net.test.ts` has the
rules: merging, removal outliving an older copy, the 200 cap, entries that do not fit, the
code rules (one use, expiry, 20 open, ten failures a minute), the join link, token lookup,
the pull on an unknown token (once per 30 s, callers together), a Mac joining with its
devices and the 409, a removed Mac starting a net of its own, leaving, and a Mac removed
while off learning it as it starts. `bridge/test/net-bridges.test.ts` is the "Done when"
row with three in-process bridges (and a fourth outside the net): B joins A, C joins
through B, and all three list each other's threads both ways; a device joined through A
opens B and C with `Authorization: Bearer` and no ticket, and registers for notifications
with it; a removal on C closes its open connection on A with 4401 and keeps it out of all
three; C stopped while A removes a member catches up as it starts again on another port,
and A reaches it at its new address; the password and ticket path (every test client) and
a `links.json` link to the fourth bridge still work; the `portals net` commands. Live,
two bridges from `src/main.ts` in `/private/tmp/portals-net-n1/` on ports 9311 and 9312
with the fake agent alone: `portals net invite` and `portals net join` from its input,
a device joined with curl through B connected to A with its token, and `portals net
remove` on A closed its open connection on B with 4401 "This device was removed from the
net." Both stopped afterwards.

**Deviations:**
- A removed Mac's token is still taken, for `net.sync` only (any other method is 4003),
  and it is answered without being heard, with its own entry alone; the Mac that removes
  another also calls it once. The copying above goes only to Macs not removed, so otherwise a removed Mac, and
  above all one asleep through its removal, would never find itself removed.
- `net.leave` first tells the other Macs this Mac is removed (told, their answers not
  taken), then starts the net of one; the plan did not say how the others learn of it.
- Of this Mac's own entry only a removal is taken from another Mac's copy: the rest is
  this Mac's to say.
- The issuing Mac copies the list on to every Mac but the joiner, which has the answer
  and may not know the issuing Mac's token yet.
- A Mac's join is refused (409) only for a Mac in its list that the issuing Mac's net
  does not have, so a Mac joining a net it is already in is not refused; the check comes
  before the code is used, so the code still works after a 409. Also refused: an id the
  net has for the other kind (409), a full net (409), a body it cannot use (400), a code
  used, expired or wrong (401).
- `state/net.json` also keeps `revision`, which is this bridge's own count (not copied).
- A connection signed in some way a method does not take gets the new error code 4003,
  with a sentence; a param type `list` was added for `net.sync`'s `members`.
- A Mac name longer than 80 characters (`fleet.name` allows 100) is cut to 80.
- `poll.now` carries `net` to every device that asks, besides `thread_list`.
- The counters number the links by their place among all of them (the net's Macs first,
  then `links.json`'s), not in `links.json` alone.
- A thread whose only watcher was a removed device leaves push.json with it (an empty
  list of watchers would be every device's).
- The contract test counts `net` among the features the app does not use, until N2 puts
  it in the app's contract subset.
- No `relay` config block: nothing in N1 needs it (R1 adds it).
- Merging (after the review below): a Mac's own entry (`by` its own id) under the token it
  was removed with never undoes its removal, whichever is newer; a Mac's join entry is
  made `by` the Mac that takes it in (the plan had the joiner), and a removal or a leave
  is stamped at least 1 ms after the entry it replaces.
- `state/net.json` also keeps `left`: the net this Mac last left, its entry there
  (removed) and the other Macs' ids and token hashes. Only the last such net is kept, and
  for good: a later leave from a net with other Macs replaces it.
- Both net files are saved with a `.bak`; one that cannot be used is taken from its `.bak`
  (net.json's saved at once two revisions past it, past the save it lost), and with no
  usable `.bak` both are kept aside as `.corrupt-<time>` and the bridge goes on in a net of
  its own, as the registry does for threads.json, instead of refusing to start: a bridge
  that would not start leaves out the password devices too. The registry's reader moved
  into `store/jsonFile.ts` (`readStateFile`) for both.

**Review fixes, 2026-10-23** (commit 0dd13ade), five findings, all confirmed and fixed:
- A Mac removed while off that came back with a new name or address rewrote its own entry
  newer than the removal and stayed in the old net; worse, a Mac that had missed the
  removal could take that entry and bring it back everywhere. Fixed in `isNewer` (above).
- `net.leave` told the others once: a Mac asleep then kept the leaver for good. Fixed with
  `left` (above): its next call is answered in the old net's terms with the leaver's
  removed entry, also after the leaver restarted.
- An empty or unreadable `net.json` became a new net of one, written over the old file.
  Fixed with the `.bak` and keeping it aside (above); `net-own.json` likewise.
- A removed Mac's `net.sync` was answered with the whole list and every token hash; now
  with its own entry alone.
- A removed device's token made the Mac ask every other Mac; a token the list knows,
  removed or not, is now answered at once.

Checked: `npm test` (1605 tests, all pass), `npm run typecheck`, `npm run contract` (no
change) and `scripts/check-contract.sh bridge/contract.json` (OK). New tests in
`net.test.ts` (the merge rule, a removed Mac back under a new name and address with a Mac
that missed the removal, the answer to a removed Mac, leaving while a Mac sleeps and a
restart after, both files from their `.bak` and kept aside, no asking for a removed
device's token) and in `net-bridges.test.ts` (a removed Mac stopped and started again on
another port finds itself out, over real bridges); each failed before the fixes.

**Left:** the relay (R1) and the app (N2). Not checked: `scripts/check-contract.sh` with
no argument (it needs a Hermes install's contract, which this Mac does not have at
`~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json`); leaving while
another Mac sleeps over real bridges (only with the stand-ins in net.test.ts); no live
run from `src/main.ts` for the review fixes; `portals-bridge status` does not show the net
yet, and the bridge's "No password is set up, so nobody can sign in" warning is as
before, though net members can sign in without one.

### R1, 2026-10-24

**Built** (branch `net`, commits e85ecf55 and 23ee2be5):
- `relay/`: `src/tunnel.ts`, the object's logic as a plain class over its sockets, storage
  and alarm (claiming with the relay secret's SHA-256, pairing a device with the Mac's leg
  of its channel, passing messages as they are, closing the other end with the same code,
  the 10 s alarm, the limits), and the Worker's part of the routes (`makeTunnelRoute`: the
  path, the upgrade, `TUNNEL_LIMIT` per relay id, then the object). `src/worker.ts` has the
  Durable Object class `MacTunnel` (hibernatable sockets with tags and attachments,
  `setWebSocketAutoResponse` for `ping`/`pong`, the alarm), and sends `/v1/tunnel/…` to it
  before the notification routes look for their secrets, with minimal type declarations
  for the Workers APIs it uses. `wrangler.jsonc`: the `MAC_TUNNEL` binding, migration `v1`
  with `new_sqlite_classes: ["MacTunnel"]`, and `TUNNEL_LIMIT` (60 a minute). The push
  routes are as they were.
- `bridge/src/relay/`: `seal.ts` (X25519, the salt, HKDF, the nonce, a `Sealer` and an
  `Opener` per direction), `tunnel.ts` (the bridge's leg of a channel: the handshake, the
  token checked with `Net.authenticate`, pull-on-unknown included, then a socket the
  gateway takes as a `ws` WebSocket), `standby.ts` (the standby socket, the legs). The
  gateway's `accept` and `Connection` now take a `GatewaySocket` (the members they use of
  a `ws` WebSocket), which both satisfy. `Net.agree` does X25519 with the Mac's private
  key without handing it out. Config `relay.enabled` (default true) and `relay.url`
  (default the deployed relay, as `push.relay`); the tests' and the bench's bridges have
  it off.
- `bridge/test/fixtures/tunnel-vectors.json`, written by `bridge/scripts/tunnel-vectors.ts`
  from fixed phrases; `bridge/scripts/tunnel-device.ts`, a device in Node;
  `bridge/scripts/tunnel-check.ts`, the end-to-end check against any relay address.
- Docs: "The tunnel" in docs/pairing-and-relay.md (routes, close codes, handshake, frames,
  the vectors' fields), a line in docs/gateway-protocol.md section 2, relay/README.md (the
  object, the migration, trying it locally, what deploying adds), the two config keys in
  bridge/README.md (since 0.3.0 in bridge/DEVELOPING.md, Settings).

**Checked:**
- `cd relay && npm test` (27 tests: the 17 before and 10 of the tunnel's object in
  `test/tunnel.test.ts`, over stand-ins for the sockets, storage and alarm, each step by a
  new object as after hibernation) and `npm run typecheck`.
- `cd bridge && npm test` (1621 tests, all pass; one run before had "Stop as Claude
  finishes" in claude-bridge.test.ts time out under load, which passed three times alone
  and in the next whole run), `npm run typecheck`, `npm run contract` (no change), and
  `scripts/check-contract.sh bridge/contract.json` (OK). `bridge/test/tunnel.test.ts` (16):
  the vectors against the code and again through WebCrypto (SHA-256, HKDF, AES-GCM by
  another road), X25519 against RFC 7748 section 6.1, a frame opening only once and in its
  turn (tampered, wrong tag, out of turn, replayed, short, another key), an answer over
  16 MiB turned into an error and an event that large left out, the handshake's time
  limit, a 31-byte key, a low-order key and a text frame refused, frames sent while the
  token is checked reaching the gateway in order, the standby socket's backoff (20, 40,
  80, 80 ms with the times shortened) and a standby socket with no `pong` opened again,
  the config keys; then a real bridge and devices through the relay's own object run
  in-process over `ws` (`bridge/test/relay-standin.ts`, which mounts `relay/src/tunnel.ts`):
  a device joined with a code signs in with its token, `net.list` says it is that member,
  it lists threads and gets the fake agent's reply; a wrong token 4401; a wrong Mac key
  4400 at the first sealed frame with nothing opened; a changed frame 4400; `net.remove`
  closes the device's tunnel with 4401 and keeps it out; the standby socket back after
  the relay drops every socket; another secret refused (401).
- Locally with `wrangler dev` (no Cloudflare sign-in asked for or used): wrangler 4.151.3
  from the npx cache (`~/.npm/_npx/…/wrangler dev --port 8790 --ip 127.0.0.1 --persist-to
  /private/tmp/portals-net-r1/wrangler-state`; `npx --no-install wrangler@4.151.3` would
  not run it, and nothing was downloaded), which listed `MAC_TUNNEL` and the three rate
  limits as local bindings. A probe by hand: the standby socket claims, `ping` gets `pong`
  from the auto-response, another secret 401, a device's first frame waits for the Mac's
  leg and is delivered, the leg's 4401 reaches the device, 4503 with no standby socket,
  4504 after 10 s. Then `node scripts/tunnel-check.ts http://127.0.0.1:8790
  /private/tmp/portals-net-r1/bridge` (a scratch bridge from `startBridge` on a free
  port, the fake agent alone, `relay.url` the local relay): a device joined with a code,
  through the relay did the handshake and token and got `gateway.ready`, `net.list` said
  `you = tunnel-check-phone`, `threads.list` listed the thread made over the direct
  connection, `session.resume` and `prompt.submit` got "Hello from the fake agent. You
  said: Hello through the relay.", it closed with 1000; a token the bridge does not know
  closed 4401 "The token was not accepted."; a device using another key for the Mac closed
  4400 "A frame through the tunnel did not open." with nothing opened. Passed. wrangler
  stopped afterwards, its state and the scratch bridge's folder removed, no process left.

**Deviations:**
- Close codes the plan did not name: 4400 from the bridge for a frame that does not open,
  a handshake not understood (a key not of 32 bytes, or of low order) or a text frame, and
  from the relay for over 1 KB sent before the Mac's leg came; 4408 for a handshake and
  token not in within 10 s; 4409 for a standby socket a newer one replaced; 4429 for a
  21st device. The Mac's leg is refused 404 when no device waits on its channel (also
  before any claim) and 409 when the channel has its leg; a non-WebSocket request 426.
- A device's frames sent before the Mac's leg is there (its key) are kept in its socket's
  attachment, up to 1 KB, so they outlive hibernation.
- A newer standby socket takes the place of the one before, which is closed (4409), so the
  object tells only one about each device.
- Of the frames over 16 MiB, an answer becomes an error for its call (-32603, a sentence
  saying it comes when the device reaches the Mac directly); any other (an event) is left
  out with a warning, since there is no call to answer.
- The object answers every socket's close itself (`closed` closes it back): under
  `wrangler dev` with this compatibility date a device that closed waited for the
  handshake and saw 1006 otherwise.
- The standby socket's wait goes 1 s, 2 s, … up to 60 s, and starts again at 1 s only
  after a socket that stayed open a minute, so a relay that takes and drops it at once is
  not hit every second.
- The gateway's protocol pings on a tunnel go to the bridge's leg and are answered by the
  relay, not the device; the app's heartbeat is what tells a stalled tunnel.
- The bridge's tests run the relay's own object logic (`relay/src/tunnel.ts`) in-process
  rather than a separate fake of it.
- wrangler 4.151.3 rather than the README's 4.139.0: what the npx cache had.

**Left:** R2 (the app's side, against the vectors), deploying (N3). Not checked: anything
on Cloudflare itself (hibernation in production, its message size limit, the real rate
limiter). Under `wrangler dev` a socket the object closes (4503, 4504, a refused one)
gets its close frame at once but its connection ends about 10 s later; not looked into
further. Every bridge built from this branch opens its standby socket to the deployed
relay by default, which until the tunnel is deployed answers 404, so it tries again once
a minute (logged once). The first standby socket claims an object: anyone who knew a
Mac's relay id before that Mac first connected could claim it first (the id is random
and the Mac connects as it starts, but the id is in the list every member has).
`portals-bridge status` does not show the relay's state.

### N2, 2026-10-24

**Built** (branch `net`, commits 68048a35, c1c1e32b). In PortalsKit: `AgentCore/Net.swift`
(`NetMember`, `NetList`, `NetMembership` with the device's id, the net id, the members and
each Mac's revision, kept as `net.json` in the data folder by `ThreadStore.loadNet`/`saveNet`;
the token in the Keychain through `CredentialStore.netToken`; `JoinLink` and `PortalsLink`;
`NetHosts.apply`, the hosts the list makes; `NetScan.decide`, what a code comes to;
`NetReporting`), `HostConfig.netMember`/`netName`, `HermesBackend/TokenAuthenticator.swift`
(`Authorization: Bearer` on the upgrade, no query, and on every REST call),
`HermesBackend/NetWire.swift` (the four methods, the readers, `NetJoinClient` for `POST
/net/join`), `gateway.ready`'s `bridge.net`, and `HermesBackend.netNews` (the revision as each
connection opens and with each `poll.now`; a token's 4401 with its sentence). In the app:
`Portals/App/Net.swift` (keeping up, the scanning cases, invite, remove, leave),
`Fleet.netChanged`/`netLeft`, the token authenticator for net hosts (`HostDirectory`),
`HostSettingsSheet` taking a pair or join code through the net (Add this Mac, Join, Switch
with its confirmation, a refusal offering the Mac's net), the scanner and `portals://`
links reading both kinds, `HostsSheet` with Add a device (`AddDeviceSheet`: the QR code, the
link with Copy, the minutes left, a new code when it runs out) and Devices (every member,
Macs first, this device marked, Remove or Leave with a confirmation; a net host's Remove is
the net's), and an alert when the device was taken out from elsewhere. The net methods the
app sends are in `contract-subset.json`'s `bridge.methods`.

**Checked:** `swift test` in Packages/PortalsKit (all pass; new: `NetTests`, 14, for the
membership store, the join link, the hosts from the list and the scanning decisions;
`NetWireTests`, 11, for the authenticator, joining, the revisions, a refused token and the
methods); `scripts/check-contract.sh bridge/contract.json` (OK) and the bridge's
`test/contract.test.ts` against the new subset (6 pass); builds for a scratch iPhone 18 Pro
and iPad Pro 13-inch (M5) simulator and for Mac Catalyst (`CODE_SIGNING_ALLOWED=NO`), all
succeeded. Live, with three bridges from this branch's committed bridge (copied out to
`/private/tmp/portals-net-n2/snap`, ports 9411 to 9413, the fake agent alone), B and C joined
to A with `portals net invite`/`join`: the iPhone simulator, with a hand-added Mac B (saved
with B's machine id and no password), opened A's join link and joined; it then had three
hosts, `B by hand` (the same host, now signed in with the token) and Mac A and Mac C, all
connected with `Authorization: Bearer` on the WebSocket, and each Mac's list taken. Add a
device showed a code from Mac B; its QR code, read from the screenshot, joined the iPad
simulator, which then listed Mac A, Mac B and Mac C. Removing Mac C from the iPhone's Devices
took it off every Mac's list and off both devices; `portals net remove` of the iPad on Mac B
took the iPad out (its Macs gone, "This device was removed from the net." said once). A
fourth bridge outside the net, its pairing link opened on the iPhone, joined the net by
`net.join_with` and became a host. Screenshots in `/private/tmp/portals-net-n2/`. Bridges
stopped and simulators deleted afterwards.

**Deviations:**
- `net` is in the subset's `bridge.methods` but not its `bridge.features`: the bridge's
  `contract.test.ts` (not this stage's to change) counts it among the features the app does
  not use, and wants the two lists equal. Taking it out of `notForTheApp` and into the
  subset's features is one change for whoever next touches the bridge's tests.
- A hand-added host is matched by its machine id and, when it has none yet (never
  connected), by its address. A second host for a Mac that already has a net host (one
  added by hand that later says the same machine id) is dropped.
- Each Mac's revision is its own count, so the device keeps one per Mac (in `net.json`) and
  asks a Mac again when it says another; on each launch the first net host to connect is
  asked anyway. Only a list from a Mac the device signs in to with its token is taken; one
  of another net is taken when it names the device (`you`), as when a Mac it joined through
  went into another net with its devices.
- A device learns it was taken out from the 4401 its connections close with: another
  connected Mac is asked for the list (its own entry removed ends the membership), and when
  every net host has refused the token the device leaves. The plan did not say how.
- Leave asks a connected Mac to remove the device, then leaves here whether or not the
  answer comes (that Mac closes the connection as it takes the device out). Removing a Mac
  goes through another connected Mac (a Mac cannot remove itself).
- A `portals://join` link of the device's own net (its Mac's address is one of the net's)
  is "known": nothing happens. Whether a join link is of another net is told by the
  address only, so a Mac of the device's net at an address the list does not have reads as
  another net, and asks to switch.
- A join link opened from the Camera shows a sheet with one Join button, as a pairing link
  shows Add this Mac, rather than joining at once.
- Add a device is offered only in a net. A device whose Macs were all added by hand before
  the net is in none until it scans a code.
- Debug switches for the simulator (`DebugLaunch`): `PORTALS_DEBUG_OPEN_LINK` (a link opened
  at launch: `simctl openurl` stops at the system's "Open in Portals?" with no Simulator app
  to tap it), `PORTALS_DEBUG_FROM_CODE` (presses the code sheet's button),
  `PORTALS_DEBUG_HOST_SETTINGS=device|devices`, `PORTALS_DEBUG_NET_REMOVE=<name>`.
- `hermesWebSocketURL` leaves the query out when there is none (it ended in `?` before); the
  test that pinned the `?` was changed.

**Left:** the relay as backup per host (R2). Not checked: scanning with a real camera, the
Camera app opening a link (the switches stood in), Switch to this net and a Mac's refusal
offering its net (only the decisions and the wire are tested), the Mac Catalyst app run
(built only), Keychain behaviour on a real device, and editing a net host's name in its
settings. The Devices list on Mac Catalyst has no swipe: Remove is in the context menu
there.

### R2, 2026-10-24

**Built** (branch `net`, commits c1dffe70 and 67f5f6c4). In PortalsKit (`HermesBackend`):
`TunnelSeal.swift` (the keys from the two ephemerals and the Mac's static key, the salt,
HKDF, the counter nonces, a `Sealer` and an `Opener` per direction, in CryptoKit; a key
CryptoKit refuses, as one of low order, ends the handshake), `RelayTunnel.swift`
(`RelayRoute`: the relay, the Mac's relay id and key from its entry, the token;
`RelayTunnelTransport`: the device's leg as a `WebSocketTransport`, which does the handshake
and the token frame as it opens and seals and opens every frame after it),
`RelayFallback.swift` (which way an attempt tries first, and what counts as the Mac not
reached), and `HermesBackend` using them: with a route, the address is given 8 s on the
backend's clock, then the relay; a reconnect goes through the relay first while the address
has not answered since; the address is tried every 60 s and at once when the network
changes, and when it answers the connection moves to it (threads followed again as after a
reconnect, the relay's socket closed). `HermesConnection.open(transport:)` opens over a
socket made already. `ConnectionRoute` and `RouteReporting` in AgentCore. In the app:
`Net.relayRoute(to:)`, read as each attempt begins; `Fleet` gives each net host its route;
`HostModel.route` and `isViaRelay`; "via relay" in small text by the status in the list of
Macs and under the Mac's name in the sidebar; `PORTALS_DEBUG_RELAY_URL`, which
`RelayRegistration.relay` takes before `PortalsRelayURL`. Docs: "The app's side" in
docs/pairing-and-relay.md.

**Checked:** `swift test` in Packages/PortalsKit, all pass (HermesBackendTests 477, 24 new).
`TunnelSealTests` (10): the copy of the vectors is byte for byte the bridge's file; the key
pairs, both shared secrets, `ikm`, the salt, `k_dm` and `k_md` are the vectors'; every nonce;
the device's three frames seal to the vectors' bytes and the bridge's three open (the last
outside ASCII), and the device's open with `k_dm` as the bridge would; a frame out of turn,
changed, replayed, short or under the other direction's key does not open; another static key
makes other keys; keys of 31, 33 bytes or of low order end the handshake; the route's checks
and its WebSocket address. `RelayFallbackTests` (14), scripted sockets for both ways and a
test clock: an address that answers is used and the relay never tried; one silent for 8 s is
let go of (its socket closed) for the relay; one refused at once goes to the relay without
waiting; a 4401 at the address is not tried through the relay; a Mac with no route waits only
at its address; a 4401 through the relay is said as the Mac's no (`netNews`); with both
failing the address's error is said and the waits go on; a dropped tunnel is opened again
through the relay first; on the relay the address is tried after 60 s (silent: stays), and
after another 60 s it answers and the connection moves (route `.direct`, `.connected` again,
the tunnel closed); a change of network tries the address at once; a run going on is resumed
on the address it moved to; a stalled check on the address sends the next attempt through
the relay; the decisions alone. `scripts/check-contract.sh bridge/contract.json` OK (no
method added). Builds: the scratch iPhone 18 Pro simulator and Mac Catalyst
(`CODE_SIGNING_ALLOWED=NO`) both succeeded.

Live, in `/private/tmp/portals-net-r2/`: `wrangler dev` (4.151.3 from the npx cache, local
mode, no sign-in) on 127.0.0.1:8790 from a copy of the committed relay; a scratch bridge from
a copy of the committed bridge (`startBridge`, port 9511, the fake agent alone, `relay.url`
the local relay, `net.url` http://127.0.0.1:9521), with a TCP proxy on 9521 standing for its
address (`scripts/proxy.mjs`: stopped, the address is refused; `--hang`, it takes connections
and passes nothing). A scratch iPhone simulator with a hand-added Mac R opened the bridge's
join link (`PORTALS_DEBUG_OPEN_LINK`, `PORTALS_DEBUG_RELAY_URL`) and was connected at the
address. With the proxy stopped, the app's log said "Mac R is reached through the relay"
0.6 s after the drop, and wrangler's log has `GET /v1/tunnel/<id>/device 101` and the Mac's
leg `GET /v1/tunnel/<id>/mac/<channel> 101`. Launched again with `PORTALS_DEBUG_PROMPT`, a
message went through the relay and the fake agent answered ("Hello from the fake agent. You
said: Hello through the relay.", r2-1-thread-via-relay.png); the list of Macs read "Connected
via relay" (r2-2-hosts-via-relay.png). With the proxy back, the app moved to the address 60 s
after it went through the relay (bridge: a connection opened, the relay's closed with 1000;
r2-3-hosts-direct-again.png, "Connected" alone). With the proxy holding connections, the
minute's try waited its 8 s and stayed on the relay, and a launch went through the relay 8.4 s
after it began. Everything stopped afterwards, the simulator deleted, wrangler's state
removed. The system's notification prompt shows over two of the screenshots: the simulator
cannot be granted it from the command line and no Simulator app was open to tap it.

**Deviations:**
- An address refused at once (nothing listening) goes to the relay at once, without waiting
  out the 8 s: it "cannot be made" sooner. A refusal by the Mac itself (4401, 4403, a
  sign-in error) is not tried through the relay, which would hear the same.
- Once the address failed or stalled, reconnects go through the relay first (then the
  address, 8 s) until the address answers again, so a Mac reachable only through the relay
  is not waited for at its address on every reconnect. A change of network puts the address
  first again.
- The 8 s cover the whole opening up to `gateway.ready`, not only the socket.
- When both ways fail, the address's failure is what the status says.
- Moving back to the address is a reconnect for the threads (running ones resumed, the rest
  told `.detached`), on a second socket opened before the relay's is closed.
- The copy of the vectors is in the tests' fixtures, with a test that it is the bridge's file.
- `PORTALS_DEBUG_RELAY_URL` is read by `RelayRegistration.relay`, so it is the relay for the
  device's registration too, not only the tunnel.
- "via relay" shows only while connected; in the sidebar it takes the line the status uses
  for a problem.

**Left:** N3 (deploying), N4. Not checked: a real device or Tailscale's own stall (the proxy
stood for both), the Mac Catalyst app run (built only), a move back while a run is going on
live (unit-tested only), the push routes (REST) while on the relay: they go to the address
and fail until it answers. The heartbeat is the peer's 45 s, so a stalled address is noticed
that late (N4). The Info.plist's `ITSAppUsesNonExemptEncryption` false says the app uses
CryptoKit and nothing of its own; the tunnel's end-to-end encryption may need that answer
looked at again before TestFlight.

### Review fixes for R1, N2 and R2, 2026-10-24

Seven findings from independent reviews, all re-checked and found real, all fixed (commits
c0af5971, 034a16a4, d345f400):
- **A device's frame over 16 MiB closed the tunnel** (the leg took 16 MiB and the tag, so a
  `file.attach_bytes` of a file over about 12 MB ended in 1009 and no answer). The leg now
  takes up to the relay's own 32 MiB, and a request over 16 MiB is answered with -32603 for
  its id ("The request is over 16 MiB, too large to send through the relay. Try again when
  this device reaches the Mac directly."), anything else that large left out with a warning;
  the tunnel stays open. The app does not send a call over 16 MiB through the relay at all:
  `WebSocketTransport.checkCarries`, which the relay's transport answers with
  `TooLargeForRelay` ("This is over 16 MiB, too large to send through the relay. Try again
  when this device reaches the Mac directly."), fails that call alone before it is queued,
  and the connection stays up.
- **The handshake's 10 s also covered the token's check**, which for a token the Mac does
  not know waits on the other Macs (10 s each). Once the token frame is in, the check has its
  own 30 s ("The Mac took too long to check the token.", still 4408).
- **A slow address was cut at 8 s even when the relay then failed.** With a way through the
  relay, the address's attempt is now kept on when the relay is tried at 8 s (or at once when
  the address cannot be reached), and whichever reaches `gateway.ready` first is the
  connection, the other closed. When the relay goes first and fails, the address has its own
  15 s, not 8. The minute's try of the address while on the relay keeps its 8 s.
- **Switching nets left the old one before the new join was tried**, so a code that did not
  work left the device in no net. The join (or the Mac's sign-in and invite) comes first now,
  and `become` leaves the old net only once it worked.
- **The device took a Mac's list whole**, so a Mac that missed a change (asleep as another
  joined) took that Mac's host away. `NetMembership.take` now merges as the Macs do: per id
  the newer `changed` wins, a tie going to the greater `by`, no entry dropped because a copy
  lacks it, new members after those held. A list of another net the device was carried into
  replaces the old one.
- **A list kept without its token left its hosts behind**, stopped with missing credentials
  for good (a backup restored onto another device). Those hosts now go, quietly, once the
  fleet has them (`Net.attach(to:)`), and the device gets a new id.
- **Every attempt to a net host read the Keychain on the main thread** (`Net.relayRoute`).
  The routes are now `RelayRoutes`, a lock-held copy of the Macs' relay ids and keys kept as
  the membership is saved, read with the token from the backend's own executor.

**Checked:** `cd bridge && npm test` (1624, all pass; two runs before under a load average
over 100 each had one Codex or `portals` timing test fail, a different one each time, which
passed alone and in the third whole run), `npm run typecheck`, `npm run contract` (no
change), `scripts/check-contract.sh bridge/contract.json` (OK); `cd relay && npm test` (27)
and `npm run typecheck` (relay/ unchanged); `swift test` in Packages/PortalsKit, all pass
(the watchdog's two CPU-timing tests failed once under the same load and passed alone and in
the next whole run); `xcodebuild` for the iOS Simulator (generic) and Mac Catalyst
(`CODE_SIGNING_ALLOWED=NO`), both succeeded. New tests, each failing before its fix where it
can: in `bridge/test/tunnel.test.ts` a request over 16 MiB answered with its error and the
tunnel open (over a stand-in leg, and over the relay's own object to a real bridge with a
sealed `file.attach_bytes` of 16 MiB and 1 KB, then `net.list` on the same tunnel), and a
token check taking longer than the handshake's limit accepted while one that never ends is
refused at its own; in `RelayFallbackTests` a slow address taken when the relay answers 4503,
a slow address taken over a relay that had not answered yet (the tunnel closed), the address
not cut at 8 s after the relay failed first, and the tunnel's 16 MiB limit and its sentence;
in `JSONRPCPeerTests` a call the socket does not carry failing alone with the connection
staying up; in `NetTests` a stale copy from a Mac that missed a joining keeping that Mac's
host, an older entry and a tie, and a removed Mac's own copy not undoing its removal.

**Deviations:**
- The plan said the app connects through the relay when the address cannot be made within
  8 s; it now tries both from then on and takes whichever answers first.
- Of a Mac's own copy, its entry saying it is in (made by itself) does not undo a removal the
  device holds, whatever the times: as on the bridges, it may not have heard of it yet. The
  device has no token hashes, so a Mac taken in again after a removal and then renaming
  itself could, in a copy from it alone, read as still removed until another Mac's copy is
  taken (the bridges' entry for the joining is newer). The other way round too (bug hunt
  round 3, 2026-10-26): a Mac's own entry the device holds, made by itself, gives way to a
  removal that comes after, whatever the times. A Mac removed while it was off writes its
  entry anew as it starts (a new address) and could give that to the device before hearing
  of its removal; newer than the removal, it kept a host for that Mac on the device, which
  refuses the token, for good. The cost is the mirror of the one above: a Mac taken in
  again that then wrote its own entry reads as removed while the device's newest copy is
  from a Mac that slept through the joining, until that Mac has caught up and is listed again.
- A Mac joining a net (`net.join_with`) takes along what changed on its own list while the
  answer was on its way, its devices that joined and its removals (bug hunt round 3,
  2026-10-26); so that nothing of another net comes along, it refuses a second join of its
  own and a Mac joining it (409) until the first is answered, and a leave of its own.
  What it brings leaves out a removal of a member the net has in under another token: that
  removal is of the member's way into the joining Mac's net (a phone that went from there
  to this net, then removed there), and its later time says nothing of its way into this one.
  The joining Mac says which net its list is of (`net` in the request); one of this net
  joining it again, or a bridge that does not say, brings its removals as they are. It
  refuses, and is refused, any join while it leaves its net.
- A Mac that writes its own entry anew stamps it after the one it replaces, which a Mac
  whose clock is ahead may have made as it took it in.
- A device whose Keychain lost the token but kept its data folder on the same device also
  gets a new id: its old entry stays in the net's Devices until removed there.
- The leg's limit is the relay's documented 32 MiB, not checked against Cloudflare itself.

**Left:** not checked live: switching nets with a code that fails, a restore without the
token, and a large attachment through a real relay (only the tests above); the three app
fixes in Portals/App (switching, the lost token, the routes) have no unit tests, there
being no test target for the app, and were built only.

### N4 (first part), 2026-10-24

the go-ahead: "Shorten stall detection" first. Done in the app, on this branch:

- **A Mac the relay reaches is checked after any change of network.** Before, a connection
  was checked (a `gateway.ping`, 5 s for anything to arrive) only when the interface it went
  out by went with the change; one through Tailscale whose interface stayed (cellular with
  Wi-Fi joining, or a tunnel the system lists after the radio) waited for the heartbeat's
  45 s. Now, for a host with a way through the relay connected at its address, every
  change of network with a way out checks it (`networkChanged` in `HermesBackend.swift`);
  a check that fails ends the connection as stalled, so `RelayFallback` sends the next
  attempt through the relay first. The cost, for such a host only: a large frame on its
  way over a slow link when the network changes may be cut, and fetched again after a
  reconnect. Hosts without the relay keep the old rule.
- **The address is given 5 s, not 8,** before the relay is tried as well (`directLimit`):
  since the review fixes the address's attempt goes on beside the relay's, so a slow but
  working address still wins when it answers first.
- **"If Tailscale is on, it may be stuck: turn it off and on in the Tailscale app."** under a
  Mac in the Macs list that cannot be reached at a Tailscale address (a `.ts.net` name or
  100.64.0.0/10), unless its sign-in was refused (`HostModel.tailscaleHint`).
- Checked: two new tests in `RelayFallbackTests` (a change that keeps the way out still
  checks the address, and one that answers keeps its socket), the existing relay and
  network tests with the 5 s limit, the whole PortalsKit suite (484 and 850) and an iOS
  Simulator build.
- Left of N4: the measurements on a phone over poor network profiles, before and after;
  the heartbeat itself (15 s, 45 s) unchanged, since a shorter deadline would cut large
  frames on slow links for every host.


### Codex review fixes (the bridge), 2026-10-24

The independent review of this branch (Codex, GPT-6.1 Sol) found nine things; the
bridge's are findings 2, 3, 4, 6, 7, 8 and 9, and its side of finding 1. Each was
confirmed in the code first, and each test below fails without its fix.

- **1, the bridge's side: a relay could forge a refusal.** The app took a 4401 through the
  relay as the Mac refusing its token, and the relay can send any close code. Now the
  bridge first sends one sealed frame, `{"refused":"token"}` or `{"refused":"removed"}`
  with the sentence as `message`, then closes with 4401 as before (`Tunnel.tellRefused`;
  the removal goes through `Tunnel.close`, which the gateway calls with 4401 only for a
  member taken out of the net). A token check that failed on the Mac sends none, so the
  device tries again. The app's side (only a sealed refusal is one) is its own commit.
  Tests: in `tunnel.test.ts`, a refused token and a removed member each give the device
  exactly that frame before the close, other closes and a failed check give none, and
  through the relay's object to a real bridge the device opens `{"refused":"token"}` and,
  removed, `{"refused":"removed"}`.
- **2: a push registration in flight outlived the device's removal.** The token was
  checked before the body was read and never again. Now the push routes check it again
  (`Net.known`, the list as it is, asking no Mac) once the body is in, right before
  anything is kept, and answer 401 for a member gone meanwhile. Test (`push.test.ts`):
  headers and half a body, the device removed, the rest sent: 401 and nothing stored.
- **3: an old join code let into the Mac's next net.** Codes did not know their net. Now
  a code remembers the net it was made in, `/net/join` takes it only in that net, and
  every open code goes when the Mac moves to another (`commit` with a new net id: joining,
  leaving, being removed). Tests (`net.test.ts`): `JoinCodes` refuses a code for another
  net and after `clear`; a code made before each of the three moves is refused with 401
  after it, and a new one works.
- **4: frames before the token could fill the bridge's memory.** Everything that came
  while the token was checked was kept. Now at most 4 frames and 64 KiB in all are kept;
  more closes the tunnel with 4400, and what was kept goes on a refusal and on a close.
  Test (`tunnel.test.ts`): a fifth frame, and 70 KiB in two, close it; a token accepted
  after that reaches no gateway.
- **6: a rejoin through a Mac whose clock is behind was undone.** A device's or a Mac's
  new entry was stamped with that Mac's clock, older than a removal stamped by a Mac
  ahead. Now it is stamped `max(now, changed + 1)` of the entry it replaces, as removals
  were. Test: Alpha an hour ahead removes a device and a Mac, both join again through
  Beta, and all three Macs keep them in.
- **7: a relay that took the standby socket's request and never answered stopped the
  bridge trying.** Now the standby socket not open in 15 s is given up as a failed
  attempt and opened again after the usual wait. A leg was already held to the tunnel's
  10 s (its handshake timer starts as the leg is opened, and closing a socket still
  opening lets go of its request), so it is left as it was and only tested. Test: a relay
  that answers no request sees the standby socket asked for again and again and every
  waiting request let go of, then a leg it never answers let go of too.
- **8: a Mac whose devices overfilled the net was half taken in.** The cap was checked for
  the Mac alone and the merge then dropped what did not fit, the Mac among it. Now the
  list the join would make, the Mac with its devices, is counted before the code is used,
  and a join over the limit is refused whole (409, "This net is full: with this Mac and
  its devices it would have 201 members, and it takes 200."), the code still good. Test:
  a Mac with 199 devices is refused and nothing of it taken in; with one of them removed
  it joins with the same code.
- **9: two Macs at the cap that each let one in while apart never agreed.** A merge
  dropped entries it had no room for. As decided, 200 is now an admission limit only,
  counted on members not removed when a device or a Mac joins (a join that adds none, in
  a net already over, is not refused); a merge takes every entry. For safety a list holds
  at most 1000 entries (`mostEntries`), and past that every copy keeps the same ones:
  Macs first, then those not removed, then the newer, then by id (`fitEntries`), when
  read and when merged. Tests: a merge past 200, two lists past 1000 merged either way
  keeping the same entries, the 101 oldest removals out; and two Macs at 199 that each
  let a device in while apart both end with 201 and take both tokens, and refuse the next.

Checked: the bridge's whole suite (1632 pass), its typecheck, the contract written and
`scripts/check-contract.sh bridge/contract.json`. The relay was not changed.

### Codex review fixes (the app), 2026-10-24

The app's part of the same review: finding 5, and the app's side of finding 1. Both were
confirmed in the code first, and the tests below fail without their fixes.

- **1, the app's side: a relay could forge a refusal.** `heardRefusal` took any
  `WebSocketClosed` 4401 as the Mac refusing the token, and the relay's tunnel passed its
  socket's close up as one: a relay that closed with 4401, before the handshake or after,
  had the app leave the net, forget its token, remove its hosts and delete their threads.
  Now `RelayTunnelTransport` turns every close of the relay's socket, whatever its code,
  into `RelayClosed`, which is the Mac not reached (tried again with the usual waits, and
  not a 4403's stop either), and only a sealed frame it opened whose plaintext is
  `{"refused":"token"}` or `{"refused":"removed"}` is a refusal, given as the 4401 the Mac
  would close with at its address, with the frame's `message` (or "The token was not
  accepted." / "This device was removed from the net."). A 4401 at the address means what
  it did. The tunnel now runs over a small `TunnelSocket`, so the tests play the relay
  and the Mac behind it with the test vectors' key. Tests (`RelayRefusalTests`): the relay
  closing with 4401 as the socket opens, after the token went, and on an open tunnel, and
  a refusal the relay makes up unsealed: no refusal heard, and the next attempt connects
  (the net hears only the list's revision); the Mac's sealed `{"refused":"token"}` is heard
  as `.refused("The token was not accepted.")` as a 4401 was before, and a sealed removal
  on an open tunnel in its own words. Without the fix the first three fail.
- **5: a late answer could undo a switch of nets.** A `net.list` asked of a Mac of net A
  and answered after the device joined B was taken: it lists the device, so `take`
  followed it into A, keeping B's token, and the hosts were made from A's list, taking B's
  Macs and their threads away. Now `NetMembership` has a `generation` (not kept in the
  file, and not part of what makes two the same) that moves on every join, leave and
  switch, including following a Mac into another net; `heard(_:askedIn:)` drops a list
  asked for under an earlier one. `Net` notes the generation as it asks for a list, a
  removal or a Mac's join, drops a list from a host the fleet no longer has, drops what
  such a host says (`said`), and a leave whose call came back after a join or a leave
  meanwhile leaves nothing. Tests (`NetTests`): a list asked for in A and answered after
  joining B is dropped, B's list is taken and nothing after a leave; a list of another
  net that lists the device moves it there a generation on, and the old net's late list
  does not take it back; the generation is not in the saved file.

Checked: the whole PortalsKit suite (491 and 853), an iOS Simulator build, and the bridge's
suite, typecheck, contract and `scripts/check-contract.sh bridge/contract.json` (unchanged
by this part; one run had a timing test of the desk's plan fail under load, the next passed
whole).

### Codex re-check fixes (the bridge, findings 1 and 2), 2026-10-24

An independent re-check of the fixes above found two defects in the 1000-entry cap. Both
were confirmed first, and the tests below fail without their fixes.

- **1: a removal let go of brought a revoked token back.** Past 1000 entries the list kept
  Macs and members not removed first and dropped the oldest removals, when merged and
  when read. A Mac asleep through a device's removal still held the device as a member;
  once the removal was dropped, its copy made the device new again, and the device's old
  token was taken, also after a restart (the probe in the first test below shows it on the
  old code). As decided, entries are never dropped: `fitEntries` and its order are gone,
  and a merge, a read of `state/net.json` and a sync keep every entry, so a removal is
  kept for good. Against a broken or hostile copy, a list from another Mac of more than
  5000 entries (`mostIncoming`; a `net.sync`, a Mac's join with its `members`, the answer
  to a sync or a join) is refused whole and logged (`parseIncoming`): -32602 "That list
  has more than 5000 entries: none of it was taken in." for a `net.sync`, 400 for a join,
  nothing taken from an answer.
- **2: a join could answer 200 and drop what it let in.** The device's entry was added and
  the list cut to 1000 before the 200 was checked, and a Mac's join was merged and cut
  likewise, so with two Macs and 998 removed ones a device got a token already gone, and
  a Mac was taken in without the device it brought. Now 1000 entries, removed ones
  included, is an admission limit beside the 200 (`mostEntries`): the whole list a join
  would make, a Mac with its devices, is counted before the code is used, and a join over
  either is refused whole (409, "This net is full: its list keeps 1000 entries, removed
  members included." for a device; for a Mac "…with this Mac and its devices its list
  would have 1002 entries, removed members included, and it keeps 1000."), the code still
  good. One that adds none (a device joining again) is not refused, as for the 200; what a
  join lets in is kept whole.

Tests (`test/net.test.ts`): a merge past 1000 keeps every entry either way and a read
keeps them too, and `parseIncoming` refuses 5001; 1100 newer removals merged after a
device's removal, the Mac started again from its file, and a Mac that slept through the
removal waking with the device in its copy: all 1104 entries kept, the token refused, the
sleeping Mac learns the removal; with two Macs and 997 removed ones a device joins and its
token works, the next device is refused with nothing changed, the first joining again is
not, and a Mac with a device is refused whole; a `net.sync`, a Mac's join and the answers
to a sync and a join of 5001 entries are refused and nothing changes, while 5000 is taken.

Checked: the bridge's whole suite (1635 pass), its typecheck, the contract written
(unchanged) and `scripts/check-contract.sh bridge/contract.json`. The app was not changed
by this part.

### Codex re-check fixes (the app, finding 3), 2026-10-24

- **3: a stale Add a Mac could join the Mac to the wrong net.** Confirmed in the code:
  `Net.addMac` read the device's net and its connected Mac only after the new Mac's
  `net.list` came back, and called `net.invite` and `net.join_with` with no check of the
  generation (it was used only for the list taken at the end); the sheet started the work
  in a `Task` nobody held, so closing it cancelled nothing. Started in net A, cancelled,
  the device switched to B, and the late answer had a Mac of B make the code and the new
  Mac join B. Now every join, Add a Mac and switch, and Add a device's code, is a
  `NetAttempt` (PortalsKit, AgentCore) under the generation it started in: `step` checks
  before and after each call to a Mac, and the attempt runs its steps in order
  (`joinThrough`: the Mac's answer whether it offers the net, its code, `POST /net/join`;
  `add`: whether it offers the net, its list, the net's code, `net.join_with`). A
  cancelled task throws `CancellationError`, and another generation throws
  `NetError.overtaken` ("Your net changed while this was under way. Try again."); either
  way the next call is never made, and a Mac without the net that answers too late is not
  added by itself. The hosts sheet holds the task it starts and cancels it when it closes
  (and does nothing with what a cancelled one came to); Add a device holds its Try again
  and Make a new code the same way, as `.task` already did the first code. `Net.leave`
  and `Net.remove` keep the check they had: their one call goes at once, and what comes
  back under another generation is dropped. Tests (`NetAttemptTests`): the re-check's
  case (Add a Mac in A, the new Mac's list held, the device moves to B whose Mac answers
  now, the list released): `overtaken`, and neither A's nor B's Mac makes a code, nor does
  the new Mac join; the same with the sheet closed (cancelled); a code made as the net
  changed is not given to the new Mac; a late "no net" after cancel is not `.withoutNet`;
  joining through a Mac redeems nothing once the net changed, and a redeemed code answered
  after cancel is not taken; Add a Mac left alone still joins with the net's code, and a
  Mac of the net already makes no code. With `check` made to do nothing, all but those two
  fail. The sheets and `Net` are app-only (no app test target): their part is holding the
  task, cancelling it on close, and making an attempt per `open`, `switchToNet` and
  `invite`.

Checked: the whole PortalsKit suite (491 and 862; one run had the CPU-time probe test fail
under load, which passed alone after), an iOS Simulator build, and the bridge's suite (1635
pass), typecheck, contract and `scripts/check-contract.sh bridge/contract.json` (unchanged
by this part).

### Codex's second re-check, 2026-10-24

Codex confirmed the three re-check fixes (a sleeping Mac's stale copy no longer brings a
removed token back, after a restart either; a join over the limits is refused whole and
its code kept; a cancelled or overtaken Add a Mac makes no further call) and that joins,
rejoins, Add a Mac and switching nets still work. It found one more: the 5000-entry guard
on incoming lists stopped a valid history from converging (six Macs apart, each at 1000
entries, merge to about 6000; the larger copy was then refused, so a removal made on it
never reached the others). The guard is gone: a list from another Mac is taken whole
however long (`receive`, `syncWith`, a Mac's join and a join's answer use `parseMembers`),
bounded only by the frame size. Test: "a list merged past 5000 entries, as six Macs apart
may make, is still copied whole both ways, so a removal on it reaches every Mac" (on the
guarded code the other Mac refused the list and kept taking the removed device's token).

### N3, 2026-10-24

With the go-ahead ("Shorten stall detection, Deploy the relay, Install on your Macs, push and
merge after u have codex do a deep review on ur changes"):

- **Reviews:** Codex (GPT-6.1 Sol, extra high) reviewed the whole branch three times in a
  Portals thread: nine findings, then three in their fixes, then one more; all fixed (the
  subsections above), each with a test that failed before it.
- **The relay** is deployed: the Worker `portals-relay` with `MacTunnel`, version
  ba9b1f4f-be0a-4d8b-b5a0-8178368aa742 (the one before, for a rollback:
  9ea67ed3-52b9-4c6b-9fa6-ee0246e3fe54). Its notification routes answer as before, and
  `bridge/scripts/tunnel-check.ts` passed through it: a scratch bridge, a device joined to
  its net, `threads.list` and a reply from the fake agent through Cloudflare, a wrong token
  and a wrong key refused.
- **Merged:** main is 1ed8004d (a fast-forward of the branch), pushed; the branch is gone.
- **The mini's bridge** runs 1ed8004d since 03:21 local (backups `*.bak-2026-10-24-before-net`;
  the Hermes gateway untouched), in a net of its own with its standby socket on the relay.
- **MBP16's bridge** is updated by a detached updater once every thread on it is at rest,
  which then joins it to the mini's net with a code from the mini (log
  `~/Library/Logs/portals-bridge-net-install.log`). MBP14's bridge (linked, asleep) is left
  for later: `portals net join` with a code from `portals net invite` on either Mac.
- **The app** (Release, 1ed8004d): on MBP16's Mac since 03:27, connected to both Macs; MBP14,
  the iPhone and the iPad by waiters (`/private/tmp/portals-install-1ed8004d`).
- Left: the devices joining the net (scan a Mac's pairing link or a join code once the app
  is on them), N4's measurements on the phone.


### Bug hunt round 3 (net), 2026-10-26: open, for the user

Fixed on branch `n12/hunt-net`, each with a test (its commits say how). Open, needing a
decision or a design:

- **A Mac's incarnation on the wire.** A device cannot apply the bridges' removal rule
  (`isNewer`'s same-token case), as members reach it without `token_hash`: a Mac's own
  newer entry, passed on by a Mac that missed its removal, briefly brings a removed Mac's
  host back. A non-secret marker per membership (a join counter, or a short prefix of the
  token's hash) would let the device decide as the Macs do. Done 2026-10-26 (round 3's
  net-5, follow-up): each public entry carries `token_tag`, a one-way tag of the token's
  hash, and `NetMember.wins` applies `isNewer`'s same-token rule by it; an entry without
  one (an older bridge) is judged as before.
- **Switching nets leaves the device in the old one.** "Then leave (no call to the old
  net)": the old net's Macs keep the device as a member, and keep sending it sealed
  notifications, which the notification extension can no longer open (the host's key is
  gone), so they show as "Portals: New activity". A call to a Mac of the old net, once the
  new join worked, taking the device out (as Leave does) would end them. Done 2026-10-26
  (round 3's net-17): the device asks a Mac of the old net it is still connected to
  (`NetAttempt.leaveOldNet`); one try, so with none connected it stays as before.
  Follow-up the same evening: the removal names the old net (`net.remove`'s `net`), so a
  Mac that moved into the new net between its two answers refuses it; and a switch that no
  Mac of the old net answered keeps the old net (`NetLeftBehind`, with its Macs' addresses
  and its token) and asks its Macs again, directly at their addresses (not through the
  relay), every ten minutes while the app runs, from one launch to the next, until one takes
  the device out, says it is out, or none can (each in another net, or refusing the old
  token); after seven days it is given up and the person told once. A removal whose answer
  does not come is asked again; none is sent while a join, an Add a Mac or a switch is under
  way, nor once the device is in that net again. A removal already on its way when the device
  joins that net again can still win on merge, as any removal made on a Mac that has not
  heard of a rejoin does. A turn read before the list had its end (net-20) is told from a
  later one by the list's `turn` and where the host's list was last heard before the read; a
  turn so quick that nothing from the host had its start before the read stays unseen here.
- **Add a device through a Mac reached by the relay.** `Net.invite` takes the first
  connected net host, which may be one this device reaches only through the relay; the new
  device must reach the code's Mac at its address. A host reached directly would be better.
  Done 2026-10-26 (round 3's net-18): `NetHosts.forCodes` takes one reached directly first.
- **Two bridges with one relay id** (a copied bridge folder) take the relay's standby
  socket from each other (4409) without a word in either log, and keep doing so. Done
  2026-10-26 (round 3's net-19, "First keeps it, newcomer warns"): the relay
  refuses another bridge run's standby socket (409) while the holder pings; the newcomer
  logs it, says `relay_problem` in `gateway.ready`, and tries again every five minutes
  (docs/pairing-and-relay.md, "The tunnel"). Needs the relay deployed; until then the two
  take turns every five minutes.
- **A turn read here before the list had its end** (`EndedOutOfSight.readHere`) is marked
  seen by the first merge that lists the thread changed, which may also bring a later turn
  from another device, sent as seen with that later revision. The mark would need the turn
  it is of (its end's time, say).

### A Mac's name synced from the app, 2026-10-26 (branch `n13/names`)

2026-10-26: "we should do the Mac name syncing", and: a Mac renamed in the app is
renamed everywhere, on every Mac and device, the latest rename winning. Before, the app's
name for a host was each device's own (`HostConfig.name`, the net's name taken unless the
user renamed it there, `joined`), and a bridge named itself by `fleet.name` or its
Computer Name, which only `config.json` and a restart could change.

**Built**, behind the feature `net_rename`:
- The bridge: `net.rename {name, member?, after?}` (this Mac when `member` is not given),
  from a device, the password or the command, on any Mac of the net; `portals net rename
  [MAC] NAME`. A Mac's entry carries `named` (the name's stamp) and `named_by` (the Mac that
  set it), merged apart from the rest of the entry (`isNamedLater` in `members.ts`): of two
  copies the later stamp's name wins, whichever entry wins. The Mac renamed takes the name
  from any copy that reaches it (`net.sync` either way, a join's answer, as it starts and
  asks), goes by it at once (`Net.name()`, the `renamed` listener: `here` in `bridge.ts`, so
  the fleet's lines and `started_by`, and `net.invite`'s link), and writes its own entry anew
  with it.
- The app: the host settings of a Mac of the device's net, with a connected Mac of the net
  that lists the feature, rename it through the net (`Net.rename`): through the Mac itself
  when it is connected, else another; the footer says "A new name renames it on all your
  portals and hosts." The device merges names as the Macs do (`NetMembership.take`), and a
  host keeps the stamp of the net's name it last took (`HostConfig.netNamed`): a name given
  on this device alone stays while the stamp is the same (a Computer Name that changes does
  not replace it, as before), and a list with another stamp, a rename made since here or
  anywhere, replaces it.

**Decided without asking**, and why:
- *Any Mac may rename any Mac*, and the Mac renamed adopts it on sync, rather than the call
  having to reach the Mac itself: a device may reach only some Macs, through the relay
  alone, and the Mac to rename may be asleep; any Mac of the net already changes the list.
- *The stamp* is `max(now, named before + 1, after + 1)` on the Mac that applies it, the
  entries' own `stampAfter` rule: a rename made after seeing another always wins whatever
  the clocks say (a Lamport-style step), two made apart are told by the clocks (the later
  wins, as "the latest" asks), at the same stamp by the greater `named_by`. `after` is the
  stamp the device holds, for a rename it saw that the Mac it asks has not heard of. An
  `after` that is not a whole number above 0, or more than a day past this Mac's clock and
  the stamp it holds, is not taken (a device sending a wrong one cannot put the name past
  every rename to come), and a stamp held at the largest whole number refuses the rename
  rather than reuse it (review finding 4).
- *The entry's `changed` and `by` stay* when another Mac is renamed: a rename that moved
  them could undo a removal made meanwhile on a Mac it had not heard from (a newer entry,
  not removed, not the member's own word). So a bridge from before the feature, which
  merges whole entries by `changed`, takes the name only once the Mac renamed (if it is
  new) writes its own entry anew.
- *Kept in the Mac's own entry in `state/net.json`*, not `config.json`, which the running
  bridge never writes (only setup does): it wins over `fleet.name` and the Computer Name
  across restarts, leaving and joining nets, until set again. Lost only with both copies of
  `net.json` (then the Mac goes by its own name again).
- *Refused*: empty, more than one line, over 80 characters as UTF-16 counts them (a longer
  one would be dropped by every Mac's `parseMember`); only a Mac, not a device. The same
  name again changes nothing when the device says no stamp or an older one than this Mac
  holds; with the same stamp or a later one it is a rename back all the same (review
  finding 1 and its re-check: another name may have won at that stamp by a greater id). A
  Mac joining a net takes along its later names of the Macs it holds, its name alone on
  the answer's entry, whether set while the answer was on its way or before (finding 2 and
  its re-check: a bridge from before answers without the stamps). A host keeps who set its
  net name as well as when (`netNamedBy`), so a rename at the same stamp by another Mac
  counts (finding 3).
- *In the app*, the rename goes through the net only for a host that is a Mac of the
  device's net. When no Mac takes it (none of the net connected, or the name refused) the
  sheet says why in red under the name and the host keeps its name: keeping the new one on
  this device alone would leave it apart from the others without a word. Connected Macs
  without the feature keep today's local rename. A host added by hand keeps its name as it
  becomes the net's (as since N2), and follows the renames after.
- A Mac's link name follows its name (`mac-a` becomes `studio`), as it already did when its
  Computer Name changed: `machine/thread` ids through the fleet change with it.

**Reviewed** by Codex (GPT-6.1 Sol, extra high) on 2026-10-26: four findings, all real, all
fixed with a test that failed before (the commits say how); its re-check confirmed two of
the fixes and found two cases the other two missed, also real and fixed with tests. It also found that the
removal rule is not associative on main, before this branch: with one token, a removal at
2000, the member taken in again by another Mac at 3000 and its own rewrite at 4000 come to
in or out by the order they are merged in (`isNewer`'s same-token case). Left open,
with the open points of the third bug hunt above.

**Old and new together** (nothing is installed by this branch): an app from before ignores
the new keys and keeps its own names as before; a bridge from before in a net with new ones
keeps working, drops the stamps from its copies, takes a renamed Mac's own rewritten entry
whole, and its copies undo no rename on the new bridges; a Mac whose bridge is from before,
renamed on another, keeps going by its own name in what it passes on until it is updated,
while every new bridge and app shows the new one. A device in no net (the user's portals paired
by password before the net, the backlog's "Old pairings and linked Macs brought into the
net") renames its hosts on itself alone until it is in the net.

**Checked:** `bridge/test/net.test.ts` (the merge rule, the refusals and a restart over
another name of its own, a rename on another Mac reaching every Mac and the Mac's own entry
written anew, an hour-ahead clock losing to a later rename and winning a race made apart, a
tie by id, the device's `after`, a Mac renamed while off coming back at a new address, a
bridge standing in for one from before); `bridge/test/net-names-bridges.test.ts`, three real
bridges in one net (a phone renames C through A and every Mac lists it, and C's next message
to A and a thread it starts there say "Studio" without a restart; two renames of B at once
through A and C end with the later on every Mac; C renamed while stopped goes by it as it
starts and after another restart, its `config.json` unchanged; the refusals; `portals net
rename`); PortalsKit `NetTests` and `NetWireTests`. In the simulator with three scratch
bridges from this branch (ports 9601 to 9603): the footer, a rename of Mac A from its
settings reaching all three bridges and A's own join link, a name given on the device alone
replaced live by a rename made on bridge C, an 81-character name refused, and no Mac
connected said so.

### Devices renamed from the app, 2026-10-28 (branch `n15/devices`)

2026-10-28: the Mac app joined the net as "iPad" (Mac Catalyst's `UIDevice.name`,
and since iOS 16 an iPhone's is "iPhone"), and only Macs could be renamed. The plan is
docs/plans/2026-10-28-devices.md.

**Built**, behind the feature `net_rename_devices`:
- The bridge: `net.rename` takes a device's id (any member may rename any device, itself
  included), stamped and merged as a Mac's name is; a device's entry carries `named` and
  `named_by`, which `parseMember` now reads on either kind. Refusals say the member's kind
  ("A device's name cannot be empty.") and "There is no member X in this net." for an id
  the list has not, or has removed. A device that joins again replaces its entry as before,
  its name stamped as a rename made then, at the entry's own `changed`, past the one it
  had (else an older given name would win the merge on every other Mac, also one given on
  a Mac the joining one had not heard from: Codex's review, 2026-10-29); a device joining
  for the first time has no stamp. A device's rename is stamped past its entry's `changed`,
  so the app tells a name it was given (stamped past `changed`, or at it by another Mac than
  `by`; kept as `givenName`) from the one it joined with (Codex's re-checks: a Mac app's
  "Mac" was kept over its bridge's name; a rename at the very stamp of a re-join). A Mac joining a net takes along
  its later names of devices as of Macs (a bridge from before 2026-10-28 answers without a
  device's stamp).
- The app: Settings → Net → Portals offers Rename on every device's row, this one's
  included, while a connected Mac of the net lists the feature, through any such Mac. The
  device keeps the name it was last given (`NetMembership.givenName`, through leaves and
  switches) and joins a net with it; without one, a Mac app joins with the net's name for
  the bridge on this same Mac, else "Mac", and an iPhone or iPad with `UIDevice.name`.

**Beside a bridge from before**: it drops a device's stamp, keeps the name it held for a
device it has and takes the renamed name of one it has not; its copies undo no rename on
the new bridges. An app from before keeps the name it held.

