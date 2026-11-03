# portals-relay

Sends Portals notifications to Apple for bridges that have no APNs key of their own,
and carries a device's connection to a Mac it cannot reach directly (the tunnel).
Only the holder of the developer account's push key can notify the app, so bridges
without that key hand their notifications to this Cloudflare Worker, which holds it.
The formats are in `docs/pairing-and-relay.md`.

- `POST /v1/devices`: the app trades its device token for a relay token.
- `POST /v1/notify`: a bridge sends one notification with a relay token.
- `GET /v1/health`: answers `{"service":"portals-relay"}`.
- `GET /v1/tunnel/<relay id>/mac`, `…/mac/<channel>` and `…/device`: the tunnel, WebSockets
  (below).

For notifications the relay stores nothing. A relay token carries the device it names,
signed by the relay (`src/tokens.ts`), so only tokens it issued are taken. Notifications
are limited per token, and registrations per address (`wrangler.jsonc`). It logs what it
decided, never a token or a payload. The words of a notification are sealed by the bridge for the app, so
the relay never sees them anyway. Apple takes only HTTP/2; a Worker's `fetch` speaks it
to Apple (the R1 spike, 2026-10-09).

## The tunnel

A backup way from a device to a Mac it cannot reach directly (docs/net-plan.md; the
routes, close codes and handshake are in docs/pairing-and-relay.md, "The tunnel"). Each
Mac keeps an idle standby socket open to its own Durable Object, `MacTunnel`
(`src/worker.ts`; its logic in `src/tunnel.ts`), named by the Mac's relay id. A device
connects, the object tells the Mac on the standby socket, the Mac opens a socket for that
device, and the object passes every message between the two as it is. What passes is
sealed between the device and the bridge, so the relay reads nothing, and it logs only
what it decided, never a secret.

- **SQLite-backed** (`new_sqlite_classes` in the migration in `wrangler.jsonc`), which
  Cloudflare's free plan runs. The object stores one thing: the SHA-256 of the Mac's relay
  secret, which the first standby socket claims it with.
- **Hibernation:** its sockets are accepted with `acceptWebSocket`, with tags and an
  attachment saying what each is, so the object can sleep while they stay open; the
  standby socket's `ping` is answered with `pong` by `setWebSocketAutoResponse`, without
  waking it. A device that the Mac does not answer within 10 s is closed by the object's
  alarm.
- **Limits:** 60 sockets a minute per relay id (`TUNNEL_LIMIT`), 20 devices at once per
  Mac.
- The tunnel needs none of the secrets below: under `wrangler dev` with no `.dev.vars` it
  works while the notification routes answer 503.

The bridge's side is `bridge/src/relay/` (config `relay.enabled`, `relay.url`). To try it
locally, with nothing deployed:

```sh
cd relay
npx wrangler@4.139.0 dev --port 8790      # local mode; no Cloudflare sign-in needed
# in another terminal, a scratch bridge and a device through the tunnel:
cd bridge
node scripts/tunnel-check.ts http://127.0.0.1:8790 /private/tmp/portals-tunnel-check
```

`node --test test/tunnel.test.ts` checks the object's logic with stand-ins for its
sockets, storage and alarm; the bridge's `test/tunnel.test.ts` runs the same logic over
real sockets (`bridge/test/relay-standin.ts`) between a bridge and a device.

It runs at **https://portals-relay.danielou1208.workers.dev**. The bridge's `push.relay`
and the app's `PortalsRelayURL` default to that address.

## Developing

```sh
cd relay
npm ci
npm test            # the routes against a stand-in for Apple, with a key made by the test
npm run typecheck
```

`npx wrangler@4.139.0 dev` runs it locally, reading secrets from a `.dev.vars` file
(gitignored; use a key made for the purpose, not the real one). Registering and the
token checks work there, but `/v1/notify` answers `502 {"reason":"Unreachable"}`: the
local runtime does not reach Apple, which the deployed Worker does.

## Deploying

Everything below runs from `relay/` with wrangler 4.139.0. Each secret is read from
standard input, so none is typed into the shell history or printed.

1. Sign in to Cloudflare (opens the browser once):

   ```sh
   npx wrangler@4.139.0 login
   ```

2. The APNs key, its id and the team id. The key file is the `AuthKey_<key id>.p8` from
   the Apple developer account; a bridge's config can name all three under `apns`.

   ```sh
   npx wrangler@4.139.0 secret put APNS_KEY < path/to/AuthKey_XXXXXXXXXX.p8
   printf %s XXXXXXXXXX | npx wrangler@4.139.0 secret put APNS_KEY_ID
   printf %s YYYYYYYYYY | npx wrangler@4.139.0 secret put APNS_TEAM_ID
   ```

   Or straight from a bridge's config, without seeing the values:

   ```sh
   # aeriportal-bridge until the bridge's setup has moved it to portals-bridge
   config="$HOME/Library/Application Support/aeriportal-bridge/config.json"
   node -e 'const a = require(process.argv[1]).apns; process.stdout.write(require("fs").readFileSync(a.keyPath.replace(/^~/, require("os").homedir()), "utf8"))' "$config" | npx wrangler@4.139.0 secret put APNS_KEY
   node -e 'process.stdout.write(require(process.argv[1]).apns.keyId)' "$config" | npx wrangler@4.139.0 secret put APNS_KEY_ID
   node -e 'process.stdout.write(require(process.argv[1]).apns.teamId)' "$config" | npx wrangler@4.139.0 secret put APNS_TEAM_ID
   ```

3. The secret that signs relay tokens: random, made once, never needed anywhere else.

   ```sh
   openssl rand -base64 32 | tr -d '\n' | npx wrangler@4.139.0 secret put RELAY_SECRET
   ```

4. Deploy, and check it answers:

   ```sh
   npx wrangler@4.139.0 deploy
   curl https://portals-relay.danielou1208.workers.dev/v1/health
   ```

   The first deploy with the tunnel applies the migration `v1` in `wrangler.jsonc`, which
   makes the `MacTunnel` class; wrangler lists it and the `MAC_TUNNEL` binding as it
   deploys. A later change to the class (renaming or removing it) needs a new migration
   with its own tag, never an edit of `v1`. A check that the tunnel is there, which
   answers 426 because it is not a WebSocket:

   ```sh
   curl -i https://portals-relay.danielou1208.workers.dev/v1/tunnel/AAAAAAAAAAAAAAAAAAAAAA/device
   ```

5. One test notification to each Portals device a bridge knows (the phone must have
   opened Portals with that bridge added, so the bridge has its device token):

   ```sh
   node scripts/test-notification.ts https://portals-relay.danielou1208.workers.dev \
     "$HOME/Library/Application Support/aeriportal-bridge/state/push.json"
   ```

   Each device should say `notify answered 200 {"sent":true}` and the phone should show
   "A test notification through the relay". `410 {"gone":true}` means Apple no longer
   knows that device token (an old install).

A missing secret makes every route answer 503 naming it.

## Changing the signing secret

Every relay token the apps hold was signed with `RELAY_SECRET`, and Cloudflare never
shows a secret again. To change it without cutting anyone off, put the old value (if you
kept it) in `RELAY_SECRET_PREVIOUS` before setting a new `RELAY_SECRET`, and delete it a
week or more later: the app fetches a fresh relay token at least once a week. Without
the old value, notifications through the relay fail with 401 until each app has fetched
a new token.
