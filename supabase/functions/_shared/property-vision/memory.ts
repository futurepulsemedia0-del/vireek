// supabase/functions/_shared/property-vision/memory.ts
//
// The "memory" half of Persistent Property Vision — pure, deterministic and
// unit-tested. Given what the vision model saw in THIS visit and what we
// already remember about the property, it decides:
//   1. identity   — is this the same physical unit as before? (never merged silently)
//   2. asset diff — what changed (condition, model/serial now known, age evidence)
//   3. findings   — new / seen again / worsened / no longer visible / reopened
//   4. context    — the compact memory block handed to the model next time
//
// Hard rules encoded here:
//   - Low-confidence identity => NEW asset + "possible duplicate" suggestion, never an auto-merge.
//   - A serial that is clearly legible and DIFFERENT from a known verified serial blocks any match.
//   - "Not visible in this photo" => not_reobserved (needs a human), never auto-resolved.
//   - A dismissed finding stays dismissed (a human decision is respected).

import {
  AGE_BASIS_RANK, CONDITION_SCORE, ageYears, lifespanFor, remainingLifeYears, severityRank,
  type AgeBasis, type Condition, type FindingType, type InstallQuality, type NormEquipment,
  type NormFinding, type PriorStatus, type Severity,
} from "./taxonomy.ts";
import { humanize, serialLooseKey } from "./normalize.ts";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export interface KnownAsset {
  id: string;
  ref?: string;
  kind: string;
  label: string;
  location_label: string | null;
  make: string | null;
  model: string | null;
  specs: string | null;
  serial_norm: string | null;
  serial_verified: boolean;
  condition: Condition;
  installation_quality: InstallQuality;
  install_year: number | null;
  age_basis: AgeBasis;
  age_years_est: number | null;
  expected_lifespan_years: number | null;
  human_confirmed: boolean;
  last_seen_at: string;
}

export interface ExistingFinding {
  id: string;
  finding_type: FindingType;
  code: string;
  locus: string;
  title: string;
  severity: Severity;
  status: "open" | "not_reobserved" | "resolved" | "dismissed";
  times_observed: number;
  first_seen_at?: string;
}

export type MatchStatus = "auto" | "suggested" | "new";
export interface MatchDecision {
  status: MatchStatus;
  assetId: string | null;
  candidateId: string | null;
  confidence: number;
  basis: string;
}

export interface EventDraft {
  event_type:
    | "first_seen" | "observed" | "condition_changed" | "model_identified" | "serial_identified"
    | "age_estimated" | "finding_new" | "finding_worsened" | "finding_reopened" | "finding_not_reobserved"
    | "component_observed" | "component_replaced_suspected" | "identity_conflict" | "possible_duplicate";
  severity: Severity;
  summary: string;
  delta: Record<string, unknown>;
  event_key: string;
  finding_key: string | null;
  finding_type: FindingType | null;
}

// ------------------------------------------------------------------
// 1. Identity resolution
// ------------------------------------------------------------------

const alnum = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function softEq(a: string | null, b: string | null): boolean {
  const x = alnum(a), y = alnum(b);
  if (!x || !y) return true; // unknown on either side is not a conflict
  return x === y || x.includes(y) || y.includes(x);
}

function clearSerial(eq: NormEquipment): string | null {
  return eq.serial_legibility === "clear" ? eq.serial_norm : null;
}

/** Could this detected unit physically be that known asset? (Conflict = definitely not.) */
export function isCompatible(eq: NormEquipment, a: KnownAsset): boolean {
  if (!(eq.kind === "other" || a.kind === "other" || eq.kind === a.kind)) return false;
  const s = clearSerial(eq);
  if (s && a.serial_norm && a.serial_verified && s !== a.serial_norm) return false;
  if (!softEq(eq.make, a.make) || !softEq(eq.model, a.model)) return false;
  return true;
}

