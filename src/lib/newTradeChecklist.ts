/**
 * New-trade expansion checklist — generator and draft-playbook linter. Pure (no I/O, no Supabase).
 *
 * Companion to docs/product/new-vertical-playbook.md. Two jobs:
 *  1. generateChecklist(candidate): everything a new trade needs (price book, intents, safety content,
 *     compliance, localization, data model, entry points, QA, release), filtered by what the candidate
 *     actually involves. Every touchpoint carries `evidence` (file + substring) so checkEvidence() can prove
 *     the claim is still true in the repository; the test suite runs it, so the checklist cannot rot silently.
 *  2. lintPlaybookDraft(draft): mechanical quality gates for a draft TradePlaybook BEFORE it is added to
 *     TRADE_PLAYBOOKS. It checks structure and internal consistency only. It cannot tell whether a price,
 *     benchmark or safety instruction is correct for the real world: that stays a human review item.
 *
 * Imports use relative `.ts` paths so scripts/product/new-trade-checklist.mjs can run this file with
 * `node --experimental-strip-types`. Keep it free of enums, namespaces and parameter properties.
 */

import { TRADE_PLAYBOOKS, matchJobType } from './tradePlaybookCatalog.ts';
import type { TradePlaybook } from './tradePlaybookCatalog.ts';

// ============================================================
// CANDIDATE
// ============================================================

export const HAZARDS = ['gas', 'smoke', 'electric', 'water', 'structural', 'height', 'stored_energy', 'chemical', 'other'] as const;
export type Hazard = (typeof HAZARDS)[number];

/**
 * Hazard classes that already have a FIXED life-safety line in
 * supabase/functions/_shared/emergency/emergencyCore.ts (SAFETY_LINES). A drift test keeps this in sync.
 */
export const COVERED_HAZARDS: readonly Hazard[] = ['gas', 'smoke', 'electric', 'water'];

/** Locale bundles that exist under src/locales (en is the source language). */
export const SUPPORTED_LOCALES = ['es', 'fr', 'de', 'ja', 'zh', 'hi', 'ar', 'fa'] as const;
export const RTL_LOCALES: readonly string[] = ['ar', 'fa'];

export interface TradeCandidate {
  /** snake_case; becomes TradeSlug, the pack id, and must equal the onboarding industry value. */
  slug: string;
  name: string;
  hazards: Hazard[];
  /** Licensing, permits or certification apply in at least one target market. */
  regulatedWork: boolean;
  /** Technicians handle regulated products (refrigerants, pesticides, chemicals) that need a ledger. */
  usesRegulatedProducts: boolean;
  /** Maintenance contracts / memberships / recurring visits are part of the business model. */
  recurringContracts: boolean;
  /** ISO 3166 region codes, e.g. "US", "US-TX", "DE". */
  markets: string[];
  /** Locale codes beyond English that the trade must ship in. */
  languages: string[];
  /** Outcomes of this trade should feed the cross-tenant Outcome Intelligence Network. */
  joinsOutcomeNetwork: boolean;
  /** The launch needs a new database table (as opposed to reusing the trade_playbook_* tables). */
  needsNewTables: boolean;
}

export const SLUG_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MARKET_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

export function validateCandidate(c: TradeCandidate): string[] {
  const errors: string[] = [];
  if (!SLUG_RE.test(c.slug)) errors.push(`slug "${c.slug}" must match ${SLUG_RE.source} (snake_case; it is also the pack id)`);
  if (c.name.trim() === '' || c.name.length > 60) errors.push('name must be 1-60 characters');
  if (TRADE_PLAYBOOKS.some((p) => p.slug === c.slug)) errors.push(`slug "${c.slug}" already has a playbook; extend it and bump catalogVersion instead`);
  for (const h of c.hazards) if (!(HAZARDS as readonly string[]).includes(h)) errors.push(`unknown hazard "${h}" (allowed: ${HAZARDS.join(', ')})`);
  if (new Set(c.hazards).size !== c.hazards.length) errors.push('hazards contains duplicates');
  for (const m of c.markets) if (!MARKET_RE.test(m)) errors.push(`market "${m}" is not an ISO region code like US or US-TX`);
  if (c.markets.length === 0) errors.push('at least one target market is required');
  for (const l of c.languages) if (!(SUPPORTED_LOCALES as readonly string[]).includes(l)) errors.push(`language "${l}" has no locale bundle (supported: ${SUPPORTED_LOCALES.join(', ')})`);
  if (new Set(c.languages).size !== c.languages.length) errors.push('languages contains duplicates');
  return errors;
}

// ============================================================
// TOUCHPOINTS
// ============================================================

export const CHECKLIST_AREAS = ['scope', 'price_book', 'intents', 'safety', 'compliance', 'localization', 'data_model', 'entry_points', 'quality', 'release'] as const;
export type ChecklistArea = (typeof CHECKLIST_AREAS)[number];

export const AREA_TITLES: Record<ChecklistArea, string> = {
  scope: '1. Scope and mechanism',
  price_book: '2. Price book',
  intents: '3. Intents and matching',
  safety: '4. Safety content',
  compliance: '5. Compliance',
  localization: '6. Localization',
  data_model: '7. Data model',
  entry_points: '8. Entry points and go-to-market',
  quality: '9. Quality and verification',
  release: '10. Release',
};

export type Tag = 'COUNSEL' | 'VERIFY';
export type WorkKind = 'code' | 'sql' | 'content' | 'config' | 'human';

/** A claim about the repository. `contains` must be present in `file`; `absent` must NOT be. */
export interface Evidence {
  file: string;
  contains?: string;
  absent?: string;
}

export interface Touchpoint {
  id: string;
  area: ChecklistArea;
  title: string;
  action: string;
  kind: WorkKind;
  /** Launch must not proceed while this is open. */
  blocking: boolean;
  tags: Tag[];
  files: string[];
  evidence: Evidence[];
  /** Human-readable condition shown in the checklist; omitted when it always applies. */
  appliesWhen?: string;
  applies?: (c: TradeCandidate) => boolean;
}

const uncoveredHazards = (c: TradeCandidate): Hazard[] => c.hazards.filter((h) => !COVERED_HAZARDS.includes(h));
const hasLanguages = (c: TradeCandidate): boolean => c.languages.length > 0;
const nonUs = (c: TradeCandidate): boolean => c.markets.some((m) => !m.startsWith('US'));

