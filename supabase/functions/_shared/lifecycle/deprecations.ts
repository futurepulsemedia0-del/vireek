// supabase/functions/_shared/lifecycle/deprecations.ts
//
// Pure deprecation/sunset logic. No imports, no I/O, no clock reads (callers pass `nowMs`), so the same file is
// used by the Deno edge functions (api-v1 headers) and by the React app (in-app banner), and is tested in Vitest.
// The data lives in ./registry.ts; the policy (notice periods, communication steps, data export) is
// docs/product/lifecycle-policy.md. Keep the two in sync: MIN_NOTICE_DAYS below IS the policy's table.

export const DEPRECATION_KINDS = ['api_resource', 'api_version', 'route', 'feature', 'integration', 'setting'] as const;
export type DeprecationKind = (typeof DEPRECATION_KINDS)[number];

/** Which minimum notice applies. `forced` = a third party or a security/legal necessity leaves less time; needs `forcedReason`. */
export const NOTICE_CLASSES = ['stable', 'beta', 'integration', 'forced'] as const;
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

/** Minimum days between `announcedAt` and `sunsetAt`. `stable` must never be shorter than the published API policy (90 days). */
export const MIN_NOTICE_DAYS: Readonly<Record<NoticeClass, number>> = { stable: 90, beta: 30, integration: 60, forced: 0 };

/** From this many days before the sunset the in-app banner can no longer be dismissed. */
export const URGENT_DAYS = 14;
/** Most banners shown at once (the dashboard already carries several). */
export const MAX_BANNERS = 2;

export interface DeprecationMessages {
  title: string;
  summary: string;
}

export interface DeprecationBannerConfig {
  enabled: boolean;
  /** Show only from this many days before the sunset (default: from the announcement). */
  showFromDaysBeforeSunset?: number;
  /** Only on these dashboard paths (exact or child paths). Default: everywhere in the dashboard. */
  routePrefixes?: readonly string[];
  /** Default 'all'. 'owner' = account owners only (for settings that only owners can change). */
  audience?: 'all' | 'owner';
}

export interface DeprecationDataExport {
  /** True when customers keep data in the thing being removed. */
  holdsCustomerData: boolean;
  /** In-app path where the customer exports it (e.g. '/dashboard/exports'). Required when holdsCustomerData, unless `note` explains. */
  exportRoute?: string;
  note?: string;
}

export interface DeprecationEntry {
  /** kebab-case, unique, never reused. */
  id: string;
  kind: DeprecationKind;
  noticeClass: NoticeClass;
  /** English. Short noun phrase, e.g. "Legacy call export". */
  title: string;
  /** English, one plain sentence telling customers what changes and what to do. */
  summary: string;
  /** Per-language overrides for the banner (keys are language codes such as "es"). Falls back to title/summary. */
  messages?: Readonly<Record<string, DeprecationMessages>>;
  /** Area from docs/OWNERS.md. */
  owner: string;
  /** YYYY-MM-DD (UTC): the day customers were first told. Not in the future. Notice is measured from here. */
  announcedAt: string;
  /** YYYY-MM-DD (UTC): removal happens on or after this day, never before. */
  sunsetAt: string;
  /** YYYY-MM-DD: the day removal actually shipped. Set it when it ships; the entry stays as history. */
  removedAt?: string;
  /** Required when noticeClass is 'forced': why the normal notice was impossible. */
  forcedReason?: string;
  replacement?: { label: string; route?: string; url?: string };
  /** https URL of the migration guide. Required for api_* kinds (it becomes the Link header). */
  migrationUrl?: string;
  dataExport: DeprecationDataExport;
  /** Required for api_resource ('calls' | 'leads' | 'jobs') and api_version ('*'); forbidden otherwise. */
  api?: { resource: string };
  banner?: DeprecationBannerConfig;
}

/** Shape consumed by api-v1's `deprecationHeaders` (kept compatible with the original `Deprecation` interface). */
export interface ApiDeprecationRecord {
  resource: string;
  deprecatedAt: string;
  sunsetAt: string;
  link: string;
}

export type DeprecationPhase = 'deprecated' | 'sunset_due' | 'removed';

const DAY_MS = 86_400_000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** UTC milliseconds for a real YYYY-MM-DD date, else null (rejects 2026-02-30 and any other format). */
export function parseIsoDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : null;
}

/** Whole days from `fromMs` to `toMs` (rounded to the nearest day; both are UTC midnights in practice). */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / DAY_MS);
}