export function resolveAssets(
  equipment: NormEquipment[], known: KnownAsset[], ctx: { forcedAssetId?: string | null } = {},
): MatchDecision[] {
  const out: (MatchDecision | null)[] = equipment.map(() => null);
  const used = new Set<string>();
  const byId = new Map(known.map((a) => [a.id, a]));
  const byRef = new Map(known.filter((a) => a.ref).map((a) => [a.ref as string, a]));

  const take = (i: number, d: MatchDecision) => {
    out[i] = d;
    if (d.status === "auto" && d.assetId) used.add(d.assetId);
  };

  // Pass 1 — exact, clearly-legible serial: the strongest identity signal there is.
  equipment.forEach((eq, i) => {
    const s = clearSerial(eq);
    if (!s) return;
    const hit = known.find((a) => !used.has(a.id) && a.serial_verified && a.serial_norm === s && isCompatible(eq, a));
    if (hit) take(i, { status: "auto", assetId: hit.id, candidateId: null, confidence: 0.99, basis: "serial_exact" });
  });

  // Pass 2 — user pinned a specific asset ("re-photograph this unit").
  const forced = ctx.forcedAssetId ? byId.get(ctx.forcedAssetId) : undefined;
  if (forced && !used.has(forced.id)) {
    const candidates = equipment.map((eq, i) => ({ eq, i })).filter(({ eq, i }) => out[i] === null && isCompatible(eq, forced));
    const byModelRef = candidates.find(({ eq }) => eq.match_ref && eq.match_ref === forced.ref);
    const contradicts = (eq: NormEquipment) => {
      const other = eq.match_ref ? byRef.get(eq.match_ref) : undefined;
      return !!other && other.id !== forced.id && eq.match_confidence >= 0.85;
    };
    const pick = byModelRef ?? (candidates.length === 1 && !contradicts(candidates[0].eq) ? candidates[0] : undefined);
    if (pick) take(pick.i, { status: "auto", assetId: forced.id, candidateId: null, confidence: 0.9, basis: "user_pinned" });
  }

  // Pass 3 — model reference, near-serial and heuristic suggestions.
  equipment.forEach((eq, i) => {
    if (out[i]) return;

    const s = clearSerial(eq);
    if (s) {
      const loose = serialLooseKey(s);
      const near = known.find((a) => !used.has(a.id) && a.serial_norm && a.serial_norm !== s && serialLooseKey(a.serial_norm) === loose);
      if (near) return void (out[i] = { status: "suggested", assetId: null, candidateId: near.id, confidence: 0.7, basis: "serial_near_match" });
    }

    const ref = eq.match_ref ? byRef.get(eq.match_ref) : undefined;
    if (ref && !used.has(ref.id) && isCompatible(eq, ref)) {
      if (eq.match_confidence >= 0.85) return take(i, { status: "auto", assetId: ref.id, candidateId: null, confidence: eq.match_confidence, basis: "visual_match" });
      if (eq.match_confidence >= 0.5) return void (out[i] = { status: "suggested", assetId: null, candidateId: ref.id, confidence: eq.match_confidence, basis: "visual_match_low_confidence" });
    }

    if (eq.make && eq.model && eq.location_label) {
      const same = known.filter((a) =>
        !used.has(a.id) && a.kind === eq.kind && alnum(a.make) === alnum(eq.make) && alnum(a.model) === alnum(eq.model) &&
        alnum(a.location_label) === alnum(eq.location_label) && isCompatible(eq, a));
      if (same.length === 1) {
        return void (out[i] = { status: "suggested", assetId: null, candidateId: same[0].id, confidence: 0.6, basis: "same_make_model_location" });
      }
    }
    out[i] = { status: "new", assetId: null, candidateId: null, confidence: 0, basis: "no_match" };
  });

  return out as MatchDecision[];
}

// ------------------------------------------------------------------
// 2. Assets: build / diff
// ------------------------------------------------------------------

function assetLabel(eq: NormEquipment): string {
  return [humanize(eq.kind), eq.make, eq.location_label].filter(Boolean).join(" · ").slice(0, 200);
}

export interface AssetScope { userId: string; customerId: string | null; propertyKey: string | null }

