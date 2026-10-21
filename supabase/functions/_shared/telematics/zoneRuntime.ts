// I/O side of the geofence editor. One ZoneTracker per VehicleSession (see ingest.ts):
//   init()   load the account's active zones (60 s cache) + this vehicle's saved zone state
//   step()   pure state machine per fix -> confirmed enter/exit transitions (no I/O)
//   handle() record each transition once (idempotent), then run the zone's automations
//
// Safety rules baked in:
//   - A transition is recorded BEFORE any action runs, and a replayed transition (duplicate
//     row) runs nothing: at-most-once for customer texts, clock-ins and job changes.
//   - Transitions older than STALE_ACTION_MS are audited but never acted on.
//   - Every automation failure is isolated and recorded; none can break position ingestion.
//   - Customer texts go through sendCompliantSms (A2P, opt-out, quiet hours) and are never
//     queued for later: a text that is not sendable right now is skipped, not sent hours late.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../messaging/sendSms.ts";
import {
  estimateEtaMinutes, formatEtaMinutes, haversineMeters, parseZone, pickZoneJob, planActions, renderEtaMessage, stepZones,
  type ActionKind, type Zone, type ZoneFix, type ZoneJobCandidate, type ZoneStateMap, type ZoneTransition,
} from "./zones.ts";

export interface ZoneVehicle { id: string; user_id: string; assigned_technician_id: string | null }
export interface ZoneHostJob { id: string; lat: number; lng: number; scheduled_datetime: string | null; job_status: string }

export interface ActionResult { action: ActionKind; status: "done" | "skipped" | "failed"; detail?: string }

const ZONE_COLUMNS = "id, name, geofence_type, shape, latitude, longitude, radius_meters, polygon, job_id, automations, dwell_seconds, exit_buffer_m";
const ZONE_CACHE_TTL_MS = 60_000;
const MAX_ZONES = 200;
const OPEN_JOB_STATUSES = ["scheduled", "dispatched", "en_route"];
const ETA_TEXT_WINDOW_HOURS = 12;

const zoneCache = new Map<string, { at: number; zones: Zone[] }>();

export async function loadZones(admin: SupabaseClient, ownerId: string): Promise<Zone[]> {
  const cached = zoneCache.get(ownerId);
  if (cached && Date.now() - cached.at < ZONE_CACHE_TTL_MS) return cached.zones;
  const { data, error } = await admin.from("fleet_geofences").select(ZONE_COLUMNS).eq("user_id", ownerId).eq("active", true).limit(MAX_ZONES);
  if (error) {
    console.error(JSON.stringify({ event: "zone_load_failed", error: error.message }));
    return cached?.zones ?? []; // stale zones beat no zones
  }
  const zones = (data ?? []).map((r) => parseZone(r as Record<string, unknown>)).filter((z): z is Zone => z !== null);
  zoneCache.set(ownerId, { at: Date.now(), zones });
  return zones;
}

