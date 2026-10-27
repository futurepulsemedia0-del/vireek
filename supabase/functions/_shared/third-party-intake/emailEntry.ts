// supabase/functions/_shared/third-party-intake/emailEntry.ts
//
// Called by email-webhook for every inbound email addressed to a tenant alias.
// Returns { handled: true } only when the email came from a configured partner
// and was stored as a work-order request. In every other case (no partners,
// unknown sender, or any error) it returns { handled: false } so the email
// still lands in the normal Unified Inbox: nothing is ever silently swallowed.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { matchPayer, parseEmail, senderDomain } from "./core.ts";
import { ingestIntake, listEnabledPayers } from "./runtime.ts";

export interface ThirdPartyInboundEmail {
  userId: string;
  /** Local part of the "to" address, e.g. "a1b2c3d4e5f6" or "a1b2c3d4e5f6+chubb". */
  toLocalPart: string;
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
}

export async function handleThirdPartyEmail(admin: SupabaseClient, mail: ThirdPartyInboundEmail): Promise<{ handled: boolean }> {
  try {
    const payers = await listEnabledPayers(admin, mail.userId);
    if (!payers.length) return { handled: false };

    const tag = mail.toLocalPart.includes("+") ? mail.toLocalPart.split("+").slice(1).join("+").toLowerCase() : null;
    const match = matchPayer(payers, tag, senderDomain(mail.from));
    if (!match) return { handled: false };

    const parsed = parseEmail({ from: mail.from, subject: mail.subject, text: mail.text, html: mail.html });
    if (!parsed.ok) return { handled: false };

    const raw = [`From: ${mail.from}`, `Subject: ${mail.subject ?? ""}`, "", mail.text ?? mail.html ?? ""].join("\n");
    await ingestIntake(admin, {
      payer: match.payer,
      via: "email",
      intake: parsed.intake,
      raw,
      extraReasons: match.via === "domain" ? ["Matched by sender domain only: confirm the sender is genuine"] : [],
    });
    return { handled: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "third_party_email_failed", error: error instanceof Error ? error.message : String(error) }));
    return { handled: false };
  }
}
