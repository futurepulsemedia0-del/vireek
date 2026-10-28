/**
 * Dynamic Number Insertion (call tracking by website traffic source) — pure helpers shared by the dashboard.
 * The embed script (public/dni.js) and the database (20280102093000_dynamic_number_insertion.sql) enforce the
 * same limits; keep the three in sync.
 */

export const LIMITS = { maxNumbers: 100, maxRules: 50, maxDomains: 20, minLease: 5, maxLease: 1440, defaultLease: 30 } as const;

export type NumberKind = 'source' | 'pool';
export type MatchField = 'utm_source' | 'utm_medium' | 'utm_campaign' | 'referrer_host' | 'landing_path' | 'click_id';
export type MatchOp = 'equals' | 'contains' | 'present';

export interface DniSettingsRow {
  account_owner_id: string;
  public_key: string;
  enabled: boolean;
  default_number: string | null;
  allowed_domains: string[];
  lease_minutes: number;
  last_seen_at: string | null;
  last_seen_host: string | null;
}

export interface DniNumberRow {
  id: string;
  phone_e164: string;
  vapi_phone_number_id: string | null;
  label: string;
  kind: NumberKind;
  source_key: string | null;
  active: boolean;
  lease_until: string | null;
}

export interface DniRuleRow {
  id: string;
  priority: number;
  match_field: MatchField;
  match_op: MatchOp;
  match_value: string | null;
  source_key: string;
  source_label: string;
  enabled: boolean;
}

export interface SourceStat {
  source_key: string;
  source_label: string;
  sessions: number;
  calls: number;
  last_call_at: string | null;
}

export interface DniPerformance {
  days: number;
  sources: SourceStat[];
  pool: { pool_total: number; pool_leased: number; dedicated: number };
  exhausted_events: number;
  rate_limited_events: number;
}

export interface ClassificationPreview {
  source_key: string;
  source_label: string;
  medium: string;
  number_mode: 'source' | 'pool' | 'default';
  dedicated_number: string | null;
}

/* ------------------------------ catalogues ------------------------------ */

export const BUILTIN_SOURCES: { key: string; label: string }[] = [
  { key: 'google_ads', label: 'Google Ads' },
  { key: 'google_organic', label: 'Google Search (organic)' },
  { key: 'google_business_profile', label: 'Google Business Profile' },
  { key: 'bing_ads', label: 'Microsoft Ads' },
  { key: 'bing_organic', label: 'Bing (organic)' },
  { key: 'meta', label: 'Facebook / Instagram' },
  { key: 'tiktok_ads', label: 'TikTok Ads' },
  { key: 'email', label: 'Email' },
  { key: 'sms', label: 'Text message' },
  { key: 'yelp', label: 'Yelp' },
  { key: 'nextdoor', label: 'Nextdoor' },
  { key: 'referral', label: 'Referral sites' },
  { key: 'organic_search', label: 'Other search engines' },
  { key: 'direct', label: 'Direct' },
];

export const FIELD_LABELS: Record<MatchField, string> = {
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  referrer_host: 'Referring site',
  landing_path: 'Landing page path',
  click_id: 'Ad click ID type',
};
export const OP_LABELS: Record<MatchOp, string> = { equals: 'is exactly', contains: 'contains', present: 'is present' };
export const MATCH_FIELDS = Object.keys(FIELD_LABELS) as MatchField[];
export const MATCH_OPS = Object.keys(OP_LABELS) as MatchOp[];

export function sourceLabel(key: string, rules: DniRuleRow[] = []): string {
  const rule = rules.find((r) => r.source_key === key);
  if (rule) return rule.source_label;
  const builtin = BUILTIN_SOURCES.find((s) => s.key === key);
  if (builtin) return builtin.label;
  const cleaned = key.replace(/^utm_/, '').replace(/_/g, ' ').trim();
  return cleaned ? cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) : key;
}

/** Sources a dedicated number can be tied to: built-ins plus every custom rule source, de-duplicated. */
export function sourceOptions(rules: DniRuleRow[]): { key: string; label: string }[] {
  const out = [...BUILTIN_SOURCES];
  for (const r of rules) if (!out.some((o) => o.key === r.source_key)) out.push({ key: r.source_key, label: r.source_label });
  return out;
}

/* ------------------------------ phone numbers ------------------------------ */

/** Returns +E.164 or null. 10 digits (or 11 starting with 1) are treated as US/Canada; anything else needs a leading +. */
export function normalizeE164(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  let e164: string;
  if (raw.startsWith('+') || raw.startsWith('00')) e164 = '+' + (raw.startsWith('00') ? d.slice(2) : d);
  else if (d.length === 10) e164 = '+1' + d;
  else if (d.length === 11 && d.startsWith('1')) e164 = '+' + d;
  else return null;
  return /^\+[1-9][0-9]{6,14}$/.test(e164) ? e164 : null;
}

