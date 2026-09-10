// supabase/functions/_shared/ai-core/knowledge.ts
//
// Vireek AI Core — Knowledge Layer.
//
// Separates BUSINESS FACTS (what Vireek is, what it costs, what it does)
// from BRAND BEHAVIOR (tone, rules — see identity.ts). No provider ever
// gets business facts baked into its own prompt; everything flows through
// here so there is exactly one place to correct a claim.
//
// DESIGN NOTE (future RAG migration): today this is a static in-memory
// object because the fact set is small and rarely changes. Every consumer
// below calls `getKnowledgeSnippet(topic)` rather than importing the raw
// object directly — so when this grows into a real vector-search/RAG
// lookup, only THIS file changes; the AI Core, router, and edge functions
// never need to know the difference.
//
// RULE: never invent a fact here that isn't actually true of the product.
// If something isn't known, leave it out — the identity layer instructs
// every provider to say "I don't know" rather than fill gaps.

export type KnowledgeTopic =
  | "company"
  | "product"
  | "pricing"
  | "industries"
  | "faq"
  | "onboarding"
  | "policies";

interface KnowledgeEntry {
  topic: KnowledgeTopic;
  /** Plain-text facts, safe to paste directly into a system prompt. Keep
   *  each entry short — this is a prompt budget, not a knowledge base. */
  facts: string;
}

// ---------------------------------------------------------------------------
// EDIT THESE to match Vireek's actual, approved facts. Nothing here should
// be marketing copy or unapproved claims — this is what every AI provider
// is allowed to state as fact.
// ---------------------------------------------------------------------------
const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    topic: "company",
    facts:
      "Vireek is an AI-powered virtual receptionist and business-operations platform for home-service businesses (plumbing, HVAC, electrical, roofing, cleaning, landscaping, and similar trades). It answers and triages phone calls, qualifies leads, books jobs, and gives owners a dashboard with call/lead/job/revenue visibility.",
  },
  {
    topic: "product",
    facts:
      "Core capabilities: an AI voice receptionist that answers calls 24/7, automatic lead capture and qualification, emergency-call detection and escalation, appointment booking synced to the business's calendar, a dashboard with call history/leads/jobs/revenue, and an AI assistant that answers plain-English questions about the account's own data.",
  },
  {
    topic: "pricing",
    facts:
      "Exact current plan names and prices are managed in the product's own pricing page/config and change over time — the assistant must point the user to the live Pricing page rather than quoting a number from memory, unless that number is explicitly supplied to it in the same request.",
  },
  {
    topic: "industries",
    facts:
      "Vireek is built for home-service trades: plumbing, HVAC, electrical, roofing, cleaning/janitorial, landscaping, pest control, garage door, and similar appointment-based field-service businesses.",
  },
  {
    topic: "onboarding",
    facts:
      "New customers sign up, connect or forward their business phone number, describe their services and service area, and the AI receptionist goes live. No hardware install is required.",
  },
  {
    topic: "policies",
    facts:
      "Vireek never impersonates a human when directly asked and will identify itself as an AI receptionist if a caller asks. Customer call and business data is scoped per account; team members only see what their account's permissions allow.",
  },
  {
    topic: "faq",
    facts:
      "Common questions: (1) Does it replace my staff? — It handles calls so staff aren't interrupted, and hands off/escalates anything it can't resolve. (2) What happens on an emergency call? — It's detected and flagged/escalated immediately rather than queued normally. (3) Can it book appointments? — Yes, synced to the connected calendar.",
  },
];

const byTopic = new Map(KNOWLEDGE_BASE.map((e) => [e.topic, e]));

/**
 * Returns the approved fact block for one topic, or "" if nothing is on
 * file — callers must treat an empty string as "no authoritative info",
 * never fall back to guessing.
 */
export function getKnowledgeSnippet(topic: KnowledgeTopic): string {
  return byTopic.get(topic)?.facts ?? "";
}

/**
 * Returns every topic's facts concatenated, for tasks (like the public
 * demo chat) that need general brand grounding rather than one narrow
 * topic. Kept deliberately short — this is injected into every request.
 */
export function getFullKnowledgeBrief(): string {
  return KNOWLEDGE_BASE.map((e) => `[${e.topic}]\n${e.facts}`).join("\n\n");
}

/**
 * Lightweight keyword router from a free-text question to the most
 * relevant topic(s). Intentionally dumb (no embeddings) — this is the
 * seam that gets replaced by real semantic retrieval later without
 * changing anything that calls it.
 */
export function findRelevantTopics(question: string): KnowledgeTopic[] {
  const q = question.toLowerCase();
  const hits: KnowledgeTopic[] = [];
  const rules: [KnowledgeTopic, string[]][] = [
    ["pricing", ["price", "pricing", "cost", "plan", "$", "fee"]],
    ["industries", ["industry", "trade", "plumb", "hvac", "electric", "roof", "clean", "landscap"]],
    ["onboarding", ["sign up", "signup", "onboard", "get started", "setup", "set up"]],
    ["policies", ["human", "privacy", "data", "security", "policy"]],
    ["faq", ["replace", "staff", "emergency", "book", "appointment"]],
    ["product", ["feature", "does it", "capable", "can it"]],
    ["company", ["what is vireek", "who is vireek", "about vireek"]],
  ];
  for (const [topic, keywords] of rules) {
    if (keywords.some((k) => q.includes(k))) hits.push(topic);
  }
  return hits.length ? hits : ["company", "product"];
}
