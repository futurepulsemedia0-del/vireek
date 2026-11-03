// supabase/functions/_shared/agent-callers/detect.ts
//
// Pure (no Deno / npm imports): decides whether the party on the line is a human, an AI agent calling on a
// customer's behalf, or unknown.
//
// WHAT THIS RELIES ON — and what it deliberately does NOT:
//   (a) documented self-identification   — the caller says, in words, that it is an AI / automated assistant
//                                           and/or that it is calling for a customer. STRONG evidence.
//   (b) conversational patterns          — structured question order, no greeting small-talk. WEAK evidence;
//                                           capped so patterns alone can never produce "ai_agent".
//   (c) provider-documented signals      — NONE are verified. As of the research behind this file (Nov 2026),
//                                           Google's own Business Profile help page (support.google.com/business/
//                                           answer/16190256) documents that price/availability calls exist, that
//                                           they are recorded, and how to opt out — it does NOT document a caller-ID
//                                           name/number, a SIP header, or a fixed opening line. So no number list,
//                                           user-agent or header heuristic is implemented. `ProviderSignal` is an
//                                           extension point that stays empty until a partner program documents one.
//
// Platform attribution ("google", …) comes ONLY from what the caller SAYS. Anyone can say it, so it is recorded
// as `platformClaimed` and never used to relax a safety check.
//
// Fail-safe: anything below the agent threshold behaves exactly like a human caller.

export type CallerKind = "human" | "ai_agent" | "unknown";

export type SignalSource = "self_identification" | "pattern" | "provider" | "human_marker";

export interface Signal {
  id: string;
  source: SignalSource;
  /** Contribution toward "AI agent" (0..1). Human markers carry weight against it. */
  weight: number;
}

export interface ProviderSignal {
  /** Reserved. Populate ONLY from a provider's published documentation (cite it in the PR). */
  id: string;
  platform: string;
  weight: number;
}

export interface Detection {
  kind: CallerKind;
  /** 0..1 confidence in `kind` (for "unknown" it is the confidence that we cannot tell). */
  confidence: number;
  /** 0..1 agent likelihood before thresholding. */
  agentScore: number;
  signals: Signal[];
  platformClaimed: string | null;
  /** True only when the protocol should switch to the agent exchange. */
  useAgentProtocol: boolean;
}

export const AGENT_THRESHOLD = 0.8;
/** Without ANY self-identification, patterns are capped here: never enough for "ai_agent". */
export const PATTERN_ONLY_CAP = 0.55;
export const HUMAN_THRESHOLD = 0.65;

const AI_NOUN = String.raw`(?:ai|a\.i\.|artificial intelligence|automated|virtual|digital|voice|booking|calling)`;
const ROLE_NOUN = String.raw`(?:assistant|agent|system|service|bot|caller|model)`;

interface Rule {
  id: string;
  re: RegExp;
  weight: number;
}

