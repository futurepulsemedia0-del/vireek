import type { HomeJob, ScopeKey, ShareScopes } from './types';
import { SCOPE_KEYS } from './types';

export const SCOPE_META: Record<ScopeKey, { label: string; description: string }> = {
  jobs: { label: 'Appointments & history', description: 'Upcoming visits and your past service history.' },
  invoices: { label: 'Invoices & payments', description: 'Invoices, amounts due and payment status.' },
  equipment: { label: 'Equipment & warranties', description: 'Your equipment, warranty dates and equipment passports.' },
  documents: { label: 'Documents', description: 'Files this business chooses to share with you.' },
  health: { label: 'Home health', description: 'Your home health score and maintenance recommendations.' },
};

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_MAX_COUNT = 6;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** E.164 from user input. 10-digit numbers are treated as US; anything else needs a leading "+". */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  let e164: string;
  if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export function isOtp(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** Accepts a bare token or a full /portal/<token> link. */
export function extractPortalToken(input: string): string | null {
  const m = UUID_RX.exec(input);
  return m ? m[0].toLowerCase() : null;
}

export function formatMoney(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
}

function parseDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(iso: string | null | undefined): string {
  const d = iso ? parseDate(iso) : null;
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export function formatDateTime(iso: string | null | undefined): string {
  const d = iso ? parseDate(iso) : null;
  return d
    ? d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'To be scheduled';
}

const OPEN: ReadonlySet<string> = new Set(['scheduled', 'en_route', 'in_progress']);

export function splitJobs(jobs: HomeJob[]): { upcoming: HomeJob[]; past: HomeJob[] } {
  const time = (j: HomeJob) => (j.scheduled_datetime ? new Date(j.scheduled_datetime).getTime() : Number.MAX_SAFE_INTEGER);
  const upcoming = jobs.filter((j) => OPEN.has(j.job_status)).sort((a, b) => time(a) - time(b));
  const past = jobs.filter((j) => !OPEN.has(j.job_status));
  return { upcoming, past };
}

export function enabledScopes(scopes: ShareScopes): ScopeKey[] {
  return SCOPE_KEYS.filter((k) => scopes[k]);
}

export function scopeSummary(scopes: ShareScopes): string {
  const on = enabledScopes(scopes);
  return on.length ? on.map((k) => SCOPE_META[k].label).join(' · ') : 'Nothing shared';
}

export function validatePhotoFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!PHOTO_TYPES.includes(file.type.toLowerCase())) return 'Use a JPG, PNG, WebP or HEIC photo.';
  if (file.size <= 0) return 'That photo looks empty.';
  if (file.size > PHOTO_MAX_BYTES) return 'Photos must be under 10 MB.';
  return null;
}

export function buildPhotoPath(userId: string, file: Pick<File, 'type'>): string {
  const t = file.type.toLowerCase();
  const ext = t.includes('png') ? 'png' : t.includes('webp') ? 'webp' : t.includes('hei') ? 'heic' : 'jpg';
  return `${userId}/${crypto.randomUUID()}.${ext}`;
}

export function invoiceStatusLabel(status: string): string {
  switch (status) {
    case 'paid': return 'Paid';
    case 'sent': return 'Due';
    case 'viewed': return 'Due';
    case 'overdue': return 'Overdue';
    case 'void': return 'Void';
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export const SERVICE_TYPES = [
  'AC / Heating', 'Plumbing', 'Electrical', 'Water heater', 'Roof', 'Appliance', 'Other',
] as const;
