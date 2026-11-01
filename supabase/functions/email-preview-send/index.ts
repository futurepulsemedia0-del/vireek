// email-preview-send — emails a preview of a kit template to the CALLER's own address only.
// Disabled unless ENABLE_EMAIL_PREVIEW_SEND=true (keep it off in production).
// Deploy: supabase functions deploy email-preview-send   (JWT verified; do NOT use --no-verify-jwt)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { PREVIEW_SAMPLES } from "../_shared/email-kit/previewSamples.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (Deno.env.get("ENABLE_EMAIL_PREVIEW_SEND") !== "true") return json({ error: "Disabled" }, 403);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return json({ error: "Server not configured" }, 500);
  const client = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { data } = await client.auth.getUser();
  const to = data.user?.email;
  if (!to) return json({ error: "Unauthorized" }, 401);

  let body: { sampleId?: unknown; locale?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const sample = PREVIEW_SAMPLES.find((s) => s.id === body.sampleId);
  if (!sample) return json({ error: "Unknown sample" }, 400);
  const locale = typeof body.locale === "string" ? body.locale.slice(0, 8) : "en";

  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");
  const mail = sample.render(locale, siteUrl);
  const res = await sendEmail(to, `[Preview] ${mail.subject}`, mail.html, mail.text);
  return res.ok ? json({ sent: 1 }) : json({ error: "Email provider error" }, 502);
});
