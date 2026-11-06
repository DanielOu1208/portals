import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bridgeHome, loadConfig, parseConfig, pathsFor, type AuthConfig, type Config } from "./config.ts";
import { counters, type CountersOptions } from "./counters.ts";
import { DeskSessions } from "./desk.ts";
import { Fleet } from "./fleet/fleet.ts";
import { TellStarters, type Told } from "./fleet/heldElsewhere.ts";
import { Links, macName } from "./fleet/links.ts";
import { Folders, makeGeneral, type FolderSource } from "./folders.ts";
import { Gateway } from "./gateway/gateway.ts";
import { PollNow } from "./gateway/pollNow.ts";
import { Auth } from "./http/auth.ts";
import { createLocalServer, listenLocal, writeLauncher } from "./http/local.ts";
import { createHttpServer } from "./http/server.ts";
import { log } from "./log.ts";
import { stopDeadlineMs } from "./lifetime.ts";
import { Looks } from "./looks.ts";
import { isLoopbackAddress } from "./net/members.ts";
import { Net } from "./net/net.ts";
import { machineID, SidebarOrder } from "./order.ts";
import { ClaudeProvider } from "./providers/claude/provider.ts";
import { makeProviders, startProviders } from "./providers/index.ts";
import { AgentPrograms, type ProgramsOptions } from "./providers/programs.ts";
import type { Provider } from "./providers/types.ts";
import { Apns, DryRun, type Sender } from "./push/apns.ts";
import { Relay } from "./push/relay.ts";
import { Standby } from "./relay/standby.ts";
import { Notifier } from "./push/notifier.ts";
import { PushStore } from "./push/store.ts";
import { FileReader } from "./sessions/fileRead.ts";
import { ThreadSearch } from "./search/search.ts";
import { FileSearch } from "./sessions/fileSearch.ts";
import { FolderSearch } from "./folderSearch.ts";
import { DiffStore } from "./sessions/keptDiffs.ts";
import { noteRepos, SessionManager } from "./sessions/manager.ts";
import { SpentStore } from "./sessions/spent.ts";
import { WaitingStore } from "./sessions/waiting.ts";
import { Registry } from "./sessions/registry.ts";
import { readJSON } from "./store/jsonFile.ts";
import { UpdateCheck, type UpdateCheckOptions } from "./updates.ts";
import { DiskSpace, type DiskSpaceOptions } from "./disk.ts";
import { startUsage, type RunningUsage, type UsageOptions } from "./usage/host.ts";
import { systemTimeZone } from "./usage/store.ts";
import { Telemetry, type TelemetryOptions } from "./usage/telemetry.ts";
import { version } from "./version.ts";

// Puts the pieces together and starts listening. `main.ts` runs this; tests run it on
// port 0 in a folder of their own.

export { version };

export interface BridgeOptions {
  /** The bridge's folder; defaults to `bridgeHome()`. */
  home?: string;
  /** How many events each session's replay log keeps. */
  logCapacity?: number;
  /** Agents to run instead of the ones config.json names (tests). */
  providers?: Map<string, Provider>;
  /** Folders never offered for being temporary, instead of the usual ones (tests, whose folders all are). */
  temporaryFolders?: string[];
  /** The user's home folder, never offered itself and searched for folders (feature folder_search); tests give another. */
  userHome?: string;
  /** For the counters when config.json has them on: a shorter tick, a smaller cap, another file, `ps` or clock (tests). */
  counters?: Partial<Pick<CountersOptions, "seconds" | "capBytes" | "file" | "ps" | "clock" | "gauges">>;
  /** How long another Mac's word on which threads here its threads keep at work holds, and how often this one says it again, in ms (tests; feature held_elsewhere). */
  held?: { for?: number; every?: number };
  /** The waits before each new try at a starter's notice that could not be sent, in ms (tests; `Fleet`'s `noticeRetries`). */
  noticeRetries?: readonly number[];
  /** For the check for a later version when config.json has it on: another registry, clock or timing (tests; feature update_notice). */
  updates?: Partial<Omit<UpdateCheckOptions, "own" | "file" | "changed">>;
  /** For the reading of the free space on the bridge's disk: a stand-in for `statfs`, other timing (tests; feature disk_space). */
  disk?: Partial<Pick<DiskSpaceOptions, "statfs" | "everyMs">>;
  /** For the agents' programs: another home folder, environment, update time or source of latest releases (tests; feature agent_programs). */
  programs?: Partial<Pick<ProgramsOptions, "home" | "env" | "updateMs" | "latest">>;
  /** For token analytics (feature usage_history): another home to read history under, a fetch that stays off the network, other timing (tests). */
  usage?: UsageOptions;
  /** For the anonymous totals (feature usage_telemetry): another environment (the stats address, the switch's lock), clock, fetch or timing (tests). */
  telemetry?: Partial<Pick<TelemetryOptions, "env" | "clock" | "fetch" | "timeZone" | "firstMs" | "everyMs" | "answerMs" | "backoffMs">>;
}

