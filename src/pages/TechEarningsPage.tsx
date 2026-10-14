import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Banknote, CloudOff, RefreshCw, Wallet } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useEarningsDetail, useTechEarnings } from '@/hooks/useTechEarnings';
import { TONE_CLASSES } from '@/lib/truckStock';
import {
  buildTrend,
  currentTotalCents,
  currentWagesCents,
  describePayType,
  earningsMix,
  formatAgo,
  formatCents,
  formatDay,
  formatHours,
  formatStamp,
  periodLabel,
  periodTakeHomeCents,
  periodTotalCents,
  periodWagesCents,
  TIP_SOURCE_LABELS,
  type EarningsDetail,
  type EarningsSummary,
  type MixPart,
  type PastPeriod,
} from '@/lib/techEarnings';

const MIX_COLOR: Record<MixPart['key'], string> = { wages: 'bg-accent', commission: 'bg-success-500', tips: 'bg-warning-500' };

function Row({ label, value, strong = false, muted = false }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className={`text-sm ${muted ? 'text-text-secondary' : 'text-text-primary'} ${strong ? 'font-semibold' : ''}`}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold text-text-primary' : 'text-sm text-text-primary'}`}>{value}</dd>
    </div>
  );
}

function MixBar({ parts }: { parts: MixPart[] }) {
  const visible = parts.filter((p) => p.percent > 0);
  if (visible.length === 0) return null;
  return (
    <div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-bg-tertiary"
        role="img"
        aria-label={`Earnings mix: ${visible.map((p) => `${p.label} ${p.percent}%`).join(', ')}`}
      >
        {visible.map((p) => (
          <div key={p.key} className={MIX_COLOR[p.key]} style={{ width: `${p.percent}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        {visible.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${MIX_COLOR[p.key]}`} aria-hidden /> {p.label} {p.percent}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, count, children, defaultOpen = false }: { title: string; count: number; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="rounded-2xl border border-border bg-bg-secondary" open={defaultOpen}>
      <summary className="flex min-h-[3rem] cursor-pointer items-center justify-between px-4 text-sm font-medium text-text-primary">
        <span>{title}</span>
        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary tabular-nums">{count}</span>
      </summary>
      <div className="border-t border-border">{children}</div>
    </details>
  );
}

function DetailLines({ detail, loading, error, onRetry }: { detail: EarningsDetail | null; loading: boolean; error: string | null; onRetry: () => void }) {
  if (loading && !detail) {
    return (
      <div className="space-y-3" role="status" aria-label="Loading details">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
      </div>
    );
  }
  if (error && !detail) {
    return (
      <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
        <p className="text-text-primary">Couldn't load the details. {error}</p>
        <button type="button" onClick={onRetry} className="mt-2 h-10 rounded-lg bg-accent px-4 text-xs font-semibold text-white">Try again</button>
      </div>
    );
  }
  if (!detail) return null;

  const empty = (text: string) => <p className="px-4 py-4 text-sm text-text-secondary">{text}</p>;
  return (
    <div className="space-y-3">
      <Section title="Commission" count={detail.commissions.length} defaultOpen>
        {detail.commissions.length === 0 ? (
          empty('No commission in this period.')
        ) : (
          <ul className="divide-y divide-border">
            {detail.commissions.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{c.customer_name ?? 'Job'}</p>
                  <p className="text-xs text-text-secondary">
                    {formatStamp(c.created_at)} · {formatCents(c.basis_amount_cents)} × {c.commission_rate_percent}%
                    {c.status === 'pending' ? ' · pending approval' : ''}
                  </p>
                </div>
                <p className="flex-shrink-0 text-sm font-medium tabular-nums text-text-primary">{formatCents(c.commission_cents)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Tips" count={detail.tips.length} defaultOpen={detail.tips.length > 0}>
        {detail.tips.length === 0 ? (
          empty('No tips in this period.')
        ) : (
          <ul className="divide-y divide-border">
            {detail.tips.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{t.customer_name ?? 'Tip'}</p>
                  <p className="text-xs text-text-secondary">
                    {formatStamp(t.received_at)} · {TIP_SOURCE_LABELS[t.source] ?? 'Other'}
                    {t.note ? ` · ${t.note}` : ''}
                  </p>
                </div>
                <p className="flex-shrink-0 text-sm font-medium tabular-nums text-text-primary">{formatCents(t.amount_cents)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Hours" count={detail.timesheets.length}>
        {detail.timesheets.length === 0 ? (
          empty('No hours logged in this period.')
        ) : (
          <ul className="divide-y divide-border">
            {detail.timesheets.map((h) => (
              <li key={h.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-text-primary">{formatDay(h.work_date)}{h.customer_name ? ` · ${h.customer_name}` : ''}</p>
                  <p className="text-xs text-text-secondary">{h.status === 'pending' ? 'Waiting for approval' : 'Approved'}</p>
                </div>
                <p className="flex-shrink-0 text-sm tabular-nums text-text-primary">
                  {formatHours(h.regular_hours)}
                  {h.overtime_hours > 0 ? ` + ${formatHours(h.overtime_hours)} OT` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function CurrentCard({ summary }: { summary: EarningsSummary }) {
  const c = summary.current;
  const wages = currentWagesCents(c);
  const total = currentTotalCents(c);
  return (
    <section className="rounded-3xl border border-border bg-bg-secondary p-5" aria-label="Current period">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{c.since ? `Since ${formatDay(c.since)}` : 'So far'} · not yet paid</p>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES.warning}`}>Estimate</span>
      </div>
      <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-text-primary">{formatCents(total)}</p>
      <p className="mt-1 text-xs text-text-secondary">Before tax. Final numbers come from the office's pay run.</p>

      <div className="mt-4"><MixBar parts={earningsMix(wages, c.commission_cents, c.tips_cents)} /></div>

      <dl className="mt-4 divide-y divide-border border-t border-border">
        {summary.employee.pay_type === 'hourly' && (
          <>
            <Row label={`Regular pay · ${formatHours(c.regular_hours)}`} value={formatCents(c.regular_pay_cents)} />
            {c.overtime_hours > 0 && <Row label={`Overtime · ${formatHours(c.overtime_hours)}`} value={formatCents(c.overtime_pay_cents)} />}
          </>
        )}
        {c.salary_pay_cents > 0 && <Row label="Salary (one pay period)" value={formatCents(c.salary_pay_cents)} />}
        <Row label={`Commission${c.commission_count ? ` · ${c.commission_count} job${c.commission_count === 1 ? '' : 's'}` : ''}`} value={formatCents(c.commission_cents)} />
        <Row label="Tips" value={formatCents(c.tips_cents)} />
      </dl>
      {c.pending_timesheets > 0 && (
        <p className="mt-3 rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">
          {c.pending_timesheets} timesheet{c.pending_timesheets === 1 ? ' is' : 's are'} waiting for approval. The hours are counted here but may change.
        </p>
      )}
    </section>
  );
}

function PastCard({ period, w2 }: { period: PastPeriod; w2: boolean }) {
  const wages = periodWagesCents(period);
  return (
    <section className="rounded-3xl border border-border bg-bg-secondary p-5" aria-label="Pay period">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{periodLabel(period.pay_period_start, period.pay_period_end)}</p>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${period.status === 'paid' ? TONE_CLASSES.success : TONE_CLASSES.accent}`}>
          {period.status === 'paid' ? `Paid ${formatDay(period.pay_date)}` : `Pays ${formatDay(period.pay_date)}`}
        </span>
      </div>
      <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight text-text-primary">{formatCents(periodTotalCents(period))}</p>
      <p className="mt-1 text-xs text-text-secondary">Total earned before tax, including tips.</p>

      <div className="mt-4"><MixBar parts={earningsMix(wages, period.commission_cents, period.tips_cents)} /></div>

      <dl className="mt-4 divide-y divide-border border-t border-border">
        {period.regular_pay_cents > 0 && <Row label={`Regular pay · ${formatHours(period.regular_hours)}`} value={formatCents(period.regular_pay_cents)} />}
        {period.overtime_pay_cents > 0 && <Row label={`Overtime · ${formatHours(period.overtime_hours)}`} value={formatCents(period.overtime_pay_cents)} />}
        {period.salary_pay_cents > 0 && <Row label="Salary" value={formatCents(period.salary_pay_cents)} />}
        {period.bonus_cents > 0 && <Row label="Bonus" value={formatCents(period.bonus_cents)} />}
        <Row label="Commission" value={formatCents(period.commission_cents)} />
        <Row label="Gross pay" value={formatCents(period.gross_pay_cents)} strong />
        {period.tax_withholding_cents > 0 && <Row label={w2 ? 'Tax withheld (estimate)' : 'Tax withheld'} value={`−${formatCents(period.tax_withholding_cents)}`} muted />}
        {period.other_deductions_cents > 0 && <Row label="Other deductions" value={`−${formatCents(period.other_deductions_cents)}`} muted />}
        <Row label="Net pay" value={formatCents(period.net_pay_cents)} strong />
        <Row label="Tips (paid outside payroll)" value={`+${formatCents(period.tips_cents)}`} />
        <Row label="Take-home" value={formatCents(periodTakeHomeCents(period))} strong />
      </dl>
    </section>
  );
}

export function TechEarningsPage() {
  const earnings = useTechEarnings();
  const { summary } = earnings;
  const [selected, setSelected] = useState<string>('current');
  const [, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const period = useMemo(() => summary?.periods.find((p) => p.item_id === selected) ?? null, [summary, selected]);
  // A refresh can drop the selected period; fall back to the running one.
  const effective = period ? selected : 'current';
  const trend = useMemo(() => (summary ? buildTrend(summary) : []), [summary]);

  const detail = useEarningsDetail(effective === 'current' ? null : effective, earnings.status === 'ready');

  const header = (
    <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <Link to="/tech/today" aria-label="Back to today's jobs" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-text-primary">Earnings</h1>
          <p className="truncate text-xs text-text-secondary">
            {summary ? `${describePayType(summary.employee)} · paid ${summary.employee.pay_schedule}` : 'Wages, commission and tips'}
          </p>
        </div>
        {!earnings.online && (
          <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASSES.warning}`} role="status">
            <CloudOff className="h-3.5 w-3.5" aria-hidden /> Offline
          </span>
        )}
        <button
          type="button"
          onClick={() => void earnings.refresh()}
          disabled={earnings.refreshing || !earnings.online}
          aria-label="Refresh earnings"
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary disabled:opacity-40"
        >
          <RefreshCw className={`h-5 w-5 ${earnings.refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </header>
  );

  let body: ReactNode;
  if (earnings.status === 'loading') {
    body = (
      <div className="space-y-3" role="status" aria-label="Loading earnings">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-72 w-full rounded-3xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
      </div>
    );
  } else if (earnings.status === 'blocked') {
    body =
      earnings.blocked === 'no_pay_profile' ? (
        <EmptyState
          icon={Wallet}
          title="Your pay profile isn't set up yet"
          description="Ask the office to add you to payroll. Once they do, your wages, commission and tips show up here."
          action={{ label: 'Check again', onClick: () => void earnings.refresh() }}
        />
      ) : (
        <EmptyState
          icon={Wallet}
          title="This page is for technicians"
          description="Earnings follow the technician who did the work. Payroll for the whole team lives under Payroll in the dashboard."
        />
      );
  } else if (earnings.status === 'error' || !summary) {
    body = (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your earnings"
        description={earnings.online ? (earnings.error ?? 'Something went wrong. Try again.') : 'You are offline and your earnings have not been saved on this device yet. Connect once to load them.'}
        action={{ label: 'Try again', onClick: () => void earnings.refresh() }}
      />
    );
  } else {
    body = (
      <>
        {!earnings.online && (
          <p role="status" className="mb-3 flex gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
            <CloudOff className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
            <span>You're offline. Showing what was saved {formatAgo(earnings.syncedAt)}.</span>
          </p>
        )}
        {earnings.online && earnings.error && (
          <p role="status" className="mb-3 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
            Couldn't refresh just now — showing the last saved numbers.{' '}
            <button type="button" onClick={() => void earnings.refresh()} className="font-semibold underline">Retry</button>
          </p>
        )}

        <nav aria-label="Pay periods" className="mb-4">
          <ul className="flex items-end gap-2 overflow-x-auto pb-1">
            {trend.map((bar) => {
              const active = (bar.current ? 'current' : bar.id) === effective;
              return (
                <li key={bar.id} className="flex-1 basis-0">
                  <button
                    type="button"
                    onClick={() => setSelected(bar.current ? 'current' : bar.id)}
                    aria-pressed={active}
                    aria-label={`${bar.current ? 'Current period, estimate' : `Period ending ${bar.label}`}: ${formatCents(bar.cents)}`}
                    className={`flex h-24 min-w-[3.25rem] w-full flex-col items-center justify-end gap-1 rounded-xl border px-1 pb-1.5 pt-2 ${active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}
                  >
                    <span className="flex w-full flex-1 items-end justify-center" aria-hidden>
                      <span
                        className={`w-5 rounded-md ${bar.current ? 'bg-warning-500/70' : 'bg-accent'} ${bar.height === 0 ? 'h-px opacity-40' : ''}`}
                        style={bar.height ? { height: `${bar.height}%` } : undefined}
                      />
                    </span>
                    <span className={`text-[11px] ${active ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{bar.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {effective === 'current' ? <CurrentCard summary={summary} /> : period && <PastCard period={period} w2={summary.employee.employment_type === 'w2'} />}

        <div className="mt-4">
          <DetailLines detail={detail.detail} loading={detail.loading} error={detail.error} onRetry={detail.reload} />
        </div>

        {summary.periods.length === 0 && (
          <p className="mt-4 rounded-2xl border border-dashed border-border p-4 text-center text-sm text-text-secondary">
            No pay periods yet. Once the office approves your first pay run, it shows up here.
          </p>
        )}

        <p className="mt-6 flex gap-2 text-xs leading-relaxed text-text-secondary">
          <Banknote className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <span>
            Current numbers are an estimate until payroll runs. Withholding is estimated by your employer and is not a tax filing.
            Questions about a number? Ask the office.
          </span>
        </p>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-12">
      {header}
      <main className="mx-auto max-w-lg px-4 py-4">{body}</main>
    </div>
  );
}
