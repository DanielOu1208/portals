# Linux plan: a Linux machine as a Portals host

**Decided 2026-10-28.** the user answered the questions at the end the same day ("u can run all").
Branch `linux/port` from main fc402bc8. The user wants a Linux port of the bridge
(`portals-host`, in `bridge/`), so a Linux machine can be a host that the iPhone and Mac
apps reach over Tailscale, as a Mac is today.

The goal: on a Linux machine with Node and Tailscale, `npx portals-host setup` does what
it does on a Mac. It keeps the bridge running, maps `tailscale serve`, finds the agents,
and shows the pairing code. Then the apps use that machine as they use a Mac. Macs see
no change.

## What the sweep found

Read-only, on main fc402bc8. On macOS the bridge's tests pass: 2,123 of 2,123 in 46 s.
They have not been run on Linux yet.

**Install.** `bridge/package.json` has `"os": ["darwin"]` (and the lockfile's root
entry says the same), so npm refuses to install on Linux. Every dependency already has
what Linux needs: the Claude Agent SDK has optional Linux packages for x64 and arm64,
glibc and musl, all in the lockfile. `ws`, `zod`, `uqr`, `@clack/prompts` and the
Droid SDK are plain JavaScript.

**Setup (`src/setup/`) is macOS-only:**

- It keeps the bridge running with a LaunchAgent (`launchAgent.ts`: a plist in
  `~/Library/LaunchAgents`, `launchctl` bootstrap, kickstart, bootout and print).
  `commands.ts` uses that class for setup, update, `relay reset` and uninstall.
- It reads the Computer Name with `/usr/sbin/scutil` (`commands.ts:497`,
  `fleet/links.ts:96`). Both fall back to the host name, so neither breaks on Linux,
  but on Linux the fallback is all there is.
- It looks for Tailscale on the PATH or inside the Mac app (`tailscale.ts:9`), and its
  messages send people to the Mac download.
- Files: the bridge's folder is `~/Library/Application Support/portals-bridge`
  (`config.ts:346`), and its log is `~/Library/Logs/<folder>.log` (`state.ts:51`).
- The PATH it gives the bridge (`install.ts:117`) and the places it looks for agents
  (`agents.ts`) list Homebrew's folders and `~/.local/bin`. That is enough on Linux
  too, except for npm's own global folder when it is not under node.
- The onboarding branch adds `osascript` and `open` (to open Portals on this Mac). On
  Linux, those fail as "not found", but they should be skipped by platform instead.
- Eleven of setup's messages in `commands.ts` say "this Mac", and more say "Mac".
- A systemd unit kills everything the bridge started when it stops (`KillMode`
  `control-group`). But `hermes serve` (`providers/hermes/serve.ts:178`) and the Codex
  app-server daemon (`providers/codex/provider.ts:278`) are meant to outlive a restart,
  as they do under launchd. The unit needs `KillMode=process`.
- Node: Ubuntu 24.04 and Debian 12 ship Node 18, below the floor. People will need
  nodejs.org, NodeSource or nvm, and the README has to say so.

**The bridge itself is mostly portable, with these exceptions:**

- **Pi's desk** (sessions running in a terminal) breaks: `providers/pi/desk.ts:351` runs
  `/usr/sbin/lsof`, which Debian and Ubuntu keep in `/usr/bin` and often don't install.
  When a Pi runs in a terminal, a session continued from the desk then fails on every
  turn (`pi/provider.ts:394`). Linux can read `/proc/<pid>/cwd` instead. The same file
  runs `ps -axo` (`-eo` is the safe spelling for procps) and sets
  `LC_ALL=en_US.UTF-8`, a locale Linux often lacks (`C.UTF-8` is always there).
- **File search for `@`** (`sessions/fileSearch.ts:438`) watches each project folder
  recursively on every platform. On Linux, Node adds one inotify watch per subfolder,
  `node_modules` included, which is slow and can run out of watches. It already falls
  back to listing again once a listing is old (`unwatchedMs`); on Linux, that fallback
  should be used from the start.
