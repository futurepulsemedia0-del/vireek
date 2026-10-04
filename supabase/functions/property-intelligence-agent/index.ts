// supabase/functions/property-intelligence-agent/index.ts
//
// Property Intelligence OS — the autonomous physical-world loop.
//
//   Telemetry -> Predict -> Diagnose -> Check/Reserve Part -> Quote & Notify Customer
//             -> Customer Approves -> Schedule (before failure) -> Dispatch Technician
//             -> Repair -> Verify -> Learn
//
// One idempotent pass per run (schedule hourly). Every step is a state transition on
// pio_missions guarded by a unique "one open mission per unit" index, so a crashed or
// overlapping run can only repeat guarded work, never duplicate it.
//
// Safety model
//   * Probabilities come from the deterministic model in _shared/property-intelligence.
//   * Customer outreach / parts reservation / dispatch pass through Agent Governance
//     (slugs pio_customer_outreach, pio_parts_reserve, pio_dispatch). Outreach defaults
//     to owner approval — approve in Dashboard -> Agent Governance.
//   * Prices come ONLY from the owner's price book. No match = no quote, never an invented number.
//   * SMS goes through sendCompliantSms (A2P + DNC/STOP). Cooldown per customer.
//   * The agent never claims a part is reserved unless a reservation row really exists.
//
// Auth: cron -> header X-Cron-Secret (CRON_SECRET must be set), all accounts.
//       app  -> Authorization: Bearer <user JWT>, that account only ("Run now").
// Deploy: supabase functions deploy property-intelligence-agent --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { authorizeAgentAction, recordAgentActionOutcome } from "../_shared/governance/agentGovernance.ts";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { assignBestTechnician } from "../_shared/dispatch/assign.ts";
import {
  calibrationFactor,
  computePredictions,
  explainPrediction,
  FAILURE_MODES,
  friendlyEquipment,
  MISSION_MIN_CONFIDENCE,
  MISSION_MIN_PROBABILITY,
  type EquipmentContext,
  type MetricFeature,
  type Prediction,
} from "../_shared/property-intelligence/model.ts";

type Admin = ReturnType<typeof createClient>;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const DAY = 86_400_000;
const MAX_NEW_MISSIONS_PER_ACCOUNT = 25;
const MAX_OUTREACH_PER_ACCOUNT = 20;
const QUOTE_VALID_DAYS = 14;
const OFFLINE_AFTER_HOURS = 6;
const LOW_BATTERY_PCT = 15;
const ESCALATE_AFTER_HOURS = 24;

interface Counts {
  accounts: number; predictions: number; missions_opened: number; parts_reserved: number;
  quoted: number; awaiting_approval: number; scheduled: number; dispatched: number;
  repaired: number; verified: number; declined: number; expired: number; blocked: number; alerts: number;
}
const newCounts = (): Counts => ({
  accounts: 0, predictions: 0, missions_opened: 0, parts_reserved: 0, quoted: 0, awaiting_approval: 0,
  scheduled: 0, dispatched: 0, repaired: 0, verified: 0, declined: 0, expired: 0, blocked: 0, alerts: 0,
});

function histAppend(hist: unknown, stage: string, note?: string) {
  const arr = Array.isArray(hist) ? hist : [];
  return [...arr, { stage, at: new Date().toISOString(), ...(note ? { note } : {}) }];
}

async function advance(admin: Admin, mission: Row, patch: Row, stage?: string, note?: string) {
  const update: Row = { ...patch, updated_at: new Date().toISOString() };
  if (stage && stage !== mission.stage) {
    update.stage = stage;
    update.stage_history = histAppend(mission.stage_history, stage, note);
    if (["verified", "declined", "dismissed", "expired"].includes(stage)) update.completed_at = new Date().toISOString();
  }
  const { error } = await admin.from("pio_missions").update(update).eq("id", mission.id);
  if (error) console.error(JSON.stringify({ event: "pio_advance_failed", mission_id: mission.id, error: error.message }));
  Object.assign(mission, update);
}

async function notify(admin: Admin, userId: string, title: string, message: string, actionUrl: string) {
  const { error } = await admin.from("notifications").insert({ user_id: userId, type: "property_intelligence", title, message, action_url: actionUrl });
  if (error) console.error(JSON.stringify({ event: "pio_notify_failed", error: error.message }));
}

