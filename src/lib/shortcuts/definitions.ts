import type { ShortcutDef } from './registry';

/**
 * The ONE list of dashboard shortcuts. The key dispatcher, the Cmd+K palette
 * hints, the cheat-sheet and tooltips all read from here — never hard-code a
 * key combination anywhere else.
 *
 * Navigation entries carry their `href`, so adding a "go to X" shortcut needs
 * no handler code: `navigationHandlers()` derives it.
 */
const nav = (id: string, keys: string, defaultLabel: string, href: string): ShortcutDef => ({
  id: `nav.${id}`,
  binding: keys,
  category: 'navigation',
  defaultLabel,
  context: 'dashboard',
  href,
});

export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  // --- General -----------------------------------------------------------
  {
    id: 'palette.toggle',
    binding: 'mod+k',
    category: 'general',
    defaultLabel: 'Open search and commands',
    context: 'global',
    allowInInput: true,
    allowInDialog: true,
  },
  {
    id: 'palette.actions',
    binding: 'mod+shift+k',
    category: 'general',
    defaultLabel: 'Open commands (actions only)',
    context: 'global',
    allowInInput: true,
  },
  {
    id: 'help.shortcuts',
    binding: '?',
    category: 'general',
    defaultLabel: 'Show keyboard shortcuts',
    context: 'global',
  },

  // --- Navigation (hrefs match DashboardNav routes) -----------------------
  nav('overview', 'g o', 'Go to Overview', '/dashboard'),
  nav('calendar', 'g c', 'Go to Calendar', '/dashboard/calendar'),
  nav('jobs', 'g j', 'Go to My Jobs', '/dashboard/jobs'),
  nav('calls', 'g h', 'Go to Call History', '/dashboard/calls'),
  nav('voicemails', 'g v', 'Go to Voicemails', '/dashboard/voicemails'),
  nav('leads', 'g l', 'Go to Leads', '/dashboard/leads'),
  nav('analytics', 'g a', 'Go to Analytics', '/dashboard/analytics'),
  nav('insights', 'g i', 'Go to Insights', '/dashboard/insights'),
  nav('reviews', 'g r', 'Go to Reviews', '/dashboard/reviews'),
  nav('profile', 'g p', 'Go to Business Profile', '/dashboard/business-profile'),
  nav('team', 'g t', 'Go to Team', '/dashboard/team'),
  nav('billing', 'g b', 'Go to Billing', '/dashboard/billing'),
  nav('settings', 'g s', 'Go to Settings', '/dashboard/settings'),

  // --- Create (mirrors QUICK_ACTIONS in lib/globalSearch.ts) --------------
  {
    id: 'create.job',
    binding: 'c j',
    category: 'create',
    defaultLabel: 'Create job',
    context: 'dashboard',
    href: '/dashboard/jobs',
    state: { prefill: {} },
  },
  {
    id: 'create.quote',
    binding: 'c q',
    category: 'create',
    defaultLabel: 'Create quote',
    context: 'dashboard',
    href: '/dashboard/quotes?new=1',
  },
  {
    id: 'create.invite',
    binding: 'c t',
    category: 'create',
    defaultLabel: 'Invite teammate',
    context: 'dashboard',
    href: '/dashboard/team?invite=1',
  },
];

export const SHORTCUT_BY_ID: ReadonlyMap<string, ShortcutDef> = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

/** One handler per shortcut that has an `href` (navigation + create shortcuts). */
export function navigationHandlers(
  navigate: (href: string, opts?: { state?: unknown }) => void,
): Record<string, () => void> {
  const handlers: Record<string, () => void> = {};
  for (const def of SHORTCUT_DEFS) {
    if (!def.href) continue;
    const { href, state } = def;
    handlers[def.id] = () => navigate(href, state !== undefined ? { state } : undefined);
  }
  return handlers;
}
