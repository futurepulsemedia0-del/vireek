// supabase/functions/ai-assistant-query/index.ts
//
// ============================================================
// SECURITY MODEL (read this before changing anything below)
// ============================================================
// The LLM is NEVER allowed to generate or run SQL, and it never sees a
// database connection. Its only job is to map the user's question onto one
// of the fixed `INTENTS` below (a strict enum) plus a few whitelisted
// parameters. The actual data fetch for each intent is a hardcoded
// supabase-js query written by us, not by the model — so even a fully
// "jailbroken" model response can only ever select one of these prewritten,
// read-only queries. There is no code path from user input to a write
// (insert/update/delete) operation anywhere in this function.
//
// Row scoping is enforced by Postgres RLS, not by this function: the
// Supabase client below is created with the *caller's own JWT* (forwarded
// from the Authorization header), so every query runs as that user and is
// automatically restricted to their account by the same RLS policies that
// protect every other page in the app (via `get_account_owner_id()`).
// There is no service-role client and no client-supplied user_id anywhere
// in this file.
//
// LLM provider: routed through the Vireek AI Core (_shared/ai-core). If
// Gemini fails (invalid key, quota, outage) it falls back automatically
// to Groq, then Cerebras, then OpenRouter — see registry.ts for the exact
// chain. Both LLM calls below (classify + answer) go through the SAME
// router, so a provider outage never breaks the dashboard assistant.

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Intent =
  | "calls_count"
  | "emergency_calls_by_service"
  | "leads_uncontacted"
  | "jobs_today"
  | "jobs_by_status"
  | "revenue_this_month"
  | "top_customers"
  | "unsupported";

interface IntentPlan {
  intent: Intent;
  period?: "today" | "this_week" | "this_month" | "last_7_days" | "last_30_days";
}

const INTENT_DESCRIPTIONS = `
- "calls_count": how many calls came in over a period. params: { "period": "today" | "this_week" | "this_month" | "last_7_days" | "last_30_days" }
- "emergency_calls_by_service": which service type gets the most emergency calls (uses linked leads).
- "leads_uncontacted": leads still sitting in the "new" stage that haven't been contacted yet.
- "jobs_today": jobs scheduled for today.
- "jobs_by_status": breakdown of jobs by their current status.
- "revenue_this_month": total invoiced revenue (paid invoices) so far this month.
- "top_customers": the customers who have generated the most invoiced revenue.
- "unsupported": the question isn't about this business's calls/leads/jobs data, asks for a write/change, or is otherwise out of scope.
`.trim();

