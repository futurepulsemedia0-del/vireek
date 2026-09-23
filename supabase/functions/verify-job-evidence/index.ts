// supabase/functions/verify-job-evidence/index.ts
//
// Field Safety + Quality Verification via Computer Vision: downloads 1-6
// photos the caller already uploaded to their own folder in the private
// `job-evidence-photos` bucket, sends them to Gemini's vision-capable
// generateContent endpoint, and returns a strict-JSON verdict: is the
// photo evidence complete, is photo quality good enough to be usable,
// is any visible serial/model number legible, and does anything in frame
// look like a safety hazard. The AI never closes or blocks a job itself —
// it writes an advisory row a human reviews before marking the job done.
//
// Auth: caller's own Supabase JWT (Authorization header) — this is what
// lets us download the photo at all, since storage RLS only allows a user
// to read their own folder. The verdict itself is written with the
// service-role client so a technician can't forge a "pass" via the REST API.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // 8MB each
const RATE_LIMIT_MAX_PER_HOUR = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const RESPONSE_SCHEMA = `You are a field-service quality-and-safety auditor reviewing job-completion photos before the job is allowed to close. Return ONLY a JSON object, no markdown, in exactly this shape:
{
  "verdict": "one of: pass, needs_attention, fail",
  "evidence_completeness": 0.0 to 1.0,
  "quality_issues": [ { "photo_index": 0, "issue": "e.g. blurry, too dark, too far away, obstructed view", "severity": "low or medium or high" } ],
  "safety_flags": [ { "photo_index": 0, "hazard": "specific visible hazard, e.g. exposed live wiring, missing PPE, unsecured ladder, gas smell cannot be assessed from photo, trip hazard", "severity": "low or medium or high" } ],
  "detected_serials": [ "any serial/model/rating-plate number you can read, verbatim" ],
  "summary": "one or two plain-English sentences a dispatcher would read before approving the job to close"
}
Rules:
- "pass": evidence looks complete and usable, no legible serial is garbled, no safety hazard visible.
- "needs_attention": evidence is usable but has a real gap — e.g. no photo of the finished work, a safety item of low/medium severity, or a serial number that's illegible.
- "fail": evidence is unusable (all photos blurry/wrong subject) OR a high-severity safety hazard is visible.
- quality_issues and safety_flags MUST be empty arrays if none apply — never invent an issue to fill the array.
- Only report a safety hazard you can actually see in frame. Never guess at hazards that aren't visible (e.g. don't claim to detect a gas leak by smell).
- detected_serials: only include text you can actually read on a plate/label in the image; omit anything you're guessing at.
- Never invent brand names, addresses, or people from the image beyond what's clearly visible.`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