export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '—';
  const d = e164.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return `+${d}`;
}

export function slugifySourceKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/* ------------------------------ domains ------------------------------ */

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** One domain per line (or comma separated). Strips protocol, path and www. Returns clean list + the lines it rejected. */
export function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\n,]+/)) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    const host = t.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
    if (!DOMAIN_RE.test(host)) invalid.push(part.trim());
    else if (!domains.includes(host)) domains.push(host);
  }
  return { domains, invalid };
}

/* ------------------------------ validation ------------------------------ */

export interface SettingsDraft { enabled: boolean; defaultNumber: string; domainsText: string; leaseMinutes: number }
export interface NumberDraft { kind: NumberKind; phone: string; sourceKey: string; label: string; vapiId: string }
export interface RuleDraft { field: MatchField; op: MatchOp; value: string; sourceLabel: string; priority: number }

export type Errors<T extends string> = Partial<Record<T, string>>;
export const hasErrors = (e: object) => Object.keys(e).length > 0;

export function validateSettings(d: SettingsDraft): Errors<'defaultNumber' | 'domains' | 'lease'> {
  const e: Errors<'defaultNumber' | 'domains' | 'lease'> = {};
  if (d.defaultNumber.trim() && !normalizeE164(d.defaultNumber)) e.defaultNumber = 'Enter a valid phone number, e.g. (555) 123-4567 or +44 20 7123 4567.';
  if (d.enabled && !normalizeE164(d.defaultNumber)) e.defaultNumber = 'Your normal business number is required to turn tracking on — it is the number the script looks for on your pages.';
  const { domains, invalid } = parseDomains(d.domainsText);
  if (invalid.length) e.domains = `Not a valid domain: ${invalid.slice(0, 3).join(', ')}`;
  else if (domains.length > LIMITS.maxDomains) e.domains = `At most ${LIMITS.maxDomains} domains.`;
  if (!Number.isInteger(d.leaseMinutes) || d.leaseMinutes < LIMITS.minLease || d.leaseMinutes > LIMITS.maxLease)
    e.lease = `Between ${LIMITS.minLease} and ${LIMITS.maxLease} minutes.`;
  return e;
}

export function validateNumber(d: NumberDraft, existing: DniNumberRow[], defaultNumber: string | null): Errors<'phone' | 'sourceKey' | 'label' | 'vapiId'> {
  const e: Errors<'phone' | 'sourceKey' | 'label' | 'vapiId'> = {};
  const phone = normalizeE164(d.phone);
  if (!phone) e.phone = 'Enter a valid phone number.';
  else if (existing.some((n) => n.phone_e164 === phone)) e.phone = 'This number is already in your list.';
  else if (defaultNumber && phone === defaultNumber) e.phone = 'This is your normal business number — tracking numbers must be different.';
  if (d.kind === 'source') {
    if (!/^[a-z0-9_]{1,40}$/.test(d.sourceKey)) e.sourceKey = 'Pick a source.';
    else if (existing.some((n) => n.kind === 'source' && n.source_key === d.sourceKey)) e.sourceKey = 'That source already has a dedicated number.';
  }
  if (d.label.length > 80) e.label = 'At most 80 characters.';
  if (d.vapiId.trim().length > 120) e.vapiId = 'Too long.';
  if (existing.length >= LIMITS.maxNumbers) e.phone = `You can add up to ${LIMITS.maxNumbers} numbers.`;
  return e;
}

export function validateRule(d: RuleDraft, count: number): Errors<'value' | 'sourceLabel' | 'priority'> {
  const e: Errors<'value' | 'sourceLabel' | 'priority'> = {};
  if (d.op !== 'present' && !d.value.trim()) e.value = 'Enter the text to match.';
  if (d.value.trim().length > 120) e.value = 'At most 120 characters.';
  const label = d.sourceLabel.trim();
  if (!label) e.sourceLabel = 'Give this source a name.';
  else if (label.length > 60) e.sourceLabel = 'At most 60 characters.';
  else if (!slugifySourceKey(label)) e.sourceLabel = 'Use letters or numbers in the name.';
  if (!Number.isInteger(d.priority) || d.priority < 1 || d.priority > 1000) e.priority = 'Between 1 and 1000.';
  if (count >= LIMITS.maxRules) e.sourceLabel = `You can add up to ${LIMITS.maxRules} rules.`;
  return e;
}

/* ------------------------------ install ------------------------------ */

export interface SnippetInput { origin: string; publicKey: string; supabaseUrl: string; supabaseAnonKey: string; requireConsent: boolean }
const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function buildSnippet({ origin, publicKey, supabaseUrl, supabaseAnonKey, requireConsent }: SnippetInput): string {
  const lines = [
    '<!-- Vireek call tracking -->',
    '<script',
    `  src="${escAttr(origin.replace(/\/$/, ''))}/dni.js"`,
    `  data-key="${escAttr(publicKey)}"`,
    `  data-api="${escAttr(supabaseUrl.replace(/\/$/, ''))}"`,
    `  data-anon="${escAttr(supabaseAnonKey)}"`,
  ];
  if (requireConsent) lines.push('  data-consent="required"');
  lines.push('  async', '></script>');
  return lines.join('\n');
}

