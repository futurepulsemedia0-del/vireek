// supabase/functions/_shared/billing/costPolicy.ts
//
// Which AI tasks may be paused when an account reaches its cost limit. This is an explicit ALLOW-LIST of OPTIONAL
// analytics / narrative / planning features. Everything else (live-call and emergency handling, dispatch, booking,
// customer-facing replies, and any NEW task type nobody has classified) is protected by default: fail-safe direction.

export const OPTIONAL_AI_TASKS: ReadonlySet<string> = new Set([
  "business_insights", "business_decision_engine", "goal_decomposition", "workflow_compiler", "causal_world_simulator",
  "continual_identity_learner", "cash_flow_narrative", "executive_report_commentary", "workforce_equilibrium_narrative",
  "cash_flow_war_room_plan", "regional_demand_narrative", "outcome_benchmark_advice", "capacity_demand_narrative",
  "staffing_forecast_narrative", "callback_root_cause", "trust_bank_intervention", "next_best_action_engine",
  "business_scientist_hypothesis", "field_scientist_causes", "causal_shock_extract", "causal_shock_cascade",
  "opportunity_cost_ranking", "business_drift_narrative", "job_autopsy", "switching_shield_plan",
]);

/** True only for explicitly optional tasks. Unknown or undefined tasks are NOT optional (never paused for cost). */
export function isOptionalAiTask(task: string | undefined | null): boolean {
  return typeof task === "string" && OPTIONAL_AI_TASKS.has(task);
}
