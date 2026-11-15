// supabase/functions/_shared/feature-snapshots/pfn.ts
//
// Point-in-time feature snapshot for the Predictive Failure Network (feature-store PILOT, see
// docs/adr/0001-feature-store-pilot.md). Pure: no I/O, no Deno APIs — unit-tested from Vitest.
//
// A snapshot is the exact input vector predictUnit() saw (inputs) plus a few derived features
// (derived) so analysts can query them in SQL without re-implementing the engine:
//   features->'inputs'->>'equipment_type', (features->'derived'->>'lifespan_used_ratio')::numeric ...
//
// Replay contract: when meta.replayable is true, unitInputFromPfnFeatures() rebuilds a UnitInput for which
// predictUnit() returns the same forecast as it did at decision time (proved in pfn.test.ts).
// Large arrays are capped; a capped snapshot is flagged replayable=false instead of silently lying.
//
// Privacy: no customer id / name / address is stored. entity_id (the equipment id) is the only link.

import { monthsBetween, type AtlasCell, type UnitHistoryEvent, type UnitInput } from "../predictive-failure/engine.ts";
import { fingerprintOf } from "../import-framework/hash.ts";

export const PFN_SNAPSHOT_ENGINE = "pfn";
export const PFN_SNAPSHOT_ENTITY_TYPE = "equipment";
/** Bump when the shape or meaning of any feature changes. Never edit a released version in place. */
export const PFN_FEATURE_SET_VERSION = "pfn-features-1";
export const PFN_SNAPSHOT_SOURCE_TABLE = "pfn_forecasts";

export const MAX_SNAPSHOT_EVENTS = 200;
export const MAX_SNAPSHOT_ATLAS_CELLS = 50;

type Duty = "light" | "normal" | "heavy";
type Env = "normal" | "coastal" | "dusty" | "corrosive" | "humid";

export interface PfnFeatureVector {
  feature_set_version: typeof PFN_FEATURE_SET_VERSION;
  as_of: string;
  inputs: {
    equipment_type: string;
    make: string | null;
    model: string | null;
    install_date: string | null;
    last_service_date: string | null;
    expected_lifespan_years: number;
    service_interval_months: number;
    customer_type: "residential" | "commercial" | null;
    profile: { duty_class: Duty; environment: Env } | null;
    weather: { heat30d: number; cold30d: number };
    history: {
      repairs12m: number;
      repairs6m: number;
      repairs_prev6m: number;
      callbacks12m: number;
      companies24m: number;
      repeat_part: string | null;
      repeat_part_count: number;
      last_service_at: string | null;
      cross_company: boolean;
      events: Array<{
        at: string;
        type: string | null;
        root_cause: string | null;
        parts: string[];
        callback: boolean;
        single: boolean;
      }>;
    };
    atlas: Array<{
      failure_mode: string;
      units_observed: number;
      failure_rate_pct: number;
      median_age_months: number | null;
      p25_age_months: number | null;
      p75_age_months: number | null;
      contributor_count: number;
    }>;
  };
  derived: {
    /** null when install date is missing, invalid or after as_of. Fractional months (30.4375-day months). */
    age_months: number | null;
    lifespan_months: number;
    lifespan_used_ratio: number | null;
    /** months since max(last_service_date, install_date, history.last_service_at); null when none is valid. */
    months_since_service: number | null;
    service_overdue_ratio: number | null;
  };
  meta: {
    events_total: number;
    events_kept: number;
    atlas_total: number;
    atlas_kept: number;
    /** false when an array was capped: the snapshot is still a valid feature log but cannot reproduce the forecast. */
    replayable: boolean;
  };
}

