// supabase/functions/_shared/compliance/consentContext.ts
//
// Turns resolveConsentProfile() into the text injected as {{recording_consent_context}} (inbound: vapi-webhook,
// outbound: speed-to-lead). DRAFT - NOT LEGAL ADVICE. The text is an instruction to the voice assistant, never UI copy,
// and it makes no statement about what any law requires.
//
// US BEHAVIOUR IS UNCHANGED BY CONSTRUCTION:
//   * if the legacy area-code notice (recordingConsent.ts) is non-empty, nothing is added;
//   * a US business with a caller whose location we cannot tell from the number (blocked / unmapped NANP number) keeps
//     today's behaviour: no regional text.
// Everything else - a non-US business, or any caller whose number maps to a non-US country - goes through the resolver.
//
// TODO(counsel): approve the wording of every script below per language before launch.
// TODO(counsel): decide whether a US business in an all-party state should also announce to out-of-state one-party
//                callers (today: no - US behaviour intentionally unchanged).
// TODO(owner): business province/state is not stored for non-US accounts; a Canadian business therefore resolves as
//              "unknown province" => strictest rule until that data exists.

import { allPartyStateForNumber } from "./recordingConsent.ts";
import { CONSENT_SCRIPTS, renderConsentScript, type ProfileLanguage } from "./recordingProfiles.ts";
import { inferCallerRegion, resolveConsentProfile, type CallerRegionSource, type ConsentProfile } from "./consentProfile.ts";
import { loadRegional } from "../regional/regional.ts";

const NOTICE_SCRIPTS: Record<ProfileLanguage, string> = {
  en: "Just so you know, this call may be recorded and transcribed for [Purpose].",
  de: "Zur Information: Dieses Gespräch kann zu [Purpose] aufgezeichnet und transkribiert werden.",
  fr: "Pour information, cet appel peut être enregistré et transcrit pour [Purpose].",
  es: "Le informamos que esta llamada puede ser grabada y transcrita para [Purpose].",
};

export type ConsentDecisionReason =
  | "legacy_notice_present"
  | "us_legacy_preserved"
  | "one_party"
  | "applied";

export interface RegionalConsentInput {
  /** Output of buildRecordingConsentNotice(callerNumber): "" when the legacy rule does not fire. */
  legacyNotice: string;
  /** Business country (ISO alpha-2). tenant.regional.country in the webhook. */
  businessCountry: string | null | undefined;
  businessSubdivision?: string | null;
  callerNumber: string | null | undefined;
  language?: ProfileLanguage;
  purpose?: string;
}

export interface RegionalConsentDecision {
  /** "" => add nothing to the prompt. */
  context: string;
  profile: ConsentProfile | null;
  callerSource: CallerRegionSource;
  reason: ConsentDecisionReason;
}

const areaCodeState = (area: string) => allPartyStateForNumber(`+1${area}5550100`);

export function decideRegionalConsent(input: RegionalConsentInput): RegionalConsentDecision {
  const caller = inferCallerRegion(input.callerNumber, areaCodeState);
  if (input.legacyNotice) return { context: "", profile: null, callerSource: caller.source, reason: "legacy_notice_present" };

  const bizCountry = (input.businessCountry ?? "").trim().toUpperCase();
  if (bizCountry === "US" && (caller.source === "missing" || caller.source === "nanp_unmapped")) {
    return { context: "", profile: null, callerSource: caller.source, reason: "us_legacy_preserved" };
  }

  const profile = resolveConsentProfile({
    businessRegion: { country: bizCountry || null, subdivision: input.businessSubdivision },
    callerRegion: caller.region,
  });
  if (!profile.announceRequired) return { context: "", profile, callerSource: caller.source, reason: "one_party" };

  const lang: ProfileLanguage = input.language ?? "en";
  const purpose = (input.purpose ?? "").trim().slice(0, 120) || "quality and service";
  const declined = (CONSENT_SCRIPTS[lang] ?? CONSENT_SCRIPTS.en).declined;
  const where = `${profile.business.jurisdiction} / ${profile.caller.jurisdiction}`;

  if (profile.explicitConsentRequired) {
    const s = renderConsentScript(lang, purpose);
    const gate = profile.strictRegime ? " Do not record or transcribe anything before the yes." : "";
    return {
      callerSource: caller.source, profile, reason: "applied",
      context:
        `Call-recording policy for this call (${where}): explicit consent is required before recording. ` +
        `Before anything else, ask: "${s.ask}" Wait for a clear yes before continuing.${gate} ` +
        `If the caller declines, say: "${s.declined}", transfer to a human if possible, and do not ask again.`,
    };
  }

  const notice = (NOTICE_SCRIPTS[lang] ?? NOTICE_SCRIPTS.en).replace("[Purpose]", purpose);
  return {
    callerSource: caller.source, profile, reason: "applied",
    context:
      `Call-recording policy for this call (${where}): tell the caller up front that the call may be recorded. ` +
      `Say: "${notice}" and then continue. If the caller objects, say: "${declined}", transfer to a human if possible, ` +
      `and do not mention recording again.`,
  };
}

/** Outbound helper (speed-to-lead): loads the business country itself. Never throws; "" on any problem keeps today's behaviour. */
export async function resolveRegionalConsentContext(
  // deno-lint-ignore no-explicit-any
  admin: { from: (t: string) => any },
  userId: string,
  callerNumber: string | null | undefined,
  legacyNotice: string,
): Promise<string> {
  try {
    const regional = await loadRegional(admin, userId);
    return decideRegionalConsent({ legacyNotice, businessCountry: regional.country, callerNumber }).context;
  } catch {
    return "";
  }
}