- **Folder search** (`folderSearch.ts:118-142`) skips Finder packages (folders named
  `.app`, `.bundle` and so on) and, at the top of the home folder, `Library`, Desktop,
  Documents and Downloads, which macOS guards. On Linux none of those are guarded, so a
  project in `~/Documents` would never be found.
- Smaller: the socket fallback should use `$XDG_RUNTIME_DIR` (`config.ts:385`), the
  temporary folders `folders.ts:118` knows lack `/var/tmp` and `/run/user`, Linuxbrew's
  folder is in no list, and `options.ts:10` says Claude's login is in the Keychain.
- Bridge text that reaches the app or the agents also says "Mac": the agents' profile
  descriptions (each `providers/*/provider.ts`), about 30 net errors (`net/net.ts`),
  folder errors (`folders.ts:195-236`), and the guide the `portals` command gives agents
  (`portals/guide.ts:115`).

**Already fine on Linux:**

- `sessions/fileSearch.ts:496` finds git on Linux (`/usr/bin/git` is a real git there).
- `sessions/fileRead.ts:213` falls back from macOS's `O_NOFOLLOW_ANY` to `O_NOFOLLOW`,
  which refuses a link only at the end of the path. The check after the open stays
  either way. On Linux, `/proc/self/fd/<fd>` names the file that was opened, which
  makes the "no link anywhere" check as strong as on macOS (see L1).
- `folderSearch.ts:309` watches the home folder for new folders only on macOS. Elsewhere
  it reads the listing again once it is a minute old. Keep that on Linux: there, Node
  watches recursively with one inotify watch per folder, and a home folder can hold
  more folders than inotify allows (8,192 watches on older kernels).
- Process groups, signals, `kill(pid, 0)` and the `ps -A -o` calls elsewhere are POSIX.
  Nothing reads `$SHELL` or starts a login shell. Paths are compared as given, never
  lowercased, so the case-sensitive file system doesn't matter.
- `providers/claude/settingsEnv.ts:35` reads Claude Code's managed settings at the macOS
  path. Linux keeps them in `/etc/claude-code/managed-settings.json`.
- The hello tells the app `machine: { hostname, home, id }`
  (`gateway/connection.ts:99`), with no word of the OS.
- Wire words to leave alone: the net calls every host `kind: "mac"`
  (`net/members.ts:36`). The app finds attached files by the exact line "Files
  attached in Portals (saved on this Mac):" (`sessions/files.ts:13`,
  `AgentCore/Files.swift:82`). Changing either breaks older apps and bridges.

**Tests.** Three fleet tests make their folders under `/private/tmp`
(`test/fleet-delta*.test.ts`), so they fail on Linux, and so do the `record-*.ts`
scripts' defaults. `config.test.ts:281` and `setup.test.ts:543` expect macOS values.
Four tests already skip off macOS (`folder-search`, `file-read`), and the file search
tests that use real watching (`file-search.test.ts:258-320`) may be flaky on Linux.

**The apps** (no `.xcstrings`; every string is inline Swift):

- They don't know a host's OS. About 17 strings call the host "Mac": the welcome
  (`RootView.swift:232-268`), Add a host (`HostSettingsSheet.swift:277-365`), the
  scanner (`PairingScanner.swift:75`), the net ("Mac" for every host,
  `NetSettings.swift:294`), empty states (`MainScreen.swift:897`,
  `ChatScreen.swift:1425`), the relay error (`HermesWire.swift:84`) and "My Mac" for a
  host with no name (`Pairing.swift:122`).
- Icons are guessed from the host's name (`NetSettings.swift:192`,
  `MacTabs.swift:276`), so a Linux machine shows as a laptop.
