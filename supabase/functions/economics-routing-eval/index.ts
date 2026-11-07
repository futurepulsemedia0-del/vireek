// supabase/functions/economics-routing-eval/index.ts
//
// Staff-run harness (service-role Bearer): compares a BASELINE provider and a CANDIDATE provider on ONE task type using
// paired cases, decides with the quality gate (CI on the paired delta, critical-case rule), and prices both with the
// versioned provider_cost_rates table. It only REPORTS; enabling a route is a human step (AI_ROUTE_OVERRIDES_JSON).
//
// Limits (stated, not hidden): cases carry their own `system` text, so quality is measured on what you send, not on
// the production grounded prompt; the hallucination judge from evalHarness is NOT applied here.
//
// POST { task, baseline: {provider}, candidate: {provider}, cases: [{ id, system?, userMessage, jsonMode?, critical?, assertions }] }

import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { routeChat } from "../_shared/ai-core/router.ts";
import { ALL_ADAPTERS, getRouteForTask } from "../_shared/ai-core/registry.ts";
import { evaluateAssertions, type EvalAssertion } from "../_shared/ai-core/evalHarness.ts";
import { resolveUsage } from "../_shared/ai-core/costTracking.ts";
import type { TaskType } from "../_shared/ai-core/types.ts";
import { runRoutingEval, type VariantSpec } from "../_shared/economics/routingEval.ts";
import { costMicro, resolveVersionedRate, type VersionedRate } from "../_shared/economics/microDollars.ts";

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

interface Case { id: string; system?: string; userMessage: string; jsonMode?: boolean; critical?: boolean; assertions: EvalAssertion[] }

Deno.serve(async (req: Request) => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key || req.headers.get("Authorization") !== `Bearer ${key}`) return json({ error: "Unauthorized" }, 401);
  let body: { task?: string; baseline?: { provider?: string }; candidate?: { provider?: string }; cases?: Case[] };
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const task = body.task as TaskType | undefined;
  const cases = body.cases;
  const bp = body.baseline?.provider, cp = body.candidate?.provider;
  if (!task || !bp || !cp || bp === cp || !Array.isArray(cases) || cases.length === 0 || cases.length > 300) return json({ error: "invalid_request" }, 400);
  if (!(bp in ALL_ADAPTERS) || !(cp in ALL_ADAPTERS)) return json({ error: "unknown_provider" }, 400);

  const chain = getRouteForTask(task);
  const modelOf = (p: string) => chain.find((e) => e.provider === p)?.model ?? "unknown";
  const baseline: VariantSpec = { provider: bp, model: modelOf(bp) };
  const candidate: VariantSpec = { provider: cp, model: modelOf(cp) };
  if (!ALL_ADAPTERS[bp].isConfigured() || !ALL_ADAPTERS[cp].isConfigured()) return json({ error: "provider_not_configured" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", key, { auth: { persistSession: false } });
  const { data: rateRows, error: rateErr } = await admin.from("provider_cost_rates").select("id, component, provider, unit, rate_usd, effective_from, effective_to").eq("component", "llm");
  if (rateErr) return json({ error: "rates_unavailable" }, 500);
  const rates: VersionedRate[] = (rateRows ?? []).map((r) => ({
    id: String(r.id), component: String(r.component), provider: String(r.provider), unit: r.unit as VersionedRate["unit"],
    rateUsd: String(r.rate_usd), effectiveFrom: String(r.effective_from), effectiveTo: r.effective_to ? String(r.effective_to) : null,
  }));
  const day = new Date().toISOString().slice(0, 10);

  const report = await runRoutingEval({
    task, cases, baseline, candidate,
    run: async (c, v) => {
      const request = {
        system: c.system ?? "", messages: [{ role: "user" as const, content: c.userMessage }],
        maxTokens: 500, jsonMode: Boolean(c.jsonMode), temperature: 0,
      };
      const t0 = Date.now();
      const { response } = await routeChat(task, request, [v.provider]); // single provider: no silent fallback to the other variant
      if (response.provider !== v.provider) throw new Error("unexpected_provider");
      const failed = evaluateAssertions(response.text, response.latencyMs, c.assertions);
      const score = c.assertions.length ? (c.assertions.length - failed.length) / c.assertions.length : 1;
      const u = resolveUsage(request, response);
      const rin = resolveVersionedRate(rates, "llm", v.provider, "per_1m_input_tokens", day);
      const rout = resolveVersionedRate(rates, "llm", v.provider, "per_1m_output_tokens", day);
      const cost = rin && rout ? costMicro(u.inputTokens, rin.rateUsd, "per_1m_input_tokens") + costMicro(u.outputTokens, rout.rateUsd, "per_1m_output_tokens") : null;
      return { score, costMicro: cost, latencyMs: Date.now() - t0 };
    },
  });
  return json({ report, note: "Report only. To enable, add an AI_ROUTE_OVERRIDES_JSON entry with this report's gate evidence; rollback = set AI_ROUTE_OVERRIDES_DISABLED=1." });
});
