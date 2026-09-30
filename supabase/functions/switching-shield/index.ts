// supabase/functions/switching-shield/index.ts
//
// Customer Switching Shield — Save Customer Agent.
//
// Actions (POST JSON { action, ... }):
//   scan      cron only (X-Cron-Secret) — re-scores every account, opens cases, drafts plans
//   scan_me   signed-in user — re-scores their own account now
//   plan      signed-in user { case_id } — regenerate the save plan for one case
//   execute   signed-in user { action_id, message? } — approve & send an SMS, or mark a call done
//
// Scoring is deterministic SQL (refresh_switching_shield_cases). This function
// only picks offers from fixed rules, writes compliant message templates, and
// asks AI to narrate — AI never chooses amounts, discounts or recipients, and
// no customer message is sent without a human approving it.
//
// DEPLOY: supabase functions deploy switching-shield --no-verify-jwt
// (auth is checked inside; the cron path needs the CRON_SECRET secret).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MAX_ACCOUNTS_PER_RUN = 300;
const MAX_PLANS_PER_ACCOUNT_RUN = 5;
const SMS_COOLDOWN_DAYS = 7;
const SOFT_DEADLINE_MS = 110_000;

type OfferType =
  | "priority_appointment" | "discount" | "free_inspection"
  | "manager_call" | "membership_offer" | "warranty_extension";
type SignalType =
  | "booking_decline" | "complaint" | "price_objection" | "delayed_response" | "low_satisfaction"
  | "unresolved_job" | "repeat_reservice" | "competitor_mention" | "missed_appointment";
type Level = "watch" | "at_risk" | "critical";

interface Signal { type: SignalType; points: number; count: number; detail: string }
interface CaseRow {
  id: string; user_id: string; customer_id: string; risk_score: number; risk_level: Level;
  signals: Signal[]; customer_value_cents: number;
}
interface Settings { max_discount_percent: number; enabled_offers: string[] }
interface Draft { offer_type: OfferType; channel: "sms" | "call_task"; terms: Record<string, unknown>; rationale: string; message: string }

const SIGNAL_LABEL: Record<SignalType, string> = {
  booking_decline: "fewer bookings", complaint: "a complaint", price_objection: "price objections",
  delayed_response: "slow responses", low_satisfaction: "low satisfaction scores", unresolved_job: "an unresolved job",
  repeat_reservice: "repeat service visits", competitor_mention: "competitor comparisons", missed_appointment: "missed appointments",
};

// How strongly each warning sign points toward each offer (higher = better fit).
const AFFINITY: Record<SignalType, Partial<Record<OfferType, number>>> = {
  booking_decline: { membership_offer: 3, free_inspection: 3, priority_appointment: 1 },
  complaint: { manager_call: 4, warranty_extension: 2, free_inspection: 2 },
  price_objection: { discount: 4, membership_offer: 3 },
  delayed_response: { priority_appointment: 4, manager_call: 3 },
  low_satisfaction: { manager_call: 4, free_inspection: 2, warranty_extension: 2 },
  unresolved_job: { priority_appointment: 4, manager_call: 3 },
  repeat_reservice: { warranty_extension: 4, free_inspection: 3, manager_call: 3 },
  competitor_mention: { manager_call: 3, discount: 3, membership_offer: 2 },
  missed_appointment: { priority_appointment: 4, manager_call: 2 },
};

const digits10 = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "").slice(-10);
const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "there";

function discountPercent(level: Level, max: number): number {
  const factor = level === "critical" ? 1 : level === "at_risk" ? 0.7 : 0.4;
  return Math.max(1, Math.min(max, Math.round(max * factor)));
}

