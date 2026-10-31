/**
 * Vireek PDF design system — the shared writer every generated document uses.
 *
 * Responsibilities: page chrome (brand band, running header, footer with
 * "Page x of y", legal line, optional subtle attribution), typographic scale,
 * tables with repeating headers + zebra + hairline rules, totals blocks,
 * RTL mirroring, document metadata (title / author / language).
 *
 * The writer talks to a *structural* `PdfDocLike`, so it works with jsPDF in
 * the browser, jsPDF in Deno edge functions, and a recording fake in tests.
 */

import {
  FOOTER_RESERVE, HEAD_FILL, INK, LEADING, LINE, MARGIN, MUTED, PAGE_SIZES, TYPE, ZEBRA,
  readableOn, type PageSizeName, type Rgb,
} from './tokens';
import { planTable } from './tablePlan';

export interface PdfDocLike {
  internal: { pageSize: { getWidth(): number; getHeight(): number } };
  setFont(name: string, style?: string): unknown;
  setFontSize(size: number): unknown;
  setTextColor(r: number, g: number, b: number): unknown;
  setFillColor(r: number, g: number, b: number): unknown;
  setDrawColor(r: number, g: number, b: number): unknown;
  setLineWidth(w: number): unknown;
  rect(x: number, y: number, w: number, h: number, style?: string): unknown;
  line(x1: number, y1: number, x2: number, y2: number): unknown;
  text(text: string | string[], x: number, y: number, opts?: { align?: 'left' | 'right' | 'center' }): unknown;
  splitTextToSize(text: string, maxWidth: number): string[];
  addPage(): unknown;
  setPage(n: number): unknown;
  getNumberOfPages(): number;
  addImage(data: string, format: string, x: number, y: number, w: number, h: number): unknown;
  setProperties(p: { title?: string; subject?: string; author?: string; creator?: string; keywords?: string }): unknown;
  setLanguage?(lang: string): unknown;
}

export interface DocBrandLike {
  wordmark: string;
  primary: Rgb;
  accent: Rgb;
  logo: { dataUrl: string; aspect: number } | null;
  /** "Generated with Vireek", or null when white-label hides it. */
  attribution: string | null;
}

export interface WriterOptions {
  brand: DocBrandLike;
  /** Base language of the content, e.g. "en". */
  lang: string;
  /** PDF metadata title (screen readers announce this). */
  title: string;
  subject?: string;
  /** Shown in the running header and footer, e.g. the invoice number. */
  docNumber?: string;
  pageLabel: { page: string; of: string };
  legalLine?: string | null;
  rtl?: boolean;
  pageSize?: PageSizeName;
}

export interface TableColumn {
  header: string;
  /** Share of the content width; shares are normalised, so they need not sum to 1. */
  weight: number;
  align?: 'left' | 'right' | 'center';
}

export interface TextStyle { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center' }

const PAD_X = 8;
const PAD_Y = 6;
const RUNNING_HEADER_Y = 30;
const CONTINUATION_TOP = 56;

const JSPDF_LANG: Record<string, string> = { en: 'en-US', es: 'es-ES', fr: 'fr', de: 'de' };

export class DocumentWriter {
  readonly doc: PdfDocLike;
  readonly pageW: number;
  readonly pageH: number;
  readonly bottom: number;
  readonly left = MARGIN;
  readonly right: number;
  readonly contentW: number;
  readonly brandText: Rgb;
  y = 0;
  private readonly o: WriterOptions;
  private readonly rtl: boolean;

  constructor(doc: PdfDocLike, opts: WriterOptions) {
    this.doc = doc;
    this.o = opts;
    this.rtl = opts.rtl === true;
    const size = PAGE_SIZES[opts.pageSize ?? 'a4'];
    // Trust the document when it reports a size; fall back to the requested one.
    this.pageW = doc.internal.pageSize.getWidth() || size.w;
    this.pageH = doc.internal.pageSize.getHeight() || size.h;
    this.right = this.pageW - MARGIN;
    this.contentW = this.pageW - MARGIN * 2;
    this.bottom = this.pageH - FOOTER_RESERVE;
    // Customer-chosen colours must stay readable as text on white.
    this.brandText = readableOn(opts.brand.primary);
  }

  /* ------------------------------ geometry ------------------------------ */

  private px(x: number): number { return this.rtl ? this.pageW - x : x; }
  private al(a: 'left' | 'right' | 'center'): 'left' | 'right' | 'center' {
    if (!this.rtl || a === 'center') return a;
    return a === 'left' ? 'right' : 'left';
  }

  /* ------------------------------- text -------------------------------- */

  text(str: string, x: number, y: number, s: TextStyle = {}): void {
    const d = this.doc;
    d.setFont('helvetica', s.bold ? 'bold' : 'normal');
    d.setFontSize(s.size ?? TYPE.body);
    const c = s.color ?? INK;
    d.setTextColor(c[0], c[1], c[2]);
    d.text(str, this.px(x), y, { align: this.al(s.align ?? 'left') });
  }