/** How long telling another Mac which of its threads threads here keep at work may take. */
const heldCallMs = 8_000;

export interface RunningBridge {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  home: string;
  replayEpoch: string;
  /** The bridge's threads as a whole: for tests of what only it does, between two calls (a wait called off). */
  fleet: Fleet;
  /** The check for a later version, when config.json has it on: for tests, which wait for its answer. */
  updates: UpdateCheck | undefined;
  /** The free space on the bridge's disk: for tests, which wait for its reading. */
  disk: DiskSpace;
  /** The agents' programs: for tests, which wait for an update's end. */
  programs: AgentPrograms;
  /** The anonymous totals' sender: for tests, which have it look for a day to send. */
  telemetry: Telemetry | undefined;
  /** Signal shutdown budget; normally eight seconds, at most sixteen. */
  readonly stopDeadlineMs?: number;
  /** Stops everything; once, however often it is called. */
  close(): Promise<void>;
}

export async function startBridge(options: BridgeOptions = {}): Promise<RunningBridge> {
  const home = options.home ?? bridgeHome();
  const config = loadConfig(home);
  // Before the agents start: Claude Code's first check runs in it.
  if (!makeGeneral(config.generalFolder)) log.warn("General folder missing; using the home folder", { folder: config.generalFolder });
  const paths = pathsFor(home);
  const providers = options.providers ?? makeProviders(config, paths);
  const registry = new Registry(paths.threads, paths.removed);
  const push = new PushStore(paths.push, { apnsConfigured: config.apns !== null || config.push.relay !== null });
  const sender = notificationSender(config);
  const notifier = sender ? new Notifier({ store: push, sender }) : undefined;
  // Feature worktrees: the repository each thread's worktree is of, in the background.
  void noteRepos(registry).catch((error: Error) => log.warn("could not read the threads' worktrees", { error: error.message }));
  const diffs = new DiffStore(paths.diffs);
  // The diffs kept for threads taken off the list: one removed as the bridge stopped.
  try {
    diffs.sweep((thread) => !registry.has(thread) && registry.removedRecord(thread) !== undefined);
  } catch (error) {
    log.warn("could not let go of the diffs kept for removed threads", { error: (error as Error).message });
  }
  // The free space on the disk this folder is on: Settings shows it, and the threads are
  // told as it runs low (feature disk_space). Read from `start` on, once everything is made.
  const disk = new DiskSpace({
    path: home,
    name: () => here.name,
    changed: () => pollNow.moved(),
    low: () => sessions.diskLow(),
    ...options.disk,
  });
  const sessions = new SessionManager({
    registry, providers, logCapacity: options.logCapacity, listener: notifier, waiting: new WaitingStore(paths.waiting), spent: new SpentStore(paths.spent), diffs,
    heldFor: options.held?.for, disk,
  });
  // A thread taken off the list is no device's to hear about any more, as when the app
  // asks for it with the push route's DELETE (feature thread_sync). When push.json cannot
  // be read or written then, the store still forgets the thread at once, and the file
  // loses it at the next write that succeeds. A registration still in the file when the
  // bridge stopped (between the two writes of a removal, or with no write since) is
  // forgotten when the bridge starts, or when the thread is taken up again, before the
  // device taking it up registers it.
  const forget = (id: string) => push.forget(id);
  sessions.listen({ threadRemoved: forget, threadReturning: forget });
  // Only those the file lists, not a write for each removed thread at every start: a
  // removed thread notifies nobody until it is taken up again, which forgets it.
  const watched = push.state().threads;
  for (const record of registry.allRemoved()) {
    if (!(record.id in watched)) continue;
    try {
      push.forget(record.id);
    } catch (error) {
      log.warn("a removed thread's notifications could not be forgotten", { thread: record.id, error: (error as Error).message });
    }
  }
  const folders = new Folders({
    general: config.generalFolder,
    hide: config.folders.hide,
    own: [home],
    temporary: options.temporaryFolders,
    home: options.userHome,
    added: paths.folders,
    sources: [
      ...[...providers.values()].flatMap((provider): FolderSource[] => (provider.recentFolders ? [() => provider.recentFolders!()] : [])),
      // The bridge's own threads: the newest word on a folder used from the phone.
      async () => registry.all().map((record) => ({ path: record.cwd, lastUsed: record.updatedAt * 1000 })),
    ],
  });
  const desk = new DeskSessions({
    registry,
    general: () => folders.general(),
    hide: config.folders.hide,
    own: [home],
    temporary: options.temporaryFolders,
  });
  const machine = machineID(paths.machine);
  const here = { id: machine, name: macName(config.fleet.name) };
  // The Macs and devices this one reaches after pairing once; a net of one until someone joins.
  const net = new Net({ path: paths.net, ownPath: paths.netOwn, here });
  // A name set from the app (`net.rename`) wins over `fleet.name` and the Computer Name:
  // the fleet's lines and `started_by` say the one the net goes by, from now on.
  here.name = net.name();
  if (notifier) notifier.inNet = (member) => net.isMember(member);
  const links = new Links(paths.links, net);
  const fleet = new Fleet({ sessions, providers, folders, links, here, tellStarters: config.fleet.tellStarters, noticeRetries: options.noticeRetries });
  // Each Mac of the net is told which of its threads threads here keep at work, so that it
  // lists them as running too (feature held_elsewhere, docs/fleet-plan.md): a thread started
  // here from one of its threads (`started_by.from`, its Mac by its stable id).
  const starters = new TellStarters({
    activity: () => sessions.activity(),
    startedFrom: (id) => {
      const from = sessions.record(id)?.startedBy?.from;
      return from?.machine && from.thread && from.machine !== here.id ? { machine: from.machine, thread: from.thread } : undefined;
    },
    tell: async (machine, threads) => {
      const name = links.nameOfMachine(machine);
      if (!name) return "gone";
      // An older bridge's greeting lacks the feature: it is only pinged, and not told.
      return (await links.call(name, "threads.held", { threads }, heldCallMs, {
        fallback: { feature: "held_elsewhere", method: "gateway.ping", params: {} },
        receive: (_answer, method) => ({ result: method === "threads.held" ? "told" : "older" }),
      })) as Told;
    },
    every: options.held?.every,
  });
  const looks = new Looks(paths.looks);
  const order = new SidebarOrder(paths.order);
  // The devices that ask are told when something their poll reads moved: the list, a
  // thread's activity, the looks, the order or the net (feature poll_now). The event says
  // where the list and the net are, as they are when it goes.
  const pollNow = new PollNow(() => ({ thread_list: sessions.list(), net: net.revision() }));
  looks.moved = order.moved = () => pollNow.moved();
  registry.moved = () => {
    pollNow.moved();
    // A thread taken off the list may have been the one between a thread at work here and
    // its starter on another Mac, which then hears so at once (Codex's review of 01c6a8cc).
    starters.update();
  };
  sessions.listen({
    activityChanged: () => {
      pollNow.moved();
      starters.update();
    },
  });
  const files = new FileReader();
  const search = new ThreadSearch({
    source: { records: () => sessions.records(), loaded: (id) => sessions.get(id)?.messages },
    providers,
  });
  const fileSearch = new FileSearch();
  const folderSearch = new FolderSearch({
    home: folders.homeFolder(),
    refusing: () => folders.refusing(),
    taking: () => folders.taking(),
    listed: async () => (await folders.list()).folders,
  });
  // Whether a later portals-host is out: the devices that ask are told as it comes (feature update_notice).
  const updates = config.updates.check
    ? new UpdateCheck({ own: version, file: paths.update, changed: () => pollNow.moved(), ...options.updates })
    : undefined;
  // Which programs are installed, and updating them (feature agent_programs).
  const programs = new AgentPrograms({ config, paths, providers, ...options.programs });
  // What all coding on this computer spent, read from the agents' own history, which of it
  // went through Portals, and the plans' limits over time (feature usage_history). A host
  // that cannot start it goes on without it.
  let usage: RunningUsage | undefined;
  try {
    usage = startUsage({ paths, registry, sessions, providers, usage: options.usage });
    registry.added = usage.threadAdded;
  } catch (error) {
    log.warn("usage: token analytics could not start; the host goes on without them", { error: (error as Error).message });
  }
  // The anonymous daily totals (feature usage_telemetry): on unless config.json's
  // `telemetry` or the environment says otherwise. Sends nothing without the usage book,
  // and the switch still answers.
  let telemetry: Telemetry | undefined;
  try {
    const sender = new Telemetry({
      stateDir: paths.state,
      configPath: paths.config,
      env: process.env,
      book: usage?.book,
      prices: usage?.prices,
      timeZone: usage?.book.timeZone ?? systemTimeZone(),
      version,
      netID: () => net.revision().id,
      platformOf: (id) => net.list(null).members.find((member) => member.id === id)?.platform,
      ...options.telemetry,
    });
    sessions.listen({ turnStarted: () => sender.turnStarted() });
    telemetry = sender;
  } catch (error) {
    log.warn("usage: the anonymous totals could not start; nothing is sent", { error: (error as Error).message });
  }
  const gateway = new Gateway({ config, sessions, providers, folders, desk, fleet, looks, order, machine, pollNow, files, fileSearch, folderSearch, net, search, updates, disk, programs, usage, telemetry });
  net.listener = {
    moved: () => pollNow.moved(),
    // Set from the app, here or on another Mac: what this Mac passes on says it at once.
    renamed: (name) => {
      here.name = name;
    },
    // Out of the net here: their connections close, and what their devices registered goes.
    removed: (members) => {
      gateway.closeMembers(new Set(members.map((member) => member.id)));
      try {
        push.dropMembers(members.map((member) => member.id));
      } catch (error) {
        log.warn("the notifications of members removed from the net could not be forgotten", { error: (error as Error).message });
      }
    },
    // In under a new token: what the old one opened closes (the member signs in again with the new).
    retokened: (members) => gateway.closeMembers(new Set(members.map((member) => member.id))),
  };
  const auth = new Auth({
    // Read again at each sign-in, so a password set while running works without a restart.
    credentials: (): AuthConfig | null => {
      try {
        return parseConfig(readJSON<Record<string, unknown>>(paths.config, {})).auth;
      } catch {
        return config.auth;
      }
    },
  });
  if (!config.auth) {
    log.warn(`No password is set up, so nobody can sign in. Run npx portals-host setup, or add one to ${paths.config} (see scripts/hash-password.ts).`);
  }

  const server = createHttpServer({ auth, gateway, push, net, allowedHosts: config.allowedHosts, version });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  // The `portals` command's way in. Without it the bridge still serves the app.
  const local = createLocalServer(gateway);
  try {
    await listenLocal(local, paths.socket);
    // The command's script is beside this file: .ts when run from source, .js when built.
    const entry = fileURLToPath(new URL(`./portals${extname(import.meta.url)}`, import.meta.url));
    writeLauncher({ command: paths.command, home, node: process.execPath, entry });
  } catch (error) {
    log.warn("the portals command is off: its socket or launcher could not be made", { socket: paths.socket, error: (error as Error).message });
  }
  // Once both listen: a bridge that could not take its port makes no file. Off unless
  // config.json has `counters` on, and then nothing of them is started.
  const claude = [...providers.values()].find((provider) => provider instanceof ClaudeProvider);
  const counting = counters.start({
    config: paths.config,
    file: paths.counters,
    gauges: () => ({
      conns: gateway.openConnections,
      loaded: sessions.loaded,
      ...registry.counts(),
      revision: registry.revision,
      waiters: fleet.waiters,
      claude_sessions: claude?.tracked.sessions ?? 0,
      claude_warm: claude?.tracked.warm ?? 0,
    }),
    ...options.counters,
  });
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  // Its address in the net: the phone's (setup's), else config's, else this Mac's own. Setup
  // giving 127.0.0.1 means no Tailscale: this Mac's own Portals is all that reaches it.
  const fromSetup = netAddress(paths.setup);
  const thisMacOnly = fromSetup !== undefined && isLoopbackAddress(fromSetup) && !config.net.url;
  net.start((fromSetup && !isLoopbackAddress(fromSetup) ? fromSetup : config.net.url) ?? fromSetup ?? `http://${host}:${port}`, { thisMacOnly });
  // The backup way in: devices that cannot reach this Mac directly come through the relay.
  // A Mac set up for itself has no such devices, and no reason to hold a connection open for them.
  const standby = config.relay.enabled && !thisMacOnly ? new Standby({ url: config.relay.url, net, accept: (socket, member) => gateway.accept(socket, member) }) : undefined;
  if (standby) {
    gateway.relayProblem = () => standby.problem;
    standby.start();
    log.info(`devices that cannot reach this Mac directly come through the relay at ${config.relay.url}`);
  }
  updates?.start();
  disk.start();
  telemetry?.start();
  // The threads an agent still runs are followed again; then those that had messages
  // waiting when the bridge stopped are loaded, so the messages are sent.
  const following = new AbortController();
  // An agent that keeps one conversation has it on the list, and its other threads leave
  // it: those there are now, and one its host adds later (a Hermes profile put back).
  const keepOngoing = (name: string, provider: Provider) => {
    if (provider.ongoingThread) void keepOngoingOnceAnswered(name, provider, sessions, following.signal);
  };
  for (const provider of new Set(providers.values())) provider.onAgentAdded?.(keepOngoing);
  for (const [name, provider] of providers) {
    provider.watchThreads?.(
      () => registry.all().filter((record) => record.agent === name && !record.readOnly),
      async (id) => {
        if (following.signal.aborted || registry.get(id)?.agent !== name) return;
        await sessions.refresh(await sessions.load(id));
      },
    );
  }
  startProviders(providers);
  for (const [name, provider] of providers) keepOngoing(name, provider);
  void followLiveThreads(registry, providers, sessions, following.signal).then(async (asking) => {
    if (await sessions.sendWaiting()) return;
    // A thread that could not be loaded is tried again a few times; for an agent still
    // asked which threads it runs, that asking sees to it.
    for (const name of providers.keys()) if (!asking.has(name)) void sendWaitingAgain(name, sessions, following.signal);
  });

  let closing: Promise<void> | undefined;
  return {
    url: `http://${host}:${port}`,
    port,
    home,
    replayEpoch: gateway.replayEpoch,
    fleet,
    updates,
    disk,
    programs,
    telemetry,
    get stopDeadlineMs() {
      return Math.min(16_000, Math.max(stopDeadlineMs, ...[...providers.values()].map((provider) => provider.stopDeadlineMs ?? 0)));
    },
    close() {
      closing ??= (async () => {
        // With a last line; only the bridge that started them stops them.
        if (counting) counters.stop();
        // The totals read so far are saved, and the history reader ends.
        telemetry?.stop();
        const usageStopped = usage?.stop().catch((error: Error) => log.warn("usage: token analytics did not stop cleanly", { error: error.message }));
        // An agent that could not be asked which threads it has open is not asked again.
        following.abort();
        // Nobody is left waiting for a thread, nor for another Mac's copy of the net.
        fleet.close();
        starters.close();
        net.close();
        standby?.close();
        updates?.stop();
        disk.stop();
        programs.close();
        pollNow.close();
        fileSearch.close();
        folderSearch.close();
        gateway.closeAll();
        await sessions.close();
        await usageStopped;
        // What the last turns called for is still sent.
        await notifier?.idle();
        notifier?.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        if (local.listening) {
          await new Promise<void>((resolve) => {
            local.close(() => resolve());
            local.closeAllConnections();
          });
          rmSync(paths.socket, { force: true });
        }
      })();
      return closing;
    },
  };
}