/** (a) Self-identification. Each pattern requires an explicit first-person / "this is" statement. */
const SELF_ID_RULES: Rule[] = [
  { id: "self_id_ai_assistant", re: new RegExp(String.raw`\b(?:i(?:'m| am)|this is|you(?:'re| are) (?:speaking|talking) (?:to|with))\s+(?:an?\s+|the\s+|\w+'s\s+)?(?:\w+\s+){0,2}${AI_NOUN}\s+${ROLE_NOUN}\b`, "i"), weight: 0.92 },
  { id: "self_id_automated_service_for", re: new RegExp(String.raw`\b(?:${AI_NOUN})\s+${ROLE_NOUN}\s+(?:calling|call(?:s)?|phoning)\s+(?:for|on behalf of)\b`, "i"), weight: 0.9 },
  { id: "self_id_this_call_automated", re: /\bthis (?:is an? )?(?:call|call is)\s+(?:is\s+)?(?:made|placed|from)\s+(?:by\s+)?(?:an?\s+)?(?:ai|automated|virtual)\b/i, weight: 0.88 },
  { id: "self_id_i_am_an_ai", re: /\bi(?:'m| am)\s+(?:an?\s+)?(?:ai|artificial intelligence|language model|bot|robot)\b/i, weight: 0.9 },
  // Weaker alone: a human office manager can also "call on behalf of a customer".
  { id: "behalf_of_customer", re: /\bcalling\s+(?:on behalf of|for)\s+(?:a|my|one of (?:our|my))\s+(?:customer|user|client)s?\b/i, weight: 0.5 },
  { id: "behalf_of_user_named", re: /\bon behalf of (?:a|the)\s+(?:homeowner|customer|user)\b/i, weight: 0.45 },
];

/** Negations that flip a self-identification ("I'm not an AI", "this isn't a robocall"). */
const NEGATION_RE = /\b(?:i(?:'m| am)\s+not|i(?:'m| am)\s+no|this\s+(?:is\s+not|isn't)|not\s+a(?:n)?)\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|automated|virtual|machine|recording|robocall)\b/i;

/** Platforms a caller can NAME. Unverified claims — recorded, never trusted. */
const PLATFORM_CLAIMS: { id: string; re: RegExp }[] = [
  { id: "google", re: /\bgoogle(?:'s)?\b/i },
  { id: "gemini", re: /\bgemini\b/i },
  { id: "openai", re: /\b(?:openai|chatgpt)\b/i },
  { id: "apple", re: /\b(?:siri|apple intelligence)\b/i },
  { id: "amazon", re: /\b(?:alexa|amazon)\b/i },
  { id: "yelp", re: /\byelp\b/i },
];

/** (b) Weak conversational patterns, evaluated per whole conversation. */
interface PatternCheck {
  id: string;
  weight: number;
  test: (turns: string[]) => boolean;
}

const GREETING_RE = /^\s*(?:hi|hello|hey|good (?:morning|afternoon|evening)|howdy)\b/i;
const SMALL_TALK_RE = /\b(?:how are you|how's it going|how is your day|hope you(?:'re| are) (?:well|doing)|thanks? (?:so much|a lot)|appreciate it|have a great)\b/i;
const DISFLUENCY_RE = /\b(?:um+|uh+|er+|hmm+|you know|i mean|like,)\b/i;
const QUESTION_WORDS_RE = /\b(?:price|pricing|cost|how much|quote|estimate|rate|fee|availab|appointment|earliest|next (?:open|available)|when can|warranty|permit|haul)/i;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

const PATTERN_CHECKS: PatternCheck[] = [
  {
    id: "pattern_opens_with_structured_request",
    weight: 0.2,
    // First turn goes straight to a combined price + availability ask with a ZIP, no greeting.
    test: (t) => !!t[0] && !GREETING_RE.test(t[0]) && /\b(?:price|cost|quote|rate)/i.test(t[0]) && /\bavailab|earliest|next (?:open|available)|appointment/i.test(t[0]) && ZIP_RE.test(t[0]),
  },
  {
    id: "pattern_enumerated_asks",
    weight: 0.15,
    test: (t) => t.some((x) => (x.match(/\b(?:first|second|third|also|and then)\b/gi) ?? []).length >= 2 && QUESTION_WORDS_RE.test(x)),
  },
  {
    id: "pattern_no_small_talk",
    weight: 0.1,
    test: (t) => t.length >= 3 && !t.some((x) => SMALL_TALK_RE.test(x) || GREETING_RE.test(x)),
  },
  {
    id: "pattern_uniform_terse_turns",
    weight: 0.1,
    test: (t) => t.length >= 3 && t.every((x) => x.split(/\s+/).length <= 22 && QUESTION_WORDS_RE.test(x) || /^(?:yes|no|ok|okay|confirmed|thank you)\b/i.test(x)),
  },
];

/** Things humans do that agents (so far) do not: they lower the agent score. */
const HUMAN_MARKERS: Rule[] = [
  { id: "human_small_talk", re: SMALL_TALK_RE, weight: 0.25 },
  { id: "human_disfluency", re: DISFLUENCY_RE, weight: 0.2 },
  { id: "human_emotion", re: /\b(?:oh my god|omg|help(?: me)?|please hurry|scared|panic|flooding|everywhere|my (?:wife|husband|kids?|mom|dad|dog)|i don't know what to do)\b/i, weight: 0.3 },
  { id: "human_negated_ai", re: NEGATION_RE, weight: 0.7 },
  { id: "human_asks_if_robot", re: /\b(?:are you (?:a |an )?(?:real|human|person|robot|bot|ai|machine)|is this a (?:recording|robot|machine))\b/i, weight: 0.35 },
];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Noisy-OR: independent positive signals combine without ever exceeding 1. */
const noisyOr = (ws: number[]) => 1 - ws.reduce((acc, w) => acc * (1 - clamp01(w)), 1);

export interface DetectInput {
  /** Only what the CALLER said, oldest first. Never pass the assistant's own turns. */
  callerTurns: string[];
  /** Reserved for provider-documented signals (none are verified today). */
  providerSignals?: ProviderSignal[];
}

export function detectCaller(input: DetectInput): Detection {
  const turns = (input.callerTurns ?? []).map((t) => (typeof t === "string" ? t.slice(0, 2000) : "")).filter((t) => t.trim().length > 0).slice(0, 40);
  const joined = turns.join(" \n ");
  const signals: Signal[] = [];

  if (turns.length === 0) {
    return { kind: "unknown", confidence: 1, agentScore: 0, signals, platformClaimed: null, useAgentProtocol: false };
  }

  const negated = NEGATION_RE.test(joined);
  let selfIdStrong = 0;
  let selfIdAny = 0;
  for (const rule of SELF_ID_RULES) {
    if (rule.re.test(joined)) {
      signals.push({ id: rule.id, source: "self_identification", weight: rule.weight });
      selfIdAny = Math.max(selfIdAny, rule.weight);
      if (rule.weight >= 0.85) selfIdStrong = Math.max(selfIdStrong, rule.weight);
    }
  }
  // A single weak "on behalf of" + an AI-ish self-id is already strong; weak-only stays weak.
  const providers = (input.providerSignals ?? []).filter((p) => p.weight > 0);
  for (const p of providers) signals.push({ id: `provider:${p.platform}:${p.id}`, source: "provider", weight: clamp01(p.weight) });

  const patternWeights: number[] = [];
  for (const check of PATTERN_CHECKS) {
    if (check.test(turns)) {
      signals.push({ id: check.id, source: "pattern", weight: check.weight });
      patternWeights.push(check.weight);
    }
  }
  const humanWeights: number[] = [];
  for (const rule of HUMAN_MARKERS) {
    if (rule.re.test(joined)) {
      signals.push({ id: rule.id, source: "human_marker", weight: rule.weight });
      humanWeights.push(rule.weight);
    }
  }

  const positives = noisyOr([
    ...(negated ? [] : signals.filter((s) => s.source === "self_identification").map((s) => s.weight)),
    ...signals.filter((s) => s.source === "provider").map((s) => s.weight),
  ]);
  const patternScore = Math.min(PATTERN_ONLY_CAP, noisyOr(patternWeights));
  const hasHardEvidence = !negated && (selfIdAny > 0 || providers.length > 0);
  let agentScore = hasHardEvidence ? noisyOr([positives, patternScore * 0.5]) : patternScore;
  const humanScore = noisyOr(humanWeights);
  // Human markers pull the score down proportionally (a self-ID is still not erased by a stray "um").
  agentScore = clamp01(agentScore * (1 - 0.6 * humanScore));

  // "calling on behalf of a customer" alone is not an AI admission: require a strong self-ID or provider signal.
  const hasStrongEvidence = !negated && (selfIdStrong > 0 || providers.some((p) => p.weight >= 0.85));
  const isAgent = hasStrongEvidence && agentScore >= AGENT_THRESHOLD;

  const platformClaimed = isAgent || selfIdAny > 0 ? detectPlatformClaim(joined) : null;

  if (isAgent) {
    return { kind: "ai_agent", confidence: round(agentScore), agentScore: round(agentScore), signals, platformClaimed, useAgentProtocol: true };
  }
  if (negated || humanScore >= HUMAN_THRESHOLD || (agentScore < 0.15 && turns.length >= 2)) {
    return { kind: "human", confidence: round(Math.max(humanScore, 1 - agentScore)), agentScore: round(agentScore), signals, platformClaimed: null, useAgentProtocol: false };
  }
  // Unsure: behave as for a human, politely. The agent score is kept for analytics only.
  return { kind: "unknown", confidence: round(1 - Math.abs(agentScore - 0.4)), agentScore: round(agentScore), signals, platformClaimed, useAgentProtocol: false };
}

function round(n: number): number {
  return Math.round(clamp01(n) * 1000) / 1000;
}

export function detectPlatformClaim(text: string): string | null {
  for (const p of PLATFORM_CLAIMS) if (p.re.test(text)) return p.id;
  return null;
}

/**
 * Sticky merge for a live call: once the agent protocol is on it stays on (an agent that self-identified does not
 * "become human"), and a human verdict is never overturned by pattern-only evidence.
 */
export function mergeDetections(prev: Detection | null, next: Detection): Detection {
  if (!prev) return next;
  if (prev.useAgentProtocol && next.kind !== "human") return { ...next, kind: "ai_agent", useAgentProtocol: true, agentScore: Math.max(prev.agentScore, next.agentScore), confidence: Math.max(prev.confidence, next.confidence), platformClaimed: prev.platformClaimed ?? next.platformClaimed, signals: dedupeSignals([...prev.signals, ...next.signals]) };
  if (prev.kind === "human" && !next.useAgentProtocol) return { ...prev, signals: dedupeSignals([...prev.signals, ...next.signals]) };
  return next;
}

function dedupeSignals(list: Signal[]): Signal[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}
