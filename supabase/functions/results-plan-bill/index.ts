// supabase/functions/results-plan-bill/index.ts
//
// Cron (X-Cron-Secret = RESULTS_PLAN_CRON_SECRET). For ACTIVE accounts with APPROVED terms and a healthy subscription:
//   1. prices pending charges chronologically (caps / guarantee / never-more-than-flat) and posts a Stripe Billing Meter event
//      (identifier = rp-<chargeId>, so a retry cannot double-bill inside Stripe's dedupe window),
//   2. issues Stripe customer-balance credits for credited charges,
//   3. raises 50/80/100% cap alerts once per threshold per month.
// If Stripe is not configured the function reports "blocked" and changes NOTHING (no fake billing).
// Env: STRIPE_SECRET_KEY, STRIPE_RESULTS_METER_EVENT, RESULTS_PLAN_CRON_SECRET.
// Stripe setup: a Billing Meter (sum) named by STRIPE_RESULTS_METER_EVENT + a metered Price of 1 minor-currency unit per meter unit.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.4.0";
import { capAlertPct, effectiveCeilingCents, fairUseLevel, inGuarantee, priceNextJob, type PricingTerms } from "../_shared/results-plan/pricing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const BATCH = 25;
const BUDGET_MS = 100_000;
const RETRY_COOLDOWN_MS = 15 * 60_000;
type Admin = SupabaseClient;

interface Account { user_id: string; terms_id: string; never_exceed_flat: boolean; flat_plan_cents: number | null; opted_in_at: string; rule_version: string; last_cap_alert_month: string | null; last_cap_alert_pct: number }
interface TermsRow { id: string; currency: string; model: "hybrid" | "per_job"; base_fee_cents: number; per_job_cents: number; tier_price_cents: Record<string, number>; monthly_floor_cents: number; monthly_cap_cents: number | null; guarantee_days: number; guarantee_cap_cents: number | null; fair_use_minutes: number | null; guarantee_minutes_cap: number | null; status: string }
interface Charge { id: string; job_id: string; status: string; job_type: string | null; verified_at: string; month: string; amount_cents: number | null; updated_at: string }

const toTerms = (t: TermsRow, a: Account): PricingTerms => ({
  model: t.model, baseFeeCents: t.base_fee_cents, perJobCents: t.per_job_cents, tierPriceCents: t.tier_price_cents ?? {},
  monthlyFloorCents: t.monthly_floor_cents, monthlyCapCents: t.monthly_cap_cents,
  neverExceedFlatCents: a.never_exceed_flat ? a.flat_plan_cents : null, guaranteeDays: t.guarantee_days, guaranteeCapCents: t.guarantee_cap_cents,
});

async function append(admin: Admin, a: Account, jobId: string, event: string, key: string, evidence: Record<string, unknown>) {
  const { error } = await admin.rpc("proof_ledger_append", { p_user: a.user_id, p_job: jobId, p_event: event, p_key: key, p_rule: a.rule_version, p_evidence: evidence });
  if (error) throw new Error(`ledger:${error.message}`);
}

