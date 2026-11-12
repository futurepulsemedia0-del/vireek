import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { createSweepPorts } from "../_shared/usage-alerts/ports.ts";
import { runUsageAlertSweep } from "../_shared/usage-alerts/sweep.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Cron-only entry point (no browser CORS). Fail-closed: requires `Authorization: Bearer <service-role key>`.
// USAGE_ALERT_MODE=live sends alerts; anything else (default) is SHADOW mode: it only reports what it would send.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || !timingSafeEqual(presented, serviceKey)) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });
  const mode = Deno.env.get("USAGE_ALERT_MODE") === "live" ? "live" : "shadow";
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://app.vireek.com").replace(/\/$/, "");

  try {
    const summary = await runUsageAlertSweep(createSweepPorts(admin), { now: new Date(), siteUrl, mode });
    console.log(JSON.stringify({ event: "usage_alert_sweep", ...summary }));
    return json(mode === "shadow" ? { ...summary, note: "shadow mode: nothing was sent. Set USAGE_ALERT_MODE=live to send." } : summary);
  } catch (err) {
    console.error(JSON.stringify({ event: "usage_alert_sweep_failed", error: err instanceof Error ? err.message.replace(/[^\w:. -]/g, "").slice(0, 120) : "error" }));
    return json({ error: "Sweep failed" }, 500);
  }
});
