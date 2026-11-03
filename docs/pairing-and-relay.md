# Pairing, the relay, and sealed notifications

The formats the release milestones share: the bridge's setup
(R3) writes them, the relay (R2) and the app (R2, R5) read them. Decided 2026-10-09.
Change one here first, then on both sides.

## Names on the Mac (R3)

| | Name |
|---|---|
| npm package and command | `portals-bridge` (`npx portals-bridge setup`) |
| Data folder | `~/Library/Application Support/portals-bridge/` (`PORTALS_BRIDGE_HOME` overrides; the old `AERIPORTAL_BRIDGE_HOME` is still read) |
| LaunchAgent label | `com.danielou.portals.bridge` |
| Log | `~/Library/Logs/portals-bridge.log` |
| Port | 9120 on 127.0.0.1, reached from the phone only through `tailscale serve` |
| General folder | `~/Portals` |

Setup moves an install with the old names (`aeriportal-bridge`, `com.danielou.aeriportal.bridge`,
the user's) to these: the data folder with its threads, config and password, then the
LaunchAgent. The port and the `tailscale serve` mapping stay as they are.

A second bridge for development (R0) uses `portals-bridge-dev`, `com.danielou.portals.bridge.dev`
and port 9121.

## The pairing link (R3 shows it, R5 reads it)

```
portals://pair?v=1&url=<address>&user=<user name>&password=<password>&name=<Mac name>
```

- Every value is percent-encoded. `url` is the address the phone uses, with scheme and
  port (`https://mac.tailnet.ts.net:10010`). `name` is optional: the Mac's own name,
  shown as the host's name. `user` and `password` are the bridge's sign-in.
- Unknown parameters are ignored. A `v` above 1 is refused with "Update Portals to add
  this Mac".
- Setup prints the link as a QR code in the terminal, and as text for copying.
  Scanning it with the Camera opens Portals at the add-a-Mac sheet, filled in, with
  one button to add it; the add-a-Mac sheet can also scan it itself.
- The link holds the password, so it is shown only on the Mac, never logged or sent.

## The join link and `POST /net/join` (net plan, N1)

A Mac or a device already in a net (docs/net-plan.md) lets another in with a join link,
which `net.invite` makes on any Mac of the net (`portals net invite` on the Mac, Add a
device in the app):

```
portals://join?v=1&url=<issuing Mac's address>&code=<code>&name=<issuing Mac's name>
```

- Every value is percent-encoded. `code` is 16 random bytes in base64url; it works once,
  for ten minutes, lives in the issuing bridge's memory only (a restart forgets it), and at
  most 20 are open there at once. It lets in to the net it was made in only: when the
  issuing Mac moves to another net (joins one, leaves, or is removed), its open codes go. `url` is the issuing Mac's address, as in the pairing
  link; `name` is optional.
- A `v` above 1 is refused with "Update Portals to join this net". Unknown parameters are
  ignored.
- The link lets whoever has it into the net, so it is shown only to the person, never
  logged or sent anywhere but to the issuing Mac.

**`POST <url>/net/join`**, with no sign-in: the code is the credential. Ten wrong codes
within a minute and every code is refused with 429 for the rest of it, as sign-in does.

A device:

```json
{ "code": "…", "member": { "id": "<its own id>", "kind": "device", "name": "an iPhone", "platform": "ios" } }
```

→ `200 {"net": "<16 hex>", "member": {…}, "token": "<the device's token>", "members": [ … ]}`.
The Mac makes the device's token (32 random bytes, base64url) and keeps only its hash; a
device that was in the list before, removed or not, is replaced. `members` is the whole
list as `net.list` gives it, without the tokens' hashes. The device then signs in to every
Mac in it with `Authorization: Bearer <token>` (docs/gateway-protocol.md, section 11).

A Mac (the bridge's `net.join_with` sends this):

```json
{ "code": "…", "member": { "id", "kind": "mac", "name", "url", "key", "relay", "token_hash" }, "members": [ …its whole list… ], "net": "<the net it is in, 16 hex>" }
```

`net` (from 2026-10-26; optional) says which net the list is of. From another net than
this one, a removal in it of a member this net has under another token is left out: it is
of the member's way into that net (a phone that went from there to here, then removed
there), not of its way into this one. From this net, or unsaid, every entry is taken.

→ `200 {"net": "<16 hex>", "members": [ … ]}`, with the tokens' hashes: the joining Mac
takes it as its list and its net, and copies it to every Mac. Its devices come along with
it. `409` when its list holds another Mac, not removed, that is not in this net: "This Mac
is in a net with other Macs. Run `portals net leave` on it first."; the code still works.

Otherwise: `400` for a body it cannot use, `401` for a code used, expired, wrong or made
in a net the Mac has left, `409` for an id the net has for the other kind or a full net
(200 members not removed, or 1000 entries in the list, removed members included; the
whole list the join would make is counted, a Mac with its devices, and a join over either
is refused whole, its code still good, while one that is let in is kept whole), each with
`{"detail": "<a sentence>"}`. A Mac's `members`, and the answer, are taken whole however
long they are.

## The relay (R2)

A Cloudflare Worker that holds the user's APNs key and sends notifications for bridges
that have none. It accepts only Portals' bundle ID, keeps no message, and stores
nothing it does not need. Its address is set in the app (Info.plist
`PortalsRelayURL`) and in the bridge (config `push.relay`, defaulting to the deployed
address).

**`POST /v1/devices`**, from the app, once per device token:

```json
{ "token": "<hex device token>", "environment": "production" | "sandbox", "bundle_id": "com.danielou.portals" }
```

→ `200 {"relay_token": "<opaque>"}`. 400 for a bad body, 403 for another bundle ID.
The relay token names the device to the relay and nothing else; its format is the
relay's own and may change.

**`POST /v1/notify`**, from a bridge, `Authorization: Bearer <relay token>`:

```json
{ "payload": { "aps": { … } , … }, "priority": 10, "collapse_id": "…", "expiration": 0 }
```

`priority`, `collapse_id` and `expiration` are optional (APNs' meanings).
→ `200 {"sent": true}`; `410 {"gone": true}` when Apple says the device is gone (the
bridge forgets it); `429` when the token sends too often (with `Retry-After`); `401`
for a token the relay did not issue; `400` for a bad body or a payload over 4 KB;
`502 {"sent": false, "reason": "…"}` when Apple turned it down or could not be reached.

**`GET /v1/health`** → `200 {"service": "portals-relay"}`, for checking a deploy.

The relay runs at `https://portals-relay.danielou1208.workers.dev` (relay/README.md).

## The tunnel (net plan, R1)

The relay's second job: a backup way from a device to a Mac it cannot reach directly
(docs/net-plan.md, "Decided for the build: the relay"). The same Worker holds one
Durable Object per Mac, `MacTunnel`, named by the Mac's relay id (its `relay` in the
net's list), which pairs WebSockets and passes what they say. What passes is sealed end
to end between the device and the bridge; the relay holds no key. Code:
`relay/src/tunnel.ts` (the object), `bridge/src/relay/` (the bridge's side).

**Routes**, each a WebSocket (`GET` with `Upgrade: websocket`; anything else is 426):

- `GET /v1/tunnel/<relay id>/mac`, `Authorization: Bearer <relay secret>`: the Mac's
  standby socket. The first one claims the object, which keeps the secret's SHA-256;
  later ones must bring the same secret, else `401 {"detail": …}`. A newer standby socket
  takes the place of the one before, which is closed with 4409, unless another bridge's
  holds it: each run of a bridge names itself in `X-Portals-Standby` (16 random bytes,
  base64url), and a standby socket of another run is refused `409 {"detail": "This relay
  id is in use by another bridge."}` while the holder's last ping was answered within 75 s
  (the first keeps it; 2026-10-26: "First keeps it, newcomer warns"). Two bridges
  with one relay id are a copy of a bridge's folder. The same run's newer socket (a
  reconnect the relay has not seen the end of), a socket naming no run (a bridge from
  before this), or any socket once the holder's pings have stopped still takes its place.
  The refused bridge logs it once, says `relay_problem: "in_use"` in `gateway.ready`
  (docs/gateway-protocol.md, section 11, "The net") and tries again every five minutes; so
  does a bridge whose standby socket is closed with 4409, which only a relay from before
  this does to another bridge's. Both the log line and the app's line in Settings say how
  to mend it: `npx portals-host relay reset` on that Mac (with `PORTALS_BRIDGE_HOME` set
  to the copy's folder, for one not in the usual place) takes `relay` out of its
  `state/net-own.json` and its `.bak`, keeping its token and key, so that it makes a new
  relay id and secret as it starts; its net entry changes with it. A bridge its
  LaunchAgent runs is stopped for it and started again; one running some other way (its
  `portals` socket answers) is left alone, with a sentence to stop it first; a copied
  folder's `setup.json`, which names the LaunchAgent of the bridge it was copied from, does
  not get that one stopped. The bridge sends the text
  `ping` every 30 s and the relay answers `pong` without waking the object. A standby
  socket not open within 15 s is given up as a failed attempt and opened again after the
  bridge's wait (1 s, doubling up to a minute).
- `GET /v1/tunnel/<relay id>/mac/<channel>`, same secret: the Mac's leg of one device's
  channel. `404` when no device waits on that channel, `409` when it has its leg already.
- `GET /v1/tunnel/<relay id>/device`: a device, with no credential at the relay. The
  object gives it a channel id (16 random bytes, base64url) and sends
  `{"type":"open","channel":"<channel>"}` as text on the standby socket; the bridge opens
  that channel's leg, and from then on every message passes between the two as it is,
  text as text and binary as binary. What the device sends before the leg is there (its
  32-byte key) waits for it, up to 1 KB and four messages. The waiting socket's attachment
  must also fit 1536 bytes as UTF-8 JSON, counting base64, text escaping and metadata,
  as an application policy. JSON byte length does not measure structured-clone size;
  the runtime separately limits serialized attachments to 16 KiB. The app sends one key and
  waits for the Mac's reply before its token; reconnects start with a fresh socket and
  budget. WebSocket fragments are reassembled into one message before this count.

Relay ids and channel ids are 22 base64url characters, secrets 43. At most 60 sockets a
minute per relay id (`429` with `Retry-After: 60`, the `TUNNEL_LIMIT` rate limit), and at
most 20 devices at once per Mac. When either end of a channel closes, the other is closed
with the same code and reason when that code may be sent on (1000, 3000 to 4999), else
1001.

**Close codes** a device may see:

| Code | From | Means |
|---|---|---|
| 4503 | relay | "The Mac is not connected to the relay.": no standby socket (also when it goes while the device waits) |
| 4504 | relay | "The Mac did not answer.": no leg within 10 s |
| 4429 | relay | "Too many devices are connected to this Mac through the relay." |
| 4400 | relay | "Wait for the Mac before sending more.": over 1 KB, four messages, or the waiting attachment's budget before the leg came |
| 4400 | bridge | "A frame through the tunnel did not open." (a wrong key, a changed frame, one out of turn), or a handshake not understood, or a text frame; or "Too much came through the tunnel before the token was accepted." (step 5) |
| 4401 | bridge | "The token was not accepted.", or the member was removed from the net (as on a direct connection), always after the bridge's sealed refusal (step 5); a 4401 without one is the relay's, and means nothing more than any other close |
| 4408 | bridge | "The tunnel's handshake took too long.": the key and the token not in within 10 s; or "The Mac took too long to check the token.": no answer on the token 30 s after it came (a token the Mac does not know has it ask the other Macs first, 10 s each) |

**Handshake and frames** (binary frames throughout):

1. Device → bridge: `e_d`, a fresh ephemeral X25519 public key, raw, 32 bytes.
2. Bridge → device: `e_m`, its own fresh ephemeral, 32 bytes.
3. Both: `ikm = X25519(e_d, e_m) ‖ X25519(e_d, S_m)`, where `S_m` is the Mac's static key
   (`key` in its entry; the bridge uses its private half); `salt = SHA-256("portals-tunnel-v1"
   ‖ e_d ‖ e_m ‖ S_m)` (the ASCII text, then the three raw keys); HKDF-SHA256 with that
   salt and info `keys` (ASCII), 64 bytes: `k_dm` the first 32 (device to Mac), `k_md` the
   next 32 (Mac to device).
4. Every frame after: AES-256-GCM under its direction's key, nonce 4 zero bytes then the
   frame's counter as 8 bytes big-endian (0 for each direction's first frame, then 1, 2,
   …), no additional data; the frame is the ciphertext then the 16-byte tag (CryptoKit's
   `ciphertext + tag`, without the nonce). A frame that does not open closes the tunnel.
5. The device's first sealed frame is `{"token":"<its token>"}`, checked as a Bearer token
   is on a direct connection (a token the bridge does not know has it ask the other Macs
   first). Refused, or the member removed while its tunnel is open, the bridge first sends
   one sealed frame whose plaintext is `{"refused":"token"}` or `{"refused":"removed"}`
   (with the sentence it closes with as `message` beside it, maybe), then closes with 4401.
   Only that sealed frame is a refusal to the app: the relay, or anything on the way, can
   close the socket with 4401 as well as any other code, before the handshake or after it,
   so a close without the frame, whatever its code, is the Mac not reached. A check
   that failed on the Mac (not a token looked at and refused) sends no such frame. What
   the device sends after its token and before the bridge accepted it is kept for the
   gateway, at most 4 frames and 64 KiB in all; more closes the tunnel with 4400 and
   what was kept goes (the app sends nothing before `gateway.ready`).
6. Then each sealed frame is one JSON-RPC message as on a direct WebSocket, starting with
   the bridge's `gateway.ready`; the connection is signed in as that member. At most 16 MiB
   of JSON a frame either way: an answer larger than that comes back as an error for its
   call (-32603), a device's request larger than that is answered with such an error too
   (the app does not send one), and a larger event or notification is left out. A sealed
   frame over 32 MiB, the relay's own limit, closes the tunnel. No compression.

A relay pretending to be the Mac has no private half of `S_m`, so it cannot make the
device's keys: the device's first sealed frame, with its token, does not open for it, and
nothing the relay sends opens at the device. A relay passing frames between the real two
can drop them or close the tunnel, but not read or change them. The protocol pings (the gateway's every 30 s) are answered by the
relay, not by the device; the app's heartbeat (section 2 of docs/gateway-protocol.md) is
what tells a stalled tunnel.

**Test vectors:** `bridge/test/fixtures/tunnel-vectors.json`, made by
`bridge/scripts/tunnel-vectors.ts` from fixed phrases (running it again writes the same
file) and checked by `bridge/test/tunnel.test.ts`, also through WebCrypto. Bytes are
lower-case hex, plaintexts UTF-8:

| Field | What |
|---|---|
| `mac_static` | The Mac's static key pair: `private` (the raw 32-byte X25519 scalar, as CryptoKit's `rawRepresentation`), `public`, and `public_base64url` as the net's list gives it |
| `device_ephemeral`, `mac_ephemeral` | The two ephemeral key pairs, `private` and `public` (`e_d`, `e_m`) |
| `shared_ephemeral` | X25519(`e_d`, `e_m`) |
| `shared_static` | X25519(`e_d`, `S_m`) |
| `ikm` | `shared_ephemeral ‖ shared_static` |
| `salt` | SHA-256("portals-tunnel-v1" ‖ `e_d` ‖ `e_m` ‖ `S_m`) |
| `info` | `"keys"` |
| `k_dm`, `k_md` | The two keys, from HKDF-SHA256 |
| `device_to_mac` | The device's frames in order: `counter`, `plaintext` (the first is its token frame), `nonce`, and `sealed` (ciphertext ‖ tag) under `k_dm` |
| `mac_to_device` | The bridge's frames in order, likewise under `k_md`; the last has characters outside ASCII |

**The app's side** (`Packages/PortalsKit/Sources/HermesBackend`: `TunnelSeal.swift`,
`RelayTunnel.swift`, `RelayFallback.swift`, checked against a copy of the vectors in its
tests' fixtures): a Mac of the device's net whose entry has `relay` and `key` is tried at
its address first. When the address does not answer within 8 s (up to `gateway.ready`)
or cannot be reached at all, the app tries the relay as well (`PortalsRelayURL`, or
`PORTALS_DEBUG_RELAY_URL` in a development launch) with the handshake above in CryptoKit,
behind the same transport the JSON-RPC peer uses; the address's attempt is kept on, with
its own limit, and whichever reaches `gateway.ready` first is the connection, the other
closed. A Mac that refused the token at its address (4401, 4403) is not tried through the
relay. From then on, and after the address's heartbeat stalls, reconnects go through the
relay first (and then the address, with its own limit); the address is tried every 60 s and when
the network changes, and the connection moves back to it as soon as it answers, its
threads followed again as after a reconnect. The host's status reads "via relay"
meanwhile. Only the WebSocket goes through the tunnel: the push routes (a REST call) wait
for the address. A call over 16 MiB (a large attachment) is not sent through the relay:
it fails with "This is over 16 MiB, too large to send through the relay. Try again when
this device reaches the Mac directly."

Through the relay, only the bridge's sealed refusal (step 5), opened with the tunnel's
keys, is a refusal: the app hears it as it hears a 4401 at the Mac's address, and the net
takes it as that Mac not taking the token. Every close of the relay's socket without one,
4401 and 4403 among them, before the handshake or after it, is a connection failure
(`RelayClosed`), tried again with the usual waits: never a reason to leave the net, remove
a host, or delete what was kept for it.

## What the app tells a bridge (R2)

The push registration (`PUT /api/plugins/aeriportal-push/registration`,
docs/gateway-protocol.md section 10) gains two optional fields on `device`:

- `relay_token`: from `POST /v1/devices`. A bridge without its own APNs key sends
  through the relay with it.
- `key`: 32 random bytes, base64, made by the app for this host and kept where the
  notification extension can read it. When a device has given one, the bridge seals
  every notification to it, whether it goes through the relay or straight to Apple.

The app sends `relay_token` only to a bridge that lists the feature `push_relay`, and
`key` only to one that lists `push_sealed` (docs/gateway-protocol.md, section 11).
Hosts that do not know these fields (the Hermes plugin) would ignore them anyway.

## Sealed notifications (R2)

The bridge puts the real notification in `aeriportal.sealed`: the JSON
`{"title": …, "subtitle": …, "body": …}` sealed with AES-256-GCM under the device's
key, as base64 of nonce (12 bytes) + ciphertext + tag (16 bytes), which is CryptoKit's
`AES.GCM.SealedBox.combined`. What Apple and the relay see is `aps.alert` with the
title "Portals" and the body "New activity", `mutable-content: 1`, and the
`aeriportal` fields that carry no text (`host`, `agent`, `thread`, `kind`). The
notification extension opens the seal with the key for `aeriportal.host` and shows the
real text; if it cannot, it shows what came. The whole payload stays under APNs' 4 KB,
so the bridge shortens the body before sealing.

Which way a notification goes: a bridge with `apns` in its config sends to Apple
itself; otherwise, to a device that gave a relay token, through `push.relay`;
otherwise not at all (logged once per device).
