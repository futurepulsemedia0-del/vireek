// supabase/functions/_shared/compliance/recordingProfiles.ts
//
// DRAFT — NOT LEGAL ADVICE. Region-aware recording-consent + AI-disclosure profile resolver.
// Complements (does not replace) recordingConsent.ts, which only handles US area codes.
// Every profile ships with legalReview = "draft" until counsel signs off; callers MUST treat
// "draft" profiles as a safe default (opt-in where unsure), never as legal clearance.
// Pure and dependency-free (Deno + Node + Vite safe).

export type RecordingMode = "off" | "notice" | "opt_in" | "opt_in_strict";
export type ProfileLanguage = "en" | "de" | "fr" | "es";

export interface RecordingProfile {
  mode: RecordingMode;
  /** Recording AND transcription must not start before an explicit yes. */
  gateBeforeRecording: boolean;
  legalReview: "draft" | "approved";
  jurisdiction: string;
}

export interface ProfileInput {
  /** ISO-3166 alpha-2 country the business location serves. */
  country: string | null | undefined;
  /** State / province code, e.g. "CA", "QC". */
  subdivision?: string | null;
}

const US_ALL_PARTY = new Set(["CA", "FL", "PA", "IL", "MA", "MI", "WA", "MD", "CT", "MT", "NH", "DE", "NV"]);
const EU = new Set(["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"]);

const mk = (mode: RecordingMode, jurisdiction: string): RecordingProfile => ({
  mode, jurisdiction, legalReview: "draft", gateBeforeRecording: mode === "opt_in" || mode === "opt_in_strict",
});

/** Unknown/missing country falls back to the STRICTEST non-criminal default (opt_in), never to "off". */
export function resolveRecordingProfile(input: ProfileInput): RecordingProfile {
  const c = (input.country ?? "").trim().toUpperCase();
  const sub = (input.subdivision ?? "").trim().toUpperCase();
  if (c === "DE") return mk("opt_in_strict", "DE");
  if (EU.has(c)) return mk("opt_in", c);
  if (c === "GB") return mk("notice", "GB");
  if (c === "CA") return mk(sub === "QC" ? "opt_in" : "notice", sub ? `CA-${sub}` : "CA");
  if (c === "AU") return mk("opt_in", "AU");
  if (c === "US") return mk(US_ALL_PARTY.has(sub) ? "opt_in" : "notice", sub ? `US-${sub}` : "US");
  return mk("opt_in", c || "UNKNOWN");
}

export const CONSENT_SCRIPTS: Record<ProfileLanguage, { ask: string; declined: string }> = {
  en: { ask: "I'm an AI voice assistant, not a person. May I record and transcribe this call for [Purpose]? Please say yes or no. You can ask for a person at any time.", declined: "No problem, I won't record this call." },
  de: { ask: "Ich bin eine KI und kein Mensch. Dürfen wir dieses Gespräch zu [Purpose] aufzeichnen und transkribieren? Bitte antworten Sie mit Ja oder Nein. Sie können jederzeit darum bitten, mit einer Person zu sprechen.", declined: "In Ordnung, ich zeichne nichts auf." },
  fr: { ask: "Je suis une intelligence artificielle, pas une personne. Acceptez-vous que cet appel soit enregistré et transcrit pour [Purpose] ? Répondez par oui ou par non. Vous pouvez demander à parler à une personne à tout moment.", declined: "Très bien, je n'enregistre pas cet appel." },
  es: { ask: "Soy un asistente de voz con inteligencia artificial, no una persona. ¿Nos permite grabar y transcribir esta llamada para [Purpose]? Responda sí o no. Puede pedir hablar con una persona en cualquier momento.", declined: "De acuerdo, no grabaré la llamada." },
};

export function renderConsentScript(lang: ProfileLanguage, purpose: string): { ask: string; declined: string } {
  const p = purpose.trim().slice(0, 120) || "quality and service";
  const s = CONSENT_SCRIPTS[lang] ?? CONSENT_SCRIPTS.en;
  return { ask: s.ask.replace("[Purpose]", p), declined: s.declined };
}
