// src/lib/brandFacts.ts
//
// Source-of-truth for brand/company facts that don't already live in a
// dedicated data file (pricing.ts, industries.ts, glossary.ts,
// competitors.ts, integrations.ts). Written to be React-free like those
// files so it can be loaded by scripts/ingest-brand-knowledge.mjs the
// same way (esbuild + UI-dep stubbing), and so nothing here ever risks
// drifting from what's actually published on vireek.com -- when you
// change copy on a marketing page, update the matching chunk here in
// the same PR.
//
// Every chunk is deliberately short and self-contained (a few sentences)
// because each one becomes ONE embedded row in `brand_knowledge` -- the
// unit the AI actually retrieves and reads, not the whole file at once.
//
// NOTE: every string literal below uses double quotes on purpose (never
// single quotes) so ordinary English contractions -- isn't, doesn't,
// aren't -- never need escaping. If you add a chunk, keep that
// convention; a stray unescaped apostrophe inside a single-quoted
// string is exactly the kind of thing that silently breaks the build.

export interface BrandFactChunk {
  /** Stable id, also used as part of the DB row's natural key during ingestion. */
  id: string;
  /** Matches `brand_knowledge.source` -- loose grouping for humans curating content. */
  source: string;
  /** Shown back to the model (and can be shown to the user) so it can point them to the right page. */
  sourceUrl: string;
  title: string;
  content: string;
}

