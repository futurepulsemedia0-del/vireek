// supabase/functions/revenue-realization-run/index.ts
//
// Revenue Realization runner. Detects leaks, scores them, persists them, reconciles resolved ones
// (realized ONLY on confirmed payment/booking) and writes the monthly realization snapshot.
//   • Cron  (X-Cron-Secret = REVENUE_REALIZATION_CRON_SECRET; body {offset?:number}): sweeps accounts.
//   • Owner/team (Authorization: Bearer <jwt>): refreshes ONLY the caller's own account.
//
// Service role bypasses RLS, so EVERY query below is explicitly scoped by user_id.
// This function never bills, messages or edits a customer-facing record. It only reads source tables
// and writes revenue_leaks / revenue_realization_snapshots.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  FORMULA_VERSION, adaptLedger, calibrate, computeRealization, dedupeCandidates, detectAgreementsExpiring, detectDeclinedRisk,
  detectDiscountOverPolicy, detectUnderpriced, detectWarrantyUnfiled, ledgerOutcomes, realizedAmount,
  type FeedbackStats, type LeakCandidate, type LedgerFact, type RealizedProof, type ScoredLeak, type DetectorId, type LeakStatus,
} from "../_shared/revenue-realization/engine.ts";
import {
  capturedByMonth, lineItemsTotalCents, mapAgreements, mapDeclined, mapDiscounts, mapUnderpriced, mapWarranty, monthKey,
  type AgreementRow, type FindingItemRow, type FindingPackageRow, type GuardrailRow, type JobPriceRow, type PriceBookRow,
  type QuoteContactRow, type QuoteStatusRow, type WarrantyRow,
} from "../_shared/revenue-realization/mappers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

type Db = SupabaseClient;
const DAY = 86_400_000;
const PAGE = 1000; // PostgREST default cap; every list query below is bounded by an explicit limit.
const MAX_ACCOUNTS = 100;
const REFRESH_COOLDOWN_MS = 60_000;

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function rows<T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? []) as T[];
}
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

interface ExistingLeak {
  id: string; dedupe_key: string; status: LeakStatus; detector: DetectorId; amount_cents: number; confidence: number;
  pool_key: string; ledger_event_id: string | null; evidence: { table: string; id: string }[]; occurred_at: string;
}

// ------------------------------------------------------------------ detection

