// supabase/functions/_shared/ai-core/outcomeBenchmarkNarrative.ts
//
// Outcome Benchmark Network advisor. The AI never sees raw rows or other
// businesses' data: only the caller's own numbers plus the k-anonymous peer
// percentiles they are already entitled to see. Gaps are computed in code;
// the model only prioritizes and phrases actions, and its output is
// validated (unknown metrics/levers dropped, text length-capped).

import { askVireekAi } from "./index.ts";

// Keep ids in sync with LEVERS in src/lib/outcomeBenchmark.ts
export const ALLOWED_LEVERS: Record<string, string> = {
  ftf_autopilot: "predicts fix probability before dispatch; holds or corrects risky jobs",
  apprenticeship: "closes exact technician skill gaps behind failed fixes",
  callback_root_cause: "finds why repeat visits happen and how to prevent them",
  job_quality_gate: "blocks job sign-off until work is verified",
  diagnosis_copilot: "improves diagnosis confidence before repair starts",
  dispatch_board: "assign and track jobs faster",
  advanced_routing: "routes jobs to the nearest qualified technician",
  on_call: "guarantees someone is always assigned to respond",
  technician_capacity: "spots overload before it slows response",
};

const METRICS = new Set(["first_time_fix_rate", "reservice_rate", "median_response_minutes"]);

export interface OutcomeAdviceChange {
  title: string;
  why: string;
  how: string;
  metric: string | null;
  lever_id: string | null;
}
export interface OutcomeAdvice {
  summary: string;
  changes: OutcomeAdviceChange[];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function sanitizeAdvice(raw: unknown): OutcomeAdvice | null {
  const obj = (Array.isArray(raw) ? { changes: raw } : raw) as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return null;
  const list = Array.isArray(obj.changes) ? obj.changes : [];
  const changes: OutcomeAdviceChange[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    const title = str(d.title, 120);
    const why = str(d.why, 320);
    const how = str(d.how, 320);
    if (!title || !why || !how) continue;
    const metric = typeof d.metric === "string" && METRICS.has(d.metric) ? d.metric : null;
    const lever = typeof d.lever_id === "string" && d.lever_id in ALLOWED_LEVERS ? d.lever_id : null;
    changes.push({ title, why, how, metric, lever_id: lever });
    if (changes.length === 3) break;
  }
  const summary = str(obj.summary, 400);
  if (!summary || changes.length === 0) return null;
  return { summary, changes };
}

export async function generateOutcomeAdvice(payload: Record<string, unknown>): Promise<OutcomeAdvice | null> {
  try {
    const result = await askVireekAi({
      task: "outcome_benchmark_advice",
      jsonMode: true,
      maxTokens: 900,
      temperature: 0.3,
      messages: [
        {
          role: "user",
          content: `Ground-truth data (treat every number as exact; never invent others):\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
    });
    const cleaned = result.text.replace(/```json|```/g, "").trim();
    const start = cleaned.search(/[\[{]/);
    if (start === -1) return null;
    return sanitizeAdvice(JSON.parse(cleaned.slice(start)));
  } catch {
    return null;
  }
}
