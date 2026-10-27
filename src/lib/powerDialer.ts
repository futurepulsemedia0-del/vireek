// ============================================================
// Power dialer - types, disposition rules and pure helpers.
// The rules below are the single source of truth mirrored in
// 20271210000100_power_dialer.sql (dialer_complete_attempt) and pinned by powerDialer.test.ts.
// ============================================================

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';
export type PacingMode = 'preview' | 'power';
export type ContactStatus = 'pending' | 'claimed' | 'done' | 'dnc';

export type Disposition =
  | 'no_answer' | 'voicemail' | 'busy' | 'failed' | 'callback_requested'
  | 'interested' | 'booked' | 'not_interested' | 'wrong_number' | 'do_not_call';

export interface DialerCampaign {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  pacing_mode: PacingMode;
  preview_seconds: number;
  wrap_up_seconds: number;
  max_attempts: number;
  retry_minutes: number;
  max_calls_per_hour: number;
  phone_number_id: string | null;
  script: string | null;
  created_at: string;
}

export interface DialerStats {
  campaign_id: string;
  total_contacts: number;
  ready_now: number;
  pending: number;
  claimed: number;
  done: number;
  dnc: number;
  total_attempts: number;
  booked: number;
  interested: number;
}

export interface DialerContact {
  id: string;
  campaign_id: string;
  name: string;
  phone_e164: string;
  notes: string | null;
  status: ContactStatus;
  attempts: number;
  last_disposition: string | null;
  next_attempt_at: string;
  claim_expires_at: string | null;
}

export interface CallerIdOption { id: string; phone_number: string; friendly_name: string }

// ------------------------------------------------------------
// Dispositions
// ------------------------------------------------------------
export interface DispositionRule {
  key: Disposition;
  label: string;
  hotkey: string;
  tone: 'neutral' | 'good' | 'warn' | 'bad';
  countsAttempt: boolean;
  outcome: 'retry' | 'callback' | 'done' | 'dnc';
  needsCallback?: boolean;
}

export const DISPOSITIONS: DispositionRule[] = [
  { key: 'booked', label: 'Booked', hotkey: '1', tone: 'good', countsAttempt: true, outcome: 'done' },
  { key: 'interested', label: 'Interested', hotkey: '2', tone: 'good', countsAttempt: true, outcome: 'done' },
  { key: 'callback_requested', label: 'Call back later', hotkey: '3', tone: 'warn', countsAttempt: false, outcome: 'callback', needsCallback: true },
  { key: 'no_answer', label: 'No answer', hotkey: '4', tone: 'neutral', countsAttempt: true, outcome: 'retry' },
  { key: 'voicemail', label: 'Left voicemail', hotkey: '5', tone: 'neutral', countsAttempt: true, outcome: 'retry' },
  { key: 'busy', label: 'Busy', hotkey: '6', tone: 'neutral', countsAttempt: true, outcome: 'retry' },
  { key: 'not_interested', label: 'Not interested', hotkey: '7', tone: 'bad', countsAttempt: true, outcome: 'done' },
  { key: 'wrong_number', label: 'Wrong number', hotkey: '8', tone: 'bad', countsAttempt: true, outcome: 'done' },
  { key: 'do_not_call', label: 'Do not call', hotkey: '9', tone: 'bad', countsAttempt: true, outcome: 'dnc' },
  { key: 'failed', label: 'Call failed', hotkey: '0', tone: 'neutral', countsAttempt: false, outcome: 'retry' },
];

export const DISPOSITION_LABELS: Record<string, string> = {
  ...Object.fromEntries(DISPOSITIONS.map((d) => [d.key, d.label])),
  abandoned: 'Abandoned',
};

export function dispositionByHotkey(key: string): DispositionRule | undefined {
  return DISPOSITIONS.find((d) => d.hotkey === key);
}

export interface NextState { status: ContactStatus; attempts: number; retryInMinutes: number | null }

/** What happens to a contact after a disposition (mirror of dialer_complete_attempt). */
export function nextContactState(
  disposition: Disposition,
  attemptsSoFar: number,
  campaign: Pick<DialerCampaign, 'max_attempts' | 'retry_minutes'>,
): NextState {
  const rule = DISPOSITIONS.find((d) => d.key === disposition);
  if (!rule) throw new Error(`Unknown disposition: ${disposition}`);
  const attempts = attemptsSoFar + (rule.countsAttempt ? 1 : 0);
  if (rule.outcome === 'dnc') return { status: 'dnc', attempts, retryInMinutes: null };
  if (rule.outcome === 'done') return { status: 'done', attempts, retryInMinutes: null };
  if (rule.outcome === 'callback') return { status: 'pending', attempts, retryInMinutes: null };
  if (disposition === 'failed') return { status: 'pending', attempts, retryInMinutes: Math.min(campaign.retry_minutes, 15) };
  if (attempts >= campaign.max_attempts) return { status: 'done', attempts, retryInMinutes: null };
  return { status: 'pending', attempts, retryInMinutes: campaign.retry_minutes };
}

// ------------------------------------------------------------
// Campaign form
// ------------------------------------------------------------
export interface CampaignForm {
  name: string;
  description: string;
  pacing_mode: PacingMode;
  preview_seconds: number;
  wrap_up_seconds: number;
  max_attempts: number;
  retry_minutes: number;
  max_calls_per_hour: number;
  phone_number_id: string;
  script: string;
}

export const DEFAULT_FORM: CampaignForm = {
  name: '', description: '', pacing_mode: 'power', preview_seconds: 5, wrap_up_seconds: 15,
  max_attempts: 3, retry_minutes: 240, max_calls_per_hour: 60, phone_number_id: '', script: '',
};