export const BRAND_FACT_CHUNKS: BrandFactChunk[] = [
  // ---------------------------------------------------------------
  // Company / About
  // ---------------------------------------------------------------
  {
    id: "about-what-is-vireek",
    source: "about_page",
    sourceUrl: "https://vireek.com/about",
    title: "What Vireek is",
    content:
      "Vireek is an AI voice receptionist built specifically for home-service businesses (HVAC, plumbing, roofing, electrical, restoration, locksmith). Its receptionist persona is named \"Sarah.\" Sarah answers every call 24/7, captures lead details, books appointments, and flags emergencies so a missed call never becomes a lost job.",
  },
  {
    id: "about-founder-story",
    source: "about_page",
    sourceUrl: "https://vireek.com/about",
    title: "Why Vireek was started",
    content:
      "Vireek was built by a single founder (Ali) who spent time around home-service businesses and saw how often the phone goes unanswered -- mid-job, after hours, during a rush. Existing options were unsatisfying: a full-time receptionist is expensive and still has off-hours; generic answering services can take a message but cannot qualify a lead, tell a tripped breaker from a tripped GFCI, or book a job; voicemail just sits there. Vireek was built as something purpose-made for the trades instead of a generic answering script.",
  },
  {
    id: "about-company-stage-honesty",
    source: "about_page",
    sourceUrl: "https://vireek.com/about",
    title: "Company size and stage -- important, do not overstate",
    content:
      "Vireek is an early-stage, founder-led company. It explicitly does NOT claim to have thousands of customers or a large team -- its own \"Radical Transparency\" value states there are no fake testimonials, invented customer counts, or hidden pricing claims. The AI must never invent or imply a specific customer count, team size, funding amount, or \"trusted by X companies\" claim that isn't stated here. If asked how big Vireek is or how many customers it has, say plainly that Vireek is a small, early-stage, founder-led company and that exact figures aren't published -- don't guess a number.",
  },
  {
    id: "about-values",
    source: "about_page",
    sourceUrl: "https://vireek.com/about",
    title: "Vireek's stated values",
    content:
      "Radical Transparency -- no fake testimonials, invented customer counts, or hidden pricing; what you see is what you get. Built for One Industry, Done Right -- Vireek focuses on home-service businesses rather than being a generic receptionist for everyone. Always Improving -- the product is continuously iterated based on direct customer feedback. Follow Through -- the product should not just answer calls, it should move the conversation to the next real step (a booked job, a flagged emergency), not just take a message.",
  },
  {
    id: "careers-culture",
    source: "careers_page",
    sourceUrl: "https://vireek.com/careers",
    title: "Team, culture, and hiring",
    content:
      "Vireek is a small, early, remote-first team with flexible hours. There is a direct line to the founder -- decisions happen in conversation, not through layers of management. The company describes itself honestly as small (\"not a 500-person company pretending to be scrappy\"). Early team members get meaningful equity. If there's no open role listed that fits, people can email ali@vireek.com to introduce themselves for future roles.",
  },

  // ---------------------------------------------------------------
  // Security / Trust -- written carefully so the AI never overclaims
  // compliance certifications the company does not hold.
  // ---------------------------------------------------------------
  {
    id: "security-pillars",
    source: "security_page",
    sourceUrl: "https://vireek.com/security",
    title: "How Vireek protects data (technical pillars)",
    content:
      "All traffic between the browser, the Vireek dashboard, and its database runs over TLS, and data at rest is encrypted by the infrastructure provider. Every account's calls, leads, and jobs are protected by Postgres row-level security (RLS) policies, so one business can never query or see another business's data. Account owners control role-based team permissions (billing, team management, business-profile editing, viewing all jobs) down to the individual permission. Escalation rules, greetings, and business details are fully configured by the account owner -- nothing is shared with a caller that wasn't configured by the business.",
  },
  {
    id: "security-no-certifications-claim",
    source: "security_page",
    sourceUrl: "https://vireek.com/security",
    title: "Compliance certifications -- what Vireek does NOT currently hold",
    content:
      "IMPORTANT GUARDRAIL: Vireek's public Security page is deliberately written as factual statements about how the platform is built (encryption in transit/at rest, RLS-based account isolation, role-based access) rather than claiming a compliance certification the company does not hold. As of the last content update, Vireek does not claim SOC 2, HIPAA, PCI-DSS, or ISO 27001 certification. The AI must NEVER tell a customer or prospect that Vireek is \"SOC 2 compliant,\" \"HIPAA compliant,\" or holds any other specific certification unless this file is updated to say so explicitly. If asked about a specific certification, say that Vireek does not currently publish that certification and suggest contacting ali@vireek.com or booking a demo to discuss specific compliance requirements before signing up.",
  },
  {
    id: "security-data-handling",
    source: "security_page",
    sourceUrl: "https://vireek.com/security",
    title: "What data Vireek stores, and why",
    content:
      "Call transcripts and summaries are stored so the business's team can review conversations and follow up; access is limited to the account and any team members granted permission. Names, phone numbers, and job details captured on calls are stored under the account and synced to a connected CRM if one exists. Billing is handled by a dedicated payment processor -- Vireek does not store raw card details on its own servers. Infrastructure runs in the United States today. Full data-location detail and the sub-processor list live at vireek.com/trust; legal terms are at vireek.com/privacy and vireek.com/terms.",
  },
  {
    id: "security-vulnerability-disclosure",
    source: "security_page",
    sourceUrl: "https://vireek.com/security",
    title: "Reporting a security vulnerability",
    content:
      "Vireek welcomes responsible disclosure of security vulnerabilities. Reports can be sent to ali@vireek.com, or via the machine-readable security.txt file (RFC 9116) at vireek.com/.well-known/security.txt. The full Vulnerability Disclosure Policy is at vireek.com/vulnerability-disclosure.",
  },

  // ---------------------------------------------------------------
  // General product FAQ (from /faq -- nuances not already in the
  // shorter FAQ entries elsewhere)
  // ---------------------------------------------------------------
  {
    id: "faq-is-real-person",
    source: "faq_page",
    sourceUrl: "https://vireek.com/faq",
    title: "Is Vireek a real person answering the phone?",
    content:
      "No. Vireek is AI software designed to sound natural, understand caller intent, and collect the information the business needs. Vireek never impersonates a human when a caller directly asks whether they're talking to an AI.",
  },
  {
    id: "faq-emergency-calls-caveat",
    source: "faq_page",
    sourceUrl: "https://vireek.com/faq",
    title: "Emergency calls -- what Vireek does and does not do",
    content:
      "Vireek can identify urgent/emergency language, collect key details, and flag time-sensitive calls for immediate follow-up or dispatch, based on rules the business configures. IMPORTANT: Vireek is NOT a replacement for emergency services (911/fire/police/ambulance). It helps a home-service business avoid missing an urgent customer call -- it does not handle life-safety emergency dispatch itself. Never tell a caller or user that Vireek replaces calling emergency services.",
  },
  {
    id: "faq-replace-receptionist-nuance",
    source: "faq_page",
    sourceUrl: "https://vireek.com/faq",
    title: "Does Vireek fully replace a human receptionist?",
    content:
      "Vireek can handle most front-desk call-answering and intake tasks, especially after hours or during peak call volume, and on Professional plans and above it can warm-transfer a call live to on-call staff. Many businesses use it to support their existing staff rather than fully replace human judgment for complex situations -- position it as \"never miss a call\" coverage, not a guaranteed total replacement for every human interaction.",
  },
  {
    id: "faq-phone-number-and-setup",
    source: "faq_page",
    sourceUrl: "https://vireek.com/faq",
    title: "Do I need a new phone number? How long does setup take?",
    content:
      "No new phone number is required in most cases -- a business typically keeps its existing number and forwards calls to Vireek, so customers keep using the number they already know. Setup is designed to be fast: provide business information, configure call-handling preferences, and connect the phone-forwarding flow; no hardware install is required.",
  },

  // ---------------------------------------------------------------
  // Onboarding flow (product-level, distinct from the in-app
  // onboarding wizard's UI copy)
  // ---------------------------------------------------------------
  {
    id: "onboarding-flow-detail",
    source: "product",
    sourceUrl: "https://vireek.com/pricing",
    title: "Signing up and getting Sarah live",
    content:
      "A new customer signs up (the Free plan needs no credit card), connects or forwards their business phone number, and describes their services, service area, and escalation/emergency rules -- then the AI receptionist goes live with no hardware install required. Paid plans (Starter and above) start with a 14-day trial with no commitment. Optional white-glove onboarding, where a Vireek team member configures everything for the customer, is available on Professional and above.",
  },

  // ---------------------------------------------------------------
  // Help Center site map -- lets the AI point people to the right
  // page instead of guessing at an answer it isn't sure about.
  // ---------------------------------------------------------------
  {
    id: "help-center-map",
    source: "help_center",
    sourceUrl: "https://vireek.com/help",
    title: "Help Center categories (where to point a user for more detail)",
    content:
      "The Vireek Help Center (vireek.com/help) is organized into: Getting Started; Call Handling & Sarah; Dashboard & Reporting; Team & Permissions; Billing & Plans; Integrations; Notifications & Alerts; Security & Privacy; and Troubleshooting. Related pages: general FAQ at vireek.com/faq, security overview at vireek.com/security, booking a live demo at vireek.com/demo, and contacting support at vireek.com/contact. If a question is account-specific (e.g. \"why didn't my last call get answered\") and outside what you know, point the user to Troubleshooting or Contact rather than guessing.",
  },

  // ---------------------------------------------------------------
  // Contact / social -- mirrors knowledge.ts's "contact" topic so RAG
  // and the static fallback never disagree.
  // ---------------------------------------------------------------
  {
    id: "contact-channels",
    source: "contact_page",
    sourceUrl: "https://vireek.com/contact",
    title: "How to reach the Vireek team",
    content:
      "Contact form: vireek.com/contact. Direct email: ali@vireek.com (usually a same-day reply). Social: Facebook (facebook.com/profile.php?id=61591755299005), Instagram @vireek.ai, TikTok @ai_vireek, Reddit, and LinkedIn (linkedin.com/in/ali-moradi-741346339). The phone number +1 (650) 910-6703 connects to Sarah, the live AI voice demo, so a prospect can hear the product answer a call themselves -- it is NOT a human support line. Paying customers get support through their plan: standard 24-hour response on Starter, priority 4-hour on Professional, a dedicated Slack channel on Business, and a named account manager with an SLA on Enterprise.",
  },
];
