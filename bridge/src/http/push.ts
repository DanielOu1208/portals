import { threadIDPattern } from "../sessions/registry.ts";
import { notificationKinds, type NotificationKind } from "../push/notifier.ts";
import { deviceKey } from "../push/seal.ts";
import type { PushStore, Registration } from "../push/store.ts";

// The push routes the app calls (docs/gateway-protocol.md, section 10), checked the way
// the plugin checks them. A bad field rejects the whole request with 422.

const tokenPattern = /^[0-9a-fA-F]{32,200}$/;
const bundlePattern = /^[A-Za-z0-9.-]{1,200}$/;
const relayTokenPattern = /^[A-Za-z0-9._-]{1,1000}$/;
/** 32 bytes in base64. */
const keyPattern = /^[A-Za-z0-9+/]{43}=$/;

export class InvalidRegistration extends Error {}

/** A registration body, or `InvalidRegistration` saying what is wrong with it. */
export function parseRegistration(body: unknown): Registration {
  if (!isObject(body)) throw new InvalidRegistration("The body must be a JSON object.");
  const registration: Registration = { threads: [] };

  if (body.device !== undefined && body.device !== null) {
    const device = body.device;
    if (!isObject(device)) throw new InvalidRegistration("device must be an object.");
    if (typeof device.token !== "string" || !tokenPattern.test(device.token)) {
      throw new InvalidRegistration("device.token must be 32 to 200 hexadecimal characters.");
    }
    if (typeof device.bundle_id !== "string" || !bundlePattern.test(device.bundle_id)) {
      throw new InvalidRegistration("device.bundle_id must be 1 to 200 letters, digits, dots or dashes.");
    }
    const environment = device.environment ?? "sandbox";
    if (typeof environment !== "string") throw new InvalidRegistration("device.environment must be a string.");
    registration.device = { token: device.token, bundle_id: device.bundle_id, environment };
    // Sent only to a bridge that lists `push_relay` and `push_sealed` (docs/pairing-and-relay.md).
    if (device.relay_token !== undefined && device.relay_token !== null) {
      if (typeof device.relay_token !== "string" || !relayTokenPattern.test(device.relay_token)) {
        throw new InvalidRegistration("device.relay_token must be the token the relay gave, up to 1000 characters.");
      }
      registration.device.relay_token = device.relay_token;
    }
    if (device.key !== undefined && device.key !== null) {
      if (typeof device.key !== "string" || !keyPattern.test(device.key) || !deviceKey(device.key)) {
        throw new InvalidRegistration("device.key must be 32 bytes in base64.");
      }
      registration.device.key = device.key;
    }
    // Sent only to a bridge that lists `push_muting`: the kinds the device wants none of.
    if (device.muted !== undefined && device.muted !== null) {
      if (!Array.isArray(device.muted) || device.muted.some((kind) => typeof kind !== "string" || !notificationKinds.includes(kind as NotificationKind))) {
        throw new InvalidRegistration(`device.muted must be a list of ${notificationKinds.join(", ")}.`);
      }
      registration.device.muted = [...new Set(device.muted as NotificationKind[])].sort();
    }
  }

  const threads = body.threads ?? [];
  if (!Array.isArray(threads)) throw new InvalidRegistration("threads must be a list.");
  if (threads.length > 2000) throw new InvalidRegistration("At most 2000 threads can be registered at once.");
  for (const thread of threads) {
    if (!isObject(thread)) throw new InvalidRegistration("Each thread must be an object.");
    if (typeof thread.id !== "string" || !threadIDPattern.test(thread.id)) {
      throw new InvalidRegistration("Each thread id must be 1 to 200 letters, digits or the characters _ . : -");
    }
    const text = (key: string): string => {
      const value = thread[key] ?? "";
      if (typeof value !== "string") throw new InvalidRegistration(`threads[].${key} must be a string.`);
      return value;
    };
    registration.threads.push({ id: thread.id, agent: text("agent"), agent_name: text("agent_name"), title: text("title") });
  }

  if (body.host !== undefined && body.host !== null) {
    if (typeof body.host !== "string" || body.host.length > 200) throw new InvalidRegistration("host must be a string of at most 200 characters.");
    registration.host = body.host;
  }
  return registration;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PushResponse {
  status: number;
  body: unknown;
}

/**
 * Answers one push route, or returns undefined when `method` and `path` are not one.
 * `path` is after `/api/plugins/aeriportal-push/`. `member`: the net member that signed
 * in with its token, whose registration is kept under its id.
 */
export function handlePush(store: PushStore, method: string, path: string, body: unknown, member?: string): PushResponse | undefined {
  if (path === "registration" && method === "PUT") {
    let registration: Registration;
    try {
      registration = parseRegistration(body);
    } catch (error) {
      if (error instanceof InvalidRegistration) return { status: 422, body: { detail: error.message } };
      throw error;
    }
    return { status: 200, body: store.summary(store.register(registration, member)) };
  }
  if (path.startsWith("threads/") && method === "DELETE") {
    const scoped = /^threads\/[^/]+\/watcher$/.test(path);
    let id: string;
    try {
      id = decodeURIComponent(path.slice("threads/".length, scoped ? -"/watcher".length : undefined));
    } catch {
      return { status: 422, body: { detail: "The thread id is not valid." } };
    }
    if (!threadIDPattern.test(id)) return { status: 422, body: { detail: "The thread id is not valid." } };
    if (scoped) {
      if (!isObject(body) || typeof body.device_token !== "string" || !tokenPattern.test(body.device_token)) {
        return { status: 422, body: { detail: "device_token must be 32 to 200 hexadecimal characters." } };
      }
      return { status: 200, body: store.summary(store.removeWatcher(id, body.device_token)) };
    }
    return { status: 200, body: store.summary(store.unwatch(id)) };
  }
  if (path === "status" && method === "GET") {
    // Feature push_watcher, for an app that asks before it has connected: the route that
    // stops notifying one device (`threads/{id}/watcher`) is here.
    return { status: 200, body: { ...store.summary(store.state()), features: ["watcher"] } };
  }
  return undefined;
}