async function releaseReservation(admin: Admin, mission: Row, status: "released" | "fulfilled") {
  if (!mission.reservation_id) return;
  await admin.from("inventory_reservations")
    .update({ status, released_at: new Date().toISOString() }).eq("id", mission.reservation_id).eq("status", "active");
}

/** Earliest business-hours slot at/after `from + minOffsetDays` (mirrors the home-health agent). */
function pickSlot(hours: Row | null, from: Date, minOffsetDays: number): Date {
  const keys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (let i = minOffsetDays; i <= minOffsetDays + 21; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i));
    const cfg = hours ? hours[keys[d.getUTCDay()]] : null;
    let hour = 9;
    if (hours && Object.keys(hours).length > 0) {
      if (!cfg || cfg.closed || !cfg.open) continue;
      const openH = parseInt(String(cfg.open).split(":")[0], 10);
      const closeH = cfg.close ? parseInt(String(cfg.close).split(":")[0], 10) : 24;
      if (Number.isNaN(openH)) continue;
      hour = openH + 1;
      if (hour >= closeH) hour = openH;
    } else if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      continue;
    }
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  }
  const fallback = new Date(from.getTime() + (minOffsetDays + 1) * DAY);
  fallback.setUTCHours(9, 0, 0, 0);
  return fallback;
}

function matchPriceItem(items: Row[], keywords: string[]): Row | null {
  const repair = /repair|replace|install|diagnos|service|fix|recharge/i;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    for (const item of items) {
      const text = `${item.service_name ?? ""} ${(item.keywords ?? []).join(" ")} ${item.category ?? ""}`.toLowerCase();
      if (text.includes(k) && repair.test(text)) return item;
    }
  }
  return null;
}

const sanitizeKw = (s: string) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim();

/** Find the part for a failure mode: owner's explicit map first, then keyword match on inventory. */
async function findPart(admin: Admin, userId: string, eq: Row, pred: Row, keywords: string[]): Promise<{ part: Row; qty: number } | null> {
  const { data: maps } = await admin.from("pio_part_map")
    .select("part_id, quantity, equipment_type_pattern").eq("user_id", userId).eq("failure_mode", pred.failure_mode);
  for (const m of (maps ?? []) as Row[]) {
    const pat = (m.equipment_type_pattern as string | null)?.replace(/%/g, "").toLowerCase();
    if (pat && !String(eq.equipment_type).toLowerCase().includes(pat)) continue;
    const { data: part } = await admin.from("inventory_parts").select("id, name, part_number, unit_cost_cents").eq("id", m.part_id).eq("active", true).maybeSingle();
    if (part) return { part: part as Row, qty: m.quantity as number };
  }
  const kws = keywords.map(sanitizeKw).filter((k) => k.length >= 3);
  if (kws.length === 0) return null;
  const filter = kws.flatMap((k) => [`name.ilike.%${k}%`, `category.ilike.%${k}%`, `part_number.ilike.%${k}%`]).join(",");
  const { data } = await admin.from("inventory_parts").select("id, name, part_number, unit_cost_cents")
    .eq("user_id", userId).eq("active", true).or(filter).limit(10);
  const rows = (data ?? []) as Row[];
  // Prefer the part whose name matches the make, then the first keyword (keywords are ordered by relevance).
  const make = String(eq.make ?? "").toLowerCase();
  const best = rows.find((p) => make && String(p.name).toLowerCase().includes(make)) ?? rows[0];
  return best ? { part: best, qty: 1 } : null;
}

