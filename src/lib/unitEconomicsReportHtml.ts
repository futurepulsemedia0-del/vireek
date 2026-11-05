/** Board-ready unit-economics report as a self-contained HTML string (print to PDF from the browser). Pure. */
import { formatPct, formatUsd } from './staffUsage';
import { reconcile } from './marginModel';
import type { CostDriver, MarginSummary, PlanStat, TenantMargin } from './marginDashboard';

export interface ReportReconciliation { month: string; provider: string; reportedUsd: number; invoicedUsd: number | null; driftPct: number | null; status: 'ok' | 'drift' | 'no_invoice' }

export interface ReportModel {
  title: string; periodLabel: string; generatedAtIso: string;
  coverage: { callsTotal: number; callsWithCost: number };
  totals: MarginSummary; planStats: PlanStat[]; negative: TenantMargin[]; drivers: CostDriver[];
  freeTier: { orgs: number; avgCostUsd: number | null };
  reconciliation: ReportReconciliation | null; assumptions: string[];
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
:root{color-scheme:light}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:black;background:white;margin:0;padding:32px;max-width:960px;margin-inline:auto}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid gray;padding-bottom:4px}
.meta{color:dimgray;margin:0 0 16px}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.kpi{border:1px solid gray;border-radius:8px;padding:10px}.kpi b{display:block;font-size:20px}.kpi span{color:dimgray;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid lightgray;text-align:right}
th:first-child,td:first-child{text-align:left}.tag{font-size:11px;border:1px solid gray;border-radius:4px;padding:0 4px;white-space:nowrap}
.note{border-left:3px solid gray;padding:4px 10px;margin:8px 0}ul{padding-left:20px}
@media print{body{padding:0}h2{break-after:avoid}table,.kpis{break-inside:avoid}}
`;

const BASIS_LABEL = { provider_reported: 'Measured (provider-reported)', estimated: 'Estimate' } as const;

export function buildReportHtml(m: ReportModel): string {
  const t = m.totals;
  const cov = m.coverage.callsTotal > 0 ? Math.round((m.coverage.callsWithCost / m.coverage.callsTotal) * 100) : 0;
  const kpi = (label: string, value: string, sub: string) => `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b><span>${esc(sub)}</span></div>`;
  const planRows = m.planStats.map((p) => `<tr><td>${esc(p.planName)}</td><td>${p.tenants}</td><td>${esc(formatUsd(p.revenueUsd))}</td><td>${esc(formatUsd(p.costUsd))}</td><td>${esc(formatPct(p.marginPct))}</td><td>${esc(formatPct(p.marginPctP10))} / ${esc(formatPct(p.marginPctP50))} / ${esc(formatPct(p.marginPctP90))}</td><td>${p.lossTenants}</td></tr>`).join('');
  const negRows = m.negative.map((o) => `<tr><td>${esc(o.name)}</td><td>${esc(o.planName)}</td><td>${esc(formatUsd(o.revenueUsd))}</td><td>${esc(formatUsd(o.totalCostUsd))}</td><td>${esc(formatUsd(o.marginUsd))}</td></tr>`).join('');
  const driverRows = m.drivers.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(formatUsd(d.usd))}</td><td><span class="tag">${esc(BASIS_LABEL[d.basis])}</span></td></tr>`).join('');
  const rec = m.reconciliation;
  const recHtml = rec
    ? `<p>${esc(rec.provider)} — ${esc(rec.month)}: reported ${esc(formatUsd(rec.reportedUsd))} vs invoiced ${esc(formatUsd(rec.invoicedUsd))}. ${rec.status === 'no_invoice' ? 'No invoice entered yet: NOT reconciled.' : `Drift ${esc(formatPct(rec.driftPct))} — ${rec.status === 'drift' ? 'OVER threshold, investigate.' : 'within threshold.'}`}</p>`
    : '<p>No invoice reconciliation is included in this report.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.title)}</title><style>${CSS}</style></head><body>
<h1>${esc(m.title)}</h1><p class="meta">${esc(m.periodLabel)} · Generated ${esc(m.generatedAtIso.slice(0, 10))} · Internal — contains estimates</p>
<h2>Summary</h2><div class="kpis">
${kpi('Revenue (estimate)', formatUsd(t.revenueUsd), `${t.tenants} organisations`)}
${kpi('Total cost', formatUsd(t.totalCostUsd), `${formatUsd(t.voiceReportedUsd)} measured voice · ${formatUsd(t.voiceEstimatedUsd + t.aiEstimatedUsd)} estimated`)}
${kpi('Gross margin', formatPct(t.marginPct), formatUsd(t.marginUsd))}
${kpi('Cost data coverage', `${cov}%`, `${m.coverage.callsWithCost} of ${m.coverage.callsTotal} calls have a provider-reported cost`)}</div>
<h2>Margin by plan</h2><table><thead><tr><th>Plan</th><th>Orgs</th><th>Revenue (est.)</th><th>Cost</th><th>Margin</th><th>Org margin p10 / p50 / p90</th><th>Loss-making</th></tr></thead><tbody>${planRows || '<tr><td colspan="7">No data</td></tr>'}</tbody></table>
<h2>Top cost drivers</h2><table><thead><tr><th>Driver</th><th>Cost</th><th>Basis</th></tr></thead><tbody>${driverRows || '<tr><td colspan="3">No data</td></tr>'}</tbody></table>
<h2>Negative-margin organisations</h2><table><thead><tr><th>Organisation</th><th>Plan</th><th>Revenue (est.)</th><th>Cost</th><th>Margin</th></tr></thead><tbody>${negRows || '<tr><td colspan="5">None in this window</td></tr>'}</tbody></table>
<h2>Free tier</h2><p>${m.freeTier.orgs} free organisations; average cost per free organisation in this window: ${esc(formatUsd(m.freeTier.avgCostUsd))}.</p>
<h2>Provider invoice reconciliation</h2>${recHtml}
<h2>Assumptions</h2><ul>${m.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
<p class="note">Estimates are not invoices. Measured figures are provider-reported and not yet reconciled unless stated above.</p>
</body></html>`;
}

/** Reported (provider webhook) total vs the entered invoice for one provider-month. */
export function buildReconciliation(a: { month: string; provider: string; reportedUsd: number; invoicedUsd: number | null; thresholdPct: number }): ReportReconciliation {
  const r = reconcile(a.reportedUsd, a.invoicedUsd, a.thresholdPct);
  return { month: a.month, provider: a.provider, reportedUsd: a.reportedUsd, invoicedUsd: a.invoicedUsd, driftPct: r.driftPct, status: r.status };
}
