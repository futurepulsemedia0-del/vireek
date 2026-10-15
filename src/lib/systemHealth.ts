/**
 * System health — pure evaluator for the Overview health strip.
 *
 * No React, no Supabase. It turns the REAL snapshot returned by the
 * `get_system_health_snapshot()` RPC into one check per subsystem.
 * RULE: never report green without evidence. Missing/unknown data is "off"
 * (not set up) or surfaces as an error in the hook — it is never faked green.
 */
import { getIntegrationHealth } from '@/lib/integrationRecovery';
import type { Integration } from '@/lib/supabase';

export type HealthState = 'green' | 'amber' | 'red' | 'off';
export type HealthCheckId = 'voice' | 'phone' | 'sms' | 'stripe' | 'calendar' | 'quickbooks' | 'webhooks';

export interface HealthFix {
  label: string;
  href: string;
}

export interface HealthCheck {
  id: HealthCheckId;
  label: string;
  state: HealthState;
  summary: string;
  fix?: HealthFix;
}

export interface IntegrationSnapshot {
  status: string;
  error_code: string | null;
  error_message: string | null;
}

export interface SystemHealthSnapshot {
  generated_at: string;
  voice: { assistant_linked: boolean; calls_7d: number; last_call_at: string | null };
  phone: { total: number; active: number; active_voice: number; pending: number; porting: number };
  sms: { active_sms_numbers: number; brand_status: string; campaign_status: string; rejection_reason: string | null };
  stripe: {
    has_customer: boolean;
    subscription_status: 'active' | 'past_due' | 'suspended' | string;
    grace_ends_at: string | null;
    last_payment_error: string | null;
    connect: { exists: boolean; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean };
  };
  integrations: Record<string, IntegrationSnapshot | undefined>;
  webhooks: {
    endpoints_active: number;
    endpoints_failing: number;
    deliveries_24h: number;
    errors_24h: number;
    last_error_at: string | null;
    last_error_message: string | null;
  };
}

export interface HealthSummary {
  overall: Exclude<HealthState, 'off'>;
  red: number;
  amber: number;
  headline: string;
}

export const FIX_ROUTES = {
  assistant: '/dashboard/settings/assistant',
  numbers: '/dashboard/phone-numbers',
  a2p: '/dashboard/business-profile',
  billing: '/dashboard/billing',
  updatePayment: '/dashboard/billing/update-payment',
  integrations: '/dashboard/integrations',
} as const;

const SEVERITY: Record<HealthState, number> = { off: 0, green: 1, amber: 2, red: 3 };

export function worst(states: HealthState[]): HealthState {
  return states.reduce<HealthState>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'off');
}

