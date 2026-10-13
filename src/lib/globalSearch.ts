/**
 * Pure helpers for the Cmd+K global search: types, routing, client-side
 * ranking for pages / quick actions, recent items, and match highlighting.
 * No React, no Supabase here, so everything is unit-testable.
 */

export type SearchEntityType =
  | 'customer'
  | 'job'
  | 'quote'
  | 'invoice'
  | 'equipment'
  | 'team'
  | 'knowledge'
  | 'lead'
  | 'call';

/** Row shape returned by the `global_search` Postgres RPC. */
export interface GlobalSearchRow {
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  subtitle: string | null;
  parent_id: string | null;
  status: string | null;
  score: number;
  created_at: string | null;
}

export interface GlobalSearchResult {
  key: string;
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle: string;
  status: string | null;
  href: string;
  score: number;
}

export const ENTITY_LABELS: Record<SearchEntityType, string> = {
  customer: 'Customers',
  job: 'Jobs',
  quote: 'Quotes',
  invoice: 'Invoices',
  equipment: 'Equipment',
  team: 'Team',
  knowledge: 'Knowledge',
  lead: 'Leads',
  call: 'Calls',
};

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 80;

export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

/** Where a search result navigates to. */
export function hrefForRow(row: Pick<GlobalSearchRow, 'entity_type' | 'entity_id' | 'parent_id'>): string {
  const id = encodeURIComponent(row.entity_id);
  switch (row.entity_type) {
    case 'customer':
      return `/dashboard/customers/${id}`;
    case 'equipment':
      // Equipment lives on its customer's page.
      return row.parent_id ? `/dashboard/customers/${encodeURIComponent(row.parent_id)}` : '/dashboard/customers';
    case 'job':
      return `/dashboard/jobs?job=${id}`;
    case 'quote':
      return '/dashboard/quotes';
    case 'invoice':
      return '/dashboard/invoicing';
    case 'team':
      return '/dashboard/team';
    case 'knowledge':
      return `/dashboard/knowledge?article=${id}`;
    case 'lead':
      return '/dashboard/leads';
    case 'call':
      return '/dashboard/calls';
  }
}

export function rowToResult(row: GlobalSearchRow): GlobalSearchResult {
  return {
    key: `${row.entity_type}:${row.entity_id}`,
    type: row.entity_type,
    id: row.entity_id,
    title: row.title,
    subtitle: row.subtitle ?? '',
    status: row.status,
    href: hrefForRow(row),
    score: row.score,
  };
}

export interface ResultGroup {
  type: SearchEntityType;
  label: string;
  items: GlobalSearchResult[];
}

/**
 * Groups results by type. Groups are ordered by their best-scoring item (so a
 * perfect "Invoice INV-0042" hit beats a weak customer hit), items inside a
 * group by score. Duplicate keys are dropped.
 */
export function groupResults(results: GlobalSearchResult[]): ResultGroup[] {
  const seen = new Set<string>();
  const byType = new Map<SearchEntityType, GlobalSearchResult[]>();
  for (const r of [...results].sort((a, b) => b.score - a.score)) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  return [...byType.entries()].map(([type, items]) => ({ type, label: ENTITY_LABELS[type], items }));
}

// ---------------------------------------------------------------------------
// Pages + quick actions (ranked on the client, instant, no network)
// ---------------------------------------------------------------------------

export type PagePermission = 'can_view_billing' | 'can_manage_team' | 'can_edit_business_profile';

export interface PaletteCommand {
  id: string;
  label: string;
  href: string;
  keywords?: string;
  permission?: PagePermission;
  /** Passed to react-router navigate(); used to open a page's create modal. */
  state?: unknown;
  kind: 'page' | 'action';
}

export const QUICK_ACTIONS: PaletteCommand[] = [
  { id: 'action:new-job', kind: 'action', label: 'New job', href: '/dashboard/jobs', keywords: 'create add schedule', state: { prefill: {} } },
  { id: 'action:new-quote', kind: 'action', label: 'New quote', href: '/dashboard/quotes?new=1', keywords: 'create add estimate proposal' },
  { id: 'action:new-article', kind: 'action', label: 'New knowledge article', href: '/dashboard/knowledge?new=1', keywords: 'create add faq answer' },
];

