# portals-stats

Keeps the anonymous daily totals Portals hosts send, and shows them on a page only the
maintainer can open. A Cloudflare Worker with a D1 database, on the same account as
`portals-relay` but apart from it, so it cannot touch the relay. The plan is
`docs/plans/2026-11-06-token-analytics.md`, section 6; the host's sender is
`bridge/src/usage/telemetry.ts`, and its README section lists every field sent and how to
turn it off.

- `POST /v1/day`: a host sends one finished day of its totals. Open to anyone; answers 204.
- `GET /`: the page. `GET /api/summary?days=N` (1 to 365, 30 by default): its data. Both
  only through Cloudflare Access (below).

## What it keeps, and what it does not

One row per day and host in `days`, and one per day, host, agent and model in `usage`
(`migrations/0001_init.sql`):

- `install`: a random id the host made once, not from the hardware.
- `owner`: a hash the host makes of its net's id (so a person's Macs give the same one,
  and the net id itself never leaves them), or the install id for a host in no net. Daily
  active users are distinct owners a day.
- The host's version and OS (`darwin`, `linux`), the Portals turns started that day, and
  how many devices of each kind (iPhone, iPad, Mac, other) connected to it.
- By agent and model: requests, and input, output, cache read, cache write and reasoning
  tokens, with the API-equivalent dollars at the host's prices. A model the host's price
  table does not know arrives as `other`.
- When the day arrived.

It never gets a prompt, a title, a path, a folder, an account or a name, and it does not
keep the caller's address: that is only the rate limiter's key (60 days a minute per
address, `wrangler.jsonc`). Nothing is logged: `observability` is off and the Worker
writes no log line, and no answer repeats what was sent. A host that sends a day again
replaces what it sent for that day, in one transaction, so nothing counts twice.

`POST /v1/day` takes only the plan's body: every key known and present, nothing else, each
value of its type and within a cap (at most 64 usage rows, names at most 64 characters of
a safe set, counts whole and not negative, dollars finite), and a day at most 14 days
before the server's UTC date and not after it. Anything else gets
`400 {"detail":"Not a day of Portals totals."}`; a body past 32 KB gets 413, a busy
address 429.

## Who can see it

Only someone Cloudflare Access lets in. Access signs the visitor in and adds a token to
each request (`Cf-Access-Jwt-Assertion`); the Worker checks that token itself
(`src/access.ts`): signed RS256 by one of the team's keys (fetched from
`https://<team>/cdn-cgi/access/certs` and kept an hour), issued by the team, for this
application's AUD tag, and not expired. An email header alone is never trusted. While
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty, everything but `POST /v1/day` answers 403,
so the page is closed even before Access is set up.

## Developing

```sh
cd stats
npm ci
npm test            # validation, resends, the summary's numbers and Access, on D1 and Access stand-ins
npm run typecheck
```

The tests run the Worker's SQL on SQLite (Node's own `node:sqlite`, which is what D1 is)
with the migrations applied (`test/d1.ts`), and sign Access tokens with a key they make.

`npx wrangler@4.139.0 dev` runs it locally with a local D1 (apply the migrations first
with `npx wrangler@4.139.0 d1 migrations apply portals-stats --local`). The page there
answers 403 unless the two Access vars are set in a `.dev.vars` file, and then only to
requests carrying a real token, so try `POST /v1/day` locally and the page once deployed.

## Deploying

Everything below runs from `stats/` with wrangler 4.139.0, and needs a yes first.

1. Sign in to Cloudflare (opens the browser once):

   ```sh
   npx wrangler@4.139.0 login
   ```

2. Make the database, and put the `database_id` it prints into `wrangler.jsonc` in place
   of the zeros:

   ```sh
   npx wrangler@4.139.0 d1 create portals-stats
   ```

3. Make the tables:

   ```sh
   npx wrangler@4.139.0 d1 migrations apply portals-stats --remote
   ```

   A later change to the tables is a new numbered file in `migrations/`, applied the same
   way, never an edit of one already applied.

4. Deploy, and check it takes a day and refuses the page:

   ```sh
   npx wrangler@4.139.0 deploy
   curl -i -X POST https://portals-stats.danielou1208.workers.dev/v1/day -d '{}'   # 400
   curl -i https://portals-stats.danielou1208.workers.dev/                         # 403
   ```

5. Close the page with Cloudflare Access. In the Cloudflare dashboard, Zero Trust
   (setting up a team the first time; the free plan is enough):

   1. Access → Applications → Add an application → Self-hosted. Application domain
      `portals-stats.danielou1208.workers.dev`, path empty (everything).
   2. A policy, action Allow, with an Include rule Emails → the maintainer's email only.
   3. A second policy, action Bypass, Include Everyone, for the hosts' route: hosts carry
      no Access sign-in, so `/v1/day` must not be held up by Access. Either add a second
      application for the same domain with the path `v1/day` and only that Bypass policy
      (the more specific path wins), or leave Access off that path some other way. The
      Worker checks the token itself on every other route, so a bypass there opens nothing
      else.
   4. Save, and copy the application's **AUD tag** (the application's Overview, or
      Additional settings), and the team's domain, `<team>.cloudflareaccess.com`
      (Settings → Custom pages, or the sign-in page's address).

6. Put both in `wrangler.jsonc`'s `vars` (`ACCESS_TEAM_DOMAIN` without `https://`) and
   deploy again:

   ```sh
   npx wrangler@4.139.0 deploy
   ```

   Then open https://portals-stats.danielou1208.workers.dev in a browser: Access asks for
   the email, sends a code, and shows the page. `POST /v1/day` from step 4 should still
   answer 400 (not a redirect to the sign-in page): if it is redirected, the bypass in
   step 5.3 is missing, and hosts' days are being turned away.
