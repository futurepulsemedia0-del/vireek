// supabase/functions/_shared/compliance/callStartPlan.ts
//
// DRAFT - NOT LEGAL ADVICE. Every spoken sentence and every jurisdiction rule below is a starting hypothesis
// marked [COUNSEL]; every statement about provider behaviour is marked [VERIFY] in
// docs/compliance/call-recording-vendor-capability.md. Wording needs native-speaker + local-counsel review.
//
// Pure and dependency-light (Deno + Node + Vite safe). Composes the existing modules instead of duplicating them:
//   recordingProfiles.ts  business-location profile (country -> notice / opt_in / opt_in_strict)
//   recordingConsent.ts   caller-state heuristic (US all-party area codes)
//   ai-disclosure/select  the AI disclosure sentence already chosen for this caller
//
// What it decides for an inbound call, BEFORE the assistant speaks:
//   1. The first message, in this fixed order:  AI disclosure -> recording notice or transcript-consent question -> greeting.
//   2. Whether the provider may record audio (artifactPlan.recordingEnabled), fail-closed when consent is required.
//   3. After the call: whether the recording URL and transcript may be stored, from the caller's spoken answer.

import { DEFAULT_DISCLOSURE_SCRIPT } from "../ai-disclosure/select.ts";
import { allPartyStateForNumber } from "./recordingConsent.ts";
import { resolveRecordingProfile, type ProfileLanguage, type RecordingMode, type RecordingProfile } from "./recordingProfiles.ts";

/** shadow = speak the notice, write the ledger, change NOTHING at the provider. enforce = also block recording when consent is required. */
export type GateMode = "shadow" | "enforce";

export function parseGateMode(raw: string | null | undefined): GateMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow";
}

export type Decision =
  | "record_after_notice"
  | "no_recording_consent_gate"
  | "no_recording_language_unsupported"
  | "no_recording_disabled";

export type SpokenKind = "recording_notice" | "transcript_consent_ask" | "none";
export type ConsentOutcome = "pending" | "granted" | "declined" | "unclear" | "not_asked";

const MODE_RANK: Record<RecordingMode, number> = { off: 0, notice: 1, opt_in: 2, opt_in_strict: 3 };
const SUPPORTED: ReadonlySet<string> = new Set(["en", "de", "fr", "es"]);

interface Script { notice: string; ask: string; declined: string; invite: string }

/** [COUNSEL] draft wording. [Purpose] is substituted. These are NOT the reviewed scripts in recordingProfiles.ts: they only cover what is spoken after the AI disclosure. */
export const CALL_START_SCRIPTS: Record<ProfileLanguage, Script> = {
  en: {
    notice: "This call is recorded and transcribed for [Purpose]. Say \"no recording\" if you'd rather we didn't, or ask for a person at any time.",
    ask: "We do not keep an audio recording of this call. May we keep a written transcript of it for [Purpose]? Please say yes or no. You can ask for a person at any time.",
    declined: "No problem, I won't keep a recording or a transcript of this call.",
    invite: "How can I help you today?",
  },
  de: {
    notice: "Dieses Gespräch wird zu [Purpose] aufgezeichnet und transkribiert. Sagen Sie \"keine Aufzeichnung\", wenn Sie das nicht möchten, oder bitten Sie jederzeit um eine Person.",
    ask: "Wir speichern keine Tonaufnahme dieses Gesprächs. Dürfen wir ein schriftliches Protokoll zu [Purpose] aufbewahren? Bitte antworten Sie mit Ja oder Nein. Sie können jederzeit darum bitten, mit einer Person zu sprechen.",
    declined: "In Ordnung, ich speichere weder eine Aufnahme noch ein Protokoll.",
    invite: "Wie kann ich Ihnen helfen?",
  },
  fr: {
    notice: "Cet appel est enregistré et transcrit pour [Purpose]. Dites \"pas d'enregistrement\" si vous préférez, ou demandez une personne à tout moment.",
    ask: "Nous ne conservons pas d'enregistrement audio de cet appel. Pouvons-nous conserver une transcription écrite pour [Purpose] ? Répondez par oui ou par non. Vous pouvez demander à parler à une personne à tout moment.",
    declined: "Très bien, je ne conserve ni enregistrement ni transcription.",
    invite: "Comment puis-je vous aider ?",
  },
  es: {
    notice: "Esta llamada se graba y se transcribe para [Purpose]. Diga \"no grabar\" si prefiere que no, o pida hablar con una persona en cualquier momento.",
    ask: "No conservamos una grabación de audio de esta llamada. ¿Nos permite conservar una transcripción escrita para [Purpose]? Responda sí o no. Puede pedir hablar con una persona en cualquier momento.",
    declined: "De acuerdo, no conservaré ni la grabación ni la transcripción.",
    invite: "¿En qué puedo ayudarle?",
  },
};

