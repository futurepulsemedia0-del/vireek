// supabase/functions/_shared/lead-marketplace/emailEntry.ts
//
// Called by email-webhook for every inbound email addressed to a tenant alias.
// Returns { handled: true } only when the email was a marketplace lead that was
// parsed and ingested. In every other case (not a marketplace, provider not
// enabled for this tenant, or parse failure) it returns { handled: false } so
// the email still lands in the normal Unified Inbox — a lead email can never
// be silently swallowed. Parse failures are additionally logged as
// `parse_failed` events (with the raw email) so the parser can be tuned.

import { ingestParsedLead, type IngestDeps } from "./ingest.ts";
import { detectProvider, parseMarketplaceEmail, providerFromAliasTag } from "./parsers.ts";

export interface InboundEmail {
  userId: string;
  /** Local part of the "to" address, e.g. "a1b2c3d4e5f6" or "a1b2c3d4e5f6+angi". */
  toLocalPart: string;
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  receivedAtMs: number;
}

export async function handleMarketplaceEmail(deps: IngestDeps, mail: InboundEmail): Promise<{ handled: boolean }> {
  try {
    const tag = mail.toLocalPart.includes("+") ? mail.toLocalPart.split("+").slice(1).join("+") : null;
    const provider = detectProvider({ from: mail.from, subject: mail.subject, text: mail.text ?? mail.html, hint: providerFromAliasTag(tag) });
    if (!provider) return { handled: false };

    const source = await deps.store.getSource(mail.userId, provider);
    if (!source || !source.enabled) return { handled: false };

    const raw = [`From: ${mail.from}`, `Subject: ${mail.subject ?? ""}`, "", mail.text ?? mail.html ?? ""].join("\n");
    const result = parseMarketplaceEmail(provider, { from: mail.from, subject: mail.subject, text: mail.text, html: mail.html });

    if (!result.ok) {
      await deps.store.insertFailedEvent({
        user_id: mail.userId,
        source_id: source.id,
        provider,
        received_via: "email",
        parse_error: `${result.reason}: ${result.detail}`,
        raw_payload: raw.slice(0, 16_000),
        received_at: new Date(mail.receivedAtMs).toISOString(),
      });
      return { handled: false };
    }

    await ingestParsedLead(deps, { source, receivedVia: "email", parsed: result.lead, rawPayload: raw, receivedAtMs: mail.receivedAtMs });
    return { handled: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "marketplace_email_failed", error: error instanceof Error ? error.message : String(error) }));
    return { handled: false };
  }
}
