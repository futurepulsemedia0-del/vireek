// supabase/functions/workflow-compiler/index.ts
//
// Vireek Workflow Compiler — "tell Vireek what should happen" -> executable graph.
//
//   instruction (plain language)
//     -> AI produces an untrusted intent graph (IR)
//     -> validateIr() (deterministic, see _shared/workflow-compiler/spec.ts)
//     -> on errors: the exact errors go back to the model for repair (max 3 attempts)
//     -> lowerIr() adds guaranteed fallbacks, buildReport() computes the risk report
//     -> stored as an IMMUTABLE draft (graph is frozen by a DB trigger)
//
// The model never touches the database and never chooses what executes: it can
// only combine the capabilities in the registry, and anything it gets wrong is
// rejected by code. Nothing is switched on here — the owner promotes a draft to
// test mode and then to live from the dashboard.
//
// DEPLOY: supabase functions deploy workflow-compiler   (JWT verification ON)

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { askVireekAi } from "../_shared/ai-core/index.ts";
import { capabilityCatalog, compileIr, TRIGGER_EVENTS, MAX_NODES } from "../_shared/workflow-compiler/spec.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

const MAX_INSTRUCTION = 2000;
const MAX_ATTEMPTS = 3;
const HOURLY_LIMIT = 20;

const EXAMPLE_IR = {
  name: "VIP HVAC emergency dispatch",
  summary: "VIP emergency HVAC calls get the best available technician within 60 minutes, price confirmed first, contractor network if the part is missing.",
  trigger: { event: "call.emergency" },
  sla_minutes: 60,
  nodes: [
    { id: "cust", kind: "lookup", label: "Look up customer", capability: "customer_profile" },
    { id: "is_vip", kind: "decision", label: "Is VIP?", rule: { path: "cust.is_vip", op: "truthy" } },
    { id: "triage", kind: "reason", label: "Assess HVAC emergency", question: "From this call summary, is it an HVAC emergency, and which part is most likely needed? Summary: {{trigger.summary}}", options: ["hvac_emergency", "not_hvac"], fields: [{ key: "likely_part", type: "string" }, { key: "failure_risk", type: "number" }] },
    { id: "is_hvac", kind: "decision", label: "HVAC emergency?", rule: { path: "triage.choice", op: "eq", value: "hvac_emergency" } },
    { id: "techs", kind: "lookup", label: "Check technicians", capability: "technician_roster" },
    { id: "part", kind: "lookup", label: "Check part stock", capability: "part_availability", params: { query_path: "triage.likely_part" } },
    { id: "price_ok", kind: "approval", label: "Confirm price before dispatch", prompt: "Confirm the price for {{customer.name}} before dispatch. Assessment: {{triage.rationale}}", timeout_minutes: 15 },
    { id: "in_stock", kind: "decision", label: "Part in stock?", rule: { path: "part.in_stock", op: "truthy" } },
    { id: "dispatch", kind: "action", label: "Dispatch best technician", capability: "dispatch_technician" },
    { id: "check", kind: "verify", label: "Technician really assigned?", capability: "job_assigned", params: { target: "dispatch" } },
    { id: "network", kind: "action", label: "Ask contractor network", capability: "post_contractor_handoff", params: { trade: "hvac", title: "Urgent HVAC emergency - {{triage.likely_part}} needed", summary: "VIP customer, same-hour response needed." } },
    { id: "tell_owner", kind: "action", label: "Tell owner (not a VIP HVAC emergency)", capability: "notify_owner", params: { title: "Emergency call, no automation", message: "An emergency call did not match the VIP HVAC workflow." } },
  ],
  edges: [
    { from: "cust", to: "is_vip", on: "next" }, { from: "is_vip", to: "triage", on: "true" }, { from: "is_vip", to: "tell_owner", on: "false" },
    { from: "triage", to: "is_hvac", on: "next" }, { from: "is_hvac", to: "techs", on: "true" }, { from: "is_hvac", to: "tell_owner", on: "false" },
    { from: "techs", to: "part", on: "next" }, { from: "part", to: "price_ok", on: "next" }, { from: "price_ok", to: "in_stock", on: "approved" },
    { from: "in_stock", to: "dispatch", on: "true" }, { from: "in_stock", to: "network", on: "false" },
    { from: "dispatch", to: "check", on: "next" }, { from: "dispatch", to: "network", on: "fail" }, { from: "check", to: "network", on: "fail" },
  ],
  assumptions: ["'Best technician' is decided by Vireek's existing dispatch ranking (skills, service area, capacity)."],
};

