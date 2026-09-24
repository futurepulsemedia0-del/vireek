/**
 * Regret Minimization Console — client library.
 *
 * Minimax regret, not expected-value optimization: for each option, the
 * worst regret it could produce across all plausible scenarios, then pick
 * the option whose *worst* regret is smallest. Ties break toward the
 * better worst-case floor, then toward the more reversible option — so
 * "least regret" and "least irreversible harm" both drive the answer,
 * transparently (no hidden weighting).
 *
 * Server counterpart: supabase/migrations/20261128000000_regret_minimization_console.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type DecisionType = 'pricing' | 'discount' | 'overtime' | 'decline_job' | 'custom';
export type Reversibility = 'easy' | 'moderate' | 'hard';

export interface RegretOption {
  id: string;
  name: string;
  reversibility: Reversibility;
}

export interface RegretScenario {
  id: string;
  name: string;
  probability_pct: number | null;
}

/** optionId -> scenarioId -> the owner's own estimated dollar impact */
export type PayoffMatrix = Record<string, Record<string, number>>;

export interface RegretDecision {
  id: string;
  decision_type: DecisionType;
  title: string;
  options: RegretOption[];
  scenarios: RegretScenario[];
  payoff_matrix: PayoffMatrix;
  recommended_option_id: string | null;
  max_regret_by_option: Record<string, number> | null;
  worst_case_by_option: Record<string, number> | null;
  expected_value_by_option: Record<string, number> | null;
  notes: string | null;
  chosen_option_id: string | null;
  decided_at: string | null;
  actual_scenario_id: string | null;
  outcome_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================
// THE MATH
// ============================================================

export interface RegretComputation {
  bestPerScenario: Record<string, { optionId: string; payoff: number }>;
  maxRegretByOption: Record<string, number>;
  worstCaseByOption: Record<string, number>;
  /** null when any scenario is missing a probability — we never guess at odds */
  expectedValueByOption: Record<string, number> | null;
  recommendedOptionId: string | null;
}

const REVERSIBILITY_RANK: Record<Reversibility, number> = { easy: 0, moderate: 1, hard: 2 };

export function computeRegret(
  options: RegretOption[],
  scenarios: RegretScenario[],
  matrix: PayoffMatrix
): RegretComputation {
  const bestPerScenario: Record<string, { optionId: string; payoff: number }> = {};
  for (const s of scenarios) {
    let best: { optionId: string; payoff: number } | null = null;
    for (const o of options) {
      const payoff = matrix[o.id]?.[s.id];
      if (typeof payoff !== 'number' || Number.isNaN(payoff)) continue;
      if (!best || payoff > best.payoff) best = { optionId: o.id, payoff };
    }
    if (best) bestPerScenario[s.id] = best;
  }

  const maxRegretByOption: Record<string, number> = {};
  const worstCaseByOption: Record<string, number> = {};
  for (const o of options) {
    let maxRegret = -Infinity;
    let worstCase = Infinity;
    for (const s of scenarios) {
      const payoff = matrix[o.id]?.[s.id];
      if (typeof payoff !== 'number' || Number.isNaN(payoff)) continue;
      const best = bestPerScenario[s.id]?.payoff ?? payoff;
      const regret = best - payoff;
      if (regret > maxRegret) maxRegret = regret;
      if (payoff < worstCase) worstCase = payoff;
    }
    maxRegretByOption[o.id] = maxRegret === -Infinity ? 0 : maxRegret;
    worstCaseByOption[o.id] = worstCase === Infinity ? 0 : worstCase;
  }

  const haveProbabilities = scenarios.length > 0 && scenarios.every((s) => typeof s.probability_pct === 'number');
  let expectedValueByOption: Record<string, number> | null = null;
  if (haveProbabilities) {
    expectedValueByOption = {};
    for (const o of options) {
      let ev = 0;
      for (const s of scenarios) {
        const payoff = matrix[o.id]?.[s.id] ?? 0;
        ev += payoff * ((s.probability_pct ?? 0) / 100);
      }
      expectedValueByOption[o.id] = ev;
    }
  }

  let recommendedOptionId: string | null = null;
  let bestScore: [number, number, number] | null = null; // [maxRegret asc, worstCase desc, reversibility asc]
  for (const o of options) {
    const score: [number, number, number] = [
      maxRegretByOption[o.id] ?? Infinity,
      -(worstCaseByOption[o.id] ?? -Infinity),
      REVERSIBILITY_RANK[o.reversibility],
    ];
    const better =
      !bestScore ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2]);
    if (better) {
      bestScore = score;
      recommendedOptionId = o.id;
    }
  }

  return { bestPerScenario, maxRegretByOption, worstCaseByOption, expectedValueByOption, recommendedOptionId };
}

// ============================================================
// TEMPLATES — starter options/scenarios for the four common calls
// ============================================================

export const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  pricing: 'Raise prices',
  discount: 'Offer a discount',
  overtime: 'Approve overtime',
  decline_job: 'Take or decline a job',
  custom: 'Custom decision',
};

type Template = {
  title: string;
  options: Array<Omit<RegretOption, 'id'>>;
  scenarios: Array<Omit<RegretScenario, 'id'>>;
};

