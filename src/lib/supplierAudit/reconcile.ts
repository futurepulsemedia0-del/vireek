/** Confirmation loop (pure): suggest bank deposits for a finding. A human confirms; only then is it "recovered". */
import { normName } from './money';

export interface BankTxnLite { id: string; postedDate: string; amountCents: number; description: string; merchantName?: string | null }
export interface DepositFinding { vendorName: string; lowCents: number; likelyCents: number; highCents: number; firstSeenDate: string }
export interface DepositSuggestion { txn: BankTxnLite; score: number; reasons: string[] }

const STOP = new Set(['and', 'inc', 'llc', 'ltd', 'supply', 'wholesale', 'distribution', 'distributors', 'co', 'company']);

export function suggestDepositMatches(f: DepositFinding, txns: BankTxnLite[], used: Set<string>): DepositSuggestion[] {
  const tokens = normName(f.vendorName).split(' ').filter((t) => t.length >= 3 && !STOP.has(t));
  const out: DepositSuggestion[] = [];
  for (const t of txns) {
    if (used.has(t.id) || t.amountCents <= 0 || t.postedDate < f.firstSeenDate) continue; // deposits only, never before the finding
    const hay = normName(`${t.description} ${t.merchantName ?? ''}`);
    const reasons: string[] = []; let score = 0;
    const name = tokens.some((tok) => hay.includes(tok));
    if (name) { score += 2; reasons.push('Vendor name in description'); }
    const exact = [f.likelyCents, f.lowCents, f.highCents].some((v) => v > 0 && v === t.amountCents);
    const near = f.likelyCents > 0 && Math.abs(t.amountCents - f.likelyCents) <= Math.max(100, Math.round(f.likelyCents * 0.02));
    if (exact) { score += 3; reasons.push('Exact amount'); } else if (near) { score += 1.5; reasons.push('Within 2% of the estimate'); }
    if (!name && !exact) continue;      // amount alone or name alone is never enough
    if (!exact && !near) continue;      // a name match with an unrelated amount is not a match
    out.push({ txn: t, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.txn.postedDate.localeCompare(b.txn.postedDate) || a.txn.id.localeCompare(b.txn.id)).slice(0, 5);
}
