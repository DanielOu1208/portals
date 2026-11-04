# portals-host

Portals host runs Claude Code, Codex, Pi, Cursor, Droid and Hermes on your computer, a
Mac or a Linux computer, for **Portals**, the app on iPhone, iPad and Mac for talking to
your agents. You start threads, answer their questions and approve what they want to do
from the app, while the agents work on your computer with your files, your settings and
your logins.

The host listens only on your computer (127.0.0.1). Portals on the same Mac reaches it
directly. Any other device reaches it through [Tailscale](https://tailscale.com), on your
own private network. When a device in your net can't reach it directly, the Portals relay
can carry the connection, sealed end to end so that the relay can't read it.

It was called `portals-bridge` up to 0.1.0, and its folder and its log still go by that
name.

## What you need

- **A Mac** that is awake when you use the app, **or a Linux computer** with systemd and
  glibc (Ubuntu, Debian, Fedora, Arch), on x86_64 or arm64. Not Alpine, and not WSL for
  now. The app calls it a Linux computer.
- **Node 22.18 or later** on that computer, from [nodejs.org](https://nodejs.org). On
  Linux, take it from [nodejs.org/en/download](https://nodejs.org/en/download)
  (NodeSource, nvm or the binaries): the Node that Ubuntu and Debian ship is older.
- **Claude Code, Codex, Pi, Cursor, Droid, Hermes, or any of them** installed on that
  computer:
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
  - Codex: `npm install -g @openai/codex`, then `codex login`
  - Pi: `npm install -g @earendil-works/pi-coding-agent`, then `pi` and `/login`
  - Cursor's command-line agent: `curl https://cursor.com/install -fsS | bash`, then
    `cursor-agent login`
  - Droid: follow the [Factory quickstart](https://docs.factory.ai/cli/getting-started/quickstart),
    then run `droid` in a terminal and use `/login`
  - Hermes: setup offers to install it, or `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`
- **Tailscale on that computer and on your iPhone** (and on any iPad or other Mac you use
  Portals on), signed in to the same account. You don't need it to use Portals only on the
  Mac the host runs on: see [Just this Mac](#just-this-mac). On Linux, get it from
  [tailscale.com/download/linux](https://tailscale.com/download/linux) and connect with
  `sudo tailscale up`. In the [admin console's DNS page](https://login.tailscale.com/admin/dns),
  MagicDNS and HTTPS certificates must be on (they are for most new tailnets).
- **Portals** on your iPhone, iPad or Mac.
- **For Claude Code, your own Claude login** (the one `claude` uses in your terminal), or an
  Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys)); see
  [Claude Code's sign-in](#claude-codes-sign-in).

## Setting up

On the computer the agents are to run on, in a terminal:

```sh
npx portals-host setup
```

Setup checks each thing it needs and says what to do about anything missing. It:

1. finds Claude Code, Codex, Pi, Cursor, Droid and Hermes (and offers to install Hermes), and
   asks how Claude Code should sign in;
2. makes `~/Portals`, the folder new threads start in when you don't pick one;
3. makes a password for the app to sign in with (you never type it);
4. makes your computer reachable from your tailnet at
   `https://<your computer>.<tailnet>.ts.net:<port>`, with `tailscale serve`, after asking.
   If Tailscale isn't installed or connected, or MagicDNS or HTTPS certificates are off, it
   says what to do and waits while you do it;
5. installs the host in its folder and keeps it running, now and at every login, after
   asking: on a Mac with a LaunchAgent, on Linux with a systemd user service;
6. shows a QR code to add your computer in the app ([Adding it to the app](#adding-it-to-the-app)).

Running setup again is safe: it keeps what's there, offers what's missing, and installs
the version you ran it with. Run it again:

- after you install an agent it didn't find: it offers to turn that agent on;
- after you switch Node versions (with nvm, say): what keeps the host running names the
  `node` it was set up with, and `pi.path` the `pi` installed for that Node.

### Just this Mac

Tailscale is the recommended way to set up: it's what lets your iPhone and iPad reach your
agents. If you'll only ever use Portals on the Mac the host runs on, you can go without it.
When setup says Tailscale isn't ready, choose **Use just this Mac without it**, or run
`npx portals-host setup --no-tailscale`. Portals on that Mac then reaches the host at
`http://127.0.0.1:<port>`, and setup gives you a link to add it instead of a QR code.

**To use your iPhone or iPad later, you'll need Tailscale.** Nothing else can reach the host
until then, so Add a portal explains this instead of showing a code, and the host refuses to
join a net with other Macs. Install Tailscale on the Mac and on the device, signed in to the
same account, then run `npx portals-host setup` again. Your threads and settings stay, and
Portals on the Mac moves to the new address by itself. Until then the host keeps no
connection to the Portals relay, since nothing could come through it.

### On a Mac

macOS may say a background item was added (`node`): that's the host. Leave it allowed in
System Settings → General → Login Items.

### On Linux

- **Run setup from a login of your own** (at the desktop, over SSH, or `su -` with its
  dash): from `sudo -u` there is no systemd manager of yours to run the host.
- **Tailscale's operator.** Linux lets only root, or the user Tailscale names its
  operator, change what it serves. When Tailscale refuses, setup offers to run
  `sudo tailscale set --operator=$USER` once, and asks first.
- **What keeps it running** is a systemd user service, `portals-host.service` in
  `~/.config/systemd/user/`, started again two seconds after it stops.
- **Lingering.** systemd stops a user's services when they log out, and starts them at
  boot only once they log in. On a machine nobody stays logged in to, setup offers to turn
  lingering on (`loginctl enable-linger`, with sudo where polkit doesn't let you), so the
  host keeps running and starts at boot.
- **The agents' logins** are files, not the Keychain: Claude Code's in
  `~/.claude/.credentials.json`. On a machine without a browser, `claude` prints a link
  to open elsewhere and asks for the code it gives; `codex login --device-auth` does the
  same for Codex.
- **Setup can't open Portals** on a Linux computer, as it can on a Mac: scan the code
  with the iPhone, or paste the link under it in Add a host on a Mac or iPad.

### Where it keeps things

| | Mac | Linux |
|---|---|---|
| The host's folder: settings (`config.json`), password, list of threads | `~/Library/Application Support/portals-bridge/` | `~/.local/share/portals-bridge/` (`$XDG_DATA_HOME`) |
| Its log | `~/Library/Logs/portals-bridge.log` | `~/.local/state/portals-bridge.log` (`$XDG_STATE_HOME`) |
| What keeps it running | `~/Library/LaunchAgents/com.danielou.portals.bridge.plist` | `~/.config/systemd/user/portals-host.service` |

`$PORTALS_BRIDGE_HOME` names another folder. On Linux, `systemctl --user status
portals-host` says whether it runs; the host's own output goes to its log, not to the
journal. The agents keep their own conversations where they always do.

### Setup's options

| Option | What it does |
|---|---|
| `--yes` | Takes the default answer to every question |
| `--claude <how>` | How Claude Code signs in, instead of asking: `login`, `api-key` or `off` |
| `--no-tailscale` | Leaves `tailscale serve` alone. On a Mac with no other address, Portals works on [just this Mac](#just-this-mac) |
| `--address <url>` | The address the app uses, if not set up through Tailscale |
| `--port <number>` | The host's port on 127.0.0.1 (a new install only) |
| `--no-service` | Installs without a LaunchAgent or systemd user service: you start the host yourself |

Set `PORTALS_BRIDGE_LABEL` to an unused service label for a separate home; it overrides the label saved in `setup.json`.

### Adding it to the app

Setup ends with a QR code. Scan it with the iPhone's Camera: Portals opens with your
computer filled in. Tap Add, and you're done. On a device that already uses Portals, scan
it with Add a host there instead, or paste the link printed under the code. When Portals
is on the same Mac, setup offers to open it with this Mac filled in, so the Mac app needs
no link copied.

The QR code holds the host's password. Anyone who has it and is on your tailnet can use
your agents on that computer, so keep it to yourself. `npx portals-host pair` shows it
again.

## Claude Code's sign-in

Setup asks how the host should run Claude Code:

- **With your own Claude login** (the first choice): the one `claude` already uses in your
  terminal, so there is nothing to sign in to again. Usage counts against your Claude plan.
- **With an Anthropic API key**, what Anthropic's terms cover most clearly for use
  through another app like this one. The key is kept in the host's settings, readable only by
  you, and given to Claude Code when the host runs it. Usage is billed to the key. Setup
  offers this first when `claude` is not signed in and `ANTHROPIC_API_KEY` is set in the
  terminal.
- **Not at all**, if you don't use Claude Code.

Setup checks the login without the terminal's `ANTHROPIC_API_KEY`, as the host runs
Claude Code: the host never passes on a key from its environment.

To change it later, run setup again with `--claude=login`, `--claude=api-key` or
`--claude=off`. Or edit `claude.apiKey` in `config.json` (a key, or `null` for your own
login) and `providers.claude`, then restart the host ([Every day](#every-day)).

## Every day

| Command | What it does |
|---|---|
| `npx portals-host pair` | Shows the QR code again, to add your computer on another device or after reinstalling the app. On a Mac, offers to open Portals with it, when Portals is there |
| `npx portals-host status` | Whether the host runs, its address, its agents, its General folder and its log, and whether a newer version is out |
| `npx portals-host@latest update` | Installs the newest host and restarts it ([Updating](#updating)) |
| `npx portals-host relay reset` | Only when the app says this host has another host's relay id, which happens when its folder was copied from another computer: gives it a new one, and restarts it |
| `npx portals-host uninstall` | Stops the host and removes it ([Uninstalling](#uninstalling)) |

To restart the host without updating it (after changing its settings, say):

```sh
launchctl kickstart -k gui/$(id -u)/com.danielou.portals.bridge   # on a Mac
systemctl --user restart portals-host                             # on Linux
```

A restart stops Claude Code, Pi, Cursor and Droid turns in progress; Codex's keep going.

### Updating

To update, run `npx portals-host@latest update` on the computer the host runs on, the
same on a Mac and on Linux. It installs the newest version and restarts the host.

You don't have to watch for new versions. The host asks npm's registry for the newest
version of `portals-host` when it starts and about once a day after, never more often,
and reads only the version number. When a newer one is out, the app says so: a small
"Update available" in the sidebar, beside Settings, and on the host's row in Settings →
Hosts, which gives the command to run (the host's own page there has a Copy button for
it). With no network, the check does nothing. To turn it off, set
`"updates": { "check": false }` in `config.json`; it is on unless you do.

## What the agents can do

The agents run as you, in your folders, with your own settings for each of them, so they
can read and change your files and run commands just as they do in your terminal. Each
thread starts in the permission mode your settings give (Claude Code's
`permissions.defaultMode`, Codex's `approval_policy` and `sandbox_mode`). Pick a mode in
the app, or type it in the thread, to change it for that thread; the app shows each
request as a card to approve or deny. For Claude Code and Codex:

| Command | The thread then |
|---|---|
| `/mode` | says its mode |
| `/mode ask` | asks before editing files or running commands |
| `/mode edits` | Claude Code: edits files without asking, asks before running commands. Codex: edits files and runs commands in its folder without asking, asks before going outside it |
| `/mode plan` | Claude Code: plans first, and asks before carrying the plan out. Codex: only reads, and asks before changing anything |
| `/mode full` | edits files and runs commands without asking |
| `/mode default` | follows your own settings for that agent |

Pi, Cursor and Droid differ: see each below.

A thread runs in General (`~/Portals`), in a folder your agents have worked in lately, or
in any folder under your home folder that you add in the app, which finds them as you
type (on a Mac, also from its folder dialog).

### Files you attach

A message can carry files of any kind (a PDF, a spreadsheet, source, an archive), picked
in the app or dragged onto its message field: at most ten a message, 25 MB each. The
host saves each in the thread's folder, under `.portals/files/<thread>/`, and the
message tells the agent where, so any agent reads them with its own tools, without asking
for another folder. A `.gitignore` in `.portals/` keeps them out of git. They
are yours to delete: the host leaves them there, also when the thread is taken off the
list. Images still go to the agent as pictures, for the models that see them.

### Visuals in replies

An agent can put a visual in a reply: a chart, a diagram, a comparison, something to
play with. The app draws it live, as it is written. Claude Code, Codex, Pi, Cursor and
Droid threads are told the app does this (`visuals.tellAgents`). A visual is a visual aid
only: nothing in it reaches the agent or the host. It runs locked down in the app: it can
load scripts, style sheets and fonts from jsDelivr, unpkg and cdnjs, and nothing else from
the network, and a link you tap opens in your browser.

### A message sent while an agent works

One setting in the app (the gear, under Messages) says what it does:

- **Steer** (as it comes): the agent reads the message during the turn it is on. Claude
  Code, Codex and Pi can; Droid takes it at the next model step. Cursor and Hermes
  cannot, and queue it.
- **Queue**: the message waits and starts a turn of its own when the agent is done.

Messages that wait are listed above the message field on every device connected to the
host, where one can be taken off the list or steered in now. They are kept on disk, so a
host that restarts meanwhile still sends them.

### Notifications

The app is notified when an approval or a question card opens, when a turn finishes
(with the first line of the reply) and when one fails. The words are sealed to a key the
app gave the host: Apple and the Portals relay see only "Portals: New activity".

### Sessions from your terminal

Under From this Mac in each coding agent's menu, the app lists the sessions you started
in a terminal on that computer (Claude Code's, Codex's and Pi's), to **continue**, to
**fork** (a new thread with its history so far) or to **view only**. A Claude Code session
a terminal has open is not continued, nor a Pi session while a Pi runs in a terminal in
its folder: quit it there first, or fork. A Codex thread can be worked on from both.

### Claude Code

The host runs your installed `claude` with your own settings, CLAUDE.md files, plugins
and MCP servers, as at the desk. `/status` shows the thread's folder, git branch, model
and mode, and `/usage` your plan's limits. Claude Code's own commands (`/compact`,
`/context`, …) and your skills are offered too; the app's own `/model` and `/reasoning`
change one thread. Background work Claude starts runs on after the turn, and Claude
answers when it ends. Stop, and a restart of the host, end it.

### Codex

The host joins the Codex daemon every Codex on your computer uses, so threads keep
running while the host restarts, and a terminal can work on the same thread. A thread
runs with your `config.toml`; the host never writes it, and what you change in the app
is for that thread only. `/compact` and `/usage` are offered. A new thread is named by a
short call to a cheap model (`codex.titleModel`; `null` for none).

### Pi

**Pi does not ask before it acts.** It has no approvals and no permission modes: it runs
every command and makes every edit its model decides on, at once, and there is no `/mode`
for it. Give a Pi thread only work you would let Pi do unattended in your terminal. (If one
of your Pi extensions asks something, the app shows it as a card.)

- **Sign in with Pi's own `/login`.** The host gets a PATH and nothing else of your
  shell's, so an API key you keep in a shell variable does not reach its Pi: models that
  need it are missing, and a new thread may run on another model than at the desk. Store
  the key with `/login`, set `pi.model` in `config.json`, or pick a model in the app.
- `/compact`, your extensions' commands, prompt templates and skills (`/skill:<name>`) are
  offered; Pi's own `/model`, `/name` and the like are the app's controls instead.
- A thread from the app is one of Pi's sessions: `pi --resume` lists it. Quit Pi at the
  desk before you go on from the app: two Pis writing one session make branches in it.

### Cursor

This is Cursor's command-line agent, `cursor-agent`, with your own Cursor settings and
sign-in.

- **It asks as much as Cursor is set to.** `always` on an approval card adds to Cursor's
  own allowlist, so the terminal stops asking for it too.
- **A model you choose for a thread is selected in Cursor itself**: your other Cursor
  threads on `default`, and `cursor-agent` in the terminal, are on it from then on.
- **Modes:** Agent (`/mode default`) is Cursor's agent mode, asking as your Cursor settings
  say (Allowlist, Auto-review or Run Everything); Full access (`/mode full`) is the same
  mode on a Cursor started with `--force`, Cursor's Run Everything, a second Cursor process
  for that folder (unless your team does not allow Run Everything); `/mode plan` plans
  first, and `/mode ask` is Cursor's Ask mode, which reads and answers only. There is no
  `edits`, and no Auto-review of a thread's own: Cursor's ACP reads only its settings for
  that. Plan and Ask are not locks: the model can leave either by itself, and the thread
  shows "Switch Mode: agent" when it does.
- **Stop does not always end a command** Cursor started; its row then says it may still be
  running.
- **Subagents** Cursor's Task tool starts are on the thread's subagents line, with what each
  is doing and its answer; one asks before a command on a card of its own. A subagent left
  in the background keeps the turn open until it ends (Cursor answers the turn then), and
  Stop ends it with the turn: Cursor cannot stop one alone.
- **A turn Cursor could not finish** (no network, a plan that is used up) ends as failed,
  with what Cursor said.
- A message sent while it works waits for the turn to end. There is no context meter or
  `/compact`: Cursor tells of no tokens. Cursor keeps every session under
  `~/.cursor/acp-sessions/`, and nothing deletes them.

### Droid

Droid runs your installed `droid` with your Factory login and settings (`droid`, then
`/login`). Setup only finds it: it does not install, update or sign in. The app's modes
mean this for Droid:

| Mode | Droid behavior |
|---|---|
| Off | Actions needing permission are offered for approval |
| Low | Safe edits **and low-risk commands** may run without asking; this is not edits-only |
| Medium | Reversible development actions may run without asking; Droid can still ask for approval |
| High | High-risk actions may run without asking, subject to safety rules; **not** unsafe permission bypass |
| Spec | Read-only planning until you approve a plan, then execution continues in the same or a new session, as offered |
| Default | Inherits the Droid CLI's configured autonomy and interaction mode |

The host never turns on Droid's unsafe permission bypass, and your Droid's own policy
still applies. `/context`, `/compact`, `/cost` (the session's tokens and credits, not your
balance), `/rename` and your Markdown commands from `.factory/commands` are offered.

### Hermes

Each Hermes profile is an agent (`hermes` for the default one). Setup finds Hermes or
offers its installer; `hermes setup model` gives it the AI provider and model it needs.
The host joins the `hermes serve` your user runs, or starts one and leaves it running:
while it does, run `hermes dashboard` with `--isolated`, or stop it first with
`hermes serve --stop`. A message sent while Hermes works is queued. A profile called `pi`
or `cursor` loses that name to that agent: leave the agent off there.

## Agents working with each other

An agent can see and drive the other threads on your computer with the `portals` command,
the way you do from the app: list them, read one, send it a message, wait for it, start a
new one or stop one. Ask for it in words: "start a Codex thread to review this and tell
me what it says". Claude Code, Codex, Pi, Cursor and Droid threads are told the command
exists, and to use it only when you ask (`fleet.tellAgents`). A message sent this way says
it came through Portals, and the app shows who sent it. The command cannot answer another
thread's approvals or questions: a blocked thread waits for you in the app. A thread an
agent started tells that agent when it finishes, fails or waits for an answer
(`fleet.tellStarters`).

```sh
portals threads                      # the newest threads, and whether each is idle, working, blocked or in error
portals read THREAD                  # its last turn, what it waits on first
portals send THREAD "text" --wait    # a message, and the reply once the thread is at rest
portals start --agent codex "text"   # a new thread, with its first message
portals guide                        # the rest, as the agents read it
```

The command is `bin/portals` in the host's folder, and works in your own terminal too.

Your other computers' threads can be in the list too, once they are in one net. Every host
starts as a net of its own. To bring another in, make a join link on a computer of the net
and give it to the other yourself, in a terminal: a join link lets whoever has it into the
net, for ten minutes, once.

```sh
portals net                    # the net's members
portals net invite             # a join link
portals net join               # on the other computer: asks for the join link, then joins
portals net rename "Studio"    # renames this computer on every computer and device
portals net remove MEMBER      # takes a computer or a device out, on every computer
portals net leave              # this computer leaves, and is a net of its own
```

### Slow links between Macs

If an unfiltered full fetch actually times out and the peer advertises `fleet_pages`,
later refreshes can build a private base from frozen 32 KiB pages. A complete candidate
still needs a fresh delta and live-state overlay before any of its rows are shown.
The app's eight-second deadline and immediate failed-Mac backoff stay unchanged:
a refresh during backoff can start one detached eight-second paging exchange, but
never waits for it or starts a second one while it is in flight. There is no timer
or poller fetching pages. Without requested refreshes, bootstrap makes no progress.

The per-linked-Mac cache holds at most 20,000 rows or an estimated 16 MiB; larger lists
are returned whole, not truncated, without retaining a delta base. Removed or replaced
links free it immediately, and an unsuccessful incremental refresh's rows and cursor
expire after a minute. Older bridges use `threads.list` on the same connection, without a failed
probe. Filtered requests retain today's exactly filtered remote `threads.list` call,
since a cold filtered reply can be much smaller than an unfiltered delta base.
The app and its `threads.changes` protocol do not need to change.
Full safety refreshes still run every two minutes. Their replacement is built privately:
the last verified list remains visible, including its last verified titles and live
states, until a complete replacement passes a fresh seal. Failed or timed-out attempts
keep that list and retry on later requested refreshes; no partial replacement is shown.
An idle private candidate expires after a minute without removing the verified list.
The verified base, private replacement and pending pages share that near-side bound.
The serving bridge keeps
at most four frozen snapshots and 16 MiB total across all requesting Macs. Valid page
progress/access refreshes a 60-second idle expiry; malformed pages, link removal,
restart or overflow discard the affected stage. Excessive mutations can prevent a
fresh seal, in which case an initial bootstrap stays unreachable and a safety refresh
keeps the last verified list.

## When something doesn't work

- **The app can't reach your computer.** Check that it is awake and that Tailscale is on
  and signed in to the same account on both. `npx portals-host status` says whether the
  host runs and the address the app uses.
- **On Linux, the host stops when you log out.** Turn lingering on:
  `sudo loginctl enable-linger $USER`.
- **Sign-in fails.** Pair again with the code from `npx portals-host pair`.
- **An agent is missing from the app.** Run setup again: it says what it finds, and
  offers to turn on an agent installed since, Pi, Cursor or Droid among them (or set its
  `providers` key to `true`). An update alone does not. Claude Code with your own login
  must be signed in (`claude`, then `/login`); Codex too (`codex login`).
- **A Pi thread runs on a model you did not pick, or a model you use at the desk is not
  on the list.** The host's Pi does not get your shell's variables, API keys among them:
  see [Pi](#pi).
- **A Pi thread says Pi is too old.** Update it (`pi update`) and send the message again.
- **A Cursor thread says Cursor is not signed in.** Run `cursor-agent login` in a
  terminal on that computer, then send the message again. The host never signs in for
  you: Cursor would open a browser there.
- **A Droid thread cannot sign in.** Run `droid` in a terminal on that computer and use
  `/login`, then try again. Setup does not look at or copy Factory credentials.
- **The app says the host has another host's relay id.** Its folder was copied from
  another computer: run `npx portals-host relay reset` on it.
- **Anything else.** Read the log: `~/Library/Logs/portals-bridge.log` on a Mac,
  `~/.local/state/portals-bridge.log` on Linux ([Where it keeps things](#where-it-keeps-things)).

## Settings

The settings are `config.json` in the host's folder, readable by you only. Setup writes
it, and keeps what you change when it runs again. Restart the host after editing it
([Every day](#every-day)). These are the ones people change:

| Key | What it does |
|---|---|
| `providers.claude`, `providers.codex`, `providers.pi`, `providers.cursor`, `providers.droid`, `providers.hermes` | Offers that agent in the app (`true`) or not (`false`). Setup turns on what it finds |
| `claude.path`, `codex.path`, `pi.path`, `cursor.path`, `droid.path`, `hermes.path` | Where each agent's program is. Setup writes the one it found; a bare name is looked up on the PATH the host runs with |
| `claude.apiKey` | The Anthropic API key Claude Code runs with, or `null` for your own Claude login ([Claude Code's sign-in](#claude-codes-sign-in)) |
| `generalFolder` | General: where a new thread runs when you pick no folder. `~/Portals` unless set |
| `folders.hide` | Folders never offered for new threads, nor anything under them (`~` is your home folder) |
| `pi.model` | The model a new Pi thread starts on, as `pi --list-models` names it: `"openai/gpt-6.1-sol"`. `null`: Pi's own default |
| `push.relay` | The Portals relay notifications go through; `null` sends none |
| `relay.enabled` | Keeps a standby connection to the Portals relay, so a device in your net that cannot reach this computer directly comes through it, sealed end to end. On unless `false` |
| `fleet.tellAgents` | Tells the agents that the `portals` command exists (on unless `false`). With `false` it still works for an agent you tell of it |
| `fleet.tellStarters` | Tells the thread that started a thread when that one finishes a turn, fails or waits for an answer (on unless `false`) |
| `visuals.tellAgents` | Tells the agents that the app draws visuals (on unless `false`). A visual an agent writes anyway is still drawn |
| `updates.check` | Asks npm's registry, about once a day, whether a newer host is out ([Updating](#updating)). On unless `false` |

Every key, with what each does, is listed in `bridge/DEVELOPING.md` in the Portals
source repository.

## Uninstalling

```sh
npx portals-host uninstall
```

It stops the host and removes its LaunchAgent (on Linux, its systemd user service), and
offers to remove the `tailscale serve` mapping setup made. It asks before deleting the
host's folder, which holds the settings, the password, the list of threads and the
conversations the app shows for Cursor and Droid threads. `~/Portals` and your agents'
own sessions are not touched.

## License

MIT. See [LICENSE](LICENSE).