/** The address setup found for the phone, which the net's members reach this Mac at too. */
function netAddress(setup: string): string | undefined {
  const state = readJSON<{ address?: unknown }>(setup, {});
  return typeof state?.address === "string" && state.address !== "" ? state.address.replace(/\/+$/, "") : undefined;
}

/** What notifications go through: APNs, the relay, the dry-run file, or nothing (the routes still keep registrations). */
function notificationSender(config: Config): Sender | null {
  if (config.push.dryRun) {
    log.info(`notifications are written to ${config.push.dryRun} instead of being sent (push.dryRun)`);
    return new DryRun(config.push.dryRun);
  }
  if (!config.apns && config.push.relay) {
    log.info(`notifications are sent through the relay at ${config.push.relay}`);
    return new Relay({ url: config.push.relay });
  }
  if (!config.apns) {
    log.info("notifications are off: config.json names no APNs key (apns) and no relay (push.relay)");
    return null;
  }
  const apns = new Apns({ config: config.apns });
  try {
    apns.providerToken();
    log.info(`notifications are sent through APNs with key ${config.apns.keyId}`);
  } catch (error) {
    log.warn(`could not read the APNs key ${config.apns.keyPath}; notifications will fail until it can be read`, { error: (error as Error).message });
  }
  return apns;
}