/** Row for property_assets (snake_case = column names). */
export function buildAssetInsert(
  eq: NormEquipment, scope: AssetScope, nowIso: string, nowYear: number,
  duplicate: { candidateId: string; confidence: number } | null,
): Record<string, unknown> {
  const lifespan = lifespanFor(eq.kind);
  const age = ageYears(eq.age_basis, eq.install_year, eq.age_range, nowYear);
  const serialOk = eq.serial_legibility === "clear" && eq.serial_norm;
  return {
    user_id: scope.userId,
    customer_id: scope.customerId,
    property_key: scope.propertyKey,
    kind: eq.kind,
    label: assetLabel(eq),
    location_label: eq.location_label,
    make: eq.make,
    model: eq.model,
    specs: eq.specs,
    serial_number: serialOk ? eq.serial_raw : null,
    serial_norm: serialOk ? eq.serial_norm : null,
    serial_verified: !!serialOk,
    condition: eq.condition,
    condition_score: CONDITION_SCORE[eq.condition],
    install_year: eq.install_year,
    age_basis: eq.age_basis,
    age_confidence: eq.age_basis === "unknown" ? null : eq.age_confidence,
    age_years_est: age,
    age_range_min: eq.age_range?.[0] != null ? Math.round(eq.age_range[0]) : null,
    age_range_max: eq.age_range?.[1] != null ? Math.round(eq.age_range[1]) : null,
    expected_lifespan_years: lifespan,
    remaining_life_years: remainingLifeYears(lifespan, age, eq.condition),
    installation_quality: eq.installation_quality,
    match_confidence: duplicate?.confidence ?? null,
    possible_duplicate_of: duplicate?.candidateId ?? null,
    first_seen_at: nowIso,
    last_seen_at: nowIso,
    updated_at: nowIso,
  };
}

export interface AssetPlan { patch: Record<string, unknown>; events: EventDraft[] }

export function planAssetUpdate(a: KnownAsset, eq: NormEquipment, nowIso: string, nowYear: number): AssetPlan {
  const patch: Record<string, unknown> = { last_seen_at: nowIso, updated_at: nowIso };
  const events: EventDraft[] = [];
  const ev = (e: Omit<EventDraft, "finding_key" | "finding_type" | "event_key">) =>
    events.push({ ...e, event_key: `${e.event_type}:${a.id}`, finding_key: null, finding_type: null });

  // Fill-only identity fields: a human-confirmed or earlier value is never silently overwritten.
  if (!a.make && eq.make) patch.make = eq.make;
  if (!a.model && eq.model) {
    patch.model = eq.model;
    ev({ event_type: "model_identified", severity: "info", summary: `Model identified: ${[eq.make ?? a.make, eq.model].filter(Boolean).join(" ")}`, delta: { model: eq.model } });
  }
  if (!a.specs && eq.specs) patch.specs = eq.specs;
  if (!a.location_label && eq.location_label) patch.location_label = eq.location_label;
  if (a.kind === "other" && eq.kind !== "other") {
    patch.kind = eq.kind;
    patch.expected_lifespan_years = lifespanFor(eq.kind);
  }

  const s = clearSerial(eq);
  if (s && !a.serial_norm) {
    patch.serial_number = eq.serial_raw;
    patch.serial_norm = s;
    patch.serial_verified = true;
    ev({ event_type: "serial_identified", severity: "info", summary: "Serial number read from the data plate", delta: {} });
  }

  // Condition: latest assessment wins; a change is a timeline event.
  let condition = a.condition;
  if (eq.condition !== "unknown") {
    condition = eq.condition;
    patch.condition = eq.condition;
    patch.condition_score = CONDITION_SCORE[eq.condition];
    if (a.condition !== "unknown" && a.condition !== eq.condition) {
      const before = CONDITION_SCORE[a.condition] ?? 0;
      const after = CONDITION_SCORE[eq.condition] ?? 0;
      const worse = after < before;
      ev({
        event_type: "condition_changed",
        severity: worse ? (eq.condition === "critical" ? "high" : "medium") : "info",
        summary: `Condition ${worse ? "worsened" : "improved"}: ${a.condition} → ${eq.condition}`,
        delta: { from: a.condition, to: eq.condition, direction: worse ? "worse" : "better" },
      });
    }
  }
  if (eq.installation_quality !== "unknown") patch.installation_quality = eq.installation_quality;

  // Age: only replace with strictly better evidence (a human value outranks everything).
  let age = a.age_years_est;
  if (AGE_BASIS_RANK[eq.age_basis] > AGE_BASIS_RANK[a.age_basis]) {
    age = ageYears(eq.age_basis, eq.install_year, eq.age_range, nowYear);
    patch.age_basis = eq.age_basis;
    patch.install_year = eq.install_year;
    patch.age_confidence = eq.age_confidence;
    patch.age_years_est = age;
    patch.age_range_min = eq.age_range ? Math.round(eq.age_range[0]) : null;
    patch.age_range_max = eq.age_range ? Math.round(eq.age_range[1]) : null;
    ev({
      event_type: "age_estimated", severity: "info",
      summary: eq.install_year ? `Install year ${eq.install_year} (${eq.age_basis.replace("_", " ")})` : `Estimated age ${eq.age_range?.[0]}–${eq.age_range?.[1]} years (visual)`,
      delta: { basis: eq.age_basis },
    });
  }
  const lifespan = (patch.expected_lifespan_years as number | undefined) ?? a.expected_lifespan_years ?? lifespanFor((patch.kind as string) ?? a.kind);
  patch.expected_lifespan_years = lifespan;
  patch.remaining_life_years = remainingLifeYears(lifespan, age, condition);

  ev({ event_type: "observed", severity: "info", summary: "Photographed again", delta: {} });
  return { patch, events };
}

