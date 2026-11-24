// supabase/functions/_shared/vertical-ai/runtime.ts
//
// Database/IO glue for the Vertical AI layer, shared by the live voice tools in vapi-webhook. All tenant reads are
// explicitly scoped (`.eq("user_id", ...)` on the service-role client). The decisions themselves live in the PURE
// modules (answer.ts, pricing.ts, intake.ts, emergencyRules.ts), which are unit-tested and eval-measured.
//
// Failure policy: telemetry never breaks a call; a failed ontology read falls back to the bundled seed; a failed
// price-book read answers "a team member will confirm" (never a guess); emergency detection needs no I/O at all.

import { recordTraceEvent, type AdminLike, type TraceCtx } from "../observability/recorder.ts";
import { classifyUrgency, emergencyInstruction } from "./emergencyRules.ts";
import { gateEntriesForAi, type GovernedEntry } from "../safety-governance/hazardGovernance.ts";
import { normalizeIntake, type NormalizedIntake } from "./intake.ts";
import { ONTOLOGY_SEED } from "./ontologySeed.ts";
import type { OntologyEntry, OntologyPayload } from "./ontology.ts";
import { dollarsToCents, resolvePrice, type PriceContext } from "./pricing.ts";
import { REFUSAL_SPOKEN, screenRequest } from "./requestPolicy.ts";
import { emergencyOverrideEvent, groundingMissEvent, handoffEvent, intakeEvent, pricePathEvent, type VaiEvent } from "./telemetry.ts";
import type { PriceItemLite } from "../price-book/match.ts";
import type { SafetyFlag, Trade } from "./types.ts";

export type Admin = AdminLike;

// ---- ontology (global table, 5 minute cache, seed fallback) ---------------------------------------------------
let cache: { at: number; entries: OntologyEntry[] } | null = null;
const TTL_MS = 5 * 60_000;

interface OntologyRow {
  trade: string; kind: string; key: string; version: number; title: string; payload: OntologyPayload;
  source: string; effective_on: string; expires_on: string | null; jurisdiction: string; confidence: number | string; reviewed: boolean;
  reviewed_by?: string | null; reviewed_at?: string | null; review_expires_on?: string | null; hazard_domains?: string[] | null;
}

/**
 * Hazard-content gate (docs/safety/hazard-content-governance.md). Instructional gas / CO / electrical / refrigerant rows
 * without a CURRENT human review never reach the planner. Safety-rule floor rows are never blocked. Set the edge secret
 * HAZARD_CONTENT_GATE=report to log instead of block during a staged rollout.
 */
function applyHazardGate(entries: OntologyEntry[], now: number): OntologyEntry[] {
  const enforce = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get("HAZARD_CONTENT_GATE") !== "report";
  const r = gateEntriesForAi(entries as unknown as GovernedEntry[], new Date(now), enforce);
  if (r.blocked.length > 0 || r.unreviewedFloor.length > 0) {
    console.warn(JSON.stringify({ event: "hazard_content_gate", enforce, blocked: r.blocked.map((b) => `${b.kind}:${b.key}@v${b.version}`), unreviewed_floor: r.unreviewedFloor }));
  }
  return r.allowed as unknown as OntologyEntry[];
}

export async function loadOntology(admin: Admin, now: number = Date.now()): Promise<OntologyEntry[]> {
  if (cache && now - cache.at < TTL_MS) return cache.entries;
  try {
    const { data, error } = await admin.from("vertical_ontology_entries")
      .select("trade, kind, key, version, title, payload, source, effective_on, expires_on, jurisdiction, confidence, reviewed, reviewed_by, reviewed_at, review_expires_on, hazard_domains")
      .eq("status", "active");
    if (!error && Array.isArray(data) && data.length > 0) {
      const entries = (data as OntologyRow[]).map((r) => ({
        trade: r.trade as OntologyEntry["trade"], kind: r.kind as OntologyEntry["kind"], key: r.key, version: r.version, title: r.title,
        payload: r.payload, source: r.source, effectiveOn: r.effective_on, expiresOn: r.expires_on, jurisdiction: r.jurisdiction,
        confidence: Number(r.confidence), reviewed: r.reviewed === true,
        reviewedBy: r.reviewed_by ?? null, reviewedAt: r.reviewed_at ?? null, reviewExpiresOn: r.review_expires_on ?? null, declaredHazardDomains: r.hazard_domains ?? null,
      }));
      const gated = applyHazardGate(entries, now);
      cache = { at: now, entries: gated };
      return gated;
    }
  } catch { /* fall through to the bundled seed */ }
  return applyHazardGate([...ONTOLOGY_SEED], now);
}

/** Test hook. */
export function _resetOntologyCache(): void { cache = null; }

// ---- telemetry ------------------------------------------------------------------------------------------------
export async function emit(admin: Admin, ctx: TraceCtx | null, ev: VaiEvent): Promise<void> {
  if (!ctx) return;
  await recordTraceEvent(admin, ctx, { kind: ev.kind, name: ev.name, ok: ev.ok, attrs: ev.attrs });
}

// ---- emergency override (independent of the LLM) -------------------------------------------------------------
export interface EmergencyDeps {
  /** Existing flag_emergency_call implementation (sets calls.is_emergency, notifies on-call). */
  flag: () => Promise<string>;
  isAlreadyFlagged: () => Promise<boolean>;
}

