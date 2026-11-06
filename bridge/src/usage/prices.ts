import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { readJSON, writeBytes } from "../store/jsonFile.ts";
import type { ModelPrice, TokenCounts } from "./types.ts";

// What the tokens would cost at the providers' API prices (docs/plans/2026-11-06-token-analytics.md):
// an estimate to show beside the counts, not anyone's bill. The prices are LiteLLM's
// public list (`model_prices_and_context_window.json`), trimmed to the models these
// agents use: `prices.json` beside this file, made by `scripts/prices.ts` at each
// release and shipped with the host. Once a day the host fetches the same list again
// (nothing is sent, it is a plain download) and keeps the trimmed copy in
// `state/usage/prices.json`; a fetch that fails, is too big or does not look like the
// list leaves the table it had.
//
// A model is found by its name as the agent wrote it, made plain first: provider prefixes
// ("anthropic/", "us.anthropic."), a context window in brackets ("[1m]"), and a date
// after the name when the list has the model without it. A model the list does not have
// has no price: its tokens are counted and shown as unpriced, never priced as another.

/** LiteLLM's list. */
export const pricesUrl = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** The list is about 3.5 MB; anything far bigger is not it. */
const largestList = 24 * 1024 * 1024;
const fetchMs = 30_000;
const dayMs = 24 * 60 * 60_000;

/**
 * The providers whose models the agents run: Anthropic's and OpenAI's own, and the main
 * ones Pi and Droid reach. Each provider's own names only, not its resellers'.
 */
const providers = new Set(["anthropic", "openai", "xai", "gemini", "deepseek", "moonshot", "zai", "minimax", "mistral", "xiaomi_mimo", "dashscope"]);
/** Vertex's names for Gemini models without a provider prefix, which the Gemini API's list lacks. */
const vertexGemini = "vertex_ai-language-models";
const modes = new Set(["chat", "responses"]);

/** A price per million tokens: input, output, cache read, cache write, cache write for an hour; null where the list has none. */
export type PriceEntry = [input: number, output: number, cacheRead: number | null, cacheWrite: number | null, cacheWrite1h: number | null];

/** The table as kept, in prices.json and state/usage/prices.json. */
export interface PriceFile {
  v: 1;
  /** When the list was fetched, ISO. */
  at: string;
  source: string;
  /** By the model's plain name (`modelKey`), per million tokens. */
  perMillion: Record<string, PriceEntry>;
}

/** A model's name made plain, as the table is keyed. */
export function modelKey(name: string): string {
  let key = name.trim().toLowerCase();
  if (key.startsWith("custom:")) key = key.slice("custom:".length);
  key = key.replace(/\[[^\]]*\]/g, "");
  key = key.replace(/@(\d{8})$/, "-$1").replace(/@.*$/, "");
  key = key.slice(key.lastIndexOf("/") + 1);
  key = key.replace(/^(?:us|eu|apac|global|us-gov|jp|au|ca)\./, "");
  key = key.replace(/^(?:anthropic|openai|moonshotai|moonshot|zai|xai|deepseek|qwen|mistral|google|minimax)\./, "");
  key = key.replace(/-v\d+(?::\d+)?$/, "");
  return key.trim();
}

/** The names a model may be under in the table, the plainest last. */
function candidates(name: string): string[] {
  const key = modelKey(name);
  const found = [key];
  const undated = key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  if (undated !== key) found.push(undated);
  // Anthropic's names have hyphens where some agents write dots ("claude-sonnet-4.5").
  for (const one of [...found]) if (one.startsWith("claude-") && /\d\.\d/.test(one)) found.push(one.replace(/(\d)\.(\d)/g, "$1-$2"));
  for (const one of [...found]) if (one.endsWith("-latest")) found.push(one.slice(0, -"-latest".length));
  return found;
}

/**
 * LiteLLM's list trimmed to what the agents use, per million tokens. Throws when the list
 * does not look like LiteLLM's: too few models, or none of Anthropic's or OpenAI's.
 */
