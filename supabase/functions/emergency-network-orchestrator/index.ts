// supabase/functions/emergency-network-orchestrator/index.ts
//
// Vireek Autonomous Emergency Network — the orchestrator.
//
// Runs one emergency incident through:
//   Triage -> Dispatch -> ETA -> Customer updates -> Technician prep -> Job -> Evidence -> Payment -> Follow-up
// and, when the company cannot respond fast enough, hands the incident to the Contractor Network:
//   "No technician available" != "No service available".
//
// Design rules
//  * Idempotent. Every message / alert is guarded by a flag in emergency_incidents.alerts_sent, so a retry,
//    a double invocation or a crash can never text a customer twice.
//  * Leased. Work is claimed with a 2-minute lease (claim_due_emergency_incidents, SKIP LOCKED), so two
//    workers never process the same incident.
//  * Fail-safe. A step that throws is retried with backoff; after 5 failures the incident goes to
//    "needs_human" and the owner is alerted. Nothing is ever silently dropped.
//  * Explainable. Every decision is written to emergency_incident_events AND to the AI Reliability &
//    Governance Engine (audit trail, confidence, outcome tracking).
//  * Safe by default. Nothing runs unless the owner switched the Emergency Network ON; hand-offs to other
//    businesses need one-tap approval unless the owner enabled full automation.
//
// Invocation (all JSON POST):
//   {}                          cron: process due incidents      (requires X-Cron-Secret or the service key)
//   { "incident_id": "<uuid>" } process one incident now         (service key / cron secret, or a signed-in
//                                                                  user who owns the incident)
//   { "create": { ... } }       declare an emergency from the dashboard (signed-in user), then process it
//
// Schedule it every minute with your existing external cron:
//   POST https://<project>.supabase.co/functions/v1/emergency-network-orchestrator
//   Header: X-Cron-Secret: <CRON_SECRET>
//
// Deploy:  supabase functions deploy emergency-network-orchestrator

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";
import { sendSms } from "../_shared/notify/deliver.ts";
import { recordAiDecision, recordAiDecisionOutcome } from "../_shared/governance/aiDecisionRecorder.ts";
import {
  customerMessage,
  decideRoute,
  formatEta,
  localHour,
  ownerAlert,
  rankTechnicians,
  slaState,
  technicianBrief,
  type CustomerMessageContext,
  type CustomerMessageKind,
  type OwnerAlertKind,
  type RouteDecision,
  type TechInput,
  type Tier,
  type Trade,
} from "../_shared/emergency/emergencyCore.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};

const MAX_ATTEMPTS = 5;
const APPROVAL_TIMEOUT_MIN = 10;
const RESOLVED_WATCH_DAYS = 7;
const TIME_BUDGET_MS = 45_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Incident {
  id: string;
  user_id: string;
  source: string;
  call_id: string | null;
  triage_submission_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  description: string | null;
  hazards: string[];
  required_trade: Trade;
  severity_tier: Tier;
  severity_score: number;
  insurance_involved: boolean;
  sla_minutes: number;
  sla_due_at: string;
  status: string;
  stage: string;
  assigned_technician_id: string | null;
  assigned_technician_name: string | null;
  eta_minutes_est: number | null;
  decision: Record<string, unknown>;
  handoff_id: string | null;
  network_started_at: string | null;
  network_approved: boolean;
  network_rejected: boolean;
  partner_name: string | null;
  partner_phone: string | null;
  alerts_sent: string[];
  attempts: number;
  created_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  last_error: string | null;
}

interface Settings {
  enabled: boolean;
  auto_dispatch: boolean;
  auto_network_handoff: boolean;
  max_internal_eta_minutes: number;
  network_wait_minutes: number;
  customer_updates: boolean;
  publish_estimated_eta: boolean;
  notify_phone: string | null;
}

interface Ctx {
  admin: SupabaseClient;
  inc: Incident;
  settings: Settings;
  businessName: string;
  networkMember: boolean;
  allowTracking: boolean;
  timeZone: string | null;
  siteUrl: string;
}

