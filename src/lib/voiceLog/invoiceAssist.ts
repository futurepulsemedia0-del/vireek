// Invoice assist (phase D): compares what the technician logged (approved voice logs) and what
// telematics saw on site against the invoice and the price book. It ONLY returns review flags —
// it never edits an invoice. Matching is heuristic (token overlap), so every flag says "review".

export interface InvLine { description: string; quantity: number; unit_price_cents: number }
export interface BookItem { id: string; service_name: string; keywords: string[] | null; price_cents: number; pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly'; active: boolean }
export interface AssistInput {
  invoiceLines: InvLine[];
  loggedParts: { name: string; quantity: number }[];
  loggedMinutes: number | null;
  onsiteMinutes: number | null;
  priceBook: BookItem[];
}
export type FlagKind = 'part_not_billed' | 'part_qty_low' | 'labor_under_billed' | 'price_below_book';
export interface AssistFlag { kind: FlagKind; lineIndex: number | null; data: Record<string, string | number> }

export const MATCH_THRESHOLD = 0.6;
export const LABOR_TOLERANCE_MIN = 15;
const LABOR_RE = /\b(labou?r|hours?|hrs?|mano de obra|horas?)\b|ساعت|دستمزد|کارگری/iu;

export function tokens(s: string): Set<string> {
  const base = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const out = new Set<string>();
  for (const raw of base.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    out.add(raw.length > 3 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Overlap coefficient on tokens: |A∩B| / min(|A|,|B|). */
export function similarity(a: string, b: string): number {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}

function bestBook(desc: string, book: BookItem[]): BookItem | null {
  let best: BookItem | null = null; let bestScore = 0;
  for (const item of book) {
    if (!item.active) continue;
    const s = Math.max(similarity(desc, item.service_name), ...(item.keywords ?? []).map((k) => similarity(desc, k)), 0);
    if (s > bestScore) { best = item; bestScore = s; }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
}

export function reconcileInvoice(input: AssistInput): AssistFlag[] {
  const flags: AssistFlag[] = [];
  const { invoiceLines, loggedParts, priceBook } = input;
  const bookFor = invoiceLines.map((l) => bestBook(l.description, priceBook));
  const isLabor = invoiceLines.map((l, i) => bookFor[i]?.pricing_model === 'hourly' || LABOR_RE.test(l.description));

  // 1) parts the technician logged that are missing / short on the invoice
  const used = new Set<number>();
  for (const p of loggedParts) {
    let idx = -1; let best = 0;
    invoiceLines.forEach((l, i) => {
      if (isLabor[i] || used.has(i)) return;
      const s = similarity(p.name, l.description);
      if (s > best) { best = s; idx = i; }
    });
    if (idx < 0 || best < MATCH_THRESHOLD) { flags.push({ kind: 'part_not_billed', lineIndex: null, data: { part: p.name, qty: p.quantity } }); continue; }
    used.add(idx);
    if (invoiceLines[idx].quantity < p.quantity) flags.push({ kind: 'part_qty_low', lineIndex: idx, data: { part: p.name, logged: p.quantity, billed: invoiceLines[idx].quantity } });
  }

  // 2) work time (logged or seen on site) vs billed labor hours
  const work = Math.max(input.loggedMinutes ?? 0, input.onsiteMinutes ?? 0);
  if (work > 0) {
    const billedMin = Math.round(invoiceLines.reduce((n, l, i) => n + (isLabor[i] ? l.quantity * 60 : 0), 0));
    if (billedMin + LABOR_TOLERANCE_MIN < work) flags.push({ kind: 'labor_under_billed', lineIndex: null, data: { workMin: work, billedMin } });
  }

  // 3) lines priced below their price-book entry
  invoiceLines.forEach((l, i) => {
    const b = bookFor[i];
    if (b && b.pricing_model !== 'range' && l.unit_price_cents < b.price_cents) {
      flags.push({ kind: 'price_below_book', lineIndex: i, data: { item: b.service_name, billed: l.unit_price_cents, book: b.price_cents } });
    }
  });
  return flags;
}