export function trimPrices(list: unknown, at: number): PriceFile {
  if (list === null || typeof list !== "object" || Array.isArray(list)) throw new Error("the price list is not an object");
  const kept = new Map<string, { entry: PriceEntry; bare: boolean }>();
  for (const [name, value] of Object.entries(list as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const model = value as Record<string, unknown>;
    const provider = model.litellm_provider;
    if (typeof provider !== "string") continue;
    const ours = providers.has(provider) || (provider === vertexGemini && name.startsWith("gemini-"));
    if (!ours || (model.mode !== undefined && !modes.has(String(model.mode)))) continue;
    if (name.startsWith("ft:") || /(?:audio|realtime|image|tts|transcribe|embedding|search-preview)/.test(name)) continue;
    const input = perMillion(model.input_cost_per_token);
    const output = perMillion(model.output_cost_per_token);
    if (input === null || output === null) continue;
    const entry: PriceEntry = [input, output, perMillion(model.cache_read_input_token_cost), perMillion(model.cache_creation_input_token_cost), perMillion(model.cache_creation_input_token_cost_above_1hr)];
    const key = modelKey(name);
    if (!key) continue;
    // A provider's own name ("gpt-5.5") over its prefixed one ("openai/gpt-5.5").
    const bare = !name.includes("/");
    const before = kept.get(key);
    if (before && (before.bare || !bare)) continue;
    kept.set(key, { entry, bare });
  }
  // A dated name priced as its undated one adds nothing: the lookup finds the undated one.
  for (const [key, { entry }] of [...kept]) {
    const undated = key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
    if (undated !== key && kept.has(undated) && JSON.stringify(kept.get(undated)!.entry) === JSON.stringify(entry)) kept.delete(key);
  }
  const keys = [...kept.keys()].sort();
  if (keys.length < 50 || !keys.some((key) => key.startsWith("claude-")) || !keys.some((key) => key.startsWith("gpt-"))) {
    throw new Error("the price list does not look like LiteLLM's");
  }
  const table: Record<string, PriceEntry> = {};
  for (const key of keys) table[key] = kept.get(key)!.entry;
  return { v: 1, at: new Date(at).toISOString(), source: pricesUrl, perMillion: table };
}

/** A price file's text: one model a line, so a release's change to it reads as a diff of models. */
export function priceFileText(file: PriceFile): string {
  const lines = Object.entries(file.perMillion).map(([key, entry]) => `  ${JSON.stringify(key)}: ${JSON.stringify(entry)}`);
  return `{\n "v": 1,\n "at": ${JSON.stringify(file.at)},\n "source": ${JSON.stringify(file.source)},\n "perMillion": {\n${lines.join(",\n")}\n }\n}\n`;
}

/** Fetches LiteLLM's list: a plain GET, bounded in time and size. */
export async function fetchPriceList(url = pricesUrl, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(fetchMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`the price list answered ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > largestList) throw new Error("the price list is too big");
  if (!response.body) throw new Error("the price list is empty");
  const pieces: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > largestList) {
      await reader.cancel().catch(() => undefined);
      throw new Error("the price list is too big");
    }
    pieces.push(value);
  }
  return JSON.parse(Buffer.concat(pieces).toString("utf8"));
}

/** What `counts` cost at `price`, in US dollars. Reasoning is inside the output, and priced there. */
export function costOf(price: ModelPrice, counts: Pick<TokenCounts, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">): number {
  const hour = Math.min(counts.cacheWrite1h, counts.cacheWrite);
  return (
    counts.input * price.input +
    counts.output * price.output +
    counts.cacheRead * (price.cacheRead ?? price.input) +
    (counts.cacheWrite - hour) * (price.cacheWrite ?? price.input) +
    // Anthropic's hour-long cache costs twice the input where the list does not say.
    hour * (price.cacheWrite1h ?? price.input * 2)
  );
}

export interface PricesOptions {
  /** The host's state folder; the fetched table is kept in `usage/prices.json` there. */
  stateDir: string;
  clock?: () => number;
  fetch?: typeof fetch;
  url?: string;
  /** The shipped table; prices.json beside this file when not given (tests). */
  bundled?: PriceFile;
}

/** The price table: the shipped one, or a newer one fetched since. */
export class Prices {
  private readonly path: string;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly url: string;
  private table = new Map<string, ModelPrice>();
  private found = new Map<string, ModelPrice | null>();
  private tableAt = 0;
  private triedAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<boolean> | undefined;

  constructor(options: PricesOptions) {
    this.path = join(options.stateDir, "usage", "prices.json");
    this.clock = options.clock ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.url = options.url ?? pricesUrl;
    const bundled = options.bundled ?? readBundled();
    if (bundled) this.use(bundled);
    const fetched = readJSON<unknown>(this.path, undefined);
    if (isPriceFile(fetched) && Date.parse(fetched.at) > this.tableAt) this.use(fetched);
  }

  /** When the table was fetched from the list (milliseconds), for the wire's `prices_at`. */
  get at(): number {
    return this.tableAt;
  }

  /** A model's price; null when the list does not have it. */
  price(model: string): ModelPrice | null {
    const known = this.found.get(model);
    if (known !== undefined) return known;
    let price: ModelPrice | null = null;
    for (const key of candidates(model)) {
      const hit = this.table.get(key);
      if (hit) {
        price = hit;
        break;
      }
    }
    if (this.found.size > 10_000) this.found.clear();
    this.found.set(model, price);
    return price;
  }

  /**
   * The name the table has `model` under, its plain name; null when it has no price. What
   * leaves the host names a model only so (telemetry.ts): a name as the agent wrote it can
   * carry more than the model ("custom:", a provider prefix of someone's own).
   */
  known(model: string): string | null {
    for (const key of candidates(model)) if (this.table.has(key)) return key;
    return null;
  }

  /** What `counts` of `model` cost, in US dollars; null when the model has no price. */
  cost(model: string, counts: Pick<TokenCounts, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">): number | null {
    const price = this.price(model);
    return price ? costOf(price, counts) : null;
  }

  /** Fetches the list if the table is a day old and none was tried in the last day. Never throws. */
  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const now = this.clock();
    if (now - this.tableAt < dayMs || now - this.triedAt < dayMs) return Promise.resolve(false);
    this.triedAt = now;
    this.refreshing = (async () => {
      try {
        const file = trimPrices(await fetchPriceList(this.url, this.fetcher), this.clock());
        writeBytes(this.path, () => Buffer.from(priceFileText(file)));
        this.use(file);
        return true;
      } catch (error) {
        log.info("usage: the price list could not be fetched; the table the host has stays", { why: (error as Error).message });
        return false;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** Refreshes now if due, and once an hour looks again whether a day has passed. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 60 * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private use(file: PriceFile): void {
    const table = new Map<string, ModelPrice>();
    for (const [key, entry] of Object.entries(file.perMillion)) {
      const price: ModelPrice = { input: entry[0] / 1e6, output: entry[1] / 1e6 };
      if (entry[2] !== null) price.cacheRead = entry[2] / 1e6;
      if (entry[3] !== null) price.cacheWrite = entry[3] / 1e6;
      if (entry[4] !== null) price.cacheWrite1h = entry[4] / 1e6;
      table.set(key, price);
    }
    this.table = table;
    this.found = new Map();
    this.tableAt = Date.parse(file.at) || 0;
  }
}

/** The shipped table, from prices.json beside this file. */
export function readBundled(): PriceFile | undefined {
  try {
    const file: unknown = JSON.parse(readFileSync(new URL("./prices.json", import.meta.url), "utf8"));
    return isPriceFile(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

function isPriceFile(value: unknown): value is PriceFile {
  if (value === null || typeof value !== "object") return false;
  const file = value as Partial<PriceFile>;
  if (file.v !== 1 || typeof file.at !== "string" || !Number.isFinite(Date.parse(file.at))) return false;
  if (file.perMillion === null || typeof file.perMillion !== "object") return false;
  return Object.values(file.perMillion).every(
    (entry) => Array.isArray(entry) && entry.length === 5 && entry.every((part, index) => (index < 2 ? typeof part === "number" && part >= 0 : part === null || (typeof part === "number" && part >= 0))),
  );
}

/** A price per token as a price per million; null for anything that is not a price. */
function perMillion(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  // Rounded to what the list can say, so 3e-6 is 3 and not 2.9999999999999996.
  return Math.round(value * 1e6 * 1e6) / 1e6;
}
