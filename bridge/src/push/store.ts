import { readJSON, writeJSON } from "../store/jsonFile.ts";
import type { NotificationKind } from "./notifier.ts";

// The devices to notify and the threads each one wants to hear about, in
// `state/push.json`. The same shape and rules as the `aeriportal-push` Hermes plugin
// (hermes-plugin/aeriportal-push/core.py, `Store`): registering only adds or updates,
// and a thread is watched by the devices that registered it. What is sent, and when, is
// in notifier.ts.

export interface DeviceEntry {
  environment: "production" | "sandbox";
  bundle_id: string;
  /** Which host the app calls this bridge, echoed back in notifications as `aeriportal.host`. */
  host?: string;
  /** From the relay, for sending through it when this bridge has no APNs key (docs/pairing-and-relay.md). */
  relay_token?: string;
  /** The key, base64, this device's notifications are sealed to (seal.ts). */
  key?: string;
  /** The kinds of notification the device wants none of (`push_muting`); absent for none. */
  muted?: NotificationKind[];
  /** The net member that registered it, signed in with its token: removed from the net, it is forgotten (src/net/net.ts). */
  member?: string;
  updated_at: number;
}

export interface ThreadEntry {
  agent: string;
  agent_name: string;
  title: string;
  /** Tokens of the devices that registered the thread. */
  devices: string[];
  updated_at: number;
}

export interface PushState {
  devices: Record<string, DeviceEntry>;
  threads: Record<string, ThreadEntry>;
}

export interface Registration {
  device?: { token: string; environment: string; bundle_id: string; relay_token?: string; key?: string; muted?: NotificationKind[] };
  threads: { id: string; agent: string; agent_name: string; title: string }[];
  host?: string;
}

export class PushStore {
  private readonly path: string;
  private readonly apnsConfigured: boolean;
  /**
   * Threads forgotten (`unwatch`, `forget`) that push.json may still list, because it
   * could not be read or written then: no state has them, so nobody is notified about
   * them, and the next write that succeeds takes them out of the file.
   */
  private readonly forgotten = new Set<string>();

  /** `apnsConfigured`: notifications can be sent (an APNs key or a relay), as the routes report. */
  constructor(path: string, options: { apnsConfigured?: boolean } = {}) {
    this.path = path;
    this.apnsConfigured = options.apnsConfigured ?? false;
  }

  state(): PushState {
    return this.read().state;
  }

  /**
   * What push.json holds, and whether it is there but could not be read now. Then the
   * state is empty, and writing it would leave the file with nothing of what it holds:
   * a registration and an unwatch refuse instead (`unread`), and the app registers again
   * at its next connect. A file that is missing or not JSON is a new one.
   */
  private read(): { state: PushState; unreadable: boolean } {
    let unreadable = false;
    const data = readJSON<Partial<PushState>>(this.path, {}, () => {
      unreadable = true;
      return {};
    });
    const threads = isRecord(data.threads) ? (data.threads as Record<string, ThreadEntry>) : {};
    for (const id of this.forgotten) delete threads[id];
    const devices = byLowerToken(isRecord(data.devices) ? (data.devices as Record<string, DeviceEntry>) : {});
    for (const thread of Object.values(threads)) {
      if (Array.isArray(thread?.devices)) thread.devices = [...new Set(thread.devices.map(tokenKey))];
    }
    return { state: { devices, threads }, unreadable };
  }

  /**
   * A device registers at every connect, mostly with what push.json already holds. Then
   * only the times would be new, which nothing reads, and the file is left as it is: an
   * entry's `updated_at` is when it last changed. `member`: the net member it came from,
   * signed in with its token, which the device's entry is kept under.
   */
  register(registration: Registration, member?: string): PushState {
    const { state, unreadable } = this.read();
    if (unreadable) throw unread();
    const now = Math.floor(Date.now() / 1000);
    const token = tokenKey(registration.device?.token ?? "");
    // A forgotten thread the file may still list leaves it at this write.
    let changed = this.forgotten.size > 0;
    if (registration.device) {
      const entry: DeviceEntry = {
        environment: registration.device.environment === "production" ? "production" : "sandbox",
        bundle_id: registration.device.bundle_id,
        updated_at: now,
      };
      if (registration.host) entry.host = registration.host;
      // Kept when a registration leaves them out: an app that could not reach the relay
      // this time still has the token it got before.
      const before = state.devices[token];
      const relayToken = registration.device.relay_token ?? before?.relay_token;
      if (relayToken) entry.relay_token = relayToken;
      const key = registration.device.key ?? before?.key;
      if (key) entry.key = key;
      // Kept too when left out: only an app that knows `push_muting` says, and an empty
      // list says the device wants every kind again.
      const muted = registration.device.muted ?? before?.muted;
      if (muted?.length) entry.muted = muted;
      const by = member ?? before?.member;
      if (by) entry.member = by;
      if (untimed(before) !== untimed(entry)) changed = true;
      state.devices[token] = entry;
    }
    for (const thread of registration.threads) {
      const before = untimed(state.threads[thread.id]);
      const watchers = state.threads[thread.id]?.devices ?? [];
      if (token && !watchers.includes(token)) watchers.push(token);
      const entry: ThreadEntry = {
        agent: thread.agent,
        agent_name: thread.agent_name || thread.agent,
        title: thread.title,
        devices: watchers,
        updated_at: now,
      };
      if (before !== untimed(entry)) changed = true;
      state.threads[thread.id] = entry;
    }
    if (changed) this.save(state);
    return state;
  }

