/**
 * Job Evidence Chain — exportable PDF for disputes, warranty, insurance and enterprise QA.
 * Vector text only (no DOM screenshots). jsPDF is loaded on demand so it never bloats the main bundle.
 * The report prints the chain HEAD HASH: anyone can later re-verify the ledger against it.
 */

import {
  GAP_LABELS,
  KIND_LABELS,
  LEVEL_META,
  STAGE_META,
  shortHash,
  type ChainReport,
  type EvidenceEntry,
} from '@/lib/jobEvidenceChain';

const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const SUCCESS: [number, number, number] = [22, 130, 87];
const WARNING: [number, number, number] = [190, 120, 10];
const DANGER: [number, number, number] = [200, 55, 55];
const LINE: [number, number, number] = [225, 225, 232];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const CW = PAGE_W - M * 2;

export interface EvidenceReportJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  address?: string | null;
}

function toneColor(tone: 'success' | 'warning' | 'danger' | 'neutral'): [number, number, number] {
  return tone === 'success' ? SUCCESS : tone === 'warning' ? WARNING : tone === 'danger' ? DANGER : MUTED;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function payloadSummary(e: EvidenceEntry): string {
  const p = e.payload ?? {};
  const parts: string[] = [];
  if (e.kind === 'measurement' && p.label != null) {
    parts.push(`${String(p.label)}: ${String(p.value ?? '')} ${String(p.unit ?? '')}`.trim());
    if (p.phase) parts.push(`phase: ${String(p.phase)}`);
    if (p.in_range === true) parts.push('in range');
    if (p.in_range === false) parts.push('OUT OF RANGE');
  }
  if (e.kind === 'test') {
    parts.push(`${String(p.name ?? 'Test')}: ${p.passed === true ? 'PASSED' : 'FAILED'}`);
  }
  if (e.kind === 'part') {
    if (p.part_name) parts.push(String(p.part_name));
    if (p.quantity) parts.push(`qty ${String(p.quantity)}`);
    if (p.serial_number) parts.push(`serial ${String(p.serial_number)}`);
  }
  if (e.kind === 'approval' && p.method) parts.push(`method: ${String(p.method)}`);
  if (e.stage === 'result' && p.outcome) parts.push(`outcome: ${String(p.outcome).replace(/_/g, ' ')}`);
  if (p.replaces_part === true) parts.push('replaces a part');
  if (p.emergency === true) parts.push('emergency work');
  return parts.join(' · ');
}

export async function exportEvidenceChainPdf(input: {
  job: EvidenceReportJob;
  entries: EvidenceEntry[];
  report: ChainReport;
  businessName?: string | null;
}): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const { job, entries, report, businessName } = input;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const level = LEVEL_META[report.level];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const superseded = new Set(entries.map((e) => e.supersedes_id).filter((v): v is string => !!v));

  let y = 0;

  const footer = (page: number, total: number) => {
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Job ${job.id.slice(0, 8)} · Chain head ${shortHash(report.integrity.head_hash, 16)}`, M, PAGE_H - 24);
    doc.text(`Page ${page} of ${total}`, PAGE_W - M, PAGE_H - 24, { align: 'right' });
  };

  const ensure = (needed: number) => {
    if (y + needed > PAGE_H - 48) {
      doc.addPage();
      y = M;
    }
  };

  const write = (text: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number; gap?: number } = {}) => {
    const { size = 10, bold = false, color = INK, indent = 0, gap = 4 } = opts;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(text, CW - indent) as string[];
    for (const line of lines) {
      ensure(size + 4);
      doc.text(line, M + indent, y);
      y += size + 3;
    }
    y += gap;
  };

  // ---------- Header ----------
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_W, 6, 'F');
  y = 40;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...ACCENT);
  doc.text('VIREEK · JOB EVIDENCE CHAIN', M, y);
  y += 22;
  write('Evidence Chain Report', { size: 22, bold: true, gap: 6 });
  write(
    [businessName, job.customer_name, job.service_type, job.address].filter(Boolean).join(' · '),
    { size: 10, color: MUTED, gap: 10 },
  );

  // ---------- Summary ----------
  ensure(90);
  doc.setDrawColor(...LINE);
  doc.roundedRect(M, y, CW, 74, 6, 6);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(30);
  doc.setTextColor(...toneColor(level.tone));
  doc.text(String(report.score), M + 18, y + 46);
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('/ 100', M + 18 + doc.getTextWidth(String(report.score)) + 6, y + 46);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...toneColor(level.tone));
  doc.text(level.label, M + 150, y + 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  doc.text(
    report.integrity.valid
      ? `Integrity verified · ${report.integrity.entries} sealed entries`
      : `INTEGRITY FAILED at entry #${report.integrity.broken_seq} (${report.integrity.reason})`,
    M + 150,
    y + 47,
  );
  doc.setTextColor(...MUTED);
  doc.text(
    `${report.stats.system_verified} system-verified · ${report.stats.human_recorded} human-recorded · ${report.stats.media_files} media files`,
    M + 150,
    y + 62,
  );
  y += 96;

  // ---------- Stage table ----------
  write('Chain stages', { size: 12, bold: true, gap: 6 });
  for (const s of report.stages) {
    ensure(16);
    const color = s.status === 'complete' ? SUCCESS : s.status === 'missing' ? DANGER : MUTED;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...color);
    doc.text(s.status === 'complete' ? 'COMPLETE' : s.status === 'missing' ? 'MISSING' : 'N/A', M, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    doc.text(STAGE_META[s.stage].label, M + 70, y);
    doc.setTextColor(...MUTED);
    doc.text(`${s.count} entr${s.count === 1 ? 'y' : 'ies'}`, M + 210, y);
    y += 14;
  }
  y += 8;

  if (report.gaps.length > 0) {
    write('Open gaps', { size: 12, bold: true, gap: 4 });
    for (const g of report.gaps) {
      write(`${g.severity === 'blocking' ? '•' : '◦'} ${GAP_LABELS[g.key] ?? g.key}${g.severity === 'advisory' ? ' (advisory)' : ''}`, {
        size: 9,
        color: g.severity === 'blocking' ? DANGER : MUTED,
        gap: 1,
      });
    }
    y += 8;
  }

  // ---------- Timeline ----------
  write('Sealed timeline', { size: 12, bold: true, gap: 6 });
  for (const e of entries) {
    ensure(64);
    doc.setDrawColor(...LINE);
    doc.line(M, y - 4, M + CW, y - 4);
    const isSuperseded = superseded.has(e.id);
    const headColor = isSuperseded ? MUTED : INK;
    write(`#${e.seq}  ${STAGE_META[e.stage].label} · ${KIND_LABELS[e.kind]}${isSuperseded ? '  (superseded)' : ''}`, {
      size: 8,
      bold: true,
      color: ACCENT,
      gap: 1,
    });
    write(e.title, { size: 10, bold: true, color: headColor, gap: 1 });
    if (e.detail) write(e.detail, { size: 9, color: headColor, gap: 1 });
    const summary = payloadSummary(e);
    if (summary) write(summary, { size: 9, color: headColor, gap: 1 });
    if (e.refs.length > 0) {
      const because = e.refs
        .map((id) => byId.get(id))
        .filter((r): r is EvidenceEntry => !!r)
        .map((r) => `#${r.seq} ${r.title}`)
        .join('; ');
      write(`Because of: ${because}`, { size: 8, color: MUTED, gap: 1 });
    }
    if (e.supersedes_id && byId.get(e.supersedes_id)) {
      write(`Corrects entry #${byId.get(e.supersedes_id)!.seq}`, { size: 8, color: WARNING, gap: 1 });
    }
    for (const m of e.media) {
      write(`Media: ${m.name ?? m.path.split('/').pop()} · SHA-256 ${m.sha256.slice(0, 24)}…`, { size: 7.5, color: MUTED, gap: 0 });
    }
    write(
      `${e.actor_name ?? e.actor_type} (${e.actor_type}) · ${fmt(e.recorded_at)}${
        e.latitude != null && e.longitude != null ? ` · GPS ${e.latitude.toFixed(4)}, ${e.longitude.toFixed(4)}` : ''
      } · hash ${shortHash(e.entry_hash, 16)}`,
      { size: 7.5, color: MUTED, gap: 8 },
    );
  }

  // ---------- Verification block ----------
  ensure(90);
  y += 6;
  write('How to verify this report', { size: 11, bold: true, gap: 3 });
  write(
    'Every entry is sealed with a SHA-256 hash that includes the previous entry\'s hash, the server timestamp, the recorded identity and the fingerprint of every attached file. Entries cannot be edited or deleted; corrections are new entries that reference the original. Re-running the verification in Vireek must reproduce the chain head hash below.',
    { size: 8.5, color: MUTED, gap: 4 },
  );
  write(`Chain head hash: ${report.integrity.head_hash ?? '—'}`, { size: 8, bold: true, gap: 2 });
  write(`Generated: ${fmt(report.generated_at)}`, { size: 8, color: MUTED, gap: 0 });

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    footer(i, total);
  }

  doc.save(`evidence-chain-${job.id.slice(0, 8)}.pdf`);
}
