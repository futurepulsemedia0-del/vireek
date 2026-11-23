// supabase/functions/_shared/compliance-rules/caSeedRules.ts
//
// CANADA PACK — data only. [COUNSEL][VERIFY] on every rule.
//
// Drafted by engineering as a research starting point from general knowledge. It is NOT verified legal
// text and nothing here is a statement of what the law requires. Every version is seeded as "in_review"
// and is never enforced until a staff reviewer confirms the sources with counsel and approves it
// (Compliance -> Rule review). Until the required rules for a surface are approved, Canadian outbound
// contact on that surface is blocked (see canada.ts). Values marked "conservative default" are Vireek
// product choices pending counsel, not legal requirements.
//
// Canonical source for supabase/migrations/20290306000100_canada_rule_pack.sql
// (regenerate: node --experimental-strip-types scripts/gen-compliance-seed-ca.mjs).

import type { SeedRule } from "./seedRules.ts";
import type { SourceRef } from "./types.ts";

export const CA_SEED_EFFECTIVE_FROM = "2026-11-19";
/** Marker every Canadian rule, explanation and source note must carry (enforced by tests). */
export const CA_MARKERS = ["[COUNSEL]", "[VERIFY]"] as const;

const NOTE = "Starter citation — [COUNSEL][VERIFY] confirm current text, scope and effective dates before approving.";
const src = (citation: string, type: SourceRef["type"], extra = ""): SourceRef => ({ citation, type, note: extra ? `${NOTE} ${extra}` : NOTE });

const CASL = src("Canada's Anti-Spam Legislation (CASL), S.C. 2010, c. 23", "statute");
const CASL_REGS = src("Electronic Commerce Protection Regulations (CRTC) and Industry Canada regulations under CASL", "regulation");
const UTR = src("CRTC Unsolicited Telecommunications Rules (Telemarketing Rules, National DNCL Rules, ADAD Rules) under the Telecommunications Act", "agency_guidance");
const DNCL = src("National Do Not Call List rules (CRTC) — registration, scrubbing and exemptions", "agency_guidance");

const TAG = " [COUNSEL][VERIFY]";
const PACK = { packSlug: "ca-federal", packName: "Canada (federal)", jurisdiction: "CA" } as const;

