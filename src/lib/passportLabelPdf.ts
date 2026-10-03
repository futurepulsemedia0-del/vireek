/**
 * Equipment Passport label for PDFs (job evidence report / visit report).
 * Draws a crisp VECTOR QR code (no raster, prints and scans at any size) next to the machine identity,
 * so the paper copy the customer keeps leads straight to the machine's lifetime history.
 */

import QRCode from 'qrcode';
import { supabase } from '@/lib/supabase';
import { equipmentTitle, formatPassportCode, maskSerial, normalizePassportCode, passportUrl } from '@/lib/equipmentPassport';

export interface PdfPassport {
  code: string;
  title: string;
  equipmentType: string;
  serial: string | null;
}

interface RawLink {
  equipment_id: string;
  passport:
    | { public_code: string; make: string | null; model: string | null; equipment_type: string; serial_number: string | null }
    | { public_code: string; make: string | null; model: string | null; equipment_type: string; serial_number: string | null }[]
    | null;
}

/** Pure + tested: rows from equipment_passport_links -> unique, printable passports. */
export function toPdfPassports(rows: RawLink[]): PdfPassport[] {
  const seen = new Set<string>();
  const out: PdfPassport[] = [];
  for (const r of rows) {
    const p = Array.isArray(r.passport) ? r.passport[0] : r.passport;
    if (!p?.public_code) continue;
    const code = normalizePassportCode(p.public_code);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      title: equipmentTitle({ make: p.make, model: p.model, equipment_type: p.equipment_type }),
      equipmentType: p.equipment_type,
      serial: p.serial_number,
    });
  }
  return out;
}

/** Verified passports of the equipment linked to a job. Never throws (older DB / no equipment -> []). */
export async function fetchJobPassports(jobId: string): Promise<PdfPassport[]> {
  try {
    const { data: links } = await supabase.from('job_equipment').select('equipment_id').eq('job_id', jobId);
    const ids = ((links as { equipment_id: string }[] | null) ?? []).map((l) => l.equipment_id);
    if (ids.length === 0) return [];
    const { data } = await supabase
      .from('equipment_passport_links')
      .select('equipment_id, passport:passport_id (public_code, make, model, equipment_type, serial_number)')
      .in('equipment_id', ids)
      .eq('status', 'active')
      .eq('verified', true);
    return toPdfPassports((data as unknown as RawLink[]) ?? []);
  } catch {
    return [];
  }
}

// Minimal structural type so this file does not depend on jsPDF's types at import time.
interface PdfDoc {
  setFillColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setFont(name: string, style?: string): void;
  setFontSize(n: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string): void;
  text(text: string | string[], x: number, y: number, opts?: { align?: string }): void;
  splitTextToSize(text: string, width: number): string[];
  addPage(): void;
}

export interface PdfLayout {
  pageHeight: number;
  margin: number;
  contentWidth: number;
  bottomReserve?: number;
}

const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const ACCENT: [number, number, number] = [32, 58, 216];
const LINE: [number, number, number] = [225, 225, 232];
const QR_SIZE = 78;
const BOX_H = QR_SIZE + 28;

function drawQr(doc: PdfDoc, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
  const n: number = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, size, size, 'F');
  doc.setFillColor(11, 18, 32);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        // +0.25 overlap hides hairline seams between neighbouring modules in some PDF viewers
        doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.25, cell + 0.25, 'F');
      }
    }
  }
}

/**
 * Draws one labelled box per passport starting at `y` (adds pages as needed). Returns the new y.
 * Does nothing (returns y) when there are no passports.
 */
export function drawPassportLabels(doc: PdfDoc, y: number, passports: PdfPassport[], layout: PdfLayout, origin?: string): number {
  if (passports.length === 0) return y;
  const { pageHeight, margin, contentWidth } = layout;
  const limit = pageHeight - (layout.bottomReserve ?? 48);
  const textX = margin + QR_SIZE + 28;
  const textW = contentWidth - QR_SIZE - 44;

  const ensure = (needed: number) => {
    if (y + needed > limit) {
      doc.addPage();
      y = margin;
    }
  };

  ensure(36 + BOX_H);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text(passports.length === 1 ? 'Equipment passport' : 'Equipment passports', margin, y);
  y += 14;

  for (const p of passports) {
    ensure(BOX_H + 10);
    doc.setDrawColor(...LINE);
    doc.roundedRect(margin, y, contentWidth, BOX_H, 6, 6);

    drawQr(doc, passportUrl(p.code, origin), margin + 14, y + 14, QR_SIZE);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...ACCENT);
    doc.text('VIREEK EQUIPMENT PASSPORT', textX, y + 22);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...INK);
    const titleLines = doc.splitTextToSize(p.title, textW).slice(0, 2);
    doc.text(titleLines, textX, y + 38);
    const afterTitle = y + 38 + titleLines.length * 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(`${p.equipmentType}${p.serial ? ` · S/N ${p.serial}` : ''}`.slice(0, 90), textX, afterTitle - 2);

    doc.setFont('courier', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(formatPassportCode(p.code), textX, afterTitle + 14);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(
      doc.splitTextToSize('Scan to see the full service history of this machine — it stays with the machine, whoever services it.', textW),
      textX,
      afterTitle + 28,
    );

    y += BOX_H + 10;
  }
  return y + 4;
}

export { maskSerial };
