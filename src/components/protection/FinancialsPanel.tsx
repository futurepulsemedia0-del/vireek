import { formatMoney, type ProtectionFinancials } from '@/lib/protectionPlans';
import { Kpi, cardClass } from './ui';

const monthLabel = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  if (!y || !m) return '';
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
};

export function FinancialsPanel({ data }: { data: ProtectionFinancials }) {
  const maxBar = Math.max(1, ...data.monthly.map((m) => Math.max(m.premium_written_cents, m.claims_paid_cents)));
  const reserveTone = data.reserve_balance_cents < 0 || data.reserve_shortfall_cents > 0 ? 'bad' : 'good';
  const lossTone = data.loss_ratio_percent === null ? 'default' : data.loss_ratio_percent > 70 ? 'bad' : data.loss_ratio_percent > 50 ? 'warn' : 'good';

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Premium written" value={formatMoney(data.written_premium_cents)} sub={`${data.contracts.active} active · ${data.contracts.pending} awaiting payment`} />
        <Kpi label="Earned to date" value={formatMoney(data.earned_cents)} sub="Straight-line, daily" />
        <Kpi label="Unearned (owed as coverage)" value={formatMoney(data.unearned_cents)} sub="Liability on active plans" />
        <Kpi label="Refunds issued" value={formatMoney(data.refunds_cents)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Claims paid" value={formatMoney(data.claims_paid_cents)} />
        <Kpi label="Open claims reserve" value={formatMoney(data.case_reserve_cents)} sub={`${data.open_claims} open claim${data.open_claims === 1 ? '' : 's'}`} />
        <Kpi
          label="Claims reserve balance"
          value={formatMoney(data.reserve_balance_cents)}
          sub={data.reserve_shortfall_cents > 0 ? `Short ${formatMoney(data.reserve_shortfall_cents)} against open claims` : 'Funded − paid − released'}
          tone={reserveTone}
        />
        <Kpi label="Loss ratio" value={data.loss_ratio_percent === null ? '—' : `${data.loss_ratio_percent}%`} sub="(Paid + open) ÷ earned" tone={lossTone} />
      </div>

      <div className={cardClass}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Last 12 months</h3>
          <p className="text-xs text-text-secondary">
            Underwriting result so far: <strong className={data.underwriting_result_cents < 0 ? 'text-danger' : 'text-text-primary'}>{formatMoney(data.underwriting_result_cents)}</strong>
          </p>
        </div>
        <div className="mt-4 flex h-40 items-end gap-1.5" role="img" aria-label="Monthly premium written versus claims paid">
          {data.monthly.map((m) => (
            <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex h-32 w-full items-end justify-center gap-0.5">
                <div
                  className="w-1/2 rounded-t bg-accent/80"
                  style={{ height: `${Math.round((m.premium_written_cents / maxBar) * 100)}%` }}
                  title={`Premium ${formatMoney(m.premium_written_cents)}`}
                />
                <div
                  className="w-1/2 rounded-t bg-danger/70"
                  style={{ height: `${Math.round((m.claims_paid_cents / maxBar) * 100)}%` }}
                  title={`Claims ${formatMoney(m.claims_paid_cents)}`}
                />
              </div>
              <span className="text-[10px] text-text-secondary">{monthLabel(m.month)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-4 text-xs text-text-secondary">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent/80" /> Premium written
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-danger/70" /> Claims paid
          </span>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-text-secondary">
        Premium is recognised evenly over each plan’s term. A share of every premium (the plan’s reserve %) is set aside for claims; payouts draw it down, and what is left is released 30 days
        after the plan ends once no claim is open. Figures are bookkeeping aids — confirm treatment with your accountant, as rules for service contracts vary by state.
      </p>
    </div>
  );
}