/** https only; no whitespace, quotes, angle brackets or control characters (it ends up in a Link header and in an href). */
export function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  if (/[\s"'<>\\^`{|}\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname.length > 0 && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/** An in-app path: starts with a single "/", no scheme, no protocol-relative "//", no whitespace or control characters. */
export function isSafeAppRoute(value: unknown): value is string {
  return typeof value === 'string' && /^\/(?!\/)[^\s\\\u0000-\u001f\u007f]*$/.test(value) && value.length <= 512;
}

export function deprecationPhase(entry: Pick<DeprecationEntry, 'sunsetAt' | 'removedAt'>, nowMs: number): DeprecationPhase {
  if (entry.removedAt) return 'removed';
  const sunset = parseIsoDate(entry.sunsetAt);
  return sunset !== null && nowMs >= sunset ? 'sunset_due' : 'deprecated';
}

/** Days left until the sunset day starts (0 on the sunset day, negative afterwards). */
export function daysUntilSunset(entry: Pick<DeprecationEntry, 'sunsetAt'>, nowMs: number): number {
  const sunset = parseIsoDate(entry.sunsetAt);
  if (sunset === null) return Number.POSITIVE_INFINITY;
  return Math.ceil((sunset - nowMs) / DAY_MS);
}

export function isUrgent(entry: Pick<DeprecationEntry, 'sunsetAt'>, nowMs: number): boolean {
  return daysUntilSunset(entry, nowMs) <= URGENT_DAYS;
}

/** The banner copy for a language: exact code, then its base ("es-MX" -> "es"), then the English fields. */
export function localizedCopy(entry: Pick<DeprecationEntry, 'title' | 'summary' | 'messages'>, language: string | undefined): DeprecationMessages {
  const lang = (language ?? '').toLowerCase();
  const pick = (code: string): DeprecationMessages | undefined => {
    const hit = entry.messages?.[code];
    return hit && hit.title.trim() && hit.summary.trim() ? hit : undefined;
  };
  return pick(lang) ?? pick(lang.split('-')[0] ?? '') ?? { title: entry.title, summary: entry.summary };
}

/** Exact or child path match: "/dashboard/billing" matches "/dashboard/billing" and "/dashboard/billing/plans", not "/dashboard/billing-x". */
export function matchesRoute(pathname: string, prefixes: readonly string[] | undefined): boolean {
  if (!prefixes || prefixes.length === 0) return true;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return prefixes.some((raw) => {
    const prefix = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    return prefix === '/' || path === prefix || path.startsWith(`${prefix}/`);
  });
}

export interface BannerContext {
  nowMs: number;
  pathname: string;
  isOwner: boolean;
}

/** Entries to show as banners right now: enabled, not removed, inside the display window, on a matching route and audience. Most urgent first. */
export function selectBannerEntries(entries: readonly DeprecationEntry[], ctx: BannerContext, max: number = MAX_BANNERS): DeprecationEntry[] {
  return entries
    .filter((e) => {
      if (!e.banner?.enabled) return false;
      if (deprecationPhase(e, ctx.nowMs) === 'removed') return false;
      if (parseIsoDate(e.announcedAt) === null || parseIsoDate(e.sunsetAt) === null) return false; // fail closed on bad data
      if (parseIsoDate(e.announcedAt)! > ctx.nowMs) return false;
      if (e.banner.audience === 'owner' && !ctx.isOwner) return false;
      if (!matchesRoute(ctx.pathname, e.banner.routePrefixes)) return false;
      const from = e.banner.showFromDaysBeforeSunset;
      if (typeof from === 'number' && daysUntilSunset(e, ctx.nowMs) > from) return false;
      return true;
    })
    .sort((a, b) => daysUntilSunset(a, ctx.nowMs) - daysUntilSunset(b, ctx.nowMs) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, max));
}

/** Header-ready list for api-v1: entries that target the API and have not been removed yet. */
export function apiDeprecationList(entries: readonly DeprecationEntry[]): ApiDeprecationRecord[] {
  const out: ApiDeprecationRecord[] = [];
  for (const e of entries) {
    if (!e.api || e.removedAt) continue;
    if (parseIsoDate(e.announcedAt) === null || parseIsoDate(e.sunsetAt) === null) continue;
    out.push({ resource: e.api.resource, deprecatedAt: `${e.announcedAt}T00:00:00Z`, sunsetAt: `${e.sunsetAt}T00:00:00Z`, link: e.migrationUrl ?? '' });
  }
  return out;
}

export interface ValidateOptions {
  /** Midnight UTC of "today". `announcedAt` may not be later than this. */
  todayMs: number;
  /** Resource names api-v1 really serves; an api entry must target one of these or '*'. */
  knownApiResources: readonly string[];
}

/** Every problem in the registry, as readable strings. Empty = valid. Run in CI (deprecations.test.ts). */
export function validateRegistry(entries: readonly DeprecationEntry[], opts: ValidateOptions): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const apiTargets = new Map<string, string>();
  for (const e of entries) {
    const at = `[${e.id || '(no id)'}]`;
    const bad = (msg: string) => problems.push(`${at} ${msg}`);

    if (!SLUG_RE.test(e.id ?? '')) bad('id must be kebab-case (a-z, 0-9, "-")');
    else if (ids.has(e.id)) bad('duplicate id (ids are never reused)');
    else ids.add(e.id);

    if (!(DEPRECATION_KINDS as readonly string[]).includes(e.kind)) bad(`kind must be one of ${DEPRECATION_KINDS.join(', ')}`);
    if (!(NOTICE_CLASSES as readonly string[]).includes(e.noticeClass)) bad(`noticeClass must be one of ${NOTICE_CLASSES.join(', ')}`);
    if (!e.title?.trim() || e.title.length > 80) bad('title is required, at most 80 characters');
    if (!e.summary?.trim() || e.summary.length > 240) bad('summary is required, at most 240 characters');
    if (!e.owner?.trim()) bad('owner is required (an area from docs/OWNERS.md)');
    for (const [lang, m] of Object.entries(e.messages ?? {})) {
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(lang)) bad(`messages key "${lang}" is not a language code`);
      if (!m?.title?.trim() || m.title.length > 80 || !m?.summary?.trim() || m.summary.length > 240) bad(`messages.${lang} needs a title (<=80) and summary (<=240)`);
    }

    const announced = parseIsoDate(e.announcedAt);
    const sunset = parseIsoDate(e.sunsetAt);
    if (announced === null) bad('announcedAt must be a real date as YYYY-MM-DD');
    if (sunset === null) bad('sunsetAt must be a real date as YYYY-MM-DD');
    if (announced !== null && announced > opts.todayMs) bad('announcedAt is in the future: add the entry on the day customers are told');
    if (announced !== null && sunset !== null) {
      const notice = daysBetween(announced, sunset);
      const min = MIN_NOTICE_DAYS[e.noticeClass];
      if (sunset <= announced) bad('sunsetAt must be after announcedAt');
      else if (min !== undefined && notice < min) bad(`notice is ${notice} days; the ${e.noticeClass} class needs at least ${min} (docs/product/lifecycle-policy.md)`);
    }
    if (e.noticeClass === 'forced' && !e.forcedReason?.trim()) bad('forcedReason is required for a forced deprecation');
    if (e.removedAt !== undefined) {
      const removed = parseIsoDate(e.removedAt);
      if (removed === null) bad('removedAt must be a real date as YYYY-MM-DD');
      else {
        if (sunset !== null && removed < sunset) bad('removedAt is before sunsetAt: nothing may be removed before its sunset');
        if (removed > opts.todayMs) bad('removedAt is in the future');
      }
    }

    if (e.migrationUrl !== undefined && !isSafeHttpsUrl(e.migrationUrl)) bad('migrationUrl must be a plain https URL');
    if (e.replacement) {
      if (!e.replacement.label?.trim()) bad('replacement.label is required');
      if (e.replacement.route !== undefined && !isSafeAppRoute(e.replacement.route)) bad('replacement.route must be an in-app path starting with a single "/"');
      if (e.replacement.url !== undefined && !isSafeHttpsUrl(e.replacement.url)) bad('replacement.url must be a plain https URL');
      if (!e.replacement.route && !e.replacement.url) bad('replacement needs a route or a url');
    }

    const dx = e.dataExport;
    if (!dx || typeof dx.holdsCustomerData !== 'boolean') bad('dataExport.holdsCustomerData must be true or false (decide explicitly)');
    else {
      if (dx.exportRoute !== undefined && !isSafeAppRoute(dx.exportRoute)) bad('dataExport.exportRoute must be an in-app path starting with a single "/"');
      if (dx.holdsCustomerData && !dx.exportRoute && !dx.note?.trim()) bad('customers keep data here: give dataExport.exportRoute, or dataExport.note explaining how they get it out before the sunset');
    }

    const isApi = e.kind === 'api_resource' || e.kind === 'api_version';
    if (isApi) {
      const r = e.api?.resource;
      if (!r) bad('api.resource is required for api_* kinds');
      else {
        if (e.kind === 'api_version' && r !== '*') bad('an api_version deprecation targets api.resource "*"');
        if (e.kind === 'api_resource' && !opts.knownApiResources.includes(r)) bad(`api.resource "${r}" is not an api-v1 resource (${opts.knownApiResources.join(', ')})`);
        if (!e.removedAt) {
          const prior = apiTargets.get(r);
          if (prior) bad(`api.resource "${r}" is already deprecated by [${prior}]: one live entry per target`);
          else apiTargets.set(r, e.id);
        }
      }
      if (!e.migrationUrl) bad('migrationUrl is required for api_* kinds (it is sent as the Link header)');
    } else if (e.api) bad('api is only allowed for api_resource and api_version kinds');

    const b = e.banner;
    if (b) {
      if (typeof b.enabled !== 'boolean') bad('banner.enabled must be true or false');
      if (b.showFromDaysBeforeSunset !== undefined && !(Number.isInteger(b.showFromDaysBeforeSunset) && b.showFromDaysBeforeSunset >= 1 && b.showFromDaysBeforeSunset <= 365)) bad('banner.showFromDaysBeforeSunset must be a whole number of 1-365');
      for (const p of b.routePrefixes ?? []) if (!isSafeAppRoute(p)) bad(`banner.routePrefixes entry "${p}" must be an in-app path starting with a single "/"`);
      if (b.audience !== undefined && b.audience !== 'all' && b.audience !== 'owner') bad('banner.audience must be "all" or "owner"');
    }
  }
  return problems;
}