  /** Nobody is to hear about the thread any more: at once, also when push.json cannot be read or written now. */
  unwatch(threadID: string): PushState {
    this.forgotten.add(threadID);
    const { state, unreadable } = this.read();
    if (unreadable) throw unread();
    this.save(state);
    return state;
  }

  /** A local unsubscribe, not a global unwatch. Legacy broadcasts have no individual watchers to remove. */
  removeWatcher(threadID: string, given: string): PushState {
    const token = tokenKey(given);
    const { state, unreadable } = this.read();
    if (unreadable) throw unread();
    const thread = state.threads[threadID];
    if (!thread?.devices?.includes(token)) return state;
    const watchers = thread.devices.filter((watcher) => watcher !== token);
    if (watchers.length) {
      thread.devices = watchers;
      thread.updated_at = Math.floor(Date.now() / 1000);
    } else {
      // An empty watcher list means broadcast, not nobody.
      delete state.threads[threadID];
    }
    this.save(state);
    return state;
  }

  /**
   * As `unwatch`, for a thread the bridge took off its list, but push.json is written only
   * when it lists the thread, and as it was read that once: one that cannot be read now is
   * left as it is rather than replaced by an empty one, and loses the thread at its next
   * write.
   */
  forget(threadID: string): void {
    const state = this.state();
    this.forgotten.add(threadID);
    if (!(threadID in state.threads)) return;
    delete state.threads[threadID];
    this.save(state);
  }

  /**
   * The devices the net members `members` registered, with the threads they watch: the
   * members were removed from the net. A thread no other device watched goes too (an
   * empty list of watchers would be every device's).
   */
  dropMembers(members: string[]): void {
    const { state, unreadable } = this.read();
    if (unreadable) throw unread();
    const tokens = Object.entries(state.devices).filter(([, device]) => device.member !== undefined && members.includes(device.member)).map(([token]) => token);
    if (tokens.length === 0) return;
    for (const token of tokens) delete state.devices[token];
    for (const [id, thread] of Object.entries(state.threads)) {
      if (!thread.devices.some((token) => tokens.includes(token))) continue;
      const watchers = thread.devices.filter((token) => !tokens.includes(token));
      if (watchers.length > 0) thread.devices = watchers;
      else delete state.threads[id];
    }
    this.save(state);
  }

  /** A device Apple says no longer takes notifications, unless it was registered again differently meanwhile. */
  dropDevice(given: string, sent?: DeviceEntry): PushState {
    const token = tokenKey(given);
    const state = this.state();
    if (!(token in state.devices)) return state;
    if (sent && untimed(state.devices[token]) !== untimed(sent)) return state;
    delete state.devices[token];
    this.save(state);
    return state;
  }

  /** Every write is of a `state()`, which leaves the forgotten threads out: once one is written, the file has none of them. */
  private save(state: PushState): void {
    writeJSON(this.path, state);
    this.forgotten.clear();
  }

  /** The answer the plugin gives to every route. */
  summary(state: PushState): { devices: number; threads: number; apns_configured: boolean } {
    return { devices: Object.keys(state.devices).length, threads: Object.keys(state.threads).length, apns_configured: this.apnsConfigured };
  }
}

/**
 * A device token as push.json keeps it: in lower case (net-21). The app sends lower case;
 * one that ever sent upper case would otherwise be two devices, notified twice.
 */
function tokenKey(token: string): string {
  return token.toLowerCase();
}

/**
 * The devices under their tokens in lower case. A file from before that has one device
 * under two cases keeps one entry: the newer, with what only the older had of what a
 * registration keeps when it leaves it out (its member, relay token and key), so a member
 * removed from the net still takes it away.
 */
function byLowerToken(devices: Record<string, DeviceEntry>): Record<string, DeviceEntry> {
  const kept: Record<string, DeviceEntry> = {};
  for (const [token, entry] of Object.entries(devices)) {
    const key = tokenKey(token);
    const other = kept[key];
    if (!other) {
      kept[key] = entry;
      continue;
    }
    const [newer, older] = (entry?.updated_at ?? 0) > (other?.updated_at ?? 0) ? [entry, other] : [other, entry];
    const merged: DeviceEntry = { ...newer };
    if (merged.member === undefined && older?.member !== undefined) merged.member = older.member;
    if (merged.relay_token === undefined && older?.relay_token !== undefined) merged.relay_token = older.relay_token;
    if (merged.key === undefined && older?.key !== undefined) merged.key = older.key;
    kept[key] = merged;
  }
  return kept;
}

/** Why push.json is not written: it is there, and what it holds could not be read. */
function unread(): Error {
  return new Error("push.json cannot be read now, so it is left as it is.");
}

/** An entry as text without its time, to tell whether a registration changes it; undefined for none. */
function untimed(entry: DeviceEntry | ThreadEntry | undefined): string | undefined {
  return entry && JSON.stringify({ ...entry, updated_at: 0 });
}

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
