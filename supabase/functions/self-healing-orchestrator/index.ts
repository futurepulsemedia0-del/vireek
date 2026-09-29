// supabase/functions/self-healing-orchestrator/index.ts
//
// Self-Healing Operations — Autonomous Service Recovery
//
// service-recovery-agent DETECTS four early warning signs and opens a
// service_recovery_signals row. This function closes the loop for the
// two time-critical ones (a technician who is running late, or who
// hasn't even left yet) WITHOUT waiting on a human approval step:
//
//   DETECT -> PREDICT -> DECIDE -> ACT -> VERIFY
//
// Every run does three passes, in this order:
//   1. verifyPass    — incidents whose actions have had time to work:
//                       check the real outcome and close the loop.
//   2. detectPass     — new open technician_delayed / eta_missed
//                       signals that don't have an incident yet.
//   3. runIncident    — predict + decide + act, for anything just
//                       detected (and, defensively, anything left in
//                       'detecting' from a prior run that crashed
//                       mid-pipeline).
//
// Same "detection is deterministic, never hallucinated" philosophy as
// service-recovery-agent — thresholds and rules below, not an LLM
// guess, because a business's dispatch board is not somewhere to
// improvise.
//
// DEPLOYMENT: supabase functions deploy self-healing-orchestrator
// --no-verify-jwt, then point your existing cron at it every 10
// minutes, same X-Cron-Secret header / CRON_SECRET already used by
// service-recovery-agent.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { claimCoordinationSlot, recordCoordinationOutcome } from "../_shared/ai-core/emergentCoordination.ts";
import { sendSms } from "../_shared/notify/deliver.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// ---- Tuning knobs — nothing else in the system depends on these exact numbers. ----
const VERIFY_AFTER_MINUTES = 45;     // how long to let actions work before checking the real outcome
const RESCHEDULE_CAP_MINUTES = 120;  // never push a downstream job later than this in one shot
const HIGH_VALUE_JOB_CENTS = 40000;  // $400+ job bumps risk — losing it hurts more

type IncidentType = "technician_delayed" | "eta_missed";
type RiskTier = "low" | "medium" | "high" | "critical";
type ActionType =
  | "notify_customer" | "reassign_technician" | "reoptimize_route"
  | "reschedule_downstream" | "reserve_parts" | "activate_contractor_network"
  | "offer_customer_options";

interface JobRow {
  id: string; user_id: string; customer_name: string; customer_phone: string | null;
  service_type: string | null; address: string | null; scheduled_datetime: string | null;
  assigned_technician_id: string | null; job_status: string; invoice_amount: number | null;
  reschedule_token: string | null; latitude: number | null; longitude: number | null;
  customer_disputed: boolean;
}

interface SignalRow {
  id: string; user_id: string; signal_type: string; job_id: string | null;
  customer_name: string; customer_phone: string | null; severity_score: number; status: string;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function logAction(
  admin: SupabaseClient, userId: string, incidentId: string,
  actionType: ActionType, status: "success" | "skipped" | "failed", detail: Record<string, unknown>,
) {
  await admin.from("self_healing_actions").insert({
    incident_id: incidentId, user_id: userId, action_type: actionType, status, detail,
  });
}

// =====================================================================
// PASS 1 — VERIFY: incidents that have had time to work
// =====================================================================
async function verifyPass(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - VERIFY_AFTER_MINUTES * 60_000).toISOString();
  const { data: incidents } = await admin
    .from("self_healing_incidents")
    .select("id, user_id, job_id, signal_id, acted_at")
    .eq("stage", "awaiting_verification")
    .lte("acted_at", cutoff);

