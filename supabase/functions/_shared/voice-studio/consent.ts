// Voice-clone consent + liveness logic (pure; works in Deno and browsers).
export const CONSENT_VERSION = "v1";
export const CONSENT_TEXT_V1 =
  "I confirm that the voice in the sample I upload is my own, or that its owner gave me explicit written permission " +
  "to create a synthetic copy of it for this business's AI receptionist. I will not clone any other person's voice. " +
  "I understand calls will still disclose that the assistant is AI, and that I can revoke this consent at any time, " +
  "which deletes the cloned voice.";
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
