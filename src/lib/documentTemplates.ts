/**
 * Document Templates — pure logic (no React, no network, no imports).
 *
 * A template is a versioned JSON "design" for a customer-facing PDF (quote, invoice or report).
 * Everything that comes out of the database goes through normalizeDesign(), so a stale, partial or
 * hand-edited row can never crash the editor or the PDF renderer.
 *
 * Schema + security: supabase/migrations/20280101000000_document_templates.sql
 * Data access:       src/lib/documentTemplatesApi.ts
 * PDF rendering:     src/lib/documentTemplatePdf.ts
 */

// ============================================================
// Constants & types
// ============================================================

export const DOC_TYPES = ['quote', 'invoice', 'report'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  quote: 'Quote',
  invoice: 'Invoice',
  report: 'Report',
};

export const FONT_FAMILIES = ['helvetica', 'times', 'courier'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const FONT_LABELS: Record<FontFamily, string> = {
  helvetica: 'Sans-serif (Helvetica)',
  times: 'Serif (Times)',
  courier: 'Monospace (Courier)',
};

export const PAGE_SIZES = ['a4', 'letter'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const PAGE_SIZE_LABELS: Record<PageSize, string> = { a4: 'A4', letter: 'US Letter' };
/** Page dimensions in PDF points (1 pt = 1/72 in). */
export const PAGE_DIMENSIONS: Record<PageSize, { w: number; h: number }> = {
  a4: { w: 595.28, h: 841.89 },
  letter: { w: 612, h: 792 },
};

export const ACCENT_BARS = ['none', 'top', 'band'] as const;
export type AccentBar = (typeof ACCENT_BARS)[number];
export const ACCENT_BAR_LABELS: Record<AccentBar, string> = { none: 'None', top: 'Thin top bar', band: 'Full header band' };

export const TABLE_HEADER_STYLES = ['filled', 'underline'] as const;
export type TableHeaderStyle = (typeof TABLE_HEADER_STYLES)[number];

export const LOGO_ALIGNS = ['left', 'right'] as const;
export type LogoAlign = (typeof LOGO_ALIGNS)[number];

export const SECTION_IDS = ['customer', 'summary', 'metrics', 'items', 'totals', 'payment', 'notes', 'terms', 'signature'] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/** Sections each document type supports, in default order. */
export const SECTIONS_BY_TYPE: Record<DocType, SectionId[]> = {
  quote: ['customer', 'items', 'totals', 'notes', 'terms', 'signature'],
  invoice: ['customer', 'items', 'totals', 'payment', 'notes', 'terms'],
  report: ['summary', 'metrics', 'items', 'notes'],
};

export function sectionLabel(id: SectionId, docType: DocType): string {
  if (id === 'customer') return docType === 'invoice' ? 'Bill-to & dates' : 'Customer & dates';
  if (id === 'items') return docType === 'report' ? 'Data table' : 'Line items';
  const labels: Record<Exclude<SectionId, 'customer' | 'items'>, string> = {
    summary: 'Summary',
    metrics: 'Key metrics',
    totals: 'Totals',
    payment: 'Payment instructions',
    notes: 'Notes',
    terms: 'Terms & conditions',
    signature: 'Signature block',
  };
  return labels[id];
}

export const LIMITS = {
  name: 80,
  title: 24,
  tagline: 80,
  label: 20,
  terms: 2000,
  footer: 240,
  signature: 40,
  marginMin: 24,
  marginMax: 72,
  sizeMin: 8,
  sizeMax: 12,
  maxSections: 12,
} as const;

export interface SectionConfig {
  id: SectionId;
  visible: boolean;
}

export interface DocumentDesign {
  version: 1;
  page: { size: PageSize; margin: number };
  theme: { primary: string; accent: string; text: string; muted: string; font: FontFamily; baseSize: number };
  header: {
    showLogo: boolean;
    logoAlign: LogoAlign;
    showBusinessName: boolean;
    showBusinessContact: boolean;
    tagline: string;
    title: string;
    accentBar: AccentBar;
  };
  table: {
    descriptionLabel: string;
    qtyLabel: string;
    unitLabel: string;
    amountLabel: string;
    showQty: boolean;
    showUnitPrice: boolean;
    zebra: boolean;
    headerStyle: TableHeaderStyle;
  };
  totals: { showSubtotal: boolean; showDiscount: boolean; showTax: boolean; totalLabel: string };
  sections: SectionConfig[];
  terms: string;
  signatureLabel: string;
  footer: { text: string; showPageNumbers: boolean; showBranding: boolean };
}

export interface DocumentTemplate {
  id: string;
  user_id: string;
  name: string;
  doc_type: DocType;
  design: DocumentDesign;
  is_default: boolean;
  status: 'active' | 'archived';
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** What the editor changes before saving. */
export interface TemplateDraft {
  name: string;
  design: DocumentDesign;
}

// ============================================================
// Low-level sanitizers
// ============================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, min: number, max: number, fallback: number, step = 1): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const snapped = Math.round(n / step) * step;
  return Math.min(max, Math.max(min, Number(snapped.toFixed(2))));
}

// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Strips control characters, trims and caps length. Multi-line keeps \n. */
export function cleanText(v: unknown, max: number, fallback = '', multiline = false): string {
  if (typeof v !== 'string') return fallback;
  const stripped = v.replace(/\r\n?/g, '\n').replace(multiline ? CONTROL_MULTI_LINE : CONTROL_SINGLE_LINE, multiline ? '' : ' ');
  return (multiline ? stripped.trim() : stripped.replace(/\s+/g, ' ').trim()).slice(0, max);
}

/** Accepts #RGB / #RRGGBB (any case), returns #RRGGBB uppercase, else the fallback. */
export function normalizeColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${h.toUpperCase()}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeColor(hex, '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Mixes a color toward white. amount 0 = original, 1 = white. */
export function tint(hex: string, amount: number): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.min(1, Math.max(0, amount));
  return [Math.round(r + (255 - r) * a), Math.round(g + (255 - g) * a), Math.round(b + (255 - b) * a)];
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between a color and white. */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

// ============================================================
// Defaults & presets
// ============================================================

const DEFAULT_TITLES: Record<DocType, string> = { quote: 'QUOTE', invoice: 'INVOICE', report: 'REPORT' };
const DEFAULT_TERMS: Record<DocType, string> = {
  quote: 'This quote is valid until the date shown above. Please review the scope of work before accepting.',
  invoice: 'Please pay by the due date shown above. Contact us if you have any questions about this invoice.',
  report: '',
};
const DEFAULT_FOOTER: Record<DocType, string> = {
  quote: 'Thank you for the opportunity to work with you.',
  invoice: 'Thank you for your business.',
  report: 'Prepared for internal use.',
};

export function defaultDesign(docType: DocType): DocumentDesign {
  return {
    version: 1,
    page: { size: 'a4', margin: 48 },
    theme: { primary: '#203AD8', accent: '#D6582A', text: '#171717', muted: '#6E6E78', font: 'helvetica', baseSize: 10 },
    header: {
      showLogo: true,
      logoAlign: 'left',
      showBusinessName: true,
      showBusinessContact: true,
      tagline: '',
      title: DEFAULT_TITLES[docType],
      accentBar: 'top',
    },
    table: {
      descriptionLabel: 'Description',
      qtyLabel: 'Qty',
      unitLabel: 'Unit price',
      amountLabel: 'Amount',
      showQty: true,
      showUnitPrice: true,
      zebra: false,
      headerStyle: 'filled',
    },
    totals: { showSubtotal: true, showDiscount: true, showTax: true, totalLabel: 'Total' },
    sections: SECTIONS_BY_TYPE[docType].map((id) => ({ id, visible: true })),
    terms: DEFAULT_TERMS[docType],
    signatureLabel: 'Customer signature',
    footer: { text: DEFAULT_FOOTER[docType], showPageNumbers: true, showBranding: true },
  };
}

export const PRESET_IDS = ['classic', 'modern', 'minimal', 'executive'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export const PRESETS: { id: PresetId; label: string; description: string }[] = [
  { id: 'classic', label: 'Classic', description: 'Blue accent, thin top bar, clean table.' },
  { id: 'modern', label: 'Modern', description: 'Dark header band, striped rows.' },
  { id: 'minimal', label: 'Minimal', description: 'No color blocks, hairline table.' },
  { id: 'executive', label: 'Executive', description: 'Serif type, restrained and formal.' },
];

export function applyPreset(docType: DocType, preset: PresetId): DocumentDesign {
  const d = defaultDesign(docType);
  switch (preset) {
    case 'modern':
      d.theme = { ...d.theme, primary: '#0F172A', accent: '#0EA5E9' };
      d.header.accentBar = 'band';
      d.table.zebra = true;
      d.page.margin = 44;
      break;
    case 'minimal':
      d.theme = { ...d.theme, primary: '#111827', accent: '#6B7280', baseSize: 9.5 };
      d.header.accentBar = 'none';
      d.table.headerStyle = 'underline';
      break;
    case 'executive':
      d.theme = { ...d.theme, primary: '#1F2937', accent: '#9A3412', font: 'times', baseSize: 10.5 };
      d.header.accentBar = 'none';
      d.table.headerStyle = 'underline';
      d.page.margin = 54;
      break;
    case 'classic':
    default:
      break;
  }
  return normalizeDesign(d, docType);
}

/** Applies only the visual style of a preset (colors, font, accent, table style, margin); content is kept. */
export function applyPresetStyle(design: DocumentDesign, docType: DocType, preset: PresetId): DocumentDesign {
  const p = applyPreset(docType, preset);
  return normalizeDesign(
    {
      ...design,
      page: { ...design.page, margin: p.page.margin },
      theme: { ...p.theme },
      header: { ...design.header, accentBar: p.header.accentBar },
      table: { ...design.table, headerStyle: p.table.headerStyle, zebra: p.table.zebra },
    },
    docType,
  );
}

// ============================================================
// Normalization
// ============================================================

function normalizeSections(raw: unknown, docType: DocType): SectionConfig[] {
  const allowed = SECTIONS_BY_TYPE[docType];
  const out: SectionConfig[] = [];
  const seen = new Set<SectionId>();
  if (Array.isArray(raw)) {
    for (const item of raw.slice(0, LIMITS.maxSections)) {
      if (!isRecord(item)) continue;
      const id = item.id;
      if (typeof id !== 'string' || !(allowed as string[]).includes(id) || seen.has(id as SectionId)) continue;
      seen.add(id as SectionId);
      out.push({ id: id as SectionId, visible: bool(item.visible, true) });
    }
  }
  // Sections added in later versions (or missing from old rows) are appended, visible.
  for (const id of allowed) if (!seen.has(id)) out.push({ id, visible: true });
  return out;
}

/** Turns ANY value into a complete, valid design for the given type. Never throws. */
export function normalizeDesign(raw: unknown, docType: DocType): DocumentDesign {
  const base = defaultDesign(docType);
  const r = isRecord(raw) ? raw : {};
  const page = isRecord(r.page) ? r.page : {};
  const theme = isRecord(r.theme) ? r.theme : {};
  const header = isRecord(r.header) ? r.header : {};
  const table = isRecord(r.table) ? r.table : {};
  const totals = isRecord(r.totals) ? r.totals : {};
  const footer = isRecord(r.footer) ? r.footer : {};

  return {
    version: 1,
    page: {
      size: pick(page.size, PAGE_SIZES, base.page.size),
      margin: num(page.margin, LIMITS.marginMin, LIMITS.marginMax, base.page.margin),
    },
    theme: {
      primary: normalizeColor(theme.primary, base.theme.primary),
      accent: normalizeColor(theme.accent, base.theme.accent),
      text: normalizeColor(theme.text, base.theme.text),
      muted: normalizeColor(theme.muted, base.theme.muted),
      font: pick(theme.font, FONT_FAMILIES, base.theme.font),
      baseSize: num(theme.baseSize, LIMITS.sizeMin, LIMITS.sizeMax, base.theme.baseSize, 0.5),
    },
    header: {
      showLogo: bool(header.showLogo, base.header.showLogo),
      logoAlign: pick(header.logoAlign, LOGO_ALIGNS, base.header.logoAlign),
      showBusinessName: bool(header.showBusinessName, base.header.showBusinessName),
      showBusinessContact: bool(header.showBusinessContact, base.header.showBusinessContact),
      tagline: cleanText(header.tagline, LIMITS.tagline, base.header.tagline),
      title: cleanText(header.title, LIMITS.title, base.header.title),
      accentBar: pick(header.accentBar, ACCENT_BARS, base.header.accentBar),
    },
    table: {
      descriptionLabel: cleanText(table.descriptionLabel, LIMITS.label, base.table.descriptionLabel) || base.table.descriptionLabel,
      qtyLabel: cleanText(table.qtyLabel, LIMITS.label, base.table.qtyLabel) || base.table.qtyLabel,
      unitLabel: cleanText(table.unitLabel, LIMITS.label, base.table.unitLabel) || base.table.unitLabel,
      amountLabel: cleanText(table.amountLabel, LIMITS.label, base.table.amountLabel) || base.table.amountLabel,
      showQty: bool(table.showQty, base.table.showQty),
      showUnitPrice: bool(table.showUnitPrice, base.table.showUnitPrice),
      zebra: bool(table.zebra, base.table.zebra),
      headerStyle: pick(table.headerStyle, TABLE_HEADER_STYLES, base.table.headerStyle),
    },
    totals: {
      showSubtotal: bool(totals.showSubtotal, base.totals.showSubtotal),
      showDiscount: bool(totals.showDiscount, base.totals.showDiscount),
      showTax: bool(totals.showTax, base.totals.showTax),
      totalLabel: cleanText(totals.totalLabel, LIMITS.label, base.totals.totalLabel) || base.totals.totalLabel,
    },
    sections: normalizeSections(r.sections, docType),
    terms: cleanText(r.terms, LIMITS.terms, base.terms, true),
    signatureLabel: cleanText(r.signatureLabel, LIMITS.signature, base.signatureLabel) || base.signatureLabel,
    footer: {
      text: cleanText(footer.text, LIMITS.footer, base.footer.text, true),
      showPageNumbers: bool(footer.showPageNumbers, base.footer.showPageNumbers),
      showBranding: bool(footer.showBranding, base.footer.showBranding),
    },
  };
}

export function designsEqual(a: DocumentDesign, b: DocumentDesign, docType: DocType): boolean {
  return JSON.stringify(normalizeDesign(a, docType)) === JSON.stringify(normalizeDesign(b, docType));
}

export function draftsEqual(a: TemplateDraft, b: TemplateDraft, docType: DocType): boolean {
  return a.name.trim() === b.name.trim() && designsEqual(a.design, b.design, docType);
}

export function normalizeTemplate(row: unknown): DocumentTemplate | null {
  if (!isRecord(row)) return null;
  const { id, user_id, name } = row;
  if (typeof id !== 'string' || !id || typeof user_id !== 'string' || typeof name !== 'string') return null;
  if (typeof row.doc_type !== 'string' || !(DOC_TYPES as readonly string[]).includes(row.doc_type)) return null;
  const doc_type = row.doc_type as DocType;
  return {
    id,
    user_id,
    name,
    doc_type,
    design: normalizeDesign(row.design, doc_type),
    is_default: row.is_default === true,
    status: row.status === 'archived' ? 'archived' : 'active',
    revision: typeof row.revision === 'number' && row.revision >= 1 ? Math.floor(row.revision) : 1,
    created_by: typeof row.created_by === 'string' ? row.created_by : '',
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

export function normalizeTemplates(rows: unknown): DocumentTemplate[] {
  if (!Array.isArray(rows)) return [];
  const out: DocumentTemplate[] = [];
  for (const r of rows) {
    const t = normalizeTemplate(r);
    if (t) out.push(t);
  }
  return out;
}

// ============================================================
// Validation, naming, filtering
// ============================================================

export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the template a name.';
  if (n.length > LIMITS.name) return `Keep the name under ${LIMITS.name} characters.`;
  return null;
}

/** "Name (copy)", "Name (copy 2)", … guaranteed not to collide (case-insensitive) with `existing`. */
export function uniqueCopyName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const root = name.trim().replace(/\s+\(copy(?: \d+)?\)$/i, '');
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? ' (copy)' : ` (copy ${i})`;
    const candidate = `${root.slice(0, LIMITS.name - suffix.length)}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${root.slice(0, LIMITS.name - 8)} (copy)`;
}

export interface TemplateFilters {
  type: DocType | 'all';
  showArchived: boolean;
  query: string;
}

export const DEFAULT_FILTERS: TemplateFilters = { type: 'all', showArchived: false, query: '' };

/** Defaults first, then most recently edited. */
export function filterTemplates(list: DocumentTemplate[], f: TemplateFilters): DocumentTemplate[] {
  const q = f.query.trim().toLowerCase();
  return list
    .filter((t) => (f.showArchived ? true : t.status === 'active'))
    .filter((t) => f.type === 'all' || t.doc_type === f.type)
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return b.updated_at.localeCompare(a.updated_at);
    });
}

export interface TemplateSummary {
  active: number;
  archived: number;
  byType: Record<DocType, number>;
  defaults: Record<DocType, string | null>;
}

export function summarizeTemplates(list: DocumentTemplate[]): TemplateSummary {
  const s: TemplateSummary = {
    active: 0,
    archived: 0,
    byType: { quote: 0, invoice: 0, report: 0 },
    defaults: { quote: null, invoice: null, report: null },
  };
  for (const t of list) {
    if (t.status === 'archived') {
      s.archived += 1;
      continue;
    }
    s.active += 1;
    s.byType[t.doc_type] += 1;
    if (t.is_default) s.defaults[t.doc_type] = t.id;
  }
  return s;
}

// ============================================================
// Section helpers
// ============================================================

export function visibleSections(design: DocumentDesign, docType: DocType): SectionId[] {
  const allowed = SECTIONS_BY_TYPE[docType];
  return design.sections.filter((s) => s.visible && allowed.includes(s.id)).map((s) => s.id);
}

export function moveSection(design: DocumentDesign, id: SectionId, delta: -1 | 1): DocumentDesign {
  const i = design.sections.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= design.sections.length) return design;
  const sections = design.sections.slice();
  [sections[i], sections[j]] = [sections[j], sections[i]];
  return { ...design, sections };
}

export function setSectionVisible(design: DocumentDesign, id: SectionId, visible: boolean): DocumentDesign {
  return { ...design, sections: design.sections.map((s) => (s.id === id ? { ...s, visible } : s)) };
}

// ============================================================
// PDF-safe text
// ============================================================

// jsPDF's built-in fonts only cover Latin-1 (WinAnsi). Anything else would render as garbage, so it is
// replaced with "?" in the PDF and flagged in the editor instead of failing silently.
const WINANSI_EXTRAS = '\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2022\u2026\u20AC\u2122\u2020\u2021\u2030\u2039\u203A';

function isPdfSafeChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (c === 0x0a || c === 0x20) return true;
  if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
  return c <= 0xff || WINANSI_EXTRAS.includes(ch);
}

