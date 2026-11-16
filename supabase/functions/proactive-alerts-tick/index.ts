// Proactive in-app alerts to the CUSTOMER (payment failed, accounting connection in error,
// call volume drop, calls possibly no longer forwarding). Source: public.proactive_alert_candidates().
// At-most-once: dedupe row inserted FIRST (UNIQUE); if the notification insert fails the dedupe row is
// removed so the next tick retries. Fails CLOSED without CRON_SECRET.
// Deploy: supabase functions deploy proactive-alerts-tick --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const MAX_PER_RUN = 500;
const CHUNK = 10;

interface Candidate { account_id: string; kind: string; dedupe_key: string; title: string; message: string; action_url: string }

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return json({ error: "server_misconfigured" }, 500);
  if (!safeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "server_misconfigured" }, 500);
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc("proactive_alert_candidates");
  if (error) {
    console.error(JSON.stringify({ event: "proactive_alerts_failed", stage: "candidates", code: error.code }));
    return json({ error: "candidates_failed" }, 500);
  }
  const candidates = ((data ?? []) as Candidate[]).slice(0, MAX_PER_RUN);
  let sent = 0, skipped = 0, failed = 0;

  for (let i = 0; i < candidates.length; i += CHUNK) {
    await Promise.all(candidates.slice(i, i + CHUNK).map(async (c) => {
      const ins = await admin.from("customer_alert_log").insert({ account_id: c.account_id, kind: c.kind, dedupe_key: c.dedupe_key });
      if (ins.error) { if (ins.error.code === "23505") skipped++; else failed++; return; }
      const n = await admin.from("notifications").insert({
        user_id: c.account_id, type: `proactive_${c.kind}`, title: c.title, message: c.message, action_url: c.action_url,
      });
      if (n.error) {
        failed++;
        await admin.from("customer_alert_log").delete().eq("account_id", c.account_id).eq("kind", c.kind).eq("dedupe_key", c.dedupe_key);
        return;
      }
      sent++;
    }));
  }
  console.log(JSON.stringify({ event: "proactive_alerts_tick", candidates: candidates.length, sent, skipped, failed }));
  return json({ ok: true, candidates: candidates.length, sent, skipped, failed });
});
