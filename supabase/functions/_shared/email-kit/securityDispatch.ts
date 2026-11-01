// Pure planning for security-event-notify: turns a security_events row into the UnifiedNotification
// and decides what may be sent. No I/O so it is unit-tested; the edge function does the I/O.

import { buildSecurityNotification, type SecurityEvent, type SecurityEventContext } from "./securityTemplates.ts";
import type { UnifiedNotification } from "./notification.ts";

export const SECURITY_EVENTS: readonly SecurityEvent[] = [
  "password_changed",
  "email_changed",
  "mfa_enrolled",
  "mfa_disabled",
  "recovery_codes_regenerated",
  "api_key_created",
  "api_key_revoked",
];

export interface SecurityEventRow {
  id: string;
  user_id: string;
  event: string;
  occurred_at: string;
  meta: Record<string, unknown> | null;
}

export const isSecurityEvent = (v: unknown): v is SecurityEvent => typeof v === "string" && (SECURITY_EVENTS as readonly string[]).includes(v);

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : null);

/** Whitelist meta -> template context. Anything not listed here is dropped, so stray data can't leak into mail. */
export function contextFromRow(row: SecurityEventRow): SecurityEventContext {
  const m = row.meta ?? {};
  const when = new Date(row.occurred_at);
  return {
    whenUtc: Number.isNaN(when.getTime()) ? new Date() : when,
    keyName: str(m.key_name, 80),
    newEmailMasked: str(m.new_email_masked, 120),
  };
}

export function planSecurityNotification(row: SecurityEventRow, locale: string | null): UnifiedNotification | null {
  if (!isSecurityEvent(row.event)) return null;
  return buildSecurityNotification(row.event, contextFromRow(row), locale ?? "en");
}

export const isValidEmailAddress = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s);

/** email_changed goes to the PREVIOUS address (supplied by the DB trigger in the dispatch body); every other event to the current one. */
export function pickRecipient(event: SecurityEvent, currentEmail: string | null | undefined, previousEmail: unknown): string | null {
  if (event === "email_changed") return isValidEmailAddress(previousEmail) ? previousEmail : isValidEmailAddress(currentEmail) ? currentEmail : null;
  return isValidEmailAddress(currentEmail) ? currentEmail : null;
}

/** Constant-time string compare for the dispatch secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
