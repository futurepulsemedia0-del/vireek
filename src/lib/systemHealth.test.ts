import { describe, expect, it } from 'vitest';
import {
  FIX_ROUTES,
  evaluateSystemHealth,
  summarizeHealth,
  timeAgo,
  type HealthCheckId,
  type SystemHealthSnapshot,
} from '@/lib/systemHealth';

const NOW = new Date('2026-10-14T12:00:00Z');

function snap(over: Partial<SystemHealthSnapshot> = {}): SystemHealthSnapshot {
  return {
    generated_at: NOW.toISOString(),
    voice: { assistant_linked: true, calls_7d: 12, last_call_at: '2026-10-14T09:00:00Z' },
    phone: { total: 1, active: 1, active_voice: 1, pending: 0, porting: 0 },
    sms: { active_sms_numbers: 1, brand_status: 'approved', campaign_status: 'approved', rejection_reason: null },
    stripe: {
      has_customer: true,
      subscription_status: 'active',
      grace_ends_at: null,
      last_payment_error: null,
      connect: { exists: true, charges_enabled: true, payouts_enabled: true, details_submitted: true },
    },
    integrations: {
      google_calendar: { status: 'connected', error_code: null, error_message: null },
      quickbooks: { status: 'connected', error_code: null, error_message: null },
    },
    webhooks: { endpoints_active: 1, endpoints_failing: 0, deliveries_24h: 10, errors_24h: 0, last_error_at: null, last_error_message: null },
    ...over,
  };
}

const get = (s: SystemHealthSnapshot, id: HealthCheckId) => evaluateSystemHealth(s, NOW).find((c) => c.id === id)!;

