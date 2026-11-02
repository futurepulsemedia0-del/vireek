// supabase/functions/feedback-retention/index.ts
//
// Daily cron (header X-Cron-Secret = CRON_SECRET). Removes expired screenshots through the Storage API
// (SQL deletes would leave orphaned files), then applies the SQL retention rules:
// screenshots 90d, survey events 400d, help search gaps 90d, closed follow-ups 365d,
// identity link + survey comments removed after 730d.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const BUCKET = "feedback-screenshots";
const SCREENSHOT_DAYS = 90;

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("X-Cron-Secret") !== secret) return new Response("forbidden", { status: 403 });

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  const { data: paths, error } = await admin.rpc("feedback_retention_screenshots", { p_days: SCREENSHOT_DAYS });
  if (error) return new Response("candidates_failed", { status: 500 });

  const list = (paths ?? []) as string[];
  for (let i = 0; i < list.length; i += 100) {
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(list.slice(i, i + 100));
    // Abort before touching the database so a failed purge is retried tomorrow instead of orphaning files.
    if (rmErr) return new Response("storage_failed", { status: 500 });
  }
  const { data: summary, error: applyErr } = await admin.rpc("feedback_retention_apply", { p_screenshot_days: SCREENSHOT_DAYS });
  if (applyErr) return new Response("apply_failed", { status: 500 });
  return new Response(JSON.stringify({ filesRemoved: list.length, ...summary }), { headers: { "Content-Type": "application/json" } });
});
