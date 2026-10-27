// ============================================================
// Call masking (proxy numbers) - types and pure helpers.
// DB rules live in 20271210000000_call_masking_proxy_numbers.sql.
// ============================================================

export type ProxyNumberStatus = 'active' | 'paused' | 'retired';
export type ProxySessionStatus = 'active' | 'closed' | 'expired';
export type SessionFilter = 'active' | 'ended' | 'all';

export interface ProxyNumber {
  id: string;
  e164: string;
  label: string | null;
  status: ProxyNumberStatus;
  created_at: string;
}

export interface ProxyNumberStats {
  number_id: string;
  active_sessions: number;
  total_sessions: number;
  calls_30d: number;
}

export interface ProxySession {
  id: string;
  proxy_number_id: string;
  job_id: string | null;
  technician_id: string | null;
  customer_name: string;
  technician_name: string | null;
  customer_e164: string;
  technician_e164: string;
  status: ProxySessionStatus;
  expires_at: string;
  closed_at: string | null;
  close_reason: string | null;
  created_at: string;
}

export interface MySession {
  id: string;
  job_id: string | null;
  customer_name: string;
  proxy_e164: string;
  expires_at: string;
  created_at: string;
}

export interface ProxyCallEvent {
  id: string;
  session_id: string | null;
  direction: string;
  status: string;
  duration_seconds: number | null;
  created_at: string;
}

export interface TechnicianOption {
  id: string;
  member_name: string | null;
  member_email: string;
  member_phone: string | null;
}

export const TTL_OPTIONS: { hours: number; label: string }[] = [
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];
export const DEFAULT_TTL_HOURS = 72;
export const MAX_LABEL_LENGTH = 80;

/** Mirrors public.normalize_phone_e164() in the database. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const d = t.replace(/\D/g, '');
  if (t.startsWith('+')) return /^[1-9][0-9]{7,14}$/.test(d) ? `+${d}` : null;
  if (/^[2-9][0-9]{9}$/.test(d)) return `+1${d}`;
  if (/^1[2-9][0-9]{9}$/.test(d)) return `+${d}`;
  return null;
}

/** +15552010001 -> (555) 201-0001 ; other countries stay in E.164. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+1([2-9]\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function telHref(e164: string): string {
  return `tel:${e164.replace(/[^\d+]/g, '')}`;
}

export function validateProxyNumber(raw: string, label: string): { e164?: string; label?: string; error?: string } {
  const e164 = normalizePhone(raw);
  if (!e164) return { error: 'Enter a valid phone number, for example +1 555 201 0001.' };
  const trimmed = label.trim();
  if (trimmed.length > MAX_LABEL_LENGTH) return { error: `Label must be ${MAX_LABEL_LENGTH} characters or fewer.` };
  return { e164, label: trimmed || undefined };
}

export interface SessionInput {
  technicianId: string;
  customerName: string;
  customerPhone: string;
  ttlHours: number;
}

export function validateSessionInput(input: SessionInput): string | null {
  if (!input.technicianId) return 'Choose a technician.';
  const name = input.customerName.trim();
  if (name.length < 1 || name.length > 120) return 'Enter the customer name (up to 120 characters).';
  if (!normalizePhone(input.customerPhone)) return 'Enter a valid customer phone number.';
  if (!TTL_OPTIONS.some((o) => o.hours === input.ttlHours)) return 'Choose how long the number stays active.';
  return null;
}

/** Effective state: a session whose time ran out is "expired" even before the database sweeps it. */
export function effectiveStatus(s: Pick<ProxySession, 'status' | 'expires_at'>, now: number = Date.now()): ProxySessionStatus {
  if (s.status === 'active' && new Date(s.expires_at).getTime() <= now) return 'expired';
  return s.status;
}

export function filterSessions(list: ProxySession[], filter: SessionFilter, query: string, now: number = Date.now()): ProxySession[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/[^\d]/g, '');
  return list.filter((s) => {
    const live = effectiveStatus(s, now) === 'active';
    if (filter === 'active' && !live) return false;
    if (filter === 'ended' && live) return false;
    if (!q) return true;
    return (
      s.customer_name.toLowerCase().includes(q) ||
      (s.technician_name ?? '').toLowerCase().includes(q) ||
      (digits.length >= 3 && s.customer_e164.replace(/\D/g, '').includes(digits))
    );
  });
}

export function timeLeftLabel(expiresAt: string, now: number = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return 'Expired';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min left`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h left`;
  return `${Math.floor(hours / 24)} days left`;
}

export function closeReasonLabel(reason: string | null): string {
  const labels: Record<string, string> = {
    manual: 'Closed manually',
    expired: 'Expired',
    job_cancelled: 'Job cancelled',
    number_retired: 'Number retired',
    done: 'Closed',
  };
  return reason ? (labels[reason] ?? reason) : 'Closed';
}

export function summarizeNumbers(numbers: ProxyNumber[], stats: Record<string, ProxyNumberStats>) {
  const usable = numbers.filter((n) => n.status === 'active');
  const live = usable.reduce((sum, n) => sum + (stats[n.id]?.active_sessions ?? 0), 0);
  return { total: numbers.length, usable: usable.length, liveSessions: live };
}

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "You don't have permission to do that.",
  not_authenticated: 'Please sign in again.',
  invalid_phone: 'That phone number is not valid.',
  invalid_customer_phone: 'That customer phone number is not valid.',
  invalid_customer_name: 'Enter the customer name (up to 120 characters).',
  invalid_ttl: 'Choose a duration between 1 hour and 30 days.',
  technician_not_found: 'That technician was not found.',
  technician_phone_missing: "This technician has no mobile number yet. Add it under 'Technician phones'.",
  same_phone: 'The customer and technician cannot share a phone number.',
  phone_is_proxy_number: 'That number is one of your proxy numbers and cannot be a participant.',
  job_not_found: 'That job was not found.',
  customer_not_found: 'That customer was not found.',
  no_proxy_number_available: 'No free proxy number. Add more numbers to the pool or close finished conversations.',
  session_not_found: 'That conversation was not found.',
  session_is_final: 'That conversation has already ended.',
  session_not_active: 'That conversation has ended.',
  number_is_business_line: 'That number is already one of your business lines. Use a separate number.',
  not_configured: 'Calling is not configured on the server yet.',
  twilio_failed: 'Could not start the call. Please try again.',
};

export function maskingErrorMessage(error: { code?: string; message?: string } | null | undefined): string {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.code === '23505') return 'That number is already registered.';
  if (error.message && ERROR_MESSAGES[error.message]) return ERROR_MESSAGES[error.message];
  return 'Something went wrong. Please try again.';
}
