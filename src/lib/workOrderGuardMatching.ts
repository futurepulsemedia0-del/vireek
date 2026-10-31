// src/lib/workOrderGuardMatching.ts
//
// Matches APPROVED work-order invoices to bank deposits by reusing the existing, audited
// supabase/functions/_shared/bank/matching.ts (suggestMatches). This file only adapts shapes:
// approved work orders -> OpenInvoice, bank_transactions -> MatchTxn. Nothing here writes anywhere;
// the user confirms a suggestion and the wog_deposit_match_apply RPC stores it.

import { suggestMatches } from '../../supabase/functions/_shared/bank/matching';
import type { MatchSuggestion, MatchTxn, OpenInvoice } from '../../supabase/functions/_shared/bank/types';
import { addDays, localDate, type WorkOrder } from '@/lib/workOrderGuard';

export interface DepositTxn {
  id: string;
  amountCents: number;
  postedDate: string; // YYYY-MM-DD
  name: string;
  merchantKey: string | null;
}

export interface DepositSuggestion {
  txn: DepositTxn;
  suggestion: MatchSuggestion;
  orders: WorkOrder[];
}

/** Methods that map cleanly onto "whole invoices paid by one deposit" (a partial payment cannot be applied). */
const APPLICABLE = new Set(['reference', 'exact_single', 'subset_unique', 'subset_ambiguous', 'processor_fee']);

export const isMatchable = (o: WorkOrder): boolean => o.outcome === 'approved' && (o.invoiceTotalCents ?? 0) > 0 && Boolean(o.id);

export function suggestDeposits(
  orders: WorkOrder[],
  txns: DepositTxn[],
  opts: { payerName: string | null; timezone: string; paymentTermsDays: number },
): DepositSuggestion[] {
  const pool = orders.filter(isMatchable);
  const byId = new Map(pool.map((o) => [o.id as string, o]));
  const claimed = new Set<string>();
  const out: DepositSuggestion[] = [];

  const invoiceOf = (o: WorkOrder): OpenInvoice => ({
    id: o.id as string,
    number: o.invoiceNumber ?? o.woNumber,
    customerId: null,
    customerName: opts.payerName,
    balanceCents: o.invoiceTotalCents as number,
    dueDate: addDays(localDate(o.invoiceSubmittedAt ?? o.completedAt ?? o.receivedAt, opts.timezone), opts.paymentTermsDays),
  });

  for (const t of [...txns].filter((x) => x.amountCents > 0).sort((a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id))) {
    const open = pool.filter((o) => !claimed.has(o.id as string)).map(invoiceOf);
    if (open.length === 0) break;
    const txn: MatchTxn = { id: t.id, amountCents: t.amountCents, postedDate: t.postedDate, name: t.name, merchantKey: t.merchantKey };
    const top = suggestMatches(txn, { invoices: open, bills: [], unlinkedPayments: [] }).find((s) => APPLICABLE.has(s.method));
    if (!top) continue;
    const ids = top.items.map((i) => i.invoiceId).filter((x): x is string => Boolean(x));
    const matched = ids.map((id) => byId.get(id)).filter((o): o is WorkOrder => Boolean(o));
    if (matched.length === 0 || matched.length !== ids.length) continue;
    ids.forEach((id) => claimed.add(id));
    out.push({ txn: t, suggestion: top, orders: matched });
  }
  return out;
}
