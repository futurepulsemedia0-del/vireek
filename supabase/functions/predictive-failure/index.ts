// supabase/functions/predictive-failure/index.ts
//
// VIREEK Predictive Failure Network - orchestrator.
//
//   Prediction -> Customer alert -> Maintenance -> Quote -> Parts reservation -> Technician -> Outcome -> Model learning
//
// Actions (POST JSON):
//   scan    { equipmentIds?: string[] }   score units, issue forecasts, sync the loop, stage parts, alert the owner
//   handoff { forecastId }                 owner only: push a forecast into the Home Health Agent loop
//
// What this function does NOT do: send anything to customers. The hand-off creates a home_health_actions row;
// outreach, quoting, scheduling and dispatch are performed by the existing home-health-agent, so every customer
// message still passes Agent Governance, A2P/DNC compliance and the owner's price book.
//
// Auth  : cron -> header X-Cron-Secret (CRON_SECRET must be set), all accounts.
//         app  -> Authorization: Bearer <user JWT>, that account only.
// Needs : migration 20270401000000_predictive_failure_network.sql
// Deploy: supabase functions deploy predictive-failure --no-verify-jwt
// Schedule (hourly, same style as home-health-agent): header X-Cron-Secret, body {"action":"scan"}.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ENGINE_VERSION, isMaintenanceJobType, normKey, predictUnit, shouldIssue, toHomeHealthDrivers,
  type AtlasCell, type Learning, type ModeDef, type UnitForecast, type UnitHistoryEvent, type UnitInput,
} from "../_shared/predictive-failure/engine.ts";
import { parseSignals, type PassportSignals } from "../_shared/equipment-lifecycle/score.ts";

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
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNITS_PER_ACCOUNT = 1500;
const CHUNK = 100;
const MIN_SCAN_GAP_MS = 2 * 60_000;           // app-triggered scans
const MAX_HANDOFFS_PER_RUN = 25;               // onboarding backlog guard (same spirit as the Home Health agent)
const DECLINE_COOLDOWN_DAYS = 90;
const VERIFIED_COOLDOWN_DAYS = 180;
const OPEN_HH_STAGES = ["detected", "explained", "awaiting_customer", "scheduled", "dispatched", "repaired"];
const DEFAULT_SETTINGS = { enabled: true, horizon_days: 90, alert_threshold: 0.35, auto_handoff: false, auto_stage_parts: true };

interface Counts {
  scanned: number; forecasts_issued: number; unchanged: number; skipped_no_evidence: number;
  alerts: number; handed_off: number; parts_staged: number; resolved: number; synced: number;
}
const newCounts = (): Counts => ({
  scanned: 0, forecasts_issued: 0, unchanged: 0, skipped_no_evidence: 0, alerts: 0, handed_off: 0, parts_staged: 0, resolved: 0, synced: 0,
});

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isMissingRelation = (e: { code?: string; message?: string } | null | undefined) =>
  Boolean(e && (e.code === "42P01" || e.code === "42883" || e.code === "PGRST202" || e.code === "PGRST205" || /does not exist|schema cache/i.test(e.message ?? "")));

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

async function loadCatalog(admin: Admin): Promise<ModeDef[]> {
  const { data, error } = await admin.from("pfn_failure_modes").select("*").eq("active", true);
  if (error) throw new Error(`catalog load failed: ${error.message}`);
  return ((data ?? []) as Row[]).map((m) => ({
    key: m.key, label: m.label, families: m.families, shape: Number(m.shape),
    scaleMonths: m.scale_months === null ? null : Number(m.scale_months),
    aliases: m.aliases ?? [], partKeywords: m.part_keywords ?? [],
    maintenanceSensitive: m.maintenance_sensitive, runtimeDriven: m.runtime_driven, seasonal: m.seasonal,
    safetyCritical: m.safety_critical, typicalCostCents: m.typical_cost_cents, intervention: m.intervention,
  }));
}

