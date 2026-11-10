import { describe, it, expect } from 'vitest';
import { accountingCsvConnector, csvCell, formatAmount } from './accountingCsv';
import { ConnectorError, ConnectorRegistry, assertScopes, defineConnector, pickFields } from './sdk';

const ctx = { accountOwnerId: 'owner-1', now: new Date('2026-11-09T10:00:00Z') };
const job = (o: Record<string, unknown> = {}) => ({
  id: 'j1', customer_name: 'Acme', service_type: 'AC repair', invoice_amount: 120.5,
  invoice_status: 'sent', completed_at: '2026-11-01T08:00:00Z', created_at: '2026-10-30T08:00:00Z', ...o,
});

describe('accounting-csv connector', () => {
  it('exports a header plus one line per billable job', () => {
    const r = accountingCsvConnector.run([job()], ctx);
    expect(r.output.csv).toBe('InvoiceDate,Reference,Customer,Description,Amount,Status\r\n2026-11-01,j1,Acme,AC repair,120.50,sent\r\n');
    expect(r.processed).toBe(1);
    expect(r.output.filename).toBe('vireek-accounting-2026-11-09.csv');
  });
  it('never exports PII outside the allowlist', () => {
    const r = accountingCsvConnector.run([job({ address: '1 Secret St', phone: '555-0100', notes: 'gate code 1234' })], ctx);
    expect(r.output.csv).not.toMatch(/Secret|555-0100|gate code/);
  });
  it('neutralises CSV formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
  });
  it('skips invalid, duplicate, void and undated rows with a reason', () => {
    const r = accountingCsvConnector.run([
      job(), job(), job({ id: 'j2', invoice_amount: null }), job({ id: 'j3', invoice_status: 'void' }),
      job({ id: 'j4', completed_at: null, created_at: 'nope' }), { customer_name: 'x' },
    ], ctx);
    expect(r.processed).toBe(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(['duplicate_id', 'no_valid_invoice_amount', 'invoice_not_billable', 'no_valid_date', 'missing_id']);
  });
  it('formats amounts exactly', () => {
    expect(formatAmount(0.1 + 0.2)).toBe('0.30');
    expect(formatAmount('19.999')).toBe('20.00');
    expect(formatAmount(-1)).toBeNull();
    expect(formatAmount(Number.NaN)).toBeNull();
  });
});

describe('connector sdk', () => {
  it('rejects malformed manifests', () => {
    expect(() => defineConnector({ manifest: { id: 'Bad Id', name: 'x', version: '1', direction: 'export', requiredScopes: ['jobs:read'], readableFields: {} }, run: () => ({ output: null, processed: 0, skipped: [] }) })).toThrow(ConnectorError);
  });
  it('registry blocks duplicates and unknown ids', () => {
    const reg = new ConnectorRegistry();
    reg.register(accountingCsvConnector);
    expect(() => reg.register(accountingCsvConnector)).toThrow(/already registered/);
    expect(() => reg.get('nope')).toThrow(/Unknown connector/);
    expect(reg.list()[0].id).toBe('accounting-csv');
  });
  it('enforces scopes and field allowlists', () => {
    expect(() => assertScopes(accountingCsvConnector.manifest, ['leads:read'])).toThrow(/jobs:read/);
    expect(() => assertScopes(accountingCsvConnector.manifest, ['jobs:read'])).not.toThrow();
    expect(pickFields({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });
  });
});
