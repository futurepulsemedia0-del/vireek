// supabase/functions/trust-subscribe/index.ts
//
// Public double-opt-in subscription to sub-processor change notices (security portal).
//
// Actions (POST JSON, callable with the anon key):
//   { action: "subscribe",   email }  -> sends a verification email (never reveals whether the address exists)
//   { action: "verify",      token }  -> confirms the subscription
//   { action: "unsubscribe", token }  -> stops notices (token comes from every notice email)
//
// Secrets: RESEND_API_KEY, RESEND_FROM_EMAIL, SITE_URL (same as send-team-invite)
// Deploy:  supabase functions deploy trust-subscribe

import { corsHeaders, json, readJson } from "../_shared/trust/http.ts";
import { adminClient } from "../_shared/trust/vault.ts";
import { escapeHtml } from "../../../src/lib/trustPack/notices.ts";
import { isUuid } from "../../../src/lib/trustPack/regions.ts";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESEND_COOLDOWN_MS = 10 * 60_000;

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  const key = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM_EMAIL");
  if (!key || !from) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  return res.ok;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await readJson(req);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const admin = adminClient();
  const site = (Deno.env.get("SITE_URL") ?? "https://vireek.com").replace(/\/+$/, "");

  if (body.action === "subscribe") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Enter a valid email address." }, 400);

    const { data: existing } = await admin.from("subprocessor_subscribers")
      .select("id,verify_token,verified_at,unsubscribed_at,last_verification_sent_at").ilike("email", email).maybeSingle();

    let token: string | null = null;
    if (!existing) {
      const { data: created, error } = await admin.from("subprocessor_subscribers")
        .insert({ email, last_verification_sent_at: new Date().toISOString() }).select("verify_token").single();
      if (error || !created) return json({ error: "Could not subscribe right now." }, 500);
      token = created.verify_token;
    } else if (!existing.verified_at || existing.unsubscribed_at) {
      const last = existing.last_verification_sent_at ? Date.parse(existing.last_verification_sent_at) : 0;
      if (Date.now() - last >= RESEND_COOLDOWN_MS) {
        // Re-subscribing after an unsubscribe requires a fresh confirmation.
        await admin.from("subprocessor_subscribers")
          .update({ unsubscribed_at: null, verified_at: null, verify_token: crypto.randomUUID(), last_verification_sent_at: new Date().toISOString() })
          .eq("id", existing.id);
        const { data: fresh } = await admin.from("subprocessor_subscribers").select("verify_token").eq("id", existing.id).single();
        token = fresh?.verify_token ?? null;
      }
    }
    if (token) {
      const link = `${site}/trust/security?verify=${token}#subprocessor-notices`;
      await sendEmail(
        email,
        "Confirm your Vireek sub-processor notices",
        `<p>Confirm your subscription to Vireek sub-processor change notices.</p><p><a href="${escapeHtml(link)}">Confirm subscription</a></p><p style="color:#667085;font-size:12px">If you didn't request this, ignore this email.</p>`,
        `Confirm your subscription to Vireek sub-processor change notices: ${link}\n\nIf you didn't request this, ignore this email.`,
      );
    }
    // Same answer whether or not the address was already known.
    return json({ ok: true });
  }

  if (body.action === "verify" || body.action === "unsubscribe") {
    const token = typeof body.token === "string" ? body.token : "";
    if (!isUuid(token)) return json({ error: "This link is not valid." }, 400);
    if (body.action === "verify") {
      const { data } = await admin.from("subprocessor_subscribers")
        .update({ verified_at: new Date().toISOString(), unsubscribed_at: null }).eq("verify_token", token).select("id");
      return data?.length ? json({ ok: true }) : json({ error: "This link is not valid or has expired." }, 400);
    }
    const { data } = await admin.from("subprocessor_subscribers")
      .update({ unsubscribed_at: new Date().toISOString() }).eq("unsubscribe_token", token).select("id");
    return data?.length ? json({ ok: true }) : json({ error: "This link is not valid." }, 400);
  }

  return json({ error: "Unknown action" }, 400);
});
