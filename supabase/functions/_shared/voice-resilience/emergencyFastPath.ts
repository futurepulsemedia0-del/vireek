// Emergency fast-path. Pure, dependency-free, usable at EVERY degradation level.
//
// Design rule: a false positive costs one extra phone call to the owner; a false negative can cost a
// life or a house. So this errs toward "emergency". The generic word "emergency" is the only term
// that an explicit negation ("not an emergency") can cancel; life-safety terms never are.

export interface EmergencyVerdict {
  emergency: boolean;
  /** Which rule fired (for audit). Never contains caller PII beyond the matched keyword itself. */
  matched: string[];
}

const LIFE_SAFETY: { id: string; re: RegExp }[] = [
  { id: "gas", re: /\b(gas (leak|smell)|smell(s|ing)? (of )?gas|smells? like gas|natural gas|propane leak)\b/i },
  { id: "co", re: /\b(carbon monoxide|co (alarm|detector)|monoxide)\b/i },
  { id: "fire", re: /\b(fire|on fire|burning|smoke|smoking|sparking|sparks|electrical fire)\b/i },
  { id: "flood", re: /\b(flood(ed|ing)?|burst pipe|pipe burst|water (everywhere|pouring|gushing)|sewage (backup|overflow))\b/i },
  { id: "shock", re: /\b(electrocut|shock(ed)?|live wire|downed (power )?line)\b/i },
  { id: "trapped", re: /\b(locked (in|out) (with )?(a )?(baby|child|kid|infant)|trapped)\b/i },
  // Spanish
  { id: "es", re: /\b(fuga de gas|huele a gas|incendio|fuego|humo|inundaci[oó]n|tuber[ií]a rota|mon[oó]xido de carbono)\b/i },
];

const GENERIC = /\b(emergency|emergencia|urgent|urgente)\b/i;
const NEGATED_GENERIC = /\b(not|no|isn'?t|is not|n'?t)\s+(an?\s+)?(emergency|urgent|emergencia)\b/i;

export function detectEmergencyText(text: string | null | undefined): EmergencyVerdict {
  const t = (text ?? "").slice(0, 4000);
  if (!t.trim()) return { emergency: false, matched: [] };
  const matched = LIFE_SAFETY.filter((r) => r.re.test(t)).map((r) => r.id);
  if (matched.length > 0) return { emergency: true, matched };
  if (GENERIC.test(t) && !NEGATED_GENERIC.test(t)) return { emergency: true, matched: ["generic"] };
  return { emergency: false, matched: [] };
}

/** DTMF: "1" is the announced emergency key on every degraded-level prompt. */
export const EMERGENCY_DTMF = "1";
export function isEmergencyDtmf(digits: string | null | undefined): boolean {
  return (digits ?? "").trim() === EMERGENCY_DTMF;
}

/** Combined verdict for a Twilio <Gather> result (speech and/or digits). */
export function detectEmergencyGather(p: { SpeechResult?: string; Digits?: string }): EmergencyVerdict {
  if (isEmergencyDtmf(p.Digits)) return { emergency: true, matched: ["dtmf"] };
  return detectEmergencyText(p.SpeechResult);
}
