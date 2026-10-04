// Shared ingestion core used by telematics-ingest (webhooks) and telematics-sync (polling).
// One VehicleSession per vehicle per invocation: loads state once, processes fixes in
// time order, and flushes breadcrumbs + live state in bulk. Arrivals/departures are
// written immediately so a crash mid-batch can never lose a confirmed visit.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  isValidPoint, normalizeSettings, shouldLogBreadcrumb, stepGeofence,
  type Fix, type OpenVisit, type PendingMap, type TelematicsSettings,
} from "./engine.ts";

export interface IncomingFix {
  t: number;
  lat: number;
  lng: number;
  speedMph: number | null;
  headingDeg?: number | null;
  engine: "on" | "off" | "idle" | "unknown";
  odometerMiles?: number | null;
  engineHours?: number | null;
  fuelPct?: number | null;
  checkEngine?: boolean;
  reverseGeo?: string | null;
}

export const EVENT_TYPES = [
  "harsh_brake", "harsh_accel", "harsh_turn", "speeding", "idling", "collision", "dtc_fault",
  "geofence_enter", "geofence_exit", "ignition_on", "ignition_off", "dashcam_clip",
  "distracted_driving", "seatbelt", "other",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export interface IncomingEvent {
  type: EventType;
  occurredAt: number;
  severity?: (typeof SEVERITIES)[number];
  lat?: number | null;
  lng?: number | null;
  speedMph?: number | null;
  speedLimitMph?: number | null;
  durationSeconds?: number | null;
  mediaUrl?: string | null;
  externalId?: string | null;
  details?: Record<string, unknown>;
}

export interface IncomingFault {
  code: string;
  description?: string | null;
  severity?: "low" | "medium" | "high" | "critical";
  checkEngine?: boolean;
  cleared?: boolean;
}

export interface VehicleRef {
  id: string;
  user_id: string;
  assigned_technician_id: string | null;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 7 * 86_400_000;
const ACTIVE_STATUSES = ["scheduled", "dispatched", "en_route", "in_progress"];

interface SiteJob {
  id: string;
  lat: number;
  lng: number;
  scheduled_datetime: string | null;
  job_status: string;
}

export class VehicleSession {
  private settings: TelematicsSettings;
  private prev: Fix | null = null;
  private lastLogged: Fix | null = null;
  private pending: PendingMap = {};
  private open: (OpenVisit & { visitId: string; arrivedMs: number })[] = [];
  private jobs = new Map<string, SiteJob>();
  private stationarySince: number | null = null;
  private crumbs: Record<string, unknown>[] = [];
  private newest: IncomingFix | null = null;
  private currentJobId: string | null = null;
  private liveExists = false;
  stats = { fixes: 0, skipped: 0, arrivals: 0, departures: 0, events: 0 };

  constructor(private admin: SupabaseClient, private vehicle: VehicleRef, rawSettings: unknown) {
    this.settings = normalizeSettings(rawSettings);
  }

  async init(): Promise<void> {
    const { admin, vehicle } = this;
    const [{ data: live }, { data: crumb }, { data: visits }] = await Promise.all([
      admin.from("vehicle_live_state").select("latitude, longitude, speed_mph, engine_state, last_fix_at, stationary_since, geofence_pending, current_job_id").eq("vehicle_id", vehicle.id).maybeSingle(),
      admin.from("vehicle_position_log").select("recorded_at, latitude, longitude, speed_mph, engine_state").eq("vehicle_id", vehicle.id).order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
      admin.from("telematics_job_visits").select("id, job_id, arrived_at").eq("vehicle_id", vehicle.id).is("departed_at", null),
    ]);

    if (live) {
      this.liveExists = true;
      if (live.last_fix_at && live.latitude != null && live.longitude != null) {
        this.prev = { t: Date.parse(live.last_fix_at), lat: live.latitude, lng: live.longitude, speedMph: live.speed_mph, engine: live.engine_state };
      }
      this.stationarySince = live.stationary_since ? Date.parse(live.stationary_since) : null;
      this.pending = (live.geofence_pending ?? {}) as PendingMap;
      this.currentJobId = live.current_job_id;
    }
    if (crumb) {
      this.lastLogged = { t: Date.parse(crumb.recorded_at), lat: crumb.latitude, lng: crumb.longitude, speedMph: crumb.speed_mph, engine: (crumb.engine_state ?? "unknown") as Fix["engine"] };
    }
    this.open = (visits ?? []).map((v) => ({ visitId: v.id, jobId: v.job_id, arrivedAt: Date.parse(v.arrived_at), arrivedMs: Date.parse(v.arrived_at) }));

    // Candidate jobs = this technician's active jobs near today, plus any job with an open visit.
    const ids = new Set(this.open.map((o) => o.jobId));
    const select = "id, latitude, longitude, scheduled_datetime, job_status";
    const now = Date.now();
    const queries = [];
    if (vehicle.assigned_technician_id) {
      queries.push(
        admin.from("jobs").select(select)
          .eq("user_id", vehicle.user_id).eq("assigned_technician_id", vehicle.assigned_technician_id)
          .in("job_status", ACTIVE_STATUSES).not("latitude", "is", null)
          .gte("scheduled_datetime", new Date(now - 18 * 3600_000).toISOString())
          .lte("scheduled_datetime", new Date(now + 18 * 3600_000).toISOString()).limit(60),
      );
    }
    if (ids.size) queries.push(admin.from("jobs").select(select).in("id", [...ids]));
    for (const { data } of await Promise.all(queries)) {
      for (const j of data ?? []) {
        if (j.latitude == null || j.longitude == null) continue;
        this.jobs.set(j.id, { id: j.id, lat: j.latitude, lng: j.longitude, scheduled_datetime: j.scheduled_datetime, job_status: j.job_status });
      }
    }
  }

  /** Process one fix. Must be called in ascending time order. */
  async push(f: IncomingFix): Promise<void> {
    const now = Date.now();
    if (!isValidPoint({ lat: f.lat, lng: f.lng }) || !Number.isFinite(f.t) || f.t > now + MAX_FUTURE_SKEW_MS || f.t < now - MAX_AGE_MS) { this.stats.skipped++; return; }
    if (this.prev && f.t <= this.prev.t) { this.stats.skipped++; return; }

    const fix: Fix = { t: f.t, lat: f.lat, lng: f.lng, speedMph: f.speedMph, engine: f.engine };
    this.stats.fixes++;

    const moved = this.prev ? Math.hypot((fix.lat - this.prev.lat) * 111_000, (fix.lng - this.prev.lng) * 111_000 * Math.cos((fix.lat * Math.PI) / 180)) : Infinity;
    const stationary = (fix.speedMph ?? 0) < 3 && moved < 30;
    this.stationarySince = stationary ? (this.stationarySince ?? this.prev?.t ?? fix.t) : null;

    if (shouldLogBreadcrumb(this.lastLogged, fix)) {
      this.crumbs.push({ user_id: this.vehicle.user_id, vehicle_id: this.vehicle.id, recorded_at: new Date(fix.t).toISOString(), latitude: fix.lat, longitude: fix.lng, speed_mph: fix.speedMph, engine_state: fix.engine });
      this.lastLogged = fix;
    }

    const sites = [...this.jobs.values()].map((j) => ({ jobId: j.id, point: { lat: j.lat, lng: j.lng } }));
    const step = stepGeofence(fix, sites, this.pending, this.open, this.settings);
    this.pending = step.pending;

    for (const a of step.arrivals) await this.handleArrival(a.jobId, a.arrivedAt, a.distanceM);
    for (const d of step.departures) await this.handleDeparture(d.jobId, d.departedAt);

    this.prev = fix;
    this.newest = f;
  }

  private async handleArrival(jobId: string, arrivedAt: number, distanceM: number) {
    const { admin, vehicle } = this;
    const job = this.jobs.get(jobId);
    const scheduledMs = job?.scheduled_datetime ? Date.parse(job.scheduled_datetime) : NaN;
    const minutesLate = Number.isNaN(scheduledMs) ? null : Math.round((arrivedAt - scheduledMs) / 60_000);

    const { data: visit, error } = await admin.from("telematics_job_visits").upsert({
      user_id: vehicle.user_id, job_id: jobId, vehicle_id: vehicle.id, technician_id: vehicle.assigned_technician_id,
      arrived_at: new Date(arrivedAt).toISOString(), arrival_distance_m: distanceM,
      scheduled_at: Number.isNaN(scheduledMs) ? null : new Date(scheduledMs).toISOString(), minutes_late: minutesLate,
    }, { onConflict: "job_id,vehicle_id,arrived_at", ignoreDuplicates: true }).select("id").maybeSingle();
    if (error) { console.error(JSON.stringify({ event: "telematics_arrival_failed", error: error.message })); return; }

    const visitId = visit?.id ?? (await admin.from("telematics_job_visits").select("id").eq("job_id", jobId).eq("vehicle_id", vehicle.id).eq("arrived_at", new Date(arrivedAt).toISOString()).maybeSingle()).data?.id;
    this.open.push({ visitId: visitId as string, jobId, arrivedAt, arrivedMs: arrivedAt });
    this.currentJobId = jobId;
    this.stats.arrivals++;

    await admin.from("jobs").update({ telematics_arrived_at: new Date(arrivedAt).toISOString(), telematics_departed_at: null }).eq("id", jobId).is("telematics_arrived_at", null);
    await this.event({ type: "geofence_enter", occurredAt: arrivedAt, severity: "info", externalId: `visit:${jobId}:${arrivedAt}`, details: { job_id: jobId, distance_m: distanceM, minutes_late: minutesLate } }, jobId);

    if (this.settings.auto_advance_job_status && job && ["scheduled", "dispatched", "en_route"].includes(job.job_status)) {
      const iso = new Date(arrivedAt).toISOString();
      const { error: advErr } = await admin.from("jobs").update({ job_status: "in_progress", arrived_at: iso, started_at: iso }).eq("id", jobId).in("job_status", ["scheduled", "dispatched", "en_route"]);
      if (!advErr) {
        job.job_status = "in_progress";
        await admin.from("job_status_events").insert({ job_id: jobId, technician_id: vehicle.assigned_technician_id, from_status: "en_route", to_status: "in_progress", note: "Auto-detected by vehicle GPS arrival" });
      }
    }
  }

  private async handleDeparture(jobId: string, departedAt: number) {
    const { admin } = this;
    const idx = this.open.findIndex((o) => o.jobId === jobId);
    if (idx < 0) return;
    const visit = this.open[idx];
    const onsite = Math.max(0, Math.round((departedAt - visit.arrivedMs) / 1000));
    await admin.from("telematics_job_visits").update({ departed_at: new Date(departedAt).toISOString(), onsite_seconds: onsite }).eq("id", visit.visitId);
    await admin.from("jobs").update({ telematics_departed_at: new Date(departedAt).toISOString(), telematics_onsite_minutes: Math.round(onsite / 60) }).eq("id", jobId);
    this.open.splice(idx, 1);
    if (this.currentJobId === jobId) this.currentJobId = null;
    this.stats.departures++;
    await this.event({ type: "geofence_exit", occurredAt: departedAt, severity: "info", externalId: `visit-exit:${jobId}:${visit.arrivedMs}`, details: { job_id: jobId, onsite_seconds: onsite } }, jobId);
  }

  /** Record a normalized event (idempotent when externalId is present). */
  async event(e: IncomingEvent, forcedJobId?: string | null): Promise<void> {
    const type = EVENT_TYPES.includes(e.type) ? e.type : "other";
    const severity = e.severity && SEVERITIES.includes(e.severity) ? e.severity : "low";
    if (!Number.isFinite(e.occurredAt)) return;
    const row = {
      user_id: this.vehicle.user_id, vehicle_id: this.vehicle.id, technician_id: this.vehicle.assigned_technician_id,
      job_id: forcedJobId ?? this.currentJobId, event_type: type, severity,
      occurred_at: new Date(e.occurredAt).toISOString(),
      latitude: e.lat != null && Math.abs(e.lat) <= 90 ? e.lat : null, longitude: e.lng != null && Math.abs(e.lng) <= 180 ? e.lng : null,
      speed_mph: e.speedMph ?? null, speed_limit_mph: e.speedLimitMph ?? null,
      duration_seconds: e.durationSeconds != null ? Math.round(e.durationSeconds) : null,
      media_url: typeof e.mediaUrl === "string" && /^https:\/\//i.test(e.mediaUrl) ? e.mediaUrl.slice(0, 2000) : null,
      details: e.details ?? {}, source: "provider", external_id: e.externalId ?? null,
    };
    const { error } = await this.admin.from("telematics_events").upsert(row, { onConflict: "vehicle_id,source,external_id", ignoreDuplicates: true });
    if (error) console.error(JSON.stringify({ event: "telematics_event_failed", error: error.message }));
    else this.stats.events++;
  }

  async fault(f: IncomingFault): Promise<void> {
    const code = String(f.code ?? "").trim().slice(0, 40);
    if (!code) return;
    const { admin, vehicle } = this;
    if (f.cleared) {
      await admin.from("vehicle_faults").update({ cleared_at: new Date().toISOString() }).eq("vehicle_id", vehicle.id).eq("code", code).is("cleared_at", null);
      return;
    }
    const { data: existing } = await admin.from("vehicle_faults").select("id").eq("vehicle_id", vehicle.id).eq("code", code).is("cleared_at", null).maybeSingle();
    if (existing) {
      await admin.from("vehicle_faults").update({ last_seen_at: new Date().toISOString() }).eq("id", existing.id);
    } else {
      await admin.from("vehicle_faults").insert({ user_id: vehicle.user_id, vehicle_id: vehicle.id, code, description: f.description?.slice(0, 300) ?? null, severity: f.severity ?? "medium", check_engine: f.checkEngine ?? false });
      await this.event({ type: "dtc_fault", occurredAt: Date.now(), severity: f.severity ?? "medium", externalId: `dtc:${code}:${new Date().toISOString().slice(0, 13)}`, details: { code, description: f.description ?? null } });
    }
  }

  /** Persist breadcrumbs + live state + propagate real GPS to the technician / active jobs. */
  async flush(): Promise<void> {
    const { admin, vehicle } = this;
    if (this.crumbs.length) {
      const { error } = await admin.from("vehicle_position_log").upsert(this.crumbs, { onConflict: "vehicle_id,recorded_at", ignoreDuplicates: true });
      if (error) console.error(JSON.stringify({ event: "telematics_breadcrumb_failed", error: error.message }));
      this.crumbs = [];
    }
    const n = this.newest;
    if (!n) return;
    const iso = new Date(n.t).toISOString();
    const patch: Record<string, unknown> = {
      vehicle_id: vehicle.id, user_id: vehicle.user_id, latitude: n.lat, longitude: n.lng, speed_mph: n.speedMph,
      heading_deg: n.headingDeg ?? null, engine_state: n.engine, last_fix_at: iso,
      stationary_since: this.stationarySince ? new Date(this.stationarySince).toISOString() : null,
      geofence_pending: this.pending, current_job_id: this.currentJobId, updated_at: new Date().toISOString(),
    };
    if (n.odometerMiles != null) patch.odometer_miles = Math.round(n.odometerMiles * 10) / 10;
    if (n.engineHours != null) patch.engine_hours = Math.round(n.engineHours * 10) / 10;
    if (n.fuelPct != null) patch.fuel_pct = Math.min(100, Math.max(0, n.fuelPct));
    if (n.checkEngine != null) patch.check_engine = n.checkEngine;
    if (n.reverseGeo) patch.reverse_geo = n.reverseGeo.slice(0, 200);
    await admin.from("vehicle_live_state").upsert(patch, { onConflict: "vehicle_id" });
    this.liveExists = true;

    if (n.odometerMiles != null) await admin.from("vehicles").update({ odometer_miles: Math.round(n.odometerMiles) }).eq("id", vehicle.id);

    // Feed the EXISTING live-ETA stack with real GPS instead of phone GPS.
    if (vehicle.assigned_technician_id && n.engine !== "off") {
      await admin.from("team_members").update({ current_latitude: n.lat, current_longitude: n.lng, location_updated_at: iso }).eq("id", vehicle.assigned_technician_id);
      await admin.from("jobs").update({ technician_lat: n.lat, technician_lng: n.lng, location_updated_at: iso })
        .eq("user_id", vehicle.user_id).eq("assigned_technician_id", vehicle.assigned_technician_id).in("job_status", ["en_route", "in_progress"]);
    }
  }
}