// ---------------------------------------------------------------------------
async function processAccount(admin: Admin, userId: string, siteUrl: string, counts: Counts) {
  const now = new Date();
  const nowIso = now.toISOString();

  // ---------- 1. PREDICT -----------------------------------------------------
  const { data: featRows, error: fErr } = await admin.rpc("pio_equipment_features", { p_user_id: userId });
  if (fErr) throw new Error(`features: ${fErr.message}`);
  const features = (featRows ?? []) as MetricFeature[];
  const eqIds = [...new Set(features.map((f) => f.equipment_id))];

  const equipment = new Map<string, Row>();
  for (let i = 0; i < eqIds.length; i += 100) {
    const { data } = await admin.from("equipment")
      .select("id, customer_id, equipment_type, make, model, install_date, last_service_date, expected_lifespan_years, service_interval_months")
      .eq("user_id", userId).eq("status", "active").in("id", eqIds.slice(i, i + 100));
    for (const e of (data ?? []) as Row[]) equipment.set(e.id, e);
  }

  const { data: calRows } = await admin.from("pio_calibration").select("failure_mode, total, confirmed").eq("user_id", userId);
  const calibration = new Map<string, number>(((calRows ?? []) as Row[]).map((c) => [c.failure_mode, calibrationFactor(c.confirmed, c.total)]));

  const { data: activePreds } = await admin.from("pio_predictions").select("id, equipment_id, failure_mode").eq("user_id", userId).eq("status", "active");
  const existingPred = new Map<string, string>(((activePreds ?? []) as Row[]).map((p) => [`${p.equipment_id}|${p.failure_mode}`, p.id]));
  const seen = new Set<string>();
  const top = new Map<string, { pred: Prediction; id: string }>();

  for (const [eqId, eq] of equipment) {
    const preds = computePredictions(eq as EquipmentContext, features.filter((f) => f.equipment_id === eqId), calibration, now);
    const hasFresh = features.some((f) => f.equipment_id === eqId && f.n_recent >= 12);
    for (const p of preds) {
      const key = `${eqId}|${p.failure_mode}`;
      seen.add(key);
      const body = {
        label: p.label, probability: p.probability, raw_probability: p.raw_probability, confidence: p.confidence,
        horizon_days_min: p.horizon_days_min, horizon_days_max: p.horizon_days_max, predicted_failure_at: p.predicted_failure_at,
        severity: p.severity, probable_cause: p.probable_cause, evidence: p.evidence, lifecycle_prior: p.lifecycle_prior,
        model_version: p.model_version, updated_at: nowIso,
      };
      let id = existingPred.get(key);
      if (id) {
        await admin.from("pio_predictions").update(body).eq("id", id);
      } else {
        const { data, error } = await admin.from("pio_predictions")
          .insert({ ...body, user_id: userId, customer_id: eq.customer_id, equipment_id: eqId, failure_mode: p.failure_mode })
          .select("id").single();
        if (error || !data) { if (error?.code !== "23505") console.error(JSON.stringify({ event: "pio_pred_insert_failed", error: error?.message })); continue; }
        id = data.id as string;
      }
      counts.predictions++;
      if (!top.has(eqId)) top.set(eqId, { pred: p, id });
    }
    // Healthy again (with fresh data to prove it): close predictions that no longer fire.
    if (hasFresh) {
      for (const [key, id] of existingPred) {
        if (key.startsWith(`${eqId}|`) && !seen.has(key)) {
          await admin.from("pio_predictions").update({ status: "resolved", resolved_at: nowIso, updated_at: nowIso }).eq("id", id).eq("status", "active");
        }
      }
    }
  }

  // ---------- 2. OPEN MISSIONS -------------------------------------------------
  const { data: openRows } = await admin.from("pio_missions").select("equipment_id")
    .eq("user_id", userId).not("stage", "in", "(verified,declined,dismissed,expired)");
  const hasOpen = new Set(((openRows ?? []) as Row[]).map((m) => m.equipment_id));
  let opened = 0;
  for (const [eqId, { pred, id }] of top) {
    if (opened >= MAX_NEW_MISSIONS_PER_ACCOUNT) break;
    if (hasOpen.has(eqId) || pred.probability < MISSION_MIN_PROBABILITY || pred.confidence < MISSION_MIN_CONFIDENCE) continue;
    const eq = equipment.get(eqId)!;
    const deadline = new Date(Math.max(now.getTime() + DAY, now.getTime() + pred.horizon_days_min * DAY));
    const { error } = await admin.from("pio_missions").insert({
      user_id: userId, customer_id: eq.customer_id, equipment_id: eqId, prediction_id: id, failure_mode: pred.failure_mode,
      urgency: pred.severity === "critical" ? "critical" : "high",
      headline: `${friendlyEquipment(eq as EquipmentContext)}: ${Math.round(pred.probability * 100)}% chance of ${pred.label.toLowerCase()} in ${pred.horizon_days_min}–${pred.horizon_days_max} days`,
      explanation: explainPrediction(pred, eq as EquipmentContext), probability: pred.probability, deadline_at: deadline.toISOString(),
      stage_history: [{ stage: "detected", at: nowIso, note: `model ${pred.model_version}` }],
    });
    if (error) { if (error.code !== "23505") console.error(JSON.stringify({ event: "pio_mission_insert_failed", error: error.message })); continue; }
    opened++; counts.missions_opened++;
  }

  // ---------- load context for transitions ------------------------------------
  const { data: missionRows } = await admin.from("pio_missions").select("*")
    .eq("user_id", userId).in("stage", ["detected", "awaiting_customer", "scheduled", "dispatched", "repaired"]);
  const missions = (missionRows ?? []) as Row[];
  if (missions.length > 0) {
    const missionEqIds = [...new Set(missions.map((m) => m.equipment_id as string))].filter((id) => !equipment.has(id));
    if (missionEqIds.length > 0) {
      const { data } = await admin.from("equipment")
        .select("id, customer_id, equipment_type, make, model, install_date, last_service_date, expected_lifespan_years, service_interval_months")
        .in("id", missionEqIds);
      for (const e of (data ?? []) as Row[]) equipment.set(e.id, e);
    }
    const customerIds = [...new Set(missions.map((m) => m.customer_id as string))];
    const { data: custRows } = await admin.from("customers").select("id, name, phone, email, address").in("id", customerIds);
    const customers = new Map<string, Row>(((custRows ?? []) as Row[]).map((c) => [c.id, c]));
    const predIds = missions.map((m) => m.prediction_id).filter(Boolean) as string[];
    const { data: pRows } = await admin.from("pio_predictions").select("id, failure_mode, label, probability, horizon_days_min, horizon_days_max, probable_cause").in("id", predIds);
    const preds = new Map<string, Row>(((pRows ?? []) as Row[]).map((p) => [p.id, p]));
    const { data: profile } = await admin.from("profiles").select("company_name").eq("id", userId).maybeSingle();
    const business = (profile?.company_name as string | undefined) || "Your service team";
    const { data: bp } = await admin.from("business_profile").select("business_hours").eq("user_id", userId).maybeSingle();
    const { data: priceRows } = await admin.from("price_book_items").select("service_name, category, keywords, price_cents, sort_order").eq("user_id", userId).eq("active", true).order("sort_order");
    const priceItems = (priceRows ?? []) as Row[];

    const recent = new Map<string, number>();
    const { data: recentRows } = await admin.from("pio_missions").select("customer_id, customer_notified_at").eq("user_id", userId).gte("customer_notified_at", new Date(now.getTime() - 3 * DAY).toISOString());
    for (const r of (recentRows ?? []) as Row[]) recent.set(r.customer_id, Math.max(recent.get(r.customer_id) ?? 0, new Date(r.customer_notified_at).getTime()));
    let outreachSent = 0;

    for (const mission of missions) {
      try {
        const customer = customers.get(mission.customer_id);
        const eq = equipment.get(mission.equipment_id);
        const pred = preds.get(mission.prediction_id);
        if (!customer || !eq || !pred) continue;
        const friendly = friendlyEquipment(eq as EquipmentContext);
        const kws = FAILURE_MODES.find((m) => m.key === mission.failure_mode);

        // ---------- 3. DIAGNOSE -> PART CHECK & RESERVE -----------------------
        if (mission.stage === "detected" && mission.part_status === "unchecked") {
          const found = await findPart(admin, userId, eq, mission, kws?.partKeywords ?? []);
          if (!found) {
            await advance(admin, mission, { part_status: "not_found" });
          } else {
            const { part, qty } = found;
            const { data: levels } = await admin.from("inventory_stock_levels")
              .select("location_id, quantity_on_hand, quantity_reserved, inventory_locations!inner(active)")
              .eq("part_id", part.id).eq("inventory_locations.active", true);
            const best = ((levels ?? []) as Row[])
              .map((l) => ({ location_id: l.location_id as string, avail: (l.quantity_on_hand ?? 0) - (l.quantity_reserved ?? 0) }))
              .sort((a, b) => b.avail - a.avail)[0];
            if (best && best.avail >= qty) {
              const auth = await authorizeAgentAction(admin, {
                userId, actionSlug: "pio_parts_reserve", agentSource: "property-intelligence-agent",
                targetTable: "pio_missions", targetId: mission.id,
                reasoning: `Reserve ${qty} × ${part.name} for a predicted ${pred.label.toLowerCase()} on ${friendly}.`,
              });
              if (auth.decision === "pending_approval") { counts.awaiting_approval++; continue; }
              if (auth.decision === "rejected") { await advance(admin, mission, { part_status: "not_required" }); }
              else {
                const { data: res, error } = await admin.from("inventory_reservations")
                  .insert({ user_id: userId, part_id: part.id, location_id: best.location_id, quantity: qty, status: "active" }).select("id").single();
                if (error || !res) {
                  await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: error?.message ?? "reservation failed" });
                } else {
                  await advance(admin, mission, { part_id: part.id, part_quantity: qty, part_status: "reserved", part_location_id: best.location_id, reservation_id: res.id });
                  await recordAgentActionOutcome(admin, auth.logId, { status: "executed", afterState: { reservation_id: res.id } });
                  counts.parts_reserved++;
                }
              }
            } else {
              const { data: vend } = await admin.from("inventory_part_vendors").select("lead_time_days, is_preferred").eq("part_id", part.id)
                .order("is_preferred", { ascending: false }).limit(1).maybeSingle();
              const lead = vend?.lead_time_days as number | null | undefined;
              const eta = lead ? new Date(now.getTime() + lead * DAY).toISOString().slice(0, 10) : null;
              await advance(admin, mission, { part_id: part.id, part_quantity: qty, part_status: eta ? "backorder" : "low_stock", part_eta: eta });
            }
          }
        }

        // ---------- 4. QUOTE + CUSTOMER NOTIFICATION --------------------------
        if (mission.stage === "detected" && mission.part_status !== "unchecked") {
          if (outreachSent >= MAX_OUTREACH_PER_ACCOUNT) continue;
          const cooldown = mission.urgency === "critical" ? DAY : 3 * DAY;
          if (now.getTime() - (recent.get(mission.customer_id) ?? 0) < cooldown) continue;
          if (!customer.phone && !customer.email) {
            await advance(admin, mission, { blocked_reason: "Customer has no phone or email on file." });
            counts.blocked++;
            if (mission.urgency === "critical") { await notify(admin, userId, `Cannot reach ${customer.name}`, `${mission.headline} — no contact details on file.`, "/dashboard/property-intelligence"); counts.alerts++; }
            continue;
          }
          const item = matchPriceItem(priceItems, kws?.serviceKeywords ?? []);
          if (!item) {
            await advance(admin, mission, { blocked_reason: `Add a price book item for "${friendly} ${pred.label.toLowerCase()}" repair so Vireek can quote it.` });
            counts.blocked++; continue;
          }
          const auth = await authorizeAgentAction(admin, {
            userId, actionSlug: "pio_customer_outreach", agentSource: "property-intelligence-agent",
            targetTable: "pio_missions", targetId: mission.id,
            reasoning: mission.explanation ?? mission.headline,
            payload: { customer_id: mission.customer_id, equipment_id: mission.equipment_id, probability: mission.probability, price_cents: item.price_cents },
          });
          if (auth.decision === "pending_approval") {
            if (mission.blocked_reason !== "Waiting for your approval in Agent Governance.") await advance(admin, mission, { blocked_reason: "Waiting for your approval in Agent Governance." });
            counts.awaiting_approval++; continue;
          }
          if (auth.decision === "rejected") { await advance(admin, mission, { blocked_reason: "Rejected in Agent Governance." }, "dismissed", "governance rejected"); await releaseReservation(admin, mission, "released"); continue; }

          let quote: Row | null = null;
          if (mission.quote_id) {
            const { data } = await admin.from("quotes").select("id, quote_token, status").eq("id", mission.quote_id).maybeSingle();
            quote = data as Row | null;
          }
          if (!quote) {
            const { data: inserted, error } = await admin.from("quotes").insert({
              user_id: userId, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone, customer_email: customer.email,
              status: "draft", source: "property_intelligence", valid_until: new Date(now.getTime() + QUOTE_VALID_DAYS * DAY).toISOString().slice(0, 10),
              line_items: [{ description: item.service_name, quantity: 1, unit_price_cents: item.price_cents }], notes: mission.explanation,
            }).select("id, quote_token, status").single();
            if (error || !inserted) { await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: error?.message ?? "quote insert failed" }); continue; }
            quote = inserted as Row;
            await advance(admin, mission, { quote_id: quote.id });
          }

          const link = `${siteUrl}/quote/${quote.quote_token}`;
          const first = String(customer.name ?? "there").split(" ")[0];
          const pct = Math.round(Number(mission.probability) * 100);
          const days = `${pred.horizon_days_min}–${pred.horizon_days_max} days`;
          const partLine = mission.part_status === "reserved" ? " We've already set the part aside." : "";
          const sms = `${business}: Hi ${first}, live sensor data shows a ${pct}% chance your ${friendly} will fail within ~${days}.${partLine} Book a fix before it breaks: ${link} Reply STOP to opt out.`;

          let delivered = false; let failure = "";
          if (customer.phone) {
            const res = await sendCompliantSms(admin, userId, customer.phone, sms);
            delivered = res.ok; if (!res.ok) failure = `${res.reason}${res.detail ? `: ${res.detail}` : ""}`;
          }
          if (!delivered && customer.email) {
            const html = `<p>Hi ${first},</p><p>${mission.explanation}</p>${partLine ? `<p>${partLine.trim()}</p>` : ""}<p><a href="${link}">Review and approve the repair</a> — quote valid ${QUOTE_VALID_DAYS} days.</p><p>${business}</p>`;
            const res = await sendEmail(customer.email, `${business}: your ${friendly} needs attention soon`, html, `${mission.explanation}\n\nReview and approve: ${link}\n\n${business}`);
            delivered = res.ok; if (!res.ok) failure = res.error ?? failure;
          }
          if (!delivered) {
            await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: failure || "delivery failed" });
            await advance(admin, mission, { blocked_reason: `Could not reach customer (${failure || "no channel"}). Will retry.` });
            counts.blocked++; continue;
          }
          await admin.from("quotes").update({ status: "sent", sent_at: nowIso, updated_at: nowIso }).eq("id", quote.id);
          await recordAgentActionOutcome(admin, auth.logId, { status: "executed", afterState: { quote_id: quote.id } });
          await advance(admin, mission, { blocked_reason: null, customer_notified_at: nowIso }, "awaiting_customer", "customer notified + quote sent");
          recent.set(mission.customer_id, now.getTime()); outreachSent++; counts.quoted++;
          continue;
        }

        // ---------- 5. CUSTOMER DECISION -> SCHEDULE -> DISPATCH --------------
        if (mission.stage === "awaiting_customer") {
          if (!mission.quote_id) continue;
          const { data: q } = await admin.from("quotes").select("id, status, valid_until, line_items, tax_percent").eq("id", mission.quote_id).maybeSingle();
          if (!q) continue;
          if (q.status === "declined") { await advance(admin, mission, {}, "declined", "customer declined"); await releaseReservation(admin, mission, "released"); counts.declined++; continue; }
          if (q.status !== "accepted") {
            if (q.valid_until && new Date(q.valid_until) < now) {
              await admin.from("quotes").update({ status: "expired", updated_at: nowIso }).eq("id", q.id).eq("status", "sent");
              await advance(admin, mission, {}, "expired", "quote expired"); await releaseReservation(admin, mission, "released"); counts.expired++;
            } else if (mission.urgency === "critical" && mission.customer_notified_at &&
              now.getTime() - new Date(mission.customer_notified_at).getTime() > ESCALATE_AFTER_HOURS * 3_600_000 &&
              !JSON.stringify(mission.stage_history).includes("escalated")) {
              await notify(admin, userId, `Critical: ${customer.name} hasn't responded`, `${mission.headline} — call the customer to approve the repair.`, "/dashboard/property-intelligence");
              const history = histAppend(mission.stage_history, "awaiting_customer", "escalated to owner");
              await admin.from("pio_missions").update({ stage_history: history, updated_at: nowIso }).eq("id", mission.id);
              mission.stage_history = history;
              counts.alerts++;
            }
            continue;
          }

          const auth = await authorizeAgentAction(admin, {
            userId, actionSlug: "pio_dispatch", agentSource: "property-intelligence-agent",
            targetTable: "pio_missions", targetId: mission.id,
            reasoning: "Customer approved the predictive repair — schedule before the predicted failure and dispatch the best technician.",
          });
          if (auth.decision === "pending_approval") { counts.awaiting_approval++; continue; }
          if (auth.decision === "rejected") { await advance(admin, mission, { blocked_reason: "Dispatch rejected in Agent Governance." }, "dismissed"); await releaseReservation(admin, mission, "released"); continue; }

          const { data: existingJob } = await admin.from("jobs").select("id, reschedule_token, scheduled_datetime").eq("pio_mission_id", mission.id).maybeSingle();
          let job = existingJob as Row | null;
          if (!job) {
            const items = (q.line_items ?? []) as Row[];
            const subtotal = items.reduce((s, li) => s + (li.quantity || 0) * (li.unit_price_cents || 0), 0);
            const total = Math.round(subtotal * (1 + (Number(q.tax_percent) || 0) / 100)) / 100;
            // Never earlier than the part can arrive; as early as the business allows otherwise.
            const partDelay = mission.part_eta ? Math.max(0, Math.ceil((new Date(mission.part_eta).getTime() - now.getTime()) / DAY) + 1) : 0;
            const slot = pickSlot((bp?.business_hours as Row | null) ?? null, now, Math.max(1, partDelay));
            const late = slot.getTime() > new Date(mission.deadline_at).getTime();
            const { data: created, error } = await admin.from("jobs").insert({
              user_id: userId, customer_id: customer.id, customer_name: customer.name, customer_phone: customer.phone,
              service_type: `${pred.label} (predictive)`, address: customer.address, scheduled_datetime: slot.toISOString(),
              duration_minutes: 120, job_status: "scheduled", invoice_amount: total, quote_id: q.id, pio_mission_id: mission.id,
              tags: ["predictive-maintenance", ...(mission.urgency === "critical" ? ["urgent"] : [])],
              dispatch_note: `Created by Property Intelligence. ${mission.explanation ?? ""}${late ? " NOTE: earliest slot is after the predicted failure window." : ""}`.trim(),
            }).select("id, reschedule_token, scheduled_datetime").single();
            if (error || !created) { await recordAgentActionOutcome(admin, auth.logId, { status: "failed", error: error?.message ?? "job insert failed" }); continue; }
            job = created as Row;
            await admin.from("job_equipment").upsert({ job_id: job.id, equipment_id: mission.equipment_id, service_type: "repair" });
            if (mission.part_id) {
              await admin.from("job_parts_required").upsert({
                user_id: userId, job_id: job.id, part_id: mission.part_id, quantity_required: mission.part_quantity ?? 1,
                status: mission.part_status === "reserved" ? "allocated" : mission.part_status === "backorder" ? "backordered" : "needed",
              }, { onConflict: "job_id,part_id" });
            }
            if (mission.reservation_id) await admin.from("inventory_reservations").update({ job_id: job.id }).eq("id", mission.reservation_id);
            await advance(admin, mission, { job_id: job.id, blocked_reason: late ? "Earliest available slot is after the predicted failure window." : null }, "scheduled", "job created");
            counts.scheduled++;
            if (customer.phone) {
              const when = new Date(job.scheduled_datetime).toUTCString().replace(/:\d\d GMT$/, " UTC");
              await sendCompliantSms(admin, userId, customer.phone, `${business}: You're booked to fix your ${friendly} — ${when}. Need another time? ${siteUrl}/reschedule/${job.reschedule_token}`);
            }
          } else if (mission.job_id !== job.id) {
            await advance(admin, mission, { job_id: job.id }, "scheduled");
          }

          const assignment = await assignBestTechnician(admin, userId, { id: job.id, service_type: null, address: customer.address ?? null, scheduled_datetime: job.scheduled_datetime });
          if (assignment.technicianId) {
            await advance(admin, mission, { technician_id: assignment.technicianId, blocked_reason: mission.blocked_reason?.startsWith("Earliest") ? mission.blocked_reason : null }, "dispatched", `assigned ${assignment.technicianName ?? assignment.technicianId}`);
            counts.dispatched++;
            await recordAgentActionOutcome(admin, auth.logId, { status: "executed", afterState: { job_id: job.id, technician_id: assignment.technicianId } });
          } else {
            await advance(admin, mission, { blocked_reason: `No technician assigned yet: ${assignment.reason}` });
          }
          continue;
        }

        // ---------- retry dispatch / track field progress ---------------------
        if (["scheduled", "dispatched", "repaired"].includes(mission.stage) && mission.job_id) {
          const { data: job } = await admin.from("jobs")
            .select("id, job_status, assigned_technician_id, quality_check_passed, after_photos, scheduled_datetime").eq("id", mission.job_id).maybeSingle();
          if (!job) continue;
          if (["cancelled", "no_show"].includes(job.job_status)) {
            await advance(admin, mission, { blocked_reason: `Job ${job.job_status}.` }, "dismissed", `job ${job.job_status}`);
            await releaseReservation(admin, mission, "released"); continue;
          }
          if (mission.stage === "scheduled" && job.job_status !== "completed") {
            if (job.assigned_technician_id) { await advance(admin, mission, { technician_id: job.assigned_technician_id, blocked_reason: null }, "dispatched"); counts.dispatched++; }
            else {
              const r = await assignBestTechnician(admin, userId, { id: job.id, service_type: null, address: customer.address ?? null, scheduled_datetime: job.scheduled_datetime });
              if (r.technicianId) { await advance(admin, mission, { technician_id: r.technicianId, blocked_reason: null }, "dispatched"); counts.dispatched++; }
            }
            continue;
          }
          // ---------- 6. REPAIR ------------------------------------------------
          if (job.job_status === "completed" && ["scheduled", "dispatched"].includes(mission.stage)) {
            await admin.from("equipment").update({ last_service_date: nowIso.slice(0, 10) }).eq("id", mission.equipment_id);
            await advance(admin, mission, { blocked_reason: null }, "repaired", "job completed"); counts.repaired++;
          }
          // ---------- 7. VERIFY + LEARN ----------------------------------------
          if (mission.stage === "repaired") {
            const photos = Array.isArray(job.after_photos) ? job.after_photos.length : 0;
            const verified = job.quality_check_passed === true || (job.quality_check_passed !== false && photos > 0);
            if (verified) {
              await releaseReservation(admin, mission, "fulfilled");
              await admin.from("pio_predictions").update({ status: "resolved", resolved_at: nowIso, updated_at: nowIso }).eq("id", mission.prediction_id).eq("status", "active");
              await advance(admin, mission, { blocked_reason: null }, "verified", "quality gate / after-photos confirmed"); counts.verified++;
              await notify(admin, userId, "Predictive repair verified", `${mission.headline} — confirm what the technician found so Vireek can learn.`, "/dashboard/property-intelligence");
            } else {
              await advance(admin, mission, { blocked_reason: "Awaiting quality check or after-photos to verify the repair." });
            }
          }
        }
      } catch (err) {
        console.error(JSON.stringify({ event: "pio_mission_failed", mission_id: mission.id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
  }

  // ---------- 8. DEVICE HEALTH ----------------------------------------------
  const offlineCutoff = new Date(now.getTime() - OFFLINE_AFTER_HOURS * 3_600_000).toISOString();
  const { data: devs } = await admin.from("pio_devices").select("id, name, last_seen_at, created_at, battery_pct, offline_alerted_at, status")
    .eq("user_id", userId).eq("status", "active");
  for (const d of (devs ?? []) as Row[]) {
    const lastSignal = (d.last_seen_at ?? d.created_at) as string;
    if (lastSignal < offlineCutoff && !d.offline_alerted_at) {
      await notify(admin, userId, `Sensor offline: ${d.name}`, `No data for over ${OFFLINE_AFTER_HOURS} hours. Predictions for this unit are paused until it reconnects.`, "/dashboard/property-intelligence");
      await admin.from("pio_devices").update({ offline_alerted_at: nowIso }).eq("id", d.id);
      counts.alerts++;
    } else if (typeof d.battery_pct === "number" && d.battery_pct <= LOW_BATTERY_PCT && !d.offline_alerted_at) {
      await notify(admin, userId, `Low battery: ${d.name}`, `Battery at ${d.battery_pct}%. Replace it before the sensor goes dark.`, "/dashboard/property-intelligence");
      await admin.from("pio_devices").update({ offline_alerted_at: nowIso }).eq("id", d.id);
      counts.alerts++;
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const cronSecret = Deno.env.get("CRON_SECRET");
  const isCron = Boolean(cronSecret) && req.headers.get("X-Cron-Secret") === cronSecret;
  let onlyUser: string | null = null;

  if (!isCron) {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Unauthorized" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ error: "Invalid or expired session." }, 401);
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
    });
    const { data: ownerId, error: oErr } = await userClient.rpc("get_account_owner_id");
    if (oErr || !ownerId) return json({ error: "Could not resolve account." }, 403);
    onlyUser = ownerId as string;
  }

  // Accounts that have at least one active device (paged distinct list).
  const accounts = new Set<string>();
  if (onlyUser) accounts.add(onlyUser);
  else {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("pio_devices").select("user_id").eq("status", "active").order("user_id").range(from, from + 999);
      if (error) return json({ error: error.message }, 500);
      for (const d of (data ?? []) as Row[]) accounts.add(d.user_id);
      if (!data || data.length < 1000) break;
    }
  }

  const counts = newCounts();
  for (const userId of accounts) {
    try { await processAccount(admin, userId, siteUrl, counts); counts.accounts++; }
    catch (err) { console.error(JSON.stringify({ event: "pio_account_failed", user_id: userId, error: err instanceof Error ? err.message : String(err) })); }
  }
  return json(counts);
});
