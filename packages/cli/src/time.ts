import { usageError } from './errors.js';

const RELATIVE = /^(\d+)([smhdw])$/i;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/**
 * Accepts an ISO date/datetime ("2026-10-01", "2026-10-01T09:00:00Z") or a
 * relative age ("90m", "24h", "7d", "4w") and returns an ISO-8601 UTC string.
 * Date-only values are interpreted as UTC midnight.
 */
export function parseTimestamp(label: string, raw: string, now: number = Date.now()): string {
  const value = raw.trim();
  const relative = RELATIVE.exec(value);
  if (relative) {
    const unit = (relative[2] as string).toLowerCase() as keyof typeof UNIT_MS;
    return new Date(now - Number(relative[1]) * UNIT_MS[unit]).toISOString();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw usageError(
      `Invalid ${label} value "${raw}".`,
      'Use an ISO date (2026-10-01), a datetime (2026-10-01T09:00:00Z) or a relative age such as 24h, 7d or 4w.',
    );
  }
  return new Date(ms).toISOString();
}
