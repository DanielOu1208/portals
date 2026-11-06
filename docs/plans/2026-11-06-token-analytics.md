# Token analytics (2026-11-06)

A Usage section in Settings: how many tokens all coding on each Mac spends over time, what
that would cost at API prices, and how fast the plans' limits are being used up. Each host
also sends anonymous daily totals to a server only the maintainer sees.

The asks, 2026-11-06:

- "track token usage over time and get more detailed insights on spending limits"
- "how many tokens pass through portals every day, and get anonymous analytics as well"
- "some visuals would be nice, and this will live in the settings menu"
- "find a very lightweight method to track token usage. Don't have a very heavy dependency"
- "It should be just the coding usage in general. Take a look at how Tokscale does it"
- "some line graph would be cool that shows token spread"
- "It should show the dollar equivalent"
- "anonymous totals to my server should be automatically on by default, but people can turn it off if they want"
- "For the total counters, I think only me."
- "the server can be like a small worker, and only I should be able to see it ... just use my recommendations for now"
- "make sure we can also get an idea of the daily DAU"

## Decisions

| Question | Answer |
|---|---|
| What is counted | All coding on the Mac (terminal, other apps, Portals), from each agent's own history files; Portals' threads marked as such |
| Tokscale | Borrow, don't fork: its knowledge of where each agent keeps usage and its counting rules (MIT, credited in THIRD_PARTY_NOTICES.md), no Rust, no binary |
| Dependencies | None new: Node's own `fs`, `zlib` (zstd), `child_process`, later `node:sqlite`; Swift Charts in the app |
| Dollars | Shown, as an API-equivalent estimate, labelled as not the bill |
| Anonymous totals | On by default, with an off switch (Settings, CLI, config.json, `DO_NOT_TRACK`) |
| Who sees the totals | Only the maintainer: a private page |
| Daily active users | Counted per person, not per Mac: hosts in one net report one owner id |

## What there is today

- `turn.end.spent.tokens` (sessions/session.ts `spentOn`): one number a turn, input, output
  and cache added together, no model, the main agent's only. Codex's are kept per thread,
  the last 200, and go with the thread (sessions/spent.ts).
- Plan limits read live for `/usage` (providers/claude/usage.ts, providers/planLimits.ts),
  none kept.
- No telemetry. counters.ts is the model for what may be written: counts only.

Tokscale (github.com/junhoyeo/tokscale, MIT, v4.21.0): about 300,000 lines of Rust, 60+
agents, a 20 MB binary per platform, prices from LiteLLM, a public leaderboard. Too heavy
for the host, which has five small dependencies, but its readers hold the traps worth
knowing (below).

## 1. Reading usage on each host

Sources, each with its usual override:

| Agent | Where | Notes |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (`~/.claude`) | per request `message.usage`; subagents under `<session>/subagents/` |
| Codex | `$CODEX_HOME/sessions/`, `archived_sessions/` (`*.jsonl`, `*.jsonl.zst`) | `token_count` events |
| Pi | `~/.pi/agent/sessions/` | per message `usage` |
| Droid | `~/.factory/sessions/` | |
| Cursor | Cursor's usage API, with the sign-in planLimits.ts already reads | no local history |
| Hermes, OpenCode | SQLite (`state.db`, `opencode.db`) | later, with `node:sqlite` |

Counting rules (from Tokscale's readers and tests):

- Claude Code writes one request's usage on several lines: count each request once, by
  message id and request id, across files too (a resumed session can repeat earlier lines).
- `journal.jsonl` beside subagent transcripts is not usage.
- Codex's `token_count` is a running total: a request is the rise since the last one. A
  session in both `sessions/` and `archived_sessions/` counts once, by the id in its
  `session_meta`, not by the path.
- OpenAI's output tokens already hold the reasoning ones: shown apart, never added twice.

How it stays light:

- The files only grow, so each one's size, inode and how far it was read are kept; a scan
  looks at sizes first and reads only new bytes. A file that shrank or changed inode is read
  again from the start, and its earlier counts are replaced, not added to.
- Before `JSON.parse`, a quick text check skips lines that cannot hold usage (tool output and
  images are most of the bytes).
- Scanning runs in a short-lived child process (first built as a `worker_thread`, whose freed
  memory stayed in the host), so the host's loop never waits on it. When: at start,
  every 10 minutes, and shortly after a turn ends; a scan with nothing new costs a few `stat`s.
- The first scan reads the whole history once (on the development Mac 7.2 GB: Claude Code
  4.4 GB in 1,104 files, Codex 2.2 GB in 2,601, Droid 566 MB, Pi 57 MB). Its time is
  measured before this ships.
- What is kept: daily totals by agent, model and folder, each with input, output, cache
  read, cache write, reasoning, requests and dollars, plus each day's tokens by hour. In
  `state/usage/`. They stay when an agent deletes old transcripts (Claude Code does after
  `cleanupPeriodDays`, 30 by default), so the totals only ever grow.
- Portals' own threads are known to the host by session id, so each total also says how
  much went through Portals (next section).

### Through Portals or elsewhere

The agents' files do not say Portals ran them, except Codex's; the host's own records do.

- `state/usage/sessions.json`: every session the host has run, `"<agent>:<session id>"`
  with `since` (milliseconds): from when its requests count as Portals'. Added when a thread
  starts, is resumed, forked, or taken up from the terminal (a desk session: `since` is the
  moment it was taken up, so its earlier requests stay "elsewhere"). Never trimmed when a
  thread is deleted.
- Seeded once from `threads.json` (`createdAt` as `since`) and `removed.json`.
- Codex writes who started each session in its first line: `session_meta.payload.originator`
  is `portals-bridge` (or the old `aeriportal-bridge`) for Portals, `codex-tui` for the
  terminal, `codex_exec` for headless runs. A Portals originator counts as Portals whatever
  the list says.
- Claude Code's `entrypoint` (`cli` in the terminal, `sdk-ts` in apps on the Agent SDK,
  Portals among them) is not proof alone: on the development Mac 51 of 247 `sdk-ts`
  transcripts were not current Portals threads.
