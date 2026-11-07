// supabase/functions/_shared/economics/reconcile.ts
//
// Ledger-vs-provider reconciliation. Pure. Never adjusts existing ledger rows: a mismatch produces a PROPOSED
// offsetting correction event (kind='correction'), which staff posts through post_cost_correction().

export interface ReconcileInput { provider: string; month: string; ledgerMicro: number; providerMicro: number }
export type VarianceStatus = "match" | "within_tolerance" | "over_threshold";
export interface ReconcileResult {
  provider: string; month: string; ledgerMicro: number; providerMicro: number;
  varianceMicro: number; variancePct: number | null; status: VarianceStatus;
  proposedCorrectionMicro: number | null; // = providerMicro - ledgerMicro when status != match
}

export function reconcile(i: ReconcileInput, thresholdPct = 5): ReconcileResult {
  const varianceMicro = i.ledgerMicro - i.providerMicro;
  const variancePct = i.providerMicro > 0 ? (varianceMicro / i.providerMicro) * 100 : null;
  const status: VarianceStatus = varianceMicro === 0 ? "match"
    : variancePct === null || Math.abs(variancePct) > thresholdPct ? "over_threshold" : "within_tolerance";
  return { ...i, varianceMicro, variancePct, status, proposedCorrectionMicro: varianceMicro === 0 ? null : i.providerMicro - i.ledgerMicro };
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export interface StatementLine { provider: string; month: string; amountMicro: number; ref: string }
/** Expected header: provider,period_month,amount_usd,ref. Rejects malformed rows loudly instead of skipping them. */
export function parseStatementCsv(text: string): { lines: StatementLine[]; errors: string[] } {
  const rows = parseCsv(text); const errors: string[] = []; const lines: StatementLine[] = [];
  if (rows.length === 0) return { lines, errors: ["empty file"] };
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const ix = { p: h.indexOf("provider"), m: h.indexOf("period_month"), a: h.indexOf("amount_usd"), r: h.indexOf("ref") };
  if (ix.p < 0 || ix.m < 0 || ix.a < 0) return { lines, errors: ["header must contain provider,period_month,amount_usd"] };
  rows.slice(1).forEach((r, k) => {
    const prov = (r[ix.p] ?? "").trim(), month = (r[ix.m] ?? "").trim(), amt = (r[ix.a] ?? "").trim();
    if (!prov || !/^\d{4}-\d{2}-01$/.test(month) || !/^\d+(\.\d{1,6})?$/.test(amt)) { errors.push(`row ${k + 2}: invalid`); return; }
    const [w, fr = ""] = amt.split(".");
    lines.push({ provider: prov.toLowerCase(), month, amountMicro: Number(w) * 1_000_000 + Number(fr.padEnd(6, "0")), ref: (ix.r >= 0 ? r[ix.r] : "")?.trim() ?? "" });
  });
  return { lines, errors };
}
