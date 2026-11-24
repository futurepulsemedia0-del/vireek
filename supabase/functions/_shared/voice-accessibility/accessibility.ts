// supabase/functions/_shared/voice-accessibility/accessibility.ts
//
// Voice accessibility for callers with hearing or speech difficulty. PURE TypeScript (no Deno / browser APIs, no I/O):
// imported by the Edge Functions and unit-tested by vitest. Human-readable version: docs/accessibility/VOICE_ACCESSIBILITY.md
//
// SECURITY INVARIANT (do not weaken): nothing in this file grants access. Every function here only changes HOW Sarah talks
// (pace, patience, channel offers). Authorization still comes ONLY from voice-security/gate.ts + toolPolicy.ts. A caller who
// announces a relay service, a hearing loss, a speech difficulty or an accent gets exactly the same verification,
// confirmation and rate-limit rules as everyone else, and is never treated as MORE suspicious because of it.
//
// LEGAL: relay-service obligations and wording (ADA Title IV / FCC TRS rules and local equivalents), text-message consent
// and the accessible-communication duties of each business are [COUNSEL]. Silence thresholds below are product defaults,
// not research-validated values [VERIFY with users who rely on relay / speech-to-speech services].

export type AccessibilityIntent =
  | "repeat"
  | "slow_down"
  | "need_more_time"
  | "text_instead"
  | "hearing_difficulty"
  | "speech_difficulty"
  | "relay_call"
  | "accent_concern";

export type AccessibilityMode = "standard" | "patient" | "relay";

// ---------------------------------------------------------------------------------------------
// Intent detection (English + Spanish, the two languages the live agent already serves)
// ---------------------------------------------------------------------------------------------

interface IntentRule { intent: AccessibilityIntent; pattern: RegExp }