async function billAccount(admin: Admin, stripe: Stripe, meterEvent: string, a: Account) {
  const out = { posted: 0, waived: 0, failed: 0, credits: 0 };
  const { data: terms } = await admin.from("results_plan_pricing_terms").select("*").eq("id", a.terms_id).eq("status", "approved").maybeSingle();
  if (!terms) return { ...out, skipped: "terms_not_approved" };
  const t = terms as TermsRow;
  const { data: prof } = await admin.from("profiles").select("stripe_customer_id,subscription_status,minutes_used_this_month").eq("id", a.user_id).maybeSingle();
  const customerId = (prof as { stripe_customer_id: string | null } | null)?.stripe_customer_id;
  const subStatus = (prof as { subscription_status: string | null } | null)?.subscription_status;
  if (!customerId) return { ...out, skipped: "no_customer" };
  if (subStatus && !["active", "trialing"].includes(subStatus)) return { ...out, skipped: `subscription_${subStatus}` };
  const pricing = toTerms(t, a);

  // Charges under an open dispute stay pending until a human decides.
  const { data: open } = await admin.from("results_plan_disputes").select("charge_id").eq("user_id", a.user_id).eq("status", "open");
  const blocked = new Set(((open ?? []) as Array<{ charge_id: string }>).map((d) => d.charge_id));

  const { data: todo } = await admin.from("results_plan_charges").select("id,job_id,status,job_type,verified_at,month,amount_cents,updated_at")
    .eq("user_id", a.user_id).in("status", ["pending", "failed"]).order("verified_at", { ascending: true }).limit(200);
  const posted = new Map<string, number>(); // month -> cents already posted (credited ones no longer count)
  const loadMonth = async (m: string) => {
    if (posted.has(m)) return;
    const { data } = await admin.from("results_plan_charges").select("amount_cents").eq("user_id", a.user_id).eq("month", m).eq("status", "posted");
    posted.set(m, ((data ?? []) as Array<{ amount_cents: number | null }>).reduce((s, r) => s + (r.amount_cents ?? 0), 0));
  };

  for (const c of (todo ?? []) as Charge[]) {
    if (blocked.has(c.id)) continue;
    if (c.status === "failed" && Date.now() - Date.parse(c.updated_at) < RETRY_COOLDOWN_MS) continue;
    await loadMonth(c.month);
    const charged = posted.get(c.month) ?? 0;
    const d = priceNextJob(pricing, { chargedCents: charged, startedAt: a.opted_in_at }, c.job_type, c.verified_at);
    const stamp = new Date().toISOString();
    await admin.from("results_plan_charges").update({ list_price_cents: d.listPriceCents, amount_cents: d.amountCents, bound_by: d.boundBy, terms_id: t.id, updated_at: stamp }).eq("id", c.id).eq("user_id", a.user_id);
    try {
      let identifier: string | null = null;
      if (d.amountCents > 0) {
        identifier = `rp-${c.id}`;
        await stripe.billing.meterEvents.create({ event_name: meterEvent, identifier, payload: { stripe_customer_id: customerId, value: String(d.amountCents) } });
      }
      const { error: upErr } = await admin.from("results_plan_charges").update({ status: "posted", posted_at: stamp, stripe_meter_identifier: identifier, failure_reason: null, updated_at: stamp }).eq("id", c.id).eq("user_id", a.user_id).in("status", ["pending", "failed"]);
      if (upErr) throw new Error(upErr.message);
      await append(admin, a, c.job_id, "charge_posted", `charge:${c.id}`, { charge_id: c.id, amount_cents: d.amountCents, list_price_cents: d.listPriceCents, bound_by: d.boundBy, terms_id: t.id, currency: t.currency });
      posted.set(c.month, charged + d.amountCents);
      if (d.amountCents > 0) out.posted++; else out.waived++;
    } catch (e) {
      out.failed++;
      await admin.from("results_plan_charges").update({ status: "failed", failure_reason: (e instanceof Error ? e.message : "stripe_error").slice(0, 300), updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", a.user_id);
    }
  }

  // Credits (auto, reviewer, or cancellation inside the window): Stripe customer balance, once per charge.
  const { data: cr } = await admin.from("results_plan_charges").select("id,amount_cents").eq("user_id", a.user_id).eq("status", "credited").is("stripe_balance_txn_id", null).gt("amount_cents", 0).limit(100);
  for (const c of (cr ?? []) as Array<{ id: string; amount_cents: number }>) {
    try {
      const txn = await stripe.customers.createBalanceTransaction(customerId, { amount: -c.amount_cents, currency: t.currency.toLowerCase(), description: "Vireek Results Plan credit", metadata: { charge_id: c.id } }, { idempotencyKey: `rp-credit-${c.id}` });
      await admin.from("results_plan_charges").update({ stripe_balance_txn_id: txn.id, updated_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", a.user_id);
      out.credits++;
    } catch (e) { console.error("results-plan-bill credit failed", c.id, e instanceof Error ? e.message : e); }
  }

  // Cap alerts (once per threshold per month).
  const month = new Date().toISOString().slice(0, 7);
  const ceiling = effectiveCeilingCents(pricing);
  if (ceiling !== null) {
    await loadMonth(month);
    const pct = capAlertPct(posted.get(month) ?? 0, ceiling);
    const last = a.last_cap_alert_month === month ? a.last_cap_alert_pct : 0;
    if (pct > last) {
      await admin.from("ai_insights").insert({
        user_id: a.user_id, insight_type: "alert", title: `Results Plan: ${pct}% of this month's spending limit used`,
        description: pct >= 100 ? "You reached your monthly limit. Further verified jobs this month are free." : `You have used ${pct}% of your monthly Results Plan limit.`,
      });
      await admin.from("results_plan_accounts").update({ last_cap_alert_month: month, last_cap_alert_pct: pct }).eq("user_id", a.user_id);
    }
  }

  // Fair-use minutes: staff flag at 80%/100%, owner notice at 100% (answering is never cut off automatically).
  const used = Number((prof as { minutes_used_this_month: number | null } | null)?.minutes_used_this_month ?? 0);
  const inGuar = inGuarantee(pricing, { chargedCents: 0, startedAt: a.opted_in_at }, new Date().toISOString());
  const limit = inGuar && t.guarantee_minutes_cap ? t.guarantee_minutes_cap : t.fair_use_minutes;
  const lvl = fairUseLevel(used, limit);
  if (lvl > 0) {
    const mon = new Date(); mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
    const { error: fe } = await admin.from("results_plan_flags").upsert({
      user_id: a.user_id, code: "fair_use_minutes", severity: lvl === 100 ? "high" : "warn",
      detail: `${Math.round(used)} of ${limit} fair-use minutes used (${lvl}%).`, week_start: mon.toISOString().slice(0, 10),
    }, { onConflict: "user_id,code,week_start" });
    if (fe) console.error("results-plan-bill fair-use flag failed", fe.message);
    if (lvl === 100) {
      const title = "Results Plan: fair-use minutes reached";
      const { count } = await admin.from("ai_insights").select("id", { count: "exact", head: true }).eq("user_id", a.user_id).eq("title", title).gte("created_at", `${month}-01T00:00:00Z`);
      if ((count ?? 0) === 0) {
        await admin.from("ai_insights").insert({ user_id: a.user_id, insight_type: "alert", title, description: "You have used your monthly fair-use call minutes. Our team will contact you to review your plan." });
      }
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("RESULTS_PLAN_CRON_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  const meterEvent = Deno.env.get("STRIPE_RESULTS_METER_EVENT");
  if (!key || !meterEvent) return json({ blocked: "stripe_not_configured", detail: "Set STRIPE_SECRET_KEY and STRIPE_RESULTS_METER_EVENT. Nothing was billed." });
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: accounts, error } = await admin.from("results_plan_accounts")
    .select("user_id,terms_id,never_exceed_flat,flat_plan_cents,opted_in_at,rule_version,last_cap_alert_month,last_cap_alert_pct")
    .eq("status", "active").not("terms_id", "is", null).not("opted_in_at", "is", null).limit(BATCH);
  if (error) return json({ error: error.message }, 500);

  const started = Date.now();
  const results: Array<Record<string, unknown>> = [];
  for (const a of (accounts ?? []) as Account[]) {
    if (Date.now() - started > BUDGET_MS) break;
    try { results.push({ user_id: a.user_id, ...(await billAccount(admin, stripe, meterEvent, a)) }); }
    catch (e) { console.error("results-plan-bill account failed", a.user_id, e instanceof Error ? e.message : e); results.push({ user_id: a.user_id, error: true }); }
  }
  return json({ processed: results.length, results });
});
