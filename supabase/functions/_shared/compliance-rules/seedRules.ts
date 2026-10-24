// supabase/functions/_shared/compliance-rules/seedRules.ts
//
// STARTER CATALOG — drafted from general knowledge as a research starting
// point, NOT verified legal text. Every rule below is seeded as "in_review"
// and is never enforced until a staff reviewer confirms the source text with
// counsel and approves it. Citations are the ones most likely to need correction.
//
// Canonical source for supabase/migrations/20271110000100_compliance_rule_seed.sql
// (regenerate with: node --experimental-strip-types scripts/gen-compliance-seed.mjs).

import type { RuleKind, Severity, SourceRef, Surface } from "./types.ts";

export interface SeedRule {
  packSlug: string;
  packName: string;
  ruleKey: string;
  jurisdiction: string;
  kind: RuleKind;
  severity: Severity;
  appliesTo: Surface[];
  title: string;
  ownerExplanation: string;
  params: Record<string, unknown>;
  sourceRefs: SourceRef[];
}

/** First day the starter versions apply once approved. */
export const SEED_EFFECTIVE_FROM = "2026-10-21";

const VERIFY = "Starter citation — verify current text with counsel before approving.";
const ecfr = (citation: string, path: string, note = VERIFY): SourceRef => ({
  citation, type: "regulation", url: `https://www.ecfr.gov/${path}`, note,
});
const statute = (citation: string, note = VERIFY): SourceRef => ({ citation, type: "statute", note });

const STATE_NAMES: Record<string, string> = {
  CA: "California", FL: "Florida", IL: "Illinois", MD: "Maryland", MA: "Massachusetts", MT: "Montana",
  NH: "New Hampshire", PA: "Pennsylvania", WA: "Washington", CT: "Connecticut", NV: "Nevada", DE: "Delaware",
  MI: "Michigan", OK: "Oklahoma", TX: "Texas", AZ: "Arizona", CO: "Colorado", UT: "Utah",
};
const pack = (s: string) => (s === "US" ? "us-federal" : `us-${s.toLowerCase()}`);
const packName = (s: string) => (s === "US" ? "Federal (US)" : STATE_NAMES[s]);

const RECORDING_SCRIPT =
  "Quick note before we get started — this call may be recorded for quality and training. Is that okay with you?";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const FED_PART_64 = "current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200";

function rec(state: string, citation: string, note?: string): SeedRule {
  return {
    packSlug: pack(state), packName: packName(state), ruleKey: "recording-consent", jurisdiction: `US-${state}`,
    kind: "recording_consent", severity: "require", appliesTo: ["call"],
    title: `${STATE_NAMES[state]}: all-party consent to record calls`,
    ownerExplanation:
      `${STATE_NAMES[state]} is treated as an all-party-consent state for recording phone calls: everyone on the call must agree before it is recorded. ` +
      "The assistant asks for consent at the start of the call and recording must stop if the customer declines.",
    params: { mode: "all_party", script: RECORDING_SCRIPT },
    sourceRefs: [statute(citation, note ? `${VERIFY} ${note}` : VERIFY)],
  };
}

function quiet(state: string, citation: string, windows: Array<{ days: number[]; start: string; end: string }>, plain: string): SeedRule {
  return {
    packSlug: pack(state), packName: packName(state), ruleKey: "telemarketing-hours", jurisdiction: `US-${state}`,
    kind: "quiet_hours", severity: "block", appliesTo: ["call", "sms"],
    title: `${STATE_NAMES[state]}: telemarketing contact hours`,
    ownerExplanation: `${plain} Vireek holds marketing calls and texts until the customer's local window opens. Service and emergency messages are not affected.`,
    params: { windows, purposes: ["marketing"] }, sourceRefs: [statute(citation)],
  };
}

function license(state: string, citation: string, label: string): SeedRule {
  return {
    packSlug: pack(state), packName: packName(state), ruleKey: "license-display", jurisdiction: `US-${state}`,
    kind: "license_display", severity: "require", appliesTo: ["quote", "contract"],
    title: `${STATE_NAMES[state]}: show your contractor license number`,
    ownerExplanation:
      `${STATE_NAMES[state]} requires licensed contractors to show their license number on contracts and bids. ` +
      "Vireek checks that a valid license is on file for the job's state and that it appears on the document.",
    params: { licenseLabel: label, placement: "on the document" }, sourceRefs: [statute(citation)],
  };
}