async function detect(db: Db, userId: string, now: number): Promise<LeakCandidate[]> {
  const iso = (ms: number) => new Date(ms).toISOString();
  const today = iso(now).slice(0, 10);

  const [open, resolved, items, checks, claims, expiring, jobs, book, feedback] = await Promise.all([
    rows<LedgerFact & Record<string, unknown>>(db.from("revenue_recovery_events")
      .select("id,source_type,source_table,source_id,estimated_value_cents,status,occurred_at,assigned_to,customer_name,recovered_amount_cents,recovered_job_id")
      .eq("user_id", userId).in("status", ["open", "contacted"]).order("occurred_at", { ascending: false }).limit(PAGE * 3), "ledger open"),
    rows<{ source_type: string; status: string }>(db.from("revenue_recovery_events").select("source_type,status")
      .eq("user_id", userId).in("status", ["recovered", "written_off"]).order("occurred_at", { ascending: false }).limit(PAGE * 5), "ledger resolved"),
    rows<FindingItemRow>(db.from("findings_package_items").select("id,package_id,severity,options,recommended_option_id,decided_at")
      .eq("user_id", userId).eq("decision", "declined").in("severity", ["urgent", "recommended"]).gte("decided_at", iso(now - 365 * DAY)).limit(PAGE), "findings"),
    rows<GuardrailRow>(db.from("margin_guardrail_checks").select("id,quote_id,requested_by,revenue_cents,estimated_cost_cents,margin_floor_pct,verdict,override_reason,created_at")
      .eq("user_id", userId).eq("verdict", "overridden").gte("created_at", iso(now - 180 * DAY)).limit(PAGE), "guardrails"),
    rows<WarrantyRow>(db.from("warranty_claims").select("id,job_id,customer_name,status,claimed_amount_cents,part_cost_cents,labor_cost_cents,claim_deadline,created_at")
      .eq("user_id", userId).in("status", ["eligible", "packet_pending"]).limit(PAGE), "warranty"),
    rows<AgreementRow>(db.from("recurring_agreements").select("id,customer_id,customer_name,title,service_type,interval_unit,interval_count,start_date,end_date,price_amount,status,preferred_technician_id")
      .eq("user_id", userId).eq("status", "active").gte("end_date", today).lte("end_date", iso(now + 45 * DAY).slice(0, 10)).limit(PAGE), "agreements"),
    rows<JobPriceRow>(db.from("jobs").select("id,customer_name,service_type,invoice_amount,assigned_technician_id,scheduled_datetime,created_at")
      .eq("user_id", userId).eq("job_status", "completed").in("invoice_status", ["sent", "paid"]).gt("invoice_amount", 0)
      .not("service_type", "is", null).gte("created_at", iso(now - 90 * DAY)).limit(PAGE * 2), "jobs"),
    rows<PriceBookRow>(db.from("price_book_items").select("service_name,pricing_model,price_cents,keywords,active").eq("user_id", userId).eq("active", true).limit(PAGE), "price book"),
    rows<{ detector: string; verdict: string }>(db.from("revenue_leak_feedback").select("detector,verdict").eq("user_id", userId).order("created_at", { ascending: false }).limit(PAGE * 5), "feedback"),
  ]);

  // Joins that depend on the first wave.
  const pkgIds = [...new Set(items.map((i) => i.package_id))];
  const pkgs = (await Promise.all(chunks(pkgIds, 200).map((ids) =>
    rows<FindingPackageRow>(db.from("findings_packages").select("id,job_id,customer_name,customer_email,customer_phone,tax_percent").eq("user_id", userId).in("id", ids), "packages")))).flat();
  const quoteContacts = items.length
    ? await rows<QuoteContactRow>(db.from("quotes").select("customer_email,customer_phone,created_at").eq("user_id", userId).gte("created_at", iso(now - 365 * DAY)).limit(PAGE * 5), "quote contacts")
    : [];
  const quoteIds = [...new Set(checks.map((c) => c.quote_id))];
  const quotes = (await Promise.all(chunks(quoteIds, 200).map((ids) =>
    rows<QuoteStatusRow>(db.from("quotes").select("id,status,customer_name").eq("user_id", userId).in("id", ids), "quotes")))).flat();
  const custIds = [...new Set(expiring.map((a) => a.customer_id).filter((x): x is string => !!x))];
  const siblings = custIds.length
    ? (await Promise.all(chunks(custIds, 200).map((ids) =>
        rows<AgreementRow>(db.from("recurring_agreements").select("id,customer_id,customer_name,title,service_type,interval_unit,interval_count,start_date,end_date,price_amount,status,preferred_technician_id")
          .eq("user_id", userId).eq("status", "active").in("customer_id", ids), "sibling agreements")))).flat()
    : [];

  const stats: FeedbackStats = {};
  for (const f of feedback) {
    const s = (stats[f.detector as DetectorId] ??= { truePositive: 0, falsePositive: 0 });
    if (f.verdict === "true_positive") s.truePositive++; else if (f.verdict === "false_positive") s.falsePositive++;
  }

  const ledgerRows: LedgerFact[] = open.map((r) => ({
    id: r.id, sourceType: String(r["source_type"]), sourceTable: String(r["source_table"]), sourceId: String(r["source_id"]),
    estimatedValueCents: Number(r["estimated_value_cents"]) || 0, status: r.status, occurredAt: String(r["occurred_at"]),
    assignedTo: (r["assigned_to"] as string | null) ?? null, customerName: (r["customer_name"] as string | null) ?? null,
    recoveredAmountCents: null, recoveredJobId: null,
  }));
  const outcomes = ledgerOutcomes(resolved.map((r) => ({ sourceType: r.source_type, status: r.status })));

  const all = [
    ...adaptLedger(ledgerRows, outcomes),
    ...detectDeclinedRisk(mapDeclined(items, pkgs, quoteContacts), now),
    ...detectDiscountOverPolicy(mapDiscounts(checks, quotes)),
    ...detectWarrantyUnfiled(mapWarranty(claims), now),
    ...detectAgreementsExpiring(mapAgreements(expiring, siblings), now),
    ...detectUnderpriced(mapUnderpriced(jobs, book)),
  ];
  // Ledger-linked candidates keep a pointer to their ledger row.
  return dedupeCandidates(calibrate(all, stats));
}

