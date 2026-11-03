import { log } from "./log.ts";
import { readJSON, writeJSON } from "./store/jsonFile.ts";

// Whether a newer portals-host is out (feature update_notice, docs/gateway-protocol.md
// section 11). Nothing updates a person's bridge by itself: TestFlight and the App Store
// update the app, and the bridge is updated only when the person runs
// `npx portals-host@latest update` on its computer. So the bridge asks npm's registry for
// the version tagged latest when it starts and about once a day after, never more often,
// across restarts too (`state/update.json` says when it last asked), and reads nothing but
// that version. When it is later than the bridge's own, devices are told: `gateway.ready`'s
// `bridge` block and the `sessions.activity` answer carry it as `latest`, and `poll.now`
// tells the devices that ask as it comes. Offline, or on any error, it says nothing and
// asks again a day later. `updates.check` false in config.json: it never asks.

/** The version of portals-host npm's `latest` tag names (the package's whole package.json, of which only `version` is read). */
export const registryURL = "https://registry.npmjs.org/portals-host/latest";

/** How often the registry is asked: once a day. */
export const checkEveryMs = 24 * 60 * 60 * 1000;

/** How long an answer may take before the check gives up until the next. */
const answerMs = 15_000;

/** More than a package.json ever weighs: an answer larger than this is not read. */
const mostBytes = 1024 * 1024;