/**
 * After a restart: the threads an agent still has running or open (Codex's daemon
 * outlives the bridge) are followed again at once, so their questions are waiting
 * when the app comes back. The rest load when the app opens them. An agent that cannot
 * be asked yet (it took no connection in the time a call waits for one), or one with a
 * thread that could not be loaded (its connection dropped as it was), is asked again in
 * the background until all its threads are followed or the bridge stops (`stopped`),
 * without holding up the messages waiting: where the bridge gave up, a turn the agent
 * still ran was followed only once the app opened its thread, so a question it asked
 * meanwhile had no card and sent no notification.
 */
async function followLiveThreads(registry: Registry, providers: Map<string, Provider>, sessions: SessionManager, stopped: AbortSignal): Promise<Set<string>> {
  const asking = new Set<string>();
  // Each agent at once: one slow to answer (Codex waits 15 s for a connection) held up
  // the agents after it, and Hermes interrupts a turn 20 s after its client went.
  await Promise.all(
    [...providers].map(async ([name, provider]) => {
      if (!provider.liveThreads) {
        await followLeftRunning(name, registry, sessions);
        return;
      }
      try {
        if (await followLive(name, provider, registry, sessions)) return;
      } catch (error) {
        log.warn(`could not ask ${provider.profile.displayName} which threads are open; it is asked again until it answers`, { error: (error as Error).message });
      }
      asking.add(name);
      void followOnceAnswered(name, provider, registry, sessions, stopped);
    }),
  );
  return asking;
}