async function loadLearning(admin: Admin, owner: string, catalog: ModeDef[]): Promise<Learning> {
  const [stats, bins, outcomes] = await Promise.all([
    admin.from("pfn_mode_stats").select("mode, expected, observed, n").eq("user_id", owner),
    admin.from("pfn_calibration_bins").select("bin, n, positives").eq("user_id", owner),
    admin.from("job_outcomes").select("root_cause_key, revenue_cents")
      .eq("user_id", owner).not("revenue_cents", "is", null).not("root_cause_key", "is", null)
      .gte("recorded_at", new Date(Date.now() - 36 * 30.4375 * 86_400_000).toISOString()).limit(3000),
  ]);

  const modeStats: Learning["modeStats"] = {};
  for (const r of (stats.data ?? []) as Row[]) modeStats[r.mode] = { expected: Number(r.expected), observed: Number(r.observed), n: Number(r.n) };

  let binArr: Learning["bins"] = null;
  let resolvedCount = 0;
  if ((bins.data ?? []).length > 0) {
    binArr = Array.from({ length: 10 }, () => ({ n: 0, pos: 0 }));
    for (const b of (bins.data ?? []) as Row[]) {
      const i = Number(b.bin);
      if (i >= 0 && i <= 9) { binArr[i] = { n: Number(b.n), pos: Number(b.positives) }; resolvedCount += Number(b.n); }
    }
  }

  const keyToMode = new Map<string, string>();
  for (const m of catalog) { keyToMode.set(m.key, m.key); for (const a of m.aliases) keyToMode.set(normKey(a), m.key); }
  const sums = new Map<string, { sum: number; n: number }>();
  for (const o of (outcomes.data ?? []) as Row[]) {
    const mode = keyToMode.get(normKey(o.root_cause_key));
    if (!mode || !(Number(o.revenue_cents) > 0)) continue;
    const s = sums.get(mode) ?? { sum: 0, n: 0 };
    s.sum += Number(o.revenue_cents); s.n += 1; sums.set(mode, s);
  }
  const costByMode: Learning["costByMode"] = {};
  for (const [k, s] of sums) costByMode[k] = { avgCents: s.sum / s.n, n: s.n };

  return { modeStats, bins: binArr, resolvedCount, costByMode };
}

async function loadWeather(admin: Admin, owner: string): Promise<{ heat30d: number; cold30d: number }> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await admin.from("weather_surge_events").select("nws_alert_id, event_type")
    .eq("user_id", owner).gte("created_at", since).limit(200);
  if (error) return { heat30d: 0, cold30d: 0 };
  const heat = new Set<string>(); const cold = new Set<string>();
  for (const e of (data ?? []) as Row[]) {
    const t = String(e.event_type ?? "");
    if (/heat/i.test(t)) heat.add(e.nws_alert_id);
    else if (/cold|freeze|frost|winter|ice|chill|blizzard/i.test(t)) cold.add(e.nws_alert_id);
  }
  return { heat30d: heat.size, cold30d: cold.size };
}

function buildHistory(rawEvents: Row[], signals: PassportSignals | null, now: Date): UnitInput["history"] {
  const events: UnitHistoryEvent[] = rawEvents.map((e) => ({
    at: e.at, type: e.type ?? null, rootCause: e.root_cause ?? null,
    parts: Array.isArray(e.parts) ? e.parts.map(String) : [], callback: e.callback === true, single: e.single === true,
  }));
  const ms = (m: number) => now.getTime() - m * 30.4375 * 86_400_000;
  const repairs = events.filter((e) => !isMaintenanceJobType(e.type));
  const within = (e: UnitHistoryEvent, from: number, to: number) => {
    const t = new Date(e.at).getTime();
    return t >= ms(from) && t < (to === 0 ? now.getTime() + 1 : ms(to));
  };
  let repairs12m = repairs.filter((e) => within(e, 12, 0)).length;
  let repairs6m = repairs.filter((e) => within(e, 6, 0)).length;
  let repairsPrev6m = repairs.filter((e) => within(e, 12, 6)).length;
  let callbacks12m = repairs.filter((e) => e.callback && within(e, 12, 0)).length;

  const partCounts = new Map<string, number>();
  for (const e of repairs.filter((x) => within(x, 24, 0))) {
    for (const p of new Set(e.parts.map((x) => x.trim().toLowerCase()).filter(Boolean))) partCounts.set(p, (partCounts.get(p) ?? 0) + 1);
  }
  let repeatPart: string | null = null; let repeatPartCount = 0;
  for (const [p, n] of partCounts) if (n >= 2 && n > repeatPartCount) { repeatPart = p; repeatPartCount = n; }

  let companies24m = repairs.length > 0 ? 1 : 0;
  let lastServiceAt: string | null = events[0]?.at ?? null;
  let crossCompany = false;
  if (signals) {
    repairs12m = Math.max(repairs12m, signals.repair_12m);
    repairs6m = Math.max(repairs6m, signals.repair_6m);
    repairsPrev6m = Math.max(repairsPrev6m, signals.repair_prev_6m);
    callbacks12m = Math.max(callbacks12m, signals.callbacks_12m);
    companies24m = Math.max(companies24m, signals.contractors_24m);
    crossCompany = signals.contractors_24m > 1;
    if (signals.last_service_at && (!lastServiceAt || signals.last_service_at > lastServiceAt)) lastServiceAt = signals.last_service_at;
    if (signals.repeat_part && signals.repeat_part_count > repeatPartCount) { repeatPart = signals.repeat_part; repeatPartCount = signals.repeat_part_count; }
  }
  return { events, repairs12m, repairs6m, repairsPrev6m, callbacks12m, companies24m, repeatPart, repeatPartCount, lastServiceAt, crossCompany };
}