export interface CallStartInput {
  /** The AI disclosure already chosen for this caller (ledger plan). Empty -> built-in default, so it can never be missing. */
  aiDisclosureText: string | null | undefined;
  /** Caller language code (e.g. "es"); null/"en" -> English. Unsupported codes cannot receive a recording notice. */
  language: string | null | undefined;
  callerNumber: string | null;
  businessCountry: string | null | undefined;
  businessSubdivision?: string | null;
  /** Greeting to speak last; null -> a neutral invitation. */
  greeting?: string | null;
  purpose?: string;
  gateMode: GateMode;
}

export interface CallStartPlan {
  profile: RecordingProfile;
  effectiveMode: RecordingMode;
  /** US all-party state guessed from the caller's area code. A phone number is NOT a location [VERIFY with counsel]. */
  callerState: string | null;
  callerStateSource: "area_code_heuristic" | "none";
  language: ProfileLanguage;
  languageSupported: boolean;
  gated: boolean;
  /** true when enforce mode WOULD stop audio recording for this call (also true in shadow, where nothing is stopped). */
  wouldBlock: boolean;
  decision: Decision;
  gateMode: GateMode;
  /** Value to request for artifactPlan.recordingEnabled. */
  recordingEnabled: boolean;
  /** true only in enforce mode: only then may the webhook send an artifactPlan override to the provider. */
  applyProviderOverride: boolean;
  spokenKind: SpokenKind;
  /** Exact wording spoken between the AI disclosure and the greeting ("" when none). */
  spokenText: string;
  declinedText: string;
  aiDisclosure: string;
  /** Full assistantOverrides.firstMessage. */
  firstMessage: string;
  /** Value for the recording_consent_context prompt variable. */
  promptContext: string;
}

function cleanLanguage(raw: string | null | undefined): { lang: ProfileLanguage; supported: boolean } {
  const l = (raw ?? "en").trim().toLowerCase().slice(0, 2) || "en";
  return SUPPORTED.has(l) ? { lang: l as ProfileLanguage, supported: true } : { lang: "en", supported: false };
}

const fill = (s: string, purpose: string): string => s.replace("[Purpose]", purpose);
const join = (...parts: Array<string | null | undefined>): string =>
  parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" ");