export const TOUCHPOINTS: readonly Touchpoint[] = [
  // ---------------------------------------------------------- scope
  {
    id: 'S1', area: 'scope', kind: 'human', blocking: true, tags: [],
    title: 'Choose the mechanism',
    action: 'Operating knowledge (job types, price seeds, triage, dispatch rules) goes in tradePlaybookCatalog.ts. Regulated-product ledgers and compliance log types are the older Trade Pack framework (src/lib/tradePacks). Recurring-contract trades with their own tables (landscaping) are gated packs. Seasonal/weather campaigns in supabase/functions/_shared/playbooks are NOT trades. Record the choice and why.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/tradePacks/index.ts', 'docs/PACK_AUTHORING.md'],
    evidence: [
      { file: 'src/lib/tradePlaybookCatalog.ts', contains: 'export const TRADE_PLAYBOOKS' },
      { file: 'src/lib/tradePacks/index.ts', contains: 'GATED_TRADE_PACKS' },
      { file: 'docs/PACK_AUTHORING.md', contains: 'A new trade is a new manifest' },
    ],
  },
  {
    id: 'S2', area: 'scope', kind: 'code', blocking: true, tags: [],
    title: 'Pick a slug that is valid everywhere it is reused',
    action: 'The slug is the TradeSlug, the baseline pack id (^[a-z][a-z0-9_]{1,40}$, so no hyphens), the playbook_slug stored per tenant, AND the onboarding industry value (TradePlaybooksPage preselects by primary_industry === slug). Reuse the key already used in talentNetwork.ts TRADES when one exists.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/talentNetwork.ts', 'src/pages/TradePlaybooksPage.tsx'],
    evidence: [
      { file: 'docs/PACK_AUTHORING.md', contains: '^[a-z][a-z0-9_]{1,40}$' },
      { file: 'src/lib/talentNetwork.ts', contains: "['garage_door'" },
      { file: 'src/pages/TradePlaybooksPage.tsx', contains: 'p.slug === state?.primaryIndustry' },
    ],
  },
  {
    id: 'S3', area: 'scope', kind: 'human', blocking: true, tags: ['VERIFY'],
    title: 'Record demand and the owner',
    action: 'Write down who asked for this trade, how many prospects or tenants it unlocks, and who owns the content after launch. The repository contains no demand data, so nothing may be assumed.',
    files: ['docs/OWNERS.md'], evidence: [{ file: 'docs/OWNERS.md' }],
  },
  {
    id: 'S4', area: 'scope', kind: 'human', blocking: false, tags: [],
    title: 'Buy / build / partner check for any new external dependency',
    action: 'If the trade needs a new vendor (parts data, a regulated-product database, a licensing API), score it with the build-buy-partner policy and add a vendor-exit page before integrating.',
    files: ['docs/governance/build-buy-partner.md', 'docs/vendor-exit/README.md'],
    evidence: [{ file: 'docs/governance/build-buy-partner.md', contains: 'Scoring sheet' }, { file: 'docs/vendor-exit/README.md', contains: 'Adding a provider' }],
  },

  // ---------------------------------------------------------- price book
  {
    id: 'P1', area: 'price_book', kind: 'content', blocking: true, tags: ['VERIFY'],
    title: 'Define 3+ job types with stable keys',
    action: 'Add the slug to the TradeSlug union and append the playbook at the END of TRADE_PLAYBOOKS (array order decides cross-trade matching, see I1). Each job type needs key (kebab-case, unique after hyphens become underscores in the baseline pack), label, benchmark, checklist and one PriceSeed. Every number is a placeholder until a working owner of the trade confirms it; the catalog stores no source attribution, so keep sources in the pull request.',
    files: ['src/lib/tradePlaybookCatalog.ts'],
    evidence: [
      { file: 'src/lib/tradePlaybookCatalog.ts', contains: 'export interface TradeJobType' },
      { file: 'src/lib/tradePlaybookCatalog.ts', contains: 'export type TradeSlug' },
      { file: 'src/lib/packs/baseline.ts', contains: "replace(/[^a-z0-9]+/g, '_')" },
    ],
  },
  {
    id: 'P2', area: 'price_book', kind: 'content', blocking: true, tags: ['VERIFY'],
    title: 'Price seeds: integer cents, cost basis, margin that matches the benchmark',
    action: 'priceCents/priceMaxCents/estimatedCostCents are integer cents in the USD-like baseline. The install rounds scaled prices to whole dollars and skips services the tenant already has (case-insensitive name). Check that margin at the lowest price is within a few points of benchmark.targetMarginPct.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/tradePlaybooks.ts'],
    evidence: [
      { file: 'src/lib/tradePlaybooks.ts', contains: 'Math.round((cents * mult) / 100) * 100' },
      { file: 'src/lib/tradePlaybooks.ts', contains: 'havePrice' },
    ],
  },
  {
    id: 'P3', area: 'price_book', kind: 'content', blocking: true, tags: [],
    title: 'Keywords the AI uses to quote',
    action: 'price.keywords feed lookup_price on live calls. Write what customers actually say, 3+ per service, no overlap with another trade unless intended.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/tradePlaybooks.ts'],
    evidence: [{ file: 'src/lib/tradePlaybooks.ts', contains: 'keywords: jt.price.keywords' }],
  },
  {
    id: 'P4', area: 'price_book', kind: 'code', blocking: false, tags: [],
    title: 'Baseline pack is derived automatically; confirm the mirror test covers it',
    action: 'BASELINE_PACKS is TRADE_PLAYBOOKS.map(playbookToPack) at version `${catalogVersion}.0.0`. No manifest to write; the mirror test in src/lib/packs/packs.test.ts iterates every playbook. Staff still publish the pack version and grant packs:<slug>.',
    files: ['src/lib/packs/baseline.ts', 'src/lib/packs/packs.test.ts'],
    evidence: [
      { file: 'src/lib/packs/baseline.ts', contains: 'TRADE_PLAYBOOKS.map(playbookToPack)' },
      { file: 'src/lib/packs/packs.test.ts', contains: 'mirrors the playbook catalog exactly' },
    ],
  },
  {
    id: 'P5', area: 'price_book', kind: 'human', blocking: true, tags: ['VERIFY'],
    title: 'Currency and unit decision for non-US markets',
    action: 'The catalog is a USD-like baseline with imperial examples. Decide per market: convert, ship a separate seed set, or do not ship the price book there. Run lint:regional.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'scripts/check-regional-assumptions.mjs'],
    evidence: [{ file: 'src/lib/tradePlaybookCatalog.ts', contains: 'USD-like baseline' }, { file: 'package.json', contains: '"lint:regional"' }],
    appliesWhen: 'a target market outside the US', applies: nonUs,
  },

  // ---------------------------------------------------------- intents
  {
    id: 'I1', area: 'intents', kind: 'content', blocking: true, tags: [],
    title: 'Job-type match fragments',
    action: 'job type `match` fragments are lower-case substrings of jobs.service_type; longest wins inside a playbook, but across playbooks the FIRST playbook in TRADE_PLAYBOOKS wins (firstTimeFixAutopilot.findJobType). Avoid generic fragments, pad short tokens with spaces (" ac "), and keep fragments distinct from every existing trade.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/firstTimeFixAutopilot.ts'],
    evidence: [
      { file: 'src/lib/tradePlaybookCatalog.ts', contains: 'Longest matching fragment' },
      { file: 'src/lib/firstTimeFixAutopilot.ts', contains: 'for (const pb of TRADE_PLAYBOOKS)' },
    ],
  },
  {
    id: 'I2', area: 'intents', kind: 'human', blocking: true, tags: [],
    title: 'Run the seven caller scenarios for this trade',
    action: 'emergency, after_hours, new_inquiry, price_quote, reschedule_cancel, existing_customer and complaint are generic, so they need no code. Script one realistic call per scenario in the call-script simulator with trade vocabulary and record the results.',
    files: ['supabase/functions/_shared/call-scripts/logic.ts'],
    evidence: [{ file: 'supabase/functions/_shared/call-scripts/logic.ts', contains: "key: 'price_quote'" }],
  },
  {
    id: 'I3', area: 'intents', kind: 'code', blocking: false, tags: [],
    title: 'Technician simulator trade mapping',
    action: 'tradeForServiceType and SimTrade list four trades (hvac, plumbing, electrical, appliance). A new trade returns null there. Decide whether to extend the type, the Edge Function mirror and the tests, or to document the gap.',
    files: ['src/lib/technicianSimulator.ts'],
    evidence: [{ file: 'src/lib/technicianSimulator.ts', contains: "export type SimTrade = 'hvac' | 'plumbing' | 'electrical' | 'appliance'" }],
  },
  {
    id: 'I4', area: 'intents', kind: 'code', blocking: false, tags: [],
    title: 'Service-intelligence loop comes from the catalog',
    action: 'serviceIntelligenceLoop builds its vocabulary from TRADE_PLAYBOOKS (playbook -> job type -> cause keys), so cause keys are permanent identifiers: once tenants record outcomes, renaming a key splits history. Choose them as final.',
    files: ['src/lib/serviceIntelligenceLoop.ts'],
    evidence: [{ file: 'src/lib/serviceIntelligenceLoop.ts', contains: 'import { TRADE_PLAYBOOKS }' }],
  },

  // ---------------------------------------------------------- safety
  {
    id: 'F1', area: 'safety', kind: 'content', blocking: true, tags: ['VERIFY'],
    title: 'Triage safety line and root causes for every diagnosable job type',
    action: 'troubleshooting needs symptom, a safety sentence, 3+ causes (at least one "common": the AI article summary lists common causes) and a test, fix and parts list for each. A technician must review each line; the article is published to the AI receptionist and says not to promise a diagnosis by phone.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/tradePlaybooks.ts'],
    evidence: [{ file: 'src/lib/tradePlaybooks.ts', contains: 'do not promise a diagnosis' }],
  },
  {
    id: 'F2', area: 'safety', kind: 'content', blocking: true, tags: [],
    title: 'Mark the checklist items that are safety or callback critical',
    action: 'Set critical on isolation/lock-out, test-before-touch and commissioning steps. Critical items drive the learning loop (checklist_critical suggestions) and the baseline pack forms.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/outcomeLearning.ts'],
    evidence: [{ file: 'src/lib/outcomeLearning.ts', contains: "'checklist_critical'" }],
    appliesWhen: 'the trade has at least one hazard', applies: (c) => c.hazards.length > 0,
  },
  {
    id: 'F3', area: 'safety', kind: 'content', blocking: true, tags: ['VERIFY'],
    title: 'Dispatch urgency rules',
    action: 'dispatchNotes become a published AI article ("Dispatch urgency rules"). Cover each hazard: what the caller must do first, then the dispatch priority. Never ask the AI to diagnose.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/tradePlaybooks.ts'],
    evidence: [{ file: 'src/lib/tradePlaybooks.ts', contains: 'Dispatch urgency rules' }],
  },
  {
    id: 'F4', area: 'safety', kind: 'code', blocking: true, tags: ['COUNSEL'],
    title: 'Emergency fast-path vocabulary',
    action: 'detectEmergencyText is a fixed regex list (gas, CO, fire, flood, shock, trapped, plus Spanish). A hazard or phrase it misses is a false negative. Add the trade’s life-safety phrases and tests; a false positive only costs a phone call.',
    files: ['supabase/functions/_shared/voice-resilience/emergencyFastPath.ts'],
    evidence: [{ file: 'supabase/functions/_shared/voice-resilience/emergencyFastPath.ts', contains: 'const LIFE_SAFETY' }],
    appliesWhen: 'the trade has at least one hazard', applies: (c) => c.hazards.length > 0,
  },
  {
    id: 'F5', area: 'safety', kind: 'code', blocking: true, tags: ['COUNSEL'],
    title: 'Fixed safety lines for hazard classes that have none',
    action: 'Life-safety instructions are fixed templates, never model-generated (SAFETY_LINES / SAFETY_ORDER in emergencyCore.ts; only gas, smoke, electric, water exist). Each new hazard needs a reviewed line and tests. Do not ship a trade with an uncovered hazard unless the caller path is explicitly "end the call and direct to emergency services".',
    files: ['supabase/functions/_shared/emergency/emergencyCore.ts', 'supabase/functions/_shared/emergency/emergencyCore.test.ts'],
    evidence: [{ file: 'supabase/functions/_shared/emergency/emergencyCore.ts', contains: 'const SAFETY_LINES' }],
    appliesWhen: 'a hazard class other than gas, smoke, electric or water', applies: (c) => uncoveredHazards(c).length > 0,
  },
  {
    id: 'F6', area: 'safety', kind: 'sql', blocking: true, tags: [],
    title: 'Emergency network trade enumerations',
    action: 'emergencyCore Trade, EmergencyTrade, skillMarket TRADE_OPTIONS and the emergency-network CHECK on required_trade accept hvac, plumbing, electrical, roofing, restoration, locksmith, general. Map the new trade to "general" (no change) or extend all four together with an idempotent migration.',
    files: ['supabase/functions/_shared/emergency/emergencyCore.ts', 'src/lib/emergencyNetwork.ts', 'src/lib/skillMarket.ts', 'supabase/migrations/20270111000000_autonomous_emergency_network.sql'],
    evidence: [
      { file: 'supabase/migrations/20270111000000_autonomous_emergency_network.sql', contains: "required_trade IN ('hvac', 'plumbing', 'electrical', 'roofing', 'restoration', 'locksmith', 'general')" },
      { file: 'src/lib/emergencyNetwork.ts', contains: "'locksmith' | 'general'" },
    ],
  },

  // ---------------------------------------------------------- compliance
  {
    id: 'C1', area: 'compliance', kind: 'human', blocking: true, tags: ['COUNSEL', 'VERIFY'],
    title: 'Licensing, permit and certification rules per market',
    action: 'The compliance rule seeds cover US federal plus five states and are all "in_review" until counsel approves them. Do not state any licensing, permit or certification requirement in playbook text or marketing until counsel has confirmed it for that market.',
    files: ['supabase/functions/_shared/compliance-rules/seedRules.ts'],
    evidence: [{ file: 'supabase/functions/_shared/compliance-rules/seedRules.ts', contains: 'in_review' }],
    appliesWhen: 'regulated work (licensing, permits, certification)', applies: (c) => c.regulatedWork,
  },
  {
    id: 'C2', area: 'compliance', kind: 'code', blocking: true, tags: ['COUNSEL'],
    title: 'Regulated-product register',
    action: 'Refrigerants, pesticides and similar need a usage ledger. The playbook catalog has none; that is the legacy Trade Pack framework (regulated-product register + compliance log types). Build it there, not in the catalog.',
    files: ['src/lib/tradePacks/types.ts', 'src/lib/tradePacks/pestControl.ts'],
    evidence: [{ file: 'src/lib/tradePacks/types.ts', contains: 'regulated-product register' }],
    appliesWhen: 'technicians handle regulated products', applies: (c) => c.usesRegulatedProducts,
  },
  {
    id: 'C3', area: 'compliance', kind: 'config', blocking: false, tags: [],
    title: 'Membership and recurring-visit workflows',
    action: 'Pick workflowSlugs from WORKFLOW_PLAYBOOKS (membership-welcome, membership-visit-reminder, ...). Auto-renewal and recurring-charge terms are consumer-protection territory.',
    files: ['src/lib/workflowPlaybooks.ts'],
    evidence: [{ file: 'src/lib/workflowPlaybooks.ts', contains: "slug: 'membership-welcome'" }],
    appliesWhen: 'recurring contracts or memberships', applies: (c) => c.recurringContracts,
  },
  {
    id: 'C4', area: 'compliance', kind: 'human', blocking: true, tags: ['COUNSEL'],
    title: 'Recording consent and AI disclosure for each market and language',
    action: 'Review the voice consent and AI-disclosure wording for every new market/language. Keys must be recorded under a named native reviewer before the release strictness check passes.',
    files: ['docs/compliance/voice-consent-and-ai-disclosure.md', 'docs/i18n/reviewed-keys.json'],
    evidence: [{ file: 'docs/compliance/voice-consent-and-ai-disclosure.md' }, { file: 'docs/i18n/launch-checklist.md', contains: 'i18n:coverage:release' }],
    appliesWhen: 'a non-English language or a market outside the US', applies: (c) => hasLanguages(c) || nonUs(c),
  },
  {
    id: 'C5', area: 'compliance', kind: 'human', blocking: true, tags: ['COUNSEL', 'VERIFY'],
    title: 'Public claims for the new trade',
    action: 'Any website, blog or sales claim about the trade (savings, response times, "licensed", "certified") must go through the public claims inventory and scripts/check-claims.mjs. Mark unverified statements [VERIFY].',
    files: ['docs/compliance/PUBLIC_CLAIMS_INVENTORY.md', 'scripts/check-claims.mjs'],
    evidence: [{ file: 'scripts/check-claims.mjs' }, { file: 'docs/compliance/PUBLIC_CLAIMS_INVENTORY.md' }],
  },
  {
    id: 'C6', area: 'compliance', kind: 'human', blocking: true, tags: ['COUNSEL'],
    title: 'Cross-tenant sharing consent',
    action: 'Outcome network contribution is opt-in with a recorded consent timestamp, and published cells need 5+ tenants and 10+ matured cases. Confirm the consent text covers the new trade and that nothing trade-specific lets a tenant be identified.',
    files: ['src/lib/outcomeNetwork.ts', 'docs/compliance/cross-tenant-data-flows.md'],
    evidence: [{ file: 'src/lib/outcomeNetwork.ts', contains: 'MIN_CONTRIBUTORS = 5' }, { file: 'src/lib/outcomeNetwork.ts', contains: 'consented_at' }],
    appliesWhen: 'outcomes feed the Outcome Intelligence Network', applies: (c) => c.joinsOutcomeNetwork,
  },
  {
    id: 'C7', area: 'compliance', kind: 'config', blocking: true, tags: [],
    title: 'Erasure coverage for new tables',
    action: 'Register every new tenant table in docs/compliance/erasure-coverage-baseline.json and the data map.',
    files: ['docs/compliance/erasure-coverage-baseline.json', 'docs/compliance/data-map.md'],
    evidence: [{ file: 'docs/compliance/erasure-coverage-baseline.json', contains: 'trade_playbook' }],
    appliesWhen: 'a new database table', applies: (c) => c.needsNewTables,
  },

  // ---------------------------------------------------------- localization
  {
    id: 'L1', area: 'localization', kind: 'human', blocking: true, tags: [],
    title: 'Decide how playbook content is localized',
    action: 'Catalog text (labels, triage, dispatch notes) is English-only data and TradePlaybooksPage renders it, and its toasts, without i18n (no useTranslation). Either ship English-only for this trade and say so in the release notes, or add a content-localization mechanism first. Do not machine-translate safety text.',
    files: ['src/pages/TradePlaybooksPage.tsx', 'src/lib/tradePlaybookCatalog.ts'],
    evidence: [{ file: 'src/pages/TradePlaybooksPage.tsx', absent: 'useTranslation' }],
    appliesWhen: 'a non-English language', applies: hasLanguages,
  },
  {
    id: 'L2', area: 'localization', kind: 'code', blocking: true, tags: [],
    title: 'UI strings through i18n, RTL checked',
    action: 'Any new UI text goes into src/locales/<lang>/*.json for en, es, fr, de, ja, zh, hi, ar, fa. ar and fa are right-to-left. Run i18n:keys and i18n:coverage.',
    files: ['src/locales/en/dashboard.json', 'scripts/i18n-missing-keys.mjs'],
    evidence: [{ file: 'package.json', contains: '"i18n:coverage"' }, { file: 'src/locales/en/dashboard.json', contains: '"trade_playbooks"' }],
    appliesWhen: 'new UI strings or any non-English language', applies: (c) => hasLanguages(c) || c.needsNewTables,
  },
  {
    id: 'L3', area: 'localization', kind: 'human', blocking: true, tags: ['COUNSEL'],
    title: 'Native review of emergency, consent and AI-disclosure keys',
    action: 'Follow docs/i18n/launch-checklist.md: native reviewer name and date, i18n:coverage:release, pseudo-localization, PDF fonts.',
    files: ['docs/i18n/launch-checklist.md', 'docs/i18n/reviewed-keys.json'],
    evidence: [{ file: 'docs/i18n/launch-checklist.md', contains: 'Native reviewer' }],
    appliesWhen: 'a non-English language', applies: hasLanguages,
  },
  {
    id: 'L4', area: 'localization', kind: 'content', blocking: false, tags: [],
    title: 'Trade glossary',
    action: 'Add the trade’s terms to the i18n glossary so translators use one word per concept.',
    files: ['docs/i18n/glossary.json'], evidence: [{ file: 'docs/i18n/glossary.json' }],
    appliesWhen: 'a non-English language', applies: hasLanguages,
  },
  {
    id: 'L5', area: 'localization', kind: 'code', blocking: true, tags: ['COUNSEL'],
    title: 'Emergency phrases and voice per language',
    action: 'The fast-path regexes cover English and Spanish only. For every other language add native life-safety phrases with tests, and check ASR/TTS voice and persona for that language before enabling the trade there.',
    files: ['supabase/functions/_shared/voice-resilience/emergencyFastPath.ts', 'docs/VOICE_PERSONA_BIBLE.md'],
    evidence: [{ file: 'supabase/functions/_shared/voice-resilience/emergencyFastPath.ts', contains: '// Spanish' }],
    appliesWhen: 'a language other than English or Spanish', applies: (c) => c.languages.some((l) => l !== 'es'),
  },

  // ---------------------------------------------------------- data model
  {
    id: 'D1', area: 'data_model', kind: 'sql', blocking: false, tags: [],
    title: 'Install, outcomes, tuning and suggestions need no migration',
    action: 'trade_playbook_installs, job_outcomes, trade_playbook_tuning and playbook_learning_suggestions store playbook_slug as free text with no CHECK on its value, and are RLS-scoped by get_account_owner_id(). A new playbook works without SQL.',
    files: ['supabase/migrations/20261126000000_trade_playbooks_outcome_learning.sql'],
    evidence: [
      { file: 'supabase/migrations/20261126000000_trade_playbooks_outcome_learning.sql', contains: 'playbook_slug text NOT NULL' },
      { file: 'supabase/migrations/20261126000000_trade_playbooks_outcome_learning.sql', contains: 'get_account_owner_id()' },
    ],
  },
  {
    id: 'D2', area: 'data_model', kind: 'sql', blocking: true, tags: ['COUNSEL'],
    title: 'Outcome Intelligence Network is locked to three trades',
    action: 'The network CHECKs and RPC guards accept only hvac, plumbing, electrical, and tradeFromIndustry() returns "other" for everything else. To join, ship an idempotent migration (CHECKs, RPC guard, taxonomy seeds for symptom / failure_mode / action / part) plus tradeFromIndustry and OinTrade changes, with pgTAP tests. Otherwise state explicitly that the trade does not contribute.',
    files: ['supabase/migrations/20270205000000_outcome_intelligence_network.sql', 'src/lib/outcomeNetwork.ts'],
    evidence: [
      { file: 'supabase/migrations/20270205000000_outcome_intelligence_network.sql', contains: "trade text NOT NULL CHECK (trade IN ('hvac', 'plumbing', 'electrical'))" },
      { file: 'src/lib/outcomeNetwork.ts', contains: "export type OinTrade = 'hvac' | 'plumbing' | 'electrical'" },
    ],
    appliesWhen: 'outcomes feed the Outcome Intelligence Network', applies: (c) => c.joinsOutcomeNetwork,
  },
  {
    id: 'D3', area: 'data_model', kind: 'sql', blocking: true, tags: [],
    title: 'New tables: idempotent migration, RLS, pgTAP',
    action: 'Follow the repo pattern: IF NOT EXISTS, RLS with user_id = public.get_account_owner_id(), npm run lint:migrations, a pgTAP file under supabase/tests/database, and a rollback note in the header comment.',
    files: ['supabase/tests/database', 'scripts/lint-migrations.mjs'],
    evidence: [{ file: 'package.json', contains: '"lint:migrations"' }],
    appliesWhen: 'a new database table', applies: (c) => c.needsNewTables,
  },
  {
    id: 'D4', area: 'data_model', kind: 'config', blocking: true, tags: [],
    title: 'Publish the baseline pack and gate the rollout',
    action: 'Staff publish pack versions in ascending order (immutable afterwards), grant the entitlement packs:<slug>, and enable the trade_pack_framework flag per tenant or rollout percentage.',
    files: ['docs/PACK_AUTHORING.md'],
    evidence: [{ file: 'docs/PACK_AUTHORING.md', contains: 'trade_pack_framework' }, { file: 'src/lib/packs/registry.ts', contains: "PACK_ENTITLEMENT_PREFIX = 'packs:'" }],
  },

  // ---------------------------------------------------------- entry points
  {
    id: 'E1', area: 'entry_points', kind: 'code', blocking: true, tags: [],
    title: 'Onboarding and signup values',
    action: 'Add the industry value in five places that must agree: INDUSTRY_OPTIONS (onboarding/types.ts), QUALIFICATION_QUESTIONS (signupQualificationCore.ts), the CHECK in the signup_qualification migration (new idempotent migration that replaces it), SUPPORTED_TRADES (onboardingTradeDefaults.ts, a hard-coded list: tradeSlugFor() returns null for anything not in it, so onboarding shows no preview) and, for the Outcome Network, tradeFromIndustry. An industry value with no playbook (roofing today) makes TradePlaybooksPage preselect the first playbook (HVAC).',
    files: ['src/pages/onboarding/types.ts', 'src/lib/signupQualificationCore.ts', 'src/lib/onboardingTradeDefaults.ts', 'supabase/migrations/20290306000000_signup_qualification.sql'],
    evidence: [
      { file: 'src/pages/onboarding/types.ts', contains: 'export const INDUSTRY_OPTIONS' },
      { file: 'src/lib/signupQualificationCore.ts', contains: "id: 'trade'" },
      { file: 'src/lib/onboardingTradeDefaults.ts', contains: 'export const SUPPORTED_TRADES' },
      { file: 'supabase/migrations/20290306000000_signup_qualification.sql', contains: "CHECK (trade IN ('hvac','plumbing','electrical','roofing','general_home_services','other'))" },
    ],
  },
  {
    id: 'E2', area: 'entry_points', kind: 'human', blocking: true, tags: [],
    title: 'Trade Playbooks page lists it automatically; verify it end to end',
    action: 'The page maps TRADE_PLAYBOOKS, so no page edit is needed. Install on a staging tenant, install again (must add nothing), record an outcome, and confirm loading, empty and error states. The page has no uninstall: removing a playbook from the array hides it but leaves tenant rows.',
    files: ['src/pages/TradePlaybooksPage.tsx'],
    evidence: [
      { file: 'src/pages/TradePlaybooksPage.tsx', contains: 'TRADE_PLAYBOOKS.map(' },
      { file: 'src/lib/tradePlaybooks.ts', absent: 'uninstall' },
    ],
  },
  {
    id: 'E3', area: 'entry_points', kind: 'content', blocking: false, tags: ['VERIFY'],
    title: 'Marketing surface',
    action: 'Customer-story trade filter, blog roadmap and landing copy for the trade. Write original, specific, sourced content; no invented testimonials or statistics.',
    files: ['src/lib/customerStories.ts', 'BLOG_ROADMAP.md', 'content/blog'],
    evidence: [{ file: 'src/lib/customerStories.ts', contains: "slug: 'hvac'" }, { file: 'BLOG_ROADMAP.md' }],
  },

  // ---------------------------------------------------------- quality
  {
    id: 'Q1', area: 'quality', kind: 'code', blocking: true, tags: [],
    title: 'Draft playbook lints clean',
    action: 'Run `npm run product:new-trade -- <input.json> --verify-evidence --check` (input.json holds the candidate and the draft playbook). Zero errors; every warning explained in the pull request.',
    files: ['src/lib/newTradeChecklist.ts', 'scripts/product/new-trade-checklist.mjs'],
    evidence: [{ file: 'src/lib/newTradeChecklist.ts', contains: 'export function lintPlaybookDraft' }],
  },
  {
    id: 'Q2', area: 'quality', kind: 'human', blocking: true, tags: ['VERIFY'],
    title: 'Domain review by a working practitioner',
    action: 'A licensed or experienced technician of the trade reads every cause, test, fix, part, safety line and price, and signs the pull request. The model and the linter cannot do this.',
    files: [], evidence: [],
  },
  {
    id: 'Q3', area: 'quality', kind: 'code', blocking: true, tags: [],
    title: 'Automated checks',
    action: 'npx vitest run src/lib/packs src/lib/newTradeChecklist.test.ts src/lib/outcomeLearning.test.ts src/lib/serviceIntelligenceLoop.test.ts · npm run typecheck · npm run lint · npm run lint:migrations (if SQL) · npm run i18n:coverage (if strings).',
    files: ['package.json'],
    evidence: [{ file: 'package.json', contains: '"typecheck"' }, { file: 'package.json', contains: '"lint:migrations"' }],
  },
  {
    id: 'Q4', area: 'quality', kind: 'human', blocking: false, tags: [],
    title: 'Shadow-mode pilot with 1-3 friendly tenants',
    action: 'Run the trade in shadow mode first and review the AI’s triage answers before it speaks to real customers.',
    files: ['docs/SHADOW_MODE.md'], evidence: [{ file: 'docs/SHADOW_MODE.md' }],
  },

  // ---------------------------------------------------------- release
  {
    id: 'R1', area: 'release', kind: 'code', blocking: true, tags: [],
    title: 'catalogVersion rules',
    action: 'A new playbook ships at catalogVersion 1 (pack 1.0.0). Any later content change bumps the version; the pack version follows automatically. Never edit a published pack version.',
    files: ['src/lib/tradePlaybookCatalog.ts', 'src/lib/packs/baseline.ts'],
    evidence: [{ file: 'src/lib/packs/baseline.ts', contains: '${pb.catalogVersion}.0.0' }],
  },
  {
    id: 'R2', area: 'release', kind: 'human', blocking: true, tags: [],
    title: 'Rollback plan',
    action: 'Catalog entries are additive and tenants own installed rows. Rollback = remove the entry from the array (hides the playbook) and turn the pack flag/entitlement off. Already-installed price rows and articles stay by design; say so in the release notes.',
    files: ['src/lib/tradePlaybooks.ts'], evidence: [{ file: 'src/lib/tradePlaybooks.ts', contains: 'never overwrites tenant-owned rows' }],
  },
  {
    id: 'R3', area: 'release', kind: 'human', blocking: false, tags: [],
    title: 'Docs and surface inventory',
    action: 'Update docs/product-surface.md if a page or table was added, link this checklist’s output from the pull request, and record the decision in the pull request description.',
    files: ['docs/product-surface.md'], evidence: [{ file: 'docs/product-surface.md', contains: 'TradePlaybooksPage' }],
  },
];

