// Voice-clone consent + liveness logic (pure; works in Deno and browsers).
export const CONSENT_VERSION = "v1";
export const CONSENT_TEXT_V1 =
  "I confirm that the voice in the sample I upload is my own, or that its owner gave me explicit written permission " +
  "to create a synthetic copy of it for this business's AI receptionist. I will not clone any other person's voice. " +
  "I understand calls will still disclose that the assistant is AI, and that I can revoke this consent at any time, " +
  "which deletes the cloned voice.";
// ---------------------------------------------------------------------------
// Versioned consent text. A consent record stores the VERSION and the SHA-256 of the exact text the person accepted.
// NEVER edit a published text: add a new version, make it current, and keep the old one so old records stay verifiable.
// The same texts are seeded, immutably, in public.voice_clone_consent_texts (migration 20290306000000); a test keeps
// this file and that migration identical.
// v2 adds the retention statement (automatic deletion after the period the owner chooses). Wording is a draft: [COUNSEL].
export const CONSENT_TEXT_V2 =
  "I confirm that the voice in the sample I upload is my own, or that its owner gave me explicit written permission " +
  "to create a synthetic copy of it for this business's AI receptionist. I will not clone any other person's voice. " +
  "I understand calls will still disclose that the assistant is AI. " +
  "I understand that the uploaded sample and the cloned voice are kept only for the retention period I choose, " +
  "after which both are deleted automatically, and that I can revoke this consent at any time, which deletes them sooner.";
export const CONSENT_TEXTS = { v1: CONSENT_TEXT_V1, v2: CONSENT_TEXT_V2 } as const;
export type ConsentVersion = keyof typeof CONSENT_TEXTS;
/** The version new consents are created with. v1 is legacy: it is still accepted for old records, never offered. */
export const CURRENT_CONSENT_VERSION: ConsentVersion = "v2";
export const CURRENT_CONSENT_TEXT: string = CONSENT_TEXTS[CURRENT_CONSENT_VERSION];
export function isKnownConsentVersion(v: unknown): v is ConsentVersion {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CONSENT_TEXTS, v);
}
export function consentTextFor(version: string): string | null {
  return isKnownConsentVersion(version) ? CONSENT_TEXTS[version] : null;
}
export const CONSENT_TTL_MS = 30 * 60 * 1000;
export const RELATIONSHIPS = ["self", "employee_written_consent"] as const;

const WORDS = [
  "amber","anchor","apple","arrow","atlas","badge","basil","beacon","birch","bridge","cactus","candle","canyon","cedar",
  "cobalt","comet","coral","cricket","daisy","delta","ember","falcon","fern","forest","garnet","glacier","harbor","hazel",
  "indigo","island","jasper","kettle","lantern","lemon","maple","meadow","mirror","nectar","orchid","otter","pebble","pepper",
  "quartz","raven","river","saddle","silver","spruce","summit","thunder","tulip","velvet","violet","walnut","willow","yellow",
  "zephyr","marble","copper","meteor","sunset","ripple","timber","whisper",
] as const;

/** rng(n) must return an integer in [0, n). Caller supplies crypto-backed randomness. */
export function generateLivenessPhrase(rng: (n: number) => number, count = 4): string {
  const out: string[] = [];
  for (let tries = 0; out.length < count; tries++) {
    if (tries > count * 100) throw new Error("rng_exhausted");
    const w = WORDS[rng(WORDS.length)];
    if (!out.includes(w)) out.push(w);
  }
  return out.join(" ");
}

export function normalizeTranscript(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/** True only if every phrase word appears in the transcript, in order. */
export function phraseMatches(transcript: string, phrase: string): boolean {
  const want = normalizeTranscript(phrase);
  if (!want.length) return false;
  let i = 0;
  for (const tok of normalizeTranscript(transcript)) if (tok === want[i] && ++i === want.length) return true;
  return false;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ConsentRow {
  user_id: string; status: string; attested: boolean; liveness_phrase: string; created_at: string;
}

/** Fail closed: cloning may start only for a fresh, pending, attested consent owned by this account. */
export function canStartClone(c: ConsentRow | null | undefined, ownerId: string, now: Date): boolean {
  if (!c || c.user_id !== ownerId || c.status !== "pending" || c.attested !== true) return false;
  const created = Date.parse(c.created_at);
  if (!Number.isFinite(created)) return false;
  const age = now.getTime() - created;
  return age >= 0 && age <= CONSENT_TTL_MS && c.liveness_phrase.length > 0;
}
