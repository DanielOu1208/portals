// Days as "YYYY-MM-DD". The server's own days are UTC; a host's day is its local date,
// which is never ahead of the UTC date once that day has finished anywhere on Earth.

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = 86_400_000;

/** The UTC date of `ms` milliseconds since 1970. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whether `text` is a real calendar date, not only shaped like one ("2026-02-30" is not). */
export function isDay(text: string): boolean {
  if (!dayPattern.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) && utcDay(ms) === text;
}

/** The day `count` days after `day` (before it when negative). */
export function addDays(day: string, count: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + count * dayMs);
}
