// supabase/functions/_shared/compliance-rules/canada.ts
//
// Canada rule pack — pure helpers. Zero dependencies (runs in Deno, Node/Vitest and the browser).
//
// NOT LEGAL ADVICE. Every Canadian rule is seeded as 'in_review' (caSeedRules.ts) and is marked
// [COUNSEL][VERIFY]: nothing is enforced as law until counsel approves each version in the staff review
// workflow. Until the pack is ENABLED, all Canadian outbound contact is blocked (fail closed).
//
// "Enabled" (for a surface) = every rule key in CA_REQUIRED_RULE_KEYS[surface] has an approved,
// currently-effective version with jurisdiction "CA" that applies to that surface. A partial pack never
// opens the gate.

import type { RuleVersion, Surface } from "./types.ts";

export const CA_PACK_SLUG = "ca-federal";
export const CA_JURISDICTION = "CA";
export const CA_GATE_RULE_KEY = "ca-pack-not-enabled";

/** Surfaces the Canada gate covers (outbound contact). */
export const CA_GATED_SURFACES = ["call", "sms", "email"] as const;
export type CaGatedSurface = (typeof CA_GATED_SURFACES)[number];

export function isCaGatedSurface(s: string): s is CaGatedSurface {
  return (CA_GATED_SURFACES as readonly string[]).includes(s);
}

/** Rule keys that must all be approved + effective before a surface is enabled. */
export const CA_REQUIRED_RULE_KEYS: Record<CaGatedSurface, readonly string[]> = {
  call: ["ca-call-hours", "ca-call-marketing-consent", "ca-call-dncl-scrub", "ca-call-identification"],
  sms: ["ca-sms-consent", "ca-sms-unsubscribe", "ca-cem-identification"],
  email: ["ca-email-consent", "ca-email-unsubscribe", "ca-cem-identification"],
};

export interface CanadaPackStatus {
  enabled: boolean;
  /** Required rule keys with no approved, effective, surface-matching version. */
  missing: string[];
}

/** `active` must already be effective-date resolved (engine.selectEffective). */
export function canadaPackStatus(active: readonly RuleVersion[], surface: CaGatedSurface): CanadaPackStatus {
  const have = new Set(
    active
      .filter((v) => v.status === "approved" && v.jurisdiction === CA_JURISDICTION && v.appliesTo.includes(surface as Surface))
      .map((v) => v.ruleKey),
  );
  const missing = CA_REQUIRED_RULE_KEYS[surface].filter((k) => !have.has(k));
  return { enabled: missing.length === 0, missing: [...missing] };
}

export function canadaGateMessage(surface: CaGatedSurface, missing: readonly string[]): string {
  const what = surface === "call" ? "calls" : surface === "sms" ? "text messages" : "emails";
  return `Canadian recipient: outbound ${what} are blocked until the Canada rule pack is enabled (counsel-approved rules still missing: ${missing.join(", ") || "n/a"}). [COUNSEL][VERIFY]`;
}

// ---------------------------------------------------------------------------
// Implied-consent windows (data: consent_required.params.impliedWindows)
// ---------------------------------------------------------------------------

export type ImpliedBasis = "transaction" | "inquiry";
export interface ImpliedWindow { basis: ImpliedBasis; months: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** null = invalid; [] is never returned (an empty list is invalid). */
export function parseImpliedWindows(v: unknown): ImpliedWindow[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 4) return null;
  const out: ImpliedWindow[] = [];
  const seen = new Set<string>();
  for (const w of v) {
    if (!isObj(w)) return null;
    const basis = w.basis;
    const months = w.months;
    if (basis !== "transaction" && basis !== "inquiry") return null;
    if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 60) return null;
    if (seen.has(basis)) return null;
    seen.add(basis);
    out.push({ basis, months });
  }
  return out;
}

/** Date part of YYYY-MM-DD or ISO; null when unparseable. */
export function dateKeyOf(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Last day (inclusive) of a window that starts on `startKey` and lasts `months` calendar months. */
export function windowEndKey(startKey: string, months: number): string {
  const [y, mo, d] = startKey.split("-").map(Number);
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const lastOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastOfTarget)));
  return end.toISOString().slice(0, 10);
}

/**
 * First window that covers `todayKey`, or null. Future-dated relationship facts never count (they are
 * almost certainly data errors) and missing / unparseable facts never count.
 */
export function impliedConsentMatch(
  windows: readonly ImpliedWindow[],
  facts: { transactionAt?: string | null; inquiryAt?: string | null } | undefined,
  todayKey: string,
): { basis: ImpliedBasis; months: number; since: string; until: string } | null {
  if (!facts) return null;
  for (const w of windows) {
    const since = dateKeyOf(w.basis === "transaction" ? facts.transactionAt : facts.inquiryAt);
    if (!since || since > todayKey) continue;
    const until = windowEndKey(since, w.months);
    if (todayKey <= until) return { basis: w.basis, months: w.months, since, until };
  }
  return null;
}
