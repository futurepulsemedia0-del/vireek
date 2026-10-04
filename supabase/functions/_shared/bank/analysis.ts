// Loads context, runs the matching engine + AI fallback, saves suggestions.
// Never posts to the ledger: posting happens only via bank_apply_reconciliation.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../ai-core/index.ts";
import { suggestAll, HIGH_CONFIDENCE, type BankTxn, type BookedPayment, type OpenDoc, type Suggestion } from "./engine.ts";

export interface AnalysisResult { analyzed: number; suggested: number; high_confidence: number; ai_categorized: number }

// deno-lint-ignore no-explicit-any
const one = (x: any) => (Array.isArray(x) ? x[0] : x) ?? null;
const SINCE_DAYS = 150;

export async function runAnalysis(db: SupabaseClient, ownerId: string): Promise<AnalysisResult> {
  const { data: txRows } = await db.from("bank_transactions")
    .select("id, posted_date, amount_cents, description, merchant_name, bank_accounts!inner(account_type, is_active)")
    .eq("user_id", ownerId).eq("pending", false).eq("currency", "USD")
    .in("match_status", ["unmatched", "suggested"]).eq("bank_accounts.is_active", true)
    .order("posted_date", { ascending: false }).limit(500);
  // deno-lint-ignore no-explicit-any
  const txns: BankTxn[] = (txRows ?? []).map((r: any) => ({
    id: r.id, posted_date: r.posted_date, amount_cents: Number(r.amount_cents), description: r.description ?? "",
    merchant_name: r.merchant_name, account_type: one(r.bank_accounts)?.account_type ?? "depository",
  }));
  if (!txns.length) return { analyzed: 0, suggested: 0, high_confidence: 0, ai_categorized: 0 };

  const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString().slice(0, 10);
  const [inv, bills, arPay, apPay, linked, rulesRes, coa] = await Promise.all([
    db.from("ar_invoices").select("id, invoice_number, issue_date, total_cents, amount_paid_cents, customers(name)").eq("user_id", ownerId).in("status", ["sent", "partially_paid", "overdue"]).limit(1000),
    db.from("ap_bills").select("id, bill_number, bill_date, total_cents, amount_paid_cents, vendors(name)").eq("user_id", ownerId).in("status", ["approved", "partially_paid"]).limit(1000),
    db.from("ar_payments").select("id, amount_cents, payment_date, journal_entry_id, ar_invoices(invoice_number)").eq("user_id", ownerId).gte("payment_date", since).limit(1000),
    db.from("ap_bill_payments").select("id, amount_cents, payment_date, journal_entry_id, ap_bills(bill_number)").eq("user_id", ownerId).gte("payment_date", since).limit(1000),
    db.from("bank_transactions").select("journal_entry_id, match_type, match_refs").eq("user_id", ownerId).eq("match_status", "reconciled"),
    db.from("bank_category_rules").select("merchant_key, category_code").eq("user_id", ownerId),
    db.from("chart_of_accounts").select("code, name, type").eq("user_id", ownerId).eq("is_active", true),
  ]);

  const usedJe = new Set<string>(), usedPay = new Set<string>();
  for (const l of linked.data ?? []) {
    if (l.journal_entry_id) usedJe.add(l.journal_entry_id);
    if (l.match_type === "ar_payment" || l.match_type === "ap_bill_payment") for (const r of (l.match_refs ?? []) as { id: string }[]) usedPay.add(r.id);
  }
  // deno-lint-ignore no-explicit-any
  const docs = (rows: any[] | null, num: string, date: string, partyRel: string): OpenDoc[] => (rows ?? [])
    .map((r) => ({ id: r.id, number: r[num] as string, party: one(r[partyRel])?.name ?? "", balance_cents: Number(r.total_cents) - Number(r.amount_paid_cents), date: r[date] as string }))
    .filter((d) => d.balance_cents > 0);
  // deno-lint-ignore no-explicit-any
  const booked = (rows: any[] | null, rel: string, numField: string): BookedPayment[] => (rows ?? [])
    .filter((r) => !usedPay.has(r.id) && !(r.journal_entry_id && usedJe.has(r.journal_entry_id)))
    .map((r) => ({ id: r.id, amount_cents: Number(r.amount_cents), date: r.payment_date, label: one(r[rel])?.[numField] ?? "Payment" }));

  const accountNames = new Map<string, string>((coa.data ?? []).map((a: { code: string; name: string }) => [a.code, a.name]));
  const results = suggestAll(txns, {
    invoices: docs(inv.data, "invoice_number", "issue_date", "customers"),
    bills: docs(bills.data, "bill_number", "bill_date", "vendors"),
    bookedAr: booked(arPay.data, "ar_invoices", "invoice_number"),
    bookedAp: booked(apPay.data, "ap_bills", "bill_number"),
    rules: new Map((rulesRes.data ?? []).map((r: { merchant_key: string; category_code: string }) => [r.merchant_key, r.category_code])),
    accountNames,
  });

  // ---- AI fallback for withdrawals nothing else could categorize ----
  let aiCount = 0;
  const expenseCodes = (coa.data ?? []).filter((a: { type: string }) => a.type === "expense") as { code: string; name: string }[];
  const leftovers = txns.filter((t) => { const s = results.get(t.id)!; return t.amount_cents < 0 && !s.match_type && !s.category_code; }).slice(0, 40);
  if (leftovers.length && expenseCodes.length) {
    try {
      const allowed = new Set(expenseCodes.map((a) => a.code));
      const ai = await askVireekAi({
        task: "bank_transaction_categorization",
        jsonMode: true,
        maxTokens: 1200,
        temperature: 0,
        extraInstructions: "You are a bookkeeping classifier for a home-service business. Choose ONLY from the allowed account codes. If unsure, use a lower confidence. Return JSON only: {\"items\":[{\"id\":string,\"code\":string,\"confidence\":number}]}.",
        messages: [{
          role: "user",
          content: JSON.stringify({
            allowed: expenseCodes,
            transactions: leftovers.map((t) => ({ id: t.id, text: `${t.merchant_name ?? ""} ${t.description}`.replace(/\d{6,}/g, "#").trim().slice(0, 80), usd: Math.abs(t.amount_cents) / 100 })),
          }),
        }],
      });
      const parsed = JSON.parse(ai.text.replace(/^```(?:json)?|```$/gm, "").trim());
      for (const it of Array.isArray(parsed?.items) ? parsed.items : []) {
        const cur = results.get(String(it?.id));
        if (!cur || cur.match_type || !allowed.has(String(it.code))) continue;
        const conf = Math.min(0.8, Math.max(0.3, Number(it.confidence) || 0.5));
        results.set(String(it.id), { ...cur, match_type: "expense", confidence: conf, reason: `AI-suggested category: ${accountNames.get(String(it.code)) ?? it.code}`, category_code: String(it.code), category_label: accountNames.get(String(it.code)) ?? String(it.code), category_confidence: conf, category_source: "ai" });
        aiCount++;
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "bank_ai_categorization_failed", error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const rows = txns.map((t) => {
    const s: Suggestion = results.get(t.id)!;
    return {
      id: t.id,
      match_status: s.match_type ? "suggested" : "unmatched",
      match_type: s.match_type,
      match_refs: s.refs,
      match_confidence: s.match_type ? s.confidence : null,
      match_reason: s.reason || null,
      category_code: s.category_code,
      category_label: s.category_label,
      category_confidence: s.category_confidence,
      category_source: s.category_source,
    };
  });
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.rpc("bank_save_suggestions", { p_user_id: ownerId, p_rows: rows.slice(i, i + 200) });
    if (error) throw error;
  }
  return {
    analyzed: rows.length,
    suggested: rows.filter((r) => r.match_type).length,
    high_confidence: rows.filter((r) => r.match_type && (r.match_confidence ?? 0) >= HIGH_CONFIDENCE).length,
    ai_categorized: aiCount,
  };
}
