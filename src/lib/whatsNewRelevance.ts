import type { ChangelogEntry } from '@/lib/changelog';

/** An entry with no `roles` is for everyone; otherwise only the listed roles (owners/admins always see all). */
export function isRelevantForRole(entry: Pick<ChangelogEntry, 'roles'>, role: string | null | undefined): boolean {
  if (!entry.roles || entry.roles.length === 0) return true;
  if (!role) return true;
  if (role === 'owner' || role === 'admin') return true;
  return entry.roles.includes(role);
}

/** Only same-origin app paths may be deep links. */
export function safeDeepLink(href: string | undefined): string | null {
  return href && /^\/[A-Za-z0-9/_?=&#.-]{0,198}$/.test(href) && !href.startsWith('//') ? href : null;
}
