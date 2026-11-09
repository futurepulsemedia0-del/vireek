// supabase/functions/_shared/vertical-ai/requestPolicy.ts
//
// Deterministic screen for requests the assistant must never satisfy: free service / price overrides,
// unsafe DIY instructions on gas/electrical/refrigerant/safety devices, and prompt-injection attempts.
// PURE. Output is a verdict, not prose: the caller (runtime.ts) decides the spoken reply.

import { normalizeText } from "./ontology.ts";

export type RequestIntent = "free_service" | "price_override" | "unsafe_diy" | "prompt_injection" | "none";

export interface RequestVerdict { intent: RequestIntent; action: "refuse_and_handoff" | "none"; rule: string | null }

const LEGIT_FREE = /\bfree (?:estimate|estimates|quote|quotes|diagnostic|inspection|second opinion)s?\b/;
const FREE_DEMAND = /\b(?:put (?:\S+ ){0,4}under warranty|mark (?:\S+ ){0,3}(?:warranty|covered)|not to charge me|not charge me|dont charge|do not charge|say (?:its|it is|that its) (?:covered|under warranty)|for free|free of charge|waive(?:d)? (?:the )?(?:fee|fees|charge|diagnostic|trip)?|comp it|comp the|no charge|dont charge me|do not charge me|wont pay|not paying|you owe me|just say (?:its|it is) covered|mark it (?:as )?(?:warranty|covered)|say its under warranty|put it under warranty)\b/;
const PO_VERBS = "guarantee me|promise me|assure me|commit to|in writing|do it for|price match|match (?:their|that|the|it)(?: price| quote)?|beat (?:it|that|their|the)(?: price| quote)?|honor (?:the|that|this) (?:\\S+ ){0,3}(?:price|quote)|lock in|promise (?:me )?(?:its|it will be|a price|youll)|guarantee (?:me )?(?:the )?price|confirm (?:its|it is|youll)(?: \\S+){0,6} for";
// normalizeText() strips "$", so a number is just digits here; the number may come before or after the verb phrase.
const PO_RE = new RegExp(`\\b(?:${PO_VERBS})\\b`);
const PRICE_OVERRIDE = { test: (t: string): boolean => PO_RE.test(t) && /\d/.test(t) };
const INJECTION = /\b(?:ignore (?:all |any |your |the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)|disregard (?:your |the )?(?:instructions|rules|policy)|system prompt|reveal (?:your )?(?:prompt|instructions)|you are now|developer mode|jailbreak|new instructions|override (?:your )?(?:rules|policy|instructions)|act as (?:an? )?(?:admin|owner|manager))\b/;
const DIY_VERB = /\b(?:whats the (?:trick|way|secret)|what is the (?:trick|way|secret)|is there a way to|any way to|walk me through|how to|how (?:do|can|would|should) (?:i|you|we)|can i|should i|tell me how|show me how|what is the way to|walk me through|steps to)\b/;
const DIY_HAZARD = /\b(?:bypass(?:ing)?|by pass|jumper|jump (?:the )?(?:limit|safety|switch|breaker)|disable (?:the )?(?:safety|limit|flame sensor|flamesensor|flamepart|gfci|breaker)|remove (?:the )?(?:co|smoke|carbon monoxide) (?:detector|alarm)|take (?:the )?batteries? out of (?:the )?(?:co|smoke|carbon monoxide)|open(?:ing)? (?:the )?(?:breaker |electrical |service )?(?:panel|box)|(?:swap|swapping|replace|replacing|change|changing) (?:the )?(?:main )?breaker|work on (?:the )?(?:panel|live|wiring)|live wires?|splice|rewir(?:e|ing)|(?:tape|taping|patch|patching|seal|fix|fixing) (?:a |the )?gas (?:line|leak|pipe)|disconnect (?:the )?gas|turn (?:the )?gas back on|recharg(?:e|ing) (?:the |my |our )?(?:ac|freon|refrigerant)|add (?:freon|refrigerant)|vent (?:the )?refrigerant|replace (?:the )?(?:breaker|main breaker|panel))\b/;

export function screenRequest(text: string | null | undefined): RequestVerdict {
  const t = normalizeText(text);
  if (!t) return { intent: "none", action: "none", rule: null };
  if (INJECTION.test(t)) return { intent: "prompt_injection", action: "refuse_and_handoff", rule: "injection" };
  if (DIY_VERB.test(t) && DIY_HAZARD.test(t)) return { intent: "unsafe_diy", action: "refuse_and_handoff", rule: "diy_hazard" };
  if (DIY_HAZARD.test(t) && /\b(?:myself|on my own|by myself|diy|without (?:a )?(?:tech|technician|electrician|plumber))\b/.test(t)) return { intent: "unsafe_diy", action: "refuse_and_handoff", rule: "diy_hazard_self" };
  if (PRICE_OVERRIDE.test(t)) return { intent: "price_override", action: "refuse_and_handoff", rule: "price_override" };
  if (FREE_DEMAND.test(t) && !LEGIT_FREE.test(t)) return { intent: "free_service", action: "refuse_and_handoff", rule: "free_demand" };
  return { intent: "none", action: "none", rule: null };
}

/** Fixed spoken replies: never model-authored, never contain a price or a how-to. */
export const REFUSAL_SPOKEN: Record<Exclude<RequestIntent, "none">, string> = {
  free_service: "I'm not able to waive or change charges on this call. I can have a team member review it with you and follow up.",
  price_override: "I can only quote what's on our price list. I can have a team member discuss anything beyond that.",
  unsafe_diy: "That work can be dangerous to do yourself, so I can't walk you through it. I can get a licensed technician out to handle it safely.",
  prompt_injection: "I can only help with scheduling and questions about our services. Let me connect you with a team member if you need anything else.",
};