- A subagent's requests go with their parent session.
- Not read in this version: Cursor (no local history; its usage API later), Hermes and
  OpenCode (SQLite, later with `node:sqlite`). The page says which agents are counted.

## 2. Prices

- A table from LiteLLM's public `model_prices_and_context_window.json`, trimmed to the
  models the agents use, made by a script at each release and shipped with the host.
- The host refreshes it once a day from the same file (nothing is sent), falling back to the
  shipped table.
- Priced per token type (input, output, cache read, cache write). A model with no price
  counts its tokens and shows as unpriced. Fast-mode premiums later.

## 3. Plan limits over time

- Each limit reading the host already gets (Claude's `rate_limit_event`, Codex's limit
  updates, `/usage` answers) is kept with its time, plus one reading every 15 minutes while
  a thread runs: `state/usage/limits.jsonl`, 90 days.
- The app works out the pace from it: how much of the window is used against how much of it
  has passed, and when it runs out at this rate.

## 4. The wire

- Feature `usage_history`, request `usage.history { from, to }` ("YYYY-MM-DD", inclusive,
  the host's days; at most 400 days). The answer, snake_case like the rest of the wire:

  ```json
  {
    "time_zone": "Europe/London",
    "agents": ["claude", "codex", "pi", "droid"],
    "scan": { "scanning": false, "progress": 1, "scanned_at": 1762416000000 },
    "days": [
      { "day": "2026-11-05", "agent": "claude", "model": "claude-opus-5-5", "folder": "/Users/dana/code/app",
        "via": "portals", "input": 1200, "output": 5400, "cache_read": 980000, "cache_write": 41000,
        "cache_write_1h": 41000, "reasoning": 300, "requests": 61, "usd": 2.41 }
    ],
    "hours": [ { "day": "2026-11-05", "agent": "claude", "via": "portals", "tokens": [0, 0, "... 24 numbers"] } ],
    "limits": [ { "at": 1762416000000, "agent": "claude", "name": "weekly", "percent": 62,
                  "resets_at": 1762588800, "window_seconds": 604800 } ],
    "prices_at": 1762400000000
  }
  ```

  `usd` is worked out when answering, from the prices of now, so a price fixed later
  applies to all of history; null for a model with no price. `agents` lists the agents
  whose history this host reads.
- Feature `usage_telemetry`, request `usage.telemetry { enabled? }`: with `enabled`, sets
  the host's switch (config.json `telemetry`); always answers
  `{ "enabled": bool, "locked": "env" | null, "last_sent_day": "YYYY-MM-DD" | null }`.
  `locked: "env"` when `DO_NOT_TRACK` (or `PORTALS_TELEMETRY=0`) keeps it off whatever the
  switch says.
- The app asks every host and adds them up; one Mac can be picked.
- contract.json (`npm run contract`) and docs/gateway-protocol.md get both.

## 5. Settings → Usage

- Ranges 24 hours, 7, 30 and 90 days; All Macs or one.
- Tiles: tokens, API-equivalent dollars, cache hit rate, share through Portals.
- Line chart of tokens by agent: over the range, and over an average day ("token spread").
- Cost by token type as a split bar; limits with the pace mark and when each runs out.
- Lists by model, folder and Mac, each with dollars and a share bar.
- Swift Charts; iPhone, iPad and Mac layouts.

## 6. Anonymous totals

On by default. Off with any of:

- Settings → Usage → Share anonymous totals (sets it on that host)
- `portals-host telemetry off`
- `"telemetry": false` in config.json
- `DO_NOT_TRACK=1`

The setup TUI says in one line that it is on and how to turn it off. The README lists every
field sent.

What is sent: once a day, by the host (one sender per Mac, so nothing counts twice), each
finished day it has not sent yet (at most the last 7), retried when offline. Only days the
host was active: a Portals turn ran, or a device connected. Only what went through Portals
is sent: the totals measure Portals. No prompts, titles, paths, folder names or account
details. `POST https://portals-stats.danielou1208.workers.dev/v1/day` (`PORTALS_STATS_URL`
overrides it), with the body:

```json
{
  "v": 1,
  "install": "6f1c2b9e-4a7d-4d55-9c1e-2f0b7a8e3d41",
  "owner": "3b7e9c0d1a2f4e5b6c7d8e9f0a1b2c3d",
  "day": "2026-11-05",
  "version": "0.3.3",
  "os": "darwin",
  "turns": 42,
  "portals": { "iphone": 1, "ipad": 0, "mac": 1, "other": 0 },
  "usage": [
    { "agent": "claude", "model": "claude-opus-5-5", "requests": 120, "input": 2100,
      "output": 51000, "cache_read": 3900000, "cache_write": 210000, "reasoning": 0, "usd": 12.34 }
  ]
}
```

- `install`: a random UUID made once on the host (`state/usage/install.json`), not from the
  hardware.
- `owner`: the first 32 hex digits of SHA-256 of `"portals-stats owner v1:" + <net id>`, so
  every host in one person's net gives the same owner and the net id itself is never sent;
  the install id for a host in no net. Daily active users = distinct owners a day.
- `turns`: Portals turns started that day. `portals`: distinct devices that connected that
  day, by kind (the kind the device says; `other` when it says none).
- `usage`: the day's through-Portals totals by agent and model. A model the price table does
  not know goes as `"other"` (a custom model name could say something about its user).
  `usd` from the host's prices.

The server: a new Worker, `portals-stats` (folder `stats/`, like `relay/`), on the same
Cloudflare account as `portals-relay` but apart from it, so it cannot touch the relay.

- D1 tables `days` (one row per day and install: owner, version, os, turns, portals by kind)
  and `usage` (one row per day, install, agent and model). A resend of a day replaces that
  install's rows for it (one batch), so nothing counts twice.
- `POST /v1/day` checks the body strictly (known keys only, sizes capped, day within the last
  14 days and not ahead), answers 204. Rate-limited per address with a `ratelimits` binding;
  the address is the limiter's key only, never stored. No logs (`observability` off), no
  payload in any error.
- Everything else needs Cloudflare Access: the Worker itself checks the
  `Cf-Access-Jwt-Assertion` token (RS256, the team's certs, the app's AUD, from the secrets
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`) and refuses all but `POST /v1/day` when they are not
  set. So the page is closed even before Access is set up.
- As deployed (2026-11-06): the page at https://stats.portals.build, a custom domain Access
  covers whole (email-only policy); hosts send to `workers.dev`, which Access does not
  cover and where the Worker refuses everything but `POST /v1/day`.
- `GET /` is the page; `GET /api/summary?days=N` its data: by day, daily active users
  (distinct owners), active hosts (distinct installs), weekly and monthly actives, tokens by
  agent and type, dollars, devices by kind (the largest per owner), and the mix of agents,
  models, versions and OSes over the range.
- The page draws its charts itself (SVG, no library, no CDN): daily active users, tokens a
  day by agent as lines, dollars a day, and the mixes as bars.
- Deploying (D1 create, migrations, `wrangler deploy`) and setting up Access are done by hand
  after a yes: `stats/README.md` says how.

## Where the code goes

| Part | Files |
|---|---|
| Shared shapes | `bridge/src/usage/types.ts` (written first; changed only with care, every part reads it) |
| Reading history | `bridge/src/usage/readers/{claude,codex,pi,droid}.ts`, `scanner.ts` (cursors, reader process), `scanWorker.ts`, `store.ts` (daily totals, hours), `book.ts` (the `UsageBook`), `prices.ts` + `prices.json` + `bridge/scripts/prices.ts`; tests `bridge/test/usage-*.test.ts` with fixtures in `bridge/test/fixtures/usage/` |
| Host wiring | `bridge/src/usage/sessions.ts` (Portals' sessions), `limits.ts` (limit readings), the gateway methods and features, `bridge.ts`, `config.ts` paths, contract.json, docs/gateway-protocol.md |
| Telemetry | `bridge/src/usage/telemetry.ts`, the CLI's `telemetry on|off|status`, the setup line, README section |
| Server | `stats/` (worker, D1 migrations, page, tests, README) |
| App | PortalsKit wire + models + tests; `Portals/Settings/Usage*.swift`; the Settings section |

## Stages

1. The host reader: sources, counting rules, worker thread, daily totals, prices, with
   tests from small fixture files. First-scan time measured on the development Mac.
2. `usage.history` and the Settings → Usage page.
3. Limit readings and pace.
4. The stats Worker and its private page, the sender, the switches, the README section.
   Deploying the Worker needs a yes first.
5. Live check on the development Mac and the mini, then release with the next version.