- One real bug: `tidyPath` (`AgentCore/Folders.swift:53`) shortens only `/Users/<x>/…`
  to `~/…`, so Linux paths (`/home/<x>/…`) show in full. The hello's `home` fixes it.
- A Linux host never counts as "this Mac" (`Platform.swift:64`), so it gets the remote
  folder picker. That is right.

**Machines.** On the tailnet, two devices run Linux:

- `linux-box` (Omarchy, Arch-based, x86_64), offline since 2026-10-20.
- `montypc`, online, on the user's account, created 2026-09-28. It is not among the
  machines the `computers` skill knows, so nothing was checked on it.

The 5070 Ti has Ubuntu 24.04 in WSL2, but it has been offline 30 days, and its notes say
not to install Tailscale inside WSL. This Mac runs Colima: Docker in an Ubuntu 24.04
arm64 VM, with only the `searxng` container in it now. The disk has 15 GB free.

**The onboarding branch** (`onboarding/first-pass`, not committed yet) changes
`setup/commands.ts`, `agents.ts`, `cli.ts`, the README, `package.json` (the Node floor
goes to 22.18), `RootView.swift` and `HostSettingsSheet.swift`. Setup's service and
wording work below waits for it to merge. L0 and L1 stay out of those files.

## Decided as defaults (say if any is wrong)

- Same package, same command: `npx portals-host setup`. `"os"` becomes
  `["darwin", "linux"]`.
- One small module, `src/platform.ts`, answers what differs: the bridge's folder, the
  log, the machine's name, Claude's managed settings, extra PATH folders, and which
  service keeps the bridge running. On a Mac, each answer stays what it is today.
- On Linux, the folder is `$XDG_DATA_HOME/portals-bridge` (`~/.local/share/portals-bridge`)
  and the log is `$XDG_STATE_HOME/portals-bridge.log` (`~/.local/state/…`).
  `PORTALS_BRIDGE_HOME` still overrides the folder.
- The machine's name on Linux is `PRETTY_HOSTNAME` from `/etc/machine-info` when it is
  set, else the host name.
- The hello gains `machine.os` (`"macos"` or `"linux"`). Older apps ignore it. The net
  keeps `kind: "mac"` and the files line stays word for word.

## The plan, cheap and safe first

**L0. The tests on Linux, as they are.** No product change.
- A script, `bridge/scripts/linux-test.sh`, runs `npm ci` and `node --test` in a
  `node:24` container under Colima. The worktree is mounted read-only and copied inside,
  and no port is published. It pulls about 1 GB once.
- Done when: we have a list of what fails on Linux, and why.

**L1. The bridge runs on Linux, started by hand.** Macs see no change.
- `"os"` gets `linux`. `platform.ts` answers for the folder, the log, the name, the
  managed settings and the PATH folders. `fleet/links.ts` takes the name from it.
- `fileRead` checks `/proc/self/fd` on Linux. The hello gets `machine.os`.
- Pi's desk reads `/proc/<pid>/cwd` on Linux in place of `lsof`, with `ps -eo` and
  `C.UTF-8`.
- File search for `@` doesn't watch recursively on Linux. Folder search skips the
  macOS-only folders only on macOS. The socket fallback and the temporary folders
  learn Linux's places.
- Tests stop assuming macOS (`os.tmpdir()` in place of `/private/tmp`, values per
  platform), and so do the `record-*.ts` defaults.
- Touches `package.json` (one line), `config.ts`, `fleet/links.ts`, `settingsEnv.ts`,
  `fileRead.ts`, `gateway/connection.ts`, `pi/desk.ts`, `sessions/fileSearch.ts`,
  `folderSearch.ts`, `folders.ts` and tests.
- Done when: the tests pass on macOS and in the container, and `node src/main.ts` in
  the container answers a hello with `os: "linux"`.