// ------------------------------------------------------------------ persistence + reconciliation

function ledgerIdOf(c: LeakCandidate): string | null {
  return c.evidence.find((e) => e.table === "revenue_recovery_events")?.id ?? null;
}

async function persist(db: Db, userId: string, cands: LeakCandidate[], nowIso: string): Promise<{ upserted: number; kept: ExistingLeak[] }> {
  const existing = await rows<ExistingLeak>(db.from("revenue_leaks")
    .select("id,dedupe_key,status,detector,amount_cents,confidence,pool_key,ledger_event_id,evidence,occurred_at").eq("user_id", userId).in("status", ["open", "in_progress"]).limit(PAGE * 5), "existing leaks");
  const closed = await rows<{ dedupe_key: string }>(db.from("revenue_leaks").select("dedupe_key").eq("user_id", userId)
    .in("status", ["dismissed", "false_positive", "realized"]).limit(PAGE * 10), "closed leaks");
  const closedKeys = new Set(closed.map((c) => c.dedupe_key));
  const statusByKey = new Map(existing.map((e) => [e.dedupe_key, e.status]));

  const out = cands.filter((c) => !closedKeys.has(c.dedupe_key)).map((c) => ({
    user_id: userId, detector: c.detector, dedupe_key: c.dedupe_key, pool_key: c.poolKey, amount_cents: c.amountCents,
    confidence: Number(c.confidence.toFixed(3)), low_sample: c.lowSample, status: statusByKey.get(c.dedupe_key) ?? "open",
    owner_member_id: c.ownerId, technician_id: c.technicianId, source_label: c.source, customer_name: c.customerName,
    evidence: c.evidence, why_key: c.whyKey, why_params: c.whyParams, fix_kind: c.fix, ledger_event_id: ledgerIdOf(c),
    formula_version: FORMULA_VERSION, occurred_at: c.occurredAt, last_detected_at: nowIso,
  }));
  for (const part of chunks(out, 500)) {
    const { error } = await db.from("revenue_leaks").upsert(part, { onConflict: "user_id,dedupe_key" });
    if (error) throw new Error(`upsert leaks: ${error.message}`);
  }
  const live = new Set(cands.map((c) => c.dedupe_key));
  return { upserted: out.length, kept: existing.filter((e) => !live.has(e.dedupe_key)) };
}

