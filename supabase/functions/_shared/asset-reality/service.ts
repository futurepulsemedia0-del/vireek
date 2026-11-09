// supabase/functions/_shared/asset-reality/service.ts
// Thin I/O layer (server-side, service-role client injected). All decisions live in the pure modules.
//   recordMeasurement -> normalize -> asset_measurements (idempotent) -> truth claim -> state refresh
//   assetGate         -> Operational Truth gate + decision log; SHADOW mode never changes the caller's behavior.
import { normalizeMeasurement, type RawMeasurementInput, type CanonicalMeasurement } from "./measurement.ts";
import { resolveAttribute, predicateFor, type AssetClaim, type ClaimMethod } from "./state.ts";

// Structural client type so tests can inject a fake (no SDK import).
export interface Db {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const SOURCE_FOR: Record<CanonicalMeasurement["method"], string> = {
  instrument: "instrument_bluetooth", sensor: "installed_sensor", manual: "technician_measurement", ocr: "nameplate_ocr", derived: "vireek_system",
};
const METHOD_FOR_SOURCE: Record<string, ClaimMethod> = {
  instrument_bluetooth: "instrument", installed_sensor: "sensor", technician_measurement: "manual", nameplate_ocr: "ocr",
  oem_database: "database", owner_attested: "attestation", other_company_attestation: "attestation", regulatory_record: "regulatory", vireek_system: "sensor",
};

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic key => replays and out-of-order batches collapse to one row. */
export async function idempotencyKey(equipmentId: string, m: CanonicalMeasurement, origin: string): Promise<string> {
  return (await sha256Hex([origin, equipmentId, m.kind, m.measured_at, m.input_value, m.input_unit, m.instrument?.id ?? ""].join("|"))).slice(0, 48);
}

export type RecordResult = { ok: true; measurement_id: string; claim_id: string | null } | { ok: false; reason: string };

export async function recordMeasurement(db: Db, userId: string, raw: RawMeasurementInput & { equipment_id: string }, origin: string, now: Date = new Date()): Promise<RecordResult> {
  const n = normalizeMeasurement(raw, now);
  if (!n.ok) return { ok: false, reason: n.reason };
  const m = n.measurement;
  const idem = await idempotencyKey(raw.equipment_id, m, origin);
  const { data, error } = await db.rpc("asset_measurement_record", { p_user: userId, p_row: { ...m, idempotency_key: idem, source_table: origin } });
  if (error) return { ok: false, reason: error.code === "42501" ? "forbidden" : "store_failed" };
  const measurementId = String(data);

  // Claim through Operational Truth (the single trust engine). Unregistered kinds are stored but make no claim.
  const predicate = predicateFor(m.kind);
  let claimId: string | null = null;
  if (predicate && !m.quality.includes("ocr_unconfirmed")) {
    const source = SOURCE_FOR[m.method];
    const conf = Math.min(0.999, m.quality.includes("uncalibrated") || m.quality.includes("calibration_expired") ? 0.8 : 0.92);
    const res = await db.rpc("truth_write_claim", {
      p_user: userId, p_actor: null, p_subject_type: "asset", p_subject_id: raw.equipment_id, p_predicate: predicate,
      p_value: m.value, p_source_key: source, p_source_ref: `asset_measurements:${measurementId}`,
      p_verified_at: m.measured_at, p_expires_at: null, p_confidence: conf, p_method: m.method === "instrument" ? "instrument" : "asserted",
      p_evidence: m.evidence_digest ? [{ kind: "photo", content_hash: m.evidence_digest }] : [],
    });
    if (!res.error) claimId = String(res.data);
  }
  await refreshAttribute(db, userId, raw.equipment_id, m.kind, now).catch((e) => console.error("asset state refresh failed", e instanceof Error ? e.message : e));
  return { ok: true, measurement_id: measurementId, claim_id: claimId };
}

export async function refreshAttribute(db: Db, userId: string, equipmentId: string, attribute: string, now: Date = new Date()): Promise<void> {
  const predicate = predicateFor(attribute);
  if (!predicate) return;
  const { data, error } = await db.from("truth_facts")
    .select("id, value, source_key, verified_at, verification_method, user_id")
    .eq("user_id", userId).eq("subject_type", "asset").eq("subject_id", equipmentId).eq("predicate", predicate).eq("status", "current");
  if (error) throw new Error(error.message);
  const claims: AssetClaim[] = ((data ?? []) as Array<{ id: string; value: unknown; source_key: string; verified_at: string; verification_method: string }>)
    .filter((r) => ["number", "string", "boolean"].includes(typeof r.value))
    .map((r) => ({
      id: r.id, attribute, value: r.value as number | string | boolean, source_key: r.source_key,
      method: METHOD_FOR_SOURCE[r.source_key] ?? "manual", measured_at: r.verified_at,
      verified: r.verification_method === "human_confirmed", confirmed: r.verification_method === "human_confirmed",
    }));
  const st = resolveAttribute(attribute, claims, now);
  const newest = claims.map((c) => c.measured_at).sort().pop() ?? null;
  const up = await db.rpc("asset_state_upsert", { p_user: userId, p_equipment: equipmentId, p_state: { ...st, measured_at: newest } });
  if (up.error) throw new Error(up.error.message);
}

export interface GateDecision { allow: boolean; claim_ids: string[]; status: string; shadow: boolean; would_change_behavior: boolean }

/**
 * Agent gate for asset facts. Reads the materialized state (fast), logs the claim ids relied on.
 * shadow=true: returns allow=true to the caller regardless (behavior unchanged) but records what WOULD be blocked.
 * Fail-closed when enforcing; fail-open ONLY in shadow (and logged) so a layer outage cannot change live behavior.
 */
export async function assetGate(db: Db, userId: string, agent: string, equipmentId: string, attribute: string, opts: { safetyCritical?: boolean } = {}): Promise<GateDecision> {
  const flags = await db.from("asset_reality_flags").select("shadow, enforce").eq("user_id", userId).maybeSingle();
  const shadow = flags.data ? Boolean(flags.data.shadow) : true;
  const enforce = flags.data ? Boolean(flags.data.enforce) : false;
  if (!flags.data && flags.error) console.error("asset flags read failed", flags.error.message);

  const q = await db.from("asset_state").select("status, winning_claim_id, conflict_claim_ids, safety_eligible, confidence")
    .eq("user_id", userId).eq("equipment_id", equipmentId).eq("attribute", attribute).maybeSingle();
  let allow: boolean; let status: string; let ids: string[] = [];
  if (q.error) { allow = false; status = "state_unavailable"; }
  else if (!q.data) { allow = false; status = "unknown"; }
  else {
    status = q.data.status;
    ids = q.data.status === "conflict" ? q.data.conflict_claim_ids ?? [] : q.data.winning_claim_id ? [q.data.winning_claim_id] : [];
    allow = q.data.status === "ok" && Number(q.data.confidence) >= 0.7 && (!opts.safetyCritical || q.data.safety_eligible === true);
  }
  const would = !allow;
  await db.rpc("asset_decision_log_write", {
    p_user: userId, p_equipment: equipmentId, p_agent: agent, p_attribute: attribute, p_claim_ids: ids, p_verdict: status,
    p_allowed: allow, p_shadow: shadow && !enforce, p_would_change: would,
  }).then((r) => { if (r.error) console.error("asset decision log failed", r.error.message); });
  const effective = shadow && !enforce ? true : allow;
  return { allow: effective, claim_ids: ids, status, shadow: shadow && !enforce, would_change_behavior: would };
}
