/**
 * Demand OS — profit-based budget allocator (pure, deterministic, no I/O).
 *
 * Goal: optimise ad budgets for PROFITABLE COMPLETED JOBS, not leads.
 * An LLM never moves money — this engine is auditable and unit-tested; the
 * LLM layer (if any) may only *explain* its output.
 *
 * Method
 * 1. Per campaign: roi = grossProfit / adSpend over a matured lead cohort.
 * 2. Small samples lie, so roi is shrunk toward the portfolio mean:
 *      shrunk = mu + c * (roi - mu),   c = nEff / (nEff + priorJobs)
 *    nEff = max(jobsWon, spend / portfolioCostPerJob) so a campaign that
 *    burned many "job-equivalents" of budget with zero jobs is judged
 *    on evidence, not ignored.
 * 3. Losers are cut, winners grow, budget-neutral by default.
 * 4. Guardrails: max shift %, cooldown (platform learning phase), minimum
 *    evidence, dead-band, per-campaign floor, optional total cap.
 */

export interface CampaignEconomics {
  campaignId: string;
  platform: 'google_ads' | 'meta_ads' | 'google_lsa';
  name: string;
  market: string | null;
  status: 'enabled' | 'paused' | 'removed' | 'unknown';
  dailyBudgetCents: number | null;
  /** false for shared budgets, ad-set-level budgets, and LSA (no budget API). */
  budgetEditable: boolean;
  lastBudgetChangeAt: string | null;
  spendCents: number;
  leads: number;
  jobsWon: number;
  revenueCents: number;
  grossProfitCents: number;
}

export interface AllocatorSettings {
  maxShiftPct: number; // 1..30
  cooldownDays: number;
  minSpendCents: number;
  minJobs: number; // minimum effective job-evidence to act
  allowGrowth: boolean; // allow total daily budget to rise
  totalDailyCapCents: number | null;
  priorJobs?: number; // shrinkage strength (default 8)
  minConfidence?: number; // winners need >= this (default 0.35)
  deadbandPct?: number; // ignore |delta| inside this band (default 0.15)
  minBudgetCents?: number; // per-campaign floor (default 500 = $5/day)
}

export interface Recommendation {
  campaignId: string;
  direction: 'increase' | 'decrease';
  currentBudgetCents: number;
  proposedBudgetCents: number;
  deltaCents: number;
  applyable: boolean;
  reason: string;
  evidence: {
    roiRaw: number | null;
    roiShrunk: number;
    portfolioRoi: number;
    confidence: number;
    jobsWon: number;
    effectiveJobs: number;
    spendCents: number;
    grossProfitCents: number;
    estNetDailyProfitDeltaCents: number;
  };
}

