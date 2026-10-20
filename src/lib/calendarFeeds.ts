/**
 * ICS calendar subscription feeds — client types and pure helpers.
 * No network or Supabase imports so everything is trivially testable.
 * Server side: supabase/functions/calendar-feed (+ _shared/calendar-feed/engine.ts),
 * schema: 20271020000000_calendar_ics_feeds.sql.
 */

export type FeedScope = 'business' | 'technician';
export type DetailLevel = 'full' | 'busy';

export interface CalendarFeed {
  id: string;
  user_id: string;
  scope: FeedScope;
  team_member_id: string | null;
  token: string;
  enabled: boolean;
  detail_level: DetailLevel;
  created_at: string;
  rotated_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
}

export interface FeedMember {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

export interface FeedOverview {
  can_manage: boolean;
  my_member_id: string | null;
  members: FeedMember[];
  feeds: CalendarFeed[];
}

export interface FeedRow {
  key: string;
  scope: FeedScope;
  /** Display title, e.g. "Business calendar" or the technician's name. */
  title: string;
  subtitle: string | null;
  memberId: string | null;
  feed: CalendarFeed | null;
}

export type FeedTone = 'ok' | 'warn' | 'muted';

export interface FeedStatus {
  tone: FeedTone;
  label: string;
  detail: string;
}

export const DETAIL_OPTIONS: { value: DetailLevel; label: string; hint: string }[] = [
  { value: 'full', label: 'Full details', hint: 'Customer, phone, address, notes and a link back to the job.' },
  { value: 'busy', label: 'Busy only', hint: 'Just the time block — no customer name, phone, address or notes.' },
];

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isFeedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/** Normalizes the `calendar_feed_overview` RPC payload; tolerates missing/garbled fields. */
export function parseOverview(raw: unknown): FeedOverview {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const feeds = (Array.isArray(o.feeds) ? o.feeds : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .filter((f) => typeof f.id === 'string' && isFeedToken(f.token) && (f.scope === 'business' || f.scope === 'technician'))
    .map(
      (f): CalendarFeed => ({
        id: f.id as string,
        user_id: String(f.user_id ?? ''),
        scope: f.scope as FeedScope,
        team_member_id: typeof f.team_member_id === 'string' ? f.team_member_id : null,
        token: f.token as string,
        enabled: f.enabled !== false,
        detail_level: f.detail_level === 'busy' ? 'busy' : 'full',
        created_at: String(f.created_at ?? ''),
        rotated_at: typeof f.rotated_at === 'string' ? f.rotated_at : null,
        last_accessed_at: typeof f.last_accessed_at === 'string' ? f.last_accessed_at : null,
        access_count: Number(f.access_count ?? 0) || 0,
      }),
    );
  const members = (Array.isArray(o.members) ? o.members : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string')
    .map((m): FeedMember => ({
      id: m.id as string,
      name: typeof m.name === 'string' ? m.name : null,
      email: typeof m.email === 'string' ? m.email : null,
      role: typeof m.role === 'string' ? m.role : null,
    }));
  return {
    can_manage: o.can_manage === true,
    my_member_id: typeof o.my_member_id === 'string' ? o.my_member_id : null,
    members,
    feeds,
  };
}

export function memberLabel(m: Pick<FeedMember, 'name' | 'email'>): string {
  return (m.name ?? '').trim() || (m.email ?? '').trim() || 'Team member';
}

/**
 * Rows the page renders. Managers get the business row + one row per team member
 * (feed may still be null = "not created yet"). A technician gets only his own row.
 */
export function buildFeedRows(overview: FeedOverview): FeedRow[] {
  const byMember = new Map(overview.feeds.filter((f) => f.scope === 'technician' && f.team_member_id).map((f) => [f.team_member_id as string, f]));
  const rows: FeedRow[] = [];

  if (overview.can_manage) {
    rows.push({
      key: 'business',
      scope: 'business',
      title: 'Business calendar',
      subtitle: 'Every scheduled job in your account',
      memberId: null,
      feed: overview.feeds.find((f) => f.scope === 'business') ?? null,
    });
    const sorted = [...overview.members].sort((a, b) => memberLabel(a).localeCompare(memberLabel(b), undefined, { sensitivity: 'base' }));
    for (const m of sorted) {
      rows.push({
        key: `tech-${m.id}`,
        scope: 'technician',
        title: memberLabel(m),
        subtitle: m.name && m.email ? m.email : null,
        memberId: m.id,
        feed: byMember.get(m.id) ?? null,
      });
    }
    return rows;
  }

  if (overview.my_member_id) {
    rows.push({
      key: `tech-${overview.my_member_id}`,
      scope: 'technician',
      title: 'My schedule',
      subtitle: 'Jobs assigned to you',
      memberId: overview.my_member_id,
      feed: byMember.get(overview.my_member_id) ?? null,
    });
  }
  return rows;
}

// ----------------------------------------------------------------- URLs ----

export function feedHttpsUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/functions/v1/calendar-feed/${token}.ics`;
}

/** webcal:// makes Apple Calendar (and most desktop clients) offer "Subscribe" directly. */
export function feedWebcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:\/\//i, 'webcal://');
}

export function googleSubscribeUrl(httpsUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feedWebcalUrl(httpsUrl))}`;
}

export function outlookSubscribeUrl(httpsUrl: string, name: string, kind: 'personal' | 'work' = 'personal'): string {
  const host = kind === 'work' ? 'outlook.office.com' : 'outlook.live.com';
  return `https://${host}/calendar/0/addfromweb?url=${encodeURIComponent(httpsUrl)}&name=${encodeURIComponent(name)}`;
}

/** Shows the secret only partially unless the user reveals it (safe for screen sharing). */
export function maskFeedUrl(httpsUrl: string): string {
  return httpsUrl.replace(/\/([0-9a-f]{4})[0-9a-f]{56}([0-9a-f]{4})\.ics$/i, '/$1••••••••••••••••••••$2.ics');
}

// --------------------------------------------------------------- status ----

export function formatRelativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function describeFeed(feed: CalendarFeed | null, now: Date = new Date()): FeedStatus {
  if (!feed) return { tone: 'muted', label: 'Not set up', detail: 'Create a private link to subscribe a calendar app.' };
  if (!feed.enabled) return { tone: 'muted', label: 'Paused', detail: 'The link returns nothing until you resume it.' };
  if (!feed.last_accessed_at) {
    return { tone: 'warn', label: 'Waiting for first sync', detail: 'Add the link to your calendar app — it will show here once it connects.' };
  }
  return { tone: 'ok', label: 'Active', detail: `Last synced ${formatRelativeTime(feed.last_accessed_at, now)}` };
}

/** Maps RPC/PostgREST errors to copy a user can act on. */
export function feedErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  const code = error?.code ?? '';
  const message = error?.message ?? '';
  if (code === '42501' || /not_authorized/.test(message)) return "Your role doesn't allow changing this calendar link.";
  if (code === 'P0002' || /feed_not_found/.test(message)) return 'This link no longer exists. Refresh the page.';
  return fallback;
}