/** Deterministic UUID (v4-shaped) so a replayed transition always maps to the same time-clock event id. */
export async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ZoneTracker {
  private zones: Zone[] = [];
  state: ZoneStateMap = {};
  private labels: { vehicle?: string; tech?: string | null } = {};

  constructor(private admin: SupabaseClient, private vehicle: ZoneVehicle) {}

  async init(savedState: unknown): Promise<void> {
    this.zones = await loadZones(this.admin, this.vehicle.user_id);
    this.state = savedState && typeof savedState === "object" && !Array.isArray(savedState) ? (savedState as ZoneStateMap) : {};
  }

  /** Pure: advances the state and returns confirmed transitions. Call once per fix, in time order. */
  step(fix: ZoneFix): ZoneTransition[] {
    if (this.zones.length === 0) {
      this.state = {};
      return [];
    }
    const r = stepZones(fix, this.zones, this.state);
    this.state = r.state;
    return r.transitions;
  }

  async handle(transitions: ZoneTransition[], fix: ZoneFix & { speedMph: number | null }, hostJobs: ZoneHostJob[]): Promise<void> {
    const now = Date.now();
    const candidates: ZoneJobCandidate[] = hostJobs.map((j) => ({
      id: j.id, lat: j.lat, lng: j.lng, status: j.job_status,
      scheduledMs: j.scheduled_datetime ? Date.parse(j.scheduled_datetime) : null,
    }));

    for (const tr of transitions) {
      const zone = this.zones.find((z) => z.id === tr.zoneId);
      if (!zone) continue;
      try {
        const plan = planActions(zone, tr, now);
        const { data: row, error } = await this.admin.from("fleet_geofence_events").upsert({
          user_id: this.vehicle.user_id, geofence_id: zone.id, zone_name: zone.name, vehicle_id: this.vehicle.id,
          technician_id: this.vehicle.assigned_technician_id, kind: tr.kind, occurred_at: new Date(tr.at).toISOString(),
          latitude: fix.lat, longitude: fix.lng,
        }, { onConflict: "vehicle_id,geofence_id,kind,occurred_at", ignoreDuplicates: true }).select("id").maybeSingle();
        if (error) { console.error(JSON.stringify({ event: "zone_event_failed", error: error.message })); continue; }
        if (!row) continue; // replay: already recorded (and acted on) before

        const needsJob = plan.some((p) => !p.skip && (p.kind === "arrived" || p.kind === "eta_text"));
        const job = needsJob ? await this.resolveJob(zone, candidates, now) : null;

        const results: ActionResult[] = [];
        for (const p of plan) {
          if (p.skip) { results.push({ action: p.kind, status: "skipped", detail: p.skip }); continue; }
          try {
            results.push(await this.run(p.kind, zone, tr, fix, job));
          } catch (e) {
            results.push({ action: p.kind, status: "failed", detail: String((e as Error)?.message ?? e).slice(0, 160) });
          }
        }
        const patch: Record<string, unknown> = { actions: results };
        if (job) patch.job_id = job.id;
        if (results.length || job) await this.admin.from("fleet_geofence_events").update(patch).eq("id", row.id);
      } catch (e) {
        console.error(JSON.stringify({ event: "zone_transition_failed", zone: zone.id, error: String((e as Error)?.message ?? e) }));
      }
    }
  }

  private async resolveJob(zone: Zone, candidates: ZoneJobCandidate[], now: number): Promise<ZoneJobCandidate | null> {
    const picked = pickZoneJob(zone, candidates, now);
    if (picked || !zone.jobId) return picked;
    const { data } = await this.admin.from("jobs").select("id, latitude, longitude, scheduled_datetime, job_status")
      .eq("id", zone.jobId).eq("user_id", this.vehicle.user_id).maybeSingle();
    if (!data || data.latitude == null || data.longitude == null) return null;
    return { id: data.id, lat: data.latitude, lng: data.longitude, status: data.job_status, scheduledMs: data.scheduled_datetime ? Date.parse(data.scheduled_datetime) : null };
  }

  private run(kind: ActionKind, zone: Zone, tr: ZoneTransition, fix: ZoneFix & { speedMph: number | null }, job: ZoneJobCandidate | null): Promise<ActionResult> {
    switch (kind) {
      case "arrived": return this.arrived(zone, tr, job);
      case "clock_in": return this.clockIn(zone, tr, fix);
      case "eta_text": return this.etaText(zone, fix, job);
      case "exit_alert": return this.exitAlert(zone);
    }
  }

  // ---- auto "arrived" ------------------------------------------------------
  private async arrived(zone: Zone, tr: ZoneTransition, job: ZoneJobCandidate | null): Promise<ActionResult> {
    if (!job) return { action: "arrived", status: "skipped", detail: "no_job_in_zone" };
    if (!OPEN_JOB_STATUSES.includes(job.status)) return { action: "arrived", status: "skipped", detail: `job_${job.status}` };
    const iso = new Date(tr.at).toISOString();
    const { data, error } = await this.admin.from("jobs")
      .update({ job_status: "in_progress", arrived_at: iso, started_at: iso, telematics_arrived_at: iso })
      .eq("id", job.id).eq("user_id", this.vehicle.user_id).in("job_status", OPEN_JOB_STATUSES).select("id");
    if (error) return { action: "arrived", status: "failed", detail: error.message.slice(0, 160) };
    if (!data || data.length === 0) return { action: "arrived", status: "skipped", detail: "status_changed" };
    await this.admin.from("job_status_events").insert({
      job_id: job.id, technician_id: this.vehicle.assigned_technician_id, from_status: job.status, to_status: "in_progress",
      note: `Auto-detected: vehicle entered zone "${zone.name}"`,
    });
    return { action: "arrived", status: "done" };
  }

  // ---- auto clock-in -------------------------------------------------------
  private async clockIn(zone: Zone, tr: ZoneTransition, fix: ZoneFix): Promise<ActionResult> {
    const tm = this.vehicle.assigned_technician_id;
    if (!tm) return { action: "clock_in", status: "skipped", detail: "no_technician" };
    const eventId = await deterministicUuid(`zone-clock-in:${zone.id}:${this.vehicle.id}:${tr.at}`);
    const { data, error } = await this.admin.rpc("zone_auto_clock_in", {
      p_owner: this.vehicle.user_id, p_team_member: tm, p_at: new Date(tr.at).toISOString(),
      p_lat: fix.lat, p_lng: fix.lng, p_zone: zone.id, p_event_id: eventId,
    });
    if (error) return { action: "clock_in", status: "failed", detail: error.message.slice(0, 160) };
    const out = String(data ?? "");
    if (out === "applied") return { action: "clock_in", status: "done" };
    return { action: "clock_in", status: "skipped", detail: out.replace(/^(skipped|rejected):/, "") || "unknown" };
  }

  // ---- customer ETA text ---------------------------------------------------
  private async etaText(zone: Zone, fix: ZoneFix & { speedMph: number | null }, job: ZoneJobCandidate | null): Promise<ActionResult> {
    const skip = (detail: string): ActionResult => ({ action: "eta_text", status: "skipped", detail });
    if (!job) return skip("no_job_in_zone");
    const owner = this.vehicle.user_id;

    const { data: row } = await this.admin.from("jobs")
      .select("customer_id, customer_name, customer_phone, reschedule_token").eq("id", job.id).eq("user_id", owner).maybeSingle();
    if (!row?.customer_phone) return skip("no_customer_phone");

    // Atomic once-per-window claim: two vehicles / two replays can never double-text.
    const cutoff = new Date(Date.now() - ETA_TEXT_WINDOW_HOURS * 3_600_000).toISOString();
    const { data: claimed, error: claimErr } = await this.admin.from("jobs")
      .update({ eta_text_sent_at: new Date().toISOString() })
      .eq("id", job.id).eq("user_id", owner).or(`eta_text_sent_at.is.null,eta_text_sent_at.lt.${cutoff}`).select("id");
    if (claimErr) return { action: "eta_text", status: "failed", detail: claimErr.message.slice(0, 160) };
    if (!claimed || claimed.length === 0) return skip("already_sent");
    const release = () => this.admin.from("jobs").update({ eta_text_sent_at: null }).eq("id", job.id);

    const [{ data: biz }, { data: prof }, tech] = await Promise.all([
      this.admin.from("business_profile").select("allow_live_tracking").eq("user_id", owner).maybeSingle(),
      this.admin.from("profiles").select("company_name").eq("id", owner).maybeSingle(),
      this.techName(),
    ]);
    const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
    const link = biz?.allow_live_tracking && row.reschedule_token ? `Track live: ${siteUrl}/track/${row.reschedule_token}` : "";
    const eta = estimateEtaMinutes(haversineMeters(fix, { lat: job.lat, lng: job.lng }), fix.speedMph);
    const body = renderEtaMessage(zone.automations.eta_text?.template, {
      customer: String(row.customer_name ?? "").trim().split(/\s+/)[0] || "there",
      tech: tech ?? "Your technician", company: prof?.company_name ?? "your service team", eta: formatEtaMinutes(eta), link,
    });

    const res = await sendCompliantSms(this.admin, owner, row.customer_phone, body, {
      purpose: "service", source: "geofence-zone", customerId: row.customer_id ?? null, onQuiet: "caller",
    });
    if (res.ok) return { action: "eta_text", status: "done", detail: `eta_${eta}min` };
    await release(); // nothing was sent, so let a later qualifying event try again
    const expected = ["OPTED_OUT", "A2P_NOT_APPROVED", "QUIET_HOURS", "NOT_CONFIGURED"];
    return { action: "eta_text", status: expected.includes(res.reason) ? "skipped" : "failed", detail: res.reason.toLowerCase() };
  }

  // ---- alert on leaving ----------------------------------------------------
  private async exitAlert(zone: Zone): Promise<ActionResult> {
    const [label, tech] = await Promise.all([this.vehicleLabel(), this.techName()]);
    const who = tech ? `${tech} (${label})` : label;
    const { error } = await this.admin.from("notifications").insert({
      user_id: this.vehicle.user_id, type: "geofence_exit", title: `${who} left ${zone.name}`,
      message: `${who} left the "${zone.name}" zone.`, action_url: "/dashboard/live-map",
    });
    return error ? { action: "exit_alert", status: "failed", detail: error.message.slice(0, 160) } : { action: "exit_alert", status: "done" };
  }

  private async vehicleLabel(): Promise<string> {
    if (this.labels.vehicle === undefined) {
      const { data } = await this.admin.from("vehicles").select("label").eq("id", this.vehicle.id).maybeSingle();
      this.labels.vehicle = data?.label ?? "A vehicle";
    }
    return this.labels.vehicle;
  }

  private async techName(): Promise<string | null> {
    if (this.labels.tech === undefined) {
      const id = this.vehicle.assigned_technician_id;
      const { data } = id ? await this.admin.from("team_members").select("member_name").eq("id", id).maybeSingle() : { data: null };
      this.labels.tech = data?.member_name ?? null;
    }
    return this.labels.tech;
  }
}