function systemRules(): string {
  return [
    "You are the Vireek Workflow Compiler. Convert the owner's plain-language instruction into a workflow graph as ONE JSON object. Output JSON only.",
    "",
    "SCHEMA: { name, summary, trigger:{event}, sla_minutes (int|null), nodes:[{id,kind,label,capability?,params?,question?,options?,fields?,rule?,prompt?,timeout_minutes?}], edges:[{from,to,on}], assumptions:[string] }",
    `trigger.event must be one of: ${TRIGGER_EVENTS.join(", ")}.`,
    `node kinds: lookup | reason | decision | action | approval | verify | wait. Max ${MAX_NODES} nodes. ids are lowercase_snake_case.`,
    "edge 'on' per kind: lookup/reason/wait: next (+fail for lookup/reason). decision: true AND false. action: next, fail. approval: approved, rejected, timeout. verify: pass, fail.",
    "Exactly one entry node (no incoming edge). No cycles. Every node reachable. A node only branches to nodes that make sense after it.",
    "Pipeline order to follow: trigger -> data lookups -> AI reasoning -> decisions -> human approval -> actions -> verification. Use fail edges as fallbacks (e.g. dispatch fails -> contractor network).",
    "'reason' nodes classify using ONLY options you list (2-6) and typed fields (max 5). Their outputs are choice, confidence, rationale + your fields. Branch on them with decision nodes; never let reasoning pick an action.",
    "decision.rule = {path, op, value}; op in eq|neq|gt|gte|lt|lte|truthy|falsy|in|contains; path is node.field of an EARLIER node or trigger.*/customer.*.",
    "Templates use {{node.field}} and may only reference earlier nodes, trigger.*, customer.* (name, phone). Never put phone numbers or emails in contractor titles/summaries.",
    "Commitment actions (dispatch_technician, post_contractor_handoff) MUST have an approval node before ANY branch that can reach them. If one approval gates several branches, place it before the branch.",
    "If the owner states a time limit, set sla_minutes. If they state conditions you cannot check with a listed capability, say so in assumptions instead of inventing a capability.",
    "Write name, summary, labels, prompts, messages and assumptions in the SAME LANGUAGE as the owner's instruction. Keep ids, kinds, capabilities, ops and enum values in English.",
    "",
    "CAPABILITIES (the only things you may use):",
    JSON.stringify(capabilityCatalog()),
    "",
    "EXAMPLE of a correct output for: \"If a VIP customer calls with an HVAC emergency, find the best technician within 60 minutes, confirm the price before dispatch, and check the contractor network if the part isn't available.\"",
    JSON.stringify(EXAMPLE_IR),
  ].join("\n");
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(cleaned.slice(s, e + 1));
    throw new Error("Model did not return JSON");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const authClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await authClient.auth.getUser();
    if (!user) return json({ error: "Not authenticated." }, 401);

    // Resolve the account owner so team members compile into the owner's account.
    const { data: ownerId } = await authClient.rpc("get_account_owner_id");
    const owner: string = (typeof ownerId === "string" && ownerId) || user.id;

    const body = await req.json().catch(() => ({}));
    const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
    const parentId = typeof body?.parent_id === "string" ? body.parent_id : null;
    if (instruction.length < 15) return json({ error: "Describe what should happen in a full sentence or two." }, 400);
    if (instruction.length > MAX_INSTRUCTION) return json({ error: `Instruction is too long (max ${MAX_INSTRUCTION} characters).` }, 400);

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false } });

    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await db.from("compiled_workflows").select("id", { count: "exact", head: true }).eq("user_id", owner).gte("created_at", since);
    if ((count ?? 0) >= HOURLY_LIMIT) return json({ error: "Compile limit reached (20 per hour). Try again shortly." }, 429);

    const { count: techCount } = await db.from("team_members").select("id", { count: "exact", head: true }).eq("account_owner_id", owner);

    const messages: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: `Owner's instruction:\n"""\n${instruction}\n"""\nAccount facts: ${techCount ?? 0} team member(s). Compile it.` },
    ];

    let lastErrors: string[] = [];
    let meta: { provider: string; model: string } = { provider: "unknown", model: "unknown" };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await askVireekAi({
        task: "workflow_compiler",
        jsonMode: true,
        maxTokens: 3500,
        temperature: 0.15,
        extraInstructions: systemRules(),
        messages,
      });
      meta = { provider: result.meta.provider, model: result.meta.model };

      let raw: unknown;
      try {
        raw = parseJson(result.text);
      } catch {
        lastErrors = ["Output was not valid JSON. Return exactly one JSON object."];
        messages.push({ role: "assistant", content: result.text.slice(0, 3000) }, { role: "user", content: `Rejected: ${lastErrors[0]}` });
        continue;
      }

      const compiled = compileIr(raw);
      if (!compiled.ok) {
        lastErrors = compiled.errors.slice(0, 12);
        messages.push(
          { role: "assistant", content: JSON.stringify(raw).slice(0, 6000) },
          { role: "user", content: `Rejected by the validator. Fix ALL of these and return the full corrected JSON:\n- ${lastErrors.join("\n- ")}` },
        );
        continue;
      }

      const { ir, graph, report } = compiled;
      const { data: row, error } = await db
        .from("compiled_workflows")
        .insert({
          user_id: owner,
          parent_id: parentId,
          name: ir.name,
          instruction,
          summary: ir.summary,
          trigger_event: ir.trigger.event,
          sla_minutes: ir.sla_minutes ?? null,
          ir,
          graph,
          report,
          compiler_meta: { ...meta, attempts: attempt, compiler_version: graph.version },
        })
        .select("*")
        .single();
      if (error || !row) throw error ?? new Error("Could not save the compiled workflow.");

      return json({ workflow: row, attempts: attempt });
    }

    return json({
      error: "Vireek could not turn that into a safe workflow. Try describing the trigger, the condition and the outcome more explicitly.",
      details: lastErrors,
    }, 422);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(JSON.stringify({ event: "workflow_compile_failed", error: message }));
    return json({ error: "The compiler is temporarily unavailable. Please try again." }, 503);
  }
});