export const DECISION_TEMPLATES: Record<Exclude<DecisionType, 'custom'>, Template> = {
  pricing: {
    title: 'Raise prices this quarter?',
    options: [
      { name: 'Raise prices 8%', reversibility: 'moderate' },
      { name: 'Raise prices 3%', reversibility: 'moderate' },
      { name: 'Hold current prices', reversibility: 'easy' },
    ],
    scenarios: [
      { name: 'Demand holds steady', probability_pct: null },
      { name: 'Price-sensitive customers churn', probability_pct: null },
      { name: 'A competitor undercuts you', probability_pct: null },
    ],
  },
  discount: {
    title: 'Offer a discount to close this deal?',
    options: [
      { name: 'Offer 10% discount', reversibility: 'hard' },
      { name: 'Offer a smaller add-on instead', reversibility: 'easy' },
      { name: 'Hold firm on price', reversibility: 'easy' },
    ],
    scenarios: [
      { name: 'Customer books anyway', probability_pct: null },
      { name: 'Customer walks without it', probability_pct: null },
      { name: 'Customer books, but now expects it every time', probability_pct: null },
    ],
  },
  overtime: {
    title: 'Approve overtime to clear this backlog?',
    options: [
      { name: 'Approve overtime this week', reversibility: 'easy' },
      { name: 'Push the backlog to next week', reversibility: 'moderate' },
      { name: 'Bring in a subcontractor', reversibility: 'moderate' },
    ],
    scenarios: [
      { name: 'It was a one-off spike', probability_pct: null },
      { name: "It's the new normal workload", probability_pct: null },
    ],
  },
  decline_job: {
    title: 'Take this job or decline it?',
    options: [
      { name: 'Take the job', reversibility: 'hard' },
      { name: 'Decline and refer it out', reversibility: 'easy' },
      { name: 'Take it with a scheduling buffer / upcharge', reversibility: 'moderate' },
    ],
    scenarios: [
      { name: 'Job goes as scoped', probability_pct: null },
      { name: 'Job runs long / scope creeps', probability_pct: null },
      { name: 'It becomes a recurring/referral customer', probability_pct: null },
    ],
  },
};

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function buildFromTemplate(type: Exclude<DecisionType, 'custom'>): {
  title: string;
  options: RegretOption[];
  scenarios: RegretScenario[];
} {
  const t = DECISION_TEMPLATES[type];
  return {
    title: t.title,
    options: t.options.map((o) => ({ ...o, id: newId('opt') })),
    scenarios: t.scenarios.map((s) => ({ ...s, id: newId('scn') })),
  };
}

export function blankOption(): RegretOption {
  return { id: newId('opt'), name: '', reversibility: 'moderate' };
}

export function blankScenario(): RegretScenario {
  return { id: newId('scn'), name: '', probability_pct: null };
}

// ============================================================
// FORMAT
// ============================================================

export function formatDollars(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}

export const REVERSIBILITY_LABELS: Record<Reversibility, string> = {
  easy: 'Easy to undo',
  moderate: 'Some cost to undo',
  hard: 'Hard to undo',
};

export const REVERSIBILITY_COLORS: Record<Reversibility, string> = {
  easy: 'bg-success-500/10 text-success-500',
  moderate: 'bg-warning-500/10 text-warning-500',
  hard: 'bg-danger/10 text-danger',
};

// ============================================================
// CRUD
// ============================================================

export async function fetchDecisions(): Promise<RegretDecision[]> {
  const { data, error } = await supabase
    .from('regret_console_decisions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as RegretDecision[]) ?? [];
}

export interface SaveDecisionInput {
  decision_type: DecisionType;
  title: string;
  options: RegretOption[];
  scenarios: RegretScenario[];
  payoff_matrix: PayoffMatrix;
  notes: string;
}

export async function saveDecision(input: SaveDecisionInput, userId: string): Promise<RegretDecision> {
  const computed = computeRegret(input.options, input.scenarios, input.payoff_matrix);
  const { data, error } = await supabase
    .from('regret_console_decisions')
    .insert({
      user_id: userId,
      decision_type: input.decision_type,
      title: input.title.trim(),
      options: input.options,
      scenarios: input.scenarios,
      payoff_matrix: input.payoff_matrix,
      recommended_option_id: computed.recommendedOptionId,
      max_regret_by_option: computed.maxRegretByOption,
      worst_case_by_option: computed.worstCaseByOption,
      expected_value_by_option: computed.expectedValueByOption,
      notes: input.notes.trim() || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as RegretDecision;
}

export async function recordChoice(id: string, chosenOptionId: string): Promise<void> {
  const { error } = await supabase
    .from('regret_console_decisions')
    .update({ chosen_option_id: chosenOptionId, decided_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function recordOutcome(id: string, actualScenarioId: string, outcomeNotes: string): Promise<void> {
  const { error } = await supabase
    .from('regret_console_decisions')
    .update({
      actual_scenario_id: actualScenarioId,
      outcome_notes: outcomeNotes.trim() || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteDecision(id: string): Promise<void> {
  const { error } = await supabase.from('regret_console_decisions').delete().eq('id', id);
  if (error) throw error;
}
