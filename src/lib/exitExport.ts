/**
 * Exit-Ready — Excel and PDF export with a changelog between evidence runs.
 *
 * `buildExportSheets` is pure and unit-tested; `writeXlsx` / `writePdf` render the same sheets so both files
 * show identical numbers. Heavy libraries are imported lazily so they never load with the page.
 * Every output is a SCREENING ESTIMATE, not a valuation, appraisal, QoE, tax or legal advice.
 */

import {
  ADDBACK_KIND_LABELS, ESTIMATE_DISCLAIMER, GRADE_LABELS,
  type AddBack, type Evaluation, type ModelInput,
} from '@/lib/exitReadiness';
import {
  centsLabel, diffRuns, factMap, groupDigits, factNum, formatHeadline, headline, shortHash, SIZE_BAND_LABELS,
  type ChecklistItem, type EffectiveMultiples, type LineageRun, type MultipleProvenance, type Signal,
} from '@/lib/exitLineage';

export type CellKind = 'text' | 'money' | 'int' | 'pct';
export type Cell = string | number | null;

export interface SheetColumn {
  header: string;
  key: string;
  width: number;
  kind: CellKind;
}

export interface ExportSheet {
  name: string;
  title: string;
  columns: SheetColumn[];
  rows: Record<string, Cell>[];
  notes: string[];
}

export interface ExportInput {
  companyName: string | null;
  generatedAt: string;
  run: LineageRun | null;
  previousRun: LineageRun | null;
  evaluation: Evaluation;
  model: ModelInput;
  multiples: EffectiveMultiples;
  addBacks: AddBack[];
  /** add-back id -> evidence document titles */
  evidence: Record<string, string[]>;
  checklist: ChecklistItem[];
  evidenceScore: number | null;
  signals: Signal[];
}

const text = (header: string, key: string, width = 28): SheetColumn => ({ header, key, width, kind: 'text' });
const money = (header: string, key: string, width = 18): SheetColumn => ({ header, key, width, kind: 'money' });
const int = (header: string, key: string, width = 12): SheetColumn => ({ header, key, width, kind: 'int' });
const pctCol = (header: string, key: string, width = 12): SheetColumn => ({ header, key, width, kind: 'pct' });

const dollars = (cents: number | null): number | null => (cents === null ? null : Math.round(cents) / 100);

function provText(p: MultipleProvenance): string {
  const label = p.origin === 'manual' ? 'Entered by you' : p.origin === 'table' ? 'Your multiple table' : 'Built-in placeholder';
  return `${label}: ${p.source}${p.sourceDate ? ` (published ${p.sourceDate})` : ''}${p.illustrative ? ' — ILLUSTRATIVE, not market fact' : ''}`;
}

