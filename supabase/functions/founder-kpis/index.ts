// supabase/functions/founder-kpis/index.ts
//
// Founder KPI API (Part B) - PLATFORM STAFF ONLY.
// POST { action: "get", month?: "YYYY-MM", activationDays?: 1..90 }
//    | { action: "upsert_input", month, spendCents, grossMarginBp, platformFeeCents, note? }
// Authorization is enforced three times: JWT required here, `profiles.is_staff` checked here, and every RPC
// re-checks is_vireek_staff(auth.uid()) inside the database. The user's own JWT is used for the RPCs (no service role),
// so a non-staff caller cannot reach the data even if this function had a bug.
// Deploy: supabase functions deploy founder-kpis

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { corsHeaders, json } from "../_shared/data-platform/http.ts";
import {
  activeAccountIds, addMonths, buildLedger, computeActivation, computeAttachRates, computeCacPayback, computeCohortTable,
  computeRetention, computeTakeRate, monthBounds, monthOf, type MrrPoint,
} from "../_shared/analytics/founderKpis.ts";
import { parseFounderRequest } from "../_shared/analytics/request.ts";

const MODULES = ["jobs", "quotes", "invoices", "job_costing", "timesheets"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "Missing Authorization header." }, 401);
    const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false }, global: { headers: { Authorization: auth } },
    });
    const { data: u } = await db.auth.getUser();
    if (!u?.user) return json({ error: "Invalid or expired session." }, 401);
    const { data: staff } = await db.rpc("is_vireek_staff", { uid: u.user.id });
    const { error: gate } = await db.rpc("founder_require_staff");
    if (staff === false || gate) return json({ error: "Platform staff only." }, 403);

    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
    const parsed = parseFounderRequest(body);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const q = parsed.value;

    if (q.action === "upsert_input") {
      const { data, error } = await db.rpc("founder_upsert_cac_input", {
        p_month: q.month, p_spend_cents: q.spendCents, p_gross_margin_bp: q.grossMarginBp, p_platform_fee_cents: q.platformFeeCents, p_note: q.note,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ input: data });
    }

    const now = new Date();
    const thisMonth = now.toISOString().slice(0, 7);
    const month = q.month ?? addMonths(thisMonth, -1);
    if (month > thisMonth) return json({ error: "month is in the future." }, 400);
    const { start, end } = monthBounds(month);
    const asOf = now.toISOString() < end ? now.toISOString() : end;

    const [ledgerRes, signupsRes, usageRes, gpvRes, inputsRes, healthRes] = await Promise.all([
      db.rpc("founder_get_mrr_ledger"),
      db.rpc("founder_get_signups", { p_from: start, p_to: end }),
      db.rpc("founder_get_module_usage", { p_asof: asOf }),
      db.rpc("founder_get_payment_volume", { p_from: start, p_to: end }),
      db.rpc("founder_get_cac_inputs"),
      db.rpc("founder_get_data_health"),
    ]);
    for (const r of [ledgerRes, signupsRes, usageRes, gpvRes, inputsRes, healthRes]) if (r.error) throw new Error(r.error.message);

    const points: MrrPoint[] = (ledgerRes.data ?? []).map((r: { account_key: string; event_at: string; mrr_cents: number }) => ({ accountId: r.account_key, at: r.event_at, mrrCents: Number(r.mrr_cents) }));
    const { ledger, stats } = buildLedger(points);

    const retention = computeRetention(ledger, start, end);
    // 12-month trend (each month computed from the same ledger, so rows reconcile)
    const trend = [] as { month: string; grrBp: number | null; nrrBp: number | null; closingMrrCents: number; newMrrCents: number; churnedCents: number }[];
    for (let i = 11; i >= 0; i--) {
      const m = addMonths(month, -i);
      const b = monthBounds(m);
      const r = computeRetention(ledger, b.start, b.end);
      trend.push({ month: m, grrBp: r.grrBp, nrrBp: r.nrrBp, closingMrrCents: r.closingMrrCents, newMrrCents: r.newMrrCents, churnedCents: r.churnedCents });
    }
    const cohorts = computeCohortTable(ledger, addMonths(month, -11), month, 12, now.toISOString());

    const activation = computeActivation(
      (signupsRes.data ?? []).map((s: { account_key: string; created_at: string; activated_at: string | null }) => ({ accountId: s.account_key, createdAt: s.created_at, activatedAt: s.activated_at })),
      q.activationDays, now.toISOString(), start, end,
    );
    const paying = activeAccountIds(ledger, asOf);
    const attach = computeAttachRates(paying, (usageRes.data ?? []).map((r: { account_key: string; module_key: string }) => ({ accountId: r.account_key, moduleKey: r.module_key })), MODULES);

    const inputs = (inputsRes.data ?? []) as { month: string; spend_cents: number; gross_margin_bp: number; platform_fee_cents: number; note: string | null; updated_at: string }[];
    const input = inputs.find((i) => i.month === month) ?? null;
    const gpv = Number(gpvRes.data ?? 0);
    const takeRate = input ? { ...computeTakeRate(gpv, Number(input.platform_fee_cents)), grossPaymentVolumeCents: gpv, platformFeeCents: Number(input.platform_fee_cents) } : { takeRateBp: null, grossPaymentVolumeCents: gpv, platformFeeCents: null };
    const cac = input
      ? computeCacPayback({ spendCents: Number(input.spend_cents), newCustomers: retention.newAccounts - retention.reactivationAccounts, newMrrCents: retention.newMrrCents, grossMarginBp: Number(input.gross_margin_bp) })
      : null;

    return json({
      month, monthOf: monthOf(Date.parse(start)), retention, trend, cohorts, activation: { ...activation, windowDays: q.activationDays },
      attach, payingAccounts: paying.length, takeRate, cac, inputs, input, dataHealth: healthRes.data, ledgerStats: stats, generated_at: now.toISOString(),
    }, 200, { "Cache-Control": "private, no-store" });
  } catch (err) {
    console.error("[founder-kpis]", err instanceof Error ? err.message : err);
    return json({ error: "Could not compute founder KPIs." }, 500);
  }
});