  let verified = 0;
  for (const inc of incidents ?? []) {
    if (!inc.job_id) {
      await admin.from("self_healing_incidents").update({
        stage: "resolved", outcome: "partial", verified_at: new Date().toISOString(),
        outcome_note: "No linked job to verify against; closed without a confirmed outcome.",
      }).eq("id", inc.id);
      continue;
    }

    const { data: job } = await admin
      .from("jobs").select("job_status, customer_disputed")
      .eq("id", inc.job_id).maybeSingle();

    let outcome: "recovered" | "partial" | "failed" = "partial";
    let note = "Job is still in progress after intervention; treated as a mitigated (not confirmed) recovery.";

    if (job?.job_status === "completed" && !job.customer_disputed) {
      outcome = "recovered";
      note = "Job completed after the self-healing intervention, with no dispute raised.";
    } else if (job?.customer_disputed) {
      outcome = "failed";
      note = "Customer disputed the job despite the intervention — needs human follow-up.";
    } else if (job?.job_status === "en_route" || job?.job_status === "in_progress") {
      outcome = "recovered";
      note = "A technician is now actively en route or on site — the delay was addressed.";
    }

    await admin.from("self_healing_incidents").update({
      stage: "resolved", outcome, outcome_note: note, verified_at: new Date().toISOString(),
      resolved_at: new Date().toISOString(),
    }).eq("id", inc.id);

    if (outcome !== "failed") {
      await admin.from("service_recovery_signals").update({
        status: "resolved", resolved_at: new Date().toISOString(),
        resolution_note: `Auto-resolved by self-healing-orchestrator: ${note}`,
      }).eq("id", inc.signal_id).in("status", ["open", "playbook_enrolled"]);
    } else {
      await admin.from("service_recovery_signals").update({
        status: "escalated",
        resolution_note: "Self-healing intervention did not prevent a dispute — escalated for a human.",
      }).eq("id", inc.signal_id).in("status", ["open", "playbook_enrolled"]);
    }
    verified++;
  }
  return verified;
}

// =====================================================================
// PASS 2 — DETECT: new signals without an incident yet
// =====================================================================
async function detectPass(admin: SupabaseClient): Promise<string[]> {
  const { data: signals } = await admin
    .from("service_recovery_signals")
    .select("id, user_id, signal_type, job_id, customer_name, customer_phone, severity_score, status")
    .in("signal_type", ["technician_delayed", "eta_missed"])
    .in("status", ["open", "playbook_enrolled"])
    .not("job_id", "is", null);

  if (!signals || signals.length === 0) return [];

  const { data: existing } = await admin
    .from("self_healing_incidents").select("signal_id").in("signal_id", signals.map((s) => s.id));
  const already = new Set((existing ?? []).map((r) => r.signal_id));

  const createdIds: string[] = [];
  for (const s of signals) {
    if (already.has(s.id)) continue;
    const { data: row, error } = await admin.from("self_healing_incidents").insert({
      user_id: s.user_id, signal_id: s.id, job_id: s.job_id,
      incident_type: s.signal_type as IncidentType, stage: "detecting",
    }).select("id").single();
    if (!error && row) createdIds.push(row.id);
  }
  return createdIds;
}

// =====================================================================
// PREDICT
// =====================================================================
async function predict(admin: SupabaseClient, job: JobRow, signal: SignalRow) {
  let score = signal.severity_score;

  if (job.invoice_amount != null && job.invoice_amount * 100 >= HIGH_VALUE_JOB_CENTS) score += 10;

  const { count: otherOpenSignals } = await admin
    .from("service_recovery_signals").select("id", { count: "exact", head: true })
    .eq("job_id", job.id).neq("id", signal.id).in("status", ["open", "playbook_enrolled", "escalated"]);
  if ((otherOpenSignals ?? 0) > 0) score += 10;

  let cascadeCount = 0;
  if (job.assigned_technician_id && job.scheduled_datetime) {
    const dayStart = new Date(job.scheduled_datetime); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(job.scheduled_datetime); dayEnd.setHours(23, 59, 59, 999);
    const { count } = await admin.from("jobs").select("id", { count: "exact", head: true })
      .eq("assigned_technician_id", job.assigned_technician_id).eq("job_status", "scheduled")
      .neq("id", job.id).gte("scheduled_datetime", dayStart.toISOString()).lte("scheduled_datetime", dayEnd.toISOString());
    cascadeCount = count ?? 0;
    score += Math.min(15, cascadeCount * 5);
  }

  score = Math.max(0, Math.min(100, score));
  const tier: RiskTier = score >= 85 ? "critical" : score >= 65 ? "high" : score >= 40 ? "medium" : "low";

  return {
    score, tier,
    impact: {
      base_severity: signal.severity_score,
      high_value_job: job.invoice_amount != null && job.invoice_amount * 100 >= HIGH_VALUE_JOB_CENTS,
      compounding_signals: (otherOpenSignals ?? 0) > 0,
      cascade_jobs_today: cascadeCount,
    },
  };
}

