// Emergency / escalation target selection (pure). Used by vapi-webhook for flag_emergency_call and transfers.
export interface EscalationRuleLite {
  trigger?: "emergency" | "after_hours" | "no_answer" | "human_request";
  action?: "transfer" | "sms" | "email";
  target?: string;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function isValidE164(value: string | null | undefined): value is string {
  return typeof value === "string" && E164_RE.test(value);
}

/** First transfer rule for the trigger whose target is a valid E.164 number; anything else -> null (never a guessed number). */
export function findEscalationTarget(rules: EscalationRuleLite[] | null | undefined, trigger: EscalationRuleLite["trigger"]): string | null {
  if (!Array.isArray(rules)) return null;
  const rule = rules.find((r) => r?.trigger === trigger && r.action === "transfer" && isValidE164(r.target));
  return rule?.target ?? null;
}
