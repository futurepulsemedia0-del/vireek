// ============================================================
// Marketing Content Calendar — view model (PURE: no React, no network).
//
// Everything the /dashboard/marketing/calendar page needs that is not
// rendering lives here so it is unit-tested once (contentCalendar.test.ts):
// channel + status metadata, validation, status transitions, date math,
// month/week grids, grouping, filtering, summaries and .ics export.
//
// Dates are LOCAL time everywhere in the UI and stored as timestamptz.
// All date arithmetic goes through setDate/setMonth (never +24h) so it is
// DST-safe.
// ============================================================

// ------------------------------------------------------------
// Channels
// ------------------------------------------------------------

export type ChannelId =
  | 'facebook'
  | 'instagram'
  | 'google_business'
  | 'linkedin'
  | 'x'
  | 'tiktok'
  | 'youtube'
  | 'nextdoor'
  | 'blog'
  | 'email'
  | 'sms'
  | 'direct_mail'
  | 'other';

export type ChannelGroup = 'social' | 'owned' | 'direct';

export interface ChannelMeta {
  id: ChannelId;
  label: string;
  group: ChannelGroup;
  /** Max characters for the caption/body on that channel. */
  limit: number;
  /** Tailwind class for the small colour dot (default palette). */
  dot: string;
}

/** Hard ceiling enforced by the database CHECK constraint. */
export const BODY_MAX = 5000;
export const TITLE_MAX = 160;
export const NOTES_MAX = 2000;
export const LINK_MAX = 500;
export const TAG_MAX_COUNT = 10;
export const TAG_MAX_LENGTH = 30;

export const CHANNELS: readonly ChannelMeta[] = [
  { id: 'facebook', label: 'Facebook', group: 'social', limit: BODY_MAX, dot: 'bg-blue-500' },
  { id: 'instagram', label: 'Instagram', group: 'social', limit: 2200, dot: 'bg-pink-500' },
  { id: 'google_business', label: 'Google Business Profile', group: 'social', limit: 1500, dot: 'bg-emerald-500' },
  { id: 'linkedin', label: 'LinkedIn', group: 'social', limit: 3000, dot: 'bg-sky-600' },
  { id: 'x', label: 'X (Twitter)', group: 'social', limit: 280, dot: 'bg-slate-500' },
  { id: 'tiktok', label: 'TikTok', group: 'social', limit: 2200, dot: 'bg-fuchsia-500' },
  { id: 'youtube', label: 'YouTube', group: 'social', limit: BODY_MAX, dot: 'bg-red-500' },
  { id: 'nextdoor', label: 'Nextdoor', group: 'social', limit: BODY_MAX, dot: 'bg-lime-600' },
  { id: 'blog', label: 'Blog / website', group: 'owned', limit: BODY_MAX, dot: 'bg-indigo-500' },
  { id: 'email', label: 'Email', group: 'direct', limit: BODY_MAX, dot: 'bg-amber-500' },
  { id: 'sms', label: 'SMS', group: 'direct', limit: 480, dot: 'bg-teal-500' },
  { id: 'direct_mail', label: 'Direct mail', group: 'direct', limit: BODY_MAX, dot: 'bg-orange-500' },
  { id: 'other', label: 'Other', group: 'owned', limit: BODY_MAX, dot: 'bg-zinc-400' },
];

const CHANNEL_BY_ID = new Map<string, ChannelMeta>(CHANNELS.map((c) => [c.id, c]));

export function isChannelId(value: unknown): value is ChannelId {
  return typeof value === 'string' && CHANNEL_BY_ID.has(value);
}

export function getChannel(id: string): ChannelMeta {
  return CHANNEL_BY_ID.get(id) ?? (CHANNEL_BY_ID.get('other') as ChannelMeta);
}

// ------------------------------------------------------------
// Content types + statuses
// ------------------------------------------------------------

export type ContentType = 'post' | 'story' | 'video' | 'article' | 'email' | 'sms' | 'offer' | 'event' | 'ad' | 'other';

