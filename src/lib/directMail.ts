// src/lib/directMail.ts
//
// Pure helpers for the Direct Mail (postcard) channel: types, CSV import, report maths, labels.
// Rules shared with the edge functions live in supabase/functions/_shared/direct-mail/engine.ts
// (tracking codes, address checks, artwork, signature). Server side: migration
// 20271102000000_direct_mail_channel.sql + functions direct-mail-send / -settings / -webhook.

import {
  addressKey,
  generateTrackingCode,
  normalizeAddress,
  parseSingleLineAddress,
  validateAddress,
  type MailAddress,
  type MailType,
  type PieceStatus,
  type PostcardSize,
} from '../../supabase/functions/_shared/direct-mail/engine';

export {
  GEOMETRY,
  addressKey,
  campaignUtm,
  formatTrackingCode,
  generateTrackingCode,
  isValidTrackingCode,
  landingRedirectPath,
  normalizeAddress,
  normalizeTrackingCode,
  scanUrl,
  validateAddress,
  type MailAddress,
  type MailType,
  type PieceStatus,
  type PostcardSize,
} from '../../supabase/functions/_shared/direct-mail/engine';

export type CampaignStatus = 'draft' | 'sending' | 'paused' | 'completed' | 'cancelled';

export interface DirectMailSettings {
  configured: boolean;
  api_mode: 'test' | 'live' | null;
  api_key_last4: string | null;
  webhook_secret_set: boolean;
  webhook_token: string | null;
  return_address: { name: string | null; line1: string | null; line2: string | null; city: string | null; state: string | null; zip: string | null } | null;
  default_landing_page_id: string | null;
}

export interface Campaign {
  id: string;
  user_id: string;
  name: string;
  status: CampaignStatus;
  landing_page_id: string | null;
  size: PostcardSize;
  mail_type: MailType;
  headline: string;
  offer: string;
  cta: string;
  phone: string;
  accent_color: string;
  est_unit_cost_cents: number;
  budget_cap_cents: number | null;
  created_at: string;
  sent_at: string | null;
}

export interface Piece {
  id: string;
  campaign_id: string;
  tracking_code: string;
  recipient_name: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
  status: PieceStatus;
  provider_url: string | null;
  expected_delivery: string | null;
  cost_cents: number | null;
  cost_estimated: boolean;
  last_error: string | null;
  scan_count: number;
  submitted_at: string | null;
  delivered_at: string | null;
  verification_status?: 'unverified' | 'deliverable' | 'review' | 'undeliverable';
  verification_note?: string | null;
}

export interface CampaignReportRow {
  campaign_id: string;
  name: string;
  status: CampaignStatus;
  size: PostcardSize;
  created_at: string;
  sent_at: string | null;
  pieces_total: number;
  queued: number;
  in_mail: number;
  delivered: number;
  returned: number;
  failed: number;
  mailed: number;
  cost_cents: number;
  cost_estimated_pieces: number;
  scanned_pieces: number;
  scans: number;
  landing_views: number;
  landing_visitors: number;
  leads: number;
  responders: number;
  booked_jobs: number;
  completed_jobs: number;
  revenue: number;
}

export interface CampaignDraft {
  name: string;
  landing_page_id: string;
  size: PostcardSize;
  mail_type: MailType;
  headline: string;
  offer: string;
  cta: string;
  phone: string;
  accent_color: string;
  est_unit_cost: string; // dollars, as typed
  budget_cap: string; // dollars, as typed ('' = no cap)
}

export const EMPTY_DRAFT: CampaignDraft = {
  name: '',
  landing_page_id: '',
  size: '6x9',
  mail_type: 'usps_standard',
  headline: '',
  offer: '',
  cta: 'Scan to book online',
  phone: '',
  accent_color: '#0F62FE',
  est_unit_cost: '',
  budget_cap: '',
};

export const SIZE_OPTIONS: { value: PostcardSize; label: string }[] = [
  { value: '4x6', label: '4 × 6 in' },
  { value: '6x9', label: '6 × 9 in' },
  { value: '6x11', label: '6 × 11 in' },
];

