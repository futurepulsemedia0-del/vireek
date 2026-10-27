import { describe, it, expect } from 'vitest';
import {
  answeredOnTime,
  availableActions,
  buildCurlExample,
  buildIntakeEmailAlias,
  buildIntakeUrl,
  computeSla,
  describeIntakeError,
  EMPTY_ACTION_INPUT,
  EMPTY_PAYER_FORM,
  filterIntakes,
  formatDuration,
  normalizeDomains,
  normalizeEmailTag,
  sortIntakes,
  summarizeIntakes,
  toActArgs,
  toEditFields,
  toPayerPayload,
  validateActionInput,
  validateEditForm,
  validatePayerForm,
  type ThirdPartyWorkOrder,
} from './thirdPartyIntake';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

const row = (over: Partial<ThirdPartyWorkOrder> = {}): ThirdPartyWorkOrder => ({
  id: 'r1', user_id: 'u1', payer_id: 'p1', payer_name: 'Acme Warranty', received_via: 'api', external_ref: 'CLM-1',
  priority: 'standard', title: 'Fridge not cooling', description: null, service_type: null, customer_name: 'Ana Lopez',
  customer_phone: '555-010-2030', customer_email: null, service_address: '12 Oak St', policy_number: null,
  nte_cents: 45000, quoted_cents: null, status: 'new', needs_review: false, review_reasons: [],
  authorization_status: 'pending', authorization_ref: null, authorized_cents: null, authorized_at: null,
  decline_reason: null, scheduled_for: null, work_order_id: null,
  received_at: iso(-30), accept_due_at: iso(90), schedule_due_at: iso(24 * 60), complete_due_at: iso(72 * 60),
  responded_at: null, accepted_at: null, completed_at: null, paused_at: null, paused_from_status: null,
  created_at: iso(-30), updated_at: iso(-30), ...over,
});

