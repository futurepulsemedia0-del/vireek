// Cron (every 5 min): advances emergency-access state and delivers owner/contact notices.
// Auth: CRON_SECRET via x-cron-secret (fail-closed, see _shared/http/cronAuth.ts). Deploy with verify_jwt = false.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { requireCronAuth } from "../_shared/http/cronAuth.ts";
import { sendEmail } from "../_shared/notify/deliver.ts";
import { renderNotice } from "../_shared/emergency-access/notices.ts";

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const auth = requireCronAuth(req, { allowBearer: true });
  if (!auth.ok) return auth.response;
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
    const appUrl = Deno.env.get("APP_URL") ?? Deno.env.get("SITE_URL") ?? "https://app.vireek.com"; // [VERIFY] production app URL
    const { data: tick, error: tickErr } = await db.rpc("emergency_tick");
    if (tickErr) throw tickErr;

    let sent = 0, failed = 0;
    for (let batch = 0; batch < 4; batch++) {
      const { data: due, error } = await db.rpc("emergency_claim_notices", { p_limit: 25 });
      if (error) throw error;
      if (!due?.length) break;
      // deno-lint-ignore no-explicit-any
      for (const n of due as any[]) {
        const rendered = renderNotice({
          kind: n.kind, recipient: n.recipient, ownerBusiness: n.owner_business, contactName: n.contact_name,
          requestReason: n.request_reason, accessAvailableAt: n.access_available_at, accessExpiresAt: n.access_expires_at,
          closedReason: n.closed_reason, waitHours: n.wait_hours, scopes: n.scopes,
        }, appUrl);
        if (!rendered || !n.to_email) {
          await db.rpc("emergency_mark_notice", { p_id: n.id, p_ok: !rendered, p_error: rendered ? "no_recipient" : "unknown_kind" }); // unknown kinds are dropped, not retried forever
          if (rendered) failed++;
          continue;
        }
        const r = await sendEmail(n.to_email, rendered.subject, rendered.html, rendered.text);
        await db.rpc("emergency_mark_notice", { p_id: n.id, p_ok: r.ok, p_error: r.ok ? null : (r.error ?? "send_failed").slice(0, 200) });
        r.ok ? sent++ : failed++;
      }
    }
    return json({ tick, sent, failed });
  } catch (e) {
    console.error(JSON.stringify({ event: "emergency_tick_failed", error: e instanceof Error ? e.message : String(e) }));
    return json({ error: "Tick failed." }, 500);
  }
});