export const CONTENT_TYPES: readonly { id: ContentType; label: string }[] = [
  { id: 'post', label: 'Post' },
  { id: 'story', label: 'Story / Reel' },
  { id: 'video', label: 'Video' },
  { id: 'article', label: 'Article' },
  { id: 'email', label: 'Email' },
  { id: 'sms', label: 'Text message' },
  { id: 'offer', label: 'Offer / promotion' },
  { id: 'event', label: 'Event' },
  { id: 'ad', label: 'Ad' },
  { id: 'other', label: 'Other' },
];

export function isContentType(value: unknown): value is ContentType {
  return typeof value === 'string' && CONTENT_TYPES.some((t) => t.id === value);
}

export type ContentStatus = 'idea' | 'draft' | 'in_review' | 'approved' | 'scheduled' | 'published' | 'cancelled';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const STATUSES: readonly { id: ContentStatus; label: string; tone: StatusTone }[] = [
  { id: 'idea', label: 'Idea', tone: 'neutral' },
  { id: 'draft', label: 'Draft', tone: 'neutral' },
  { id: 'in_review', label: 'In review', tone: 'warning' },
  { id: 'approved', label: 'Approved', tone: 'info' },
  { id: 'scheduled', label: 'Scheduled', tone: 'info' },
  { id: 'published', label: 'Published', tone: 'success' },
  { id: 'cancelled', label: 'Cancelled', tone: 'danger' },
];

export function isContentStatus(value: unknown): value is ContentStatus {
  return typeof value === 'string' && STATUSES.some((s) => s.id === value);
}

export function statusLabel(status: string): string {
  return STATUSES.find((s) => s.id === status)?.label ?? status;
}

export function statusTone(status: string): StatusTone {
  return STATUSES.find((s) => s.id === status)?.tone ?? 'neutral';
}

/** Allowed status moves. Published is final (a published post cannot be "un-published" here). */
export const STATUS_TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  idea: ['draft', 'cancelled'],
  draft: ['in_review', 'approved', 'scheduled', 'cancelled'],
  in_review: ['draft', 'approved', 'cancelled'],
  approved: ['draft', 'scheduled', 'published', 'cancelled'],
  scheduled: ['draft', 'approved', 'published', 'cancelled'],
  published: [],
  cancelled: ['draft'],
};

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return from === to || STATUS_TRANSITIONS[from].includes(to);
}

/** Statuses a user can pick in the editor: the current one plus every legal move. */
export function selectableStatuses(current: ContentStatus | null): ContentStatus[] {
  if (!current) return ['idea', 'draft', 'in_review', 'approved', 'scheduled'];
  return [current, ...STATUS_TRANSITIONS[current]];
}

export interface QuickAction {
  to: ContentStatus;
  label: string;
}

/** The one-click buttons shown on an item (not every legal move — just the common ones). */
export function quickActions(status: ContentStatus): QuickAction[] {
  switch (status) {
    case 'in_review':
      return [{ to: 'approved', label: 'Approve' }];
    case 'approved':
    case 'scheduled':
      return [{ to: 'published', label: 'Mark published' }];
    case 'cancelled':
      return [{ to: 'draft', label: 'Reopen as draft' }];
    default:
      return [];
  }
}

// ------------------------------------------------------------
// Item model
// ------------------------------------------------------------

