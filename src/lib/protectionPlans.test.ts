import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { rpc, from: vi.fn() } }));

import {
  EMPTY_TEMPLATE,
  addMonths,
  blockerMessage,
  certificateLink,
  claimBlockReason,
  cleanList,
  coverageEnd,
  coveredFrom,
  daysLeftLabel,
  earnedCents,
  effectiveStatus,
  fetchCertificate,
  fileClaim,
  formatMoney,
  isOfferedOnQuote,
  offerItemId,
  parseCertificate,
  parseFinancials,
  parseMoney,
  payableCents,
  protectionErrorMessage,
  refundCents,
  remainingCents,
  renewalState,
  runLifecycle,
  sellPlan,
  termDays,
  termLabel,
  toTemplateRow,
  unearnedCents,
  validateTemplate,
  type PlanClaim,
  type ProtectionContract,
  type TemplateInput,
} from './protectionPlans';

beforeEach(() => rpc.mockReset());

const contract = (over: Partial<ProtectionContract> = {}): ProtectionContract => ({
  id: 'c1',
  template_id: 't1',
  contract_number: 'PPC-00001',
  status: 'active',
  source: 'manual',
  customer_id: 'cu1',
  customer_name: 'Jane',
  customer_email: null,
  customer_phone: null,
  plan_name: 'Gold',
  term_months: 12,
  price_cents: 24_000,
  deductible_cents: 5_000,
  per_claim_limit_cents: 60_000,
  aggregate_limit_cents: 100_000,
  waiting_period_days: 30,
  free_look_days: 30,
  cancellation_fee_cents: 2_500,
  reserve_percent: 35,
  max_equipment: 2,
  renewable: true,
  quote_id: null,
  job_id: null,
  invoice_id: null,
  renewed_from_id: null,
  coverage_start: '2027-01-01',
  coverage_end: '2027-12-31',
  activated_at: null,
  activation_blocker: null,
  cancelled_effective: null,
  cancel_reason: null,
  refund_cents: 0,
  paid_out_cents: 0,
  renewal_offered_at: null,
  public_token: 'tok',
  created_at: '2027-01-01T00:00:00Z',
  protection_contract_equipment: [],
  ...over,
});

const claim = (over: Partial<PlanClaim> = {}): PlanClaim => ({
  id: 'k1',
  protection_contract_id: 'c1',
  equipment_id: 'e1',
  claim_number: 'PPC-00001-C1',
  status: 'submitted',
  customer_name: 'Jane',
  failure_date: '2027-03-01',
  failure_description: 'x',
  part_cost_cents: 0,
  labor_cost_cents: 0,
  claimed_amount_cents: 0,
  deductible_cents: 5_000,
  approved_amount_cents: null,
  credit_received_cents: null,
  credit_received_at: null,
  credit_method: null,
  denial_reason: null,
  notes: null,
  repair_job_id: null,
  submitted_at: null,
  created_at: '2027-03-02T00:00:00Z',
  ...over,
});

describe('dates (mirror of Postgres date arithmetic)', () => {
  it('clamps month ends like date + interval', () => {
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2027-11-15', 3)).toBe('2028-02-15');
    expect(addMonths('2027-03-31', -1)).toBe('2027-02-28');
  });

  it('coverage end is inclusive (start + term - 1 day)', () => {
    expect(coverageEnd('2027-01-01', 12)).toBe('2027-12-31');
    expect(coverageEnd('2027-01-31', 1)).toBe('2027-02-27');
    expect(termDays('2027-01-01', '2027-12-31')).toBe(365);
    expect(termDays('2028-01-01', '2028-12-31')).toBe(366);
  });
});

describe('earned premium (straight-line, daily)', () => {
  it('matches the SQL function on known values', () => {
    expect(earnedCents(24_000, '2027-01-01', '2027-12-31', '2027-01-01')).toBe(65);
    expect(earnedCents(24_000, '2027-01-01', '2027-12-31', '2026-12-31')).toBe(0);
    expect(earnedCents(24_000, '2027-01-01', '2027-12-31', '2027-12-31')).toBe(24_000);
    expect(earnedCents(24_000, '2027-01-01', '2027-12-31', '2030-01-01')).toBe(24_000);
  });

  it('earned + unearned always equals price and never goes negative', () => {
    for (const asOf of ['2026-06-01', '2027-01-01', '2027-04-17', '2027-12-31', '2028-06-01']) {
      const e = earnedCents(19_999, '2027-01-01', '2027-12-31', asOf);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e + unearnedCents(19_999, '2027-01-01', '2027-12-31', asOf)).toBe(19_999);
    }
  });

  it('is 0 without dates', () => {
    expect(earnedCents(24_000, null, null, '2027-01-01')).toBe(0);
  });
});