export function buildExportSheets(i: ExportInput): ExportSheet[] {
  const ev = i.evaluation;
  const v = ev.valuation;
  const facts = factMap(i.run);
  const sheets: ExportSheet[] = [];

  // ---- Summary: the estimate, its formula and every assumption
  const summaryRows: Record<string, Cell>[] = [
    { item: 'Prepared for', value: i.companyName ?? '—' },
    { item: 'Generated at', value: i.generatedAt },
    { item: 'Evidence as of', value: i.run?.asOf ?? 'No evidence run yet' },
    { item: 'Evidence run hash (SHA-256)', value: i.run?.runHash ?? '—' },
    { item: 'Method', value: v.method === 'sde' ? 'Seller’s discretionary earnings (SDE)' : 'Adjusted EBITDA' },
    { item: 'Earnings used', value: centsLabel(v.earningsCents) },
    { item: 'Multiple range (low / mid / high)', value: `${v.multiple.low}× / ${v.multiple.mid}× / ${v.multiple.high}×` },
    { item: 'Multiple source — SDE', value: provText(i.multiples.sde) },
    { item: 'Multiple source — EBITDA', value: provText(i.multiples.ebitda) },
    { item: 'Size band used', value: i.multiples.sizeBand ? SIZE_BAND_LABELS[i.multiples.sizeBand] : 'Unknown (no revenue)' },
    { item: 'Estimate range', value: v.reason ? 'Not available' : `${centsLabel(v.lowCents)} – ${centsLabel(v.highCents)}` },
    { item: 'Readiness-adjusted point estimate', value: v.reason ? 'Not available' : centsLabel(v.pointCents) },
    { item: 'Formula', value: 'Estimate = earnings × multiple. Low / mid / high use the low / mid / high multiple. Point estimate multiple = low + (high − low) × readiness score ÷ 100 when readiness adjustment is on.' },
    { item: 'Net income (ledger)', value: centsLabel(ev.earnings.netIncomeCents) },
    { item: 'Ledger add-backs', value: centsLabel(ev.earnings.autoAddBacksCents) },
    { item: 'Documented add-backs', value: centsLabel(ev.earnings.manualAddBacksCents) },
    { item: 'Owner replacement salary', value: centsLabel(ev.earnings.ownerSalaryCents) },
    { item: 'Sell-readiness score', value: ev.readiness.score === null ? 'Not enough data' : `${Math.round(ev.readiness.score)} / 100 (${GRADE_LABELS[ev.readiness.grade]})` },
    { item: 'Confidence', value: ev.confidence },
    { item: 'Evidence score', value: i.evidenceScore === null ? 'Run the evidence check' : `${i.evidenceScore} / 100` },
  ];
  if (v.reason) summaryRows.push({ item: 'Why there is no estimate', value: v.reason });
  sheets.push({
    name: 'Summary', title: 'Estimate summary', columns: [text('Item', 'item', 38), text('Value', 'value', 90)],
    rows: summaryRows, notes: [ESTIMATE_DISCLAIMER],
  });

  // ---- KPI book (headline per metric)
  const kpiRows: Record<string, Cell>[] = (i.run?.facts ?? []).map((f) => ({
    metric: f.label, headline: formatHeadline(f.metricKey, headline(f)), source: f.sourceTable, records: f.sourceCount, asOf: f.asOf,
  }));
  sheets.push({
    name: 'KPI book', title: 'KPI book',
    columns: [text('Metric', 'metric', 52), text('Headline', 'headline', 18), text('Source table', 'source', 26), int('Source records', 'records', 16), text('As of', 'asOf', 26)],
    rows: kpiRows, notes: i.run ? [] : ['No evidence run yet. Run the evidence check to populate this sheet.'],
  });

  // ---- Lineage (reproducible logic + hash per number)
  sheets.push({
    name: 'Lineage', title: 'Lineage: how every number was computed',
    columns: [text('Metric', 'metric', 40), text('Logic', 'logic', 110), int('Source records', 'records', 16), text('Logic version', 'ver', 16), text('SHA-256', 'hash', 70)],
    rows: (i.run?.facts ?? []).map((f) => ({ metric: f.label, logic: f.logicText, records: f.sourceCount, ver: f.logicVersion, hash: f.contentHash })),
    notes: ['A figure can be re-computed from live data at its as-of time; a different hash means the underlying records changed afterwards.'],
  });

  // ---- Reconciliation
  sheets.push({
    name: 'Reconciliation', title: 'Reconciliation checks (differences are shown, not hidden)',
    columns: [text('Check', 'check', 44), text('Left', 'left', 32), money('Left $', 'l'), text('Right', 'right', 32), money('Right $', 'r'), money('Difference $', 'd'), text('Status', 'status', 14), text('Note', 'note', 80)],
    rows: (i.run?.reconciliation ?? []).map((r) => ({ check: r.label, left: r.leftLabel, l: dollars(r.leftCents), right: r.rightLabel, r: dollars(r.rightCents), d: dollars(r.diffCents), status: r.status, note: r.note })),
    notes: [],
  });

  // ---- AR aging + recurring-revenue schedule
  const ar = facts.ar_aging;
  sheets.push({
    name: 'AR aging', title: 'Accounts receivable aging',
    columns: [text('Bucket', 'b', 24), money('Open $', 'c')],
    rows: ar ? [
      { b: 'Current', c: dollars(factNum(ar, 'currentCents')) }, { b: '1–30 days past due', c: dollars(factNum(ar, 'd1to30Cents')) },
      { b: '31–60 days', c: dollars(factNum(ar, 'd31to60Cents')) }, { b: '61–90 days', c: dollars(factNum(ar, 'd61to90Cents')) },
      { b: 'Over 90 days', c: dollars(factNum(ar, 'over90Cents')) }, { b: 'Total open', c: dollars(factNum(ar, 'openCents')) },
    ] : [],
    notes: ar ? [`${ar.sourceCount} open invoices. As of ${ar.asOf}.`] : ['No evidence run yet.'],
  });
  const rr = facts.recurring_revenue;
  const mb = facts.membership_base;
  const mr = facts.membership_renewals_12m;
  sheets.push({
    name: 'Recurring revenue', title: 'Recurring-revenue schedule',
    columns: [text('Measure', 'm', 44), text('Value', 'v', 24)],
    rows: [
      { m: 'Annualised recurring membership revenue', v: rr ? centsLabel(factNum(rr, 'annualCents')) : '—' },
      { m: 'Active memberships', v: String(factNum(rr, 'activeMemberships') ?? '—') },
      { m: 'Active at start of window', v: String(factNum(mb, 'activeAtWindowStart') ?? '—') },
      { m: '12-month retention', v: formatRatio(factNum(mb, 'retention12m')) },
      { m: 'Renewal rate (renewed ÷ renewed + lapsed)', v: formatRatio(factNum(mr, 'renewalRate')) },
      { m: 'Renewal cycles in window', v: String(factNum(mr, 'cycles') ?? '—') },
    ],
    notes: [],
  });

  // ---- Add-back schedule with evidence
  sheets.push({
    name: 'Add-backs', title: 'Add-back schedule with evidence',
    columns: [text('Type', 'kind', 26), text('Item', 'label', 36), money('Amount $', 'amount'), text('Justification', 'why', 70), text('Evidence documents', 'ev', 50), text('Counted in earnings', 'active', 20)],
    rows: i.addBacks.map((a) => ({
      kind: ADDBACK_KIND_LABELS[a.kind], label: a.label, amount: dollars(a.amountCents), why: a.justification,
      ev: [...(i.evidence[a.id] ?? []), ...(a.evidenceRef ? [`Reference: ${a.evidenceRef}`] : [])].join('; ') || 'No evidence attached',
      active: a.active ? 'Yes' : 'No',
    })),
    notes: ['Add-backs are owner-documented adjustments, not verified by Vireek or any third party.'],
  });

  // ---- Readiness checklist + signals
  sheets.push({
    name: 'Readiness', title: 'Readiness checklist and additional signals',
    columns: [text('Item', 'item', 56), text('Status', 'status', 12), text('Severity', 'sev', 12), text('Detail', 'detail', 100)],
    rows: [
      ...i.checklist.map((c) => ({ item: c.title, status: c.status, sev: c.severity, detail: c.detail })),
      ...i.signals.map((s) => ({ item: s.label, status: s.score === null ? 'info' : s.status, sev: 'signal', detail: `${s.display}. ${s.detail}` })),
    ],
    notes: [],
  });

  // ---- Changelog vs previous run
  const changes = i.run ? diffRuns(i.previousRun, i.run) : [];
  sheets.push({
    name: 'Changelog', title: i.previousRun ? `Changes since ${i.previousRun.asOf}` : 'Changes (no earlier run to compare)',
    columns: [text('Metric', 'metric', 48), text('Change', 'change', 12), text('Before', 'before', 20), text('After', 'after', 20), pctCol('Relative', 'rel')],
    rows: changes.map((c) => ({
      metric: c.label, change: c.change,
      before: c.before === null ? '—' : formatHeadline(c.metricKey, c.before),
      after: c.after === null ? '—' : formatHeadline(c.metricKey, c.after),
      rel: c.relative,
    })),
    notes: i.previousRun ? [`Compared with the run of ${i.previousRun.asOf} (${shortHash(i.previousRun.runHash ?? '')}).`] : ['This is the first evidence run.'],
  });
  return sheets;
}