describe('evaluateSystemHealth', () => {
  it('returns all seven subsystems in order, all green when healthy', () => {
    const checks = evaluateSystemHealth(snap(), NOW);
    expect(checks.map((c) => c.id)).toEqual(['voice', 'phone', 'sms', 'stripe', 'calendar', 'quickbooks', 'webhooks']);
    expect(checks.every((c) => c.state === 'green')).toBe(true);
    expect(summarizeHealth(checks).headline).toBe('All systems operational');
  });

  it('voice: red without assistant, amber when active number gets no calls, never green without evidence', () => {
    expect(get(snap({ voice: { assistant_linked: false, calls_7d: 0, last_call_at: null } }), 'voice')).toMatchObject({
      state: 'red',
      fix: { href: FIX_ROUTES.assistant },
    });
    expect(get(snap({ voice: { assistant_linked: true, calls_7d: 0, last_call_at: null } }), 'voice').state).toBe('amber');
  });

  it('phone: red with none, amber while pending/porting, red when voice disabled', () => {
    expect(get(snap({ phone: { total: 0, active: 0, active_voice: 0, pending: 0, porting: 0 } }), 'phone').state).toBe('red');
    const porting = get(snap({ phone: { total: 1, active: 0, active_voice: 0, pending: 0, porting: 1 } }), 'phone');
    expect(porting.state).toBe('amber');
    expect(porting.summary).toMatch(/port/);
    expect(get(snap({ phone: { total: 1, active: 1, active_voice: 0, pending: 0, porting: 0 } }), 'phone').state).toBe('red');
  });

  it('sms: rejected is red with reason, pending amber, unregistered-with-numbers red, nothing set up is off', () => {
    const s = (sms: Partial<SystemHealthSnapshot['sms']>) => snap({ sms: { ...snap().sms, ...sms } });
    const rejected = get(s({ brand_status: 'rejected', rejection_reason: 'EIN mismatch' }), 'sms');
    expect(rejected.state).toBe('red');
    expect(rejected.summary).toContain('EIN mismatch');
    expect(get(s({ campaign_status: 'pending' }), 'sms').state).toBe('amber');
    expect(get(s({ brand_status: 'not_started', campaign_status: 'not_started' }), 'sms').state).toBe('red');
    expect(get(s({ brand_status: 'not_started', campaign_status: 'not_started', active_sms_numbers: 0 }), 'sms').state).toBe('off');
    expect(get(s({ active_sms_numbers: 0 }), 'sms').state).toBe('amber');
  });

  it('stripe: suspended red, past_due amber then red after grace, missing customer amber, incomplete Connect amber', () => {
    const st = (p: Partial<SystemHealthSnapshot['stripe']>) => snap({ stripe: { ...snap().stripe, ...p } });
    expect(get(st({ subscription_status: 'suspended' }), 'stripe')).toMatchObject({ state: 'red', fix: { href: FIX_ROUTES.updatePayment } });
    expect(get(st({ subscription_status: 'past_due', grace_ends_at: '2026-10-20T00:00:00Z' }), 'stripe').state).toBe('amber');
    expect(get(st({ subscription_status: 'past_due', grace_ends_at: '2026-10-10T00:00:00Z' }), 'stripe').state).toBe('red');
    expect(get(st({ has_customer: false }), 'stripe').state).toBe('amber');
    const connect = { exists: true, charges_enabled: false, payouts_enabled: false, details_submitted: true };
    expect(get(st({ connect }), 'stripe').state).toBe('amber');
  });

  it('calendar / quickbooks: missing row is off, error is red with recovery link, manual disconnect is off', () => {
    const noRows = snap({ integrations: {} });
    expect(get(noRows, 'calendar').state).toBe('off');
    expect(get(noRows, 'quickbooks').state).toBe('off');
    const broken = snap({
      integrations: { google_calendar: { status: 'error', error_code: 'token_expired', error_message: null } },
    });
    expect(get(broken, 'calendar')).toMatchObject({ state: 'red', summary: 'Access expired', fix: { href: FIX_ROUTES.integrations } });
    const manual = snap({ integrations: { quickbooks: { status: 'disconnected', error_code: 'manual_disconnect', error_message: null } } });
    expect(get(manual, 'quickbooks').state).toBe('off');
  });

  it('webhooks: off when unused, amber on a few errors, red on majority failures or all endpoints failing', () => {
    const w = (p: Partial<SystemHealthSnapshot['webhooks']>) => snap({ webhooks: { ...snap().webhooks, ...p } });
    expect(get(w({ endpoints_active: 0, deliveries_24h: 0 }), 'webhooks').state).toBe('off');
    expect(get(w({ errors_24h: 1, deliveries_24h: 20, last_error_at: '2026-10-14T11:00:00Z' }), 'webhooks').state).toBe('amber');
    expect(get(w({ errors_24h: 6, deliveries_24h: 8 }), 'webhooks').state).toBe('red');
    expect(get(w({ endpoints_active: 2, endpoints_failing: 1 }), 'webhooks').state).toBe('amber');
    expect(get(w({ endpoints_active: 2, endpoints_failing: 2 }), 'webhooks').state).toBe('red');
  });

  it('every non-green, non-"off-without-action" check carries a real in-app fix link', () => {
    const bad = snap({
      voice: { assistant_linked: false, calls_7d: 0, last_call_at: null },
      phone: { total: 0, active: 0, active_voice: 0, pending: 0, porting: 0 },
      integrations: {},
    });
    for (const c of evaluateSystemHealth(bad, NOW)) {
      if (c.state !== 'green') expect(c.fix?.href).toMatch(/^\/dashboard\//);
    }
  });
});

describe('summarizeHealth / timeAgo', () => {
  it('ignores off checks, counts red/amber and pluralises', () => {
    const checks = evaluateSystemHealth(snap({ integrations: {} }), NOW);
    expect(summarizeHealth(checks)).toMatchObject({ overall: 'green', red: 0, amber: 0 });
    const one = evaluateSystemHealth(snap({ voice: { assistant_linked: false, calls_7d: 0, last_call_at: null } }), NOW);
    expect(summarizeHealth(one)).toMatchObject({ overall: 'red', red: 1, headline: '1 issue needs attention' });
    const two = evaluateSystemHealth(
      snap({ voice: { assistant_linked: false, calls_7d: 0, last_call_at: null }, phone: { total: 0, active: 0, active_voice: 0, pending: 0, porting: 0 } }),
      NOW,
    );
    expect(summarizeHealth(two).headline).toBe('2 issues need attention');
  });

  it('formats relative time', () => {
    expect(timeAgo(null, NOW)).toBe('never');
    expect(timeAgo('2026-10-14T11:59:40Z', NOW)).toBe('just now');
    expect(timeAgo('2026-10-14T11:15:00Z', NOW)).toBe('45m ago');
    expect(timeAgo('2026-10-14T06:00:00Z', NOW)).toBe('6h ago');
    expect(timeAgo('2026-10-10T12:00:00Z', NOW)).toBe('4d ago');
  });
});
