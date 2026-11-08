import { useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { useGrowthT } from '@/i18n/growthNamespace';
import {
  deleteSpend, fetchAcquisition, fetchActivation, fetchBridge, fetchSpend, fetchTrials, upsertSpend,
  type ActivationRecord, type SpendRow, type TrialRow,
} from '@/lib/growth/growthApi';
import {
  MIN_SAMPLE, activatedWithin, channelEconomics, estimateLtv, logoChurn, monthlyChurnFromPeriod, trialToPaid, ttfvAmongActivated,
} from '@/lib/growth/growthMetrics';
import { AsyncBoundary, DataTable, MetricTile, Notice, SectionTitle, Td, useAsync, useFormatters, type AsyncState } from './growthShared';

const DAY = 86_400_000;
const CHANNEL_RE = /^[a-z0-9][a-z0-9._~-]{0,63}$/;

export function AcquisitionTab({ from, to }: { from: Date; to: Date }) {
  const { t } = useGrowthT();
  const key = `${from.getTime()}-${to.getTime()}`;
  const activation = useAsync(() => fetchActivation(from, to), `a${key}`);
  const trials = useAsync(() => fetchTrials(from, to), `t${key}`);
  return (
    <div className="space-y-8">
      <section aria-labelledby="g-act" className="space-y-3">
        <SectionTitle id="g-act" hint={t('acq.activationHint')}>{t('acq.activation')}</SectionTitle>
        <AsyncBoundary state={activation}>
          {(d) => <ActivationSection d={d} />}
        </AsyncBoundary>
      </section>
      <section aria-labelledby="g-trial" className="space-y-3">
        <SectionTitle id="g-trial" hint={t('acq.trialHint')}>{t('acq.trials')}</SectionTitle>
        <AsyncBoundary state={trials}>
          {(d) => <TrialSection rows={d.records} truncated={d.truncated} />}
        </AsyncBoundary>
      </section>
      <UnitEconomics from={from} to={to} />
    </div>
  );
}

function ActivationSection({ d }: { d: Awaited<ReturnType<typeof fetchActivation>> }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const now = useMemo(() => new Date(), []);
  const recs = d.records.map((r: ActivationRecord) => ({ signupAt: r.signupAt, activatedAt: r.realCallAt }));
  const ttfv = ttfvAmongActivated(recs);
  const buckets: [string, number][] = (() => {
    const hours = recs.filter((r) => r.activatedAt).map((r) => ((r.activatedAt as Date).getTime() - r.signupAt.getTime()) / 3_600_000);
    const c = (lo: number, hi: number) => hours.filter((h) => h >= lo && h < hi).length;
    return [[t('acq.bucket.lt1h'), c(0, 1)], [t('acq.bucket.1_24h'), c(1, 24)], [t('acq.bucket.1_3d'), c(24, 72)], [t('acq.bucket.3_7d'), c(72, 168)], [t('acq.bucket.gt7d'), c(168, Infinity)]];
  })();
  const steps: [string, number][] = [[t('acq.step.signup'), d.signups], [t('acq.step.testCall'), d.testCallAnswered], [t('acq.step.realCall'), d.realCall], [t('acq.step.booking'), d.booking]];
  if (d.signups === 0) return <Notice>{t('acq.noSignups')}</Notice>;
  return (
    <div className="space-y-4">
      <DataTable caption={t('acq.activation')} head={[t('acq.step.name'), t('common.accounts'), t('acq.step.share')]}>
        {steps.map(([label, n]) => (
          <tr key={label}><Td>{label}</Td><Td>{n}</Td><Td>{f.pct(n / d.signups, 0)}</Td></tr>
        ))}
      </DataTable>
      {d.truncated && <Notice>{t('common.truncated')}</Notice>}
      <div className="grid gap-3 sm:grid-cols-3">
        {[1, 3, 7].map((days) => {
          const r = activatedWithin(recs, days, now);
          return <MetricTile key={days} label={t('acq.activatedWithin', { days })} formula={t('acq.activatedFormula')} metric={r} interval={r.interval} format={(v) => f.pct(v)} />;
        })}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-text-primary">{t('acq.ttfv')}</h3>
        {ttfv.n === 0 ? <Notice>{t('common.insufficient')}</Notice> : (
          <p className="text-sm text-text-primary">
            {t('acq.ttfvSummary', { n: ttfv.n, median: f.num(ttfv.medianHoursAmongActivated ?? 0), p90: f.num(ttfv.p90HoursAmongActivated ?? 0) })}
          </p>
        )}
        <Notice>{t('acq.ttfvCaveat')}</Notice>
        <DataTable caption={t('acq.ttfv')} head={[t('acq.bucket.name'), t('common.accounts')]}>
          {buckets.map(([label, n]) => (<tr key={label}><Td>{label}</Td><Td>{n}</Td></tr>))}
        </DataTable>
      </div>
    </div>
  );
}

function TrialSection({ rows, truncated }: { rows: TrialRow[]; truncated: boolean }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const now = useMemo(() => new Date(), []);
  const toRec = (r: TrialRow) => ({ trialEnd: r.trialEnd, convertedAt: r.convertedAt });
  if (rows.length === 0) return <Notice>{t('acq.noTrials')}</Notice>;
  const overall = trialToPaid(rows.map(toRec), now);
  const group = (pick: (r: TrialRow) => string): [string, ReturnType<typeof trialToPaid>][] => {
    const m = new Map<string, TrialRow[]>();
    for (const r of rows) m.set(pick(r), [...(m.get(pick(r)) ?? []), r]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, trialToPaid(v.map(toRec), now)]);
  };
  const table = (title: string, data: [string, ReturnType<typeof trialToPaid>][]) => (
    <DataTable caption={title} head={[title, t('acq.matured'), t('acq.converted'), t('acq.rate'), t('common.ci95Head'), t('acq.inFlight')]}>
      {data.map(([k, r]) => (
        <tr key={k}>
          <Td>{k}</Td><Td>{r.matured.n}</Td><Td>{r.matured.k}</Td>
          <Td>{r.matured.value === null ? t('common.insufficient') : f.pct(r.matured.value)}{r.matured.status === 'low_sample' && <span className="ms-1 text-xs text-text-secondary">({t('common.lowSampleShort')})</span>}</Td>
          <Td>{r.matured.interval ? `${f.pct(r.matured.interval.low, 0)}–${f.pct(r.matured.interval.high, 0)}` : '—'}</Td>
          <Td>{r.inFlight}</Td>
        </tr>
      ))}
    </DataTable>
  );
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile label={t('acq.trialToPaid')} formula={t('acq.trialFormula')} metric={overall.matured} interval={overall.matured.interval} format={(v) => f.pct(v)} />
      </div>
      {truncated && <Notice>{t('common.truncated')}</Notice>}
      {table(t('acq.bySource'), group((r) => r.channel))}
      {table(t('acq.byCohort'), group((r) => r.cohortMonth.slice(0, 7)))}
    </div>
  );
}