function pickOffers(signals: Signal[], level: Level, settings: Settings, hasMembership: boolean): OfferType[] {
  const enabled = new Set(settings.enabled_offers);
  if (settings.max_discount_percent <= 0) enabled.delete("discount");
  if (hasMembership) enabled.delete("membership_offer");

  const scores = new Map<OfferType, number>();
  for (const s of signals) {
    const aff = AFFINITY[s.type] ?? {};
    for (const [offer, weight] of Object.entries(aff) as [OfferType, number][]) {
      if (enabled.has(offer)) scores.set(offer, (scores.get(offer) ?? 0) + s.points * weight);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
  const top = ranked.slice(0, 3);
  if (level === "critical" && enabled.has("manager_call")) {
    return ["manager_call", ...top.filter((o) => o !== "manager_call")].slice(0, 3);
  }
  return top;
}

function buildDraft(offer: OfferType, ctx: { name: string; business: string; level: Level; max: number; why: string }): Draft {
  const hi = `Hi ${ctx.name}, it's ${ctx.business}.`;
  switch (offer) {
    case "discount": {
      const pct = discountPercent(ctx.level, ctx.max);
      return { offer_type: offer, channel: "sms", terms: { percent: pct, valid_days: 14 }, rationale: ctx.why,
        message: `${hi} As a thank-you for being our customer, take ${pct}% off your next service with us in the next 14 days. Just reply to book.` };
    }
    case "free_inspection":
      return { offer_type: offer, channel: "sms", terms: { valid_days: 14 }, rationale: ctx.why,
        message: `${hi} We'd like to give you a complimentary inspection to make sure everything is working the way it should. Reply and we'll find a time that suits you.` };
    case "priority_appointment":
      return { offer_type: offer, channel: "sms", terms: { window_hours: 48 }, rationale: ctx.why,
        message: `${hi} We want to make things right. We're holding a priority appointment slot for you within the next 48 hours. Reply with a time that works and we'll lock it in.` };
    case "membership_offer":
      return { offer_type: offer, channel: "sms", terms: {}, rationale: ctx.why,
        message: `${hi} Our members get priority scheduling and preferred pricing. Would you like us to send you the details? Just reply YES.` };
    case "warranty_extension":
      return { offer_type: offer, channel: "sms", terms: { extra_months: 3 }, rationale: ctx.why,
        message: `${hi} We stand behind our work, and we'd like to extend your warranty by 3 months for your peace of mind. Reply if you'd like to talk it through.` };
    case "manager_call":
    default:
      return { offer_type: "manager_call", channel: "call_task", terms: {}, rationale: ctx.why,
        message: `Personal call from a manager to ${ctx.name}: listen first, acknowledge the specific issue, then offer the next step.` };
  }
}

async function narrate(facts: Record<string, unknown>, fallback: { narrative: string; talk_track: string }) {
  try {
    const r = await askVireekAi({
      task: "switching_shield_plan", jsonMode: true, maxTokens: 500, temperature: 0.3,
      messages: [{ role: "user", content: `Churn-risk facts for one customer, already computed — treat as ground truth:\n${JSON.stringify(facts)}` }],
    });
    const p = JSON.parse(r.text) as { narrative?: unknown; talk_track?: unknown };
    if (typeof p.narrative === "string" && typeof p.talk_track === "string" && p.narrative.trim() && p.talk_track.trim()) {
      return { narrative: p.narrative.trim().slice(0, 600), talk_track: p.talk_track.trim().slice(0, 900) };
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "switching_shield_narrate_failed", error: err instanceof Error ? err.message : String(err) }));
  }
  return fallback;
}

