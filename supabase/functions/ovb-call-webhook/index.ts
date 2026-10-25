// supabase/functions/ovb-call-webhook/index.ts
//
// Server URL for the Vapi *caller bot* used by phone runs (see startPhoneCall in
// _shared/ovb/runtime.ts). Receives end-of-call-report, stores the recording
// privately, builds the transcript and scores the scenario.
// Vapi roles are from the caller bot's point of view: "bot" = our scripted caller,
// "user" = whoever answered the phone = the agent under test.
// Deploy: supabase functions deploy ovb-call-webhook --no-verify-jwt   (secret header x-ovb-secret)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { countOpen, finalizeRun, scoreAndStore, type Json } from "../_shared/ovb/runtime.ts";
import { assertSafeVendorUrl, buildTurnsFromVapi, type Check } from "../_shared/ovb/logic.ts";

const MAX_AUDIO = 50 * 1024 * 1024;
const ok = (b: unknown = { ok: true }, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return ok({ error: "Method not allowed" }, 405);
  const secret = Deno.env.get("OVB_WEBHOOK_SECRET") ?? "";
  const sent = req.headers.get("x-ovb-secret") ?? "";
  if (!secret || !sent || !safeEqual(sent, secret)) return ok({ error: "Unauthorized" }, 401);

  const payload = (await req.json().catch(() => null)) as { message?: Json } | null;
  const msg = payload?.message as { type?: string; call?: { id?: string; metadata?: { ovb_result_id?: string } }; artifact?: { messages?: { role?: string; message?: string; time?: number; endTime?: number }[]; recordingUrl?: string; recording?: { stereoUrl?: string; mono?: { combinedUrl?: string } } }; recordingUrl?: string; endedReason?: string } | undefined;
  if (!msg || msg.type !== "end-of-call-report") return ok();

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });
  try {
    const resultId = msg.call?.metadata?.ovb_result_id;
    const q = admin.from("ovb_run_results").select("id, run_id, scenario_id, status, attempts");
    const { data: rr } = await (resultId ? q.eq("id", resultId) : q.eq("call_ref", msg.call?.id ?? "-")).maybeSingle();
    if (!rr || rr.status !== "awaiting_call") return ok();

    const turns = buildTurnsFromVapi(msg.artifact?.messages ?? []);
    const agentTurns = turns.filter((t) => t.role === "agent").length;
    if (agentTurns === 0 || /no-answer|busy|failed|voicemail/i.test(msg.endedReason ?? "")) {
      await admin.from("ovb_run_results").update({ status: "pending", claimed_at: null, error: `call ended: ${msg.endedReason ?? "no agent speech"}`.slice(0, 200) }).eq("id", rr.id);
      return ok();
    }

    const [{ data: run }, { data: sc }] = await Promise.all([
      admin.from("ovb_runs").select("id, purpose, rubric_snapshot, suite_id, agent_id, provenance").eq("id", rr.run_id).single(),
      admin.from("ovb_scenarios").select("id, scenario_key, content_hash, weight, is_held_out, checks, business_context").eq("id", rr.scenario_id).single(),
    ]);
    if (!run || !sc) return ok();
    const [{ data: suite }, { data: agent }] = await Promise.all([
      admin.from("ovb_suites").select("business_profile").eq("id", run.suite_id).single(),
      admin.from("ovb_agents").select("public_listing_consent").eq("id", run.agent_id).single(),
    ]);

    // Recording: download once, store privately, remember the hash.
    let recording: { path: string; sha256: string; isPublic: boolean } | undefined;
    const rawUrl = msg.artifact?.recording?.stereoUrl ?? msg.artifact?.recordingUrl ?? msg.recordingUrl ?? msg.artifact?.recording?.mono?.combinedUrl;
    const safe = rawUrl ? assertSafeVendorUrl(rawUrl) : null;
    if (safe?.ok) {
      const res = await fetch(safe.url, { redirect: "follow" }).catch(() => null);
      if (res?.ok) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > 0 && buf.length <= MAX_AUDIO) {
          const type = (res.headers.get("content-type") ?? "").split(";")[0];
          const allowed = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/ogg", "audio/webm"];
          const contentType = allowed.includes(type) ? type : "audio/wav";
          const ext = contentType === "audio/mpeg" ? "mp3" : contentType.split("/")[1].replace("x-", "");
          const path = `${run.id}/${rr.id}.${ext}`;
          const { error } = await admin.storage.from("ovb-recordings").upload(path, buf, { contentType, upsert: true });
          if (!error) {
            const digest = await crypto.subtle.digest("SHA-256", buf);
            recording = { path, sha256: Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join(""), isPublic: run.provenance === "first_party" || Boolean(agent?.public_listing_consent) };
          }
        }
      }
    }

    await scoreAndStore(admin, { id: run.id, purpose: run.purpose, rubric_snapshot: run.rubric_snapshot as Json, suite_id: run.suite_id },
      rr.id, { ...sc, checks: sc.checks as Check[], business_context: sc.business_context as Json }, (suite?.business_profile ?? {}) as Json,
      { turns, outcome: null, outcomeSource: null }, { recording, callRef: msg.call?.id });
    if ((await countOpen(admin, run.id, true)) === 0) await finalizeRun(admin, run.id);
    return ok();
  } catch (e) {
    console.error("[ovb-call-webhook]", e instanceof Error ? e.message : e);
    return ok({ error: "processing failed" }, 500);
  }
});
