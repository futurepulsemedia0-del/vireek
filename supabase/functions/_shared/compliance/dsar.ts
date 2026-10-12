// supabase/functions/_shared/compliance/dsar.ts
//
// Pure, dependency-free logic for the public Data Subject Request (DSAR)
// flow: input validation, verification-code generation/hashing, due-date
// maths and the two transactional email bodies. Kept free of Deno/Supabase
// globals so it is unit-testable under Vitest (see dsar.test.ts) and shared
// verbatim by the `dsar-request` edge function.
//
// Mirror of the client-side checks in src/lib/dsar.ts — the server is the
// source of truth; the client copy only gives instant feedback.

export const DSAR_KINDS = ["access", "delete", "correct"] as const;
export type DsarKind = (typeof DSAR_KINDS)[number];

export const DSAR_RELATIONSHIPS = ["account_holder", "customer_of_customer", "website_visitor", "other"] as const;
export type DsarRelationship = (typeof DSAR_RELATIONSHIPS)[number];

export const DSAR_REGIONS = ["eu_uk", "california", "other"] as const;
export type DsarRegion = (typeof DSAR_REGIONS)[number];

/** Response deadline counted from identity verification. GDPR allows one month and CCPA 45 days; we promise the stricter one. */
export const DSAR_RESPONSE_DAYS = 30;
export const DSAR_CODE_TTL_MINUTES = 15;
export const DSAR_MAX_VERIFY_ATTEMPTS = 5;
export const DSAR_MAX_CODE_SENDS = 4;
export const DSAR_GRACE_PERIOD_DAYS = 14;

export const DSAR_LIMITS = { nameMin: 2, nameMax: 120, emailMax: 254, detailsMax: 2000, correctionMin: 10 } as const;

export interface DsarSubmission {
  kind: DsarKind;
  email: string;
  fullName: string;
  relationship: DsarRelationship;
  region: DsarRegion;
  details: string;
}

export type DsarValidation =
  | { ok: true; value: DsarSubmission }
  | { ok: false; fieldErrors: Record<string, string> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= DSAR_LIMITS.emailMax && EMAIL_RE.test(email);
}

/** Collapses control characters/newline runs so a name can never inject headers or markup into emails. */
function cleanLine(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
}

function cleanBlock(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() : "";
}

export function validateSubmission(input: unknown): DsarValidation {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fieldErrors: Record<string, string> = {};

  const kind = src.kind as DsarKind;
  if (!DSAR_KINDS.includes(kind)) fieldErrors.kind = "Choose what you would like us to do.";

  const email = normalizeEmail(src.email);
  if (!email) fieldErrors.email = "Enter the email address linked to your data.";
  else if (!isValidEmail(email)) fieldErrors.email = "Enter a valid email address.";

  const fullName = cleanLine(src.fullName);
  if (fullName.length < DSAR_LIMITS.nameMin) fieldErrors.fullName = "Enter your full name.";
  else if (fullName.length > DSAR_LIMITS.nameMax) fieldErrors.fullName = `Keep your name under ${DSAR_LIMITS.nameMax} characters.`;

  const relationship = src.relationship as DsarRelationship;
  if (!DSAR_RELATIONSHIPS.includes(relationship)) fieldErrors.relationship = "Tell us how you relate to Vireek.";

  const region = (DSAR_REGIONS.includes(src.region as DsarRegion) ? src.region : "other") as DsarRegion;

  const details = cleanBlock(src.details);
  if (details.length > DSAR_LIMITS.detailsMax) fieldErrors.details = `Keep this under ${DSAR_LIMITS.detailsMax} characters.`;
  else if (kind === "correct" && details.length < DSAR_LIMITS.correctionMin) {
    fieldErrors.details = "Tell us what is wrong and what it should say instead.";
  }

  if (src.confirmed !== true) fieldErrors.confirmed = "Please confirm this request is about your own data.";

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, value: { kind, email, fullName, relationship, region, details } };
}

