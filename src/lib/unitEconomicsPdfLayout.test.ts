import { describe, it, expect } from 'vitest';
import type { jsPDF } from 'jspdf';
import { buildReportBlocks, pdfSafe, renderReportPdf } from './unitEconomicsPdfLayout';
import { buildPlanStats, buildTenantMargins, negativeMarginOrgs, summarizeMargins, type UeTenantRow } from './marginDashboard';
import type { ReportModel } from './unitEconomicsReportHtml';

const row = (o: Partial<UeTenantRow>): UeTenantRow => ({ account_id: 'abcdef123456', email: null, company_name: 'Acme', plan: 'starter', voice_seconds: 0, voice_calls: 0, reported_voice_cost_usd: 0, calls_with_cost: 0, ai_cost_usd: 0, ...o });

function model(rows: UeTenantRow[]): ReportModel {
  const ms = buildTenantMargins(rows, { fallbackVoiceCpm: 0.1, days: 30 });
  return {
    title: 'Vireek unit economics', periodLabel: 'Last 30 days', generatedAtIso: '2026-11-04T00:00:00Z', coverage: { callsTotal: 10, callsWithCost: 5 },
    totals: summarizeMargins(ms), planStats: buildPlanStats(ms), negative: negativeMarginOrgs(ms, 500), drivers: [{ label: 'tts', usd: 3, basis: 'provider_reported' }],
    freeTier: { orgs: 0, avgCostUsd: null }, reconciliation: null, assumptions: ['Revenue is an ESTIMATE.', 'Measured ≥ estimated → check'],
  };
}

describe('pdfSafe', () => {
  it('maps typographic characters and replaces what built-in PDF fonts cannot draw', () => {
    expect(pdfSafe('a — b ≥ c → d')).toBe('a - b >= c -> d');
    expect(pdfSafe('سلام')).toBe('????');
    expect(pdfSafe('Café')).toBe('Café');
  });
});

describe('buildReportBlocks', () => {
  it('uses a short account id when the name is not drawable', () => {
    const blocks = buildReportBlocks(model([row({ company_name: 'شرکت تست', ai_cost_usd: 500 })]));
    const table = blocks.find((b) => b.kind === 'table' && b.head[0] === 'Organisation');
    expect(table && table.kind === 'table' && table.rows[0][0]).toBe('Account abcdef12');
  });
  it('states "None" instead of an empty table and always lists assumptions', () => {
    const blocks = buildReportBlocks(model([row({})]));
    expect(blocks.some((b) => b.kind === 'paragraph' && b.text === 'None in this window.')).toBe(true);
    expect(blocks.some((b) => b.kind === 'bullets' && b.items.length === 2)).toBe(true);
  });
});

// A recording stand-in for jsPDF: checks pagination and that only drawable text is emitted. (Real PDF bytes: unitEconomicsPdf.test.ts)
function stub() {
  const texts: string[] = [];
  const state = { pages: 1, current: 1 };
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'text') return (t: string | string[]) => { (Array.isArray(t) ? t : [t]).forEach((x) => texts.push(x)); return self; };
      if (prop === 'getTextWidth') return (s: string) => s.length * 4.5;
      if (prop === 'splitTextToSize') return (s: string, w: number) => { const per = Math.max(1, Math.floor(w / 4.5)); const out: string[] = []; for (let i = 0; i < s.length; i += per) out.push(s.slice(i, i + per)); return out.length ? out : ['']; };
      if (prop === 'addPage') return () => { state.pages++; state.current = state.pages; return self; };
      if (prop === 'getNumberOfPages') return () => state.pages;
      if (prop === 'setPage') return (p: number) => { state.current = p; return self; };
      return () => self;
    },
  });
  return { doc: self as unknown as jsPDF, texts, state };
}

describe('renderReportPdf', () => {
  it('paginates long tables and writes a footer on every page', () => {
    const rows = Array.from({ length: 120 }, (_, i) => row({ account_id: `id${i}`.padEnd(12, 'x'), company_name: `Org ${i}`, ai_cost_usd: 300 + i }));
    const { doc, texts, state } = stub();
    renderReportPdf(doc, buildReportBlocks(model(rows)), { footer: 'Vireek · Internal' });
    expect(state.pages).toBeGreaterThan(2);
    expect(texts.filter((t) => t.startsWith('Page ')).length).toBe(state.pages);
    expect(texts.some((t) => t.includes('Org 119'))).toBe(true);
  });
  it('never emits characters outside Latin-1', () => {
    const { doc, texts } = stub();
    renderReportPdf(doc, buildReportBlocks(model([row({ company_name: 'شرکت ✓ 测试', ai_cost_usd: 500 })])), { footer: 'x' });
    expect(texts.every((t) => !/[^\t\n\x20-\x7E\xA0-\xFF]/.test(t))).toBe(true);
  });
});