export interface AllocatorResult {
  recommendations: Recommendation[];
  skipped: { campaignId: string; reason: string }[];
  portfolio: { spendCents: number; grossProfitCents: number; roi: number | null };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function allocateBudgets(rows: CampaignEconomics[], s: AllocatorSettings, now: Date = new Date()): AllocatorResult {
  const priorJobs = s.priorJobs ?? 8;
  const minConfidence = s.minConfidence ?? 0.35;
  const deadband = s.deadbandPct ?? 0.15;
  const floor = s.minBudgetCents ?? 500;
  const maxShift = clamp(s.maxShiftPct, 1, 30) / 100;
  const skipped: AllocatorResult['skipped'] = [];

  const live = rows.filter((r) => r.status === 'enabled' && (r.dailyBudgetCents ?? 0) > 0);
  const totalSpend = live.reduce((a, r) => a + r.spendCents, 0);
  const totalGp = live.reduce((a, r) => a + r.grossProfitCents, 0);
  const totalJobs = live.reduce((a, r) => a + r.jobsWon, 0);
  const mu = totalSpend > 0 ? totalGp / totalSpend : 0;
  const portfolio = { spendCents: totalSpend, grossProfitCents: totalGp, roi: totalSpend > 0 ? mu : null };
  if (totalSpend <= 0) return { recommendations: [], skipped, portfolio };

  const costPerJob = totalJobs > 0 ? totalSpend / totalJobs : Infinity;
  const cooldownMs = s.cooldownDays * 86_400_000;
  const scale = Math.max(Math.abs(mu), 0.1);

  type Scored = { r: CampaignEconomics; roi: number | null; shrunk: number; c: number; nEff: number; d: number };
  const scored: Scored[] = [];
  for (const r of live) {
    if (r.lastBudgetChangeAt && now.getTime() - new Date(r.lastBudgetChangeAt).getTime() < cooldownMs) {
      skipped.push({ campaignId: r.campaignId, reason: 'cooldown' });
      continue;
    }
    const nEff = Math.max(r.jobsWon, Number.isFinite(costPerJob) ? r.spendCents / costPerJob : 0);
    if (r.spendCents < s.minSpendCents || nEff < s.minJobs) {
      skipped.push({ campaignId: r.campaignId, reason: 'insufficient_evidence' });
      continue;
    }
    const roi = r.spendCents > 0 ? r.grossProfitCents / r.spendCents : null;
    const c = nEff / (nEff + priorJobs);
    const shrunk = mu + c * ((roi ?? 0) - mu);
    scored.push({ r, roi, shrunk, c, nEff, d: shrunk - mu });
  }

  const currentTotal = live.reduce((a, r) => a + (r.dailyBudgetCents ?? 0), 0);
  // roi < 1 means every $1 of ads returns < $1 of gross profit: money-losing.
  const cuts = new Map<string, number>();
  const funding = new Set<string>(); // profitable-but-weaker: cut ONLY to fund a better campaign
  for (const x of scored) {
    const budget = x.r.dailyBudgetCents as number;
    const lossMaking = x.shrunk < 1 && x.c >= 0.5;
    const losing = x.d < -deadband * scale || lossMaking;
    if (!losing) continue;
    const severity = clamp(Math.abs(x.d) / scale, 0, 1);
    const pct = lossMaking ? maxShift : maxShift * Math.max(0.3, severity);
    const cut = Math.min(Math.round(budget * pct), Math.max(0, budget - floor));
    if (cut < Math.max(100, Math.round(budget * 0.02))) continue;
    cuts.set(x.r.campaignId, cut);
    if (!lossMaking) funding.add(x.r.campaignId);
  }

  const winners = scored.filter(
    (x) => x.r.budgetEditable && x.d > deadband * scale && x.c >= minConfidence && x.shrunk > 1,
  );
  const capacity = winners.reduce((a, w) => a + Math.round((w.r.dailyBudgetCents as number) * maxShift), 0);
  const editableCut = (ids: (id: string) => boolean) =>
    scored.reduce((a, x) => (x.r.budgetEditable && ids(x.r.campaignId) ? a + (cuts.get(x.r.campaignId) ?? 0) : a), 0);
  const lossPool = editableCut((id) => !funding.has(id));
  const fundingPool = editableCut((id) => funding.has(id));
  // Never destroy profit: funding cuts are limited to what winners can absorb.
  const fundingFactor = fundingPool > 0 ? clamp((capacity - lossPool) / fundingPool, 0, 1) : 0;
  const editableIds = new Set(scored.filter((x) => x.r.budgetEditable).map((x) => x.r.campaignId));
  for (const id of funding) {
    // Non-editable campaigns (e.g. LSA) get an advisory cut whenever a better home exists.
    const factor = editableIds.has(id) ? fundingFactor : capacity > 0 ? 1 : 0;
    const scaled = Math.floor((cuts.get(id) as number) * factor);
    if (scaled < 100) cuts.delete(id);
    else cuts.set(id, scaled);
  }
  const pool = editableCut(() => true);
  const ceiling = s.allowGrowth ? (s.totalDailyCapCents ?? Math.round(currentTotal * 1.1)) : currentTotal;
  const available = Math.max(pool, ceiling - (currentTotal - pool));
  const caps = new Map(winners.map((w) => [w.r.campaignId, Math.round((w.r.dailyBudgetCents as number) * maxShift)]));
  const weights = new Map(winners.map((w) => [w.r.campaignId, w.d * w.c]));
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);
  const totalCap = [...caps.values()].reduce((a, b) => a + b, 0);
  let toDistribute = Math.min(available, totalCap);
  const raises = new Map<string, number>();
  // Water-filling so per-campaign caps never strand budget that others can use.
  let open = winners.map((w) => w.r.campaignId);
  while (toDistribute > 0 && open.length > 0 && totalWeight > 0) {
    const wSum = open.reduce((a, id) => a + (weights.get(id) as number), 0);
    let spent = 0;
    const next: string[] = [];
    for (const id of open) {
      const room = (caps.get(id) as number) - (raises.get(id) ?? 0);
      const share = Math.floor((toDistribute * (weights.get(id) as number)) / wSum);
      const add = Math.min(room, share);
      raises.set(id, (raises.get(id) ?? 0) + add);
      spent += add;
      if (room - add > 0) next.push(id);
    }
    if (spent === 0) break;
    toDistribute -= spent;
    open = next;
  }

  const recommendations: Recommendation[] = [];
  const evidenceFor = (x: Scored, deltaCents: number): Recommendation['evidence'] => ({
    roiRaw: x.roi,
    roiShrunk: x.shrunk,
    portfolioRoi: mu,
    confidence: x.c,
    jobsWon: x.r.jobsWon,
    effectiveJobs: x.nEff,
    spendCents: x.r.spendCents,
    grossProfitCents: x.r.grossProfitCents,
    // Net daily profit effect of moving budget: each $1 yields `roi` gross
    // profit and costs $1. Increases get a 30% diminishing-returns haircut.
    estNetDailyProfitDeltaCents: Math.round(deltaCents * ((deltaCents > 0 ? x.shrunk * 0.7 : x.shrunk) - 1)),
  });
  const why = (x: Scored, dir: 'increase' | 'decrease', pct: number) =>
    `Returns $${x.shrunk.toFixed(2)} gross profit per $1 of ad spend vs $${mu.toFixed(2)} portfolio average ` +
    `(${x.r.jobsWon} completed jobs, ${Math.round(x.c * 100)}% confidence). ` +
    `${dir === 'increase' ? 'Increase' : 'Decrease'} daily budget by ${pct}%.`;

  for (const x of scored) {
    const id = x.r.campaignId;
    const budget = x.r.dailyBudgetCents as number;
    const cut = cuts.get(id) ?? 0;
    const raise = raises.get(id) ?? 0;
    const delta = raise - cut;
    if (delta === 0) continue;
    recommendations.push({
      campaignId: id,
      direction: delta > 0 ? 'increase' : 'decrease',
      currentBudgetCents: budget,
      proposedBudgetCents: budget + delta,
      deltaCents: delta,
      applyable: x.r.budgetEditable,
      reason: why(x, delta > 0 ? 'increase' : 'decrease', Math.round((Math.abs(delta) / budget) * 100)),
      evidence: evidenceFor(x, delta),
    });
  }
  recommendations.sort((a, b) => Math.abs(b.evidence.estNetDailyProfitDeltaCents) - Math.abs(a.evidence.estNetDailyProfitDeltaCents));
  return { recommendations, skipped, portfolio };
}
