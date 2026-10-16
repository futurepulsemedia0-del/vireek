import type { DemoSlot } from '@/lib/enterpriseDemoBooking';

// ============================================================
// Options
// ============================================================

export const TEAM_SIZES = ['1-5', '6-15', '16-50', '51-200', '200+'] as const;
export const LOCATION_COUNTS = ['1', '2-5', '6-20', '21+'] as const;
export const BEST_TIMES = ['Morning 8-12', 'Afternoon 12-5', 'Evening 5-8'] as const;

export type TeamSize = (typeof TEAM_SIZES)[number];
export type LocationCount = (typeof LOCATION_COUNTS)[number];
export type BestTime = (typeof BEST_TIMES)[number];
export type Segment = 'enterprise' | 'mid_market' | 'smb';
export type Priority = 'high' | 'normal' | 'low';

export const TEAM_SIZE_LABELS: Record<TeamSize, string> = {
  '1-5': '1–5 people',
  '6-15': '6–15 people',
  '16-50': '16–50 people',
  '51-200': '51–200 people',
  '200+': '200+ people',
};
export const LOCATION_LABELS: Record<LocationCount, string> = {
  '1': '1 location',
  '2-5': '2–5 locations',
  '6-20': '6–20 locations',
  '21+': '21+ locations',
};

export const LIMITS = { name: 120, email: 254, title: 100, company: 120, phone: 40, message: 1500, utm: 100 } as const;

// ============================================================
// Form
// ============================================================

export interface SalesFormValues {
  fullName: string;
  workEmail: string;
  jobTitle: string;
  companyName: string;
  phone: string;
  teamSize: TeamSize | '';
  locations: LocationCount | '';
  bestTimeToCall: BestTime | '';
  message: string;
  smsConsent: boolean;
  /** Honeypot: hidden from people, bots fill it. */
  website: string;
}

export const EMPTY_SALES_FORM: SalesFormValues = {
  fullName: '',
  workEmail: '',
  jobTitle: '',
  companyName: '',
  phone: '',
  teamSize: '',
  locations: '',
  bestTimeToCall: '',
  message: '',
  smsConsent: false,
  website: '',
};

export type SalesFormErrors = Partial<
  Record<'fullName' | 'workEmail' | 'companyName' | 'phone' | 'teamSize' | 'locations' | 'message' | 'smsConsent', string>
