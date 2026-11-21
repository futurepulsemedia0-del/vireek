// supabase/functions/_shared/voice-security/riskTiers.ts
//
// Config-driven RISK TIERS for AI actions, layered ON TOP of the least-privilege catalog in toolPolicy.ts.
// The catalog stays the floor: this module can only TIGHTEN what the catalog already requires, never relax it.
// Pure TypeScript (no Deno / npm imports) so it runs under vitest and the edge runtime.
//
// Action classes (what the business reasons about):
//   info            facts that are the same for every caller (hours, prices, availability)         -> public tools
//   intake          new bookings and write-only capture                                             -> booking + intake tools
//   account_read    reads data about an existing customer                                           -> sensitive_read tools
//   reschedule      changes an existing appointment                                                 -> record_write tools
//   address_change  changes where service happens / contact details / access                        -> voice_never tools today
//   payment         moves or exposes money                                                          -> money tools
//   safety          emergencies and human hand-off: NEVER restricted by this config
//
// Step-up methods (how a refusal can be resolved):
//   sms_otp   one-time code texted to the number ON FILE + known details (existing request_verification / verify_caller)
//   callback  the office calls the number ON FILE back (request_callback). Resolved out of band by a human; it
//             never unlocks anything inside the current call.
//
// NOT LEGAL ADVICE. [COUNSEL] Which actions may be performed by voice at all, and what identity proof is
// "reasonable", is a business/legal decision; the defaults below are conservative engineering defaults.

import type { RiskTier, VerificationLevel } from "./types.ts";
import { levelAtLeast, type ToolSpec } from "./toolPolicy.ts";

export type ActionClass = "safety" | "info" | "intake" | "account_read" | "reschedule" | "address_change" | "payment";
export type StepUpMethod = "sms_otp" | "callback";

export const ACTION_CLASSES: readonly ActionClass[] = ["safety", "info", "intake", "account_read", "reschedule", "address_change", "payment"];
export const STEP_UP_METHODS: readonly StepUpMethod[] = ["sms_otp", "callback"];

export interface ClassPolicy {
  /** Minimum identity proof for FULL access. Can only be raised above the catalog value. */
  min: VerificationLevel;
  /** Below `min`: refuse, or (reads only) return a data-minimised result. "refuse" can only tighten "minimal". */
  below: "refuse" | "minimal";
  /** Ways a refusal can be resolved. Without "sms_otp" the class is callback-only: always refused in-call. */
  methods: readonly StepUpMethod[];
  /** Kill switch for the class: every tool in it is refused (audited) until re-enabled. Never applies to "safety". */
  disabled: boolean;
}

export interface TierConfig {
  version: 1;
  classes: Readonly<Record<ActionClass, ClassPolicy>>;
  /** "all": audit every allow as well as every refusal. "sensitive": audit allows only for non-public classes. */
  auditAllows: "all" | "sensitive";
}

const BOTH: readonly StepUpMethod[] = ["sms_otp", "callback"];

export const DEFAULT_TIER_CONFIG: TierConfig = Object.freeze({
  version: 1 as const,
  classes: Object.freeze({
    safety: { min: "none", below: "minimal", methods: [], disabled: false },
    info: { min: "none", below: "minimal", methods: [], disabled: false },
    intake: { min: "none", below: "minimal", methods: [], disabled: false },
    account_read: { min: "step_up", below: "minimal", methods: BOTH, disabled: false },
    reschedule: { min: "step_up", below: "refuse", methods: BOTH, disabled: false },
    address_change: { min: "step_up", below: "refuse", methods: ["callback"], disabled: false },
    payment: { min: "step_up", below: "refuse", methods: BOTH, disabled: false },
  } as Record<ActionClass, ClassPolicy>),
  auditAllows: "all" as const,
});

// ---------------------------------------------------------------------------------------------
// Tool -> class
// ---------------------------------------------------------------------------------------------

const CLASS_BY_TIER: Readonly<Record<RiskTier, ActionClass>> = Object.freeze({
  safety: "safety",
  public: "info",
  booking: "intake",
  intake: "intake",
  sensitive_read: "account_read",
  record_write: "reschedule",
  money: "payment",
  voice_never: "address_change",
});