export const PAGES: PaletteCommand[] = [
  { id: 'page:overview', kind: 'page', label: 'Overview', href: '/dashboard', keywords: 'home dashboard' },
  { id: 'page:calls', kind: 'page', label: 'Call History', href: '/dashboard/calls', keywords: 'phone voicemail' },
  { id: 'page:leads', kind: 'page', label: 'Leads', href: '/dashboard/leads', keywords: 'pipeline prospects' },
  { id: 'page:customers', kind: 'page', label: 'Customers', href: '/dashboard/customers', keywords: 'contacts clients crm' },
  { id: 'page:jobs', kind: 'page', label: 'My Jobs', href: '/dashboard/jobs', keywords: 'work orders dispatch' },
  { id: 'page:calendar', kind: 'page', label: 'Calendar', href: '/dashboard/calendar', keywords: 'schedule appointments' },
  { id: 'page:quotes', kind: 'page', label: 'Quotes', href: '/dashboard/quotes', keywords: 'estimates proposals' },
  { id: 'page:invoicing', kind: 'page', label: 'Invoicing', href: '/dashboard/invoicing', keywords: 'invoices payments', permission: 'can_view_billing' },
  { id: 'page:knowledge', kind: 'page', label: 'Knowledge Base', href: '/dashboard/knowledge', keywords: 'articles faq answers' },
  { id: 'page:equipment', kind: 'page', label: 'Equipment Health', href: '/dashboard/equipment-health', keywords: 'hvac assets lifecycle' },
  { id: 'page:passports', kind: 'page', label: 'Equipment Passports', href: '/dashboard/equipment-passports', keywords: 'serial warranty' },
  { id: 'page:analytics', kind: 'page', label: 'Analytics', href: '/dashboard/analytics', keywords: 'reports metrics' },
  { id: 'page:insights', kind: 'page', label: 'Insights', href: '/dashboard/insights', keywords: 'ai recommendations' },
  { id: 'page:notifications', kind: 'page', label: 'Notifications', href: '/dashboard/notifications', keywords: 'alerts inbox' },
  { id: 'page:team', kind: 'page', label: 'Team', href: '/dashboard/team', keywords: 'staff technicians roles invite', permission: 'can_manage_team' },
  { id: 'page:billing', kind: 'page', label: 'Billing', href: '/dashboard/billing', keywords: 'plan subscription', permission: 'can_view_billing' },
  { id: 'page:integrations', kind: 'page', label: 'Integrations', href: '/dashboard/integrations', keywords: 'connect apps' },
  { id: 'page:profile', kind: 'page', label: 'Business Profile', href: '/dashboard/business-profile', keywords: 'settings company hours', permission: 'can_edit_business_profile' },
  { id: 'page:security', kind: 'page', label: 'Security settings', href: '/dashboard/settings/security', keywords: '2fa mfa audit password' },
];

/** 0 = no match. Exact > prefix > word-prefix > substring > keyword. */
export function scoreCommand(query: string, cmd: Pick<PaletteCommand, 'label' | 'keywords'>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = cmd.label.toLowerCase();
  if (label === q) return 1.2;
  if (label.startsWith(q)) return 1.0;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 0.8;
  if (label.includes(q)) return 0.6;
  if (cmd.keywords?.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))) return 0.45;
  return 0;
}

export type PermissionMap = Partial<Record<PagePermission, boolean>>;

export function rankCommands(
  query: string,
  commands: PaletteCommand[],
  permissions: PermissionMap,
  limit = 6,
): PaletteCommand[] {
  return commands
    .filter((c) => !c.permission || permissions[c.permission] === true)
    .map((c, index) => ({ c, s: scoreCommand(query, c), index }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.c);
}

// ---------------------------------------------------------------------------
// Recent items (per user, localStorage; failures are silent)
// ---------------------------------------------------------------------------

export interface RecentItem {
  key: string;
  kind: 'result' | 'command';
  type?: SearchEntityType;
  label: string;
  sublabel: string;
  href: string;
  state?: unknown;
}

export const MAX_RECENTS = 6;
const recentKey = (userId: string) => `vireek:cmdk:recent:${userId}`;

export function loadRecents(userId: string | undefined, storage: Pick<Storage, 'getItem'> = window.localStorage): RecentItem[] {
  if (!userId) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(recentKey(userId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is RecentItem => !!x && typeof x.key === 'string' && typeof x.href === 'string' && typeof x.label === 'string')
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function pushRecent(
  userId: string | undefined,
  item: RecentItem,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): RecentItem[] {
  if (!userId) return [];
  const next = [item, ...loadRecents(userId, storage).filter((r) => r.key !== item.key)].slice(0, MAX_RECENTS);
  try {
    storage.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    /* storage full / blocked: recents are a convenience, never an error */
  }
  return next;
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase();
  if (!q || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: HighlightSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (at > i) out.push({ text: text.slice(i, at), match: false });
    out.push({ text: text.slice(at, at + q.length), match: true });
    i = at + q.length;
  }
  return out;
}