// =====================================================================
// DECIDE
// =====================================================================
function decide(incidentType: IncidentType, tier: RiskTier): { actions: ActionType[]; reasoning: string } {
  const actions: ActionType[] = ["notify_customer"];
  const reasons: string[] = ["Always tell the customer before they have to ask."];

  if (incidentType === "technician_delayed") {
    if (tier !== "low") {
      actions.push("reassign_technician", "reoptimize_route");
      reasons.push(`Risk tier ${tier}: find a replacement technician and re-sequence their day.`);
    }
    if (tier === "high" || tier === "critical") {
      actions.push("reschedule_downstream");
      reasons.push("High enough risk that today's later jobs likely need to shift too.");
    }
    if (tier === "critical") {
      actions.push("reserve_parts");
      reasons.push("Critical: make sure the replacement technician actually has the parts on the truck.");
    }
  } else {
    if (tier === "high" || tier === "critical") {
      actions.push("offer_customer_options");
      reasons.push("ETA already missed and risk is high: give the customer a self-serve reschedule option now.");
    }
    if (tier === "critical") {
      actions.push("reschedule_downstream");
      reasons.push("Critical ETA miss: protect today's later customers from the same cascade.");
    }
  }

  return { actions, reasoning: reasons.join(" ") };
}

// =====================================================================
// ACT — one function per action type
// =====================================================================

async function actNotifyCustomer(admin: SupabaseClient, incidentId: string, job: JobRow) {
  if (!job.customer_phone) {
    await logAction(admin, job.user_id, incidentId, "notify_customer", "skipped", { reason: "No phone on file." });
    return;
  }
  const claim = await claimCoordinationSlot(admin, {
    userId: job.user_id, agentSource: "self-healing-orchestrator", actionCategory: "customer_contact",
    targetTable: "jobs", targetId: job.id, baseScore: 55, reasoning: "self_healing.notify_customer",
  });
  if (claim.decision === "deferred") {
    await logAction(admin, job.user_id, incidentId, "notify_customer", "skipped", { reason: "Another agent already holds the contact slot for this customer right now." });
    return;
  }
  const body = `Hi ${job.customer_name}, this is your service provider — we noticed your appointment is running behind and wanted to reach out before you had to ask. We're already working on it and will text you the moment we have an update. Thanks for your patience.`;
  const result = await sendSms(job.customer_phone, body);
  await recordCoordinationOutcome(admin, claim.bidId, result.ok ? "success" : "failed");
  await logAction(admin, job.user_id, incidentId, "notify_customer", result.ok ? "success" : "failed", { channel: "sms", ok: result.ok, error: result.error });
}