**L2. Setup on Linux,** after the onboarding branch merges.
- A `Service` interface, with `LaunchAgent` as it is and a new `SystemdService`: a
  user unit in `~/.config/systemd/user/` with `Restart=always`, `KillMode=process` and
  output appended to the log, run with `systemctl --user` enable, restart and stop.
  Lingering as Q3 decides.
- Setup, update, status, `relay reset` and uninstall go through the interface.
- On Linux, Tailscale comes from the PATH, with the Linux download link and the operator
  step (Q4). No `osascript` or `open`. A Node below the floor gets Linux's ways to
  install one. The messages name the machine as Q6 decides.
- Touches `setup/*.ts`, `cli.ts` and `test/setup.test.ts`.
- Done when: the setup tests run against both services. On a Linux VM or machine, setup
  brings the bridge up, the bridge comes back after `kill` and after a reboot, and
  uninstall removes everything setup made.

**L3. The agents on Linux,** on the test machine.
- Claude Code: its login is a file there (`~/.claude/.credentials.json`), and
  `claude auth login` works over SSH with a URL and a code.
- Codex: `codex login --device-auth` for a machine with no browser (Codex 0.163 has
  it), and its Linux sandbox.
- Pi, Cursor, Droid and Hermes, as Q5 decides. Fix what each needs.
- Done when: a thread runs a turn from the iPhone with each agent in scope.

**L4. The apps.**
- `tidyPath` uses the hello's `home`. The icon and the word for a host come from
  `machine.os` (Q6). Where no host is known yet (the welcome, Add a host), the words
  cover both kinds.
- The bridge's own text that reaches the app or the agents follows the same words.
- Touches `AgentCore`, `RootView`, `HostSettingsSheet`, `NetSettings`, `MacTabs`,
  `PairingScanner`, `MainScreen` and the bridge strings listed above.
- Done when: we have screenshots on the iPhone and on the Mac with both a Mac host and a
  Linux host.

**L5. End to end, and docs.**
- On the real machine, from a clean account: the README's steps, setup, pairing from
  the iPhone, a turn with each agent, an update and an uninstall.
- The README gets a Linux section (Node, Tailscale, the operator step, lingering, where
  things are). DEVELOPING gets the container script.
- Done when: The user adds the Linux host on an iPhone from the README alone.

L0 and L1 don't touch the onboarding branch's files, apart from one line of
`package.json` near its own change. Git merges those apart.

Review as usual: reviewer agents per step, then Codex rounds through Portals. Nothing is
installed on this Mac's bridge, and nothing touches its `tailscale serve` or
`hermes serve` on 127.0.0.1:9119. The container and any VM keep their ports to
themselves.

## Where it stands, 2026-10-28

Built on `linux/port`, rebased on main 7a15e231 (onboarding merged). Tests: the bridge's
own on macOS and on Linux (`scripts/linux-test.sh`), PortalsKit's 1,022, and the app
builds for the simulator; the counts are in the commits.

- **L0, L1: done.** As planned, and from the first review (one medium, three low, all
  fixed): a Pi in a terminal whose folder can't be read stops desk turns on Linux too, as
  on a Mac; `file.read` takes a path the kernel names in another case on a
  case-insensitive file system; the Droid test covers a rename; the test script passes
  arguments whole.
- **L2: done.** `setup/service.ts` (the interface), `setup/systemd.ts` (the unit,
  `systemctl --user`, lingering), Linux's Tailscale (download link, `sudo tailscale up`,
  the operator step), no `osascript` or `open`, a check that the person's systemd manager
  answers before anything is installed. Lingering is asked for, and when polkit refuses
  (most servers), asked again for sudo. Setup's words say "this Linux computer" there.
  Tried for real in an Ubuntu 24.04 container with systemd as PID 1
  (`scripts/linux/Dockerfile`, below): setup, the bridge back after `kill -9`, back after
  a reboot with lingering on and nobody logged in, `update`, `relay reset`, `status` and
  `uninstall`; `hermes serve` and Codex's daemon outlive a restart (`KillMode=process`).