interface JobRow {
  id: string;
  job_status: string;
  eta_minutes: number | null;
  reschedule_token: string | null;
  invoice_status: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function minutesFromNow(min: number): string {
  return new Date(Date.now() + min * 60_000).toISOString();
}

async function log(c: Ctx, stage: string, outcome: "ok" | "skipped" | "failed" | "info", summary: string, detail: Record<string, unknown> = {}): Promise<void> {
  const { error } = await c.admin.rpc("_emergency_log", {
    p_incident_id: c.inc.id,
    p_user_id: c.inc.user_id,
    p_stage: stage,
    p_outcome: outcome,
    p_summary: summary,
    p_detail: detail,
    p_actor: "system",
  });
  if (error) console.error(JSON.stringify({ event: "emergency_log_failed", incident: c.inc.id, error: error.message }));
}

async function patch(c: Ctx, fields: Record<string, unknown>): Promise<void> {
  const { error } = await c.admin.from("emergency_incidents").update(fields).eq("id", c.inc.id);
  if (error) throw new Error(`incident update failed: ${error.message}`);
  Object.assign(c.inc, fields);
}

const has = (c: Ctx, flag: string): boolean => c.inc.alerts_sent.includes(flag);

async function mark(c: Ctx, flag: string): Promise<void> {
  if (!has(c, flag)) await patch(c, { alerts_sent: [...c.inc.alerts_sent, flag] });
}

async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, {
      headers: { "User-Agent": "Vireek Emergency Network (support@vireek.com)" },
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const hits = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    const lat = Number(hits?.[0]?.lat);
    const lon = Number(hits?.[0]?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getJob(c: Ctx): Promise<JobRow | null> {
  if (!c.inc.job_id) return null;
  const { data } = await c.admin
    .from("jobs")
    .select("id, job_status, eta_minutes, reschedule_token, invoice_status")
    .eq("id", c.inc.job_id)
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

function trackingUrl(c: Ctx, job: JobRow | null): string | null {
  if (!c.allowTracking || !job?.reschedule_token) return null;
  return `${c.siteUrl}/track/${job.reschedule_token}`;
}

// ---------------------------------------------------------------------------
// Messaging (each guarded by an idempotency flag)
// ---------------------------------------------------------------------------

async function textCustomer(c: Ctx, flag: string, kind: CustomerMessageKind, extra: Partial<CustomerMessageContext> = {}): Promise<void> {
  if (has(c, flag) || !c.settings.customer_updates) return;
  if (!c.inc.customer_phone) {
    await mark(c, flag);
    await log(c, "customer_updates", "skipped", "No customer phone number — customer not texted");
    return;
  }
  const job = extra.trackingUrl === undefined ? await getJob(c) : null;
  const body = customerMessage(kind, {
    businessName: c.businessName,
    hazards: c.inc.hazards,
    technicianName: c.inc.assigned_technician_name,
    etaMinutes: c.settings.publish_estimated_eta ? c.inc.eta_minutes_est : null,
    trackingUrl: extra.trackingUrl === undefined ? trackingUrl(c, job) : extra.trackingUrl,
    ...extra,
  });
  const result = await sendCompliantSms(c.admin, c.inc.user_id, c.inc.customer_phone, body);
  await mark(c, flag); // never retry-storm a customer, whatever the outcome
  if (result.ok) await log(c, "customer_updates", "ok", `Customer texted (${kind})`);
  else await log(c, "customer_updates", "failed", `Customer text not sent (${kind}): ${result.reason}`, { reason: result.reason });
}

async function textStaff(c: Ctx, flag: string, phone: string | null, body: string, label: string): Promise<void> {
  if (has(c, flag)) return;
  if (!phone) {
    await mark(c, flag);
    await log(c, "tech_prep", "skipped", `${label}: no phone number on file`);
    return;
  }
  const result = await sendSms(phone, body.slice(0, 600));
  await mark(c, flag);
  await log(c, "tech_prep", result.ok ? "ok" : "failed", result.ok ? `${label} sent` : `${label} not sent: ${result.error ?? "unknown error"}`);
}

async function alertOwner(c: Ctx, flag: string, kind: OwnerAlertKind, detail?: string): Promise<void> {
  if (has(c, flag)) return;
  const a = ownerAlert(kind, { customerName: c.inc.customer_name, tier: c.inc.severity_tier, detail });
  const { error } = await c.admin.from("notifications").insert({
    user_id: c.inc.user_id,
    type: "system",
    title: a.title,
    message: a.message,
    action_url: "/dashboard/emergency-network",
  });
  if (error) console.error(JSON.stringify({ event: "emergency_owner_notification_failed", error: error.message }));
  if (c.settings.notify_phone) await sendSms(c.settings.notify_phone, `${a.title}: ${a.message}`.slice(0, 600));
  await mark(c, flag);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCtx(admin: SupabaseClient, inc: Incident): Promise<Ctx> {
  const [settings, profile, bp, sched] = await Promise.all([
    admin.from("emergency_network_settings").select("*").eq("user_id", inc.user_id).maybeSingle(),
    admin.from("profiles").select("company_name").eq("id", inc.user_id).maybeSingle(),
    admin.from("business_profile").select("network_enabled, allow_live_tracking").eq("user_id", inc.user_id).maybeSingle(),
    admin.from("on_call_schedules").select("timezone").eq("user_id", inc.user_id).eq("is_active", true).limit(1).maybeSingle(),
  ]);
  if (!settings.data) throw new Error("Emergency Network settings are missing for this account");
  return {
    admin,
    inc,
    settings: settings.data as Settings,
    businessName: (profile.data?.company_name as string | null)?.trim() || "Your service team",
    networkMember: Boolean(bp.data?.network_enabled),
    allowTracking: Boolean(bp.data?.allow_live_tracking),
    timeZone: (sched.data?.timezone as string | null) ?? Deno.env.get("DEFAULT_TIMEZONE") ?? null,
    siteUrl: (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, ""),
  };
}

interface VanFit {
  required: number;
  onVan: number;
  missing: string[];
}

/** Which kit parts for this trade are on each technician's van. Soft: returns an empty map on any problem. */
async function loadVanFit(admin: SupabaseClient, userId: string, trade: Trade, techIds: string[]): Promise<Map<string, VanFit>> {
  const out = new Map<string, VanFit>();
  if (trade === "general" || techIds.length === 0) return out;
  try {
    const { data: kit } = await admin
      .from("service_part_kits")
      .select("part_id, quantity, inventory_parts(name)")
      .eq("user_id", userId)
      .ilike("service_type", `%${trade}%`);
    if (!kit || kit.length === 0) return out;

    const { data: locs } = await admin
      .from("inventory_locations")
      .select("id, assigned_technician_id")
      .eq("user_id", userId)
      .eq("location_type", "van")
      .eq("active", true)
      .in("assigned_technician_id", techIds);
    const locIds = (locs ?? []).map((l: { id: string }) => l.id);

    const stock = new Map<string, number>();
    if (locIds.length > 0) {
      const { data: rows } = await admin
        .from("inventory_stock_levels")
        .select("location_id, part_id, quantity_on_hand, quantity_reserved")
        .in("location_id", locIds)
        .in("part_id", kit.map((k: { part_id: string }) => k.part_id));
      for (const r of rows ?? []) {
        stock.set(`${r.location_id}:${r.part_id}`, (r.quantity_on_hand ?? 0) - (r.quantity_reserved ?? 0));
      }
    }

    for (const techId of techIds) {
      const loc = (locs ?? []).find((l: { assigned_technician_id: string }) => l.assigned_technician_id === techId);
      const missing: string[] = [];
      let onVan = 0;
      for (const k of kit as Array<{ part_id: string; quantity: number; inventory_parts: { name?: string } | Array<{ name?: string }> | null }>) {
        const have = loc ? stock.get(`${loc.id}:${k.part_id}`) ?? 0 : 0;
        if (have >= k.quantity) onVan += 1;
        else {
          const ip = Array.isArray(k.inventory_parts) ? k.inventory_parts[0] : k.inventory_parts;
          missing.push(ip?.name ?? "part");
        }
      }
      out.set(techId, { required: kit.length, onVan, missing });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "emergency_van_fit_failed", error: errText(e) }));
  }
  return out;
}

async function loadTechnicians(c: Ctx): Promise<{ techs: TechInput[]; names: Map<string, { name: string | null; phone: string | null }> }> {
  const { data: members, error } = await c.admin
    .from("team_members")
    .select("id, member_name, member_phone, skills, max_jobs_per_day, current_latitude, current_longitude, location_updated_at, home_latitude, home_longitude")
    .eq("account_owner_id", c.inc.user_id)
    .eq("role", "technician")
    .eq("dispatch_enabled", true);
  if (error) throw new Error(`technician lookup failed: ${error.message}`);

  const rows = members ?? [];
  const ids = rows.map((m: { id: string }) => m.id);
  const names = new Map<string, { name: string | null; phone: string | null }>();
  for (const m of rows) names.set(m.id, { name: m.member_name ?? null, phone: m.member_phone ?? null });
  if (ids.length === 0) return { techs: [], names };

  const now = Date.now();
  const dayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const { data: jobs } = await c.admin
    .from("jobs")
    .select("assigned_technician_id, job_status, scheduled_datetime")
    .eq("user_id", c.inc.user_id)
    .in("assigned_technician_id", ids)
    .not("job_status", "in", "(completed,cancelled)");

  const today = new Map<string, number>();
  const busy = new Set<string>();
  for (const j of jobs ?? []) {
    const tid = j.assigned_technician_id as string;
    if (j.job_status === "en_route" || j.job_status === "in_progress") busy.add(tid);
    const t = j.scheduled_datetime ? new Date(j.scheduled_datetime).getTime() : null;
    if (t !== null && t >= dayStart.getTime() && t < dayEnd.getTime()) today.set(tid, (today.get(tid) ?? 0) + 1);
  }

  const fit = await loadVanFit(c.admin, c.inc.user_id, c.inc.required_trade, ids);

  const techs: TechInput[] = rows.map((m: Record<string, unknown>) => {
    const fresh =
      typeof m.location_updated_at === "string" &&
      now - new Date(m.location_updated_at).getTime() < 30 * 60_000 &&
      m.current_latitude !== null &&
      m.current_longitude !== null;
    const lat = (fresh ? m.current_latitude : m.home_latitude) as number | null;
    const lon = (fresh ? m.current_longitude : m.home_longitude) as number | null;
    const f = fit.get(m.id as string);
    return {
      id: m.id as string,
      name: (m.member_name as string | null) ?? null,
      skills: Array.isArray(m.skills) ? (m.skills as string[]) : [],
      maxJobsPerDay: typeof m.max_jobs_per_day === "number" ? m.max_jobs_per_day : 6,
      jobsToday: today.get(m.id as string) ?? 0,
      busyNow: busy.has(m.id as string),
      lat,
      lon,
      locationFresh: fresh,
      partsRequired: f?.required ?? 0,
      partsOnVan: f?.onVan ?? 0,
    };
  });
  return { techs, names };
}

// ---------------------------------------------------------------------------
// Step: dispatch (Triage result -> routing decision -> assignment or network)
// ---------------------------------------------------------------------------

async function stepDispatch(c: Ctx): Promise<number | null> {
  const inc = c.inc;

  // The customer self-triage RPC may already have created and assigned a job: adopt it, never duplicate it.
  if (!inc.job_id && inc.triage_submission_id) {
    const { data: sub } = await c.admin
      .from("emergency_triage_submissions")
      .select("job_id, assigned_technician_id")
      .eq("id", inc.triage_submission_id)
      .maybeSingle();
    if (sub?.job_id && sub.assigned_technician_id) {
      const { data: tm } = await c.admin.from("team_members").select("member_name").eq("id", sub.assigned_technician_id).maybeSingle();
      await patch(c, {
        job_id: sub.job_id,
        assigned_technician_id: sub.assigned_technician_id,
        assigned_technician_name: tm?.member_name ?? null,
        assigned_at: new Date().toISOString(),
        first_response_at: inc.first_response_at ?? new Date().toISOString(),
        status: "assigned",
        stage: "tech_prep",
      });
      await log(c, "dispatch", "ok", `Adopted the technician already assigned by customer self-triage (${tm?.member_name ?? "technician"})`);
      return 0;
    }
  }

  // Location: coordinates make the ETA honest. Without them the ETA is flagged as unknown, never invented.
  if ((inc.latitude === null || inc.longitude === null) && inc.address) {
    const geo = await geocode(inc.address);
    if (geo) await patch(c, { latitude: geo.lat, longitude: geo.lon });
    else await log(c, "eta", "info", "Address could not be geocoded — ETA will be marked as an unknown-location estimate");
  }

  const { techs, names } = await loadTechnicians(c);
  const hour = localHour(new Date(), c.timeZone);
  const ranking = rankTechnicians({
    techs,
    trade: inc.required_trade,
    site: { lat: inc.latitude, lon: inc.longitude },
    hour,
    maxInternalEtaMinutes: c.settings.max_internal_eta_minutes,
  });

  const route: RouteDecision = decideRoute({
    ranking,
    autoDispatch: c.settings.auto_dispatch,
    maxInternalEtaMinutes: c.settings.max_internal_eta_minutes,
    network: { member: c.networkMember, rejected: inc.network_rejected, alreadyTried: inc.handoff_id !== null },
  });

  const cand = route.candidate;
  const decisionDetail = {
    route: route.route,
    reason: route.reason,
    hour,
    candidate: cand ? { id: cand.id, score: cand.score, eta_minutes: cand.etaMinutes, breakdown: cand.breakdown } : null,
    alternatives: ranking.ranked.slice(1, 4).map((r) => ({ id: r.id, score: r.score, eta_minutes: r.etaMinutes })),
    excluded: ranking.excluded,
  };
  await log(c, "dispatch", "info", `Routing decision: ${route.route.replace("_", " ")} — ${route.reason}`, decisionDetail);

  if (route.route === "needs_human") {
    await patch(c, { status: "needs_human", stage: "dispatch", decision: decisionDetail, last_error: route.reason.slice(0, 500) });
    await alertOwner(c, "owner_needs_human", "needs_human", route.reason);
    return null;
  }

  if (route.route === "network") {
    if (!c.settings.auto_network_handoff && !inc.network_approved) {
      await patch(c, { status: "network_pending_approval", stage: "dispatch", decision: decisionDetail });
      await alertOwner(c, "owner_approval", "approval_needed", route.reason);
      return APPROVAL_TIMEOUT_MIN;
    }
    return await startNetworkSearch(c, route, decisionDetail);
  }

  // internal | internal_late
  if (!cand) throw new Error("routing chose an internal technician but none was ranked");
  const person = names.get(cand.id);
  const jobId = await assignJob(c, cand.id, person?.name ?? cand.name, cand.etaMinutes);

  const gov = await recordAiDecision(c.admin, {
    userId: inc.user_id,
    decisionType: "dispatch",
    agentSource: "emergency-network-orchestrator",
    engineKind: "rules",
    modelVersion: "emergency-routing-v1",
    title: `Emergency: ${person?.name ?? "technician"} dispatched to ${inc.customer_name}`,
    decision: `Assign ${person?.name ?? cand.id} (ETA ${formatEta(cand.etaMinutes)}) to a ${inc.severity_tier} ${inc.required_trade} emergency`,
    reasoning: route.reason,
    confidencePct: cand.score,
    reasonFactors: Object.entries(cand.breakdown).map(([factor, weight]) => ({ factor, weight: weight as number })),
    dataUsed: [
      { source: "emergency_incidents", ref: inc.id, fields: ["severity", "location", "trade"] },
      { source: "team_members", ref: cand.id, fields: ["skills", "location", "capacity"] },
      { source: "jobs", ref: jobId, fields: ["job_status", "scheduled_datetime"] },
    ],
    subjectTable: "jobs",
    subjectId: jobId,
    correlationId: inc.id,
    enforcement: "post_execution",
    executed: true,
  });

  await patch(c, {
    job_id: jobId,
    assigned_technician_id: cand.id,
    assigned_technician_name: person?.name ?? cand.name,
    assigned_at: new Date().toISOString(),
    first_response_at: inc.first_response_at ?? new Date().toISOString(),
    eta_minutes_est: cand.etaMinutes,
    eta_basis: cand.etaBasis,
    decision: { ...decisionDetail, governance_record_id: gov.recordId },
    status: "assigned",
    stage: "tech_prep",
  });
  await log(c, "dispatch", "ok", `${person?.name ?? "Technician"} assigned — ETA ${formatEta(cand.etaMinutes)} (estimate)`, { eta_basis: cand.etaBasis });

  return await stepActive(c);
}

/** Creates the emergency job (or assigns the existing one) and returns its id. */
async function assignJob(c: Ctx, technicianId: string, technicianName: string | null, etaMinutes: number): Promise<string> {
  const inc = c.inc;
  const eta = c.settings.publish_estimated_eta ? { eta_minutes: etaMinutes, eta_set_at: new Date().toISOString() } : {};
  const note = `EMERGENCY (${inc.severity_tier}) via Emergency Network: ${(inc.description ?? inc.severity_tier).slice(0, 300)}`;

  if (inc.job_id) {
    const { error } = await c.admin
      .from("jobs")
      .update({ assigned_technician_id: technicianId, job_status: "scheduled", dispatch_note: note, ...eta })
      .eq("id", inc.job_id);
    if (error) throw new Error(`job assignment failed: ${error.message}`);
    return inc.job_id;
  }

  const { data, error } = await c.admin
    .from("jobs")
    .insert({
      user_id: inc.user_id,
      customer_id: inc.customer_id,
      customer_name: inc.customer_name,
      customer_phone: inc.customer_phone,
      service_type: `Emergency ${inc.required_trade === "general" ? "service" : inc.required_trade}`,
      address: inc.address,
      latitude: inc.latitude,
      longitude: inc.longitude,
      scheduled_datetime: new Date().toISOString(),
      assigned_technician_id: technicianId,
      job_status: "scheduled",
      dispatch_note: note,
      ...eta,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`job creation failed: ${error?.message ?? "no row returned"}`);
  void technicianName;
  return data.id as string;
}

async function startNetworkSearch(c: Ctx, route: RouteDecision, decisionDetail: Record<string, unknown>): Promise<number | null> {
  const inc = c.inc;
  const { data, error } = await c.admin.rpc("emergency_network_post_handoff", { p_incident_id: inc.id });
  if (error || !data) throw new Error(`network hand-off failed: ${error?.message ?? "empty response"}`);
  const res = data as { handoff_id: string; matches: number; existing: boolean };

  const gov = await recordAiDecision(c.admin, {
    userId: inc.user_id,
    decisionType: "dispatch",
    agentSource: "emergency-network-orchestrator",
    engineKind: "rules",
    modelVersion: "emergency-routing-v1",
    title: `Emergency: handed ${inc.customer_name} to the Contractor Network`,
    decision: `Offer a ${inc.severity_tier} ${inc.required_trade} emergency to ${res.matches} network partner(s)`,
    reasoning: route.reason,
    confidencePct: route.candidate ? route.candidate.score : null,
    reasonFactors: [{ factor: "no_internal_option_within_limit", value: route.reason }],
    dataUsed: [{ source: "team_members", fields: ["skills", "capacity", "location"] }, { source: "network_handoffs", ref: res.handoff_id }],
    subjectTable: "emergency_incidents",
    subjectId: inc.id,
    correlationId: inc.id,
    enforcement: "post_execution",
    executed: true,
  });

  await patch(c, {
    handoff_id: res.handoff_id,
    network_started_at: new Date().toISOString(),
    first_response_at: inc.first_response_at ?? new Date().toISOString(),
    decision: { ...decisionDetail, network_record_id: gov.recordId },
    status: "network_search",
    stage: "dispatch",
  });
  await log(c, "network", "ok", `Offered to the Contractor Network (${res.matches} eligible partner${res.matches === 1 ? "" : "s"})`, { handoff_id: res.handoff_id });

  if (res.matches === 0) {
    await log(c, "network", "failed", "No eligible network partner is available — using our own best technician");
    await c.admin.rpc("emergency_network_withdraw", { p_incident_id: inc.id });
    await patch(c, { status: "dispatching", stage: "dispatch" });
    return 0;
  }

  await textCustomer(c, "customer_partner_search", "partner_search");
  return 1;
}

// ---------------------------------------------------------------------------
// Step: network search
// ---------------------------------------------------------------------------

async function stepNetworkSearch(c: Ctx): Promise<number | null> {
  const inc = c.inc;
  if (!inc.handoff_id) {
    await patch(c, { status: "dispatching", stage: "dispatch" });
    return 0;
  }

  await c.admin.rpc("emergency_network_maintain");

  const { data: h } = await c.admin
    .from("network_handoffs")
    .select("status, claimed_by_name, claimed_by_phone")
    .eq("id", inc.handoff_id)
    .maybeSingle();

  if (h?.status === "claimed" || h?.status === "completed") {
    await patch(c, {
      partner_name: h.claimed_by_name ?? null,
      partner_phone: h.claimed_by_phone ?? null,
      status: "handed_off",
      stage: "job",
    });
    await log(c, "network", "ok", `${h.claimed_by_name ?? "A partner"} accepted the emergency`, { handoff_id: inc.handoff_id });
    await textCustomer(c, "customer_partner_found", "partner_found", {
      partnerName: h.claimed_by_name ?? null,
      partnerPhone: h.claimed_by_phone ?? null,
      trackingUrl: null,
    });
    await alertOwner(c, "owner_partner", "partner_accepted", `${h.claimed_by_name ?? "A partner"} accepted. Their coordination number is on the hand-off card.`);
    return 5;
  }

  const startedAt = inc.network_started_at ? new Date(inc.network_started_at).getTime() : Date.now();
  const waitedMin = (Date.now() - startedAt) / 60_000;

  const { count: live } = await c.admin
    .from("network_handoff_matches")
    .select("id", { count: "exact", head: true })
    .eq("handoff_id", inc.handoff_id)
    .in("status", ["offered", "queued"]);

  const exhausted = (live ?? 0) === 0;
  const gone = !h || h.status === "cancelled" || h.status === "expired";
  const timedOut = waitedMin >= c.settings.network_wait_minutes;

  if (exhausted || gone || timedOut) {
    await c.admin.rpc("emergency_network_withdraw", { p_incident_id: inc.id });
    const why = gone ? "the offer closed" : exhausted ? "every partner declined or did not answer" : `no partner accepted within ${c.settings.network_wait_minutes} minutes`;
    await log(c, "network", "failed", `Network search ended — ${why}. Falling back to our own technician.`);
    await alertOwner(c, "owner_network_failed", "network_failed", `Network search ended (${why}).`);
    await patch(c, { status: "dispatching", stage: "dispatch" });
    return 0;
  }

  return 1;
}

// ---------------------------------------------------------------------------
// Step: assigned / en route / on site  (ETA, customer updates, technician prep, SLA watch)
// ---------------------------------------------------------------------------

async function stepActive(c: Ctx): Promise<number | null> {
  const inc = c.inc;
  const job = await getJob(c);

  // Technician prep: one SMS with what they need to know and which parts are not on their van.
  if (!has(c, "tech_brief") && inc.assigned_technician_id) {
    const { data: tm } = await c.admin.from("team_members").select("member_phone").eq("id", inc.assigned_technician_id).maybeSingle();
    const fit = await loadVanFit(c.admin, inc.user_id, inc.required_trade, [inc.assigned_technician_id]);
    const brief = technicianBrief({
      customerName: inc.customer_name,
      customerPhone: inc.customer_phone,
      address: inc.address,
      description: inc.description,
      hazards: inc.hazards,
      tier: inc.severity_tier,
      etaMinutes: c.settings.publish_estimated_eta ? inc.eta_minutes_est : null,
      missingParts: fit.get(inc.assigned_technician_id)?.missing ?? [],
      insuranceInvolved: inc.insurance_involved,
    });
    await textStaff(c, "tech_brief", (tm?.member_phone as string | null) ?? null, brief, "Technician briefing");
  }

  if (!has(c, "owner_dispatched")) {
    await alertOwner(c, "owner_dispatched", "dispatched", `${inc.assigned_technician_name ?? "A technician"} assigned${inc.eta_minutes_est ? `, ETA ${formatEta(inc.eta_minutes_est)}` : ""}.`);
  }

  // Customer updates follow the real job status.
  await textCustomer(c, "customer_assigned", "assigned");
  const status = job?.job_status ?? "scheduled";
  if (status === "en_route") {
    await textCustomer(c, "customer_en_route", "en_route", { etaMinutes: c.settings.publish_estimated_eta ? job?.eta_minutes ?? inc.eta_minutes_est : null });
  }
  if (status === "in_progress") {
    await textCustomer(c, "customer_on_site", "on_site");
    if (inc.stage !== "job") await patch(c, { stage: "job" });
  }

  // SLA watch: a breached response target is surfaced loudly, once.
  if (status !== "in_progress") {
    const sla = slaState(new Date(), new Date(inc.sla_due_at), inc.sla_minutes);
    if (sla.state === "breached") {
      await alertOwner(c, "owner_sla_breach", "sla_breach", `Response target of ${inc.sla_minutes} minutes passed ${Math.abs(sla.minutesLeft)} minutes ago and the technician has not started the job.`);
      await textCustomer(c, "customer_delayed", "delayed", { etaMinutes: null });
    }
  }

  if (inc.stage === "tech_prep" && has(c, "tech_brief")) await patch(c, { stage: status === "in_progress" || status === "en_route" ? "job" : "eta" });
  return 2;
}

// ---------------------------------------------------------------------------
// Step: handed off to a partner
// ---------------------------------------------------------------------------

async function stepHandedOff(c: Ctx): Promise<number | null> {
  const inc = c.inc;
  if (!inc.handoff_id) {
    await patch(c, { status: "dispatching", stage: "dispatch" });
    return 0;
  }
  const { data: h } = await c.admin.from("network_handoffs").select("status").eq("id", inc.handoff_id).maybeSingle();

  if (h?.status === "completed") {
    await textCustomer(c, "customer_resolved", "resolved", { trackingUrl: null });
    const networkRecord = (inc.decision as { network_record_id?: string | null }).network_record_id ?? null;
    const late = Date.now() > new Date(inc.sla_due_at).getTime();
    await recordAiDecisionOutcome(c.admin, networkRecord, {
      result: late ? "partial" : "successful",
      notes: late ? "Partner completed the emergency after the SLA target." : "Partner completed the emergency within the SLA target.",
    });
    await patch(c, { status: "closed", stage: "done", resolved_at: new Date().toISOString(), closed_at: new Date().toISOString() });
    await log(c, "followup", "ok", "Partner completed the emergency — referral fee settlement is handled in the Network Hub");
    return null;
  }

  if (h?.status === "open") {
    // The partner released the job: fall back to our own best technician.
    await log(c, "network", "failed", "The partner released the emergency — falling back to our own technician");
    await c.admin.rpc("emergency_network_withdraw", { p_incident_id: inc.id });
    await alertOwner(c, "owner_partner_released", "network_failed", "The partner released the job. Sending our own best technician.");
    await patch(c, { status: "dispatching", stage: "dispatch" });
    return 0;
  }

  if (h?.status === "cancelled" || h?.status === "expired") {
    await alertOwner(c, "owner_handoff_closed", "needs_human", "The network hand-off closed without a completed job.");
    await patch(c, { status: "needs_human", last_error: "The network hand-off closed without a completed job." });
    return null;
  }
  return 5;
}

// ---------------------------------------------------------------------------
// Step: resolved (evidence, payment, follow-up)
// ---------------------------------------------------------------------------

async function stepResolved(c: Ctx): Promise<number | null> {
  const inc = c.inc;
  const job = await getJob(c);
  await textCustomer(c, "customer_resolved", "resolved");

  if (!has(c, "evidence_checked")) {
    if (job) {
      const { count } = await c.admin.from("job_evidence_chain_entries").select("id", { count: "exact", head: true }).eq("job_id", job.id);
      if ((count ?? 0) > 0) await log(c, "evidence", "ok", `Evidence chain holds ${count} entr${count === 1 ? "y" : "ies"} for this job`);
      else {
        await log(c, "evidence", "failed", "No evidence was recorded for this job (photos, readings, approvals)");
        await alertOwner(c, "owner_no_evidence", "needs_human", "The job is complete but has no evidence recorded. Add photos and notes to protect the invoice and any insurance claim.");
      }
    }
    await mark(c, "evidence_checked");
  }

  const paid = job?.invoice_status === "paid";
  if (!paid && !has(c, "payment_noted")) {
    await log(c, "payment", "info", "Waiting for payment — send the payment request from the job");
    await mark(c, "payment_noted");
  }
  if (paid && !has(c, "paid_noted")) {
    await log(c, "payment", "ok", "Payment received");
    await mark(c, "paid_noted");
  }

  const ageDays = (Date.now() - new Date(inc.resolved_at ?? inc.created_at).getTime()) / 86_400_000;
  if (paid || ageDays >= RESOLVED_WATCH_DAYS) {
    await log(c, "followup", paid ? "ok" : "info", paid
      ? "Incident closed — the Follow-up Agent handles the review request when that campaign is enabled"
      : `Incident closed after ${RESOLVED_WATCH_DAYS} days without payment`);
    await patch(c, { status: "closed", stage: "done", closed_at: new Date().toISOString() });
    return null;
  }
  if (inc.stage !== "payment") await patch(c, { stage: "payment" });
  return 30;
}

// ---------------------------------------------------------------------------
// Processing loop
// ---------------------------------------------------------------------------

async function processIncident(admin: SupabaseClient, inc: Incident): Promise<{ id: string; status: string; error?: string }> {
  try {
    const c = await loadCtx(admin, inc);

    if (!c.settings.enabled) {
      await patch(c, { status: "needs_human", last_error: "The Emergency Network was switched off" });
      await log(c, "system", "info", "Emergency Network is switched off — incident left for a person");
      await release(c, null);
      return { id: inc.id, status: c.inc.status };
    }

    let next: number | null;
    switch (c.inc.status) {
      case "dispatching":
        next = await stepDispatch(c);
        break;
      case "network_pending_approval":
        // Still waiting after the timeout: serve the customer with our own technician instead of waiting forever.
        await log(c, "network", "info", `No approval within ${APPROVAL_TIMEOUT_MIN} minutes — using our own best technician`);
        await patch(c, { network_rejected: true, status: "dispatching", stage: "dispatch" });
        next = await stepDispatch(c);
        break;
      case "network_search":
        next = await stepNetworkSearch(c);
        break;
      case "handed_off":
        next = await stepHandedOff(c);
        break;
      case "assigned":
      case "en_route":
      case "on_site":
        next = await stepActive(c);
        break;
      case "resolved":
        next = await stepResolved(c);
        break;
      default:
        next = null;
    }
    await release(c, next);
    return { id: inc.id, status: c.inc.status };
  } catch (e) {
    const message = errText(e);
    console.error(JSON.stringify({ event: "emergency_incident_failed", incident: inc.id, attempt: inc.attempts + 1, error: message }));
    const attempts = inc.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await admin
      .from("emergency_incidents")
      .update({
        attempts,
        last_error: message.slice(0, 500),
        locked_until: null,
        next_action_at: minutesFromNow(Math.min(2 ** attempts, 15)),
        ...(giveUp ? { status: "needs_human" } : {}),
      })
      .eq("id", inc.id);
    await admin.rpc("_emergency_log", {
      p_incident_id: inc.id,
      p_user_id: inc.user_id,
      p_stage: "system",
      p_outcome: "failed",
      p_summary: giveUp ? `Gave up after ${attempts} attempts: ${message}` : `Step failed (attempt ${attempts}): ${message}`,
      p_detail: {},
      p_actor: "system",
    });
    if (giveUp) {
      await admin.from("notifications").insert({
        user_id: inc.user_id,
        type: "system",
        title: "Emergency needs a person now",
        message: `${inc.customer_name} (${inc.severity_tier}): automatic handling failed repeatedly — ${message.slice(0, 200)}`,
        action_url: "/dashboard/emergency-network",
      });
    }
    return { id: inc.id, status: giveUp ? "needs_human" : inc.status, error: message };
  }
}

async function release(c: Ctx, nextMinutes: number | null): Promise<void> {
  await patch(c, {
    locked_until: null,
    attempts: 0,
    last_error: c.inc.status === "needs_human" ? c.inc.last_error : null,
    next_action_at: nextMinutes === null ? minutesFromNow(24 * 60) : minutesFromNow(nextMinutes),
  });
}

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------

type Caller = { kind: "trusted" } | { kind: "user"; token: string } | null;

function authenticate(req: Request): Caller {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") === cronSecret) return { kind: "trusted" };
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return null;
  if (bearer === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return { kind: "trusted" };
  return { kind: "user", token: bearer };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const caller = authenticate(req);
  if (!caller) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "Server configuration error" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const started = Date.now();

  try {
    // -- user-scoped client (RLS applies): used to prove ownership and to create incidents -----------------
    let userDb: SupabaseClient | null = null;
    if (caller.kind === "user") {
      userDb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${caller.token}` } },
      });
      const { data: who, error: whoErr } = await userDb.auth.getUser(caller.token);
      if (whoErr || !who?.user) return json({ error: "Unauthorized" }, 401);
    }

    // -- create ---------------------------------------------------------------------------------------------
    if (body.create && typeof body.create === "object") {
      if (!userDb) return json({ error: "Declaring an emergency requires a signed-in user" }, 403);
      const input = body.create as Record<string, unknown>;
      const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
      const hazards = Array.isArray(input.hazards) ? (input.hazards as unknown[]).filter((h): h is string => typeof h === "string").slice(0, 8) : [];
      const description = str(input.description, 2000);
      if (!description && hazards.length === 0) return json({ error: "Describe the emergency or select a hazard" }, 400);

      const { data: owner } = await userDb.rpc("get_account_owner_id");
      if (!owner) return json({ error: "Unauthorized" }, 401);

      const { data: created, error: createErr } = await userDb.rpc("create_emergency_incident", {
        p_user_id: owner,
        p_source: "manual",
        p_customer_name: str(input.customer_name, 200) ?? "Unknown caller",
        p_customer_phone: str(input.customer_phone, 32),
        p_address: str(input.address, 400),
        p_description: description,
        p_hazards: hazards,
        p_insurance_involved: input.insurance_involved === true,
      });
      if (createErr || !created) return json({ error: createErr?.message ?? "Could not create the incident" }, 400);
      const incidentId = (created as { incident_id?: string }).incident_id;
      if (!incidentId) return json({ error: "Could not create the incident" }, 400);
      const result = await runOne(admin, incidentId);
      return json({ ok: true, incident_id: incidentId, ...result });
    }

    // -- process one ----------------------------------------------------------------------------------------
    if (typeof body.incident_id === "string") {
      if (userDb) {
        const { data: visible } = await userDb.from("emergency_incidents").select("id").eq("id", body.incident_id).maybeSingle();
        if (!visible) return json({ error: "Incident not found" }, 404);
      }
      return json({ ok: true, ...(await runOne(admin, body.incident_id)) });
    }

    // -- cron: process what is due ----------------------------------------------------------------------------
    if (caller.kind !== "trusted") return json({ error: "Forbidden" }, 403);
    const { data: due, error: dueErr } = await admin.rpc("claim_due_emergency_incidents", { p_limit: 12 });
    if (dueErr) return json({ error: dueErr.message }, 500);

    const results: Array<{ id: string; status: string; error?: string }> = [];
    const queue = (due ?? []) as Incident[];
    for (let i = 0; i < queue.length && Date.now() - started < TIME_BUDGET_MS; i += 3) {
      results.push(...(await Promise.all(queue.slice(i, i + 3).map((inc) => processIncident(admin, inc)))));
    }
    return json({ ok: true, claimed: queue.length, processed: results.length, results });
  } catch (e) {
    console.error(JSON.stringify({ event: "emergency_orchestrator_error", error: errText(e) }));
    return json({ error: "Internal error" }, 500);
  }
});

async function runOne(admin: SupabaseClient, incidentId: string): Promise<{ processed: boolean; status?: string; error?: string }> {
  const { data, error } = await admin.rpc("claim_emergency_incident", { p_incident_id: incidentId });
  if (error) return { processed: false, error: error.message };
  const inc = ((data ?? []) as Incident[])[0];
  if (!inc) return { processed: false };
  const res = await processIncident(admin, inc);
  return { processed: true, status: res.status, error: res.error };
}
