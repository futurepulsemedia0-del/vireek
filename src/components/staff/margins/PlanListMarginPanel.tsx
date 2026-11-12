import { useMemo } from 'react';
import { GROSS_MARGIN_FLOOR_PCT, buildPlanListMargins, platformFixedMonthlyUsd, type PlanMarginStatus } from '@/lib/planMargins';
import { formatPct, formatUsd } from '@/lib/staffUsage';
import type { CostRate } from '@/lib/unitEconomics';
import { RateStatusBadge } from './RateStatusBadge';
import { Section, TableWrap, TD, TDR, TH, THR } from './shared';

const STATUS: Record<PlanMarginStatus, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-success/10 text-success' },
  below_floor: { label: `Below ${GROSS_MARGIN_FLOOR_PCT}%`, cls: 'bg-danger/10 text-danger' },
  unpriced: { label: 'Unpriced (missing rate)', cls: 'bg-warning/10 text-warning' },
  not_applicable: { label: 'Free / custom', cls: 'bg-bg-tertiary text-text-secondary' },
};

export function PlanListMarginPanel({ rates }: { rates: CostRate[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = useMemo(() => buildPlanListMargins(rates, today, { phoneNumbersPerTenant: 1 }), [rates, today]);
  const platform = useMemo(() => platformFixedMonthlyUsd(rates, today), [rates, today]);
  const flagged = rows.filter((r) => r.status === 'below_floor');
  return (
    <div className="mb-6">
      <Section title="List-price margin per plan" aside={<span className="text-xs text-text-secondary">100% of included minutes used · inbound · cost from the rate table</span>}>
        {flagged.length > 0 && (
          <p role="status" className="mb-3 rounded-xl border border-danger bg-danger/10 p-3 text-sm text-text-primary">
            Below the {GROSS_MARGIN_FLOOR_PCT}% gross-margin floor at full use: {flagged.map((r) => `${r.planName} (${formatPct(r.marginPct)})`).join(', ')}.
          </p>
        )}
        <TableWrap caption="List-price gross margin per plan">
          <thead><tr>
            <th scope="col" className={TH}>Plan</th><th scope="col" className={THR}>List price</th><th scope="col" className={THR}>Included min</th>
            <th scope="col" className={THR}>Cost at full use</th><th scope="col" className={THR}>Gross margin</th><th scope="col" className={TH}>Status</th><th scope="col" className={TH}>Rates</th>
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.plan} className="border-t border-border">
              <th scope="row" className={`${TD} font-medium`}>{r.planName}</th>
              <td className={TDR}>{formatUsd(r.priceUsd)}</td>
              <td className={TDR}>{r.includedMinutes === null ? '—' : r.includedMinutes.toLocaleString('en-US')}</td>
              <td className={TDR}>{formatUsd(r.costAtFullUseUsd)}</td>
              <td className={TDR}>{formatUsd(r.marginUsd)} · {formatPct(r.marginPct)}</td>
              <td className={TD}><span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
              <td className={TD}>{r.status === 'unpriced' ? `missing: ${r.missing.join(', ')}` : r.rateNotVerified ? <><RateStatusBadge status="unverified" /> <span className="text-xs text-text-secondary">{r.unverified.join(', ')}</span></> : r.status === 'not_applicable' ? '—' : 'Verified'}</td>
            </tr>))}</tbody>
        </TableWrap>
<p className="mt-3 text-xs text-text-secondary">Estimate: list price vs. rate-table cost per minute (platform + carrier + speech-to-text + LLM + text-to-speech) plus one phone number per organisation (assumption). No SMS allowance is defined in the pricing catalog, so none is included. {platform.usd === null ? 'Platform fixed cost: no rate set.' : `Platform overhead (not in these margins): ${formatUsd(platform.usd)}/month${platform.unverified ? ' (not verified)' : ''}.`} Replace unverified rates with real invoices.</p>
      </Section>
    </div>
  );
}