/** Same signals the script sends, parsed from a pasted URL — powers the "test a visit" tool. */
export function parseSignalsFromUrl(url: string, referrer: string): { signals: Record<string, string>; host: string | null } | null {
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`); } catch { return null; }
  if (!u.hostname.includes('.')) return null;
  const signals: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = u.searchParams.get(k);
    if (v) signals[k] = v.slice(0, 120);
  }
  for (const id of ['gclid', 'gbraid', 'wbraid', 'msclkid', 'fbclid', 'ttclid']) {
    const v = u.searchParams.get(id);
    if (v) { signals.click_id_type = id; signals.click_id = v.slice(0, 120); break; }
  }
  signals.landing_path = u.pathname.slice(0, 200);
  const ref = referrer.trim();
  if (ref) signals.referrer = /^[a-z]+:\/\//i.test(ref) ? ref : `https://${ref}`;
  return { signals, host: u.hostname.toLowerCase().replace(/^www\./, '') };
}

/* ------------------------------ analytics ------------------------------ */

export interface SourceRow extends SourceStat { callRate: number | null; sessionShare: number }
export interface PerformanceSummary { sessions: number; calls: number; callRate: number | null; rows: SourceRow[] }

export function summarizePerformance(p: DniPerformance | null): PerformanceSummary {
  const sources = p?.sources ?? [];
  const sessions = sources.reduce((a, s) => a + s.sessions, 0);
  const calls = sources.reduce((a, s) => a + s.calls, 0);
  const rows = sources.map((s) => ({
    ...s,
    callRate: s.sessions > 0 ? s.calls / s.sessions : null,
    sessionShare: sessions > 0 ? s.sessions / sessions : 0,
  }));
  return { sessions, calls, callRate: sessions > 0 ? calls / sessions : null, rows };
}

export const formatPercent = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);
export const formatCount = (n: number) => n.toLocaleString('en-US');

export type Health = { level: 'ok' | 'warn' | 'danger' | 'info'; message: string };

export function poolHealth(p: DniPerformance | null): Health {
  const total = p?.pool.pool_total ?? 0;
  const leased = p?.pool.pool_leased ?? 0;
  if (!p || (total === 0 && p.pool.dedicated === 0)) return { level: 'info', message: 'No tracking numbers yet — add a pool or a dedicated number to start swapping.' };
  if (p.exhausted_events > 0) return { level: 'danger', message: `The pool ran out ${formatCount(p.exhausted_events)} time${p.exhausted_events === 1 ? '' : 's'} in this period — those visitors saw your normal number. Add more pool numbers.` };
  if (total > 0 && leased / total >= 0.8) return { level: 'warn', message: `${leased} of ${total} pool numbers are in use right now. Add more before a busy period.` };
  if (total === 0) return { level: 'ok', message: 'Dedicated numbers only — every visitor from a tracked source sees that source’s number.' };
  return { level: 'ok', message: `${leased} of ${total} pool numbers in use.` };
}

export function readinessIssues(s: DniSettingsRow | null, numbers: DniNumberRow[], now = Date.now()): string[] {
  const issues: string[] = [];
  if (!s?.default_number) issues.push('Add your normal business number — the script swaps that number wherever it appears on your site.');
  if (!numbers.some((n) => n.active)) issues.push('Add at least one tracking number, otherwise every visitor keeps your normal number.');
  if (s?.enabled && !s.last_seen_at) issues.push('Tracking is on, but the snippet has not been seen on your website yet. Paste it before </body> on every page.');
  else if (s?.enabled && s.last_seen_at && now - Date.parse(s.last_seen_at) > 7 * 86_400_000)
    issues.push('The snippet has not loaded on your website for over 7 days. Check that it is still installed.');
  return issues;
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function friendlyError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '');
  if (msg.includes('idx_dni_numbers_phone') || /dni_numbers.*duplicate/i.test(msg)) return 'That phone number is already used as a tracking number.';
  if (msg.includes('idx_dni_numbers_source')) return 'That source already has a dedicated number.';
  if (msg.includes('DNI_LIMIT_NUMBERS')) return `You can add up to ${LIMITS.maxNumbers} numbers.`;
  if (msg.includes('DNI_LIMIT_RULES')) return `You can add up to ${LIMITS.maxRules} rules.`;
  if (msg.includes('DNI_NOT_CONFIGURED')) return 'Save your settings first, then try again.';
  if (msg.includes('DNI_FORBIDDEN') || /row-level security|permission denied/i.test(msg)) return 'You don’t have permission to change call tracking.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Network problem — check your connection and try again.';
  return fallback;
}
