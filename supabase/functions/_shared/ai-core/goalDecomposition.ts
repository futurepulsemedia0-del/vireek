// supabase/functions/_shared/ai-core/goalDecomposition.ts
//
// Goal Decomposition Orchestrator — reasoning layer only. Turns a
// plain-language vision statement into a validated tree of Strategies ->
// Actions. Like businessDecisions.ts, this file NEVER touches the
// database and NEVER executes anything — goal-decomposition-orchestrator/
// index.ts is the only caller, and it does the inserting + any real
// execution hooks.

import { askVireekAi } from "./index.ts";

export interface DecomposedAction {
  title: string;
  description: string;
  action_type: "human_task" | "workflow_enrollment" | "marketing_campaign";
  owner_name: string | null;
  due_in_days: number; // relative to goal creation; clamped to the goal's horizon
}

export interface DecomposedStrategy {
  title: string;
  rationale: string;
  actions: DecomposedAction[];
}

const VALID_ACTION_TYPES = new Set(["human_task", "workflow_enrollment", "marketing_campaign"]);

function clampDays(n: unknown, horizonDays: number): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num) || num < 1) return Math.min(14, horizonDays);
  return Math.max(1, Math.min(Math.round(num), horizonDays));
}

/**
 * `context` must be plain, already-computed business facts (see
 * goal-decomposition-orchestrator/index.ts) — never raw rows.
 */
export async function decomposeGoal(
  vision: string,
  targetMetric: string | null,
  horizonDays: number,
  context: Record<string, unknown>,
): Promise<DecomposedStrategy[]> {
  if (!vision?.trim()) return [];

  const result = await askVireekAi({
    task: "goal_decomposition",
    jsonMode: true,
    maxTokens: 1800,
    temperature: 0.4,
    messages: [
      {
        role: "user",
        content:
          `Business goal to decompose: "${vision.trim()}"\n` +
          `Target metric: ${targetMetric || "not specified"}\n` +
          `Horizon: ${horizonDays} days\n` +
          `Current account context (ground truth, do not contradict):\n${JSON.stringify(context, null, 2)}\n\n` +
          `Break this into 2-4 concrete strategies. Each strategy gets 2-6 concrete actions. ` +
          `Every action needs: title, description (1-2 sentences, specific to THIS business's context above, not generic advice), ` +
          `action_type ("human_task" for anything requiring judgment/a phone call/a decision, "workflow_enrollment" only for something an automated SMS/email sequence could plausibly do, "marketing_campaign" only for an outbound marketing push), ` +
          `owner_name (a role like "Owner" or "Office Manager", or null), and due_in_days (integer, within the horizon, earliest actions first). ` +
          `Return ONLY JSON: { "strategies": [ { "title": "...", "rationale": "...", "actions": [ { "title": "...", "description": "...", "action_type": "...", "owner_name": "...", "due_in_days": 0 } ] } ] }`,
      },
    ],
  });

  const parsed = JSON.parse(result.text);
  const rawStrategies: unknown[] = Array.isArray(parsed?.strategies) ? parsed.strategies : [];

  const strategies: DecomposedStrategy[] = [];
  for (const s of rawStrategies.slice(0, 4)) {
    if (!s || typeof s !== "object") continue;
    const title = String((s as Record<string, unknown>).title ?? "").trim();
    if (!title) continue;

    const rawActions: unknown[] = Array.isArray((s as Record<string, unknown>).actions) ? (s as { actions: unknown[] }).actions : [];
    const actions: DecomposedAction[] = [];
    for (const a of rawActions.slice(0, 6)) {
      if (!a || typeof a !== "object") continue;
      const aTitle = String((a as Record<string, unknown>).title ?? "").trim();
      if (!aTitle) continue;
      const actionTypeRaw = String((a as Record<string, unknown>).action_type ?? "human_task");
      actions.push({
        title: aTitle,
        description: String((a as Record<string, unknown>).description ?? "").trim(),
        action_type: (VALID_ACTION_TYPES.has(actionTypeRaw) ? actionTypeRaw : "human_task") as DecomposedAction["action_type"],
        owner_name: (a as Record<string, unknown>).owner_name ? String((a as Record<string, unknown>).owner_name) : null,
        due_in_days: clampDays((a as Record<string, unknown>).due_in_days, horizonDays),
      });
    }
    if (actions.length === 0) continue;

    strategies.push({
      title,
      rationale: String((s as Record<string, unknown>).rationale ?? "").trim(),
      actions,
    });
  }

  return strategies;
}
