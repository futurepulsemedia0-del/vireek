// supabase/functions/conversation-intel-analyze/index.ts
//
// Conversation Intelligence — analyse ONE consented in-home recording.
//
// Input : { recordingId }  (caller's JWT; the audio was uploaded to the private
//         bucket `conversation-recordings` and attached via attach_conversation_audio()).
// Does  : re-verifies consent server-side -> claims the row atomically -> one Gemini call
//         (audio -> speaker-labelled transcript + promises/objections/upsells/safety + coaching)
//         -> validates EVERYTHING in code (engine.ts) -> writes insights, commitments (Commitment
//         Graph), follow-up tasks, an in-app safety notification and a coaching note.
// Safe  : idempotent (re-analysis never duplicates insights/commitments/tasks); never trusts model
//         output for enums, dates or priorities; the transcript is treated as data, not instructions.
//
// Secrets: GEMINI_API_KEY (required, shared with tribal-knowledge-voice-capture), GEMINI_MODEL (optional).
// Deploy : supabase functions deploy conversation-intel-analyze

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import {
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  buildTaskDraft,
  canRecord,
  computeDueAt,
  dedupeInsights,
  insightKey,
  safetyAlertNeeded,
  validateAnalysis,
  type CustomerConsentStatus,
  type RawInsight,
} from "../_shared/conversation-intel/engine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const BUCKET = "conversation-recordings";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ANALYSES_PER_HOUR = 30;
const STALE_ANALYZING_MS = 6 * 60_000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function audioMime(path: string, stored: string | null): string {
  if (stored && stored.startsWith("audio/")) return stored.split(";")[0];
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
  };
  return map[ext] ?? "audio/webm";
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { return null; }
  }
}