// ============================================================
// GENERATOR
// ============================================================

export interface ChecklistItem {
  id: string;
  area: ChecklistArea;
  title: string;
  action: string;
  kind: WorkKind;
  blocking: boolean;
  tags: Tag[];
  files: string[];
  /** Why this item applies; "always" when unconditional. */
  applicability: string;
}

export interface SkippedItem { id: string; title: string; reason: string }

export interface GeneratedChecklist {
  candidate: TradeCandidate;
  items: ChecklistItem[];
  skipped: SkippedItem[];
  counts: { total: number; blocking: number; counsel: number; verify: number };
}

export function generateChecklist(candidate: TradeCandidate): GeneratedChecklist {
  const errors = validateCandidate(candidate);
  if (errors.length > 0) throw new Error(`Invalid trade candidate:\n - ${errors.join('\n - ')}`);

  const items: ChecklistItem[] = [];
  const skipped: SkippedItem[] = [];
  for (const t of TOUCHPOINTS) {
    if (t.applies && !t.applies(candidate)) {
      skipped.push({ id: t.id, title: t.title, reason: `only when ${t.appliesWhen ?? 'a condition holds'}` });
      continue;
    }
    items.push({
      id: t.id, area: t.area, title: t.title, action: t.action, kind: t.kind, blocking: t.blocking,
      tags: [...t.tags], files: [...t.files], applicability: t.appliesWhen ? `because ${t.appliesWhen}` : 'always',
    });
  }
  const order = (a: ChecklistArea) => CHECKLIST_AREAS.indexOf(a);
  items.sort((a, b) => order(a.area) - order(b.area));
  return {
    candidate,
    items,
    skipped,
    counts: {
      total: items.length,
      blocking: items.filter((i) => i.blocking).length,
      counsel: items.filter((i) => i.tags.includes('COUNSEL')).length,
      verify: items.filter((i) => i.tags.includes('VERIFY')).length,
    },
  };
}