export const MAIL_TYPE_OPTIONS: { value: MailType; label: string; hint: string }[] = [
  { value: 'usps_standard', label: 'USPS Standard (Marketing)', hint: 'Lowest cost, slower (about 5–10 business days)' },
  { value: 'usps_first_class', label: 'USPS First-Class', hint: 'Faster (about 3–5 business days), costs more' },
];

// ------------------------------------------------------------------ money / ratios
export const dollarsToCents = (v: string): number | null => {
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return String(v).trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });
}

export const formatPercent = (ratio: number | null): string => (ratio === null ? '—' : `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`);

const safeDiv = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export interface CampaignMetrics {
  responseRate: number | null; // responders / mailed
  scanRate: number | null; // scanned pieces / mailed
  costPerResponse: number | null; // cents
  costPerLead: number | null; // cents
  costPerBookedJob: number | null; // cents
  revenueDollars: number;
  roas: number | null; // revenue / cost
  costIsEstimate: boolean;
}

export function computeMetrics(r: Pick<CampaignReportRow, 'mailed' | 'responders' | 'scanned_pieces' | 'cost_cents' | 'leads' | 'booked_jobs' | 'revenue' | 'cost_estimated_pieces'>): CampaignMetrics {
  const costDollars = r.cost_cents / 100;
  const cpj = safeDiv(r.cost_cents, r.booked_jobs);
  return {
    responseRate: safeDiv(r.responders, r.mailed),
    scanRate: safeDiv(r.scanned_pieces, r.mailed),
    costPerResponse: (() => { const v = safeDiv(r.cost_cents, r.responders); return v === null ? null : Math.round(v); })(),
    costPerLead: (() => { const v = safeDiv(r.cost_cents, r.leads); return v === null ? null : Math.round(v); })(),
    costPerBookedJob: cpj === null ? null : Math.round(cpj),
    revenueDollars: r.revenue,
    roas: safeDiv(r.revenue, costDollars),
    costIsEstimate: r.cost_estimated_pieces > 0,
  };
}

/** Sums campaigns. A job attributed to two campaigns would count twice; this is rare and documented. */
export function totalReport(rows: CampaignReportRow[]): CampaignReportRow {
  const base: CampaignReportRow = {
    campaign_id: 'total', name: 'All campaigns', status: 'completed', size: '6x9', created_at: '', sent_at: null,
    pieces_total: 0, queued: 0, in_mail: 0, delivered: 0, returned: 0, failed: 0, mailed: 0, cost_cents: 0,
    cost_estimated_pieces: 0, scanned_pieces: 0, scans: 0, landing_views: 0, landing_visitors: 0, leads: 0,
    responders: 0, booked_jobs: 0, completed_jobs: 0, revenue: 0,
  };
  for (const r of rows) {
    for (const k of Object.keys(base) as (keyof CampaignReportRow)[]) {
      if (typeof base[k] === 'number') (base[k] as number) += Number(r[k] ?? 0);
    }
  }
  return base;
}

export function parseReport(data: unknown): CampaignReportRow[] {
  if (!Array.isArray(data)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  return data.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      campaign_id: String(r.campaign_id), name: String(r.name ?? ''), status: r.status as CampaignStatus, size: r.size as PostcardSize,
      created_at: String(r.created_at ?? ''), sent_at: (r.sent_at as string | null) ?? null,
      pieces_total: num(r.pieces_total), queued: num(r.queued), in_mail: num(r.in_mail), delivered: num(r.delivered),
      returned: num(r.returned), failed: num(r.failed), mailed: num(r.mailed), cost_cents: num(r.cost_cents),
      cost_estimated_pieces: num(r.cost_estimated_pieces), scanned_pieces: num(r.scanned_pieces), scans: num(r.scans),
      landing_views: num(r.landing_views), landing_visitors: num(r.landing_visitors), leads: num(r.leads),
      responders: num(r.responders), booked_jobs: num(r.booked_jobs), completed_jobs: num(r.completed_jobs), revenue: num(r.revenue),
    };
  });
}