export interface PfnSnapshotRow {
  user_id: string;
  engine: typeof PFN_SNAPSHOT_ENGINE;
  engine_version: string;
  feature_set_version: typeof PFN_FEATURE_SET_VERSION;
  entity_type: typeof PFN_SNAPSHOT_ENTITY_TYPE;
  entity_id: string;
  as_of: string;
  features: PfnFeatureVector;
  features_hash: string;
  source_table: typeof PFN_SNAPSHOT_SOURCE_TABLE | null;
  source_id: string | null;
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Non-finite numbers would serialise to null and silently change meaning; make that explicit. */
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function validTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Derived features. These intentionally mirror three engine internals that are not exported
 * (lifespan floor/default, lastServiceDateOf, unit age); pfn.test.ts pins them to the engine's own
 * output so a change in the engine fails the test instead of silently skewing the log.
 */
function deriveFeatures(unit: UnitInput, asOf: Date): PfnFeatureVector["derived"] {
  const installedMs = validTime(unit.installDate);
  const age_months =
    installedMs !== null && installedMs <= asOf.getTime() ? monthsBetween(new Date(installedMs), asOf) : null;
  const lifespan_months = Math.max(12, (unit.expectedLifespanYears || 15) * 12);

  const candidates = [unit.lastServiceDate, unit.installDate, unit.history.lastServiceAt]
    .map(validTime)
    .filter((t): t is number => t !== null);
  const lastMs = candidates.length ? Math.max(...candidates) : null;
  const months_since_service = lastMs !== null ? monthsBetween(new Date(lastMs), asOf) : null;

  return {
    age_months: age_months === null ? null : r4(age_months),
    lifespan_months: r4(lifespan_months),
    lifespan_used_ratio: age_months === null ? null : r4(age_months / lifespan_months),
    months_since_service: months_since_service === null ? null : r4(months_since_service),
    service_overdue_ratio:
      months_since_service !== null && unit.serviceIntervalMonths > 0
        ? r4(months_since_service / unit.serviceIntervalMonths)
        : null,
  };
}

/** Builds the versioned feature vector for one unit at one instant. Throws RangeError on an invalid asOf. */
export function buildPfnFeatureVector(unit: UnitInput, asOf: Date): PfnFeatureVector {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new RangeError("asOf must be a valid Date");

  const h = unit.history;
  const events = h.events.slice(0, MAX_SNAPSHOT_EVENTS);
  const atlas = unit.atlas.slice(0, MAX_SNAPSHOT_ATLAS_CELLS);

  return {
    feature_set_version: PFN_FEATURE_SET_VERSION,
    as_of: asOf.toISOString(),
    inputs: {
      equipment_type: unit.equipmentType,
      make: unit.make,
      model: unit.model,
      install_date: unit.installDate,
      last_service_date: unit.lastServiceDate,
      expected_lifespan_years: num(unit.expectedLifespanYears),
      service_interval_months: num(unit.serviceIntervalMonths),
      customer_type: unit.customerType,
      profile: unit.profile ? { duty_class: unit.profile.dutyClass, environment: unit.profile.environment } : null,
      weather: { heat30d: num(unit.weather.heat30d), cold30d: num(unit.weather.cold30d) },
      history: {
        repairs12m: num(h.repairs12m),
        repairs6m: num(h.repairs6m),
        repairs_prev6m: num(h.repairsPrev6m),
        callbacks12m: num(h.callbacks12m),
        companies24m: num(h.companies24m),
        repeat_part: h.repeatPart,
        repeat_part_count: num(h.repeatPartCount),
        last_service_at: h.lastServiceAt,
        cross_company: h.crossCompany === true,
        events: events.map((e) => ({
          at: e.at,
          type: e.type,
          root_cause: e.rootCause,
          parts: [...e.parts],
          callback: e.callback === true,
          single: e.single === true,
        })),
      },
      atlas: atlas.map((c) => ({
        failure_mode: c.failureMode,
        units_observed: num(c.unitsObserved),
        failure_rate_pct: num(c.failureRatePct),
        median_age_months: numOrNull(c.medianAgeMonths),
        p25_age_months: numOrNull(c.p25AgeMonths),
        p75_age_months: numOrNull(c.p75AgeMonths),
        contributor_count: num(c.contributorCount),
      })),
    },
    derived: deriveFeatures(unit, asOf),
    meta: {
      events_total: h.events.length,
      events_kept: events.length,
      atlas_total: unit.atlas.length,
      atlas_kept: atlas.length,
      replayable: events.length === h.events.length && atlas.length === unit.atlas.length,
    },
  };
}

export interface BuildSnapshotRowArgs {
  owner: string;
  unit: UnitInput;
  asOf: Date;
  engineVersion: string;
  /** pfn_forecasts.id this snapshot fed (null for ad-hoc / back-test snapshots). */
  sourceId: string | null;
}

/** DB row for ml_feature_snapshots. The unique key is (user_id, engine, feature_set_version, entity_type, entity_id, as_of). */
export function buildPfnSnapshotRow(args: BuildSnapshotRowArgs): PfnSnapshotRow {
  const features = buildPfnFeatureVector(args.unit, args.asOf);
  return {
    user_id: args.owner,
    engine: PFN_SNAPSHOT_ENGINE,
    engine_version: args.engineVersion,
    feature_set_version: PFN_FEATURE_SET_VERSION,
    entity_type: PFN_SNAPSHOT_ENTITY_TYPE,
    entity_id: args.unit.equipmentId,
    as_of: features.as_of,
    features,
    features_hash: fingerprintOf(features),
    source_table: args.sourceId ? PFN_SNAPSHOT_SOURCE_TABLE : null,
    source_id: args.sourceId,
  };
}

/** Conflict target for upsert(..., { ignoreDuplicates: true }) — must match uq_ml_feature_snapshots_point. */
export const PFN_SNAPSHOT_CONFLICT_TARGET = "user_id,engine,feature_set_version,entity_type,entity_id,as_of";

export type ReplayResult = { ok: true; unit: UnitInput } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Rebuilds the UnitInput from a stored snapshot (the JSON read back from the DB is untrusted shape-wise).
 * Refuses unknown feature-set versions and capped (non-replayable) snapshots rather than guessing.
 */
export function unitInputFromPfnFeatures(
  features: unknown,
  ids: { equipmentId: string; customerId: string | null },
): ReplayResult {
  if (!isObj(features)) return { ok: false, reason: "features is not an object" };
  if (features.feature_set_version !== PFN_FEATURE_SET_VERSION) {
    return { ok: false, reason: `unsupported feature_set_version: ${String(features.feature_set_version)}` };
  }
  const meta = features.meta;
  if (!isObj(meta) || meta.replayable !== true) return { ok: false, reason: "snapshot is not replayable (arrays were capped)" };
  const i = features.inputs;
  if (!isObj(i) || !isObj(i.history) || !isObj(i.weather) || !Array.isArray(i.atlas) || !Array.isArray(i.history.events)) {
    return { ok: false, reason: "inputs are malformed" };
  }
  if (typeof i.equipment_type !== "string") return { ok: false, reason: "inputs.equipment_type is missing" };
  const h = i.history;
  const p = i.profile;

  const unit: UnitInput = {
    equipmentId: ids.equipmentId,
    customerId: ids.customerId,
    equipmentType: i.equipment_type,
    make: (i.make as string | null) ?? null,
    model: (i.model as string | null) ?? null,
    installDate: (i.install_date as string | null) ?? null,
    lastServiceDate: (i.last_service_date as string | null) ?? null,
    expectedLifespanYears: num(i.expected_lifespan_years),
    serviceIntervalMonths: num(i.service_interval_months),
    customerType: (i.customer_type as UnitInput["customerType"]) ?? null,
    profile: isObj(p)
      ? { dutyClass: p.duty_class as Duty, environment: p.environment as Env }
      : null,
    history: {
      events: (h.events as Array<Record<string, unknown>>).map(
        (e): UnitHistoryEvent => ({
          at: String(e.at),
          type: (e.type as string | null) ?? null,
          rootCause: (e.root_cause as string | null) ?? null,
          parts: Array.isArray(e.parts) ? e.parts.map(String) : [],
          callback: e.callback === true,
          single: e.single === true,
        }),
      ),
      repairs12m: num(h.repairs12m),
      repairs6m: num(h.repairs6m),
      repairsPrev6m: num(h.repairs_prev6m),
      callbacks12m: num(h.callbacks12m),
      companies24m: num(h.companies24m),
      repeatPart: (h.repeat_part as string | null) ?? null,
      repeatPartCount: num(h.repeat_part_count),
      lastServiceAt: (h.last_service_at as string | null) ?? null,
      crossCompany: h.cross_company === true,
    },
    atlas: (i.atlas as Array<Record<string, unknown>>).map(
      (c): AtlasCell => ({
        failureMode: String(c.failure_mode),
        unitsObserved: num(c.units_observed),
        failureRatePct: num(c.failure_rate_pct),
        medianAgeMonths: numOrNull(c.median_age_months),
        p25AgeMonths: numOrNull(c.p25_age_months),
        p75AgeMonths: numOrNull(c.p75_age_months),
        contributorCount: num(c.contributor_count),
      }),
    ),
    weather: { heat30d: num(i.weather.heat30d), cold30d: num(i.weather.cold30d) },
  };
  return { ok: true, unit };
}