/**
 * Run the deterministic rules over text the caller controls (tool arguments, transcript). If an emergency is
 * detected and the model has NOT already flagged it, flag it here. Returns the spoken instruction to PREPEND to the
 * tool result, or null. Never throws; works with every LLM provider down because classifyUrgency is pure.
 */
export async function applyEmergencyOverride(
  admin: Admin, trace: TraceCtx | null, text: string, deps: EmergencyDeps, opts: { outdoorTempF?: number | null; source: string },
): Promise<{ flags: SafetyFlag[]; spoken: string } | null> {
  let v;
  try { v = classifyUrgency({ text, outdoorTempF: opts.outdoorTempF ?? null }); } catch { return null; }
  if (!v.override) return null;
  let modelFlagged = false;
  try { modelFlagged = await deps.isAlreadyFlagged(); } catch { /* unknown: treat as not flagged and flag */ }
  let transfer = "";
  if (!modelFlagged) {
    try { transfer = await deps.flag(); } catch { transfer = "Please connect the caller to the on-call number immediately."; }
  }
  await emit(admin, trace, emergencyOverrideEvent({ flags: v.flags, rules: v.rules, modelFlagged, source: opts.source }));
  const instr = emergencyInstruction(v.flags);
  return { flags: v.flags, spoken: [instr?.text ?? "", transfer].filter(Boolean).join(" ") };
}

// ---- deterministic price tool ---------------------------------------------------------------------------------
export interface PriceToolInput {
  userId: string;
  query: string;
  afterHours: boolean;
  /** business_profile.after_hours_fee in DOLLARS (numeric column); converted to cents here. */
  afterHoursFee: number | string | null;
  emergency: boolean;
  vapiCallId?: string | null;
  /** AI commit controls: given the highest amount (cents) the assistant is about to speak, returns an instruction to use INSTEAD of the quote, or null. */
  commitGate?: (spokenMaxCents: number) => Promise<string | null>;
}

export async function lookupPriceDeterministic(admin: Admin, trace: TraceCtx | null, input: PriceToolInput): Promise<string> {
  const screen = screenRequest(input.query);
  if (screen.intent !== "none") {
    await emit(admin, trace, handoffEvent({ reason: `request_${screen.intent}`, action: "handoff" }));
    return `${REFUSAL_SPOKEN[screen.intent as keyof typeof REFUSAL_SPOKEN]} Do not mention any dollar amount.`;
  }

  const { data: items, error } = await admin.from("price_book_items")
    .select("id, service_name, category, pricing_model, price_cents, price_max_cents, unit_label, keywords")
    .eq("user_id", input.userId)
    .eq("active", true);
  if (error) {
    await emit(admin, trace, handoffEvent({ reason: "price_book_unreadable", action: "handoff" }));
    return "I couldn't reach the price list right now  let the caller know a team member will confirm pricing.";
  }

  const ctx: PriceContext = {
    afterHours: input.afterHours, emergency: input.emergency, afterHoursFeeCents: dollarsToCents(input.afterHoursFee),
    emergencyMultiplier: null, membershipDiscountPct: null, isMember: false, taxable: null,
  };
  const res = resolvePrice((items ?? []) as PriceItemLite[], input.query, ctx);
  await emit(admin, trace, pricePathEvent({ status: res.status, path: res.path, candidates: res.candidates.length }));

  if (res.status === "no_price_book") {
    return "No price list has been set up for this business yet  let the caller know a team member will follow up with pricing.";
  }
  if (res.status === "no_match") {
    await emit(admin, trace, groundingMissEvent({ type: "price", reason: "no_evidence" }));
    await emit(admin, trace, handoffEvent({ reason: "price_no_match", action: "handoff" }));
    return `Nothing on the price list matches "${input.query.slice(0, 80)}"  let the caller know a team member will confirm that price. Do not guess or estimate an amount.`;
  }

  try {
    await admin.from("price_lookup_log").insert({
      user_id: input.userId, external_call_id: input.vapiCallId ?? null, query: input.query.slice(0, 200),
      matched_items: res.candidates.map((c) => ({ service_name: c.serviceName, pricing_model: c.model, price_cents: c.baseCents, price_max_cents: c.baseMaxCents })),
    });
  } catch { /* logging is best-effort */ }
  if (input.commitGate) {
    const spokenMax = Math.max(...res.candidates.map((c) => c.totalToCents ?? c.totalFromCents));
    const held = await input.commitGate(spokenMax);
    if (held !== null) return held;
  }
  if (res.status === "ambiguous") {
    return `A few things matched "${input.query.slice(0, 80)}": ${res.candidates.map((c) => c.spoken).join(" ")} Ask which one the caller means before quoting; never combine or average amounts.`;
  }
  const c = res.candidates[0];
  return `${c.spoken} Quote ONLY this exact amount; never round, add, or estimate other figures.`;
}

// ---- structured intake tool -----------------------------------------------------------------------------------
export async function captureIntakeStructured(
  admin: Admin, trace: TraceCtx | null, rawFields: Record<string, unknown>, opts: { transcript?: string | null; outdoorTempF?: number | null },
): Promise<{ intake: NormalizedIntake; entries: OntologyEntry[] }> {
  const entries = await loadOntology(admin);
  const intake = normalizeIntake(rawFields, { transcript: opts.transcript ?? null, outdoorTempF: opts.outdoorTempF ?? null, entries });
  await emit(admin, trace, intakeEvent({ trade: intake.trade as Trade | null, urgency: intake.urgency, fields_missing: intake.fieldsMissing, override: intake.override }));
  return { intake, entries };
}