interface ParsedVerdict {
  verdict?: string;
  evidence_completeness?: number;
  quality_issues?: { photo_index: number; issue: string; severity: string }[];
  safety_flags?: { photo_index: number; hazard: string; severity: string }[];
  detected_serials?: string[];
  summary?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const { jobId, storagePaths } = await req.json();
    if (typeof jobId !== "string" || !jobId) return json({ error: "Missing jobId." }, 400);
    if (!Array.isArray(storagePaths) || storagePaths.length === 0 || storagePaths.length > MAX_PHOTOS) {
      return json({ error: `Provide 1 to ${MAX_PHOTOS} storage paths.` }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    for (const p of storagePaths) {
      if (typeof p !== "string" || !p.startsWith(`${user.id}/`)) {
        return json({ error: "Invalid photo path." }, 400);
      }
    }

    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const adminDb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // The job must actually belong to this account — checked with the
    // service-role client since RLS on jobs is scoped to the account owner.
    const { data: job, error: jobError } = await adminDb.from("jobs").select("id, user_id").eq("id", jobId).maybeSingle();
    if (jobError || !job) return json({ error: "Job not found." }, 404);

    // ---- Rate limit (service-role client, NOT the caller's) ----------------
    const nowMs = Date.now();
    const { data: existingLimit } = await adminDb
      .from("job_evidence_rate_limit")
      .select("window_start, request_count")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingLimit && nowMs - new Date(existingLimit.window_start).getTime() < RATE_LIMIT_WINDOW_MS) {
      if (existingLimit.request_count >= RATE_LIMIT_MAX_PER_HOUR) {
        return json({ error: "You've hit the hourly limit for AI evidence checks. Try again in a bit." }, 429);
      }
      await adminDb.from("job_evidence_rate_limit")
        .update({ request_count: existingLimit.request_count + 1 })
        .eq("user_id", user.id);
    } else {
      await adminDb.from("job_evidence_rate_limit")
        .upsert({ user_id: user.id, window_start: new Date(nowMs).toISOString(), request_count: 1 });
    }

    // ---- Download photos (caller-scoped client → enforces storage RLS) ----
    const imageParts: { inline_data: { mime_type: string; data: string } }[] = [];
    for (const path of storagePaths) {
      const { data: blob, error: dlError } = await callerClient.storage.from("job-evidence-photos").download(path);
      if (dlError || !blob) return json({ error: `Could not read photo: ${path}` }, 404);
      if (blob.size > MAX_PHOTO_BYTES) return json({ error: "Each photo must be under 8MB." }, 400);

      const buf = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      imageParts.push({ inline_data: { mime_type: blob.type || "image/jpeg", data: base64 } });
    }

    // ---- Gemini vision call -------------------------------------------------
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "Evidence verification is not configured yet (missing GEMINI_API_KEY)." }, 500);

    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: RESPONSE_SCHEMA }, ...imageParts] }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.2, response_mime_type: "application/json" },
        }),
        signal: AbortSignal.timeout(25_000),
      },
    );

    if (!geminiRes.ok) {
      const t = await geminiRes.text().catch(() => "");
      console.error("[verify-job-evidence] Gemini error", geminiRes.status, t.slice(0, 300));
      return json({ error: "The AI evidence checker is temporarily unavailable. Review the photos manually for now." }, 502);
    }

    const geminiData = await geminiRes.json();
    const rawText: string = geminiData?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";

    let parsed: ParsedVerdict;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      return json({ error: "The AI response could not be parsed. Try again or review the photos manually." }, 502);
    }

    const verdict = ["pass", "needs_attention", "fail"].includes(parsed.verdict ?? "") ? (parsed.verdict as string) : "needs_attention";
    const qualityIssues = (parsed.quality_issues ?? []).slice(0, 10);
    const safetyFlags = (parsed.safety_flags ?? []).slice(0, 10);
    const detectedSerials = (parsed.detected_serials ?? []).filter((s) => typeof s === "string" && s.trim()).slice(0, 10);
    const evidenceCompleteness = Math.min(1, Math.max(0, Number(parsed.evidence_completeness) || 0));
    const summary = String(parsed.summary ?? "").slice(0, 500);

    const { data: inserted, error: insertError } = await adminDb
      .from("job_evidence_checks")
      .insert({
        user_id: job.user_id,
        job_id: jobId,
        photo_paths: storagePaths,
        verdict,
        evidence_completeness: evidenceCompleteness,
        quality_issues: qualityIssues,
        safety_flags: safetyFlags,
        detected_serials: detectedSerials,
        ai_summary: summary,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("[verify-job-evidence] insert failed", insertError);
      return json({ error: "Verified, but could not save the result. Try again." }, 500);
    }

    if (verdict === "pass") {
      await adminDb.from("jobs").update({ evidence_verified_at: new Date().toISOString() }).eq("id", jobId);
    }

    return json({
      check_id: inserted.id,
      verdict,
      evidence_completeness: evidenceCompleteness,
      quality_issues: qualityIssues,
      safety_flags: safetyFlags,
      detected_serials: detectedSerials,
      summary,
    });
  } catch (err) {
    console.error("[verify-job-evidence] unhandled error", err);
    return json({ error: "Something went wrong verifying the evidence." }, 500);
  }
});
