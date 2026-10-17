/**
 * Website Chat Widget — pure domain logic (no I/O, fully unit-tested).
 * The embed script (public/chat-widget.js) mirrors getWidgetStatus() — keep the two in sync.
 */

export type WidgetPosition = 'left' | 'right';
export type WidgetTheme = 'light' | 'dark' | 'auto';
export type HoursMode = 'always' | 'scheduled';
export type RoutingMode = 'team_inbox' | 'assigned_member';
export type OfflineBehavior = 'collect_lead' | 'show_message' | 'hide';
export type ContactField = 'none' | 'email' | 'phone' | 'either';

/** 0 = Sunday … 6 = Saturday. Times are "HH:MM" 24h in the widget time zone. A missing day = closed. */
export interface DayHours {
  open: string;
  close: string;
}
export type WeekSchedule = Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', DayHours>>;

export interface ChatWidgetSettings {
  enabled: boolean;
  brand_color: string;
  position: WidgetPosition;
  theme: WidgetTheme;
  title: string;
  greeting: string;
  offline_message: string;
  hours_mode: HoursMode;
  timezone: string;
  schedule: WeekSchedule;
  routing_mode: RoutingMode;
  assigned_team_member_id: string | null;
  offline_behavior: OfflineBehavior;
  contact_field: ContactField;
  allowed_domains: string[];
}

export interface ChatWidgetRow extends ChatWidgetSettings {
  account_owner_id: string;
  public_key: string;
  last_seen_at: string | null;
  last_seen_host: string | null;
  updated_at: string;
}

export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const DAY_ORDER: ('1' | '2' | '3' | '4' | '5' | '6' | '0')[] = ['1', '2', '3', '4', '5', '6', '0'];

export const LIMITS = { title: 60, greeting: 240, offline: 240, domains: 20 } as const;

export const DEFAULT_SCHEDULE: WeekSchedule = {
  '1': { open: '09:00', close: '18:00' },
  '2': { open: '09:00', close: '18:00' },
  '3': { open: '09:00', close: '18:00' },
  '4': { open: '09:00', close: '18:00' },
  '5': { open: '09:00', close: '18:00' },
};

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

export function buildDefaults(): ChatWidgetSettings {
  return {
    enabled: false,
    brand_color: '#3448E8',
    position: 'right',
    theme: 'auto',
    title: 'Chat with us',
    greeting: 'Hi! How can we help you today?',
    offline_message: 'We are offline right now. Leave a message and we will get back to you.',
    hours_mode: 'always',
    timezone: defaultTimezone(),
    schedule: { ...DEFAULT_SCHEDULE },
    routing_mode: 'team_inbox',
    assigned_team_member_id: null,
    offline_behavior: 'collect_lead',
    contact_field: 'email',
    allowed_domains: [],
  };
}

/* ------------------------------ domains ------------------------------ */

/** "https://www.Example.com/path" → "example.com" (leading www. dropped; subdomains are matched server-side). */
export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) && v !== 'localhost') return null;
  return v;
}

export function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/).filter(Boolean)) {
    const d = normalizeDomain(raw);
    if (!d) invalid.push(raw);
    else if (!domains.includes(d)) domains.push(d);
  }
  return { domains, invalid };
}

/* ----------------------------- validation ---------------------------- */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMinutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ChatWidgetErrors = Partial<Record<'title' | 'greeting' | 'offline_message' | 'brand_color' | 'timezone' | 'schedule' | 'assigned_team_member_id' | 'allowed_domains', string>>;

