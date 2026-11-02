// supabase/functions/_shared/audit/consentText.ts
//
// The EXACT wording shown to the person, versioned. The server stores the template snapshot + its sha256 on every
// consent row, so "what did they agree to?" is always provable. Changing any string REQUIRES bumping the version.
//
// DRAFT FOR COUNSEL. Not legal advice. See docs/compliance/missed-call-audit.md for the review checklist.

import { sha256Hex } from "./crypto.ts";

export const CONSENT_VERSION = "audit-consent-2026-11-v1";

export type ConsentScope = "otp_message" | "ai_test_calls" | "email_followup";

export const CONSENT_TEXTS: Record<ConsentScope, string> = {
  otp_message:
    "Send one verification code to the business phone number I entered, by text message or by an automated voice call, " +
    "so I can prove I control this line. I am the owner or an authorized representative of this business. This is a " +
    "one-time message with no marketing. Message and data rates may apply.",
  ai_test_calls:
    "I authorize Vireek to place up to 3 short automated test calls to my verified business phone number, at the times " +
    "shown on this page. Each call is made by an AI voice assistant that says so at the start, does not record audio, " +
    "and does not try to sell anything. I understand that whoever answers will hear an automated call, and that I can " +
    "cancel any remaining call from my report page. I confirm I control this number and am authorized to request these tests.",
  email_followup:
    "Email me up to 2 follow-up messages about my audit results and how Vireek could help. I can unsubscribe in one click at any time.",
};

export interface ConsentSnapshot {
  scope: ConsentScope;
  version: string;
  text: string;
  sha256: string;
}

export async function consentSnapshot(scope: ConsentScope): Promise<ConsentSnapshot> {
  const text = CONSENT_TEXTS[scope];
  return { scope, version: CONSENT_VERSION, text, sha256: await sha256Hex(`${CONSENT_VERSION}|${scope}|${text}`) };
}

/** The lawful basis logged with every call consent. */
export const CALL_BASIS =
  "Calls go only to the requester's own number, which the requester proved they control by entering a one-time code " +
  "sent to that same number, at the requester's explicit request and for the requester's own benefit (a test of their own " +
  "line). No call is a solicitation, none is placed to any third-party number, and none is recorded.";
