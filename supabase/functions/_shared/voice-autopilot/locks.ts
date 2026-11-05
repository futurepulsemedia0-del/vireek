// supabase/functions/_shared/voice-autopilot/locks.ts
//
// LOCKED COMPLIANCE LANGUAGE. AI disclosure and recording consent are injected by vapi-webhook through their own
// variables (ai_disclosure, recording_consent_context, firstMessage prefix) — never through a script. This module is
// the second line of defence: (1) variant text is rejected if it tries to remove / contradict / override them,
// (2) the final composed prompt is verified to still contain the locked text verbatim.
// NOT LEGAL ADVICE: the pattern list is a safe default; counsel must review.
//
// KEEP IN SYNC with public.voice_autopilot_text_violates_lock() in
// supabase/migrations/20280410000000_voice_autopilot.sql (a test asserts the pattern ids match).

export interface LockRule { id: string; pattern: RegExp; reason: string }

const VERB_OFF = "skip|omit|drop|remove|bypass|suppress|avoid|hide|don'?t|do not|never|without|stop";

export const LOCK_RULES: readonly LockRule[] = [
  {
    id: "no_remove_disclosure",
    pattern: new RegExp(`\\b(${VERB_OFF})\\b[^.\\n]{0,40}\\b(disclos\\w*|(that )?(you are|you're|this is) (an? )?(ai|virtual|automated|assistant))`, "i"),
    reason: "Variants may not remove or hide the AI disclosure",
  },
  {
    id: "no_remove_recording_consent",
    pattern: new RegExp(`\\b(${VERB_OFF})\\b[^.\\n]{0,40}\\b(record\\w*|consent)`, "i"),
    reason: "Variants may not remove or hide recording consent",
  },
  {
    id: "no_claim_human",
    pattern: /\b(pretend|claim|say|tell|insist|act)\b[^.\n]{0,30}\b(human|real person|live person|not (an? )?(ai|robot|bot))/i,
    reason: "Variants may not make the assistant claim to be human",
  },
  {
    id: "no_override_compliance",
    pattern: /\b(ignore|override|replace|disregard|bypass)\b[^.\n]{0,40}\b(disclosure|consent|compliance|safety|emergency|911)/i,
    reason: "Variants may not override compliance, safety or emergency rules",
  },
  {
    id: "no_skip_emergency_guidance",
    pattern: /\b(skip|don'?t|do not|never|avoid)\b[^.\n]{0,30}\b(911|emergency services|evacuat\w*|leave the (area|house|building))/i,
    reason: "Variants may not suppress emergency safety guidance",
  },
];

/** Postgres ARE form of a rule (\\b is a backspace in Postgres; the word boundary is \\y). Used by the migration + parity test. */
export const toPostgresRegex = (r: RegExp): string => r.source.replace(/\\b/g, "\\y");

export interface LockViolation { ruleId: string; reason: string }

export function checkVariantText(...texts: (string | null | undefined)[]): LockViolation[] {
  const joined = texts.filter((t): t is string => typeof t === "string").join("\n");
  const out: LockViolation[] = [];
  for (const r of LOCK_RULES) if (r.pattern.test(joined)) out.push({ ruleId: r.id, reason: r.reason });
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Verifies the locked blocks survive in the final prompt/first message. Returns the blocks that are MISSING. */
export function missingLockedBlocks(composed: string, locked: { name: string; text: string }[]): string[] {
  const hay = norm(composed);
  return locked.filter((b) => b.text.trim() && !hay.includes(norm(b.text))).map((b) => b.name);
}

/** Dimensions an experiment may vary. Anything compliance-related is deliberately absent. */
export const EXPERIMENT_DIMENSIONS = ["greeting", "discovery_order", "objection_handling", "booking_ask", "voice_pace"] as const;
export type ExperimentDimension = (typeof EXPERIMENT_DIMENSIONS)[number];
export const FORBIDDEN_DIMENSIONS = ["ai_disclosure", "recording_consent", "emergency_guidance", "compliance"] as const;

export function isAllowedDimension(v: unknown): v is ExperimentDimension {
  return typeof v === "string" && (EXPERIMENT_DIMENSIONS as readonly string[]).includes(v);
}

export const PACES = ["slower", "normal", "faster"] as const;
export type Pace = (typeof PACES)[number];
const PACE_TEXT: Record<Pace, string> = {
  slower: "Pace: speak slightly slower than usual, with shorter sentences and a brief pause after each question.",
  normal: "",
  faster: "Pace: keep a brisk, efficient rhythm; do not rush the caller or cut them off.",
};
/** Voice/pace is expressed as prompt guidance only (provider voice parameters are not changed). */
export function paceGuidance(p: string | null | undefined): string {
  return PACE_TEXT[(PACES as readonly string[]).includes(p ?? "") ? (p as Pace) : "normal"];
}
