// supabase/functions/analyze-job-compliance/index.ts
//
// AI Permit / Code / Compliance Engine.
//
// Input : { jobId, force?: boolean, jurisdictionOverride?: string }
// Output: a persisted compliance review for the job - jurisdiction, permit
//         likelihood, and a prioritised list of permit / inspection /
//         licensing / safety / documentation / regulation requirements.
//
// Pipeline
//   1. Deterministic rule engine (always runs, free, testable) - the backbone.
//   2. AI layer (Gemini) adds job- and jurisdiction-specific context. It can
//      only ADD items (capped at "warning"); see _shared/permit-rules/ai.ts.
//   3. If the AI is unavailable or unconfigured the rule-based review is
//      still saved and returned (ai_status = "unavailable" | "skipped").
//
// Cost control: a review is cached by a hash of the job facts + rules version;
// an unchanged job is served from the database with no AI call.
//
// Auth  : the caller's own JWT. Job/equipment reads run as the caller so RLS
//         isolates tenants. The service-role client is used ONLY for the quota
//         RPC and the final upsert - same pattern as generate-mission-brief.
//         Per-requirement progress (item_progress) is never touched here, so
//         it survives regeneration.
//
// Secrets: GEMINI_API_KEY (optional - without it reviews are rules-only),
//          GEMINI_MODEL (optional).

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";
import { evaluateJob } from "../_shared/permit-rules/engine.ts";
import { parseJurisdiction } from "../_shared/permit-rules/jurisdiction.ts";
import { RULES_VERSION } from "../_shared/permit-rules/rules.ts";
import {
  buildUserPrompt, extractJson, mergeLikelihood, normalizeAi, RESPONSE_SCHEMA, ruleSummary, SYSTEM_PROMPT,
} from "../_shared/permit-rules/ai.ts";
import { sortItems } from "../_shared/permit-rules/engine.ts";
import type { JobFacts } from "../_shared/permit-rules/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const QUOTA_MAX_PER_HOUR = 40;
const QUOTA_WINDOW_SECONDS = 3600;
const CACHE_MAX_AGE_MS = 30 * 86_400_000;

