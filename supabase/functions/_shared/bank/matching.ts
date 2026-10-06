// supabase/functions/_shared/bank/matching.ts
//
// Pure, deterministic bank-line -> invoice/bill matching. No I/O, no AI:
// every suggestion carries an explanation a human can audit, and only
// unambiguous, evidence-backed suggestions are ever eligible for autopilot.

import type {
  MatchContext, MatchItem, MatchKind, MatchMethod, MatchSuggestion, MatchTxn, UnlinkedPayment,
} from "./types.ts";
import { daysBetween, dollars, isProcessorPayout, nameSimilarity } from "./normalize.ts";

const NAME_MATCH = 0.6;
const MAX_POOL = 25;
const MAX_SUBSET = 8;
const NODE_BUDGET = 150_000;

const clamp = (x: number) => Math.max(0.05, Math.min(0.99, Math.round(x * 1000) / 1000));

/** All subsets (by index) of `values` summing exactly to `target`. Budgeted + pruned. */
export function findSubsets(values: number[], target: number, maxSize = MAX_SUBSET, maxSolutions = 4): number[][] {
  const order = values.map((_, i) => i).filter((i) => values[i] > 0).sort((a, b) => values[b] - values[a]);
  const suffix = new Array<number>(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + values[order[i]];
  const out: number[][] = [];
  const cur: number[] = [];
  let nodes = 0;
  const dfs = (start: number, remaining: number) => {
    if (out.length >= maxSolutions || nodes++ > NODE_BUDGET) return;
    if (remaining === 0) { if (cur.length > 0) out.push([...cur]); return; }
    if (cur.length >= maxSize) return;
    for (let i = start; i < order.length; i++) {
      if (suffix[i] < remaining) return;
      const v = values[order[i]];
      if (v > remaining) continue;
      cur.push(order[i]);
      dfs(i + 1, remaining - v);
      cur.pop();
      if (out.length >= maxSolutions || nodes > NODE_BUDGET) return;
    }
  };
  dfs(0, target);
  return out;
}

/** Subsets whose sum lies in [lo, hi] (used for processor payouts net of fees). */
export function findSubsetsInWindow(values: number[], lo: number, hi: number, maxSize = 6, maxSolutions = 12): number[][] {
  const order = values.map((_, i) => i).filter((i) => values[i] > 0).sort((a, b) => values[b] - values[a]);
  const suffix = new Array<number>(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + values[order[i]];
  const out: number[][] = [];
  const cur: number[] = [];
  let nodes = 0;
  const dfs = (start: number, sum: number) => {
    if (out.length >= maxSolutions || nodes++ > NODE_BUDGET) return;
    if (sum >= lo && sum <= hi && cur.length > 0) { out.push([...cur]); return; }
    if (cur.length >= maxSize) return;
    for (let i = start; i < order.length; i++) {
      if (sum + suffix[i] < lo) return;
      const v = values[order[i]];
      if (sum + v > hi) continue;
      cur.push(order[i]);
      dfs(i + 1, sum + v);
      cur.pop();
      if (out.length >= maxSolutions || nodes > NODE_BUDGET) return;
    }
  };
  dfs(0, 0);
  return out;
}

interface Doc { id: string; number: string; party: string | null; balance: number; due: string }

const normRef = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function mkItem(kind: "ar" | "ap", d: Doc, cents: number): MatchItem {
  return kind === "ar"
    ? { invoiceId: d.id, amountCents: cents, label: d.number }
    : { billId: d.id, amountCents: cents, label: d.number };
}

function dueNote(txn: MatchTxn, docs: Doc[]): string {
  const near = docs.every((d) => Math.abs(daysBetween(txn.postedDate, d.due)) <= 15);
  return near ? " Due date is within 15 days of the transaction." : "";
}
function dueBonus(txn: MatchTxn, docs: Doc[]): number {
  return docs.every((d) => Math.abs(daysBetween(txn.postedDate, d.due)) <= 15) ? 0.03 : 0;
}

function suggestDocs(kind: "ar" | "ap", amt: number, txn: MatchTxn, docs: Doc[], allowFees: boolean): MatchSuggestion[] {
  const open = docs.filter((d) => d.balance > 0);
  if (open.length === 0) return [];
  const party = kind === "ar" ? "payer" : "payee";
  const text = txn.name;
  const nameHit = new Set(open.filter((d) => nameSimilarity(text, d.party) >= NAME_MATCH).map((d) => d.id));
  const byDue = [...open].sort((a, b) => a.due.localeCompare(b.due));
  const out: MatchSuggestion[] = [];
  const mk = (
    method: MatchMethod, confidence: number, explanation: string, items: MatchItem[], fee = 0,
  ): MatchSuggestion => {
    const sum = items.reduce((s, i) => s + i.amountCents, 0);
    return {
      kind, method, confidence: clamp(confidence), explanation,
      matchedCents: sum, feeCents: fee, unmatchedCents: Math.max(0, amt + fee - sum), items,
    };
  };

  // 1) Explicit invoice/bill number in the bank description
  const normText = normRef(text);
  const refDocs = open.filter((d) => normRef(d.number).length >= 5 && normText.includes(normRef(d.number)));
  if (refDocs.length > 0) {
    const sum = refDocs.reduce((s, d) => s + d.balance, 0);
    if (sum === amt) {
      out.push(mk("reference", 0.99, `The bank description references ${refDocs.map((d) => d.number).join(", ")} and the amount equals their combined open balance (${dollars(sum)}).`,
        refDocs.map((d) => mkItem(kind, d, d.balance))));
    } else if (refDocs.length === 1 && amt < refDocs[0].balance) {
      out.push(mk("partial", 0.8, `The bank description references ${refDocs[0].number}; ${dollars(amt)} is a partial payment of its ${dollars(refDocs[0].balance)} balance.`,
        [mkItem(kind, refDocs[0], amt)]));
    }
  }

  // 2) Exact single-document balance
  const singles = open.filter((d) => d.balance === amt);
  const namedSingles = singles.filter((d) => nameHit.has(d.id));
  for (const d of singles) {
    const named = nameHit.has(d.id);
    let conf = 0.82 + (named ? 0.12 : 0) + dueBonus(txn, [d]);
    let note = "";
    if (singles.length > 1) {
      if (named && namedSingles.length === 1) { note = ` ${singles.length} documents share this amount; the ${party} name disambiguates.`; conf -= 0.0; }
      else { conf -= 0.25; note = ` ${singles.length} open documents have this exact balance — please confirm which one.`; }
    }
    out.push(mk("exact_single", conf,
      `${dollars(amt)} equals the open balance of ${d.number}${d.party ? ` (${d.party})` : ""}.${named ? ` The ${party} name matches.` : ""}${note}${dueNote(txn, [d])}`,
      [mkItem(kind, d, d.balance)]));
  }

  // 3) Multi-document exact subset — name-matched pool first
  const subsetOver = (pool: Doc[], named: boolean) => {
    const capped = pool.slice(0, MAX_POOL);
    const sols = findSubsets(capped.map((d) => d.balance), amt, MAX_SUBSET, 3).filter((s) => s.length >= 2);
    if (sols.length === 0) return false;
    const unique = sols.length === 1;
    for (const s of sols) {
      const items = s.map((i) => capped[i]);
      const base = unique ? 0.84 : 0.55;
      const conf = base + (named ? 0.12 : 0) + (unique ? dueBonus(txn, items) : 0);
      out.push(mk(unique ? "subset_unique" : "subset_ambiguous", conf,
        `${items.length} open documents (${items.map((d) => d.number).join(", ")}) add up exactly to ${dollars(amt)}.${named ? ` All belong to a ${party} whose name matches the bank description.` : ""}${unique ? "" : " More than one combination fits — review before applying."}`,
        items.map((d) => mkItem(kind, d, d.balance))));
    }
    return true;
  };
  const namedPool = byDue.filter((d) => nameHit.has(d.id));
  let subsetFound = false;
  if (namedPool.length >= 2) subsetFound = subsetOver(namedPool, true);
  if (!subsetFound && singles.length === 0 && open.length >= 2) subsetFound = subsetOver(byDue, false);

  // 4) Partial payment from a recognised party (never blind)
  if (out.length === 0 && namedPool.length > 0) {
    const target = namedPool.find((d) => amt < d.balance);
    if (target) {
      out.push(mk("partial", namedPool.length === 1 ? 0.72 : 0.6,
        `${dollars(amt)} from a ${party} whose name matches ${namedPool.length === 1 ? target.number : `${namedPool.length} open documents`}; applying as a partial payment to the oldest one (${target.number}, ${dollars(target.balance)} open).`,
        [mkItem(kind, target, amt)]));
    }
  }

  // 5) Card/ACH processor payouts arrive net of fees
  if (allowFees && isProcessorPayout(text, txn.merchantKey) && !out.some((s) => s.confidence >= 0.8)) {
    const pool = byDue.slice(0, 18);
    const hi = Math.ceil(amt * 1.06) + 100;
    const sols = findSubsetsInWindow(pool.map((d) => d.balance), amt, hi, 6, 12)
      .map((s) => {
        const items = s.map((i) => pool[i]);
        const gross = items.reduce((a, d) => a + d.balance, 0);
        const fee = gross - amt;
        const expected = Math.round(gross * 0.029) + 30 * items.length;
        return { items, gross, fee, err: Math.abs(fee - expected), pct: fee / gross };
      })
      .filter((s) => s.fee > 0 && s.pct >= 0.01 && s.pct <= 0.06)
      .sort((a, b) => a.err - b.err)
      .slice(0, 3);
    sols.forEach((s, idx) => {
      out.push(mk("processor_fee", (sols.length === 1 ? 0.72 : 0.5) - idx * 0.02,
        `Processor payout of ${dollars(amt)}: ${s.items.length} open document(s) (${s.items.map((d) => d.number).join(", ")}) total ${dollars(s.gross)}, implying ${dollars(s.fee)} in processing fees (${(s.pct * 100).toFixed(1)}%).`,
        s.items.map((d) => mkItem(kind, d, d.balance)), s.fee));
    });
  }
  void subsetFound;
  return out;
}

function linkPayments(kind: "ar_payment" | "ap_payment", amt: number, txn: MatchTxn, pays: UnlinkedPayment[]): MatchSuggestion[] {
  const want = kind === "ar_payment" ? "ar" : "ap";
  const pool = pays.filter((p) => p.kind === want && Math.abs(daysBetween(txn.postedDate, p.paymentDate)) <= 10);
  if (pool.length === 0) return [];
  const out: MatchSuggestion[] = [];
  const exact = pool.filter((p) => p.amountCents === amt);
  const named = exact.filter((p) => nameSimilarity(txn.name, p.partyName) >= NAME_MATCH);
  for (const p of exact) {
    const nm = named.some((n) => n.id === p.id);
    let conf = 0.88 + (nm ? 0.08 : 0) + (Math.abs(daysBetween(txn.postedDate, p.paymentDate)) <= 3 ? 0.02 : 0);
    if (exact.length > 1 && !(nm && named.length === 1)) conf -= 0.25;
    out.push({
      kind, method: "linked_payment", confidence: clamp(conf),
      explanation: `A payment of ${dollars(p.amountCents)} was already recorded by hand on ${p.paymentDate}${p.partyName ? ` for ${p.partyName}` : ""}; the bank now confirms it.${exact.length > 1 ? " Several recorded payments share this amount — confirm which one." : ""}`,
      matchedCents: p.amountCents, feeCents: 0, unmatchedCents: 0,
      items: [{ paymentId: p.id, amountCents: p.amountCents, label: p.partyName ?? "Recorded payment" }],
    });
  }
  if (out.length === 0 && pool.length >= 2) {
    const sols = findSubsets(pool.map((p) => p.amountCents), amt, 5, 2);
    if (sols.length === 1) {
      const items = sols[0].map((i) => pool[i]);
      out.push({
        kind, method: "linked_payment", confidence: clamp(0.78 + (items.every((p) => nameSimilarity(txn.name, p.partyName) >= NAME_MATCH) ? 0.08 : 0)),
        explanation: `${items.length} manually recorded payments add up exactly to ${dollars(amt)}; the bank now confirms them.`,
        matchedCents: amt, feeCents: 0, unmatchedCents: 0,
        items: items.map((p) => ({ paymentId: p.id, amountCents: p.amountCents, label: p.partyName ?? "Recorded payment" })),
      });
    }
  }
  return out;
}

export function suggestMatches(txn: MatchTxn, ctx: MatchContext): MatchSuggestion[] {
  const amt = Math.abs(txn.amountCents);
  if (amt === 0) return [];
  let all: MatchSuggestion[];
  if (txn.amountCents > 0) {
    all = [
      ...linkPayments("ar_payment", amt, txn, ctx.unlinkedPayments),
      ...suggestDocs("ar", amt, txn, ctx.invoices.map((i) => ({ id: i.id, number: i.number, party: i.customerName, balance: i.balanceCents, due: i.dueDate })), true),
    ];
  } else {
    all = [
      ...linkPayments("ap_payment", amt, txn, ctx.unlinkedPayments),
      ...suggestDocs("ap", amt, txn, ctx.bills.map((b) => ({ id: b.id, number: b.number, party: b.vendorName, balance: b.balanceCents, due: b.dueDate })), false),
    ];
  }
  const seen = new Set<string>();
  const uniq: MatchSuggestion[] = [];
  for (const s of all.sort((a, b) => b.confidence - a.confidence)) {
    const sig = `${s.kind}:${s.items.map((i) => i.invoiceId ?? i.billId ?? i.paymentId).sort().join(",")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniq.push(s);
  }
  return uniq.slice(0, 3);
}

const AUTO_METHODS: MatchMethod[] = ["reference", "exact_single", "subset_unique", "linked_payment"];

/** Autopilot gate: high confidence, evidence-backed method, no competing suggestion, no fees. */
export function isAutoApplicable(suggestions: MatchSuggestion[], threshold: number): boolean {
  const [top, second] = suggestions;
  if (!top) return false;
  if (!AUTO_METHODS.includes(top.method) || top.feeCents > 0 || top.unmatchedCents > 0) return false;
  if (top.confidence < threshold) return false;
  if (second && top.confidence - second.confidence < 0.15) return false;
  return true;
}

export type { MatchKind };
