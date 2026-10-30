/**
 * Owner-facing leak-repair report, one PDF per appliance (portrait, vector text only).
 * jsPDF is loaded on demand so it never bloats the main bundle.
 *
 * Built from the unit's own records: leak cases, signed verification tests
 * (technician + EPA 608 certificate number), follow-up inspections, retrofit /
 * retirement plan, the case timeline and the last 12 months of the refrigerant
 * ledger. Retention: 3 years. NOT LEGAL ADVICE — see LEGAL_NOTICE.
 */

import type { jsPDF } from 'jspdf';
import {
  CATEGORY_LABELS,
  CERT_TYPE_LABELS,
  EVENT_LABELS,
  certTypeFromCredential,
  type RefrigerantEntry,
} from '@/lib/refrigerantCompliance';
import {
  CLOSE_REASON_LABELS,
  LEGAL_NOTICE,
  METHOD_LABELS,
  NEXT_ACTION_LABELS,
  STATUS_LABELS,
  TEST_KIND_LABELS,
  type LeakCase,
  type LeakCaseDetail,
} from '@/lib/leakRepair';

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const ACCENT: [number, number, number] = [32, 58, 216];
const LINE: [number, number, number] = [210, 210, 220];
const SHADE: [number, number, number] = [244, 245, 250];
const DANGER: [number, number, number] = [200, 55, 55];

const PAGE_W = 612;
const PAGE_H = 792;
const M = 40;
const CW = PAGE_W - M * 2;
const BOTTOM = PAGE_H - 56;

export interface LeakReportInput {
  businessName: string | null;
  unit: {
    label: string | null;
    serial: string | null;
    site: string | null;
    customer: string | null;
    refrigerant: string | null;
    chargeLbs: number | null;
    category: string | null;
  };
  cases: { case: LeakCase; detail: LeakCaseDetail }[];
  /** Ledger rows for the unit (any range; the last 12 months are printed). */
  ledger: RefrigerantEntry[];
  generatedAt?: Date;
}

const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : '—');
const dt = (v: string | null | undefined) =>
  v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';

export function leakReportFilename(
  unitSerialOrLabel: string | null,
  generatedAt = new Date(),
): string {
  const slug =
    (unitSerialOrLabel ?? 'unit')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unit';
  return `leak-repair-report_${slug}_${generatedAt.toISOString().slice(0, 10)}.pdf`;
}