export function pdfSafeText(input: string | null | undefined): string {
  if (!input) return '';
  let out = '';
  for (const ch of input.replace(/\t/g, ' ').replace(/\r\n?/g, '\n')) {
    out += isPdfSafeChar(ch) ? ch : ch.codePointAt(0)! < 0x20 || ch === '\u200b' ? '' : '?';
  }
  return out;
}

export function hasUnsupportedPdfChars(input: string | null | undefined): boolean {
  if (!input) return false;
  for (const ch of input.replace(/[\t\r]/g, ' ')) if (!isPdfSafeChar(ch)) return true;
  return false;
}

/** Human labels of the editable text fields that contain characters the PDF fonts cannot draw. */
export function unsupportedFields(design: DocumentDesign, name = ''): string[] {
  const checks: [string, string][] = [
    ['Template name', name],
    ['Title', design.header.title],
    ['Tagline', design.header.tagline],
    ['Column labels', [design.table.descriptionLabel, design.table.qtyLabel, design.table.unitLabel, design.table.amountLabel].join(' ')],
    ['Total label', design.totals.totalLabel],
    ['Terms', design.terms],
    ['Signature label', design.signatureLabel],
    ['Footer', design.footer.text],
  ];
  return checks.filter(([, v]) => hasUnsupportedPdfChars(v)).map(([k]) => k);
}

