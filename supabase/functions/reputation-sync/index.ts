// Deploy: supabase functions deploy reputation-sync --no-verify-jwt
// Scheduled sync of every connected review source. CRON ONLY: callers must send
// the X-Cron-Secret header (REPUTATION_CRON_SECRET). Fails CLOSED — with no
// secret configured, nobody can trigger it. Users sync their own account
// on demand through the `reputation` function's "sync" action instead.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { platformConfig, type ConnectionRow } from "../_shared/reputation/providers.ts";
import { loadSettings, syncConnection } from "../_shared/reputation/sync.ts";

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

const MAX_PER_RUN = 200;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("REPUTATION_CRON_SECRET") ?? "";
  const given = req.headers.get("X-Cron-Secret") ?? "";
  if (!secret || !given || !safeEqual(secret, given)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  const cfg = platformConfig();
  const { data: rows } = await admin
    .from("review_connections")
    .select("id, user_id, platform, external_id, display_name")
    .neq("status", "needs_reauth")
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  const settingsCache = new Map<string, Awaited<ReturnType<typeof loadSettings>>>();
  let synced = 0, skipped = 0, inserted = 0, alerts = 0, failed = 0;

  for (const conn of (rows ?? []) as ConnectionRow[]) {
    if (!cfg[conn.platform].configured) { skipped++; continue; }
    let settings = settingsCache.get(conn.user_id);
    if (!settings) { settings = await loadSettings(admin, conn.user_id); settingsCache.set(conn.user_id, settings); }
    const r = await syncConnection(admin, conn, settings);
    if (r.error) failed++; else synced++;
    inserted += r.inserted;
    alerts += r.alerts;
  }

  console.log(JSON.stringify({ event: "reputation_sync_run", synced, skipped, failed, inserted, alerts }));
  return json({ synced, skipped, failed, inserted, alerts });
});
