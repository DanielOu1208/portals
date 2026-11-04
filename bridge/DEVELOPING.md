# Working on portals-bridge

The bridge speaks the part of the Hermes gateway protocol the Portals app uses
(`docs/gateway-protocol.md` in the app's repository): the same sign-in, the same
WebSocket protocol, the same reconnect and replay rules, plus the extensions in
`bridge.features`. What a person installing it needs is in `README.md`, the page npm
shows; this is for changing it, and holds what the README said of the bridge's insides
until 0.3.0 ([How it works](#how-it-works): every file, every setting, each agent, the
counters, the known limits). Not part of the npm package.

## Running it from the source

- Node 22.18 or later. In the repository Node runs the `.ts` files directly; `tsc` only
  type-checks. The npm package ships compiled JavaScript instead (below).
- Claude Code and Codex installed, as in `README.md`; `pi` to run Pi threads,
  Cursor's `cursor-agent` to run Cursor threads, and OpenCode 2's `opencode` to run
  OpenCode threads.

```sh
cd bridge
npm ci
npm start                                   # node src/main.ts, in ~/Library/Application Support/portals-bridge
PORTALS_BRIDGE_HOME=/tmp/b npm start        # with a folder of its own
PORTALS_BRIDGE_LOG=debug npm start          # debug, info (default), warn, error, silent
node src/cli.ts setup                       # setup from the source (needs npm run build first: it installs dist/)
```

`npm ci` also installs the SDK's bundled Claude Code binary (about 230 MB, an optional
dependency of the SDK). The bridge does not use it; it runs the installed `claude`.

It logs to standard error. SIGINT or SIGTERM stops every Claude, Pi and Cursor process
it started, then exits; Codex turns on the shared daemon keep running. A stop that has
not finished after eight seconds exits all the same. An exception nothing catches is
logged and stops it the same way, with exit code 1 (launchd starts it again); a promise
that fails with nothing to catch it is logged, and the bridge goes on
(`src/lifetime.ts`). Check it with `curl http://127.0.0.1:9120/api/status`. The older
names `AERIPORTAL_BRIDGE_HOME` and `AERIPORTAL_BRIDGE_LOG` still work.

## The package

```sh
npm run build        # tsc -p tsconfig.build.json: src/ → dist/, imports rewritten to .js
npm pack             # builds first (prepack); the tarball has dist/, README.md, LICENSE and package.json
npm pack --dry-run   # the same list without writing it (0.3.0: 176 files, about 600 KB)
```

The package is `portals-host` on npm, for macOS and Linux (`os`), on Node 22.18 or later
(`engines`). `README.md` is its page there, so it says only what a person installing it
needs; this file is not in the package. A release is the version in `package.json` and
`package-lock.json` (`npm version <v> --no-git-tag-version`), `npm run contract` (the
contract names the version), then `npm publish` from `bridge/`. A bridge learns that a later
version is out from the registry's `latest` tag (`src/updates.ts`), so a version published
under another tag (`npm publish --tag next`) is told to nobody.

Node strips TypeScript types only outside `node_modules`, so an installed package must
be JavaScript. `bin` is `dist/cli.js`; the LaunchAgent runs `dist/main.js` from the copy
setup installs in the bridge's folder (`app/`), never from npx's cache, which npm may
clear. The `portals` command (`src/portals.ts`, also a `bin`) is not put on anyone's
PATH by setup: the bridge writes a launcher for it, `bin/portals` in its folder, each
time it starts, for the copy that is running, and gives that folder to the agents it
starts.

The Agent SDK is an optional peer dependency (and a dev dependency here), not a
dependency, so `npx portals-host` fetches only its few dependencies (`@clack/prompts`,
`@factory/droid-sdk`, `uqr` for the QR code, `ws`, `zod`), not the SDK's 224 MB copy of
Claude Code. Setup writes the installed bridge a `package.json` of
its own with the SDK among its dependencies and installs it with `--omit=optional`
(`src/setup/install.ts`). The SDK's own dependencies resolve within the ranges it
declares; there is no lockfile in the installed copy.

`bridge/scripts/install.sh` is the same install from this checkout: it builds `dist/` and
runs `node dist/cli.js update`.

To try the package as a stranger would, without touching launchd or the tailnet, run the
packed tarball's setup with another `HOME` and stand-ins for the two programs setup
changes things with: `PORTALS_SETUP_LAUNCHCTL` and `PORTALS_SETUP_TAILSCALE` name
scripts to run instead of `launchctl` and `tailscale` (on Linux, `PORTALS_SETUP_SYSTEMCTL`,
`PORTALS_SETUP_LOGINCTL` and `PORTALS_SETUP_SUDO` too).

```sh
HOME=/tmp/stranger PORTALS_SETUP_LAUNCHCTL=/tmp/fakes/launchctl PORTALS_SETUP_TAILSCALE=/tmp/fakes/tailscale \
  npm exec --yes --package=./portals-host-0.3.0.tgz -- portals-host setup --yes
```

With the real `launchctl`, give the LaunchAgent a throwaway label
(`PORTALS_BRIDGE_LABEL=com.danielou.portals.bridge.test`), a folder of its own
(`PORTALS_BRIDGE_HOME`) with a `config.json` on another port, and `uninstall` it after.

## Testing

```sh
npm test                 # node --test, no installed agents needed
npm run test:bench       # the benchmark harness's short run through every scenario
npm run typecheck        # tsc --noEmit
npm run contract         # rewrite contract.json after changing a method or event
../scripts/check-contract.sh bridge/contract.json   # (from the repo root)
```

`npm test` keeps the harness's scratch-safety and isolated-config checks, but skips
its all-scenario smoke test. `npm run test:bench` runs all three checks, including
every scenario's table, JSON rows and process cleanup. `BENCH_TESTS=1 npm test`
includes that smoke test in a full run.

Setup's tests (`test/setup.test.ts`) run every command against stand-ins for launchctl,
tailscale, npm, claude, codex, pi and cursor-agent, in a home folder of their own; a
Mac's setup on either system (`os: "macos"` in their context), and a Linux computer's
against stand-ins for systemctl, loginctl and sudo too (`linuxContext`).

On Linux, `scripts/linux-test.sh` runs the same tests in a `node:24` container (Docker;
Colima on a Mac), the repository mounted read-only and copied in, so neither side's
`node_modules` reaches the other. Arguments go to `node --test`
(`scripts/linux-test.sh test/setup.test.ts`). `scripts/linux/Dockerfile` is an Ubuntu
with systemd, for trying setup itself against a real systemd user manager
(docs/linux-plan.md).

The counters (`src/counters.ts`, [Counters](#counters) below)
write a line a minute, which is too slow for a test. Two switches shorten it, and
neither can reach an installed bridge (the LaunchAgent's environment is `PATH` and
`PORTALS_BRIDGE_HOME` only):

- `BridgeOptions.counters`, for a bridge started in a test: `seconds` (the tick),
  `capBytes` (the size the file is rotated at), `file`, `ps`, `clock` and `gauges`.
  `test/counters.test.ts` uses them all.
- `PORTALS_BRIDGE_COUNTERS_SECONDS`, for a bridge run as a process: the tick in
  seconds. Anything that is not a number of at least 0.02 and at most 2,147,483 (the
  longest timer Node has, about 24.8 days) is a minute.

Either way the counters run only when the bridge's `config.json` has
`"counters": { "enabled": true }`. They are one per process: of several bridges in one
test process, the first started with them on holds them, and the others' traffic is
counted into its lines. A place that counts is `if (counters.on) counters.…(…)` and
nothing else, so that off costs a branch; a new counting function takes numbers and
words from a fixed set only, never text, and is added to the list in
`test/counters.test.ts` of what a line may hold.

The harness (`scripts/bench.ts`, its parts in `scripts/bench/`)
measures what the fleet and thread sync cost, and prints a Markdown table for each
scenario:

```sh
node scripts/bench.ts                          # every scenario but cost, counters on: about five minutes
node scripts/bench.ts --only turns,marks       # some of them: idle turns marks fleet stream loads connect network pushes resume tokens cost, or all
node scripts/bench.ts --only cost              # what the counters themselves cost: about four minutes
node scripts/bench.ts --sizes 100,1000,5000    # the list sizes (these are the default)
node scripts/bench.ts --counters off           # the bridges' counters off: the numbers from outside only
node scripts/bench.ts --json /tmp/bench.json   # also every table's rows, the commit and the settings, as JSON
node scripts/bench.ts --idle 120               # how long idle watches, in seconds (60)
node scripts/bench.ts --quick --only all       # small sizes, seconds: what npm run test:bench checks
```

It calls no model and touches no installed bridge. Each bridge it starts is a process
of its own (`node src/main.ts`) in a folder inside one scratch folder the harness makes
and removes (in the system's temporary folder, or under `--scratch <folder>`), on port
0, with the scripted agent only, no relay, and General inside the scratch folder. It
refuses to start a bridge, or to run the `portals` command, in a folder outside that
one, and stops every bridge by its pid and checks it gone, also when a scenario fails or
the harness is interrupted (`--pid-notes <prefix>` keeps each running bridge's pid in a
file `<prefix><n>` meanwhile). The lists of threads are written, not played
(`scripts/bench/registry.ts`: the same threads every run), and a harness device does
what the app does around the list (`scripts/bench/device.ts`). In `network` a device
reaches its bridge over a bad network instead of loopback: a proxy on this Mac
(`scripts/bench/link.ts`) that adds latency, a bandwidth cap and lost segments, stops
passing on what the bridge sends for a while (a stall) and cuts the connections, and
counts the bytes that cross it.

Numbers come from two sides. From outside, with the counters on or off: what a device
sent and received, and the bridge process's CPU time and memory, which a small file
loaded into each harness bridge before the bridge itself answers for
(`scripts/bench/probe.ts`; `ps` gives CPU time in hundredths of a second). From inside,
with the counters on: the bridge's own lines, read between two edges, so that a
scenario's setup is not in its numbers. Several things at work on the Mac show in the
times; every table carries the time it was taken and the load average then. A number
that matters is the middle of three runs.

The notification tests hold the bridge's wording to the Hermes plugin's, byte for byte,
through `test/fixtures/push/plugin-payloads.json`: inputs, and the payload the plugin's
`compose()` gives for each. After changing a case or the plugin, fill the payloads in
again with `python3 -I scripts/plugin-payloads.py` (any Python 3; it loads only the
plugin's `core.py`). The APNs tests run against a stand-in server with a key they make.

The Claude tests replay real Claude Code streams recorded in `test/fixtures/claude/`:
straight through the mapper (golden `*.events.json` files), and through the whole bridge
with the SDK's query played back (`test/claude-fixtures.ts`). After a deliberate change
to the mapping, check the new output by hand and rewrite the golden files with
`UPDATE_GOLDEN=1 node --test test/claude-stream.test.ts`.

To record the streams again (a new Claude Code release, say):

```sh
node scripts/record-claude.ts            # or name scenarios: plain tools approval …
```

It runs Haiku with harmless prompts in scratch folders under
`/private/tmp/portals-claude-record/`, on your login and quota, then deletes the
sessions and folders it made and replaces paths in what it writes, also where Claude
Code streamed a path in pieces (`scripts/record-claude-clean.ts`, which can clean a
recording again: `node scripts/record-claude-clean.ts <file> <scratch folder>`). A plan
the `plan` scenario writes stays in `~/.claude/plans/`; delete it by hand.

The Codex tests replay real Codex streams recorded in `test/fixtures/codex/` the same
way (golden `*.events.json` files, `UPDATE_GOLDEN=1 node --test test/codex-stream.test.ts`),
and run whole threads against a stand-in for the shared daemon that plays them
(`test/codex-daemon.ts`). To record again, and to copy the protocol types the bridge
uses from the installed Codex into `src/providers/codex/types/` (after updating Codex):

```sh
node scripts/record-codex.ts             # or name scenarios: plain tools approval …
node scripts/codex-types.ts
```

The recorder starts threads on the shared daemon in scratch folders under
`/private/tmp/portals-codex-record/`, with your default model and login, then deletes
the threads and folders.

Codex's client and Hermes's (`src/providers/codex/client.ts`, `src/providers/hermes/client.ts`)
keep their connectors, frames, handshakes and errors, and share the part that connects
again (`src/providers/rpc.ts`): calls and their timers, the pauses between attempts,
which connection counts, and the guard around their listeners. `test/clients.test.ts`
holds both to one contract through a stand-in connector on mocked timers, and each to
what is its own (Codex's ids and `prepare`, Hermes's greeting, ping and heartbeat).

The Pi tests replay real runs of Pi's RPC mode recorded in `test/fixtures/pi/`: each
`<scenario>.jsonl` holds every record both ways in order, and `<scenario>.session.jsonl`
Pi's session file as it was at the end. They go straight through the mapper and the
history reader (golden `*.events.json` and `*.history.json` files,
`UPDATE_GOLDEN=1 node --test test/pi-stream.test.ts test/pi-history.test.ts`), and whole
threads run against a stand-in for `pi --mode rpc` that plays them
(`test/pi-agent.ts`, run as a real child process; `test/pi-standin.ts` makes it the
program a test gives for `pi.path`). The stand-in is as strict as Pi where a forgiving
one would hide a bug in the bridge (its header lists how), and it will not run without
`PI_CODING_AGENT_DIR`, so it never writes under `~/.pi`. No test starts the installed
`pi`: `providers.pi` is off unless a config turns it on, and a test bridge names it
off. The tests of Pi's sessions from the desk (`test/pi-desk.test.ts`) write their own
session files into the stand-in's folder and say themselves in which folders a Pi "runs
in a terminal"; the provider a test builds with `piProvider` never asks the Mac for its
processes. To record again (Pi changes its records often; these were recorded on
1.5.0):

```sh
node scripts/record-pi.ts                # or name scenarios: plain tools stop steer …
node scripts/record-pi.ts --again        # no Pi: cleans records kept in $PI_RECORD_RAW again
```

The recorder runs the installed Pi on a small OpenAI model (`openai/gpt-6-luna`) on your
sign-in and quota, with harmless prompts in scratch folders under
`/private/tmp/portals-pi-record/`, bare (none of your extensions, skills or context
files) except for the one scenario that says otherwise. It stops if a turn ran on
another provider or model, replaces paths and personal fields in what it writes, and
writes nothing while a search of the result still finds one. After recording, read the
golden files' diff by hand.

Cursor is run through the Agent Client Protocol, and is tested in three layers. The
protocol library (`src/providers/acp/`) has its client tested against a stand-in agent
started as a process (`test/acp-agent.ts`, `test/acp-client.test.ts`), and its mapping
against turns recorded from OpenCode and Cursor on 2026-10-10 (`test/fixtures/acp/`,
`test/acp-stream.test.ts`). The Cursor provider's mapping replays recordings of the real
`cursor-agent acp` (`test/fixtures/cursor/`: every message both ways, a line each) into
golden `*.events.json` files (`UPDATE_GOLDEN=1 node --test test/cursor-stream.test.ts`).
Whole threads run through the bridge against the stand-in with its feature `cursor`,
which does what the recordings show (`test/cursor-bridge.test.ts`); what could not be
recorded (a question card, a permission request for a command or an edit, a permission
allowed, a lost sign-in) is tested against the stand-in alone, and the test file says
so. One test kills a bridge in the middle of a turn: its provider runs in a process of
its own for that (`test/cursor-killed-bridge.ts`). No test starts `cursor-agent`.

To record Cursor again (a new release, say):

```sh
node scripts/record-cursor.ts            # or name scenarios: plain tools cancel plan …
node scripts/record-cursor.ts --check    # says what Cursor is set to; changes nothing
```

It runs the real Cursor on your sign-in and plan, with short harmless prompts on its
Auto model in scratch folders under `/private/tmp/portals-cursor-record/`, and replaces
paths, names and ids in what it writes. A run changes things in Cursor itself, because
its protocol leaves no other way (the script's header has the list):

- A model can only be chosen by selecting it in Cursor, which is then the terminal's
  model too. The recorder notes what Cursor was on, selects Auto, and puts the old model
  and its settings back when it ends; after a run that died, `--put-back` does that.
- Cursor keeps every session a run makes (`~/.cursor/acp-sessions/`) and a folder for
  each scratch folder (`~/.cursor/projects/`). Nothing deletes them.

After recording, set `testedCursorVersion` (`src/providers/cursor/options.ts`) to the
release recorded. Before committing a recording, search it for your home path, your user
and host names, email addresses and tokens: the recorder replaces them, and this checks
that it did.

OpenCode is tested against a stand-in for its server (`test/opencode-serve.ts`) that
answers the HTTP calls OpenCode's own client makes and plays, on its event stream, turns
recorded from OpenCode 2.2.5 (`test/fixtures/opencode/`: each event of a turn, a line
each, and one session's stored messages): a reply, a command allowed once, always and
denied, a file written, a stop, a failed provider, a dropped stream. A recording waits at
a permission request for the bridge's answer and, when a test says, at a stop for the
bridge's interrupt. Whole threads run through the bridge against it
(`test/opencode-bridge.test.ts`); the mapping of tools, cards and stored conversations
has tests of its own (`test/opencode-mapping.test.ts`), and finding the server, the
background service or an `opencode serve` of the bridge's own (a stand-in program,
`test/opencode-standin.ts`), too (`test/opencode-server.test.ts`). No test starts
`opencode`. The recordings were made with an `@opencode/cli` installed in a scratch
folder, with `HOME` and the XDG folders pointed inside it and its updates off, so the
user's own OpenCode, settings and sessions were never touched; record again that way, on
a free model, after a release, then set `testedOpenCodeVersion` and the pinned
`@opencode/client` to it.

The same native client drives the inbox, forms, agents, commands, compaction, Console
usage, subagents and desk-adoption tests. Mapping tests cover typed form values,
historical and nested child rows, stopped versus failed children and Console budgets;
integration tests cover native bodies, reconnect receipts, external answers, background
cards, read-only adoption and unsupported images rejected before any prompt. Setup tests
cover selective client installation, including installed-copy updates and rollback.
Run `node --import ./test/environment.ts --test test/opencode-*.test.ts` for the provider
checks, then `npm run typecheck` and `npm test` for the bridge.

Against a running bridge, the app's own client checks it end to end (from
`Packages/PortalsKit`, password in `$PORTALS_PASSWORD`). Live checks run in a
scratch folder: start the bridge with its own `PORTALS_BRIDGE_HOME` whose
`config.json` sets `generalFolder` to that folder (a temporary folder is never on the
list, but General always works), and leave `--cwd` out. A scratch bridge with Pi on
also gets `PI_CODING_AGENT_SESSION_DIR=<a scratch folder>`: Pi then keeps that bridge's
threads there, not among your own sessions in `~/.pi/agent/sessions`, and the bridge
reads their history from there:

```sh
swift run portals-probe --url http://127.0.0.1:9120 --user dana profiles
swift run portals-probe --url http://127.0.0.1:9120 --user dana folders --profile claude
swift run portals-probe --url http://127.0.0.1:9120 --user dana desk --profile claude
swift run portals-probe --url http://127.0.0.1:9120 --user dana adopt <session id> --profile claude --mode fork
swift run portals-probe --url http://127.0.0.1:9120 --user dana chat --profile claude \
  --model haiku --slash "/mode ask" --approve deny,once "Create a.txt."
swift run portals-probe --url http://127.0.0.1:9120 --user dana chat --profile codex \
  --follow-up "Then say banana." "Count to 100."
swift run portals-probe --url http://127.0.0.1:9120 --user dana reattach <thread id> --last-seen 30
```

Frames captured with `--capture` and cleaned by `scripts/capture-frames.sh NAME --from
FILE` are the `bridge-*.jsonl` fixtures the Swift tests replay through `HermesBackend`.

## A password by hand

Setup makes the password. To set one yourself, hash it into `auth.passwordHash`:

```sh
node scripts/hash-password.ts --user dana     # asks for the password, prints the "auth" block
```

`pair` can't show a password it didn't make, so a phone then signs in with the user
name and password typed in the app.

## How it works

Up to 0.2.0 the README held all of what follows. From 0.3.0 the README is the page npm
shows, what a person installing the host needs, and what it said of the bridge's insides
was moved here as it was (2026-10-29): the files it keeps, every setting, notifications,
the folders it offers, sessions from the desk, the fleet and the net in detail, how each
agent is run, the counters and the known limits. "The bridge" is the host as its code and
its files call it.

- [Where things are](#where-things-are)
- [Settings](#settings): every key
- [Notifications](#notifications)
- [Folders](#folders)
- [Sessions from the desk](#sessions-from-the-desk)
- [Agents working with each other](#agents-working-with-each-other)
- [Visuals in replies](#visuals-in-replies)
- [How each agent is run](#how-each-agent-is-run): [Claude Code](#claude-code),
  [Codex](#codex), [Pi](#pi), [Cursor](#cursor), [Droid](#droid), [Hermes](#hermes),
  [OpenCode](#opencode)
- [Counters](#counters)
- [Experimental client feature](#experimental-client-feature): lean deltas
- [Known limits](#known-limits)

## Where things are

Everything is in `~/Library/Application Support/portals-bridge/`, on Linux in
`~/.local/share/portals-bridge/` (`$PORTALS_BRIDGE_HOME` names another folder):

| File | What |
|---|---|
| `config.json` | Settings (below). Mode 0600 |
| `password.txt` | The sign-in password setup made, for `pair` to show. Mode 0600; only its hash is in `config.json` |
| `setup.json` | What setup found and made: the LaunchAgent, the phone's address, the `tailscale serve` port it mapped |
| `app/` | The installed bridge the LaunchAgent runs |
| `bin/portals` | The `portals` command of this bridge ([Agents working with each other](#agents-working-with-each-other)), written each time the bridge starts |
| `agent.sock` | The socket that command reaches the bridge by. Mode 0600. Under `/tmp` instead when the folder's path is too long for a socket |
| `links.json` | The other Macs this bridge reaches by a link made by hand, with their bridges' address and sign-in. Mode 0600 |
| `state/net.json` | The net this Mac is in and its members, Macs and devices, removed ones kept as removed; every Mac in the net keeps a copy. Also the net this Mac last left, so that a Mac of it that was off learns it. Mode 0600 |
| `state/net-own.json` | What never leaves this Mac: its token in the net, its X25519 key, and its relay id and secret. Mode 0600. Each save of either keeps the file before it as `.bak`; one the bridge could not read when it started is kept beside it as `.corrupt-<time>-<id>`, with an error in the log, and the bridge goes on with the `.bak`; when that cannot be read either, it is kept aside too, and the bridge starts a net of its own (`portals net join` takes it back into its net) |
| `state/aeri.sqlite`, `state/aeri-memory.md` | Left by a bridge that ran Aeri, an agent of its own that managed the others, taken out on 2026-10-21 (its code is on the branch `aeri-kept`). Never read |
| `state/threads.json` | The threads the bridge knows: agent, folder, model, mode, title. Each save keeps the file before it as `threads.json.bak` (so does `removed.json`, the threads taken off the list). One it could not read when it started is kept beside it as `threads.json.corrupt-<time>-<id>`, with an error in the log, to be put back by hand with the bridge stopped, and the bridge goes on with `threads.json.bak`, as a new list every device takes whole; when that cannot be read either, it is kept aside too, and the bridge starts a new, empty list, which every device takes |
| `state/waiting/` | The messages waiting for an agent to finish its turn, with their images, while they wait: sent once the bridge starts again if it stopped meanwhile |
| `state/push.json` | Devices and the threads they want to hear about (see [Notifications](#notifications)) |
| `state/looks.json` | How each agent looks in the app (its avatar's shape, face and colour, or its maker's logo), so every device draws it the same |
| `state/images/` | Images from the phone while Codex reads them; each is deleted when its turn ends |
| `state/cursor/` | Cursor's models and commands as it last listed them (`agent.json`), each Cursor thread's conversation as the app shows it (`threads/`), and the Cursor processes that run now (`processes.json`). What Cursor itself keeps is under `~/.cursor`: see [Cursor](#cursor) |
| `state/droid/` | Droid session identities and the display conversations for Portals threads. Droid keeps its own execution context separately; see [Droid](#droid) |
| `state/update.json` | When npm's registry was last asked for the newest `portals-host`, and what it said (`src/updates.ts`); `npx portals-host status` reads it to say a newer version is out |
| `opencode-serve.log` | What an `opencode serve` of the bridge's own printed ([OpenCode](#opencode)) |
| `counters.log` | A line of counts a minute, while the [counters](#counters) are on; `counters.log.1` is the file before it. Mode 0600 |

When no usable backup exists, quarantine reserves an unused archive name and moves
the original there atomically, preserving unreadable files, directories and symlinks
without copying them. A stop between reservation and move can leave an empty archive
reservation beside the intact original. A later recovery uses another name. Restoring
a usable backup still keeps the corrupt primary until its replacement is ready.

The LaunchAgent is `~/Library/LaunchAgents/com.danielou.portals.bridge.plist`, and the
log `~/Library/Logs/portals-bridge.log`. On Linux, the systemd unit is
`~/.config/systemd/user/portals-host.service`, and the log
`~/.local/state/portals-bridge.log`.

The agents keep their own conversations where they always do. A Pi thread is Pi's own
session file under `~/.pi/agent/sessions/`; the bridge keeps no copy of it and nothing
else of Pi's in its folder. A Cursor thread is kept twice: by Cursor under `~/.cursor`,
and by the bridge as the app shows it (`state/cursor/`, above).

## Settings

`config.json`, as setup writes it:

```json
{
  "host": "127.0.0.1",
  "port": 9120,
  "auth": { "username": "you", "passwordHash": "scrypt$…" },
  "allowedHosts": ["127.0.0.1", "localhost", "::1", "your-mac.your-tailnet.ts.net"],
  "generalFolder": "~/Portals",
  "folders": { "hide": [] },
  "providers": { "claude": true, "codex": true, "pi": true, "cursor": true, "droid": true, "hermes": true, "opencode": true, "fake": false },
  "claude": { "path": "/Users/you/.local/bin/claude", "idleMinutes": 15, "maxWarm": 6, "apiKey": "sk-ant-…" },
  "codex": { "mode": "shared", "path": "/usr/local/bin/codex", "socket": null, "titleModel": "gpt-5.6-luna" },
  "pi": { "path": "/usr/local/bin/pi", "idleMinutes": 15, "maxWarm": 6, "model": null },
  "cursor": { "path": "/Users/you/.local/bin/cursor-agent", "idleMinutes": 15 },
  "droid": { "path": "~/.local/bin/droid", "idleMinutes": 15, "maxWarm": 6 },
  "hermes": { "path": "~/.local/bin/hermes", "start": true },
  "opencode": { "path": "/Users/you/.opencode/bin/opencode", "mode": "shared", "start": true },
  "fake": { "delayMs": 40 },
  "apns": null,
  "push": { "dryRun": null, "relay": "https://portals-relay.danielou1208.workers.dev" },
  "fleet": { "tellAgents": true, "name": null },
  "relay": { "enabled": true, "url": "https://portals-relay.danielou1208.workers.dev" },
  "visuals": { "tellAgents": true },
  "counters": { "enabled": false },
  "updates": { "check": true }
}
```

Restart the bridge after editing it (`npx portals-host update`, or
`launchctl kickstart -k gui/$(id -u)/com.danielou.portals.bridge`; on Linux
`systemctl --user restart portals-host`). Only `counters` can
be changed while it runs, on a bridge that was started with them on ([Counters](#counters)).

| Key | Meaning |
|---|---|
| `port` | The bridge's port on 127.0.0.1; `tailscale serve` maps the phone's address to it. |
| `auth` | The user name and the password's hash the app signs in with. |
| `allowedHosts` | Names a request may be addressed to; anything else is refused, which keeps web pages from reaching the bridge. Setup adds your Mac's tailnet name. |
| `generalFolder` | General: where a new thread runs when the app names no folder, first in the app's list of folders. `~/Portals` unless set; the bridge makes it at startup when it is missing (only the last level: with its parent missing too, General is the home folder). |
| `folders.hide` | Folders never offered for new threads, nor anything under them (`~` is the home folder). See [Folders](#folders). |
| `providers.claude` | Offer Claude Code (`claude` in the sidebar). |
| `providers.codex` | Offer Codex (`codex` in the sidebar). |
| `providers.pi` | Offer Pi (`pi` in the sidebar). Off unless set: setup turns it on where it finds `pi`. Pi does not ask before it acts; see [Pi](#pi). |
| `providers.cursor` | Offer Cursor (`cursor` in the sidebar), when `cursor-agent` is installed. On unless set to `false`, also for a bridge set up before it could run Cursor; setup writes `false` on a new install that finds none. See [Cursor](#cursor). |
| `providers.droid` | Automatically offer the installed Droid (`droid` in the sidebar). On unless explicitly `false`; no separate installation or login. Setup records the executable it finds. See [Droid](#droid). |
| `providers.hermes` | Offer Hermes, one agent per Hermes profile (`hermes` for its default profile), when Hermes is installed; see [Hermes](#hermes). |
| `providers.opencode` | Offer OpenCode 2 (`opencode` in the sidebar), when `opencode` is installed. Off unless set: setup turns it on where it finds OpenCode 2, and only says an OpenCode 1 is there, with how to upgrade. See [OpenCode](#opencode). |
| `providers.fake` | Offer the scripted test agent (`fake`). Tests and development only. |
| `claude.path` | The installed `claude`. |
| `claude.idleMinutes` | A thread's Claude process stops after this long with no turn running, no question open and no background work running. The next message resumes it. |
| `claude.maxWarm` | At most this many Claude processes at once; the least recently used idle one stops first. |
| `claude.apiKey` | The Anthropic API key Claude Code runs with, or `null` for your own Claude login. See [Claude Code's sign-in](README.md#claude-codes-sign-in). |
| `claude.oauthToken` | A long-lived token from `claude setup-token`, given to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`, or `null` for your own Claude login. Not used when `claude.apiKey` is set. See [Claude Code's sign-in](README.md#claude-codes-sign-in). |
| `claude.toolSummaries` | Claude Code says in a few words what each run of its tool calls did ("Read a.txt and b.txt"), which the app shows on the status line as what the agent is working on. Each summary costs Claude Code one small extra model call of its own. On unless set to `false`. |
| `codex.mode` | `shared` (the default) or `own`; see [Codex](#codex). |
| `codex.path` | The installed `codex`. A bare name is looked up on the PATH the bridge runs with. |
| `codex.socket` | The shared daemon's socket; `null` is `~/.codex/app-server-control/app-server-control.sock`. |
| `codex.titleModel` | The model a new thread is named with after its first message, as Codex's own apps name theirs: `gpt-5.6-luna` unless set, Codex's own choice. `null` makes no names: a thread keeps the first line of its first message. See [Codex](#codex). |
| `pi.path` | The installed `pi`. A bare name is looked up on the PATH the bridge runs with. Setup writes the one it found; under nvm that is one Node version's, so run setup again after moving to another. |
| `pi.idleMinutes` | A thread's Pi process stops after this long with no turn running and no question open. The next message starts one again on the same session. |
| `pi.maxWarm` | At most this many Pi processes at once; the least recently used idle one stops first. |
| `pi.model` | The model a new Pi thread starts on, as `pi --list-models` names it with its provider first: `"openai/gpt-6.1-sol"`. Unset or `null`: Pi's own default, which under launchd can be another than in your terminal (see [Pi](#pi)). A thread's model can still be changed in the app. One Pi does not list is passed over, and the bridge's log says so. |
| `pi.titleModel` | The model a new Pi thread is named with after its first message, in one short request at no thinking (a `pi --print` with none of your tools, extensions, MCP servers, skills or context files, only your sign-ins), as Codex threads are named: `"provider/id"`. Unset: the thread's own model. `null` makes no names: a thread keeps the first line of its first message. A thread you renamed keeps your name. |
| `cursor.path` | The installed `cursor-agent`. A bare name is looked up on the PATH the bridge runs with. |
| `cursor.idleMinutes` | A folder's Cursor process stops after this long with no turn running, no card open and no thread being loaded. The next message starts it again. |
| `droid.path` | The installed `droid`, default `~/.local/bin/droid`. `~` expands to your home; a bare name is looked up on the bridge's PATH. Setup records the executable it finds. |
| `droid.idleMinutes` | A thread's Droid process stops after this many idle minutes (default 15), never during an active turn, an open question or tracked background work. The next message resumes its session. |
| `droid.maxWarm` | At most this many warm Droid thread processes (default 6); an idle process is cooled first when space is needed. |
| `droid.titleModel` | The model a new Droid thread is named with after its first message, as Codex threads are named: one short read-only `droid exec` at the model's lowest effort, with Codex's title prompt and no tools that reach anything, in an empty folder of the bridge's (its session files are removed after). Unset: the thread's own model. `null`: the bridge makes no names, and a thread takes Droid's own. Droid's own name stands in when none comes; a thread you renamed keeps your name. |
| `hermes.path` | The installed `hermes`. A bare name is looked up on the PATH; without one, `~/.local/bin/hermes`, where Hermes's installer puts it. |
| `hermes.start` | Start `hermes serve` when none runs (the default). With `false` the bridge only joins one that runs, and Hermes threads wait for it. |
| `opencode.path` | The installed `opencode`. A bare name is looked up on the PATH, then in `~/.opencode/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. Setup writes the one it found. |
| `opencode.mode` | `shared` (the default): join OpenCode's background service, the one its own apps use. `own`: run an `opencode serve` of the bridge's own. See [OpenCode](#opencode). |
| `opencode.start` | In `shared` mode, start OpenCode's background service when none runs (the default). With `false` the bridge runs a server of its own instead. |
| `apns` | The APNs key notifications are sent with, `{"keyPath", "keyId", "teamId"}`; `null` (the default) sends them through the relay. See [Notifications](#notifications). |
| `push.dryRun` | A file to write notifications to instead of sending them; `null` sends them. |
| `push.relay` | The Portals relay, used when `apns` is `null`; `null` sends none that way. |
| `fleet.tellAgents` | Tell Claude Code, Codex, Pi, Cursor and Droid threads that the `portals` command exists (the default). With `false` the command still works for an agent you tell of it. See [Agents working with each other](#agents-working-with-each-other). Either way they are told that the app typesets LaTeX between `$...$` and `$$...$$`. |
| `fleet.tellStarters` | Tell the thread that started a thread, with a message from it, when it finishes a turn, fails or waits for an answer (the default). A notice starts a turn of that thread's agent when it is at rest. With `false` the agent learns of it only by asking (`portals wait`, `portals read`). See [Agents working with each other](#agents-working-with-each-other). |
| `fleet.name` | What this Mac is called in what it passes on to another Mac's bridge: who sent a message, who started a thread. Its Computer Name when `null` (the default), never its network host name, which changes with the network. The app shows its own name for that Mac when it is paired with it too. A name set from the app (or `portals net rename`) wins over it until the Mac is renamed again. |
| `net.url` | The address the net's other Macs and devices reach this bridge at, with scheme and port, for a bridge set up without `portals-host setup`. `null` (the default): the address setup found, else `http://127.0.0.1:<port>`, which only this Mac reaches. |
| `relay.enabled` | Keep a standby connection open to the Portals relay, so a device in the net that cannot reach this Mac directly comes through it, sealed end to end (docs/pairing-and-relay.md, "The tunnel"). On unless `false`. |
| `relay.url` | The relay the tunnel goes through: the deployed one unless set (an `http://` address for one run by `wrangler dev`). |
| `visuals.tellAgents` | Tell Claude Code, Codex, Pi, Cursor and Droid threads that the app draws visuals (the default), in a line that sends them to `portals guide visuals`. With `false` they are not told, and a visual an agent writes anyway is still drawn. See [Visuals in replies](#visuals-in-replies). |
| `counters.enabled` | Write a line of counts a minute to `counters.log`: what the bridge costs. Off unless `true`. See [Counters](#counters). |
| `updates.check` | Ask npm's registry for the newest version of `portals-host` when the bridge starts and about once a day after, never more often, reading only the version number; when a newer one is out, the app shows "Update available" in the sidebar and on the host's row in Settings → Hosts, with the command to run (README, [Updating](README.md#updating)). Nothing when offline. On unless `false`. |

## Notifications

The phone is notified when an agent needs you or finishes:

| When | Says |
|---|---|
| An approval card opens | Wants to run: the command (Claude's plan, Codex's file change, …) |
| A question card opens | The first question |
| A turn finishes | The first line of the reply |
| A turn fails | Stopped with an error: the error |

Nothing for an interrupted turn. Only threads the app registered (it registers every
thread it shows), only to the devices that registered them, and the same approval or
question once a minute at most. The title is the agent's name, the subtitle the thread's
title; secrets in the text are masked and it is cut to one line. Each notification also
names this bridge as the app calls it (`aeriportal.host`), so a tap opens the thread on
the right host and the app puts the right agent's avatar on it. A device Apple says is
gone is forgotten.

The words are sealed to a key the app gave this bridge (`docs/pairing-and-relay.md` in
the app's repository): Apple and the relay see "Portals: New activity", and the app shows
the real words. A device that gave no key (an older app) gets them in the open.

Only the developer account that owns the app can notify it, so the bridge hands each
notification to the Portals relay (`push.relay`), which holds that account's key. The app
registers its device with the relay and gives the bridge the relay token it got, which
is what the bridge sends with: it names the device to the relay, and only the relay can
make one. The relay keeps no message.

A bridge run by the app's developer can send straight to Apple instead: point `apns` at
an APNs auth key (a `.p8` key with the Apple Push Notifications service enabled, from the
developer account the app is signed with), readable by you only (`chmod 600`):

```json
"apns": {
  "keyPath": "~/path/to/AuthKey_<key id>.p8",
  "keyId": "<key id>",
  "teamId": "<team id>"
}
```

The bridge reads the key, makes a provider token from it every 50 minutes and never
copies or logs either. A device's notifications go to Apple's sandbox or production
server, as the app registered it. At startup the bridge logs whether notifications are
on. With neither `apns` nor `push.relay` the routes still keep registrations and nothing
is sent. To see what would be sent, set `push.dryRun` to a file: each notification is
appended to it as a line of JSON instead.

## Folders

A new thread runs in a folder the app picks from the list the bridge offers
(`folders.list`): General (`generalFolder`) first, then the folders the agents worked in
lately, newest first, at most 30. The list comes from:

- Claude Code's sessions (the Agent SDK's `listSessions()`: each session's folder and
  when it last changed), the desk's and the bridge's alike;
- Codex's threads (`thread/list`, from Codex's own index), asked for in the background
  when the bridge starts and every 3 minutes, so a reply never waits for Codex;
- the projects `~/.codex/config.toml` trusts (its `[projects."<path>"]` headers only;
  no time, so they come after the rest);
- Droid's sessions (`~/.factory/sessions`) and Pi's (its session folder): the folder
  each session file's first line names, and when the file last changed; only that
  line is read, and again only once the file has changed;
- the bridge's own threads.

Only folders that exist are offered, each once by its real path. Never offered: `/`,
the home folder, temporary folders (`/tmp`, `/private/tmp`, `/var/folders`), the bridge's
own folder, hidden folders (any part of the path starting with `.`, so Codex's worktrees
under `~/.codex` too) and whatever `folders.hide` names. A thread can start only in
General or a folder on the list: `session.create` refuses any other `cwd`. A folder the
person chose in the app is put on the list with `folders.add` (marked `added` until
`folders.remove` takes it off; feature `folders_add`), and `folders.search` finds any folder
under the home folder for the app's picker, as the person types (src/folderSearch.ts,
feature `folder_search`). The app cannot create a folder.

## Sessions from the desk

The app lists the sessions an agent has on this Mac that were started in a terminal
(`desk.list`), under From this Mac in each coding agent's menu, and takes one up as a
thread (`session.adopt`). Listed: Claude Code's sessions from a terminal (not the ones
an SDK started), from its own index; Codex's threads, from its index; and Pi's sessions,
read from the files Pi keeps them in (`~/.pi/agent/sessions/`), since Pi has no command
that lists them. Newest first. Never listed: the bridge's own threads, sub-agents'
threads, a Codex thread or a Pi session with no message yet, and sessions in a folder
that is gone, temporary (unless it is General or under it), the bridge's own or hidden
in `folders.hide`. Nor Cursor's: Cursor keeps those apart from the ones the bridge can
open ([Cursor](#cursor)).

| State | Claude Code | Codex | Pi |
|---|---|---|---|
| Open in a terminal | `claude agents --json` lists it: a terminal (or a background agent) has it | | A Pi runs in a terminal in the session's folder, and may have it |
| Working | | A turn is running | |
| Needs you | | It waits on an approval or a question | |
| (none) | Nobody has it open | Loaded with nothing running, or not loaded | No Pi runs in a terminal in its folder |

Pi does not say which session a terminal has open: it keeps no lock and no list. What
the bridge can see is that a `pi` runs in a terminal and in which folder (`ps`, then
`lsof` for the folder), so it goes by folder: while a Pi is open in a project's terminal,
every Pi session of that project counts as open, whichever one that Pi has.

Taking one up:

- **Continue.** Claude Code: the thread is the session, resumed by its id, so `claude
  --resume <id>` at the desk later shows the phone's turns. A session a terminal has open
  is not continued: resuming it would add turns the terminal never sees. The check runs
  again each time Claude starts for the thread. Codex: the bridge joins the thread on the
  shared daemon, also while a terminal works on it; an approval the terminal waits on
  comes to the phone too, and answering it there closes the terminal's dialog. Pi: the
  thread is the session, opened by its id in its folder, on the model and level it had at
  the desk, so `pi --resume` at the desk later shows the phone's turns, and what you say
  at the desk shows on the phone once you open the thread there again (the bridge loads
  it again from Pi's file, when nothing is under way in it). It is not
  continued while a Pi runs in a terminal in that folder (quit it there first, or fork),
  and the bridge looks again before every turn of the thread: while a Pi is open there,
  the turn ends with a sentence saying so and nothing is written (nor when the Mac does
  not answer in time: send the message again). A title, model or level you give the
  thread meanwhile is kept, and Pi gets it with the next turn that goes through. If the
  session ran on a model the bridge's Pi has no key for, its turns fail with Pi's
  sentence until you pick another model for the thread. A session whose folder has since
  become a link to another folder is not continued (Pi would not find it from there);
  fork it. A thread whose folder becomes one later takes no more turns, and says why.
- **Fork.** A new thread with the session's history so far (Claude's `forkSession`,
  Codex's `thread/fork`, Pi's own `pi --fork`, run once by the bridge); the session
  itself is left alone. A Pi fork runs also while a Pi is open in the folder's terminal.
- **View only.** The thread shows the session, read again each time the app opens it, and
  takes no message. For Pi, a command the Pi at the desk is still running shows once it
  has finished.

Adopted threads are kept in `state/threads.json` with origin `desk` and behave like any
other thread from then on.

## Agents working with each other

An agent can see and drive the other threads on the Mac with the `portals` command, the
way you do from the app: list them, read one, send it a message, wait for it, start a
new one or stop one. Ask for it in words: "start a Codex thread to review this and tell
me what it says".

```sh
portals threads                      # the newest threads, and whether each is idle, working, blocked or in error
portals read THREAD                  # its last turn, what it waits on first
portals send THREAD "text" --wait    # a message, and the reply once the thread is at rest
portals report "text"                # in a thread another started: its report to that one
portals start --agent codex "text"   # a new thread, with its first message
portals guide                        # the rest, as the agents read it
portals guide visuals                # how agents write a visual (Visuals in replies)
```

- The command is `bin/portals` in the bridge's folder. Claude Code, Codex, Pi, Cursor and Droid
  threads are told it exists, and to use it only when you ask (`fleet.tellAgents`). It
  works in your own terminal too.
- A message sent this way opens with a line saying it came through Portals, and from
  which thread when an agent's thread sent it (any of Claude Code, Codex, Pi, Cursor
  and Droid), so neither the other agent nor you take it for yours. The app shows who
  sent it above a lighter bubble, with the Mac it came from when that is another.
- The command cannot answer another thread's approvals or questions, and agents are
  told not to try: a blocked thread waits for you in the app.
- A thread an agent started tells that agent's thread when it finishes a turn, fails or
  waits for an answer: the bridge sends a message from it, opening "Notice from the
  bridge", with its last reply or what it asks, on this Mac or the other Mac of the net
  the starting thread is on. So the agent that started it hears of it without checking,
  and can bring you its news or its questions. A thread waiting for it already
  (`portals send --wait`, `portals wait`) hears it there and is not told again. A started
  thread can also end its work with a report of its own (`portals report`, which finds the
  thread that started it), and then no notice follows for that work; a message it sends
  with `portals send` while it works (to ask something, or say how far it is) still gets
  the notice when it finishes. What it asks is told either way (`fleet.tellStarters`).
- The command reaches the bridge over a socket in its folder that only you can open.
  Nothing of it is reachable from the tailnet.

Your other Macs' threads can be in the list too. Macs in one net reach
each other both ways by themselves, named after each Mac (`mac-mini`), with no password:
each bridge keeps a copy of the net's members, Macs and devices, and tells the others when
it changes. Every bridge starts as a net of its own. To bring another Mac in, make a join
link on a Mac of the net and give it to the other, yourself, in a terminal: a join link
lets whoever has it into the net, for ten minutes, once.

```sh
portals net                                # the net's members
portals net invite                         # a join link
portals net join                           # on the other Mac: asks for the join link, then joins with its devices
portals net remove MEMBER                  # takes a Mac or a device out, on every Mac
portals net rename "Studio"                # renames this Mac on every Mac and device (MEMBER "Studio": another Mac)
portals net leave                          # this Mac leaves, and is a net of its own
```

A Mac in a net with other Macs cannot join another until it leaves its own.

A Mac outside the net can still be linked by hand, with that Mac's pairing link
(`npx portals-host pair` there shows it). Do it yourself, in a terminal: the link holds
that Mac's password, so it does not belong in a chat with an agent.

```sh
portals link                               # asks for the pairing link, checks the other Mac's bridge, then keeps the link
portals machines                           # the linked Macs, and their agents
portals start --machine mini --agent claude "text"
portals unlink mini
```

Its threads then show with ids like `mini/6d3c…`, which work wherever a thread is named.
A link gives reach one way: link each Mac to the other for both. The link keeps the
other bridge's password, in `links.json` in the bridge's folder (mode 0600). When that
password changes, link the Mac again under the same name. A Mac that is asleep is left
out of the lists for half a minute after it fails to answer, so the lists stay quick.
What a Mac passes on to another (who a message is from, who started a thread) names it
by its Computer Name, or by `fleet.name` in its settings when that is set, until it is
renamed from the app or with `portals net rename`: that name is the net's, on every Mac
and device, and the Mac goes by it from then on (kept in `state/net.json`, not in
`config.json`) until it is renamed again.

Between bridges, links offer WebSocket compression, as the app does. A bridge that
supports it compresses replies of at least 1 KB; older bridges may decline it. The
calls and their answers stay the same, and the eight-second listing deadline is
unchanged. Each link socket lasts for one call, then closes, keeping no compression
state between calls (about 360 KB per compressed connection while open).

Unfiltered lists from linked bridges that advertise `fleet_delta_positions` use an incremental
local list internally:
changed threads, removals and every thread's live non-idle state. Each refresh still
asks the other Mac, never serves a stale answer when it cannot be reached, and gives
clients the same fields and newest-first ordering as a full list. Absolute registry
positions preserve ordering when a thread is removed and re-adopted between refreshes,
without another call. A full reply already gives registry order and omits the redundant
positions array. Invalid positions or a digest mismatch discard the base and
report the Mac unreachable, with a payload-free log and counter; the next call takes
a full base. Restarts reset the cursor, and a full safety read runs every two minutes.

The per-linked-Mac cache holds at most 20,000 rows or an estimated 16 MiB; larger lists
are returned whole, not truncated, without retaining a delta base. Removed or replaced
links free it immediately, and an unreachable Mac's rows and cursor expire after a
minute. Older bridges use `threads.list` on the same connection, without a failed
probe. Filtered requests retain today's exactly filtered remote `threads.list` call,
since a cold filtered reply can be much smaller than an unfiltered delta base.
The app and its `threads.changes` protocol do not need to change.

## Visuals in replies

An agent can put a visual in a reply: a chart, a diagram, a comparison, something to
play with. It writes the HTML in a code block whose language is `portals-visual`, and
the app draws that block live instead of showing code (other apps show the code), as it
is written. Claude Code, Codex, Pi, Cursor and Droid threads are told the app does
this, and to make one whenever seeing or trying something helps, especially when they
explain or teach (`visuals.tellAgents`); `portals guide visuals` prints the rules they
read before making one. (They were called widgets at first: a `portals-widget` block is
still drawn, and `portals guide widgets` still prints the guide.)

- A visual is a visual aid only: sliders, tabs and toggles change the visual, and
  nothing in it reaches the agent or the bridge.
- It runs in the app, locked down: it can load scripts, style sheets and fonts from
  jsDelivr, unpkg and cdnjs, and nothing else from the network, and it cannot open
  pages, frames or pop-ups. A link you tap opens in your browser.
- Nothing about visuals is stored by the bridge: a visual is part of the reply, in the
  agent's own history.

How the app draws them is in `docs/visuals.md`.

## How each agent is run

What the bridge does with each agent, what the app sees of it, and the commands it offers.
The README keeps a short part of each for the person using it.

**Versions.** Each agent names the releases the bridge was tested with, and a minimum
only where an older release is known not to work (`src/providers/program.ts`). The
bridge learns the release from `--version` at startup, and from the running process
where it says so itself: Claude Code's `system/init` (`claude_code_version`) and the
Codex app server's `initialize` (`userAgent`), which is the release a thread really runs
on when the program was updated after the bridge started, or the shared Codex daemon was
not restarted. Each release is logged once: an error when the program does not run or is
older than the minimum, a warning when it is newer than the tested ones or another, a
line for a tested one. Only a release below the minimum runs no turn; today that is Pi
older than 1.1.0. `/status` shows the release last known, and what is off about it, on
a `Version:` line after the agent (`Version: Codex 0.168.0, newer than the 0.166.0
Portals was tested with`).

### Claude Code

Each thread is one Claude Code session, and the thread id is its session id. The bridge
chooses it at `session.create` and starts nothing then; the first message starts a
`claude` process (streaming input through the Agent SDK) in the thread's folder. The
process stays up for the next message and stops after `idleMinutes` idle; the message
after that starts a new one that resumes the session. A thread opened after a restart
of the bridge is read from Claude's own history without starting anything.

Background work Claude starts (a command or subagent run in the background, a
workflow) runs in that process, so the thread does not count as idle while there is any
(`background_tasks_changed`). When a piece of it ends, Claude begins a turn by itself;
the app gets it as a turn opened by a line saying what ended (`status.update` kind
`process`, then `message.start`), and a push when it finishes, as for a turn of its own.

How it runs `claude`:

- **The installed `claude`**, at `claude.path`, not a copy of its own. The bridge was
  tested with Claude Code 2.1.318 and `@anthropic-ai/claude-agent-sdk` 0.3.318; it logs
  a warning for another release, at startup and when a process says it runs one.
- **Its sign-in.** With `claude.apiKey` set, `claude` gets the key as
  `ANTHROPIC_API_KEY`; with `claude.oauthToken`, the token as `CLAUDE_CODE_OAUTH_TOKEN`.
  Without, it signs in with its own Keychain login (`apiKeySource: none`); the bridge
  never reads, stores or passes on Claude credentials. A login ends on a fixed date,
  which `claude auth status` (`loginExpiresAt`, asked at startup) and each result
  (`credential_expires_at`) say from 2.1.318: from ten days before, each thread says
  so once a day. A turn refused for the sign-in (`authentication_failed`) ends with
  what to run on the host instead of Claude Code's words, which name its `/login`.
- **Your own settings.** It loads your user, project and local settings, CLAUDE.md
  files, plugins and MCP servers, as at the desk, with Claude Code's own system prompt,
  and starts in the permission mode they give. Change it per thread with `/mode` (below).
- **A clean environment.** Variables starting with `CLAUDE_CODE_`, `CLAUDECODE`,
  `CLAUDE_PID`, `CLAUDE_EFFORT`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not
  passed on from the bridge's own environment, so a bridge started from a Claude Code
  terminal still starts clean sessions. `CLAUDE_AGENT_SDK_CLIENT_APP` is set to
  `portals-bridge`.

What the app sees:

| Claude | In the app |
|---|---|
| Text and (summarized) thinking | The reply and its reasoning row, word by word |
| `Bash` | Terminal row: the command, its output, its exit code |
| `Read` · `Write` · `Edit`, `MultiEdit` | Read · Write · Edit rows; writes and edits show a diff |
| `Grep`, `Glob` · `WebSearch` · `WebFetch` · `Task`/`Agent` · `TodoWrite` | Search · Web search · Read page · Delegate · To-do rows; MCP and other tools keep their names |
| A permission prompt | An approval card: once, for this thread (session), always (saved in the folder's `.claude/settings.local.json`, offered only when Claude suggests a lasting rule), deny, with what to do instead when the app gives it (Claude is told it as the reason) |
| `AskUserQuestion` | A question card; the answer goes back to Claude |
| `ExitPlanMode` | An approval card whose text is the plan |
| A message sent while Claude works | Added to the running turn (`steered`) |
| Claude's own session title | The thread's title |
| Context use, and a usage limit at 80% or more | The context meter, and a warning in the thread |

Models are the ones `claude` lists (`default`, `opus`, `sonnet`, `haiku`, …), each under
the name Claude Code gives it ("Opus 5.5", `model_names`). A thread that names no model
is on `default`: it runs on the `model` in your Claude Code settings, else on Claude's
recommended model, and the app lists it under that model's name, marked as the default.
The bridge asks Claude Code which model that is at startup, and again when the app asks
once that answer is ten minutes old; a `model` in one project's own settings is not
seen. The alias for the same model (`opus`) is left off the list, so each model is
listed once; a thread already on it keeps it. `/status` names the default
"Opus 5.5 (default)". The app's slider offers each model the effort levels Claude lists
for it (`model_levels`), and the composer shows the level a thread runs at: the one
chosen for it, else the model's own (`model_default_levels`, asked of Claude Code
model by model at startup, since your settings and Claude Code give each model its
own); a model that lists none (Haiku 4.5) is offered Claude's five,
which become its thinking budget. A level the app sends that Claude lacks goes to the
nearest (`none` and `minimal` are `low`, `ultra` is `max`). A model or level changed
during a turn applies when the turn ends.

#### `/mode`

| Command | Claude permission mode | The thread then |
|---|---|---|
| `/mode` | | says its mode |
| `/mode ask` | `default` | asks before editing files or running commands |
| `/mode edits` | `acceptEdits` | edits files without asking, asks before running commands |
| `/mode plan` | `plan` | plans first, and asks before carrying the plan out |
| `/mode full` | `bypassPermissions` | edits files and runs commands without asking |
| `/mode default` | (none set) | follows your Claude Code settings |

The mode is kept per thread and applied whenever its process starts; the app shows it as
an icon in the composer and changes it from there too (`session.set_mode`). A plan comes
to the app as a plan card: Start carries it out in the mode the thread had before plan
mode (Claude is told to leave plan mode for it; left to itself it would go back to
asking), and Keep planning sends what to change. When Claude leaves a mode itself
otherwise, the thread follows.

#### Other commands

`/status` shows the thread's agent, folder, the git branch checked out there, model and
mode. `/usage` shows your plan
and how much of each of its limits is used, and when each resets, as Claude Code's own
`/usage` does: asked of the thread's Claude Code while it runs, else of one started only
to ask (no session, no message); when none can say, or it cannot read the plan's limits
just then, as the turns last reported it, with when. Claude Code's own commands
(`/compact`, `/context`, `/init`, …) and your skills are offered too and are sent to
Claude as a message, each a turn of its own (one sent while a turn runs waits for it).
Commands that would leave the thread (`/clear`), change settings for every session
(`/model`, `/config`, `/effort`, …) or need a terminal are not offered; the app's own
`/model` and `/reasoning` change one thread.

A compaction, `/compact` or Claude Code's own as the context fills up, is marked where
it happened (`session.compacted`, with the tokens the context held before) and the
context meter falls to the summary. A command Claude Code refuses ("No messages to
compact") ends its turn with that reason.

### Codex

Each thread is one Codex thread, and the thread id is Codex's own (`thread/start`). The
bridge was tested with codex-cli 0.166.0; it logs a warning for another release, at
startup and when the app server it connects to names one.

**Shared or own.** With `codex.mode` `shared` (the default) the bridge joins the
app-server daemon every Codex on this Mac uses (`codex app-server daemon version` shows
it), over its socket: one connection for all of the bridge's threads. Threads live in
the daemon, so they keep running when the bridge stops or restarts, and a terminal can
work on the same thread: a question answered there closes the card on the phone. If the
socket is missing the bridge runs `codex app-server daemon start`; it never stops,
restarts or updates the daemon. With `own` the bridge runs a `codex app-server` of its
own instead, whose threads stop with the bridge. Either way Codex uses `~/.codex` (a
`CODEX_HOME` in the bridge's environment is ignored) and its own login.

How it runs Codex:

- **Your own settings.** A thread runs with your `config.toml`: model, thinking level,
  approval policy and sandbox. The bridge never writes `config.toml`. Changes from the
  phone (`/model`, `/reasoning`, `/mode`) go with that thread's next turn and Codex keeps
  them for that thread only. A turn also asks for reasoning summaries (`summary: auto`)
  when `config.toml` sets no `model_reasoning_summary`, so the app's reasoning row has
  text.
- **Turns.** A message sent while Codex works goes into the running turn
  (`turn/steer`, answered `steered`), except into a compaction, which Codex takes none
  into: it waits for the compaction to end (`queued`). One that reaches Codex as the
  turn ends, too late for it, is answered in a turn of its own right after. An image is
  written to `state/images/` for Codex to read and deleted when the turn ends; Codex
  reads JPEG, PNG, GIF and WebP.
- **Questions.** Approvals and Codex's questions (`request_user_input`) are the app's
  cards. They outlive the bridge's connection to Codex: after a reconnect or a restart
  Codex asks again and the card that is open answers it. Codex's other requests
  (more permissions, an MCP server asking for input) are declined with a note in the
  thread.
- **After a restart** the bridge at once follows its threads that Codex still has
  open, so a turn that kept running shows as running and its open approval waits for
  the phone. Other threads are read back from Codex when the app opens them, without
  loading them in Codex (loading a thread starts its MCP servers).
- **When Codex restarts** (it does to update itself, giving running turns a minute to
  finish) a turn it cut off ends interrupted, with a line in the thread saying so; the
  next message goes on from there.
- **When the connection to Codex drops**, the bridge connects again by itself and then
  tells the turns typed at the desk meanwhile. A message sent with no turn running waits
  as queued until they are told, then has its turn. When Codex still cannot be reached
  about 15 seconds after the message was sent, the message fails ("Codex is not reachable
  right now. The message was not sent.") and the app offers Try again; it is never sent
  later by itself.
- **Names.** Codex's daemon names no thread by itself: each of Codex's apps names the
  threads it starts, and so does the bridge. Once a new thread's first turn has started,
  a title-generation thread on `codex.titleModel` is given that message with Codex's own
  title prompt (a short imperative title, under five words where it can be) and answers
  with JSON; the name goes onto the thread (`thread/name/set`), where Codex's own apps
  see it too. That thread is ephemeral (Codex keeps nothing of it), has one line of
  instructions in place of Codex's own, and runs with nothing to act with: no plugins,
  apps, shell or MCP servers (each one `config.toml` sets up is turned off for it, and
  when Codex cannot say which, no name is made), none of your hooks and no memories.
  It costs about 8,500 input tokens on the cheap model. Until the name comes,
  and when none does, the title is the message's first line. A thread named meanwhile
  (renamed in the app, `portals start --title`, another app) keeps its name.

What the app sees:

| Codex | In the app |
|---|---|
| Messages beside the work (commentary) | Text, closed off before the next row |
| The final answer and reasoning summaries | The reply and its reasoning row, word by word |
| `commandExecution` | Terminal row: the command (without Codex's `zsh -lc` wrapper), its output, its exit code |
| `fileChange` | Edit row with a unified diff; a new file is a Write row |
| `mcpToolCall` · `webSearch` · sub-agents · plan updates | The tool's own name · Web search · Delegate · To-do rows |
| A plan of plan mode (`plan`) | Plan row, filled in as Codex writes it (`item/plan/delta`, as live output) |
| `sleep` (Codex waiting) | Wait row, saying for how long |
| A review (`enteredReviewMode` to `exitedReviewMode`) | One Review row from its start to its end, saying what it reviews; the review's commands are rows of their own, and its findings are Codex's reply |
| A command approval | once (`accept`), for this thread (`acceptForSession`, when Codex offers it), always (the rule Codex proposes, when it offers one), deny (`decline`: the turn goes on; what to do instead, when the app gives it, follows as your message steered into the turn) |
| A file-change approval | "Edit <path>" and the diff: once, for this thread, deny |
| A command's approval to reach a host (`networkApprovalContext`) | The host (or the command reaching it) and "Codex wants to reach <host>"; always allows the host from then on (the network amendment Codex offers) |
| `request_user_input` | A question card |
| A turn started in a terminal on a thread the bridge follows | A turn of its own |
| Codex's name for the thread | The thread's title; until the bridge has named a new thread, the first line of its first message |
| Context use, and a usage limit at 80% or more | The context meter, and a warning in the thread |
| `contextCompaction` | "Compacting the conversation…" while it runs, then a mark of where it compacted, with the context use before it |

Models are the ones `model/list` offers (hidden ones left out), from provider `openai`;
the default is `config.toml`'s. The app's slider offers each model its
`supportedReasoningEfforts` (`model_levels`); a level a model lacks goes to the next one
up it has, else its strongest. Of Codex's own slash commands the bridge offers those it
can carry out through the app-server: `/compact` runs `thread/compact/start`, a turn of
its own, and `/review` runs `review/start` on the thread (the uncommitted changes, or what
follows the command), a turn of its own too, with the thread's settings as Codex has them.
Neither takes a message in while it runs: one sent meanwhile waits for it. The rest of
Codex's commands are its terminal's own. Codex's skills for the thread's folder
(`skills/list`, those turned off left out) are offered as skills: `/name what to do` goes
to Codex as it is, with the skill beside it (a `skill` input), as Codex's own apps send a
skill picked from their menus. `/usage` shows your plan and how much of
each of its limits is used now (`account/rateLimits/read`), a workspace's spending limit,
what turns work away where no limit shows it (a workspace's credits used up), and the
credits left.

#### `/mode`

| Command | Approval policy | Sandbox | The thread then |
|---|---|---|---|
| `/mode` | | | says its mode |
| `/mode ask` | `untrusted` | workspace write | asks before editing files or running commands |
| `/mode edits` | `on-request` | workspace write | edits files and runs commands in its folder without asking, and asks before going outside it |
| `/mode plan` | `on-request` | read only | only reads, and asks before changing anything |
| `/mode full` | `never` | full access | edits files and runs commands without asking |
| `/mode default` | from `config.toml` | from `config.toml` | follows your Codex settings |

The mode is kept per thread and goes with the thread's next turn. Workspace write takes
network access from `config.toml`'s `[sandbox_workspace_write]`.

### Pi

Each thread is one [Pi](https://github.com/earendil-works/pi) session, and the thread id
is the session's own id. The bridge chooses it at `session.create` and starts nothing
then; the first message starts `pi --mode rpc --session-id <id>` in the thread's folder,
one process per thread. The process stays up for the next message and stops after
`pi.idleMinutes` idle, never while a turn runs or a question is open; the message after
that starts a new one, and Pi goes on from its own session file. A thread opened after a
restart of the bridge is read from that file without starting anything. The bridge was
tested with Pi 1.1.0 and 1.5.0, whose RPC mode is the same; at startup it logs a warning
for another release. A Pi older than 1.1.0 runs no turn (it lacks what the bridge ends a
turn by): the thread says so, and works once Pi is updated (`pi update`).

**Pi does not ask before it acts.** Pi has no approvals and no permission modes: it runs
every command and makes every edit its model decides on, at once, and through the bridge
it does the same. There is nothing to approve on the phone and no `/mode` for a Pi
thread. Give a Pi thread only work you would let Pi do unattended in your terminal. If
one of your Pi extensions asks something (a confirmation before a command, say), the
phone shows its question as a card and sends your answer back; that is the extension
asking, and a Pi without such an extension asks nothing.

How it runs Pi:

- **The installed `pi`**, at `pi.path`, with your own settings, extensions, skills,
  prompt templates and the sign-ins Pi keeps itself (`pi`, then `/login`). Of Pi's own
  files the bridge reads only the session files (a thread's for its history, all of them
  for the [sessions from the desk](#sessions-from-the-desk)), and it writes nothing under
  `~/.pi`: a fork is made by Pi. Whether a project's own `.pi/` folder is loaded is Pi's
  setting (`defaultProjectTrust`), as at the desk.
- **Not your shell's variables.** The installed bridge is started by launchd, which
  gives it a PATH and nothing else, so an API key you keep in a shell variable does not
  reach the bridge's Pi. The models that need it are missing from the app's list. If
  Pi's default model is one of them, Pi falls back, without saying so, to a model it
  does have a sign-in for (with an Anthropic sign-in, `anthropic/claude-opus-4-8` when
  this was written), and a new thread that names no model runs on that one. At startup
  the bridge logs which model it is ("Pi's own default, which a new Pi thread runs on
  unless it names a model"). Three ways out: name the model new threads start on with
  `pi.model` in `config.json` (`"pi": { "model": "openai/gpt-6.1-sol" }`), which holds
  whatever Pi falls back to; store the key with Pi's own `/login` in place of the
  variable, to have the same models as at the desk; or pick the model for each thread
  in the app.
- **`pi.path` is the `pi` setup found.** `pi` is a script run by `node`, so setup also
  puts its folder on the LaunchAgent's PATH, and the commands Pi runs see that PATH.
  Under nvm the folder belongs to one Node version: after you move to another, the
  bridge keeps running the old Pi until you run `npx portals-host setup` again.
- **The `portals` command** is on a Pi thread's PATH, and the thread is told of it in a
  few lines added to Pi's system prompt (`--append-system-prompt`), unless
  `fleet.tellAgents` is off. Pi takes that flag in place of the `APPEND_SYSTEM.md` it
  would add by itself, so the bridge names your own (`~/.pi/agent/APPEND_SYSTEM.md`)
  along with its lines. A project's own `.pi/APPEND_SYSTEM.md` is not added then:
  whether Pi trusts a project is Pi's to say. With `fleet.tellAgents` off Pi starts
  without the flag and adds what it adds at the desk.

What the app sees:

| Pi | In the app |
|---|---|
| Text and thinking | The reply and its reasoning row, word by word |
| `bash` | Terminal row: the command, its output, its exit code |
| `read` · `write` · `edit` | Read · Write · Edit rows; writes and edits show a diff |
| `grep`, `find`, `ls` | Search rows |
| `codemode` | One row with the script; the calls the script makes are not rows |
| Your extensions' tools | `web_search` and `fetch_content` (pi-web-access) are Web search and Read page rows, `subagent` (pi-subagents) a Delegate row; MCP and other tools keep their names |
| An extension's dialog (`select`, `confirm`, `input`, `editor`) | A question card; the answer goes back to the extension. One with a time limit closes when the time is up |
| A tool call an extension refused | Its row, closed as blocked with the extension's reason |
| A message sent while Pi works | Added to the running turn (`steered`): Pi reads it after the tool calls of the answer it is writing |
| Stop | Pi's own Esc. Messages Pi had not read yet are dropped, and a note in the thread quotes them |
| An automatic retry | "Pi is trying again (2 of 3): …" while it waits |
| A compaction, `/compact` or Pi's own | "Compacting the conversation…" while it runs, then a mark of where it compacted, with the context use before it |
| Context use | The context meter |
| The session's name | The thread's title. A thread is named from its first message and Pi is given that name, so `pi --resume` lists it by the same words |

Models are the ones Pi lists for the sign-ins and keys it has, grouped by Pi's provider
(`openai`, `anthropic`, …) and under Pi's names for them; the default is Pi's own. The
list is Pi's and the bridge passes it on whole: Pi lists every model of a provider you
are signed in to, and a sign-in may not run them all (a ChatGPT sign-in refuses some of
OpenAI's). A turn on such a model fails at once with the provider's own sentence; pick
another model for the thread. The bridge asks a short-lived `pi` with no session for the
list when it starts, and again when the app asks once that answer is ten minutes old. The
levels are Pi's: `off` (the app's `none`), `minimal`, `low`, `medium` and `high`, with
`xhigh` and `max` for the models that have them, and `none` alone for a model that does
not think. A level a model lacks goes to the next one up it has, else its strongest, and
the composer shows the level Pi says it runs at. A model or level changed during a turn
applies when the turn ends. Both are kept in the thread's own session, never in your Pi
settings. An image is sent with the message; one the thread's model cannot read is left
out with a note.

`/compact [what to keep]` runs Pi's compaction, a turn of its own; Pi keeps the last
20,000 tokens whatever it summarises, so in a short thread it answers "Nothing to compact
(session too small)". Your extensions' commands, your prompt templates and your skills
(`/skill:<name>`) are offered too and go to Pi as a message, each a turn of its own. Pi's
built-in commands (`/model`, `/thinking`, `/name`, `/new`, `/resume`, `/tree`, `/fork`,
`/login`, …) exist only in its terminal and are not offered: the app's own controls
change a thread's model, level and name. Nor is a command that only one project
defines, or one with a capital letter in its name. An extension's command that draws in
the terminal is offered and does nothing here.

**At the desk.** A session you started with `pi` in a terminal is offered in the app
under From this Mac, to continue, fork or only read
([Sessions from the desk](#sessions-from-the-desk)). The other way round, a phone thread
is one of Pi's sessions in its folder: `pi --resume` lists it by the thread's title, `pi
--continue` opens it when it is the folder's newest, and `pi --session <thread id>`
opens it by its id. Quit Pi there before you go on from the phone: two Pis writing one
session file make branches in it, and Pi does not tell the bridge which session a
terminal has. The bridge looks for a Pi in the folder's terminal only before the turns
of a session it took up from the desk, not for a thread started on the phone or a fork.
Used in turn, the two do not collide: when a Pi at the desk has written a thread's
session and quit, the bridge starts Pi again for the thread's next message, so Pi
answers it with what was said at the desk in mind. That part of the conversation shows
on the phone only after the bridge restarts, since the bridge reads a session's history
once.

### Cursor

Cursor here is Cursor's command-line agent, `cursor-agent`, run through its Agent Client
Protocol mode (`cursor-agent acp`) with your own Cursor settings and sign-in. Each
thread is one Cursor session, and the thread id is that session's id. The bridge was
tested with cursor-agent 2026.10.22; it logs a warning for another version at startup,
and again when a process starts on a release it has not seen yet (Cursor's command
updates itself when you use it in a terminal).

How it runs Cursor:

- **One process per folder.** `cursor-agent acp` is started in a thread's folder when a
  thread there first needs it, and the threads in that folder share it; another folder
  gets its own. Cursor reads the project's rules, skills and MCP servers from where it
  starts. A process stops after `cursor.idleMinutes` with nothing running or waiting,
  and with the bridge; the next message starts it again and has it load the session.
- **Your own settings.** Whether Cursor asks before a command or an edit is Cursor's own
  setting (its allowlist and approval mode). The bridge starts it plainly, never with
  `--force`, and gives it no MCP servers of its own.
- **Its sign-in.** `cursor-agent login`, in a terminal. A Cursor that is not signed in
  says so in the thread, with that command; the bridge never signs in for you.
- **The conversation the app shows is the bridge's**, kept in `state/cursor/threads/`,
  so opening an old thread starts nothing. It is written as the turn goes, so a bridge
  that is killed mid-turn keeps the message and the rows up to then. Cursor itself goes
  on with a turn when the bridge is killed under it, so the bridge notes each Cursor
  process it starts (`state/cursor/processes.json`); when it next starts it stops the
  ones a killed bridge left running, and such a thread shows its turn as stopped. When
  Cursor no
  longer has a thread's session (it keeps none for a thread that never got a message),
  the thread gets a new session at its next message and keeps its id; a notice says so
  when there was a conversation.
- **Turns.** A message sent while Cursor works waits in the bridge and is sent when the
  turn has ended (`queued`): Cursor cannot take one into a running turn, and a second
  prompt would cancel the first. Cursor reads JPEG, PNG, GIF and WebP images.
- **The `portals` command.** Cursor has no place for a client's instructions, so a
  thread's first message carries the few lines on `portals` as a note beside your words
  (with `fleet.tellAgents` on). Your message is sent as you wrote it.

What the app sees:

| Cursor | In the app |
|---|---|
| Text and thinking | The reply and its reasoning row, word by word |
| A command | Terminal row: the command, its output, its exit code |
| Read · Edit · Delete | Read · Edit (with a diff) · Delete rows |
| Grep, glob, list a folder, codebase search · Web search · Fetch · Task · Generate image | Search · Web search · Read page · Delegate · Image rows; MCP tools keep their names |
| Its to-do list, and a plan's steps | To-do row, always with the whole list |
| A permission request | An approval card: once, always, deny |
| A question (`cursor/ask_question`) | A question card. Cursor takes only its own options back, so an answer typed in your own words goes back as the question skipped, with your words as the reason, which the model reads |
| A plan (`cursor/create_plan`) | A plan card: Start, Keep planning |
| The model changing its mode by itself | A row, "Switch Mode: agent" |
| Cursor's name for the session | The thread's title, after the first line of the first message; a title you give stays |

**Stop** ends Cursor's turn. It does not always end a command Cursor started: Cursor
runs each command in a process group of its own and gives no process id for it, and a
stop in a command's first seconds misses it. Such a command runs to its end on the Mac,
and its row says it may ("Stopped. The command may still be running on the Mac"). A
command Cursor was still asking about never ran, and its row says only that it was
stopped. A command also outlives Cursor's process, when that stops for being idle, dies, or the
bridge restarts. A subagent does not: it runs inside Cursor's process and ends with it.

**`always` on an approval card is Cursor's own.** It adds the command, path or domain to
the allowlist in Cursor's settings, so `cursor-agent` in your terminal stops asking for
it too.

Models are the ones Cursor lists, each under Cursor's name for it, and the slider offers
each the thinking levels Cursor lists for it. The list is kept in
`state/cursor/agent.json`; until Cursor has run once, only `default` is there. `default`
("Cursor's own") leaves the choice to Cursor: the thread runs on whatever model Cursor
is set to, and the bridge sets nothing. Cursor's Auto is `auto`. A level chosen for a
thread on `default`, or for a model with no levels, is refused with a sentence (the app
shows the slider for them all the same).

**A model you choose is selected in Cursor itself.** In Cursor the model is not a
session's but Cursor's own setting, so choosing one for a thread does what `/model` in
the terminal does: Cursor writes it to its settings (`~/.cursor/cli-config.json`), and
your other Cursor threads on `default`, and `cursor-agent` in the terminal, are on it
from then on. A thinking level is kept the same way, per model. A thread with a model
of its own selects it again before each of its turns. A thread on `default` sets
nothing, and runs on whatever Cursor is on then. (Cursor's own code goes back to the
model a session last ran on when it loads an old session again; the one time this was
looked at, on 2026-10-12, it stayed on the model it was set to.)

#### `/mode`

| Command | Cursor's mode | The thread then |
|---|---|---|
| `/mode` | | says its mode |
| `/mode default` | `agent` | follows your Cursor settings |
| `/mode plan` | `plan` | plans first, and asks before carrying the plan out |
| `/mode ask` | `ask` | is in Cursor's Ask mode, for reading and answering: Cursor is told to edit no files and run no commands |
| `/mode full`, `/mode edits` | | refused: Cursor has no such mode |

None of Cursor's modes is about how much it asks before acting; that is set in Cursor
itself. So "Ask first" in the app is Cursor's Ask mode here, which only reads. The mode
is kept per thread and sent to Cursor before every turn; one chosen while a turn runs
counts from the thread's next message. If Cursor does not take the mode, the turn fails
and the message is not sent, so nothing runs in another mode than the thread shows.

**Plan and Ask are not locks.** Cursor lets the model leave either mode with a tool of
its own, without asking anyone and without telling the bridge. The thread shows the row
"Switch Mode: agent", the rest of that turn runs in the other mode, and the thread's
next message is sent in its own mode again.

**Start on a plan card sends Cursor a go-ahead.** Cursor ends its turn once a plan is
accepted and waits for a message, so Start alone would start nothing. The bridge
accepts the plan, takes the thread out of plan mode and sends "Go ahead with the plan."
in the same turn; the words are not shown as a message of yours. Keep planning sends
the plan back with what you typed, and Cursor plans again.

#### Other commands

`/status` shows the thread's agent, folder, its git branch, model and mode. Cursor's own slash commands
are offered too, as Cursor last listed them (it does once a session has started), and
are sent to Cursor as a message. Its `copy-request-id` is left out: it writes the Mac's
clipboard.

#### What Cursor keeps on the Mac

All of it is Cursor's own, written by Cursor. The bridge never reads or writes these.

| Where | What |
|---|---|
| `~/.cursor/acp-sessions/<session id>/` | Each thread's session. Nothing deletes one, also not removing the thread in the app, so they add up |
| `~/.cursor/cli-config.json` | Cursor's settings: the selected model and each model's level (changed by a model or level chosen in the app), and the allowlist (added to by `always`) |
| `~/.cursor/plans/` | A plan accepted with Start, beside the terminal's plans |
| `~/.cursor/projects/<folder>/` | For every folder a thread ran in: Cursor's index of it, and under `assets/` each image sent |
| `~/.cursor/acp-config.json`, `~/.cursor/ai-tracking/` | Rewritten when a model is set; added to when Cursor edits a file |

Cursor indexes every folder a thread is started in and syncs its file tree with
Cursor's servers, as it does for a folder you open at the desk. That is Cursor's own
doing, under Cursor's own settings.

#### What is not there

Cursor's interface has nothing for these, so the bridge goes without:

- **The context meter.** Cursor reports no token or context use.
- **Compaction.** Cursor summarises a long session by itself and says nothing of it: no
  mark in the thread, no `/compact`.
- **A message into a running turn.** It waits for the turn to end.
- **Sessions from the desk, either way.** Cursor keeps the sessions the bridge makes
  apart from the terminal's (`~/.cursor/chats/`), and neither side opens the other's:
  the terminal's sessions are not offered in the app, and a phone thread cannot be
  continued in the terminal. (A Cursor thread removed in the app is offered again under
  From this Mac, and taken up with its conversation.)
- **Renaming and deleting at Cursor.** A title given in the app is the bridge's;
  Cursor's own list keeps its own name, and every session ever made.
- **Ending a command Cursor started** (above).
- **Failed turns told as such.** Cursor ends a turn it could not finish (no network, a
  model error, a plan limit) as complete, with an "Error: …" line or "Upgrade your plan
  to continue" as its text. Only "Please sign in to continue" is read as a failure.

Left out by choice:

- **Background subagents.** Cursor can leave a subagent working after a turn ends. The
  bridge does not follow it: the thread shows at rest (with a notice, when the bridge
  sees a subagent being left), and the subagent ends when Cursor's process stops, which
  an idle one does after `cursor.idleMinutes`.
- **Cursor's own recent folders** for new threads. A folder is offered once another
  agent worked there or you added it in the app.
- **Cursor's other model settings** (`fast`, the context size): left as Cursor has them.
- **`/mode full` and `/mode edits`**: Cursor has nothing they could mean.
- **Other agents that speak the same protocol** (OpenCode and the like): only Cursor is
  run this way.

### Droid

Droid uses the installed CLI through the official `@factory/droid-sdk` (pinned to
0.10.0, protocol 1.269.0; 0.9.1 refused newer Droid's Script approvals and pick lists
before the bridge saw them), with your existing Factory login and settings. The bridge
was tested with CLI 1.0.0 and 1.3.0. Setup only discovers the executable and probes its version;
it neither installs/upgrades Droid nor signs in or
copies credentials. Bridge-launched processes disable automatic updates with
`FACTORY_DROID_AUTO_UPDATE_ENABLED=false`. Startup does not change global Droid settings.

The bridge automatically detects `~/.local/bin/droid`, the bridge's PATH, and common
Node/Homebrew install locations. Set `droid.path` for another location, or
`providers.droid: false` to disable it. New Droid
threads use General or another folder already offered by Portals, with the Factory logo.

Core support includes multi-turn chat with streamed text, available reasoning and
live tool output; model and supported reasoning-level selection; images and attached-file
paths; questions; stopping the current turn; and resuming Portals-created conversations
after idle shutdown or bridge restart. An interrupted turn does not keep running across
a bridge restart.

The app's modes have these Droid-specific meanings:

| Mode | Droid behavior |
|---|---|
| Off | Actions needing permission are offered for approval |
| Low | Safe edits **and low-risk commands** may run without asking; this is not edits-only |
| Medium | Reversible development actions may run without asking; Droid can still ask for approval |
| High | High-risk actions may run without asking, subject to safety rules; **not** unsafe permission bypass |
| Spec | Read-only planning until you approve a plan, then execution continues in the same or a new session, as offered |
| Default | Inherits the Droid CLI's configured autonomy and interaction mode |

The bridge never enables Droid's unsafe permission bypass. Your installed Droid's
settings and policy still apply. Approve only actions and plans you intend to allow.
Cards show the choices Droid actually offers, their scope, edit diffs and safety
details. Persistent grants and starting a new session require explicit confirmation.
Spec plans can be edited before approval; a separate Spec model and reasoning level
can be set for the thread without changing global settings.

- **Live activity:** thinking, tool work, approval waits and compaction status; terminal
  output, structured TodoWrite checklists, turn usage, and retry/hook/MCP notices.
  Live output keeps the last 8 KiB and 200 lines, updated at most four times per second
  per tool; completion keeps the full final result.
- **Context:** an estimated context meter, `/context` for its breakdown, and
  `/compact [instructions]` with the displayed history kept across the session swap.
- **Messages while working:** Steer is picked up at the next model step, not midway
  through a tool. Queue stays on disk until it starts a separate turn. Attachments
  that cannot be steered wait in Queue; unconfirmed delivery is never replayed blindly.
- **Commands:** `/cost` shows observed session tokens and Factory credits, not your
  account balance; `/rename` updates both titles. `/model` and `/new` use the app's
  picker and new-thread screen. The menu includes supported Markdown commands from
  `~/.factory/commands` and the thread's `.factory/commands`, with project commands taking precedence.
  Opening the menu never starts a Droid process.
  `$ARGUMENTS` expands literally, without shell evaluation. Script commands are not run.
- **Skills and MCP:** `/skills`, `/mcp` and `/mcp tools [server]` list only display
  metadata, never skill contents, file paths, MCP configuration or auth fields.
  `/skills on|off <name>`, `/mcp on|off <server>` and
  `/mcp tool on|off <server> <tool>` first explain that the change affects Droid
  everywhere: every thread, the CLI and the desktop app. Nothing is written until
  the exact command is sent again with `confirm`, within five minutes. Successful
  changes name the user settings file written (`~/.factory/settings.json` for
  skills, `~/.factory/mcp.json` for MCP). Managed and non-user MCP configurations
  must be changed in Droid itself. Quote names containing spaces. Startup never
  changes global settings; only these explicitly confirmed commands do.
- **MCP sign-in:** feature `mcp_auth` exposes live cards through `mcp.auth`.
  Sign-in is explicit; the app shows the server and destination host before
  opening a validated HTTPS link. Paste a bare code or final browser redirect
  URL if the host's localhost callback cannot be reached; a callback on the host
  completes automatically. Codes and SDK state stay out of prompts, history,
  replay, push and debug output. Cards and URLs live only in memory; the event is
  an empty invalidation. Cancel, process loss and a ten-minute deadline clear
  live secrets. While signing in, the process stays warm. SDK raw wire logging
  is disabled for bridge-owned Droid transports, even if requested in the parent
  environment, since it would otherwise write authentication material.
- **Subagents:** real child identities, running/finished state and final reports, with
  nested tool progress when Droid supplies it. Finished snapshots survive reopening.
  There is no individual subagent stop control: in CLI 1.0.0 `kill_worker_session` is
  for Mission workers, interrupts the parent of an ordinary Task and leaves that Task
  running (see `docs/plans/2026-10-29-droid-subagent-stop.md`). Nested progress has scripted test
  coverage but has not yet been observed in live checks.

Each active thread has its own Droid session/process. The bridge stores the session
identity and the conversation shown in the app under `state/droid/`, while Droid keeps
the actual execution context. Stored history can be shown without starting every
process; the next message resumes the same Droid session. Missing session context is
reported rather than silently starting a fresh conversation. Thread titles use the
existing first-message fallback, without extra title-generation calls.

Tracked background commands and subagents keep the process warm until their actual
completion and automatic parent follow-up finish, or an hour passes without activity.
At that bound tracking ends without claiming success, and the process may cool. Final
command output replaces its launch row. Process loss marks unfinished subagents stopped,
without claiming a successful outcome. Droid answers a finished background task or
command in a turn it begins by itself; the bridge shows that turn like any other, opened
by a line saying what finished (`Agent "…" finished`), and keeps it in the thread. A
steering message Droid takes only after the turn it was sent in has ended, it also runs
as a turn of its own: that turn opens with the message, which joins it as steered (or
stays shown failed, if Portals had already failed it). What Droid says once its turn for
a message is over, while that turn still closes in Portals, is told as a turn of its own
after it. A message sent meanwhile waits for it.

A confirmed new-session Spec handoff defers reopening while implementation background
work remains tracked. With the tested CLI 0.245.0 and SDK 0.9.1, post-handoff completions
appear in the target CLI history but are not forwarded on the original connection.
Portals may therefore keep tracking until the one-hour inactivity bound or a new
message. A new message reopens the saved target and ends that tracking, without claiming
the work stopped: it may already have finished.

The SDK's transitive `uuid` is overridden to 11.1.1 for its buffer-bounds security fix;
the SDK only uses its unchanged `v4()` API. This applies when the bridge is the npm
root, including the runtime installed by setup. npm ignores a dependency's overrides,
so the initial npx launcher can still install the SDK's deprecated UUID 9 and warn
before setup runs. SDK 0.10.0 still declares UUID 9; upgrading to it does not fix that
install path. Avoid overriding unrelated packages or vendoring the SDK just to hide
the warning.

Direct dependencies remain exact pins. Zod's 4.6.5 pin had no special compatibility
constraint; 4.6.7 fixes validation work on oversized constrained collections. The SDK
still requires Zod 3 (currently 3.25.76), which has the same unresolved audit advisory.
It is not forced to Zod 4 across that major-version boundary. Audit findings describe
dependency risk, not a demonstrated unauthenticated bridge exploit.

Not included yet: desktop session adoption, fork, rewind, skills/MCP management, model-based
image gating or native SDK file attachments. Missions remain out of scope. Automatic
parent replies outside a submitted turn are not imported into the transcript; child
reports and background command output are shown in their own cards.

### Hermes

Each Hermes profile is an agent: the default profile is `hermes`, the others keep their
names (`hermes-<name>` if Claude Code, Codex, Pi or Cursor already has it). Each thread
is one Hermes session, and the thread id is Hermes's stored session id. Hermes speaks the
protocol the bridge speaks to the app, so its turns, tools, approvals, questions and
stored conversations come through as Hermes sends them; Hermes's own approval reviewer
settles most commands, and only what it puts to the user reaches the phone.

**One backend.** Hermes runs one `hermes serve` per user for all its profiles, and
says where in `~/.local/state/hermes/gateway-locks/host-serve.json`, with its session
token beside it. The bridge joins that one over its WebSocket, as Hermes's own apps do,
so a `hermes serve` or `hermes dashboard` started by hand is the same backend. When none
runs, the bridge starts `hermes serve` in a process group of its own (output in
`hermes-serve.log` in the bridge's folder), and leaves it running: turns go on while the
bridge restarts. Hermes stops a turn whose client has been gone for 20 seconds; the
bridge is back well before. The profiles Hermes listed last are kept in
`state/hermes.json`, so after a restart the agents are there before Hermes answers.
The bridge was tested with Hermes 0.22.5; at startup it logs a warning for another
release (`hermes --version`), and counts a build past a release (`v0.22.5+12.g1a2b3c4`)
as newer.

Setup finds Hermes and, when it is running, asks it whether it can run a turn (Hermes
needs an AI provider and model: `hermes setup model` sets them). When Hermes is missing,
setup offers its installer (`curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`),
which ends with Hermes's own setup. Run setup again after installing Hermes later; the
bridge also offers it on its next start once it is installed.

### OpenCode

OpenCode 2 is one agent, `opencode`, run through OpenCode's own HTTP API with its client
(`@opencode/client`, pinned to the version tested, an optional peer dependency the bridge
loads only when OpenCode is used: it brings Effect, about 66 MB). Each thread is one
OpenCode session, and the thread id is OpenCode's session id. A turn is OpenCode's
execution: it begins with `session.execution.started` and ends with exactly one of
`succeeded`, `failed` or `interrupted`, whoever sent the message, so a turn sent from
OpenCode's terminal on the same server shows on the phone too
(`src/providers/opencode/`; the plan behind it is in `docs/providers-plan.md`).

**One server.** OpenCode 2 runs one background service per user, which its terminal,
desktop and web apps share, and says where in `$XDG_STATE_HOME/opencode/service.json`
(`~/.local/state/opencode/service.json`), with a password. In `shared` mode (the default)
the bridge joins it, and starts it (`opencode serve --service`) when none runs and
`opencode.start` is not `false`, leaving it running. It reads registration and probes
the native client directly, never calls the destructive `Service.ensure`, and joins
healthy 2.x services across patch versions. An unhealthy or occupied shared service is
never replaced or stopped; the bridge falls back to own. OpenCode 1 is refused before
launch or join (`opencode upgrade --major`). The bridge logs the version it reached,
with a minimum of 2.2.0 and a warning for one it was not tested with (`testedOpenCodeVersion`,
`src/providers/opencode/options.ts`). In `own` mode, or
when the service cannot be had, the bridge runs `opencode serve --hostname 127.0.0.1
--port 0` with a password it makes (`OPENCODE_PASSWORD`), its output in
`opencode-serve.log` in the bridge's folder. A private `<logPath>.server.json`
(mode 0600) lets a restarted bridge reclaim its verified orphan, including the stable
native server identity. Normal close first interrupts every active native root and
child, with one four-second settlement deadline, then awaits bounded TERM and KILL of
the whole owned process group. The optional provider stop deadline gives only a live
owned process sixteen seconds of signal grace, otherwise the usual eight seconds.
Uncertain ownership fails visibly and names the record and `.lock`
files: stop the bridge, check the recorded process, then remove only stale files,
never live ownership records. Both share
OpenCode's one store of sessions, so a thread is the same session either way.

**Shutdown notes stay in the bridge.** `stopNotes.ts` keeps an atomic mode-0600
`<logPath>.stops.json` ledger of IDs, flags and timestamps. It holds at most four
records and 256 KiB; each record has up to 256 settled IDs, 256 unsettled IDs and
512 shown thread IDs, with 160-byte IDs and a 24-hour expiry. Overflow makes native
inventory explicitly unknown, never implicitly settled. Closed views retain at most
256 owned routing targets until provider close, so settlement can end their generic
turn records after `SessionManager` closes them. On the next resume, fresh native
activity/history and a bounded nested-child inventory decide whether to show an
interrupted note, an actual resumed-after-stop notice, or the may-resume warning.
Each stop retains at most 256 native execution references: session, opener,
assistant and terminal message IDs, not message content. The opener/assistant
snapshot precedes interruption, with a best-effort 150 ms budget inside the
four-second deadline. Settled annotations are anchored to that exact terminal ID,
even if later turns exist. A resumed claim requires the recorded aborted
assistant's immediately adjacent native `synthetic` message with
`metadata.notice === "restart"`, with no intervening user/manual opener or idle.
Old provenance-free records can only warn, and a later unrelated opener retires
the stale warning. Child execution histories are read only for bounded retained
provenance, not for every descendant.
Root and descendant outcomes are classified independently. The overlay keeps the
root on its own line and summarizes descendants by count, for example
`2 subagents stopped; 1 was resumed by OpenCode`. A root terminal never hides a
verified descendant restart, and a descendant's exact terminal is not downgraded
to an unconfirmed warning.
Each is a clearly Portals-labelled gateway history overlay, consumed once per thread;
it never modifies OpenCode history, messages or model context. A broken nested lookup
keeps the root readable and marks the note's inventory uncertain.

**One event stream** (`GET /api/event`) for every thread. It keeps nothing for a client
that was away, so when it comes back each open thread catches up from what OpenCode
keeps: native user/assistant/idle message groups, activity, inbox receipts and requests.
One generation-owned turn serializes admission, Stop and snapshots. A reconnect buffers
frames until authoritative history is applied; delayed deltas for snapshot-covered
`(assistantMessageID, kind, ordinal)` pieces refresh only those pieces. New pieces,
steps and tools still stream live. Terminal frames force a history barrier so they
cannot end a turn before its missing text or reopen one already ended by the snapshot.
Completed desk turns missed entirely offline are replayed once. No outcome after a
server crash is an explicit interrupted/error result, never empty success. Idle
attachments also restore permissions and forms; cards answered elsewhere close.
Recovery runs on every writable attachment and reconnect, regardless of server identity
or orphan-reclaim metadata. Held frames are bounded by 1,024 entries and 1 MiB of
UTF-8 JSON; overflow requires a newer full snapshot, not lossy replay. Failed reads
keep recovery pending and retry with capped backoff, warning after three failures.
Confirmed native session deletion ends the turn with a non-retryable message.

**Permissions are the user's.** OpenCode's own config decides what runs without asking;
the app's modes set nothing. A `permission.asked` becomes an approval card with
OpenCode's three answers: `once`, `always`, which saves a rule for the project (the
request's `save` patterns) that holds in every session there until it is removed in
OpenCode, and `reject`, which also turns down the session's other waiting requests and
tells the model the note, if any. A request answered in OpenCode's terminal
(`permission.replied`) closes the card.

Tools map to the gateway's names (`shell` → `terminal`, `write` → `write_file`, `edit` →
`patch`, `read`, `grep`/`glob`, `webfetch`, `websearch`, `subagent` → `delegate_task`);
an edit's diff is OpenCode's own (`files[].patch`, its `Index:` headers made into a
unified diff), else one made from the tool's input. Images go inline as `data:` URIs.
Models are OpenCode's enabled ones, grouped by native provider. Gateway model IDs are
provider-qualified opaque strings, with native names and provider-specific levels;
raw IDs are restored before native API calls. Typed raw names require an explicit or
current provider when ambiguous. The thinking level is the model's variant (`default`
is none of its own). The context ring totals input, output, reasoning and cache tokens.

Native inbox steering uses stable IDs and delivery receipts, including late receipts
after successful no-op cancellation. Explicit Queue placement stays bridge-local until
the turn ends. Unresolved steering payloads are bounded by 128 receipts and 32 MiB,
including image bytes. At capacity, a known-unsent prompt stays in the normal bridge
queue until the turn ends; settled receipts free capacity for later steering.
Native forms become typed question cards; unsupported conditional,
hidden or external fields require OpenCode's UI. Native primary agents implement
`/mode` and `/agent`; slash commands and `/compact` use their own APIs. Usage shows
only native Console windows/budgets. Child sessions supply subagent rows and their own
questions; desk sessions support read/continue/fork, with no read-only mutations.

OpenCode 2.2.5's `session.environment` replaces the entire shell environment, not just
the supplied keys; there is no native environment getter to merge with a shared
service's environment. The bridge therefore supplies its complete environment in
both server modes, retaining HOME, USER, SHELL, XDG settings, custom variables, provider
credentials and `PORTALS_BRIDGE_HOME`/`PORTALS_BRIDGE_LOG`. It removes exactly
`OPENCODE_PASSWORD`, `PORTALS_PASSWORD` and `AERIPORTAL_PASSWORD` (transport/setup
passwords), prepends the command's PATH and sets `PORTALS_THREAD`, clearing competing
thread identities. Writable creation and resume await this preparation before returning. Each new
connection prepares loaded writable roots again before recovery or another admission;
per-connection promises share the work and failed preparation is retryable. Previously
discovered children are restored best effort, without preparing read-only adoptions.
Child commands address their bridge-owned root. Child preparation is asynchronous
and best-effort after discovery: the native client offers no pre-first-shell hook,
so a child's first shell may run before its environment and instructions are installed.
`experimental.session.instructions.entry` stores the same `commandAccess` text in one
idempotent `portals` entry, without replacing user entries. Failure warns once and
leaves the command environment usable. A missing client is repaired with
`npx portals-host@latest update` or `setup`.

OpenCode parity uses `todowrite` for to-do cards, per-assistant step identities for
turn token totals and context updates, and `metadata.shellID` for cursor-based shell
output polling through `LiveOutput`. Only an active tool's explicitly named shell is
polled. No location-wide shell is inferred to belong to a thread, so background shell
rows are omitted. Stored user images use the existing attachment-marker convention.
MCP status is read for the thread's folder; recent project folders refresh in the
background. These use existing protocol events and need no new app capability.

## Counters

To see what the bridge costs (calls and bytes from your devices and other Macs, file
writes, memory, CPU, child processes), turn its counters on in `config.json` and restart
the bridge:

```json
"counters": { "enabled": true }
```

Once a minute it then appends one line of JSON to `counters.log` in the bridge's folder
(`~/Library/Application Support/portals-bridge/counters.log`; the bridge's log says
where as they turn on). The lines hold **counts, sizes and timings only**: never a title, a
message, a reply, a folder, a file's name, an account or a Mac's name. At 5 MB the file
becomes `counters.log.1`, replacing the one before, and a new one starts, so the two
never hold more than 10 MB, about a week. Both are readable by you alone (mode 0600).

A bridge started with the counters on reads the switch again every minute: set
`enabled` to `false` to stop them and to `true` to start them again, with no restart. A
bridge started with them off has nothing of them running, and takes a restart to turn
them on. A `counters` value that cannot be used counts as off; the bridge's log says so.

```sh
cd ~/Library/Application\ Support/portals-bridge
tail -n 5 counters.log                    # the last five minutes
# The last hour's polls from your devices (a line that is not whole is skipped):
tail -n 60 counters.log | jq -R 'fromjson?' | jq -s 'map(.rpc["sessions.activity"].n // 0) | add'
# Memory and loaded threads, minute by minute:
tail -n 60 counters.log | jq -R 'fromjson?' | jq -c '[.t, .proc.rss, .now.loaded]'
```

Each line covers the time since the line before. A number that is 0 is left out, and so
is a part with nothing in it. Times are milliseconds and memory is megabytes.

| In a line | What |
|---|---|
| `t`, `s`, `up` | When it was written, the seconds it covers, and the seconds since the bridge started |
| `late` | 1 when the line covers far more than a minute: the Mac slept |
| `dropped` | Lines that could not be written before this one |
| `tick_ms` | What writing the line before cost the bridge's own process (the `ps` for `kids` is a process of its own, and its CPU time is in no line) |
| `proc` | The bridge's own process: `rss`, `heap` and `ext` memory now, `cpu_user` and `cpu_sys` used in the period, and `loop_max`, how late a one-second timer ran at worst (long stalls only) |
| `kids` | The processes the bridge started and theirs (`n`), with their memory (`rss`), as of the line before, and how long the answer of the `ps` that listed them took to come (`ps_ms`: by the clock, so longer when the bridge was busy; not the `ps`'s CPU time) |
| `now` | How many there are now: connections (`conns`), loaded threads (`loaded`), `threads` on the list and `removed` from it, the list's `revision`, pending waits (`waiters`), Claude sessions tracked and processes kept warm |
| `conn` | Connections `opened` (`net`: through the port; `local`: the `portals` command) and `closed` (`app`: a device; `link`: another Mac; `local`) |
| `rpc` | For each method called: `n` calls, total `ms` and the longest (`max`), `wait_ms` for calls that wait for a thread on purpose, bytes `in` and `out`, the largest answer (`out_max`), errors (`err`). A method the bridge does not have is `other` |
| `rpc_by` | The same calls and bytes by who called: `app`, `link`, `local` |
| `out` | Every frame sent, by kind: `ready` (the first on each connection), `answers`, `events`, `asks` (approvals and questions), with their bytes and the most a socket had waiting |
| `emit` | Events threads gave out, and the time to hand them to the devices following |
| `turns`, `threads` | Turns `started` and `ended`; threads `added` to the list and `removed` from it |
| `changes` | Answers to a device asking what changed in the list: `empty`, `delta`, `full`, and the `threads` they listed |
| `files` | Whole-file writes (`w`, `w_bytes`, `w_ms`, the longest `w_max`) and reads (`r`, `r_bytes`, `r_ms`; a file that is not JSON was read all the same) of the bridge's state files, by file: `threads`, `removed`, `push`, `folders`, `links`, `config`, `setup`, `hermes`, `fake`, `other` |
| `load` | Threads loaded from disk, by kind of agent, with their time |
| `links` | Calls to each linked Mac, by its place among the links: the net's other Macs in the net's order, then those of `links.json` (`0` is the first): `n`, `ms`, `max`, `wait_ms`, bytes `out` (what was sent or tried, also by a call that failed) and `in`, `err`, and `signins` (sign-ins tried) |
| `http` | HTTP requests by route (`login`, `ticket`, `status`, `push`, `other`), with the bytes of their bodies |
| `spawn` | Processes the bridge started to do an agent's work or to look at processes: `claude`, `claude_cli`, `codex`, `pi` (a thread's, and the short-lived one asked for its models), `cursor` (a folder's), `hermes`, `ps`. Not counted: each agent's `--version` check as the bridge starts |
| `codex_folders`, `claude_checks` | Codex asked where its threads ran (`rows` is how many it listed), and Claude Code asked for its models and commands |
| `log` | Lines and bytes the bridge wrote to its own log |

Bytes are the messages themselves: headers, WebSocket framing and encryption are not in
them.

## Experimental client feature

Clients that explicitly negotiate `lean_deltas` through `client.capabilities` can
receive compact live text and reasoning frames. PortalsKit opts in only when the bridge
advertises the feature and expands the frames into its existing events. Replay and
reconnect keep the same canonical events and sequence numbers. A malformed compact frame
closes the connection for replay and disables the opt-in for that host until the app exits.
See [the protocol](../docs/gateway-protocol.md#lean-deltas) for the format and opt-in boundary.

## Known limits

- A thread an agent starts with `portals` is not in the app's list, and sends no
  notification, until the app lists the bridge's threads itself. The agent that started
  it has to tell you when it is blocked.
- A message a Codex or Cursor thread sends with `portals` does not name the thread it
  came from: each runs one process for several threads, so the bridge cannot tell them
  apart. Hermes agents are not told of the command.
- A Claude Code thread started before the bridge had the command learns of it only once
  its conversation is compacted: Claude Code keeps a session's first instructions.
- A Claude Code session continued from the phone and then opened at the desk while its
  process on the bridge is still warm (up to `idleMinutes`) is written to from both
  sides; the check against open terminals runs only when the bridge starts Claude.
- Codex asks its questions (`request_user_input`) only in its own plan collaboration
  mode, which the bridge does not turn on; `/mode plan` is a read-only sandbox.
- Restarting the bridge (`update` does) stops Claude's processes, and with them any
  background work. The next message resumes the session, and Claude is told what did
  not finish.
- Stop on the phone interrupts the turn and also stops Claude's background work: the
  bridge does not declare `perTaskStopAffordance`, as the app has no control to stop
  one task.
- A message sent mid-turn and then interrupted may still be answered by Claude after
  the interrupt; that answer is not shown live.
- Pi threads never ask before a command or an edit ([Pi](#pi)), and have no `/mode`.
- Whether a terminal has a Pi session open is judged by folder, since Pi does not say.
  A Pi left open in a project keeps every Pi session of that project from being
  continued (fork one instead). Not seen: a Pi started in another folder that opened
  the session through `/resume`'s list of all sessions, and a Pi another program runs
  with no terminal (a second bridge on the same Mac lists this bridge's Pi threads
  among its sessions from the desk). And a thread started on the phone, or a fork, is
  never checked: `pi --continue` at the desk opens the folder's newest session, which
  may be that thread, and the phone then writes behind it.
- A fork of a Pi session that fails after Pi has written the copy (Pi did not answer in
  time) leaves the copy's file under `~/.pi/agent/sessions/`. The app does not list it;
  `pi --resume` at the desk does, under the original's name.
- Restarting the bridge stops Pi's processes, and a Pi turn that was running is cut
  where it was. The next message goes on from what Pi had written to its session file.
- A Pi process that is killed, or that crashes, leaves a command it was running behind:
  Pi ends its commands only when it exits in order. The thread says a command may still
  be running. A Pi the bridge stops (Stop that Pi does not obey within 15 seconds, an
  idle thread, a removed one) does end them.
- An idle Pi process is stopped after `pi.idleMinutes` even while one of its extensions
  still runs something in the background (pi-subagents' background runs): Pi does not
  say that such work exists. A longer `pi.idleMinutes` is the only handle.
- A project's own `.pi/APPEND_SYSTEM.md` is not part of a Pi thread's system prompt
  while Pi threads are told of the `portals` command (`fleet.tellAgents`, the default);
  your own `~/.pi/agent/APPEND_SYSTEM.md` is.
- After a restart of the bridge a Pi thread shows neither an extension's command nor its
  answer, a `/compact` shows only its mark, and a prompt template shows as the text Pi
  expanded it to: Pi's session file keeps no more.
- Pi's `sessionDir` setting, which keeps its sessions elsewhere, is not followed: such
  a thread works, and has no history after a restart of the bridge. (The variable
  `PI_CODING_AGENT_SESSION_DIR` is followed when the bridge itself runs with it: its Pi
  threads are then kept in that folder, and read from there.)
- Restarting the bridge stops Cursor's processes too. A Cursor turn in progress ends
  interrupted, with what was said so far kept; a subagent ends; a command Cursor started
  runs on.
- Stop on a Cursor thread does not always end a command Cursor started, a model chosen
  for a Cursor thread is selected in Cursor itself, and Cursor's Plan and Ask modes are
  not locks: see [Cursor](#cursor).
- Cursor's question card was built from Cursor's own code and never seen from the real
  agent: in every try the model said it had no question tool and asked in its reply.
  Nor was a permission request for a command or an edit: with the settings it was tried
  on, Cursor asked only before a web search.
- The app offers all five modes and every thinking level for Cursor, though Cursor has
  three modes and some models have no levels: the ones it has not are refused with a
  sentence.
- A Hermes profile that is itself called `pi` loses that name to Pi when Pi is turned
  on. The profile is offered as `hermes-pi` from the second restart on, and the threads
  it already had, kept under `pi`, open as empty Pi threads: nothing moves them yet.
  Leave Pi off on a bridge with such a profile. A profile called `cursor` loses its name
  to Cursor the same way, on a Mac that has `cursor-agent`: turn Cursor off there
  (`providers.cursor`).
- Hermes threads through the bridge list no Hermes sessions from the desk (Discord, a
  terminal), and offer only those of Hermes's own commands that change none of its
  settings and work outside its own windows (`hermesCommands` in
  `src/providers/hermes/provider.ts`). A skill local to a project is not offered, and
  goes as words when typed: the catalog is asked for the profile. A subagent's own
  transcript (`subagent.tail`) is not shown.
- While a `hermes serve` the bridge started runs, `hermes dashboard` refuses to start
  beside it (one backend per user): stop it with `hermes serve --stop`, or run the
  dashboard with `--isolated`.
- Hermes sends a session's events to the one client that opened it last: a thread also
  opened in another Hermes app (the desktop app, the web dashboard) goes quiet on the
  phone until the bridge opens it again (after a reconnect, or a restart of the bridge).