/**
 * Follows the threads of the agent `name` it has open now: true when every one is
 * followed. Throws when the agent cannot be asked. A thread that cannot be loaded is
 * logged, a warning the first time (`again` false) and a debug line after.
 */
async function followLive(name: string, provider: Provider, registry: Registry, sessions: SessionManager, again = false): Promise<boolean> {
  const ids = registry.all().filter((record) => record.agent === name).map((record) => record.id);
  if (ids.length === 0) return true;
  const live = await provider.liveThreads!(ids);
  if (live.length > 0 && !again) log.info(`following ${live.length} ${provider.profile.displayName} thread${live.length === 1 ? "" : "s"} it still has open`);
  // With those whose turn was running as the bridge stopped and has ended since: loaded,
  // the end is told as any turn's is (`leftRunning`).
  const following = new Set([...live, ...leftRunning(name, registry)]);
  // All at once: one slow to load held up those after it, and Hermes interrupts a turn
  // 20 s after its client went.
  const loaded = await Promise.all(
    [...following].map(async (id) => {
      try {
        await sessions.load(id);
        return true;
      } catch (error) {
        if (again) log.debug("could not follow a thread again yet", { thread: id, error: (error as Error).message });
        else log.warn("could not follow a thread again; it is tried again", { thread: id, error: (error as Error).message });
        return false;
      }
    }),
  );
  return loaded.every(Boolean);
}

