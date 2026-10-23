/**
 * Printable sheet of Vireek Tags. Vector QR (no raster), real label-stock presets, partial-sheet restart.
 * Pure layout maths + a drawing function that only needs a structural subset of jsPDF (easy to test).
 */

import QRCode from 'qrcode';
import { formatTagToken, tagUrl } from '@/lib/vireekTag';

export type SheetPresetId = 'a4_24' | 'letter_30' | 'a4_8';

export interface SheetPreset {
  id: SheetPresetId;
  name: string;
  pageW: number; pageH: number;            // mm
  cols: number; rows: number;
  labelW: number; labelH: number;          // mm
  marginLeft: number; marginTop: number;   // mm
  pitchX: number; pitchY: number;          // mm (label + gap)
}

export const SHEET_PRESETS: Record<SheetPresetId, SheetPreset> = {
  a4_24: { id: 'a4_24', name: 'A4 · 24 labels (63.5 × 33.9 mm, Avery L7159)', pageW: 210, pageH: 297, cols: 3, rows: 8, labelW: 63.5, labelH: 33.9, marginLeft: 7.2, marginTop: 13.1, pitchX: 66.0, pitchY: 33.9 },
  letter_30: { id: 'letter_30', name: 'US Letter · 30 labels (66.7 × 25.4 mm, Avery 5160)', pageW: 215.9, pageH: 279.4, cols: 3, rows: 10, labelW: 66.7, labelH: 25.4, marginLeft: 4.8, marginTop: 12.7, pitchX: 69.85, pitchY: 25.4 },
  a4_8: { id: 'a4_8', name: 'A4 · 8 large labels (99.1 × 67.7 mm, Avery L7165)', pageW: 210, pageH: 297, cols: 2, rows: 4, labelW: 99.1, labelH: 67.7, marginLeft: 4.65, marginTop: 13.1, pitchX: 101.6, pitchY: 67.7 },
};

export interface PrintableTag { token: string; caption?: string }

export const labelsPerSheet = (p: SheetPreset): number => p.cols * p.rows;

export function slotRect(p: SheetPreset, slot: number): { x: number; y: number; w: number; h: number } {
  const col = slot % p.cols;
  const row = Math.floor(slot / p.cols) % p.rows;
  return { x: p.marginLeft + col * p.pitchX, y: p.marginTop + row * p.pitchY, w: p.labelW, h: p.labelH };
}

/** Splits tags into pages. `startSlot` lets you reuse a half-used sheet (0-based slot on the first page). */
export function paginateTags<T>(items: T[], p: SheetPreset, startSlot = 0): { slot: number; item: T }[][] {
  const per = labelsPerSheet(p);
  const start = Math.max(0, Math.min(per - 1, Math.floor(startSlot)));
  const pages: { slot: number; item: T }[][] = [];
  let slot = start;
  let page: { slot: number; item: T }[] = [];
  for (const item of items) {
    if (slot >= per) { pages.push(page); page = []; slot = 0; }
    page.push({ slot, item });
    slot += 1;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

// Minimal structural jsPDF subset.
export interface TagPdfDoc {
  setFillColor(r: number, g: number, b: number): void;
  setDrawColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setLineWidth(w: number): void;
  setFont(name: string, style?: string): void;
  setFontSize(n: number): void;
  rect(x: number, y: number, w: number, h: number, style?: string): void;
  roundedRect(x: number, y: number, w: number, h: number, rx: number, ry: number, style?: string): void;
  text(text: string | string[], x: number, y: number, opts?: { align?: string }): void;
  splitTextToSize(text: string, width: number): string[];
  addPage(): void;
}

export interface SheetOptions {
  preset: SheetPresetId;
  startSlot?: number;
  origin?: string;
  businessName?: string;
  /** Draw a hairline outline per label (useful on plain paper; leave off for pre-cut stock). */
  outline?: boolean;
}

const INK: [number, number, number] = [11, 18, 32];
const MUTED: [number, number, number] = [90, 98, 112];
const ACCENT: [number, number, number] = [32, 58, 216];
const LINE: [number, number, number] = [190, 196, 208];

function drawQr(doc: TagPdfDoc, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' });
  const n: number = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.setFillColor(255, 255, 255);
  doc.rect(x, y, size, size, 'F');
  doc.setFillColor(...INK);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) doc.rect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell + 0.02, cell + 0.02, 'F');
    }
  }
}

export function drawTagLabel(doc: TagPdfDoc, tag: PrintableTag, box: { x: number; y: number; w: number; h: number }, opts: SheetOptions): void {
  const { x, y, w, h } = box;
  const k = Math.min(1.6, Math.max(0.8, h / 30));
  const pad = 2.2 * k;
  const qr = Math.min(h - pad * 2, w * 0.46);
  if (opts.outline) {
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.15);
    doc.roundedRect(x + 0.4, y + 0.4, w - 0.8, h - 0.8, 1.5, 1.5, 'S');
  }
  drawQr(doc, tagUrl(tag.token, 'qr', opts.origin), x + pad, y + (h - qr) / 2, qr);

  const tx = x + pad + qr + 2.4 * k;
  const tw = x + w - pad - tx;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5 * k);
  doc.setTextColor(...ACCENT);
  doc.text('VIREEK TAG', tx, y + pad + 2.2 * k);

  doc.setFontSize(7.5 * k);
  doc.setTextColor(...INK);
  const head = doc.splitTextToSize('Scan for service, manual & warranty', tw).slice(0, 2);
  doc.text(head, tx, y + pad + 6.2 * k);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(5.6 * k);
  doc.setTextColor(...MUTED);
  let lineY = y + pad + 6.2 * k + head.length * 3.1 * k + 0.6 * k;
  if (tag.caption) {
    doc.text(doc.splitTextToSize(tag.caption, tw).slice(0, 1), tx, lineY);
    lineY += 2.8 * k;
  }
  if (opts.businessName) doc.text(doc.splitTextToSize(opts.businessName, tw).slice(0, 1), tx, lineY);

  doc.setFont('courier', 'bold');
  doc.setFontSize(6 * k);
  doc.setTextColor(...INK);
  doc.text(formatTagToken(tag.token), tx, y + h - pad);
}

/** Draws every page; returns the number of pages used. */
export function drawTagSheet(doc: TagPdfDoc, tags: PrintableTag[], opts: SheetOptions): number {
  const preset = SHEET_PRESETS[opts.preset];
  const pages = paginateTags(tags, preset, opts.startSlot ?? 0);
  pages.forEach((page, i) => {
    if (i > 0) doc.addPage();
    for (const { slot, item } of page) drawTagLabel(doc, item, slotRect(preset, slot), opts);
  });
  return pages.length;
}

export async function downloadTagSheetPdf(tags: PrintableTag[], opts: SheetOptions, filename = 'vireek-tags.pdf'): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const p = SHEET_PRESETS[opts.preset];
  const doc = new jsPDF({ unit: 'mm', format: [p.pageW, p.pageH], orientation: 'portrait' });
  drawTagSheet(doc as unknown as TagPdfDoc, tags, opts);
  doc.save(filename);
}