function formatRatio(n: number | null): string {
  return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** jsPDF's built-in fonts only cover Latin-1: replace common typographic characters with plain ones. */
export function toLatin1(s: string): string {
  const mapped = s
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/×/g, 'x').replace(/÷/g, '/').replace(/≈/g, '~').replace(/−/g, '-').replace(/≤/g, '<=').replace(/≥/g, '>=');
  let out = '';
  for (const ch of mapped) {
    const c = ch.codePointAt(0) ?? 63;
    out += c === 9 || c === 10 || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) ? ch : '?';
  }
  return out;
}

const FILE_STAMP = (iso: string) => iso.slice(0, 10);
export const exportFileName = (ext: 'xlsx' | 'pdf', generatedAt: string) => `exit-ready-${FILE_STAMP(generatedAt)}.${ext}`;

export async function writeXlsx(sheets: ExportSheet[], meta: { generatedAt: string; company: string | null }): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vireek';
  wb.created = new Date(meta.generatedAt);
  wb.title = 'Exit-Ready screening estimate and evidence book';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.columns = s.columns.map((c) => ({ key: c.key, width: c.width }));
    ws.getCell('A1').value = `${s.title}${meta.company ? ` — ${meta.company}` : ''}`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = 'ESTIMATE — not a valuation, appraisal, QoE, tax or legal advice.';
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF9A3412' } };
    const header = ws.getRow(3);
    s.columns.forEach((c, idx) => {
      const cell = header.getCell(idx + 1);
      cell.value = c.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
    s.rows.forEach((r, rIdx) => {
      const row = ws.getRow(4 + rIdx);
      s.columns.forEach((c, idx) => {
        const cell = row.getCell(idx + 1);
        const val = r[c.key] ?? null;
        cell.value = val;
        cell.alignment = { vertical: 'top', wrapText: c.kind === 'text' };
        if (c.kind === 'money') cell.numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00';
        else if (c.kind === 'int') cell.numFmt = '#,##0';
        else if (c.kind === 'pct') cell.numFmt = '0.0%';
      });
    });
    if (s.rows.length) ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: s.columns.length } };
    let n = 4 + s.rows.length + 1;
    for (const note of s.notes) {
      ws.getCell(`A${n}`).value = note;
      ws.getCell(`A${n}`).font = { italic: true, size: 9 };
      n += 1;
    }
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

