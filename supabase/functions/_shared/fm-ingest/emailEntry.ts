// supabase/functions/_shared/fm-ingest/emailEntry.ts
//
// Called by email-webhook for inbound mail addressed to "<alias>+fm@<domain>".
// A portal work-order email forwarded by an account member becomes a Work-Order Guard intake item:
// sanitized text + the untouched original in the private bucket. NOTHING is imported automatically;
// a manager reviews the item in the app and presses Import.
//
// Returns { handled: true } only when an item was stored (or already existed). In every other case
// (no +fm tag, unknown sender, empty body, rate limit, any error) it returns { handled: false } so the
// email still lands in the normal inbox: nothing is silently swallowed.
//
// Sender check: the From address must belong to the account (owner or team member). The webhook payload
// is provider-normalised and carries no SPF/DKIM verdict [VERIFY with your inbound provider], so a forged
// From can only add an item to the review queue, never data to the Guard tables.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { extractEmailAddress, sanitizeHeaderValue, sanitizeInboundText, sha256Hex } from "./sanitize.ts";

export interface FmInboundEmail {
  userId: string;          // account owner resolved from the alias token
  toLocalPart: string;     // e.g. "a1b2c3d4e5f6+fm"
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
}

const BUCKET = "fm-ingest-originals";
const MAX_ORIGINAL_FIELD = 500_000;

export const hasFmTag = (localPart: string): boolean => {
  const i = localPart.indexOf("+");
  return i >= 0 && localPart.slice(i + 1).toLowerCase() === "fm";
};

export async function handleFmPortalEmail(admin: SupabaseClient, mail: FmInboundEmail): Promise<{ handled: boolean }> {
  try {
    if (!hasFmTag(mail.toLocalPart)) return { handled: false };
    const sender = extractEmailAddress(mail.from);
    if (!sender) return { handled: false };

    const [{ data: owner }, { data: member }] = await Promise.all([
      admin.from("profiles").select("id").eq("id", mail.userId).eq("email", sender).maybeSingle(),
      admin.from("team_members").select("id").eq("account_owner_id", mail.userId).eq("member_email", sender).maybeSingle(),
    ]);
    if (!owner && !member) return { handled: false };

    const body = mail.text && mail.text.trim() ? sanitizeInboundText(mail.text, { html: false }) : sanitizeInboundText(mail.html ?? "", { html: true });
    if (body.text.length < 10) return { handled: false };
    const subject = sanitizeHeaderValue(mail.subject);
    const sha = await sha256Hex(`${sender}\n${subject}\n${body.text}`);
    const id = crypto.randomUUID();
    const path = `${mail.userId}/${id}.json`;

    const { data: stored, error } = await admin.rpc("wog_ingest_store", {
      p_owner: mail.userId, p_actor: null,
      p: {
        id, channel: "email", status: "ready", content_sha256: sha, original_path: path, original_name: "forwarded-email.json",
        sender, subject, text_content: body.text, text_truncated: body.truncated, sanitize_stats: body.stats,
      },
    });
    if (error || !stored?.ok) return { handled: false };
    if (stored.duplicate) return { handled: true };

    const original = JSON.stringify({
      receivedAt: new Date().toISOString(), from: mail.from.slice(0, 600), toLocalPart: mail.toLocalPart.slice(0, 200), subject: (mail.subject ?? "").slice(0, 1000),
      text: (mail.text ?? "").slice(0, MAX_ORIGINAL_FIELD), html: (mail.html ?? "").slice(0, MAX_ORIGINAL_FIELD),
    });
    const up = await admin.storage.from(BUCKET).upload(path, new Blob([original], { type: "application/json" }), { contentType: "application/json", upsert: false });
    if (up.error) {
      await admin.rpc("wog_ingest_discard", { p_owner: mail.userId, p_id: id });
      return { handled: false };
    }
    return { handled: true };
  } catch (error) {
    console.error(JSON.stringify({ event: "fm_email_ingest_failed", error: error instanceof Error ? error.message : String(error) }));
    return { handled: false };
  }
}