export function renderChecklistMarkdown(list: GeneratedChecklist): string {
  const c = list.candidate;
  const out: string[] = [];
  out.push(`# New trade checklist: ${c.name} (\`${c.slug}\`)`, '');
  out.push(`- Hazards: ${c.hazards.length ? c.hazards.join(', ') : 'none declared'}`);
  out.push(`- Markets: ${c.markets.join(', ')} · Languages beyond English: ${c.languages.length ? c.languages.join(', ') : 'none'}`);
  out.push(`- Regulated work: ${c.regulatedWork ? 'yes' : 'no'} · Regulated products: ${c.usesRegulatedProducts ? 'yes' : 'no'} · Recurring contracts: ${c.recurringContracts ? 'yes' : 'no'}`);
  out.push(`- Joins Outcome Network: ${c.joinsOutcomeNetwork ? 'yes' : 'no'} · New tables: ${c.needsNewTables ? 'yes' : 'no'}`);
  out.push(`- ${list.counts.total} items · ${list.counts.blocking} blocking · ${list.counts.counsel} need counsel [COUNSEL] · ${list.counts.verify} contain unverified facts [VERIFY]`, '');
  for (const area of CHECKLIST_AREAS) {
    const rows = list.items.filter((i) => i.area === area);
    if (rows.length === 0) continue;
    out.push(`## ${AREA_TITLES[area]}`, '');
    for (const i of rows) {
      const flags = [i.blocking ? 'BLOCKING' : 'advisory', ...i.tags.map((t) => `[${t}]`)].join(' ');
      out.push(`- [ ] **${i.id}** ${i.title} _(${flags}; ${i.kind}; ${i.applicability})_`);
      out.push(`  - ${i.action}`);
      if (i.files.length) out.push(`  - Files: ${i.files.map((f) => `\`${f}\``).join(', ')}`);
    }
    out.push('');
  }
  if (list.skipped.length) {
    out.push('## Not applicable for this candidate', '');
    for (const s of list.skipped) out.push(`- ${s.id} ${s.title} (${s.reason})`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * Verifies every touchpoint's evidence against the repository. `read` returns file text, or null if missing.
 * Returns a list of problems (empty = every claim still holds).
 */
export function checkEvidence(read: (path: string) => string | null, touchpoints: readonly Touchpoint[] = TOUCHPOINTS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const t of touchpoints) {
    if (ids.has(t.id)) problems.push(`${t.id}: duplicate touchpoint id`);
    ids.add(t.id);
    for (const e of t.evidence) {
      const text = read(e.file);
      if (text === null) { problems.push(`${t.id}: file not found: ${e.file}`); continue; }
      if (e.contains !== undefined && !text.includes(e.contains)) problems.push(`${t.id}: ${e.file} no longer contains ${JSON.stringify(e.contains)}`);
      if (e.absent !== undefined && text.includes(e.absent)) problems.push(`${t.id}: ${e.file} now contains ${JSON.stringify(e.absent)}; update this touchpoint`);
    }
    // Directories (e.g. content/blog) are fine: the caller's reader returns '' for them.
    for (const f of t.files) if (read(f) === null) problems.push(`${t.id}: listed file not found: ${f}`);
  }
  return problems;
}

// ============================================================
// DRAFT PLAYBOOK LINTER
// ============================================================

/** A playbook under construction: same shape as TradePlaybook but with a free-form slug. */
export type DraftPlaybook = Omit<TradePlaybook, 'slug'> & { slug: string };

export type Severity = 'error' | 'warning';
export interface Finding { severity: Severity; code: string; path: string; message: string }

export interface LintOptions {
  /** Playbooks the draft must not collide with. Defaults to the shipped catalog. */
  existing?: readonly DraftPlaybook[];
  /** Slugs from WORKFLOW_PLAYBOOKS. When omitted, workflow slugs are reported as unverified. */
  knownWorkflowSlugs?: readonly string[];
}

const KEY_RE = /^[a-z][a-z0-9-]*$/;
const PROMISE_RE = /\b(guarantee[sd]?|100\s?%|lifetime|risk[- ]free)\b/i;
const URGENCY_RE = /priority|emergency|urgent|same-day/i;

export function lintPlaybookDraft(draft: DraftPlaybook, options: LintOptions = {}): Finding[] {
  const f: Finding[] = [];
  const add = (severity: Severity, code: string, path: string, message: string) => f.push({ severity, code, path, message });
  const existing = options.existing ?? (TRADE_PLAYBOOKS as readonly DraftPlaybook[]);

  if (!SLUG_RE.test(draft.slug)) add('error', 'slug-format', 'slug', `"${draft.slug}" must match ${SLUG_RE.source}`);
  if (existing.some((p) => p.slug === draft.slug)) add('error', 'slug-taken', 'slug', `"${draft.slug}" already exists in the catalog`);
  if (draft.name.trim() === '') add('error', 'name-empty', 'name', 'name is empty');
  if (draft.tagline.trim() === '') add('error', 'tagline-empty', 'tagline', 'tagline is empty');
  if (!Number.isInteger(draft.catalogVersion) || draft.catalogVersion < 1) add('error', 'catalog-version', 'catalogVersion', 'must be a positive integer');

  if (draft.jobTypes.length < 3) add('error', 'job-types-min', 'jobTypes', `needs at least 3 job types (has ${draft.jobTypes.length})`);
  else if (draft.jobTypes.length < 4) add('warning', 'job-types-few', 'jobTypes', 'shipped trades have 4 or more job types');

  const jtKeys = new Set<string>();
  const packKeys = new Set<string>();
  const serviceNames = new Set<string>();
  let anyCritical = false;

  draft.jobTypes.forEach((jt, i) => {
    const p = `jobTypes[${i}](${jt.key})`;
    if (!KEY_RE.test(jt.key)) add('error', 'jobtype-key-format', p, `key must match ${KEY_RE.source}`);
    if (jtKeys.has(jt.key)) add('error', 'jobtype-key-dup', p, 'duplicate job type key');
    jtKeys.add(jt.key);
    const packKey = jt.key.replace(/[^a-z0-9]+/g, '_');
    if (packKeys.has(packKey)) add('error', 'jobtype-key-collision', p, `key collides after conversion to the pack key "${packKey}"`);
    packKeys.add(packKey);
    if (jt.label.trim() === '') add('error', 'label-empty', p, 'label is empty');

    // ---- match fragments
    if (jt.match.length === 0) add('error', 'match-empty', p, 'no match fragments: jobs of this type will never be recognised');
    for (const frag of jt.match) {
      if (frag !== frag.toLowerCase()) add('error', 'match-case', p, `fragment "${frag}" is not lower-case and can never match`);
      if (frag.trim().length < 3 && frag === frag.trim()) add('warning', 'match-short', p, `fragment "${frag}" is very short and will match inside other words; pad with spaces`);
      // firstTimeFixAutopilot.findJobType returns the FIRST playbook (array order) with any match, and a new
      // playbook is appended last. A draft fragment that equals or contains an existing fragment can therefore
      // never win: any service type containing it also matches the older trade first.
      for (const other of existing) {
        for (const oj of other.jobTypes) {
          for (const ef of oj.match) {
            if (ef.trim() === '') continue;
            if (frag === ef) add('error', 'match-collision', p, `fragment "${frag}" is identical to one in ${other.slug}/${oj.key}; ${other.slug} is earlier in TRADE_PLAYBOOKS and always wins`);
            else if (frag.includes(ef)) add('error', 'match-shadowed', p, `fragment "${frag}" contains "${ef}" from ${other.slug}/${oj.key}; ${other.slug} is earlier in TRADE_PLAYBOOKS and wins first`);
          }
        }
      }
    }

    // ---- checklist
    const ids = new Set<string>();
    for (const item of jt.checklist) {
      if (ids.has(item.id)) add('error', 'checklist-id-dup', p, `duplicate checklist id "${item.id}"`);
      ids.add(item.id);
      if (item.label.trim() === '') add('error', 'checklist-label-empty', p, `checklist item "${item.id}" has no label`);
      if (item.critical) anyCritical = true;
    }
    if (jt.checklist.length < 3) add('error', 'checklist-min', p, `needs at least 3 checklist items (has ${jt.checklist.length})`);
    else if (jt.checklist.length < 5) add('warning', 'checklist-few', p, 'shipped job types have 5 or more checklist items');
    if (jt.troubleshooting && !jt.checklist.some((x) => x.critical)) add('error', 'checklist-no-critical', p, 'a diagnosable job type needs at least one critical checklist item');

    // ---- troubleshooting
    const t = jt.troubleshooting;
    if (t) {
      if (t.symptom.trim() === '') add('error', 'symptom-empty', p, 'troubleshooting.symptom is empty');
      if (t.safety.trim() === '') add('error', 'safety-empty', p, 'troubleshooting.safety is empty');
      if (t.causes.length < 3) add('error', 'causes-min', p, `needs at least 3 root causes (has ${t.causes.length})`);
      if (!t.causes.some((c) => c.likelihood === 'common')) add('error', 'causes-no-common', p, 'at least one cause must be "common": the AI article summary lists common causes and would read "Common causes include ."');
      const ck = new Set<string>();
      t.causes.forEach((c, k) => {
        const cp = `${p}.causes[${k}](${c.key})`;
        if (!KEY_RE.test(c.key)) add('error', 'cause-key-format', cp, `key must match ${KEY_RE.source}`);
        if (ck.has(c.key)) add('error', 'cause-key-dup', cp, 'duplicate cause key');
        ck.add(c.key);
        if (c.label.trim() === '' || c.test.trim() === '' || c.fix.trim() === '') add('error', 'cause-incomplete', cp, 'label, test and fix are all required');
        if (PROMISE_RE.test(`${c.label} ${c.fix}`)) add('warning', 'promise-language', cp, 'avoid guarantee wording: the AI must not promise outcomes');
      });
    }

    // ---- benchmark
    const b = jt.benchmark;
    if (!(b.ticketMinCents >= 0 && b.ticketMaxCents >= b.ticketMinCents)) add('error', 'bench-ticket-order', p, 'ticketMaxCents must be >= ticketMinCents >= 0');
    if (!(b.durationMinutes > 0)) add('error', 'bench-duration', p, 'durationMinutes must be > 0');
    else if (b.durationMinutes > 720) add('warning', 'bench-duration-long', p, 'durations above 720 minutes are ignored by the first-time-fix prior');
    for (const [name, v] of [['firstTimeFixPct', b.firstTimeFixPct], ['maxCallbackPct', b.maxCallbackPct], ['targetMarginPct', b.targetMarginPct]] as const) {
      if (!(v >= 0 && v <= 100)) add('error', 'bench-pct', p, `${name} must be between 0 and 100`);
    }

    // ---- price seed
    const s = jt.price;
    const pp = `${p}.price`;
    if (s.serviceName.trim() === '' || s.category.trim() === '' || s.description.trim() === '') add('error', 'price-text-empty', pp, 'serviceName, category and description are required');
    const sn = s.serviceName.trim().toLowerCase();
    if (serviceNames.has(sn)) add('error', 'price-name-dup', pp, `duplicate service name "${s.serviceName}"`);
    serviceNames.add(sn);
    for (const other of existing) for (const oj of other.jobTypes) {
      if (oj.price.serviceName.trim().toLowerCase() === sn) add('error', 'price-name-taken', pp, `service name already used by ${other.slug}/${oj.key}`);
    }
    for (const [name, v] of [['priceCents', s.priceCents], ['estimatedCostCents', s.estimatedCostCents], ['priceMaxCents', s.priceMaxCents ?? 0]] as const) {
      if (!Number.isInteger(v) || v < 0) add('error', 'price-integer', pp, `${name} must be a non-negative integer number of cents`);
    }
    if (s.priceCents % 100 !== 0 || (s.priceMaxCents ?? 0) % 100 !== 0) add('warning', 'price-whole-dollar', pp, 'installs round to whole dollars, so cents will be dropped');
    if (s.pricingModel === 'range' && (s.priceMaxCents === undefined || s.priceMaxCents <= s.priceCents)) add('error', 'price-range', pp, 'a range price needs priceMaxCents greater than priceCents');
    if (s.pricingModel !== 'range' && s.priceMaxCents !== undefined) add('warning', 'price-max-unused', pp, 'priceMaxCents is only meaningful for the "range" model');
    if (s.estimatedCostCents >= s.priceCents && s.priceCents > 0) add('error', 'price-cost', pp, 'estimated cost is at or above the price: negative margin');
    else if (s.priceCents > 0) {
      const margin = ((s.priceCents - s.estimatedCostCents) / s.priceCents) * 100;
      if (margin < b.targetMarginPct - 5) add('warning', 'price-margin', pp, `margin at the lowest price is ${margin.toFixed(1)}% against a ${b.targetMarginPct}% target`);
    }
    const top = s.priceMaxCents ?? s.priceCents;
    if (s.priceCents > b.ticketMaxCents || top < b.ticketMinCents) add('warning', 'price-vs-ticket', pp, 'price range does not overlap the benchmark ticket range');
    // The tenant's service type usually equals the price-book service name, so it must resolve to THIS job type.
    const resolved = resolveJobType([...existing, draft], s.serviceName);
    if (!resolved) add('error', 'price-name-unmatched', pp, `service name "${s.serviceName}" matches no job type fragment`);
    else if (resolved.playbook.slug !== draft.slug) add('error', 'price-name-shadowed', pp, `service name "${s.serviceName}" resolves to ${resolved.playbook.slug}/${resolved.jobType.key} (earlier trade), not to this job type`);
    else if (resolved.jobType.key !== jt.key) add('error', 'price-name-misrouted', pp, `service name "${s.serviceName}" resolves to this trade's "${resolved.jobType.key}" job type instead`);
    if (s.keywords.length === 0) add('error', 'price-keywords-empty', pp, 'no keywords: the AI cannot find this service when quoting');
    else if (s.keywords.length < 3) add('warning', 'price-keywords-few', pp, 'add at least 3 keywords customers actually say');
    if (PROMISE_RE.test(`${s.description} ${jt.label}`)) add('warning', 'promise-language', pp, 'avoid guarantee wording in customer-facing text');
  });

  if (!anyCritical && draft.jobTypes.length > 0) add('warning', 'no-critical-anywhere', 'jobTypes', 'no checklist item is marked critical in any job type');

  // ---- dispatch notes
  if (draft.dispatchNotes.length === 0) add('error', 'dispatch-min', 'dispatchNotes', 'at least one dispatch rule is required');
  else {
    if (draft.dispatchNotes.length < 2) add('warning', 'dispatch-few', 'dispatchNotes', 'shipped trades have 3 rules');
    if (!draft.dispatchNotes.some((n) => URGENCY_RE.test(n))) add('warning', 'dispatch-no-urgency', 'dispatchNotes', 'no rule states a priority or emergency handling');
  }
  draft.dispatchNotes.forEach((n, i) => { if (n.trim() === '') add('error', 'dispatch-empty', `dispatchNotes[${i}]`, 'empty rule'); });

  // ---- workflows
  const known = options.knownWorkflowSlugs;
  if (draft.workflowSlugs.length === 0) add('warning', 'workflows-none', 'workflowSlugs', 'no workflow playbooks recommended');
  if (known === undefined) add('warning', 'workflows-unverified', 'workflowSlugs', 'workflow slugs were not checked against WORKFLOW_PLAYBOOKS');
  else for (const w of draft.workflowSlugs) if (!known.includes(w)) add('error', 'workflow-unknown', 'workflowSlugs', `"${w}" is not a slug in WORKFLOW_PLAYBOOKS`);
  if (new Set(draft.workflowSlugs).size !== draft.workflowSlugs.length) add('warning', 'workflows-dup', 'workflowSlugs', 'duplicate workflow slugs');

  return f;
}