function rescission(state: string, citation: string, noticeText: string): SeedRule {
  return {
    packSlug: pack(state), packName: packName(state), ruleKey: "right-of-rescission", jurisdiction: `US-${state}`,
    kind: "rescission", severity: "require", appliesTo: ["contract"],
    title: `${STATE_NAMES[state]}: three-day right to cancel (in-home sales)`,
    ownerExplanation:
      `For contracts signed at the customer's home, ${STATE_NAMES[state]} gives the customer three business days to cancel. ` +
      "Vireek calculates the deadline, checks that the written notice is included and tells you when the window closes.",
    params: { days: 3, minAmountCents: 2500, saleLocations: ["customer_home"], excludedWeekdays: [0], emergencyWaiverAllowed: true, noticeText },
    sourceRefs: [statute(citation)],
  };
}

export const SEED_RULES: SeedRule[] = [
  // --- Federal -----------------------------------------------------------
  {
    packSlug: "us-federal", packName: "Federal (US)", ruleKey: "telemarketing-hours", jurisdiction: "US",
    kind: "quiet_hours", severity: "block", appliesTo: ["call", "sms"],
    title: "Federal: no telemarketing before 8 a.m. or after 9 p.m.",
    ownerExplanation:
      "Federal telemarketing rules bar marketing calls and texts before 8 a.m. or after 9 p.m. in the customer's local time. " +
      "Vireek holds marketing messages until the customer's window opens. Service and emergency messages are not affected.",
    params: { windows: [{ days: ALL_DAYS, start: "08:00", end: "21:00" }], purposes: ["marketing"] },
    sourceRefs: [ecfr("47 C.F.R. § 64.1200(c)(1)", FED_PART_64)],
  },
  {
    packSlug: "us-federal", packName: "Federal (US)", ruleKey: "ai-voice-marketing-consent", jurisdiction: "US",
    kind: "consent_required", severity: "block", appliesTo: ["call"],
    title: "Federal: written consent before marketing calls with an AI voice",
    ownerExplanation:
      "The FCC treats AI-generated voices as \"artificial\" voices under the TCPA, so a marketing call placed by the AI assistant needs the customer's prior express written consent. " +
      "Vireek blocks outbound AI marketing calls to contacts without that consent in the ledger.",
    params: { consentType: "ai_voice", purposes: ["marketing"], requiresAiVoice: true, evidence: "prior express written consent" },
    sourceRefs: [
      statute("47 U.S.C. § 227(b)(1)(A)"),
      { citation: "FCC Declaratory Ruling, FCC 24-17 (Feb. 2024)", type: "agency_guidance", url: "https://docs.fcc.gov/public/attachments/FCC-24-17A1.pdf", note: VERIFY },
    ],
  },
  {
    packSlug: "us-federal", packName: "Federal (US)", ruleKey: "marketing-sms-consent", jurisdiction: "US",
    kind: "consent_required", severity: "block", appliesTo: ["sms"],
    title: "Federal: written consent before marketing texts",
    ownerExplanation:
      "Marketing texts need the customer's prior express written consent. Vireek blocks marketing texts to contacts with no consent record, or who withdrew consent.",
    params: { consentType: "marketing_sms", purposes: ["marketing"], evidence: "prior express written consent" },
    sourceRefs: [ecfr("47 C.F.R. § 64.1200(a)(2)", FED_PART_64)],
  },
  {
    packSlug: "us-federal", packName: "Federal (US)", ruleKey: "sms-opt-out-notice", jurisdiction: "US",
    kind: "required_notice", severity: "require", appliesTo: ["sms"],
    title: "Federal: marketing texts must explain how to opt out",
    ownerExplanation: "Marketing texts must tell the customer how to stop receiving them. Vireek checks that opt-out instructions are included.",
    params: { noticeId: "sms-opt-out", text: "Add opt-out wording to the message, e.g. \"Reply STOP to unsubscribe.\"" },
    sourceRefs: [ecfr("47 C.F.R. § 64.1200", FED_PART_64), { citation: "CTIA Messaging Principles and Best Practices", type: "other", note: VERIFY }],
  },
  {
    packSlug: "us-federal", packName: "Federal (US)", ruleKey: "right-of-rescission", jurisdiction: "US",
    kind: "rescission", severity: "require", appliesTo: ["contract"],
    title: "Federal: three-day cooling-off period for in-home sales",
    ownerExplanation:
      "When a sale of $25 or more is made at the customer's home, the FTC Cooling-Off Rule gives the customer three business days to cancel and requires a written notice and cancellation form. " +
      "Vireek calculates the deadline and checks the notice is included. True emergency repairs can be exempt when the customer signs a waiver.",
    params: {
      days: 3, minAmountCents: 2500, saleLocations: ["customer_home"], excludedWeekdays: [0], emergencyWaiverAllowed: true,
      noticeText: "Include the written notice of the three-day right to cancel and two copies of the cancellation form.",
    },
    sourceRefs: [ecfr("16 C.F.R. Part 429 (Cooling-Off Rule)", "current/title-16/chapter-I/subchapter-D/part-429")],
  },

  // --- State recording consent (all-party) ---------------------------------
  rec("CA", "Cal. Penal Code § 632"),
  rec("FL", "Fla. Stat. § 934.03"),
  rec("IL", "720 ILCS 5/14-2"),
  rec("MD", "Md. Code, Cts. & Jud. Proc. § 10-402"),
  rec("MA", "Mass. Gen. Laws ch. 272, § 99"),
  rec("MT", "Mont. Code Ann. § 45-8-213"),
  rec("NH", "N.H. Rev. Stat. Ann. § 570-A:2"),
  rec("PA", "18 Pa. Cons. Stat. § 5704"),
  rec("WA", "Wash. Rev. Code § 9.73.030"),
  rec("CT", "Conn. Gen. Stat. § 52-570d", "Civil liability for recording telephone calls without all-party consent."),
  rec("NV", "Nev. Rev. Stat. § 200.620", "Confirm treatment of telephone calls under Lane v. Allstate (Nev. 1998)."),
  rec("DE", "Del. Code Ann. tit. 11, § 1335", "Interpretation is disputed — confirm."),
  rec("MI", "Mich. Comp. Laws § 750.539c", "Interpretation is disputed (participant exception) — confirm."),

  // --- State telemarketing hours --------------------------------------------
  quiet("CA", "Cal. Bus. & Prof. Code § 17511.3", [{ days: ALL_DAYS, start: "09:00", end: "21:00" }], "California limits telephone sales calls to 9 a.m.–9 p.m."),
  quiet("FL", "Fla. Stat. § 501.059", [{ days: ALL_DAYS, start: "08:00", end: "20:00" }], "Florida limits telephonic sales calls and texts to 8 a.m.–8 p.m."),
  quiet("OK", "Okla. Stat. tit. 15, § 775C.1 et seq.", [{ days: ALL_DAYS, start: "08:00", end: "20:00" }], "Oklahoma limits telemarketing to 8 a.m.–8 p.m."),
  quiet("MD", "Md. Code, Com. Law § 14-4501 et seq.", [{ days: ALL_DAYS, start: "08:00", end: "20:00" }], "Maryland limits telephone solicitation to 8 a.m.–8 p.m."),
  quiet("TX", "Tex. Bus. & Com. Code § 302.101", [{ days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "21:00" }, { days: [0], start: "12:00", end: "21:00" }], "Texas limits telephone solicitation to 9 a.m.–9 p.m. Monday–Saturday and noon–9 p.m. Sunday."),

  // --- Contractor license display ---------------------------------------------
  license("CA", "Cal. Bus. & Prof. Code § 7030.5", "CSLB contractor license number"),
  license("FL", "Fla. Stat. § 489.119(5)(b)", "contractor license number"),
  license("TX", "Tex. Occ. Code § 1302.352", "TDLR air-conditioning contractor license number"),
  license("AZ", "Ariz. Rev. Stat. § 32-1151", "ROC contractor license number"),

  // --- State rescission --------------------------------------------------------
  rescission("CA", "Cal. Civ. Code §§ 1689.5–1689.14; Cal. Bus. & Prof. Code § 7159", "Include the statutory Notice of Cancellation required by Cal. Civ. Code § 1689.7 (and B&P § 7159 for home-improvement contracts)."),
  rescission("FL", "Fla. Stat. §§ 501.021–501.055 (Home Solicitation Sale Act)", "Include the written notice of the three-day right to cancel required for home solicitation sales."),
  rescission("TX", "Tex. Bus. & Com. Code ch. 601 (Home Solicitation Transactions)", "Include the written notice of the three-day right to cancel required for home solicitation transactions."),

  // --- Required notices ----------------------------------------------------------
  {
    packSlug: "us-ca", packName: "California", ruleKey: "mechanics-lien-warning", jurisdiction: "US-CA",
    kind: "required_notice", severity: "require", appliesTo: ["contract"],
    title: "California: mechanics' lien warning in home-improvement contracts",
    ownerExplanation: "California home-improvement contracts must carry a statutory warning about mechanics' liens. Vireek checks that the notice is included.",
    params: { noticeId: "ca-mechanics-lien-warning", text: "Include the statutory mechanics' lien warning required for home-improvement contracts (Cal. Bus. & Prof. Code § 7159)." },
    sourceRefs: [statute("Cal. Bus. & Prof. Code § 7159")],
  },
  {
    packSlug: "us-fl", packName: "Florida", ruleKey: "recovery-fund-notice", jurisdiction: "US-FL",
    kind: "required_notice", severity: "require", appliesTo: ["contract"],
    title: "Florida: Homeowners' Construction Recovery Fund notice",
    ownerExplanation: "Florida residential contracts must include a notice about the Florida Homeowners' Construction Recovery Fund. Vireek checks that the notice is included.",
    params: { noticeId: "fl-recovery-fund-notice", text: "Include the Florida Homeowners' Construction Recovery Fund notice required by Fla. Stat. § 489.1425." },
    sourceRefs: [statute("Fla. Stat. § 489.1425")],
  },

  // --- Price caps -----------------------------------------------------------------
  {
    packSlug: "us-ca", packName: "California", ruleKey: "emergency-price-cap", jurisdiction: "US-CA",
    kind: "price_cap", severity: "block", appliesTo: ["quote", "contract"],
    title: "California: 10% cap on price increases after a declared emergency",
    ownerExplanation:
      "After a state of emergency is declared, California bars raising prices for repair, reconstruction and cleanup services more than 10% above what you charged before. " +
      "Vireek compares the quote with your pre-emergency price when you mark an emergency.",
    params: { condition: "emergency_declared", maxIncreasePercent: 10 },
    sourceRefs: [statute("Cal. Penal Code § 396")],
  },

  // --- AI disclosure -----------------------------------------------------------------
  {
    packSlug: "us-co", packName: "Colorado", ruleKey: "ai-disclosure", jurisdiction: "US-CO",
    kind: "ai_disclosure", severity: "require", appliesTo: ["call", "sms", "email"],
    title: "Colorado: tell customers they are talking to AI",
    ownerExplanation: "Colorado's AI law expects consumers to be told when they are interacting with an AI system. The assistant introduces itself as an AI assistant at the start of the interaction.",
    params: { script: "Hi, this is an AI assistant for the company — I can help you with scheduling and questions." },
    sourceRefs: [statute("Colo. Rev. Stat. § 6-1-1704", "Effective date was delayed and the law has been amended — verify current status.")],
  },
  {
    packSlug: "us-ut", packName: "Utah", ruleKey: "ai-disclosure", jurisdiction: "US-UT",
    kind: "ai_disclosure", severity: "require", appliesTo: ["call", "sms", "email"],
    title: "Utah: disclose AI use to consumers",
    ownerExplanation: "Utah requires businesses to disclose generative AI use when a consumer asks, and some regulated businesses must disclose up front. The assistant introduces itself as an AI assistant.",
    params: { script: "Hi, this is an AI assistant for the company — I can help you with scheduling and questions." },
    sourceRefs: [statute("Utah Code Ann. § 13-2-12", "Amended in 2025 — verify current text and scope.")],
  },
];
