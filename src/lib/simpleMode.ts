/**
 * Simple mode: what a brand-new owner sees (lean Today dashboard + a short menu). Pure and unit-tested.
 * Safe by construction: it only HIDES navigation entries (routes and permissions are untouched) and never applies to
 * accounts older than SIMPLE_MODE_DAYS, so existing customers keep the menu they know.
 */

export const SIMPLE_MODE_DAYS = 14;
export const SHOW_ALL_STORAGE_KEY = 'vireek.nav.showAll';

/** Overview + 11 destinations = 12 top-level entries. Every href must be both a route and a nav item (see simpleMode.test.ts). */
export const SIMPLE_NAV_HREFS = [
  '/dashboard',
  '/dashboard/getting-started',
  '/dashboard/calls',
  '/dashboard/calendar',
  '/dashboard/jobs',
  '/dashboard/customers',
  '/dashboard/quotes',
  '/dashboard/price-book',
  '/dashboard/phone-numbers',
  '/dashboard/team',
  '/dashboard/billing',
  '/dashboard/settings',
] as const;

const SIMPLE_SET: ReadonlySet<string> = new Set(SIMPLE_NAV_HREFS);

export function filterToSimpleNav<T extends { href: string }>(items: readonly T[]): T[] {
  return items.filter((i) => SIMPLE_SET.has(i.href));
}

export interface SimpleModeInput {
  isOwner: boolean;
  /** profiles.created_at (ISO). Missing/invalid → not simple (fail toward the full menu). */
  createdAt: string | null | undefined;
  now?: number;
  /** Tenant has the `full_navigation` feature flag on. */
  fullNavigationFlag: boolean;
  /** The person chose "Show all features". */
  showEverything: boolean;
}

export function isSimpleModeActive(i: SimpleModeInput): boolean {
  if (!i.isOwner || i.fullNavigationFlag || i.showEverything) return false;
  const created = i.createdAt ? Date.parse(i.createdAt) : Number.NaN;
  if (!Number.isFinite(created)) return false;
  const ageDays = ((i.now ?? Date.now()) - created) / 86_400_000;
  return ageDays >= 0 && ageDays < SIMPLE_MODE_DAYS;
}