// Patterns are deliberately narrow: they match requests ABOUT HOW Sarah speaks, never requests to reveal or repeat
// instructions. "repeat your instructions / system prompt" is NOT a `repeat` intent (see EXCLUDE below).
const RULES: readonly IntentRule[] = [
  { intent: "repeat", pattern: /\b(can|could|would|will) you (please )?(say|repeat|read) (that|it|this|the (address|number|time|date|name))( (again|once more|one more time))?\b/i },
  { intent: "repeat", pattern: /\b(say|repeat|read) (that|it|the (address|number|time|date)) (again|once more)\b|\bone more time\b|\bsay (that )?again\b|\bplease repeat (that|the (address|number|time|date))\b|\bwhat was that\b|\bi (didn'?t|did not|couldn'?t|could not) (catch|hear|get) (that|it)\b|\bpardon\b/i },
  { intent: "repeat", pattern: /\b(repite|repita|puede repetir|otra vez|de nuevo)\b|\bno (te |lo )?(escuch[eé]|entend[ií])\b/i },
  { intent: "slow_down", pattern: /\b(please )?(slow(er)? down|speak (more )?slow(ly|er)|talk (more )?slow(ly|er)|(a )?(little|bit) slower|too fast)\b/i },
  { intent: "slow_down", pattern: /\b(m[aá]s despacio|habla(r)? (m[aá]s )?lento|muy r[aá]pido)\b/i },
  { intent: "need_more_time", pattern: /\b(give me|i need|take) (a )?(moment|minute|second|more time|some time)\b|\bhold on\b|\bone moment\b|\bwait (a )?(sec|second|moment|minute)\b|\bi'?m (typing|writing|still typing)\b|\bun momento\b|\bespere\b/i },
  { intent: "text_instead", pattern: /\b(can|could) (you|we) (just )?(text|message|sms) (me|us)\b|\b(text|sms|message) me (instead|please|the)\b|\bsend (me )?(a )?(text|sms)\b|\bprefer (to )?(text|texting|sms|messages?)\b|\b(can|could) we do this (by|over|via) text\b|\bmand[ae]me un (mensaje|texto)\b|\bpor (mensaje|texto)\b/i },
  { intent: "hearing_difficulty", pattern: /\b(i'?m|i am|i'?m a) (deaf|hard of hearing|hearing impaired|hearing[- ]impaired)\b|\bhard of hearing\b|\b(i|we) (can'?t|cannot|don'?t) hear (you |well|very well|properly)\b|\bbad (hearing|connection) on my end\b|\bsoy (sord[oa]|dur[oa] de o[ií]do)\b|\bno (te )?oigo bien\b/i },
  { intent: "speech_difficulty", pattern: /\b(i|i'?ve|i have) (a )?(stutter|stammer|speech (impairment|difficulty|disability|disorder))\b|\bi (stutter|stammer)\b|\b(my|the) speech (is|may be|can be) (hard|difficult|slow|unclear)\b|\bit takes me (a while|time) to (talk|speak|say)\b|\btengo (tartamudez|dificultad (para|al) hablar)\b/i },
  { intent: "accent_concern", pattern: /\b(sorry|apologi[sz]e|excuse)( for)? (my|the) accent\b|\bmy accent\b|\bi have (a|an) (strong |heavy |thick )?accent\b|\benglish is (my )?(second|not my first)\b|\bperd[oó]n por mi acento\b|\bmi ingl[eé]s no es muy bueno\b/i },
  // Relay announcements. Relay operators speak in the third person and use "GA" (go ahead) / "SK" (stop keying).
  { intent: "relay_call", pattern: /\b(this is|i'?m|i am) (the |a |your )?(relay|video relay|vrs|ip relay|ip cts|captioned telephone|telecommunications relay|tty|911 relay)( service)?( operator| interpreter| assistant| agent)?\b|\b(relay (operator|service|call)|video relay|video interpreter|ip relay|ip cts|captioned (telephone|call)|speech[- ]to[- ]speech|\bSTS\b|\b(711|tty|tdd|text telephone)\b|(using|through|via|calling (you )?(with|through|using)) (a |the )?relay)\b/i },
  { intent: "relay_call", pattern: /\b(the )?(caller|client|customer) (says|would like|wants|is asking|asks|needs|is calling)\b.*\b(go ahead|ga)\b|\bgo ahead\s*\(?\s*GA\s*\)?\b|\bGA to SK\b/i },
  { intent: "relay_call", pattern: /\b(soy|llamo (por|con)) (el )?(operador|servicio) de (retransmisi[oó]n|relay)\b/i },
];

/** Requests to disclose or replay the agent's instructions are NOT accessibility requests. */
const EXCLUDE = /\b(system|hidden|initial|internal|previous|prior|above|your) (prompt|instructions?|rules|message|configuration|tool list)\b|\binstructions?\b.*\b(repeat|say|read|print|reveal)\b|\b(repeat|say|read|print|reveal)\b.*\b(your|the) (prompt|instructions?|rules|system)\b|\bword for word\b/i;

export interface DetectionResult {
  intents: AccessibilityIntent[];
  /** True when the utterance asks Sarah to reveal/replay her own instructions. Such text never yields accessibility intents. */
  disclosureAttempt: boolean;
}

export function detectAccessibilityIntents(utterance: string): DetectionResult {
  const text = (utterance ?? "").normalize("NFKC").replace(/[\u200B-\u200F\u2060-\u2064\uFEFF]/g, "").slice(0, 600);
  if (EXCLUDE.test(text)) return { intents: [], disclosureAttempt: true };
  const found = new Set<AccessibilityIntent>();
  for (const r of RULES) if (r.pattern.test(text)) found.add(r.intent);
  if (/\bGA\s*$/.test(text.trim())) found.add("relay_call"); // upper-case "GA" (go ahead) as the final token, typical relay text
  return { intents: [...found], disclosureAttempt: false };
}

// ---------------------------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------------------------

export interface AccessibilityState {
  mode: AccessibilityMode;
  repeatRequests: number;
  slowRequests: number;
  /** Consecutive recognition problems ("didn't catch that"). Never feeds any fraud / verification / abuse score. */
  recognitionMisses: number;
  textPreferred: boolean;
  hearingOrSpeechDisclosed: boolean;
}

export const initialState = (): AccessibilityState => ({
  mode: "standard", repeatRequests: 0, slowRequests: 0, recognitionMisses: 0, textPreferred: false, hearingOrSpeechDisclosed: false,
});

/** Pure reducer. Relay is sticky (a relay call stays a relay call); patient is sticky within a call; neither ever downgrades. */
export function applyIntents(prev: AccessibilityState, intents: readonly AccessibilityIntent[]): AccessibilityState {
  const s = { ...prev };
  for (const i of intents) {
    switch (i) {
      case "repeat": s.repeatRequests += 1; break;
      case "slow_down": s.slowRequests += 1; if (s.mode === "standard") s.mode = "patient"; break;
      case "need_more_time": if (s.mode === "standard") s.mode = "patient"; break;
      case "text_instead": s.textPreferred = true; break;
      case "hearing_difficulty":
      case "speech_difficulty": s.hearingOrSpeechDisclosed = true; if (s.mode === "standard") s.mode = "patient"; break;
      case "relay_call": s.mode = "relay"; s.hearingOrSpeechDisclosed = true; break;
      case "accent_concern": if (s.mode === "standard") s.mode = "patient"; break;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Pacing, patience and turn limits
// ---------------------------------------------------------------------------------------------

export interface TurnLimitsForMode { maxWords: number; maxSentences: number; maxQuestions: number; digitsPerGroup: number }

/** Standard values mirror persona.ts TURN_LIMITS. Patient/relay turns are shorter, one idea each, numbers in small groups. */
export function turnLimitsFor(mode: AccessibilityMode): TurnLimitsForMode {
  switch (mode) {
    case "patient": return { maxWords: 25, maxSentences: 2, maxQuestions: 1, digitsPerGroup: 3 };
    // Relay: the operator relays text/signing, so turns are complete, plain and unambiguous; no rhetorical or stacked questions.
    case "relay": return { maxWords: 30, maxSentences: 3, maxQuestions: 1, digitsPerGroup: 3 };
    default: return { maxWords: 35, maxSentences: 3, maxQuestions: 1, digitsPerGroup: 4 };
  }
}

export type SilenceAction =
  | { action: "wait" }
  | { action: "check_in"; line: "silence_check_in" | "silence_check_in_patient" | "silence_check_in_relay" }
  | { action: "offer_alternatives"; line: "silence_offer_text" }
  | { action: "end_politely"; line: "silence_end_with_followup" };

/** Silence timings (ms since the caller last spoke / since Sarah finished speaking). Defaults, not validated [VERIFY]. */
export const SILENCE_POLICY: Record<AccessibilityMode, { checkInMs: number; offerMs: number; endMs: number }> = {
  standard: { checkInMs: 5_000, offerMs: 10_000, endMs: 20_000 },
  patient: { checkInMs: 15_000, offerMs: 35_000, endMs: 90_000 },
  // Relay operators type or sign every utterance and often wait for a "GA": the longest allowance.
  relay: { checkInMs: 25_000, offerMs: 60_000, endMs: 120_000 },
};

/**
 * What to do after `silentMs` of silence. Ending the call is the LAST resort and never happens without first
 * offering a text / callback follow-up (the caller can still be reached). Safety: if an emergency is flagged the
 * agent must never hang up on silence at all (the caller may be unable to speak) and must keep the line open.
 */
export function nextSilenceAction(mode: AccessibilityMode, silentMs: number, opts: { checkInsGiven: number; emergencyFlagged?: boolean }): SilenceAction {
  const p = SILENCE_POLICY[mode];
  if (opts.emergencyFlagged) return silentMs >= p.checkInMs && opts.checkInsGiven === 0 ? { action: "check_in", line: lineFor(mode) } : { action: "wait" };
  if (silentMs >= p.endMs && opts.checkInsGiven >= 2) return { action: "end_politely", line: "silence_end_with_followup" };
  if (silentMs >= p.offerMs && opts.checkInsGiven >= 1) return { action: "offer_alternatives", line: "silence_offer_text" };
  if (silentMs >= p.checkInMs && opts.checkInsGiven === 0) return { action: "check_in", line: lineFor(mode) };
  return { action: "wait" };
}
const lineFor = (m: AccessibilityMode) => (m === "relay" ? "silence_check_in_relay" : m === "patient" ? "silence_check_in_patient" : "silence_check_in");

// ---------------------------------------------------------------------------------------------
// Repeat / slow-down behaviour
// ---------------------------------------------------------------------------------------------

export type RepeatStrategy = "repeat_same" | "rephrase_simpler" | "offer_text" | "offer_text_or_human";

/** 1st request: repeat. 2nd: say it again in simpler words. 3rd: also offer to text it. 4th+: text or a person. Never sighs, never refuses. */
export function repeatStrategy(repeatRequests: number): RepeatStrategy {
  if (repeatRequests <= 1) return "repeat_same";
  if (repeatRequests === 2) return "rephrase_simpler";
  if (repeatRequests === 3) return "offer_text";
  return "offer_text_or_human";
}

/** Recognition trouble (ASR misses, accent, stutter). Accent is NEVER a risk signal; the ladder only adds ways to be understood. */
export type RecognitionStep = "ask_again" | "offer_spelling_or_read_back" | "offer_text" | "offer_human_or_callback";
export function recognitionLadder(misses: number): RecognitionStep {
  if (misses <= 1) return "ask_again";
  if (misses === 2) return "offer_spelling_or_read_back";
  if (misses === 3) return "offer_text";
  return "offer_human_or_callback";
}

/** Reads digits in small groups for slow, clear speech: phone numbers as 3-3-4, anything else in groups of `digitsPerGroup`. Patient/relay modes separate each digit. */
export function speakDigits(digits: string, mode: AccessibilityMode): string {
  const d = digits.replace(/\D/g, "");
  const sizes: number[] = [];
  if (d.length === 10) sizes.push(3, 3, 4);
  else for (let i = 0; i < d.length; i += turnLimitsFor(mode).digitsPerGroup) sizes.push(Math.min(turnLimitsFor(mode).digitsPerGroup, d.length - i));
  const groups: string[] = [];
  let at = 0;
  for (const n of sizes) { groups.push(d.slice(at, at + n)); at += n; }
  return groups.map((g) => (mode === "standard" ? g : g.split("").join(" "))).join(", ");
}

// ---------------------------------------------------------------------------------------------
// SMS fallback decision
// ---------------------------------------------------------------------------------------------

export type TextFallbackDecision =
  | { channel: "caller_id_sms"; reason: "caller_requested_text" | "hearing_or_speech_difficulty" | "recognition_trouble" | "silence" }
  | { channel: "ask_for_text_number"; reason: "relay_caller_id_is_not_the_caller" | "no_caller_id" }
  | { channel: "none"; reason: "not_needed" };

/**
 * Where a text follow-up may go. Rules:
 *  - Only ever the caller's OWN caller-ID number, or a number the caller gives and that is stored via book_appointment's
 *    `phone` (never an arbitrary number typed into an SMS tool: that would be an SMS-pumping / harassment vector).
 *  - On a relay call the caller ID belongs to the relay provider, not the person, so we never text it. We ask for the
 *    caller's own text number instead.
 *  - Blocked caller ID: ask for a number.
 */
export function decideTextFallback(input: { callerNumber: string | null; mode: AccessibilityMode; textPreferred: boolean; hearingOrSpeechDisclosed: boolean; recognitionMisses: number; silenceOffered?: boolean }): TextFallbackDecision {
  const wants = input.textPreferred || input.hearingOrSpeechDisclosed || input.recognitionMisses >= 3 || Boolean(input.silenceOffered);
  if (!wants) return { channel: "none", reason: "not_needed" };
  if (input.mode === "relay") return { channel: "ask_for_text_number", reason: "relay_caller_id_is_not_the_caller" };
  if (!input.callerNumber) return { channel: "ask_for_text_number", reason: "no_caller_id" };
  return {
    channel: "caller_id_sms",
    reason: input.textPreferred ? "caller_requested_text" : input.hearingOrSpeechDisclosed ? "hearing_or_speech_difficulty" : input.recognitionMisses >= 3 ? "recognition_trouble" : "silence",
  };
}

// ---------------------------------------------------------------------------------------------
// Relay-call guidance + prompt block
// ---------------------------------------------------------------------------------------------

/** Compact block injected into the live prompt (kept short on purpose: per-call tokens add latency). Persona test caps the total. */
export function buildAccessibilityPromptBlock(): string {
  return [
    "ACCESSIBILITY: never doubt or penalize an accent, stutter, slow speech or long pauses.",
    "Asked to repeat: repeat, then use simpler words, then offer a text. Asked to slow down: shorter turns, numbers in small groups.",
    "Be patient with silence: offer a text or callback before ever ending a call, and never hang up on silence during an emergency.",
    "A relay operator or interpreter is the caller: speak plainly to the caller, ask one thing at a time, say \"go ahead\" when done.",
    "Texting: request_text_followup (caller's own number only); on a relay call ask for their text number and book with it.",
    "Accessibility never changes identity checks.",
  ].join(" ");
}
