// supabase/functions/wallet-sync/index.ts
//
// Cron worker: drains wallet_push_outbox (filled by DB triggers when an ETA, technician, balance, status or
// warranty changes) and refreshes every installed copy of the pass:
//   * Apple  -> empty APNs push to each registered device; the device then GETs the new pass from wallet-pass.
//   * Google -> PATCH the object; Google syncs it to the device.
//
// DEPLOY:   supabase functions deploy wallet-sync --no-verify-jwt
// SCHEDULE: every minute with header  X-Cron-Secret: <CRON_SECRET>   (same external cron as arrival-window-notify)
// Fails CLOSED without CRON_SECRET.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { sendApnsPush } from "../_shared/wallet/applePush.ts";
import { readWalletEnv } from "../_shared/wallet/config.ts";
import { loadPayload, refreshGoogle, safeEqual } from "../_shared/wallet/service.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

interface Claimed { id: string; pass_id: string; attempts: number }

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return json({ error: "CRON_SECRET not configured" }, 503);
  if (!safeEqual(req.headers.get("X-Cron-Secret") ?? "", secret)) return json({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Server misconfigured" }, 500);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const env = readWalletEnv();

  const { data: claimed, error } = await admin.rpc("claim_wallet_push_batch", { p_limit: 25 });
  if (error) return json({ error: error.message }, 500);
  const rows = (claimed ?? []) as Claimed[];

  let sent = 0;
  let failed = 0;
  const work = async (row: Claimed) => {
    const problems: string[] = [];
    try {
      const payload = await loadPayload(admin, row.pass_id);
      if (!payload) {
        await admin.rpc("complete_wallet_push", { p_id: row.id, p_ok: true });
        return;
      }

      // Apple devices
      const { data: regs } = await admin.from("wallet_registrations").select("id, push_token").eq("pass_id", row.pass_id);
      for (const reg of (regs ?? []) as { id: string; push_token: string }[]) {
        if (!env.apple) { problems.push("APPLE_NOT_CONFIGURED"); break; }
        const r = await sendApnsPush(reg.push_token, { certPem: env.apple.certPem, keyPem: env.apple.keyPem, passTypeIdentifier: env.apple.passTypeIdentifier });
        if (r.gone) await admin.from("wallet_registrations").delete().eq("id", reg.id); // device removed the pass
        else if (!r.ok) problems.push(`APNS_${r.status}${r.detail ? `:${r.detail}` : ""}`);
      }

      // Google object (only once it has been created for this customer)
      const { data: meta } = await admin.from("wallet_passes").select("google_synced_at").eq("id", row.pass_id).single();
      if (meta?.google_synced_at && env.google) {
        const g = await refreshGoogle(env, payload);
        if (g.ok) await admin.from("wallet_passes").update({ google_synced_at: new Date().toISOString() }).eq("id", row.pass_id);
        else problems.push(`GOOGLE_${g.status}${g.detail ? `:${g.detail}` : ""}`);
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }

    await admin.rpc("complete_wallet_push", { p_id: row.id, p_ok: problems.length === 0, p_error: problems.join(" | ").slice(0, 480) || null });
    if (problems.length) { failed++; console.warn("wallet-sync problems:", row.pass_id, problems.join(" | ")); } else sent++;
  };

  for (let i = 0; i < rows.length; i += 5) await Promise.all(rows.slice(i, i + 5).map(work));
  return json({ claimed: rows.length, sent, failed });
});