// ------------------------------------------------------------------
// 3. Findings reconcile
// ------------------------------------------------------------------

export const findingKey = (type: string, code: string, locus: string) => `${type}|${code}|${locus}`;

export interface FindingInsert { key: string; finding: NormFinding }
export interface FindingUpdate { id: string; key: string; patch: Record<string, unknown> }
export interface ReconcileResult { inserts: FindingInsert[]; updates: FindingUpdate[]; events: EventDraft[] }

function dedupeObserved(list: NormFinding[]): NormFinding[] {
  const m = new Map<string, NormFinding>();
  for (const f of list) {
    const k = findingKey(f.type, f.code, f.locus);
    const prev = m.get(k);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) m.set(k, f);
  }
  return [...m.values()];
}

export function reconcileFindings(
  existing: ExistingFinding[], observedRaw: NormFinding[], priorById: Record<string, PriorStatus>, nowIso: string,
): ReconcileResult {
  const observed = dedupeObserved(observedRaw);
  const byKey = new Map(existing.map((e) => [findingKey(e.finding_type, e.code, e.locus), e]));
  const matched = new Set<string>();
  const res: ReconcileResult = { inserts: [], updates: [], events: [] };

  const evt = (e: Omit<EventDraft, "event_key">, key: string): void => {
    res.events.push({ ...e, event_key: `${e.event_type}:${key}` });
  };

  const findMatch = (f: NormFinding): ExistingFinding | undefined => {
    const exact = byKey.get(findingKey(f.type, f.code, f.locus));
    if (exact && !matched.has(exact.id)) return exact;
    const sameCode = existing.filter((e) => e.finding_type === f.type && e.code === f.code && !matched.has(e.id));
    if (f.locus === "") return sameCode.length === 1 ? sameCode[0] : undefined;
    return sameCode.find((e) => e.locus === "");
  };

  for (const f of observed) {
    const key = findingKey(f.type, f.code, f.locus);
    const hit = findMatch(f);
    if (!hit) {
      res.inserts.push({ key, finding: f });
      if (f.type === "component") {
        evt({ event_type: "component_observed", severity: "info", summary: `Component recorded: ${f.title}`, delta: { code: f.code }, finding_key: key, finding_type: f.type }, key);
        if (f.attrs.origin === "appears_replaced") {
          evt({ event_type: "component_replaced_suspected", severity: "info", summary: `${f.title} appears newer than the surrounding equipment — verify against job/parts records`, delta: {}, finding_key: key, finding_type: f.type }, key);
        }
      } else {
        evt({ event_type: "finding_new", severity: f.severity, summary: `New: ${f.title}`, delta: { severity: f.severity, code: f.code }, finding_key: key, finding_type: f.type }, key);
      }
      continue;
    }

    matched.add(hit.id);
    const patch: Record<string, unknown> = {
      last_seen_at: nowIso,
      times_observed: hit.times_observed + 1,
      severity: f.severity,
    };
    if (f.description) patch.description = f.description;
    if (f.region) patch.region = f.region;
    const hitKey = findingKey(hit.finding_type, hit.code, hit.locus);

    if (hit.status === "resolved" || hit.status === "not_reobserved") {
      patch.status = "open";
      patch.resolved_at = null;
      patch.resolved_by = null;
      if (hit.finding_type !== "component") {
        evt({ event_type: "finding_reopened", severity: f.severity, summary: `Seen again: ${hit.title}`, delta: { from: hit.status }, finding_key: hitKey, finding_type: hit.finding_type }, hitKey);
      }
    }
    // dismissed => stays dismissed (no status in patch).
    if (hit.status !== "dismissed" && severityRank(f.severity) > severityRank(hit.severity) && hit.finding_type !== "component") {
      evt({ event_type: "finding_worsened", severity: f.severity, summary: `Worsened: ${hit.title} (${hit.severity} → ${f.severity})`, delta: { from: hit.severity, to: f.severity }, finding_key: hitKey, finding_type: hit.finding_type }, hitKey);
    }
    res.updates.push({ id: hit.id, key: hitKey, patch });
  }

  // Previously open findings the model did not list this time.
  for (const e of existing) {
    if (matched.has(e.id) || e.finding_type === "component") continue;
    const verdict = priorById[e.id];
    const key = findingKey(e.finding_type, e.code, e.locus);
    if (verdict === "no_longer_visible" && e.status === "open") {
      res.updates.push({ id: e.id, key, patch: { status: "not_reobserved" } });
      evt({ event_type: "finding_not_reobserved", severity: "info", summary: `${e.title} is no longer visible — confirm whether it was fixed`, delta: {}, finding_key: key, finding_type: e.finding_type }, key);
    } else if (verdict === "still_visible" && (e.status === "open" || e.status === "not_reobserved")) {
      res.updates.push({ id: e.id, key, patch: { last_seen_at: nowIso, times_observed: e.times_observed + 1, ...(e.status === "not_reobserved" ? { status: "open" } : {}) } });
    }
  }
  return res;
}

