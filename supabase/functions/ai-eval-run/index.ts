// supabase/functions/ai-eval-run/index.ts
//
// یک eval suite کامل رو اجرا و نتیجه رو ثبت می‌کنه. فقط برای owner/admin
// همون اکانتی که suite بهش تعلق داره مجازه — چون اجرای suite یعنی تماس
// واقعی (و billed) با AI Core، پس باید هم‌سطح تغییر تنظیمات billing
// محافظت بشه، نه فقط دسترسی خواندنی.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { runEvalCase, type EvalCaseInput } from "../_shared/ai-core/evalHarness.ts";
import type { TaskType } from "../_shared/ai-core/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { suiteId } = await req.json();
    if (!suiteId) {
      return new Response(JSON.stringify({ error: "suiteId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await callerClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: suite, error: suiteErr } = await admin
      .from("ai_eval_suites")
      .select("id, account_id, task")
      .eq("id", suiteId)
      .maybeSingle();

    if (suiteErr || !suite) {
      return new Response(JSON.stringify({ error: "Suite not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Access check: caller باید owner/admin همین اکانت باشه — یا خودِ
    // اکانت، یا یک عضو تیم با همون نقش.
    const { data: ownProfile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const isDirectAdmin = user.id === suite.account_id && !!ownProfile && ["owner", "admin"].includes(ownProfile.role);

    let isTeamAdmin = false;
    if (!isDirectAdmin) {
      const { data: membership } = await admin
        .from("team_members")
        .select("role, member_email")
        .eq("account_owner_id", suite.account_id)
        .eq("member_email", user.email)
        .maybeSingle();
      isTeamAdmin = !!membership && ["owner", "admin"].includes(membership.role);
    }

    if (!isDirectAdmin && !isTeamAdmin) {
      return new Response(JSON.stringify({ error: "Not authorized to run this suite" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: cases } = await admin
      .from("ai_eval_cases")
      .select("id, user_message, extra_instructions, json_mode, assertions")
      .eq("suite_id", suiteId);

    const { data: run } = await admin
      .from("ai_eval_runs")
      .insert({
        suite_id: suiteId,
        account_id: suite.account_id,
        status: "running",
        triggered_by: user.id,
        case_count: cases?.length ?? 0,
      })
      .select("id")
      .single();

    const results = [];
    for (const c of cases ?? []) {
      const kase: EvalCaseInput = {
        id: c.id,
        userMessage: c.user_message,
        extraInstructions: c.extra_instructions,
        jsonMode: c.json_mode,
        assertions: c.assertions ?? [],
      };
      const result = await runEvalCase(suite.task as TaskType, kase, suite.account_id);
      results.push(result);

      await admin.from("ai_eval_results").insert({
        run_id: run!.id,
        case_id: c.id,
        passed: result.passed,
        assertions_failed: result.failedAssertions,
        hallucination_detected: result.hallucinationDetected,
        hallucination_reason: result.hallucinationReason,
        provider: result.provider,
        model: result.model,
        latency_ms: result.latencyMs,
        cost_usd: result.costUsd,
        output_text: result.outputText,
      });
    }

    const passCount = results.filter((r) => r.passed).length;
    const hallucinationCount = results.filter((r) => r.hallucinationDetected).length;
    const avgLatency = results.length ? Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length) : 0;
    const totalCost = results.reduce((s, r) => s + r.costUsd, 0);

    await admin
      .from("ai_eval_runs")
      .update({
        status: "completed",
        pass_count: passCount,
        fail_count: results.length - passCount,
        hallucination_count: hallucinationCount,
        avg_latency_ms: avgLatency,
        total_cost_usd: totalCost,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run!.id);

    return new Response(
      JSON.stringify({ runId: run!.id, caseCount: results.length, passCount, hallucinationCount, avgLatency, totalCost }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[ai-eval-run] failed:", err);
    return new Response(JSON.stringify({ error: "Internal error running eval suite" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