// ---------------------------------------------------------------------------
// scan: score -> issue
// ---------------------------------------------------------------------------

function forecastRow(owner: string, u: UnitInput, f: UnitForecast, now: Date): Row {
  return {
    user_id: owner, equipment_id: f.equipmentId, customer_id: f.customerId, equipment_label: f.label.slice(0, 200),
    horizon_days: f.horizonDays, horizon_end: new Date(now.getTime() + f.horizonDays * 86_400_000).toISOString(),
    probability: f.probability, raw_probability: f.rawProbability, ci_low: f.ciLow, ci_high: f.ciHigh,
    band: f.band, confidence: f.confidence, calibrated: f.calibrated, top_mode: f.topMode, top_mode_label: f.topModeLabel,
    modes: f.modes, factors: f.factors, evidence: f.evidence, recommended: f.recommended, data_gaps: f.dataGaps,
    customer_explanation: f.customerExplanation, exposure_cents: f.exposureCents, engine_version: ENGINE_VERSION,
    issued_at: now.toISOString(), last_checked_at: now.toISOString(),
    status: "open", parts_status: f.recommended?.parts.length ? "none" : "not_needed",
  };
}

async function scanAccount(admin: Admin, owner: string, counts: Counts, only: string[] | null) {
  const now = new Date();
  const { data: sRow } = await admin.from("pfn_settings").select("*").eq("user_id", owner).maybeSingle();
  const settings = { ...DEFAULT_SETTINGS, ...((sRow as Row | null) ?? {}) };
  if (!settings.enabled) return;
  const horizonDays = Number(settings.horizon_days);
  const threshold = Number(settings.alert_threshold);

  // 1) score what is already due, so this run's learning is available immediately
  const { data: resolved } = await admin.rpc("pfn_resolve_forecasts", { p_owner: owner });
  counts.resolved += Number(resolved ?? 0);

  // 2) keep the loop in sync BEFORE issuing anything new
  await syncLoop(admin, owner, settings, counts);

  const catalog = await loadCatalog(admin);
  const learning = await loadLearning(admin, owner, catalog);
  const weather = await loadWeather(admin, owner);

  // 3) equipment
  let q = admin.from("equipment")
    .select("id, customer_id, equipment_type, make, model, install_date, last_service_date, expected_lifespan_years, service_interval_months")
    .eq("user_id", owner).eq("status", "active").order("id").limit(MAX_UNITS_PER_ACCOUNT);
  if (only && only.length > 0) q = q.in("id", only);
  const { data: eqRows, error: eqErr } = await q;
  if (eqErr) throw new Error(`equipment load failed: ${eqErr.message}`);
  const equipment = (eqRows ?? []) as Row[];
  if (equipment.length === 0) return;

  const custType = new Map<string, "residential" | "commercial">();
  const cids = [...new Set(equipment.map((e) => e.customer_id as string).filter(Boolean))];
  for (let i = 0; i < cids.length; i += 200) {
    const { data } = await admin.from("customers").select("id, customer_type").in("id", cids.slice(i, i + 200));
    for (const c of (data ?? []) as Row[]) custType.set(c.id, c.customer_type);
  }
  const profiles = new Map<string, Row>();
  for (let i = 0; i < equipment.length; i += 200) {
    const { data } = await admin.from("pfn_equipment_profiles").select("equipment_id, duty_class, environment")
      .in("equipment_id", equipment.slice(i, i + 200).map((e) => e.id));
    for (const p of (data ?? []) as Row[]) profiles.set(p.equipment_id, p);
  }

  const historyById = new Map<string, Row[]>();
  const signalsById = new Map<string, PassportSignals>();
  let passportOk = true;
  for (let i = 0; i < equipment.length; i += CHUNK) {
    const ids = equipment.slice(i, i + CHUNK).map((e) => e.id as string);
    const { data: hist, error: hErr } = await admin.rpc("pfn_unit_history", { p_owner: owner, p_equipment_ids: ids });
    if (hErr) throw new Error(`history load failed: ${hErr.message}`);
    for (const [id, evs] of Object.entries((hist ?? {}) as Record<string, Row[]>)) historyById.set(id, evs);
    if (passportOk) {
      const { data: sig, error: sErr } = await admin.rpc("lifecycle_passport_signals", { p_equipment_ids: ids });
      if (sErr) passportOk = false;
      else for (const [id, raw] of Object.entries((sig ?? {}) as Record<string, unknown>)) { const p = parseSignals(raw); if (p) signalsById.set(id, p); }
    }
  }

  // existing live forecasts
  const live = new Map<string, Row>();
  const eqIds = equipment.map((e) => e.id as string);
  for (let i = 0; i < eqIds.length; i += 200) {
    const { data } = await admin.from("pfn_forecasts").select("id, equipment_id, probability, band, issued_at, status")
      .eq("user_id", owner).in("status", ["open", "handed_off"]).in("equipment_id", eqIds.slice(i, i + 200));
    for (const r of (data ?? []) as Row[]) live.set(r.equipment_id, r);
  }

  const atlasCache = new Map<string, AtlasCell[]>();
  let atlasOk = true;
  const loadAtlas = async (eq: Row): Promise<AtlasCell[]> => {
    if (!atlasOk || !eq.make) return [];
    const key = `${eq.equipment_type}|${eq.make}|${eq.model ?? ""}`.toLowerCase();
    const cached = atlasCache.get(key);
    if (cached) return cached;
    const { data, error } = await admin.rpc("get_failure_atlas", { p_equipment_type: eq.equipment_type, p_make: eq.make, p_model: eq.model ?? null });
    if (error) { if (isMissingRelation(error)) atlasOk = false; return []; }
    const cells = ((data ?? []) as Row[]).map((c) => ({
      failureMode: c.failure_mode, unitsObserved: Number(c.units_observed), failureRatePct: Number(c.failure_rate_pct),
      medianAgeMonths: c.median_age_months === null ? null : Number(c.median_age_months),
      p25AgeMonths: c.p25_age_months === null ? null : Number(c.p25_age_months),
      p75AgeMonths: c.p75_age_months === null ? null : Number(c.p75_age_months),
      contributorCount: Number(c.contributor_count),
    }));
    atlasCache.set(key, cells);
    return cells;
  };

  const crossed: UnitForecast[] = [];
  for (const eq of equipment) {
    counts.scanned++;
    try {
      const prof = profiles.get(eq.id);
      const unit: UnitInput = {
        equipmentId: eq.id, customerId: eq.customer_id ?? null, equipmentType: eq.equipment_type, make: eq.make ?? null,
        model: eq.model ?? null, installDate: eq.install_date ?? null, lastServiceDate: eq.last_service_date ?? null,
        expectedLifespanYears: Number(eq.expected_lifespan_years) || 15, serviceIntervalMonths: Number(eq.service_interval_months) || 12,
        customerType: custType.get(eq.customer_id) ?? null,
        profile: prof ? { dutyClass: prof.duty_class, environment: prof.environment } : null,
        history: buildHistory(historyById.get(eq.id) ?? [], signalsById.get(eq.id) ?? null, now),
        atlas: await loadAtlas(eq), weather,
      };
      const f = predictUnit(unit, catalog, learning, { now, horizonDays });
      if (!f) { counts.skipped_no_evidence++; continue; }

      const prev = live.get(eq.id) as Row | undefined;
      // an in-flight hand-off keeps its forecast (it is being scored against the loop); otherwise refresh when it moved
      if (prev && (prev.status === "handed_off" || !shouldIssue(prev as never, f, now))) {
        await admin.from("pfn_forecasts").update({ last_checked_at: now.toISOString() }).eq("id", prev.id);
        counts.unchanged++;
        continue;
      }
      if (prev) await admin.from("pfn_forecasts").update({ status: "superseded", last_checked_at: now.toISOString() }).eq("id", prev.id).eq("status", "open");

      const { error: insErr } = await admin.from("pfn_forecasts").insert(forecastRow(owner, unit, f, now));
      if (insErr) { if (insErr.code !== "23505") console.error(JSON.stringify({ event: "pfn_insert_failed", error: insErr.message })); continue; }
      counts.forecasts_issued++;
      if (f.probability >= threshold && f.recommended) crossed.push(f);
    } catch (err) {
      console.error(JSON.stringify({ event: "pfn_unit_failed", equipment_id: eq.id, error: errMsg(err) }));
    }
  }

  // 4) act on the ones that crossed the owner's threshold
  if (crossed.length > 0) {
    if (settings.auto_handoff) {
      crossed.sort((a, b) => b.probability - a.probability);
      for (const f of crossed.slice(0, MAX_HANDOFFS_PER_RUN)) {
        const { data: fr } = await admin.from("pfn_forecasts").select("*").eq("user_id", owner).eq("equipment_id", f.equipmentId).eq("status", "open").maybeSingle();
        if (fr) { const res = await handoffForecast(admin, owner, fr as Row); if (res.ok) counts.handed_off++; }
      }
    }
    await admin.from("notifications").insert({
      user_id: owner, type: "predictive_failure",
      title: `${crossed.length} unit${crossed.length === 1 ? "" : "s"} at elevated failure risk`,
      message: `Highest: ${crossed[0].label} - ${Math.round(crossed[0].probability * 100)}% within ${horizonDays} days. ${settings.auto_handoff ? "Proactive outreach was queued." : "Review and approve the hand-off."}`,
      action_url: "/dashboard/predictive-failure",
    }).then(({ error }: { error: { message: string } | null }) => { if (error) console.error(JSON.stringify({ event: "pfn_notify_failed", error: error.message })); else counts.alerts++; });
  }

  await admin.from("pfn_settings").upsert({ user_id: owner, last_scan_at: now.toISOString(), updated_at: now.toISOString() }, { onConflict: "user_id", ignoreDuplicates: false });
}