export function timeAgo(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'never';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

type Partial3 = Pick<HealthCheck, 'state' | 'summary' | 'fix'>;

function pickWorst(candidates: Partial3[]): Partial3 {
  return candidates.reduce((a, b) => (SEVERITY[b.state] > SEVERITY[a.state] ? b : a));
}

function voiceCheck(s: SystemHealthSnapshot, now: Date): Partial3 {
  const fix = { label: 'Link assistant', href: FIX_ROUTES.assistant };
  if (!s.voice.assistant_linked) {
    return { state: 'red', summary: 'No voice assistant is linked — calls cannot be answered', fix };
  }
  if (s.phone.active_voice > 0 && s.voice.calls_7d === 0) {
    return {
      state: 'amber',
      summary: `No calls in 7 days (last: ${timeAgo(s.voice.last_call_at, now)}) — place a test call`,
      fix: { label: 'Review assistant', href: FIX_ROUTES.assistant },
    };
  }
  return {
    state: 'green',
    summary: s.voice.last_call_at ? `Linked · last call ${timeAgo(s.voice.last_call_at, now)}` : 'Assistant linked',
  };
}

function phoneCheck(s: SystemHealthSnapshot): Partial3 {
  const fix = { label: 'Manage numbers', href: FIX_ROUTES.numbers };
  const p = s.phone;
  if (p.total === 0) return { state: 'red', summary: 'No phone number — add or port one', fix };
  if (p.active === 0) {
    const why = p.porting > 0 ? 'port in progress' : 'activation pending';
    return { state: 'amber', summary: `No active number yet (${why})`, fix };
  }
  if (p.active_voice === 0) return { state: 'red', summary: 'Active numbers have voice disabled', fix };
  return { state: 'green', summary: `${p.active_voice} active voice number${p.active_voice === 1 ? '' : 's'}` };
}

function smsCheck(s: SystemHealthSnapshot): Partial3 {
  const { brand_status: brand, campaign_status: campaign, rejection_reason: reason, active_sms_numbers: n } = s.sms;
  const fix = { label: 'Fix A2P registration', href: FIX_ROUTES.a2p };
  if (brand === 'rejected' || campaign === 'rejected') {
    return { state: 'red', summary: `A2P registration rejected${reason ? `: ${reason}` : ''}`, fix };
  }
  if (brand === 'approved' && campaign === 'approved') {
    return n > 0
      ? { state: 'green', summary: `A2P approved · ${n} SMS number${n === 1 ? '' : 's'}` }
      : { state: 'amber', summary: 'A2P approved but no number has SMS enabled', fix: { label: 'Enable SMS', href: FIX_ROUTES.numbers } };
  }
  if (brand === 'pending' || campaign === 'pending') {
    return { state: 'amber', summary: 'A2P registration pending carrier review', fix };
  }
  if (n > 0) return { state: 'red', summary: 'SMS numbers are blocked by carriers until A2P is registered', fix };
  return { state: 'off', summary: 'SMS not set up', fix: { label: 'Set up SMS', href: FIX_ROUTES.a2p } };
}

function stripeCheck(s: SystemHealthSnapshot, now: Date): Partial3 {
  const st = s.stripe;
  const pay = { label: 'Update payment', href: FIX_ROUTES.updatePayment };
  const out: Partial3[] = [];
  if (st.subscription_status === 'suspended') {
    out.push({ state: 'red', summary: 'Subscription suspended for non-payment', fix: pay });
  } else if (st.subscription_status === 'past_due') {
    const expired = st.grace_ends_at ? new Date(st.grace_ends_at).getTime() <= now.getTime() : false;
    out.push({
      state: expired ? 'red' : 'amber',
      summary: `Payment past due${st.last_payment_error ? `: ${st.last_payment_error}` : ''}`,
      fix: pay,
    });
  } else if (!st.has_customer) {
    out.push({ state: 'amber', summary: 'No payment method on file', fix: { label: 'Add payment method', href: FIX_ROUTES.billing } });
  }
  if (st.connect.exists && (!st.connect.details_submitted || !st.connect.charges_enabled || !st.connect.payouts_enabled)) {
    out.push({
      state: 'amber',
      summary: 'Stripe payments onboarding incomplete',
      fix: { label: 'Finish Stripe setup', href: FIX_ROUTES.billing },
    });
  }
  if (out.length > 0) return pickWorst(out);
  return { state: 'green', summary: st.connect.exists ? 'Billing active · payments enabled' : 'Billing active' };
}

function integrationCheck(row: IntegrationSnapshot | undefined, name: string): Partial3 {
  const fix = { label: `Open ${name}`, href: FIX_ROUTES.integrations };
  if (!row) return { state: 'off', summary: 'Not connected', fix: { label: `Connect ${name}`, href: FIX_ROUTES.integrations } };
  if (row.status === 'connected') return { state: 'green', summary: 'Connected' };
  const asRow: Integration = {
    id: 'snapshot',
    user_id: '',
    integration_type: name,
    status: row.status === 'error' ? 'error' : 'disconnected',
    config: { error_code: row.error_code ?? undefined, error_message: row.error_message ?? undefined },
    created_at: '',
  };
  const h = getIntegrationHealth(asRow);
  if (h.needsRecovery) return { state: 'red', summary: h.title, fix: { label: h.primaryActionLabel, href: FIX_ROUTES.integrations } };
  return { state: 'off', summary: 'Not connected', fix: { label: `Connect ${name}`, href: FIX_ROUTES.integrations } };
}

function webhooksCheck(s: SystemHealthSnapshot, now: Date): Partial3 {
  const w = s.webhooks;
  const fix = { label: 'Fix webhooks', href: FIX_ROUTES.integrations };
  const legacy = s.integrations.webhook;
  const out: Partial3[] = [];
  if (legacy?.status === 'error') out.push({ state: 'red', summary: 'Webhook integration is failing', fix });
  if (w.endpoints_failing > 0) {
    out.push({
      state: w.endpoints_failing >= w.endpoints_active ? 'red' : 'amber',
      summary: `${w.endpoints_failing} of ${w.endpoints_active} endpoint${w.endpoints_active === 1 ? '' : 's'} failing`,
      fix,
    });
  }
  if (w.errors_24h > 0) {
    const severe = w.errors_24h >= 3 && w.errors_24h / Math.max(1, w.deliveries_24h) >= 0.5;
    out.push({
      state: severe ? 'red' : 'amber',
      summary: `${w.errors_24h} of ${w.deliveries_24h} deliveries failed in 24h (last ${timeAgo(w.last_error_at, now)})`,
      fix,
    });
  }
  if (out.length > 0) return pickWorst(out);
  if (w.endpoints_active === 0 && w.deliveries_24h === 0 && !legacy) {
    return { state: 'off', summary: 'No webhooks configured', fix: { label: 'Add webhook', href: FIX_ROUTES.integrations } };
  }
  return { state: 'green', summary: `${w.deliveries_24h} deliveries in 24h, none failed` };
}

export function evaluateSystemHealth(s: SystemHealthSnapshot, now: Date = new Date()): HealthCheck[] {
  return [
    { id: 'voice', label: 'Voice AI', ...voiceCheck(s, now) },
    { id: 'phone', label: 'Phone numbers', ...phoneCheck(s) },
    { id: 'sms', label: 'SMS / A2P', ...smsCheck(s) },
    { id: 'stripe', label: 'Stripe', ...stripeCheck(s, now) },
    { id: 'calendar', label: 'Google Calendar', ...integrationCheck(s.integrations.google_calendar, 'Google Calendar') },
    { id: 'quickbooks', label: 'QuickBooks', ...integrationCheck(s.integrations.quickbooks, 'QuickBooks') },
    { id: 'webhooks', label: 'Webhooks', ...webhooksCheck(s, now) },
  ];
}

export function summarizeHealth(checks: HealthCheck[]): HealthSummary {
  const red = checks.filter((c) => c.state === 'red').length;
  const amber = checks.filter((c) => c.state === 'amber').length;
  const overall = red > 0 ? 'red' : amber > 0 ? 'amber' : 'green';
  const n = red + amber;
  const headline =
    n === 0 ? 'All systems operational' : `${n} issue${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention`;
  return { overall, red, amber, headline };
}
