import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls: { table: string; ops: Array<[string, unknown[]]> }[] = [];
let nextResult: { data: unknown; error: unknown; count?: number } = { data: [], error: null };
const invoke = vi.fn();

function makeBuilder(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const builder: Record<string, unknown> = {};
  for (const op of ['select', 'insert', 'upsert', 'eq', 'ilike', 'order', 'range', 'limit', 'single']) {
    builder[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => resolve(nextResult);
  return builder;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (t: string) => makeBuilder(t), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

import {
  normalizePhone,
  isValidPhone,
  maskEin,
  maskPhone,
  computeReadiness,
  canSendSms,
  canSubmit,
  overallState,
  currentConsent,
  toCsv,
  fetchOptOuts,
  addManualOptOut,
  fetchOptInProof,
  recordOptIn,
  submitRegistration,
  type A2pRegistration,
  type OptInRow,
} from '@/lib/smsCompliance';

const base: A2pRegistration = {
  legal_business_name: 'Acme Plumbing LLC',
  ein: '12-3456789',
  business_registration_type: 'llc',
  business_website: 'https://acme.test',
  sms_sample_message: 'Hi, your technician is on the way.',
  sms_opt_in_description: 'Customers tick an SMS box on our booking form.',
  a2p_brand_status: 'not_started',
  a2p_campaign_status: 'not_started',
  a2p_brand_sid: null,
  a2p_campaign_sid: null,
  a2p_requested_at: null,
  a2p_rejection_reason: null,
};

beforeEach(() => {
  calls.length = 0;
  invoke.mockReset();
  nextResult = { data: [], error: null };
});

describe('phone helpers', () => {
  it('normalizes exactly like the edge-function gate', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('1 555 123 4567')).toBe('+15551234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('validates E.164 length', () => {
    expect(isValidPhone('555-123-4567')).toBe(true);
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('')).toBe(false);
  });

  it('masks sensitive values', () => {
    expect(maskEin('12-3456789')).toBe('••-•••6789');
    expect(maskEin(null)).toBe('—');
    expect(maskPhone('+15551234567')).toMatch(/4567$/);
    expect(maskPhone('+15551234567')).not.toContain('5551');
  });
});

describe('registration state', () => {
  it('only treats an approved CAMPAIGN as sendable (mirrors a2pGate.ts)', () => {
    expect(canSendSms({ a2p_campaign_status: 'approved' })).toBe(true);
    expect(canSendSms({ a2p_campaign_status: 'pending' })).toBe(false);
    expect(overallState({ ...base, a2p_brand_status: 'approved', a2p_campaign_status: 'pending' })).toBe('in_review');
  });

  it('derives overall state', () => {
    expect(overallState(base)).toBe('not_started');
    expect(overallState({ ...base, a2p_brand_status: 'pending' })).toBe('in_review');
    expect(overallState({ ...base, a2p_brand_status: 'approved', a2p_campaign_status: 'approved' })).toBe('approved');
    expect(overallState({ ...base, a2p_campaign_status: 'rejected' })).toBe('action_required');
  });

  it('lists missing required fields and blocks submit until complete', () => {
    const empty = { ...base, ein: '  ', sms_sample_message: null };
    expect(computeReadiness(empty).missing.map((m) => m.key)).toEqual(['ein', 'sms_sample_message']);
    expect(canSubmit(empty)).toBe(false);
    expect(canSubmit(base)).toBe(true);
  });

  it('allows resubmit after rejection but never while pending or approved', () => {
    expect(canSubmit({ ...base, a2p_brand_status: 'rejected' })).toBe(true);
    expect(canSubmit({ ...base, a2p_brand_status: 'pending' })).toBe(false);
    expect(canSubmit({ ...base, a2p_brand_status: 'approved', a2p_campaign_status: 'approved' })).toBe(false);
  });
});

describe('currentConsent', () => {
  const row = (phone: string, granted: boolean): OptInRow => ({
    id: phone + granted, contact_phone: phone, contact_email: null, granted,
    source: 'manual', notes: null, ip_address: null, created_at: '2027-01-01',
  });

  it('takes the newest ledger row per contact (input is newest-first)', () => {
    const rows = [row('+15550000001', false), row('+15550000001', true), row('+15550000002', true)];
    expect(currentConsent(rows)).toEqual({ granted: 1, revoked: 1 });
  });

  it('treats differently formatted numbers as the same contact', () => {
    expect(currentConsent([row('(555) 000-0001', true), row('+15550000001', false)])).toEqual({ granted: 1, revoked: 0 });
  });
});

describe('toCsv', () => {
  it('quotes cells and neutralises formula injection but keeps phone numbers', () => {
    const csv = toCsv(['Phone', 'Note'], [['+15551234567', '=HYPERLINK("x")'], ['a,b', 'line\nbreak']]);
    expect(csv).toContain('+15551234567');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"line\nbreak"');
  });
});

describe('data access is scoped to the account owner', () => {
  it('fetchOptOuts filters by user_id, paginates and searches by digits', async () => {
    nextResult = { data: [], error: null, count: 0 };
    await fetchOptOuts('owner-1', { search: '(555) 12', offset: 25 });
    const c = calls[0];
    expect(c.table).toBe('dnc_suppressions');
    expect(c.ops).toContainEqual(['eq', ['user_id', 'owner-1']]);
    expect(c.ops).toContainEqual(['range', [25, 49]]);
    expect(c.ops).toContainEqual(['ilike', ['phone_number', '%55512%']]);
  });

  it('addManualOptOut writes a normalized, owner-scoped, idempotent row', async () => {
    await addManualOptOut('owner-1', '(555) 123-4567');
    const [, args] = calls[0].ops.find(([op]) => op === 'upsert')!;
    expect(args[0]).toEqual({ user_id: 'owner-1', phone_number: '+15551234567', reason: 'manual' });
    expect(args[1]).toMatchObject({ ignoreDuplicates: true });
    await expect(addManualOptOut('owner-1', '12')).rejects.toThrow();
  });

  it('fetchOptInProof only reads this owner\'s SMS marketing consent', async () => {
    await fetchOptInProof('owner-1');
    expect(calls[0].table).toBe('consent_records');
    expect(calls[0].ops).toContainEqual(['eq', ['user_id', 'owner-1']]);
    expect(calls[0].ops).toContainEqual(['eq', ['consent_type', 'marketing_sms']]);
  });

  it('recordOptIn requires evidence and appends a granted ledger row', async () => {
    await expect(recordOptIn('owner-1', { phone: '5551234567', source: 'manual', notes: 'short' })).rejects.toThrow(/Describe/);
    expect(calls).toHaveLength(0);
    await recordOptIn('owner-1', { phone: '5551234567', source: 'web_form', notes: 'Ticked the box on booking form' });
    const [, args] = calls[0].ops.find(([op]) => op === 'insert')!;
    expect(args[0]).toMatchObject({ user_id: 'owner-1', contact_phone: '+15551234567', consent_type: 'marketing_sms', granted: true });
  });

  it('surfaces database errors', async () => {
    nextResult = { data: null, error: new Error('boom') };
    await expect(fetchOptInProof('owner-1')).rejects.toThrow('boom');
  });
});

describe('submitRegistration (register-a2p-brand)', () => {
  it('returns the brand SID on success', async () => {
    invoke.mockResolvedValue({ data: { success: true, brandSid: 'BN123', status: 'pending' }, error: null });
    await expect(submitRegistration()).resolves.toEqual({ brandSid: 'BN123', status: 'pending' });
    expect(invoke).toHaveBeenCalledWith('register-a2p-brand');
  });

  it('shows the real server error instead of a generic one', async () => {
    const context = { json: async () => ({ error: 'Missing required fields: ein' }) };
    invoke.mockResolvedValue({ data: null, error: Object.assign(new Error('non-2xx'), { context }) });
    await expect(submitRegistration()).rejects.toThrow('Missing required fields: ein');
  });
});
