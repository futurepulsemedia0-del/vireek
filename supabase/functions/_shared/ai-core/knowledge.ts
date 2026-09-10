// supabase/functions/_shared/ai-core/knowledge.ts
//
// Vireek AI Core — Knowledge Layer. Separates business facts from brand
// behavior (identity.ts). Static object today; swap for real RAG later
// without touching any caller — everyone goes through the functions below.

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
  facts: string;
}

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
      "Exact current plan names and prices are managed in the product's own pricing page/config and change over time — point the user to the live Pricing page rather than quoting a number from memory, unless that number is explicitly supplied in the same request.",
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

export function getKnowledgeSnippet(topic: KnowledgeTopic): string {
  return byTopic.get(topic)?.facts ?? "";
}

export function getFullKnowledgeBrief(): string {
  return KNOWLEDGE_BASE.map((e) => `[${e.topic}]\n${e.facts}`).join("\n\n");
}

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