  /** Lays out `str` into `width`, returns lines and their total height. */
  private wrap(str: string, width: number, size: number, bold = false): { lines: string[]; height: number } {
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal');
    this.doc.setFontSize(size);
    const lines = this.doc.splitTextToSize(str || '\u2014', width);
    return { lines, height: lines.length * size * LEADING };
  }

  /* ------------------------------ page chrome --------------------------- */

  begin(): this {
    const { brand, title, subject, lang } = this.o;
    this.doc.setProperties({
      title,
      subject: subject ?? title,
      author: brand.wordmark,
      // White-label: never leak the platform name into metadata when attribution is hidden.
      creator: brand.attribution ? 'Vireek' : brand.wordmark,
    });
    const tag = JSPDF_LANG[lang];
    if (tag && typeof this.doc.setLanguage === 'function') {
      try { this.doc.setLanguage(tag); } catch { /* unsupported tag: skip, never fail an export */ }
    }
    this.band();
    this.y = 0;
    return this;
  }

  private band(): void {
    const p = this.o.brand.primary;
    this.doc.setFillColor(p[0], p[1], p[2]);
    this.doc.rect(0, 0, this.pageW, 6, 'F');
  }

  newPage(): void {
    this.doc.addPage();
    this.band();
    if (this.o.docNumber) {
      this.text(this.o.docNumber, this.left, RUNNING_HEADER_Y, { size: TYPE.micro, color: MUTED });
      this.text(this.o.brand.wordmark, this.right, RUNNING_HEADER_Y, { size: TYPE.micro, color: MUTED, align: 'right' });
    }
    this.y = CONTINUATION_TOP;
  }

  ensure(height: number): void {
    if (this.y + height > this.bottom) this.newPage();
  }

  /** First-page identity block: logo/wordmark on one side, document type + number + status on the other. */
  titleBlock(opts: { business: string; kind: string; number: string; stamp?: { text: string; color: Rgb } | null }): void {
    const { brand } = this.o;
    let y = 52;
    if (brand.logo) {
      const h = 28;
      const w = Math.min(120, h * brand.logo.aspect);
      const x = this.rtl ? this.right - w : this.left;
      this.doc.addImage(brand.logo.dataUrl, 'PNG', x, 18, w, h);
      y = 18 + h + 22;
    }
    this.text(opts.business, this.left, y, { size: TYPE.h1, bold: true });
    this.text(opts.kind.toUpperCase(), this.right, y, { size: TYPE.display, bold: true, color: this.brandText, align: 'right' });
    y += 20;
    this.text(opts.number, this.right, y, { size: TYPE.body, color: MUTED, align: 'right' });
    if (opts.stamp) {
      this.text(opts.stamp.text.toUpperCase(), this.right, y + 16, { size: TYPE.body, bold: true, color: opts.stamp.color, align: 'right' });
    }
    y += 40;
    this.rule(y);
    this.y = y + 22;
  }

  rule(y: number, color: Rgb = LINE): void {
    this.doc.setDrawColor(color[0], color[1], color[2]);
    this.doc.setLineWidth(0.75);
    this.doc.line(this.px(this.left), y, this.px(this.right), y);
  }

  /** Label/value columns (e.g. BILL TO · ISSUED · DUE). `at` is the column start as a share (0–1) of content width. */
  metaRow(cols: { at: number; label: string; lines: string[] }[]): void {
    const rowTop = this.y;
    let maxLines = 1;
    for (const c of cols) {
      const x = this.left + c.at * this.contentW;
      this.text(c.label.toUpperCase(), x, rowTop, { size: TYPE.micro, bold: true, color: MUTED });
      c.lines.forEach((ln, i) => {
        this.text(ln, x, rowTop + 15 + i * 14, { size: i === 0 ? 11 : TYPE.small, bold: i === 0, color: i === 0 ? INK : MUTED });
      });
      maxLines = Math.max(maxLines, c.lines.length);
    }
    this.y = rowTop + 15 + maxLines * 14 + 20;
  }

  section(label: string): void {
    this.ensure(36);
    this.text(label.toUpperCase(), this.left, this.y, { size: TYPE.small, bold: true, color: MUTED });
    this.y += 16;
  }

  paragraph(str: string, style: TextStyle = {}): void {
    const size = style.size ?? TYPE.body;
    const { lines } = this.wrap(str, this.contentW, size, style.bold);
    for (const ln of lines) {
      this.ensure(size * LEADING);
      this.text(ln, this.left, this.y, { ...style, size });
      this.y += size * LEADING;
    }
  }

  /* -------------------------------- table ------------------------------- */

