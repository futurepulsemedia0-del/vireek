// Deploy: supabase functions deploy listings-sync --no-verify-jwt
// Scheduled sync of every linked listing. CRON ONLY: callers must send the
// X-Cron-Secret header (LISTINGS_CRON_SECRET). Fails CLOSED — with no secret
// configured, nobody can trigger it. Users sync their own account on demand
// through the `listings` function's "sync" action instead.
//
// Each run: pushes stale listings, re-verifies due ones (daily), skips locations
// whose owner switched auto-sync off, and prunes audit events older than 90 days.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { LINK_COLUMNS, type LinkRow } from "../_shared/listings/providers.ts";
import { loadOwnerContext, processLink, type OwnerContext } from "../_shared/listings/sync.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_PER_RUN = 150;
const TIME_BUDGET_MS = 100_000;
const EVENT_RETENTION_DAYS = 90;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("LISTINGS_CRON_SECRET") ?? "";
  const given = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !given || !safeEqual(secret, given)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });
  const started = Date.now();

  const { data: rows } = await admin
    .from("listing_links")
    .select(LINK_COLUMNS)
    .neq("state", "needs_reauth")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  const contexts = new Map<string, OwnerContext>();
  const counts = { pushed: 0, checked: 0, drift: 0, failed: 0, skipped: 0 };

  for (const link of (rows ?? []) as LinkRow[]) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    let ctx = contexts.get(link.user_id);
    if (!ctx) {
      ctx = await loadOwnerContext(admin, link.user_id);
      contexts.set(link.user_id, ctx);
    }
    if (!ctx.settings.auto_sync) { counts.skipped++; continue; }

    const r = await processLink(admin, link, ctx);
    if (r.error) counts.failed++;
    else if (r.action === "push") counts.pushed++;
    else if (r.action === "check") { counts.checked++; if (r.state === "drift") counts.drift++; }
    else counts.skipped++;
  }

  const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000).toISOString();
  await admin.from("listing_sync_events").delete().lt("created_at", cutoff);

  console.log(JSON.stringify({ event: "listings_sync_run", ...counts }));
  return json(counts);
});