async function generatePlan(admin: SupabaseClient, userId: string, c: CaseRow): Promise<boolean> {
  const [{ data: customer }, { data: settingsRow }, { data: profile }, { data: memberships }] = await Promise.all([
    admin.from("customers").select("id, name, phone").eq("id", c.customer_id).eq("user_id", userId).maybeSingle(),
    admin.from("switching_shield_settings").select("max_discount_percent, enabled_offers").eq("user_id", userId).maybeSingle(),
    admin.from("business_profile").select("company_name").eq("user_id", userId).maybeSingle(),
    admin.from("memberships").select("customer_phone").eq("user_id", userId).eq("status", "active"),
  ]);
  if (!customer) return false;

  const settings: Settings = {
    max_discount_percent: settingsRow?.max_discount_percent ?? 10,
    enabled_offers: settingsRow?.enabled_offers ?? [],
  };
  const pd = digits10(customer.phone);
  const hasMembership = pd !== "" && (memberships ?? []).some((m: { customer_phone: string | null }) => digits10(m.customer_phone) === pd);
  const signals = Array.isArray(c.signals) ? c.signals : [];
  const offers = pickOffers(signals, c.risk_level, settings, hasMembership);
  const name = firstName(customer.name);
  const business = (profile as { company_name?: string } | null)?.company_name || "our team";
  const top = signals[0];
  const why = top ? `Top warning sign: ${top.detail}` : "Elevated churn risk.";

  const drafts = offers.map((o) => buildDraft(o, { name, business, level: c.risk_level, max: settings.max_discount_percent, why }));
  const labels = signals.slice(0, 3).map((s) => SIGNAL_LABEL[s.type] ?? s.type).join(", ");
  const { narrative, talk_track } = await narrate(
    {
      first_name: name, risk_score: c.risk_score, risk_level: c.risk_level,
      customer_value_usd: Math.round((c.customer_value_cents ?? 0) / 100),
      signals: signals.map((s) => ({ type: s.type, points: s.points, count: s.count, detail: s.detail })),
      proposed_offers: drafts.map((d) => ({ offer_type: d.offer_type, terms: d.terms })),
    },
    {
      narrative: `${name} is showing ${signals.length} warning sign${signals.length === 1 ? "" : "s"}${labels ? ` (${labels})` : ""}. ${top ? top.detail : ""}`.trim(),
      talk_track: `Thank ${name} for their business.\nAcknowledge the specific issue.\nOffer the proposed next step.\nAsk what would make this right.`,
    },
  );

  await admin.from("switching_shield_actions").delete().eq("case_id", c.id).eq("status", "proposed");
  if (drafts.length) {
    const { error } = await admin.from("switching_shield_actions").insert(
      drafts.map((d) => ({ ...d, user_id: userId, case_id: c.id, customer_id: c.customer_id })),
    );
    if (error) throw new Error(`insert actions: ${error.message}`);
  }
  const { error: upErr } = await admin.from("switching_shield_cases")
    .update({ narrative, talk_track, plan_generated_at: new Date().toISOString() })
    .eq("id", c.id).eq("user_id", userId);
  if (upErr) throw new Error(`update case: ${upErr.message}`);
  return true;
}

async function planPending(admin: SupabaseClient, userId: string, limit: number): Promise<number> {
  const { data: cases } = await admin.from("switching_shield_cases")
    .select("id, user_id, customer_id, risk_score, risk_level, signals, customer_value_cents")
    .eq("user_id", userId).eq("status", "open").is("plan_generated_at", null)
    .order("risk_score", { ascending: false }).limit(limit);
  let planned = 0;
  for (const c of (cases ?? []) as CaseRow[]) {
    try { if (await generatePlan(admin, userId, c)) planned++; }
    catch (err) { console.error(JSON.stringify({ event: "switching_shield_plan_failed", case_id: c.id, error: err instanceof Error ? err.message : String(err) })); }
  }
  return planned;
}

async function scanAccount(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.rpc("refresh_switching_shield_cases", { p_user_id: userId });
  if (error) throw new Error(error.message);
  const planned = await planPending(admin, userId, MAX_PLANS_PER_ACCOUNT_RUN);
  return { ...(data as Record<string, unknown>), planned };
}

