import { useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { fetchIncidents, fetchResidency, fetchSlaCredits, fetchSlaPolicy } from '@/lib/trustPack/api';
import { isRegionCode } from '@/lib/trustPack/regions';
import {
  DEFAULT_SLA_TIERS, EXCLUSION_LABEL, computeMonthlyReport, formatMinutes, formatUptime, periodOf, quoteCredit, validateTiers,
} from '@/lib/trustPack/sla';
import { Badge, Card, PanelError, PanelSkeleton, fmtDate, useLoader, type Tone } from './ui';

const CREDIT_TONE: Record<string, Tone> = { none: 'neutral', pending: 'warn', applied: 'ok', failed: 'bad', void: 'neutral' };
const money = (cents: number, cur = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase() }).format(cents / 100);

function lastPeriods(now: number, n: number): string[] {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) => periodOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)));
}

export function SlaPanel({ ownerId }: { ownerId: string }) {
  const [now] = useState(() => Date.now());
  const periods = useMemo(() => lastPeriods(now, 6), [now]);
  const [period, setPeriod] = useState(periods[0]);

  const { data, status, error, retry } = useLoader(async () => {
    const since = new Date(now - 200 * 86_400_000).toISOString();
    const [incidents, policy, credits, residency] = await Promise.all([
      fetchIncidents(since), fetchSlaPolicy(ownerId), fetchSlaCredits(ownerId), fetchResidency(ownerId),
    ]);
    return { incidents, policy, credits, region: residency && isRegionCode(residency.region) ? residency.region : ('us' as const) };
  });

  if (status === 'loading') return <PanelSkeleton />;
  if (status === 'error' || !data) return <PanelError message={error || 'Could not load SLA data.'} onRetry={retry} />;

  const tiers = data.policy && validateTiers(data.policy.tiers) ? data.policy.tiers : DEFAULT_SLA_TIERS;
  const report = computeMonthlyReport(period, { id: ownerId, region: data.region }, data.incidents, now);
  const quote = quoteCredit(report.uptimePct, tiers, data.policy?.monthly_fee_cents ?? null);
  const target = Math.max(...tiers.map((t) => t.below));
  const meets = report.uptimePct >= target;
  const counted = report.verdicts.filter((v) => v.counts);
  const excluded = report.verdicts.filter((v) => !v.counts);

  return (
    <div className="space-y-6">
      <Card title="Uptime" icon={Activity} aside={
        <select aria-label="Month" className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" value={period} onChange={(e) => setPeriod(e.target.value)}>
          {periods.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      }>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <p className="text-3xl font-semibold tabular-nums text-text-primary">{formatUptime(report.uptimePct)}</p>
            <p className="text-xs text-text-secondary">{report.state === 'in_progress' ? 'Month to date' : 'Final'} · target {target}%</p>
          </div>
          <Badge tone={meets ? 'ok' : 'bad'}>{meets ? 'Meeting target' : 'Below target'}</Badge>
          <p className="text-sm text-text-secondary">{formatMinutes(report.downtimeMinutes)} of downtime in {formatMinutes(report.measuredMinutes)}</p>
        </div>

        {report.state === 'final' && quote.creditPct > 0 && (
          <p className="mt-4 rounded-xl bg-emerald-500/5 p-3 text-sm text-text-secondary">
            {data.policy ? <>A <strong className="text-text-primary">{quote.creditPct}%</strong> service credit applies{quote.creditCents > 0 ? ` (${money(quote.creditCents, data.policy.currency)})` : ''}.</>
              : <>Uptime fell below target. Email us within 30 days of month end to claim a {quote.creditPct}% credit under the <a className="text-accent underline" href="/sla">SLA</a>.</>}
          </p>
        )}

        <h3 className="mt-6 text-sm font-semibold text-text-primary">Incidents this month</h3>
        {report.verdicts.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">No incidents recorded.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {[...counted, ...excluded].map((v) => (
              <li key={v.incident.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-text-primary">{v.incident.title}</p>
                  <p className="text-xs text-text-secondary">{fmtDate(v.incident.started_at)} · {v.incident.ended_at ? 'resolved' : 'ongoing'}</p>
                </div>
                {v.counts ? <Badge tone="bad">Counts as downtime</Badge> : <Badge>{EXCLUSION_LABEL[v.reason ?? 'outside_period']}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Service credits">
        {!data.policy && <p className="mb-3 text-sm text-text-secondary">Automatic credits apply to accounts with a contracted SLA. Otherwise credits are claimed under the public <a className="text-accent underline" href="/sla">SLA</a>.</p>}
        {data.policy && (
          <p className="mb-3 text-xs text-text-secondary">Schedule: {tiers.map((t) => `below ${t.below}% → ${t.credit_pct}%`).join(' · ')}{data.policy.auto_credit ? ' · applied automatically to your next invoice' : ''}.</p>
        )}
        {data.credits.length === 0 ? (
          <p className="text-sm text-text-secondary">No monthly results yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead><tr className="text-xs uppercase tracking-wide text-text-secondary"><th className="py-2 pr-3">Month</th><th className="py-2 pr-3">Uptime</th><th className="py-2 pr-3">Credit</th><th className="py-2">Status</th></tr></thead>
              <tbody>
                {data.credits.map((c) => (
                  <tr key={c.id} className="border-t border-border/60">
                    <td className="py-2 pr-3 text-text-primary">{c.period}</td>
                    <td className="py-2 pr-3 tabular-nums">{formatUptime(Number(c.uptime_pct))}</td>
                    <td className="py-2 pr-3 tabular-nums">{c.credit_pct ? `${c.credit_pct}%${c.credit_cents ? ` · ${money(c.credit_cents, data.policy?.currency)}` : ''}` : '—'}</td>
                    <td className="py-2"><Badge tone={CREDIT_TONE[c.status]}>{c.status === 'none' ? 'No credit due' : c.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