/**
 * The threads of the agent `name` whose turn was running when the bridge stopped (their
 * record says `inTurn`). Loading one tells a turn that ended while the bridge was down
 * (a crash, a restart) as any turn's end is: the thread unseen, and a notification
 * (2026-10-26: "Notify + mark unseen"). The load clears `inTurn` as it tells it,
 * so a turn is told once, and a turn that ended while the bridge ran is never one of them.
 */
function leftRunning(name: string, registry: Registry): string[] {
  return registry.all().filter((record) => record.agent === name && record.inTurn === true).map((record) => record.id);
}

/** Loads `leftRunning`'s threads, for an agent that cannot be asked which threads it runs. */
async function followLeftRunning(name: string, registry: Registry, sessions: SessionManager): Promise<void> {
  await Promise.all(
    leftRunning(name, registry).map((id) =>
      sessions.load(id).catch((error: Error) => log.warn("could not load a thread whose turn ran as the bridge stopped", { thread: id, error: error.message })),
    ),
  );
}

/**
 * `followLive` again, a second later and then less often, up to a minute apart, until
 * the agent answers and every thread it runs is followed, or the bridge stops; the
 * messages waiting in its threads are sent once it has answered (`sendWaitingAgain`).
 */
async function followOnceAnswered(name: string, provider: Provider, registry: Registry, sessions: SessionManager, stopped: AbortSignal): Promise<void> {
  let sent = false;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
    try {
      await sleep(delay, undefined, { signal: stopped, ref: false });
    } catch {
      return;
    }
    if (stopped.aborted) return;
    let followed: boolean;
    try {
      followed = await followLive(name, provider, registry, sessions, true);
    } catch {
      // Not yet: said once, when it was first asked.
      continue;
    }
    // A thread whose message waited behind a turn that ended while the bridge was away
    // could not be loaded either while the agent did not answer, and no longer runs: its
    // message has its turn now, not only once the app opens the thread. Once the agent
    // answers, whether or not a thread it runs could be loaded; one that cannot be loaded
    // then (the agent went again meanwhile) is tried again a few times.
    if (!sent && !stopped.aborted) {
      sent = true;
      if (!(await sessions.sendWaiting(name, true))) void sendWaitingAgain(name, sessions, stopped);
    }
    if (followed) return;
  }
}