function UnitEconomics({ from, to }: { from: Date; to: Date }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const key = `${from.getTime()}-${to.getTime()}`;
  const acq = useAsync(() => fetchAcquisition(from, to), `q${key}`);
  const bridge = useAsync(() => fetchBridge(new Date(Date.now() - 90 * DAY), new Date()), 'b90');
  const spend = useAsync(() => fetchSpend(from, to), `s${key}`);
  const [marginInput, setMarginInput] = useState('');
  const margin = (() => { const n = Number(marginInput); return marginInput !== '' && n > 0 && n <= 100 ? n / 100 : null; })();

  return (
    <section aria-labelledby="g-unit" className="space-y-3">
      <SectionTitle id="g-unit" hint={t('acq.unitHint')}>{t('acq.unit')}</SectionTitle>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="g-margin" className="text-sm text-text-primary">{t('acq.margin')}</label>
        <input id="g-margin" inputMode="decimal" value={marginInput} onChange={(e) => setMarginInput(e.target.value)} aria-describedby="g-margin-hint" className="focus-ring w-24 rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary" />
        <span id="g-margin-hint" className="text-xs text-text-secondary">{t('acq.marginHint')}</span>
      </div>
      <AsyncBoundary state={acq}>
        {(a) => {
          const cur = [...a.current].sort((x, y) => y.mrrCents - x.mrrCents)[0];
          if (!cur) return <Notice>{t('revenue.noHistory')}</Notice>;
          const arpa = cur.payingAccounts > 0 ? Math.round(cur.mrrCents / cur.payingAccounts) : 0;
          const brow = bridge.data?.find((r) => r.currency === cur.currency);
          const churn90 = brow ? logoChurn(brow) : null;
          const monthly = churn90?.value != null ? monthlyChurnFromPeriod(churn90.value, 90) : null;
          const months = a.historyStart ? Math.floor((Date.now() - a.historyStart.getTime()) / (30 * DAY)) : 0;
          const ltv = margin === null || monthly === null
            ? null
            : estimateLtv({ arpaCents: arpa, grossMargin: margin, monthlyChurn: monthly, payingCustomers: cur.payingAccounts, monthsOfData: months });
          const channels = a.channels.filter((c) => c.currency === cur.currency);
          return (
            <div className="space-y-4">
              {margin === null && <Notice>{t('acq.needMargin')}</Notice>}
              <div className="grid gap-3 sm:grid-cols-2">
                {ltv ? <MetricTile label={t('acq.ltv')} formula={t('acq.ltvFormula')} metric={ltv} format={(v) => f.money(v, cur.currency)} /> : (
                  <div className="rounded-xl border border-border p-4 text-sm text-text-secondary">{t('acq.ltvNeedsInputs')}</div>
                )}
                <div className="rounded-xl border border-border p-4 text-sm text-text-primary">
                  <p>{t('acq.arpa', { value: f.money(arpa, cur.currency), n: cur.payingAccounts })}</p>
                  <p className="text-xs text-text-secondary">{monthly === null ? t('acq.noChurnObserved') : t('acq.monthlyChurn', { value: f.pct(monthly) })}</p>
                </div>
              </div>
              {!a.spendPeriodAligned && <Notice>{t('acq.spendNotAligned')}</Notice>}
              {a.coverage.total > 0 && a.coverage.attributed < a.coverage.total && (
                <Notice>{t('acq.coverage', { attributed: a.coverage.attributed, total: a.coverage.total })}</Notice>
              )}
              <DataTable caption={t('acq.byChannel')} head={[t('acq.channel'), t('acq.newCustomers'), t('acq.spend'), t('acq.cac'), t('acq.channelArpa'), t('acq.payback')]}>
                {channels.map((c) => {
                  const e = channelEconomics({ spendCents: c.spendCents, newCustomers: c.newCustomers, newMrrCents: c.newMrrCents, grossMargin: margin ?? 0 });
                  return (
                    <tr key={c.channel}>
                      <Td>{c.channel}</Td>
                      <Td>{c.newCustomers}</Td>
                      <Td>{c.spendCents === null ? t('acq.noSpend') : f.money(c.spendCents, c.currency)}</Td>
                      <Td>{e.cac.value === null ? t(`reason.${e.cac.reason ?? 'missing_inputs'}`) : `${f.money(e.cac.value, c.currency)}${e.cac.status === 'low_sample' ? ` (${t('common.lowSampleShort')})` : ''}`}</Td>
                      <Td>{e.arpaCents === null ? '—' : f.money(e.arpaCents, c.currency)}</Td>
                      <Td>{e.payback.value === null || margin === null ? t('common.insufficient') : `${f.num(e.payback.value)} ${t('acq.months')} · ${t('common.estimated')}`}</Td>
                    </tr>
                  );
                })}
              </DataTable>
              <p className="text-xs text-text-secondary">{t('acq.cacFormula')} {t('acq.paybackFormula')}</p>
            </div>
          );
        }}
      </AsyncBoundary>
      <SpendEditor rows={spend} />
    </section>
  );
}