const semver = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Which of two versions comes later, by semver's order: negative when `a` is earlier,
 * 0 when they are the same (build metadata aside), positive when `a` is later; undefined
 * when either is not a version.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const x = semver.exec(a.trim());
  const y = semver.exec(b.trim());
  if (!x || !y) return undefined;
  for (let part = 1; part <= 3; part++) {
    const [p, q] = [BigInt(x[part]), BigInt(y[part])];
    if (p !== q) return p < q ? -1 : 1;
  }
  // A pre-release comes before its release: 0.3.0-beta.1 < 0.3.0.
  const [preA, preB] = [x[4], y[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const [idsA, idsB] = [preA.split("."), preB.split(".")];
  for (let index = 0; index < Math.min(idsA.length, idsB.length); index++) {
    const order = compareIdentifiers(idsA[index], idsB[index]);
    if (order !== 0) return order;
  }
  return Math.sign(idsA.length - idsB.length);
}

/** Numbers by their value and before words; words by their characters. */
function compareIdentifiers(a: string, b: string): number {
  const [numberA, numberB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (numberA && numberB) {
    const [p, q] = [BigInt(a), BigInt(b)];
    return p === q ? 0 : p < q ? -1 : 1;
  }
  if (numberA !== numberB) return numberA ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Whether `latest` is a version later than `own`; false when either is not a version. */
export function isNewer(latest: string, own: string): boolean {
  return (compareVersions(latest, own) ?? 0) > 0;
}

/** What `state/update.json` keeps: when the registry was last asked, and the latest version it named then or before. */
interface Kept {
  checked?: unknown;
  latest?: unknown;
}

/** What `file` keeps; nothing for one that is missing, is not JSON, or is not such an object (`null`, a list). */
function readKept(file: string): Kept {
  const kept = readJSON<unknown>(file, {});
  return kept !== null && typeof kept === "object" && !Array.isArray(kept) ? (kept as Kept) : {};
}

/** The latest version the registry named, as `file` (`state/update.json`) keeps it; undefined for none (`portals-host status`). */
export function lastHeard(file: string): string | undefined {
  return versionIn(readKept(file));
}

function versionIn({ latest }: Kept): string | undefined {
  return typeof latest === "string" && compareVersions(latest, latest) !== undefined ? latest : undefined;
}

export interface UpdateCheckOptions {
  /** This bridge's version. */
  own: string;
  /** `state/update.json`. */
  file: string;
  /** The registry's address for the latest version (tests give their own server's). */
  url?: string;
  /** How often to ask, in ms (tests). */
  everyMs?: number;
  /** How long an answer may take, in ms (tests). */
  answerMs?: number;
  /** The clock (tests). */
  now?: () => number;
  /** Asks (tests). */
  fetch?: typeof fetch;
  /** What devices are told changed: a newer version came out, or is no longer newer. */
  changed?: () => void;
}

export class UpdateCheck {
  private readonly options: UpdateCheckOptions;
  private readonly everyMs: number;
  private readonly now: () => number;
  /** The latest version the registry named, whether or not it is newer than this bridge. */
  private named: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly stopping = new AbortController();
  /** The check under way, if any (tests wait for it). */
  private asking: Promise<void> | undefined;

  constructor(options: UpdateCheckOptions) {
    this.options = options;
    this.everyMs = options.everyMs ?? checkEveryMs;
    this.now = options.now ?? Date.now;
  }

  /** The later version that is out, when there is one; what devices are told. */
  get latest(): string | undefined {
    return this.named !== undefined && isNewer(this.named, this.options.own) ? this.named : undefined;
  }

  /**
   * Takes what the last check found, and asks now, unless it asked less than a day ago:
   * then once that day is over. A check said to be in the future (the clock was set back)
   * is taken as one made now, and kept so: a restart does not put the next off again.
   */
  start(): void {
    const kept = readKept(this.options.file);
    this.named = versionIn(kept);
    const checked = typeof kept.checked === "string" ? Date.parse(kept.checked) : Number.NaN;
    const since = this.now() - checked;
    if (since < 0) {
      this.keep();
      this.askIn(this.everyMs);
    } else if (Number.isNaN(since) || since >= this.everyMs) {
      this.ask(true);
    } else {
      this.askIn(this.everyMs - since);
    }
    if (this.latest) log.info(`portals-host ${this.latest} is out; this is ${this.options.own}. To update, run: npx portals-host@latest update`);
  }

  /** Asks no more, and lets go of an answer still coming. */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stopping.abort();
  }

  /** The check under way, if any. */
  get settled(): Promise<void> {
    return this.asking ?? Promise.resolve();
  }

  private askIn(ms: number): void {
    if (this.stopping.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.ask(), ms);
    this.timer.unref();
  }

  /** Asks the registry now; `starting`, as the bridge starts. */
  private ask(starting = false): void {
    if (this.stopping.signal.aborted) return;
    this.timer = undefined;
    // Kept before asking: a bridge that stops while it asks, again and again, still asks
    // once a day. One that cannot keep it does not ask as it starts, since the next start
    // would not know it had: it asks once it has run a day.
    if (!this.keep() && starting) {
      this.askIn(this.everyMs);
      return;
    }
    this.asking = this.fetchLatest().then((named) => {
      this.asking = undefined;
      if (this.stopping.signal.aborted) return;
      if (named !== undefined && named !== this.named) {
        const before = this.latest;
        this.named = named;
        this.keep();
        if (this.latest !== before) {
          if (this.latest) log.info(`portals-host ${this.latest} is out; this is ${this.options.own}. To update, run: npx portals-host@latest update`);
          this.options.changed?.();
        }
      }
      this.askIn(this.everyMs);
    });
  }

  /** The version the registry names as latest, or undefined when it could not be asked or said none. Never throws. */
  private async fetchLatest(): Promise<string | undefined> {
    try {
      const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(this.options.answerMs ?? answerMs)]);
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? registryURL, { headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error(`the registry answered ${response.status}`);
      if (Number(response.headers.get("content-length") ?? 0) > mostBytes) throw new Error("the registry's answer is too large");
      const text = await response.text();
      if (text.length > mostBytes) throw new Error("the registry's answer is too large");
      const version = (JSON.parse(text) as { version?: unknown } | null)?.version;
      if (typeof version !== "string" || compareVersions(version, version) === undefined) throw new Error("the registry named no version");
      return version.trim();
    } catch (error) {
      // Offline, a registry that is down, an answer that is not one: nothing to say.
      if (!this.stopping.signal.aborted) log.debug("could not ask npm's registry for the latest portals-host", { error: (error as Error)?.message ?? String(error) });
      return undefined;
    }
  }

  /** Keeps that the registry is asked now, with what it named last; whether that could be written. */
  private keep(): boolean {
    try {
      writeJSON(this.options.file, { checked: new Date(this.now()).toISOString(), latest: this.named ?? null } satisfies Kept);
      return true;
    } catch (error) {
      log.debug("could not keep when npm's registry was asked", { error: (error as Error).message });
      return false;
    }
  }
}