export const CA_SEED_RULES: SeedRule[] = [
  // ---- Calls -----------------------------------------------------------------------------------
  {
    ...PACK, ruleKey: "ca-call-hours", kind: "quiet_hours", severity: "block", appliesTo: ["call"],
    title: "Canada: telemarketing call hours (recipient local time)" + TAG,
    ownerExplanation:
      "Canadian telemarketing rules limit the hours in which marketing calls may be made, measured in the recipient's local time. Vireek holds marketing calls to Canadian numbers until the window opens." +
      " The weekday and weekend hours below are Vireek's conservative starting values and must be confirmed by counsel." + TAG,
    params: {
      windows: [
        { days: [1, 2, 3, 4, 5], start: "09:30", end: "21:30" },
        { days: [0, 6], start: "09:30", end: "17:00" },
      ],
      purposes: ["marketing"],
    },
    sourceRefs: [UTR, src("Weekend closing time (17:00 vs 18:00) is uncertain in engineering's notes; the earlier time is used as a conservative default.", "other")],
  },
  {
    ...PACK, ruleKey: "ca-call-marketing-consent", kind: "consent_required", severity: "block", appliesTo: ["call"],
    title: "Canada: consent or existing relationship before marketing calls" + TAG,
    ownerExplanation:
      "Before a marketing call to a Canadian number, Vireek requires a marketing-call consent on file, or a recent purchase or inquiry that falls inside the relationship window below. A revoked consent always blocks." +
      " The window lengths are placeholders for counsel to confirm; this is Vireek's conservative default, not a statement of what the rules require." + TAG,
    params: {
      consentType: "marketing_call", purposes: ["marketing"], evidence: "express consent or an existing-relationship window",
      impliedWindows: [{ basis: "transaction", months: 18 }, { basis: "inquiry", months: 6 }],
    },
    sourceRefs: [UTR, DNCL],
  },
  {
    ...PACK, ruleKey: "ca-call-ai-voice-consent", kind: "consent_required", severity: "block", appliesTo: ["call"],
    title: "Canada: express consent before marketing calls placed with an AI voice" + TAG,
    ownerExplanation:
      "Calls made by an AI voice assistant may fall under the rules for automatic dialing-announcing devices. As a conservative default Vireek requires express AI-voice consent on file for Canadian marketing calls and does not accept an implied relationship window." +
      " Counsel must confirm how the rules classify AI voice calls." + TAG,
    params: { consentType: "ai_voice", purposes: ["marketing"], requiresAiVoice: true, evidence: "express consent" },
    sourceRefs: [UTR],
  },
  {
    ...PACK, ruleKey: "ca-call-dncl-scrub", kind: "required_notice", severity: "require", appliesTo: ["call"],
    title: "Canada: scrub marketing calls against the National Do Not Call List" + TAG,
    ownerExplanation:
      "Marketing calls to Canadian numbers generally require checking the National Do Not Call List (and your own internal list) first, unless an exemption applies. Vireek reminds the team; it does not connect to the registry itself." + TAG,
    params: {
      noticeId: "ca-dncl-scrub",
      text: "Confirm the number was checked against the National Do Not Call List and your internal do-not-call list (or that a documented exemption applies) before calling. [COUNSEL][VERIFY]",
    },
    sourceRefs: [DNCL],
  },
  {
    ...PACK, ruleKey: "ca-call-identification", kind: "required_notice", severity: "require", appliesTo: ["call"],
    title: "Canada: identify the caller and the purpose at the start of the call" + TAG,
    ownerExplanation:
      "Canadian telemarketing rules expect the caller to identify themselves, the business on whose behalf they call and the purpose of the call, and to provide contact details on request. The AI assistant must follow the same script." + TAG,
    params: {
      noticeId: "ca-call-identification",
      text: "Open the call by stating the caller's name, the business name, that the call is a marketing call, and offer contact details on request. [COUNSEL][VERIFY]",
    },
    sourceRefs: [UTR],
  },
  // ---- Text messages and email (commercial electronic messages) --------------------------------
  {
    ...PACK, ruleKey: "ca-sms-consent", kind: "consent_required", severity: "block", appliesTo: ["sms"],
    title: "Canada: express or implied consent before marketing texts" + TAG,
    ownerExplanation:
      "Marketing texts to Canadian recipients need express consent, or implied consent from a recent purchase/contract or inquiry inside the windows below. Vireek blocks the message when neither applies, and never contacts someone who withdrew consent." +
      " The window lengths are placeholders for counsel to confirm." + TAG,
    params: {
      consentType: "marketing_sms", purposes: ["marketing"], evidence: "express consent or an implied-consent window",
      impliedWindows: [{ basis: "transaction", months: 24 }, { basis: "inquiry", months: 6 }],
    },
    sourceRefs: [CASL, CASL_REGS],
  },
  {
    ...PACK, ruleKey: "ca-email-consent", kind: "consent_required", severity: "block", appliesTo: ["email"],
    title: "Canada: express or implied consent before marketing emails" + TAG,
    ownerExplanation:
      "Marketing emails to Canadian recipients need express consent, or implied consent from a recent purchase/contract or inquiry inside the windows below. Vireek blocks the email when neither applies, and never contacts someone who withdrew consent." +
      " The window lengths are placeholders for counsel to confirm." + TAG,
    params: {
      consentType: "marketing_email", purposes: ["marketing"], evidence: "express consent or an implied-consent window",
      impliedWindows: [{ basis: "transaction", months: 24 }, { basis: "inquiry", months: 6 }],
    },
    sourceRefs: [CASL, CASL_REGS],
  },
  {
    ...PACK, ruleKey: "ca-sms-unsubscribe", kind: "required_notice", severity: "require", appliesTo: ["sms"],
    title: "Canada: working unsubscribe mechanism in every marketing text" + TAG,
    ownerExplanation:
      "Marketing texts to Canadian recipients must include a working way to unsubscribe, and the request must be honoured promptly. Vireek checks that the unsubscribe wording is in the message; honouring the request within the legal deadline is for counsel to define." + TAG,
    params: {
      noticeId: "ca-unsubscribe-mechanism",
      text: "Add an unsubscribe instruction (e.g. reply STOP) that works for at least 60 days after sending, and honour requests promptly. [COUNSEL][VERIFY]",
    },
    sourceRefs: [CASL, CASL_REGS],
  },
  {
    ...PACK, ruleKey: "ca-email-unsubscribe", kind: "required_notice", severity: "require", appliesTo: ["email"],
    title: "Canada: working unsubscribe link in every marketing email" + TAG,
    ownerExplanation:
      "Marketing emails to Canadian recipients must include a working unsubscribe mechanism, and the request must be honoured promptly. Vireek checks that the unsubscribe wording is present; the legal honouring deadline is for counsel to define." + TAG,
    params: {
      noticeId: "ca-unsubscribe-mechanism",
      text: "Add a one-step unsubscribe link or address that works for at least 60 days after sending, and honour requests promptly. [COUNSEL][VERIFY]",
    },
    sourceRefs: [CASL, CASL_REGS],
  },
  {
    ...PACK, ruleKey: "ca-cem-identification", kind: "required_notice", severity: "require", appliesTo: ["sms", "email"],
    title: "Canada: identify the sender in marketing texts and emails" + TAG,
    ownerExplanation:
      "Commercial messages to Canadian recipients must identify the sender (and anyone on whose behalf it is sent) and give contact information. Vireek checks that the identification is included." + TAG,
    params: {
      noticeId: "ca-sender-identification",
      text: "Include the business name, a mailing address and a working contact method (phone, email or web address) in the message. [COUNSEL][VERIFY]",
    },
    sourceRefs: [CASL, CASL_REGS],
  },
];