type Loose = any; // deno-lint-ignore no-explicit-any

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function callGemini(model: string, apiKey: string, prompt: string) {
  return await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1100,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const body = await req.json().catch(() => null);
    const jobId: string | null = body && typeof body.jobId === "string" && body.jobId ? body.jobId : null;
    if (!jobId) return json({ error: "jobId is required." }, 400);
    const force = body?.force === true;
    const override: string | null =
      typeof body?.jurisdictionOverride === "string" && body.jurisdictionOverride.trim()
        ? body.jurisdictionOverride.trim().slice(0, 160)
        : null;

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const callerClient: SupabaseClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    const { data: ownerId, error: ownerError } = await callerClient.rpc("get_account_owner_id");
    if (ownerError || !ownerId) return json({ error: "Could not resolve your account." }, 500);

    // ---- Job (caller-scoped, RLS applies) ------------------------------------
    const { data: job, error: jobError } = await callerClient
      .from("jobs")
      .select("id, service_type, address, customer_country, customer_type, dispatch_note, technician_diagnosis, is_rework, tags")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError) return json({ error: "Could not load this job." }, 500);
    if (!job) return json({ error: "Job not found." }, 404);
    if (!job.service_type && !job.dispatch_note) {
      return json({ error: "This job needs a service type or dispatch note before a compliance review can be built." }, 400);
    }

    // Emergency flag lives on calls, not jobs, so derive it from job tags/notes only.
    const tags: string[] = Array.isArray(job.tags) ? job.tags.filter((t: unknown) => typeof t === "string").slice(0, 20) : [];
    const isEmergency = tags.some((t) => /emergenc/i.test(t)) || /\bemergenc/i.test(`${job.service_type ?? ""} ${job.dispatch_note ?? ""}`);

    // Business country as the jurisdiction hint (owner profile), then customer country.
    const { data: profile } = await callerClient.from("profiles").select("business_country").eq("id", ownerId).maybeSingle();

    // ---- Linked equipment (first unit) -----------------------------------------
    const { data: jobEquipmentRow } = await callerClient
      .from("job_equipment")
      .select("equipment:equipment_id (equipment_type, make, model)")
      .eq("job_id", jobId)
      .limit(1)
      .maybeSingle();
    const eq = (jobEquipmentRow?.equipment as Loose) ?? null;
    const equipmentType = eq ? [eq.equipment_type, eq.make, eq.model].filter(Boolean).join(" ") || null : null;

    const facts: JobFacts = {
      serviceType: job.service_type ?? null,
      dispatchNote: job.dispatch_note ?? null,
      diagnosisNote: job.technician_diagnosis ?? null,
      address: override ?? job.address ?? null,
      countryHint: job.customer_country ?? profile?.business_country ?? null,
      customerType: job.customer_type === "commercial" ? "commercial" : job.customer_type === "residential" ? "residential" : null,
      isEmergency,
      isRework: !!job.is_rework,
      tags,
      equipmentType,
    };

    const inputHash = await sha256(JSON.stringify({ facts, v: RULES_VERSION }));

    // ---- Cache: unchanged job + healthy AI result => no work, no AI cost ----
    if (!force) {
      const { data: cached } = await callerClient.from("job_compliance_reviews").select("*").eq("job_id", jobId).maybeSingle();
      if (
        cached && cached.input_hash === inputHash && cached.ai_status !== "unavailable" &&
        Date.now() - new Date(cached.generated_at).getTime() < CACHE_MAX_AGE_MS
      ) {
        return json(cached);
      }
    }

    const serviceClient: SupabaseClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });

    const { data: allowed, error: quotaError } = await serviceClient.rpc("consume_compliance_review_quota", {
      p_user_id: user.id,
      p_max: QUOTA_MAX_PER_HOUR,
      p_window_seconds: QUOTA_WINDOW_SECONDS,
    });
    if (quotaError) {
      console.error("[analyze-job-compliance] quota rpc failed", quotaError.message);
      return json({ error: "Could not verify your usage limit. Try again shortly." }, 500);
    }
    if (allowed === false) return json({ error: "You've reached the hourly limit for compliance reviews. Try again in a bit." }, 429);

    // ---- 1) Deterministic engine --------------------------------------------------
    const engine = evaluateJob(facts);
    // A manual jurisdiction override that cannot be parsed must not silently pass as verified.
    if (override && engine.jurisdiction.basis === "unknown") {
      engine.jurisdiction = { ...parseJurisdiction(null, facts.countryHint), label: override.slice(0, 80) };
    }

    // ---- 2) AI layer (optional, never fatal) --------------------------------------
    let aiStatus: "ok" | "unavailable" | "skipped" = "skipped";
    let model: string | null = null;
    let summary = ruleSummary(engine);
    let likelihood = engine.permitLikelihood;
    let items = engine.items;
    let questions: string[] = [];

    const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (apiKey) {
      model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
      try {
        const res = await callGemini(model, apiKey, buildUserPrompt(engine, {
          serviceType: facts.serviceType, dispatchNote: facts.dispatchNote, diagnosisNote: facts.diagnosisNote,
          equipmentType: facts.equipmentType, customerType: facts.customerType, isEmergency,
        }));
        if (!res.ok) {
          console.error("[analyze-job-compliance] Gemini error", res.status, (await res.text().catch(() => "")).slice(0, 300));
          aiStatus = "unavailable";
        } else {
          const data = await res.json();
          const raw: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
          const ai = data?.promptFeedback?.blockReason ? null : normalizeAi(extractJson(raw), engine.items);
          if (ai) {
            aiStatus = "ok";
            summary = ai.summary;
            likelihood = mergeLikelihood(engine.permitLikelihood, ai.permit_likelihood);
            items = sortItems([...engine.items, ...ai.extra_items]);
            questions = ai.verify_questions;
          } else {
            aiStatus = "unavailable";
          }
        }
      } catch (err) {
        console.error("[analyze-job-compliance] Gemini call failed", err);
        aiStatus = "unavailable";
      }
    }
    if (aiStatus !== "ok") model = aiStatus === "skipped" ? null : model;

    // ---- 3) Persist (service role). item_progress is deliberately not written. ---
    const { data: saved, error: saveError } = await serviceClient
      .from("job_compliance_reviews")
      .upsert(
        {
          user_id: ownerId,
          job_id: jobId,
          jurisdiction: engine.jurisdiction,
          work_types: engine.workTypes,
          permit_likelihood: likelihood,
          summary,
          requirements: items,
          verify_questions: questions,
          ai_status: aiStatus,
          input_hash: inputHash,
          rules_version: RULES_VERSION,
          model,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "job_id" },
      )
      .select("*")
      .single();

    if (saveError) {
      console.error("[analyze-job-compliance] save failed", saveError.message);
      return json({ error: "The review was generated but could not be saved. Try again." }, 500);
    }
    return json(saved);
  } catch (err) {
    console.error("[analyze-job-compliance] unhandled error", err);
    return json({ error: "Something went wrong building the compliance review." }, 500);
  }
});