// ============================================================
// Render data (what a real document / sample feeds the renderer)
// ============================================================

export interface RenderLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface RenderBusiness {
  name: string;
  lines: string[];
  /** PNG/JPEG data URL (already converted) or null. */
  logoDataUrl: string | null;
}

export interface RenderReport {
  title: string;
  period: string;
  summary: string;
  metrics: { label: string; value: string }[];
  columns: string[];
  rows: string[][];
}

export type RenderTone = 'success' | 'danger' | 'primary';

export interface RenderData {
  docType: DocType;
  documentNumber: string;
  issueDate: string | null;
  secondaryDateLabel: string;
  secondaryDate: string | null;
  business: RenderBusiness;
  customer: { name: string; lines: string[] };
  lineItems: RenderLineItem[];
  taxPercent: number;
  /** Exact tax in cents when the source document stores one (jurisdiction breakdown); overrides taxPercent. */
  taxCentsOverride?: number | null;
  discountCents: number;
  currency: string | null;
  notes: string | null;
  paymentInstructions: string | null;
  report: RenderReport | null;
  /** Status stamp under the document number, e.g. PAID / VOID. */
  stamp?: { text: string; tone: RenderTone } | null;
  /** Extra rows printed under the total (payments received, balance due, …). */
  extraTotals?: { label: string; value: string; tone?: RenderTone; bold?: boolean }[];
}