async function actReassignTechnician(admin: SupabaseClient, incidentId: string, job: JobRow): Promise<string | null> {
  const day = job.scheduled_datetime ? new Date(job.scheduled_datetime) : new Date();
  const dayStr = day.toISOString().slice(0, 10);

  const { data: candidates } = await admin
    .from("team_members")
    .select("id, member_name, phone, skills, service_area, max_jobs_per_day, current_latitude, current_longitude, home_latitude, home_longitude")
    .eq("account_owner_id", job.user_id).eq("role", "technician").eq("invite_status", "active").eq("dispatch_enabled", true)
    .neq("id", job.assigned_technician_id ?? "00000000-0000-0000-0000-000000000000");

  let best: { id: string; name: string | null; phone: string | null } | null = null;
  let bestScore = -1;
  for (const c of candidates ?? []) {
    const { count: load } = await admin.from("jobs").select("id", { count: "exact", head: true })
      .eq("assigned_technician_id", c.id).in("job_status", ["scheduled", "en_route", "in_progress"])
      .gte("scheduled_datetime", `${dayStr}T00:00:00`).lte("scheduled_datetime", `${dayStr}T23:59:59`);
    const capacity = c.max_jobs_per_day ?? 6;
    if ((load ?? 0) >= capacity) continue;

    let score = (capacity - (load ?? 0)) * 2;
    if (job.service_type && (c.skills ?? []).includes(job.service_type)) score += 10;
    if (c.service_area && job.address?.toLowerCase().includes(c.service_area.toLowerCase())) score += 5;
    const tLat = c.current_latitude ?? c.home_latitude;
    const tLon = c.current_longitude ?? c.home_longitude;
    if (tLat != null && tLon != null && job.latitude != null && job.longitude != null) {
      const miles = haversineMiles(tLat, tLon, job.latitude, job.longitude);
      score += Math.max(0, 10 - miles / 2);
    }
    if (score > bestScore) { bestScore = score; best = { id: c.id, name: c.member_name, phone: c.phone }; }
  }

  if (!best) {
    await logAction(admin, job.user_id, incidentId, "reassign_technician", "failed", { reason: "No technician with open capacity found." });
    return null;
  }

  const { data: result, error } = await admin.rpc("assign_technician_to_job", { p_job_id: job.id, p_technician_id: best.id });
  if (error || (result as { status?: string })?.status !== "assigned") {
    await logAction(admin, job.user_id, incidentId, "reassign_technician", "failed", { reason: error?.message ?? (result as { reason?: string })?.reason ?? "Assignment RPC declined." });
    return null;
  }

  if (job.customer_phone) {
    await sendSms(job.customer_phone, `Update: we've assigned ${best.name ?? "a fresh technician"} to get to you as quickly as possible. We'll keep you posted on the new arrival time.`);
  }
  if (best.phone) {
    await sendSms(best.phone, `You've been auto-assigned job for ${job.customer_name} at ${job.address ?? "the job address"} by the self-healing dispatch system — the originally scheduled technician is delayed.`);
  }

  await logAction(admin, job.user_id, incidentId, "reassign_technician", "success", { technician_id: best.id, technician_name: best.name });
  return best.id;
}