/** Leaks whose condition cleared: REALIZED only with proof of money/booking, otherwise EXPIRED. */
async function reconcile(db: Db, userId: string, gone: ExistingLeak[], nowIso: string): Promise<{ realized: number; expired: number }> {
  if (!gone.length) return { realized: 0, expired: 0 };
  const ledgerIds = gone.map((g) => g.ledger_event_id).filter((x): x is string => !!x);
  const ledger = new Map((await Promise.all(chunks(ledgerIds, 200).map((ids) =>
    rows<{ id: string; status: string; recovered_amount_cents: number | null; recovered_job_id: string | null; resolved_at: string | null }>(
      db.from("revenue_recovery_events").select("id,status,recovered_amount_cents,recovered_job_id,resolved_at").eq("user_id", userId).in("id", ids), "ledger proof")))).flat().map((r) => [r.id, r]));
  const claimIds = gone.flatMap((g) => g.evidence.filter((e) => e.table === "warranty_claims").map((e) => e.id));
  const claims = new Map((await Promise.all(chunks(claimIds, 200).map((ids) =>
    rows<{ id: string; credit_received_cents: number | null; credit_received_at: string | null }>(
      db.from("warranty_claims").select("id,credit_received_cents,credit_received_at").eq("user_id", userId).in("id", ids), "warranty proof")))).flat().map((r) => [r.id, r]));
  const actions = await Promise.all(chunks(gone.map((g) => g.id), 200).map((ids) =>
    rows<{ leak_id: string; result: { invoiceId?: string; quoteId?: string } | null }>(
      db.from("revenue_leak_actions").select("leak_id,result").eq("user_id", userId).eq("status", "executed").in("leak_id", ids), "action proof")));
  const actionByLeak = new Map(actions.flat().map((a) => [a.leak_id, a.result ?? {}]));
  const invIds = [...actionByLeak.values()].map((r) => r.invoiceId).filter((x): x is string => !!x);
  const qIds = [...actionByLeak.values()].map((r) => r.quoteId).filter((x): x is string => !!x);
  const invs = new Map((await Promise.all(chunks(invIds, 200).map((ids) =>
    rows<{ id: string; status: string; paid_at: string | null; line_items: unknown; tax_percent: number }>(
      db.from("invoices").select("id,status,paid_at,line_items,tax_percent").eq("user_id", userId).in("id", ids), "invoice proof")))).flat().map((r) => [r.id, r]));
  const qs = new Map((await Promise.all(chunks(qIds, 200).map((ids) =>
    rows<{ id: string; status: string; responded_at: string | null; line_items: unknown; tax_percent: number }>(
      db.from("quotes").select("id,status,responded_at,line_items,tax_percent").eq("user_id", userId).in("id", ids), "quote proof")))).flat().map((r) => [r.id, r]));

  let realized = 0, expired = 0;
  for (const g of gone) {
    let proof: RealizedProof | null = null;
    const l = g.ledger_event_id ? ledger.get(g.ledger_event_id) : undefined;
    if (l && l.status === "recovered" && (l.recovered_amount_cents ?? 0) > 0) {
      proof = { kind: "ledger_recovered", table: "revenue_recovery_events", id: l.id, amountCents: l.recovered_amount_cents as number, at: l.resolved_at ?? nowIso };
    }
    for (const e of g.evidence) {
      const c = e.table === "warranty_claims" ? claims.get(e.id) : undefined;
      if (!proof && c && (c.credit_received_cents ?? 0) > 0) proof = { kind: "warranty_credit", table: "warranty_claims", id: c.id, amountCents: c.credit_received_cents as number, at: c.credit_received_at ?? nowIso };
    }
    const res = actionByLeak.get(g.id);
    const inv = res?.invoiceId ? invs.get(res.invoiceId) : undefined;
    const q = res?.quoteId ? qs.get(res.quoteId) : undefined;
    if (!proof && inv?.status === "paid") proof = { kind: "invoice_paid", table: "invoices", id: inv.id, amountCents: lineItemsTotalCents(inv.line_items, inv.tax_percent), at: inv.paid_at ?? nowIso };
    if (!proof && q?.status === "accepted") proof = { kind: "quote_accepted", table: "quotes", id: q.id, amountCents: lineItemsTotalCents(q.line_items, q.tax_percent), at: q.responded_at ?? nowIso };

    const amount = realizedAmount(proof);
    const patch = amount > 0 && proof
      ? { status: "realized", realized_at: proof.at, realized_amount_cents: amount, realized_proof: proof }
      : { status: "expired" };
    const { error } = await db.from("revenue_leaks").update(patch).eq("id", g.id).eq("user_id", userId).in("status", ["open", "in_progress"]);
    if (error) throw new Error(`reconcile: ${error.message}`);
    if (amount > 0) realized++; else expired++;
  }
  return { realized, expired };
}

// ------------------------------------------------------------------ captured revenue + snapshots

/** Cash actually received. Sources: Stripe payment links, in-person payments, manually recorded invoice payments (non-card, to avoid double counting online card payments). */
async function captured(db: Db, userId: string, fromIso: string): Promise<Record<string, number>> {
  const [pr, jp, ip] = await Promise.all([
    rows<{ amount: number; paid_at: string }>(db.from("payment_requests").select("amount,paid_at").eq("user_id", userId).eq("status", "paid").gte("paid_at", fromIso).limit(PAGE * 10), "payment_requests"),
    rows<{ amount_cents: number; received_at: string }>(db.from("job_payments").select("amount_cents,received_at").eq("user_id", userId).eq("status", "succeeded").gte("received_at", fromIso).limit(PAGE * 10), "job_payments"),
    rows<{ amount_cents: number; paid_at: string }>(db.from("invoice_payments").select("amount_cents,paid_at").eq("user_id", userId).neq("method", "card").gte("paid_at", fromIso).limit(PAGE * 10), "invoice_payments"),
  ]);
  return capturedByMonth([
    ...pr.map((r) => ({ cents: Math.round(Number(r.amount) * 100), at: r.paid_at })),
    ...jp.map((r) => ({ cents: Number(r.amount_cents), at: r.received_at })),
    ...ip.map((r) => ({ cents: Number(r.amount_cents), at: r.paid_at })),
  ]);
}

