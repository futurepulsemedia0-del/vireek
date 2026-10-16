// Pure helpers for the "What's New" feed: stable release ids, unread rules, filtering.
// The release data itself stays in src/lib/changelog.ts (single source of truth shared with the
// public /changelog page and the RSS script); nothing here touches Supabase or React.
import type { ChangelogEntry, ChangelogRelease, EntryType } from '@/lib/changelog';

export interface Release {
  /** Stable id: the ISO date ("2026-09-06"), with "-2", "-3"... for same-day releases. */
  id: string;
  /** Human label as written in changelog.ts. */
  date: string;
  /** null when the label can't be parsed — such releases are shown but never counted as unread. */
  isoDate: string | null;
  entries: ChangelogEntry[];
}

export type TypeFilter = 'all' | EntryType;

/** Most releases that can ever count as unread, so the badge stays meaningful. */
export const MAX_UNREAD = 5;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "September 6, 2026" -> "2026-09-06". Rejects impossible dates such as "February 31, 2026". */
export function parseReleaseDate(label: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(label);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 0) return null;
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Adds ids and sorts newest first (undated releases keep their order, after the dated ones). */
export function buildReleases(raw: ChangelogRelease[]): Release[] {
  const seen = new Map<string, number>();
  const list: Release[] = raw.map((r, index) => {
    const isoDate = parseReleaseDate(r.date);
    const base = isoDate ?? `undated-${index}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, date: r.date, isoDate, entries: r.entries };
  });
  return list.sort((a, b) => {
    if (a.isoDate && b.isoDate) return a.isoDate < b.isoDate ? 1 : a.isoDate > b.isoDate ? -1 : 0;
    if (a.isoDate) return -1;
    if (b.isoDate) return 1;
    return 0;
  });
}

/**
 * Unread = among the newest `limit` releases that were published on/after the user's account was
 * created, those this user has not marked read. Brand-new accounts therefore start at zero, and
 * long-time users never see a badge of 40.
 */
export function unreadReleaseIds(
  releases: Release[],
  readIds: ReadonlySet<string>,
  opts: { accountCreatedAt?: string | null; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? MAX_UNREAD;
  const since = opts.accountCreatedAt ? opts.accountCreatedAt.slice(0, 10) : null;
  return releases
    .filter((r) => r.isoDate !== null && (since === null || r.isoDate >= since))
    .slice(0, limit)
    .filter((r) => !readIds.has(r.id))
    .map((r) => r.id);
}

/** Filters entries by type and (optionally) releases by id; releases left with no entries are dropped. */
export function filterReleases(releases: Release[], type: TypeFilter, onlyIds: ReadonlySet<string> | null): Release[] {
  return releases
    .map((r) => ({ ...r, entries: type === 'all' ? r.entries : r.entries.filter((e) => e.type === type) }))
    .filter((r) => r.entries.length > 0 && (onlyIds === null || onlyIds.has(r.id)));
}

export function countByType(releases: Release[]): Record<TypeFilter, number> {
  const counts: Record<TypeFilter, number> = { all: 0, new: 0, improved: 0, security: 0, fixed: 0 };
  for (const r of releases) {
    for (const e of r.entries) {
      counts.all += 1;
      counts[e.type] += 1;
    }
  }
  return counts;
}

export function badgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}
