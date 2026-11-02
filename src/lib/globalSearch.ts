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
  /** Id in SHORTCUT_DEFS (src/lib/shortcuts/definitions.ts); the palette shows its live key hint. */
  shortcutId?: string;
  /** i18n key in the `productivity` namespace for the label (actions). Pages reuse the dashboard nav keys. */
  labelKey?: string;
  /** Passed to react-router navigate(); used to open a page's create modal. */
  state?: unknown;
  kind: 'page' | 'action';
}

export const QUICK_ACTIONS: PaletteCommand[] = [
  { id: 'action:new-job', kind: 'action', label: 'New job', labelKey: 'palette.actions.new-job', shortcutId: 'create.job', href: '/dashboard/jobs', keywords: 'create add schedule', state: { prefill: {} } },
  { id: 'action:new-quote', kind: 'action', label: 'New quote', labelKey: 'palette.actions.new-quote', shortcutId: 'create.quote', href: '/dashboard/quotes?new=1', keywords: 'create add estimate proposal' },
  { id: 'action:send-feedback', kind: 'action', label: 'Send feedback', href: '/dashboard/feedback/mine?new=1', keywords: 'feedback bug idea suggestion report problem' },
  { id: 'action:new-article', kind: 'action', label: 'New knowledge article', labelKey: 'palette.actions.new-article', href: '/dashboard/knowledge?new=1', keywords: 'create add faq answer' },
  { id: 'action:invite-teammate', kind: 'action', label: 'Invite teammate', labelKey: 'palette.actions.invite-teammate', shortcutId: 'create.invite', href: '/dashboard/team?invite=1', keywords: 'create add member staff technician user', permission: 'can_manage_team' },
];

export const PAGES: PaletteCommand[] = [
  { id: 'page:overview', kind: 'page', label: 'Overview', shortcutId: 'nav.overview', href: '/dashboard', keywords: 'home dashboard' },
  { id: 'page:calls', kind: 'page', label: 'Call History', shortcutId: 'nav.calls', href: '/dashboard/calls', keywords: 'phone voicemail' },
  { id: 'page:voicemails', kind: 'page', label: 'Voicemails', shortcutId: 'nav.voicemails', href: '/dashboard/voicemails', keywords: 'messages inbox missed' },
  { id: 'page:leads', kind: 'page', label: 'Leads', shortcutId: 'nav.leads', href: '/dashboard/leads', keywords: 'pipeline prospects' },
  { id: 'page:customers', kind: 'page', label: 'Customers', href: '/dashboard/customers', keywords: 'contacts clients crm' },
  { id: 'page:jobs', kind: 'page', label: 'My Jobs', shortcutId: 'nav.jobs', href: '/dashboard/jobs', keywords: 'work orders dispatch' },
  { id: 'page:calendar', kind: 'page', label: 'Calendar', shortcutId: 'nav.calendar', href: '/dashboard/calendar', keywords: 'schedule appointments' },
  { id: 'page:quotes', kind: 'page', label: 'Quotes', href: '/dashboard/quotes', keywords: 'estimates proposals' },
  { id: 'page:invoicing', kind: 'page', label: 'Invoicing', href: '/dashboard/invoicing', keywords: 'invoices payments', permission: 'can_view_billing' },
  { id: 'page:knowledge', kind: 'page', label: 'Knowledge Base', href: '/dashboard/knowledge', keywords: 'articles faq answers' },
  { id: 'page:equipment', kind: 'page', label: 'Equipment Health', href: '/dashboard/equipment-health', keywords: 'hvac assets lifecycle' },
  { id: 'page:passports', kind: 'page', label: 'Equipment Passports', href: '/dashboard/equipment-passports', keywords: 'serial warranty' },
  { id: 'page:analytics', kind: 'page', label: 'Analytics', shortcutId: 'nav.analytics', href: '/dashboard/analytics', keywords: 'reports metrics' },
  { id: 'page:insights', kind: 'page', label: 'Insights', shortcutId: 'nav.insights', href: '/dashboard/insights', keywords: 'ai recommendations' },
  { id: 'page:reviews', kind: 'page', label: 'Reviews', shortcutId: 'nav.reviews', href: '/dashboard/reviews', keywords: 'ratings feedback reputation' },
  { id: 'page:notifications', kind: 'page', label: 'Notifications', href: '/dashboard/notifications', keywords: 'alerts inbox' },
  { id: 'page:team', kind: 'page', label: 'Team', shortcutId: 'nav.team', href: '/dashboard/team', keywords: 'staff technicians roles invite', permission: 'can_manage_team' },
  { id: 'page:billing', kind: 'page', label: 'Billing', shortcutId: 'nav.billing', href: '/dashboard/billing', keywords: 'plan subscription', permission: 'can_view_billing' },
  { id: 'page:integrations', kind: 'page', label: 'Integrations', href: '/dashboard/integrations', keywords: 'connect apps' },
  { id: 'page:profile', kind: 'page', label: 'Business Profile', shortcutId: 'nav.profile', href: '/dashboard/business-profile', keywords: 'settings company hours', permission: 'can_edit_business_profile' },
  { id: 'page:settings', kind: 'page', label: 'Settings', shortcutId: 'nav.settings', href: '/dashboard/settings', keywords: 'preferences account configuration' },
  { id: 'page:security', kind: 'page', label: 'Security settings', href: '/dashboard/settings/security', keywords: '2fa mfa audit password' },
];