describe('cancellation refund', () => {
  const base = {
    priceCents: 24_000,
    start: '2027-01-01',
    end: '2027-12-31',
    freeLookDays: 30,
    feeCents: 2_500,
    paidOutCents: 0,
    claimsFiled: 0,
  };

  it('is a full refund inside the free-look period with no claims', () => {
    expect(refundCents({ ...base, effective: '2027-01-20' })).toBe(24_000);
    expect(refundCents({ ...base, effective: '2027-01-31' })).toBe(24_000);
  });

  it('is a full refund before coverage starts', () => {
    expect(refundCents({ ...base, effective: '2026-12-15' })).toBe(24_000);
  });

  it('is pro-rata minus the fee after free-look', () => {
    expect(refundCents({ ...base, effective: '2027-07-02' })).toBe(Math.floor((24_000 * 183) / 365) - 2_500);
  });

  it('loses free-look once any claim is filed or paid', () => {
    const r = refundCents({ ...base, effective: '2027-01-20', claimsFiled: 1 });
    expect(r).toBeLessThan(24_000);
    expect(r).toBe(Math.floor((24_000 * (365 - 19)) / 365) - 2_500);
  });

  it('subtracts paid claims and never goes below zero', () => {
    expect(refundCents({ ...base, effective: '2027-07-02', paidOutCents: 5_000 })).toBe(Math.floor((24_000 * 183) / 365) - 2_500 - 5_000);
    expect(refundCents({ ...base, effective: '2027-07-02', paidOutCents: 100_000 })).toBe(0);
  });

  it('is never more than the price', () => {
    expect(refundCents({ ...base, effective: '2027-02-15', feeCents: 0 })).toBeLessThanOrEqual(24_000);
  });
});

describe('claim payout', () => {
  it('applies deductible, then per-claim limit, then aggregate remaining', () => {
    expect(payableCents(100_000, 5_000, 60_000, null)).toBe(60_000);
    expect(payableCents(100_000, 5_000, 60_000, 40_000)).toBe(40_000);
    expect(payableCents(50_000, 5_000, 60_000, 40_000)).toBe(40_000);
    expect(payableCents(8_000, 5_000, null, null)).toBe(3_000);
  });

  it('is zero when the claim is below the deductible or limits are exhausted', () => {
    expect(payableCents(4_000, 5_000, null, null)).toBe(0);
    expect(payableCents(50_000, 0, null, 0)).toBe(0);
    expect(payableCents(50_000, 0, null, -10)).toBe(0);
  });

  it('computes the aggregate remaining from paid + approved-unpaid claims', () => {
    const c = contract({ aggregate_limit_cents: 100_000, paid_out_cents: 60_000 });
    const claims = [
      claim({ id: 'a', status: 'approved', approved_amount_cents: 25_000 }),
      claim({ id: 'b', status: 'submitted', approved_amount_cents: null }),
      claim({ id: 'c', status: 'credit_received', approved_amount_cents: 60_000 }),
    ];
    expect(remainingCents(c, claims)).toBe(15_000);
    expect(remainingCents(c, claims, 'a')).toBe(40_000);
    expect(remainingCents(contract({ aggregate_limit_cents: null }), claims)).toBeNull();
    expect(remainingCents(contract({ aggregate_limit_cents: 10, paid_out_cents: 50 }), [])).toBe(0);
  });
});