export function validateSettings(s: ChatWidgetSettings): ChatWidgetErrors {
  const e: ChatWidgetErrors = {};
  if (!s.title.trim()) e.title = 'Enter a title.';
  else if (s.title.length > LIMITS.title) e.title = `Max ${LIMITS.title} characters.`;
  if (!s.greeting.trim()) e.greeting = 'Enter a greeting.';
  else if (s.greeting.length > LIMITS.greeting) e.greeting = `Max ${LIMITS.greeting} characters.`;
  if (!s.offline_message.trim()) e.offline_message = 'Enter an offline message.';
  else if (s.offline_message.length > LIMITS.offline) e.offline_message = `Max ${LIMITS.offline} characters.`;
  if (!/^#[0-9a-fA-F]{6}$/.test(s.brand_color)) e.brand_color = 'Use a 6-digit hex color, e.g. #3448E8.';
  if (!isValidTimezone(s.timezone)) e.timezone = 'Unknown time zone.';
  if (s.hours_mode === 'scheduled') {
    const days = Object.values(s.schedule).filter(Boolean) as DayHours[];
    if (days.length === 0) e.schedule = 'Open at least one day, or switch to "Always online".';
    else if (days.some((d) => !HHMM.test(d.open) || !HHMM.test(d.close) || toMinutes(d.close) <= toMinutes(d.open)))
      e.schedule = 'Closing time must be after opening time on every open day.';
  }
  if (s.routing_mode === 'assigned_member' && !s.assigned_team_member_id) e.assigned_team_member_id = 'Choose a team member.';
  if (s.allowed_domains.length > LIMITS.domains) e.allowed_domains = `Max ${LIMITS.domains} domains.`;
  return e;
}

export const hasErrors = (e: ChatWidgetErrors): boolean => Object.keys(e).length > 0;

/** Normalises a DB row (or partial) into settings, filling anything missing from defaults. */
export function normalizeSettings(row: Partial<ChatWidgetSettings> | null | undefined): ChatWidgetSettings {
  const d = buildDefaults();
  if (!row) return d;
  return {
    ...d,
    ...row,
    schedule: row.schedule && typeof row.schedule === 'object' ? row.schedule : d.schedule,
    allowed_domains: Array.isArray(row.allowed_domains) ? row.allowed_domains : [],
  };
}

/** Shallow + schedule/domains compare, used for the "unsaved changes" state. */
export function settingsEqual(a: ChatWidgetSettings, b: ChatWidgetSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ------------------------------- color ------------------------------- */

/** WCAG-based pick of readable text on top of the brand color. */
export function readableTextColor(hex: string): '#FFFFFF' | '#111827' {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#FFFFFF';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#111827' : '#FFFFFF';
}

/* -------------------------------- hours ------------------------------ */

export interface WidgetStatus {
  online: boolean;
  /** Whether the launcher should be shown at all. */
  visible: boolean;
  /** Whether the visitor can type & send. */
  canSend: boolean;
}

export function getWidgetStatus(s: Pick<ChatWidgetSettings, 'hours_mode' | 'timezone' | 'schedule' | 'offline_behavior'>, now: Date = new Date()): WidgetStatus {
  let online = true;
  if (s.hours_mode === 'scheduled') {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: isValidTimezone(s.timezone) ? s.timezone : 'UTC', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
    const minutes = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const day = s.schedule[String(wd) as keyof WeekSchedule];
    online = !!day && HHMM.test(day.open) && HHMM.test(day.close) && minutes >= toMinutes(day.open) && minutes < toMinutes(day.close);
  }
  if (online) return { online, visible: true, canSend: true };
  return { online, visible: s.offline_behavior !== 'hide', canSend: s.offline_behavior === 'collect_lead' };
}

export function formatTime12(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh}${suffix}` : `${hh}:${String(m).padStart(2, '0')}${suffix}`;
}

export function scheduleSummary(schedule: WeekSchedule): string {
  const open = DAY_ORDER.filter((d) => schedule[d]);
  if (open.length === 0) return 'Closed every day';
  return open.map((d) => `${DAY_LABELS[Number(d)].slice(0, 3)} ${formatTime12(schedule[d]!.open)}–${formatTime12(schedule[d]!.close)}`).join(' · ');
}

/* ------------------------------ install ------------------------------ */

export interface SnippetInput {
  origin: string;
  publicKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export function buildEmbedSnippet({ origin, publicKey, supabaseUrl, supabaseAnonKey }: SnippetInput): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return [
    '<!-- Vireek chat widget -->',
    '<script',
    `  src="${esc(origin.replace(/\/$/, ''))}/chat-widget.js"`,
    `  data-key="${esc(publicKey)}"`,
    `  data-api="${esc(supabaseUrl.replace(/\/$/, ''))}"`,
    `  data-anon="${esc(supabaseAnonKey)}"`,
    '  async',
    '></script>',
  ].join('\n');
}

/** Maps DB / RPC error codes to friendly copy. */
export function friendlySaveError(err: unknown, fallback = 'Could not save. Please try again.'): string {
  const msg = err instanceof Error ? err.message : typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : '';
  if (msg.includes('CHAT_WIDGET_INVALID_ASSIGNEE')) return 'That team member is no longer part of your account.';
  if (msg.includes('CHAT_WIDGET_FORBIDDEN') || /row-level security/i.test(msg)) return 'You do not have permission to change the chat widget.';
  return fallback;
}