/** Explicit overrides where the tier alone is not enough (address/contact/access changes are voice_never tools). */
const CLASS_BY_TOOL: Readonly<Record<string, ActionClass>> = Object.freeze({
  update_address: "address_change",
  update_contact: "address_change",
  grant_access: "address_change",
  issue_refund: "payment",
});

export function actionClassOf(tool: string, spec: Pick<ToolSpec, "tier">): ActionClass {
  return Object.prototype.hasOwnProperty.call(CLASS_BY_TOOL, tool) ? CLASS_BY_TOOL[tool] : CLASS_BY_TIER[spec.tier];
}

// ---------------------------------------------------------------------------------------------
// Parsing (strict; invalid config => safe default, never a half-applied config)
// ---------------------------------------------------------------------------------------------

const LEVELS: readonly VerificationLevel[] = ["none", "caller_id", "step_up"];

export interface ParseOutcome {
  config: TierConfig;
  /** Non-fatal findings (relaxations that were ignored, unknown keys). Log these. */
  warnings: string[];
  /** True when the input was rejected and the defaults are in force. */
  rejected: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parses an override document (JSON string or object). Rules:
 *   - unknown top-level keys / classes / methods => whole document rejected (typos must not silently weaken anything)
 *   - any attempt to relax a default (lower `min`, "minimal" where default is "refuse", re-enable via methods) is IGNORED
 *     per field with a warning: effective value = the stricter of default and override
 *   - "safety" can't be touched
 */
export function parseTierConfig(input: unknown): ParseOutcome {
  const reject = (why: string): ParseOutcome => ({ config: DEFAULT_TIER_CONFIG, warnings: [`rejected: ${why}`], rejected: true });
  if (input === undefined || input === null || input === "") return { config: DEFAULT_TIER_CONFIG, warnings: [], rejected: false };

  let doc: unknown = input;
  if (typeof input === "string") {
    if (input.length > 8_000) return reject("document too large");
    try {
      doc = JSON.parse(input);
    } catch {
      return reject("not valid JSON");
    }
  }
  if (!isObj(doc)) return reject("not an object");
  for (const k of Object.keys(doc)) if (!["version", "classes", "auditAllows"].includes(k)) return reject(`unknown key ${k.slice(0, 30)}`);
  if (doc.version !== undefined && doc.version !== 1) return reject("unsupported version");

  const warnings: string[] = [];
  let auditAllows: TierConfig["auditAllows"] = DEFAULT_TIER_CONFIG.auditAllows;
  if (doc.auditAllows !== undefined) {
    if (doc.auditAllows === "all" || doc.auditAllows === "sensitive") {
      // "sensitive" is a relaxation of "all": allowed because the default is not a security control, but warned.
      auditAllows = doc.auditAllows;
    } else return reject("auditAllows must be all|sensitive");
  }

  const classes: Record<ActionClass, ClassPolicy> = { ...DEFAULT_TIER_CONFIG.classes };
  if (doc.classes !== undefined) {
    if (!isObj(doc.classes)) return reject("classes must be an object");
    for (const [name, raw] of Object.entries(doc.classes)) {
      if (!(ACTION_CLASSES as readonly string[]).includes(name)) return reject(`unknown class ${name.slice(0, 30)}`);
      if (name === "safety") {
        warnings.push("safety class cannot be configured; ignored");
        continue;
      }
      if (!isObj(raw)) return reject(`class ${name} must be an object`);
      const base = DEFAULT_TIER_CONFIG.classes[name as ActionClass];
      const next: ClassPolicy = { ...base };
      for (const [field, val] of Object.entries(raw)) {
        switch (field) {
          case "min": {
            if (typeof val !== "string" || !(LEVELS as readonly string[]).includes(val)) return reject(`${name}.min invalid`);
            if (levelAtLeast(val as VerificationLevel, base.min)) next.min = val as VerificationLevel;
            else warnings.push(`${name}.min cannot be lowered below ${base.min}; ignored`);
            break;
          }
          case "below": {
            if (val !== "refuse" && val !== "minimal") return reject(`${name}.below invalid`);
            if (base.below === "refuse" && val === "minimal") warnings.push(`${name}.below cannot be relaxed to minimal; ignored`);
            else next.below = val;
            break;
          }
          case "methods": {
            if (!Array.isArray(val) || val.length > STEP_UP_METHODS.length || val.some((m) => !(STEP_UP_METHODS as readonly unknown[]).includes(m))) return reject(`${name}.methods invalid`);
            // Methods may only be REMOVED relative to the default (fewer ways in = stricter).
            const kept = (val as StepUpMethod[]).filter((m, i, a) => a.indexOf(m) === i && base.methods.includes(m));
            if (kept.length !== new Set(val as string[]).size) warnings.push(`${name}.methods cannot add methods beyond the default; extras ignored`);
            next.methods = kept;
            break;
          }
          case "disabled": {
            if (typeof val !== "boolean") return reject(`${name}.disabled invalid`);
            next.disabled = val;
            break;
          }
          default:
            return reject(`unknown field ${name}.${field.slice(0, 30)}`);
        }
      }
      classes[name as ActionClass] = Object.freeze(next);
    }
  }
  return { config: Object.freeze({ version: 1 as const, classes: Object.freeze(classes), auditAllows }), warnings, rejected: false };
}

// ---------------------------------------------------------------------------------------------
// Applying the policy to a catalog spec
// ---------------------------------------------------------------------------------------------

export interface EffectivePolicy {
  actionClass: ActionClass;
  spec: ToolSpec;
  methods: readonly StepUpMethod[];
  /** Class is disabled by config: refuse before anything else (audited). */
  disabled: boolean;
  /** No sms_otp method: the class can only be resolved by callback, so in-call step-up must NOT unlock it. */
  callbackOnly: boolean;
}

const LEVEL_RANK: Record<VerificationLevel, number> = { none: 0, caller_id: 1, step_up: 2 };

export function applyTierPolicy(tool: string, spec: ToolSpec, cfg: TierConfig): EffectivePolicy {
  const actionClass = actionClassOf(tool, spec);
  const cp = cfg.classes[actionClass];
  if (actionClass === "safety") return { actionClass, spec, methods: [], disabled: false, callbackOnly: false };

  const min = LEVEL_RANK[cp.min] > LEVEL_RANK[spec.min] ? cp.min : spec.min;
  const below: ToolSpec["below"] = spec.below === "deny" || cp.below === "refuse" ? "deny" : "minimal";
  const effective: ToolSpec = min === spec.min && below === spec.below ? spec : { ...spec, min, below };
  const callbackOnly = min === "step_up" && !cp.methods.includes("sms_otp");
  return { actionClass, spec: effective, methods: cp.methods, disabled: cp.disabled, callbackOnly };
}

// ---------------------------------------------------------------------------------------------
// Env loading (never throws; an unreadable config falls back to the defaults)
// ---------------------------------------------------------------------------------------------

export function loadTierConfig(raw: string | undefined | null): ParseOutcome {
  try {
    return parseTierConfig(raw ?? undefined);
  } catch {
    return { config: DEFAULT_TIER_CONFIG, warnings: ["rejected: unexpected error"], rejected: true };
  }
}

/** Whether an allow decision for this class must be written to the audit trail under the config. */
export function shouldAuditAllow(cfg: TierConfig, actionClass: ActionClass): boolean {
  return cfg.auditAllows === "all" || (actionClass !== "info" && actionClass !== "safety");
}

/** What the model is told when a sensitive action is refused, per available method (never reveals thresholds). */
export function spokenForMethods(methods: readonly StepUpMethod[], callbackOnly: boolean): string {
  const base = "Account details can't be shared or changed on this call right now.";
  if (methods.includes("callback") && (callbackOnly || !methods.includes("sms_otp"))) {
    return `${base} Offer to arrange a callback from the office on the number on file (request_callback), or a transfer to a team member. Share nothing about the account. Do not explain why.`;
  }
  if (methods.includes("sms_otp") && methods.includes("callback")) {
    return `${base} Offer to text a one-time code to the number on file (request_verification), then ask for the code plus two details on file such as the ZIP code and last name, and call verify_caller. If the caller can't receive texts, offer a callback from the office on the number on file (request_callback). Share nothing about the account until verified.`;
  }
  if (methods.includes("sms_otp")) {
    return `${base} Offer to text a one-time code to the number on file (request_verification), then ask for the code plus two details on file, and call verify_caller. Share nothing about the account until that succeeds.`;
  }
  return `${base} Tell the caller the office will follow up, and offer a transfer to a team member. Do not explain why.`;
}
