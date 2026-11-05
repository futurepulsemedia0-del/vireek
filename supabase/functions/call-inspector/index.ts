// supabase/functions/call-inspector/index.ts
//
// Staff-only companion to the inspector RPCs. Two actions the database cannot do alone:
//   transcript - REDACTED transcript (tenant-sealed transcripts are never opened)
//   replay     - sandbox replay of the stored numeric timeline against current detector thresholds
// Access control, in order: (1) caller JWT must belong to profiles.is_staff (checked by the DB), (2) a reason of
// >=10 chars, (3) the audit row is written BEFORE any data is read; if the audit insert fails, nothing is returned.
// Optional secrets: none required. VAPI_REPLAY_SANDBOX_URL / _SECRET are NOT used: replay is in-process only.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { scrubString } from "../_shared/observability/redact.ts";
import { replayTimeline } from "../_shared/observability/replay.ts";
import type { CallTimeline } from "../_shared/observability/callTimeline.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("Authorization") ?? "";
  if (!url || !anon || !service) return json({ error: "Server not configured" }, 500);
  if (!/^Bearer\s+\S+/.test(auth)) return json({ error: "Unauthorized" }, 401);

  let body: { action?: string; vapiCallId?: string; reason?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const vapiCallId = typeof body.vapiCallId === "string" ? body.vapiCallId.trim().slice(0, 128) : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!vapiCallId || (body.action !== "transcript" && body.action !== "replay")) return json({ error: "Invalid request" }, 400);
  if (reason.length < 10) return json({ error: "A reason of at least 10 characters is required" }, 400);

  // Caller-scoped client: auth.uid() inside the RPCs is the real staff member.
  const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { autoRefreshToken: false, persistSession: false } });
  const audit = await asUser.rpc("inspector_log_access", { p_action: body.action, p_vapi_call_id: vapiCallId, p_reason: reason, p_target_user_id: null });
  if (audit.error) return json({ error: audit.error.code === "42501" ? "Forbidden" : "Audit failed" }, audit.error.code === "42501" ? 403 : 500);

  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    if (body.action === "replay") {
      const { data } = await admin.from("call_traces").select("timeline, flags").eq("vapi_call_id", vapiCallId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const t = data?.timeline as CallTimeline | undefined;
      if (!t || !t.summary) return json({ error: "No stored timeline for this call (expired or never recorded)" }, 404);
      return json({ replay: replayTimeline(t, (data?.flags ?? []) as string[]) });
    }

    const { data: call } = await admin.from("calls").select("transcript").eq("vapi_call_id", vapiCallId).maybeSingle();
    const raw = typeof call?.transcript === "string" ? call.transcript : null;
    if (!raw) return json({ error: "No transcript stored for this call" }, 404);
    if (raw.startsWith("sealed://")) return json({ sealed: true, lines: [], note: "This tenant seals transcripts with its own key. Inspectors cannot read them." });
    const lines = raw.split(/\r?\n/).slice(0, 400).map((l) => scrubString(l, 400));
    return json({ sealed: false, lines, note: "Phone numbers, e-mails, card/SSN-like numbers and signed URLs are masked. Names and free-text addresses may remain: treat as confidential." });
  } catch {
    return json({ error: "Inspector failed" }, 500);
  }
});
