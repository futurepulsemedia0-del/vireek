// supabase/functions/_shared/messaging/emailSettings.ts
//
// Pure, deterministic helpers for the tenant Email Settings feature
// (/dashboard/settings/email): reply-to, signature, sender identity, sender
// domain verification (SPF/DKIM) and the inbound alias. No I/O, so it is
// unit-testable (src/lib/emailSettings.test.ts) and shared by the
// email-settings, email-send and email-webhook edge functions.
//
// NOT LIVE-VERIFIED: the Resend Domains API shape (POST /domains, POST
// /domains/{id}/verify, GET /domains/{id}, DELETE /domains/{id}) and its
// status strings are mapped defensively below, but re-check
// https://resend.com/docs/api-reference/domains before going live.

export type DomainStatus = "not_started" | "pending" | "verified" | "failed";
export type RecordStatus = "verified" | "pending" | "failed" | "not_started";

export interface DnsRecord {
  kind: string; // "SPF" | "DKIM" | "Receiving" | "Tracking" | other
  type: string; // TXT | MX | CNAME
  name: string;
  value: string;
  ttl: string;
  priority: number | null;
  status: RecordStatus;
}

export interface DomainSummary {
  status: DomainStatus;
  spf: RecordStatus;
  dkim: RecordStatus;
  records: DnsRecord[];
}

export const SIGNATURE_MAX = 1000;
export const SENDER_NAME_MAX = 80;
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

// Domains a tenant must never claim as their sender domain.
const BLOCKED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com",
  "aol.com", "proton.me", "protonmail.com", "resend.dev", "vireek.com",
]);

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** "https://Mail.Acme.com/path" -> "mail.acme.com"; null when invalid or not allowed. */
export function normalizeDomain(input: string): string | null {
  let d = String(input ?? "").trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/^.*@/, "").split(/[/?#:]/)[0].replace(/\.$/, "");
  if (!DOMAIN_RE.test(d)) return null;
  if (BLOCKED_DOMAINS.has(d)) return null;
  return d;
}

export function normalizeLocalPart(input: string): string | null {
  const v = String(input ?? "").trim().toLowerCase();
  return LOCAL_PART_RE.test(v) ? v : null;
}

/** Strips characters that enable header injection or break the From display name. */
export function sanitizeSenderName(input: string | null | undefined): string | null {
  const v = String(input ?? "")
    .replace(/[\r\n<>"\\,;]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SENDER_NAME_MAX);
  return v || null;
}

/** Plain-text signature: normalized newlines, no control chars, bounded length. */
export function sanitizeSignature(input: string | null | undefined): string | null {
  const v = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, SIGNATURE_MAX);
  return v || null;
}

export function composeOutboundText(body: string, signature: string | null | undefined): string {
  const text = body.trim();
  const sig = sanitizeSignature(signature);
  return sig ? `${text}\n\n-- \n${sig}` : text;
}

export function buildInboundAddress(token: string | null | undefined, inboundDomain: string | null | undefined): string | null {
  const t = String(token ?? "").trim();
  const d = String(inboundDomain ?? "").trim().toLowerCase();
  return t && d ? `${t}@${d}` : null;
}

/**
 * A custom reply-to wins; otherwise replies route back into the inbox via the
 * tenant's inbound alias (so the thread continues in /dashboard/inbox).
 */
export function resolveReplyTo(customReplyTo: string | null | undefined, inboundAlias: string | null): string | undefined {
  const custom = String(customReplyTo ?? "").trim();
  if (custom && isValidEmail(custom)) return custom;
  return inboundAlias ?? undefined;
}

/**
 * Only a VERIFIED sender domain may be used in From: an unverified one is
 * rejected by the provider and would fail every send. Falls back to the
 * platform address (same behaviour as before this feature).
 */
export function buildFromAddress(opts: {
  senderName: string | null | undefined;
  companyName: string | null | undefined;
  domain: string | null | undefined;
  domainStatus: string | null | undefined;
  localPart: string | null | undefined;
  platformFrom: string;
}): string {
  const name = sanitizeSenderName(opts.senderName) ?? sanitizeSenderName(opts.companyName);
  const platformAddress = opts.platformFrom.includes("<")
    ? (opts.platformFrom.split("<").pop() ?? "").replace(">", "").trim()
    : opts.platformFrom.trim();
  const local = normalizeLocalPart(opts.localPart ?? "") ?? "hello";
  const address =
    opts.domain && opts.domainStatus === "verified" && normalizeDomain(opts.domain) ? `${local}@${opts.domain}` : platformAddress;
  return name ? `${name} <${address}>` : address === platformAddress ? opts.platformFrom : address;
}

function mapRecordStatus(raw: unknown): RecordStatus {
  const s = String(raw ?? "").toLowerCase();
  if (s === "verified") return "verified";
  if (s === "failed" || s === "temporary_failure") return "failed";
  if (s === "pending") return "pending";
  return "not_started";
}

export function mapDomainStatus(raw: unknown): DomainStatus {
  const s = mapRecordStatus(raw);
  return s;
}

function rollUp(statuses: RecordStatus[]): RecordStatus {
  if (statuses.length === 0) return "not_started";
  if (statuses.every((s) => s === "verified")) return "verified";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "pending" || s === "verified")) return "pending";
  return "not_started";
}

/** Normalizes a Resend domain payload into what the UI and DB store. */
export function summarizeDomain(payload: unknown): DomainSummary {
  const p = (payload ?? {}) as { status?: unknown; records?: unknown };
  const rawRecords = Array.isArray(p.records) ? (p.records as Record<string, unknown>[]) : [];
  const records: DnsRecord[] = rawRecords.map((r) => ({
    kind: String(r.record ?? "").trim() || "Other",
    type: String(r.type ?? "TXT").toUpperCase(),
    name: String(r.name ?? ""),
    value: String(r.value ?? ""),
    ttl: String(r.ttl ?? "Auto"),
    priority: typeof r.priority === "number" ? r.priority : null,
    status: mapRecordStatus(r.status),
  }));
  const by = (kind: string) => records.filter((r) => r.kind.toUpperCase() === kind).map((r) => r.status);
  return { status: mapDomainStatus(p.status), spf: rollUp(by("SPF")), dkim: rollUp(by("DKIM")), records };
}

export interface PermissionInput {
  role: string | null | undefined;
  teamPermissions?: Record<string, unknown> | null;
  customRolePermissions?: Record<string, unknown> | null;
}

/** Owner, or a team member whose (custom-role-overridden) permissions include can_edit_business_profile. */
export function canManageEmailSettings(input: PermissionInput): boolean {
  if (input.role === "owner") return true;
  const perms = { ...(input.teamPermissions ?? {}), ...(input.customRolePermissions ?? {}) };
  return perms.can_edit_business_profile === true;
}
