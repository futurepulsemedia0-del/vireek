// src/components/recovery/StatementView.tsx
// Read-only rendering of a Money Recovered statement (live preview or a stored weekly snapshot).
import { Link } from 'react-router-dom';
import { ExternalLink, Headphones, Info } from 'lucide-react';
import {
  METHODOLOGY,
  REASON_LABELS,
  formatMoney,
  formatPct,
  type Statement,
  type StatementRow,
} from '@/lib/moneyRecovered';

const STATE_STYLE: Record<StatementRow['state'], { label: string; className: string }> = {
  credited: { label: 'Recovered', className: 'bg-success-500/10 text-success-500' },
  in_progress: { label: 'In progress', className: 'bg-warning-500/10 text-warning-500' },
  not_claimed: { label: 'Not claimed', className: 'bg-bg-tertiary text-text-secondary' },
};

function Stat({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'good' }) {
  return (
    <div className={`rounded-2xl border p-4 ${tone === 'good' ? 'border-success-500/25 bg-success-500/[0.05]' : 'border-border bg-bg-secondary'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'good' ? 'text-success-500' : 'text-text-primary'}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{note}</p>
    </div>
  );
}

export function StatementView({ statement: s }: { statement: Statement }) {
  const cur = s.currency;
  const amount = (r: StatementRow) =>
    r.state === 'credited' ? formatMoney(r.creditedCents, cur) : r.state === 'not_claimed' ? formatMoney(r.recoveredCents, cur) : `~${formatMoney(r.estimatedCents, cur)}`;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-text-secondary">
          {s.period.label} <span className="text-text-secondary/70">({s.period.timezone})</span>
        </p>
        <p className="mt-1 text-4xl font-extrabold text-success-500" aria-label={`Recovered ${formatMoney(s.creditedCents, cur)}`}>
          {formatMoney(s.creditedCents, cur)}
        </p>
        <p className="mt-1 text-sm text-text-secondary">
          recovered by Vireek across {s.creditedCount} {s.creditedCount === 1 ? 'customer' : 'customers'}, counted conservatively.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat tone="good" label="Recovered" value={formatMoney(s.creditedCents, cur)} note={`${s.creditedCount} counted`} />
        <Stat label="Recovered, not claimed" value={formatMoney(s.notClaimedCents, cur)} note={`${s.notClaimedCount} didn't meet our evidence bar`} />
        <Stat label="Still recoverable" value={`~${formatMoney(s.stillOpenCents, cur)}`} note={`${s.stillOpenCount} open (estimate)`} />
      </div>

      <section aria-labelledby="mr-baseline" className="rounded-2xl border border-border bg-bg-secondary p-5">
        <h3 id="mr-baseline" className="text-base font-semibold text-text-primary">Compared with your baseline Leak Report</h3>
        {s.baseline ? (
          <dl className="mt-3 divide-y divide-border text-sm">
            {[
              ['Baseline leak, per week', formatMoney(s.baseline.weeklyLeakCents, cur), `from ${formatMoney(s.baseline.monthlyLeakCents, cur)}/month`],
              ['Slipped this week', formatMoney(s.baseline.leakedThisWeekCents, cur), `${formatPct(s.baseline.leakVsBaselinePct)} vs baseline`],
              ['Recovered by Vireek', formatMoney(s.baseline.creditedCents, cur), s.baseline.recoveredVsBaselinePct === null ? '' : `${s.baseline.recoveredVsBaselinePct}% of the weekly baseline leak`],
            ].map(([k, v, n]) => (
              <div key={k} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
                <dt className="text-text-secondary">{k}</dt>
                <dd className="font-semibold text-text-primary">{v} <span className="ml-1 text-xs font-normal text-text-secondary">{n}</span></dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">No baseline recorded yet. Add your Leak Report figure below to see each week compared with it.</p>
        )}
      </section>

      <section aria-labelledby="mr-categories">
        <h3 id="mr-categories" className="mb-2 text-base font-semibold text-text-primary">By category</h3>
        {s.categories.length === 0 ? (
          <p className="text-sm text-text-secondary">Nothing to report by category this week.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Recovered</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Not claimed</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Still open (est.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {s.categories.map((c) => (
                  <tr key={c.category}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium text-text-primary">{c.label}</th>
                    <td className="px-4 py-2.5 text-right font-semibold text-text-primary">{formatMoney(c.creditedCents, cur)} <span className="font-normal text-text-secondary">({c.creditedCount})</span></td>
                    <td className="px-4 py-2.5 text-right text-text-secondary">{formatMoney(c.notClaimedCents, cur)}</td>
                    <td className="px-4 py-2.5 text-right text-text-secondary">~{formatMoney(c.openCents, cur)} ({c.openCount})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="mr-rows">
        <h3 id="mr-rows" className="mb-2 text-base font-semibold text-text-primary">Calls and customers we worked</h3>
        {s.rows.length === 0 ? (
          <p className="text-sm text-text-secondary">No recoveries or active follow-ups this week.</p>
        ) : (
          <ul className="space-y-2">
            {s.rows.map((r) => (
              <li key={r.eventId} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-text-primary">{r.customer}</p>
                    <p className="text-xs text-text-secondary">{r.source}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-text-primary">{amount(r)}</p>
                    <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATE_STYLE[r.state].className}`}>{STATE_STYLE[r.state].label}</span>
                  </div>
                </div>
                {r.summary && <p className="mt-2 text-sm text-text-secondary">{r.summary}</p>}
                {r.cappedByEstimate && <p className="mt-1 text-xs text-text-secondary">Credited up to the original estimate only.</p>}
                {r.reason && <p className="mt-1 text-xs text-text-secondary">{REASON_LABELS[r.reason]}</p>}
                <div className="mt-2 text-xs">
                  {r.callId ? (
                    <Link to={`/dashboard/calls/${r.callId}`} className="focus-ring inline-flex items-center gap-1 font-medium text-accent hover:underline">
                      {r.hasRecording ? <Headphones size={13} aria-hidden="true" /> : <ExternalLink size={13} aria-hidden="true" />}
                      {r.hasRecording ? 'Listen & view call' : 'View call'}
                    </Link>
                  ) : (
                    <span className="text-text-secondary">No call linked</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {s.rowsOmitted > 0 && <p className="mt-2 text-xs text-text-secondary">+ {s.rowsOmitted} more not shown.</p>}
      </section>

      <section aria-labelledby="mr-method" className="rounded-2xl border border-border bg-bg-tertiary/50 p-5">
        <h3 id="mr-method" className="flex items-center gap-2 text-base font-semibold text-text-primary">
          <Info size={16} aria-hidden="true" /> How we count (conservative attribution)
        </h3>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-text-secondary">
          {METHODOLOGY.map((m) => (
            <li key={m.title}><span className="font-medium text-text-primary">{m.title}.</span> {m.body}</li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-text-secondary">Method {s.methodVersion} · generated {s.generatedAt.slice(0, 10)}</p>
      </section>
    </div>
  );
}