async function snapshots(db: Db, userId: string, now: number, nowIso: string): Promise<void> {
  const cur = monthKey(nowIso);
  const prevD = new Date(now); prevD.setUTCDate(1); prevD.setUTCMonth(prevD.getUTCMonth() - 1);
  const prev = monthKey(prevD.toISOString());
  const cap = await captured(db, userId, `${prev}T00:00:00Z`);
  const leaks = await rows<{ detector: DetectorId; pool_key: string; amount_cents: number; confidence: number; status: LeakStatus; occurred_at: string; realized_amount_cents: number | null }>(
    db.from("revenue_leaks").select("detector,pool_key,amount_cents,confidence,status,occurred_at,realized_amount_cents").eq("user_id", userId).gte("occurred_at", `${prev}T00:00:00Z`).limit(PAGE * 10), "snapshot leaks");
  for (const m of [prev, cur]) {
    const inMonth = leaks.filter((l) => monthKey(new Date(l.occurred_at).toISOString()) === m);
    const scored: ScoredLeak[] = inMonth.map((l) => ({ poolKey: l.pool_key, detector: l.detector, amountCents: Number(l.amount_cents), confidence: Number(l.confidence), status: l.status }));
    const r = computeRealization(cap[m] ?? 0, scored);
    const realizedCents = inMonth.filter((l) => l.status === "realized").reduce((s, l) => s + Number(l.realized_amount_cents ?? 0), 0);
    const { error } = await db.from("revenue_realization_snapshots").upsert({
      user_id: userId, period_month: m, captured_cents: r.capturedCents, leaked_weighted_cents: r.leakedWeightedCents, leaked_full_cents: r.leakedFullCents,
      leaked_high_confidence_cents: r.leakedHighConfidenceCents, realization_pct: r.pct, realization_pct_low: r.pctLow, realization_pct_high: r.pctHigh,
      realized_cents: realizedCents, by_detector: r.byDetector, formula_version: r.formulaVersion, computed_at: nowIso,
    }, { onConflict: "user_id,period_month" });
    if (error) throw new Error(`snapshot: ${error.message}`);
  }
}

async function runAccount(db: Db, userId: string): Promise<Record<string, number>> {
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const cands = await detect(db, userId, now);
  const { upserted, kept } = await persist(db, userId, cands, nowIso);
  const rec = await reconcile(db, userId, kept, nowIso);
  await snapshots(db, userId, now, nowIso);
  return { detected: cands.length, upserted, ...rec };
}

// ------------------------------------------------------------------ entry

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const body = (await req.json().catch(() => ({}))) as { offset?: number };

  try {
    const cron = req.headers.get("X-Cron-Secret");
    if (cron !== null) {
      const secret = Deno.env.get("REVENUE_REALIZATION_CRON_SECRET");
      if (!secret || !safeEqual(cron, secret)) return json({ error: "Unauthorized." }, 401);
      const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
      const accounts = await rows<{ id: string }>(admin.from("profiles").select("id").order("id").range(offset, offset + MAX_ACCOUNTS - 1), "profiles");
      let failed = 0;
      for (const a of accounts) { try { await runAccount(admin, a.id); } catch (e) { failed++; console.error(JSON.stringify({ event: "rr_account_failed", user: a.id, error: e instanceof Error ? e.message : String(e) })); } }
      return json({ ok: true, processed: accounts.length, failed, nextOffset: accounts.length === MAX_ACCOUNTS ? offset + MAX_ACCOUNTS : null });
    }

    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Unauthorized." }, 401);
    const { data: ownerId, error: ownerErr } = await authClient.rpc("get_account_owner_id");
    if (ownerErr || typeof ownerId !== "string") return json({ error: "Account not found." }, 403);

    const recent = await rows<{ last_detected_at: string }>(admin.from("revenue_leaks").select("last_detected_at").eq("user_id", ownerId).order("last_detected_at", { ascending: false }).limit(1), "cooldown");
    if (recent[0] && Date.now() - Date.parse(recent[0].last_detected_at) < REFRESH_COOLDOWN_MS) return json({ ok: true, cooled: true });
    return json({ ok: true, ...(await runAccount(admin, ownerId)) });
  } catch (e) {
    console.error(JSON.stringify({ event: "rr_run_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Revenue Realization run failed." }, 500);
  }
});