/** Events worth waking a human for (new/worse/reopened HIGH or EMERGENCY safety findings). */
export function notifiableEvents(events: EventDraft[]): EventDraft[] {
  return events.filter((e) =>
    (e.event_type === "finding_new" || e.event_type === "finding_worsened" || e.event_type === "finding_reopened") &&
    (e.finding_type === "hazard" || e.finding_type === "installation_issue") && severityRank(e.severity) >= 4);
}

// ------------------------------------------------------------------
// 4. Memory context for the model
// ------------------------------------------------------------------

export interface ContextFinding {
  id: string; finding_type: FindingType; code: string; locus: string; severity: string;
  status: string; first_seen_at: string; times_observed: number;
}

const MAX_CONTEXT_ASSETS = 12;
const MAX_CONTEXT_FINDINGS = 6;

export function buildMemoryContext(assets: KnownAsset[], findings: Map<string, ContextFinding[]>) {
  const assetByRef = new Map<string, string>();
  const findingByRef = new Map<string, string>();
  const refByAssetId = new Map<string, string>();
  const lines: string[] = [];

  assets.slice(0, MAX_CONTEXT_ASSETS).forEach((a, i) => {
    const ref = `A${i + 1}`;
    a.ref = ref;
    assetByRef.set(ref, a.id);
    refByAssetId.set(a.id, ref);
    const d = (s: string) => s.slice(0, 10);
    lines.push(
      `${ref} | ${a.kind} | ${[a.make, a.model].filter(Boolean).join(" ") || "make/model unknown"} | serial ${a.serial_norm ?? "unknown"}` +
      ` | location: ${a.location_label ?? "unknown"} | condition: ${a.condition} | last seen ${d(a.last_seen_at)}` +
      `${a.install_year ? ` | install ~${a.install_year}` : ""}`,
    );
    const open = (findings.get(a.id) ?? [])
      .filter((f) => f.status === "open" || f.status === "not_reobserved")
      .sort((x, y) => severityRank(y.severity) - severityRank(x.severity))
      .slice(0, MAX_CONTEXT_FINDINGS);
    open.forEach((f, j) => {
      const fref = `${ref}.F${j + 1}`;
      findingByRef.set(fref, f.id);
      lines.push(`  ${fref} | ${f.finding_type} | ${f.code}${f.locus ? ` @ ${f.locus}` : ""} | ${f.severity} | ${f.status} | first seen ${d(f.first_seen_at)}`);
    });
  });

  return { text: lines.join("\n"), assetByRef, findingByRef, refByAssetId };
}