>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidPhone(value: string): boolean {
  const v = value.trim();
  if (!/^[\d\s()+.-]+$/.test(v)) return false;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Insertion order matches the field order on the page, so the first key is the first field to focus. */
export function validateSalesForm(v: SalesFormValues): SalesFormErrors {
  const e: SalesFormErrors = {};
  const name = v.fullName.trim();
  if (name.length < 2 || name.length > LIMITS.name) e.fullName = 'Please enter your full name.';
  const email = v.workEmail.trim();
  if (email.length > LIMITS.email || !EMAIL_RE.test(email)) e.workEmail = 'Please enter a valid email address.';
  const company = v.companyName.trim();
  if (company.length < 2 || company.length > LIMITS.company) e.companyName = 'Please enter your company name.';
  if (v.phone.trim() && !isValidPhone(v.phone)) e.phone = 'Enter a valid phone number, or leave it empty.';
  if (!v.teamSize) e.teamSize = 'Choose your team size.';
  if (!v.locations) e.locations = 'Choose how many locations you run.';
  if (v.message.length > LIMITS.message) e.message = `Please keep your message under ${LIMITS.message} characters.`;
  if (v.smsConsent && !v.phone.trim()) e.smsConsent = 'Add a phone number to receive texts.';
  return e;
}

// ============================================================
// Routing (mirrors submit_sales_inquiry in the database)
// ============================================================

export function classifyLead(
  teamSize: TeamSize | '' | string,
  locations: LocationCount | '' | string,
): { segment: Segment; priority: Priority } {
  let segment: Segment = 'smb';
  if (teamSize === '51-200' || teamSize === '200+' || locations === '6-20' || locations === '21+') {
    segment = 'enterprise';
  } else if (teamSize === '16-50' || locations === '2-5') {
    segment = 'mid_market';
  }
  const priority: Priority = segment === 'enterprise' ? 'high' : segment === 'mid_market' ? 'normal' : 'low';
  return { segment, priority };
}

// ============================================================
// Payload + attribution
// ============================================================

export interface UtmParams {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
}

export function readUtm(search: string): UtmParams {
  const params = new URLSearchParams(search);
  const clean = (key: string) =>
    // eslint-disable-next-line no-control-regex
    (params.get(key) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.utm);
  return { utmSource: clean('utm_source'), utmMedium: clean('utm_medium'), utmCampaign: clean('utm_campaign') };
}

export interface SalesPayload extends UtmParams {
  fullName: string;
  workEmail: string;
  jobTitle: string;
  companyName: string;
  phone: string;
  teamSize: string;
  locations: string;
  bestTimeToCall: string;
  message: string;
  smsConsent: boolean;
  website: string;
  slotStart: string | null;
  source: string;
}

export function buildPayload(
  v: SalesFormValues,
  ctx: { slotStart: Date | null; source: string } & UtmParams,
): SalesPayload {
  return {
    fullName: v.fullName.trim(),
    workEmail: v.workEmail.trim().toLowerCase(),
    jobTitle: v.jobTitle.trim(),
    companyName: v.companyName.trim(),
    phone: v.phone.trim(),
    teamSize: v.teamSize,
    locations: v.locations,
    bestTimeToCall: v.bestTimeToCall,
    message: v.message.trim(),
    smsConsent: v.smsConsent,
    website: v.website,
    slotStart: ctx.slotStart ? ctx.slotStart.toISOString() : null,
    source: ctx.source,
    utmSource: ctx.utmSource,
    utmMedium: ctx.utmMedium,
    utmCampaign: ctx.utmCampaign,
  };
}

// ============================================================
// Response handling
// ============================================================

export type SubmitResult =
  | { kind: 'ok'; inquiryId: string | null; duplicate: boolean; booking: { start: Date; end: Date } | null }
  | { kind: 'slot_taken' }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export const GENERIC_ERROR = "We couldn't send your request. Please try again or email us directly.";

export function interpretResponse(status: number, body: unknown): SubmitResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const message = typeof b.message === 'string' && b.message ? b.message : GENERIC_ERROR;

  if (status >= 200 && status < 300 && b.ok === true) {
    const booking = b.booking as { slotStart?: string; slotEnd?: string } | null | undefined;
    return {
      kind: 'ok',
      inquiryId: typeof b.inquiryId === 'string' ? b.inquiryId : null,
      duplicate: b.duplicate === true,
      booking:
        booking?.slotStart && booking?.slotEnd
          ? { start: new Date(booking.slotStart), end: new Date(booking.slotEnd) }
          : null,
    };
  }
  if (status === 409 || b.error === 'slot_taken') return { kind: 'slot_taken' };
  if (status === 429 || b.error === 'rate_limited') return { kind: 'rate_limited', message };
  if (status === 400 || b.error === 'invalid') return { kind: 'invalid', message };
  return { kind: 'error', message: GENERIC_ERROR };
}

// ============================================================
// Slot display
// ============================================================

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function groupSlotsByDay(slots: DemoSlot[]): { key: string; date: Date; slots: DemoSlot[] }[] {
  const sorted = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
  const groups: { key: string; date: Date; slots: DemoSlot[] }[] = [];
  for (const slot of sorted) {
    const key = dayKey(slot.start);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.slots.push(slot);
    else groups.push({ key, date: slot.start, slots: [slot] });
  }
  return groups;
}

export const formatDayChip = (d: Date): string =>
  d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

export const formatTime = (d: Date): string =>
  d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' ');

export const formatFullSlot = (d: Date): string =>
  `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${formatTime(d)}`;