/** True when `a` and `b` differ by at most one insertion, deletion, substitution or adjacent swap. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i); // insertion / deletion
}

function isSubsequence(q: string, text: string): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === q[at]) at += 1;
    if (at === q.length) return true;
  }
  return q.length === 0;
}

/**
 * 0 = no match. Exact > prefix > word-prefix > substring > all-words > keyword
 * > typo-tolerant > subsequence ("bprf" -> Business Profile). The fuzzy tiers
 * only apply to queries of 3+ characters so short queries stay precise.
 */
export function scoreCommand(query: string, cmd: Pick<PaletteCommand, 'label' | 'keywords'>): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = cmd.label.toLowerCase();
  if (label === q) return 1.2;
  if (label.startsWith(q)) return 1.0;
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 0.8;
  if (label.includes(q)) return 0.6;
  const keywordWords = cmd.keywords?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const labelWords = label.split(/\s+/);
  const words = [...labelWords, ...keywordWords];
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => words.some((w) => w.startsWith(t)))) return 0.5;
  if (keywordWords.some((w) => w.startsWith(q))) return 0.45;
  if (q.length >= 4 && words.some((w) => [q.length - 1, q.length, q.length + 1].some((n) => n > 0 && withinOneEdit(q, w.slice(0, n))))) return 0.3;
  if (q.length >= 3 && !q.includes(' ') && isSubsequence(q, label.replace(/\s+/g, ''))) return 0.25;
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
// Scoped queries: ">" actions, "@" people, "#" jobs
// ---------------------------------------------------------------------------

export type PaletteScope = 'all' | 'actions' | 'people' | 'jobs';

export const SCOPE_PREFIX: Record<Exclude<PaletteScope, 'all'>, string> = {
  actions: '>',
  people: '@',
  jobs: '#',
};

/** Entity types a scope may search. `null` = every type; `[]` = no record search. */
export const SCOPE_TYPES: Record<PaletteScope, SearchEntityType[] | null> = {
  all: null,
  actions: [],
  people: ['team', 'customer', 'lead'],
  jobs: ['job'],
};

export function parseScopedQuery(raw: string): { scope: PaletteScope; term: string } {
  const trimmed = raw.replace(/^\s+/, '');
  const first = trimmed.charAt(0);
  const scope: PaletteScope = first === '>' ? 'actions' : first === '@' ? 'people' : first === '#' ? 'jobs' : 'all';
  return { scope, term: normalizeQuery(scope === 'all' ? trimmed : trimmed.slice(1)) };
}

// ---------------------------------------------------------------------------
// Short-lived result cache: makes backspacing / re-typing instant (<150ms)
// ---------------------------------------------------------------------------

export interface SearchCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
}

export function createSearchCache<T>(opts: { ttlMs?: number; max?: number; now?: () => number } = {}): SearchCache<T> {
  const ttl = opts.ttlMs ?? 30_000;
  const max = opts.max ?? 40;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { at: number; value: T }>();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttl) {
        map.delete(key);
        return undefined;
      }
      map.delete(key); // refresh LRU position
      map.set(key, hit);
      return hit.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { at: now(), value });
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
  };
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