type Rec = {
  id: string; user_id: string; job_id: string | null; technician_member_id: string | null;
  technician_user_id: string | null; customer_name: string | null; status: string;
  customer_consent_status: CustomerConsentStatus; customer_consent_at: string | null;
  technician_consent_at: string | null; disclosure_shown_at: string | null;
  audio_path: string | null; audio_mime: string | null; ended_at: string | null; updated_at: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  let claimedId: string | null = null;
  let admin: ReturnType<typeof createClient> | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);
    if (!apiKey) return json({ error: "Conversation analysis is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const body = await req.json().catch(() => null);
    const recordingId = body && typeof body.recordingId === "string" ? body.recordingId : "";
    if (!/^[0-9a-f-]{36}$/i.test(recordingId)) return json({ error: "Invalid recording id." }, 400);

    const caller = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // RLS decides whether this caller may see the recording at all.
    const { data: visible } = await caller.from("conversation_recordings").select("id").eq("id", recordingId).maybeSingle();
    if (!visible) return json({ error: "Recording not found." }, 404);

    admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const { data: recRow } = await admin.from("conversation_recordings").select("*").eq("id", recordingId).maybeSingle();
    const rec = recRow as Rec | null;
    if (!rec) return json({ error: "Recording not found." }, 404);

    // ── Consent + feature gate, re-verified server-side ──────────────────────
    const { data: settings } = await admin
      .from("conversation_intel_settings").select("enabled, auto_create_tasks").eq("user_id", rec.user_id).maybeSingle();
    if (!settings?.enabled) return json({ error: "Conversation Intelligence is turned off for this account." }, 403);

    const gate = canRecord({
      customerStatus: rec.customer_consent_status,
      customerConsentAt: rec.customer_consent_at,
      technicianConsentAt: rec.technician_consent_at,
      disclosureShownAt: rec.disclosure_shown_at,
    });
    if (!gate.ok) return json({ error: gate.reason ?? "Consent is missing." }, 403);
    if (!rec.audio_path) return json({ error: "There is no audio to analyse." }, 409);

    if (rec.status === "analyzed") return json({ ok: true, alreadyAnalyzed: true });

    // ── Per-account hourly cap ────────────────────────────────────────────────
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await admin.from("conversation_recordings").select("id", { count: "exact", head: true })
      .eq("user_id", rec.user_id).in("status", ["analyzing", "analyzed"]).gte("updated_at", since);
    if ((count ?? 0) >= MAX_ANALYSES_PER_HOUR) return json({ error: "Hourly analysis limit reached. Try again shortly." }, 429);

    // ── Atomic claim (uploaded/failed, or a stale 'analyzing') ───────────────
    const staleBefore = new Date(Date.now() - STALE_ANALYZING_MS).toISOString();
    const { data: claimed } = await admin.from("conversation_recordings")
      .update({ status: "analyzing", analysis_error: null })
      .eq("id", rec.id)
      .or(`status.in.(uploaded,failed),and(status.eq.analyzing,updated_at.lt.${staleBefore})`)
      .select("id");
    if (!claimed || claimed.length === 0) return json({ error: "This recording is already being analysed." }, 409);
    claimedId = rec.id;

    // ── Audio -> Gemini ───────────────────────────────────────────────────────
    const dl = await admin.storage.from(BUCKET).download(rec.audio_path);
    if (dl.error || !dl.data) throw new Error("The audio file could not be read.");
    if (dl.data.size > MAX_AUDIO_BYTES) throw new Error("The audio file is over 10 MB.");
    const buf = new Uint8Array(await dl.data.arrayBuffer());

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const generationConfig: Record<string, unknown> = {
      temperature: 0.1,
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
      responseSchema: ANALYSIS_RESPONSE_SCHEMA,
    };
    if (model.includes("2.5")) generationConfig.thinkingConfig = { thinkingBudget: 1024 };

    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: ANALYSIS_SYSTEM_PROMPT }] },
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: audioMime(rec.audio_path, rec.audio_mime), data: toBase64(buf) } },
            { text: "Analyse this consented in-home conversation." },
          ],
        }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      console.error("[conversation-intel-analyze] Gemini error", res.status, (await res.text().catch(() => "")).slice(0, 300));
      throw new Error("The AI is temporarily unavailable. Try again shortly.");
    }
    const data = await res.json();
    if (data?.promptFeedback?.blockReason) throw new Error("The AI could not process this recording.");
    const rawText: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    const analysis = validateAnalysis(extractJson(rawText));
    if (!analysis.transcript) throw new Error("No speech could be transcribed from this recording.");
    const insights = dedupeInsights(analysis.insights);

    // ── Persist ───────────────────────────────────────────────────────────────
    const endedAt = rec.ended_at ? new Date(rec.ended_at) : new Date();
    const dueFor = (i: RawInsight) => (i.kind === "commitment" ? computeDueAt(endedAt, i.due_hours_estimate) : null);

    const insightRows = insights.map((i) => ({
      user_id: rec.user_id, recording_id: rec.id, kind: i.kind, insight_key: insightKey(i.kind, i.text),
      text: i.text, speaker: i.speaker, severity: i.severity, evidence: i.evidence,
      due_description: i.due_description, due_at: dueFor(i), resolved: i.resolved, note: i.note,
    }));

    let newlyInserted = new Set<string>();
    if (insightRows.length > 0) {
      const { data: ins, error: insErr } = await admin.from("conversation_insights")
        .upsert(insightRows, { onConflict: "recording_id,insight_key", ignoreDuplicates: true }).select("insight_key");
      if (insErr) throw new Error("Could not save the insights.");
      newlyInserted = new Set((ins ?? []).map((r: { insight_key: string }) => r.insight_key));
    }
    const { data: stored } = await admin.from("conversation_insights")
      .select("id, kind, insight_key, text, severity, due_at, due_description").eq("recording_id", rec.id);
    const idByKey = new Map((stored ?? []).map((r: { id: string; insight_key: string }) => [r.insight_key, r.id]));

    const { data: member } = rec.technician_member_id
      ? await admin.from("team_members").select("member_name, member_email, user_id").eq("id", rec.technician_member_id).maybeSingle()
      : { data: null };
    const techName: string | null = member?.member_name ?? member?.member_email ?? null;

    // Commitment Graph (idempotent via UNIQUE (source_type, source_id, source_excerpt))
    for (const i of insights.filter((x) => x.kind === "commitment")) {
      const key = insightKey(i.kind, i.text);
      const dueAt = dueFor(i);
      const { data: c } = await admin.from("commitments").upsert({
        user_id: rec.user_id, source_type: "conversation", source_id: rec.id, source_excerpt: i.text,
        owner_type: "technician", owner_team_member_id: rec.technician_member_id, owner_name: techName,
        customer_name: rec.customer_name, job_id: rec.job_id, commitment_text: i.text,
        deadline_text: i.due_description, deadline_at: dueAt, confidence: dueAt ? "high" : "medium",
      }, { onConflict: "source_type,source_id,source_excerpt" }).select("id").maybeSingle();
      const insightId = idByKey.get(key);
      if (c?.id && insightId) await admin.from("conversation_insights").update({ commitment_id: c.id }).eq("id", insightId);
    }

    // Follow-up tasks (idempotent via UNIQUE (source_insight_id); never overwrites a person's edits)
    if (settings.auto_create_tasks) {
      const taskRows: Record<string, unknown>[] = [];
      for (const i of insights) {
        const insightId = idByKey.get(insightKey(i.kind, i.text));
        const draft = insightId ? buildTaskDraft(i, { customerName: rec.customer_name, endedAt }) : null;
        if (!insightId || !draft) continue;
        taskRows.push({
          user_id: rec.user_id, created_by: null, source_insight_id: insightId, job_id: rec.job_id,
          assigned_to: i.kind === "commitment" ? (member?.user_id ?? rec.technician_user_id ?? null) : null,
          assigned_to_name: i.kind === "commitment" ? techName : null,
          title: draft.title, description: draft.description, priority: draft.priority, due_at: draft.due_at,
        });
      }
      if (taskRows.length > 0) {
        await admin.from("tasks").upsert(taskRows, { onConflict: "source_insight_id", ignoreDuplicates: true });
        const ids = taskRows.map((t) => t.source_insight_id as string);
        const { data: tasks } = await admin.from("tasks").select("id, source_insight_id").in("source_insight_id", ids);
        for (const t of tasks ?? []) {
          await admin.from("conversation_insights").update({ task_id: t.id }).eq("id", t.source_insight_id);
        }
      }
    }

    // Safety: notify once per NEW high/critical item
    for (const s of safetyAlertNeeded(insights)) {
      if (!newlyInserted.has(insightKey(s.kind, s.text))) continue;
      await admin.from("notifications").insert({
        user_id: rec.user_id, type: "ai_insight",
        title: s.severity === "critical" ? "Critical safety concern flagged" : "Safety concern flagged",
        message: `${rec.customer_name ?? "A customer"}: ${s.text}`.slice(0, 240),
        action_url: "/dashboard/conversations",
      });
    }

    // Coaching note (one per recording; refreshed on re-analysis)
    const c = analysis.coaching;
    await admin.from("conversation_coaching_notes").upsert({
      user_id: rec.user_id, recording_id: rec.id, technician_member_id: rec.technician_member_id,
      summary: c.summary || null, strengths: c.strengths, improvements: c.improvements, focus_next: c.focus_next,
      score_communication: c.scores.communication, score_commitment_clarity: c.scores.commitment_clarity,
      score_objection_handling: c.scores.objection_handling, score_safety_awareness: c.scores.safety_awareness,
      score_upsell_discovery: c.scores.upsell_discovery,
    }, { onConflict: "recording_id" });

    await admin.from("conversation_recordings").update({
      status: "analyzed", transcript: analysis.transcript, summary: c.summary || null, analyzed_at: new Date().toISOString(),
    }).eq("id", rec.id);

    return json({ ok: true, insights: insights.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Something went wrong analysing this recording.";
    console.error("[conversation-intel-analyze] failed", message);
    if (admin && claimedId) {
      await admin.from("conversation_recordings")
        .update({ status: "failed", analysis_error: message.slice(0, 500) }).eq("id", claimedId);
    }
    return json({ error: message }, 502);
  }
});