/** Same first-playbook-wins rule as firstTimeFixAutopilot.findJobType, over any ordered list of playbooks. */
export function resolveJobType(playbooks: readonly DraftPlaybook[], serviceType: string): { playbook: DraftPlaybook; jobType: DraftPlaybook['jobTypes'][number] } | undefined {
  for (const playbook of playbooks) {
    // matchJobType only reads playbook.jobTypes[].match; the slug union is irrelevant to it.
    const jobType = matchJobType(playbook as TradePlaybook, serviceType);
    if (jobType) return { playbook, jobType };
  }
  return undefined;
}

export function summarizeFindings(findings: readonly Finding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((x) => x.severity === 'error').length,
    warnings: findings.filter((x) => x.severity === 'warning').length,
  };
}

// ============================================================
// INPUT PARSING (CLI / JSON boundary)
// ============================================================

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Structural validation of untrusted JSON into a TradeCandidate. Semantic checks stay in validateCandidate. */
export function parseCandidate(raw: unknown): { candidate?: TradeCandidate; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ['candidate must be a JSON object'] };
  for (const k of ['slug', 'name'] as const) if (typeof raw[k] !== 'string') errors.push(`candidate.${k} must be a string`);
  for (const k of ['hazards', 'markets', 'languages'] as const) if (!isStrArr(raw[k])) errors.push(`candidate.${k} must be an array of strings`);
  for (const k of ['regulatedWork', 'usesRegulatedProducts', 'recurringContracts', 'joinsOutcomeNetwork', 'needsNewTables'] as const) {
    if (typeof raw[k] !== 'boolean') errors.push(`candidate.${k} must be true or false`);
  }
  if (errors.length > 0) return { errors };
  const candidate = raw as unknown as TradeCandidate;
  return { candidate, errors: validateCandidate(candidate) };
}