/** Latest retention date across the unit's cases (3 years from closure, or opening while live). */
export function reportRetainUntil(cases: LeakCase[]): string | null {
  const dates = cases
    .map((c) => c.retain_until)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

export async function generateLeakReportPdf(input: LeakReportInput): Promise<Blob> {
  const { jsPDF: PDF } = await import('jspdf');
  const doc: jsPDF = new PDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const generatedAt = input.generatedAt ?? new Date();
  let y = M;

  const fit = (text: string, width: number): string => {
    if (doc.getTextWidth(text) <= width) return text;
    let s = text;
    while (s.length > 1 && doc.getTextWidth(`${s}…`) > width) s = s.slice(0, -1);
    return `${s}…`;
  };
  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage();
      y = M;
    }
  };
  const text = (s: string, x: number, size = 9, color = INK, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    doc.text(s, x, y);
  };
  const wrap = (s: string, size = 9, color = MUTED, width = CW) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(s, width) as string[];
    for (const l of lines) {
      ensure(size + 3);
      doc.text(l, M, y);
      y += size + 3;
    }
  };
  const heading = (s: string) => {
    ensure(34);
    y += 8;
    doc.setFillColor(...SHADE);
    doc.rect(M, y - 11, CW, 18, 'F');
    text(s, M + 6, 10, ACCENT, true);
    y += 20;
  };
  const kv = (k: string, v: string, x = M, w = CW / 2) => {
    text(k, x, 8, MUTED);
    text(fit(v, w - 8), x + 92, 9, INK);
  };
  const table = (cols: { h: string; w: number }[], rows: string[][]) => {
    ensure(28);
    let x = M;
    doc.setDrawColor(...LINE);
    for (const c of cols) {
      text(c.h, x + 2, 7.5, MUTED, true);
      x += c.w;
    }
    y += 4;
    doc.line(M, y, M + CW, y);
    y += 11;
    for (const r of rows) {
      ensure(14);
      x = M;
      r.forEach((cell, i) => {
        text(fit(cell, cols[i].w - 6), x + 2, 8, INK);
        x += cols[i].w;
      });
      y += 12;
    }
    y += 4;
  };

  // ---- title ----
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');
  y = M + 6;
  text('Refrigerant leak-repair report', M, 18, INK, true);
  y += 16;
  text(
    `${input.businessName ?? 'Service provider'}  ·  generated ${generatedAt.toISOString().slice(0, 10)}`,
    M,
    9,
    MUTED,
  );
  y += 18;

  heading('Appliance');
  const u = input.unit;
  kv('Unit', u.label ?? '—');
  kv('Serial', u.serial ?? '—', M + CW / 2);
  y += 13;
  kv('Customer', u.customer ?? '—');
  kv('Refrigerant', u.refrigerant ?? '—', M + CW / 2);
  y += 13;
  kv('Site', u.site ?? '—');
  kv('Full charge', u.chargeLbs === null ? '—' : `${u.chargeLbs} lb`, M + CW / 2);
  y += 13;
  kv('Category', u.category ?? '—');
  y += 8;

  if (input.cases.length === 0) {
    wrap('No leak cases on record for this appliance.', 10, MUTED);
  }

  // ---- cases ----
  for (const { case: c, detail } of input.cases) {
    heading(`Leak case opened ${day(c.opened_at)} — ${STATUS_LABELS[c.status]}`);
    kv('Leak rate', `${c.rate_pct}% (limit ${c.threshold_pct}%)`);
    kv('Detected', dt(c.detected_at), M + CW / 2);
    y += 13;
    kv('Repair due', day(c.repair_due_at));
    kv('Retain until', day(c.retain_until), M + CW / 2);
    y += 13;
    if (c.next_action && c.next_action_due_at) {
      doc.setTextColor(
        ...(c.next_action_due_at < generatedAt.toISOString().slice(0, 10) ? DANGER : INK),
      );
      text('Next action', M, 8, MUTED);
      text(
        `${NEXT_ACTION_LABELS[c.next_action]} — due ${c.next_action_due_at}`,
        M + 92,
        9,
        c.next_action_due_at < generatedAt.toISOString().slice(0, 10) ? DANGER : INK,
        true,
      );
      y += 13;
    }
    if (c.close_reason) {
      kv('Closed', `${day(c.closed_at)} — ${CLOSE_REASON_LABELS[c.close_reason]}`);
      y += 13;
    }
    if (c.chronic_flagged_at) {
      wrap(
        'Chronic leaker: more than 125% of full charge added in one calendar year. Data for EPA HAWK is prepared separately; nothing is filed by Vireek.',
        8.5,
        DANGER,
      );
    }
    y += 4;

    if (detail.tests.length) {
      text('Signed verification tests', M, 9, INK, true);
      y += 12;
      table(
        [
          { h: 'Test', w: 120 },
          { h: 'Date (UTC)', w: 100 },
          { h: 'Result', w: 40 },
          { h: 'Technician', w: 100 },
          { h: 'EPA 608', w: 110 },
          { h: 'On time', w: 52 },
        ],
        detail.tests.map((t) => [
          `${TEST_KIND_LABELS[t.kind]} (${METHOD_LABELS[t.method]})`,
          dt(t.performed_at).replace(' UTC', ''),
          t.result.toUpperCase(),
          t.technician_name ?? '—',
          `${CERT_TYPE_LABELS[certTypeFromCredential(t.cert_type) ?? 'unspecified']} ${t.cert_number ?? ''}`.trim(),
          t.on_time ? 'Yes' : 'LATE',
        ]),
      );
    }
    if (detail.inspections.length) {
      text('Follow-up inspections', M, 9, INK, true);
      y += 12;
      table(
        [
          { h: '#', w: 24 },
          { h: 'Cadence', w: 70 },
          { h: 'Due', w: 80 },
          { h: 'Status', w: 80 },
          { h: 'Completed', w: 110 },
          { h: 'Notes', w: 148 },
        ],
        detail.inspections.map((i) => [
          String(i.period_index),
          i.cadence,
          i.due_date,
          i.status,
          i.completed_at ? dt(i.completed_at).replace(' UTC', '') : '—',
          i.waived_reason ?? i.notes ?? (i.job_id ? 'Job created' : ''),
        ]),
      );
    }
    if (detail.plan) {
      const p = detail.plan;
      text('Retrofit / retirement plan', M, 9, INK, true);
      y += 12;
      kv('Status', p.status);
      kv('Option', p.option ?? 'not chosen yet', M + CW / 2);
      y += 13;
      kv('Draft due', p.plan_due_on);
      kv('Complete by', p.complete_by, M + CW / 2);
      y += 13;
      if (p.notes) wrap(p.notes, 8.5, MUTED);
      y += 4;
    }
    if (detail.events.length) {
      text('Timeline', M, 9, INK, true);
      y += 12;
      table(
        [
          { h: 'When (UTC)', w: 110 },
          { h: 'Event', w: 110 },
          { h: 'Detail', w: 292 },
        ],
        detail.events.map((e) => [
          dt(e.created_at).replace(' UTC', ''),
          e.event_type.replace(/_/g, ' '),
          e.detail ?? '',
        ]),
      );
    }
  }

  // ---- ledger ----
  const cutoff = generatedAt.getTime() - 366 * 86_400_000;
  const rows = input.ledger
    .filter((e) => !e.voided_at && new Date(e.performed_at).getTime() >= cutoff)
    .sort((a, b) => a.performed_at.localeCompare(b.performed_at));
  heading('Refrigerant ledger — last 12 months');
  if (rows.length === 0) wrap('No refrigerant entries in the last 12 months.', 9, MUTED);
  else
    table(
      [
        { h: 'Date (UTC)', w: 100 },
        { h: 'Event', w: 60 },
        { h: 'Refrigerant', w: 80 },
        { h: 'Pounds', w: 56 },
        { h: 'Technician', w: 110 },
        { h: 'EPA 608 #', w: 106 },
      ],
      rows.map((e) => [
        dt(e.performed_at).replace(' UTC', ''),
        EVENT_LABELS[e.event_type],
        e.refrigerant_type,
        e.pounds.toFixed(2),
        e.technician_name ?? '—',
        e.cert_number ?? '—',
      ]),
    );

  // ---- retention + notice ----
  ensure(70);
  y += 6;
  const retain = reportRetainUntil(input.cases.map((c) => c.case));
  wrap(
    `Records are retained for at least ${retain ? `until ${retain}` : '3 years'} (3-year retention).`,
    8.5,
    INK,
  );
  wrap(LEGAL_NOTICE, 7.5, MUTED);
  if (u.category === null) wrap(`Category: ${CATEGORY_LABELS.other}`, 7.5, MUTED);

  // ---- footers ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE);
    doc.line(M, PAGE_H - 36, PAGE_W - M, PAGE_H - 36);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(
      `Leak-repair report · ${u.label ?? 'unit'} ${u.serial ? `· S/N ${u.serial}` : ''}`,
      M,
      PAGE_H - 24,
    );
    doc.text(`Page ${p} of ${pages}`, PAGE_W - M, PAGE_H - 24, { align: 'right' });
  }
  return doc.output('blob');
}