/**
 * For an agent that keeps one ongoing conversation (feature bot_chat): its conversation
 * on the list and its other threads off it (`SessionManager.keepOngoing`), asked again a
 * second later and then less often, up to a minute apart, until the agent answers or the
 * bridge stops.
 */
async function keepOngoingOnceAnswered(name: string, provider: Provider, sessions: SessionManager, stopped: AbortSignal): Promise<void> {
  for (let delay = 1000, said = false; !stopped.aborted; delay = Math.min(delay * 2, 60_000)) {
    try {
      await sessions.keepOngoing(name);
      return;
    } catch (error) {
      if (!said) log.warn(`could not ask ${provider.profile.displayName} where it keeps its conversation; it is asked again until it answers`, { error: (error as Error).message });
      said = true;
    }
    try {
      await sleep(delay, undefined, { signal: stopped, ref: false });
    } catch {
      return;
    }
  }
}

/** How many times an agent's threads with messages waiting are tried again, over about six minutes, before they wait for the app to open them. */
const waitingTries = 10;

/**
 * Loads the agent's threads with messages waiting that could not be loaded (`sendWaiting`)
 * again, a second later and then less often, up to a minute apart, `waitingTries` times
 * at most, or until the bridge stops: a load can fail for a moment (a connection that
 * dropped), and the message then waited until the app opened its thread. One that never
 * loads (its file cannot be read) is not read again for good.
 */
async function sendWaitingAgain(name: string, sessions: SessionManager, stopped: AbortSignal): Promise<void> {
  for (let tries = 0, delay = 1000; tries < waitingTries; tries += 1, delay = Math.min(delay * 2, 60_000)) {
    try {
      await sleep(delay, undefined, { signal: stopped, ref: false });
    } catch {
      return;
    }
    if (stopped.aborted || (await sessions.sendWaiting(name, true))) return;
  }
  log.warn("a thread with messages waiting could not be loaded; they wait until the thread is opened", { agent: name });
}
