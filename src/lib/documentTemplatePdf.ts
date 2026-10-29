import type { jsPDF as JsPdfType } from 'jspdf';
import { formatCents } from '@/lib/quotes';
import {
  DOC_TYPE_LABELS,
  computeTotals,
  formatDocDate,
  hexToRgb,
  isNumericLike,
  pdfSafeText,
  tint,
  visibleSections,
  type DocumentDesign,
  type RenderData,
  type RenderReport,
  type RenderTone,
} from '@/lib/documentTemplates';

/**
 * Renders a DocumentDesign + RenderData to a PDF.
 *
 * Same approach as src/lib/invoicePdf.ts: manual vector layout with jsPDF (real text, tiny files, no DOM
 * screenshotting). jsPDF is imported on demand so it never lands in the main dashboard bundle.
 *
 * Built-in PDF fonts only cover Latin-1, so every string goes through pdfSafeText() (unsupported
 * characters become "?"; the editor warns about them up front).
 */

type RGB = [number, number, number];

const LINE: RGB = [225, 225, 232];
const ZEBRA: RGB = [247, 247, 250];
const PAD = 8;

export function templatePdfFilename(docType: RenderData['docType'], documentNumber: string): string {
  const base = (documentNumber || DOC_TYPE_LABELS[docType]).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || DOC_TYPE_LABELS[docType]}.pdf`;
}

/**
 * Loads a (public) logo URL and converts it to a PNG data URL jsPDF can embed (handles PNG/JPEG/WebP).
 * Returns null on any failure (CORS, offline, SVG, corrupt) so a logo problem never blocks a PDF.
 */
export async function loadLogoDataUrl(url: string | null, maxPx = 480): Promise<string | null> {
  if (!url || typeof document === 'undefined') return null;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return null;
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Logo could not be decoded.'));
        el.src = objectUrl;
      });
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      if (nw < 1 || nh < 1) return null;
      const scale = Math.min(1, maxPx / nw);
      const w = Math.max(1, Math.round(nw * scale));
      const h = Math.max(1, Math.round(nh * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

interface Col {
  label: string;
  w: number;
  align: 'left' | 'right';
}

export async function buildTemplatePdf(design: DocumentDesign, data: RenderData): Promise<JsPdfType> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: design.page.size, orientation: 'portrait' });

  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = design.page.margin;
  const R = W - M;
  const CW = W - M * 2;

  const primary = hexToRgb(design.theme.primary) as RGB;
  const accent = hexToRgb(design.theme.accent) as RGB;
  const ink = hexToRgb(design.theme.text) as RGB;
  const muted = hexToRgb(design.theme.muted) as RGB;
  const font = design.theme.font;
  const base = design.theme.baseSize;
  const lh = base * 1.4;
  const S = (s: string | null | undefined) => pdfSafeText(s);
  const money = (cents: number) => S(formatCents(cents, data.currency));

  const setFont = (style: 'normal' | 'bold', size: number, color: RGB) => {
    doc.setFont(font, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  /** Ellipsizes a single line so it never overflows `width`. */
  const fit = (text: string, width: number): string => {
    const t = S(text);
    if (doc.getTextWidth(t) <= width) return t;
    let out = t;
    while (out.length > 1 && doc.getTextWidth(`${out}…`) > width) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  };

  // ---- Footer geometry (reserved on every page) ----
  const footerLines: string[] = (() => {
    if (!design.footer.text.trim()) return [];
    doc.setFont(font, 'normal');
    doc.setFontSize(Math.max(7, base - 2));
    return (doc.splitTextToSize(S(design.footer.text), CW * 0.62) as string[]).slice(0, 4);
  })();
  const footerBlockH = Math.max(26, 16 + footerLines.length * 10);
  const footerTop = H - M - footerBlockH + 8;
  const bottomLimit = footerTop - 14;

  let y = M;

  const topBar = () => {
    if (design.header.accentBar !== 'none') {
      doc.setFillColor(...primary);
      doc.rect(0, 0, W, 6, 'F');
    }
  };
  const newPage = () => {
    doc.addPage();
    topBar();
    y = M;
  };
  const ensure = (needed: number) => {
    if (y + needed > bottomLimit) newPage();
  };

  // ============================================================
  // HEADER
  // ============================================================
  const band = design.header.accentBar === 'band';
  const brandRight = design.header.logoAlign === 'right';
  const onBandText: RGB = [255, 255, 255];
  const onBandMuted: RGB = tint(design.theme.primary, 0.78);

  // Brand block content
  let logoW = 0;
  let logoH = 0;
  const logo = design.header.showLogo ? data.business.logoDataUrl : null;
  if (logo) {
    try {
      const props = doc.getImageProperties(logo);
      const k = Math.min(150 / props.width, 46 / props.height);
      logoW = props.width * k;
      logoH = props.height * k;
    } catch {
      logoW = 0;
      logoH = 0;
    }
  }
  const brandLines: { text: string; size: number; style: 'normal' | 'bold'; color: RGB }[] = [];
  if (design.header.showBusinessName && data.business.name.trim()) {
    brandLines.push({ text: data.business.name, size: base + 5, style: 'bold', color: band ? onBandText : ink });
  }
  if (design.header.tagline) brandLines.push({ text: design.header.tagline, size: base, style: 'normal', color: band ? onBandMuted : muted });
  if (design.header.showBusinessContact) {
    for (const l of data.business.lines.slice(0, 4)) {
      if (l.trim()) brandLines.push({ text: l, size: base - 1, style: 'normal', color: band ? onBandMuted : muted });
    }
  }
  const brandTextH = brandLines.reduce((h, l) => h + l.size * 1.3, 0);
  const brandH = (logoH ? logoH + (brandTextH ? 8 : 0) : 0) + brandTextH;

  const titleLines: { text: string; size: number; style: 'normal' | 'bold'; color: RGB }[] = [];
  if (design.header.title.trim()) titleLines.push({ text: design.header.title, size: 24, style: 'bold', color: band ? onBandText : primary });
  if (data.documentNumber) titleLines.push({ text: data.documentNumber, size: base + 1, style: 'normal', color: band ? onBandMuted : muted });
  if (data.docType === 'report' && data.issueDate) {
    titleLines.push({ text: formatDocDate(data.issueDate), size: base, style: 'normal', color: band ? onBandMuted : muted });
  }
  if (data.stamp?.text) {
    const tone: Record<RenderTone, RGB> = { success: [22, 130, 87], danger: [200, 55, 55], primary };
    titleLines.push({ text: data.stamp.text, size: base + 1, style: 'bold', color: band ? onBandText : tone[data.stamp.tone] });
  }
  const titleH = titleLines.reduce((h, l) => h + l.size * 1.3, 0);
  const blockH = Math.max(brandH, titleH);

  const padTop = band ? 28 : M;
  if (band) {
    doc.setFillColor(...primary);
    doc.rect(0, 0, W, padTop + blockH + 22, 'F');
  } else {
    topBar();
  }

  // Brand (logo + text) on its side
  {
    const x = brandRight ? R : M;
    const align = brandRight ? 'right' : 'left';
    let by = padTop;
    if (logo && logoW > 0) {
      try {
        doc.addImage(logo, 'PNG', brandRight ? R - logoW : M, by, logoW, logoH);
        by += logoH + (brandTextH ? 8 : 0);
      } catch {
        /* a bad logo must never block the PDF */
      }
    }
    for (const l of brandLines) {
      by += l.size * 1.05;
      setFont(l.style, l.size, l.color);
      doc.text(fit(l.text, CW * 0.55), x, by, { align });
      by += l.size * 0.25;
    }
  }
  // Title on the opposite side
  {
    const x = brandRight ? M : R;
    const align = brandRight ? 'left' : 'right';
    let ty = padTop;
    for (const l of titleLines) {
      ty += l.size * 1.05;
      setFont(l.style, l.size, l.color);
      doc.text(fit(l.text, CW * 0.42), x, ty, { align });
      ty += l.size * 0.25;
    }
  }

  y = band ? padTop + blockH + 22 + 24 : padTop + blockH + 16;
  if (!band) {
    doc.setDrawColor(...LINE);
    doc.setLineWidth(1);
    doc.line(M, y, R, y);
    y += 22;
  }

  // ============================================================
  // BUILDING BLOCKS
  // ============================================================
  const gap = () => {
    y += 16;
  };

  const label = (text: string) => {
    ensure(28);
    setFont('bold', base - 1, primary);
    doc.text(S(text), M, y);
    y += 14;
  };

  const paragraph = (text: string, size = base, color: RGB = ink) => {
    setFont('normal', size, color);
    const lines = doc.splitTextToSize(S(text), CW) as string[];
    for (const line of lines) {
      ensure(size * 1.4);
      setFont('normal', size, color);
      doc.text(line, M, y);
      y += size * 1.4;
    }
  };

  const drawTable = (cols: Col[], rows: string[][]) => {
    const xs: number[] = [];
    let cx = M;
    for (const c of cols) {
      xs.push(cx);
      cx += c.w;
    }
    const headerH = 24;
    const drawHead = () => {
      ensure(headerH + 24);
      if (design.table.headerStyle === 'filled') {
        doc.setFillColor(...tint(design.theme.primary, 0.9));
        doc.rect(M, y, CW, headerH, 'F');
        setFont('bold', base - 1, primary);
      } else {
        setFont('bold', base - 1, muted);
      }
      cols.forEach((c, i) => {
        const tx = c.align === 'right' ? xs[i] + c.w - PAD : xs[i] + PAD;
        doc.text(fit(c.label, c.w - PAD * 2), tx, y + 15, { align: c.align });
      });
      if (design.table.headerStyle === 'underline') {
        doc.setDrawColor(...primary);
        doc.setLineWidth(1);
        doc.line(M, y + headerH, R, y + headerH);
      }
      y += headerH;
    };
    drawHead();

    if (rows.length === 0) {
      ensure(30);
      setFont('normal', base, muted);
      doc.text('Nothing to show.', M + PAD, y + 18);
      y += 30;
      return;
    }

    rows.forEach((row, ri) => {
      setFont('normal', base, ink);
      const cells = row.map((cell, i) => (doc.splitTextToSize(S(cell) || '—', cols[i].w - PAD * 2) as string[]).slice(0, 8));
      const rowH = Math.max(22, Math.max(...cells.map((l) => l.length)) * lh + 10);
      if (y + rowH > bottomLimit) {
        newPage();
        drawHead();
      }
      if (design.table.zebra && ri % 2 === 1) {
        doc.setFillColor(...ZEBRA);
        doc.rect(M, y, CW, rowH, 'F');
      }
      setFont('normal', base, ink);
      cells.forEach((lines, i) => {
        const c = cols[i];
        const tx = c.align === 'right' ? xs[i] + c.w - PAD : xs[i] + PAD;
        doc.text(lines, tx, y + 6 + base, { align: c.align, lineHeightFactor: 1.4 });
      });
      y += rowH;
      if (!design.table.zebra) {
        doc.setDrawColor(...LINE);
        doc.setLineWidth(0.5);
        doc.line(M, y, R, y);
      }
    });
    y += 6;
  };

  // ============================================================
  // SECTIONS
  // ============================================================
  const renderCustomer = () => {
    const issueLabel = data.docType === 'invoice' ? 'Issued' : 'Date';
    const h = 22 + Math.min(data.customer.lines.length, 4) * (base * 1.35) + 8;
    ensure(h);
    const top = y;
    setFont('bold', base - 1.5, muted);
    doc.text(data.docType === 'invoice' ? 'Bill to' : 'Prepared for', M, top);
    setFont('bold', base + 1, ink);
    doc.text(fit(data.customer.name || '—', CW * 0.5), M, top + 16);
    setFont('normal', base - 0.5, muted);
    let cy = top + 16;
    for (const l of data.customer.lines.slice(0, 4)) {
      cy += base * 1.35;
      doc.text(fit(l, CW * 0.5), M, cy);
    }
    const dx1 = M + CW * 0.58;
    const dx2 = M + CW * 0.8;
    setFont('bold', base - 1.5, muted);
    doc.text(S(issueLabel), dx1, top);
    if (data.secondaryDateLabel) doc.text(S(data.secondaryDateLabel), dx2, top);
    setFont('normal', base, ink);
    doc.text(fit(formatDocDate(data.issueDate), CW * 0.2 - 4), dx1, top + 16);
    if (data.secondaryDateLabel) doc.text(fit(formatDocDate(data.secondaryDate), CW * 0.2 - 4), dx2, top + 16);
    y = Math.max(cy, top + 16) + 10;
  };

  const renderItems = () => {
    if (data.docType === 'report') {
      const rep: RenderReport | null = data.report;
      if (!rep || rep.columns.length === 0) return;
      const cols = rep.columns.slice(0, 8);
      const weights = cols.map((_, i) => (i === 0 ? 2 : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      const colDefs: Col[] = cols.map((c, i) => ({
        label: c,
        w: (CW * weights[i]) / total,
        align: i > 0 && rep.rows.length > 0 && rep.rows.every((r) => isNumericLike(r[i] ?? '')) ? 'right' : 'left',
      }));
      drawTable(
        colDefs,
        rep.rows.slice(0, 500).map((r) => cols.map((_, i) => r[i] ?? '')),
      );
      return;
    }
    const t = design.table;
    const amountW = 92;
    const unitW = t.showUnitPrice ? 88 : 0;
    const qtyW = t.showQty ? 56 : 0;
    const cols: Col[] = [{ label: t.descriptionLabel, w: CW - amountW - unitW - qtyW, align: 'left' }];
    if (t.showQty) cols.push({ label: t.qtyLabel, w: qtyW, align: 'right' });
    if (t.showUnitPrice) cols.push({ label: t.unitLabel, w: unitW, align: 'right' });
    cols.push({ label: t.amountLabel, w: amountW, align: 'right' });
    const rows = data.lineItems.slice(0, 500).map((li) => {
      const q = Number(li.quantity) || 0;
      const u = Number(li.unit_price_cents) || 0;
      const row = [li.description];
      if (t.showQty) row.push(q.toLocaleString('en-US', { maximumFractionDigits: 2 }));
      if (t.showUnitPrice) row.push(money(u));
      row.push(money(Math.round(q * u)));
      return row;
    });
    drawTable(cols, rows);
  };

  const renderTotals = () => {
    if (data.docType === 'report') return;
    const tot = computeTotals(data.lineItems, data.taxPercent, data.discountCents, data.taxCentsOverride);
    const rows: { label: string; value: string }[] = [];
    if (design.totals.showSubtotal) rows.push({ label: 'Subtotal', value: money(tot.subtotalCents) });
    if (design.totals.showDiscount && tot.discountCents > 0) rows.push({ label: 'Discount', value: `-${money(tot.discountCents)}` });
    if (design.totals.showTax && (tot.taxCents > 0 || data.taxPercent > 0)) {
      const pct = data.taxPercent > 0 ? ` (${data.taxPercent}%)` : '';
      rows.push({ label: `Tax${pct}`, value: money(tot.taxCents) });
    }
    ensure(rows.length * (lh + 3) + 40);
    const bw = Math.min(230, CW);
    const x0 = R - bw;
    for (const r of rows) {
      setFont('normal', base, ink);
      doc.text(S(r.label), x0, y + base);
      doc.text(S(r.value), R - PAD, y + base, { align: 'right' });
      y += lh + 3;
    }
    y += 2;
    doc.setDrawColor(...primary);
    doc.setLineWidth(1.2);
    doc.line(x0, y, R, y);
    y += 8;
    setFont('bold', base + 2, ink);
    doc.text(fit(design.totals.totalLabel, bw * 0.5), x0, y + base + 2);
    setFont('bold', base + 3, primary);
    doc.text(S(money(tot.totalCents)), R - PAD, y + base + 2, { align: 'right' });
    y += base + 12;
    const toneColor: Record<RenderTone, RGB> = { success: [22, 130, 87], danger: [200, 55, 55], primary };
    for (const r of data.extraTotals ?? []) {
      ensure(lh + 6);
      setFont(r.bold ? 'bold' : 'normal', r.bold ? base + 1 : base, toneColor[r.tone ?? 'primary'] ?? ink);
      doc.text(fit(r.label, bw * 0.55), x0, y + base);
      doc.text(S(r.value), R - PAD, y + base, { align: 'right' });
      y += lh + 3;
    }
  };

  const renderSummary = () => {
    const rep = data.report;
    if (!rep) return;
    setFont('bold', base + 5, primary);
    ensure(base * 5);
    doc.text(fit(rep.title, CW), M, y + base + 3);
    y += base + 10;
    if (rep.period) {
      setFont('normal', base, muted);
      doc.text(fit(rep.period, CW), M, y + base - 2);
      y += base + 8;
    }
    if (rep.summary.trim()) paragraph(rep.summary);
  };

  const renderMetrics = () => {
    const metrics = data.report?.metrics.slice(0, 12) ?? [];
    if (metrics.length === 0) return;
    const perRow = Math.min(4, metrics.length);
    const g = 10;
    const bw = (CW - g * (perRow - 1)) / perRow;
    const bh = 50;
    metrics.forEach((m, i) => {
      const col = i % perRow;
      if (col === 0) ensure(bh + g);
      const x = M + col * (bw + g);
      doc.setFillColor(...tint(design.theme.primary, 0.93));
      doc.rect(x, y, bw, bh, 'F');
      doc.setFillColor(...accent);
      doc.rect(x, y, 3, bh, 'F');
      setFont('bold', base + 6, primary);
      doc.text(fit(m.value, bw - 20), x + 12, y + 24);
      setFont('normal', base - 1, muted);
      doc.text(fit(m.label, bw - 20), x + 12, y + 40);
      if (col === perRow - 1 || i === metrics.length - 1) y += bh + g;
    });
  };

  const renderSignature = () => {
    ensure(86);
    y += 28;
    doc.setDrawColor(...ink);
    doc.setLineWidth(0.7);
    doc.line(M, y + 22, M + 230, y + 22);
    doc.line(M + 260, y + 22, M + 260 + 130, y + 22);
    setFont('normal', base - 1, muted);
    doc.text(fit(design.signatureLabel, 230), M, y + 36);
    doc.text('Date', M + 260, y + 36);
    y += 44;
  };

  for (const id of visibleSections(design, data.docType)) {
    const before = y;
    switch (id) {
      case 'customer':
        renderCustomer();
        break;
      case 'summary':
        if (data.report) renderSummary();
        break;
      case 'metrics':
        renderMetrics();
        break;
      case 'items':
        renderItems();
        break;
      case 'totals':
        renderTotals();
        break;
      case 'payment':
        if (data.paymentInstructions?.trim()) {
          label('Payment instructions');
          paragraph(data.paymentInstructions);
        }
        break;
      case 'notes':
        if (data.notes?.trim()) {
          label('Notes');
          paragraph(data.notes);
        }
        break;
      case 'terms':
        if (design.terms.trim()) {
          label('Terms & conditions');
          paragraph(design.terms, Math.max(7, base - 1), muted);
        }
        break;
      case 'signature':
        renderSignature();
        break;
    }
    if (y !== before) gap();
  }

  // ============================================================
  // FOOTER (every page)
  // ============================================================
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE);
    doc.setLineWidth(0.8);
    doc.line(M, footerTop, R, footerTop);
    const fs = Math.max(7, base - 2);
    setFont('normal', fs, muted);
    footerLines.forEach((line, li) => doc.text(line, M, footerTop + 14 + li * (fs + 2)));
    let ry = footerTop + 14;
    if (design.footer.showPageNumbers) {
      doc.text(`Page ${i} of ${pages}`, R, ry, { align: 'right' });
      ry += fs + 2;
    }
    if (design.footer.showBranding) doc.text('Generated with Vireek', R, ry, { align: 'right' });
  }

  doc.setProperties({
    title: S(`${design.header.title || DOC_TYPE_LABELS[data.docType]} ${data.documentNumber}`.trim()),
    creator: 'Vireek',
  });
  return doc;
}

export async function downloadTemplatePdf(design: DocumentDesign, data: RenderData, filename?: string): Promise<void> {
  const doc = await buildTemplatePdf(design, data);
  doc.save(filename ?? templatePdfFilename(data.docType, data.documentNumber));
}