// ------------------------------------------------------------------ labels
export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export const PIECE_STATUS: Record<PieceStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'muted' },
  submitting: { label: 'Sending…', tone: 'info' },
  submitted: { label: 'Sent to printer', tone: 'info' },
  in_transit: { label: 'In the mail', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'ok' },
  returned: { label: 'Returned', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'muted' },
  sending: { label: 'Sending', tone: 'info' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Sent', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

// ------------------------------------------------------------------ draft validation
export type DraftErrors = Partial<Record<keyof CampaignDraft, string>>;

export function validateDraft(d: CampaignDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = 'Give the campaign a name.';
  else if (d.name.trim().length > 120) e.name = 'Keep the name under 120 characters.';
  if (!d.landing_page_id) e.landing_page_id = 'Choose the landing page the QR code opens.';
  if (!d.headline.trim()) e.headline = 'Add a headline.';
  else if (d.headline.length > 80) e.headline = 'Max 80 characters.';
  if (!d.offer.trim()) e.offer = 'Add the offer.';
  else if (d.offer.length > 160) e.offer = 'Max 160 characters.';
  if (d.cta.length > 60) e.cta = 'Max 60 characters.';
  if (d.phone.length > 32) e.phone = 'Max 32 characters.';
  if (!/^#[0-9a-fA-F]{6}$/.test(d.accent_color)) e.accent_color = 'Use a 6-digit hex color like #0F62FE.';
  const unit = dollarsToCents(d.est_unit_cost);
  if (unit === null || unit > 10000) e.est_unit_cost = 'Enter the expected cost per mailer (e.g. 0.85).';
  if (d.budget_cap.trim()) {
    const cap = dollarsToCents(d.budget_cap);
    if (cap === null || cap <= 0) e.budget_cap = 'Enter a positive dollar amount, or leave empty.';
    else if (unit !== null && cap < unit) e.budget_cap = 'The cap is lower than one mailer.';
  }
  return e;
}

// ------------------------------------------------------------------ recipient import
export interface ParsedRecipient extends MailAddress {
  tracking_code: string;
}
export interface ImportRowError { line: number; reason: string; raw: string }
export interface ImportResult { recipients: MailAddress[]; errors: ImportRowError[]; duplicates: number }

const REASONS: Record<string, string> = {
  name_required: 'missing name', line1_required: 'missing street address', city_required: 'missing city',
  state_invalid: 'invalid state', zip_invalid: 'invalid ZIP code',
};

/** Minimal RFC-4180 style splitter for one line (quotes + commas). */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const HEADER_ALIASES: Record<keyof MailAddress, string[]> = {
  name: ['name', 'fullname', 'recipient', 'customer', 'customername'],
  line1: ['address', 'address1', 'addressline1', 'street', 'street1', 'line1'],
  line2: ['address2', 'addressline2', 'street2', 'line2', 'unit', 'apt', 'suite'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  zip: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode'],
};

/** Parses pasted CSV/TSV with a header row (name, address, address2, city, state, zip in any order). */
export function parseRecipientsCsv(text: string): ImportResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const errors: ImportRowError[] = [];
  if (lines.length < 2) return { recipients: [], errors: [{ line: 1, reason: 'add a header row and at least one recipient', raw: lines[0] ?? '' }], duplicates: 0 };

  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = {} as Record<keyof MailAddress, number>;
  for (const key of Object.keys(HEADER_ALIASES) as (keyof MailAddress)[]) {
    col[key] = header.findIndex((h) => HEADER_ALIASES[key].includes(h));
  }
  const missing = (['name', 'line1', 'city', 'state', 'zip'] as const).filter((k) => col[k] < 0);
  if (missing.length) {
    return { recipients: [], errors: [{ line: 1, reason: `missing column: ${missing.join(', ')}`, raw: lines[0] }], duplicates: 0 };
  }

  const seen = new Set<string>();
  const recipients: MailAddress[] = [];
  let duplicates = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const addr = normalizeAddress({
      name: cells[col.name], line1: cells[col.line1], line2: col.line2 >= 0 ? cells[col.line2] : '',
      city: cells[col.city], state: cells[col.state], zip: cells[col.zip],
    });
    const problems = validateAddress(addr);
    if (problems.length) { errors.push({ line: i + 1, reason: problems.map((p) => REASONS[p] ?? p).join(', '), raw: lines[i] }); continue; }
    const key = addressKey(addr);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    recipients.push(addr);
  }
  return { recipients, errors, duplicates };
}

/** Customers only have one free-text address; only those that parse cleanly are importable. */
export function customersToRecipients(customers: { name: string | null; address: string | null }[]): ImportResult {
  const errors: ImportRowError[] = [];
  const seen = new Set<string>();
  const recipients: MailAddress[] = [];
  let duplicates = 0;
  customers.forEach((c, i) => {
    const parsed = c.address ? parseSingleLineAddress(c.address) : null;
    const name = (c.name ?? '').trim();
    if (!parsed || !name) { errors.push({ line: i + 1, reason: !name ? 'missing name' : 'address could not be parsed', raw: `${name} — ${c.address ?? ''}` }); return; }
    const addr = normalizeAddress({ name, ...parsed });
    if (validateAddress(addr).length) { errors.push({ line: i + 1, reason: 'invalid address', raw: `${name} — ${c.address}` }); return; }
    const key = addressKey(addr);
    if (seen.has(key)) { duplicates++; return; }
    seen.add(key);
    recipients.push(addr);
  });
  return { recipients, errors, duplicates };
}

/** Attaches a fresh tracking code to every recipient (unique inside the batch). */
export function withTrackingCodes(recipients: MailAddress[], used: Set<string> = new Set()): ParsedRecipient[] {
  return recipients.map((r) => {
    let code = generateTrackingCode();
    while (used.has(code)) code = generateTrackingCode();
    used.add(code);
    return { ...r, tracking_code: code };
  });
}

export const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// ------------------------------------------------------------------ errors
const ERROR_COPY: Record<string, string> = {
  not_authorized: 'You do not have permission to manage direct mail.',
  campaign_locked: 'This campaign has already been sent or is sending, so it can no longer be edited.',
  campaign_not_found: 'That campaign no longer exists.',
  campaign_has_mailed_pieces: 'Mailers were already printed for this campaign, so it cannot be deleted.',
  campaign_too_large: 'A campaign can hold at most 20,000 recipients.',
  landing_page_not_found: 'That landing page no longer exists.',
  return_address_incomplete: 'Fill in the full return address.',
  return_address_invalid: 'The return address needs a 2-letter state and a valid ZIP code.',
  invalid_transition: 'That action is not available for this campaign right now.',
  code_not_found: 'No mailer with that code was found. Check the code on the postcard.',
  key_rejected: 'The print provider rejected this API key.',
  invalid_key_format: 'That does not look like a Lob API key (it starts with test_ or live_).',
  invalid_webhook_secret: 'The webhook signing secret looks invalid.',
  provider_unreachable: 'Could not reach the print provider. Please try again.',
  provider_not_configured: 'Connect your print provider first (Setup tab).',
  return_address_missing: 'Add a complete return address first (Setup tab).',
  landing_page_not_published: 'Publish the landing page first — the QR code would otherwise open nothing.',
  creative_incomplete: 'Add a headline and an offer before sending.',
  nothing_to_send: 'This campaign has no recipients waiting to be mailed.',
  campaign_not_sendable: 'This campaign cannot be sent in its current state.',
};

export function directMailErrorMessage(err: { code?: string; message?: string } | string | null | undefined, fallback: string): string {
  const raw = typeof err === 'string' ? err : `${err?.message ?? ''}`;
  for (const key of Object.keys(ERROR_COPY)) if (raw.includes(key)) return ERROR_COPY[key];
  if (typeof err === 'object' && err?.code === '42501') return ERROR_COPY.not_authorized;
  return fallback;
}

// ------------------------------------------------------------------ webhook URL
export function webhookUrl(supabaseUrl: string, token: string | null): string {
  return token ? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/direct-mail-webhook/${token}` : '';
}

export function maskToken(url: string): string {
  return url.replace(/([0-9a-f]{6})[0-9a-f]{52}([0-9a-f]{6})$/i, '$1••••••••••$2');
}