/** Same formula as calculateQuoteTotals() in lib/quotes.ts (kept local so this module stays import-free). */
export function computeTotals(
  items: RenderLineItem[],
  taxPercent: number,
  discountCents: number,
  taxCentsOverride?: number | null,
) {
  const subtotalCents = items.reduce(
    (sum, li) => sum + Math.round((Number(li.quantity) || 0) * (Number(li.unit_price_cents) || 0)),
    0,
  );
  const discount = Math.min(Math.max(0, Math.round(discountCents || 0)), Math.max(0, subtotalCents));
  const taxable = subtotalCents - discount;
  const taxCents =
    typeof taxCentsOverride === 'number' && Number.isFinite(taxCentsOverride) && taxCentsOverride >= 0
      ? Math.round(taxCentsOverride)
      : Math.round((taxable * Math.max(0, taxPercent || 0)) / 100);
  return { subtotalCents, discountCents: discount, taxCents, totalCents: taxable + taxCents };
}

export function formatDocDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Right-align columns whose values look like numbers/money/percentages. */
export function isNumericLike(v: string): boolean {
  return /^[\s$€£¥+\-–(]*\d[\d.,\s]*[%)kKmMbB]*\s*$/.test(v);
}

function addDays(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function buildSampleData(docType: DocType, business: Partial<RenderBusiness> = {}, now: Date = new Date()): RenderData {
  const biz: RenderBusiness = {
    name: business.name?.trim() || 'Your Business Name',
    lines: business.lines ?? [],
    logoDataUrl: business.logoDataUrl ?? null,
  };
  const items: RenderLineItem[] = [
    { description: 'Diagnostic visit and full system inspection', quantity: 1, unit_price_cents: 12900 },
    { description: 'Replace run capacitor and contactor', quantity: 1, unit_price_cents: 28500 },
    { description: 'Refrigerant recharge (R-410A), per pound', quantity: 2, unit_price_cents: 9500 },
    { description: 'Labor, per hour', quantity: 2, unit_price_cents: 11000 },
  ];
  const today = addDays(now, 0);
  const customer = { name: 'Jordan Rivera', lines: ['jordan@example.com', '(555) 014-2290', '418 Maple Street'] };

  if (docType === 'report') {
    return {
      docType,
      documentNumber: 'RPT-0007',
      issueDate: today,
      secondaryDateLabel: 'Period',
      secondaryDate: null,
      business: biz,
      customer: { name: '', lines: [] },
      lineItems: [],
      taxPercent: 0,
      discountCents: 0,
      currency: null,
      notes: 'Figures are taken from completed jobs and paid invoices in the selected period.',
      paymentInstructions: null,
      report: {
        title: 'Monthly performance summary',
        period: 'Last 30 days',
        summary:
          'Revenue grew while response times improved. Most new work came from repeat customers and phone bookings. Review the table below for the breakdown by service type.',
        metrics: [
          { label: 'Revenue', value: '$48,250' },
          { label: 'Jobs completed', value: '112' },
          { label: 'Average ticket', value: '$431' },
          { label: 'Close rate', value: '64%' },
        ],
        columns: ['Service', 'Jobs', 'Revenue', 'Share'],
        rows: [
          ['Repair', '61', '$21,400', '44%'],
          ['Maintenance', '34', '$8,900', '18%'],
          ['Installation', '11', '$15,300', '32%'],
          ['Emergency', '6', '$2,650', '6%'],
        ],
      },
    };
  }

  const isInvoice = docType === 'invoice';
  return {
    docType,
    documentNumber: isInvoice ? 'INV-1042' : 'Q-2087',
    issueDate: today,
    secondaryDateLabel: isInvoice ? 'Due' : 'Valid until',
    secondaryDate: addDays(now, isInvoice ? 14 : 30),
    business: biz,
    customer,
    lineItems: items,
    taxPercent: 8.25,
    discountCents: 2500,
    currency: null,
    notes: isInvoice ? 'Thank you for choosing us. Warranty details are included with your service report.' : 'Includes a 90-day labor warranty on all repairs.',
    paymentInstructions: isInvoice ? 'Pay online using the link in your invoice email, or by card over the phone.' : null,
    report: null,
  };
}
