// supabase/functions/audit-runner/index.ts
// Cron-driven worker (pg_cron -> net.http_post with X-Cron-Secret). verify_jwt = false; authenticated by a shared secret
// compared in constant time. ?action=sweep (every minute): release stuck, dial due calls, reconcile lost reports,
// finalize audits, send due emails.  ?action=housekeeping (hourly): retention purge.

import { buildAuditDeps } from "../_shared/audit/deps.ts";
import { timingSafeEqual } from "../_shared/audit/crypto.ts";
import { finalizeReady, housekeeping, reconcileCalls, runDueCalls, sendDueEmails } from "../_shared/audit/service.ts";

const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  const secret = Deno.env.get("AUDIT_CRON_SECRET") ?? "";
  const got = req.headers.get("x-cron-secret") ?? "";
  if (req.method !== "POST" || secret.length < 24 || !timingSafeEqual(got, secret)) return json(401, { error: "unauthorized" });
  const action = new URL(req.url).searchParams.get("action") ?? "sweep";
  try {
    const d = buildAuditDeps();
    if (action === "housekeeping") return json(200, { purged: await housekeeping(d) });
    if (action !== "sweep") return json(400, { error: "unknown_action" });
    const released = await d.store.releaseStuck();
    const dialed = await runDueCalls(d); // honours kill switch, consent, windows, caps internally
    const reconciled = await reconcileCalls(d);
    const completed = await finalizeReady(d);
    const emails = await sendDueEmails(d);
    return json(200, { released, dialed, reconciled, completed: completed.length, emails });
  } catch (e) {
    console.error(JSON.stringify({ scope: "audit", event: "runner_error", message: String((e as Error)?.message ?? e).slice(0, 200) }));
    return json(500, { error: "runner_failed" });
  }
});