describe('claim eligibility', () => {
  const unit = { linked_at: '2027-01-01T10:00:00Z' };
  const today = '2027-06-01';

  it('allows a claim after the waiting period', () => {
    expect(claimBlockReason(contract(), unit, '2027-05-01', [], today)).toBeNull();
  });

  it('blocks failures inside the waiting period, counted from the later of start and link date', () => {
    expect(claimBlockReason(contract(), unit, '2027-01-30', [], today)).toBe('waiting_period');
    expect(claimBlockReason(contract(), unit, '2027-01-31', [], today)).toBeNull();
    expect(claimBlockReason(contract(), { linked_at: '2027-04-01T00:00:00Z' }, '2027-04-20', [], today)).toBe('waiting_period');
    expect(coveredFrom(contract(), '2027-04-01T00:00:00Z')).toBe('2027-05-01');
    expect(coveredFrom(contract({ coverage_start: null }), '2027-04-01')).toBeNull();
  });

  it('blocks dates outside the term, in the future, and inactive plans', () => {
    expect(claimBlockReason(contract(), unit, '2026-12-31', [], today)).toBe('outside_term');
    expect(claimBlockReason(contract(), unit, '2028-01-01', [], '2028-01-02')).toBe('outside_term');
    expect(claimBlockReason(contract(), unit, '2027-07-01', [], today)).toBe('future_date');
    expect(claimBlockReason(contract({ status: 'pending_payment' }), unit, '2027-05-01', [], today)).toBe('not_active');
    expect(claimBlockReason(contract({ status: 'cancelled' }), unit, '2027-05-01', [], today)).toBe('not_active');
  });

  it('allows late filing within 30 days of the end, then closes the window', () => {
    expect(claimBlockReason(contract({ status: 'expired' }), unit, '2027-12-20', [], '2028-01-25')).toBeNull();
    expect(claimBlockReason(contract({ status: 'expired' }), unit, '2027-12-20', [], '2028-02-01')).toBe('reporting_window_closed');
  });

  it('blocks when the total limit is used up', () => {
    const c = contract({ aggregate_limit_cents: 50_000, paid_out_cents: 50_000 });
    expect(claimBlockReason(c, unit, '2027-05-01', [], today)).toBe('aggregate_limit_reached');
  });
});

describe('contract state', () => {
  it('derives the effective status from dates', () => {
    expect(effectiveStatus(contract(), '2027-06-01')).toBe('active');
    expect(effectiveStatus(contract(), '2028-01-01')).toBe('expired');
    expect(effectiveStatus(contract(), '2026-12-01')).toBe('scheduled');
    expect(effectiveStatus(contract({ status: 'cancelled' }), '2027-06-01')).toBe('cancelled');
    expect(effectiveStatus(contract({ status: 'pending_payment', coverage_start: null, coverage_end: null }), '2027-06-01')).toBe('pending_payment');
  });

  it('classifies renewals', () => {
    const c = contract();
    expect(renewalState(c, [], '2027-01-15')).toBe('too_early');
    expect(renewalState(c, [], '2027-10-15')).toBe('due');
    expect(renewalState(c, [], '2028-01-15')).toBe('due');
    expect(renewalState(c, [], '2028-02-15')).toBe('lapsed');
    expect(renewalState(c, [{ renewed_from_id: 'c1', status: 'pending_payment' }], '2027-10-15')).toBe('renewed');
    expect(renewalState(c, [{ renewed_from_id: 'c1', status: 'cancelled' }], '2027-10-15')).toBe('due');
    expect(renewalState(contract({ renewable: false }), [], '2027-10-15')).toBe('not_applicable');
    expect(renewalState(contract({ status: 'cancelled' }), [], '2027-10-15')).toBe('not_applicable');
  });

  it('words the countdown', () => {
    expect(daysLeftLabel(null)).toBe('—');
    expect(daysLeftLabel('2027-06-01', '2027-06-01')).toBe('Ends today');
    expect(daysLeftLabel('2027-06-02', '2027-06-01')).toBe('1 day left');
    expect(daysLeftLabel('2027-06-11', '2027-06-01')).toBe('10 days left');
    expect(daysLeftLabel('2027-05-31', '2027-06-01')).toBe('Ended yesterday');
    expect(daysLeftLabel('2027-05-21', '2027-06-01')).toBe('Ended 11 days ago');
  });
});

