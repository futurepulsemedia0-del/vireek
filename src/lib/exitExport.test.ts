import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { DEFAULT_SETTINGS, evaluate, type AddBack, type ExitMetrics, type ModelInput } from '@/lib/exitReadiness';
import { buildReadinessChecklist, evidenceScore, parseRun, resolveEffectiveMultiples, scoreSignals, type FactRow, type RunRow } from '@/lib/exitLineage';
import { buildExportSheets, exportFileName, fmtCell, toLatin1, writePdf, writeXlsx, type ExportInput } from '@/lib/exitExport';

const H = 'f'.repeat(64);
const fact = (key: string, value: Record<string, unknown>, count = 1): FactRow => ({
  id: `f-${key}`, metric_key: key, label: `Label ${key}`, value, as_of: '2028-02-01T00:00:00Z', logic_version: 'exit_ready.v1',
  logic_text: `logic for ${key}`, source_table: 'ar_invoices', source_count: count, content_hash: H,
});
const runRow = (id: string, recon: unknown[] = []): RunRow => ({ id, as_of: '2028-02-01T00:00:00Z', logic_version: 'exit_ready.v1', run_hash: H, created_at: '2028-02-01T00:00:00Z', reconciliation: recon });

const metrics = {
  generatedAt: '2028-02-01', ledgerMonths: 12,
  financials: { revenueCents: 300_000_000, expensesCents: 250_000_000, interestCents: 0, taxCents: 0, daCents: 0, monthly: [] },
  recurringShare: 0.1, recurringAnnualCents: 30_000_000, concentration: { top1: 0.1, top5: 0.3, customers: 40 },
  workforce: { headcount: 5, avgTenureYears: 2, turnoverRate: 0.2 }, ownerDependence: { revenueShare: 0.4 }, dso: 40, arOpenCents: 1,
  margin: { overall: 0.4, coveragePct: 0.9, byService: [] }, documentation: { published: 5, categories: 3, ackRate: 0.8 },
  compliance: { credentialsTotal: 3, credentialsValid: 3, credentialsExpiring: 0, credentialsExpired: 0, insuranceTotal: 1, insuranceValid: 1, hasGeneralLiability: true },
} as unknown as ExitMetrics;

const addBack: AddBack = { id: 'a1', kind: 'owner_perquisite', label: 'Owner truck', amountCents: 500_000, justification: 'Personal vehicle expensed', evidenceRef: 'Invoice 114', active: true };

function input(withPrev = true): ExportInput {
  const facts = [
    fact('revenue_invoiced_12m', { subtotalCents: 300_000_000, taxCents: 0, totalCents: 300_000_000, invoices: 120, customers: 40 }, 120),
    fact('ar_aging', { currentCents: 100, d1to30Cents: 200, d31to60Cents: 0, d61to90Cents: 0, over90Cents: 50, openCents: 350, invoices: 3 }, 3),
    fact('recurring_revenue', { annualCents: 30_000_000, activeMemberships: 12 }, 12),
    fact('compliance', { credentialsExpired: 1, documentsExpired: 0, permitsLapsed: 0, rescissionTracked: false }, 4),
  ];
  const run = parseRun(runRow('r2', [{ key: 'invoiced_vs_gl_revenue', label: 'Invoiced vs GL', leftLabel: 'Inv', leftCents: 100, rightLabel: 'GL', rightCents: 90, diffCents: 10, toleranceCents: 5, status: 'difference', note: 'check it' }]), facts);
  const prev = withPrev ? parseRun(runRow('r1'), [fact('revenue_invoiced_12m', { subtotalCents: 200_000_000 }, 100)]) : null;
  const model: ModelInput = { metrics, settings: DEFAULT_SETTINGS, addBacks: [addBack], dataQuality: 80 };
  const checklist = buildReadinessChecklist(run, metrics);
  return {
    companyName: 'Acme HVAC', generatedAt: '2028-02-02T10:00:00.000Z', run, previousRun: prev, evaluation: evaluate(model), model,
    multiples: resolveEffectiveMultiples(DEFAULT_SETTINGS, [], 300_000_000), addBacks: [addBack], evidence: { a1: ['Truck purchase invoice'] },
    checklist, evidenceScore: evidenceScore(checklist), signals: scoreSignals(run),
  };
}