/** Structural validation of untrusted JSON into a DraftPlaybook so the linter never throws on bad input. */
export function parseDraft(raw: unknown): { draft?: DraftPlaybook; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ['draft must be a JSON object'] };
  for (const k of ['slug', 'name', 'tagline'] as const) if (typeof raw[k] !== 'string') errors.push(`draft.${k} must be a string`);
  if (typeof raw.catalogVersion !== 'number') errors.push('draft.catalogVersion must be a number');
  if (!isStrArr(raw.dispatchNotes)) errors.push('draft.dispatchNotes must be an array of strings');
  if (!isStrArr(raw.workflowSlugs)) errors.push('draft.workflowSlugs must be an array of strings');
  if (!Array.isArray(raw.jobTypes)) errors.push('draft.jobTypes must be an array');
  else {
    raw.jobTypes.forEach((jt: unknown, i: number) => {
      const p = `draft.jobTypes[${i}]`;
      if (!isObj(jt)) { errors.push(`${p} must be an object`); return; }
      if (typeof jt.key !== 'string' || typeof jt.label !== 'string') errors.push(`${p}.key and .label must be strings`);
      if (!isStrArr(jt.match)) errors.push(`${p}.match must be an array of strings`);
      if (!Array.isArray(jt.checklist) || !jt.checklist.every((c: unknown) => isObj(c) && typeof c.id === 'string' && typeof c.label === 'string')) errors.push(`${p}.checklist must be an array of {id,label,critical?}`);
      if (!isObj(jt.benchmark) || !['ticketMinCents', 'ticketMaxCents', 'durationMinutes', 'firstTimeFixPct', 'maxCallbackPct', 'targetMarginPct'].every((k) => typeof (jt.benchmark as Record<string, unknown>)[k] === 'number')) errors.push(`${p}.benchmark must hold six numbers`);
      const pr = jt.price;
      if (!isObj(pr) || typeof pr.serviceName !== 'string' || typeof pr.category !== 'string' || typeof pr.description !== 'string' || typeof pr.pricingModel !== 'string' || typeof pr.priceCents !== 'number' || typeof pr.estimatedCostCents !== 'number' || !isStrArr(pr.keywords)) errors.push(`${p}.price is malformed`);
      const t = jt.troubleshooting;
      if (t !== undefined && (!isObj(t) || typeof t.symptom !== 'string' || typeof t.safety !== 'string' || !Array.isArray(t.causes) || !t.causes.every((c: unknown) => isObj(c) && ['key', 'label', 'test', 'fix'].every((k) => typeof c[k] === 'string') && typeof c.likelihood === 'string' && isStrArr(c.parts)))) errors.push(`${p}.troubleshooting is malformed`);
    });
  }
  if (errors.length > 0) return { errors };
  return { draft: raw as unknown as DraftPlaybook, errors: [] };
}

/** Extracts playbook slugs from workflowPlaybooks.ts source text (that module imports UI icons, so it cannot be loaded by a script). */
export function extractWorkflowSlugs(source: string): string[] {
  return [...source.matchAll(/^ {4}slug: '([a-z0-9-]+)',/gm)].map((m) => m[1]);
}
