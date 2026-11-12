// supabase/functions/results-plan-enroll/index.ts
//
// Owner-only (Authorization: Bearer <jwt>). Opt-in is EXPLICIT; existing subscribers are never migrated automatically.
//   {action:"enroll", never_exceed_flat?:boolean}    creates the draft account on the newest APPROVED terms
//   {action:"start_checkout"}                         Checkout (new customer) — or in-place switch when a flat subscription exists ({confirm:true})
//   {action:"switch_to_flat", price_id?:string}       leaves the Results Plan (only when nothing is still waiting to be billed)
// Env: STRIPE_SECRET_KEY, STRIPE_RESULTS_METERED_PRICE_ID, STRIPE_RESULTS_BASE_PRICE_ID (hybrid), STRIPE_FLAT_PRICE_ID_<PLAN> (for switch_to_flat), SITE_URL, STRIPE_AUTOMATIC_TAX=true (optional).
// Prices are VERIFIED against the approved terms before anything is created (price drift => refuse).

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import Stripe from "npm:stripe@17.4.0";
import { checkoutTaxParams, isAutomaticTaxEnabled, priceTaxVerdict } from "../_shared/billing/stripeTax.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const siteUrl = () => (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) return json({ error: "Unauthorized" }, 401);
  const { data: ownerId } = await userClient.rpc("get_account_owner_id");
  if (!ownerId || ownerId !== u.user.id) return json({ error: "Only the account owner can change billing." }, 403);

  let body: { action?: string; never_exceed_flat?: boolean; confirm?: boolean; price_id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const stripe = stripeKey ? new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() }) : null;

  const { data: prof } = await admin.from("profiles").select("id,email,plan,stripe_customer_id,stripe_subscription_id").eq("id", ownerId).maybeSingle();
  if (!prof) return json({ error: "Profile not found" }, 404);
  const p = prof as { id: string; email: string | null; plan: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null };

  const { data: terms } = await admin.from("results_plan_pricing_terms").select("*").eq("status", "approved").order("approved_at", { ascending: false }).limit(1).maybeSingle();

  if (body.action === "enroll") {
    if (!terms) return json({ error: "The Results Plan is not available yet." }, 409);
    let flat: number | null = null;
    if (stripe && p.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id);
        const price = sub.items.data[0]?.price;
        if (price?.unit_amount) flat = price.recurring?.interval === "year" ? Math.round(price.unit_amount / 12) : price.unit_amount;
      } catch (e) { console.error("results-plan-enroll flat lookup", e instanceof Error ? e.message : e); }
    }
    const t = terms as { id: string; rule_version: string; confirmed_fallback_days: number | null };
    const { error } = await admin.from("results_plan_accounts").upsert({
      user_id: p.id, terms_id: t.id, rule_version: t.rule_version, never_exceed_flat: body.never_exceed_flat !== false, flat_plan_cents: flat, confirmed_fallback_days: t.confirmed_fallback_days, status: "draft", updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) return json({ error: "Could not save." }, 500);
    return json({ ok: true, flat_plan_cents: flat });
  }

  if (!stripe) return json({ error: "Billing is not configured." }, 503);
  const { data: acct } = await admin.from("results_plan_accounts").select("*").eq("user_id", p.id).maybeSingle();
  if (!acct) return json({ error: "Enroll first." }, 409);
  const a = acct as { terms_id: string | null; status: string };

  if (body.action === "start_checkout") {
    if (a.status === "active") return json({ error: "Already active." }, 409);
    const { data: tr } = await admin.from("results_plan_pricing_terms").select("*").eq("id", a.terms_id).eq("status", "approved").maybeSingle();
    if (!tr) return json({ error: "Terms are not approved." }, 409);
    const t = tr as { id: string; model: string; base_fee_cents: number; trial_days: number; currency: string; fair_use_minutes: number | null };
    const meteredId = Deno.env.get("STRIPE_RESULTS_METERED_PRICE_ID");
    const baseId = Deno.env.get("STRIPE_RESULTS_BASE_PRICE_ID");
    if (!meteredId || (t.model === "hybrid" && t.base_fee_cents > 0 && !baseId)) return json({ error: "Billing is not configured." }, 503);
    try {
      const metered = await stripe.prices.retrieve(meteredId);
      const taxEnabled = isAutomaticTaxEnabled(Deno.env.get("STRIPE_AUTOMATIC_TAX"));
      const taxBehaviors: Array<string | null | undefined> = [metered.tax_behavior];
      if (metered.recurring?.usage_type !== "metered" || metered.unit_amount !== 1 || metered.currency !== t.currency.toLowerCase()) return json({ error: "Billing price mismatch." }, 409);
      const items: Array<{ price: string; quantity?: number }> = [];
      if (t.model === "hybrid" && t.base_fee_cents > 0) {
        const base = await stripe.prices.retrieve(baseId!);
        taxBehaviors.push(base.tax_behavior);
        if (base.unit_amount !== t.base_fee_cents || base.currency !== t.currency.toLowerCase() || base.recurring?.interval !== "month") return json({ error: "Billing price mismatch." }, 409);
        items.push({ price: baseId!, quantity: 1 });
      }
      items.push({ price: meteredId });
      if (taxEnabled && taxBehaviors.some((b) => priceTaxVerdict(b) === "inclusive")) return json({ error: "Billing price mismatch." }, 409);
      const meta = { results_plan: "1", supabase_user_id: p.id };

      if (p.stripe_subscription_id) {
        if (body.confirm !== true) return json({ error: "Confirmation required." }, 400);
        const sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id);
        if (!["active", "trialing"].includes(sub.status)) return json({ error: "Your subscription is not active." }, 409);
        await stripe.subscriptions.update(sub.id, {
          items: [...sub.items.data.map((i: { id: string }) => ({ id: i.id, deleted: true as const })), ...items],
          proration_behavior: "create_prorations", payment_behavior: "error_if_incomplete", metadata: { ...sub.metadata, ...meta },
        });
        if (t.fair_use_minutes) await admin.from("profiles").update({ minutes_included: t.fair_use_minutes }).eq("id", p.id);
        await admin.from("results_plan_accounts").update({ status: "active", opted_in_at: new Date().toISOString(), opted_in_by: u.user.id, prior_plan: p.plan, updated_at: new Date().toISOString() }).eq("user_id", p.id);
        return json({ ok: true, switched: true });
      }
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", line_items: items, customer: p.stripe_customer_id ?? undefined, customer_email: p.stripe_customer_id ? undefined : p.email ?? undefined,
        client_reference_id: p.id, metadata: meta,
        subscription_data: { metadata: meta, ...(t.trial_days > 0 ? { trial_period_days: t.trial_days } : {}) },
        ...checkoutTaxParams(taxEnabled, { hasCustomer: Boolean(p.stripe_customer_id), explicitDisabled: true }),
        success_url: `${siteUrl()}/dashboard/results-plan?checkout=success`, cancel_url: `${siteUrl()}/dashboard/results-plan?checkout=cancelled`,
      });
      return json({ ok: true, url: session.url });
    } catch (e) {
      console.error("results-plan-enroll checkout", e instanceof Error ? e.message : e);
      return json({ error: "Could not start checkout." }, 502);
    }
  }

  if (body.action === "switch_to_flat") {
    if (a.status !== "active" && a.status !== "paused") return json({ error: "Not on the Results Plan." }, 409);
    const { count } = await admin.from("results_plan_charges").select("id", { count: "exact", head: true }).eq("user_id", p.id).in("status", ["pending", "failed"]);
    if ((count ?? 0) > 0) return json({ error: "Some verified jobs are still being posted. Try again after the next billing run (about 30 minutes)." }, 409);
    const priceId = body.price_id ?? "";
    const allowed = Object.entries(Deno.env.toObject()).filter(([k]) => k.startsWith("STRIPE_FLAT_PRICE_ID_")).map(([, v]) => v);
    if (!p.stripe_subscription_id || !allowed.includes(priceId)) return json({ error: "Unknown plan." }, 400);
    try {
      const sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id);
      await stripe.subscriptions.update(sub.id, { items: [...sub.items.data.map((i: { id: string }) => ({ id: i.id, deleted: true as const })), { price: priceId, quantity: 1 }], proration_behavior: "create_prorations", payment_behavior: "error_if_incomplete" });
      await admin.from("results_plan_accounts").update({ status: "ended", updated_at: new Date().toISOString() }).eq("user_id", p.id);
      return json({ ok: true });
    } catch (e) {
      console.error("results-plan-enroll switch", e instanceof Error ? e.message : e);
      return json({ error: "Could not switch plans." }, 502);
    }
  }
  return json({ error: "Unknown action" }, 400);
});