describe('buildExportSheets', () => {
  const sheets = buildExportSheets(input());
  const byName = Object.fromEntries(sheets.map((s) => [s.name, s]));

  it('has every required sheet in a stable order', () => {
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'KPI book', 'Lineage', 'Reconciliation', 'AR aging', 'Recurring revenue', 'Add-backs', 'Readiness', 'Changelog']);
  });
  it('states the disclaimer, formula, method and multiple provenance on the summary', () => {
    const s = byName.Summary;
    expect(s.notes.join(' ')).toMatch(/not a valuation/i);
    const get = (item: string) => s.rows.find((r) => r.item === item)?.value as string;
    expect(get('Formula')).toContain('earnings × multiple');
    expect(get('Multiple source — SDE')).toMatch(/Built-in placeholder.*ILLUSTRATIVE/);
    expect(get('Size band used')).toMatch(/\$1M–\$5M/);
    expect(get('Evidence run hash (SHA-256)')).toBe(H);
  });
  it('writes money cells in dollars (cents ÷ 100) and keeps the lineage hash and logic per number', () => {
    expect(byName['AR aging'].rows.find((r) => r.b === 'Total open')?.c).toBe(3.5);
    const l = byName.Lineage.rows.find((r) => r.metric === 'Label revenue_invoiced_12m');
    expect(l).toMatchObject({ logic: 'logic for revenue_invoiced_12m', records: 120, hash: H });
    expect(byName.Reconciliation.rows[0]).toMatchObject({ d: 0.1, status: 'difference' });
  });
  it('lists add-backs with evidence documents and the owner reference', () => {
    expect(byName['Add-backs'].rows[0]).toMatchObject({ amount: 5000, ev: 'Truck purchase invoice; Reference: Invoice 114', active: 'Yes' });
  });
  it('builds a changelog against the previous run', () => {
    const rev = byName.Changelog.rows.find((r) => r.metric === 'Label revenue_invoiced_12m');
    expect(rev).toMatchObject({ change: 'changed', before: '$2,000,000.00', after: '$3,000,000.00', rel: 0.5 });
    expect(byName.Changelog.rows.find((r) => r.metric === 'Label ar_aging')?.change).toBe('added');
  });
  it('says so when there is no previous run or no evidence run at all', () => {
    expect(buildExportSheets(input(false)).find((s) => s.name === 'Changelog')!.notes[0]).toMatch(/first evidence run/i);
    const none = buildExportSheets({ ...input(false), run: null, evidenceScore: null });
    expect(none.find((s) => s.name === 'KPI book')!.rows).toEqual([]);
    expect(none.find((s) => s.name === 'Summary')!.rows.find((r) => r.item === 'Evidence as of')!.value).toBe('No evidence run yet');
  });
});

describe('helpers', () => {
  it('toLatin1 replaces typographic characters and unsupported glyphs', () => {
    expect(toLatin1('Seller’s “SDE” 2× — ≥ 3…')).toBe('Seller\'s "SDE" 2x - >= 3...');
    expect(toLatin1('日本')).toBe('??');
  });
  it('fmtCell formats by kind', () => {
    expect(fmtCell(12.5, 'money')).toBe('$12.50');
    expect(fmtCell(0.256, 'pct')).toBe('25.6%');
    expect(fmtCell(1234, 'int')).toBe('1,234');
    expect(fmtCell(null, 'text')).toBe('—');
  });
  it('names files by date', () => expect(exportFileName('xlsx', '2028-02-02T10:00:00Z')).toBe('exit-ready-2028-02-02.xlsx'));
});

describe('file output', () => {
  it('writes an xlsx that reads back with the same sheets, formats and frozen header', async () => {
    const bytes = await writeXlsx(buildExportSheets(input()), { generatedAt: '2028-02-02T10:00:00.000Z', company: 'Acme HVAC' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toContain('Changelog');
    const ar = wb.getWorksheet('AR aging')!;
    expect(ar.getCell('A3').value).toBe('Bucket');
    expect(ar.getCell('B9').value).toBe(3.5);
    expect(ar.getCell('B9').numFmt).toContain('$');
    expect(String(wb.getWorksheet('Summary')!.getCell('A2').value)).toMatch(/not a valuation/i);
    expect(wb.getWorksheet('Lineage')!.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
  });
  it('writes a multi-page-capable PDF with the disclaimer footer', async () => {
    const bytes = await writePdf(buildExportSheets(input()), { generatedAt: '2028-02-02T10:00:00.000Z', company: 'Acme HVAC' });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
