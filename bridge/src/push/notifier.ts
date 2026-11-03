import { log } from "../log.ts";
import type { OpenRequest } from "../sessions/broker.ts";
import type { SessionListener, TurnStatus } from "../sessions/session.ts";
import type { Sender, SendResult } from "./apns.ts";
import { sealed } from "./seal.ts";
import type { DeviceEntry, PushState, PushStore, ThreadEntry } from "./store.ts";

// When the app is told about a thread, and in what words: a port of the Hermes plugin's
// `compose()` and `Notifier` (hermes-plugin/aeriportal-push/core.py), so a notification
// from the bridge reads like one from Hermes and the app handles both alike
// (docs/gateway-protocol.md, section 10).
//
// - An approval or a question notifies as soon as it is put to the app; a turn when it
//   finishes or fails. An interrupted turn never does.
// - Only threads the app registered, and only to the devices that registered them.
// - The same approval or question for a thread notifies once a minute at most: an agent
//   asking again after a reconnect asks nothing new.
// - The payload is the plugin's, plus `aeriportal.host`: the id the app gave this bridge
//   when the device registered, so a tap opens the thread on the right host.
// - To a device that gave a key, the words are sealed (seal.ts): Apple, and the relay if
//   it goes through one, see "Portals: New activity", and the app shows the real words.
//
// What happened is redacted and cut to a line before it leaves the Mac. Nothing here may
// hold up or break a turn: the session hands over an event and returns.

/** The longest preview a notification carries. */
export const previewLimit = 120;
/** Within this many seconds, the same approval or question for a thread notifies once. */
export const repeatWindow = 60;

export const notificationKinds = ["approval", "question", "finished", "failed"] as const;
export type NotificationKind = (typeof notificationKinds)[number];

export interface Payload {
  aps: {
    alert: { title: string; body: string; subtitle?: string };
    sound: "default";
    "thread-id": string;
    "mutable-content": 1;
  };
  /** `sealed`: the alert's words sealed to the device's key (seal.ts), when it gave one. */
  aeriportal: { thread: string; kind: NotificationKind; agent?: string; host?: string; sealed?: string };
}

/** What a notification is about, before it is worded. */
export interface NotificationEvent {
  kind: NotificationKind;
  /** The thread id, which is the session id. */
  thread: string;
  /** The command, the question, the reply or the error. */
  text: string;
}

// MARK: Words

// Where Python's `str.splitlines()` and `str.split()` break, so a preview is cut where the
// plugin cuts it.
const lineBreak = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const whitespace = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const trailingWhitespace = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

/**
 * A visual the reply shows (`portals guide visuals`; a widget at first), fence and HTML, from its opening
 * line to its closing one or the end of the text: the app shows a card in its place. (Under `m`, `$` is
 * the end of any line: a fence left open runs to the end of the text, `(?![\s\S])`.)
 */