async function actReoptimizeRoute(admin: SupabaseClient, incidentId: string, job: JobRow, technicianId: string) {
  const day = job.scheduled_datetime ? new Date(job.scheduled_datetime) : new Date();
  const dayStr = day.toISOString().slice(0, 10);

  const { data: stops } = await admin.from("jobs")
    .select("id, latitude, longitude, scheduled_datetime")
    .eq("assigned_technician_id", technicianId).eq("job_status", "scheduled")
    .gte("scheduled_datetime", `${dayStr}T00:00:00`).lte("scheduled_datetime", `${dayStr}T23:59:59`)
    .not("latitude", "is", null).not("longitude", "is", null);

  if (!stops || stops.length === 0) {
    await logAction(admin, job.user_id, incidentId, "reoptimize_route", "skipped", { reason: "No geocoded stops left today to sequence." });
    return;
  }

  const { data: tech } = await admin.from("team_members")
    .select("current_latitude, current_longitude, home_latitude, home_longitude")
    .eq("id", technicianId).maybeSingle();
  let curLat = tech?.current_latitude ?? tech?.home_latitude ?? stops[0].latitude!;
  let curLon = tech?.current_longitude ?? tech?.home_longitude ?? stops[0].longitude!;

  const remaining = [...stops];
  let seq = 1;
  while (remaining.length > 0) {
    let nearestIdx = 0, nearestDist = Infinity;
    remaining.forEach((s, i) => {
      const d = haversineMiles(curLat, curLon, s.latitude!, s.longitude!);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    const next = remaining.splice(nearestIdx, 1)[0];
    await admin.from("jobs").update({ route_sequence: seq }).eq("id", next.id);
    curLat = next.latitude!; curLon = next.longitude!;
    seq++;
  }

  await logAction(admin, job.user_id, incidentId, "reoptimize_route", "success", { technician_id: technicianId, stops_sequenced: stops.length });
}

async function actRescheduleDownstream(admin: SupabaseClient, incidentId: string, job: JobRow, technicianId: string | null, minutesLate: number) {
  const techId = technicianId ?? job.assigned_technician_id;
  if (!techId || !job.scheduled_datetime) {
    await logAction(admin, job.user_id, incidentId, "reschedule_downstream", "skipped", { reason: "No technician or scheduled time to cascade from." });
    return;
  }
  const day = new Date(job.scheduled_datetime);
  const dayStr = day.toISOString().slice(0, 10);
  const pushMinutes = Math.min(RESCHEDULE_CAP_MINUTES, Math.max(15, Math.round(minutesLate)));

  const { data: downstream } = await admin.from("jobs")
    .select("id, customer_name, customer_phone, scheduled_datetime")
    .eq("assigned_technician_id", techId).eq("job_status", "scheduled")
    .neq("id", job.id).gt("scheduled_datetime", job.scheduled_datetime)
    .lte("scheduled_datetime", `${dayStr}T23:59:59`);

  if (!downstream || downstream.length === 0) {
    await logAction(admin, job.user_id, incidentId, "reschedule_downstream", "skipped", { reason: "No later jobs today for this technician." });
    return;
  }

  const shifted: Array<{ job_id: string; old_time: string; new_time: string }> = [];
  for (const d of downstream) {
    const newTime = new Date(new Date(d.scheduled_datetime!).getTime() + pushMinutes * 60_000).toISOString();
    await admin.from("jobs").update({ scheduled_datetime: newTime }).eq("id", d.id);
    if (d.customer_phone) {
      await sendSms(d.customer_phone, `Hi ${d.customer_name}, a heads up: today's schedule shifted slightly and your appointment is now expected about ${pushMinutes} minutes later than originally booked. We'll confirm the exact time as your technician gets closer.`);
    }
    shifted.push({ job_id: d.id, old_time: d.scheduled_datetime!, new_time: newTime });
  }

  await logAction(admin, job.user_id, incidentId, "reschedule_downstream", "success", { pushed_minutes: pushMinutes, jobs: shifted });
}

async function actReserveParts(admin: SupabaseClient, incidentId: string, job: JobRow, technicianId: string) {
  const { data: required } = await admin.from("job_parts_required")
    .select("part_id, quantity_required").eq("job_id", job.id);

  if (!required || required.length === 0) {
    await logAction(admin, job.user_id, incidentId, "reserve_parts", "skipped", { reason: "This job has no parts requirements on file." });
    return;
  }

  const { data: vanLocation } = await admin.from("inventory_locations")
    .select("id").eq("assigned_technician_id", technicianId).eq("location_type", "van").eq("active", true).maybeSingle();

  if (!vanLocation) {
    await logAction(admin, job.user_id, incidentId, "reserve_parts", "skipped", { reason: "Replacement technician has no van inventory location on file." });
    return;
  }

  const results: Array<{ part_id: string; reserved: boolean }> = [];
  for (const r of required) {
    const { data: stock } = await admin.from("inventory_stock_levels")
      .select("id, quantity_on_hand, quantity_reserved")
      .eq("part_id", r.part_id).eq("location_id", vanLocation.id).maybeSingle();

    const available = (stock?.quantity_on_hand ?? 0) - (stock?.quantity_reserved ?? 0);
    if (available >= r.quantity_required) {
      await admin.from("inventory_stock_levels").update({
        quantity_reserved: (stock?.quantity_reserved ?? 0) + r.quantity_required, updated_at: new Date().toISOString(),
      }).eq("id", stock!.id);
      results.push({ part_id: r.part_id, reserved: true });
    } else {
      results.push({ part_id: r.part_id, reserved: false });
    }
  }

  const allReserved = results.every((r) => r.reserved);
  await logAction(admin, job.user_id, incidentId, "reserve_parts", allReserved ? "success" : "failed", { van_location_id: vanLocation.id, results });
}

async function actActivateContractorNetwork(admin: SupabaseClient, incidentId: string, job: JobRow) {
  const { data: profile } = await admin.from("business_profile")
    .select("network_enabled, service_area").eq("user_id", job.user_id).maybeSingle();

  if (!profile?.network_enabled || !profile.service_area) {
    await logAction(admin, job.user_id, incidentId, "activate_contractor_network", "skipped", { reason: "Account is not opted into the contractor network." });
    return;
  }
  if (!job.customer_name || (!job.customer_phone && !job.address)) {
    await logAction(admin, job.user_id, incidentId, "activate_contractor_network", "skipped", { reason: "Not enough customer contact info to post a handoff." });
    return;
  }

  const { data: ownerProfile } = await admin.from("profiles").select("company_name").eq("id", job.user_id).maybeSingle();
  const businessName = ownerProfile?.company_name?.trim() || "Vireek member";
  const regionKey = profile.service_area.toLowerCase().trim();
  const tradeCategory = ["hvac", "plumbing", "electrical", "roofing", "restoration", "locksmith"].includes((job.service_type ?? "").toLowerCase())
    ? job.service_type!.toLowerCase() : "general";
  const expiresAt = new Date(Date.now() + 3 * 3600_000).toISOString();

  const { data: handoff, error } = await admin.from("network_handoffs").insert({
    user_id: job.user_id, business_name: businessName, kind: "emergency", trade_category: tradeCategory,
    title: "Delayed job needs immediate coverage",
    summary: "Our self-healing dispatch system couldn't find internal coverage in time — posted automatically.",
    region_key: regionKey, location_label: job.address ? job.address.slice(0, 80) : null,
    needed_by: expiresAt, estimated_value_cents: job.invoice_amount != null ? Math.round(job.invoice_amount * 100) : null,
    referral_fee_pct: 10, expires_at: expiresAt, status: "open",
  }).select("id").single();

  if (error || !handoff) {
    await logAction(admin, job.user_id, incidentId, "activate_contractor_network", "failed", { reason: error?.message ?? "Insert failed." });
    return;
  }

  await admin.from("network_handoff_contacts").insert({
    handoff_id: handoff.id, customer_name: job.customer_name, customer_phone: job.customer_phone,
    customer_address: job.address, notes: "Auto-posted by self-healing-orchestrator after no internal technician was available.",
  });
  await admin.from("network_handoff_events").insert({ handoff_id: handoff.id, actor_id: job.user_id, event: "posted" });

  await logAction(admin, job.user_id, incidentId, "activate_contractor_network", "success", { handoff_id: handoff.id, expires_at: expiresAt });
}

async function actOfferCustomerOptions(admin: SupabaseClient, incidentId: string, job: JobRow, siteUrl: string) {
  if (!job.customer_phone || !job.reschedule_token) {
    await logAction(admin, job.user_id, incidentId, "offer_customer_options", "skipped", { reason: "Missing phone or reschedule link for this job." });
    return;
  }
  const link = `${siteUrl}/reschedule/${job.reschedule_token}`;
  const body = `We're sorry for the wait, ${job.customer_name}. If today's timing no longer works for you, you can pick a new time here: ${link} — or just reply and we'll keep working to get there as soon as possible.`;
  const result = await sendSms(job.customer_phone, body);
  await logAction(admin, job.user_id, incidentId, "offer_customer_options", result.ok ? "success" : "failed", { link, ok: result.ok, error: result.error });
}

// =====================================================================
// Run one incident end-to-end: predict -> decide -> act
// =====================================================================
async function runIncident(admin: SupabaseClient, incidentId: string, siteUrl: string) {
  const { data: incident } = await admin.from("self_healing_incidents")
    .select("id, user_id, job_id, signal_id, incident_type").eq("id", incidentId).maybeSingle();
  if (!incident || !incident.job_id) return;

  const { data: job } = await admin.from("jobs")
    .select("id, user_id, customer_name, customer_phone, service_type, address, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, reschedule_token, latitude, longitude, customer_disputed")
    .eq("id", incident.job_id).maybeSingle();
  const { data: signal } = await admin.from("service_recovery_signals")
    .select("id, user_id, signal_type, job_id, customer_name, customer_phone, severity_score, status")
    .eq("id", incident.signal_id).maybeSingle();
  if (!job || !signal) return;

  // Job already resolved itself (completed, or someone finally en route) before we got to it.
  if (job.job_status === "completed" || job.job_status === "cancelled") {
    await admin.from("self_healing_incidents").update({
      stage: "resolved", outcome: "recovered", verified_at: new Date().toISOString(), resolved_at: new Date().toISOString(),
      outcome_note: "Job resolved on its own before the orchestrator had to act.",
    }).eq("id", incidentId);
    return;
  }

  const { score, tier, impact } = await predict(admin, job as JobRow, signal as SignalRow);
  const { actions, reasoning } = decide(incident.incident_type as IncidentType, tier);

  await admin.from("self_healing_incidents").update({
    stage: "acting", risk_score: score, risk_tier: tier, predicted_impact: impact,
    decision: { chosen_actions: actions, reasoning },
  }).eq("id", incidentId);

  const minutesLate = job.scheduled_datetime
    ? (Date.now() - new Date(job.scheduled_datetime).getTime()) / 60_000
    : 20;

  let reassignedTechId: string | null = null;
  for (const action of actions) {
    switch (action) {
      case "notify_customer":
        await actNotifyCustomer(admin, incidentId, job as JobRow);
        break;
      case "reassign_technician":
        reassignedTechId = await actReassignTechnician(admin, incidentId, job as JobRow);
        if (!reassignedTechId && (tier === "high" || tier === "critical")) {
          await actActivateContractorNetwork(admin, incidentId, job as JobRow);
        }
        break;
      case "reoptimize_route":
        if (reassignedTechId) await actReoptimizeRoute(admin, incidentId, job as JobRow, reassignedTechId);
        else await logAction(admin, job.user_id, incidentId, "reoptimize_route", "skipped", { reason: "No successful reassignment to re-sequence around." });
        break;
      case "reschedule_downstream":
        await actRescheduleDownstream(admin, incidentId, job as JobRow, reassignedTechId, minutesLate);
        break;
      case "reserve_parts":
        if (reassignedTechId) await actReserveParts(admin, incidentId, job as JobRow, reassignedTechId);
        else await logAction(admin, job.user_id, incidentId, "reserve_parts", "skipped", { reason: "No replacement technician to reserve parts for." });
        break;
      case "activate_contractor_network":
        await actActivateContractorNetwork(admin, incidentId, job as JobRow);
        break;
      case "offer_customer_options":
        await actOfferCustomerOptions(admin, incidentId, job as JobRow, siteUrl);
        break;
    }
  }

  await admin.from("self_healing_incidents").update({
    stage: "awaiting_verification", acted_at: new Date().toISOString(),
  }).eq("id", incidentId);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret && req.headers.get("X-Cron-Secret") !== cronSecret) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } },
  );
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  const verified = await verifyPass(admin);
  const newIncidentIds = await detectPass(admin);

  const { data: stuck } = await admin.from("self_healing_incidents").select("id").eq("stage", "detecting");
  const toRun = new Set([...newIncidentIds, ...((stuck ?? []).map((r) => r.id))]);

  let acted = 0;
  for (const id of toRun) {
    await runIncident(admin, id, siteUrl);
    acted++;
  }

  return json({ ok: true, verified, detected: newIncidentIds.length, acted });
});
