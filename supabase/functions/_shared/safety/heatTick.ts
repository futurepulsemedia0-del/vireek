// supabase/functions/_shared/safety/heatTick.ts
//
// Server side of the heat-index reminders. The decisions ("what must happen now?") come from the pure, unit-tested
// planHeatActions() in src/lib/safety/heat.ts; this file fetches the weather and records the results.
//
// Rules: reminders are shown to the technician only (nothing is sent to anyone else), every event is claimed through a
// unique (watch_id, dedupe_key) index so parallel runs never double-record, and a weather failure never raises a prompt.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  DEFAULT_HEAT_INTERVALS,
  heatIndexF,
  planHeatActions,
  validateIntervals,
  type HeatIntervals,
  type HeatTier,
} from "../../../../src/lib/safety/heat.ts";
import { fetchHeatReading, type WeatherResult } from "../../../../src/lib/safety/heatWeather.ts";

export interface WatchRow {
  id: string;
  user_id: string;
  zip: string;
  status: string;
  started_at: string;
  tier: HeatTier;
  last_water_at: string;
  last_rest_at: string;
}

export interface HeatTickResult {
  watches: number;
  zips: number;
  events: number;
  ended: number;
  weather_errors: number;
}

const MAX_WATCHES_PER_RUN = 1000;

function intervalsFrom(row: { water_every_min?: unknown; rest_every_min?: unknown } | null | undefined): HeatIntervals {
  const candidate = { waterEveryMin: row?.water_every_min, restEveryMin: row?.rest_every_min };
  return validateIntervals(candidate) ? candidate : DEFAULT_HEAT_INTERVALS;
}

/** Evaluates one watch against one weather result and records what changed. Safe to run twice. */
async function processWatch(
  admin: SupabaseClient,
  w: WatchRow,
  weather: WeatherResult,
  intervals: HeatIntervals,
  now: Date,
): Promise<{ events: number; ended: boolean; weatherError: boolean }> {
  const { data: done } = await admin.from("safety_heat_events").select("dedupe_key").eq("watch_id", w.id);
  const doneKeys = new Set<string>((done ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));

  const reading = weather.ok
    ? { heatIndexF: heatIndexF(weather.reading.tempF, weather.reading.rhPct), observedAt: weather.reading.observedAt }
    : null;

  const plan = planHeatActions(
    {
      status: "active",
      startedAt: new Date(w.started_at),
      tier: w.tier,
      lastWaterAt: new Date(w.last_water_at),
      lastRestAt: new Date(w.last_rest_at),
      doneKeys,
    },
    reading,
    intervals,
    now,
  );

  let events = 0;
  let ended = false;
  const hi = reading?.heatIndexF ?? null;
  for (const a of plan.actions) {
    if (a.kind === "end_watch") {
      await admin.from("safety_heat_watches").update({ status: "ended", ended_at: now.toISOString(), end_reason: a.reason }).eq("id", w.id).eq("status", "active");
      await admin.from("safety_heat_events").upsert({ user_id: w.user_id, watch_id: w.id, kind: "watch_ended", tier: w.tier, dedupe_key: a.key }, { onConflict: "watch_id,dedupe_key", ignoreDuplicates: true });
      ended = true;
      continue;
    }
    const kind = a.kind; // 'tier_change' | 'water_prompt' | 'rest_prompt'
    const { error } = await admin.from("safety_heat_events").upsert(
      { user_id: w.user_id, watch_id: w.id, kind, tier: plan.tier, heat_index_f: hi, dedupe_key: a.key },
      { onConflict: "watch_id,dedupe_key", ignoreDuplicates: true },
    );
    if (!error) events++;
  }

  if (!ended) {
    const patch: Record<string, unknown> = { last_checked_at: now.toISOString(), tier: plan.tier };
    if (weather.ok) {
      patch.last_observed_at = weather.reading.observedAt.toISOString();
      patch.last_temp_f = Math.round(weather.reading.tempF * 10) / 10;
      patch.last_rh = Math.round(weather.reading.rhPct * 10) / 10;
      patch.last_heat_index_f = hi;
      patch.last_error = null;
    } else {
      patch.last_error = weather.error;
    }
    await admin.from("safety_heat_watches").update(patch).eq("id", w.id).eq("status", "active");
  }
  return { events, ended, weatherError: !weather.ok };
}

async function loadIntervals(admin: SupabaseClient, ownerIds: string[]): Promise<Map<string, { enabled: boolean; intervals: HeatIntervals }>> {
  const out = new Map<string, { enabled: boolean; intervals: HeatIntervals }>();
  if (ownerIds.length === 0) return out;
  const { data } = await admin.from("safety_heat_settings").select("user_id, enabled, water_every_min, rest_every_min").in("user_id", ownerIds);
  for (const r of data ?? []) out.set(r.user_id as string, { enabled: !!r.enabled, intervals: intervalsFrom(r) });
  return out;
}

/** Cron entry: every active watch, one weather lookup per distinct ZIP. */
export async function runHeatTick(admin: SupabaseClient, now: Date = new Date(), onlyWatchId?: string): Promise<HeatTickResult> {
  const result: HeatTickResult = { watches: 0, zips: 0, events: 0, ended: 0, weather_errors: 0 };
  if (!onlyWatchId) await admin.rpc("safety_heat_purge_expired");

  let q = admin.from("safety_heat_watches")
    .select("id, user_id, zip, status, started_at, tier, last_water_at, last_rest_at")
    .eq("status", "active").limit(MAX_WATCHES_PER_RUN);
  if (onlyWatchId) q = q.eq("id", onlyWatchId);
  const { data: rows, error } = await q;
  if (error) throw new Error(error.message);
  const watches = (rows ?? []) as WatchRow[];
  result.watches = watches.length;
  if (watches.length === 0) return result;

  const settings = await loadIntervals(admin, [...new Set(watches.map((w) => w.user_id))]);
  const zips = [...new Set(watches.map((w) => w.zip))];
  result.zips = zips.length;

  const weatherByZip = new Map<string, WeatherResult>();
  const queue = [...zips];
  // Small fixed concurrency keeps us polite to the free NWS / Zippopotam services.
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let z = queue.shift(); z !== undefined; z = queue.shift()) weatherByZip.set(z, await fetchHeatReading(z, fetch, now));
  }));

  for (const w of watches) {
    const s = settings.get(w.user_id);
    if (!s?.enabled) {
      // Company switch is off: close the watch quietly (the RPC normally does this already).
      await admin.from("safety_heat_watches").update({ status: "ended", ended_at: now.toISOString(), end_reason: "manual" }).eq("id", w.id).eq("status", "active");
      result.ended++;
      continue;
    }
    try {
      const r = await processWatch(admin, w, weatherByZip.get(w.zip) ?? { ok: false, error: "forecast_failed" }, s.intervals, now);
      result.events += r.events;
      if (r.ended) result.ended++;
      if (r.weatherError) result.weather_errors++;
    } catch (err) {
      // One bad row must not stop everyone else's reminders.
      console.error(JSON.stringify({ event: "safety_heat_watch_failed", watch_id: w.id, error: err instanceof Error ? err.message : String(err) }));
    }
  }
  return result;
}