describe('money + labels', () => {
  it('formats cents', () => {
    expect(formatMoney(24_000)).toBe('$240');
    expect(formatMoney(24_050)).toBe('$240.50');
    expect(formatMoney(123_456_789)).toBe('$1,234,567.89');
    expect(formatMoney(-500)).toBe('−$5');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('parses user input to cents and rejects junk', () => {
    expect(parseMoney('$1,234.50')).toEqual({ ok: true, cents: 123_450 });
    expect(parseMoney('249')).toEqual({ ok: true, cents: 24_900 });
    expect(parseMoney('0.29')).toEqual({ ok: true, cents: 29 });
    expect(parseMoney('0').ok).toBe(false);
    expect(parseMoney('0', { allowZero: true })).toEqual({ ok: true, cents: 0 });
    expect(parseMoney('-5').ok).toBe(false);
    expect(parseMoney('12.345').ok).toBe(false);
    expect(parseMoney('abc').ok).toBe(false);
    expect(parseMoney('').ok).toBe(false);
    expect(parseMoney('100001').ok).toBe(false);
    expect(parseMoney('1e3').ok).toBe(false);
  });

  it('labels terms', () => {
    expect(termLabel(12)).toBe('1 year');
    expect(termLabel(36)).toBe('3 years');
    expect(termLabel(18)).toBe('18 months');
    expect(termLabel(1)).toBe('1 month');
  });
});

describe('quote offers', () => {
  it('uses a stable item id that survives add-on normalisation', () => {
    expect(offerItemId('abc')).toBe('protection:abc');
    expect(offerItemId('0b1c2d3e-0000-4000-8000-000000000001').length).toBeLessThanOrEqual(64);
    expect(isOfferedOnQuote({ optional_items: [{ id: 'protection:t1' }] }, 't1')).toBe(true);
    expect(isOfferedOnQuote({ optional_items: [{ id: 'other' }] }, 't1')).toBe(false);
    expect(isOfferedOnQuote({ optional_items: null as unknown as { id: string }[] }, 't1')).toBe(false);
  });
});

describe('template validation', () => {
  const valid: TemplateInput = { ...EMPTY_TEMPLATE, name: 'Gold', price_cents: 24_000, per_claim_limit_cents: 60_000, aggregate_limit_cents: 100_000, deductible_cents: 5_000 };

  it('accepts a sensible plan', () => {
    expect(validateTemplate(valid)).toEqual([]);
  });

  it('rejects every invalid field with a message', () => {
    expect(validateTemplate({ ...valid, name: '  ' }).length).toBe(1);
    expect(validateTemplate({ ...valid, price_cents: 0 }).length).toBe(1);
    expect(validateTemplate({ ...valid, term_months: 0 }).length).toBe(1);
    expect(validateTemplate({ ...valid, term_months: 121 }).length).toBe(1);
    expect(validateTemplate({ ...valid, term_months: 1.5 }).length).toBe(1);
    expect(validateTemplate({ ...valid, reserve_percent: 101 }).length).toBe(1);
    expect(validateTemplate({ ...valid, waiting_period_days: -1 }).length).toBe(1);
    expect(validateTemplate({ ...valid, max_equipment: 0 }).length).toBe(1);
    expect(validateTemplate({ ...valid, per_claim_limit_cents: 200_000 }).length).toBe(1);
    expect(validateTemplate({ ...valid, deductible_cents: 60_000 }).length).toBe(1);
    expect(validateTemplate({ ...valid, terms: 'x'.repeat(20_001) }).length).toBe(1);
  });

  it('normalises list fields', () => {
    expect(cleanList([' Parts ', 'parts', '', 'Labor'], 120)).toEqual(['Parts', 'Labor']);
    const row = toTemplateRow({ ...valid, name: ' Gold ', covered_items: ['A', 'a', ' B '], exclusions: [' ', 'X'] });
    expect(row.name).toBe('Gold');
    expect(row.covered_items).toEqual(['A', 'B']);
    expect(row.exclusions).toEqual(['X']);
  });
});

describe('error mapping', () => {
  it('maps server codes to friendly text', () => {
    expect(protectionErrorMessage(new Error('equipment_already_covered'))).toMatch(/already covered/);
    expect(protectionErrorMessage({ message: 'ERROR: within_waiting_period' })).toMatch(/waiting period/);
    expect(protectionErrorMessage(new Error('open_claims'))).toMatch(/open claims/);
  });

  it('falls back safely for unknown input', () => {
    expect(protectionErrorMessage(null, 'x')).toBe('x');
    expect(protectionErrorMessage(new Error('boom: secret detail'), 'fallback')).toBe('fallback');
    expect(blockerMessage(null)).toBeNull();
    expect(blockerMessage('invoice_line_missing')).toMatch(/removed/);
    expect(blockerMessage('weird')).toBe('Activation needs attention.');
  });
});

describe('server JSON parsing never throws', () => {
  it('parses financials and zero-fills junk', () => {
    expect(parseFinancials(null).written_premium_cents).toBe(0);
    expect(parseFinancials('x').monthly).toEqual([]);
    const f = parseFinancials({
      earned_cents: 500,
      loss_ratio_percent: 12.5,
      contracts: { active: 3 },
      monthly: [{ month: '2027-01-01', premium_written_cents: 100 }, null, 'x'],
    });
    expect(f.earned_cents).toBe(500);
    expect(f.loss_ratio_percent).toBe(12.5);
    expect(f.contracts).toEqual({ active: 3, pending: 0, expired: 0, cancelled: 0 });
    expect(f.monthly).toHaveLength(1);
    expect(parseFinancials({ loss_ratio_percent: 'x' }).loss_ratio_percent).toBeNull();
  });

  it('parses a certificate or returns null', () => {
    expect(parseCertificate(null)).toBeNull();
    expect(parseCertificate({ plan_name: 'x' })).toBeNull();
    const c = parseCertificate({
      contract_number: 'PPC-00001',
      plan_name: 'Gold',
      status: 'weird',
      covered_items: ['Parts', 3],
      equipment: [{ equipment_type: 'Furnace', serial_last4: '5678' }, null],
    });
    expect(c?.status).toBe('pending_payment');
    expect(c?.covered_items).toEqual(['Parts']);
    expect(c?.equipment).toEqual([{ equipment_type: 'Furnace', make: null, model: null, serial_last4: '5678' }]);
  });

  it('builds the customer link', () => {
    expect(certificateLink('tok', 'https://app.example.com')).toBe('https://app.example.com/protection/tok');
  });
});

describe('data access', () => {
  const TOKEN = '0b1c2d3e-0000-4000-8000-000000000001';

  it('sends the right arguments when selling a plan', async () => {
    rpc.mockResolvedValue({ data: { id: 'c1', contract_number: 'PPC-00001' }, error: null });
    const res = await sellPlan({ templateId: 't', customerId: 'cu', equipmentIds: ['e1'], invoiceId: 'inv' });
    expect(res.contract_number).toBe('PPC-00001');
    expect(rpc).toHaveBeenCalledWith('sell_protection_plan', {
      p_template_id: 't',
      p_customer_id: 'cu',
      p_equipment_ids: ['e1'],
      p_invoice_id: 'inv',
      p_job_id: null,
    });
  });

  it('throws an Error carrying the server code so it can be mapped', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'equipment_type_not_eligible' } });
    await expect(sellPlan({ templateId: 't', customerId: 'cu', equipmentIds: ['e1'] })).rejects.toThrow('equipment_type_not_eligible');
  });

  it('files a claim with cents and null job by default', async () => {
    rpc.mockResolvedValue({ data: 'claim-1', error: null });
    await fileClaim({ contractId: 'c', equipmentId: 'e', failureDate: '2027-05-01', description: 'd', partCostCents: 100, laborCostCents: 200 });
    expect(rpc).toHaveBeenCalledWith('file_protection_claim', {
      p_contract_id: 'c',
      p_equipment_id: 'e',
      p_failure_date: '2027-05-01',
      p_failure_description: 'd',
      p_part_cost_cents: 100,
      p_labor_cost_cents: 200,
      p_repair_job_id: null,
    });
  });

  it('fetchCertificate rejects malformed tokens without calling the server', async () => {
    expect(await fetchCertificate('nope')).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fetchCertificate never throws', async () => {
    rpc.mockRejectedValue(new Error('network'));
    expect(await fetchCertificate(TOKEN)).toBeNull();
    rpc.mockResolvedValue({ data: null, error: { message: 'missing function' } });
    expect(await fetchCertificate(TOKEN)).toBeNull();
    rpc.mockResolvedValue({ data: { contract_number: 'PPC-1', plan_name: 'Gold', status: 'active' }, error: null });
    expect((await fetchCertificate(TOKEN))?.plan_name).toBe('Gold');
  });

  it('runLifecycle swallows failures', async () => {
    rpc.mockRejectedValue(new Error('down'));
    await expect(runLifecycle()).resolves.toBeUndefined();
  });
});
