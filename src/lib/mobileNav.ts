export type BottomNavKey = 'overview' | 'jobs' | 'calls' | 'inbox';

export interface BottomNavItem {
  key: BottomNavKey;
  href: string;
  defaultLabel: string;
  /** Extra route prefixes that should also highlight this tab. */
  alsoMatches?: readonly string[];
}

export const BOTTOM_NAV_ITEMS: readonly BottomNavItem[] = [
  { key: 'overview', href: '/dashboard', defaultLabel: 'Overview' },
  { key: 'jobs', href: '/dashboard/jobs', defaultLabel: 'Jobs' },
  {
    key: 'calls',
    href: '/dashboard/calls',
    defaultLabel: 'Calls',
    alsoMatches: ['/dashboard/live-calls', '/dashboard/voicemails'],
  },
  { key: 'inbox', href: '/dashboard/inbox', defaultLabel: 'Inbox' },
];

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** Which bottom tab owns this pathname (null → only "More" territory). */
export function getBottomNavActiveKey(pathname: string): BottomNavKey | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/dashboard') return 'overview';
  for (const item of BOTTOM_NAV_ITEMS) {
    if (item.key === 'overview') continue;
    if ([item.href, ...(item.alsoMatches ?? [])].some((p) => matchesPrefix(path, p))) return item.key;
  }
  return null;
}