  table(cols: readonly TableColumn[], rows: readonly (readonly string[])[], opts: { zebra?: boolean } = {}): void {
    const total = cols.reduce((s, c) => s + c.weight, 0) || 1;
    const widths = cols.map((c) => (c.weight / total) * this.contentW);
    const starts: number[] = [];
    let cursor = this.left;
    for (const w of widths) {
      starts.push(cursor);
      cursor += w;
    }

    const headH = TYPE.micro * LEADING + PAD_Y * 2;
    const heights = rows.map((r) => {
      const lines = r.map((cell, i) => this.wrap(cell, widths[i]! - PAD_X * 2, TYPE.body).height);
      return Math.max(TYPE.body * LEADING, ...lines) + PAD_Y * 2;
    });

    const plan = planTable({ rowHeights: heights, headerHeight: headH, startY: this.y, pageTopY: CONTINUATION_TOP, bottomY: this.bottom });
    let endY = this.y;
    for (const page of plan) {
      if (page.newPage) this.newPage();
      let y = page.startY;
      this.drawHead(cols, widths, starts, y, headH);
      y += headH;
      for (let r = page.from; r < page.to; r++) {
        const h = heights[r]!;
        if (opts.zebra !== false && r % 2 === 1) {
          this.doc.setFillColor(ZEBRA[0], ZEBRA[1], ZEBRA[2]);
          this.doc.rect(this.left, y, this.contentW, h, 'F');
        }
        rows[r]!.forEach((cell, i) => this.drawCell(cell, cols[i]!, widths[i]!, starts[i]!, y));
        y += h;
        this.rule(y);
      }
      endY = y;
    }
    this.y = endY + 12;
  }

  private drawHead(cols: readonly TableColumn[], widths: number[], starts: number[], y: number, h: number): void {
    this.doc.setFillColor(HEAD_FILL[0], HEAD_FILL[1], HEAD_FILL[2]);
    this.doc.rect(this.left, y, this.contentW, h, 'F');
    cols.forEach((c, i) => {
      const base = this.cellX(c.align ?? 'left', widths[i]!, starts[i]!);
      this.text(c.header.toUpperCase(), base.x, y + PAD_Y + TYPE.micro * 0.85, { size: TYPE.micro, bold: true, color: MUTED, align: base.align });
    });
  }

  private cellX(align: 'left' | 'right' | 'center', w: number, start: number): { x: number; align: 'left' | 'right' | 'center' } {
    if (align === 'right') return { x: start + w - PAD_X, align: 'right' };
    if (align === 'center') return { x: start + w / 2, align: 'center' };
    return { x: start + PAD_X, align: 'left' };
  }

  private drawCell(cell: string, col: TableColumn, w: number, start: number, y: number): void {
    const { lines } = this.wrap(cell, w - PAD_X * 2, TYPE.body);
    const base = this.cellX(col.align ?? 'left', w, start);
    lines.forEach((ln, i) => {
      this.text(ln, base.x, y + PAD_Y + TYPE.body * 0.85 + i * TYPE.body * LEADING, { size: TYPE.body, align: base.align });
    });
  }

  /* ------------------------------- totals ------------------------------- */

  /** Right-hand totals block; kept on one page. Values are right-aligned so digits line up. */
  summary(rows: { label: string; value: string; bold?: boolean; color?: Rgb }[]): void {
    const h = rows.reduce((s, r) => s + (r.bold ? 24 : 18), 0);
    this.ensure(h + 8);
    const labelX = this.left + this.contentW * 0.55;
    for (const r of rows) {
      const size = r.bold ? 12 : TYPE.body;
      this.text(r.label, labelX, this.y, { size, bold: r.bold, color: r.color ?? INK });
      this.text(r.value, this.right - PAD_X, this.y, { size, bold: r.bold, color: r.color ?? INK, align: 'right' });
      this.y += r.bold ? 24 : 18;
    }
  }

  /** Label (left) / value (right) rows, e.g. a payment history. */
  ledgerRow(left: string, right: string, style: { color?: Rgb; size?: number; indent?: number } = {}): void {
    const size = style.size ?? TYPE.body;
    this.ensure(size * LEADING + 4);
    this.text(left, this.left + (style.indent ?? 0), this.y, { size, color: style.color });
    this.text(right, this.right - PAD_X, this.y, { size, color: style.color, align: 'right' });
    this.y += size * LEADING + 3;
  }

  /* ------------------------------- finish ------------------------------- */

  /** Draws the footer on every page (needs the final page count) and returns the document. */
  finish(): PdfDocLike {
    const { brand, docNumber, pageLabel, legalLine } = this.o;
    const total = this.doc.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      this.doc.setPage(i);
      this.rule(this.pageH - 56);
      if (legalLine) {
        const legal = this.wrap(legalLine, this.contentW, TYPE.micro).lines.slice(0, 2);
        legal.forEach((ln, k) => this.text(ln, this.left, this.pageH - 44 + k * 10, { size: TYPE.micro, color: MUTED }));
      }
      const pageText = `${pageLabel.page} ${i} ${pageLabel.of} ${total}`;
      this.text(docNumber ? `${docNumber} \u00B7 ${pageText}` : pageText, this.left, this.pageH - 20, { size: TYPE.micro, color: MUTED });
      if (brand.attribution) {
        this.text(brand.attribution, this.right, this.pageH - 20, { size: TYPE.micro, color: MUTED, align: 'right' });
      }
    }
    return this.doc;
  }
}