const between = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;

export function validateCampaignForm(f: CampaignForm): string | null {
  const name = f.name.trim();
  if (name.length < 1 || name.length > 120) return 'Enter a campaign name (up to 120 characters).';
  if (f.description.trim().length > 500) return 'Description must be 500 characters or fewer.';
  if (f.script.trim().length > 4000) return 'Script must be 4000 characters or fewer.';
  if (!between(f.preview_seconds, 0, 60)) return 'Preview time must be between 0 and 60 seconds.';
  if (!between(f.wrap_up_seconds, 0, 300)) return 'Wrap-up time must be between 0 and 300 seconds.';
  if (!between(f.max_attempts, 1, 10)) return 'Attempts per contact must be between 1 and 10.';
  if (!between(f.retry_minutes, 5, 10080)) return 'Retry delay must be between 5 minutes and 7 days.';
  if (!between(f.max_calls_per_hour, 1, 600)) return 'Calls per hour must be between 1 and 600.';
  return null;
}

export function formFromCampaign(c: DialerCampaign): CampaignForm {
  return {
    name: c.name, description: c.description ?? '', pacing_mode: c.pacing_mode, preview_seconds: c.preview_seconds,
    wrap_up_seconds: c.wrap_up_seconds, max_attempts: c.max_attempts, retry_minutes: c.retry_minutes,
    max_calls_per_hour: c.max_calls_per_hour, phone_number_id: c.phone_number_id ?? '', script: c.script ?? '',
  };
}

// ------------------------------------------------------------
// Import parsing (paste / CSV)
// ------------------------------------------------------------
export interface ImportRow { name: string; phone: string; notes?: string }
export const MAX_IMPORT_ROWS = 5000;

function splitLine(line: string): string[] {
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
    else if (ch === ',' || ch === '\t' || ch === ';') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Accepts "name, phone[, notes]" per line (comma / tab / semicolon). A header row is skipped. */
export function parseImportText(text: string): { rows: ImportRow[]; skipped: number; tooMany: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: ImportRow[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    const cells = splitLine(line);
    if (cells.length < 2) { skipped++; return; }
    if (i === 0 && /^(name|full name|customer)$/i.test(cells[0]) && /phone|mobile|number/i.test(cells[1])) return;
    const [name, phone, ...rest] = cells;
    if (!name || !phone) { skipped++; return; }
    const notes = rest.join(' ').trim();
    rows.push(notes ? { name, phone, notes } : { name, phone });
  });
  return { rows: rows.slice(0, MAX_IMPORT_ROWS), skipped, tooMany: rows.length > MAX_IMPORT_ROWS };
}

// ------------------------------------------------------------
// Console helpers
// ------------------------------------------------------------
export const CLAIM_LEASE_MINUTES = 10;
export const SKIP_DEFER_MINUTES = 30;

export function progressPercent(s: Pick<DialerStats, 'total_contacts' | 'done' | 'dnc'>): number {
  if (s.total_contacts <= 0) return 0;
  return Math.round(((s.done + s.dnc) / s.total_contacts) * 100);
}

export function contactRate(s: Pick<DialerStats, 'total_attempts' | 'booked' | 'interested'>): number {
  if (s.total_attempts <= 0) return 0;
  return Math.round(((s.booked + s.interested) / s.total_attempts) * 100);
}

/** Pacing countdown shown between contacts. */
export function secondsUntil(iso: string | number, now: number = Date.now()): number {
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  return Math.max(0, Math.ceil((t - now) / 1000));
}

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft', active: 'Active', paused: 'Paused', completed: 'Completed', archived: 'Archived',
};

export function nextCampaignStatuses(s: CampaignStatus): CampaignStatus[] {
  switch (s) {
    case 'draft': return ['active', 'archived'];
    case 'active': return ['paused', 'completed'];
    case 'paused': return ['active', 'completed', 'archived'];
    case 'completed': return ['active', 'archived'];
    default: return ['paused'];
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "You don't have permission to do that.",
  not_authenticated: 'Please sign in again.',
  campaign_not_found: 'That campaign was not found.',
  campaign_not_active: 'This campaign is not active.',
  contact_not_found: 'That contact was not found.',
  not_claimed_by_you: 'This contact is no longer assigned to you. Load the next one.',
  contact_suppressed: 'This number is on the do-not-call list.',
  invalid_disposition: 'Choose an outcome for this call.',
  callback_time_required: 'Pick a callback time in the future.',
  note_too_long: 'Notes must be 1000 characters or fewer.',
  caller_id_required: 'Choose a caller ID number before activating the campaign.',
  invalid_caller_id: 'That caller ID is not an active voice number on your account.',
  hourly_cap_reached: "You've reached this campaign's hourly call limit. Try again later.",
  call_in_progress: 'A call is already in progress for this contact.',
  call_already_placed: 'The call was already placed. Choose an outcome instead.',
  agent_phone_missing: 'Add your own mobile number in Account settings so the dialer can ring you.',
  caller_id_missing: 'This campaign has no caller ID number.',
  twilio_failed: 'Could not place the call. Please try again.',
  invalid_payload: 'Nothing to import, or more than 5,000 rows.',
  invalid_source: 'Unknown list source.',
};

export function dialerErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === '23505') return 'A campaign with that name already exists.';
  if (error.message && ERROR_MESSAGES[error.message]) return ERROR_MESSAGES[error.message];
  return 'Something went wrong. Please try again.';
}

/** wrap_up_active carries the remaining seconds in `details`. */
export function parseWrapUp(error: { message?: string; details?: string | null } | null | undefined): number | null {
  if (error?.message !== 'wrap_up_active') return null;
  const n = Number.parseInt(error.details ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
