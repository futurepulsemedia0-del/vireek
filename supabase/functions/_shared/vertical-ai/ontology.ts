// supabase/functions/_shared/vertical-ai/ontology.ts
//
// Trade ontology as DATA (symptom -> causes -> checks -> parts -> labor -> urgency, safety rules, permit
// triggers). PURE: lookups run over an array of entries. The entries come from the `vertical_ontology_entries`
// table at runtime (see runtime.ts) with the bundled seed (ontologySeed.ts) as an offline fallback, so grounding
// still works if the DB is unreachable.
//
// Every entry carries source, effective date, jurisdiction, confidence and a `reviewed` flag. Nothing in here
// carries a price: prices come ONLY from the tenant's price book (pricing.ts).

import type { EvidenceRef, OntologyKind, OntologyTrade, SafetyFlag, Trade, UrgencyClass } from "./types.ts";

export interface SymptomPayload {
  /** Phrases a caller might use (lowercase). Matching is phrase-in-text, so non-native variants belong here. */
  synonyms: string[];
  causes: { cause: string; likelihood: "high" | "medium" | "low" }[];
  checks: string[];
  parts: string[];
  /** Coarse labor-hours range. NEVER used to quote a price to a caller. */
  laborHours?: { min: number; max: number };
  urgency: UrgencyClass;
  escalateIf?: string[];
}
export interface SafetyPayload { flag: SafetyFlag; guidance: string }
export interface PermitPayload { work: string; synonyms: string[]; note: string }
export type OntologyPayload = SymptomPayload | SafetyPayload | PermitPayload;

export interface OntologyEntry {
  trade: OntologyTrade;
  kind: OntologyKind;
  key: string;
  version: number;
  title: string;
  payload: OntologyPayload;
  source: string;
  effectiveOn: string; // ISO date
  expiresOn: string | null;
  jurisdiction: string; // "US" = generic US; narrower values e.g. "US-CA"
  confidence: number; // 0..1
  reviewed: boolean;
}

export function evidenceIdOf(e: Pick<OntologyEntry, "trade" | "kind" | "key" | "version">): string {
  return `onto:${e.trade}:${e.kind}:${e.key}@v${e.version}`;
}

export function toEvidence(e: OntologyEntry): EvidenceRef {
  return {
    id: evidenceIdOf(e),
    kind: "ontology",
    version: e.version,
    confidence: e.confidence,
    reviewed: e.reviewed,
    effectiveOn: e.effectiveOn,
    expiresOn: e.expiresOn,
    jurisdiction: e.jurisdiction,
    source: e.source,
  };
}

/** Lowercase, strip apostrophes and punctuation, collapse whitespace. Shared by every matcher in this layer. */
export function normalizeText(input: string | null | undefined): string {
  return (input ?? "")
    .slice(0, 4000)
    .toLowerCase()
    .replace(/[\u2018\u2019`']/g, "")
    .replace(/[^a-z0-9\u00e0-\u00ff\- ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when every token of `phrase` appears in order in `text` with at most `slack` filler words between
 * consecutive tokens ("replace our water heater" matches "replace water heater"). Both inputs are normalized.
 */
export function phraseNear(text: string, phrase: string, slack = 1): boolean {
  const toks = normalizeText(phrase).split(" ").filter(Boolean);
  if (toks.length === 0) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = toks.map(esc).join(`(?: \\S+){0,${slack}} `);
  return new RegExp(`(?:^| )${body}(?: |$)`).test(text);
}

function activeOn(e: OntologyEntry, now: Date): boolean {
  const t = now.getTime();
  if (Date.parse(e.effectiveOn) > t) return false;
  if (e.expiresOn && Date.parse(e.expiresOn) <= t) return false;
  return true;
}

/** An entry applies to a jurisdiction when it is generic ("US") or its code is a prefix of the caller's. */
export function jurisdictionApplies(entryJurisdiction: string, callerJurisdiction: string | null | undefined): boolean {
  if (entryJurisdiction === "US") return true;
  if (!callerJurisdiction) return false;
  return callerJurisdiction === entryJurisdiction || callerJurisdiction.startsWith(`${entryJurisdiction}-`);
}

export interface SymptomMatch { entry: OntologyEntry; score: number }

/**
 * Rank symptom entries for a caller's words. Score = 2 per matched synonym phrase (longer phrases are specific, so
 * +1 for 3+ word phrases). Below `minScore` nothing matches: no match means "ungrounded", never a guess.
 */
export function lookupSymptoms(
  entries: readonly OntologyEntry[],
  q: { text: string; trade?: Trade | null; jurisdiction?: string | null; now?: Date; minScore?: number },
): SymptomMatch[] {
  const text = ` ${normalizeText(q.text)} `;
  const now = q.now ?? new Date();
  const minScore = q.minScore ?? 2;
  const out: SymptomMatch[] = [];
  for (const e of entries) {
    if (e.kind !== "symptom") continue;
    if (q.trade && e.trade !== q.trade) continue;
    if (!activeOn(e, now) || !jurisdictionApplies(e.jurisdiction, q.jurisdiction ?? "US")) continue;
    const p = e.payload as SymptomPayload;
    let score = 0;
    for (const syn of p.synonyms) {
      const s = normalizeText(syn);
      if (s && phraseNear(text, s, 1)) score += s.split(" ").length >= 3 ? 3 : 2;
    }
    if (score >= minScore) out.push({ entry: e, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.entry.key < b.entry.key ? -1 : 1));
}

export function lookupSafetyRule(entries: readonly OntologyEntry[], flag: SafetyFlag, now: Date = new Date()): OntologyEntry | null {
  for (const e of entries) {
    if (e.kind !== "safety_rule" || !activeOn(e, now)) continue;
    if ((e.payload as SafetyPayload).flag === flag) return e;
  }
  return null;
}

export function lookupPermitTriggers(
  entries: readonly OntologyEntry[],
  q: { text: string; trade?: Trade | null; jurisdiction?: string | null; now?: Date },
): OntologyEntry[] {
  const text = ` ${normalizeText(q.text)} `;
  const now = q.now ?? new Date();
  return entries.filter((e) => {
    if (e.kind !== "permit_trigger" || !activeOn(e, now)) return false;
    if (q.trade && e.trade !== q.trade) return false;
    if (!jurisdictionApplies(e.jurisdiction, q.jurisdiction ?? "US")) return false;
    return (e.payload as PermitPayload).synonyms.some((s) => phraseNear(text, s, 2));
  });
}

/** Stable snake_case key for a probable cause, used by the outcome-event contract (diagnosis predicted vs confirmed). */
export function causeKeyOf(cause: string): string {
  return normalizeText(cause).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "unknown";
}
