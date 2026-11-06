import type { RunningUsageBook } from "./book.ts";
import type { LimitLog } from "./limits.ts";
import type { Prices } from "./prices.ts";
import { Calendar } from "./store.ts";

// What `usage.history` answers (docs/plans/2026-11-06-token-analytics.md, section 4): a
// range of the host's days as the book keeps them, snake_case like the rest of the wire.
// The dollars are worked out here, from the prices of now, so a price fixed later applies
// to all of history; a model the table does not have is null, not nothing.

/** The most days one answer covers. */
export const longestHistoryDays = 400;

/** What the host's usage is read from: the book, the price table and the limit readings. */
export interface UsageParts {
  book: RunningUsageBook;
  prices: Prices;
  limits: LimitLog;
}

/** A day as "YYYY-MM-DD", as milliseconds of its midnight in UTC; undefined for one that is not a day. */
export function dayNumber(day: unknown): number | undefined {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const at = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  // Not one the calendar turned into another ("2026-02-30").
  return new Date(at).toISOString().slice(0, 10) === day ? at : undefined;
}

/**
 * The sentence for a range that cannot be answered, or undefined for one that can:
 * `from` and `to` days, `from` not after `to`, at most `longestHistoryDays` of them.
 */
export function historyRangeProblem(from: unknown, to: unknown): string | undefined {
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (start === undefined || end === undefined) return 'from and to are days, as "YYYY-MM-DD".';
  if (start > end) return "from is after to.";
  if ((end - start) / 86_400_000 + 1 > longestHistoryDays) return `At most ${longestHistoryDays} days are asked for at once.`;
  return undefined;
}

/** Rounded to a millionth of a dollar: what the sums can say. */
function dollars(usd: number | null): number | null {
  return usd === null || !Number.isFinite(usd) ? null : Math.round(usd * 1e6) / 1e6;
}

/** `usage.history`'s answer for days `from` to `to`, inclusive, which `historyRangeProblem` found fine. */
export function historyAnswer(parts: UsageParts, from: string, to: string): Record<string, unknown> {
  const { book, prices, limits } = parts;
  const scan = book.scan();
  const calendar = new Calendar(book.timeZone);
  // A day before `from` and after `to` in UTC holds every moment of those days in any zone; the calendar says which are.
  const start = dayNumber(from)! - 86_400_000;
  const end = dayNumber(to)! + 2 * 86_400_000;
  const inRange = (at: number) => {
    const [day] = calendar.at(at);
    return day >= from && day <= to;
  };
  return {
    time_zone: book.timeZone,
    agents: book.agents,
    scan: {
      scanning: scan.scanning,
      ...(scan.progress !== undefined ? { progress: scan.progress } : {}),
      ...(scan.scannedAt !== undefined ? { scanned_at: scan.scannedAt } : {}),
    },
    days: book.days(from, to).map((row) => ({
      day: row.day,
      agent: row.agent,
      model: row.model,
      folder: row.folder,
      via: row.via,
      input: row.input,
      output: row.output,
      cache_read: row.cacheRead,
      cache_write: row.cacheWrite,
      cache_write_1h: row.cacheWrite1h,
      reasoning: row.reasoning,
      requests: row.requests,
      usd: dollars(prices.cost(row.model, row)),
    })),
    hours: book.hours(from, to).map((row) => ({ day: row.day, agent: row.agent, via: row.via, tokens: row.tokens })),
    limits: limits
      .between(start, end)
      .filter((reading) => inRange(reading.at))
      .map((reading) => ({
        at: reading.at,
        agent: reading.agent,
        name: reading.name,
        percent: reading.percent,
        resets_at: reading.resetsAt,
        ...(reading.windowSeconds ? { window_seconds: reading.windowSeconds } : {}),
      })),
    prices_at: prices.at > 0 ? prices.at : null,
  };
}
