/**
 * Evidence packet (PDF) for ONE closeout step. Real vector text via jsPDF (no DOM screenshots).
 * Missing required items are flagged in red BEFORE anything is filed. The packet is a worksheet for a
 * person to review and submit — nothing is sent anywhere automatically.
 */
import { jsPDF } from 'jspdf';
import { supabase } from '@/lib/supabase';
import {
  EVIDENCE_LABELS, RULES_DISCLAIMER, STATUS_LABELS, STEP_LABELS, ELIGIBILITY_LABELS, PRE_APPROVAL_LABELS,
  missingEvidence, safeHttpUrl,
  type CloseoutProgram, type CloseoutStep, type CloseoutEvidence,
} from '@/lib/installCloseout';

const ACCENT: [number, number, number] = [32, 58, 216];
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const DANGER: [number, number, number] = [200, 55, 55];
const OK: [number, number, number] = [22, 130, 87];
const LINE: [number, number, number] = [225, 225, 232];
const W = 595.28;
const H = 841.89;
const M = 48;
const CW = W - M * 2;

export interface PacketInput {
  step: CloseoutStep;
  program: CloseoutProgram | null;
  evidence: CloseoutEvidence[];
  customerName: string;
  address: string | null;
  installDate: string | null;
  photoNames: Record<string, string>;
  documentTitles: Record<string, string>;
  /** Up to a handful of already-resolved thumbnails (data URLs) keyed by job_photo_id. */
  photoImages?: Record<string, string>;
}

export function buildEvidencePacket(input: PacketInput): jsPDF {
  const { step, program, evidence, customerName, address, installDate } = input;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 0;

  const ensure = (need: number) => {
    if (y + need > H - 60) { doc.addPage(); y = M; }
  };
  const text = (s: string, size = 10, color: [number, number, number] = INK, bold = false, x = M, width = CW) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(s, width) as string[];
    for (const l of lines) { ensure(size + 4); doc.text(l, x, y); y += size + 4; }
  };

  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 6, 'F');
  y = 40;
  text('INSTALL CLOSEOUT — EVIDENCE PACKET', 9, MUTED, true);
  text(`${STEP_LABELS[step.step_key]}${program ? ` · ${program.name}` : ''}`, 18, INK, true);
  y += 4;
  text(`${customerName}${address ? ` — ${address}` : ''}`, 10, MUTED);
  text(`Generated ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} · Status: ${STATUS_LABELS[step.status]}`, 9, MUTED);
  y += 8;

  const kv = (k: string, v: string | null | undefined) => {
    ensure(16);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
    doc.text(k, M, y);
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(v || '—', CW - 150) as string[];
    doc.text(lines, M + 150, y);
    y += Math.max(14, lines.length * 12);
  };
  kv('Install date', installDate);
  kv('Deadline', step.deadline_on);
  kv('Administrator', program?.administrator);
  kv('Reference / confirmation', step.reference_number);
  kv('Pre-approval', `${PRE_APPROVAL_LABELS[step.pre_approval_status]}${step.pre_approval_reference ? ` (${step.pre_approval_reference})` : ''}`);
  if (step.step_key === 'rebate') kv('Eligibility', ELIGIBILITY_LABELS[step.eligibility]);
  const src = safeHttpUrl(program?.source_url);
  kv('Rule source', src);
  kv('Rule last verified', program?.last_verified_on);
  y += 6;

  // Missing items first — this is the point of the packet.
  const required = program?.required_evidence ?? [];
  const missing = missingEvidence(required, evidence);
  doc.setDrawColor(...LINE); doc.line(M, y, W - M, y); y += 14;
  if (!program) {
    text('No rule is attached to this step, so required documents and the deadline are unknown.', 10, DANGER, true);
  } else if (missing.length) {
    text(`MISSING (${missing.length}) — do not file until these are added:`, 11, DANGER, true);
    for (const k of missing) text(`•  ${EVIDENCE_LABELS[k as keyof typeof EVIDENCE_LABELS] ?? k}`, 10, DANGER, false, M + 8);
  } else {
    text('All required items are attached.', 11, OK, true);
  }
  y += 8;

  if ((program?.enrollment_requirements ?? []).length) {
    text('Enrollment requirements (verify with the administrator)', 11, INK, true);
    for (const r of program!.enrollment_requirements) text(`•  ${r}`, 10, INK, false, M + 8);
    y += 6;
  }

  text('Attached evidence', 11, INK, true);
  y += 2;
  if (evidence.length === 0) text('Nothing attached yet.', 10, MUTED);
  for (const e of evidence) {
    const kind = EVIDENCE_LABELS[e.kind] ?? e.kind;
    let detail = e.value ?? '';
    if (e.job_photo_id) detail = `Job photo: ${input.photoNames[e.job_photo_id] ?? e.job_photo_id}`;
    if (e.document_id) detail = `Document: ${input.documentTitles[e.document_id] ?? e.document_id}`;
    const ok = (e.value ?? '').trim() !== '' || e.job_photo_id || e.document_id;
    text(`${ok ? '✓' : '✗'} ${kind}${e.label ? ` (${e.label})` : ''}: ${detail || 'EMPTY'}`.replace('✓', '[x]').replace('✗', '[ ]'),
      10, ok ? INK : DANGER, false, M + 4);
  }

  const imgs = Object.entries(input.photoImages ?? {}).slice(0, 6);
  if (imgs.length) {
    y += 8;
    text('Photos', 11, INK, true);
    let x = M;
    const size = 150;
    for (const [, data] of imgs) {
      if (x + size > W - M) { x = M; y += size + 8; }
      ensure(size + 8);
      try { doc.addImage(data, 'JPEG', x, y, size, size * 0.75); } catch { /* skip unreadable image */ }
      x += size + 10;
    }
    y += size * 0.75 + 12;
  }

  ensure(60);
  y += 10;
  doc.setDrawColor(...LINE); doc.line(M, y, W - M, y); y += 12;
  text(RULES_DISCLAIMER, 8, MUTED);
  text(`This packet is a worksheet. Nothing has been submitted to any manufacturer, utility or government portal by ${getPdfBrand().productName}.`, 8, MUTED);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(...MUTED);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 24, { align: 'right' });
  }
  return doc;
}

/** Fetch + downscale up to `max` job photos to small JPEG data URLs. Failures are skipped silently. */
export async function loadPhotoThumbnails(
  photos: { id: string; storage_path: string }[], max = 6, bucket = 'job-photos',
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of photos.slice(0, max)) {
    try {
      const { data } = await supabase.storage.from(bucket).createSignedUrl(p.storage_path, 120);
      if (!data?.signedUrl) continue;
      const blob = await (await fetch(data.signedUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, 640 / bmp.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      out[p.id] = canvas.toDataURL('image/jpeg', 0.72);
    } catch { /* ignore a photo we cannot load */ }
  }
  return out;
}

export function downloadEvidencePacket(input: PacketInput, fileName: string): void {
  buildEvidencePacket(input).save(fileName.replace(/[^\w.-]+/g, '_'));
}