export function isCodeFormat(code: unknown): code is string {
  return typeof code === "string" && /^\d{6}$/.test(code);
}

/**
 * Uniformly random 6-digit code. Uses rejection sampling so digits are not
 * biased by `% 1_000_000` on a 32-bit value. `nextUint32` is injectable for tests.
 */
export function generateVerificationCode(
  nextUint32: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (let i = 0; i < 16; i++) {
    const n = nextUint32();
    if (n < limit) return String(n % 1_000_000).padStart(6, "0");
  }
  // Practically unreachable (p < 1e-30); never loop forever.
  throw new Error("Could not generate a verification code");
}

/** HMAC-SHA256 hex. The secret keeps a leaked hash from being brute-forced across the 10^6 code space. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashVerificationCode = (secret: string, requestId: string, code: string) =>
  hmacHex(secret, `dsar-code:${requestId}:${code}`);

export const hashForRateLimit = (secret: string, value: string) => hmacHex(secret, `dsar-rl:${value}`);

export function computeDueAt(from: Date, days = DSAR_RESPONSE_DAYS): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const KIND_LABEL: Record<DsarKind, string> = {
  access: "Access a copy of my data",
  delete: "Delete my data",
  correct: "Correct my data",
};

interface Email { subject: string; html: string; text: string }

function shell(title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#64748b">Vireek &middot; This message was sent because someone submitted a data request using this address. If that wasn't you, ignore it &mdash; nothing will happen.</p></div>`;
}

export function buildCodeEmail(params: { name: string; code: string; reference: string }): Email {
  const { name, code, reference } = params;
  const mins = DSAR_CODE_TTL_MINUTES;
  return {
    subject: `Your Vireek verification code: ${code}`,
    html: shell("Verify your data request", `<p>Hi ${escapeHtml(name)},</p>
<p>Enter this code to confirm the email address on your request <strong>${escapeHtml(reference)}</strong>:</p>
<p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p>
<p>The code expires in ${mins} minutes. Vireek will never ask you to share it with anyone.</p>`),
    text: `Hi ${name},\n\nYour verification code for data request ${reference} is ${code}.\nIt expires in ${mins} minutes. Never share it with anyone.\n\nIf you didn't submit this request, ignore this email.`,
  };
}

export type DsarOutcome = "deletion_scheduled" | "deletion_blocked" | "queued";

export function buildReceiptEmail(params: {
  name: string; reference: string; kind: DsarKind; dueAt: Date; outcome: DsarOutcome; graceDays?: number;
}): Email {
  const { name, reference, kind, dueAt, outcome } = params;
  const grace = params.graceDays ?? DSAR_GRACE_PERIOD_DAYS;
  const due = dueAt.toISOString().slice(0, 10);
  const next =
    outcome === "deletion_scheduled"
      ? `Your Vireek account is scheduled for erasure after a ${grace}-day grace period. To stop it, sign in and cancel the request under Data Governance settings before the grace period ends.`
      : outcome === "deletion_blocked"
        ? "We found your account, but an active legal hold currently prevents automatic erasure. Our privacy team will review it and write to you."
        : "Our privacy team will review your request and reply to this address. If your data is held by a business that uses Vireek, we will coordinate with that business.";
  return {
    subject: `Request ${reference} received — we'll respond by ${due}`,
    html: shell("We've received your request", `<p>Hi ${escapeHtml(name)},</p>
<p>Your identity is verified. Request <strong>${escapeHtml(reference)}</strong> (${escapeHtml(KIND_LABEL[kind])}) is now in progress.</p>
<p><strong>Response due by:</strong> ${due}</p><p>${escapeHtml(next)}</p>
<p>Quote the reference number if you contact us.</p>`),
    text: `Hi ${name},\n\nYour identity is verified. Request ${reference} (${KIND_LABEL[kind]}) is in progress.\nResponse due by: ${due}\n\n${next}\n\nQuote the reference number if you contact us.`,
  };
}