const visualFence = /^ {0,3}(`{3,}|~{3,})[ \t]*portals-(?:visual|widget)(?![^\s])([^\n]*)(?:\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|(?![\s\S]))|$)/gm;

/** The text with each visual as "[Visual: its title]", so a reply that opens with one is not previewed as its fence. */
export function visualsNamed(text: string): string {
  return text.replace(visualFence, (_whole, _fence, info: string) => {
    const title = /(?:^|\s)title=(?:"([^"]*)"?|'([^']*)'?|(\S+))/.exec(info);
    const name = (title?.[1] ?? title?.[2] ?? title?.[3] ?? "").trim();
    return name ? `[Visual: ${name}]` : "[Visual]";
  });
}

/** A Markdown image, `![caption](path)`, its path between `<` and `>` or not, with or without a title. */
const markdownImage = /!\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** The text with each image the app shows in a reply (feature file_read) as "[Image: its caption]". */
export function imagesNamed(text: string): string {
  return text.replace(markdownImage, (_whole, caption: string) => {
    const name = caption.trim();
    return name ? `[Image: ${name}]` : "[Image]";
  });
}

/** The first line with something on it, its spaces collapsed, cut to `limit` characters. */
export function preview(text: unknown, limit = previewLimit): string {
  for (const raw of String(text ?? "").split(lineBreak)) {
    const line = raw.split(whitespace).filter(Boolean).join(" ");
    if (!line) continue;
    // Counted in code points, as Python counts.
    const characters = Array.from(line);
    if (characters.length <= limit) return line;
    return characters.slice(0, limit - 1).join("").replace(trailingWhitespace, "") + "…";
  }
  return "";
}

/** The notification for an event: the agent as title, the thread's title under it, and a short preview of what happened. */
export function compose(kind: string, threadID: string, thread: Partial<ThreadEntry>, text: unknown): Payload | null {
  const words = preview(redacted(imagesNamed(visualsNamed(String(text ?? "")))));
  let body: string;
  switch (kind) {
    case "approval":
      body = words ? `Wants to run: ${words}` : "Needs your approval";
      break;
    case "question":
      body = words || "Has a question for you";
      break;
    case "finished":
      body = words || "Finished";
      break;
    case "failed":
      body = words ? `Stopped with an error: ${words}` : "Stopped with an error";
      break;
    default:
      return null;
  }
  // Keys in the plugin's order, so the two serialize alike.
  const alert: Payload["aps"]["alert"] = { title: thread.agent_name || thread.agent || "Agent", body: preview(body, previewLimit + 30) };
  if (thread.title) alert.subtitle = preview(redacted(thread.title), 80);
  const details: Payload["aeriportal"] = { thread: threadID, kind };
  if (thread.agent) details.agent = String(thread.agent);
  // `mutable-content` hands it to the app's notification extension before it is shown,
  // which puts the agent's avatar on it; `aeriportal.agent` says whose.
  return { aps: { alert, sound: "default", "thread-id": threadID, "mutable-content": 1 }, aeriportal: details };
}

// MARK: Redaction

// Secrets an agent printed are masked before they reach Apple and a lock screen: the
// main shapes Hermes's own redaction (agent/redact.py, `redact_sensitive_text`) masks, in
// its order and with its mask (the first 6 and last 4 characters; `***` under 18).

const secretPrefixes = [
  String.raw`sk-[A-Za-z0-9_-](?:\.?[A-Za-z0-9_-]){9,}`, // OpenAI, Anthropic, and others
  String.raw`gh[pousr]_[A-Za-z0-9]{10,}`, // GitHub
  String.raw`github_pat_[A-Za-z0-9_]{10,}`,
  String.raw`xapp-\d+-[A-Za-z0-9-]{10,}`, // Slack
  String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
  String.raw`AIza[A-Za-z0-9_-]{30,}`, // Google
  String.raw`AKIA[A-Z0-9]{16}`, // AWS
  String.raw`[sr]k_(?:live|test)_[A-Za-z0-9]{10,}`, // Stripe
  String.raw`sk_[A-Za-z0-9_]{10,}`,
  String.raw`SG\.[A-Za-z0-9_-]{10,}`, // SendGrid
  String.raw`hf_[A-Za-z0-9]{10,}`, // Hugging Face
  String.raw`npm_[A-Za-z0-9]{10,}`,
  String.raw`pypi-[A-Za-z0-9_-]{10,}`,
  String.raw`gl(?:pat|oas|dt|cbt|ptt|ft|imt|agent|soat|ffct|wt)-[A-Za-z0-9_-]{10,}`, // GitLab
  String.raw`glrtr?-[A-Za-z0-9_.-]{10,}`,
  String.raw`gsk_[A-Za-z0-9]{10,}`, // Groq
  String.raw`xai-[A-Za-z0-9]{30,}`,
  String.raw`pplx-[A-Za-z0-9]{10,}`,
  String.raw`tvly-[A-Za-z0-9]{10,}`,
  String.raw`dop_v1_[A-Za-z0-9]{10,}`,
  String.raw`gAAAA[A-Za-z0-9_=-]{20,}`, // Codex's encrypted tokens
];
const prefixed = new RegExp(String.raw`(?<![A-Za-z0-9_-])(${secretPrefixes.join("|")})(?![A-Za-z0-9_-])`, "g");
const secretWord = String.raw`(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PW|CREDENTIAL|AUTH)`;
const environmentAssignment = new RegExp(String.raw`(?<![A-Za-z0-9_])([A-Z0-9_]{0,50}${secretWord}[A-Z0-9_]{0,50})\s*=\s*(['"]?)(\S+)\2`, "g");
/** The secret word ends the name or one of its `_` parts: `MYTOKEN`, `API_KEY_2`, not `KEYBOARD`. */
const secretName = new RegExp(String.raw`${secretWord}S?(?:_|$)`);
const authorizationHeader = /((?:Proxy-)?Authorization:\s*)([A-Za-z][\w.+-]*\s+)?([^\s"']+)/gi;
const secretHeader = /((?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)\s*:\s*)(\S+)/gi;
const privateKey = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g;
const databasePassword = /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s]+:)([^@\s]+)(@)/gi;
const urlToken = /((?:https?|wss?|git|ssh|ftp|ftps|sftp):\/\/)([^\s:@/]{8,})(@\S+)/gi;
// encodeURIComponent leaves apostrophes inside generated link values.
const portalsLink = /\bportals:\/\/[^\s"<>]+/gi;
const jwt = /eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_=-]{4,}){0,2}/g;

function mask(token: string): string {
  return token.length < 18 ? "***" : `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/** `text` with keys, tokens and passwords masked. */
export function redacted(text: unknown): string {
  let result = String(text ?? "");
  if (!result) return result;
  result = result.replace(prefixed, (token) => mask(token));
  result = result.replace(environmentAssignment, (whole, name: string, quote: string, value: string) => {
    // A variable, a path or a number is not a secret.
    if (!secretName.test(name) || /^[$~/]|^\d+$/.test(value)) return whole;
    return `${name}=${quote}${mask(value)}${quote}`;
  });
  result = result.replace(authorizationHeader, (_, header: string, scheme: string | undefined, value: string) => header + (scheme ?? "") + mask(value));
  result = result.replace(secretHeader, (_, header: string, value: string) => header + mask(value));
  result = result.replace(privateKey, "[REDACTED PRIVATE KEY]");
  result = result.replace(databasePassword, "$1***$3");
  result = result.replace(urlToken, (_, scheme: string, token: string, rest: string) => scheme + mask(token) + rest);
  // Pairing passwords and one-use join codes are credentials too, not ordinary URL text.
  result = result.replace(portalsLink, (link) => {
    // Adjacent Markdown links share a text token. Only the authority is needed
    // to check a host; reparsing each remaining suffix would be quadratic.
    // Keep the raw token: a literal scheme can also belong to a query value.
    const accepted = [...link.matchAll(/\bportals:\/\/(?=([^/?#]*))/gi)].some((match) => {
      try {
        const url = new URL(match[0] + match[1]);
        return url.hostname === "pair" || url.hostname === "join";
      } catch {
        return false;
      }
    });
    if (!accepted) return link;
    const parts: string[] = [];
    let copied = 0;
    // Scan parameter starts independently so a second URL inside a value is
    // masked too. Overlapping values are already covered by the earlier mask.
    for (const match of link.matchAll(/([?&])([^=&#?]+)=/g)) {
      if (match.index < copied) continue;
      const name = new URLSearchParams(`${match[2]}=`).keys().next().value;
      if (!name || !/^(?:password|code)$/i.test(name)) continue;
      const start = match.index + match[0].length;
      const end = link.slice(start).search(/[&#]/);
      parts.push(link.slice(copied, match.index), `${match[1]}${name}=***`);
      copied = end < 0 ? link.length : start + end;
    }
    parts.push(link.slice(copied));
    return parts.join("");
  });
  return result.replace(jwt, (token) => mask(token));
}

// MARK: Sending

export interface NotifierOptions {
  store: PushStore;
  sender: Sender;
  /** Unix seconds. */
  now?: () => number;
}

export class Notifier implements SessionListener {
  private readonly store: PushStore;
  private readonly sender: Sender;
  private readonly now: () => number;
  /** The last approval or question notified per thread and kind, and when. */
  private readonly asked = new Map<string, { body: string; at: number }>();
  private queue: Promise<void> = Promise.resolve();
  /**
   * Whether a net member is in the net still (the bridge's `Net.isMember`, set once the
   * net is made): a device registered by one that is not gets nothing, should its
   * registration not have been forgotten as it was removed (push.json could not be written).
   */
  inNet: (member: string) => boolean = () => true;

  constructor(options: NotifierOptions) {
    this.store = options.store;
    this.sender = options.sender;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  // MARK: From sessions

  requestOpened(sessionID: string, request: OpenRequest): void {
    // Put again after a restart of the bridge: it was notified when it was asked.
    if (request.again) return;
    const params = request.params;
    if (request.method === "approval") {
      this.submit({ kind: "approval", thread: sessionID, text: text(params.command) || text(params.description) });
    } else if (request.method === "clarify") {
      const first = Array.isArray(params.questions) ? (params.questions[0] as Record<string, unknown> | undefined) : undefined;
      this.submit({ kind: "question", thread: sessionID, text: typeof first === "object" && first !== null ? text(first.question) : "" });
    }
  }

  turnEnded(sessionID: string, status: TurnStatus, reply: string): void {
    // Stopped by hand, or the session closing: nothing to be told.
    if (status === "interrupted") return;
    this.submit({ kind: status === "error" ? "failed" : "finished", thread: sessionID, text: reply });
  }

  /** Resolves once everything handed over so far has been sent. */
  idle(): Promise<void> {
    return this.queue;
  }

  close(): void {
    this.sender.close();
  }

  private submit(event: NotificationEvent): void {
    // One at a time and in order, after the session has moved on.
    this.queue = this.queue
      .then(() => this.handle(event))
      .then(
        () => undefined,
        (error: Error) => log.warn("could not notify", { thread: event.thread, error: error.message }),
      );
  }

  /** Sends what the event calls for. Returns what happened per device. */
  async handle(event: NotificationEvent): Promise<SendResult[]> {
    const state = this.store.state();
    const thread = state.threads[event.thread];
    if (!thread) return [];
    const payload = compose(event.kind, event.thread, thread, event.text);
    if (!payload) return [];
    if (event.kind === "approval" || event.kind === "question") {
      const key = `${event.thread}\n${event.kind}`;
      const body = payload.aps.alert.body;
      const before = this.asked.get(key);
      if (before && before.body === body && this.now() - before.at < repeatWindow) return [];
      this.forgetOldQuestions();
      this.asked.set(key, { body, at: this.now() });
    }

    const results: SendResult[] = [];
    for (const token of Object.keys(devicesWatching(state, thread))) {
      // An earlier send may have waited while this member was removed or the thread unwatched.
      const current = this.store.state();
      const watched = current.threads[event.thread];
      const device = watched && devicesWatching(current, watched)[token];
      if (!device) continue;
      // Registered by a member taken out of the net since.
      if (device.member !== undefined && !this.inNet(device.member)) continue;
      // A kind the device asked not to have (`push_muting`).
      if (device.muted?.includes(event.kind)) continue;
      const result = await this.sender.send(token, device, forDevice(payload, device), `${event.thread}-${event.kind}`);
      if (result === "gone") this.store.dropDevice(token, device);
      results.push(result);
    }
    // What was notified about and how it went; never the words or the device.
    log.info(`notification: ${event.kind} for thread ${event.thread}: ${results.join(", ") || "no devices"}`);
    return results;
  }

  private forgetOldQuestions(): void {
    if (this.asked.size < 1000) return;
    for (const [key, { at }] of this.asked) {
      if (this.now() - at >= repeatWindow) this.asked.delete(key);
    }
  }
}

/** The devices to tell about a thread: the ones that registered it, or every device for a thread registered without one. */
export function devicesWatching(state: PushState, thread: ThreadEntry): Record<string, DeviceEntry> {
  const watchers = Array.isArray(thread.devices) ? thread.devices : [];
  if (watchers.length === 0) return { ...state.devices };
  return Object.fromEntries(watchers.filter((token) => token in state.devices).map((token) => [token, state.devices[token]]));
}

/** The payload for one device: naming this bridge as that device's app calls it, and sealed when the device gave a key. */
function forDevice(payload: Payload, device: DeviceEntry): Payload {
  const named = device.host ? { ...payload, aeriportal: { ...payload.aeriportal, host: device.host } } : payload;
  return device.key === undefined ? named : sealed(named, device.key);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
