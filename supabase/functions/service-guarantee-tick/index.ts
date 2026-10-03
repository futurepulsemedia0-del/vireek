// supabase/functions/service-guarantee-tick/index.ts
//
// Vireek Verified Service — cron worker.
//
//   1. run_service_guarantee_tick()  : evaluates due 48h / 7-day / 30-day checkpoints,
//                                      opens claims from failure signals, expires coverage,
//                                      escalates unanswered claims. All decisions are
//                                      deterministic SQL — nothing is guessed by an LLM.
//   2. claim_service_guarantee_messages() : drains the customer SMS outbox through
//                                      sendCompliantSms() (A2P + STOP/opt-out gates).
//
// DEPLOY:   supabase functions deploy service-guarantee-tick --no-verify-jwt
// SCHEDULE: every 15 minutes with header  X-Cron-Secret: <CRON_SECRET>
//           (same external cron + secret already used by service-recovery-agent).
// SECRETS:  CRON_SECRET (required), SITE_URL (optional, default https://vireek.com)
//
// Fails CLOSED: without CRON_SECRET configured the function refuses to run, because it
// can text customers.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendCompliantSms } from "../_shared/messaging/sendSms.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface OutboxMessage {
  id: string;
  user_id: string;
  guarantee_id: string;
  kind: "checkpoint_prompt" | "claim_received" | "recovery_scheduled" | "recovery_done" | "verified";
  stage: string;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  token: string | null;
  business_name: string | null;
}

const STAGE_TEXT: Record<string, string> = { h48: "2 days", d7: "a week", d30: "a month" };

function buildText(m: OutboxMessage, siteUrl: string): string {
  const who = m.business_name?.trim() || "Your service provider";
  const what = m.service_type?.trim() ? `your ${m.service_type.trim()} service` : "your recent service";
  const link = `${siteUrl}/guarantee/${m.token}`;
  switch (m.kind) {
    case "checkpoint_prompt":
      return `${who}: it has been ${STAGE_TEXT[m.stage] ?? "a while"} since ${what}. Is the problem still solved? Tell us in 10 seconds: ${link} Reply STOP to opt out.`;
    case "claim_received":
      return `${who}: we received your report about ${what}. We are checking your warranty and arranging a fix. Status: ${link} Reply STOP to opt out.`;
    case "recovery_scheduled":
      return `${who}: a free recovery visit for ${what} is scheduled. Details and status: ${link} Reply STOP to opt out.`;
    case "recovery_done":
      return `${who}: your recovery visit is complete. If anything is still wrong, tell us here: ${link} Reply STOP to opt out.`;
    case "verified":
      return `${who}: ${what} is now Vireek Verified. It stays covered, so report any issue here: ${link} Reply STOP to opt out.`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) return json({ error: "CRON_SECRET is not configured" }, 500);
  if (req.headers.get("X-Cron-Secret") !== cronSecret) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const siteUrl = (Deno.env.get("SITE_URL") || "https://vireek.com").replace(/\/$/, "");

  const tick = await admin.rpc("run_service_guarantee_tick");
  if (tick.error) return json({ error: `tick failed: ${tick.error.message}` }, 500);

  const claimed = await admin.rpc("claim_service_guarantee_messages", { p_limit: 25 });
  if (claimed.error) return json({ ok: true, tick: tick.data, messages: { error: claimed.error.message } }, 200);

  const messages = (claimed.data ?? []) as OutboxMessage[];
  const counts = { sent: 0, skipped: 0, retry: 0, failed: 0 };

  for (const m of messages) {
    const finish = async (status: "sent" | "skipped" | "failed" | "retry", error?: string) => {
      counts[status]++;
      await admin.rpc("complete_service_guarantee_message", { p_id: m.id, p_status: status, p_error: error ?? null });
    };

    try {
      if (!m.customer_phone || !m.token) {
        await finish("skipped", "No phone number or link token");
        continue;
      }
      const result = await sendCompliantSms(admin, m.user_id, m.customer_phone, buildText(m, siteUrl));
      if (result.ok) {
        await finish("sent");
      } else if (result.reason === "OPTED_OUT" || result.reason === "A2P_NOT_APPROVED" || result.reason === "NOT_CONFIGURED") {
        // Not retryable: the customer opted out, or messaging is not set up for this account.
        await finish("skipped", `${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
      } else {
        await finish("retry", result.detail ?? result.reason);
      }
    } catch (e) {
      await finish("retry", e instanceof Error ? e.message : "Unexpected error");
    }
  }

  return json({ ok: true, tick: tick.data, messages: { claimed: messages.length, ...counts } });
});
