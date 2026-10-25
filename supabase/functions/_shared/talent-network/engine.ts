// Pure, dependency-free logic for the Talent Network edge functions (unit-tested in engine.test.ts).

export type CheckStatus = "invited" | "in_progress" | "complete" | "suspended" | "canceled" | "failed";
export type CheckResult = "clear" | "consider" | null;

export interface MappedEvent {
  eventId: string;
  type: string;
  candidateId: string | null;
  invitationId: string | null;
  reportId: string | null;
  status: CheckStatus;
  result: CheckResult;
}

const PACKAGE_RE = /^[a-z0-9_]{2,60}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidPackage(v: unknown): v is string {
  return typeof v === "string" && PACKAGE_RE.test(v);
}

export function isValidEmail(v: unknown): v is string {
  return typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

/** Hex HMAC-SHA256 using WebCrypto (Deno and modern Node). */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checkr signs the raw request body with the account API key (HMAC-SHA256, hex) in X-Checkr-Signature. */
export async function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return safeEqual(expected, signature.trim().toLowerCase());
}

/** Maps a provider webhook payload to our status model. Unknown/irrelevant events return null. */
export function mapCheckrEvent(payload: unknown): MappedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  const eventId = typeof p.id === "string" ? p.id : "";
  if (!type || !eventId) return null;
  const data = (p.data as Record<string, unknown> | undefined) ?? {};
  const obj = (data.object as Record<string, unknown> | undefined) ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

  const base = { eventId, type, candidateId: null as string | null, invitationId: null as string | null, reportId: null as string | null };

  if (type.startsWith("invitation.")) {
    const status: CheckStatus | null =
      type === "invitation.completed" ? "in_progress" : type === "invitation.expired" ? "failed" : type === "invitation.deleted" ? "canceled" : null;
    if (!status) return null;
    return { ...base, candidateId: str(obj.candidate_id), invitationId: str(obj.id), status, result: null };
  }

  if (type.startsWith("report.")) {
    const reportId = str(obj.id);
    const candidateId = str(obj.candidate_id);
    if (type === "report.completed") {
      const result = obj.result === "clear" ? "clear" : "consider"; // anything not clearly clear needs human review
      return { ...base, reportId, candidateId, status: "complete", result };
    }
    if (type === "report.created" || type === "report.updated") return { ...base, reportId, candidateId, status: "in_progress", result: null };
    if (type === "report.suspended") return { ...base, reportId, candidateId, status: "suspended", result: null };
    if (type === "report.canceled") return { ...base, reportId, candidateId, status: "canceled", result: null };
  }
  return null;
}

export function referenceEmail(args: { refereeName: string; workerName: string; url: string; siteName?: string }): { subject: string; html: string; text: string } {
  const site = args.siteName ?? "Vireek";
  const subject = `${args.workerName} listed you as a reference`;
  const text =
    `Hi ${args.refereeName},\n\n${args.workerName} listed you as a professional reference on ${site}.\n` +
    `It takes about 2 minutes: ${args.url}\n\nThe link expires in 14 days. If you don't know this person, ignore this email.`;
  const html =
    `<p>Hi ${escapeHtml(args.refereeName)},</p>` +
    `<p><strong>${escapeHtml(args.workerName)}</strong> listed you as a professional reference on ${escapeHtml(site)}.</p>` +
    `<p><a href="${escapeHtml(args.url)}">Share your reference (about 2 minutes)</a></p>` +
    `<p style="color:#666;font-size:12px">The link expires in 14 days. If you don't know this person, ignore this email.</p>`;
  return { subject, html, text };
}
