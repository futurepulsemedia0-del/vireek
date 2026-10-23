// supabase/functions/quote-video-retention-sweep/index.ts
//
// Scheduled job (suggested: daily). Physically deletes quote-video files that
// are past their account's retention window, were deleted by a user, belong to
// a deleted quote, or were uploaded but never registered (abandoned > 24 h).
//
//   - Retention clock : retention_days after the LATER of upload / quote response
//                       (quote_video_settings.retention_days, default 365).
//   - Legal holds     : respected inside quote_videos_due_for_purge()
//                       via has_active_legal_hold(user_id, 'quote_videos').
//   - Tombstones      : the row stays (title, size, duration, engagement) with
//                       purged_at set, so the audit trail survives the file.
//   - Idempotent      : a row is only marked purged after its file was removed.
//
// Caller must present the SERVICE ROLE key (pg_cron / external scheduler). The
// default gateway JWT check would also accept the public anon key, so we compare
// the bearer token explicitly.
//
// Schedule example (see RUNBOOK):
//   select cron.schedule('quote-video-retention-daily', '30 3 * * *', $$
//     select net.http_post(
//       url := '<project-ref>.supabase.co/functions/v1/quote-video-retention-sweep',
//       headers := jsonb_build_object('Authorization', 'Bearer <service-role-key>'));
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { QUOTE_VIDEO_BUCKET } from "../_shared/quote-video/engine.ts";

const BATCH = 200;
const MAX_BATCHES = 10;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || !timingSafeEqual(bearer, serviceKey)) return json({ error: "FORBIDDEN" }, 403);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, { auth: { persistSession: false } });
  const summary = { purged: 0, orphansRemoved: 0, errors: [] as string[] };

  // ---------- 1. Expired / deleted videos ----------
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data: due, error } = await admin.rpc("quote_videos_due_for_purge", { p_limit: BATCH });
    if (error) {
      summary.errors.push(`load due: ${error.message}`);
      break;
    }
    const rows = (due ?? []) as Array<{ id: string; user_id: string; storage_path: string }>;
    if (rows.length === 0) break;

    const { error: removeError } = await admin.storage.from(QUOTE_VIDEO_BUCKET).remove(rows.map((r) => r.storage_path));
    if (removeError) {
      // Do NOT mark purged: the next run retries the same rows.
      summary.errors.push(`remove files: ${removeError.message}`);
      break;
    }

    const { data: marked, error: markError } = await admin.rpc("mark_quote_videos_purged", { p_ids: rows.map((r) => r.id) });
    if (markError) {
      summary.errors.push(`mark purged: ${markError.message}`);
      break;
    }
    summary.purged += Number(marked ?? 0);

    // Audit trail per affected account (same helper the main retention sweep uses).
    const owners = [...new Set(rows.map((r) => r.user_id))];
    for (const owner of owners) {
      await admin
        .rpc("log_audit_event", {
          p_user_id: owner,
          p_action: "quote_video_retention_purge",
          p_target_table: "quote_videos",
          p_target_id: null,
        })
        .then(() => undefined, () => undefined);
    }

    if (rows.length < BATCH) break;
  }

  // ---------- 2. Abandoned uploads ----------
  const { data: orphans, error: orphanError } = await admin.rpc("quote_video_orphan_paths", { p_limit: BATCH });
  if (orphanError) {
    summary.errors.push(`load orphans: ${orphanError.message}`);
  } else {
    const paths = (orphans ?? []) as string[];
    if (paths.length) {
      const { error } = await admin.storage.from(QUOTE_VIDEO_BUCKET).remove(paths);
      if (error) summary.errors.push(`remove orphans: ${error.message}`);
      else summary.orphansRemoved = paths.length;
    }
  }

  if (summary.errors.length) console.error(JSON.stringify({ event: "quote_video_sweep_errors", ...summary }));
  return json(summary, summary.errors.length ? 207 : 200);
});
