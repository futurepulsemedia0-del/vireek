/**
 * Activation funnel (time-to-first-value). Client side only reports the three events a browser can witness;
 * signup, first call, first booking and first paid invoice are written by database triggers.
 * No PII is ever sent: the RPC takes only an event name. Failures are swallowed (telemetry must never break UX).
 */
import { supabase } from '@/lib/supabase';

export const CLIENT_ACTIVATION_EVENTS = ['phone_connected', 'assistant_configured', 'first_test_call'] as const;
export type ClientActivationEvent = (typeof CLIENT_ACTIVATION_EVENTS)[number];

export const FUNNEL_ORDER = [
  'signup', 'phone_connected', 'assistant_configured', 'first_test_call',
  'first_call_logged', 'first_booking', 'first_invoice_paid',
] as const;
export type FunnelEvent = (typeof FUNNEL_ORDER)[number];

export const FUNNEL_LABELS: Record<FunnelEvent, string> = {
  signup: 'Signed up',
  phone_connected: 'Phone number connected',
  assistant_configured: 'Assistant configured',
  first_test_call: 'First test call',
  first_call_logged: 'First call logged',
  first_booking: 'First booking',
  first_invoice_paid: 'First invoice paid',
};

const sent = new Set<string>();

/** Fire-and-forget; de-duplicated per page session, and the database keeps only the first occurrence anyway. */
export function recordActivation(event: ClientActivationEvent): void {
  if (sent.has(event)) return;
  sent.add(event);
  void supabase.rpc('record_activation_event', { p_event: event }).then(({ error }) => {
    if (error) sent.delete(event);
  });
}

export interface FunnelRow { event: FunnelEvent; accounts: number; pctOfSignups: number; medianMinutes: number | null }

interface RawRow { event: string; accounts: number | string; pct_of_signups: number | string; median_minutes_from_signup: number | string | null }

/** Pure: validates, orders and normalizes the RPC rows (exported for tests). */
export function normalizeFunnel(rows: RawRow[] | null | undefined): FunnelRow[] {
  const byEvent = new Map((rows ?? []).map((r) => [r.event, r]));
  return FUNNEL_ORDER.map((event) => {
    const r = byEvent.get(event);
    const median = r?.median_minutes_from_signup;
    return {
      event,
      accounts: r ? Number(r.accounts) || 0 : 0,
      pctOfSignups: r ? Number(r.pct_of_signups) || 0 : 0,
      medianMinutes: median === null || median === undefined || !Number.isFinite(Number(median)) ? null : Number(median),
    };
  });
}

export async function fetchActivationFunnel(days: number): Promise<FunnelRow[]> {
  const { data, error } = await supabase.rpc('staff_activation_funnel', { p_days: days });
  if (error) throw new Error(error.message);
  return normalizeFunnel(data as RawRow[]);
}

/** "12 min", "3.4 h", "2.1 d"; null → "—". */
export function formatMinutes(m: number | null): string {
  if (m === null) return '—';
  if (m < 0) return '—';
  if (m < 120) return `${Math.round(m)} min`;
  if (m < 2880) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} d`;
}
