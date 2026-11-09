// supabase/functions/_shared/vertical-ai/intake.ts
//
// Structured intake for the live voice tool `capture_vertical_intake` (args: { fields: Record<string, scalar> }).
// The model proposes fields; THIS layer validates them, infers what is missing from the caller's words, runs the
// deterministic emergency rules, and can only ever RAISE urgency, never lower it. PURE.

import { classifyUrgency, emergencyInstruction } from "./emergencyRules.ts";
import { lookupSymptoms, normalizeText, type OntologyEntry } from "./ontology.ts";
import type { SafetyFlag, Trade, UrgencyClass } from "./types.ts";

export const SYSTEM_TYPES = ["split_ac", "package_unit", "furnace_gas", "furnace_electric", "heat_pump", "boiler", "mini_split", "tank_water_heater", "tankless_water_heater", "main_panel", "sub_panel", "other", "unknown"] as const;
export type SystemType = typeof SYSTEM_TYPES[number];

export interface NormalizedIntake {
  trade: Trade | null;
  symptom: string | null;
  symptomKey: string | null;
  systemType: SystemType;
  systemAgeYears: number | null;
  urgency: UrgencyClass;
  safetyFlags: SafetyFlag[];
  /** True when the deterministic layer raised the urgency above what the model supplied. */
  override: boolean;
  rules: string[];
  emergencyInstruction: string | null;
  fieldsMissing: string[];
  /** Whitelisted, length-capped fields safe to persist. */
  fields: Record<string, string | number | boolean>;
}

const TRADE_WORDS: Record<Trade, RegExp> = {
  hvac: /\b(?:furnace|ac|a c|air conditioner|air conditioning|heat pump|thermostat|hvac|boiler|ductwork|duct|ducts|blower|compressor|condenser|evaporator|refrigerant|freon|mini split|(?<!water )heater|heating|cooling|tune ?up|tune-up|air filter|furnace filter|vents)\b/,
  plumbing: /\b(?:drain|drains|toilet|faucet|sink|pipe|pipes|water heater|hot water|garbage disposal|sewer|sewage|shower|tub|leak|leaking|plumber|plumbing|water pressure|hose bib|sump|water softener|inodoro)\b/,
  electrical: /\b(?:outlet|outlets|breaker|breakers|panel|wiring|electrical|electrician|circuit|gfci|switch|light fixture|lights flickering|flickering|fuse|power|ceiling fan|ev charger|charger|dimmer)\b/,
};

export function inferTrade(text: string, entries: readonly OntologyEntry[], now?: Date): Trade | null {
  const matches = lookupSymptoms(entries, { text, now });
  if (matches.length > 0) {
    const top = matches[0];
    const tie = matches.find((m) => m.score === top.score && m.entry.trade !== top.entry.trade);
    return tie ? null : (top.entry.trade as Trade);
  }
  const t = normalizeText(text);
  const hits = (Object.keys(TRADE_WORDS) as Trade[]).filter((k) => TRADE_WORDS[k].test(t));
  return hits.length === 1 ? hits[0] : null;
}

const RANK: Record<UrgencyClass, number> = { routine: 0, urgent: 1, emergency: 2 };
const asTrade = (v: unknown): Trade | null => (v === "hvac" || v === "plumbing" || v === "electrical" ? v : null);
const asUrgency = (v: unknown): UrgencyClass | null => (v === "emergency" || v === "urgent" || v === "routine" ? v : null);
const asSystem = (v: unknown): SystemType => (typeof v === "string" && (SYSTEM_TYPES as readonly string[]).includes(v) ? (v as SystemType) : "unknown");

function parseAge(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number((/(\d{1,2})/.exec(v) ?? [])[1]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 80 ? Math.round(n) : null;
}

export function normalizeIntake(
  rawFields: Record<string, unknown> | null | undefined,
  ctx: { transcript?: string | null; outdoorTempF?: number | null; entries: readonly OntologyEntry[]; now?: Date },
): NormalizedIntake {
  const f = rawFields && typeof rawFields === "object" ? rawFields : {};
  const clean: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(f)) {
    if (n >= 25 || !/^[a-z][a-z0-9_]{0,39}$/i.test(k)) continue;
    if (typeof v === "string") clean[k] = v.slice(0, 300);
    else if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
    else if (typeof v === "boolean") clean[k] = v;
    else continue;
    n++;
  }

  const symptomText = typeof f.symptom === "string" ? f.symptom : typeof f.problem === "string" ? f.problem : typeof f.issue === "string" ? f.issue : typeof f.notes === "string" ? f.notes : "";
  const allText = [symptomText, ...Object.values(clean).filter((v): v is string => typeof v === "string"), ctx.transcript ?? ""].join(" . ");

  const modelUrgency = asUrgency(f.urgency);
  const verdict = classifyUrgency({ text: allText, outdoorTempF: ctx.outdoorTempF ?? null });
  const trade0 = asTrade(f.trade) ?? inferTrade(allText, ctx.entries, ctx.now);
  const topSym = lookupSymptoms(ctx.entries, { text: symptomText || allText, trade: trade0, now: ctx.now })[0];
  const hint: UrgencyClass = topSym ? (topSym.entry.payload as { urgency: UrgencyClass }).urgency : "routine";
  const ruleUrgency: UrgencyClass = RANK[verdict.urgency] >= RANK[hint] ? verdict.urgency : hint;
  const finalUrgency: UrgencyClass = RANK[ruleUrgency] >= RANK[modelUrgency ?? "routine"] ? ruleUrgency : (modelUrgency as UrgencyClass);
  const override = RANK[verdict.urgency] > RANK[modelUrgency ?? "routine"] && verdict.urgency !== "routine";

  const trade = asTrade(f.trade) ?? inferTrade(allText, ctx.entries, ctx.now);
  const top = lookupSymptoms(ctx.entries, { text: symptomText || allText, trade, now: ctx.now })[0];
  const sym = symptomText.trim() || null;

  const fieldsMissing: string[] = [];
  if (!trade) fieldsMissing.push("trade");
  if (!sym && !top) fieldsMissing.push("symptom");

  const instr = verdict.override ? emergencyInstruction(verdict.flags) : null;
  return {
    trade,
    symptom: sym ? sym.slice(0, 300) : null,
    symptomKey: top?.entry.key ?? null,
    systemType: asSystem(f.system_type),
    systemAgeYears: parseAge(f.system_age_years ?? f.system_age),
    urgency: finalUrgency,
    safetyFlags: verdict.flags,
    override,
    rules: verdict.rules,
    emergencyInstruction: instr?.text ?? null,
    fieldsMissing,
    fields: clean,
  };
}