function SpendEditor({ rows }: { rows: AsyncState<SpendRow[]> }) {
  const { t } = useGrowthT();
  const f = useFormatters();
  const [channel, setChannel] = useState('');
  const [month, setMonth] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('usd');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ch = channel.trim().toLowerCase();
    const cents = Math.round(Number(amount) * 100);
    if (!CHANNEL_RE.test(ch) || !/^\d{4}-\d{2}$/.test(month) || !(Number(amount) >= 0) || amount === '' || !/^[a-z]{3}$/.test(currency.trim().toLowerCase())) {
      setErr(t('spend.invalid'));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await upsertSpend({ channel: ch, month: `${month}-01`, amountCents: cents, currency: currency.trim().toLowerCase(), note });
      setChannel(''); setAmount(''); setNote('');
      rows.reload();
    } catch {
      setErr(t('spend.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const input = 'focus-ring rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary';
  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold text-text-primary">{t('spend.title')}</h3>
      <p className="text-xs text-text-secondary">{t('spend.hint')}</p>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-5" noValidate>
        <div className="flex flex-col gap-1"><label htmlFor="sp-ch" className="text-xs text-text-secondary">{t('spend.channel')}</label><input id="sp-ch" className={input} value={channel} onChange={(e) => setChannel(e.target.value)} required /></div>
        <div className="flex flex-col gap-1"><label htmlFor="sp-mo" className="text-xs text-text-secondary">{t('spend.month')}</label><input id="sp-mo" type="month" className={input} value={month} onChange={(e) => setMonth(e.target.value)} required /></div>
        <div className="flex flex-col gap-1"><label htmlFor="sp-am" className="text-xs text-text-secondary">{t('spend.amount')}</label><input id="sp-am" inputMode="decimal" className={input} value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
        <div className="flex flex-col gap-1"><label htmlFor="sp-cu" className="text-xs text-text-secondary">{t('common.currency')}</label><input id="sp-cu" maxLength={3} className={input} value={currency} onChange={(e) => setCurrency(e.target.value)} required /></div>
        <div className="flex flex-col gap-1"><label htmlFor="sp-no" className="text-xs text-text-secondary">{t('spend.note')}</label><input id="sp-no" maxLength={300} className={input} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="sm:col-span-5"><Button type="submit" size="sm" loading={busy}>{t('spend.save')}</Button></div>
      </form>
      {err && <p role="alert" className="text-xs text-danger">{err}</p>}
      <AsyncBoundary state={rows}>
        {(list) => list.length === 0 ? <p className="text-xs text-text-secondary">{t('spend.empty')}</p> : (
          <DataTable caption={t('spend.title')} head={[t('spend.channel'), t('spend.month'), t('spend.amount'), t('spend.note'), t('common.actions')]}>
            {list.map((r) => (
              <tr key={r.id}>
                <Td>{r.channel}</Td><Td>{r.month.slice(0, 7)}</Td><Td>{f.money(r.amountCents, r.currency)}</Td><Td>{r.note ?? ''}</Td>
                <Td><Button size="xs" variant="ghost" onClick={async () => { await deleteSpend(r.id); rows.reload(); }}>{t('common.delete')}<span className="sr-only"> {r.channel} {r.month.slice(0, 7)}</span></Button></Td>
              </tr>
            ))}
          </DataTable>
        )}
      </AsyncBoundary>
      <p className="text-[11px] text-text-secondary">{t('acq.minSample', { min: MIN_SAMPLE })}</p>
    </div>
  );
}
