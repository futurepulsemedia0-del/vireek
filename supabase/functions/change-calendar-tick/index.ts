// supabase/functions/change-calendar-tick/index.ts
//
// Daily reminder run for the business change calendar (public.change_calendar_entries).
//   1. change_calendar_claim_reminders(): atomically claims at most ONE due reminder per entry (exactly-once per kind).
//   2. Emails the entry owner (platform staff) a short internal message via Resend.
//   3. Marks the claim sent, or releases it when the send failed so the next run retries.
//
// Auth: header X-Cron-Secret must equal CHANGE_CALENDAR_CRON_SECRET (fails closed when the secret is not configured).
// Schedule: .github/workflows/change-calendar-tick.yml (daily). The function itself is idempotent, so extra runs are harmless.
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHANGE_CALENDAR_CRON_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL,
//          SITE_URL (optional, default https://vireek.com), SUPPORT_EMAIL (optional fallback recipient).
// Deploy:  supabase functions deploy change-calendar-tick --no-verify-jwt   (see supabase/config.toml)
//
// Emails contain only the change title, category, status and dates. No customer data.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { composeReminderEmail, REMINDER_KINDS, type ReminderItem } from "../../../src/lib/changeCalendar.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Constant-time string comparison (no early exit on the first differing byte). */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function send(to: string, mail: { subject: string; html: string; text: string }): Promise<boolean> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("RESEND_FROM_EMAIL"), to, ...mail }),
  });
  return res.ok;
}

const isItem = (v: unknown): v is ReminderItem => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.entry_id === "string" && typeof r.title === "string" && typeof r.notice_date === "string" &&
    typeof r.effective_date === "string" && typeof r.kind === "string" && (REMINDER_KINDS as readonly string[]).includes(r.kind);
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("CHANGE_CALENDAR_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !safeEqual(provided, secret)) return json({ error: "Unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "Server misconfigured" }, 500);
  // Check email config BEFORE claiming anything, so an unconfigured sender never burns a reminder.
  if (!Deno.env.get("RESEND_API_KEY") || !Deno.env.get("RESEND_FROM_EMAIL")) return json({ error: "Email is not configured." }, 503);

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const site = Deno.env.get("SITE_URL") ?? "https://vireek.com";
  const fallback = Deno.env.get("SUPPORT_EMAIL") ?? "";

  const { data, error } = await admin.rpc("change_calendar_claim_reminders");
  if (error || !Array.isArray(data)) {
    console.error(JSON.stringify({ event: "change_calendar_claim_failed" }));
    return json({ error: "Could not claim reminders" }, 500);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const raw of data) {
    if (!isItem(raw)) { skipped++; continue; }
    const to = raw.owner_email || fallback;
    try {
      if (!to) throw new Error("no recipient");
      const ok = await send(to, composeReminderEmail(raw, site));
      if (!ok) throw new Error("send failed");
      await admin.rpc("change_calendar_complete_reminder", { p_entry: raw.entry_id, p_kind: raw.kind });
      sent++;
    } catch {
      // Release so the next run retries. Never log the recipient or the title.
      await admin.rpc("change_calendar_release_reminder", { p_entry: raw.entry_id, p_kind: raw.kind });
      failed++;
    }
  }
  console.log(JSON.stringify({ event: "change_calendar_tick", claimed: data.length, sent, failed, skipped }));
  return json({ claimed: data.length, sent, failed, skipped }, failed > 0 ? 207 : 200);
});
