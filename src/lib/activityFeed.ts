// Pure model for the user-facing "Account activity" list: merge, filter, CSV. No I/O.

export type ActivityCategory = 'signIn' | 'account' | 'apiKeys';
export type ActivityKind =
  | 'sign_in'
  | 'sign_in_new_device'
  | 'password_changed'
  | 'email_changed'
  | 'mfa_enrolled'
  | 'mfa_disabled'
  | 'recovery_codes_regenerated'
  | 'api_key_created'
  | 'api_key_revoked';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: string; // ISO
  /** Already-safe detail strings (device label, key name, factor type). Never secrets. */
  details: { device?: string; key?: string; factor?: string };
  acknowledged: boolean;
}

export const CATEGORY_OF: Record<ActivityKind, ActivityCategory> = {
  sign_in: 'signIn',
  sign_in_new_device: 'signIn',
  password_changed: 'account',
  email_changed: 'account',
  mfa_enrolled: 'account',
  mfa_disabled: 'account',
  recovery_codes_regenerated: 'account',
  api_key_created: 'apiKeys',
  api_key_revoked: 'apiKeys',
};

/** Kinds that should raise the "recent security change" banner while unacknowledged. */
export const BANNER_KINDS: readonly ActivityKind[] = ['password_changed', 'email_changed', 'mfa_disabled', 'recovery_codes_regenerated', 'api_key_created'];

export interface SecurityEventRowLike {
  id: string;
  event: string;
  occurred_at: string;
  meta: Record<string, unknown> | null;
  acknowledged_at: string | null;
}
export interface LoginEventRowLike {
  id: string;
  device_label: string | null;
  is_new_device: boolean | null;
  created_at: string;
}

const isKind = (v: string): v is ActivityKind => v in CATEGORY_OF && v !== 'sign_in' && v !== 'sign_in_new_device';
const text = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : undefined);

export function fromSecurityEvent(r: SecurityEventRowLike): ActivityItem | null {
  if (!isKind(r.event)) return null;
  const m = r.meta ?? {};
  return { id: `se:${r.id}`, kind: r.event, at: r.occurred_at, details: { key: text(m.key_name), factor: text(m.factor_type, 24) }, acknowledged: r.acknowledged_at !== null };
}

export function fromLoginEvent(r: LoginEventRowLike): ActivityItem {
  return { id: `le:${r.id}`, kind: r.is_new_device ? 'sign_in_new_device' : 'sign_in', at: r.created_at, details: { device: text(r.device_label, 80) }, acknowledged: true };
}

export function mergeActivity(...lists: ActivityItem[][]): ActivityItem[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((i) => !seen.has(i.id) && !Number.isNaN(Date.parse(i.at)) && seen.add(i.id))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface ActivityFilters {
  category: ActivityCategory | 'all';
  rangeDays: 7 | 30 | 90 | 'all';
}

export function filterActivity(items: ActivityItem[], f: ActivityFilters, nowMs: number): ActivityItem[] {
  const cutoff = f.rangeDays === 'all' ? -Infinity : nowMs - f.rangeDays * 86_400_000;
  return items.filter((i) => (f.category === 'all' || CATEGORY_OF[i.kind] === f.category) && Date.parse(i.at) >= cutoff);
}

/** Items that should currently raise the banner: unacknowledged, banner-worthy, within 14 days. */
export function bannerItems(items: ActivityItem[], nowMs: number): ActivityItem[] {
  return items.filter((i) => !i.acknowledged && BANNER_KINDS.includes(i.kind) && nowMs - Date.parse(i.at) <= 14 * 86_400_000);
}

/** Neutralises spreadsheet formula injection (=, +, -, @, tab, CR) and quotes per RFC 4180. */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(items: ActivityItem[], labelOf: (k: ActivityKind) => string, headers: { time: string; event: string; details: string }): string {
  const rows = items.map((i) => [new Date(i.at).toISOString().slice(0, 19).replace('T', ' '), labelOf(i.kind), [i.details.device, i.details.key, i.details.factor].filter(Boolean).join(' · ')]);
  return [[headers.time, headers.event, headers.details], ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