async function executeAction(admin: SupabaseClient, ownerId: string, actorId: string, actionId: string, message?: string) {
  const { data: action } = await admin.from("switching_shield_actions").select("*")
    .eq("id", actionId).eq("user_id", ownerId).maybeSingle();
  if (!action) return { status: 404, body: { error: "Action not found." } };
  if (action.status !== "proposed") return { status: 409, body: { error: "This action was already handled." } };

  const now = new Date().toISOString();
  const text = (message && message.trim() ? message.trim() : String(action.message)).slice(0, 480);
  let ok = true;
  let reason: string | undefined;

  if (action.channel === "sms") {
    const { data: customer } = await admin.from("customers").select("phone").eq("id", action.customer_id).eq("user_id", ownerId).maybeSingle();
    if (!customer?.phone) return { status: 422, body: { error: "This customer has no phone number on file." } };

    const since = new Date(Date.now() - SMS_COOLDOWN_DAYS * 86_400_000).toISOString();
    const { data: recent } = await admin.from("switching_shield_actions").select("id")
      .eq("customer_id", action.customer_id).eq("user_id", ownerId).eq("status", "sent").gte("executed_at", since).limit(1);
    if (recent && recent.length) return { status: 409, body: { error: `This customer was already contacted in the last ${SMS_COOLDOWN_DAYS} days.` } };

    const res = await sendCompliantSms(admin, ownerId, customer.phone, text);
    ok = res.ok;
    if (!res.ok) reason = res.reason;
  }

  if (!ok) {
    // Keep it "proposed" so the owner can fix the cause (e.g. A2P approval) and retry.
    await admin.from("switching_shield_actions").update({ error: reason ?? "unknown" }).eq("id", actionId).eq("user_id", ownerId);
    return { status: 200, body: { ok: false, reason: reason ?? null } };
  }

  await admin.from("switching_shield_actions").update({
    status: action.channel === "sms" ? "sent" : "completed",
    message: text, decided_by: actorId, executed_at: now, error: null,
  }).eq("id", actionId).eq("user_id", ownerId);

  await admin.from("switching_shield_cases").update({ status: "action_pending" })
    .eq("id", action.case_id).eq("user_id", ownerId).eq("status", "open");
  const { error: ledgerErr } = await admin.rpc("append_activity_event", {
    p_aggregate_type: "customer", p_aggregate_id: action.customer_id,
    p_event_type: "switching_shield.action_taken",
    p_event_data: { offer_type: action.offer_type, channel: action.channel },
    p_actor_type: "user", p_user_id: ownerId,
  });
  if (ledgerErr) console.error(JSON.stringify({ event: "switching_shield_ledger_failed", error: ledgerErr.message }));
  return { status: 200, body: { ok: true, reason: null } };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine for scan */ }
  const action = String(body.action ?? "");

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

  try {
    if (action === "scan") {
      const secret = Deno.env.get("CRON_SECRET");
      if (!secret || req.headers.get("X-Cron-Secret") !== secret) return json({ error: "Unauthorized" }, 401);

      const started = Date.now();
      const { data: ids, error } = await admin.rpc("list_switching_shield_accounts");
      if (error) return json({ error: error.message }, 500);
      const results = { accounts: 0, opened: 0, planned: 0, failed: 0 };
      for (const id of ((ids ?? []) as string[]).slice(0, MAX_ACCOUNTS_PER_RUN)) {
        if (Date.now() - started > SOFT_DEADLINE_MS) break;
        try {
          const r = await scanAccount(admin, id);
          results.accounts++;
          results.opened += Number(r.opened ?? 0);
          results.planned += Number(r.planned ?? 0);
        } catch (err) {
          results.failed++;
          console.error(JSON.stringify({ event: "switching_shield_scan_failed", user_id: id, error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return json({ ok: true, ...results });
    }

    // ---- everything below needs a signed-in user ----
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);
    const { data: ownerId } = await authClient.rpc("get_account_owner_id");
    if (!ownerId) return json({ error: "No account found." }, 403);

    if (action === "scan_me") {
      return json({ ok: true, ...(await scanAccount(admin, ownerId as string)) });
    }

    if (action === "plan") {
      const caseId = String(body.case_id ?? "");
      const { data: visible } = await authClient.from("switching_shield_cases").select("id").eq("id", caseId).maybeSingle();
      if (!visible) return json({ error: "Case not found." }, 404);
      const { data: row } = await admin.from("switching_shield_cases")
        .select("id, user_id, customer_id, risk_score, risk_level, signals, customer_value_cents")
        .eq("id", caseId).eq("user_id", ownerId as string).in("status", ["open", "action_pending"]).maybeSingle();
      if (!row) return json({ error: "Only active cases can be re-planned." }, 409);
      await generatePlan(admin, ownerId as string, row as CaseRow);
      return json({ ok: true });
    }

    if (action === "execute") {
      const actionId = String(body.action_id ?? "");
      const { data: visible } = await authClient.from("switching_shield_actions").select("id").eq("id", actionId).maybeSingle();
      if (!visible) return json({ error: "Action not found." }, 404);
      const r = await executeAction(admin, ownerId as string, user.id, actionId, typeof body.message === "string" ? body.message : undefined);
      return json(r.body, r.status);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (err) {
    console.error(JSON.stringify({ event: "switching_shield_error", action, error: err instanceof Error ? err.message : String(err) }));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
});
