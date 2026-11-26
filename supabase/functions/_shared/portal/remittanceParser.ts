// supabase/functions/_shared/portal/remittanceParser.ts
// Rule-based remittance extraction (CSV-ish / text lines) + matching. AI-assisted extraction is NEVER applied automatically:
// anything not rule-matched is returned with requires_confirmation = true and lands in the human review queue.
import type { ParsedRemittance, RemittanceLine } from "./adapter.ts";

const AMOUNT_RE = /(?:[$€£]\s*)?(-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})|-?\d+\.\d{2})/;
const INV_RE = /\b(?:inv(?:oice)?\.?\s*(?:no\.?|#|number)?\s*[:#-]?\s*)([A-Z0-9][A-Z0-9-]{2,30})\b/i;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const REF_RE = /\b(?:payment|check|cheque|ach|eft|trace|reference|ref)\.?\s*(?:no\.?|#|number|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,30})\b/i;

export function toCents(s: string): number {
  const neg = s.trim().startsWith("-");
  const n = s.replace(/[^\d.]/g, "");
  const [w, f = "00"] = n.split(".");
  const cents = Number(w || "0") * 100 + Number((f + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function parseRemittanceText(doc: string): ParsedRemittance {
  const text = doc.slice(0, 200_000);
  const lines: RemittanceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const inv = INV_RE.exec(raw);
    if (!inv) continue;
    const rest = raw.slice((inv.index ?? 0) + inv[0].length);
    const amt = AMOUNT_RE.exec(rest);
    if (!amt) continue;
    lines.push({ invoice_number: inv[1].toUpperCase(), amount_cents: toCents(amt[1]), confidence: 0.9 });
  }
  const ref = REF_RE.exec(text)?.[1] ?? null;
  const date = DATE_RE.exec(text)?.[1] ?? null;
  const cur = /\b(USD|EUR|GBP|CAD|AUD)\b/.exec(text)?.[1] ?? null;
  return { payment_ref: ref, paid_on: date, currency: cur, lines, method: "rule", requires_confirmation: lines.length === 0 || ref === null };
}

export type MatchStatus = "matched" | "amount_mismatch" | "unmatched" | "duplicate";
export interface InvoiceRef { id: string; invoice_number: string; total_cents: number; already_paid_via_remittance: boolean }
export interface MatchResult { line: RemittanceLine; status: MatchStatus; invoice_id: string | null }

export function matchRemittance(lines: RemittanceLine[], invoices: InvoiceRef[]): MatchResult[] {
  const byNum = new Map(invoices.map((i) => [i.invoice_number.toUpperCase(), i]));
  const seen = new Set<string>();
  return lines.map((line) => {
    const inv = byNum.get(line.invoice_number);
    if (!inv) return { line, status: "unmatched", invoice_id: null };
    if (seen.has(inv.id) || inv.already_paid_via_remittance) return { line, status: "duplicate", invoice_id: inv.id };
    seen.add(inv.id);
    return { line, status: line.amount_cents === inv.total_cents ? "matched" : "amount_mismatch", invoice_id: inv.id };
  });
}