function periodStart(period: IntentPlan["period"]): string {
  const now = new Date();
  const d = new Date(now);
  switch (period) {
    case "today":
      d.setHours(0, 0, 0, 0);
      break;
    case "this_week": {
      const day = d.getDay();
      const diff = (day + 6) % 7; // Monday as start of week
      d.setDate(d.getDate() - diff);
      d.setHours(0, 0, 0, 0);
      break;
    }
    case "last_7_days":
      d.setDate(d.getDate() - 7);
      break;
    case "last_30_days":
      d.setDate(d.getDate() - 30);
      break;
    case "this_month":
    default:
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      break;
  }
  return d.toISOString();
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    const { question } = await req.json();
    if (!question || typeof question !== "string" || question.length > 500) {
      return new Response(JSON.stringify({ error: "A question (max 500 chars) is required." }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    // Client scoped to the CALLER's own session (their JWT), never the
    // service role — RLS does all the account-boundary enforcement below.
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated." }), {
        status: 401,
        headers: jsonHeaders,
      });
    }

    // -------------------------------------------------------------
    // Rate limit: authenticated users still get a cap (unlike the public
    // demo chat, this is per-user rather than per-IP, and more generous
    // since these are paying customers, not anonymous visitors). Same
    // fixed-window pattern as `demo_chat_rate_limit`. Uses the caller's
    // own JWT-scoped client, so RLS (not a service-role bypass) enforces
    // that a user can only ever touch their own counter row.
    // -------------------------------------------------------------
    const RATE_LIMIT_MAX_PER_HOUR = 30;
    const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
    const nowMs = Date.now();

    const { data: existingLimit } = await supabase
      .from("ai_assistant_rate_limit")
      .select("window_start, request_count")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingLimit) {
      const windowAgeMs = nowMs - new Date(existingLimit.window_start).getTime();
      if (windowAgeMs < RATE_LIMIT_WINDOW_MS) {
        if (existingLimit.request_count >= RATE_LIMIT_MAX_PER_HOUR) {
          return new Response(
            JSON.stringify({
              error: "You've hit the AI Assistant's hourly question limit. Try again in a bit.",
            }),
            { status: 429, headers: jsonHeaders },
          );
        }
        await supabase
          .from("ai_assistant_rate_limit")
          .update({ request_count: existingLimit.request_count + 1 })
          .eq("user_id", user.id);
      } else {
        await supabase
          .from("ai_assistant_rate_limit")
          .update({ window_start: new Date(nowMs).toISOString(), request_count: 1 })
          .eq("user_id", user.id);
      }
    } else {
      await supabase.from("ai_assistant_rate_limit").insert({
        user_id: user.id,
        window_start: new Date(nowMs).toISOString(),
        request_count: 1,
      });
    }

    // -------------------------------------------------------------
    // Step 1: classify the question into a fixed intent (never SQL).
    // Routed through the AI Core — automatic fallback across providers.
    // -------------------------------------------------------------
    let plan: IntentPlan;
    try {
      const result = await askVireekAi({
        task: "intent_classify",
        messages: [{ role: "user", content: question }],
        maxTokens: 150,
        jsonMode: true,
        extraInstructions: `Available intents:\n${INTENT_DESCRIPTIONS}\n\nRespond with ONLY a JSON object shaped { "intent": "...", "period": "..." } (period only for "calls_count", optional otherwise) and nothing else — no prose, no markdown fences.`,
      });
      plan = extractJson(result.text) as IntentPlan;
      console.log(
        `[ai-assistant-query] classify provider=${result.meta.provider} model=${result.meta.model} ` +
          `fallback=${result.meta.wasFallback} latencyMs=${result.meta.latencyMs}`,
      );
    } catch (err) {
      console.error("[ai-assistant-query] classify failed on ALL providers:", err);
      plan = { intent: "unsupported" };
    }

    const validIntents: Intent[] = [
      "calls_count",
      "emergency_calls_by_service",
      "leads_uncontacted",
      "jobs_today",
      "jobs_by_status",
      "revenue_this_month",
      "top_customers",
      "unsupported",
    ];
    if (!validIntents.includes(plan.intent)) plan.intent = "unsupported";

    if (plan.intent === "unsupported") {
      return new Response(
        JSON.stringify({
          answer:
            "I can only answer questions about your own calls, leads, and jobs in Vireek — try asking things like \"how many calls this week\" or \"which leads haven't been contacted yet.\"",
          rows: [],
          columns: [],
        }),
        { headers: jsonHeaders },
      );
    }

    // -------------------------------------------------------------
    // Step 2: run the ONE hardcoded, read-only query for that intent.
    // UNCHANGED — no model input reaches this switch at all.
    // -------------------------------------------------------------
    let rows: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let factsForModel = "";

    switch (plan.intent) {
      case "calls_count": {
        const since = periodStart(plan.period ?? "this_week");
        const { count, error } = await supabase
          .from("calls")
          .select("id", { count: "exact", head: true })
          .gte("call_datetime", since);
        if (error) throw error;
        columns = ["Period", "Calls"];
        rows = [{ Period: plan.period ?? "this_week", Calls: count ?? 0 }];
        factsForModel = `Call count since ${since}: ${count ?? 0}`;
        break;
      }
      case "emergency_calls_by_service": {
        const { data, error } = await supabase
          .from("calls")
          .select("id, leads(service_interested)")
          .eq("is_emergency", true)
          .limit(500);
        if (error) throw error;
        const counts: Record<string, number> = {};
        for (const row of data ?? []) {
          const leadArr = (row as { leads?: { service_interested: string | null }[] | { service_interested: string | null } | null }).leads;
          const lead = Array.isArray(leadArr) ? leadArr[0] : leadArr;
          const service = lead?.service_interested ?? "Unspecified";
          counts[service] = (counts[service] ?? 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
        columns = ["Service type", "Emergency calls"];
        rows = sorted.map(([service, n]) => ({ "Service type": service, "Emergency calls": n }));
        factsForModel = `Emergency calls grouped by linked service type: ${JSON.stringify(sorted)}`;
        break;
      }
      case "leads_uncontacted": {
        const { data, error } = await supabase
          .from("leads")
          .select("name, phone, service_interested, created_at")
          .eq("stage", "new")
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) throw error;
        columns = ["Name", "Phone", "Service", "Received"];
        rows = (data ?? []).map((l) => ({
          Name: l.name,
          Phone: l.phone ?? "—",
          Service: l.service_interested ?? "—",
          Received: new Date(l.created_at).toLocaleDateString(),
        }));
        factsForModel = `${data?.length ?? 0} leads still uncontacted (stage = "new").`;
        break;
      }
      case "jobs_today": {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const { data, error } = await supabase
          .from("jobs")
          .select("customer_name, service_type, scheduled_datetime, job_status")
          .gte("scheduled_datetime", start.toISOString())
          .lt("scheduled_datetime", end.toISOString())
          .order("scheduled_datetime", { ascending: true });
        if (error) throw error;
        columns = ["Customer", "Service", "Time", "Status"];
        rows = (data ?? []).map((j) => ({
          Customer: j.customer_name,
          Service: j.service_type ?? "—",
          Time: j.scheduled_datetime ? new Date(j.scheduled_datetime).toLocaleTimeString() : "—",
          Status: j.job_status,
        }));
        factsForModel = `${data?.length ?? 0} jobs scheduled today.`;
        break;
      }
      case "jobs_by_status": {
        const { data, error } = await supabase.from("jobs").select("job_status");
        if (error) throw error;
        const counts: Record<string, number> = {};
        for (const j of data ?? []) counts[j.job_status] = (counts[j.job_status] ?? 0) + 1;
        columns = ["Status", "Jobs"];
        rows = Object.entries(counts).map(([status, n]) => ({ Status: status, Jobs: n }));
        factsForModel = `Job counts by status: ${JSON.stringify(counts)}`;
        break;
      }
      case "revenue_this_month": {
        const since = periodStart("this_month");
        const { data, error } = await supabase
          .from("jobs")
          .select("invoice_amount")
          .eq("invoice_status", "paid")
          .gte("created_at", since);
        if (error) throw error;
        const total = (data ?? []).reduce((sum, j) => sum + (j.invoice_amount ?? 0), 0);
        columns = ["Metric", "Amount"];
        rows = [{ Metric: "Paid revenue this month", Amount: `$${total.toFixed(2)}` }];
        factsForModel = `Total paid invoice revenue since ${since}: $${total.toFixed(2)} across ${data?.length ?? 0} jobs.`;
        break;
      }
      case "top_customers": {
        const { data, error } = await supabase
          .from("jobs")
          .select("customer_name, invoice_amount")
          .not("invoice_amount", "is", null);
        if (error) throw error;
        const totals: Record<string, number> = {};
        for (const j of data ?? []) totals[j.customer_name] = (totals[j.customer_name] ?? 0) + (j.invoice_amount ?? 0);
        const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
        columns = ["Customer", "Total invoiced"];
        rows = sorted.map(([name, total]) => ({ Customer: name, "Total invoiced": `$${total.toFixed(2)}` }));
        factsForModel = `Top customers by invoiced amount: ${JSON.stringify(sorted)}`;
        break;
      }
    }

    // -------------------------------------------------------------
    // Step 3: facts -> natural language, via the AI Core (same
    // fallback chain). The model only sees aggregate facts, not raw
    // table access, and cannot request more data.
    // -------------------------------------------------------------
    let answer: string;
    try {
      const result = await askVireekAi({
        task: "dashboard_answer",
        messages: [
          { role: "user", content: `Question: "${question}"\n\nFacts: ${factsForModel || "No matching data was found."}` },
        ],
        maxTokens: 300,
      });
      answer = result.text.trim();
      console.log(
        `[ai-assistant-query] answer provider=${result.meta.provider} model=${result.meta.model} ` +
          `fallback=${result.meta.wasFallback} latencyMs=${result.meta.latencyMs}`,
      );
    } catch (err) {
      console.error("[ai-assistant-query] answer step failed on ALL providers:", err);
      answer = factsForModel || "I couldn't find an answer to that — try rephrasing.";
    }

    return new Response(JSON.stringify({ answer: answer || factsForModel, rows, columns }), { headers: jsonHeaders });
  } catch (err) {
    return new Response(
      JSON.stringify({
        answer: "I couldn't find an answer to that — try rephrasing.",
        error: err instanceof Error ? err.message : String(err),
        rows: [],
        columns: [],
      }),
      { status: 200, headers: jsonHeaders },
    );
  }
});