// ---------------------------------------------------------------------------
// hand-off into the Home Health Agent loop
// ---------------------------------------------------------------------------

async function handoffForecast(admin: Admin, owner: string, f: Row): Promise<{ ok: boolean; reason?: string }> {
  const rec = f.recommended as Row | null;
  if (!rec) return { ok: false, reason: "No recommended intervention." };
  if (!f.customer_id) return { ok: false, reason: "This unit has no customer." };
  if (f.status !== "open") return { ok: false, reason: "This forecast was already handled." };

  const actionType = rec.handoffAction === "replacement_planning" ? "replacement_planning" : "maintenance";
  const now = new Date(); const nowIso = now.toISOString();

  // cooldowns: never re-pitch a customer who just declined or just had this done
  const { data: recent } = await admin.from("home_health_actions").select("stage, completed_at")
    .eq("equipment_id", f.equipment_id).eq("action_type", actionType)
    .in("stage", ["declined", "expired", "dismissed", "verified"]).order("completed_at", { ascending: false }).limit(1);
  const last = (recent?.[0] ?? null) as Row | null;
  if (last?.completed_at) {
    const days = (now.getTime() - new Date(last.completed_at).getTime()) / 86_400_000;
    const cool = last.stage === "verified" ? VERIFIED_COOLDOWN_DAYS : DECLINE_COOLDOWN_DAYS;
    if (days < cool) {
      const reason = last.stage === "verified" ? "Already serviced recently." : "Customer recently declined a similar offer.";
      await admin.from("pfn_forecasts").update({ loop_blocked_reason: reason }).eq("id", f.id);
      return { ok: false, reason };
    }
  }

  const horizonMonths = Math.max(1, Math.ceil(Number(f.horizon_days) / 30.4375));
  const confidence = f.confidence === "high" ? 0.85 : f.confidence === "moderate" ? 0.65 : 0.45;
  const drivers = toHomeHealthDrivers({ factors: f.factors } as UnitForecast);
  let actionId: string | null = null;

  const { data: created, error } = await admin.from("home_health_actions").insert({
    user_id: owner, customer_id: f.customer_id, equipment_id: f.equipment_id, action_type: actionType, stage: "explained",
    urgency: Number(f.probability) >= 0.35 ? "high" : "medium",
    health_score: Math.max(0, Math.min(100, Math.round((1 - Number(f.probability)) * 100))),
    window_min_months: 1, window_max_months: horizonMonths, confidence, drivers,
    explanation: f.customer_explanation ?? null,
    stage_history: [{ stage: "detected", at: nowIso, note: "predictive-failure" }, { stage: "explained", at: nowIso }],
  }).select("id").single();

  if (error) {
    if (error.code !== "23505") return { ok: false, reason: error.message };
    // the Home Health agent already has an open action for this unit + type: follow that one instead of duplicating
    const { data: existing } = await admin.from("home_health_actions").select("id")
      .eq("equipment_id", f.equipment_id).eq("action_type", actionType).in("stage", OPEN_HH_STAGES).maybeSingle();
    actionId = (existing as Row | null)?.id ?? null;
    if (!actionId) return { ok: false, reason: "Could not link the existing maintenance action." };
  } else {
    actionId = (created as Row).id;
  }

  const { error: upErr } = await admin.from("pfn_forecasts").update({
    status: "handed_off", hh_action_id: actionId, handed_off_at: nowIso, loop_stage: "explained", loop_blocked_reason: null,
  }).eq("id", f.id).eq("status", "open");
  if (upErr) return { ok: false, reason: upErr.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// loop sync: mirror the Home Health action, stage parts, mark the intervention
// ---------------------------------------------------------------------------

async function syncLoop(admin: Admin, owner: string, settings: Row, counts: Counts) {
  const { data: rows } = await admin.from("pfn_forecasts").select("*")
    .eq("user_id", owner).eq("status", "handed_off").not("hh_action_id", "is", null).limit(500);
  const forecasts = (rows ?? []) as Row[];
  if (forecasts.length === 0) return;

  const actionIds = forecasts.map((f) => f.hh_action_id as string);
  const { data: acts } = await admin.from("home_health_actions")
    .select("id, stage, quote_id, job_id, blocked_reason, stage_history, completed_at").in("id", actionIds);
  const byId = new Map<string, Row>(((acts ?? []) as Row[]).map((a) => [a.id, a]));

  for (const f of forecasts) {
    const a = byId.get(f.hh_action_id);
    if (!a) continue;
    const patch: Row = {};
    if (a.stage !== f.loop_stage) patch.loop_stage = a.stage;
    if ((a.blocked_reason ?? null) !== (f.loop_blocked_reason ?? null)) patch.loop_blocked_reason = a.blocked_reason ?? null;
    if (a.quote_id && a.quote_id !== f.hh_quote_id) patch.hh_quote_id = a.quote_id;
    if (a.job_id && a.job_id !== f.job_id) patch.job_id = a.job_id;

    if (["repaired", "verified"].includes(a.stage) && !f.intervened_at) {
      const hist = Array.isArray(a.stage_history) ? (a.stage_history as Row[]) : [];
      const at = [...hist].reverse().find((h) => h.stage === "repaired")?.at ?? a.completed_at ?? new Date().toISOString();
      patch.intervened_at = at;
    }

    const jobId = (patch.job_id ?? f.job_id) as string | undefined;
    if (settings.auto_stage_parts && jobId && f.parts_status === "none" && ["scheduled", "dispatched"].includes(a.stage)) {
      const staged = await stageParts(admin, owner, jobId, (f.recommended?.parts ?? []) as string[]);
      patch.parts_status = staged.status; patch.parts_detail = staged.detail;
      if (staged.status === "staged") counts.parts_staged++;
    }
    if (Object.keys(patch).length > 0) {
      await admin.from("pfn_forecasts").update(patch).eq("id", f.id);
      counts.synced++;
    }
  }
}

async function stageParts(admin: Admin, owner: string, jobId: string, parts: string[]): Promise<{ status: string; detail: Row[] }> {
  if (parts.length === 0) return { status: "not_needed", detail: [] };
  const detail: Row[] = [];
  let staged = 0; let backordered = 0; let missing = 0;
  for (const name of parts) {
    const safe = name.replace(/[%_,()]/g, " ").trim();
    const { data: found } = await admin.from("inventory_parts").select("id, name").eq("user_id", owner).eq("active", true)
      .ilike("name", `%${safe}%`).limit(1);
    const part = (found?.[0] ?? null) as Row | null;
    if (!part) { detail.push({ name, result: "no_matching_inventory_part" }); missing++; continue; }
    const { data: lv } = await admin.from("inventory_stock_levels").select("quantity_on_hand, quantity_reserved").eq("user_id", owner).eq("part_id", part.id);
    const available = ((lv ?? []) as Row[]).reduce((s, r) => s + Math.max(0, Number(r.quantity_on_hand) - Number(r.quantity_reserved)), 0);
    const ok = available >= 1;
    const { error } = await admin.from("job_parts_required").upsert(
      { user_id: owner, job_id: jobId, part_id: part.id, quantity_required: 1, status: ok ? "needed" : "backordered", updated_at: new Date().toISOString() },
      { onConflict: "job_id,part_id" },
    );
    if (error) { detail.push({ name, part: part.name, result: "failed", error: error.message }); missing++; continue; }
    detail.push({ name, part: part.name, result: ok ? "staged" : "backordered", available });
    if (ok) staged++; else backordered++;
  }
  const total = parts.length;
  const status = staged === total ? "staged" : staged > 0 ? "partial" : backordered > 0 ? "backordered" : "failed";
  return { status, detail };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const body = ((await req.json().catch(() => null)) ?? {}) as Row;
    const action = typeof body.action === "string" ? body.action : "scan";

    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCron = Boolean(cronSecret) && req.headers.get("X-Cron-Secret") === cronSecret;
    let owner: string | null = null;
    let isOwnerCaller = false;

    if (!isCron) {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!jwt) return json({ error: "Unauthorized" }, 401);
      const { data: u, error: uErr } = await admin.auth.getUser(jwt);
      if (uErr || !u?.user) return json({ error: "Invalid or expired session." }, 401);
      const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false },
      });
      const { data: ownerId, error: oErr } = await userClient.rpc("get_account_owner_id");
      if (oErr || typeof ownerId !== "string") return json({ error: "Could not resolve your account." }, 403);
      owner = ownerId;
      isOwnerCaller = u.user.id === ownerId;
    }

    if (action === "handoff") {
      if (isCron || !owner) return json({ error: "Hand-off must be triggered by the account owner." }, 403);
      if (!isOwnerCaller) throw new HttpError(403, "Only the account owner can start customer outreach.");
      const id = body.forecastId;
      if (typeof id !== "string" || !UUID_RE.test(id)) throw new HttpError(400, "Invalid forecast.");
      const { data: fr } = await admin.from("pfn_forecasts").select("*").eq("id", id).eq("user_id", owner).maybeSingle();
      if (!fr) throw new HttpError(404, "Forecast not found.");
      const res = await handoffForecast(admin, owner, fr as Row);
      if (!res.ok) throw new HttpError(409, res.reason ?? "Could not hand off this forecast.");
      return json({ ok: true });
    }

    if (action !== "scan") throw new HttpError(400, "Unknown action.");

    const counts = newCounts();
    if (owner) {
      const { data: s } = await admin.from("pfn_settings").select("last_scan_at").eq("user_id", owner).maybeSingle();
      const last = (s as Row | null)?.last_scan_at ? new Date((s as Row).last_scan_at).getTime() : 0;
      if (Date.now() - last < MIN_SCAN_GAP_MS) throw new HttpError(429, "A scan just ran. Give it a couple of minutes.");
      const only = Array.isArray(body.equipmentIds)
        ? (body.equipmentIds as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).slice(0, 50)
        : null;
      await scanAccount(admin, owner, counts, only && only.length > 0 ? only : null);
      return json({ accounts: 1, ...counts });
    }

    // cron: every account that owns active equipment
    const owners = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("equipment").select("user_id").eq("status", "active").order("user_id").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Row[]) owners.add(r.user_id);
      if (!data || data.length < 1000) break;
    }
    for (const id of owners) {
      try { await scanAccount(admin, id, counts, null); }
      catch (err) { console.error(JSON.stringify({ event: "pfn_account_failed", user_id: id, error: errMsg(err) })); }
    }
    return json({ accounts: owners.size, ...counts });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("[predictive-failure] unhandled error", err);
    return json({ error: "Something went wrong running predictive failure analysis." }, 500);
  }
});