describe('formatDuration', () => {
  it('formats minutes, hours and days', () => {
    expect(formatDuration(20_000)).toBe('<1m');
    expect(formatDuration(5 * 60_000)).toBe('5m');
    expect(formatDuration(135 * 60_000)).toBe('2h 15m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
    expect(formatDuration(50 * 3_600_000)).toBe('2d 2h');
    expect(formatDuration(-5 * 60_000)).toBe('5m');
  });
});

describe('computeSla', () => {
  it('is ok when plenty of time is left', () => {
    const s = computeSla(row(), NOW);
    expect(s.stage).toBe('accept');
    expect(s.state).toBe('ok');
    expect(s.label).toBe('1h 30m left');
  });
  it('is at risk at 25% or less of the window', () => {
    // received 30 min ago, due in 10 min -> window 40 min, 25% = 10 min left
    expect(computeSla(row({ accept_due_at: iso(10) }), NOW).state).toBe('at_risk');
    expect(computeSla(row({ accept_due_at: iso(11) }), NOW).state).toBe('ok');
  });
  it('is breached after the deadline', () => {
    const s = computeSla(row({ accept_due_at: iso(-45) }), NOW);
    expect(s.state).toBe('breached');
    expect(s.label).toBe('Overdue by 45m');
  });
  it('moves to the schedule then complete stage with the status', () => {
    expect(computeSla(row({ status: 'accepted', accepted_at: iso(-10) }), NOW).stage).toBe('schedule');
    expect(computeSla(row({ status: 'scheduled', accepted_at: iso(-10) }), NOW).stage).toBe('complete');
  });
  it('pauses while waiting on the payer and keeps the stage it paused in', () => {
    const s = computeSla(row({ status: 'awaiting_payer', paused_at: iso(-5), paused_from_status: 'accepted' }), NOW);
    expect(s.state).toBe('paused');
    expect(s.stage).toBe('schedule');
  });
  it('is closed for terminal statuses', () => {
    for (const status of ['declined', 'cancelled', 'completed'] as const) expect(computeSla(row({ status }), NOW).state).toBe('closed');
  });
  it('handles a missing deadline', () => {
    expect(computeSla(row({ accept_due_at: null }), NOW).label).toBe('No deadline');
  });
});

describe('answeredOnTime', () => {
  it('compares the first response with the accept deadline', () => {
    expect(answeredOnTime(row())).toBeNull();
    expect(answeredOnTime(row({ responded_at: iso(60) }))).toBe(true);
    expect(answeredOnTime(row({ responded_at: iso(120) }))).toBe(false);
  });
});

describe('availableActions', () => {
  it('offers the decision first on a new request', () => {
    expect(availableActions(row())[0]).toBe('accept');
    expect(availableActions(row())).toContain('decline');
    expect(availableActions(row())).not.toContain('cancel');
  });
  it('blocks scheduling until the payer authorizes', () => {
    const accepted = availableActions(row({ status: 'accepted' }));
    expect(accepted[0]).toBe('authorize');
    expect(accepted).not.toContain('schedule');
    expect(accepted).not.toContain('complete');
    const ready = availableActions(row({ status: 'accepted', authorization_status: 'authorized' }));
    expect(ready[0]).toBe('schedule');
    expect(ready).not.toContain('authorize');
  });
  it('allows scheduling when no authorization is required', () => {
    expect(availableActions(row({ status: 'accepted', authorization_status: 'not_required' }))).toContain('schedule');
  });
  it('lets a denied authorization be re-recorded but not denied twice', () => {
    const a = availableActions(row({ status: 'accepted', authorization_status: 'denied' }));
    expect(a).toContain('authorize');
    expect(a).not.toContain('deny_authorization');
  });
  it('resumes from waiting-on-payer and offers nothing once closed', () => {
    expect(availableActions(row({ status: 'awaiting_payer' }))[0]).toBe('resume');
    expect(availableActions(row({ status: 'completed' }))).toHaveLength(0);
  });
});

describe('action input', () => {
  it('requires a reason to decline', () => {
    expect(validateActionInput('decline', EMPTY_ACTION_INPUT).note).toBeTruthy();
    expect(validateActionInput('decline', { ...EMPTY_ACTION_INPUT, note: 'Out of service area' }).note).toBeUndefined();
  });
  it('validates amounts and schedule', () => {
    expect(validateActionInput('quote', EMPTY_ACTION_INPUT).amount).toBeTruthy();
    expect(validateActionInput('quote', { ...EMPTY_ACTION_INPUT, amount: 'abc' }).amount).toBeTruthy();
    expect(validateActionInput('authorize', EMPTY_ACTION_INPUT).amount).toBeUndefined();
    expect(validateActionInput('schedule', EMPTY_ACTION_INPUT).when).toBeTruthy();
  });
  it('maps to RPC args', () => {
    expect(toActArgs('authorize', { note: ' ok ', amount: '$450.50', reference: ' AUTH-9 ', when: '' })).toEqual({
      p_note: 'ok', p_amount_cents: 45050, p_reference: 'AUTH-9', p_when: null,
    });
    expect(toActArgs('accept', { note: '', amount: '999', reference: 'x', when: '' })).toEqual({
      p_note: null, p_amount_cents: null, p_reference: null, p_when: null,
    });
  });
});

describe('edit form', () => {
  const base = { title: 'T', external_ref: '', service_type: '', customer_name: '', customer_phone: '', customer_email: '', service_address: '', policy_number: '', nte: '' };
  it('validates fields', () => {
    expect(validateEditForm({ ...base, title: ' ' }).title).toBeTruthy();
    expect(validateEditForm({ ...base, customer_email: 'nope' }).customer_email).toBeTruthy();
    expect(validateEditForm({ ...base, customer_phone: '12' }).customer_phone).toBeTruthy();
    expect(validateEditForm({ ...base, nte: 'x' }).nte).toBeTruthy();
    expect(Object.keys(validateEditForm(base))).toHaveLength(0);
  });
  it('sends NTE as whole cents, blank clears it', () => {
    expect(toEditFields({ ...base, nte: '450.5' }).nte_cents).toBe('45050');
    expect(toEditFields(base).nte_cents).toBe('');
  });
});

describe('filter / sort / summary', () => {
  const rows = [
    row({ id: 'ok', accept_due_at: iso(100) }),
    row({ id: 'late', accept_due_at: iso(-5), title: 'Water heater' }),
    row({ id: 'risk', accept_due_at: iso(10) }),
    row({ id: 'done', status: 'completed', responded_at: iso(-20) }),
    row({ id: 'wait', status: 'awaiting_payer', paused_from_status: 'new', paused_at: iso(-1) }),
    row({ id: 'authwait', status: 'accepted', accepted_at: iso(-5) }),
  ];
  it('sorts the most urgent clock first and closed last', () => {
    expect(sortIntakes(rows, NOW).map((r) => r.id)).toEqual(['late', 'risk', 'ok', 'authwait', 'wait', 'done']);
  });
  it('filters', () => {
    expect(filterIntakes(rows, 'closed', '', NOW).map((r) => r.id)).toEqual(['done']);
    expect(filterIntakes(rows, 'waiting', '', NOW).map((r) => r.id).sort()).toEqual(['authwait', 'wait']);
    expect(filterIntakes(rows, 'attention', '', NOW).map((r) => r.id).sort()).toEqual(['late', 'ok', 'risk']);
    expect(filterIntakes(rows, 'all', 'water', NOW).map((r) => r.id)).toEqual(['late']);
  });
  it('summarizes', () => {
    const s = summarizeIntakes(rows, NOW);
    expect(s.needsResponse).toBe(3);
    expect(s.breached).toBe(1);
    expect(s.atRisk).toBe(1);
    expect(s.awaitingAuthorization).toBe(5);
    expect(s.onTimePct).toBe(100);
    expect(s.openValueCents).toBe(5 * 45000);
  });
});

describe('partners', () => {
  it('normalizes tags and domains', () => {
    expect(normalizeEmailTag('Chubb-Claims!')).toBe('chubbclaims');
    expect(normalizeDomains('https://Ops.Acme.com/path, ops@acme.com; bad_domain')).toEqual({ domains: ['ops.acme.com', 'acme.com'], invalid: ['bad_domain'] });
  });
  it('validates the form', () => {
    expect(validatePayerForm(EMPTY_PAYER_FORM).name).toBeTruthy();
    const ok = { ...EMPTY_PAYER_FORM, name: 'Acme' };
    expect(Object.keys(validatePayerForm(ok))).toHaveLength(0);
    expect(validatePayerForm({ ...ok, acceptMinutes: '2' }).acceptMinutes).toBeTruthy();
    expect(validatePayerForm({ ...ok, scheduleHours: '100', completeHours: '50' }).scheduleHours).toBeTruthy();
    expect(validatePayerForm({ ...ok, senderDomains: 'nope' }).senderDomains).toBeTruthy();
  });
  it('builds the payload', () => {
    const p = toPayerPayload({ ...EMPTY_PAYER_FORM, name: ' Acme ', emailTag: 'Acme!', senderDomains: 'acme.com', defaultNte: '300' });
    expect(p).toEqual({
      name: 'Acme', kind: 'home_warranty', enabled: true, email_tag: 'acme', sender_domains: ['acme.com'],
      accept_within_minutes: 120, schedule_within_hours: 24, complete_within_hours: 72, default_nte_cents: 30000, require_authorization: true,
    });
  });
  it('builds connection details', () => {
    expect(buildIntakeUrl('https://x.supabase.co/')).toBe('https://x.supabase.co/functions/v1/third-party-intake');
    expect(buildIntakeEmailAlias('tok', 'in.vireek.com', 'acme')).toBe('tok+acme@in.vireek.com');
    expect(buildIntakeEmailAlias('tok', 'in.vireek.com', null)).toBe('tok@in.vireek.com');
    expect(buildIntakeEmailAlias(null, 'in.vireek.com', 'acme')).toBeNull();
    expect(buildCurlExample('https://u', 'TOKEN')).toContain("X-Vireek-Token: TOKEN");
  });
});

describe('describeIntakeError', () => {
  it('shows database guard messages and hides the rest', () => {
    expect(describeIntakeError({ code: '23514', message: 'Payer authorization is required' })).toBe('Payer authorization is required');
    expect(describeIntakeError({ code: '42501' })).toMatch(/permission/);
    expect(describeIntakeError({ code: 'XX000', message: 'internal stack trace' })).not.toContain('stack');
  });
});
