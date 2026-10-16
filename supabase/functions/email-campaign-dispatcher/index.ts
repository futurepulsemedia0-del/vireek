// supabase/functions/email-campaign-dispatcher/index.ts
//
// Cron worker (every 5 minutes). Authenticated by the service-role key only.
//   1. returns recipients stuck in 'sending' to the queue
//   2. starts scheduled campaigns whose time has come (freezes audience, re-checks
//      consent + suppression at that moment)
//   3. sends queued recipients of every 'sending' campaign in Resend batches
//
// Deploy:  supabase functions deploy email-campaign-dispatcher --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { Campaign, reclaimStale, runCampaign, startCampaign } from "../_shared/email-campaigns/engine.ts";

const BUDGET_MS = 110_000; // stay inside the edge-function wall-clock limit
const BATCHES_PER_CAMPAIGN = 20; // 2,000 emails per campaign per tick

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || auth !== serviceKey) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });
  const deadline = Date.now() + BUDGET_MS;
  const summary = { started: 0, processed: 0, failed: 0 };

  try {
    await reclaimStale(admin);

    const { data: due } = await admin
      .from("email_campaigns")
      .select("*")
      .eq("status", "scheduled")
      .lte("scheduled_at", new Date().toISOString())
      .limit(20);
    for (const c of (due ?? []) as Campaign[]) {
      try {
        await startCampaign(admin, c);
        summary.started += 1;
      } catch (e) {
        summary.failed += 1;
        console.error("startCampaign failed", c.id, e);
        await admin.from("email_campaigns").update({ status: "failed", last_error: String(e instanceof Error ? e.message : e).slice(0, 300) }).eq("id", c.id);
      }
    }

    const { data: sending } = await admin.from("email_campaigns").select("*").eq("status", "sending").order("started_at", { ascending: true }).limit(20);
    for (const c of (sending ?? []) as Campaign[]) {
      if (Date.now() >= deadline) break;
      try {
        await runCampaign(admin, c, BATCHES_PER_CAMPAIGN, deadline);
        summary.processed += 1;
      } catch (e) {
        summary.failed += 1;
        console.error("runCampaign failed", c.id, e);
        await admin.from("email_campaigns").update({ last_error: String(e instanceof Error ? e.message : e).slice(0, 300) }).eq("id", c.id);
      }
    }
    return json({ ok: true, ...summary });
  } catch (e) {
    console.error("email-campaign-dispatcher error", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