- **Second review (L2 to L5), all fixed:** setup makes the log's folder, which systemd
  does not (high: a new account's bridge would fail at every start); macOS's CLI help
  and Pi's lsof message are word for word as before; the systemd check comes before
  anything is written or mapped; Linux's uninstall refuses while the manager can't be
  reached, rather than say "Stopped"; the unit always goes in ~/.config/systemd/user,
  whatever the shell's `XDG_CONFIG_HOME`; a folder with `$` in its path is found running;
  editing a Linux host keeps its system.
- **Codex review (gpt-6.1-sol, xhigh), both fixed:** Pi's /proc scan read every process
  at once, so with many processes a read could fail for want of a file and hide a Pi in a
  terminal: now 32 at a time, a process gone or hidden skipped, any other failure failing
  the check; and a `$` in node's own path kept the service from starting (systemd finds
  the program before it undoes a doubled `$`): the command now starts with `:`, so
  systemd puts no variables in it at all. No macOS change found. On the Zephyrus after
  the fixes (b31de71a): its tests 2,140, one skipped; setup again wrote the unit with
  `ExecStart=:"/usr/bin/node" …`, which its systemd runs, and the mini still reaches it.
- **L3: found, not signed in.** In the container, setup finds all six: Claude Code
  2.1.312 (its installer), Codex 0.165.0 and Pi 1.4.0 (npm), Cursor 2026.10.22 and
  Droid 0.251.0 (their installers), Hermes 0.22.5 (`install.sh --skip-setup`), and the
  bridge offers each. No turn was run: that needs the user's sign-ins, on the Zephyrus
  (below).
