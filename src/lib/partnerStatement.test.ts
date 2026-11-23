import { describe, expect, it } from 'vitest';
import {
  buildStatementCsv,
  centsToDecimal,
  cleanPayoutError,
  exactCommissionCents,
  isClosedMonth,
  lastClosedMonth,
  parseAgreements,
  parsePayouts,
  parseStatement,
  periodLabel,
  statementFilename,
  verifyStatement,
} from './partnerStatement';

const rawStatement = (over: Record<string, unknown> = {}, snap: Record<string, unknown> = {}) => ({
  id: 'po1',
  partner_id: 'p1',
  source: 'monthly',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  status: 'calculated',
  carry_reason: null,
  gross_cents: 3125,
  clawback_cents: -1294,
  net_cents: 1831,
  min_payout_cents: 1000,
  entry_count: 4,
  agreement_version: 1,
  calculated_at: '2026-05-02T00:00:00Z',
  statement: {
    partner: { company_name: 'Acme Media', tier: 'affiliate', channel: 'youtube', referral_code: 'ACME1234', commission_rate: 12.5, commission_months: 12 },
    agreement: { version: 1, revenue_share_pct: 12.5, term_months: 12, min_payout_cents: 1000, document_ref: 'DOC-1' },
    activity: { earned_cents: 2500, clawback_cents: 0, reinstated_cents: 0, legacy_cents: 0, entries: 1 },
    carried_in_cents: -669,
    held_cents: 0,
    rounding_mismatches: 0,
    lines_truncated: false,
    lines: [
      { id: 'a1xxxxxx', entry_type: 'earn', earned_at: '2026-02-10T00:00:00Z', period_index: 3, base_cents: 5000, rate_pct: 12.5, amount_cents: 625, stripe_invoice_id: 'in_c', ref: 'a1xxxxxx' },
      { id: 'b2xxxxxx', entry_type: 'earn', earned_at: '2026-03-25T00:00:00Z', period_index: 4, base_cents: 20000, rate_pct: 12.5, amount_cents: 2500, stripe_invoice_id: 'in_d', ref: 'b2xxxxxx' },
      { id: 'c3xxxxxx', entry_type: 'clawback', earned_at: '2026-03-10T00:00:00Z', period_index: null, base_cents: null, rate_pct: null, amount_cents: -494, stripe_invoice_id: 'in_a', source_kind: 'refund', ref: 'c3xxxxxx' },
      { id: 'd4xxxxxx', entry_type: 'clawback', earned_at: '2026-03-20T00:00:00Z', period_index: null, base_cents: null, rate_pct: null, amount_cents: -800, stripe_invoice_id: 'in_b', source_kind: 'dispute', ref: 'd4xxxxxx' },
    ],
    ...snap,
  },
  ...over,
});

describe('exactCommissionCents (mirrors Postgres round(base x rate / 100))', () => {
  it('rounds half away from zero', () => {
    expect(exactCommissionCents(7900, 12.5)).toBe(988); // 987.5
    expect(exactCommissionCents(3333, 12.5)).toBe(417); // 416.625
    expect(exactCommissionCents(5000, 12.5)).toBe(625); // exact
    expect(exactCommissionCents(1004, 12.5)).toBe(126); // 125.5
  });
  it('has no floating-point drift on two-decimal rates', () => {
    // Math.round((5000 * 19.99) / 100) = 999 in floating point; numeric arithmetic gives 999.5 -> 1000
    expect(exactCommissionCents(5000, 19.99)).toBe(1000);
    expect(exactCommissionCents(25000, 19.99)).toBe(4998);
  });
  it('handles zero, negative and non-finite input', () => {
    expect(exactCommissionCents(0, 20)).toBe(0);
    expect(exactCommissionCents(-7900, 12.5)).toBe(-988);
    expect(exactCommissionCents(Number.NaN, 20)).toBe(0);
  });
  it('a pro-rata clawback sequence never exceeds the commission', () => {
    const earned = 625;
    const targets = [3333, 6667, 10000, 12000].map((refunded) => Math.round(earned * Math.min(1, refunded / 10000)));
    let clawed = 0;
    const deltas = targets.map((t) => {
      const d = Math.max(0, Math.min(t - clawed, earned - clawed));
      clawed += d;
      return d;
    });
    expect(deltas).toEqual([208, 209, 208, 0]);
    expect(clawed).toBe(earned);
  });
});

describe('centsToDecimal', () => {
  it('formats with integer maths, including negatives and sub-dollar values', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(1405)).toBe('14.05');
    expect(centsToDecimal(-494)).toBe('-4.94');
    expect(centsToDecimal(Number.NaN)).toBe('0.00');
  });
});

