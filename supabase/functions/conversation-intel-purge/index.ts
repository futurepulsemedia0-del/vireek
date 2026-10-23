// supabase/functions/conversation-intel-purge/index.ts
//
// Retention + deletion worker for Conversation Intelligence.
//   1. purge_expired_conversation_recordings(): detaches audio / clears transcripts past retention.
//   2. Removes every audio object queued in conversation_audio_tombstones from the private bucket.
//
// Callers: pg_cron (X-Cron-Secret, hourly) or a signed-in user right after discarding a recording
// (idempotent; only already-queued objects are removed, so any valid session may trigger it).
//
// Deploy: supabase functions deploy conversation-intel-purge

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret",
};
const BUCKET = "conversation-recordings";
const BATCH = 200;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const cronSecret = Deno.env.get("CRON_SECRET");
    let authorized = !!cronSecret && req.headers.get("X-Cron-Secret") === cronSecret;

    if (!authorized) {
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
          auth: { persistSession: false },
          global: { headers: { Authorization: authHeader } },
        });
        const { data: { user } } = await caller.auth.getUser();
        authorized = !!user;
      }
    }
    if (!authorized) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: touched, error: purgeError } = await admin.rpc("purge_expired_conversation_recordings");
    if (purgeError) throw purgeError;

    let removed = 0;
    for (let round = 0; round < 10; round++) {
      const { data: rows, error } = await admin.from("conversation_audio_tombstones").select("path").limit(BATCH);
      if (error) throw error;
      if (!rows || rows.length === 0) break;
      const paths = rows.map((r: { path: string }) => r.path);

      const { error: rmError } = await admin.storage.from(BUCKET).remove(paths);
      if (rmError) throw rmError; // keep the tombstones; the next run retries

      const { error: delError } = await admin.from("conversation_audio_tombstones").delete().in("path", paths);
      if (delError) throw delError;
      removed += paths.length;
      if (rows.length < BATCH) break;
    }

    return json({ ok: true, expiredRows: touched ?? 0, audioRemoved: removed });
  } catch (e) {
    console.error("[conversation-intel-purge] failed", e instanceof Error ? e.message : e);
    return json({ error: "Purge failed." }, 500);
  }
});