export interface ContentItem {
  id: string;
  user_id: string;
  title: string;
  body: string;
  channel: ChannelId;
  content_type: ContentType;
  status: ContentStatus;
  scheduled_at: string | null;
  published_at: string | null;
  tags: string[];
  link_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** What the editor works with (strings only, so inputs stay controlled). */
export interface ItemDraft {
  title: string;
  body: string;
  channel: ChannelId;
  content_type: ContentType;
  status: ContentStatus;
  scheduled_at: string | null;
  tags: string;
  link_url: string;
  notes: string;
}

export const EMPTY_DRAFT: ItemDraft = {
  title: '',
  body: '',
  channel: 'facebook',
  content_type: 'post',
  status: 'draft',
  scheduled_at: null,
  tags: '',
  link_url: '',
  notes: '',
};

export function draftFromItem(item: ContentItem): ItemDraft {
  return {
    title: item.title,
    body: item.body,
    channel: item.channel,
    content_type: item.content_type,
    status: item.status,
    scheduled_at: item.scheduled_at,
    tags: item.tags.join(', '),
    link_url: item.link_url ?? '',
    notes: item.notes ?? '',
  };
}

/** Copy of an item as a fresh draft (never inherits published/scheduled state). */
export function duplicateDraft(item: ContentItem): ItemDraft {
  return { ...draftFromItem(item), title: truncate(`${item.title} (copy)`, TITLE_MAX), status: 'draft', scheduled_at: null };
}

/** Postgres counts characters as code points; JS .length counts UTF-16 units. Match the database. */
export function charCount(value: string): number {
  return Array.from(value).length;
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export type DraftErrors = Partial<Record<'title' | 'body' | 'scheduled_at' | 'tags' | 'link_url' | 'notes', string>>;

/**
 * `existing` lets an already-overdue scheduled item keep its (past) time while
 * other fields are edited — the "future only" rule applies to NEW times.
 */
export function validateDraft(
  draft: ItemDraft,
  now: Date = new Date(),
  existing?: { scheduled_at: string | null; status: ContentStatus } | null,
): DraftErrors {
  const errors: DraftErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Give this a title.';
  else if (charCount(title) > TITLE_MAX) errors.title = `Keep the title under ${TITLE_MAX} characters.`;

  const channel = getChannel(draft.channel);
  const bodyLen = charCount(draft.body);
  if (bodyLen > channel.limit) {
    errors.body = `${channel.label} allows ${channel.limit.toLocaleString('en-US')} characters — this is ${bodyLen.toLocaleString('en-US')}.`;
  }

  if (charCount(draft.notes) > NOTES_MAX) errors.notes = `Keep notes under ${NOTES_MAX} characters.`;

  const link = draft.link_url.trim();
  if (link) {
    if (charCount(link) > LINK_MAX) errors.link_url = `Keep the link under ${LINK_MAX} characters.`;
    else if (!isHttpUrl(link)) errors.link_url = 'Enter a full link starting with http:// or https://.';
  }

  const tags = parseTags(draft.tags);
  if (tags.length > TAG_MAX_COUNT) errors.tags = `Use at most ${TAG_MAX_COUNT} tags.`;
  else if (tags.some((t) => charCount(t) > TAG_MAX_LENGTH)) errors.tags = `Each tag must be ${TAG_MAX_LENGTH} characters or fewer.`;

  if (draft.scheduled_at !== null && Number.isNaN(Date.parse(draft.scheduled_at))) {
    errors.scheduled_at = 'Pick a valid date and time.';
  } else if (draft.status === 'scheduled') {
    if (!draft.scheduled_at) errors.scheduled_at = 'Pick a date and time to schedule this.';
    else {
      const unchanged = existing?.status === 'scheduled' && existing.scheduled_at === draft.scheduled_at;
      if (!unchanged && Date.parse(draft.scheduled_at) < now.getTime()) {
        errors.scheduled_at = 'Pick a time in the future, or mark it as published.';
      }
    }
  }
  return errors;
}

export function hasErrors(errors: DraftErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** Row payload for insert/update (user_id is added by the caller). */
export function toRowPayload(draft: ItemDraft, now: Date = new Date(), existingPublishedAt: string | null = null) {
  return {
    title: draft.title.trim(),
    body: draft.body,
    channel: draft.channel,
    content_type: draft.content_type,
    status: draft.status,
    scheduled_at: draft.scheduled_at,
    published_at: draft.status === 'published' ? (existingPublishedAt ?? now.toISOString()) : null,
    tags: parseTags(draft.tags),
    link_url: draft.link_url.trim() || null,
    notes: draft.notes.trim() || null,
  };
}

export type TransitionResult = { ok: true; patch: { status: ContentStatus; published_at: string | null } } | { ok: false; reason: string };

export function transitionPatch(item: Pick<ContentItem, 'status' | 'scheduled_at'>, to: ContentStatus, now: Date = new Date()): TransitionResult {
  if (!canTransition(item.status, to)) return { ok: false, reason: `A ${statusLabel(item.status).toLowerCase()} item can't become ${statusLabel(to).toLowerCase()}.` };
  if (to === 'scheduled') {
    if (!item.scheduled_at) return { ok: false, reason: 'Pick a date and time first.' };
    if (Date.parse(item.scheduled_at) < now.getTime()) return { ok: false, reason: 'That time has passed — pick a new one.' };
  }
  return { ok: true, patch: { status: to, published_at: to === 'published' ? now.toISOString() : null } };
}

// ------------------------------------------------------------
// Dates
// ------------------------------------------------------------

export type ViewMode = 'month' | 'week' | 'agenda';
export const VIEW_OPTIONS: readonly { key: ViewMode; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'agenda', label: 'Agenda' },
];

export function isViewMode(value: unknown): value is ViewMode {
  return value === 'month' || value === 'week' || value === 'agenda';
}

export type WeekStart = 0 | 1;

/** First day of the week for the user's locale (Sunday=0 / Monday=1). Falls back to Sunday. */
export function detectWeekStart(locale?: string): WeekStart {
  try {
    const loc = new Intl.Locale(locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US')) as unknown as {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const first = (loc.getWeekInfo ? loc.getWeekInfo() : loc.weekInfo)?.firstDay;
    return first === 1 ? 1 : 0;
  } catch {
    return 0;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strict YYYY-MM-DD → local Date at midnight; null for anything invalid (incl. 2026-02-30). */
export function parseDateKey(key: string | null | undefined): Date | null {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Adds months, clamping the day (Jan 31 + 1 month = Feb 28/29, never Mar 3). */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

export function startOfWeek(date: Date, weekStartsOn: WeekStart = 0): Date {
  const d = startOfDay(date);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  return addDays(d, -diff);
}

export function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

export function isSameDay(a: Date, b: Date): boolean {
  return toDateKey(a) === toDateKey(b);
}

export interface GridDay {
  date: Date;
  key: string;
  inMonth: boolean;
}

/** Always 6 rows × 7 columns so the grid height never jumps between months. */
export function monthGrid(anchor: Date, weekStartsOn: WeekStart = 0): GridDay[] {
  const first = startOfMonth(anchor);
  const start = startOfWeek(first, weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(start, i);
    return { date, key: toDateKey(date), inMonth: date.getMonth() === first.getMonth() };
  });
}

export function weekDays(anchor: Date, weekStartsOn: WeekStart = 0): Date[] {
  const start = startOfWeek(anchor, weekStartsOn);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Half-open [start, end) range the current view needs data for. */
export function visibleRange(view: ViewMode, anchor: Date, weekStartsOn: WeekStart = 0): { start: Date; end: Date } {
  if (view === 'week') {
    const start = startOfWeek(anchor, weekStartsOn);
    return { start, end: addDays(start, 7) };
  }
  if (view === 'agenda') {
    const start = startOfMonth(anchor);
    return { start, end: addMonths(start, 1) };
  }
  const grid = monthGrid(anchor, weekStartsOn);
  return { start: grid[0].date, end: addDays(grid[grid.length - 1].date, 1) };
}

export function shiftAnchor(view: ViewMode, anchor: Date, dir: -1 | 1): Date {
  return view === 'week' ? addDays(anchor, dir * 7) : addMonths(anchor, dir);
}

export function rangeLabel(view: ViewMode, anchor: Date, weekStartsOn: WeekStart = 0, locale = 'en-US'): string {
  if (view !== 'week') return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const days = weekDays(anchor, weekStartsOn);
  const a = days[0];
  const b = days[6];
  const md = (d: Date) => d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  if (a.getFullYear() !== b.getFullYear()) {
    return `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
  }
  // Same month: "Oct 25 – 31, 2026". Different months: "Oct 28 – Nov 3, 2026".
  const right = a.getMonth() === b.getMonth() ? String(b.getDate()) : md(b);
  return `${md(a)} – ${right}, ${b.getFullYear()}`;
}

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDayLong = (d: Date) => d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

// ------------------------------------------------------------
// datetime-local helpers
// ------------------------------------------------------------

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${toDateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Keep the local time-of-day when an item is dragged to another day (09:00 if it had none). */
export function moveToDay(iso: string | null, target: Date, defaultHour = 9): string {
  const d = new Date(target);
  if (iso && !Number.isNaN(Date.parse(iso))) {
    const src = new Date(iso);
    d.setHours(src.getHours(), src.getMinutes(), 0, 0);
  } else {
    d.setHours(defaultHour, 0, 0, 0);
  }
  return d.toISOString();
}

export function isDraggable(status: ContentStatus): boolean {
  return status !== 'published' && status !== 'cancelled';
}

// ------------------------------------------------------------
// Email-campaign overlay (read-only) + unified entries
// ------------------------------------------------------------

export interface CampaignRow {
  id: string;
  name: string;
  status: string;
  scheduled_at: string | null;
  started_at: string | null;
}

export interface CampaignEvent {
  id: string;
  name: string;
  status: string;
  at: string;
}

/** Campaigns that actually have a send time. Drafts without a date and cancelled sends are not on the calendar. */
export function campaignEvents(rows: readonly CampaignRow[]): CampaignEvent[] {
  const out: CampaignEvent[] = [];
  for (const r of rows) {
    if (r.status === 'cancelled') continue;
    const at = r.started_at ?? r.scheduled_at;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    out.push({ id: r.id, name: r.name, status: r.status, at });
  }
  return out;
}

export type CalendarEntry =
  | { kind: 'content'; key: string; at: string | null; item: ContentItem }
  | { kind: 'campaign'; key: string; at: string; campaign: CampaignEvent };

export function buildEntries(items: readonly ContentItem[], campaigns: readonly CampaignEvent[]): CalendarEntry[] {
  const entries: CalendarEntry[] = [
    ...items.map((item): CalendarEntry => ({ kind: 'content', key: `c:${item.id}`, at: item.scheduled_at, item })),
    ...campaigns.map((campaign): CalendarEntry => ({ kind: 'campaign', key: `e:${campaign.id}`, at: campaign.at, campaign })),
  ];
  return entries;
}

function entryTitle(e: CalendarEntry): string {
  return e.kind === 'content' ? e.item.title : e.campaign.name;
}

/** Day key → entries, earliest first (ties broken by title so order is stable). Unscheduled entries are skipped. */
export function groupByDay(entries: readonly CalendarEntry[]): Map<string, CalendarEntry[]> {
  const map = new Map<string, CalendarEntry[]>();
  for (const e of entries) {
    if (!e.at || Number.isNaN(Date.parse(e.at))) continue;
    const key = toDateKey(new Date(e.at));
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string) || entryTitle(a).localeCompare(entryTitle(b)));
  }
  return map;
}

// ------------------------------------------------------------
// Filtering
// ------------------------------------------------------------

export interface CalendarFilters {
  channels: ReadonlySet<ChannelId>;
  status: ContentStatus | 'all';
  query: string;
}

export const NO_FILTERS: CalendarFilters = { channels: new Set(), status: 'all', query: '' };

export function hasActiveFilters(f: CalendarFilters): boolean {
  return f.channels.size > 0 || f.status !== 'all' || f.query.trim() !== '';
}

export function filterItems(items: readonly ContentItem[], f: CalendarFilters): ContentItem[] {
  const q = f.query.trim().toLowerCase();
  return items.filter((i) => {
    if (f.channels.size > 0 && !f.channels.has(i.channel)) return false;
    if (f.status !== 'all' && i.status !== f.status) return false;
    if (q) {
      const hay = `${i.title}\n${i.body}\n${i.tags.join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Campaign overlay follows the channel filter (Email only) and the search box; it has no content status. */
export function filterCampaigns(campaigns: readonly CampaignEvent[], f: CalendarFilters): CampaignEvent[] {
  if (f.status !== 'all') return [];
  if (f.channels.size > 0 && !f.channels.has('email')) return [];
  const q = f.query.trim().toLowerCase();
  return q ? campaigns.filter((c) => c.name.toLowerCase().includes(q)) : [...campaigns];
}

// ------------------------------------------------------------
// Summary / "needs attention"
// ------------------------------------------------------------

export function isOverdue(item: Pick<ContentItem, 'status' | 'scheduled_at'>, now: Date = new Date()): boolean {
  return (item.status === 'scheduled' || item.status === 'approved') && !!item.scheduled_at && Date.parse(item.scheduled_at) < now.getTime();
}

export function isUnscheduled(item: Pick<ContentItem, 'status' | 'scheduled_at'>): boolean {
  return !item.scheduled_at && item.status !== 'published' && item.status !== 'cancelled';
}

export interface CalendarSummary {
  upcoming7: number;
  overdue: ContentItem[];
  unscheduled: ContentItem[];
  /** Local day keys in the next 14 days (incl. today) with nothing planned. */
  gapDays: string[];
}

export function summarize(items: readonly ContentItem[], campaigns: readonly CampaignEvent[], now: Date = new Date()): CalendarSummary {
  const today = startOfDay(now);
  const in7 = addDays(today, 7).getTime();
  const live = items.filter((i) => i.status !== 'cancelled' && i.status !== 'idea');

  const upcoming7 = items.filter(
    (i) => (i.status === 'scheduled' || i.status === 'approved') && !!i.scheduled_at && Date.parse(i.scheduled_at) >= now.getTime() && Date.parse(i.scheduled_at) < in7,
  ).length;

  const overdue = items
    .filter((i) => isOverdue(i, now))
    .sort((a, b) => Date.parse(a.scheduled_at as string) - Date.parse(b.scheduled_at as string));
  const unscheduled = items.filter(isUnscheduled).sort((a, b) => a.created_at.localeCompare(b.created_at));

  const busy = groupByDay(buildEntries(live, campaigns));
  const gapDays: string[] = [];
  for (let i = 0; i < 14; i++) {
    const key = toDateKey(addDays(today, i));
    if (!busy.has(key)) gapDays.push(key);
  }
  return { upcoming7, overdue, unscheduled, gapDays };
}

// ------------------------------------------------------------
// .ics export (RFC 5545)
// ------------------------------------------------------------

const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const icsStamp = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** Fold to 75 octets per line (RFC 5545 §3.1) without splitting a multi-byte character. */
function icsFold(line: string): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of Array.from(line)) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(cur);
      cur = ' ';
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out;
}

export function buildIcs(items: readonly ContentItem[], opts: { now?: Date; calendarName?: string } = {}): string {
  const now = opts.now ?? new Date();
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vireek//Content Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (opts.calendarName) lines.push(`X-WR-CALNAME:${icsEscape(opts.calendarName)}`);
  for (const item of items) {
    if (!item.scheduled_at || item.status === 'cancelled' || Number.isNaN(Date.parse(item.scheduled_at))) continue;
    const start = new Date(item.scheduled_at);
    const end = new Date(start.getTime() + 30 * 60_000);
    const desc = [item.body, item.link_url ?? '', `Status: ${statusLabel(item.status)}`].filter(Boolean).join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.id}@vireek.content-calendar`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART:${icsStamp(start)}`,
      `DTEND:${icsStamp(end)}`,
      `SUMMARY:${icsEscape(`[${getChannel(item.channel).label}] ${item.title}`)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(icsFold).join('\r\n') + '\r\n';
}
