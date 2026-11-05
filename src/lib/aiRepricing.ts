/**
 * AI cost re-pricing — pure. costTracking.ts logs cost_usd from hard-coded list prices (and prices Cloudflare at $0).
 * Here the logged TOKEN counts are re-priced from staff-entered provider_cost_rates (component 'llm', units
 * per_1m_input_tokens + per_1m_output_tokens, matched on provider id). Every row carries a basis:
 *   rate_table      — both token rates exist in your rate table (still an ESTIMATE: tokens may be estimated by us)
 *   code_list_price — no rate entered; falls back to the logged cost_usd from costTracking.ts
 *   unpriced        — no rate entered and the logged cost is $0 although tokens were used (e.g. Cloudflare)
 */
import { resolveRate, type CostRate } from './unitEconomics';
import type { UeTenantRow } from './marginDashboard';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export interface AiUsageRow {
  account_id: string | null; provider: string; model: string;
  input_tokens: number; output_tokens: number; calls: number; estimated_calls: number; logged_cost_usd: number;
}
export interface AiUsageBreakdown { rows: AiUsageRow[]; truncated: boolean }

export function parseAiUsage(raw: unknown): AiUsageBreakdown {
  if (!isObj(raw) || !Array.isArray(raw.rows)) return { rows: [], truncated: false };
  const rows: AiUsageRow[] = [];
  for (const r of raw.rows) {
    if (!isObj(r) || typeof r.provider !== 'string' || typeof r.model !== 'string') continue;
    rows.push({
      account_id: typeof r.account_id === 'string' ? r.account_id : null, provider: r.provider, model: r.model,
      input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens), calls: num(r.calls),
      estimated_calls: num(r.estimated_calls), logged_cost_usd: num(r.logged_cost_usd),
    });
  }
  return { rows, truncated: raw.truncated === true };
}

export type AiCostBasis = 'rate_table' | 'code_list_price' | 'unpriced';
export interface PricedAiRow extends AiUsageRow { costUsd: number; basis: AiCostBasis }

export function priceAiRow(row: AiUsageRow, rates: CostRate[], onDate: string): PricedAiRow {
  const rin = resolveRate(rates, 'llm', row.provider, 'per_1m_input_tokens', onDate);
  const rout = resolveRate(rates, 'llm', row.provider, 'per_1m_output_tokens', onDate);
  if (rin && rout) {
    return { ...row, costUsd: (row.input_tokens / 1e6) * rin.rateUsd + (row.output_tokens / 1e6) * rout.rateUsd, basis: 'rate_table' };
  }
  const usedTokens = row.input_tokens + row.output_tokens > 0;
  if (row.logged_cost_usd === 0 && usedTokens) return { ...row, costUsd: 0, basis: 'unpriced' };
  return { ...row, costUsd: row.logged_cost_usd, basis: 'code_list_price' };
}

export function priceAiRows(rows: AiUsageRow[], rates: CostRate[], onDate: string): PricedAiRow[] {
  return rows.map((r) => priceAiRow(r, rates, onDate));
}

export function aiCostByAccount(priced: PricedAiRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of priced) if (r.account_id) m.set(r.account_id, (m.get(r.account_id) ?? 0) + r.costUsd);
  return m;
}

/** Replaces each tenant's logged AI cost with the re-priced one. If the breakdown was truncated, tenants absent from it keep the logged value. */
export function applyAiRepricing(tenants: UeTenantRow[], byAccount: Map<string, number>, truncated: boolean): UeTenantRow[] {
  return tenants.map((t) => {
    if (byAccount.has(t.account_id)) return { ...t, ai_cost_usd: byAccount.get(t.account_id) as number };
    return truncated ? t : { ...t, ai_cost_usd: 0 };
  });
}

export interface AiModelCost {
  provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; basis: AiCostBasis; estimatedTokenShare: number;
}

export function aiCoverageByModel(priced: PricedAiRow[]): AiModelCost[] {
  const g = new Map<string, AiModelCost & { est: number }>();
  for (const r of priced) {
    const k = `${r.provider}\u0000${r.model}`;
    const cur = g.get(k) ?? { provider: r.provider, model: r.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, basis: r.basis, estimatedTokenShare: 0, est: 0 };
    cur.calls += r.calls; cur.inputTokens += r.input_tokens; cur.outputTokens += r.output_tokens; cur.costUsd += r.costUsd; cur.est += r.estimated_calls;
    g.set(k, cur);
  }
  return [...g.values()].map(({ est, ...m }) => ({ ...m, estimatedTokenShare: m.calls > 0 ? est / m.calls : 0 })).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export interface AiPricingSummary { totalUsd: number; rateTableUsd: number; codeListUsd: number; unpricedCalls: number; estimatedTokenCalls: number; totalCalls: number }

export function aiPricingSummary(priced: PricedAiRow[]): AiPricingSummary {
  const s: AiPricingSummary = { totalUsd: 0, rateTableUsd: 0, codeListUsd: 0, unpricedCalls: 0, estimatedTokenCalls: 0, totalCalls: 0 };
  for (const r of priced) {
    s.totalUsd += r.costUsd; s.totalCalls += r.calls; s.estimatedTokenCalls += r.estimated_calls;
    if (r.basis === 'rate_table') s.rateTableUsd += r.costUsd;
    else if (r.basis === 'code_list_price') s.codeListUsd += r.costUsd;
    else s.unpricedCalls += r.calls;
  }
  return s;
}
