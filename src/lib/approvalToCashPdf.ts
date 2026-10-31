/**
 * Invoice packet (PDF): invoice + customer PO / approval + completion proof. Real vector text via jsPDF.
 * Facts come from invoice_packet_data() (DB-derived); nothing here computes money. The PDF is downloaded by a
 * person — Vireek never emails it automatically.
 */
import { jsPDF } from 'jspdf';
import { fmtCents } from '@/lib/approvalToCash';
import type { PacketData } from '@/lib/approvalToCash';

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const DANGER: [number, number, number] = [200, 55, 55];
const OK: [number, number, number] = [22, 130, 87];
const W = 595.28, H = 841.89, M = 48, CW = W - M * 2;

const d = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');

export function buildInvoicePacket(p: PacketData): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = M;
  const ensure = (n: number) => { if (y + n > H - 56) { doc.addPage(); y = M; } };
  const line = (s: string, size = 10, color: [number, number, number] = INK, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    for (const l of doc.splitTextToSize(s, CW) as string[]) { ensure(size + 4); doc.text(l, M, y + size); y += size + 4; }
  };
  const h = (s: string) => { y += 10; ensure(30); line(s, 13, INK, true); doc.setDrawColor(225, 225, 232); doc.line(M, y, W - M, y); y += 6; };
  const row = (k: string, v: string) => { ensure(16); doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED); doc.text(k, M, y + 10);
    doc.setTextColor(...INK); const ls = doc.splitTextToSize(v || '—', CW - 150) as string[]; ls.forEach((l, i) => doc.text(l, M + 150, y + 10 + i * 13)); y += Math.max(1, ls.length) * 13 + 3; };

  line(p.business_name || 'Invoice packet', 18, INK, true);
  line(`Invoice ${p.invoice.number ?? ''} · ${p.invoice.customer_name}`, 11, MUTED);
  line(`Generated ${d(p.generated_at)}`, 9, MUTED);

  const blocks = p.gate.findings.filter((f) => f.severity === 'block');
  const warns = p.gate.findings.filter((f) => f.severity === 'warn');
  if (blocks.length || warns.length) {
    h('Items to resolve before sending');
    [...blocks, ...warns].forEach((f) => line(`• ${f.severity === 'block' ? 'BLOCKED' : 'Warning'}: ${f.message}`, 10, f.severity === 'block' ? DANGER : MUTED));
  }

  h('1. Invoice');
  row('Issued', d(p.invoice.sent_at)); row('Due', d(p.invoice.due_date));
  p.invoice.line_items.forEach((li) => row(`${li.quantity} × ${li.description}`, fmtCents(Math.round(li.quantity * li.unit_price_cents))));
  if (p.invoice.tax_percent) row('Tax', `${p.invoice.tax_percent}%`);
  row('Total', fmtCents(p.invoice.total_cents)); row('Paid', fmtCents(p.invoice.paid_cents)); row('Balance due', fmtCents(p.invoice.balance_cents));

  h('2. Customer PO and approval');
  if (!p.work_order) line('No customer work order / PO is linked to this invoice.', 10, DANGER);
  else {
    const w = p.work_order;
    row('Work order', `${w.number ?? '—'} — ${w.title}`); row('Customer PO #', w.po_number ?? 'NOT PROVIDED');
    row('Not-to-exceed', w.not_to_exceed_cents != null ? fmtCents(w.not_to_exceed_cents) : 'None set');
    row('Approval status', w.approval_status); row('Approved by', w.approver_name ?? '—'); row('Approved on', d(w.approved_at));
    if (w.approval_notes) row('Approval notes', w.approval_notes);
    if (w.site_name || w.site_address) row('Site', [w.site_name, w.site_address].filter(Boolean).join(', '));
  }

  h('3. Completion proof');
  if (!p.completed_visits.length && !p.evidence.length) line('No completion proof is on file.', 10, DANGER);
  p.completed_visits.forEach((v) => row(`Visit ${v.visit_number ?? ''} completed`, `${d(v.completed_at)}${v.notes ? ' — ' + v.notes : ''}`));
  p.evidence.forEach((e) => row(`${e.stage} · ${d(e.recorded_at)}`, `${e.title}${e.actor_name ? ' (' + e.actor_name + ')' : ''}${e.media_count ? ` · ${e.media_count} media file(s) on record` : ''}`));
  if (p.evidence.length) line('Media files are listed by count; they are not embedded in this packet.', 8, MUTED);

  if (p.ap) { h('4. Invoice status'); row('Customer-side state', p.ap.state); if (p.ap.rejection_reason) row('Rejection reason', p.ap.rejection_reason); }
  if (p.gate.ok && !blocks.length) { ensure(20); line('All approval checks passed.', 9, OK); }
  return doc;
}
