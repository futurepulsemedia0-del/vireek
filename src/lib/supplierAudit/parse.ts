/**
 * CSV / XLSX statement parsing (pure). Every field carries a confidence; a value that cannot be read
 * with certainty is returned as null — it is NEVER guessed. Lines under the threshold go to human review.
 */
import { isYmd, parseMoneyToCents } from './money';

export interface ParsedLine {
  lineNo: number;
  invoiceNo: string | null; invoiceDate: string | null; sku: string | null; description: string | null;
  qty: number | null; unitPriceCents: number | null; extendedCents: number | null; isCredit: boolean;
  confidence: number; fieldConfidence: Record<string, number>; reviewStatus: 'auto_accepted' | 'needs_review';
  issues: string[];
}
export type DateOrder = 'mdy' | 'dmy';
export const ACCEPT_THRESHOLD = 0.85;

const SYN: Record<string, string[]> = {
  invoiceNo: ['invoice', 'invoice no', 'invoice number', 'invoice #', 'inv', 'inv no', 'inv #', 'document', 'doc no', 'reference', 'ref'],
  invoiceDate: ['invoice date', 'inv date', 'date', 'doc date', 'document date', 'ship date'],
  sku: ['sku', 'item', 'item #', 'item no', 'part', 'part #', 'part number', 'model', 'product code', 'catalog', 'catalog #'],
  description: ['description', 'desc', 'item description', 'product'],
  qty: ['qty', 'quantity', 'units', 'shipped', 'qty shipped'],
  unitPrice: ['unit price', 'price', 'unit cost', 'net price', 'each', 'price each'],
  extended: ['extended', 'ext', 'ext price', 'extended price', 'amount', 'line total', 'total', 'net amount'],
  type: ['type', 'doc type', 'document type', 'transaction type'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9# ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface ColumnMap { [k: string]: { index: number; confidence: number } }

/** Maps headers to fields. Exact synonym = 1.0, substring = 0.9. A header is used for at most one field. */
export function detectColumns(headers: string[]): ColumnMap {
  const map: ColumnMap = {}; const used = new Set<number>();
  const hs = headers.map(norm);
  for (const pass of ['exact', 'contains'] as const) {
    for (const [field, syns] of Object.entries(SYN)) {
      if (map[field]) continue;
      const idx = hs.findIndex((h, i) => !used.has(i) && (pass === 'exact' ? syns.includes(h) : syns.some((s) => s.length > 3 && h.includes(s))));
      if (idx >= 0) { map[field] = { index: idx, confidence: pass === 'exact' ? 1 : 0.9 }; used.add(idx); }
    }
  }
  return map;
}

/** Returns an ISO date and a confidence. Slash dates where day/month are both ≤ 12 are ambiguous (0.8 → review). */
export function parseDate(raw: string, order: DateOrder): { value: string | null; confidence: number } {
  const s = raw.trim();
  if (!s) return { value: null, confidence: 0 };
  if (isYmd(s)) return { value: s, confidence: 1 };
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (!m) return { value: null, confidence: 0 };
  const a = +m[1]; const b = +m[2]; let y = +m[3];
  if (m[3].length === 2) y += 2000;
  let mo = order === 'mdy' ? a : b; let d = order === 'mdy' ? b : a;
  let conf = 1;
  if (a <= 12 && b <= 12 && a !== b) conf = 0.8;           // genuinely ambiguous
  else if (mo > 12 && d <= 12) { [mo, d] = [d, mo]; conf = 1; } // only one reading is possible
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isYmd(iso) ? { value: iso, confidence: conf } : { value: null, confidence: 0 };
}

function parseQty(raw: string): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function mapTable(headers: string[], rows: string[][], opts: { dateOrder?: DateOrder } = {}): { lines: ParsedLine[]; columns: ColumnMap; missing: string[] } {
  const cols = detectColumns(headers);
  const missing = ['extended', 'invoiceDate'].filter((f) => !cols[f]);
  const order = opts.dateOrder ?? 'mdy';
  const lines: ParsedLine[] = [];
  const cell = (r: string[], f: string) => (cols[f] ? (r[cols[f].index] ?? '').trim() : '');
  rows.forEach((r, i) => {
    if (r.every((c) => !c.trim())) return;
    const issues: string[] = []; const fc: Record<string, number> = {};
    const text = (f: string, maxLen: number) => { const v = cell(r, f); return v ? v.slice(0, maxLen) : null; };

    const invoiceNo = text('invoiceNo', 80); fc.invoiceNo = invoiceNo ? (cols.invoiceNo?.confidence ?? 1) : 0.7;
    if (!invoiceNo) issues.push('No invoice number');
    const sku = text('sku', 120); const description = text('description', 400);
    fc.sku = sku || description ? Math.min(cols.sku?.confidence ?? 1, 1) : 0.6;

    let invoiceDate: string | null = null;
    const dRaw = cell(r, 'invoiceDate');
    if (dRaw) { const d = parseDate(dRaw, order); invoiceDate = d.value; fc.invoiceDate = Math.min(d.confidence, cols.invoiceDate?.confidence ?? 1); if (!d.value) issues.push(`Unreadable date "${dRaw}"`); else if (d.confidence < 1) issues.push('Ambiguous day/month order'); }
    else { fc.invoiceDate = 0; issues.push('No date'); }

    const qty = cell(r, 'qty') ? parseQty(cell(r, 'qty')) : null; fc.qty = qty === null ? (cols.qty ? 0.5 : 1) : (cols.qty?.confidence ?? 1);
    let unit = cell(r, 'unitPrice') ? parseMoneyToCents(cell(r, 'unitPrice')) : null; fc.unitPrice = unit === null ? (cols.unitPrice ? 0.5 : 1) : (cols.unitPrice?.confidence ?? 1);
    let ext = cell(r, 'extended') ? parseMoneyToCents(cell(r, 'extended')) : null;
    fc.extended = ext === null ? 0 : (cols.extended?.confidence ?? 1);
    if (ext === null) issues.push('Unreadable amount');

    const typeText = cell(r, 'type').toLowerCase();
    const isCredit = /credit|memo|\bcm\b|return|rebate|adjust/.test(typeText) || (ext !== null && ext < 0) || (unit !== null && unit < 0 && ext === null);
    if (ext !== null) ext = Math.abs(ext);
    if (unit !== null) unit = Math.abs(unit);

    // Cross-check qty × unit ≈ extended (tolerance: 1 cent per unit). A mismatch means one of the three was misread.
    if (qty !== null && unit !== null && ext !== null && !isCredit) {
      const calc = qty * unit; const tol = Math.max(1, Math.ceil(Math.abs(qty)));
      if (Math.abs(calc - ext) > tol) { fc.extended = Math.min(fc.extended, 0.5); fc.unitPrice = Math.min(fc.unitPrice, 0.5); issues.push('Quantity × unit price does not match the amount'); }
    }
    const confidence = Math.round(Math.min(...Object.values(fc)) * 1000) / 1000;
    lines.push({
      lineNo: i + 1, invoiceNo, invoiceDate, sku, description, qty, unitPriceCents: unit, extendedCents: ext, isCredit,
      confidence, fieldConfidence: fc, reviewStatus: confidence >= ACCEPT_THRESHOLD && issues.every((x) => x !== 'No date') ? 'auto_accepted' : 'needs_review', issues,
    });
  });
  return { lines, columns: cols, missing };
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
