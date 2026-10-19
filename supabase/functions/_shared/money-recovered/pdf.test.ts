import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';
import { computeStatement, weekWindowFor, type LedgerEvent } from './engine';
import { buildStatementPdf } from './pdf';

const window = weekWindowFor('2026-10-05', 'UTC')!;
const now = new Date('2026-10-12T08:00:00Z');
const ev = (i: number, over: Partial<LedgerEvent> = {}): LedgerEvent => ({
  id: `e${i}`, source_type: 'missed_call', call_id: i % 2 ? '11111111-2222-3333-4444-555555555555' : null,
  customer_name: `Customer ${i} Ünï`, occurred_at: '2026-10-06T15:00:00Z', estimated_value_cents: 50_000, status: 'recovered',
  recovery_method: 'callback', recovered_amount_cents: 40_000, follow_up_count: 1,
  last_follow_up_at: '2026-10-07T15:00:00Z', resolved_at: '2026-10-08T15:00:00Z', ...over,
});
const baseline = { monthly_leak_cents: 600_000, source: 'leak_report', captured_at: '2026-03-01T00:00:00Z', label: null };
const header = (b: Uint8Array) => String.fromCharCode(...b.slice(0, 5));

describe('buildStatementPdf', () => {
  it('builds a valid PDF with every section', () => {
    const statement = computeStatement({
      events: [ev(1), ev(2, { recovery_method: 'manual' }), ev(3, { status: 'open', recovered_amount_cents: null, resolved_at: null })],
      calls: [{ id: '11111111-2222-3333-4444-555555555555', summary: 'AC not cooling', has_recording: true }],
      baseline, window, now,
    });
    const bytes = buildStatementPdf(jsPDF as never, { companyName: 'Acme HVAC', statement, siteUrl: 'https://app.vireek.com' });
    expect(header(bytes)).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('paginates long statements and survives empty data and odd names', () => {
    const many = computeStatement({ events: Array.from({ length: 120 }, (_, i) => ev(i)), calls: [], baseline: null, window, now });
    expect(buildStatementPdf(jsPDF as never, { companyName: 'Acme', statement: many, siteUrl: 'https://app.vireek.com' }).length).toBeGreaterThan(2000);
    const empty = computeStatement({ events: [], calls: [], baseline: null, window, now });
    expect(() => buildStatementPdf(jsPDF as never, { companyName: '', statement: empty, siteUrl: 'https://app.vireek.com' })).not.toThrow();
  });
});
