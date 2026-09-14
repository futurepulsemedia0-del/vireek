// supabase/functions/_shared/ai-core/knowledge.ts
//
// Vireek AI Core — Knowledge Layer. Separates business FACTS from brand
// BEHAVIOR (identity/tone lives in index.ts). Static object today; swap
// for real RAG later without touching any caller — everyone goes through
// the functions below, never the KNOWLEDGE_BASE array directly.
//
// SOURCE OF TRUTH WARNING: this is a hand-kept mirror of
// src/lib/pricing.ts and src/lib/industries.ts (not a live import —
// those files pull in React/lucide-react, which can't run in the Deno
// edge runtime). If you change a plan price, a feature list, or add an
// industry in src/lib/, update the matching facts below in the same PR,
// or the AI will start giving customers stale answers.

export type KnowledgeTopic =
  | "company"
  | "product"
  | "pricing"
  | "industries"
  | "faq"
  | "onboarding"
  | "policies"
  | "contact";

interface KnowledgeEntry {
  topic: KnowledgeTopic;
  facts: string;
}

const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    topic: "company",
    facts:
      "Vireek is an AI-powered virtual receptionist and business-operations platform for home-service businesses (plumbing, HVAC, electrical, roofing, restoration, locksmith, and similar trades). It answers and triages phone calls 24/7, captures and qualifies leads, detects emergencies, books appointments, and gives owners a dashboard with call/lead/job/revenue visibility so a missed call never becomes a lost job.",
  },
  {
    topic: "product",
    facts:
      "Core capabilities: an AI voice receptionist ('Sarah') that answers every call 24/7 with no hold queue (including simultaneous calls during spikes); automatic lead capture and qualification; emergency-call detection with immediate escalation/dispatch per the business's own rules; appointment booking synced to the connected calendar; CRM sync (ServiceTitan, Housecall Pro, Jobber on Professional+); a dashboard with call history, leads, jobs, and revenue; and an AI assistant that answers plain-English questions about the account's own data.",
  },
  {
    topic: "pricing",
    facts:
      "Five plans, billed monthly or annually (annual = 10 months' price): " +
      "Free — $0/mo, 50 min included, 1 seat, 1 location: 24/7 AI call answering, voicemail-to-text, missed-call text-back, email call summaries, community support. " +
      "Starter — $79/mo, 400 min ($0.20/min overage), 2 seats, 1 location: everything in Free plus smart calendar booking, SMS appointment confirmations, 1 CRM integration, 7-day call transcript history, standard 24h support. " +
      "Professional (most popular) — $199/mo, 1,500 min ($0.15/min overage), 5 seats, 1 location: everything in Starter plus emergency detection & live dispatch, warm transfer to on-call staff, ServiceTitan/Housecall Pro/Jobber sync, unlimited call recording history, custom after-hours routing, automated review requests, priority 4h support. " +
      "Business — $399/mo, 4,000 min ($0.12/min overage), 15 seats, up to 3 locations: everything in Professional plus custom voice & script per location, advanced call-outcome analytics, role-based team access, dedicated Slack support. " +
      "Enterprise — starts at $999/mo, unlimited minutes/seats/locations, SLA-backed (no metering): everything in Business plus a custom-trained voice model, full API & webhook access, a dedicated account manager, audit logs & advanced access controls, written SLA — sales-assisted, no self-serve checkout. " +
      "No setup fee on any plan (optional white-glove onboarding on Professional+). Plans can be upgraded or downgraded anytime, prorated, effective next billing cycle. A minute = total talk time per call rounded to the nearest minute; hold time and voicemail transcription are never billed.",
  },
  {
    topic: "industries",
    facts:
      "Vireek has purpose-built call handling for six home-service trades, each with its own triage vocabulary and escalation logic: " +
      "HVAC — triages no-heat/no-cool and safety concerns for immediate dispatch, understands HVAC terminology (heat pumps, furnaces, refrigerant, ductwork), absorbs seasonal call spikes with zero hold time. " +
      "Plumbing — flags true emergencies (burst pipes, sewer backup) over low-priority calls (a running toilet), captures address/issue/urgency and syncs straight to CRM. " +
      "Roofing — handles unlimited simultaneous calls so a post-storm 10x call spike never means a busy signal; captures insurance-relevant damage details consistently. " +
      "Electrical — recognizes safety-critical language (sparking, burning smell, no power) and escalates immediately per the business's configured rules. " +
      "Restoration — treats water/fire damage calls as always time-sensitive, captures details for insurance claims, triggers the defined escalation path (SMS/transfer/team alert) for active flooding or fire damage. " +
      "Locksmith — captures lock type, location, and urgency 24/7, flags lockout/security emergencies for immediate dispatch, books routine rekeying/upgrades normally. " +
      "Across every trade, what counts as an emergency is configured per business, not hardcoded.",
  },
  {
    topic: "onboarding",
    facts:
      "New customers sign up (Free plan needs no card), connect or forward their business phone number, describe their services/service area/escalation rules, and the AI receptionist goes live — no hardware install required. Optional white-glove onboarding (a Vireek team member configures everything) is available on Professional and above. Paid plans start with a 14-day trial, no commitment.",
  },
  {
    topic: "policies",
    facts:
      "Vireek never impersonates a human when a caller directly asks if they're talking to an AI. Customer call and business data is scoped per account with Postgres Row Level Security — one account can never query another's data, and a team member only sees what their role's permissions allow. All calls are encrypted in transit and at rest. Enterprise plans include audit logging and role-based access controls.",
  },
  {
    topic: "faq",
    facts:
      "Common questions: (1) Does it replace my staff? — It handles calls so staff aren't interrupted mid-job, and warm-transfers or escalates anything it can't resolve; on Professional+ it can transfer live to on-call staff. (2) What happens on an emergency call? — It's detected against the business's own escalation rules and flagged/dispatched immediately rather than queued normally. (3) Can it book appointments? — Yes, synced to the connected calendar based on real availability. (4) What if I go over my included minutes? — Billed at the per-minute overage rate shown on the plan, visible up front, never a surprise fee or auto-upgrade. (5) Is there a setup fee? — No, on any plan.",
  },
  {
    topic: "contact",
    facts:
      "How to reach the Vireek team: the contact form at vireek.com/contact, or email ali@vireek.com directly (usually same-day reply). Vireek is on Facebook (facebook.com/profile.php?id=61591755299005), Instagram (@vireek.ai), TikTok (@ai_vireek), Reddit, and LinkedIn (linkedin.com/in/ali-moradi-741346339). The number +1 (650) 910-6703 connects to Sarah, the live AI voice demo, so a prospect can hear the product answer a call themselves — it is not a human support line. Paying customers get support through their plan's channel: standard 24h response on Starter, priority 4h on Professional, dedicated Slack channel on Business, and a named account manager with an SLA on Enterprise. General help and how-to articles live at vireek.com/help, common questions at vireek.com/faq, and current uptime at vireek.com/status. A free community for Vireek customers is being set up at vireek.com/community.",
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
    ["pricing", ["price", "pricing", "cost", "plan", "$", "fee", "trial", "minute", "overage", "upgrade", "downgrade"]],
    ["industries", ["industry", "trade", "plumb", "hvac", "electric", "roof", "restoration", "locksmith", "clean", "landscap"]],
    ["onboarding", ["sign up", "signup", "onboard", "get started", "setup", "set up", "trial"]],
    ["policies", ["human", "privacy", "data", "security", "policy", "encrypt", "rls", "access"]],
    ["faq", ["replace", "staff", "emergency", "book", "appointment", "transfer", "escalat"]],
    ["product", ["feature", "does it", "capable", "can it", "crm", "integrat", "dashboard"]],
    ["company", ["what is vireek", "who is vireek", "about vireek"]],
    ["contact", ["contact", "email address", "reach you", "get in touch", "talk to a human", "social media", "facebook", "instagram", "linkedin", "tiktok", "reddit", "phone number for support", "customer support"]],
  ];
  for (const [topic, keywords] of rules) {
    if (keywords.some((k) => q.includes(k))) hits.push(topic);
  }
  return hits.length ? hits : ["company", "product"];
}