describe('parseStatement / parsePayouts / parseAgreements', () => {
  it('parses a statement and coerces numeric strings', () => {
    const s = parseStatement(rawStatement({ gross_cents: '3125', net_cents: '1831' }));
    expect(s).not.toBeNull();
    expect(s?.gross_cents).toBe(3125);
    expect(s?.lines).toHaveLength(4);
    expect(s?.partner.company_name).toBe('Acme Media');
    expect(s?.agreement?.version).toBe(1);
  });
  it('rejects junk instead of producing an empty statement', () => {
    expect(parseStatement(null)).toBeNull();
    expect(parseStatement({ id: 'x', status: 'bogus' })).toBeNull();
    expect(parseStatement([])).toBeNull();
  });
  it('drops lines with unknown types', () => {
    const s = parseStatement(rawStatement({}, { lines: [{ id: 'z', entry_type: 'bogus', amount_cents: 1 }] }));
    expect(s?.lines).toEqual([]);
  });
  it('parses payout rows and skips invalid ones', () => {
    const rows = parsePayouts([
      { id: 'a', status: 'paid', company_name: 'A', source: 'adhoc', net_cents: '6000' },
      { id: 'b', status: 'nope' },
      7,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'a', source: 'adhoc', net_cents: 6000 });
    expect(parsePayouts({})).toEqual([]);
  });
  it('parses agreements', () => {
    const rows = parseAgreements([{ id: 'g', version: 2, status: 'active', revenue_share_pct: '12.5', term_months: 12, min_payout_cents: 1000, effective_from: '2026-01-01' }, { id: 'h', status: 'x' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].revenue_share_pct).toBe(12.5);
  });
});

describe('verifyStatement', () => {
  it('accepts a consistent statement (gross, clawbacks netted, earn lines match round(base x rate))', () => {
    const s = parseStatement(rawStatement());
    expect(s && verifyStatement(s)).toEqual({ ok: true, problems: [] });
  });
  it('flags a net that is not gross + clawbacks', () => {
    const s = parseStatement(rawStatement({ net_cents: 9999 }));
    expect(s && verifyStatement(s).ok).toBe(false);
  });
  it('flags lines that do not add up to the totals', () => {
    const s = parseStatement(rawStatement({ gross_cents: 3000, net_cents: 1706 }));
    expect(s && verifyStatement(s).problems).toContain('line total does not match gross');
  });
  it('flags an earn line that no longer equals round(base x rate)', () => {
    const s = parseStatement(rawStatement({}, { lines: [{ id: 'q1xxxxxx', entry_type: 'earn', earned_at: '2026-02-10T00:00:00Z', period_index: 1, base_cents: 7900, rate_pct: 12.5, amount_cents: 987, stripe_invoice_id: 'in_q', ref: 'q1xxxxxx' }] }));
    expect(s && verifyStatement(s).problems.some((p) => p.includes('round(base'))).toBe(true);
  });
  it('does not compare line totals when the line list was truncated', () => {
    const s = parseStatement(rawStatement({}, { lines_truncated: true, lines: [] }));
    expect(s && verifyStatement(s).ok).toBe(true);
  });
});

describe('buildStatementCsv', () => {
  const s = parseStatement(rawStatement());
  if (!s) throw new Error('fixture');

  it('writes BOM, CRLF, one row per line plus summary rows, with negative clawbacks as numbers', () => {
    const csv = buildStatementCsv(s, 'finance');
    expect(csv.startsWith('\uFEFFPartner,Statement period,Line type')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toHaveLength(1 + 4 + 5); // header + lines + 5 summary rows
    expect(lines[3]).toContain(',Clawback,2026-03-10,c3xxxxxx,in_a,,,,-494,-4.94');
    expect(lines.find((l) => l.includes('Net balance'))).toContain(',1831,18.31');
  });
  it('the partner audience omits Stripe invoice ids', () => {
    const csv = buildStatementCsv(s, 'partner');
    expect(csv).not.toContain('in_a');
    expect(csv).not.toContain('Stripe invoice');
  });
  it('neutralises spreadsheet formulas in text cells', () => {
    const evil = parseStatement(rawStatement({}, { partner: { company_name: '=HYPERLINK("http://evil")', tier: 'affiliate', channel: null, referral_code: 'X', commission_rate: 10, commission_months: 12 } }));
    if (!evil) throw new Error('fixture');
    const csv = buildStatementCsv(evil, 'partner');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv.split('\r\n')[1].startsWith('"\'=')).toBe(true);
  });
  it('notes truncation', () => {
    const t = parseStatement(rawStatement({}, { lines_truncated: true }));
    expect(t && buildStatementCsv(t)).toContain('truncated at 5000');
  });
});

describe('filenames, periods and errors', () => {
  it('builds a safe filename', () => {
    const s = parseStatement(rawStatement());
    if (!s) throw new Error('fixture');
    expect(statementFilename(s, 'csv', 'partner', new Date('2026-05-03T10:00:00Z'))).toBe('acme-media-partner-statement-2026-05-03-2026-04.csv');
    expect(statementFilename({ ...s, period_start: null }, 'pdf', 'finance', new Date('2026-05-03T10:00:00Z'))).toBe('acme-media-partner-statement-finance-2026-05-03-adhoc.pdf');
  });
  it('labels periods in UTC and falls back for ad-hoc rows', () => {
    expect(periodLabel('2026-02-01')).toBe('February 2026');
    expect(periodLabel(null)).toBe('Ad-hoc payout');
  });
  it('knows which month is closed', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    expect(lastClosedMonth(now)).toBe('2026-10-01');
    expect(lastClosedMonth(new Date('2027-01-05T00:00:00Z'))).toBe('2026-12-01');
    expect(isClosedMonth('2026-10-01', now)).toBe(true);
    expect(isClosedMonth('2026-11-01', now)).toBe(false);
    expect(isClosedMonth('2026-10-15', now)).toBe(false);
    expect(isClosedMonth('nonsense', now)).toBe(false);
  });
  it('cleans guardrail errors', () => {
    expect(cleanPayoutError('stale_payout: the ledger changed')).toBe('the ledger changed');
    expect(cleanPayoutError('payout_guardrail: only an approved payout can be marked paid (status: calculated).')).toBe('only an approved payout can be marked paid (status: calculated).');
    expect(cleanPayoutError('Staff only.')).toBe('Staff only.');
    expect(cleanPayoutError('boom')).toBe('boom');
  });
});
