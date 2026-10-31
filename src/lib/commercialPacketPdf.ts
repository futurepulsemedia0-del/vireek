import type { jsPDF as JsPdfType } from 'jspdf';
import { supabase } from '@/lib/supabase';
import { buildInvoicePdf, type InvoicePdfInput } from '@/lib/invoicePdf';
import { formatCents } from '@/lib/invoices';
import type { CommercialApproval } from '@/lib/commercialCash';

// "Invoice packet": the existing invoice PDF + approval/PO page + completion photos + customer
// signature, in ONE PDF. Built in the browser with jsPDF (same approach as invoicePdf.ts).

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48;
const BOTTOM = PAGE_H - 64;
const MAX_PHOTOS = 8;

export interface PacketInput extends InvoicePdfInput {
  approval: CommercialApproval | null;
  jobId: string | null;
}

interface Loaded { dataUrl: string; format: 'JPEG' | 'PNG' | 'WEBP'; caption: string }

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '-';

function formatFor(mimeOrName: string): Loaded['format'] | null {
  const s = mimeOrName.toLowerCase();
  if (s.includes('png')) return 'PNG';
  if (s.includes('webp')) return 'WEBP';
  if (s.includes('jpeg') || s.includes('jpg')) return 'JPEG';
  return null;
}

async function toDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

async function loadFromBucket(bucket: string, path: string, caption: string, hint: string): Promise<Loaded | null> {
  const format = formatFor(hint);
  if (!format) return null;
  const { data: signed } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
  if (!signed?.signedUrl) return null;
  const res = await fetch(signed.signedUrl);
  if (!res.ok) return null;
  return { dataUrl: await toDataUrl(await res.blob()), format, caption };
}

export async function buildCommercialPacketPdf(input: PacketInput): Promise<{ doc: JsPdfType; notes: string[] }> {
  const notes: string[] = [];
  const doc = await buildInvoicePdf(input);
  const { invoice, businessName, approval, jobId } = input;
  let y = 0;
  const footer = (label: string) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(`${invoice.invoice_number} - ${label}`, M, PAGE_H - 36);
  };
  const newPage = (title: string) => {
    doc.addPage();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
    doc.text(title, M, 64);
    y = 92;
  };
  const row = (label: string, value: string) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text(label, M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(value || '-', PAGE_W - M * 2 - 140) as string[];
    doc.text(lines, M + 140, y);
    y += Math.max(16, lines.length * 13);
  };

  // --- Approval proof ---
  newPage('Customer approval');
  if (!approval) {
    row('Status', 'No PO / work-order approval is recorded for this invoice.');
    notes.push('No approval recorded.');
  } else {
    row('PO number', approval.po_number ?? '-');
    row('Work order', approval.work_order_number ?? '-');
    row('Approved amount (NTE)', formatCents(approval.approved_amount_cents));
    row('Invoice total', formatCents(input.ledger.totalCents));
    row('Approved by', approval.approved_by_name);
    row('Approved on', fmtDate(approval.approved_at));
    row('Source', approval.approval_source.replace(/_/g, ' '));
    row('Evidence reference', approval.evidence_ref ?? '-');
    row('Evidence file', approval.evidence_storage_path ? approval.evidence_storage_path.split('/').pop() ?? '' : '-');
    if (approval.evidence_storage_path) {
      const ev = await loadFromBucket('commercial-approvals', approval.evidence_storage_path, 'Approval evidence', approval.evidence_storage_path).catch(() => null);
      if (ev) {
        const p = doc.getImageProperties(ev.dataUrl);
        const maxW = Math.min(PAGE_W - M * 2, 420); const maxH = Math.max(40, BOTTOM - y - 20);
        const scale = Math.min(maxW / p.width, maxH / p.height);
        doc.addImage(ev.dataUrl, ev.format, M, y + 8, p.width * scale, p.height * scale);
      } else {
        y += 6;
        doc.setFontSize(9); doc.setTextColor(...MUTED);
        doc.text('The evidence file is not an image (e.g. PDF or e-mail) and is not embedded here; it stays on file under the reference above.', M, y, { maxWidth: PAGE_W - M * 2 });
        notes.push('Approval evidence is not an image, so it is referenced, not embedded.');
      }
    }
  }
  footer('Approval');

  // --- Completion proof ---
  newPage('Proof of completion');
  if (!jobId) {
    row('Status', 'No job is linked to this invoice.');
    notes.push('No job linked.');
  } else {
    const [{ data: job }, { data: photos }] = await Promise.all([
      supabase.from('jobs').select('customer_name, service_type, address, completion_notes, customer_signature_data_url, customer_signature_name, customer_signature_at').eq('id', jobId).maybeSingle(),
      supabase.from('job_photos').select('storage_path, mime_type, file_name, caption, taken_at').eq('job_id', jobId).eq('kind', 'after').order('taken_at').limit(MAX_PHOTOS),
    ]);
    if (job) {
      row('Service', (job.service_type as string | null) ?? '-');
      row('Address', (job.address as string | null) ?? '-');
      if (job.completion_notes) row('Completion notes', String(job.completion_notes));
    }
    let loaded = 0; let failed = 0; let x = M; let rowH = 0; const cell = 160;
    for (const ph of (photos ?? []) as { storage_path: string; mime_type: string | null; file_name: string; caption: string | null; taken_at: string }[]) {
      const img = await loadFromBucket('job-photos', ph.storage_path, ph.caption ?? ph.file_name, ph.mime_type ?? ph.file_name).catch(() => null);
      if (!img) { failed++; continue; }
      const p = doc.getImageProperties(img.dataUrl);
      const scale = Math.min(cell / p.width, cell / p.height);
      const w = p.width * scale; const h = p.height * scale;
      if (x + cell > PAGE_W - M) { x = M; y += rowH + 22; rowH = 0; }
      if (y + h > BOTTOM) { footer('Completion'); newPage('Proof of completion (continued)'); x = M; rowH = 0; }
      doc.addImage(img.dataUrl, img.format, x, y, w, h);
      doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(fmtDate(ph.taken_at), x, y + h + 10);
      x += cell + 12; rowH = Math.max(rowH, h); loaded++;
    }
    y += rowH + 28;
    if (loaded === 0) { row('Photos', 'No completion photos on file.'); }
    if (failed > 0) notes.push(`${failed} photo(s) could not be loaded and were left out.`);
    if (job?.customer_signature_data_url) {
      if (y + 110 > BOTTOM) { footer('Completion'); newPage('Customer signature'); }
      doc.setFontSize(9); doc.setTextColor(...MUTED); doc.text('Customer signature', M, y);
      try { doc.addImage(String(job.customer_signature_data_url), 'PNG', M, y + 6, 180, 70); } catch { notes.push('Signature image could not be embedded.'); }
      doc.setFontSize(9); doc.setTextColor(...INK);
      doc.text(`${job.customer_signature_name ?? ''}  ${job.customer_signature_at ? fmtDate(String(job.customer_signature_at)) : ''}`.trim(), M, y + 90);
    } else if (!loaded) {
      notes.push('No photo or signature found.');
    }
  }
  footer('Completion');
  void businessName;
  return { doc, notes };
}