export function buildCallStartPlan(input: CallStartInput): CallStartPlan {
  const profile = resolveRecordingProfile({ country: input.businessCountry, subdivision: input.businessSubdivision });
  const callerState = allPartyStateForNumber(input.callerNumber);
  const { lang, supported } = cleanLanguage(input.language);
  const purpose = (input.purpose ?? "").trim().slice(0, 120) || "quality and service";

  // Strictest of: business-location profile, caller-state heuristic.
  let effectiveMode: RecordingMode = profile.mode;
  if (callerState && MODE_RANK[effectiveMode] < MODE_RANK.opt_in) effectiveMode = "opt_in";
  const gated = effectiveMode === "opt_in" || effectiveMode === "opt_in_strict";
  const wouldBlock = effectiveMode !== "off" && (gated || !supported);

  const script = CALL_START_SCRIPTS[lang];
  const aiDisclosure = (input.aiDisclosureText ?? "").trim() || DEFAULT_DISCLOSURE_SCRIPT;
  const greeting = (input.greeting ?? "").trim() || script.invite;
  const enforce = input.gateMode === "enforce";

  let decision: Decision;
  let recordingEnabled: boolean;
  let spokenKind: SpokenKind;
  if (effectiveMode === "off") {
    decision = "no_recording_disabled"; recordingEnabled = false; spokenKind = "none";
  } else if (enforce && wouldBlock) {
    recordingEnabled = false;
    if (gated) { decision = "no_recording_consent_gate"; spokenKind = supported ? "transcript_consent_ask" : "none"; }
    else { decision = "no_recording_language_unsupported"; spokenKind = "none"; }
  } else {
    // notice mode, or shadow mode (nothing is blocked, so the notice must be the truthful one: recording happens).
    decision = "record_after_notice"; recordingEnabled = true; spokenKind = supported ? "recording_notice" : "none";
  }

  const spokenText =
    spokenKind === "recording_notice" ? fill(script.notice, purpose)
    : spokenKind === "transcript_consent_ask" ? fill(script.ask, purpose)
    : "";
  const declinedText = script.declined;

  let promptContext = "";
  if (spokenKind === "recording_notice") {
    promptContext =
      "The caller has already been told in your first message that this call is recorded and transcribed. Do not repeat the notice. " +
      `If the caller says they do not want to be recorded, say: "${declinedText}", use the request_human_transfer tool if available, and do not mention recording again.`;
  } else if (spokenKind === "transcript_consent_ask") {
    promptContext =
      "This call is NOT audio-recorded. Your first message asked whether we may keep a written transcript. " +
      "Wait for a clear yes or no before doing anything else. If the caller says no or is unclear, say: " +
      `"${declinedText}", do not ask again, and do not mention recording or transcripts again. Offer a person if they ask for one.`;
  }

  return {
    profile, effectiveMode, callerState, callerStateSource: callerState ? "area_code_heuristic" : "none",
    language: lang, languageSupported: supported, gated, wouldBlock, decision, gateMode: input.gateMode,
    recordingEnabled, applyProviderOverride: enforce, spokenKind, spokenText, declinedText, aiDisclosure,
    firstMessage: join(aiDisclosure, spokenText, greeting), promptContext,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Consent outcome from the spoken answer (post-call, from the provider transcript turns).
// Conservative: an explicit refusal wins; anything not clearly "yes" is "unclear" (= not granted).
// ---------------------------------------------------------------------------------------------------------

export interface Turn { role: "assistant" | "user"; text: string }

const strip = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[“”„"«»]/g, " ").replace(/\s+/g, " ").trim();

const YES: Record<ProfileLanguage, RegExp> = {
  en: /\b(yes|yeah|yep|yup|sure|ok|okay|alright|fine|go ahead|that'?s fine|no problem|no worries|absolutely|of course)\b/,
  de: /\b(ja|jawohl|klar|gerne|einverstanden|in ordnung|okay|ok|natuerlich|naturlich|von mir aus)\b/,
  fr: /\b(oui|d'?accord|ok|okay|bien sur|pas de probleme|volontiers)\b/,
  es: /\b(si|claro|vale|de acuerdo|esta bien|por supuesto|adelante|ok|okay)\b/,
};
const NO: Record<ProfileLanguage, RegExp> = {
  en: /(^|\b)(no recording|don'?t record|do not record|not record|stop recording|rather not|nope|nah|no thanks|no thank you|not ok(ay)?)\b|^no\b/,
  de: /\b(keine aufzeichnung|nicht aufzeichnen|lieber nicht|nicht einverstanden|nein|nee)\b/,
  fr: /\b(pas d'?enregistrement|je refuse|pas question|non)\b/,
  es: /\b(no grabar|no graben|no grabes|prefiero que no|sin grabar|no quiero|no gracias)\b|^no\b/,
};

const NOT_A_REFUSAL = /\bno (problem|worries)\b/;

export function classifyAnswer(text: string, lang: ProfileLanguage): "yes" | "no" | "unclear" {
  const t = strip(text);
  if (!t) return "unclear";
  const cleaned = t.replace(NOT_A_REFUSAL, " yes ");
  if (NO[lang].test(cleaned)) return "no";
  const words = cleaned.split(" ").filter(Boolean).length;
  const m = YES[lang].exec(cleaned);
  // "yes" only counts at the start of the answer or in a short answer, so "si el tecnico..." / long stories are not consent.
  if (m && (m.index <= 2 || words <= 8)) return "yes";
  return "unclear";
}

export function inferConsentOutcome(
  turns: Turn[], language: ProfileLanguage, spokenKind: SpokenKind,
): { outcome: ConsentOutcome; excerpt: string | null; turnIndex: number | null } {
  if (spokenKind === "none") return { outcome: "not_asked", excerpt: null, turnIndex: null };
  const firstBot = turns.findIndex((t) => t.role === "assistant");
  if (firstBot < 0) return { outcome: "unclear", excerpt: null, turnIndex: null };
  const answers: Array<{ i: number; text: string }> = [];
  for (let i = firstBot + 1; i < turns.length && answers.length < 2; i++) if (turns[i].role === "user") answers.push({ i, text: turns[i].text });
  if (answers.length === 0) return { outcome: "unclear", excerpt: null, turnIndex: null };
  const classes = answers.map((a) => ({ ...a, c: classifyAnswer(a.text, language) }));
  const no = classes.find((a) => a.c === "no");
  if (no) return { outcome: "declined", excerpt: no.text.slice(0, 120), turnIndex: no.i };
  const yes = classes.find((a) => a.c === "yes");
  if (yes) return { outcome: "granted", excerpt: yes.text.slice(0, 120), turnIndex: yes.i };
  return { outcome: "unclear", excerpt: answers[0].text.slice(0, 120), turnIndex: answers[0].i };
}

/** Provider message list -> turns. Accepts Vapi-style { role: "bot"|"assistant"|"user", message|content }. Never throws. */
export function turnsFromProviderMessages(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; message?: unknown; content?: unknown };
    const text = typeof r.message === "string" ? r.message : typeof r.content === "string" ? r.content : "";
    if (!text.trim()) continue;
    if (r.role === "bot" || r.role === "assistant") out.push({ role: "assistant", text });
    else if (r.role === "user") out.push({ role: "user", text });
  }
  return out;
}

/** True when the exact notice/ask wording is in the FIRST assistant turn, i.e. spoken before any caller audio was answered. */
export function noticeInFirstAssistantTurn(turns: Turn[], spokenText: string): boolean | null {
  if (!spokenText) return null;
  const first = turns.find((t) => t.role === "assistant");
  if (!first) return null;
  const probe = strip(spokenText).slice(0, 40);
  return probe.length > 0 && strip(first.text).includes(probe);
}

// ---------------------------------------------------------------------------------------------------------
// Storage decision after the call.
// ---------------------------------------------------------------------------------------------------------

export interface StorageDecision {
  storeRecording: boolean;
  storeTranscript: boolean;
  /** The provider may still hold a copy the caller refused: needs provider-side deletion (see providerErasure.ts). */
  providerDeletionRequired: boolean;
  reason: string;
}

export function decideStorage(
  plan: Pick<CallStartPlan, "decision" | "gateMode" | "recordingEnabled" | "spokenKind">,
  outcome: ConsentOutcome,
): StorageDecision {
  const enforce = plan.gateMode === "enforce";
  const gatedBlocked = plan.decision === "no_recording_consent_gate";
  // 1. An explicit refusal is honoured in every mode.
  if (outcome === "declined") {
    return { storeRecording: false, storeTranscript: false, providerDeletionRequired: plan.recordingEnabled, reason: "caller_declined" };
  }
  // 2. Enforce + consent gate: nothing is kept unless the caller said an explicit yes.
  if (enforce && gatedBlocked && outcome !== "granted") {
    return { storeRecording: false, storeTranscript: false, providerDeletionRequired: false, reason: "consent_gate_not_granted" };
  }
  // 3. Enforce + gate + granted: transcript only. The audio was never recorded (provider flag off).
  if (enforce && gatedBlocked) {
    return { storeRecording: false, storeTranscript: true, providerDeletionRequired: false, reason: "transcript_consent_granted" };
  }
  return { storeRecording: true, storeTranscript: true, providerDeletionRequired: false, reason: enforce ? "notice_given" : "shadow_unchanged" };
}

// ---------------------------------------------------------------------------------------------------------
// Provider payload helpers (assistant-request response).
// Shape of artifactPlan.recordingEnabled and of per-member squad overrides is NOT LIVE-VERIFIED [VERIFY]:
// see docs/compliance/call-recording-vendor-capability.md section 5 before switching CALL_RECORDING_GATE_MODE=enforce.
// ---------------------------------------------------------------------------------------------------------

/** assistantOverrides fragment for a single assistant. artifactPlan is sent ONLY in enforce mode. */
export function planOverrides(plan: Pick<CallStartPlan, "firstMessage" | "applyProviderOverride" | "recordingEnabled">): Record<string, unknown> {
  return {
    firstMessage: plan.firstMessage,
    ...(plan.applyProviderOverride ? { artifactPlan: { recordingEnabled: plan.recordingEnabled } } : {}),
  };
}

interface SquadLike { members: Array<{ assistantId: string; assistantOverrides: Record<string, unknown> }> }

/** Squad mode: first member speaks first (gets the first message); every member carries the recording flag. Pure, returns a copy. */
export function applyPlanToSquad<T extends SquadLike>(squad: T, plan: Pick<CallStartPlan, "firstMessage" | "applyProviderOverride" | "recordingEnabled">): T {
  const members = squad.members.map((m, i) => ({
    ...m,
    assistantOverrides: {
      ...m.assistantOverrides,
      ...(i === 0 ? { firstMessage: plan.firstMessage } : {}),
      ...(plan.applyProviderOverride ? { artifactPlan: { recordingEnabled: plan.recordingEnabled } } : {}),
    },
  }));
  return { ...squad, members };
}