export async function writePdf(sheets: ExportSheet[], meta: { generatedAt: string; company: string | null }): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 36;
  let y = M;
  const footer = () => {
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(120);
    doc.text(toLatin1('ESTIMATE - not a valuation, appraisal, QoE, tax or legal advice. Generated from Vireek records; add-backs are owner-documented.'), M, H - 18);
    doc.text(`Page ${doc.getNumberOfPages()}`, W - M - 40, H - 18);
    doc.setTextColor(0);
  };
  const ensure = (h: number) => { if (y + h > H - 36) { footer(); doc.addPage(); y = M; } };

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Exit-Ready: screening estimate and evidence book', M, y); y += 20;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text(toLatin1(`${meta.company ? `${meta.company} - ` : ''}Generated ${meta.generatedAt}`), M, y); y += 14;

  for (const s of sheets) {
    ensure(48);
    y += 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(toLatin1(s.title), M, y); y += 14;
    const total = s.columns.reduce((a, c) => a + c.width, 0);
    const usable = W - 2 * M;
    const widths = s.columns.map((c) => (c.width / total) * usable);
    const drawRow = (cells: string[], bold: boolean) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
      const lines = cells.map((c, idx) => doc.splitTextToSize(toLatin1(c), widths[idx] - 6) as string[]);
      const h = Math.max(...lines.map((l) => l.length)) * 10 + 4;
      ensure(h);
      let x = M;
      if (bold) { doc.setFillColor(31, 41, 55); doc.rect(M, y - 8, usable, h, 'F'); doc.setTextColor(255); }
      lines.forEach((l, idx) => { doc.text(l, x + 3, y); x += widths[idx]; });
      doc.setTextColor(0);
      y += h;
    };
    drawRow(s.columns.map((c) => c.header), true);
    if (!s.rows.length) drawRow(['No data'].concat(s.columns.slice(1).map(() => '')), false);
    for (const r of s.rows) {
      drawRow(s.columns.map((c) => fmtCell(r[c.key] ?? null, c.kind)), false);
    }
    for (const n of s.notes) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7);
      const lines = doc.splitTextToSize(toLatin1(n), usable) as string[];
      ensure(lines.length * 9 + 4);
      doc.text(lines, M, y); y += lines.length * 9 + 4;
    }
  }
  footer();
  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

export function fmtCell(v: Cell, kind: CellKind): string {
  if (v === null) return '—';
  if (typeof v === 'string') return v;
  if (kind === 'money') return centsLabel(Math.round(v * 100));
  if (kind === 'pct') return `${(v * 100).toFixed(1)}%`;
  return Number.isInteger(v) ? `${v < 0 ? '-' : ''}${groupDigits(String(Math.abs(v)))}` : String(v);
}

export function downloadBytes(name: string, mime: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
