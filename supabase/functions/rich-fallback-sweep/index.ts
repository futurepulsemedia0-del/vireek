// RCS / Apple Messages worker (cron). Three jobs, one tick:
//   1. SMS fallback: rich messages with no delivery receipt by their deadline fall back to SMS
//      through sendCompliantSms() (A2P + opt-out + quiet-hours gates re-applied).
//   2. Deferred release: messages held by quiet hours are released; the WHOLE pipeline
//      (consent, capability, quiet hours) is re-run first.
//   3. Housekeeping: purges old webhook keys, fails rows a crashed worker left half-processed.
//
// DEPLOY:   supabase functions deploy rich-fallback-sweep --no-verify-jwt
// SCHEDULE: every minute with header  X-Cron-Secret: <CRON_SECRET>   (same external cron as arrival-window-notify)
// SECRETS:  CRON_SECRET (required)
//
// Fails CLOSED: without CRON_SECRET the function refuses to run, because it texts customers.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createRichDeps, mapMessage } from "../_shared/richMessaging/runtime.ts";
import { dispatchDeferred, runTimeoutFallback } from "../_shared/richMessaging/send.ts";

const BATCH = 25;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret) return json({ error: "CRON_SECRET is not configured" }, 503);
  if (!safeEqual(req.headers.get("X-Cron-Secret") ?? "", cronSecret)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const deps = createRichDeps(admin);

  const housekeeping = await admin.rpc("rich_housekeeping");
  if (housekeeping.error) console.error(JSON.stringify({ event: "rich_housekeeping_failed", error: housekeeping.error.message }));

  const stats = { fallbacks: 0, fallbackFailed: 0, released: 0, releaseFailed: 0 };

  const due = await admin.rpc("claim_rich_fallbacks", { p_limit: BATCH });
  if (due.error) return json({ error: due.error.message }, 500);
  for (const row of due.data ?? []) {
    try {
      const res = await runTimeoutFallback(deps, mapMessage(row));
      if (res.ok) stats.fallbacks++;
      else stats.fallbackFailed++;
    } catch (error) {
      stats.fallbackFailed++;
      console.error(JSON.stringify({ event: "rich_fallback_failed", id: row.id, error: String(error) }));
    }
  }

  const deferred = await admin.rpc("claim_due_rich_deferred", { p_limit: BATCH });
  if (deferred.error) return json({ error: deferred.error.message, ...stats }, 500);
  for (const row of deferred.data ?? []) {
    try {
      const res = await dispatchDeferred(deps, mapMessage(row));
      if (res.ok) stats.released++;
      else stats.releaseFailed++;
    } catch (error) {
      stats.releaseFailed++;
      console.error(JSON.stringify({ event: "rich_release_failed", id: row.id, error: String(error) }));
    }
  }

  return json({ ok: true, ...stats, housekeeping: housekeeping.data ?? null });
});
