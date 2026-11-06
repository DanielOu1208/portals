import { homedir } from "node:os";
import type { Paths } from "../config.ts";
import { recentUsage } from "../gateway/methods.ts";
import { log } from "../log.ts";
import { DroidStore } from "../providers/droid/store.ts";
import type { Provider } from "../providers/types.ts";
import type { SessionManager } from "../sessions/manager.ts";
import type { Registry, ThreadRecord } from "../sessions/registry.ts";
import { startUsageBook, type RunningUsageBook, type UsageBookOptions } from "./book.ts";
import type { UsageParts } from "./history.ts";
import { LimitLog, LimitSampler, watchLimits } from "./limits.ts";
import { Prices } from "./prices.ts";
import { PortalsSessions, usageAgent, type SessionAlias, type ThreadSeed } from "./sessions.ts";

// Token analytics in the running host (docs/plans/2026-11-06-token-analytics.md): the book
// that reads the agents' history, the record of the sessions Portals ran that says which
// of it went through Portals, the price table, and the limit readings, put together for
// bridge.ts, which starts them once everything else is made and stops them first.
//
// The history read is the user's own: their home folder, as the agents' own overrides
// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) in the host's environment say. Tests give
// another home (test/environment.ts makes HOME a scratch folder and clears the overrides).

/** What a test may give instead of the usual. */
export interface UsageOptions extends Partial<Pick<UsageBookOptions, "home" | "env" | "inProcess" | "sources" | "timeZone" | "everyMs" | "pokeMs" | "saveEveryMs" | "clock" | "worker">> {
  /** How the price list is fetched: tests give one that never reaches the network. */
  fetch?: typeof fetch;
  /** How long after the start the price list is first looked at (a minute). */
  pricesAfterMs?: number;
  /** For the limit readings asked while a thread runs: how far apart (15 minutes), and how often it looks (a minute). */
  sampleEveryMs?: number;
  sampleCheckMs?: number;
}

export interface RunningUsage extends UsageParts {
  sessions: PortalsSessions;
  sampler: LimitSampler;
  /** A thread put on the list (`Registry.added`): its session is Portals' from when it was made or taken up. */
  threadAdded(record: ThreadRecord): void;
  stop(): Promise<void>;
}

export function startUsage(options: { paths: Paths; registry: Registry; sessions: SessionManager; providers: Map<string, Provider>; usage?: UsageOptions }): RunningUsage {
  const { paths, registry, sessions, providers } = options;
  const given = options.usage ?? {};
  const kindOf = (agent: string) => usageAgent(providers.get(agent)?.profile.kind ?? agent);
  const seedOf = (record: ThreadRecord): ThreadSeed[] => {
    const agent = kindOf(record.agent);
    return agent ? [{ id: record.id, agent, createdAt: record.createdAt, ...(record.readOnly ? { readOnly: true } : {}) }] : [];
  };
  // Droid's threads go on in sessions of Droid's own ids (one after each /compact), which
  // only the host's record of each thread says.
  const droid = [...providers.values()].some((provider) => provider.profile.kind === "droid") ? new DroidStore(paths.droid) : undefined;
  const aliases = droid
    ? (): SessionAlias[] =>
        droid.mappings().map((mapping) => ({
          agent: "droid",
          thread: mapping.id,
          sessions: [...(mapping.formerSessions ?? []), ...(mapping.previousSession ? [mapping.previousSession] : []), mapping.session],
        }))
    : undefined;
  const portals = new PortalsSessions({ folder: paths.usage, clock: given.clock, aliases });
  if (portals.seed([...registry.all(), ...registry.allRemoved()].flatMap(seedOf))) log.info("usage: Portals' sessions noted from the threads", { sessions: portals.size });
  portals.refresh();

  const book: RunningUsageBook = startUsageBook({
    stateDir: paths.state,
    home: given.home ?? homedir(),
    env: given.env ?? process.env,
    via: portals.via,
    ...(given.clock ? { clock: given.clock } : {}),
    ...(given.inProcess ? { inProcess: true } : {}),
    ...(given.sources ? { sources: given.sources } : {}),
    ...(given.timeZone ? { timeZone: given.timeZone } : {}),
    ...(given.everyMs !== undefined ? { everyMs: given.everyMs } : {}),
    ...(given.pokeMs !== undefined ? { pokeMs: given.pokeMs } : {}),
    ...(given.saveEveryMs !== undefined ? { saveEveryMs: given.saveEveryMs } : {}),
    ...(given.worker ? { worker: given.worker } : {}),
  });

  const prices = new Prices({ stateDir: paths.state, ...(given.clock ? { clock: given.clock } : {}), ...(given.fetch ? { fetch: given.fetch } : {}) });
  // Not while the host starts, which has enough to do then; once a day after.
  const pricesLater = setTimeout(() => prices.start(), given.pricesAfterMs ?? 60_000);
  pricesLater.unref();

  const limits = new LimitLog({ folder: paths.usage, clock: given.clock });
  for (const provider of new Set(providers.values())) watchLimits(provider, limits);
  const sampler = new LimitSampler({
    running: () =>
      sessions.activity().flatMap((entry) => {
        if (entry.inherited) return [];
        const provider = providers.get(sessions.record(entry.session_id)?.agent ?? "");
        return provider ? [{ thread: entry.session_id, provider }] : [];
      }),
    ask: (provider, thread) => recentUsage(provider, thread),
    clock: given.clock,
    everyMs: given.sampleEveryMs,
    checkMs: given.sampleCheckMs,
  });
  sampler.start();

  sessions.listen({
    // A turn starting in a session not noted yet (one only read until it was continued) is Portals' from now.
    activityChanged: (id) => {
      const record = sessions.record(id);
      const agent = record && !record.readOnly ? kindOf(record.agent) : undefined;
      if (agent) portals.turn(agent, id);
    },
    // What the turn spent is in the agent's files now: read soon, with any new session a Droid thread went on in.
    turnEnded: () => {
      portals.refresh();
      book.poke();
    },
  });

  return {
    book,
    prices,
    limits,
    sessions: portals,
    sampler,
    threadAdded: (record) => {
      for (const seed of seedOf(record)) portals.thread(seed);
    },
    async stop() {
      clearTimeout(pricesLater);
      sampler.stop();
      prices.stop();
      await book.stop();
    },
  };
}