- **L4: done in code.** The hello's `machine.os` is kept with the host
  (`HostConfig.machineOS`); a Linux host gets the `pc` symbol and the word "Linux
  computer"; `/home/<x>/…` reads as `~/…`; the welcome, Add a host and the scanner speak of
  "your Mac or Linux computer"; the chat's read-only note and the no-agents screen name
  the host. Bridge text about this machine (agents' descriptions, folder, file, net and
  desk errors, the agents' guide) says "Linux computer" on Linux (`machineWord()`).
  Left as they are: the net's wire word `kind: "mac"`, the files line the app matches
  word for word, the gateway contract's summaries, log lines, and what the bridge says
  of other hosts ("another Mac", "linked Macs"). A Mac of the net that is no host on
  this device still shows as a Mac: the net's list says no system.
- **L5: docs done; end to end waits for the Zephyrus.** The README has "On Linux";
  DEVELOPING has the container script and the systemd image.

**On the Zephyrus, 2026-10-28** (Omarchy 4.0.4, Arch-based, x86_64, Node 26.8.1, with
the OK on the list of what goes on it; reached from the mini with plain `ssh`
checked against the host keys the tailnet advertises, through Tailscale SSH's check):

- The branch at ace87abd in `~/portals-linux-test`: the bridge's tests pass there,
  2,139, one skipped (FSEvents).
- `setup --yes --claude=login`: found Claude Code 2.1.312, Codex 0.163.0 (signed in),
  Pi 1.4.0 and Cursor 2026.10.22; Tailscale's operator was danielou already, so
  `https://linux.example.ts.net:10010` was mapped at once; the systemd user
  service started and answered. The user turned lingering on (`Linger=yes`) and added the
  Zephyrus from an iPhone: it is in the net beside the mini, mbp16, mbp14 and the iPhone.
- A Codex turn through the Zephyrus's bridge, and one started from the mini's bridge on
  the Zephyrus (`portals start --machine linux-box`), each answered.
- Claude Code signed in from a phone (`claude auth login` in a tmux session on the
  Zephyrus: the link opened on the phone, its code sent back and pasted), on a Max plan;
  a Claude Code turn from the mini through the Zephyrus's bridge answered "Linux x86_64".
- Not yet: Pi (no provider signed in), Cursor (not signed in), Hermes and Droid (not
  installed). His installed apps are the n14
  build, so they show the Zephyrus as a Mac until an app with L4 is installed.

### Trying setup in a container

```sh
docker build -t portals-linux-systemd bridge/scripts/linux
docker run -d --name portals-linux --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock portals-linux-systemd
# the repository in, built as dana (COPYFILE_DISABLE=1 keeps macOS's tar quiet)
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=./.git --exclude='*/node_modules' -cf - . |
  docker exec -i -u dana portals-linux bash -c 'mkdir -p ~/portals && tar -C ~/portals -xf -'
# a login session of dana's, so a systemd user manager runs it
docker exec -it portals-linux su - dana -c 'cd ~/portals/bridge && npm ci && npm run build && node dist/cli.js setup'
```

No port is published and its Tailscale never signs in, so nothing outside the container
reaches it; `docker rm -f portals-linux` ends it.

## the answers, 2026-10-28

- **Q1 distros:** as proposed: systemd and glibc, x86_64 and arm64; no Alpine, no WSL
  for now. "if ti works in a container it should be fine".
- **Q2 test machine:** a container on this Mac is enough, so no other machine is
  needed.
- **Q3 keeping it running:** a systemd user service; setup asks before turning lingering
  on.
- **Q4 `tailscale serve`:** setup offers `sudo tailscale set --operator=$USER` when
  Tailscale refuses ("yes if this is necessary").
- **Q5 agents:** Claude Code and Codex must work. Hermes is in: setup finds it as it
  finds the others ("it should work from detecting existing runtimes right?"). Pi,
  Cursor and Droid work when they are found.
- **Q6 the word:** "Linux computer is ok for now", for a host whose bridge says it runs
  Linux.
- **Q7:** "u can run all": every step, L0 to L5. L2's service layer goes in new files
  first, so the setup commands take only small edits, and those meet the onboarding
  branch when it merges.

The questions as they were put:

**Q1. Which distros.** Proposed: anything with systemd and glibc on x86_64 or arm64,
tested on Ubuntu 24.04 LTS and on Arch (Omarchy). Debian and Fedora "should work".
Not Alpine (musl) and not WSL for now.

**Q2. Which machine to test on.** Proposed: the container on this Mac for L0 and L1, then
the Zephyrus for L2 to L5 (it needs to be on, and anything beyond read-only checks
needs your OK there). What is `montypc`, and may it be used? The other choice is a VM
on this Mac (it would need disk space, and to join the tailnet as a new device, with
your OK).

**Q3. Keeping it running.** A systemd user service, as proposed. For a machine nobody
logs into, the bridge would stop at logout and not start at boot unless lingering is
on (`loginctl enable-linger`, which may ask for a password). Proposed: setup explains
this and asks before turning lingering on. Without systemd, setup stops and says why.

**Q4. `tailscale serve` on Linux** works only for root or Tailscale's "operator".
Proposed: setup tries, and when Tailscale refuses, offers to run
`sudo tailscale set --operator=$USER` once in the terminal and tries again. The
other choice is to print that command and stop.

**Q5. Which agents must work on Linux at first.** Proposed: Claude Code and Codex must.
Pi, Cursor, Droid and Hermes work if they are found, with no extra work unless L3
shows some. Is Hermes in for now, or later?

**Q6. What the apps call a Linux host.** Proposed: the bridge tells its OS, and the
apps say "Mac" for a Mac, "Linux computer" (or its name) for Linux, with a `pc` or
`server.rack` icon. Where no host is known yet, they say "computer" ("Make your Mac or
Linux computer a host"). Other choices: "computer" everywhere, Macs included; or keep
"Mac" in the apps and change only setup's own words.

**Q7. How it merges.** Proposed: L0 and L1 can merge to main on their own, since Macs see
no change. L2 starts once `onboarding/first-pass` is merged. Or the whole port could
merge as one.
